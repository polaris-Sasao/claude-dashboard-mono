// 利用枠の送信用の mod（Claude Code のプラグイン）。statusLine が呼ばれない VS Code・Desktop のセッション向け。
// mod の hooks は VS Code の拡張機能でも動き、$.session.usage() で statusLine と同じ利用枠が取れる
// （https://code.claude.com/docs/en/plugins/mods/reference 2026-10-19 確認）。
// setup が ~/.kanseishitsu/plugins にローカルのマーケットプレイスとして置き、settings.json に登録する。
// mod は応答が終わるたびに「エージェント usage <base64 の JSON>」を起動し、送信はエージェントが行う。

export const MARKETPLACE_NAME = "kanseishitsu";
export const PLUGIN_NAME = "kanseishitsu-usage";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** マーケットプレイスのディレクトリに置くファイル（相対パス → 内容）。agentCmd は mod から起動する実行ファイル */
export function modFiles(agentCmd: string, version: string): Record<string, string> {
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  return {
    ".claude-plugin/marketplace.json": json({
      name: MARKETPLACE_NAME,
      owner: { name: "Claude 管制室" },
      plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}`, description: "利用枠を Claude 管制室へ送る" }],
    }),
    [`plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json`]: json({
      name: PLUGIN_NAME,
      version,
      description: "応答が終わるたびに、利用枠とコンテキスト使用率を Claude 管制室のエージェントに渡す",
    }),
    [`plugins/${PLUGIN_NAME}/hooks/hooks.json`]: json({ description: "Claude 管制室：利用枠の送信", modules: ["./register.js"] }),
    [`plugins/${PLUGIN_NAME}/hooks/register.js`]: registerJs(agentCmd),
  };
}

function registerJs(agentCmd: string): string {
  return `// Claude 管制室：利用枠の送信（setup が生成。手で編集しても setup で上書きされます）
// 応答が終わるたびに利用枠を読み、エージェントに渡す。送信の成否は待たない
const AGENT = ${JSON.stringify(agentCmd)}

// UTF-8 の文字列を base64 にする（Windows でも引数の引用符で壊れないように）
function b64(s) {
  let bin = ''
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function register(on) {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // サブエージェントのターンは送らない（利用枠は同じ値のため）
    if (e.agentId) return result
    try {
      const usage = await $.session.usage()
      if (usage?.rateLimits?.length || usage?.context) {
        const body = { session_id: await $.session.id(), cwd: await $.session.cwd(), usage }
        $.process.run([AGENT, 'usage', b64(JSON.stringify(body))]).catch(() => {})
      }
    } catch {
      // 送れなくても Claude Code の動作は妨げない
    }
    return result
  })
}
`;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * mod から受け取った内容を、statusLine と同じ形の送信内容にする（サーバーは /api/ingest/statusline で受ける）。
 * usage() の rateLimits は { kind, percentUsed, resetsAt（ISO 8601） } の一覧、statusLine は
 * rate_limits.<kind>.{ used_percentage, resets_at（Unix 秒） }。費用は statusLine の累計と同じ値か未確認のため送らない
 */
export function modUsagePayload(arg: string): Record<string, unknown> | null {
  let body: Record<string, unknown> | undefined;
  try {
    body = obj(JSON.parse(Buffer.from(arg, "base64").toString("utf8")));
  } catch {
    return null;
  }
  const usage = obj(body?.usage);
  if (!body || !usage || typeof body.session_id !== "string") return null;
  const rate_limits: Record<string, unknown> = {};
  for (const r of Array.isArray(usage.rateLimits) ? usage.rateLimits : []) {
    const o = obj(r);
    const pct = num(o?.percentUsed);
    if (!o || (o.kind !== "five_hour" && o.kind !== "seven_day") || pct === undefined) continue;
    const reset = typeof o.resetsAt === "string" ? Date.parse(o.resetsAt) : NaN;
    rate_limits[o.kind] = { used_percentage: pct, ...(Number.isFinite(reset) ? { resets_at: reset / 1000 } : {}) };
  }
  const ctx = num(obj(usage.context)?.percent);
  return {
    session_id: body.session_id,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
    ...(ctx !== undefined ? { context_window: { used_percentage: ctx } } : {}),
    ...(Object.keys(rate_limits).length ? { rate_limits } : {}),
  };
}
