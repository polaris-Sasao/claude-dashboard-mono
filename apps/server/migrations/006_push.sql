-- フェーズ4：Web Push の購読（端末ごと）
CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  origin      TEXT NOT NULL,       -- 購読した画面の URL（VAPID の subject に使う）
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT,
  fail_count  INTEGER NOT NULL DEFAULT 0
);
