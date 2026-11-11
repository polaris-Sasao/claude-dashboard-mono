// statusLine：端末に1行を表示し、同じ内容を監視サーバーへ送る
// 項目名は https://code.claude.com/docs/en/statusline（2026-10-06 確認）に基づく

import { modelLabel, redactDeep } from "@kanseishitsu/shared";

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function hhmm(epochSec: number | undefined, withDate: boolean): string {
  if (epochSec === undefined) return "";
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return withDate ? `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function statusText(p: Record<string, unknown>): string {
  const model = obj(p.model);
  const label = modelLabel(String(model?.id ?? "")) ?? String(model?.display_name ?? "?");
  const ctx = num(obj(p.context_window)?.used_percentage);
  const parts = [`[${label}]`, ctx === undefined ? "ctx --" : `ctx ${Math.round(ctx)}%`];
  const rl = obj(p.rate_limits);
  const five = obj(rl?.five_hour);
  const seven = obj(rl?.seven_day);
  if (num(five?.used_percentage) !== undefined)
    parts.push(`5h ${Math.round(num(five?.used_percentage)!)}% (${hhmm(num(five?.resets_at), false)})`);
  if (num(seven?.used_percentage) !== undefined)
    parts.push(`7d ${Math.round(num(seven?.used_percentage)!)}% (${hhmm(num(seven?.resets_at), true)})`);
  return parts.join(" | ");
}

/** 送信する項目だけを抜き出す（transcript_path などは送らない） */
export function statuslinePayload(p: Record<string, unknown>, remote?: string | null): Record<string, unknown> {
  return redactDeep({
    ...(remote !== undefined ? { remote_session_id: remote } : {}),
    session_id: p.session_id,
    cwd: p.cwd,
    session_name: p.session_name,
    version: p.version,
    model: p.model,
    workspace: obj(p.workspace) ? { current_dir: obj(p.workspace)!.current_dir, project_dir: obj(p.workspace)!.project_dir } : undefined,
    context_window: obj(p.context_window)
      ? {
          used_percentage: obj(p.context_window)!.used_percentage,
          context_window_size: obj(p.context_window)!.context_window_size,
        }
      : undefined,
    rate_limits: p.rate_limits,
    cost: p.cost,
  });
}
