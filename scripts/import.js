#!/usr/bin/env node
// Load an export of the claude.ai pages' data into Signals HQ.
//   node scripts/import.js <exportDir>                  writes straight to DATABASE_URL
//   node scripts/import.js <exportDir> --api <APP_URL>  writes through the runner API (needs RUNNER_TOKEN)
// Layout: <exportDir>/hq/<collection>/<id>.json and <exportDir>/desks/<deskId>/<collection>/<id>.json
// Desk links are pointed at this app (the claude.ai link is kept as claudeUrl).
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const apiIdx = process.argv.indexOf("--api");
const api = apiIdx > 0 ? process.argv[apiIdx + 1].replace(/\/$/, "") : null;
const appUrl = (process.env.APP_URL || api || "https://signals.hyperweb.ca").replace(/\/$/, "");
if (!dir) { console.error("Usage: node scripts/import.js <exportDir> [--api https://signals.hyperweb.ca]"); process.exit(1); }

function walk(root, space) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const coll of fs.readdirSync(root)) {
    const cdir = path.join(root, coll);
    if (!fs.statSync(cdir).isDirectory()) continue;
    for (const f of fs.readdirSync(cdir).filter((x) => x.endsWith(".json")))
      out.push({ space, path: `${coll}/${f.slice(0, -5)}`, data: JSON.parse(fs.readFileSync(path.join(cdir, f), "utf8")) });
  }
  return out;
}

const docs = walk(path.join(dir, "hq"), "hq");
const deskRoot = path.join(dir, "desks");
if (fs.existsSync(deskRoot)) for (const d of fs.readdirSync(deskRoot)) docs.push(...walk(path.join(deskRoot, d), `desk:${d}`));

for (const d of docs) {
  if (d.space === "hq" && d.path.startsWith("desks/")) {
    const id = d.path.split("/")[1];
    if (d.data.url && /claude\.ai/.test(d.data.url)) d.data.claudeUrl = d.data.url;
    d.data.url = `${appUrl}/desk/${id}`;
  }
  if (d.space === "hq" && d.path === "hq/settings" && d.data.templateUrl && /claude\.ai/.test(d.data.templateUrl)) {
    d.data.claudeTemplateUrl = d.data.templateUrl;
    d.data.templateUrl = `${appUrl}/desk/hyperweb`;
  }
}

(async () => {
  if (api) {
    for (const d of docs) {
      const r = await fetch(`${api}/api/runner/doc`, { method: "PUT", headers: { authorization: `Bearer ${process.env.RUNNER_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(d) });
      if (!r.ok) throw new Error(`${d.space} ${d.path}: ${r.status} ${await r.text()}`);
    }
  } else {
    const { migrate, pool } = require("../lib/db");
    const store = require("../lib/store");
    await migrate();
    for (const d of docs) await store.setDoc(d.space, d.path, d.data, "import");
    await pool.end();
  }
  const spaces = [...new Set(docs.map((d) => d.space))];
  console.log(`Imported ${docs.length} documents into ${spaces.length} spaces: ${spaces.join(", ")}`);
})().catch((e) => { console.error(e); process.exit(1); });
