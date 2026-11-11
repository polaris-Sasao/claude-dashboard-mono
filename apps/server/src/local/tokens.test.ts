import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateUsd } from "@kanseishitsu/shared";
import { sessionTokenUsage } from "./tokens";

const T1 = "2026-10-06T08:03:00.000Z";
const T2 = "2026-10-06T08:15:00.000Z";
const line = (id: string, model: string, usage: Record<string, unknown>, timestamp = T1) =>
  JSON.stringify({ type: "assistant", timestamp, message: { id, model, usage } }) + "\n";
const NOW = new Date("2026-10-06T09:00:00Z");

describe("sessionTokenUsage", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  test("同じ応答の重複行を1回と数え、サブエージェントも含め、続きだけを読む", () => {
    dir = mkdtempSync(join(tmpdir(), "kanseishitsu-usage-"));
    const sid = `test-${Date.now()}`;
    const main = join(dir, `${sid}.jsonl`);
    const u = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } };
    writeFileSync(main, line("m1", "claude-opus-5-5", u) + line("m1", "claude-opus-5-5", u) + JSON.stringify({ type: "user" }) + "\n");
    mkdirSync(join(dir, sid, "subagents"), { recursive: true });
    writeFileSync(join(dir, sid, "subagents", "agent-a.jsonl"), line("s1", "claude-haiku-4-5", { input_tokens: 5, output_tokens: 50, cache_creation_input_tokens: 40 }));
    const first = sessionTokenUsage(sid, main, join(dir, "state"), NOW)!["2026-10-06T08:00:00.000Z"]!;
    expect(first["claude-opus-5-5"]).toEqual({ input: 10, output: 100, cacheRead: 1000, cache5m: 0, cache1h: 200 });
    expect(first["claude-haiku-4-5"]).toEqual({ input: 5, output: 50, cacheRead: 0, cache5m: 40, cache1h: 0 });
    // 続きを追記：前回の分は数え直さず、別の時間帯に入れる。書きかけの行は次回に回す
    appendFileSync(main, line("m2", "claude-opus-5-5", { input_tokens: 1, output_tokens: 1 }, T2) + '{"type":"assist');
    const second = sessionTokenUsage(sid, main, join(dir, "state"), NOW)!;
    expect(second["2026-10-06T08:00:00.000Z"]!["claude-opus-5-5"]!.output).toBe(100);
    expect(second["2026-10-06T08:10:00.000Z"]!["claude-opus-5-5"]!.output).toBe(1);
    // 8日より前の時間帯は捨てる
    expect(Object.keys(sessionTokenUsage(sid, main, join(dir, "state"), new Date("2026-10-15T00:00:00Z"))!)).toEqual([]);
    // Opus 5.5：10×4 + 100×20 + 1000×0.2 + 200×4×2 = 3840（100万トークンあたり）
    expect(estimateUsd({ "claude-opus-5-5": first["claude-opus-5-5"]! })).toBeCloseTo(0.00384, 8);
  });
});
