// Claude 管制室 エージェント（単独 PC 版）。同じ PC の監視サーバー（既定 http://localhost:8790）へ送る
//   セッションの一覧・会話・ファイル競合・放置は、監視サーバーが ~/.claude のファイルを直接読むため、hooks のイベントは送らない
//   kanseishitsu-agent statusline          statusLine から呼ばれる
//   kanseishitsu-agent usage <base64>      利用枠の mod（VS Code・Desktop 向け）から呼ばれる
//   kanseishitsu-agent guard               PreToolUse（同期）から呼ばれる危険操作の判定
//   kanseishitsu-agent setup [--apply]     設定と Claude Code への登録

import { guardCheck, redactDeep, type HookIngest, type StatuslineIngest } from "@kanseishitsu/shared";
import { hostInfo, loadConfig, log, post, readStdinJson, remoteSessionId, truncateDeep } from "./common";
import { setup } from "./setup";
import { modUsagePayload } from "./mod";
import { statuslinePayload, statusText } from "./statusline";

/**
 * PreToolUse（同期）から呼ばれる危険操作の判定。判定は手元で行い、当たらなければ何も出さずにすぐ終わる。
 * 当たれば許可ダイアログに回す JSON を先に出し、そのあとで監視サーバーに知らせる
 */
async function runGuard(): Promise<void> {
  const payload = await readStdinJson();
  const cfg = loadConfig();
  const mode = cfg.guardMode ?? "ask";
  if (mode === "off") return;
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const hit = guardCheck(typeof payload.tool_name === "string" ? payload.tool_name : undefined, input);
  if (!hit) return;
  if (mode === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `Claude 管制室：${hit.label}に当たるため、実行してよいか確認してください`,
        },
      }) + "\n",
    );
  }
  const body: HookIngest = {
    event: "GuardHit",
    host: hostInfo(cfg),
    payload: redactDeep(
      truncateDeep({
        session_id: payload.session_id,
        cwd: payload.cwd,
        tool_name: payload.tool_name,
        tool_use_id: payload.tool_use_id,
        tool_input: { command: input?.command },
        agent_id: payload.agent_id,
        guard: { ...hit, mode },
      }),
    ),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/hook", body);
}

async function runStatusline(): Promise<void> {
  const payload = await readStdinJson();
  // 表示を先に出す。新しい更新が来ると実行中のスクリプトは中断されるため、送信は後回しにする
  try {
    process.stdout.write(statusText(payload) + "\n");
  } catch {
    // 表示に失敗しても送信は続ける
  }
  const cfg = loadConfig();
  const body: StatuslineIngest = {
    host: hostInfo(cfg),
    payload: statuslinePayload(payload, remoteSessionId(payload.session_id)),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/statusline", body);
}

/** mod が $.session.usage() で読んだ利用枠を、statusLine と同じ受け口へ送る */
async function runUsage(arg: string): Promise<void> {
  const cfg = loadConfig();
  const p = modUsagePayload(arg);
  if (!p) return;
  const remote = remoteSessionId(p.session_id);
  const body: StatuslineIngest = {
    host: hostInfo(cfg),
    payload: redactDeep(remote !== undefined ? { remote_session_id: remote, ...p } : p),
    sentAt: new Date().toISOString(),
  };
  await post(cfg, "/api/ingest/statusline", body);
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "statusline") await runStatusline();
  else if (cmd === "usage") await runUsage(arg ?? "");
  else if (cmd === "guard") await runGuard();
  else if (cmd === "setup") await setup(process.argv.slice(3));
  // 前身の登録（hook <イベント>）が残っていても、何もせずに終わる
  else if (cmd !== "hook") console.log("usage: kanseishitsu-agent statusline | usage <base64> | guard | setup [--apply]");
} catch (e) {
  // hooks・statusLine から呼ばれたときは決して失敗させない
  log(`${cmd} error: ${e instanceof Error ? e.stack : String(e)}`);
  if (cmd === "setup") {
    console.error(e);
    process.exit(1);
  }
}
process.exit(0);
