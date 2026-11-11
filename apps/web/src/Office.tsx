// オフィス表示：まとまり（起動元）を部屋、セッションを机に座るキャラクターとして描く

import type { GroupView, PlayerView, SessionView } from "@kanseishitsu/shared";
import { Indicator } from "./Icons";
import { ago } from "./format";

interface Props {
  groups: GroupView[];
  now: Date;
  selected: string | null;
  onSelect: (id: string) => void;
}

/** 机の上の様子。wait は「人の返事が要る」と「手が空いた」で描き分け、応答なし（推定）は居眠りにする */
type Pose = "run" | "ask" | "idle" | "err" | "sleep" | "ended";

function poseOf(s: SessionView): Pose {
  if (s.status === "run") return "run";
  if (s.status === "ended") return "ended";
  if (s.status === "err") return s.statusText.startsWith("応答なし") ? "sleep" : "err";
  return s.statusText.startsWith("許可待ち") || s.statusText.startsWith("質問") ? "ask" : "idle";
}

const POSE_LABEL: Record<Pose, string> = {
  run: "作業中",
  ask: "返事待ち",
  idle: "指示待ち",
  err: "異常",
  sleep: "応答なし",
  ended: "退勤",
};

const SCREEN: Record<Pose, string> = {
  run: "#43C57F",
  ask: "#F5C451",
  idle: "#2E6E7E",
  err: "#F06A43",
  sleep: "#2A3346",
  ended: "#141B28",
};

const SHIRTS = ["#5B7FD6", "#C2577A", "#4FA36A", "#8C6BD1", "#D08A3C", "#3C9C9C", "#B8506A", "#6E8FA8"];
const HAIRS = ["#3A2A22", "#1B1F2A", "#8A5A3B", "#5A3A2A", "#C9A15A"];
const SKIN = "#F2C9A0";
const INK = "#1B1F2A";

/** セッション ID から毎回同じ見た目を選ぶ */
function lookOf(id: string): { shirt: string; hair: string } {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { shirt: SHIRTS[h % SHIRTS.length]!, hair: HAIRS[(h >>> 8) % HAIRS.length]! };
}

const HELPER = {
  claude: { body: "#D97757", cap: "#F2E4D3" },
  codex: { body: "#E8EDF4", cap: "#1B1F2A" },
};

export function OfficeFloor({ groups, now, selected, onSelect }: Props) {
  const rooms = groups;
  if (rooms.length === 0) return <p className="empty panel">起動中の Claude Code はありません。</p>;
  const night = now.getHours() < 6 || now.getHours() >= 18;
  return (
    <div className="office">
      {rooms.map((g) => (
        <Room key={g.groupId} group={g} now={now} night={night} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** まとまり（起動元）＝部屋 */
function Room({ group, now, night, selected, onSelect }: { group: GroupView; night: boolean } & Omit<Props, "groups">) {
  const present = group.sessions.filter((s) => s.status !== "ended").length;
  const latest = group.sessions.reduce<string | null>((m, s) => (!m || s.lastEventAt > m ? s.lastEventAt : m), null);
  return (
    <section className="room panel" aria-label={group.label}>
      <div className="room-wall">
        <div className="room-id">
          <div className={`room-window${night ? " night" : ""}`} aria-hidden="true" />
          <div className="room-plate">
            <div className="room-name">{group.label}</div>
            <div className="room-sub">{group.sub}</div>
          </div>
        </div>
        <div className="room-meta mono">
          在席 {present} / {group.sessions.length}
          <br />
          {ago(latest, now)}
        </div>
      </div>
      <div className="room-floor">
        {group.sessions.length === 0 ? (
          <div className="desk desk-vacant">
            <Sprite pose="ended" look={lookOf(group.groupId)} helper={null} />
            <span className="desk-status">稼働中のセッションはありません</span>
          </div>
        ) : (
          group.sessions.map((s) => (
            <Desk key={s.sessionId} s={s} now={now} selected={selected === s.sessionId} onSelect={onSelect} />
          ))
        )}
      </div>
    </section>
  );
}

function Desk({ s, now, selected, onSelect }: { s: SessionView; now: Date; selected: boolean; onSelect: (id: string) => void }) {
  const pose = poseOf(s);
  const running = s.players.filter((p) => p.status === "run");
  // 横に立たせるのは1人だけ。Codex が動いていれば Codex を優先して見せる
  const helper: PlayerView | null = running.find((p) => p.kind === "codex") ?? running[0] ?? null;
  return (
    <button
      type="button"
      className={`desk${selected ? " selected" : ""}${pose === "ask" ? " desk-ask" : ""}`}
      aria-pressed={selected}
      aria-label={`${s.project} ${POSE_LABEL[pose]} ${s.statusText}`}
      onClick={() => onSelect(s.sessionId)}
      title={s.cwd ?? undefined}
    >
      <Sprite pose={pose} look={lookOf(s.sessionId)} helper={pose === "ended" ? null : helper ? helper.kind : null} />
      <span className="desk-project">{s.project}</span>
      <span className="desk-status">
        <Indicator status={s.status} size={10} />
        <span className="desk-status-text">{s.status === "ended" ? POSE_LABEL.ended : s.statusText}</span>
      </span>
      <span className="desk-ago mono">
        {ago(s.lastEventAt, now)}
        {running.length > 1 && ` ・ 同行 ${running.length}`}
      </span>
    </button>
  );
}

/** 48×48 の点描（1点＝3px）。椅子 → 同行者 → 本人 → 机 → 手元と吹き出し の順に重ねる */
function Sprite({ pose, look, helper }: { pose: Pose; look: { shirt: string; hair: string }; helper: PlayerView["kind"] | null }) {
  const { shirt, hair } = look;
  const hp = helper ? HELPER[helper] : null;
  return (
    <svg className="sprite" width="144" height="144" viewBox="0 -8 48 48" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="2" y="36" width="44" height="2" fill="#000" opacity="0.3" />
      <rect x="14" y="8" width="12" height="13" fill="#3A4358" />
      <rect x="14" y="8" width="12" height="1" fill="#4D5873" />

      {hp && (
        <g className="bob">
          <rect x="4" y="9" width="8" height="11" fill={hp.body} />
          <rect x="5" y="3" width="6" height="6" fill={SKIN} />
          <rect x="5" y="2" width="6" height="2" fill={hp.cap} />
          <rect x="10" y="3" width="2" height="1" fill={hp.cap} />
          <rect x="9" y="5" width="1" height="1" fill={INK} />
          <rect x="10" y="11" width="3" height="5" fill="#E8EDF4" />
          <rect x="11" y="10" width="1" height="1" fill="#9DA9BB" />
          <rect x="10" y="13" width="2" height="1" fill="#9DA9BB" />
        </g>
      )}

      {(pose === "run" || pose === "ask" || pose === "idle") && (
        <>
          <rect x="15" y="11" width="10" height="10" fill={shirt} />
          <rect x="16" y="3" width="8" height="8" fill={SKIN} />
          <rect x="16" y="2" width="8" height="3" fill={hair} />
          <rect x="16" y="5" width="1" height="3" fill={hair} />
          <rect x="23" y="5" width="1" height={pose === "run" ? 2 : 3} fill={hair} />
        </>
      )}
      {pose === "run" && (
        <>
          <rect x="18" y="11" width="4" height="1" fill="#E8EDF4" opacity="0.5" />
          <g className="blink">
            <rect x="19" y="7" width="1" height="1" fill={INK} />
            <rect x="22" y="7" width="1" height="1" fill={INK} />
          </g>
        </>
      )}
      {pose === "ask" && (
        <>
          <rect x="18" y="7" width="1" height="1" fill={INK} />
          <rect x="21" y="7" width="1" height="1" fill={INK} />
          <rect x="19" y="9" width="2" height="1" fill="#B5523B" />
          <g className="wave">
            <rect x="25" y="-1" width="2" height="2" fill={SKIN} />
            <rect x="25" y="1" width="2" height="11" fill={shirt} />
          </g>
        </>
      )}
      {pose === "idle" && (
        <>
          <rect x="18" y="7" width="2" height="1" fill={INK} />
          <rect x="21" y="7" width="2" height="1" fill={INK} />
          <rect x="19" y="9" width="2" height="1" fill="#B5523B" />
          <rect x="13" y="13" width="2" height="5" fill={shirt} />
          <rect x="10" y="12" width="3" height="4" fill="#E8EDF4" />
          <rect x="9" y="13" width="1" height="2" fill="#E8EDF4" />
          <rect x="10" y="12" width="3" height="1" fill="#6B3E26" />
        </>
      )}
      {pose === "err" && (
        <>
          <rect x="15" y="15" width="10" height="6" fill={shirt} />
          <rect x="15" y="15" width="1" height="2" fill={SKIN} />
          <rect x="24" y="15" width="1" height="2" fill={SKIN} />
          <rect x="16" y="12" width="8" height="8" fill={hair} />
        </>
      )}
      {pose === "sleep" && (
        <>
          <rect x="15" y="12" width="10" height="9" fill={shirt} />
          <g className="nod">
            <rect x="17" y="5" width="8" height="8" fill={SKIN} />
            <rect x="17" y="4" width="8" height="3" fill={hair} />
            <rect x="24" y="7" width="1" height="3" fill={hair} />
            <rect x="18" y="9" width="2" height="1" fill={INK} />
            <rect x="21" y="9" width="2" height="1" fill={INK} />
          </g>
        </>
      )}

      {/* 机とモニター。画面の色は状態の色 */}
      <rect x="28" y="6" width="16" height="11" fill="#1E2433" />
      <rect x="29" y="7" width="14" height="9" fill={SCREEN[pose]} className={pose === "err" ? "flicker" : undefined} />
      <rect x="35" y="17" width="2" height="3" fill="#1E2433" />
      <rect x="32" y="19" width="8" height="1" fill="#1E2433" />
      <rect x="1" y="20" width="46" height="4" fill="#B07A4F" />
      <rect x="1" y="20" width="46" height="1" fill="#C99063" />
      <rect x="2" y="24" width="44" height="12" fill="#7A4E33" />
      <rect x="2" y="35" width="44" height="1" fill="#5E3B26" />
      <rect x="31" y="27" width="12" height="1" fill="#5E3B26" />
      <rect x="31" y="31" width="12" height="1" fill="#5E3B26" />
      <rect x="36" y="29" width="2" height="1" fill="#C99063" />
      <rect x="36" y="33" width="2" height="1" fill="#C99063" />
      <rect x="13" y="19" width="11" height="2" fill="#C8CFDB" />
      <rect x="14" y="19" width="9" height="1" fill="#9DA9BB" />

      {pose === "run" && (
        <>
          <rect x="30" y="9" width="9" height="1" fill="#0B111C" opacity="0.45" className="code" />
          <rect x="30" y="11" width="11" height="1" fill="#0B111C" opacity="0.45" className="code code2" />
          <rect x="32" y="13" width="6" height="1" fill="#0B111C" opacity="0.45" className="code" />
          <rect x="14" y="18" width="3" height="2" fill={SKIN} className="tap" />
          <rect x="20" y="18" width="3" height="2" fill={SKIN} className="tap tap2" />
        </>
      )}
      {pose === "ask" && (
        <>
          <g className="bob">
            <rect x="3" y="-7" width="10" height="10" fill="#F5C451" />
            <rect x="11" y="2" width="2" height="2" fill="#F5C451" />
            <rect x="13" y="3" width="1" height="1" fill="#F5C451" />
            <rect x="7" y="-5" width="2" height="4" fill="#0B111C" />
            <rect x="7" y="0" width="2" height="1" fill="#0B111C" />
          </g>
          <rect x="15" y="18" width="3" height="2" fill={SKIN} />
          <rect x="31" y="10" width="10" height="3" fill="#0B111C" opacity="0.35" />
        </>
      )}
      {pose === "idle" && (
        <>
          <rect x="10" y="9" width="1" height="2" fill="#9DA9BB" className="steam" />
          <rect x="12" y="8" width="1" height="2" fill="#9DA9BB" className="steam steam2" />
          <rect x="20" y="18" width="3" height="2" fill={SKIN} />
        </>
      )}
      {pose === "err" && (
        <>
          <rect x="12" y="18" width="6" height="2" fill={shirt} />
          <rect x="22" y="18" width="6" height="2" fill={shirt} />
          <rect x="38" y="2" width="3" height="3" fill="#6B7486" className="smoke" />
          <rect x="34" y="1" width="2" height="2" fill="#8892A4" className="smoke smoke2" />
          <rect x="34" y="9" width="4" height="4" fill="#0B111C" opacity="0.5" />
        </>
      )}
      {pose === "sleep" && (
        <>
          <text x="25" y="3" className="zz" fontSize="7">
            Z
          </text>
          <text x="21" y="0" className="zz zz2" fontSize="5">
            z
          </text>
        </>
      )}
    </svg>
  );
}
