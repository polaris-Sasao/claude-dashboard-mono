// アラート欄（放置・ファイル競合）

import { useState } from "react";
import type { AlertView } from "@kanseishitsu/shared";
import { Indicator } from "./Icons";

const TITLE: Record<AlertView["kind"], string> = {
  idle: "放置アラート",
  conflict: "ファイル競合",
  danger: "危険操作",
};

const OUTCOME: Record<NonNullable<AlertView["outcome"]>, string> = {
  pending: "許可待ち",
  executed: "許可されて実行",
  failed: "実行して失敗",
  not_executed: "実行されず",
};

function minutes(fromIso: string | undefined, now: Date): number {
  if (!fromIso) return 0;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(fromIso)) / 60000));
}

/** パスが長いときは末尾のファイル名側を残す */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
}

export function AlertList({
  alerts,
  now,
  idleMin,
  canOpen,
  onSelect,
}: {
  alerts: AlertView[];
  now: Date;
  idleMin: number;
  /** 一覧にあるセッションか（終了・一覧から外れたものは詳細を開けない） */
  canOpen: (sessionId: string) => boolean;
  onSelect: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  if (alerts.length === 0) return null;

  const dismiss = async (id: number) => {
    setBusy(id);
    try {
      await fetch(`/api/alerts/${id}/dismiss`, { method: "POST", credentials: "same-origin" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="alerts panel" aria-label="アラート">
      <div className="alerts-head">
        <h2>アラート</h2>
        <span className="alerts-count">{alerts.length}</span>
      </div>
      {alerts.map((a) => {
        const where = `${a.hostLabel}${a.project ? " / " + a.project : ""}`;
        return (
          <div key={a.alertId} className={`alert-row kind-${a.kind}`}>
            <Indicator status={a.kind === "danger" ? "err" : "wait"} size={16} />
            <span className="alert-title">{TITLE[a.kind]}</span>
            <span className="alert-msg">
              {a.kind === "idle" && (
                <>
                  {where} の{a.waitText?.split(" ・ ")[0] ?? "応答待ち"}が{" "}
                  <span className="alert-em">{minutes(a.waitingSince, now)}分</span> 続いています（しきい値 {idleMin}分）
                </>
              )}
              {a.kind === "danger" && (
                <>
                  {where} で{a.guardLabel}を検知し、
                  {a.guardMode === "log" ? "記録しました（止めていません）" : "実行してよいか確認を求めました"}{" "}
                  <code className="mono">{a.command}</code>
                  {a.guardMode !== "log" && <span className={`alert-outcome outcome-${a.outcome}`}>{OUTCOME[a.outcome ?? "pending"]}</span>}
                </>
              )}
              {a.kind === "conflict" && (
                <>
                  {where} で {a.actors?.join(" と ")} が <code className="mono" title={a.path}>{shortPath(a.path ?? "")}</code>{" "}
                  を続けて編集しています
                </>
              )}
            </span>
            <span className="alert-actions">
              {a.kind === "danger" && a.guardMode !== "log" && a.outcome === "pending" && a.remoteUrl && (
                <a className="alert-btn primary" href={a.remoteUrl} target="_blank" rel="noreferrer">
                  Remote Control で応答
                </a>
              )}
              {a.kind === "idle" && a.remoteUrl && (
                <a className="alert-btn primary" href={a.remoteUrl} target="_blank" rel="noreferrer">
                  Remote Control で応答
                </a>
              )}
              {a.sessionId && canOpen(a.sessionId) && (
                <button type="button" className="alert-btn" onClick={() => onSelect(a.sessionId!)}>
                  詳細
                </button>
              )}
              <button type="button" className="alert-btn" disabled={busy === a.alertId} onClick={() => dismiss(a.alertId)}>
                閉じる
              </button>
            </span>
          </div>
        );
      })}
    </section>
  );
}
