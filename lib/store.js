// Document store with the same semantics the pages were written against:
// set = full replace, update = recursive merge that requires the doc to exist
// (arrays replace), delete = idempotent, queries with where/orderBy/limit.
const { EventEmitter } = require("events");
const crypto = require("crypto");
const { pool } = require("./db");

const changes = new EventEmitter();
changes.setMaxListeners(0);

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function splitPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (!parts.length || parts.length > 16 || !parts.every((p) => SEG.test(p) && p !== "." && p !== ".."))
    throw new StoreError("invalid_argument", `Bad path: ${path}`);
  return parts;
}
function collPath(path) {
  const p = splitPath(path);
  if (p.length % 2 !== 1) throw new StoreError("invalid_argument", `Not a collection path: ${path}`);
  return p.join("/");
}
function docPath(path) {
  const p = splitPath(path);
  if (p.length % 2 !== 0) throw new StoreError("invalid_argument", `Not a document path: ${path}`);
  return { coll: p.slice(0, -1).join("/"), id: p[p.length - 1] };
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isDel = (v) => isObj(v) && v.__delete__ === true && Object.keys(v).length === 1;
function stripDeletes(obj) {
  if (!isObj(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!isDel(v)) out[k] = isObj(v) ? stripDeletes(v) : v;
  return out;
}
function deepMerge(base, patch) {
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (isDel(v)) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = isObj(v) ? stripDeletes(v) : v;
  }
  return out;
}

function checkSize(data) {
  if (!isObj(data)) throw new StoreError("invalid_argument", "Document data must be an object");
  if (Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) throw new StoreError("resource_exhausted", "Document is over 1 MiB");
}

function emit(space, coll) { changes.emit("change", { space, coll }); }

async function getDoc(space, path) {
  const { coll, id } = docPath(path);
  const r = await pool.query("SELECT data, version FROM docs WHERE space=$1 AND coll=$2 AND id=$3", [space, coll, id]);
  return r.rows[0] ? { id, exists: true, data: r.rows[0].data, version: r.rows[0].version } : { id, exists: false };
}

async function setDoc(space, path, data, by, ifVersion) {
  checkSize(data);
  const { coll, id } = docPath(path);
  const clean = stripDeletes(data);
  if (ifVersion != null) {
    const r = await pool.query(
      "UPDATE docs SET data=$4, version=version+1, updated_at=now(), updated_by=$5 WHERE space=$1 AND coll=$2 AND id=$3 AND version=$6 RETURNING version",
      [space, coll, id, clean, by || null, ifVersion]);
    if (!r.rowCount) throw new StoreError("stale", "Document changed since it was read");
    emit(space, coll);
    return r.rows[0].version;
  }
  const r = await pool.query(
    `INSERT INTO docs (space, coll, id, data, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (space, coll, id) DO UPDATE SET data=EXCLUDED.data, version=docs.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING version`, [space, coll, id, clean, by || null]);
  emit(space, coll);
  return r.rows[0].version;
}

async function updateDoc(space, path, patch, by, ifVersion) {
  checkSize(patch);
  const { coll, id } = docPath(path);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT data, version FROM docs WHERE space=$1 AND coll=$2 AND id=$3 FOR UPDATE", [space, coll, id]);
    if (!cur.rowCount) throw new StoreError("invalid_argument", `No document at ${path}`);
    if (ifVersion != null && cur.rows[0].version !== ifVersion) throw new StoreError("stale", "Document changed since it was read");
    const merged = deepMerge(cur.rows[0].data, patch);
    checkSize(merged);
    const r = await client.query(
      "UPDATE docs SET data=$4, version=version+1, updated_at=now(), updated_by=$5 WHERE space=$1 AND coll=$2 AND id=$3 RETURNING version",
      [space, coll, id, merged, by || null]);
    await client.query("COMMIT");
    emit(space, coll);
    return r.rows[0].version;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function deleteDoc(space, path, ifVersion) {
  const { coll, id } = docPath(path);
  const r = ifVersion != null
    ? await pool.query("DELETE FROM docs WHERE space=$1 AND coll=$2 AND id=$3 AND version=$4", [space, coll, id, ifVersion])
    : await pool.query("DELETE FROM docs WHERE space=$1 AND coll=$2 AND id=$3", [space, coll, id]);
  if (ifVersion != null && !r.rowCount) {
    const still = await getDoc(space, path);
    if (still.exists) throw new StoreError("stale", "Document changed since it was read");
  }
  if (r.rowCount) emit(space, coll);
}

async function addDoc(space, coll, data, by) {
  const id = crypto.randomBytes(10).toString("base64url");
  await setDoc(space, `${collPath(coll)}/${id}`, data, by);
  return id;
}

// ---- queries ----
const getField = (obj, field) => String(field).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const OPS = { eq: "==", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
function matches(v, op, want) {
  switch (OPS[op] || op) {
    case "==": return JSON.stringify(v) === JSON.stringify(want);
    case "!=": return v !== undefined && JSON.stringify(v) !== JSON.stringify(want);
    case "<": return v != null && v < want;
    case "<=": return v != null && v <= want;
    case ">": return v != null && v > want;
    case ">=": return v != null && v >= want;
    case "in": return Array.isArray(want) && want.some((w) => JSON.stringify(w) === JSON.stringify(v));
    case "not-in": return v !== undefined && Array.isArray(want) && !want.some((w) => JSON.stringify(w) === JSON.stringify(v));
    case "array-contains": return Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(want));
    case "array-contains-any": return Array.isArray(v) && Array.isArray(want) && v.some((x) => want.some((w) => JSON.stringify(w) === JSON.stringify(x)));
    default: throw new StoreError("invalid_argument", `Unsupported operator ${op}`);
  }
}
const cmp = (a, b) => (a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : 1);

async function query(space, coll, q = {}) {
  coll = collPath(coll);
  const r = await pool.query("SELECT id, data, version FROM docs WHERE space=$1 AND coll=$2 ORDER BY id", [space, coll]);
  let rows = r.rows.map((x) => ({ id: x.id, data: x.data, version: x.version }));
  for (const [f, op, v] of q.where || []) rows = rows.filter((d) => matches(getField(d.data, f), op, v));
  const order = q.orderBy || [];
  if (order.length) rows.sort((a, b) => {
    for (const [f, dir] of order) { const c = cmp(getField(a.data, f), getField(b.data, f)); if (c) return dir === "desc" ? -c : c; }
    return 0;
  });
  if (q.limit) rows = rows.slice(0, Math.max(0, +q.limit));
  return rows;
}

async function listSpaces() {
  const r = await pool.query("SELECT DISTINCT space FROM docs ORDER BY space");
  return r.rows.map((x) => x.space);
}

module.exports = { changes, StoreError, getDoc, setDoc, updateDoc, deleteDoc, addDoc, query, collPath, docPath, deepMerge, listSpaces };
