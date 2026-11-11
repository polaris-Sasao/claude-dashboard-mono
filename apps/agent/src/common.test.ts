import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteSessionId } from "./common";

describe("remoteSessionId", () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  let dir = "";
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function sessions(files: Record<string, string>) {
    dir = mkdtempSync(join(tmpdir(), "kanseishitsu-cfg-"));
    mkdirSync(join(dir, "sessions"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "sessions", name), body);
    process.env.CLAUDE_CONFIG_DIR = dir;
  }

  test("一致するセッションの bridgeSessionId を返す", () => {
    sessions({
      "100.json": JSON.stringify({ pid: 100, sessionId: "other" }),
      "200.json": JSON.stringify({ pid: 200, sessionId: "s1", bridgeSessionId: "session_01Abc23Def45" }),
      "200.abc.key": "x",
      "300.json": "{壊れた",
    });
    expect(remoteSessionId("s1")).toBe("session_01Abc23Def45");
  });

  test("Remote Control が無効なら null、記録がなければ undefined", () => {
    sessions({ "200.json": JSON.stringify({ pid: 200, sessionId: "s1" }) });
    expect(remoteSessionId("s1")).toBeNull();
    expect(remoteSessionId("s2")).toBeUndefined();
    expect(remoteSessionId(undefined)).toBeUndefined();
  });
});
