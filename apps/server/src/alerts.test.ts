import { describe, expect, test } from "bun:test";
import type { HookIngest } from "@kanseishitsu/shared";
import { dismissAlert, evaluateAlerts, openAlerts, updateDangerOutcomes, type Touch } from "./alerts";
import type { ServerConfig } from "./config";
import { openDb } from "./db";
import { processHook } from "./ingest";
import type { ToolOutcome } from "./local/conversation";
import type { LiveSession } from "./local/sessions";
import { ensureLocalHost } from "./localhost";

const cfg: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  scanIntervalMs: 1500,
  thresholds: { ctxWarnPct: 70, idleAlertSec: 600, conflictWindowSec: 600 },
  retentionDays: 15,
};

const T0 = Date.parse("2026-11-11T05:00:00Z");
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

/** ~/.claude/sessions のファイルから読んだセッション（必要な項目だけ） */
const session = (sessionId: string, rawStatus: string, waitingFor: string | null, updatedSec: number, project = "project-b"): LiveSession => ({
  groupId: "vscode:1",
  kind: "vscode",
  pid: 1,
  sessionId,
  cwd: `C:\\dev\\${project}`,
  project,
  name: null,
  entrypoint: "claude-vscode",
  rawStatus,
  waitingFor,
  status: rawStatus === "busy" ? "run" : "wait",
  statusText: waitingFor === "permission prompt" ? "許可待ち" : waitingFor === "input needed" ? "回答待ち" : "入力待ち",
  startedAt: at(0),
  updatedAt: at(updatedSec),
  bridgeSessionId: "session_0165jEdTReiKHuvRxVCNEZvA",
  version: "2.1.321",
  transcriptPath: null,
  model: null,
});

function setup() {
  const db = openDb(":memory:");
  const host = ensureLocalHost(db, "my-pc");
  const evaluate = (sec: number, live: LiveSession[], touches: Touch[] = []) =>
    evaluateAlerts(db, cfg, { live, touches }, host.host_id, new Date(T0 + sec * 1000));
  return { db, host, evaluate };
}

describe("放置アラート（ファイルの status が waiting）", () => {
  test("許可待ちが10分続いたら出し、待ちが終われば消す", () => {
    const { db, evaluate } = setup();
    const waiting = [session("s1", "waiting", "permission prompt", 0)];
    expect(evaluate(599, waiting)).toEqual({ changed: false, opened: [] });
    expect(evaluate(601, waiting).opened.length).toBe(1);
    const [a] = openAlerts(db, waiting);
    expect(a).toMatchObject({ kind: "idle", hostLabel: "my-pc", project: "project-b", waitText: "許可待ち" });
    expect(a?.remoteUrl).toBe("https://claude.ai/code/session_0165jEdTReiKHuvRxVCNEZvA");
    expect(evaluate(700, [session("s1", "busy", null, 650)])).toEqual({ changed: true, opened: [] });
    expect(openAlerts(db)).toEqual([]);
  });

  test("作業を終えて次の指示を待っているだけ（idle）なら出さない", () => {
    const { db, evaluate } = setup();
    evaluate(3600, [session("s1", "idle", null, 0)]);
    expect(openAlerts(db)).toEqual([]);
  });

  test("閉じたアラートは同じ待ちの間は出し直さず、次の待ちでは出す", () => {
    const { db, evaluate } = setup();
    evaluate(700, [session("s1", "waiting", "permission prompt", 0)]);
    expect(dismissAlert(db, openAlerts(db)[0]!.alertId)).toBe(true);
    evaluate(760, [session("s1", "waiting", "permission prompt", 0)]);
    expect(openAlerts(db)).toEqual([]);
    evaluate(1500, [session("s1", "waiting", "input needed", 800)]);
    expect(openAlerts(db).map((a) => a.waitText)).toEqual(["回答待ち"]);
  });
});

describe("ファイル競合（会話記録の編集）", () => {
  const touch = (sessionId: string, path: string, sec: number, agentId: string | null = null): Touch => ({ sessionId, agentId, path, at: at(sec) });
  const live = [session("s1", "busy", null, 0, "app"), session("s2", "busy", null, 0, "web")];

  test("別のセッションが10分以内に同じファイルを編集したら出し、10分たてば消す。パスの大文字・区切りの違いは同じとみなす", () => {
    const { db, evaluate } = setup();
    evaluate(10, live, [touch("s1", "C:\\dev\\x\\a.ts", 0), touch("s1", "C:\\dev\\x\\a.ts", 5)]);
    expect(openAlerts(db)).toEqual([]);
    const touches = [touch("s1", "C:\\dev\\x\\a.ts", 0), touch("s2", "c:/dev/x/A.ts", 20)];
    evaluate(30, live, touches);
    const [a] = openAlerts(db);
    expect(a).toMatchObject({ kind: "conflict", path: "C:\\dev\\x\\a.ts", project: "web", sessionId: "s2" });
    expect(a?.actors).toEqual(["app（メイン）", "web（メイン）"]);
    evaluate(601, live, touches);
    expect(openAlerts(db)).toEqual([]);
  });

  test("メインとサブエージェントでも出す", () => {
    const { db, evaluate } = setup();
    evaluate(30, live, [touch("s1", "/repo/a.ts", 0), touch("s1", "/repo/a.ts", 10, "a1")]);
    expect(openAlerts(db)[0]?.actors).toEqual(["app（メイン）", "app（サブエージェント）"]);
  });
});

describe("危険操作", () => {
  const hit = (toolUseId: string): HookIngest => ({
    event: "GuardHit",
    host: { hostname: "PC", os: "Windows 11" },
    payload: {
      session_id: "s1",
      cwd: "C:\\dev\\project-b",
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: { command: "git push --force origin main" },
      guard: { id: "git-push-force", label: "git push の強制上書き（--force）", mode: "ask" },
    },
    sentAt: "",
  });
  const lookup =
    (outcome: ToolOutcome | undefined, promptAfter = false) =>
    () => ({ outcome, promptAfter: () => promptAfter });

  test("GuardHit でアラートを出し、会話記録で実行されたら記録する。放置・競合の評価では消えない", () => {
    const { db, host, evaluate } = setup();
    processHook(db, host, hit("t1"), new Date(T0));
    expect(evaluate(1, []).opened.length).toBe(1);
    expect(openAlerts(db)[0]).toMatchObject({
      kind: "danger",
      project: "project-b",
      guardLabel: "git push の強制上書き（--force）",
      command: "git push --force origin main",
      guardMode: "ask",
      outcome: "pending",
    });
    expect(updateDangerOutcomes(db, lookup(undefined))).toBe(false);
    expect(updateDangerOutcomes(db, lookup("executed"))).toBe(true);
    expect(openAlerts(db)[0]?.outcome).toBe("executed");
    evaluate(2, []);
    expect(openAlerts(db).length).toBe(1);
  });

  test("却下された・結果のないまま次のプロンプトに進んだら「実行されず」、失敗は「失敗」", () => {
    for (const [o, after, want] of [
      ["rejected", false, "not_executed"],
      [undefined, true, "not_executed"],
      ["failed", false, "failed"],
    ] as const) {
      const { db, host } = setup();
      processHook(db, host, hit("t2"), new Date(T0));
      updateDangerOutcomes(db, lookup(o, after));
      expect(openAlerts(db)[0]?.outcome).toBe(want);
    }
  });
});
