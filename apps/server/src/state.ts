// 画面に渡す現在の状態（まとまり・セッション一覧と件数・利用枠・アラート）を組み立てる。
// セッションの一覧は ~/.claude/sessions のファイル（local/sessions.ts）と会話記録（local/conversation.ts）から作る。
// コンテキスト使用率は、statusLine・利用枠の mod から届いた値（sessions テーブル）で補う

import type { Database } from "bun:sqlite";
import {
  modelLabel,
  usageAccountKey,
  remoteControlUrl,
  type GroupView,
  type SessionStatus,
  type SessionView,
  type StateSnapshot,
  type UsageView,
} from "@kanseishitsu/shared";
import { openAlerts } from "./alerts";
import { breakdown, forecast } from "./usage";
import type { ServerConfig } from "./config";
import { sessionExtras } from "./ingest";
import { groupLabel, groupOrder } from "./local/groups";
import type { LiveSession } from "./local/sessions";

interface UsageRow {
  host_id: string;
  label: string;
  taken_at: string;
  five_hour_pct: number | null;
  five_hour_reset: string | null;
  seven_day_pct: number | null;
  seven_day_reset: string | null;
}

/** statusLine・mod から届いた値 */
export type SessionExtras = Map<string, { ctxPct: number | null; model: string | null }>;

const STATUS_ORDER: Record<SessionStatus, number> = { err: 0, wait: 1, run: 2, ended: 3 };

const modelLabelOrRaw = (m: string | null) => (m ? modelLabel(m) ?? m : null);

/** ファイルから読んだセッションを、画面の表示の形にする */
export function liveSessionView(s: LiveSession, extra?: { ctxPct: number | null; model: string | null }): SessionView {
  return {
    sessionId: s.sessionId,
    groupId: s.groupId,
    pid: s.pid,
    name: s.name,
    project: s.project,
    cwd: s.cwd,
    model: modelLabelOrRaw(s.model) ?? extra?.model ?? null,
    status: s.status,
    statusText: s.statusText,
    ctxPct: extra?.ctxPct ?? null,
    startedAt: s.startedAt,
    lastEventAt: s.updatedAt,
    remoteUrl: remoteControlUrl(s.bridgeSessionId),
    players: s.players ?? [],
    lastPrompt: s.lastPrompt ?? null,
  };
}

/** ファイルから読んだセッションを、まとまりごとに並べる */
export function buildGroups(live: LiveSession[], extras: SessionExtras = new Map()): GroupView[] {
  const groups = new Map<string, GroupView & { firstStartedAt: string }>();
  for (const s of live) {
    let g = groups.get(s.groupId);
    if (!g) {
      g = { groupId: s.groupId, kind: s.kind, label: "", sub: "", sessions: [], firstStartedAt: s.startedAt };
      groups.set(s.groupId, g);
    }
    if (s.startedAt < g.firstStartedAt) g.firstStartedAt = s.startedAt;
    g.sessions.push(liveSessionView(s, extras.get(s.sessionId)));
  }
  const out = [...groups.values()].sort(groupOrder);
  for (const g of out) {
    Object.assign(g, groupLabel(g.kind, g.groupId, g.sessions.map((s) => s.project)));
    g.sessions.sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.startedAt.localeCompare(b.startedAt),
    );
  }
  return out.map(({ firstStartedAt: _, ...g }) => g);
}

export function buildSnapshot(db: Database, cfg: ServerConfig, live: LiveSession[], now = new Date()): StateSnapshot {
  const groups = buildGroups(live, sessionExtras(db, live.map((s) => s.sessionId)));
  const counts = { run: 0, wait: 0, err: 0 };
  for (const g of groups) for (const s of g.sessions) if (s.status !== "ended") counts[s.status]++;
  const hosts = db.query<{ host_id: string }, []>("SELECT host_id FROM hosts WHERE revoked_at IS NULL").all();

  // 利用枠はアカウント単位の値。届いた PC ごとの最新値を新しい順に返す
  const usage: UsageView[] = db
    .query<UsageRow, []>(
      `SELECT u.*, h.label FROM usage_snapshots u
       JOIN (SELECT host_id, MAX(taken_at) AS t FROM usage_snapshots GROUP BY host_id) m
         ON u.host_id = m.host_id AND u.taken_at = m.t
       JOIN hosts h ON h.host_id = u.host_id
       ORDER BY u.taken_at DESC`,
    )
    .all()
    .map((u) => ({
      hostId: u.host_id,
      hostLabel: u.label,
      takenAt: u.taken_at,
      fiveHour: u.five_hour_pct === null ? null : { usedPct: u.five_hour_pct, resetsAt: u.five_hour_reset },
      sevenDay: u.seven_day_pct === null ? null : { usedPct: u.seven_day_pct, resetsAt: u.seven_day_reset },
    }));
  // 同じアカウント（5時間枠のリセット時刻が同じ）の PC をまとめて、予測と内訳を付ける
  // statusLine が届かない PC（VS Code・Desktop だけで使っている PC）は利用枠の値がなく、どのアカウントか分からないため、
  // 同じアカウントとみなして含める（今の運用はすべて同じアカウント）
  const withUsage = new Set(usage.filter((u) => Date.parse(u.takenAt) > now.getTime() - 5 * 3600_000).map((u) => u.hostId));
  const noUsage = hosts.map((h) => h.host_id).filter((id) => !withUsage.has(id));
  for (const u of usage) {
    // リセット時刻を過ぎた5時間枠は、新しい枠がまだ始まっていない（内訳・予測なし）
    const r5 = u.fiveHour?.resetsAt ?? null;
    const reset5 = r5 && Date.parse(r5) > now.getTime() ? r5 : null;
    const sameAccount = [...usage.filter((o) => usageAccountKey(o) === usageAccountKey(u)).map((o) => o.hostId), ...noUsage];
    u.fiveHourForecast = forecast(db, "five", reset5, now);
    u.sevenDayForecast = forecast(db, "seven", u.sevenDay?.resetsAt ?? null, now);
    u.fiveHourBreakdown = breakdown(db, sameAccount, reset5, "five", now);
  }

  return {
    generatedAt: now.toISOString(),
    ui: { ctxWarnPct: cfg.thresholds.ctxWarnPct, idleAlertMin: Math.round(cfg.thresholds.idleAlertSec / 60) },
    groups,
    counts,
    usage,
    alerts: openAlerts(db, live),
  };
}

/** generatedAt を除いた内容の指紋。変化があったときだけ配信するために使う */
export function snapshotKey(s: StateSnapshot): string {
  return JSON.stringify({ ...s, generatedAt: undefined });
}
