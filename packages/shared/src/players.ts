// プレイヤー（サブエージェント・Codex CLI）の検知
// サブエージェントは Agent ツール（旧名 Task）の呼び出しから、Codex CLI はシェルで実行されたコマンドから検知する

export type PlayerKind = "claude" | "codex";
export type PlayerStatus = "run" | "done" | "err";

export const AGENT_TOOLS = new Set(["Agent", "Task"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

// ヒアドキュメントの本文と、引用符で囲まれた文字列（ファイルに書き込む内容やメッセージ）は判定の対象外にする
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;

export function stripQuoted(command: string): string {
  return command.replace(HEREDOC, "").replace(QUOTED, "''");
}

// コマンドの先頭（または ; & | ( $( 改行の直後）で codex が呼ばれているか。
// 環境変数の前置き、npx 経由、フルパス（/c/…/codex.exe など）も含める
const CODEX_INVOCATION =
  /(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+(?:-y\s+)?@openai\/)?(?:[^\s;&|()'"]*[\\/])?codex(?:\.exe|\.cmd)?(?=\s|$)/g;
/** 版や使い方の表示だけの呼び出しは、作業として数えない */
const INFO_ONLY = /^\s*(?:--version|-V|--help|-h|help)\s*$/;

/**
 * 実行ファイルの場所を変数に入れてから起動する書き方（C=$(… codex.exe …); "$C" exec …）と、
 * 引用符で囲んだパスでの起動（"C:/…/codex.exe" exec …）を、ただの codex に置き換える
 */
function normalizeCodex(command: string): string {
  const body = command.replace(HEREDOC, "");
  const vars = new Set<string>();
  // bash：NAME=… / PowerShell：$NAME = …（値に codex.exe などを含むもの）
  for (const m of body.matchAll(/(?:^|[;&|(\s])\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^;&|\n]*?(?:[\\/]|\b)codex(?:\.exe|\.cmd)?\b/g)) vars.add(m[1]!);
  let out = body;
  if (vars.size > 0) {
    const names = [...vars].join("|");
    out = out.replace(new RegExp(`"?\\$(?:\\{(?:${names})\\}|(?:${names})\\b)"?`, "g"), " codex ");
  }
  return out.replace(/"[^"\n]*[\\/]codex(?:\.exe|\.cmd)?"|'[^'\n]*[\\/]codex(?:\.exe|\.cmd)?'/g, " codex ");
}

/** codex の起動ごとの引数（次の ; & | 改行まで）。引用符の中身を含めたものを返す */
function codexInvocations(command: string): string[] {
  const norm = normalizeCodex(command);
  const view = norm.replace(QUOTED, (q) => "\u0000".repeat(q.length));
  const out: string[] = [];
  for (const m of view.matchAll(CODEX_INVOCATION)) {
    const from = m.index! + m[0].length;
    const restView = view.slice(from);
    const len = restView.search(/[;&|\n]/);
    const args = norm.slice(from, len < 0 ? undefined : from + len);
    // 2>&1 などのつなぎ替えは除いてから見る
    if (INFO_ONLY.test(args.replace(/\u0000/g, "").replace(/\s*\d*[<>]+\S*/g, ""))) continue;
    out.push(args);
  }
  return out;
}

/** ツール呼び出しが Codex CLI の起動かどうか */
export function isCodexCall(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): boolean {
  if (!toolName) return false;
  // Codex を MCP サーバーとして使う場合（mcp__codex__codex など）
  if (toolName.startsWith("mcp__") && /codex/i.test(toolName)) return true;
  if (!SHELL_TOOLS.has(toolName)) return false;
  const cmd = toolInput?.command;
  return typeof cmd === "string" && codexInvocations(cmd).length > 0;
}

// codex のモデル指定：-m・--model（空白または = 区切り）と、-c model=…（設定の上書き）
const CODEX_MODEL = /(?:^|\s)(?:(?:-m|--model)(?:\s+|=)|-c\s+['"]?model=)(['"]?)([A-Za-z0-9][\w.:/-]*)\1?/;

/** Codex の起動で指定されたモデル。指定がなければ null（Codex 側の設定ファイルの既定値はここからは分からない） */
export function codexModel(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): string | null {
  if (!isCodexCall(toolName, toolInput)) return null;
  if (toolName!.startsWith("mcp__")) return typeof toolInput?.model === "string" && toolInput.model ? toolInput.model : null;
  for (const args of codexInvocations(toolInput!.command as string)) {
    const m = args.match(CODEX_MODEL)?.[2];
    if (m) return m;
  }
  return null;
}

export interface TodoItem {
  label: string;
  status: "done" | "active" | "todo";
}

/** TodoWrite の入力（todos 配列）を進捗の表示用に変換する */
export function todosFromInput(toolInput: Record<string, unknown> | undefined): TodoItem[] | null {
  const todos = toolInput?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((t): TodoItem[] => {
    if (!t || typeof t !== "object") return [];
    const o = t as Record<string, unknown>;
    const label = typeof o.content === "string" ? o.content : typeof o.subject === "string" ? o.subject : null;
    if (!label) return [];
    const status = o.status === "completed" ? "done" : o.status === "in_progress" ? "active" : "todo";
    return [{ label, status }];
  });
}

// Remote Control：~/.claude/sessions/<pid>.json の bridgeSessionId（session_…）が URL の末尾になる。
// 公開されていない内部ファイルのため、形式が合わない値は使わない
const REMOTE_SESSION_ID = /^session_[A-Za-z0-9]{8,64}$/;

export function remoteControlUrl(remoteSessionId: string | null | undefined): string | null {
  return remoteSessionId && REMOTE_SESSION_ID.test(remoteSessionId) ? `https://claude.ai/code/${remoteSessionId}` : null;
}

/**
 * 利用枠の値から同じアカウントを見分ける鍵。週間枠のリセット時刻を使う
 * （5時間枠はリセットのあと、新しい枠が始まるまで値が届かず、見分けに使えないため）
 */
export function usageAccountKey(u: { hostId: string; fiveHour: { resetsAt: string | null } | null; sevenDay: { resetsAt: string | null } | null }): string {
  return u.sevenDay?.resetsAt ?? u.fiveHour?.resetsAt ?? `host:${u.hostId}`;
}

/**
 * バックグラウンドの作業（Bash・サブエージェント）が終わったときに、Claude Code が自動で送るプロンプト（<task-notification>）。
 * 人のプロンプトではないので、直近のプロンプトや履歴には数えない。どのツール呼び出しが、どう終わったかを返す
 */
export function parseTaskNotification(prompt: unknown): { toolUseId: string | null; status: string | null } | null {
  if (typeof prompt !== "string" || !/^\s*<task-notification>/.test(prompt)) return null;
  const tag = (name: string) => prompt.match(new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`))?.[1] ?? null;
  return { toolUseId: tag("tool-use-id"), status: tag("status") };
}
