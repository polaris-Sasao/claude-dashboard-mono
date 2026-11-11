import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelFromTranscript } from "./transcript";

const write = (lines: unknown[], trailingNewline = true) => {
  const p = join(mkdtempSync(join(tmpdir(), "ks-")), "t.jsonl");
  writeFileSync(
    p,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (trailingNewline ? "\n" : ""),
  );
  return p;
};

describe("modelFromTranscript", () => {
  test("直近のメイン応答のモデルを返す", () => {
    const p = write([
      { type: "assistant", message: { model: "claude-sonnet-5-5" } },
      { type: "user", message: { content: "x" } },
      { type: "assistant", message: { model: "claude-opus-5-5" } },
      { type: "assistant", isSidechain: true, message: { model: "claude-haiku-4-5-20251001" } },
      { type: "assistant", message: { model: "<synthetic>" } },
      "{壊れた行",
      { type: "system" },
    ]);
    expect(modelFromTranscript(p)).toBe("claude-opus-5-5");
  });

  test("末尾に巨大なツール結果が続いても遡って見つける", () => {
    const big = "原稿".repeat(400_000); // 1行あたり約 2.4MB（チャンクをまたぐ）
    const p = write([
      { type: "assistant", message: { model: "claude-fable-5-1" } },
      { type: "user", message: { content: [{ type: "tool_result", content: big }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: big }] } },
    ]);
    expect(modelFromTranscript(p)).toBe("claude-fable-5-1");
  });

  test("ファイル先頭の行（改行なしで終わる1行だけ）も読む", () => {
    const p = write([{ type: "assistant", message: { model: "claude-opus-5-5" } }], false);
    expect(modelFromTranscript(p)).toBe("claude-opus-5-5");
  });

  test("探す範囲を超えた先にしかなければ undefined", () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const p = write([
      { type: "assistant", message: { model: "claude-opus-5-5" } },
      { type: "user", message: { content: big } },
    ]);
    expect(modelFromTranscript(p, 2 * 1024 * 1024)).toBeUndefined();
  });

  test("ファイルがなければ undefined", () => {
    expect(modelFromTranscript("/no/such/file.jsonl")).toBeUndefined();
  });
});

describe("サブエージェントの会話記録", () => {
  test("allowSidechain で isSidechain の行も読む", () => {
    const p = write([{ type: "assistant", isSidechain: true, message: { model: "claude-sonnet-5-5" } }]);
    expect(modelFromTranscript(p)).toBeUndefined();
    expect(modelFromTranscript(p, undefined, true)).toBe("claude-sonnet-5-5");
  });
});
