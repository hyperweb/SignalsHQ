// Listening methods. Each source in the catalog uses one of these; adding a source for a new
// client means configuring a method, not writing code.
//
//   feed         RSS/Atom, GeoJSON or OGC API, ArcGIS layer query, JSON list or CSV file
//   page_watch   re-read web pages and report links or passages that weren't there last time
//   registry     snapshot a list each run and report new or changed rows
//   alert_inbox  read a Gmail label or search (tender alerts, Google Alerts) and pull out each notice
//   runner       done by the scheduled Claude runner (news search, people moves, review mining, paid tools),
//                which pushes what it finds through the runner API
//   manual       pasted or uploaded by the Hyperweb team
//
// A method returns { items, state, found, note }. Items share one shape:
//   { key, title, detail, url, date, company, domain, area, data }
const crypto = require("crypto");
const gmail = require("./gmail");
const connectors = require("./connectors");

const METHODS = {
  feed: { label: "Open-data feed", server: true, help: "RSS or Atom, GeoJSON or OGC API, an ArcGIS layer query, a JSON list or a CSV file. Each new record becomes an item." },
  page_watch: { label: "Page watch", server: true, help: "Re-reads web pages and reports links (or passages) that weren't there last time. The first run only records what's there." },
  registry: { label: "Registry compare", server: true, help: "Takes a snapshot of a list each run and reports new rows and changes to the fields you watch. The first run only takes the snapshot." },
  alert_inbox: { label: "Alert inbox", server: true, help: "Reads a Gmail search (for example a tender-alert inbox) and pulls each notice out of the emails." },
  runner: { label: "Claude runner", server: false, help: "The scheduled Claude runner does the search (news, people moves, reviews, paid tools) and pushes items in. Write its instructions in the config." },
  manual: { label: "Manual or paid import", server: false, help: "The Hyperweb team pastes a CSV or list. Use for paid exports such as Altus, CoStar or Sales Navigator." },
};

class MethodError extends Error {}
const sha = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const clip = (s, n) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const cleanDomain = (d) => String(d || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

// ---------- fetching ----------
async function fetchText(url, cfg = {}) {
  const localTest = process.env.SOURCES_ALLOW_HTTP === "1" && /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url || "");
  if (!/^https:\/\//i.test(url || "") && !localTest) throw new MethodError(`Not an https address: ${url || "(blank)"}`);
  if (cfg.fetch === "firecrawl") return firecrawlText(url);
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; SignalsHQ/1.0; +https://signals.hyperweb.ca)", accept: "*/*" }, signal: AbortSignal.timeout(45e3), redirect: "follow" });
  } catch (e) {
    if (process.env.FIRECRAWL_API_KEY && cfg.fetch !== "direct") return firecrawlText(url);
    throw new MethodError(`Couldn't reach ${new URL(url).host}: ${e.cause?.code || e.message}`);
  }
  if ((r.status === 403 || r.status === 429 || r.status >= 500) && process.env.FIRECRAWL_API_KEY && cfg.fetch !== "direct") return firecrawlText(url);
  if (!r.ok) throw new MethodError(`${new URL(url).host} answered ${r.status}`);
  const text = await r.text();
  if (text.length > 25e6) throw new MethodError("The file is over 25 MB. Point the source at a smaller extract.");
  return { text, type: r.headers.get("content-type") || "" };
}
async function firecrawlText(url) {
  try {
    const p = await connectors.callTool("Firecrawl", "firecrawl_scrape", { url, formats: ["rawHtml"], onlyMainContent: false }, { team: true });
    return { text: p.payload.rawHtml || p.payload.html || p.payload.markdown || "", type: p.payload.metadata?.contentType || "text/html" };
  } catch (e) { throw new MethodError(`Firecrawl couldn't read ${url}: ${e.message}`); }
}

// ---------- parsing ----------
function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, "").trim());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}
const decode = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
const stripTags = (s) => decode(String(s || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();
function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (m) return decode(m[1]).trim();
  if (name === "link") { const h = /<link[^>]*href="([^"]+)"/i.exec(block); return h ? decode(h[1]) : ""; }
  return "";
}
function parseXmlFeed(text) {
  const blocks = text.match(/<item[\s>][\s\S]*?<\/item>/gi) || text.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const link = tag(b, "link"), guid = tag(b, "guid") || tag(b, "id");
    // Google Alerts wraps the real link: https://www.google.com/url?...&url=<real>
    let url = link; try { const u = new URL(link); if (/google\.[a-z.]+$/.test(u.host) && u.searchParams.get("url")) url = u.searchParams.get("url"); } catch {}
    return { title: stripTags(tag(b, "title")), link: url, description: stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content")), date: tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || tag(b, "dc:date"), id: guid || url };
  });
}
function getPath(obj, path) { return String(path || "").split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function parseRows(text, type, cfg = {}) {
  const t = text.trimStart();
  const fmt = cfg.format || (/^[[{]/.test(t) ? "json" : /^<\?xml|<rss|<feed|<rdf/i.test(t.slice(0, 400)) ? "xml" : /<html|<table/i.test(t.slice(0, 2000)) ? "html" : /csv|text\/plain/i.test(type) || /^[^<\n]*,[^\n]*\n/.test(t) ? "csv" : "html");
  if (fmt === "csv") return parseCsv(text);
  if (fmt === "xml") return parseXmlFeed(text);
  if (fmt === "html") return parseHtmlTable(text, cfg.table);
  let j; try { j = JSON.parse(text); } catch { throw new MethodError("The address didn't return valid JSON"); }
  if (j.error) throw new MethodError(`The service answered with an error: ${j.error.message || JSON.stringify(j.error).slice(0, 160)}`);
  let list = cfg.itemsPath ? getPath(j, cfg.itemsPath) : Array.isArray(j) ? j : j.features || j.items || j.results || j.data || j.records || [];
  if (!Array.isArray(list)) throw new MethodError(`Couldn't find a list of records${cfg.itemsPath ? " at " + cfg.itemsPath : ""}`);
  // GeoJSON / OGC API: properties; ArcGIS: attributes. Keep the feature id.
  return list.map((f) => (f && (f.properties || f.attributes) ? { _id: f.id ?? "", ...(f.properties || f.attributes) } : f));
}
function parseHtmlTable(html, which = 0) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const tb = tables[+which || 0]; if (!tb) throw new MethodError("No table found on the page");
  const trs = tb.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const cells = (tr) => (tr.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || []).map((c) => ({ text: stripTags(c).replace(/\n/g, " "), href: (/href="([^"]+)"/i.exec(c) || [])[1] || "" }));
  const head = cells(trs.shift() || "").map((c) => c.text);
  return trs.map((tr) => { const c = cells(tr); const o = {}; head.forEach((h, i) => { o[h || `col${i + 1}`] = c[i]?.text || ""; if (c[i]?.href && !o._link) o._link = c[i].href; }); return o; });
}

// "{a} - {b}" templates over a record; a bare field name works too
function fill(tpl, row) {
  if (tpl == null || tpl === "") return "";
  if (!/[{}]/.test(tpl)) { const v = getPath(row, tpl); return v == null ? "" : String(v); }
  return String(tpl).replace(/\{([^}]+)\}/g, (m, k) => { const v = getPath(row, k.trim()); return v == null ? "" : String(v); }).replace(/\s+([:,·-])\s*$/, "").trim();
}
function fmtDate(v) {
  if (v == null || v === "") return "";
  if (typeof v === "number" || /^\d{12,}$/.test(String(v))) { const d = new Date(+v); return isNaN(d) ? "" : d.toISOString().slice(0, 10); }
  const d = new Date(v); return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}
const words = (v) => (Array.isArray(v) ? v : String(v || "").split(/[\n,;]/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
function rowText(row, fields) { return (fields && fields.length ? fields.map((f) => getPath(row, f)) : Object.values(row)).filter((v) => v != null && typeof v !== "object").join(" ").toLowerCase(); }
function passes(row, cfg) {
  for (const w of cfg.where || []) {
    const v = getPath(row, w.field), s = String(v ?? "").toLowerCase(), want = w.value;
    const ok = w.op === "eq" ? s === String(want).toLowerCase() : w.op === "ne" ? s !== String(want).toLowerCase()
      : w.op === "in" ? words(want).includes(s) : w.op === "not_in" ? !words(want).includes(s)
      : w.op === "contains" ? words(want).some((x) => s.includes(x)) : w.op === "not_contains" ? !words(want).some((x) => s.includes(x))
      : w.op === "matches" ? new RegExp(want, "i").test(String(v ?? "")) : w.op === "gte" ? String(v ?? "") >= String(want) : true;
    if (!ok) return false;
  }
  const any = words(cfg.keywords), none = words(cfg.exclude);
  if (any.length || none.length) {
    const txt = rowText(row, cfg.keywordFields);
    if (any.length && !any.some((k) => txt.includes(k))) return false;
    if (none.some((k) => txt.includes(k))) return false;
  }
  return true;
}
const DEFAULT_MAP = { key: "", title: "title", detail: "description", url: "link", date: "date" };
function toItem(row, cfg, i) {
  const m = { ...DEFAULT_MAP, ...(cfg.map || {}) };
  const title = clip(fill(m.title, row), 200) || clip(Object.values(row).find((v) => typeof v === "string" && v.length > 3) || "Untitled", 200);
  const url = fill(m.url, row) || row._link || "";
  const key = clip(fill(m.key, row) || row._id || row.id || url || sha(JSON.stringify(row)), 300) || `row${i}`;
  return {
    key: String(key), title, detail: clip(fill(m.detail, row), 1200), url: /^https?:\/\//.test(url) ? url : (url && cfg.urlBase ? new URL(url, cfg.urlBase).href : ""),
    date: fmtDate(fill(m.date, row)), company: clip(fill(m.company, row), 160), domain: cleanDomain(fill(m.domain, row)), area: clip(fill(m.area, row) || cfg.area || "", 160),
    data: { type: fill(m.type, row) || cfg.signalType || "", severity: fill(m.severity, row) || "" },
  };
}

// ---------- methods ----------
async function runFeed(cfg) {
  const urls = [].concat(cfg.urls || cfg.url || []).filter(Boolean);
  if (!urls.length) throw new MethodError("Add the feed address (url) to the config");
  const items = []; let found = 0;
  for (const u of urls) {
    const { text, type } = await fetchText(u, cfg);
    const rows = parseRows(text, type, cfg);
    found += rows.length;
    rows.forEach((r, i) => { if (passes(r, cfg)) items.push(toItem(r, { ...cfg, urlBase: cfg.urlBase || u }, i)); });
  }
  const limit = +cfg.maxPerRun || 200;
  return { items: items.slice(0, limit), found, note: `${found} records read, ${items.length} matched the filters${items.length > limit ? `, first ${limit} kept` : ""}` };
}

function extractLinks(html, base) {
  const out = [], seen = new Set(), re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html))) {
    let href; try { href = new URL(decode(m[1]), base).href; } catch { continue; }
    if (!/^https?:/.test(href)) continue;
    const text = stripTags(m[2]).replace(/\s+/g, " ").trim();
    if (!text || seen.has(href)) continue; seen.add(href); out.push({ href, text });
  }
  return out;
}
async function runPageWatch(cfg, prev = {}) {
  const pages = [].concat(cfg.urls || cfg.url || []).filter(Boolean);
  if (!pages.length) throw new MethodError("Add at least one page address (urls) to the config");
  const state = { pages: { ...(prev.pages || {}) } }, items = []; let found = 0; const notes = [];
  const any = words(cfg.keywords), none = words(cfg.exclude);
  for (const p of pages) {
    const page = typeof p === "string" ? { url: p } : p;
    const { text } = await fetchText(page.url, cfg);
    const old = state.pages[page.url], first = !old;
    const seen = new Set(old?.seen || []);
    let entries;
    if ((page.watch || cfg.watch) === "text") {
      const body = stripTags(text).split("\n").map((s) => s.trim()).filter((s) => s.length >= 40);
      entries = body.map((s) => ({ id: sha(s), title: clip(s, 160), detail: clip(s, 1000), url: page.url }));
    } else {
      entries = extractLinks(text, page.url).map((l) => ({ id: sha(l.href + "|" + l.text), title: clip(l.text, 200), detail: "", url: l.href }));
    }
    found += entries.length;
    const fresh = entries.filter((e) => !seen.has(e.id));
    if (!first || cfg.deliverFirstRun) {
      for (const e of fresh) {
        const t = (e.title + " " + e.url).toLowerCase();
        if (any.length && !any.some((k) => t.includes(k))) continue;
        if (none.some((k) => t.includes(k))) continue;
        items.push({ key: e.id, title: e.title, detail: e.detail || `New on ${page.label || new URL(page.url).host}`, url: e.url, date: new Date().toISOString().slice(0, 10), company: "", domain: "", area: page.area || cfg.area || "", data: { type: cfg.signalType || "", page: page.label || page.url } });
      }
    } else notes.push(`${page.label || new URL(page.url).host}: first look, ${entries.length} entries recorded as the starting point`);
    state.pages[page.url] = { seen: [...new Set([...entries.map((e) => e.id), ...seen])].slice(0, 6000), at: new Date().toISOString() };
  }
  return { items, state, found, note: [notes.join("; "), items.length ? `${items.length} new` : ""].filter(Boolean).join(". ") };
}

async function runRegistry(cfg, prev = {}) {
  if (!cfg.url) throw new MethodError("Add the registry address (url) to the config");
  const { text, type } = await fetchText(cfg.url, cfg);
  const rows = parseRows(text, type, cfg).filter((r) => passes(r, cfg));
  const watch = [].concat(cfg.watchFields || []);
  const snap = {}, items = [], old = prev.snap || null;
  rows.forEach((r, i) => {
    const it = toItem(r, cfg, i);
    const sig = watch.length ? watch.map((f) => String(getPath(r, f) ?? "")).join("|") : JSON.stringify(r);
    snap[it.key] = { h: sha(sig), v: watch.length ? Object.fromEntries(watch.map((f) => [f, clip(getPath(r, f), 80)])) : undefined };
    if (!old) return;
    const was = old[it.key];
    if (!was) items.push({ ...it, key: `${it.key}|new|${snap[it.key].h}`, detail: it.detail || "New on the registry", data: { ...it.data, change: "new" } });
    else if (was.h !== snap[it.key].h) {
      const diffs = watch.filter((f) => (was.v || {})[f] !== snap[it.key].v[f]).map((f) => `${f}: ${(was.v || {})[f] || "blank"} → ${snap[it.key].v[f] || "blank"}`);
      items.push({ ...it, key: `${it.key}|chg|${snap[it.key].h}`, detail: diffs.join("; ") || "Changed on the registry", data: { ...it.data, change: "changed" } });
    }
  });
  const gone = old ? Object.keys(old).filter((k) => !snap[k]).length : 0;
  return { items, state: { snap, at: new Date().toISOString(), rows: rows.length }, found: rows.length, note: old ? `${rows.length} rows, ${items.length} new or changed${gone ? `, ${gone} gone` : ""}` : `First snapshot: ${rows.length} rows recorded. Changes show from the next run.` };
}

function partText(p) {
  if (!p) return "";
  if (p.parts) { const plain = p.parts.find((x) => x.mimeType === "text/plain"); return plain ? partText(plain) : p.parts.map(partText).join("\n"); }
  const d = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
  return /html/.test(p.mimeType || "") ? stripTags(d) : d;
}
async function runAlertInbox(cfg, prev = {}) {
  if (!gmail.configured()) throw new MethodError("Gmail isn't connected on this server. Add GOOGLE_* secrets with the gmail.readonly scope.");
  const q = cfg.query || "newer_than:3d";
  let list;
  try { list = await gmail.gmail(`messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(+cfg.maxEmails || 25, 50)}`); }
  catch (e) { throw new MethodError(/insufficient|scope|permission/i.test(e.message) ? "The Gmail connection can send but not read. Re-authorise it with the gmail.readonly scope." : `Gmail: ${e.message}`); }
  const seen = new Set(prev.seen || []), msgs = (list.messages || []).filter((m) => !seen.has(m.id));
  const items = [];
  for (const m of msgs.slice(0, 25)) {
    const full = await gmail.gmail(`messages/${m.id}?format=full`);
    const h = Object.fromEntries((full.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    const body = clip(partText(full.payload), 12000);
    let notices = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const r = await connectors.sample(`This is an alert email (tender notices, news alerts or similar). List every separate opportunity or notice in it.
For each give: title, buyer (the organization issuing or the company named), area (city or region if stated), closing (closing or due date, YYYY-MM-DD if stated), url (the link for that notice, exactly as in the email), detail (one sentence: what is being bought or what happened).
Return JSON: {"notices":[{"title":"","buyer":"","area":"","closing":"","url":"","detail":""}]}. Return {"notices":[]} if it's not an alert.
Subject: ${h.subject || ""}
From: ${h.from || ""}

${body}`, { modelTier: "quick", json: true, maxTokens: 3000 });
        notices = Array.isArray(r.value?.notices) ? r.value.notices : null;
      } catch (e) { notices = null; }
    }
    if (!notices) notices = [{ title: h.subject || "(no subject)", buyer: "", area: "", closing: "", url: "", detail: clip(body, 400) }];
    notices.forEach((n, i) => {
      const it = { key: `${m.id}:${i}`, title: clip(n.title, 200), detail: clip([n.detail, n.closing ? `Closes ${n.closing}` : ""].filter(Boolean).join(". "), 1200), url: /^https?:\/\//.test(n.url || "") ? n.url : "", date: fmtDate(h.date) || new Date().toISOString().slice(0, 10), company: clip(n.buyer, 160), domain: "", area: clip(n.area, 160), data: { type: cfg.signalType || "", closing: n.closing || "", email: h.subject || "" } };
      if (passes({ title: it.title, detail: it.detail, buyer: it.company, area: it.area }, cfg)) items.push(it);
    });
    seen.add(m.id);
  }
  return { items, state: { seen: [...seen].slice(-2000) }, found: msgs.length, note: `${msgs.length} new email${msgs.length === 1 ? "" : "s"}, ${items.length} notices` };
}

async function run(method, cfg, prevState) {
  if (method === "feed") return runFeed(cfg);
  if (method === "page_watch") return runPageWatch(cfg, prevState);
  if (method === "registry") return runRegistry(cfg, prevState);
  if (method === "alert_inbox") return runAlertInbox(cfg, prevState);
  throw new MethodError(`${METHODS[method]?.label || method} sources aren't run by the server`);
}

// Optional Claude screen applied to new items before routing: keep/drop against the source's rule,
// and fill in the company and area when the record only has free text.
async function screen(items, rule, ctx = "") {
  if (!rule || !items.length || !process.env.ANTHROPIC_API_KEY) return items.map(() => ({ keep: true }));
  const out = [];
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const r = await connectors.sample(`You screen raw records for a B2B lead desk. ${ctx}
Rule for what to keep: ${rule}
For each record decide keep true or false, give a short reason (under 12 words), and fill company (the business, developer, builder or public body involved, never a private individual's name; blank if none) and area (city or region) when you can tell.
Return JSON {"r":[{"i":0,"keep":true,"reason":"","company":"","area":""}]} with one entry per record, same order.
Records:
${batch.map((it, j) => `${j}. ${it.title} | ${it.detail} | ${it.company} | ${it.area} | ${it.url}`).join("\n")}`, { modelTier: "quick", json: true, maxTokens: 4000 });
    const rs = Array.isArray(r.value?.r) ? r.value.r : [];
    batch.forEach((_, j) => { const x = rs.find((y) => +y.i === j) || rs[j] || {}; out.push({ keep: x.keep !== false, reason: clip(x.reason, 120), company: clip(x.company, 160), area: clip(x.area, 160) }); });
  }
  return out;
}

// Rows pasted by the team (CSV text) for manual sources
function parsePasted(text, cfg = {}) {
  const t = String(text || "").trim();
  if (!t) return [];
  const rows = /^[[{]/.test(t) ? parseRows(t, "application/json", cfg) : /,/.test(t.split("\n")[0]) ? parseCsv(t) : t.split("\n").map((l) => ({ title: l.trim() }));
  return rows.map((r, i) => toItem(r, { ...cfg, map: { key: "", title: "title", detail: "detail", url: "url", date: "date", company: "company", domain: "domain", area: "area", ...(cfg.map || {}) } }, i));
}

module.exports = { METHODS, MethodError, run, screen, parsePasted, parseRows, parseCsv, toItem, passes, fill, sha, clip, cleanDomain, extractLinks };
