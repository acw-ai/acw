-- GETUS dispositions: initial schema (SQLite, used by the simulator and local testing)
CREATE TABLE IF NOT EXISTS calls (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  call_key         TEXT NOT NULL UNIQUE,
  pbx_call_id      TEXT,
  participant_id   TEXT,
  extension        TEXT NOT NULL,
  agent_name       TEXT,
  customer_number  TEXT,
  customer_name    TEXT,
  direction        TEXT NOT NULL DEFAULT 'unknown',
  status           TEXT NOT NULL DEFAULT 'active',
  started_at       TEXT NOT NULL,
  answered_at      TEXT,
  ended_at         TEXT,
  talk_seconds     INTEGER,
  category         TEXT,
  disposition      TEXT,
  sub_disposition  TEXT,
  notes            TEXT,
  follow_up_date   TEXT,
  disposed_at      TEXT,
  waived_by        TEXT,
  waived_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_ext_status ON calls(extension, status);
CREATE INDEX IF NOT EXISTS idx_calls_started    ON calls(started_at);
CREATE INDEX IF NOT EXISTS idx_calls_disposition ON calls(disposition);

CREATE TABLE IF NOT EXISTS agents (
  extension   TEXT PRIMARY KEY,
  name        TEXT,
  held        INTEGER NOT NULL DEFAULT 0,
  held_since  TEXT,
  last_seen   TEXT
);
