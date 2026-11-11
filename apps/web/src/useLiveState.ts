// /api/state で初期表示し、/ws の差分（フェーズ1は全体スナップショット）で更新する

import { useEffect, useState } from "react";
import type { StateSnapshot, WsMessage } from "@kanseishitsu/shared";

export type Conn = "connecting" | "open" | "retrying";

export function useLiveState(): { state: StateSnapshot | null; conn: Conn; updatedAt: Date | null } {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const apply = (s: StateSnapshot) => {
      setState(s);
      setUpdatedAt(new Date(s.generatedAt));
    };

    const loadInitial = async () => {
      const res = await fetch("/api/state", { credentials: "same-origin" });
      if (res.ok) apply(await res.json());
      return true;
    };

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 0;
        setConn("open");
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as WsMessage;
        if (msg.type === "snapshot") apply(msg.state);
      };
      ws.onclose = () => {
        if (closed) return;
        setConn("retrying");
        // サーバーが再起動した場合に備え、再接続の前に状態を取り直す
        const delay = Math.min(30_000, 1000 * 2 ** retry++);
        timer = setTimeout(async () => {
          if (await loadInitial().catch(() => true)) connect();
        }, delay);
      };
    };

    loadInitial()
      .then((ok) => ok && connect())
      .catch(() => connect());

    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { state, conn, updatedAt };
}

/** 経過時間の表示を定期的に更新するための現在時刻 */
export function useNow(intervalMs = 5000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
