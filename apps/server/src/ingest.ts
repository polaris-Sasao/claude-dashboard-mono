// 同じ PC のエージェントから届く知らせと、起動中のセッションの記録
//   ・危険操作のガードの知らせ（GuardHit）：アラートにする
//   ・statusLine・利用枠の mod：利用枠・コンテキスト使用率・モデル・費用を記録する
//   ・起動中のセッション（~/.claude/sessions のファイルから読んだもの）：利用枠の消費内訳に使うプロジェクト名・開始時刻を記録する
// セッションの状態・会話・プレイヤーは、会話記録と ~/.claude/sessions から読むため、hooks のイベントは受けない

import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { modelLabel, type HookIngest, type StatuslineIngest } from "@kanseishitsu/shared";
import { recordDanger } from "./alerts";
import type { LiveSession } from "./local/sessions";
import type { HostRow } from "./localhost";
import { recordCost } from "./usage";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const projectOf = (cwd: string | null | undefined) => (cwd ? basename(cwd.replace(/[\\/]+$/, "")) : "");

function touchHost(db: Database, host: HostRow, info: HookIngest["host"], now: string): void {
  db.query("UPDATE hosts SET os = ?, agent_version = ?, last_seen_at = ? WHERE host_id = ?").run(
    info?.os ?? null,
    info?.agentVersion ?? null,
    now,
    host.host_id,
  );
}

/** セッションの行がなければ作る（状態の列は使わないため、決まった値を入れる） */
function ensureSession(db: Database, hostId: string, sessionId: string, cwd: string | null, startedAt: string, at: string): void {
  db.query(
    `INSERT OR IGNORE INTO sessions (session_id, host_id, project, cwd, status, status_text, started_at, last_event_at)
     VALUES (?, ?, ?, ?, 'wait', '', ?, ?)`,
  ).run(sessionId, hostId, projectOf(cwd), cwd, startedAt, at);
}

/** 起動中のセッションを記録する（利用枠の消費内訳のプロジェクト名・開始時刻に使う。15 日で消す） */
export function recordLiveSessions(db: Database, hostId: string, live: LiveSession[]): void {
  db.transaction(() => {
    for (const s of live) {
      ensureSession(db, hostId, s.sessionId, s.cwd, s.startedAt, s.updatedAt);
      db.query("UPDATE sessions SET project = ?, cwd = ?, last_event_at = MAX(last_event_at, ?) WHERE session_id = ?").run(
        s.project,
        s.cwd,
        s.updatedAt,
        s.sessionId,
      );
    }
  })();
}

/** /api/ingest/hook：危険操作のガードの知らせだけを受ける（前身のイベント送信が届いても何もしない） */
export function processHook(db: Database, host: HostRow, body: HookIngest, now = new Date()): void {
  if (body.event !== "GuardHit") return;
  const at = now.toISOString();
  const payload = body.payload ?? {};
  const sessionId = str(payload.session_id);
  if (!sessionId) return;
  db.transaction(() => {
    touchHost(db, host, body.host, at);
    recordDanger(db, host.host_id, sessionId, payload, at);
  })();
}

/** 画面用：statusLine・mod から届いた、セッションごとのコンテキスト使用率とモデル */
export function sessionExtras(db: Database, sessionIds: string[]): Map<string, { ctxPct: number | null; model: string | null }> {
  const out = new Map<string, { ctxPct: number | null; model: string | null }>();
  if (sessionIds.length === 0) return out;
  const rows = db
    .query<{ session_id: string; ctx_pct: number | null; model: string | null }, string[]>(
      `SELECT session_id, ctx_pct, model FROM sessions WHERE session_id IN (${sessionIds.map(() => "?").join(",")})`,
    )
    .all(...sessionIds);
  for (const r of rows) out.set(r.session_id, { ctxPct: r.ctx_pct, model: r.model });
  return out;
}

/** /api/ingest/statusline：statusLine と利用枠の mod の値 */
export function processStatusline(db: Database, host: HostRow, body: StatuslineIngest, now = new Date()): void {
  const at = now.toISOString();
  const p = body.payload ?? {};
  const sessionId = str(p.session_id);
  const model = obj(p.model);
  const label = modelLabel(str(model?.id)) ?? modelLabel(str(model?.display_name));
  const ctx = num(obj(p.context_window)?.used_percentage) ?? null;
  const cwd = str(obj(p.workspace)?.current_dir) ?? str(p.cwd) ?? null;

  db.transaction(() => {
    touchHost(db, host, body.host, at);
    if (sessionId) {
      ensureSession(db, host.host_id, sessionId, cwd, at, at);
      db.query("UPDATE sessions SET model = COALESCE(?, model), ctx_pct = COALESCE(?, ctx_pct) WHERE session_id = ?").run(
        label,
        ctx,
        sessionId,
      );
      const cost = num(obj(p.cost)?.total_cost_usd);
      if (cost !== undefined) recordCost(db, host.host_id, sessionId, cost, at);
    }
    const rl = obj(p.rate_limits);
    if (rl) recordUsage(db, host.host_id, sessionId ?? null, rl, at);
  })();
}

const epochToIso = (v: unknown): string | null => {
  const n = num(v);
  return n === undefined ? null : new Date(n * 1000).toISOString();
};

function recordUsage(
  db: Database,
  hostId: string,
  sessionId: string | null,
  rl: Record<string, unknown>,
  at: string,
): void {
  const five = obj(rl.five_hour);
  const seven = obj(rl.seven_day);
  if (!five && !seven) return;
  const row = {
    fp: num(five?.used_percentage) ?? null,
    fr: epochToIso(five?.resets_at),
    sp: num(seven?.used_percentage) ?? null,
    sr: epochToIso(seven?.resets_at),
  };
  // 値が変わらない間は 1 分に 1 回だけ記録する
  const last = db
    .query<
      { taken_at: string; five_hour_pct: number | null; seven_day_pct: number | null },
      [string]
    >("SELECT taken_at, five_hour_pct, seven_day_pct FROM usage_snapshots WHERE host_id = ? ORDER BY taken_at DESC LIMIT 1")
    .get(hostId);
  if (
    last &&
    last.five_hour_pct === row.fp &&
    last.seven_day_pct === row.sp &&
    Date.parse(at) - Date.parse(last.taken_at) < 60_000
  )
    return;
  db.query(
    `INSERT INTO usage_snapshots (taken_at, host_id, session_id, five_hour_pct, five_hour_reset, seven_day_pct, seven_day_reset)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(at, hostId, sessionId, row.fp, row.fr, row.sp, row.sr);
}
