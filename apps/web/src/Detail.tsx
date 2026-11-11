// セッションの詳細パネル

import { useEffect, useState } from "react";
import type { SessionDetail, SessionView, TurnView } from "@kanseishitsu/shared";
import { CtxGauge, ModelChip, PLAYER_STATE, PlayerMark, playerLabel } from "./parts";
import { Indicator } from "./Icons";
import { STATUS_LABEL, ago, formatDateTime } from "./format";

/** 一覧のセッション（WebSocket で更新される）が変わったら詳細を取り直す */
function useDetail(session: SessionView | null): SessionDetail | null | "missing" {
  const [detail, setDetail] = useState<SessionDetail | null | "missing">(null);
  const key = session ? `${session.sessionId}|${session.lastEventAt}|${session.players.length}|${session.lastPrompt ?? ""}` : "";
  useEffect(() => {
    if (!session) {
      setDetail(null);
      return;
    }
    let alive = true;
    fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}`, { credentials: "same-origin" })
      .then(async (r) => {
        if (!alive) return;
        setDetail(r.ok ? await r.json() : "missing");
      })
      .catch(() => alive && setDetail("missing"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return detail;
}

export function DetailPanel({
  session,
  now,
  warnPct,
  onClose,
}: {
  session: SessionView | null;
  now: Date;
  warnPct: number;
  onClose?: () => void;
}) {
  const detail = useDetail(session);

  if (!session) {
    return (
      <aside className="detail panel detail-empty" aria-label="セッション詳細">
        <p>タイルを選ぶと、ここにセッションの詳細を表示します。</p>
      </aside>
    );
  }
  // 一覧の値（即時に更新される）を優先し、詳細 API の値で補う
  const d = detail && detail !== "missing" && detail.session.sessionId === session.sessionId ? detail : null;
  const s = session;
  return (
    <aside className="detail panel" aria-label="セッション詳細">
      {onClose && (
        <button type="button" className="detail-back" onClick={onClose}>
          ← 一覧に戻る
        </button>
      )}
      <div className="detail-head">
        <div className="detail-host mono">{d ? `${d.groupLabel}${d.groupSub ? " ・ " + d.groupSub : ""}` : " "}</div>
        <div className="detail-title">
          <h2 className="mono">{s.project}</h2>
          <ModelChip model={s.model} />
        </div>
        <div className="detail-status">
          <Indicator status={s.status} />
          <span>
            {STATUS_LABEL[s.status]} ・ {s.statusText}
          </span>
          <span className="detail-ago mono">{ago(s.lastEventAt, now)}</span>
        </div>
        <CtxGauge pct={s.ctxPct} warnPct={warnPct} large />
        {s.cwd && <div className="detail-cwd mono">{s.cwd}</div>}
      </div>

      {s.players.length > 0 && (
        <section className="detail-section">
          <h3>指揮中のプレイヤー（{s.players.length}）</h3>
          {s.players.map((p) => (
            <div key={p.playerId} className="player-row">
              <span className="player-main">
                <PlayerMark p={p} />
                <span className="player-name">{playerLabel(p)}</span>
                {p.task && <span className="player-task">{p.task}</span>}
              </span>
              <span className="player-state">
                <span className={`dot dot-${p.status}`} />
                {PLAYER_STATE[p.status]}
              </span>
            </div>
          ))}
        </section>
      )}


      {d?.todos && d.todos.length > 0 && (
        <section className="detail-section">
          <h3>進捗</h3>
          {d.todos.map((t, i) => (
            <div key={i} className={`step step-${t.status}`}>
              <StepIcon status={t.status} />
              <span>{t.label}</span>
            </div>
          ))}
        </section>
      )}

      <section className="detail-section">
        <h3>プロンプトと応答{d && d.turns.length > 0 ? `（${d.turns.length}${d.moreTurns ? " ・ 古いものは省略" : ""}）` : ""}</h3>
        {!d ? (
          <p className="detail-none">読み込み中…</p>
        ) : d.turns.length === 0 ? (
          <p className="detail-none">まだプロンプトはありません</p>
        ) : (
          <ol className="turns">
            {[...d.turns].reverse().map((t, i) => (
              <TurnItem key={t.promptId} t={t} latest={i === 0} running={s.status === "run"} />
            ))}
          </ol>
        )}
      </section>

      <footer className="detail-foot">
        {s.remoteUrl ? (
          <>
            <a className="remote-open" href={s.remoteUrl} target="_blank" rel="noreferrer">
              Remote Control で開く ↗
            </a>
            <span>応答や許可の操作は、Remote Control（公式アプリ・Web）で行えます。</span>
          </>
        ) : (
          <span>
            このセッションで <code className="mono">/remote-control</code>{" "}
            を実行すると、ここから Remote Control で開けるようになります（反映は次の操作のあと）。
          </span>
        )}
      </footer>
    </aside>
  );
}

/** プロンプト 1 件と、それに対する最後の応答。新しいものを上に出す */
function TurnItem({ t, latest, running }: { t: TurnView; latest: boolean; running: boolean }) {
  // 作業中のターンは途中の文章を出さない（最後の応答だけを出す）
  const working = latest && running;
  return (
    <li className="turn">
      <div className="turn-prompt">
        <span className="turn-label">プロンプト</span>
        <span className="turn-at mono">{formatDateTime(new Date(t.at))}</span>
        <div className="prompt-box">{t.prompt || "（本文なし）"}</div>
      </div>
      <div className="turn-response">
        <span className="turn-label">応答</span>
        {working ? (
          <p className="detail-none">作業中です</p>
        ) : t.response ? (
          <>
            <span className="turn-at mono">{formatDateTime(new Date(t.response.at))}</span>
            <div className="result">{t.response.text}</div>
          </>
        ) : (
          <p className="detail-none">{t.interrupted ? "途中で止めました" : "応答はありません"}</p>
        )}
      </div>
    </li>
  );
}

function StepIcon({ status }: { status: "done" | "active" | "todo" }) {
  if (status === "done")
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--run)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="完了">
        <path d="M5 12l5 5 9-10" />
      </svg>
    );
  if (status === "active")
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" aria-label="実行中">
        <path d="M12 3a9 9 0 1 1-9 9" />
      </svg>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4A5870" strokeWidth="2" aria-label="未着手">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
