-- 単独 PC 版：hooks のイベントを受けなくなったため、使わなくなったテーブルを消す
--   events・prompts・players：セッションの状態・会話・プレイヤーは会話記録と ~/.claude/sessions から読む
--   file_touches：ファイル競合は会話記録の編集から判定する
--   push_subscriptions：プッシュ通知を外した
-- sessions は、利用枠の消費内訳のプロジェクト名・開始時刻と、statusLine のコンテキスト使用率の記録に使い続ける

DROP TABLE IF EXISTS players;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS prompts;
DROP TABLE IF EXISTS file_touches;
DROP TABLE IF EXISTS push_subscriptions;
