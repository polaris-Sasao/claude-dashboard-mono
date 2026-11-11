// サーバーとエージェントで使う（node:fs を使うため index.ts からは出さない）
// 会話記録（transcript_path の JSONL）の末尾から、直近の応答のモデル ID を読み取る。
// VS Code 拡張やデスクトップアプリでは statusLine が動かず、SessionStart にも model が入らないことがあるための補完。
// 大きなファイルを読み込んだツール結果が末尾に続くと応答の行が遠くなるため、末尾から少しずつ遡って探す。

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const CHUNK_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const NEWLINE = 0x0a;
/** これより長い1行は応答の行ではない（巨大なツール結果）とみなして読み飛ばす */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function modelFromLine(line: Buffer, allowSidechain: boolean): string | undefined {
  // JSON として読む前に安く絞り込む
  if (line.indexOf('"assistant"') < 0) return undefined;
  try {
    const d = JSON.parse(line.toString("utf8"));
    if (d?.type !== "assistant" || (d.isSidechain && !allowSidechain)) return undefined;
    const model = d.message?.model;
    return typeof model === "string" && model && !model.startsWith("<") ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param allowSidechain サブエージェント自身の会話記録（subagents/agent-*.jsonl）を読むときは true
 */
export function modelFromTranscript(path: string, maxScanBytes = MAX_SCAN_BYTES, allowSidechain = false): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let pos = fstatSync(fd).size;
    const limit = Math.max(0, pos - maxScanBytes);
    // 前回のチャンクの先頭にあった、まだ行頭が見つかっていない断片
    let carry: Buffer = Buffer.alloc(0);
    while (pos > limit) {
      const len = Math.min(CHUNK_BYTES, pos - limit);
      pos -= len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, pos);
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // 末尾側から1行ずつ取り出す。先頭の断片は次のチャンクと結合する
      let end = buf.length;
      let nl = buf.lastIndexOf(NEWLINE, end - 1);
      while (nl >= 0) {
        const m = modelFromLine(buf.subarray(nl + 1, end), allowSidechain);
        if (m) return m;
        end = nl;
        nl = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
      }
      carry = end > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(buf.subarray(0, end));
      if (pos === 0) return carry.length ? modelFromLine(carry, allowSidechain) : undefined;
    }
  } catch {
    // ファイルがない・読めない場合は何もしない
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}
