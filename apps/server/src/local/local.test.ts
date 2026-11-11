import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalRequest } from "../localhost";
import { buildGroups } from "../state";
import { classify, groupLabel } from "./groups";
import { ancestors, type ProcInfo, type ProcTable } from "./processes";
import { readLiveSessions, statusOf } from "./sessions";

const table = (rows: [number, number, string][]): ProcTable =>
  new Map(rows.map(([pid, ppid, name]) => [pid, { pid, ppid, name } satisfies ProcInfo]));

// 2026-11-10 に Windows 11 で確かめた親子関係を写したもの
const PROCS = table([
  [13424, 36516, "Code.exe"], // VS Code 本体
  [10584, 13424, "Code.exe"], // 窓 1 の拡張機能用
  [13680, 13424, "Code.exe"], // 窓 2 の拡張機能用
  [36596, 13424, "Code.exe"], // ターミナル用（窓をまたいで共有）
  [14444, 10584, "claude.exe"], // 窓 1 の拡張
  [37912, 10584, "claude.exe"], // 窓 1 の 2 つめのタブ
  [32032, 13680, "claude.exe"], // 窓 2 の拡張
  [18588, 36596, "powershell.exe"],
  [21240, 18588, "claude.exe"], // 窓 1 のターミナル
  [14000, 36596, "powershell.exe"],
  [20836, 14000, "claude.exe"], // 窓 2 のターミナル
  [9604, 2708, "WindowsTerminal.exe"],
  [34356, 9604, "cmd.exe"],
  [20844, 34356, "claude.exe"],
  [26232, 9604, "powershell.exe"],
  [38476, 26232, "claude.exe"],
  [12636, 18416, "claude.exe"], // Claude Desktop の本体
  [17204, 12636, "claude.exe"], // Desktop の Code
]);

const group = (ep: string, pid: number) => classify(ep, ancestors(PROCS, pid)).groupId;

describe("まとまりの判定", () => {
  test("VS Code の拡張は窓ごと。同じ窓のタブは同じまとまり", () => {
    expect(group("claude-vscode", 14444)).toBe("vscode:10584");
    expect(group("claude-vscode", 37912)).toBe("vscode:10584");
    expect(group("claude-vscode", 32032)).toBe("vscode:13680");
  });
  test("VS Code の中のターミナルは、窓によらず 1 つにまとめる", () => {
    expect(group("cli", 21240)).toBe("vscode-terminal");
    expect(group("cli", 20836)).toBe("vscode-terminal");
  });
  test("Windows Terminal は窓・タブによらず 1 つにまとめる", () => {
    expect(group("cli", 20844)).toBe("windows-terminal");
    expect(group("cli", 38476)).toBe("windows-terminal");
  });
  test("Claude Desktop は 1 つにまとめる", () => {
    expect(group("claude-desktop", 17204)).toBe("desktop");
  });
  test("どれにも当たらなければ entrypoint ごと", () => {
    expect(classify("sdk-ts", []).groupId).toBe("other:sdk-ts");
    expect(classify(null, []).groupId).toBe("other:unknown");
    expect(classify("cli", ancestors(table([[1, 0, "claude.exe"]]), 1)).kind).toBe("other");
  });
  test("見出し", () => {
    expect(groupLabel("vscode", "vscode:1", ["a", "b", "a"])).toEqual({ label: "VS Code", sub: "a ・ b" });
    expect(groupLabel("other", "other:sdk-ts", []).sub).toBe("sdk-ts");
  });
});

describe("状態の判定", () => {
  test("ファイルの status・waitingFor から決める", () => {
    expect(statusOf("busy", null)).toEqual({ status: "run", statusText: "作業中" });
    expect(statusOf("idle", null)).toEqual({ status: "wait", statusText: "入力待ち" });
    expect(statusOf("waiting", "permission prompt").statusText).toBe("許可待ち");
    expect(statusOf("waiting", "input needed").statusText).toBe("回答待ち");
    expect(statusOf("waiting", "something new").statusText).toBe("待ち ・ something new");
    expect(statusOf("sleeping", null).statusText).toBe("状態不明 ・ sleeping");
  });
});

describe("localhost からのリクエストか", () => {
  test("Host が localhost でなければ断る（DNS リバインディング）", () => {
    expect(isLocalRequest("localhost:8790", null, 8790)).toBe(true);
    expect(isLocalRequest("127.0.0.1:8790", null, 8790)).toBe(true);
    expect(isLocalRequest("[::1]:8790", null, 8790)).toBe(true);
    expect(isLocalRequest("evil.example:8790", null, 8790)).toBe(false);
    expect(isLocalRequest("localhost:9999", null, 8790)).toBe(false);
    expect(isLocalRequest(undefined, null, 8790)).toBe(false);
  });
  test("Origin が付いていれば、localhost のものだけ通す", () => {
    expect(isLocalRequest("localhost:8790", "http://localhost:8790", 8790)).toBe(true);
    expect(isLocalRequest("localhost:8790", "http://127.0.0.1:8790", 8790)).toBe(true);
    expect(isLocalRequest("localhost:8790", "https://evil.example", 8790)).toBe(false);
    expect(isLocalRequest("localhost:8790", "http://localhost:5179", 8790)).toBe(false);
    expect(isLocalRequest("localhost:8790", "null", 8790)).toBe(false);
  });
});

describe("セッションのファイルを読む", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "ks-claude-"));
    mkdirSync(join(root, "sessions"));
    mkdirSync(join(root, "projects", "c---dev-app"), { recursive: true });
    const write = (pid: number, data: Record<string, unknown>) =>
      writeFileSync(join(root, "sessions", `${pid}.json`), JSON.stringify({ pid, ...data }));
    return { root, write };
  }

  test("生きている Claude Code のセッションだけを、まとまりに分けて読む", () => {
    const { root, write } = setup();
    write(14444, { sessionId: "a", cwd: "c:\\dev\\app", entrypoint: "claude-vscode", status: "busy", name: "app-1", startedAt: 1000 });
    write(32032, { sessionId: "b", cwd: "c:\\dev\\web\\", entrypoint: "claude-vscode", status: "waiting", waitingFor: "permission prompt", startedAt: 2000 });
    write(17204, { sessionId: "c", cwd: "C:\\dev", entrypoint: "claude-desktop", status: "idle", bridgeSessionId: "session_0165jEdTReiKHuvRxVCNEZvA", startedAt: 3000 });
    write(99999, { sessionId: "dead", entrypoint: "cli", status: "idle" }); // プロセスがない
    write(9604, { sessionId: "notclaude", entrypoint: "cli", status: "idle" }); // pid が Claude Code ではない
    writeFileSync(join(root, "sessions", "1.json"), "{ 書き込み途中");
    writeFileSync(
      join(root, "projects", "c---dev-app", "a.jsonl"),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } }) + "\n",
    );

    const live = readLiveSessions(PROCS, root);
    expect(live.map((s) => s.sessionId).sort()).toEqual(["a", "b", "c"]);
    const a = live.find((s) => s.sessionId === "a")!;
    expect(a).toMatchObject({ groupId: "vscode:10584", project: "app", name: "app-1", status: "run", model: "claude-opus-5-5" });
    expect(live.find((s) => s.sessionId === "b")).toMatchObject({ groupId: "vscode:13680", project: "web", statusText: "許可待ち" });

    const groups = buildGroups(live);
    expect(groups.map((g) => [g.groupId, g.label, g.sub])).toEqual([
      ["vscode:10584", "VS Code", "app"],
      ["vscode:13680", "VS Code", "web"],
      ["desktop", "Claude Desktop", ""],
    ]);
    expect(groups[2]!.sessions[0]!.remoteUrl).toBe("https://claude.ai/code/session_0165jEdTReiKHuvRxVCNEZvA");
    expect(groups[0]!.sessions[0]!.model).toBe("Opus 5.5");
  });

  test("sessions フォルダがなければ空", () => {
    expect(readLiveSessions(PROCS, join(tmpdir(), "ks-none-" + Date.now()))).toEqual([]);
  });
});
