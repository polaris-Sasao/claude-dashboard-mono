// 同じ PC の中だけで使うための仕組み
//   ・この PC を表す hosts の行（利用枠・費用・アラートの記録は host_id で持つ）。PC ごとのトークンは使わない
//   ・ほかの Web サイトから localhost への送信・読み取り（DNS リバインディングなど）を断る Host・Origin の確認

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

export interface HostRow {
  host_id: string;
  label: string;
}

export const LOCAL_HOST_ID = "local";

/** この PC を表す行を用意する。token_hash は使わないが、列の制約（NOT NULL・UNIQUE）のため埋めておく */
export function ensureLocalHost(db: Database, label = hostname()): HostRow {
  db.query(
    `INSERT INTO hosts (host_id, hostname, os, label, token_hash, created_at) VALUES (?, ?, 'windows', ?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET hostname = excluded.hostname, label = excluded.label`,
  ).run(LOCAL_HOST_ID, label, label, `unused:${LOCAL_HOST_ID}`, new Date().toISOString());
  return { host_id: LOCAL_HOST_ID, label };
}

/** テスト用：任意の名前の行を足す */
export function addHost(db: Database, label: string): { hostId: string } {
  const hostId = randomUUID();
  db.query("INSERT INTO hosts (host_id, label, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
    hostId,
    label,
    `unused:${hostId}`,
    new Date().toISOString(),
  );
  return { hostId };
}

const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHostHeader(value: string | null | undefined, port: number): boolean {
  if (!value) return false;
  const m = value.toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m || !LOCAL_NAMES.has(m[1]!)) return false;
  return m[2] === undefined ? port === 80 : Number(m[2]) === port;
}

/**
 * localhost からのリクエストか。
 * Host が localhost・127.0.0.1・[::1]（と待ち受けのポート）でなければ断る（DNS リバインディング対策）。
 * Origin が付いていれば、それも localhost のものでなければ断る（ほかのサイトからの送信・WebSocket 接続を断る）。
 * エージェントからの送信には Origin が付かない
 */
export function isLocalRequest(host: string | null | undefined, origin: string | null | undefined, port: number): boolean {
  if (!isLocalHostHeader(host, port)) return false;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && isLocalHostHeader(u.host, port);
  } catch {
    return false;
  }
}
