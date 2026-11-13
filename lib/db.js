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

-- ---------- Signal sources: managed apart from the desks ----------
-- The catalog of every source Hyperweb runs (one row per source, whatever client it's for)
CREATE TABLE IF NOT EXISTS signal_sources (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  code         text UNIQUE NOT NULL,                 -- short code stamped on UTM tags and CRM tags
  method       text NOT NULL,                        -- feed, page_watch, registry, alert_inbox, runner, manual
  kind         text NOT NULL DEFAULT 'account' CHECK (kind IN ('account','project','moment')),
  subject      text NOT NULL DEFAULT 'company',      -- company, property, public_body, project, area
  mode         text NOT NULL DEFAULT 'shared' CHECK (mode IN ('shared','per_desk')),
  status       text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Testing','Live','Paused','Retired')),
  schedule     text NOT NULL DEFAULT 'daily',        -- hourly, 6h, daily, weekly, monthly, manual
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  description  text NOT NULL DEFAULT '',
  cost_note    text NOT NULL DEFAULT '',
  segments     text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  last_run_at  timestamptz,
  next_run_at  timestamptz,
  last_error   text
);
-- Packs bundle sources (Core, Arborist pack, ...) so access is granted in one tick
CREATE TABLE IF NOT EXISTS source_packs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pack_sources (
  pack_id   text NOT NULL REFERENCES source_packs(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES signal_sources(id) ON DELETE CASCADE,
  PRIMARY KEY (pack_id, source_id)
);
CREATE TABLE IF NOT EXISTS desk_packs (
  desk_id text NOT NULL,
  pack_id text NOT NULL REFERENCES source_packs(id) ON DELETE CASCADE,
  PRIMARY KEY (desk_id, pack_id)
);
-- Per-desk territory and limits that apply to every source the desk receives
CREATE TABLE IF NOT EXISTS desk_signal_settings (
  desk_id    text PRIMARY KEY,
  areas      text[] NOT NULL DEFAULT '{}',
  daily_cap  integer,
  paused     boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
-- Per-desk overrides of one source: access and parameters
CREATE TABLE IF NOT EXISTS desk_sources (
  desk_id    text NOT NULL,
  source_id  text NOT NULL REFERENCES signal_sources(id) ON DELETE CASCADE,
  access     text NOT NULL DEFAULT 'inherit' CHECK (access IN ('inherit','on','hyperweb','off')),
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  daily_cap  integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (desk_id, source_id)
);
-- What each source remembers between runs (seen links, registry snapshots)
CREATE TABLE IF NOT EXISTS source_state (
  source_id  text NOT NULL REFERENCES signal_sources(id) ON DELETE CASCADE,
  scope      text NOT NULL DEFAULT '',
  state      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, scope)
);
-- The pool: every item any source found, once, before it is routed to desks
CREATE TABLE IF NOT EXISTS source_items (
  id         bigserial PRIMARY KEY,
  source_id  text NOT NULL REFERENCES signal_sources(id) ON DELETE CASCADE,
  scope      text NOT NULL DEFAULT '',
  key        text NOT NULL,
  title      text NOT NULL DEFAULT '',
  detail     text NOT NULL DEFAULT '',
  url        text NOT NULL DEFAULT '',
  event_date text NOT NULL DEFAULT '',
  company    text NOT NULL DEFAULT '',
  domain     text NOT NULL DEFAULT '',
  area       text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dropped    text,                                  -- why the item was held back (screened out), if it was
  found_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, scope, key)
);
CREATE INDEX IF NOT EXISTS source_items_found ON source_items (source_id, found_at DESC);
-- Which desk got which item, and whether it is still held for the Hyperweb team
CREATE TABLE IF NOT EXISTS deliveries (
  item_id      bigint NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  desk_id      text NOT NULL,
  source_id    text NOT NULL,
  coll         text NOT NULL,
  doc_id       text NOT NULL,
  hq_only      boolean NOT NULL DEFAULT false,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  PRIMARY KEY (item_id, desk_id)
);
CREATE INDEX IF NOT EXISTS deliveries_desk ON deliveries (desk_id, source_id, delivered_at);
CREATE TABLE IF NOT EXISTS source_runs (
  id          bigserial PRIMARY KEY,
  source_id   text NOT NULL REFERENCES signal_sources(id) ON DELETE CASCADE,
  scope       text NOT NULL DEFAULT '',
  trigger     text NOT NULL DEFAULT 'schedule',
  status      text NOT NULL DEFAULT 'running',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  found       integer NOT NULL DEFAULT 0,
  new_items   integer NOT NULL DEFAULT 0,
  kept        integer NOT NULL DEFAULT 0,
  delivered   integer NOT NULL DEFAULT 0,
  note        text NOT NULL DEFAULT '',
  error       text
);
CREATE INDEX IF NOT EXISTS source_runs_source ON source_runs (source_id, started_at DESC);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
