import { describe, expect, test } from "bun:test";
import type { HookIngest } from "@kanseishitsu/shared";
import { openAlerts } from "./alerts";
import { openDb } from "./db";
import { processHook, processStatusline, recordLiveSessions, sessionExtras } from "./ingest";
import type { LiveSession } from "./local/sessions";
import { ensureLocalHost } from "./localhost";

const NOW = new Date("2026-11-11T05:00:00Z");
const hostInfo = { hostname: "PC", os: "Windows 11", agentVersion: "0.5.0" };

describe("エージェントからの知らせ", () => {
  test("hooks のイベントは GuardHit だけを受け、前身のイベント送信は捨てる", () => {
    const db = openDb(":memory:");
    const host = ensureLocalHost(db, "my-pc");
    const send = (event: string, payload: Record<string, unknown>) =>
      processHook(db, host, { event, host: hostInfo, payload: { session_id: "s1", ...payload }, sentAt: "" } satisfies HookIngest, NOW);
    send("UserPromptSubmit", { prompt: "x" });
    send("Stop", {});
    expect(openAlerts(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    send("GuardHit", { tool_use_id: "t1", tool_input: { command: "rm -rf /" }, guard: { id: "rm", label: "削除", mode: "ask" } });
    expect(openAlerts(db).map((a) => a.kind)).toEqual(["danger"]);
  });

  test("statusLine のコンテキスト使用率とモデルを、セッションごとに覚える", () => {
    const db = openDb(":memory:");
    const host = ensureLocalHost(db, "my-pc");
    processStatusline(
      db,
      host,
      {
        host: hostInfo,
        payload: { session_id: "s1", cwd: "C:\\dev\\app", model: { id: "claude-opus-5-5" }, context_window: { used_percentage: 42 } },
        sentAt: "",
      },
      NOW,
    );
    expect(sessionExtras(db, ["s1", "none"])).toEqual(new Map([["s1", { ctxPct: 42, model: "Opus 5.5" }]]));
  });
});

describe("起動中のセッションの記録（消費内訳のプロジェクト名）", () => {
  test("statusLine が届かないセッションも、プロジェクト名と開始時刻を記録する", () => {
    const db = openDb(":memory:");
    const host = ensureLocalHost(db, "my-pc");
    const s = { sessionId: "s1", cwd: "C:\\dev\\web", project: "web", startedAt: "2026-11-11T04:00:00.000Z", updatedAt: "2026-11-11T04:30:00.000Z" };
    recordLiveSessions(db, host.host_id, [s as LiveSession]);
    recordLiveSessions(db, host.host_id, [{ ...s, updatedAt: "2026-11-11T04:40:00.000Z" } as LiveSession]);
    expect(db.query("SELECT project, started_at, last_event_at FROM sessions").all()).toEqual([
      { project: "web", started_at: "2026-11-11T04:00:00.000Z", last_event_at: "2026-11-11T04:40:00.000Z" },
    ]);
  });
});
