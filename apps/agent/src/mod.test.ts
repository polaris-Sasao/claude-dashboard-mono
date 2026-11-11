import { describe, expect, test } from "bun:test";
import { modFiles, modUsagePayload, PLUGIN_ID } from "./mod";
import { mergeSettings } from "./setup";

const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const LAUNCH = "/Users/u/.kanseishitsu/bin/kanseishitsu-launch";
const DIR = "/Users/u/.kanseishitsu/plugins";

describe("modUsagePayload", () => {
  test("usage() の利用枠を statusLine と同じ形にする", () => {
    const arg = enc({
      session_id: "s1",
      cwd: "G:\\小説",
      usage: {
        context: { tokens: 24378, window: 1000000, percent: 2 },
        rateLimits: [
          { kind: "five_hour", percentUsed: 12, resetsAt: "2026-10-19T08:40:00.000Z" },
          { kind: "seven_day", percentUsed: 7, resetsAt: "2026-10-25T17:00:00.000Z" },
          { kind: "spend_limit", percentUsed: 50 },
        ],
        cost: { usd: 0.5 },
      },
    });
    expect(modUsagePayload(arg)).toEqual({
      session_id: "s1",
      cwd: "G:\\小説",
      context_window: { used_percentage: 2 },
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: Date.parse("2026-10-19T08:40:00.000Z") / 1000 },
        seven_day: { used_percentage: 7, resets_at: Date.parse("2026-10-25T17:00:00.000Z") / 1000 },
      },
    });
  });

  test("利用枠がなければ rate_limits を付けない。壊れた引数は捨てる", () => {
    expect(modUsagePayload(enc({ session_id: "s1", usage: { rateLimits: [] } }))).toEqual({ session_id: "s1", cwd: undefined });
    expect(modUsagePayload("@@@")).toBeNull();
    expect(modUsagePayload(enc({ usage: {} }))).toBeNull();
  });
});

describe("mod のファイル", () => {
  test("register.js に起動する実行ファイルを埋め込む", () => {
    const files = modFiles("C:/Users/a b/.kanseishitsu/bin/kanseishitsu-agent.exe", "0.5.0");
    const js = files["plugins/kanseishitsu-usage/hooks/register.js"]!;
    expect(js).toContain('const AGENT = "C:/Users/a b/.kanseishitsu/bin/kanseishitsu-agent.exe"');
    expect(JSON.parse(files[".claude-plugin/marketplace.json"]!).plugins[0].source).toBe("./plugins/kanseishitsu-usage");
  });
});

describe("mergeSettings：利用枠の mod", () => {
  test("マーケットプレイスを登録して mod を有効にする。2回目は変更なし", () => {
    const { next, changes } = mergeSettings({ enabledPlugins: { "other@x": true } }, LAUNCH, [], DIR);
    expect(next.extraKnownMarketplaces).toEqual({ kanseishitsu: { source: { source: "directory", path: DIR } } });
    expect(next.enabledPlugins).toEqual({ "other@x": true, [PLUGIN_ID]: true });
    expect(changes.filter((c) => /extraKnownMarketplaces|enabledPlugins/.test(c)).length).toBe(2);
    expect(mergeSettings(next, LAUNCH, [], DIR).changes).toEqual([]);
  });

  test("無効にされた mod は有効に戻さない", () => {
    const { next, warnings } = mergeSettings({ enabledPlugins: { [PLUGIN_ID]: false } }, LAUNCH, [], DIR);
    expect(next.enabledPlugins![PLUGIN_ID]).toBe(false);
    expect(warnings.some((w) => w.includes(PLUGIN_ID))).toBe(true);
  });
});
