import { describe, expect, test } from "bun:test";
import { addHost } from "./localhost";
import { openDb } from "./db";
import { purgeOld } from "./retention";

describe("purgeOld", () => {
  test("保持期間より古い記録を消し、新しい記録・未対応のアラート・PC の登録は残す", () => {
    const db = openDb(":memory:");
    const { hostId } = addHost(db, "pc");
    const OLD = "2026-09-01T00:00:00.000Z";
    const NEW = "2026-10-05T00:00:00.000Z";
    for (const [id, t] of [["old", OLD], ["new", NEW]] as const) {
      db.query(
        `INSERT INTO sessions (session_id, host_id, project, status, status_text, started_at, last_event_at)
         VALUES (?, ?, 'p', 'wait', 'x', ?, ?)`,
      ).run(id, hostId, t, t);
      db.query("INSERT INTO transcript_costs (session_id, host_id, bucket_start, usd) VALUES (?, ?, ?, 1)").run(id, hostId, t);
    }
    const alert = (key: string, state: string, t: string) =>
      db
        .query(
          `INSERT INTO alerts (key, kind, host_id, session_id, detail_json, state, created_at, updated_at)
           VALUES (?, 'idle', ?, NULL, '{}', ?, ?, ?)`,
        )
        .run(key, hostId, state, t, t);
    alert("a1", "resolved", OLD);
    alert("a2", "open", OLD);
    alert("a3", "resolved", NEW);
    const n = purgeOld(db, 15, new Date("2026-10-06T00:00:00Z"));
    expect(n).toMatchObject({ sessions: 1, transcript_costs: 1, alerts: 1 });
    const count = (t: string) => (db.query(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    expect([count("sessions"), count("transcript_costs"), count("alerts"), count("hosts")]).toEqual([1, 1, 2, 1]);
    // 使わなくなったテーブルは消えている（010_single_pc.sql）
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ["players", "events", "prompts", "file_touches", "push_subscriptions"]) expect(tables).not.toContain(t);
  });
});
