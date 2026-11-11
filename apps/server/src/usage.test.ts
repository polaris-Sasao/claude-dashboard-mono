import { describe, expect, test } from "bun:test";
import { addHost } from "./localhost";
import { openDb } from "./db";
import { breakdown, forecast, recordCost, recordTranscriptCosts } from "./usage";

const RESET = "2026-10-06T10:00:00.000Z";
const iso = (min: number) => new Date(Date.parse("2026-10-06T07:00:00Z") + min * 60_000).toISOString();

function setup() {
  const db = openDb(":memory:");
  const { hostId } = addHost(db, "my-pc");
  const snap = (min: number, pct: number) =>
    db
      .query("INSERT INTO usage_snapshots (taken_at, host_id, five_hour_pct, five_hour_reset) VALUES (?, ?, ?, ?)")
      .run(iso(min), hostId, pct, RESET);
  const session = (id: string, startedMin: number) =>
    db
      .query(
        `INSERT INTO sessions (session_id, host_id, project, status, status_text, started_at, last_event_at)
         VALUES (?, ?, ?, 'run', 'x', ?, ?)`,
      )
      .run(id, hostId, `proj-${id}`, iso(startedMin), iso(startedMin));
  return { db, hostId, snap, session };
}

describe("上限予測", () => {
  test("30分で15%増えるペースなら、残り分の時刻を出す", () => {
    const { db, snap } = setup();
    for (let m = 0; m <= 30; m += 5) snap(m, 40 + m / 2);
    const f = forecast(db, "five", RESET, new Date(iso(30)))!;
    expect(f.perHour).toBe(30);
    // 55% から 1時間に 30% → 1.5時間後（リセットの 10:00 より前）
    expect(f.hitAt).toBe(iso(30 + 90));
    expect(f.beforeReset).toBe(true);
    // 時間がたつだけでは変わらない
    expect(forecast(db, "five", RESET, new Date(iso(31)))!.hitAt).toBe(f.hitAt);
  });

  test("リセットまでに届かないペース・増えていない・期間が短いとき", () => {
    const { db, snap } = setup();
    snap(0, 10);
    snap(1, 10);
    expect(forecast(db, "five", RESET, new Date(iso(1)))).toBeNull();
    snap(20, 11);
    const f = forecast(db, "five", RESET, new Date(iso(20)))!;
    expect(f.beforeReset).toBe(false);
    snap(25, 10);
    snap(30, 10);
  });
});

describe("消費内訳", () => {
  test("枠の中での増分で割合を出し、累計が0に戻っても崩れない", () => {
    const { db, hostId, session } = setup();
    session("a", 0);
    session("b", 10);
    // 枠の開始は 05:00。a は 07:00 開始（枠内）なので基準は 0
    recordCost(db, hostId, "a", 1.0, iso(1));
    recordCost(db, hostId, "a", 3.0, iso(20));
    recordCost(db, hostId, "b", 0.5, iso(11));
    recordCost(db, hostId, "b", 0.2, iso(30)); // --resume で数え直し：0.2 を新しい増分として足す
    recordCost(db, hostId, "b", 0.2, iso(31)); // 変わらなければ記録しない
    const b = breakdown(db, [hostId], RESET, "five", new Date(iso(40)))!;
    expect(b.totalUsd).toBe(3.7);
    expect(b.items.map((i) => [i.project, i.usd, i.pct])).toEqual([
      ["proj-a", 3, 81.1],
      ["proj-b", 0.7, 18.9],
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM session_costs WHERE session_id = 'b'").get()).toEqual({ n: 2 });
  });

  test("枠より前から続くセッションは、枠より前の最後の値を基準にする", () => {
    const { db, hostId } = setup();
    db.query(
      `INSERT INTO sessions (session_id, host_id, project, status, status_text, started_at, last_event_at)
       VALUES ('old', ?, 'old', 'run', 'x', '2026-10-06T01:00:00.000Z', '2026-10-06T01:00:00.000Z')`,
    ).run(hostId);
    db.query("INSERT INTO session_costs (session_id, host_id, taken_at, cost_usd) VALUES ('old', ?, '2026-10-06T04:00:00.000Z', 5)").run(hostId);
    recordCost(db, hostId, "old", 6.5, iso(10));
    expect(breakdown(db, [hostId], RESET, "five", new Date(iso(20)))!.totalUsd).toBe(1.5);
  });
});

describe("消費内訳の出どころ", () => {
  test("statusLine の値があればそれを使い、なければ会話記録からの見積もりを使う", () => {
    const { db, hostId, session } = setup();
    session("term", 0);
    session("vscode", 0);
    const now = new Date(iso(10));
    // Sonnet 5.5 の出力 10万トークン = $1。枠（05:00 から）より前の時間帯の分は数えない
    const out = (n: number) => ({ "claude-sonnet-5-5": { output: n } });
    recordCost(db, hostId, "term", 2, iso(5));
    recordTranscriptCosts(db, hostId, "term", { [iso(0)]: out(50_000) }, now);
    recordTranscriptCosts(db, hostId, "vscode", { "2026-10-06T04:50:00.000Z": out(300_000), [iso(0)]: out(100_000) }, now);
    const b = breakdown(db, [hostId], RESET, "five", now)!;
    expect(b.items.map((i) => [i.project, i.usd, i.estimated])).toEqual([
      ["proj-term", 2, false],
      ["proj-vscode", 1, true],
    ]);
    // 同じ時間帯が届き直したら置き換える
    recordTranscriptCosts(db, hostId, "vscode", { [iso(0)]: out(150_000) }, now);
    expect(breakdown(db, [hostId], RESET, "five", now)!.items[1]!.usd).toBe(1.5);
  });
});
