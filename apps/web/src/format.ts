import type { SessionStatus } from "@kanseishitsu/shared";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  run: "稼働中",
  wait: "入力待ち",
  err: "異常",
  ended: "終了",
};

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「2秒前」「12分前」「3時間前」 */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return "未受信";
  const sec = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}時間前`;
  return `${Math.floor(h / 24)}日前`;
}
