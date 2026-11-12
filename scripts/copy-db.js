#!/usr/bin/env node
// Copy everything from one Signals HQ database to another (used to move off the dev database).
//   FROM_DATABASE_URL=... TO_DATABASE_URL=... node scripts/copy-db.js
// Optional CA certs: FROM_DATABASE_CA_CERT, TO_DATABASE_CA_CERT. Re-running is safe: rows are upserted.
const { Pool } = require("pg");

const mk = (url, ca) => new Pool({
  connectionString: String(url || "").replace(/[?&]sslmode=[^&]*/, ""),
  ssl: /localhost|127\.0\.0\.1/.test(url || "") ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
});
const from = mk(process.env.FROM_DATABASE_URL, process.env.FROM_DATABASE_CA_CERT);
const to = mk(process.env.TO_DATABASE_URL, process.env.TO_DATABASE_CA_CERT);

(async () => {
  if (!process.env.FROM_DATABASE_URL || !process.env.TO_DATABASE_URL) throw new Error("Set FROM_DATABASE_URL and TO_DATABASE_URL");
  // create the schema on the target
  process.env.DATABASE_URL = process.env.TO_DATABASE_URL;
  process.env.DATABASE_CA_CERT = process.env.TO_DATABASE_CA_CERT || "";
  const { migrate, pool } = require("../lib/db");
  await migrate(); await pool.end();

  const users = (await from.query("SELECT * FROM users")).rows;
  for (const u of users)
    await to.query(`INSERT INTO users (id,email,name,role,desks,can_write,active,created_at,last_login) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, desks=EXCLUDED.desks, can_write=EXCLUDED.can_write, active=EXCLUDED.active, last_login=EXCLUDED.last_login`,
      [u.id, u.email, u.name, u.role, u.desks, u.can_write, u.active, u.created_at, u.last_login]);

  const sessions = (await from.query("SELECT * FROM sessions WHERE expires_at > now()")).rows;
  for (const s of sessions)
    await to.query("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [s.token_hash, s.user_id, s.expires_at, s.created_at]);

  const docs = (await from.query("SELECT * FROM docs")).rows;
  for (const d of docs)
    await to.query(`INSERT INTO docs (space,coll,id,data,version,updated_at,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (space,coll,id) DO UPDATE SET data=EXCLUDED.data, version=EXCLUDED.version, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
      [d.space, d.coll, d.id, d.data, d.version, d.updated_at, d.updated_by]);

  const check = async (p, t) => (await p.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;
  for (const t of ["users", "docs"]) console.log(`${t}: ${await check(from, t)} -> ${await check(to, t)}`);
  console.log(`sessions copied: ${sessions.length}`);
  await from.end(); await to.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
