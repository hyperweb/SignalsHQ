// Signals HQ server: sign-in, the HQ and desk pages, their data API, and the runner API.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { pool, migrate } = require("./lib/db");
const store = require("./lib/store");
const auth = require("./lib/auth");
const connectors = require("./lib/connectors");
const views = require("./lib/views");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

const baseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sendErr = (res, e) => {
  const code = e.code || "unavailable";
  const status = { invalid_argument: 400, not_granted: 403, permission_denied: 403, not_found: 404, stale: 409, rate_limited: 429, resource_exhausted: 413, server_not_connected: 501, tool_not_found: 501 }[code] || 500;
  if (status === 500) console.error(e);
  res.status(status).json({ code, message: e.message || "Something went wrong" });
};

// security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
// state-changing API calls must come from this site
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.path.startsWith("/runner/")) return next();
  const origin = req.get("origin");
  if (origin && origin.replace(/\/$/, "") !== baseUrl(req)) return res.status(403).json({ code: "permission_denied", message: "Cross-site request refused" });
  next();
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/healthz", wrap(async (req, res) => { await pool.query("SELECT 1"); res.send("ok"); }));

// ---------- sign-in ----------
app.get("/login", (req, res) => res.send(views.login({ next: auth.safeNext(req.query.next), sent: false })));
const loginHits = new Map();
app.post("/login", express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const email = auth.normEmail(req.body.email);
  const key = `${req.ip}|${email}`, now = Date.now();
  const hits = (loginHits.get(key) || []).filter((t) => now - t < 15 * 60e3);
  if (hits.length < 5) { hits.push(now); loginHits.set(key, hits); await auth.sendLoginLink(email, req.body.next, baseUrl(req)).catch((e) => console.error("[login]", e.message)); }
  res.send(views.login({ next: auth.safeNext(req.body.next), sent: true, email }));
}));
app.get("/auth/verify", wrap(async (req, res) => {
  const r = await auth.verifyLoginToken(req.query.t);
  if (!r) return res.status(400).send(views.login({ next: "/", sent: false, error: "That link has expired or was already used. Ask for a new one." }));
  auth.setSessionCookie(res, r.session);
  res.redirect(r.next || "/");
}));
app.post("/logout", wrap(async (req, res) => { await auth.logout(req); auth.clearSessionCookie(res); res.redirect("/login"); }));

// ---------- session middleware ----------
const needUser = wrap(async (req, res, next) => {
  req.user = await auth.sessionUser(req);
  if (req.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ code: "not_granted", message: "Sign in first" });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});
const needSpace = (req, res, next) => {
  const space = req.params.space;
  const a = auth.access(req.user, space);
  if (!a.read) return res.status(403).json({ code: "not_granted", message: "You don't have access to this desk" });
  req.space = space; req.acc = a; next();
};
const needWrite = (req, res, next) => (req.acc.write ? next() : res.status(403).json({ code: "permission_denied", message: "Your access lets you view this but not change it" }));

// ---------- pages ----------
async function deskList(user) {
  const rows = await store.query("hq", "desks");
  return rows.filter((d) => user.role === "staff" || user.desks.includes(d.id))
    .filter((d) => !["Archived", "Delete requested"].includes(d.data.status) || user.role === "staff")
    .map((d) => ({ id: d.id, name: d.data.name, type: d.data.type, status: d.data.status }));
}
app.get("/", needUser, wrap(async (req, res) => {
  if (req.user.role === "staff") return res.redirect("/hq");
  const desks = await deskList(req.user);
  if (desks.length === 1) return res.redirect(`/desk/${encodeURIComponent(desks[0].id)}`);
  res.send(views.chooser({ user: req.user, desks }));
}));
app.get("/hq", needUser, (req, res) => {
  if (req.user.role !== "staff") return res.redirect("/");
  res.send(views.page("hq", "hq", req.user));
});
app.get("/desk/:id", needUser, wrap(async (req, res) => {
  const space = `desk:${req.params.id}`;
  if (!auth.access(req.user, space).read) return res.status(403).send(views.message("No access", "Your account doesn't have this desk. Ask Hyperweb to add it."));
  const desk = await store.getDoc("hq", `desks/${req.params.id}`);
  if (!desk.exists) return res.status(404).send(views.message("Desk not found", "There's no desk at this address."));
  res.send(views.page("desk", space, req.user, { deskName: desk.data.name }));
}));
app.get("/admin", needUser, (req, res) => (req.user.role === "staff" ? res.send(views.admin(req.user)) : res.redirect("/")));

// ---------- page data API ----------
const S = "/api/s/:space";
app.get(`${S}/doc`, needUser, needSpace, wrap(async (req, res) => {
  try { const d = await store.getDoc(req.space, req.query.path); res.json({ exists: d.exists, data: d.data || null }); } catch (e) { sendErr(res, e); }
}));
app.put(`${S}/doc`, needUser, needSpace, needWrite, wrap(async (req, res) => {
  try { await store.setDoc(req.space, req.body.path, req.body.data, req.user.id); res.json({ ok: true }); } catch (e) { sendErr(res, e); }
}));
app.patch(`${S}/doc`, needUser, needSpace, needWrite, wrap(async (req, res) => {
  try { await store.updateDoc(req.space, req.body.path, req.body.data, req.user.id); res.json({ ok: true }); } catch (e) { sendErr(res, e); }
}));
app.delete(`${S}/doc`, needUser, needSpace, needWrite, wrap(async (req, res) => {
  try { await store.deleteDoc(req.space, req.query.path); res.json({ ok: true }); } catch (e) { sendErr(res, e); }
}));
app.post(`${S}/add`, needUser, needSpace, needWrite, wrap(async (req, res) => {
  try { res.json({ id: await store.addDoc(req.space, req.body.coll, req.body.data, req.user.id) }); } catch (e) { sendErr(res, e); }
}));
app.post(`${S}/query`, needUser, needSpace, wrap(async (req, res) => {
  try {
    const q = req.body || {};
    const rows = await store.query(req.space, q.coll, { where: q.where, orderBy: q.orderBy, limit: q.limit });
    res.json({ docs: rows.map((r) => ({ id: r.id, data: r.data })) });
  } catch (e) { sendErr(res, e); }
}));
app.get(`${S}/events`, needUser, needSpace, (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": connected\n\n");
  const on = (c) => { if (c.space === req.space) res.write(`event: change\ndata: ${JSON.stringify({ coll: c.coll })}\n\n`); };
  store.changes.on("change", on);
  const beat = setInterval(() => res.write(": ping\n\n"), 25e3);
  req.on("close", () => { clearInterval(beat); store.changes.off("change", on); });
});
app.post(`${S}/mcp`, needUser, needSpace, needWrite, wrap(async (req, res) => {
  try { res.json(await connectors.callTool(req.body.server, req.body.tool, req.body.input, req.acc)); } catch (e) { sendErr(res, e); }
}));
app.get(`${S}/mcp/tools`, needUser, needSpace, (req, res) => res.json({ tools: connectors.listTools() }));
const sampleHits = new Map();
app.post(`${S}/sample`, needUser, needSpace, needWrite, wrap(async (req, res) => {
  const now = Date.now(), hits = (sampleHits.get(req.user.id) || []).filter((t) => now - t < 60e3);
  if (hits.length >= 20) return sendErr(res, { code: "rate_limited", message: "Too many Claude requests, wait a minute" });
  hits.push(now); sampleHits.set(req.user.id, hits);
  try { res.json(await connectors.sample(req.body.input, { modelTier: req.body.modelTier, json: !!req.body.json })); } catch (e) { sendErr(res, e); }
}));

// people
app.post("/api/users/profiles", needUser, wrap(async (req, res) => {
  const ids = (req.body.ids || []).slice(0, 64).map(String);
  const r = await pool.query("SELECT id, name, email, role FROM users WHERE id = ANY($1)", [ids]);
  const profiles = {};
  for (const u of r.rows) profiles[u.id] = { id: u.id, name: u.name || u.email.split("@")[0], guest: u.role !== "staff" };
  res.json({ profiles });
}));
app.post("/api/users/search", needUser, wrap(async (req, res) => {
  const q = `%${String(req.body.q || "").toLowerCase()}%`;
  const r = await pool.query("SELECT id, name, email, role FROM users WHERE active AND (lower(name) LIKE $1 OR email LIKE $1) AND (role='staff' OR $2::text = ANY(ARRAY(SELECT 'desk:'||unnest(desks)))) LIMIT 20", [q, req.body.space || ""]);
  res.json({ hits: r.rows.map((u) => ({ id: u.id, name: u.name || u.email.split("@")[0], guest: u.role !== "staff" })) });
}));

// ---------- admin (staff) ----------
const needStaff = (req, res, next) => (req.user.role === "staff" ? next() : res.status(403).json({ code: "not_granted", message: "Hyperweb team only" }));
app.get("/api/admin/users", needUser, needStaff, wrap(async (req, res) => {
  const r = await pool.query("SELECT id, email, name, role, desks, can_write, active, last_login FROM users ORDER BY role, email");
  res.json({ users: r.rows, desks: (await store.query("hq", "desks")).map((d) => ({ id: d.id, name: d.data.name, type: d.data.type, status: d.data.status })) });
}));
app.post("/api/admin/users", needUser, needStaff, wrap(async (req, res) => {
  try {
    const b = req.body;
    if (auth.normEmail(b.email) === req.user.email && (b.role !== "staff" || b.active === false)) throw Object.assign(new Error("You can't remove your own Hyperweb access"), { code: "invalid_argument" });
    const u = await auth.upsertUser({ email: b.email, name: b.name, role: b.role, desks: Array.isArray(b.desks) ? b.desks.map(String) : [], canWrite: b.canWrite !== false, active: b.active !== false });
    if (!u.active) await pool.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
    res.json({ user: u });
  } catch (e) { sendErr(res, { code: e.code || "invalid_argument", message: e.message }); }
}));
app.post("/api/admin/users/link", needUser, needStaff, wrap(async (req, res) => {
  await auth.sendLoginLink(req.body.email, "/", baseUrl(req));
  res.json({ ok: true });
}));

// ---------- runner API (bearer token) ----------
const needRunner = (req, res, next) => {
  const want = process.env.RUNNER_TOKEN || "";
  const got = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (want.length >= 32 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return next();
  res.status(401).json({ code: "not_granted", message: "Bad runner token" });
};
const R = "/api/runner";
app.get(`${R}/spaces`, needRunner, wrap(async (req, res) => res.json({ spaces: await store.listSpaces() })));
app.post(`${R}/query`, needRunner, wrap(async (req, res) => {
  try { const q = req.body; res.json({ docs: await store.query(q.space, q.coll, { where: q.where, orderBy: q.orderBy, limit: q.limit }) }); } catch (e) { sendErr(res, e); }
}));
app.get(`${R}/doc`, needRunner, wrap(async (req, res) => {
  try { res.json(await store.getDoc(req.query.space, req.query.path)); } catch (e) { sendErr(res, e); }
}));
app.put(`${R}/doc`, needRunner, wrap(async (req, res) => {
  try { const b = req.body; res.json({ version: await store.setDoc(b.space, b.path, b.data, "runner", b.ifVersion) }); } catch (e) { sendErr(res, e); }
}));
app.patch(`${R}/doc`, needRunner, wrap(async (req, res) => {
  try { const b = req.body; res.json({ version: await store.updateDoc(b.space, b.path, b.data, "runner", b.ifVersion) }); } catch (e) { sendErr(res, e); }
}));
app.delete(`${R}/doc`, needRunner, wrap(async (req, res) => {
  try { await store.deleteDoc(req.query.space, req.query.path, req.query.ifVersion ? +req.query.ifVersion : undefined); res.json({ ok: true }); } catch (e) { sendErr(res, e); }
}));
// Remove every document in one desk's space (used when HQ deletes a desk). HQ itself can't be removed this way.
app.post(`${R}/delete-space`, needRunner, wrap(async (req, res) => {
  const space = String(req.body.space || "");
  if (!/^desk:[A-Za-z0-9_\-.~:@+]{1,200}$/.test(space) || req.body.confirm !== space) return sendErr(res, { code: "invalid_argument", message: "Pass {space: \"desk:<id>\", confirm: \"desk:<id>\"}" });
  const r = await pool.query("DELETE FROM docs WHERE space=$1", [space]);
  await pool.query("UPDATE users SET desks = array_remove(desks, $1)", [space.slice(5)]);
  res.json({ ok: true, deleted: r.rowCount });
}));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ code: "unavailable", message: "Server error" }); });

const port = +process.env.PORT || 8080;
migrate().then(() => app.listen(port, () => console.log(`Signals HQ on :${port}`))).catch((e) => { console.error("Startup failed:", e); process.exit(1); });
