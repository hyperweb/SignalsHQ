/* Signals HQ runtime: gives the pages the same window.claude.use(...) API they were
   built on, backed by this server instead of claude.ai. Supports db, user, mcp, sample. */
(function () {
  "use strict";
  const CFG = window.__SHQ || {};
  const SPACE = encodeURIComponent(CFG.space || "");
  const base = `/api/s/${SPACE}`;

  const err = (code, message) => ({ code, message });
  async function api(method, url, body, signal) {
    let r;
    try {
      r = await fetch(url, { method, credentials: "same-origin", signal, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (e && e.name === "AbortError") throw err("cancelled", "Cancelled");
      throw err("unavailable", "Couldn't reach Signals HQ");
    }
    if (r.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname); throw err("not_granted", "Signed out"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err(j.code || "unavailable", j.message || `Request failed (${r.status})`);
    return j;
  }

  /* ---------- db ---------- */
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (id, exists, data) => ({ id, exists, data: () => (exists ? JSON.parse(JSON.stringify(data)) : undefined), metadata: meta });
  const segs = (p) => String(p).split("/").filter(Boolean);

  // live updates: one EventSource for the page, listeners keyed by collection path
  const listeners = new Map();
  let es = null;
  function listen(coll, fn) {
    if (!listeners.has(coll)) listeners.set(coll, new Set());
    listeners.get(coll).add(fn);
    if (!es) {
      es = new EventSource(`${base}/events`);
      es.addEventListener("change", (ev) => {
        let c; try { c = JSON.parse(ev.data).coll; } catch (e) { return; }
        (listeners.get(c) || []).forEach((f) => f());
      });
      es.addEventListener("open", () => listeners.forEach((set) => set.forEach((f) => f())));
    }
    return () => listeners.get(coll)?.delete(fn);
  }

  function makeQuery(coll, q) {
    const run = async () => {
      const j = await api("POST", `${base}/query`, { coll, where: q.where, orderBy: q.orderBy, limit: q.limit });
      return j.docs;
    };
    const toSnap = (rows, prev) => {
      const docs = rows.map((d) => docSnap(d.id, true, d.data));
      const prevIds = prev ? prev.map((d) => d.id) : [];
      return {
        docs, size: docs.length, empty: !docs.length, metadata: meta,
        docChanges: () => {
          const out = docs.map((d, i) => ({ type: prevIds.includes(d.id) ? "modified" : "added", doc: d, oldIndex: prevIds.indexOf(d.id), newIndex: i }));
          prevIds.forEach((id, i) => { if (!rows.some((r) => r.id === id)) out.push({ type: "removed", doc: docSnap(id, false), oldIndex: i, newIndex: -1 }); });
          return out;
        },
      };
    };
    const self = {
      where: (f, op, v) => makeQuery(coll, { ...q, where: [...(q.where || []), [f, op, v]] }),
      orderBy: (f, dir) => makeQuery(coll, { ...q, orderBy: [...(q.orderBy || []), [f, dir || "asc"]] }),
      limit: (n) => makeQuery(coll, { ...q, limit: n }),
      get: async () => toSnap(await run()),
      onSnapshot(next, error) {
        let prev = null, live = true, inflight = false, again = false;
        const pull = async () => {
          if (!live) return;
          if (inflight) { again = true; return; }
          inflight = true;
          try { const rows = await run(); if (live) { const s = toSnap(rows, prev); prev = rows; next(s); } }
          catch (e) { if (live && error) error(e); }
          inflight = false;
          if (again) { again = false; pull(); }
        };
        const off = listen(coll, pull);
        pull();
        return () => { live = false; off(); };
      },
    };
    return self;
  }

  function collectionRef(path) {
    const p = segs(path).join("/");
    return Object.assign(makeQuery(p, {}), {
      path: p,
      doc: (id) => docRef(`${p}/${id || Math.random().toString(36).slice(2, 12) + Date.now().toString(36)}`),
      add: async (data) => { const j = await api("POST", `${base}/add`, { coll: p, data }); return docRef(`${p}/${j.id}`); },
    });
  }
  function docRef(path) {
    const s = segs(path), p = s.join("/"), id = s[s.length - 1], coll = s.slice(0, -1).join("/");
    return {
      id, path: p,
      get: async () => { const j = await api("GET", `${base}/doc?path=${encodeURIComponent(p)}`); return docSnap(id, j.exists, j.data); },
      set: async (data) => { await api("PUT", `${base}/doc`, { path: p, data }); },
      update: async (data) => { await api("PATCH", `${base}/doc`, { path: p, data }); },
      delete: async () => { await api("DELETE", `${base}/doc?path=${encodeURIComponent(p)}`); },
      acquire: async (o) => { await api("PATCH", `${base}/doc`, { path: p, data: o?.data || {} }).catch(() => {}); return { acquired: true, holder: o?.holder }; },
      onSnapshot(next, error) {
        let live = true;
        const pull = async () => {
          try { const j = await api("GET", `${base}/doc?path=${encodeURIComponent(p)}`); if (live) next(docSnap(id, j.exists, j.data)); }
          catch (e) { if (live && error) error(e); }
        };
        const off = listen(coll, pull);
        pull();
        return () => { live = false; off(); };
      },
      collection: (sub) => collectionRef(`${p}/${sub}`),
    };
  }
  const db = Object.freeze({ collection: collectionRef, doc: docRef });

  /* ---------- user ---------- */
  const U = CFG.user || {};
  const user = Object.freeze({
    id: async () => U.id,
    me: async () => ({ id: U.id, name: U.name || "", email: U.email || "", guest: !U.team }),
    isOwner: () => !!U.team,
    canEdit: async () => !!U.team,
    can: async (name) => (name === "data.write" ? !!U.canWrite : null),
    profiles: async (ids) => (await api("POST", "/api/users/profiles", { ids })).profiles,
    search: async (q) => (await api("POST", "/api/users/search", { q, space: CFG.space })).hits,
  });

  /* ---------- mcp ---------- */
  const mcp = Object.freeze({
    callTool: (server, tool, input, opts) => api("POST", `${base}/mcp`, { server, tool, input }, opts?.signal),
    listTools: async () => (await api("GET", `${base}/mcp/tools`)).tools,
    describeTool: async () => { throw err("unavailable", "Tool schemas aren't served here"); },
    server: async (name) => new Proxy({}, { get: (_, tool) => async (input) => (await mcp.callTool(name, String(tool), input)).payload }),
    watchTool(server, tool, input, handler, opts) {
      let live = true;
      const pull = async () => {
        try { const r = await mcp.callTool(server, tool, input); if (live) handler({ type: "data", payload: r.payload, cache: { storedAt: new Date().toISOString() } }); }
        catch (e) { if (live) handler({ type: "error", error: e }); }
      };
      pull();
      const t = opts?.refetchInterval ? setInterval(pull, Math.max(30e3, opts.refetchInterval)) : null;
      return () => { live = false; if (t) clearInterval(t); };
    },
  });

  /* ---------- sample ---------- */
  async function sampleCall(input, opts = {}, json = false) {
    const j = await api("POST", `${base}/sample`, { input, json, modelTier: opts.modelTier || "default" }, opts.signal);
    if (typeof opts.onText === "function") try { opts.onText({ text: j.text, delta: j.text }); } catch (e) {}
    return j;
  }
  const sample = async (input, opts) => { const j = await sampleCall(input, opts); return { text: j.text, truncated: j.truncated, modelApplied: j.modelApplied }; };
  sample.json = async (input, opts) => (await sampleCall(input, opts, true)).value;
  sample.limits = async () => ({ images: false });

  const caps = { db, user, mcp, sample, permissions: Object.freeze({ state: async () => "granted", request: async () => "granted", manage: async () => {} }) };
  const enabled = new Set(CFG.capabilities || ["db", "user", "mcp", "sample"]);
  window.claude = Object.freeze({
    use: (name) => new Promise((res) => setTimeout(() => res(name === "permissions" || enabled.has(name) ? caps[name] || null : null), 0)),
  });
})();
