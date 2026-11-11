-- 費用の出どころ：statusline（ターミナルの statusLine の cost）か transcript（会話記録のトークン数からの見積もり）
ALTER TABLE session_costs ADD COLUMN source TEXT NOT NULL DEFAULT 'statusline';
