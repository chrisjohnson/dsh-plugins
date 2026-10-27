// dsh-kanban: forward-only SQLite schema migrations.
//
// State only. If a migration ever looks like it wants a `providers`, `roles`,
// `prompts` or `settings` table, the value belongs in YAML instead (see
// src/config.mjs and the README's config table).

export const SCHEMA_VERSION = 3;

const V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  col TEXT NOT NULL CHECK (col IN ('backlog','now','blocked','needs_attention','done','discarded')),
  phase TEXT NOT NULL CHECK (phase IN ('plan','implement','review','verify','closed')),
  plan_timing TEXT NOT NULL CHECK (plan_timing IN ('now','at_pickup')),
  plan_questions TEXT NOT NULL CHECK (plan_questions IN ('interactive','autonomous')),
  priority INTEGER NOT NULL DEFAULT 0,
  sort_order REAL NOT NULL DEFAULT 0,
  allow_paid INTEGER NOT NULL DEFAULT 0 CHECK (allow_paid IN (0,1)),
  budget_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  escalation_rung INTEGER NOT NULL DEFAULT 0,
  workspace_cwd TEXT,
  needs_attention_reason TEXT,
  confidence_threshold REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS tickets_col ON tickets(col, priority DESC, sort_order ASC);
CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at);

CREATE TABLE IF NOT EXISTS acceptance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  statement TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS acceptance_ticket ON acceptance(ticket_id, ordinal);

CREATE TABLE IF NOT EXISTS conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  condition_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  how_verified TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('plan')),
  created_at TEXT NOT NULL,
  UNIQUE (ticket_id, plan_version, condition_id)
);
CREATE INDEX IF NOT EXISTS conditions_ticket ON conditions(ticket_id, plan_version);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
  dsh_session_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  purpose TEXT,
  preset TEXT,
  provider TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_ticket ON sessions(ticket_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase_from TEXT,
  phase_to TEXT,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  config_hash TEXT NOT NULL,
  prompt_hashes_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_ticket ON runs(ticket_id);

CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  parent_span_id TEXT REFERENCES spans(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trigger','workflow','agent','judge','tool','wait')),
  name TEXT NOT NULL,
  role TEXT,
  session_id TEXT,
  provider TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','ok','failed','awaiting_human','abandoned')),
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  prompt_hash TEXT
);
CREATE INDEX IF NOT EXISTS spans_ticket ON spans(ticket_id, started_at);
CREATE INDEX IF NOT EXISTS spans_run ON spans(run_id);
CREATE INDEX IF NOT EXISTS spans_parent ON spans(parent_span_id);
CREATE INDEX IF NOT EXISTS spans_status ON spans(status);

CREATE TABLE IF NOT EXISTS usage (
  span_id TEXT PRIMARY KEY REFERENCES spans(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  price_version TEXT
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id TEXT REFERENCES spans(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  condition_id TEXT NOT NULL,
  met INTEGER NOT NULL CHECK (met IN (0,1)),
  confidence REAL NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  cycle INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verifications_ticket ON verifications(ticket_id, cycle);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  span_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS artifacts_ticket ON artifacts(ticket_id, id);
CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at);
`;

const V2 = `
-- Reserved migration slot; concurrency is owned outside this plugin.
SELECT 1;
`;

const V3 = `
-- The flat-plan workflow reset. Historical workflow data is intentionally
-- discarded: the session topology and ticket modes changed incompatibly.
DROP TABLE IF EXISTS usage;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS spans;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS conditions;
DROP TABLE IF EXISTS acceptance;
DROP TABLE IF EXISTS tickets;
` + V1;

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    sql: V1,
  },
  {
    version: 2,
    name: 'drop-legacy-concurrency',
    sql: V2,
  },
  {
    version: 3,
    name: 'flat-plan-workflow',
    sql: V3,
  },
];
