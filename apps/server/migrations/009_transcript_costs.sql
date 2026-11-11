-- 会話記録からの見積もりは、10分刻みの時間帯ごとに持つ（開き直した古い会話の分を今の枠に入れないため）。
-- 008 の session_costs の source = 'transcript' は使わない
CREATE TABLE transcript_costs (
  session_id    TEXT NOT NULL,
  host_id       TEXT NOT NULL,
  bucket_start  TEXT NOT NULL,
  usd           REAL NOT NULL,
  PRIMARY KEY (session_id, bucket_start)
);
CREATE INDEX transcript_costs_time ON transcript_costs(bucket_start);
DELETE FROM session_costs WHERE source = 'transcript';
