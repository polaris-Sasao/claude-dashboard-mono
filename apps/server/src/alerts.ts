// アラート（放置・ファイル競合・危険操作）
// 放置は ~/.claude/sessions のファイルの status、ファイル競合は会話記録の編集、危険操作はエージェントのガードの知らせから出す。
// 状況は定期的に評価し、続いている間は1件にまとめる。解消したら resolved にし、再発したら新しく出す。
// 利用者が閉じたもの（dismissed）は、その事象が解消するまで出し直さない

import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { remoteControlUrl, type AlertKind, type AlertView } from "@kanseishitsu/shared";
import type { ServerConfig } from "./config";
import type { ToolOutcome } from "./local/conversation";
import type { LiveSession } from "./local/sessions";

/** 編集 1 件。担当は「セッション」と「サブエージェント（メインは null）」の組 */
export interface Touch {
  sessionId: string;
  agentId: string | null;
  path: string;
  at: string;
}

/** 評価に使う、今の状況 */
export interface AlertContext {
  live: LiveSession[];
  touches: Touch[];
}

/** 新しく作った危険操作のアラート。次の評価でプッシュ通知に回す */
const pendingOpened: number[] = [];

/** エージェントの guard が送る GuardHit から、危険操作のアラートを作る */
export function recordDanger(
  db: Database,
  hostId: string,
  sessionId: string,
  payload: Record<string, unknown>,
  at: string,
): void {
  const g = payload.guard as { id?: unknown; label?: unknown; mode?: unknown } | undefined;
  const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : `${sessionId}:${at}`;
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const command = typeof input?.command === "string" ? input.command : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const detail = {
    project: cwd ? basename(cwd.replace(/[\\/]+$/, "")) : null,
    guardId: String(g?.id ?? ""),
    guardLabel: String(g?.label ?? "危険操作"),
    guardMode: g?.mode === "log" ? "log" : "ask",
    command: command.length > 300 ? command.slice(0, 300) + "…" : command,
    toolUseId,
    outcome: "pending",
  };
  const r = db
    .query(
      `INSERT INTO alerts (key, kind, host_id, session_id, detail_json, state, created_at, updated_at)
       VALUES (?, 'danger', ?, ?, ?, 'open', ?, ?)`,
    )
    .run(`danger:${toolUseId}`, hostId, sessionId, JSON.stringify(detail), at, at);
  pendingOpened.push(Number(r.lastInsertRowid));
}

/**
 * 危険操作のその後を、会話記録のツールの結果で決める。
 * lookup はそのセッションの会話記録から、ツールの結果と「アラートより後に人のプロンプトがあったか」を返す
 */
export function updateDangerOutcomes(
  db: Database,
  lookup: (sessionId: string, toolUseId: string) => { outcome?: ToolOutcome; promptAfter: (at: string) => boolean } | null,
  now = new Date(),
): boolean {
  const rows = db
    .query<{ alert_id: number; session_id: string | null; detail_json: string; created_at: string }, []>(
      `SELECT alert_id, session_id, detail_json, created_at FROM alerts WHERE kind = 'danger' AND state IN ('open', 'dismissed')
       AND json_extract(detail_json, '$.outcome') = 'pending'`,
    )
    .all();
  let changed = false;
  for (const r of rows) {
    const d = JSON.parse(r.detail_json) as Record<string, unknown>;
    const found = r.session_id ? lookup(r.session_id, String(d.toolUseId ?? "")) : null;
    if (!found) continue;
    let outcome: string | null = null;
    if (found.outcome === "executed") outcome = "executed";
    else if (found.outcome === "failed") outcome = "failed";
    else if (found.outcome === "rejected") outcome = "not_executed";
    // 結果のないまま次のプロンプトに進んだ（中断した）
    else if (found.promptAfter(r.created_at)) outcome = "not_executed";
    if (!outcome) continue;
    db.query("UPDATE alerts SET detail_json = ?, updated_at = ? WHERE alert_id = ?").run(
      JSON.stringify({ ...d, outcome }),
      now.toISOString(),
      r.alert_id,
    );
    changed = true;
  }
  return changed;
}

interface Wanted {
  key: string;
  kind: AlertKind;
  hostId: string;
  sessionId: string | null;
  detail: Record<string, unknown>;
}

/** 許可待ち・回答待ち（ファイルの status が waiting）が idleAlertSec 続いているセッション */
function idleAlerts(ctx: AlertContext, hostId: string, cfg: ServerConfig, now: Date): Wanted[] {
  const limit = now.getTime() - cfg.thresholds.idleAlertSec * 1000;
  return ctx.live
    .filter((s) => s.rawStatus === "waiting" && Date.parse(s.updatedAt) <= limit)
    .map((s) => ({
      // 待ち始めの時刻を鍵に含め、待ちの区切りごとに別のアラートにする
      key: `idle:${s.sessionId}:${s.updatedAt}`,
      kind: "idle" as const,
      hostId,
      sessionId: s.sessionId,
      detail: { project: s.project, waitText: s.statusText, waitingSince: s.updatedAt },
    }));
}

/** Windows のパスは大文字・小文字と区切りの違いを同じものとみなす */
const pathKey = (p: string) => p.replace(/\//g, "\\").toLowerCase();

/** 同じファイルを conflictWindowSec 以内に 2 つ以上の担当が編集した */
function conflictAlerts(ctx: AlertContext, hostId: string, cfg: ServerConfig, now: Date): Wanted[] {
  const since = new Date(now.getTime() - cfg.thresholds.conflictWindowSec * 1000).toISOString();
  const projects = new Map(ctx.live.map((s) => [s.sessionId, s.project]));
  const byPath = new Map<string, Map<string, Touch>>();
  for (const t of ctx.touches) {
    if (t.at <= since) continue;
    const k = pathKey(t.path);
    const actors = byPath.get(k) ?? new Map<string, Touch>();
    const actor = `${t.sessionId}\u0000${t.agentId ?? ""}`;
    const prev = actors.get(actor);
    if (!prev || prev.at < t.at) actors.set(actor, t);
    byPath.set(k, actors);
  }
  const out: Wanted[] = [];
  for (const [k, actors] of byPath) {
    if (actors.size < 2) continue;
    const list = [...actors.values()].sort((a, b) => a.at.localeCompare(b.at));
    // 最後に編集したセッションを代表にする
    const latest = list[list.length - 1]!;
    out.push({
      key: `conflict:${hostId}:${k}`,
      kind: "conflict",
      hostId,
      sessionId: latest.sessionId,
      detail: {
        path: list[0]!.path,
        project: projects.get(latest.sessionId) ?? null,
        actors: list.map((t) => ({ sessionId: t.sessionId, agentId: t.agentId, project: projects.get(t.sessionId) ?? "不明" })),
      },
    });
  }
  return out;
}

/**
 * アラートを評価し直す。変化があれば changed、新しく出したアラートの ID を opened で返す
 * （配信のきっかけにする）
 */
export function evaluateAlerts(
  db: Database,
  cfg: ServerConfig,
  ctx: AlertContext,
  hostId: string,
  now = new Date(),
): { changed: boolean; opened: number[] } {
  const at = now.toISOString();
  const wanted = [...idleAlerts(ctx, hostId, cfg, now), ...conflictAlerts(ctx, hostId, cfg, now)];
  let changed = false;
  const opened: number[] = pendingOpened.splice(0);
  if (opened.length > 0) changed = true;
  db.transaction(() => {
    const active = db
      .query<{ alert_id: number; key: string; state: string; detail_json: string }, []>(
        "SELECT alert_id, key, state, detail_json FROM alerts WHERE state IN ('open', 'dismissed') AND kind IN ('idle', 'conflict')",
      )
      .all();
    const byKey = new Map(active.map((a) => [a.key, a]));
    const wantedKeys = new Set(wanted.map((w) => w.key));
    for (const w of wanted) {
      const json = JSON.stringify(w.detail);
      const cur = byKey.get(w.key);
      if (!cur) {
        const r = db
          .query(
            `INSERT INTO alerts (key, kind, host_id, session_id, detail_json, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .run(w.key, w.kind, w.hostId, w.sessionId, json, at, at);
        opened.push(Number(r.lastInsertRowid));
        changed = true;
      } else if (cur.detail_json !== json) {
        db.query("UPDATE alerts SET detail_json = ?, session_id = ?, updated_at = ? WHERE alert_id = ?").run(
          json,
          w.sessionId,
          at,
          cur.alert_id,
        );
        changed = true;
      }
    }
    for (const a of active) {
      if (wantedKeys.has(a.key)) continue;
      db.query("UPDATE alerts SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE alert_id = ?").run(at, at, a.alert_id);
      if (a.state === "open") changed = true;
    }
  })();
  return { changed, opened };
}

export function dismissAlert(db: Database, alertId: number, now = new Date()): boolean {
  const at = now.toISOString();
  return db.query("UPDATE alerts SET state = 'dismissed', updated_at = ? WHERE alert_id = ? AND state = 'open'").run(at, alertId)
    .changes > 0;
}

/** 画面用：未対応のアラート。プロジェクト名は記録したときのもの、Remote Control の URL は起動中のセッションから取る */
export function openAlerts(db: Database, live: LiveSession[] = []): AlertView[] {
  const bridge = new Map(live.map((s) => [s.sessionId, s.bridgeSessionId]));
  const rows = db
    .query<{ alert_id: number; kind: AlertKind; session_id: string | null; detail_json: string; created_at: string; label: string | null }, []>(
      `SELECT a.alert_id, a.kind, a.session_id, a.detail_json, a.created_at, h.label
       FROM alerts a LEFT JOIN hosts h ON h.host_id = a.host_id
       WHERE a.state = 'open' ORDER BY a.created_at DESC LIMIT 50`,
    )
    .all();
  return rows.map((r) => {
    const d = JSON.parse(r.detail_json) as Record<string, unknown>;
    const view: AlertView = {
      alertId: r.alert_id,
      kind: r.kind,
      hostLabel: r.label ?? "この PC",
      sessionId: r.session_id,
      project: typeof d.project === "string" ? d.project : null,
      createdAt: r.created_at,
    };
    const remoteUrl = remoteControlUrl(r.session_id ? bridge.get(r.session_id) : null);
    if (r.kind === "idle") {
      view.waitText = String(d.waitText ?? "");
      view.waitingSince = String(d.waitingSince ?? r.created_at);
      view.remoteUrl = remoteUrl;
    } else if (r.kind === "danger") {
      view.guardLabel = String(d.guardLabel ?? "");
      view.command = String(d.command ?? "");
      view.guardMode = d.guardMode === "log" ? "log" : "ask";
      view.outcome = (d.outcome as AlertView["outcome"]) ?? "pending";
      view.remoteUrl = remoteUrl;
    } else if (r.kind === "conflict") {
      view.path = String(d.path ?? "");
      view.actors = ((d.actors as { project?: string; agentId: string | null }[]) ?? []).map(
        (a) => `${a.project ?? "不明"}（${a.agentId ? "サブエージェント" : "メイン"}）`,
      );
    }
    return view;
  });
}
