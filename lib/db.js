// Postgres pool and schema. One table holds every page's documents, keyed by space
// ("hq" or "desk:<deskId>"), collection path and document id.
const { Pool } = require("pg");

// DigitalOcean managed Postgres needs TLS; pass its CA (DATABASE_CA_CERT) to verify the server.
const url = process.env.DATABASE_URL || "";
const ssl = process.env.DATABASE_SSL === "false" || /localhost|127\.0\.0\.1/.test(url) ? false
  : process.env.DATABASE_CA_CERT ? { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true } : { rejectUnauthorized: false };
// sslmode in the URL would override the ssl object above, so drop it
const pool = new Pool({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ""), ssl, max: 10 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  space       text        NOT NULL,
  coll        text        NOT NULL,
  id          text        NOT NULL,
  data        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version     integer     NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (space, coll, id)
);
CREATE INDEX IF NOT EXISTS docs_space_coll ON docs (space, coll);

CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  email       text UNIQUE NOT NULL,
  name        text NOT NULL DEFAULT '',
  role        text NOT NULL CHECK (role IN ('staff','partner','client')),
  desks       text[] NOT NULL DEFAULT '{}',
  can_write   boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next_path   text NOT NULL DEFAULT '/',
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
