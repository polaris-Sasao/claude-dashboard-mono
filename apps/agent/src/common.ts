// エージェント共通処理。最優先は「Claude Code の動作を絶対に妨げない」こと：
// 失敗しても再送せず、標準出力に余計なものを出さず、終了コード 0 で終える。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";
import type { HostInfo } from "@kanseishitsu/shared";
import pkg from "../package.json";

export const AGENT_DIR = join(homedir(), ".kanseishitsu");
export const CONFIG_PATH = join(AGENT_DIR, "config.json");
const LOG_PATH = join(AGENT_DIR, "agent.log");

/** 監視サーバーの既定の送り先（同じ PC の中だけ） */
export const DEFAULT_SERVER_URL = "http://localhost:8790";

export interface AgentConfig {
  /** 監視サーバーの URL。既定は http://localhost:8790（サーバーのポートを変えたときだけ設定する） */
  serverUrl: string;
  hostLabel?: string;
  /** 送信タイムアウト（ミリ秒） */
  timeoutMs?: number;
  /** 危険操作のガード：ask＝許可ダイアログに回す（既定）、log＝記録だけ、off＝判定しない */
  guardMode?: "ask" | "log" | "off";
}

/** 同じ PC の中の URL か（http の localhost・127.0.0.1・[::1]） */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 設定ファイル（~/.kanseishitsu/config.json）。なければ既定値で動く。
 * 送り先は同じ PC の中だけにする。前身（複数 PC 版）の設定が残っていて送り先がほかの PC でも、そこへは送らない
 */
export function loadConfig(): AgentConfig {
  let c: Partial<AgentConfig> & { token?: unknown; hostLabel?: unknown } = {};
  try {
    c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AgentConfig>;
  } catch {
    // 設定ファイルがない・読めない
  }
  // 前身のトークンと PC の表示名は使わない（表示名はサーバーがこの PC の名前を使う）
  const { token: _token, hostLabel: _label, ...rest } = c;
  return { ...rest, serverUrl: c.serverUrl && isLocalUrl(c.serverUrl) ? c.serverUrl : DEFAULT_SERVER_URL };
}

/** 送信失敗などはローカルのログにだけ残す（1MB を超えたら1世代だけ残して切り替える） */
export function log(msg: string): void {
  try {
    if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 1024 * 1024) renameSync(LOG_PATH, LOG_PATH + ".1");
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ログが書けなくても何もしない
  }
}

export async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  try {
    const text = await Bun.stdin.text();
    const v = text.trim() ? JSON.parse(text) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    log(`stdin parse error: ${String(e)}`);
    return {};
  }
}

function osName(): string {
  const p = platform();
  if (p === "win32") {
    const build = Number(release().split(".")[2] ?? 0);
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  return `${p} ${release()}`;
}

export function hostInfo(cfg: AgentConfig): HostInfo {
  return { hostname: hostname(), os: osName(), label: cfg.hostLabel, agentVersion: pkg.version };
}

const MAX_STRING = 8000;

/** 長い文字列（ファイル内容やコマンド出力）を切り詰め、送信量と DB の肥大を抑える */
export function truncateDeep<T>(value: T): T {
  if (typeof value === "string")
    return (value.length > MAX_STRING ? value.slice(0, MAX_STRING) + `…（${value.length}文字中 ${MAX_STRING}文字）` : value) as T;
  if (Array.isArray(value)) return value.slice(0, 200).map(truncateDeep) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateDeep(v);
    return out as T;
  }
  return value;
}

export async function post(cfg: AgentConfig, path: string, body: unknown): Promise<void> {
  const url = cfg.serverUrl.replace(/\/+$/, "") + path;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 1500),
    });
    if (!res.ok) log(`POST ${path} -> HTTP ${res.status}`);
  } catch (e) {
    log(`POST ${path} failed: ${e instanceof Error ? e.name + ": " + e.message : String(e)}`);
  }
}

/**
 * このセッションの Remote Control のセッション ID（session_…）。
 * Claude Code は動いているセッションごとに ~/.claude/sessions/<pid>.json を書き、/remote-control が有効な間は
 * bridgeSessionId を持つ（公開されていない内部ファイル。2.1.291 で確認）。無効なら null、ファイルが見つからなければ undefined
 */
export function remoteSessionId(sessionId: unknown): string | null | undefined {
  if (typeof sessionId !== "string" || !sessionId) return undefined;
  const dir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "sessions");
  try {
    const files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).slice(0, 64);
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
        if (s.sessionId !== sessionId) continue;
        return typeof s.bridgeSessionId === "string" && s.bridgeSessionId ? s.bridgeSessionId : null;
      } catch {
        // 書き込み途中のファイルなどは飛ばす
      }
    }
  } catch {
    // sessions ディレクトリがない
  }
  return undefined;
}
