-- フェーズ2：プレイヤー（サブエージェント・Codex CLI）、進捗、作業結果

CREATE TABLE players (
  player_id    TEXT PRIMARY KEY,   -- 起動したツール呼び出しの tool_use_id
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- claude / codex
  agent_type   TEXT,               -- サブエージェントの種類（Explore など）
  agent_id     TEXT,               -- SubagentStart・SubagentStop の agent_id
  model        TEXT,
  task         TEXT,
  background   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,      -- run / done / err
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);
CREATE INDEX players_session ON players(session_id, started_at);
CREATE INDEX players_agent ON players(agent_id);

ALTER TABLE sessions ADD COLUMN last_prompt_at TEXT;
ALTER TABLE sessions ADD COLUMN last_result TEXT;
ALTER TABLE sessions ADD COLUMN todos_json TEXT;
