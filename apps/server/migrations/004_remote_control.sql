-- Remote Control のセッション ID（session_…）。/remote-control が有効なときだけ値が入る
ALTER TABLE sessions ADD COLUMN remote_session_id TEXT;
