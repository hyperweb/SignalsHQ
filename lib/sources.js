// Signal sources, managed apart from the desks.
//
//   catalog (signal_sources)  every source Hyperweb runs, with its method, config, status and UTM code
//   packs                     bundles of sources (Core, Arborist pack) granted to a desk in one tick
//   desk settings             a desk's territory, daily cap and pause switch
//   desk overrides            per desk and source: access (inherit / on / Hyperweb only / off) and parameters
//   pool (source_items)       everything a source found, stored once, screened, then routed
//   deliveries                which desk got which item, and whether it's still held for the Hyperweb team
//
// Routing: a source's items go to every desk whose effective access isn't Off. A source in Testing
// only ever delivers as "Hyperweb only": the desk's team view shows it, the client view doesn't
// (the server filters it out). Going Live releases the held items still waiting on each desk.
const { pool } = require("./db");
const store = require("./store");
const methods = require("./methods");

const STATUSES = ["Draft", "Testing", "Live", "Paused", "Retired"];
const KINDS = { account: "Account signal", project: "Project signal", moment: "Market moment" };
const SUBJECTS = { company: "Company", property: "Property or site", public_body: "Public body", project: "Project or application", area: "Area or segment" };
const SCHEDULES = { hourly: "Every hour", "6h": "Every 6 hours", daily: "Daily", weekly: "Weekly", monthly: "Monthly", manual: "Only when run" };
const ACCESS = { inherit: "From packs", on: "On", hyperweb: "Hyperweb only", off: "Off" };
const RUNNABLE = new Set(["Testing", "Live"]);
const lowerList = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\n,;]/)).map((s) => String(s).trim()).filter(Boolean);

class SourceError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ---------- time ----------
function torontoOffsetMin(d) {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "shortOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "GMT-5";
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(s); return m ? +m[1] * 60 + Math.sign(+m[1]) * (+m[2] || 0) : -300;
}
// next run: hourly and 6h roll forward; daily/weekly/monthly land at 5:40 am Eastern so items are on desks before the day starts
function nextRun(schedule, from = new Date()) {
  if (schedule === "manual") return null;
  if (schedule === "hourly") return new Date(from.getTime() + 3600e3);
  if (schedule === "6h") return new Date(from.getTime() + 6 * 3600e3);
  const days = schedule === "weekly" ? 7 : schedule === "monthly" ? 30 : 1;
  const off = torontoOffsetMin(from);
  const local = new Date(from.getTime() + off * 60e3);
  local.setUTCHours(5, 40, 0, 0);
  let t = new Date(local.getTime() - off * 60e3);
  while (t <= from) t = new Date(t.getTime() + 86400e3);
  if (days > 1) t = new Date(t.getTime() + (days - 1) * 86400e3);
  return t;
}

// ---------- catalog ----------
const SRC_COLS = "id, name, code, method, kind, subject, mode, status, schedule, config, description, cost_note, segments, created_at, updated_at, updated_by, last_run_at, next_run_at, last_error";
async function listSources() { return (await pool.query(`SELECT ${SRC_COLS} FROM signal_sources ORDER BY status='Retired', name`)).rows; }
async function getSource(id) { const r = await pool.query(`SELECT ${SRC_COLS} FROM signal_sources WHERE id=$1`, [id]); return r.rows[0] || null; }
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

async function saveSource(b, by) {
  const id = slug(b.id || b.name);
  if (!id) throw new SourceError("invalid_argument", "Give the source a name");
  const code = slug(b.code || id).slice(0, 24);
  if (!methods.METHODS[b.method]) throw new SourceError("invalid_argument", "Pick a listening method");
  if (b.status && !STATUSES.includes(b.status)) throw new SourceError("invalid_argument", "Unknown status");
  if (b.kind && !KINDS[b.kind]) throw new SourceError("invalid_argument", "Unknown signal kind");
  if (b.schedule && !SCHEDULES[b.schedule]) throw new SourceError("invalid_argument", "Unknown schedule");
  let config = b.config ?? {};
  if (typeof config === "string") { try { config = JSON.parse(config || "{}"); } catch { throw new SourceError("invalid_argument", "The config isn't valid JSON"); } }
  const before = await getSource(id);
  const dup = await pool.query("SELECT id FROM signal_sources WHERE code=$1 AND id<>$2", [code, id]);
  if (dup.rowCount) throw new SourceError("invalid_argument", `The code ${code} is already used by ${dup.rows[0].id}`);
  const status = b.status || before?.status || "Draft", schedule = b.schedule || before?.schedule || "daily";
  const next = RUNNABLE.has(status) && (!before || !RUNNABLE.has(before.status) || before.schedule !== schedule) ? new Date() : before?.next_run_at || null;
  await pool.query(
    `INSERT INTO signal_sources (id, name, code, method, kind, subject, mode, status, schedule, config, description, cost_note, segments, updated_by, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, code=EXCLUDED.code, method=EXCLUDED.method, kind=EXCLUDED.kind, subject=EXCLUDED.subject, mode=EXCLUDED.mode,
       status=EXCLUDED.status, schedule=EXCLUDED.schedule, config=EXCLUDED.config, description=EXCLUDED.description, cost_note=EXCLUDED.cost_note, segments=EXCLUDED.segments,
       updated_at=now(), updated_by=EXCLUDED.updated_by, next_run_at=EXCLUDED.next_run_at`,
    [id, String(b.name || id).trim(), code, b.method, b.kind || "account", b.subject || "company", b.mode === "per_desk" ? "per_desk" : "shared", status, schedule,
      config, String(b.description || ""), String(b.cost_note || ""), lowerList(b.segments), by || null, next]);
  // Going live (or back on) releases items still held for the team on desks that now have it on
  if (before && before.status !== status) await reconcile({ sourceId: id });
  return getSource(id);
}
async function setStatus(id, status, by) {
  const s = await getSource(id); if (!s) throw new SourceError("not_found", "No such source");
  return saveSource({ ...s, status }, by);
}

// ---------- packs ----------
async function listPacks() {
  const r = await pool.query("SELECT p.id, p.name, p.description, coalesce(array_agg(ps.source_id) FILTER (WHERE ps.source_id IS NOT NULL), '{}') AS sources FROM source_packs p LEFT JOIN pack_sources ps ON ps.pack_id=p.id GROUP BY p.id ORDER BY p.name");
  return r.rows;
}
async function savePack(b) {
  const id = slug(b.id || b.name); if (!id) throw new SourceError("invalid_argument", "Give the pack a name");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO source_packs (id, name, description) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description", [id, String(b.name || id).trim(), String(b.description || "")]);
    if (Array.isArray(b.sources)) {
      await client.query("DELETE FROM pack_sources WHERE pack_id=$1", [id]);
      for (const s of b.sources) await client.query("INSERT INTO pack_sources (pack_id, source_id) SELECT $1, id FROM signal_sources WHERE id=$2 ON CONFLICT DO NOTHING", [id, s]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
  await reconcile({});
  return id;
}
async function deletePack(id) { await pool.query("DELETE FROM source_packs WHERE id=$1", [id]); }

// ---------- desks and access ----------
async function desks() {
  return (await store.query("hq", "desks")).filter((d) => !["Archived", "Delete requested"].includes(d.data.status)).map((d) => ({ id: d.id, name: d.data.name || d.id, type: d.data.type || "", status: d.data.status || "" }));
}
async function accessContext() {
  const [src, dp, ps, ds, set, pk] = await Promise.all([
    listSources(),
    pool.query("SELECT desk_id, pack_id FROM desk_packs"),
    pool.query("SELECT pack_id, source_id FROM pack_sources"),
    pool.query("SELECT desk_id, source_id, access, params, daily_cap FROM desk_sources"),
    pool.query("SELECT desk_id, areas, daily_cap, paused FROM desk_signal_settings"),
    pool.query("SELECT id, name FROM source_packs"),
  ]);
  const packNames = Object.fromEntries(pk.rows.map((r) => [r.id, r.name]));
  const packsOf = {}, inPack = {};
  dp.rows.forEach((r) => (packsOf[r.desk_id] ||= []).push(r.pack_id));
  ps.rows.forEach((r) => (inPack[r.pack_id] ||= new Set()).add(r.source_id));
  const over = {}; ds.rows.forEach((r) => { over[`${r.desk_id}|${r.source_id}`] = r; });
  const settings = {}; set.rows.forEach((r) => { settings[r.desk_id] = r; });
  return { sources: src, packsOf, inPack, over, settings, packNames };
}
// What a desk actually gets from a source: "on", "hyperweb" (team view only) or "off"
function effective(ctx, source, deskId) {
  if (!RUNNABLE.has(source.status)) return "off";
  const o = ctx.over[`${deskId}|${source.id}`], explicit = o?.access || "inherit";
  if (explicit === "off") return "off";
  const viaPack = (ctx.packsOf[deskId] || []).some((p) => ctx.inPack[p]?.has(source.id));
  const want = explicit === "inherit" ? (viaPack ? "on" : "off") : explicit;
  if (want === "off") return "off";
  return source.status === "Testing" ? "hyperweb" : want;
}
function why(ctx, source, deskId) {
  const o = ctx.over[`${deskId}|${source.id}`], explicit = o?.access || "inherit";
  const packs = (ctx.packsOf[deskId] || []).filter((p) => ctx.inPack[p]?.has(source.id));
  if (!RUNNABLE.has(source.status)) return `Source is ${source.status}`;
  if (explicit === "off") return "Turned off for this desk";
  if (explicit === "inherit") return packs.length ? `From ${packs.map((p) => ctx.packNames[p] || p).join(", ")}${source.status === "Testing" ? ", held while the source is in Testing" : ""}` : "Not in any of this desk's packs";
  return `Set to ${ACCESS[explicit]} for this desk${source.status === "Testing" && explicit === "on" ? ", held while the source is in Testing" : ""}`;
}
async function matrix() {
  const ctx = await accessContext(), ds = await desks(), packs = await listPacks();
  return {
    desks: ds.map((d) => ({ ...d, packs: ctx.packsOf[d.id] || [], settings: ctx.settings[d.id] || { areas: [], daily_cap: null, paused: false } })),
    packs, sources: ctx.sources.map((s) => ({ id: s.id, name: s.name, code: s.code, status: s.status, kind: s.kind, mode: s.mode, method: s.method })),
    cells: Object.fromEntries(ds.flatMap((d) => ctx.sources.map((s) => {
      const o = ctx.over[`${d.id}|${s.id}`];
      return [`${d.id}|${s.id}`, { access: o?.access || "inherit", params: o?.params || {}, daily_cap: o?.daily_cap ?? null, effective: effective(ctx, s, d.id), why: why(ctx, s, d.id) }];
    }))),
  };
}
async function setDeskPacks(deskId, packIds) {
  await pool.query("DELETE FROM desk_packs WHERE desk_id=$1", [deskId]);
  for (const p of packIds || []) await pool.query("INSERT INTO desk_packs (desk_id, pack_id) SELECT $1, id FROM source_packs WHERE id=$2 ON CONFLICT DO NOTHING", [deskId, p]);
  await reconcile({ deskId });
}
async function setDeskSettings(deskId, b, by) {
  const cap = b.daily_cap === "" || b.daily_cap == null ? null : Math.max(0, parseInt(b.daily_cap, 10) || 0);
  await pool.query(`INSERT INTO desk_signal_settings (desk_id, areas, daily_cap, paused, updated_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (desk_id) DO UPDATE SET areas=EXCLUDED.areas, daily_cap=EXCLUDED.daily_cap, paused=EXCLUDED.paused, updated_at=now(), updated_by=EXCLUDED.updated_by`,
  [deskId, lowerList(b.areas), cap, !!b.paused, by || null]);
}
async function setDeskSource(deskId, sourceId, b, by) {
  if (b.access && !ACCESS[b.access]) throw new SourceError("invalid_argument", "Unknown access setting");
  let params = b.params ?? {};
  if (typeof params === "string") { try { params = JSON.parse(params || "{}"); } catch { throw new SourceError("invalid_argument", "Parameters aren't valid JSON"); } }
  const cap = b.daily_cap === "" || b.daily_cap == null ? null : Math.max(0, parseInt(b.daily_cap, 10) || 0);
  await pool.query(`INSERT INTO desk_sources (desk_id, source_id, access, params, daily_cap, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (desk_id, source_id) DO UPDATE SET access=EXCLUDED.access, params=EXCLUDED.params, daily_cap=EXCLUDED.daily_cap, updated_at=now(), updated_by=EXCLUDED.updated_by`,
  [deskId, sourceId, b.access || "inherit", params, cap, by || null]);
  await reconcile({ deskId, sourceId });
}

// Release items held for the team wherever access is now plainly On. Only items nobody has acted on.
async function reconcile({ sourceId, deskId } = {}) {
  const ctx = await accessContext();
  const r = await pool.query(`SELECT item_id, desk_id, source_id, coll, doc_id FROM deliveries WHERE hq_only AND released_at IS NULL
    AND ($1::text IS NULL OR source_id=$1) AND ($2::text IS NULL OR desk_id=$2)`, [sourceId || null, deskId || null]);
  let n = 0;
  for (const d of r.rows) {
    const s = ctx.sources.find((x) => x.id === d.source_id); if (!s || effective(ctx, s, d.desk_id) !== "on") continue;
    const doc = await store.getDoc(`desk:${d.desk_id}`, `${d.coll}/${d.doc_id}`);
    if (doc.exists && (doc.data.status || "New") === "New") {
      await store.updateDoc(`desk:${d.desk_id}`, `${d.coll}/${d.doc_id}`, { hqOnly: false, releasedAt: new Date().toISOString() }, "sources");
      await pool.query("UPDATE deliveries SET hq_only=false, released_at=now() WHERE item_id=$1 AND desk_id=$2", [d.item_id, d.desk_id]);
      n++;
    }
  }
  return n;
}

// ---------- routing ----------
function areaOk(itemArea, areas, allowBlank) {
  if (!areas.length) return true;
  if (!itemArea) return allowBlank;
  const a = itemArea.toLowerCase();
  return areas.some((x) => a.includes(x.toLowerCase()) || x.toLowerCase().includes(a));
}
function deskDoc(source, item, hqOnly, screenNote) {
  const cap = (t) => String(t || "").replace(/^\s*([a-z])/, (m, c) => m.replace(c, c.toUpperCase()));
  item = { ...item, title: cap(item.title), company: cap(item.company) };
  const now = new Date().toISOString(), base = { sourceId: source.id, sourceCode: source.code, sourceName: source.name, sourceKind: source.kind, subjectType: source.subject, sourceItemId: String(item.id), hqOnly, foundAt: now, via: "Signal source", status: "New" };
  if (source.kind === "moment") {
    return { coll: "moments", data: { ...base, title: item.title, detail: item.detail, area: item.area, date: item.event_date, url: item.url, source: source.name, severity: item.data?.severity || "", segments: source.segments || [] } };
  }
  return { coll: "signals", data: { ...base, company: item.company || item.title, domain: item.domain || "", city: item.area || "", industry: "", type: item.data?.type || KINDS[source.kind], detail: item.company ? [item.title, item.detail].filter(Boolean).join(". ") : item.detail, date: item.event_date || now.slice(0, 10), source: source.name, url: item.url, triage: "Review", triageNote: screenNote || "", project: source.kind === "project" } };
}
async function deliver(source, items, scope, ctx) {
  ctx = ctx || await accessContext();
  const ds = await desks();
  const targets = (scope ? ds.filter((d) => d.id === scope) : ds).map((d) => ({ d, eff: effective(ctx, source, d.id) })).filter((x) => x.eff !== "off");
  let delivered = 0;
  for (const { d, eff } of targets) {
    const set = ctx.settings[d.id] || {}, o = ctx.over[`${d.id}|${source.id}`] || {}, p = o.params || {};
    if (set.paused) continue;
    const areas = lowerList(p.areas).length ? lowerList(p.areas) : lowerList(set.areas);
    const any = lowerList(p.keywords).map((s) => s.toLowerCase()), none = lowerList(p.exclude).map((s) => s.toLowerCase());
    const capSrc = o.daily_cap ?? source.config?.dailyCap ?? null, capDesk = set.daily_cap ?? null;
    const today = await pool.query(`SELECT count(*) FILTER (WHERE source_id=$2)::int AS src, count(*)::int AS all FROM deliveries WHERE desk_id=$1 AND delivered_at > now() - interval '24 hours'`, [d.id, source.id]);
    let nSrc = today.rows[0].src, nAll = today.rows[0].all;
    for (const it of items) {
      if (capSrc != null && nSrc >= capSrc) break;
      if (capDesk != null && nAll >= capDesk) break;
      if (!areaOk(it.area, areas, p.allowNoArea !== false && source.config?.allowNoArea !== false)) continue;
      const txt = `${it.title} ${it.detail} ${it.company} ${it.area}`.toLowerCase();
      if (any.length && !any.some((k) => txt.includes(k))) continue;
      if (none.some((k) => txt.includes(k))) continue;
      const hqOnly = eff === "hyperweb";
      const { coll, data } = deskDoc(source, it, hqOnly, it.screenNote);
      const docId = `src-${it.id}`;
      const ins = await pool.query("INSERT INTO deliveries (item_id, desk_id, source_id, coll, doc_id, hq_only) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING item_id", [it.id, d.id, source.id, coll, docId, hqOnly]);
      if (!ins.rowCount) continue;
      try { await store.setDoc(`desk:${d.id}`, `${coll}/${docId}`, data, "sources"); }
      catch (e) { await pool.query("DELETE FROM deliveries WHERE item_id=$1 AND desk_id=$2", [it.id, d.id]); throw e; }
      delivered++; nSrc++; nAll++;
    }
  }
  return delivered;
}

// Store new items in the pool (duplicates are ignored), screen them, route the keepers.
async function ingest(source, scope, items, { ctx } = {}) {
  const fresh = [];
  for (const it of items) {
    if (!it || !it.key) continue;
    const r = await pool.query(`INSERT INTO source_items (source_id, scope, key, title, detail, url, event_date, company, domain, area, data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (source_id, scope, key) DO NOTHING RETURNING *`,
    [source.id, scope || "", String(it.key).slice(0, 400), methods.clip(it.title, 200), methods.clip(it.detail, 1200), String(it.url || "").slice(0, 1000), String(it.date || "").slice(0, 20),
      methods.clip(it.company, 160), methods.cleanDomain(it.domain), methods.clip(it.area, 160), it.data || {}]);
    if (r.rowCount) fresh.push(r.rows[0]);
  }
  const rule = source.config?.screen?.keepIf;
  let kept = fresh;
  if (rule && fresh.length) {
    const verdicts = await methods.screen(fresh, rule, source.description ? `Source: ${source.name}. ${source.description}` : `Source: ${source.name}.`).catch((e) => { console.error("[sources] screen", e.message); return fresh.map(() => ({ keep: true })); });
    kept = [];
    for (let i = 0; i < fresh.length; i++) {
      const v = verdicts[i] || { keep: true }, it = fresh[i];
      const patch = { company: it.company || v.company || "", area: it.area || v.area || "" };
      if (!v.keep) { await pool.query("UPDATE source_items SET dropped=$2, company=$3, area=$4 WHERE id=$1", [it.id, v.reason || "Screened out", patch.company, patch.area]); continue; }
      await pool.query("UPDATE source_items SET company=$2, area=$3 WHERE id=$1", [it.id, patch.company, patch.area]);
      kept.push({ ...it, ...patch, screenNote: v.reason || "" });
    }
  }
  const delivered = kept.length ? await deliver(source, kept, scope, ctx) : 0;
  return { new_items: fresh.length, kept: kept.length, delivered };
}

// ---------- running ----------
const running = new Set();
async function runSource(id, trigger = "manual") {
  const source = await getSource(id);
  if (!source) throw new SourceError("not_found", "No such source");
  if (!methods.METHODS[source.method]?.server) throw new SourceError("invalid_argument", `${methods.METHODS[source.method]?.label || source.method} sources are filled by the runner or by hand, not run here`);
  if (trigger !== "manual" && !RUNNABLE.has(source.status)) return [];
  if (running.has(id)) throw new SourceError("stale", "This source is already running");
  running.add(id);
  try {
    const ctx = await accessContext();
    const scopes = source.mode === "per_desk" ? (await desks()).filter((d) => effective(ctx, source, d.id) !== "off" && !(ctx.settings[d.id]?.paused)).map((d) => d.id) : [""];
    if (source.mode === "per_desk" && !scopes.length) {
      await pool.query("UPDATE signal_sources SET last_run_at=now(), next_run_at=$2, last_error=NULL WHERE id=$1", [id, nextRun(source.schedule)]);
      return [{ scope: "", status: "ok", note: "No desk has this source on" }];
    }
    const out = [];
    for (const scope of scopes) {
      const run = (await pool.query("INSERT INTO source_runs (source_id, scope, trigger) VALUES ($1,$2,$3) RETURNING id", [id, scope, trigger])).rows[0].id;
      try {
        const st = (await pool.query("SELECT state FROM source_state WHERE source_id=$1 AND scope=$2", [id, scope])).rows[0]?.state || {};
        const cfg = { ...(source.config || {}), ...(scope ? ctx.over[`${scope}|${id}`]?.params || {} : {}) };
        const res = await methods.run(source.method, cfg, st);
        if (res.state) await pool.query("INSERT INTO source_state (source_id, scope, state) VALUES ($1,$2,$3) ON CONFLICT (source_id, scope) DO UPDATE SET state=EXCLUDED.state, updated_at=now()", [id, scope, res.state]);
        // a Draft source run by hand fills the pool for a look, but delivers nothing
        const counts = RUNNABLE.has(source.status) ? await ingest(source, scope, res.items, { ctx }) : await poolOnly(source, scope, res.items);
        await pool.query("UPDATE source_runs SET status='ok', finished_at=now(), found=$2, new_items=$3, kept=$4, delivered=$5, note=$6 WHERE id=$1",
          [run, res.found || res.items.length, counts.new_items, counts.kept, counts.delivered, String(res.note || "") + (RUNNABLE.has(source.status) ? "" : ". Draft source: kept in the pool, not delivered")]);
        out.push({ scope, status: "ok", ...counts, note: res.note });
      } catch (e) {
        await pool.query("UPDATE source_runs SET status='error', finished_at=now(), error=$2 WHERE id=$1", [run, String(e.message).slice(0, 500)]);
        out.push({ scope, status: "error", error: e.message });
      }
    }
    const err = out.find((o) => o.status === "error");
    await pool.query("UPDATE signal_sources SET last_run_at=now(), next_run_at=$2, last_error=$3 WHERE id=$1", [id, nextRun(source.schedule), err ? err.error : null]);
    return out;
  } finally { running.delete(id); }
}
async function poolOnly(source, scope, items) {
  let n = 0;
  for (const it of items) {
    const r = await pool.query(`INSERT INTO source_items (source_id, scope, key, title, detail, url, event_date, company, domain, area, data, dropped)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Draft source, not delivered') ON CONFLICT DO NOTHING`, [source.id, scope || "", String(it.key).slice(0, 400), methods.clip(it.title, 200), methods.clip(it.detail, 1200), String(it.url || "").slice(0, 1000), String(it.date || "").slice(0, 20), methods.clip(it.company, 160), methods.cleanDomain(it.domain), methods.clip(it.area, 160), it.data || {}]);
    n += r.rowCount;
  }
  return { new_items: n, kept: 0, delivered: 0 };
}

// Items pushed in by the Claude runner or pasted by the team
async function push(id, { scope = "", items = [], note = "", trigger = "runner" } = {}) {
  const source = await getSource(id);
  if (!source) throw new SourceError("not_found", "No such source");
  if (!Array.isArray(items)) throw new SourceError("invalid_argument", "items must be a list");
  const norm = items.slice(0, 500).map((it, i) => ({ ...it, key: String(it.key || it.url || methods.sha(`${it.title}|${it.company}|${it.date}|${i}`)), data: { ...(it.data || {}), type: it.type || it.data?.type || "" } }));
  const run = (await pool.query("INSERT INTO source_runs (source_id, scope, trigger, found) VALUES ($1,$2,$3,$4) RETURNING id", [id, scope, trigger, norm.length])).rows[0].id;
  const counts = RUNNABLE.has(source.status) ? await ingest(source, scope, norm) : await poolOnly(source, scope, norm);
  await pool.query("UPDATE source_runs SET status='ok', finished_at=now(), new_items=$2, kept=$3, delivered=$4, note=$5 WHERE id=$1", [run, counts.new_items, counts.kept, counts.delivered, String(note || "").slice(0, 500)]);
  if (trigger === "runner") await pool.query("UPDATE signal_sources SET last_run_at=now(), next_run_at=$2, last_error=NULL WHERE id=$1", [id, nextRun(source.schedule)]);
  return { run, ...counts };
}

// What the Claude runner should do now: runner sources that are due, with each desk's parameters
async function dueForRunner({ all = false } = {}) {
  const ctx = await accessContext(), ds = await desks();
  return ctx.sources.filter((s) => s.method === "runner" && RUNNABLE.has(s.status) && (all || !s.next_run_at || new Date(s.next_run_at) <= new Date())).map((s) => {
    const on = ds.map((d) => ({ desk: d, eff: effective(ctx, s, d.id) })).filter((x) => x.eff !== "off" && !ctx.settings[x.desk.id]?.paused);
    return {
      id: s.id, name: s.name, code: s.code, kind: s.kind, subject: s.subject, mode: s.mode, status: s.status, instructions: s.config?.instructions || s.description, config: s.config,
      desks: on.map((x) => ({ id: x.desk.id, name: x.desk.name, access: x.eff, areas: lowerList(ctx.over[`${x.desk.id}|${s.id}`]?.params?.areas).length ? lowerList(ctx.over[`${x.desk.id}|${s.id}`].params.areas) : lowerList(ctx.settings[x.desk.id]?.areas), params: ctx.over[`${x.desk.id}|${s.id}`]?.params || {} })),
    };
  }).filter((s) => s.desks.length);
}

// ---------- scheduler ----------
let timer = null;
async function tick() {
  const lock = await pool.query("SELECT pg_try_advisory_lock(424242) AS ok");
  if (!lock.rows[0].ok) return;
  try {
    const due = await pool.query(`SELECT id FROM signal_sources WHERE status IN ('Testing','Live') AND schedule<>'manual' AND method IN ('feed','page_watch','registry','alert_inbox')
      AND (next_run_at IS NULL OR next_run_at <= now()) ORDER BY next_run_at NULLS FIRST LIMIT 3`);
    for (const r of due.rows) await runSource(r.id, "schedule").catch((e) => console.error(`[sources] ${r.id}:`, e.message));
  } finally { await pool.query("SELECT pg_advisory_unlock(424242)"); }
}
function startScheduler() {
  if (timer || process.env.SOURCES_SCHEDULER === "off") return;
  timer = setInterval(() => tick().catch((e) => console.error("[sources] tick", e.message)), 60e3);
  setTimeout(() => tick().catch(() => {}), 15e3);
}

// ---------- reporting ----------
async function scorecard() {
  const [items, runs, deliv, outcomes, leads] = await Promise.all([
    pool.query(`SELECT source_id, count(*)::int AS items, count(*) FILTER (WHERE dropped IS NOT NULL)::int AS dropped, count(*) FILTER (WHERE found_at > now() - interval '30 days')::int AS items30 FROM source_items GROUP BY source_id`),
    pool.query(`SELECT DISTINCT ON (source_id) source_id, status, started_at, finished_at, found, new_items, kept, delivered, note, error FROM source_runs ORDER BY source_id, started_at DESC`),
    pool.query(`SELECT source_id, count(*)::int AS delivered, count(*) FILTER (WHERE hq_only AND released_at IS NULL)::int AS held, count(DISTINCT desk_id)::int AS desks FROM deliveries GROUP BY source_id`),
    pool.query(`SELECT data->>'sourceId' AS source_id, coalesce(data->>'status','New') AS status, count(*)::int AS n FROM docs WHERE coll IN ('signals','moments') AND data ? 'sourceId' GROUP BY 1,2`),
    pool.query(`SELECT data->>'sourceId' AS source_id, coalesce(data->>'stage','New') AS stage, count(*)::int AS n FROM docs WHERE coll='leads' AND data ? 'sourceId' AND data->>'sourceId' <> '' GROUP BY 1,2`),
  ]);
  const out = {};
  const at = (id) => (out[id] ||= { items: 0, dropped: 0, items30: 0, delivered: 0, held: 0, desks: 0, accepted: 0, dismissed: 0, waiting: 0, won: 0, leads: 0, lastRun: null });
  items.rows.forEach((r) => Object.assign(at(r.source_id), { items: r.items, dropped: r.dropped, items30: r.items30 }));
  deliv.rows.forEach((r) => Object.assign(at(r.source_id), { delivered: r.delivered, held: r.held, desks: r.desks }));
  runs.rows.forEach((r) => { at(r.source_id).lastRun = r; });
  outcomes.rows.forEach((r) => { const o = at(r.source_id); if (r.status === "Accepted" || r.status === "Used") o.accepted += r.n; else if (r.status === "Dismissed") o.dismissed += r.n; else o.waiting += r.n; });
  leads.rows.forEach((r) => { const o = at(r.source_id); o.leads += r.n; if (r.stage === "Won") o.won += r.n; });
  return out;
}
async function runsFor(id, limit = 30) { return (await pool.query("SELECT * FROM source_runs WHERE ($1::text IS NULL OR source_id=$1) ORDER BY started_at DESC LIMIT $2", [id || null, limit])).rows; }
async function poolFor(id, limit = 60) {
  return (await pool.query(`SELECT i.*, coalesce((SELECT json_agg(json_build_object('desk', d.desk_id, 'held', d.hq_only AND d.released_at IS NULL)) FROM deliveries d WHERE d.item_id=i.id), '[]') AS sent
    FROM source_items i WHERE ($1::text IS NULL OR source_id=$1) ORDER BY found_at DESC, id DESC LIMIT $2`, [id || null, limit])).rows;
}

module.exports = {
  STATUSES, KINDS, SUBJECTS, SCHEDULES, ACCESS, METHODS: methods.METHODS, SourceError,
  listSources, getSource, saveSource, setStatus, listPacks, savePack, deletePack,
  desks, matrix, setDeskPacks, setDeskSettings, setDeskSource, reconcile, accessContext, effective,
  runSource, push, dueForRunner, tick, startScheduler, scorecard, runsFor, poolFor, nextRun, parsePasted: methods.parsePasted,
};
