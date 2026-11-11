// 保持期間（既定 15 日）を過ぎた記録を消す。
// 消さないもの：この PC の行（hosts）、未対応のアラート

import type { Database } from "bun:sqlite";

export function purgeOld(db: Database, days: number, now = new Date()): Record<string, number> {
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
  const out: Record<string, number> = {};
  const run = (name: string, sql: string) => {
    out[name] = (out[name] ?? 0) + db.query(sql).run(cutoff).changes;
  };
  db.transaction(() => {
    run("sessions", "DELETE FROM sessions WHERE last_event_at < ?");
    run("alerts", "DELETE FROM alerts WHERE state IN ('resolved', 'dismissed') AND updated_at < ?");
    run("usage_snapshots", "DELETE FROM usage_snapshots WHERE taken_at < ?");
    run("session_costs", "DELETE FROM session_costs WHERE taken_at < ?");
    run("transcript_costs", "DELETE FROM transcript_costs WHERE bucket_start < ?");
  })();
  return out;
}
