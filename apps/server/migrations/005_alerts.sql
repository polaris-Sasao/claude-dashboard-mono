-- フェーズ4：アラートとファイル編集の記録
CREATE TABLE alerts (
  alert_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,       -- 同じ事象をまとめる鍵（idle:<session>:<待ち始め> など）
  kind        TEXT NOT NULL,       -- idle / conflict / danger
  host_id     TEXT,
  session_id  TEXT,
  detail_json TEXT NOT NULL,
  state       TEXT NOT NULL,       -- open / dismissed / resolved
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX alerts_state ON alerts(state, key);

CREATE TABLE file_touches (
  touch_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  agent_id    TEXT,                -- サブエージェントの編集なら agent_id、メインなら NULL
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX file_touches_path ON file_touches(host_id, path, created_at);
