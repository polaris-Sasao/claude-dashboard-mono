// 利用枠の行（5時間枠・週間枠）

import { useRef } from "react";
import { usageAccountKey, type RateWindow, type UsageBreakdown, type UsageForecast, type UsageView } from "@kanseishitsu/shared";
import { ago } from "./format";

const pad = (n: number) => String(n).padStart(2, "0");
const resetText = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const untilText = (iso: string | null, now: Date) => {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60000));
  return `あと ${Math.floor(min / 60)}:${pad(min % 60)}`;
};

/**
 * 利用枠はアカウント単位の値。同じアカウントの PC からは週間枠のリセット時刻が同じ値が届くため、それを1行にまとめて最新の値を出す。
 * 24 時間以内に届いた値だけを出す（別のアカウントの PC があれば行が分かれる）
 */
function distinct(usage: UsageView[], now: Date): UsageView[] {
  const out: UsageView[] = [];
  for (const u of usage) {
    if (now.getTime() - Date.parse(u.takenAt) > 24 * 3600_000) continue;
    // usage は新しい順に並んでいるので、先に入ったものが最新
    const same = out.find((o) => usageAccountKey(o) === usageAccountKey(u));
    if (!same) out.push(u);
  }
  return out;
}

export function UsageRow({ usage, now }: { usage: UsageView[]; now: Date }) {
  const rows = distinct(usage, now);
  if (rows.length === 0) {
    return (
      <section className="usage panel" aria-label="利用枠">
        <p className="detail-none">
          利用枠の値はまだ届いていません（ターミナルの Claude Code の statusLine から届きます）
        </p>
      </section>
    );
  }
  return (
    <section className="usage panel" aria-label="利用枠">
      {rows.map((u) => (
        <div key={u.hostId} className="usage-account">
          <Window label="5時間枠" w={u.fiveHour} now={now} short forecast={u.fiveHourForecast} />
          <Window label="週間枠" w={u.sevenDay} now={now} forecast={u.sevenDayForecast} />
          {u.fiveHourBreakdown && u.fiveHourBreakdown.items.length > 0 && <Breakdown b={u.fiveHourBreakdown} />}
          <div className="usage-src">
            {u.hostLabel} から取得 ・ {ago(u.takenAt, now)}
          </div>
        </div>
      ))}
    </section>
  );
}

/** 上限予測の1行（目安）。リセットより前に届く見込みのときだけ目立たせる */
function ForecastLine({ f, w, now }: { f: UsageForecast | null | undefined; w: RateWindow | null; now: Date }) {
  if (!f || !w?.resetsAt || Date.parse(w.resetsAt) < now.getTime()) return null;
  const basis = `直近${f.basisMin >= 60 ? `${Math.round(f.basisMin / 60)}時間` : `${f.basisMin}分`}のペース`;
  if (!f.hitAt || !f.beforeReset) {
    return <span className="forecast">{basis}ではリセットまでに上限に届かない見込み</span>;
  }
  return (
    <span className="forecast forecast-warn">
      {basis}（+{f.perHour}%/時）だと <span className="mono">{resetText(f.hitAt)}</span> ごろ上限に届く見込み
    </span>
  );
}

// 内訳の色：検証済みの3色（青・橙・青緑）。4件目からは「その他」にまとめる
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const TOP = SERIES.length;

/** 色はセッションに固定する（順位が入れ替わっても色が変わらないように、空いた色を使い回す） */
function useStableSlots(ids: string[]): Map<string, number> {
  const ref = useRef(new Map<string, number>());
  const map = ref.current;
  for (const k of [...map.keys()]) if (!ids.includes(k)) map.delete(k);
  for (const id of ids) {
    if (map.has(id)) continue;
    const used = new Set(map.values());
    const free = [...Array(TOP).keys()].find((i) => !used.has(i));
    if (free !== undefined) map.set(id, free);
  }
  return map;
}

/** 今の5時間枠で、Claude Code のどのセッションが多く使っているか（費用の推定から） */
function Breakdown({ b }: { b: UsageBreakdown }) {
  const top = b.items.slice(0, TOP);
  const rest = b.items.slice(TOP);
  const restPct = Math.round(rest.reduce((a, i) => a + i.pct, 0) * 10) / 10;
  const slots = useStableSlots(top.map((i) => i.sessionId));
  const segs = [
    ...top.map((i) => ({
      key: i.sessionId,
      label: i.project,
      sub: i.hostLabel,
      pct: i.pct,
      usd: i.usd,
      estimated: i.estimated,
      color: SERIES[slots.get(i.sessionId) ?? 0]!,
    })),
    ...(rest.length > 0
      ? [{ key: "other", label: `その他 ${rest.length}件`, sub: "", pct: restPct, usd: Math.round(rest.reduce((a, i) => a + i.usd, 0) * 100) / 100, estimated: rest.some((i) => i.estimated), color: "var(--series-other)" }]
      : []),
  ];
  return (
    <div className="breakdown">
      <span className="breakdown-title">5時間枠の内訳（Claude Code の推定費用 ${b.totalUsd.toFixed(2)} 中）</span>
      <span className="breakdown-bar" role="img" aria-label={segs.map((s) => `${s.label} ${s.pct}%`).join("、")}>
        {segs.map((s) => (
          <span
            key={s.key}
            className="breakdown-seg"
            style={{ flexGrow: Math.max(s.pct, 0.5), background: s.color }}
            title={`${s.label}${s.sub ? `（${s.sub}）` : ""} ・ ${s.pct}% ・ 約 $${s.usd.toFixed(2)}`}
          />
        ))}
      </span>
      <span className="breakdown-legend">
        {segs.map((s) => (
          <span key={s.key} className="breakdown-item" title={`約 $${s.usd.toFixed(2)}`}>
            <span className="breakdown-swatch" style={{ background: s.color }} />
            <span className="mono">{s.label}</span>
            {s.sub && <span className="breakdown-sub">{s.sub}</span>}
            <span className="breakdown-pct mono">{s.pct}%</span>
            {s.estimated && <span className="breakdown-est">見積もり</span>}
          </span>
        ))}
      </span>
      {b.items.some((i) => i.estimated) && (
        <span className="breakdown-note">
          「見積もり」は VS Code・Desktop のセッションで、会話記録のトークン数から計算しています（裏側の呼び出しを含まないため、少なめに出ます）
        </span>
      )}
    </div>
  );
}

function Window({
  label,
  w,
  now,
  short,
  forecast,
}: {
  label: string;
  w: RateWindow | null;
  now: Date;
  short?: boolean;
  forecast?: UsageForecast | null;
}) {
  // 値がない、またはリセット時刻を過ぎたときは、新しい枠がまだ始まっていない（使っていないので残り 100%）。
  // statusLine は新しい枠が始まるまで、その枠の値を送ってこない
  const expired = !w || (w.resetsAt !== null && Date.parse(w.resetsAt) < now.getTime());
  const used = expired ? 0 : Math.max(0, Math.min(100, w.usedPct));
  return (
    <div className="window">
      <span className="window-label">{label}</span>
      <span className="window-track" role="img" aria-label={`${label} 使用率 ${Math.round(used)}%`}>
        <span className="window-bar" style={{ width: `${used}%` }} />
      </span>
      <span className="window-remain">
        残り <span className="mono window-pct">{`${Math.round(100 - used)}%`}</span>
      </span>
      <span className="window-reset">
        {expired ? (
          <>新しい枠はまだ始まっていません</>
        ) : short && w?.resetsAt ? (
          <>
            <span className="only-mobile">{untilText(w.resetsAt, now)}</span>
            <span className="only-desktop">
              次のリセット <span className="mono">{resetText(w.resetsAt)}</span>
            </span>
          </>
        ) : (
          <>
            次のリセット <span className="mono">{resetText(w?.resetsAt ?? null)}</span>
          </>
        )}
      </span>
      <ForecastLine f={forecast} w={w} now={now} />
    </div>
  );
}
