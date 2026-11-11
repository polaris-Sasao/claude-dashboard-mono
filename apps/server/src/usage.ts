// フェーズ5：利用枠の上限予測と消費内訳
//
// 上限予測：同じアカウント（リセット時刻が同じ）の直近の記録から増え方を最小二乗の直線で近似し、100% に届く時刻を出す。
//   公式の計算方法は非公開のため目安。値は 1% 刻みなので、短い期間では出さない。
// 消費内訳：セッションごとの累計費用（statusLine の cost.total_cost_usd）の、今の枠の中での増分を比べる。
//   費用はモデルの単価で重み付けされるため、利用枠の減り方に近い指標として使う（推定）。チャットや Cowork の消費は含まない

import type { Database } from "bun:sqlite";
import { estimateUsd, type TokenCounts, type UsageBreakdown, type UsageForecast } from "@kanseishitsu/shared";

const FIVE_HOUR_MS = 5 * 3600_000;
const SEVEN_DAY_MS = 7 * 86400_000;

export type CostSource = "statusline" | "transcript";

/** 費用が変わったときだけ記録する。statusline はターミナルの statusLine の値、transcript は会話記録からの見積もり */
export function recordCost(
  db: Database,
  hostId: string,
  sessionId: string,
  costUsd: number,
  at: string,
  source: CostSource = "statusline",
): void {
  const last = db
    .query<{ cost_usd: number }, [string, string]>(
      "SELECT cost_usd FROM session_costs WHERE session_id = ? AND source = ? ORDER BY taken_at DESC LIMIT 1",
    )
    .get(sessionId, source);
  if (last && Math.abs(last.cost_usd - costUsd) < 1e-9) return;
  db.query("INSERT INTO session_costs (session_id, host_id, taken_at, cost_usd, source) VALUES (?, ?, ?, ?, ?)").run(
    sessionId,
    hostId,
    at,
    costUsd,
    source,
  );
}

/** 会話記録からの見積もり：時間帯（10分刻み）ごとの費用を置き換えて記録する */
export function recordTranscriptCosts(
  db: Database,
  hostId: string,
  sessionId: string,
  buckets: Record<string, Record<string, Partial<TokenCounts>>>,
  now: Date,
): void {
  const oldest = now.getTime() - 8 * 86400_000;
  const upsert = db.query(
    `INSERT INTO transcript_costs (session_id, host_id, bucket_start, usd) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, bucket_start) DO UPDATE SET usd = excluded.usd, host_id = excluded.host_id`,
  );
  for (const [bucket, models] of Object.entries(buckets)) {
    const t = Date.parse(bucket);
    if (!Number.isFinite(t) || t < oldest || t > now.getTime() + 600_000 || !models || typeof models !== "object") continue;
    upsert.run(sessionId, hostId, new Date(t).toISOString(), estimateUsd(models));
  }
}

type Win = "five" | "seven";

/** 増え方を直線で近似した、100% に届く見込みの時刻 */
export function forecast(
  db: Database,
  win: Win,
  resetsAt: string | null,
  now: Date,
): UsageForecast | null {
  if (!resetsAt) return null;
  const col = win === "five" ? "five_hour" : "seven_day";
  const lookbackMs = win === "five" ? 30 * 60_000 : 3 * 3600_000;
  const minSpanMs = win === "five" ? 5 * 60_000 : 30 * 60_000;
  const rows = db
    .query<{ taken_at: string; pct: number }, [string, string]>(
      `SELECT taken_at, ${col}_pct AS pct FROM usage_snapshots
       WHERE ${col}_reset = ? AND ${col}_pct IS NOT NULL AND taken_at >= ? ORDER BY taken_at`,
    )
    .all(resetsAt, new Date(now.getTime() - lookbackMs).toISOString());
  if (rows.length < 2) return null;
  const t0 = Date.parse(rows[0]!.taken_at);
  const xs = rows.map((r) => (Date.parse(r.taken_at) - t0) / 3600_000);
  if ((xs[xs.length - 1]! - xs[0]!) * 3600_000 < minSpanMs) return null;
  const ys = rows.map((r) => r.pct);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const perHour = sxx > 0 ? sxy / sxx : 0;
  const basisMin = Math.round((xs[n - 1]! - xs[0]!) * 60);
  if (perHour <= 0.01) return { perHour: 0, hitAt: null, beforeReset: false, basisMin };
  // 近似した直線が 100% を通る時刻（「今」に依存させず、時間がたつだけでは値が変わらないようにする）。分単位に丸める
  const hitX = mx + (100 - my) / perHour;
  const hitMs = Math.max(now.getTime(), t0 + hitX * 3600_000);
  const hitAt = new Date(Math.round(hitMs / 60_000) * 60_000);
  return {
    perHour: Math.round(perHour * 10) / 10,
    hitAt: hitAt.toISOString(),
    beforeReset: hitAt.getTime() < Date.parse(resetsAt),
    basisMin,
  };
}

/**
 * 今の5時間枠（リセット時刻の5時間前から）の中で、各セッションが使った費用の増分。
 * 累計が減ったとき（--resume などで数え直し）は、減ったあとの値を新しい増分として足す
 */
export function breakdown(db: Database, hostIds: string[], resetsAt: string | null, win: Win, now: Date): UsageBreakdown | null {
  if (!resetsAt || hostIds.length === 0) return null;
  const start = new Date(Date.parse(resetsAt) - (win === "five" ? FIVE_HOUR_MS : SEVEN_DAY_MS)).toISOString();
  const marks = hostIds.map(() => "?").join(",");
  // statusLine の値があるセッションはそれを、ないセッション（VS Code・Desktop）は会話記録からの見積もりを使う
  const rows = db
    .query<{ session_id: string; taken_at: string; cost_usd: number; source: CostSource }, string[]>(
      `SELECT session_id, taken_at, cost_usd, source FROM session_costs
       WHERE host_id IN (${marks}) AND source = 'statusline' AND taken_at >= ? AND taken_at <= ? ORDER BY session_id, taken_at`,
    )
    .all(...hostIds, start, now.toISOString());
  const hasStatusline = new Set(rows.map((r) => r.session_id));
  const sourceOf = new Map<string, CostSource>(rows.map((r) => [r.session_id, "statusline"]));
  const used = new Map<string, number>();
  // 見積もりは、枠の中の時間帯の分だけを足す
  const est = db
    .query<{ session_id: string; usd: number }, string[]>(
      `SELECT session_id, SUM(usd) AS usd FROM transcript_costs
       WHERE host_id IN (${marks}) AND bucket_start >= ? AND bucket_start <= ? GROUP BY session_id`,
    )
    .all(...hostIds, start, now.toISOString());
  for (const e of est) {
    if (hasStatusline.has(e.session_id)) continue;
    used.set(e.session_id, e.usd);
    sourceOf.set(e.session_id, "transcript");
  }
  let prevSession = "";
  let prev = 0;
  for (const r of rows) {
    if (r.session_id !== prevSession) {
      prevSession = r.session_id;
      // 枠より前の最後の値が基準。なければ、枠の中で始まったセッションは 0、そうでなければ最初の値を基準にする
      const before = db
        .query<{ cost_usd: number }, [string, string, string]>(
          "SELECT cost_usd FROM session_costs WHERE session_id = ? AND source = ? AND taken_at < ? ORDER BY taken_at DESC LIMIT 1",
        )
        .get(r.session_id, r.source, start);
      const started = db
        .query<{ started_at: string }, [string]>("SELECT started_at FROM sessions WHERE session_id = ?")
        .get(r.session_id)?.started_at;
      prev = before ? before.cost_usd : started && started >= start ? 0 : r.cost_usd;
    }
    const inc = r.cost_usd >= prev ? r.cost_usd - prev : r.cost_usd;
    used.set(r.session_id, (used.get(r.session_id) ?? 0) + inc);
    prev = r.cost_usd;
  }
  const total = [...used.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return { totalUsd: 0, items: [] };
  const items = [...used.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([sessionId, usd]) => {
      const s = db
        .query<{ project: string; label: string }, [string]>(
          "SELECT s.project, h.label FROM sessions s JOIN hosts h ON h.host_id = s.host_id WHERE s.session_id = ?",
        )
        .get(sessionId);
      return {
        sessionId,
        project: s?.project ?? "不明",
        hostLabel: s?.label ?? "",
        usd: Math.round(usd * 100) / 100,
        pct: Math.round((usd / total) * 1000) / 10,
        estimated: sourceOf.get(sessionId) === "transcript",
      };
    });
  return { totalUsd: Math.round(total * 100) / 100, items };
}
