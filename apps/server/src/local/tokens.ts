// 会話記録（メインとサブエージェント）から、モデルごとのトークン数を10分刻みの時間帯ごとに数える。
// 時間帯に分けるのは、開き直した古い会話の分を、今の利用枠に入れないため（サーバーは枠の中の時間帯だけを足す）。
// 記録は追記されていくので、前回読んだ位置をデータの置き場所の usage/<セッション>.json に覚えて、続きだけを読む。
// （前身ではエージェントが Stop フックのたびに数えて送っていた。単独 PC 版ではサーバーが起動中のセッションの分を数える）
// 1つの応答は内容ブロックごとに複数の行に分かれ、同じ usage が繰り返されるため、message.id で重複を除く

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TokenCounts } from "@kanseishitsu/shared";

interface FileState {
  offset: number;
  lastId: string;
}
/** 時間帯（10分刻みの開始時刻）→ モデル → トークン数 */
export type TokenBuckets = Record<string, Record<string, TokenCounts>>;

interface UsageState {
  version: 2;
  files: Record<string, FileState>;
  buckets: TokenBuckets;
}

const BUCKET_MS = 10 * 60_000;
/** 週間枠の計算に要る分だけ残す */
const KEEP_MS = 8 * 86400_000;

function bucketOf(ts: unknown): string | null {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? new Date(Math.floor(t / BUCKET_MS) * BUCKET_MS).toISOString() : null;
}

/** 1回に読む上限（初回に大きな記録を読むときも、読み取りを長引かせない） */
const MAX_READ = 64 * 1024 * 1024;

function readFrom(path: string, offset: number): { text: string; end: number } {
  const size = statSync(path).size;
  if (size <= offset) return { text: "", end: size < offset ? 0 : offset };
  const len = Math.min(size - offset, MAX_READ);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }
  // 書きかけの最後の行は次回に回す
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { text: "", end: offset };
  return { text: buf.subarray(0, lastNl + 1).toString("utf8"), end: offset + lastNl + 1 };
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function add(state: UsageState, bucket: string, model: string, u: Record<string, unknown>): void {
  const b = (state.buckets[bucket] ??= {});
  const c = (b[model] ??= { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 });
  c.input += n(u.input_tokens);
  c.output += n(u.output_tokens);
  c.cacheRead += n(u.cache_read_input_tokens);
  const cc = u.cache_creation as Record<string, unknown> | undefined;
  if (cc && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)) {
    c.cache5m += n(cc.ephemeral_5m_input_tokens);
    c.cache1h += n(cc.ephemeral_1h_input_tokens);
  } else {
    c.cache5m += n(u.cache_creation_input_tokens);
  }
}

/** セッションの時間帯ごとのトークン数（直近8日分）。会話記録が見つからなければ null */
export function sessionTokenUsage(
  sessionId: unknown,
  transcriptPath: unknown,
  stateDir: string,
  now = new Date(),
): TokenBuckets | null {
  if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId) || typeof transcriptPath !== "string") return null;
  if (!existsSync(transcriptPath)) return null;
  const statePath = join(stateDir, `${sessionId}.json`);
  let state: UsageState = { version: 2, files: {}, buckets: {} };
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as UsageState;
    // 時間帯に分けていなかった版（v0.4.1）の記録は使わず、最初から読み直す
    if (saved.version === 2) state = saved;
  } catch {
    // 初回
  }
  const subDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents");
  const files = [transcriptPath];
  try {
    for (const f of readdirSync(subDir)) if (f.endsWith(".jsonl")) files.push(join(subDir, f));
  } catch {
    // サブエージェントなし
  }
  for (const f of files) {
    const fs = (state.files[f] ??= { offset: 0, lastId: "" });
    const { text, end } = readFrom(f, fs.offset);
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const m = d.message as Record<string, unknown> | undefined;
      const u = m?.usage as Record<string, unknown> | undefined;
      const id = typeof m?.id === "string" ? m.id : "";
      if (d.type !== "assistant" || !u || !id || id === fs.lastId) continue;
      fs.lastId = id;
      const bucket = bucketOf(d.timestamp);
      if (bucket) add(state, bucket, typeof m?.model === "string" ? m.model : "unknown", u);
    }
    fs.offset = end;
  }
  const oldest = now.getTime() - KEEP_MS;
  for (const k of Object.keys(state.buckets)) if (Date.parse(k) < oldest) delete state.buckets[k];
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // 覚えられなくても、今回の値は送る
  }
  return state.buckets;
}
