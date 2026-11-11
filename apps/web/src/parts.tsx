// 画面のあちこちで使う小さな部品

import { modelFamily, type PlayerView } from "@kanseishitsu/shared";

export function ModelChip({ model }: { model: string | null }) {
  if (!model) return null;
  return <span className={`model model-${modelFamily(model)}`}>{model}</span>;
}

/** コンテキスト使用率のゲージ。しきい値以上で黄色と「圧縮間近」 */
export function CtxGauge({ pct, warnPct, large }: { pct: number | null; warnPct: number; large?: boolean }) {
  if (pct === null) return null;
  const high = pct >= warnPct;
  const v = Math.max(0, Math.min(100, pct));
  return (
    <span className={`ctx${large ? " ctx-large" : ""}${high ? " ctx-high" : ""}`}>
      <span className="ctx-label">{large ? "コンテキスト使用率" : "コンテキスト"}</span>
      <span className="ctx-track" role="img" aria-label={`コンテキスト使用率 ${Math.round(pct)}%`}>
        <span className="ctx-bar" style={{ width: `${v}%` }} />
      </span>
      <span className="ctx-text mono">
        {Math.round(pct)}%{high ? " 圧縮間近" : ""}
      </span>
    </span>
  );
}

export const PLAYER_STATE: Record<PlayerView["status"], string> = { run: "稼働中", done: "完了", err: "失敗" };

export function playerLabel(p: PlayerView): string {
  if (p.kind === "codex") return p.model ? `Codex CLI ・ ${p.model}` : "Codex CLI";
  return p.model ?? p.agentType ?? "サブエージェント";
}

export function CodexIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#D8DEE8" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
      <path d="M8 10l3 2-3 2" />
      <path d="M12.5 15h3.5" />
    </svg>
  );
}

export function ConductorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 20L17 7" />
      <circle cx="19" cy="5" r="2.2" />
      <path d="M8 20h-4v-4" />
    </svg>
  );
}

/** プレイヤーの頭文字の丸（Claude）または六角形（Codex） */
export function PlayerMark({ p }: { p: PlayerView }) {
  if (p.kind === "codex") return <CodexIcon />;
  const label = playerLabel(p);
  return <span className={`player-initial model-${modelFamily(p.model)}`}>{label.charAt(0)}</span>;
}

export function PlayerChip({ p }: { p: PlayerView }) {
  const label = playerLabel(p);
  return (
    <span className="player-chip" title={`${label}${p.task ? " ・ " + p.task : ""} ・ ${PLAYER_STATE[p.status]}`}>
      <PlayerMark p={p} />
      {p.kind === "codex" ? "Codex" : label.split(" ")[0]}
      <span className={`dot dot-${p.status}`} aria-label={PLAYER_STATE[p.status]} />
    </span>
  );
}
