#!/usr/bin/env node
// Create or update a person. First run: add yourself as staff, then use People and access in the app.
//   node scripts/add-user.js carl@hyperweb.ca staff "Carl Messenger-Lehmann"
//   node scripts/add-user.js trevor@agenda.ca partner "Trevor Stooke" agenda-marketing
const { migrate, pool } = require("../lib/db");
const { upsertUser } = require("../lib/auth");

const [email, role, name = "", desks = ""] = process.argv.slice(2);
if (!email || !role) { console.error("Usage: node scripts/add-user.js <email> <staff|partner|client> [name] [desk-id,desk-id]"); process.exit(1); }
(async () => {
  await migrate();
  const u = await upsertUser({ email, role, name, desks: desks.split(",").map((s) => s.trim()).filter(Boolean) });
  console.log(`Saved ${u.email} as ${u.role}${u.desks.length ? " with " + u.desks.join(", ") : ""}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
