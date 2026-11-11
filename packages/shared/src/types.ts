// サーバー・画面・エージェントで共有する型

import type { PlayerKind, PlayerStatus, TodoItem } from "./players";

/** セッションの状態。run=稼働中（緑）、wait=入力待ち（黄）、err=異常（朱）、ended=終了 */
export type SessionStatus = "run" | "wait" | "err" | "ended";

/** エージェントが /api/ingest/hook へ送る本文 */
export interface HookIngest {
  /** フックイベント名（例：PreToolUse）。コマンドライン引数で渡された値 */
  event: string;
  host: HostInfo;
  /** Claude Code から標準入力で受け取った JSON（伏せ字化済み） */
  payload: Record<string, unknown>;
  /** エージェント側の送信時刻（ISO 8601） */
  sentAt: string;
}

/** エージェントが /api/ingest/statusline へ送る本文 */
export interface StatuslineIngest {
  host: HostInfo;
  payload: Record<string, unknown>;
  sentAt: string;
}

export interface HostInfo {
  hostname: string;
  os: string;
  label?: string;
  /** エージェントのバージョン（古いものが動いていないかの確認用） */
  agentVersion?: string;
}

/** 利用枠1つ分（5時間枠・週間枠） */
export interface RateWindow {
  usedPct: number;
  resetsAt: string | null;
}

export interface SessionView {
  sessionId: string;
  /** 所属するまとまり（GroupView.groupId） */
  groupId: string;
  /** Claude Code の pid */
  pid: number | null;
  /** セッションの表示名（~/.claude/sessions/<pid>.json の name）。なければ null */
  name: string | null;
  project: string;
  cwd: string | null;
  model: string | null;
  status: SessionStatus;
  statusText: string;
  ctxPct: number | null;
  startedAt: string;
  lastEventAt: string;
  /** Remote Control の URL。このセッションで /remote-control が有効でなければ null */
  remoteUrl: string | null;
  /** 直近のプロンプト以降に起動した、または稼働中のプレイヤー */
  players: PlayerView[];
  /** 直近の人のプロンプト（会話記録から。先頭の一部だけ）。まだなければ null */
  lastPrompt?: string | null;
}

/** プロンプト 1 件と、それに対する最後の応答の組（会話記録から作る） */
export interface TurnView {
  promptId: string;
  at: string;
  prompt: string;
  /** そのターンの最後の応答の文章。まだなければ null */
  response: { text: string; at: string } | null;
  /** 利用者が途中で止めた */
  interrupted: boolean;
}

export interface PlayerView {
  playerId: string;
  kind: PlayerKind;
  /** モデルのラベル（Sonnet 5.5 など）。不明なら null */
  model: string | null;
  agentType: string | null;
  task: string | null;
  status: PlayerStatus;
  startedAt: string;
  endedAt: string | null;
}

/** 詳細パネル用 */
export interface SessionDetail {
  session: SessionView;
  groupLabel: string;
  groupSub: string;
  /** プロンプトと応答の組（古い順。新しいほうから最大 TURN_LIMIT 件） */
  turns: TurnView[];
  /** 会話記録に、表示した分より前のターンがある */
  moreTurns: boolean;
  todos: TodoItem[] | null;
}

/** 詳細に出すターンの上限 */
export const TURN_LIMIT = 200;

/**
 * まとまり（起動元）の種類。
 * vscode=VS Code の拡張（窓ごと）、vscode-terminal=VS Code の中のターミナル、windows-terminal=Windows Terminal、
 * desktop=Claude Desktop、other=そのほか（entrypoint の値ごと）
 */
export type GroupKind = "vscode" | "vscode-terminal" | "windows-terminal" | "desktop" | "other";

export interface GroupView {
  groupId: string;
  kind: GroupKind;
  label: string;
  /** 補足（VS Code の窓では作業フォルダの名前など） */
  sub: string;
  sessions: SessionView[];
}

export interface UsageView {
  hostId: string;
  hostLabel: string;
  takenAt: string;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  /** フェーズ5：上限予測（目安） */
  fiveHourForecast?: UsageForecast | null;
  sevenDayForecast?: UsageForecast | null;
  /** フェーズ5：今の5時間枠の消費内訳（Claude Code の費用の推定から） */
  fiveHourBreakdown?: UsageBreakdown | null;
}

export interface UsageForecast {
  /** 1時間あたりの増え方（%） */
  perHour: number;
  /** 100% に届く見込みの時刻。増えていなければ null */
  hitAt: string | null;
  /** リセットより前に届く見込みか */
  beforeReset: boolean;
  /** 計算に使った期間（分） */
  basisMin: number;
}

export interface UsageBreakdown {
  totalUsd: number;
  /** estimated：会話記録のトークン数からの見積もり（statusLine のない VS Code・Desktop。少なめに出る） */
  items: { sessionId: string; project: string; hostLabel: string; usd: number; pct: number; estimated: boolean }[];
}

export interface StateSnapshot {
  generatedAt: string;
  /** 画面の表示に使うしきい値 */
  ui: { ctxWarnPct: number; idleAlertMin: number };
  groups: GroupView[];
  counts: { run: number; wait: number; err: number };
  usage: UsageView[];
  /** 未対応のアラート（新しい順） */
  alerts: AlertView[];
}

export type AlertKind = "idle" | "conflict" | "danger";

export interface AlertView {
  alertId: number;
  kind: AlertKind;
  hostLabel: string;
  sessionId: string | null;
  project: string | null;
  /** 放置：待ちの内容と、待ち始めた時刻 */
  waitText?: string;
  waitingSince?: string;
  /** 競合：ファイルと、編集した担当の表示名 */
  path?: string;
  actors?: string[];
  /** 放置・危険操作の Remote Control 用 */
  remoteUrl?: string | null;
  /** 危険操作：判定の説明、コマンド（伏せ字化・切り詰め済み）、扱い（ask＝許可ダイアログに回した、log＝記録のみ）、その後 */
  guardLabel?: string;
  command?: string;
  guardMode?: "ask" | "log";
  outcome?: "pending" | "executed" | "failed" | "not_executed";
  createdAt: string;
}

/** /ws で配信するメッセージ。フェーズ1は変化のたびに全体スナップショットを送る */
export type WsMessage =
  | { type: "snapshot"; state: StateSnapshot }
  | { type: "ping"; at: string };
