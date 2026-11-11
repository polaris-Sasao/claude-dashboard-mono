import { describe, expect, test } from "bun:test";
import { isLocalUrl } from "./common";
import { desiredEntries, mergeSettings } from "./setup";

describe("送り先は同じ PC の中だけ", () => {
  test("localhost・127.0.0.1・[::1] の http だけを使う", () => {
    expect(isLocalUrl("http://localhost:8790")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8790/")).toBe(true);
    expect(isLocalUrl("http://[::1]:8790")).toBe(true);
    expect(isLocalUrl("https://remote-pc.example.ts.net:8443/")).toBe(false);
    expect(isLocalUrl("https://localhost:8790")).toBe(false);
    expect(isLocalUrl("http://localhost.example.com")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});

const BIN = "C:/Users/u/.kanseishitsu/bin/kanseishitsu-agent.exe";

describe("mergeSettings（単独 PC 版）", () => {
  test("登録するのは危険操作のガードと statusLine だけ", () => {
    const want = desiredEntries(BIN);
    expect(Object.keys(want.hooks)).toEqual(["PreToolUse"]);
    expect(want.hooks.PreToolUse![0]!.hooks![0]!.args).toEqual(["guard"]);
    const { next } = mergeSettings({}, BIN);
    expect(Object.keys(next.hooks!)).toEqual(["PreToolUse"]);
    expect(next.statusLine?.command).toBe(`${BIN} statusline`);
  });

  test("前身のイベント送信（hook <イベント>）の登録を外し、ほかのフックとガードは残す", () => {
    const old = (ev: string) => ({ hooks: [{ type: "command", command: BIN, args: ["hook", ev], async: true, timeout: 5 }] });
    const other = { hooks: [{ type: "command", command: "C:/tools/notify.exe" }] };
    const current = {
      hooks: {
        SessionStart: [old("SessionStart")],
        Stop: [old("Stop"), other],
        PreToolUse: [old("PreToolUse"), { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: BIN, args: ["guard"], timeout: 5 }] }],
      },
      statusLine: { type: "command", command: `${BIN} statusline`, padding: 0 },
    };
    const { next, changes } = mergeSettings(current, BIN);
    expect(next.hooks).toEqual({
      Stop: [other],
      PreToolUse: [{ matcher: "Bash|PowerShell", hooks: [{ type: "command", command: BIN, args: ["guard"], timeout: 5 }] }],
    });
    expect(changes.filter((c) => c.includes("前身のイベント送信")).length).toBe(3);
    // 2 回目は変更なし
    expect(mergeSettings(next, BIN).changes).toEqual([]);
  });
});
