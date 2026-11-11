import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation, isHumanPrompt, promptText } from "./conversation";

// 会話記録の 1 行を作る。形は Claude Code 2.1.318〜2.1.321 の会話記録に合わせる
let n = 0;
const T = (sec: number) => new Date(Date.parse("2026-11-11T00:00:00Z") + sec * 1000).toISOString();
const human = (uuid: string, parent: string | null, promptId: string, text: string, sec: number) => ({
  type: "user", uuid, parentUuid: parent, promptId, origin: { kind: "human" }, timestamp: T(sec),
  message: { role: "user", content: [{ type: "text", text }] },
});
const attachment = (uuid: string, parent: string) => ({ type: "attachment", uuid, parentUuid: parent, timestamp: T(0) });
const assistantText = (uuid: string, parent: string, text: string, sec: number, id = `msg_${++n}`) => ({
  type: "assistant", uuid, parentUuid: parent, timestamp: T(sec), message: { id, role: "assistant", content: [{ type: "text", text }] },
});
const toolUse = (uuid: string, parent: string, sec: number) => ({
  type: "assistant", uuid, parentUuid: parent, timestamp: T(sec), message: { id: `msg_${++n}`, content: [{ type: "tool_use", name: "Bash" }] },
});
const toolResult = (uuid: string, parent: string, promptId: string, sec: number) => ({
  type: "user", uuid, parentUuid: parent, promptId, timestamp: T(sec), toolUseResult: {},
  message: { content: [{ type: "tool_result", content: "ok" }] },
});

const conv = (records: unknown[]) => {
  const c = new Conversation("unused");
  for (const r of records) c.add(JSON.stringify(r));
  return c.list();
};

describe("プロンプトと応答の組", () => {
  test("添付の記録が挟まっても、つながりをたどって最後の応答の文章だけを組にする", () => {
    const turns = conv([
      human("u1", null, "p1", "テストを追加して", 0),
      attachment("a1", "u1"),
      attachment("a2", "a1"),
      assistantText("r1", "a2", "まず調べます", 1),
      toolUse("r2", "r1", 2),
      toolResult("t1", "r2", "p1", 3),
      { type: "system", uuid: "s1", parentUuid: "t1", timestamp: T(3) },
      assistantText("r3", "s1", "追加しました", 4),
      human("u2", "r3", "p2", "次", 10),
      assistantText("r4", "u2", "次も終わりました", 11),
    ]);
    expect(turns.map((t) => [t.prompt, t.response?.text])).toEqual([
      ["テストを追加して", "追加しました"],
      ["次", "次も終わりました"],
    ]);
    expect(turns[0]!.response!.at).toBe(T(4));
  });

  test("1 つの応答が区画ごとに分かれた記録は、つなげる", () => {
    const turns = conv([
      human("u1", null, "p1", "説明して", 0),
      assistantText("r1", "u1", "前半", 1, "msg_same"),
      assistantText("r2", "r1", "後半", 1, "msg_same"),
    ]);
    expect(turns[0]!.response!.text).toBe("前半\n後半");
  });

  test("途中で止めたターン・応答のないターン", () => {
    const turns = conv([
      human("u1", null, "p1", "やって", 0),
      toolUse("r1", "u1", 1),
      { type: "user", uuid: "x1", parentUuid: "r1", promptId: "p1", timestamp: T(2), message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } },
      human("u2", "x1", "p2", "やり直して", 5),
    ]);
    expect(turns.map((t) => [t.prompt, t.response, t.interrupted])).toEqual([
      ["やって", null, true],
      ["やり直して", null, false],
    ]);
  });

  test("サブエージェント・自動の知らせ・要約・ツールの結果はプロンプトとして数えない", () => {
    const turns = conv([
      human("u1", null, "p1", "調べて", 0),
      { ...human("sc", "u1", "p1", "サブエージェントへの指示", 1), isSidechain: true },
      { ...human("tn", "u1", "p9", "<task-notification>…</task-notification>", 2), origin: { kind: "task-notification" } },
      { ...human("cs", "u1", "p8", "This session is being continued…", 3), origin: undefined, isCompactSummary: true },
      { ...human("mt", "u1", "p1", "Base directory for this skill", 3), origin: undefined, isMeta: true },
      assistantText("r1", "u1", "調べました", 4),
    ]);
    expect(turns.map((t) => t.prompt)).toEqual(["調べて"]);
    expect(turns[0]!.response!.text).toBe("調べました");
  });
});

describe("プロンプトの本文", () => {
  test("IDE が添えた情報を除き、スラッシュコマンドは「/名前 引数」にし、画像は枚数を出す", () => {
    expect(
      promptText({ content: [{ type: "text", text: "<ide_opened_file>The user opened a.ts</ide_opened_file>" }, { type: "text", text: "直して" }] }),
    ).toBe("直して");
    expect(promptText({ content: "<command-message>kb</command-message>\n<command-name>/kb</command-name>\n<command-args>検索 Docker</command-args>" })).toBe("/kb 検索 Docker");
    expect(promptText({ content: [{ type: "image" }, { type: "text", text: "これを見て" }] })).toBe("これを見て\n［画像 1 枚］");
  });
  test("トークンらしい文字列は伏せ字にする", () => {
    expect(promptText({ content: "token=abcdef123456 を使って" })).toBe("token=＊＊＊ を使って");
  });
  test("origin のない古い版の記録", () => {
    const old = (text: string) => ({ type: "user", message: { content: text } });
    expect(isHumanPrompt(old("登録してください"))).toBe(true);
    expect(isHumanPrompt(old("[Request interrupted by user]"))).toBe(false);
    expect(isHumanPrompt(old("<local-command-stdout>ok</local-command-stdout>"))).toBe(false);
    expect(isHumanPrompt(old("<command-message>kb</command-message><command-name>/kb</command-name>"))).toBe(true);
  });
});

describe("編集とツールの結果（ファイル競合・危険操作のその後）", () => {
  const use = (uuid: string, parent: string, name: string, input: Record<string, unknown>, sec: number) => ({
    type: "assistant", uuid, parentUuid: parent, timestamp: T(sec),
    message: { id: `msg_${++n}`, content: [{ type: "tool_use", id: `tu_${uuid}`, name, input }] },
  });
  const result = (uuid: string, parent: string, toolUseId: string, isError: boolean, content: string) => ({
    type: "user", uuid, parentUuid: parent, promptId: "p1", timestamp: T(0),
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }] },
  });

  test("Edit・Write・NotebookEdit のパスを集め、ほかのツールは数えない", () => {
    const c = new Conversation("unused");
    for (const r of [
      human("u1", null, "p1", "直して", 0),
      use("e1", "u1", "Edit", { file_path: "C:\\x\\a.ts" }, 1),
      use("e2", "e1", "Bash", { command: "ls" }, 2),
      use("e3", "e2", "NotebookEdit", { notebook_path: "C:\\x\\n.ipynb" }, 3),
    ])
      c.add(JSON.stringify(r));
    expect(c.edits).toEqual([
      { path: "C:\\x\\a.ts", at: T(1) },
      { path: "C:\\x\\n.ipynb", at: T(3) },
    ]);
  });

  test("ツールの結果：実行・失敗・却下を見分け、次のプロンプトの有無を答える", () => {
    const c = new Conversation("unused");
    for (const r of [
      human("u1", null, "p1", "やって", 0),
      result("r1", "u1", "ok1", false, "done"),
      result("r2", "r1", "ng1", true, "exit code 1"),
      result("r3", "r2", "rj1", true, "The user doesn't want to proceed with this tool use. The tool use was rejected"),
      human("u2", "r3", "p2", "次", 50),
    ])
      c.add(JSON.stringify(r));
    expect([c.outcome("ok1"), c.outcome("ng1"), c.outcome("rj1"), c.outcome("none")]).toEqual(["executed", "failed", "rejected", undefined]);
    expect(c.promptAfter(T(10))).toBe(true);
    expect(c.promptAfter(T(60))).toBe(false);
  });
});

describe("プレイヤー（サブエージェント・Codex CLI）と ToDo", () => {
  const call = (uuid: string, parent: string, id: string, name: string, input: Record<string, unknown>, sec: number) => ({
    type: "assistant", uuid, parentUuid: parent, timestamp: T(sec),
    message: { id: `msg_${++n}`, content: [{ type: "tool_use", id, name, input }] },
  });
  const done = (uuid: string, parent: string, id: string, sec: number, isError = false) => ({
    type: "user", uuid, parentUuid: parent, promptId: "p1", timestamp: T(sec),
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] },
  });

  test("Agent・Codex を起動から結果まで追い、次のプロンプトまで完了の印で残す", () => {
    const c = new Conversation("unused");
    const add = (r: unknown) => c.add(JSON.stringify(r));
    add(human("u1", null, "p1", "レビューして", 0));
    add(call("a1", "u1", "ag1", "Agent", { subagent_type: "reviewer", description: "差分のレビュー", model: "sonnet" }, 1));
    add(call("a2", "a1", "cx1", "Bash", { command: 'codex exec -m gpt-5.5 "review"' }, 2));
    expect(c.players().map((p) => [p.kind, p.agentType, p.task, p.status])).toEqual([
      ["claude", "reviewer", "差分のレビュー", "run"],
      ["codex", null, 'codex exec -m gpt-5.5 "review"', "run"],
    ]);
    expect(c.players()[1]!.model).toBe("gpt-5.5");
    add(done("r1", "a2", "ag1", 10));
    add(done("r2", "r1", "cx1", 11, true));
    expect(c.players().map((p) => p.status)).toEqual(["done", "err"]);
    add(human("u2", "r2", "p2", "次", 20));
    expect(c.players()).toEqual([]);
  });

  test("バックグラウンドで起動したものは、終了の知らせで終える", () => {
    const c = new Conversation("unused");
    const add = (r: unknown) => c.add(JSON.stringify(r));
    add(human("u1", null, "p1", "裏で査読して", 0));
    add(call("a1", "u1", "cx1", "Bash", { command: 'codex exec "review"', run_in_background: true }, 1));
    add(done("r1", "a1", "cx1", 2));
    expect(c.players()[0]!.status).toBe("run");
    add({
      ...human("tn", "r1", "p9", "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>cx1</tool-use-id>\n<status>completed</status>\n</task-notification>", 30),
      origin: { kind: "task-notification" },
    });
    expect(c.players()[0]).toMatchObject({ status: "done", endedAt: T(30) });
    // 知らせは人のプロンプトとして数えない
    expect(c.list().map((t) => t.prompt)).toEqual(["裏で査読して"]);
  });

  test("直近の TodoWrite を ToDo にする", () => {
    const c = new Conversation("unused");
    c.add(JSON.stringify(human("u1", null, "p1", "直して", 0)));
    c.add(
      JSON.stringify(
        call("a1", "u1", "td1", "TodoWrite", { todos: [{ content: "調査", status: "completed" }, { content: "修正", status: "in_progress" }] }, 1),
      ),
    );
    expect(c.todos?.map((t) => [t.label, t.status])).toEqual([
      ["調査", "done"],
      ["修正", "active"],
    ]);
  });
});

describe("続きだけを読む", () => {
  test("追記された分だけを読み、書きかけの行は次の回に読む", () => {
    const p = join(mkdtempSync(join(tmpdir(), "ks-conv-")), "s.jsonl");
    writeFileSync(p, JSON.stringify(human("u1", null, "p1", "一つめ", 0)) + "\n");
    const c = new Conversation(p);
    c.update();
    expect(c.list().map((t) => t.response)).toEqual([null]);
    const line = JSON.stringify(assistantText("r1", "u1", "応答", 1));
    appendFileSync(p, line.slice(0, 20));
    c.update();
    expect(c.list()[0]!.response).toBeNull();
    appendFileSync(p, line.slice(20) + "\n");
    c.update();
    expect(c.list()[0]!.response!.text).toBe("応答");
    expect(c.size).toBe(1);
    expect(c.list(1)).toHaveLength(1);
  });
});
