// 会話記録（~/.claude/projects/<フォルダ>/<sessionId>.jsonl）から、プロンプトと応答の組を作る（docs/plan.md の「詳細と履歴」）。
//
// 組み合わせは時刻の順番ではなく、記録のつながりで決める（Claude Code 2.1.318〜2.1.321 の会話記録で確かめた形）。
//   ・人のプロンプト：type が user で origin.kind が human の記録。promptId を持つ
//   ・ツールの結果などの user の記録：同じターンのプロンプトの promptId を持つ
//   ・assistant の記録：promptId を持たない。parentUuid でたどった直前の記録の promptId のターンに属する
// 応答として出すのは、そのターンの最後の assistant の文章だけ（途中の文章・ツールの実行・考え中の内容は出さない）。
// ファイルは前回読んだ位置から続きだけを読む。
// あわせて、ファイル競合の判定に使う編集（Edit・Write など）と、危険操作のその後の判定に使うツールの結果も集める。

import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  AGENT_TOOLS,
  codexModel,
  isCodexCall,
  modelLabel,
  parseTaskNotification,
  redactText,
  todosFromInput,
  type PlayerView,
  type TodoItem,
  type TurnView,
} from "@kanseishitsu/shared";

/** プロンプトの本文は、IDE が添えた情報などを除き、伏せ字にしたもの */
export type Turn = TurnView;

type Rec = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);

/** IDE や Claude Code がプロンプトに添える情報（利用者が打った文ではないもの） */
const ATTACHED = /<(ide_opened_file|ide_selection|ide_diagnostics|system-reminder|artifact-content-authored-by-others)\b[^>]*>[\s\S]*?<\/\1>|<artifact-content-authored-by-others\/>/g;

function blocks(message: Rec | null): Rec[] {
  const c = message?.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? (c.filter((b) => obj(b)) as Rec[]) : [];
}

function textOf(message: Rec | null): string {
  return blocks(message)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** スラッシュコマンドは「/名前 引数」の形にする */
function commandText(t: string): string | null {
  const name = t.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return null;
  const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

export function promptText(message: Rec | null): string {
  const raw = textOf(message);
  const cmd = commandText(raw);
  let t = cmd ?? raw.replace(ATTACHED, "").trim();
  const images = blocks(message).filter((b) => b.type === "image").length;
  if (images > 0) t = `${t}${t ? "\n" : ""}［画像 ${images} 枚］`;
  return redactText(t);
}

const INTERRUPTED = /^\[Request interrupted by user/;

/** 人が入れたプロンプトの記録か */
export function isHumanPrompt(r: Rec): boolean {
  if (r.type !== "user" || r.isSidechain || r.isMeta || r.isCompactSummary) return false;
  const origin = obj(r.origin);
  if (origin) return origin.kind === "human";
  // origin のない古い版の記録：ツールの結果・中断の印・コマンドの出力・自動の知らせを除いた文章
  const message = obj(r.message);
  if (blocks(message).some((b) => b.type === "tool_result")) return false;
  const t = textOf(message).trim();
  if (!t || INTERRUPTED.test(t)) return false;
  // スラッシュコマンド（<command-name>）は人の入力として扱い、その出力・自動の知らせは除く
  return !/^<(local-command-|task-notification)/.test(t);
}

/** 編集として扱うツールと、パスの入っている項目 */
const EDIT_TOOLS: Record<string, string> = { Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };
/** 覚えておく編集の件数（競合は直近 10 分で判定するため、多くは要らない） */
const MAX_EDITS = 500;

export interface FileEdit {
  path: string;
  at: string;
}

/** ツールの結果：executed＝実行された、failed＝失敗した、rejected＝利用者が却下した（実行されていない） */
export type ToolOutcome = "executed" | "failed" | "rejected";

/** assistant の記録から、ファイルの編集を取り出す */
export function editsOf(r: Rec): FileEdit[] {
  if (r.type !== "assistant") return [];
  const at = str(r.timestamp);
  if (!at) return [];
  const out: FileEdit[] = [];
  for (const b of blocks(obj(r.message))) {
    const field = b.type === "tool_use" && typeof b.name === "string" ? EDIT_TOOLS[b.name] : undefined;
    const path = field ? str(obj(b.input)?.[field]) : null;
    if (path) out.push({ path, at });
  }
  return out;
}

/** 却下したときの tool_result の本文（Claude Code 2.1.x の会話記録で確かめた形） */
const REJECTED = /^The user doesn't want to proceed with this tool use/;

/** user の記録から、ツールの結果（tool_use_id ごと）を取り出す */
export function outcomesOf(r: Rec): [string, ToolOutcome][] {
  if (r.type !== "user") return [];
  const out: [string, ToolOutcome][] = [];
  for (const b of blocks(obj(r.message))) {
    const id = b.type === "tool_result" ? str(b.tool_use_id) : null;
    if (!id) continue;
    const c = b.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => String(obj(x)?.text ?? "")).join("") : "";
    out.push([id, b.is_error ? (REJECTED.test(text) ? "rejected" : "failed") : "executed"]);
  }
  return out;
}

/** プレイヤー（サブエージェント・Codex CLI）。バックグラウンドで起動したものは、ツールの結果ではなく終了の知らせで終える */
interface Player extends PlayerView {
  background: boolean;
}

/** assistant の記録の tool_use から、プレイヤーの起動を取り出す（前身の hooks の PreToolUse と同じ判定） */
export function playersOf(r: Rec): Player[] {
  if (r.type !== "assistant") return [];
  const at = str(r.timestamp) ?? new Date(0).toISOString();
  const out: Player[] = [];
  for (const b of blocks(obj(r.message))) {
    const id = b.type === "tool_use" ? str(b.id) : null;
    const name = str(b.name) ?? undefined;
    const input = obj(b.input) ?? undefined;
    if (!id || !name) continue;
    const background = input?.run_in_background === true;
    if (AGENT_TOOLS.has(name)) {
      out.push({
        playerId: id,
        kind: "claude",
        agentType: str(input?.subagent_type),
        model: modelLabel(str(input?.model)),
        task: str(input?.description),
        status: "run",
        startedAt: at,
        endedAt: null,
        background,
      });
    } else if (isCodexCall(name, input)) {
      const command = str(input?.command) ?? str(input?.prompt) ?? "";
      out.push({
        playerId: id,
        kind: "codex",
        agentType: null,
        model: codexModel(name, input),
        task: str(input?.description) ?? (command ? redactText(command.length > 80 ? command.slice(0, 80) + "…" : command) : null),
        status: "run",
        startedAt: at,
        endedAt: null,
        background,
      });
    }
  }
  return out;
}

/** 行ごとに読む会話記録の、続きだけを読む仕組み */
abstract class IncrementalReader {
  private offset = 0;
  private carry = "";

  constructor(readonly path: string) {}

  /** 増えた分を読む。ファイルが小さくなった（作り直された）ときは最初から読む */
  update(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.path, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.carry = "";
        this.reset();
      }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.carry + buf.toString("utf8")).split("\n");
      this.carry = lines.pop() ?? "";
      for (const line of lines) this.add(line);
    } catch {
      // ファイルがない・読めないときは今までの内容のまま
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  protected abstract reset(): void;
  abstract add(line: string): void;
}

/** サブエージェントの会話記録（<sessionId>/subagents/agent-*.jsonl）から、編集だけを集める */
export class EditLog extends IncrementalReader {
  edits: FileEdit[] = [];

  protected reset(): void {
    this.edits = [];
  }

  add(line: string): void {
    if (!line.includes('"tool_use"')) return;
    try {
      this.edits.push(...editsOf(JSON.parse(line) as Rec));
      if (this.edits.length > MAX_EDITS) this.edits = this.edits.slice(-MAX_EDITS);
    } catch {
      // 壊れた行は飛ばす
    }
  }
}

/** 1 つの会話記録の読み取り状態。続きだけを読むために、読んだ位置とつながりを覚えておく */
export class Conversation extends IncrementalReader {
  private turns = new Map<string, Turn>();
  private order: string[] = [];
  /** 記録の uuid → 属するターンの promptId */
  private owner = new Map<string, string>();
  /** 直前の応答の message.id（1 つの応答が区画ごとに複数の記録に分かれるため） */
  private lastMessageId = new Map<string, string>();
  /** メインの会話でのファイルの編集（新しいほうから MAX_EDITS 件） */
  edits: FileEdit[] = [];
  /** ツールの結果（tool_use_id → 結果） */
  private outcomes = new Map<string, ToolOutcome>();
  /** プレイヤー（tool_use_id → プレイヤー） */
  private playerMap = new Map<string, Player>();
  /** 直近の TodoWrite の内容 */
  todos: TodoItem[] | null = null;

  protected reset(): void {
    this.edits = [];
    this.outcomes.clear();
    this.playerMap.clear();
    this.todos = null;
    this.turns.clear();
    this.order = [];
    this.owner.clear();
    this.lastMessageId.clear();
  }

  /** 1 行分の記録を取り込む（テストからも使う） */
  add(line: string): void {
    if (!line.trim()) return;
    let r: Rec;
    try {
      r = JSON.parse(line) as Rec;
    } catch {
      return;
    }
    if (r.isSidechain) return;
    for (const e of editsOf(r)) this.edits.push(e);
    if (this.edits.length > MAX_EDITS) this.edits = this.edits.slice(-MAX_EDITS);
    for (const [id, o] of outcomesOf(r)) {
      this.outcomes.set(id, o);
      const p = this.playerMap.get(id);
      // バックグラウンドのものは、起動の結果がすぐ返るため、ここでは終えない
      if (p && !p.background && p.status === "run") Object.assign(p, { status: o === "executed" ? "done" : "err", endedAt: str(r.timestamp) });
    }
    for (const p of playersOf(r)) if (!this.playerMap.has(p.playerId)) this.playerMap.set(p.playerId, p);
    this.trackTodosAndNotifications(r);
    const uuid = str(r.uuid);
    const at = str(r.timestamp) ?? new Date(0).toISOString();
    const message = obj(r.message);

    // attachment・system などの記録も、プロンプトと応答の間に挟まる（つながりは追い、中身は使わない）
    if (r.type !== "user" && r.type !== "assistant") {
      const parent = str(r.parentUuid);
      const id = str(r.promptId) ?? (parent ? this.owner.get(parent) : undefined);
      if (uuid && id) this.owner.set(uuid, id);
      return;
    }

    if (isHumanPrompt(r)) {
      const id = str(r.promptId) ?? uuid ?? `${this.order.length}`;
      if (!this.turns.has(id)) {
        this.turns.set(id, { promptId: id, at, prompt: promptText(message), response: null, interrupted: false });
        this.order.push(id);
      }
      if (uuid) this.owner.set(uuid, id);
      return;
    }

    const parent = str(r.parentUuid);
    const id = str(r.promptId) ?? (parent ? this.owner.get(parent) : undefined);
    if (!id) return;
    if (uuid) this.owner.set(uuid, id);
    const turn = this.turns.get(id);
    if (!turn) return;

    if (r.type === "user") {
      if (INTERRUPTED.test(textOf(message).trim())) turn.interrupted = true;
      return;
    }
    const text = textOf(message).trim();
    if (!text) return;
    const messageId = str(message?.id);
    // 同じ応答（message.id が同じ）の続きの区画なら、前の文章につなげる
    if (turn.response && messageId && this.lastMessageId.get(id) === messageId) {
      turn.response = { text: `${turn.response.text}\n${redactText(text)}`, at };
    } else {
      turn.response = { text: redactText(text), at };
    }
    if (messageId) this.lastMessageId.set(id, messageId);
    turn.interrupted = false;
  }

  /** TodoWrite の内容と、バックグラウンドの作業の終了の知らせ（<task-notification>）を取り込む */
  private trackTodosAndNotifications(r: Rec): void {
    const message = obj(r.message);
    if (r.type === "assistant") {
      for (const b of blocks(message)) {
        if (b.type !== "tool_use" || b.name !== "TodoWrite") continue;
        const todos = todosFromInput(obj(b.input) ?? undefined);
        if (todos) this.todos = todos;
      }
      return;
    }
    const note = parseTaskNotification(textOf(message));
    const p = note?.toolUseId ? this.playerMap.get(note.toolUseId) : undefined;
    if (p && p.status === "run") Object.assign(p, { status: note!.status === "completed" || !note!.status ? "done" : "err", endedAt: str(r.timestamp) });
  }

  /**
   * 画面に出すプレイヤー：稼働中のもの、直近の人のプロンプトより後に起動したもの・終わったもの
   * （完了したものは、次のプロンプトまで完了の印で残す。前身と同じ）
   */
  players(): PlayerView[] {
    const last = this.order[this.order.length - 1];
    const since = last ? this.turns.get(last)!.at : "";
    return [...this.playerMap.values()]
      .filter((p) => p.status === "run" || p.startedAt >= since || (p.endedAt !== null && p.endedAt >= since))
      .map(({ background: _, ...p }) => ({ ...p }));
  }

  /** そのツールの結果。まだ結果がなければ undefined */
  outcome(toolUseId: string): ToolOutcome | undefined {
    return this.outcomes.get(toolUseId);
  }

  /** その時刻より後に、人のプロンプトがあったか */
  promptAfter(at: string): boolean {
    const last = this.order[this.order.length - 1];
    return !!last && this.turns.get(last)!.at > at;
  }

  get size(): number {
    return this.order.length;
  }

  /** 古い順のターン。limit を付けると新しいほうから limit 件 */
  list(limit?: number): Turn[] {
    const ids = limit ? this.order.slice(-limit) : this.order;
    return ids.map((id) => ({ ...this.turns.get(id)! }));
  }
}

/** 会話記録ごとの読み取り状態。終わったセッションの分は retain で捨てる */
export class ConversationStore {
  private map = new Map<string, Conversation>();
  private subagentLogs = new Map<string, EditLog>();

  /**
   * そのセッションのサブエージェントの編集（<会話記録と同じ名前のフォルダ>/subagents/*.jsonl）。
   * 前身の会話記録の集計（tokens.ts）と同じ場所。この PC ではまだ実物を確かめていない
   */
  subagentEdits(transcriptPath: string): { agentId: string; edits: FileEdit[] }[] {
    const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return [];
    }
    return files.map((f) => {
      const p = join(dir, f);
      let log = this.subagentLogs.get(p);
      if (!log) {
        log = new EditLog(p);
        this.subagentLogs.set(p, log);
      }
      log.update();
      return { agentId: basename(f, ".jsonl").replace(/^agent-/, ""), edits: log.edits };
    });
  }

  get(path: string): Conversation {
    let c = this.map.get(path);
    if (!c) {
      c = new Conversation(path);
      this.map.set(path, c);
    }
    c.update();
    return c;
  }

  /** keep に含まれない会話記録の状態を捨てる */
  retain(keep: Set<string>): void {
    for (const p of this.map.keys()) if (!keep.has(p)) this.map.delete(p);
    const dirs = [...keep].map((p) => join(dirname(p), basename(p, ".jsonl")));
    for (const p of this.subagentLogs.keys()) if (!dirs.some((d) => p.startsWith(d))) this.subagentLogs.delete(p);
  }
}
