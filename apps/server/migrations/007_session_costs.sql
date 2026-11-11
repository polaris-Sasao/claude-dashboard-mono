-- フェーズ5：消費内訳。statusLine の cost.total_cost_usd（セッションの累計、API 料金換算の推定）を変化したときだけ記録する
CREATE TABLE session_costs (
  session_id  TEXT NOT NULL,
  host_id     TEXT NOT NULL,
  taken_at    TEXT NOT NULL,
  cost_usd    REAL NOT NULL
);
CREATE INDEX session_costs_session ON session_costs(session_id, taken_at);
CREATE INDEX session_costs_time ON session_costs(taken_at);
