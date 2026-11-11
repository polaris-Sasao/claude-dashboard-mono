// まとまり（起動元）のカードとセッションタイル

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { GroupView, SessionStatus, SessionView } from "@kanseishitsu/shared";
import { ConductorIcon, CtxGauge, ModelChip, PlayerChip } from "./parts";
import { Indicator, PcIcon } from "./Icons";
import { STATUS_LABEL, ago } from "./format";

interface Props {
  groups: GroupView[];
  now: Date;
  warnPct: number;
  selected: string | null;
  onSelect: (id: string) => void;
}

/** たたんだまとまりの一覧は、見ている人のブラウザにだけ覚えておく */
const COLLAPSED_KEY = "kanseishitsu.collapsedGroups";

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function GroupGrid({ groups, now, warnPct, selected, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (groupId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(groupId)) next.add(groupId);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // 保存できなくても、この画面の間はたたんだままにする
      }
      return next;
    });
  return (
    <div className="host-grid">
      {groups.map((g) => (
        <GroupCard
          key={g.groupId}
          group={g}
          now={now}
          warnPct={warnPct}
          selected={selected}
          onSelect={onSelect}
          collapsed={collapsed.has(g.groupId)}
          onToggle={() => toggle(g.groupId)}
        />
      ))}
    </div>
  );
}

const SUMMARY_ORDER: SessionStatus[] = ["err", "wait", "run", "ended"];

/** たたんだときに出す、状態ごとのセッション数 */
function SessionSummary({ sessions }: { sessions: SessionView[] }) {
  if (sessions.length === 0) return <p className="host-empty">稼働中のセッションはありません</p>;
  return (
    <p className="host-summary">
      <span>セッション {sessions.length}</span>
      {SUMMARY_ORDER.map((st) => {
        const n = sessions.filter((s) => s.status === st).length;
        return n === 0 ? null : (
          <span key={st} className="host-summary-item">
            <Indicator status={st} size={12} />
            {STATUS_LABEL[st]} {n}
          </span>
        );
      })}
    </p>
  );
}

function GroupCard({
  group,
  now,
  warnPct,
  selected,
  onSelect,
  collapsed,
  onToggle,
}: { group: GroupView; collapsed: boolean; onToggle: () => void } & Omit<Props, "groups">) {
  // ダブルクリックでたたむ。キーボードでは Enter・Space で切り替える
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };
  // ダブルクリックで見出しが選択状態になるのを防ぐ
  const onMouseDown = (e: MouseEvent) => {
    if (e.detail > 1) e.preventDefault();
  };
  return (
    <div className={`host panel${collapsed ? " host-collapsed" : ""}`}>
      <div className="host-head">
        <div
          className="host-id host-toggle"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          title={collapsed ? "ダブルクリックでひらく" : "ダブルクリックでたたむ"}
          onDoubleClick={onToggle}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
        >
          <svg className="host-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <PcIcon />
          <div>
            <div className="host-name mono">{group.label}</div>
            {group.sub && <div className="host-sub">{group.sub}</div>}
          </div>
        </div>
        <span className="host-beat">セッション {group.sessions.length}</span>
      </div>
      {collapsed ? (
        <SessionSummary sessions={group.sessions} />
      ) : group.sessions.length === 0 ? (
        <p className="host-empty">稼働中のセッションはありません</p>
      ) : (
        group.sessions.map((s) => (
          <SessionTile
            key={s.sessionId}
            s={s}
            now={now}
            warnPct={warnPct}
            selected={selected === s.sessionId}
            onSelect={onSelect}
          />
        ))
      )}
    </div>
  );
}

function SessionTile({
  s,
  now,
  warnPct,
  selected,
  onSelect,
}: {
  s: SessionView;
  now: Date;
  warnPct: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const running = s.players.filter((p) => p.status === "run").length;
  return (
    <button
      type="button"
      className={`tile${selected ? " selected" : ""}`}
      aria-pressed={selected}
      aria-label={`${s.project} ${STATUS_LABEL[s.status]} ${s.statusText}`}
      onClick={() => onSelect(s.sessionId)}
      title={s.cwd ?? undefined}
    >
      <span className="tile-row">
        <span className="tile-title">
          <Indicator status={s.status} />
          <span className="tile-project mono">{s.project}</span>
          {s.name && s.name !== s.project && <span className="tile-name">{s.name}</span>}
        </span>
        <ModelChip model={s.model} />
      </span>
      <span className="tile-row">
        <span className="tile-status">
          <span className={`status-word status-${s.status}`}>{STATUS_LABEL[s.status]}</span> ・ {s.statusText}
        </span>
        {s.players.length > 0 ? (
          <span className="conductor" title={`稼働中 ${running} / ${s.players.length}`}>
            <ConductorIcon />
            指揮 ×{s.players.length}
          </span>
        ) : (
          <span className="tile-ago">{ago(s.lastEventAt, now)}</span>
        )}
      </span>
      {s.lastPrompt && <span className="tile-prompt">{s.lastPrompt}</span>}
      <CtxGauge pct={s.ctxPct} warnPct={warnPct} />
      {s.players.length > 0 && (
        <span className="players">
          {s.players.map((p) => (
            <PlayerChip key={p.playerId} p={p} />
          ))}
        </span>
      )}
    </button>
  );
}
