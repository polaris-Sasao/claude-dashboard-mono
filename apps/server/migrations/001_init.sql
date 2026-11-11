-- フェーズ1のテーブル

CREATE TABLE hosts (
  host_id       TEXT PRIMARY KEY,
  hostname      TEXT,
  os            TEXT,
  label         TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  host_id        TEXT NOT NULL REFERENCES hosts(host_id),
  project        TEXT NOT NULL,
  cwd            TEXT,
  model          TEXT,
  status         TEXT NOT NULL,
  status_text    TEXT NOT NULL,
  ctx_pct        REAL,
  started_at     TEXT NOT NULL,
  last_event_at  TEXT NOT NULL,
  ended_at       TEXT
);
CREATE INDEX sessions_host ON sessions(host_id, ended_at);

CREATE TABLE events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT,
  host_id       TEXT NOT NULL,
  type          TEXT NOT NULL,
  tool_name     TEXT,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX events_session ON events(session_id, created_at);
CREATE INDEX events_created ON events(created_at);

CREATE TABLE prompts (
  prompt_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX prompts_session ON prompts(session_id, created_at);

CREATE TABLE usage_snapshots (
  taken_at         TEXT NOT NULL,
  host_id          TEXT NOT NULL,
  session_id       TEXT,
  five_hour_pct    REAL,
  five_hour_reset  TEXT,
  seven_day_pct    REAL,
  seven_day_reset  TEXT
);
CREATE INDEX usage_host ON usage_snapshots(host_id, taken_at);
