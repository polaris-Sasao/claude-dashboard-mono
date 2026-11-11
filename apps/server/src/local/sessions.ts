// 起動中の Claude Code のセッションを、~/.claude/sessions/<pid>.json から読む。
// このファイルは公開されていない内部用のもの。Claude Code 2.1.319／2.1.321（Windows 11）で確かめた項目だけを使い、
// 項目がない・形が違うときも一覧全体は止めない（docs/plan.md の「情報源」と「リスク」）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PlayerView, SessionStatus, TodoItem } from "@kanseishitsu/shared";
import { modelFromTranscript } from "@kanseishitsu/shared/src/transcript";
import { ancestors, type ProcTable } from "./processes";
import { classify, type GroupKey } from "./groups";

export interface LiveSession extends GroupKey {
  pid: number;
  sessionId: string;
  cwd: string | null;
  project: string;
  name: string | null;
  entrypoint: string | null;
  /** ファイルの status の値そのまま（busy・idle・waiting） */
  rawStatus: string | null;
  waitingFor: string | null;
  status: SessionStatus;
  statusText: string;
  startedAt: string;
  updatedAt: string;
  bridgeSessionId: string | null;
  version: string | null;
  transcriptPath: string | null;
  model: string | null;
  /** 直近の人のプロンプト（index.ts で会話記録から補う） */
  lastPrompt?: string | null;
  /** サブエージェント・Codex CLI（index.ts で会話記録から補う） */
  players?: PlayerView[];
  /** 直近の TodoWrite の内容（index.ts で会話記録から補う） */
  todos?: TodoItem[] | null;
}

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const iso = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null);

/** ファイルの status・waitingFor から、画面の状態と表示の文言を決める */
export function statusOf(raw: string | null, waitingFor: string | null): { status: SessionStatus; statusText: string } {
  switch (raw) {
    case "busy":
      return { status: "run", statusText: "作業中" };
    case "idle":
      return { status: "wait", statusText: "入力待ち" };
    case "waiting":
      if (waitingFor === "permission prompt") return { status: "wait", statusText: "許可待ち" };
      if (waitingFor === "input needed") return { status: "wait", statusText: "回答待ち" };
      return { status: "wait", statusText: waitingFor ? `待ち ・ ${waitingFor}` : "待ち" };
    default:
      return { status: "wait", statusText: raw ? `状態不明 ・ ${raw}` : "状態不明" };
  }
}

/** プロセスが生きていて、Claude Code（claude.exe）であるか。一覧が取れない OS では process.kill で確かめる */
function isClaudeAlive(pid: number, procs: ProcTable): boolean {
  if (procs.size > 0) {
    const p = procs.get(pid);
    return !!p && /^claude(\.exe)?$/i.test(p.name);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 会話記録の場所とモデルは、毎回探し直さないよう覚えておく
const transcriptCache = new Map<string, string>();
const modelCache = new Map<string, { size: number; model: string | null }>();

/** ~/.claude/projects/<フォルダ>/<sessionId>.jsonl を探す（フォルダ名の付け方に頼らず、全フォルダから探す） */
export function findTranscript(sessionId: string, root = claudeDir()): string | null {
  const cached = transcriptCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const projects = join(root, "projects");
  try {
    for (const d of readdirSync(projects, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(projects, d.name, `${sessionId}.jsonl`);
      if (existsSync(p)) {
        transcriptCache.set(sessionId, p);
        return p;
      }
    }
  } catch {
    // projects フォルダがない
  }
  return null;
}

/** 会話記録の直近の応答のモデル。ファイルの大きさが変わったときだけ読み直す */
function modelOf(path: string | null): string | null {
  if (!path) return null;
  try {
    const size = statSync(path).size;
    const c = modelCache.get(path);
    if (c && c.size === size) return c.model;
    const model = modelFromTranscript(path) ?? null;
    modelCache.set(path, { size, model });
    return model;
  } catch {
    return null;
  }
}

/** 起動中のセッションの一覧 */
export function readLiveSessions(procs: ProcTable, root = claudeDir()): LiveSession[] {
  const dir = join(root, "sessions");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  const live = new Set<string>();
  for (const f of files) {
    let s: Record<string, unknown>;
    try {
      s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    } catch {
      continue; // 書き込み途中のファイルなどは飛ばす
    }
    const pid = typeof s.pid === "number" ? s.pid : Number(f.slice(0, -5));
    const sessionId = str(s.sessionId);
    if (!sessionId || !isClaudeAlive(pid, procs)) continue;
    live.add(sessionId);
    const entrypoint = str(s.entrypoint);
    const rawStatus = str(s.status);
    const waitingFor = str(s.waitingFor);
    const cwd = str(s.cwd);
    const transcriptPath = findTranscript(sessionId, root);
    const startedAt = iso(s.startedAt) ?? new Date(0).toISOString();
    out.push({
      ...classify(entrypoint, ancestors(procs, pid)),
      pid,
      sessionId,
      cwd,
      project: cwd ? basename(cwd.replace(/[\\/]+$/, "")) : "",
      name: str(s.name),
      entrypoint,
      rawStatus,
      waitingFor,
      ...statusOf(rawStatus, waitingFor),
      startedAt,
      updatedAt: iso(s.statusUpdatedAt) ?? iso(s.updatedAt) ?? startedAt,
      bridgeSessionId: str(s.bridgeSessionId),
      version: str(s.version),
      transcriptPath,
      model: modelOf(transcriptPath),
    });
  }
  // 終わったセッションの覚え書きを捨てる
  for (const id of transcriptCache.keys()) if (!live.has(id)) transcriptCache.delete(id);
  const paths = new Set(out.map((s) => s.transcriptPath));
  for (const p of modelCache.keys()) if (!paths.has(p)) modelCache.delete(p);
  return out;
}
