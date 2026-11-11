// サーバー設定。データはリポジトリの外（既定：%LOCALAPPDATA%\kanseishitsu）に置く

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  /** 待ち受けアドレス。同じ PC の中からだけ使うため、127.0.0.1 から変えない */
  host: string;
  port: number;
  /** ~/.claude/sessions と会話記録を読み直す間隔（ミリ秒） */
  scanIntervalMs: number;
  thresholds: {
    /** コンテキスト使用率がこの値（%）以上で「圧縮間近」として黄色で表示する */
    ctxWarnPct: number;
    /** 許可待ち・質問への回答待ちがこの秒数続いたら放置アラートを出す */
    idleAlertSec: number;
    /** 同じファイルをこの秒数以内に別の担当が編集したら競合とみなす */
    conflictWindowSec: number;
  };
  /** 記録を残す日数。これより古いイベント・プロンプト・利用枠・費用・解消済みのアラート・セッションは消す */
  retentionDays: number;
}

export const DATA_DIR =
  process.env.KANSEI_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "kanseishitsu");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const DB_PATH = join(DATA_DIR, "kanseishitsu.db");

const DEFAULTS: ServerConfig = {
  host: "127.0.0.1",
  port: 8790,
  scanIntervalMs: 1500,
  thresholds: { ctxWarnPct: 70, idleAlertSec: 600, conflictWindowSec: 600 },
  retentionDays: 15,
};

export function loadConfig(): ServerConfig {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  let file: Partial<ServerConfig> = {};
  if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const cfg: ServerConfig = {
    ...DEFAULTS,
    ...file,
    // 外から接続できるアドレスでは待ち受けない
    host: "127.0.0.1",
    thresholds: { ...DEFAULTS.thresholds, ...(file.thresholds ?? {}) },
  };
  if (!existsSync(CONFIG_PATH)) saveConfig(cfg);
  if (process.env.KANSEI_PORT) cfg.port = Number(process.env.KANSEI_PORT);
  return cfg;
}

export function saveConfig(cfg: ServerConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}
