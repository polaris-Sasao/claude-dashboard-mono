# CLAUDE.md - claude-dashboard-mono

## 概要
- 1 台の PC（Windows 11）で動いている Claude Code の複数のセッションを、同じ PC のブラウザから見守るツール。
- 計画と決定事項は `docs/plan.md`、使い方は `README.md` と `deploy/windows/README.md` を参照する。

## 構成
- `apps/server`：監視サーバー（Bun + Hono + SQLite）。`~/.claude/sessions` と会話記録を読み、`127.0.0.1` だけで待ち受ける。
  - `src/local/`：セッションのファイル・プロセスの親子関係（`bun:ffi` で Windows の API を呼ぶ）・会話記録・トークン数の読み取り
- `apps/web`：画面（React + Vite）
- `apps/agent`：エージェント。利用枠（statusLine・利用枠の mod）と危険操作のガード（PreToolUse）だけを、同じ PC の監視サーバーへ送る
- `packages/shared`：サーバー・画面・エージェントで共有する型と判定

## 開発
- `bun install` → `bun test`・`bun run typecheck`
- 画面：`bun run build:web`（開発中は `bun run dev:server` と `bun run dev:web`）
- エージェント：`bun run build:agent`
- 試験でサーバーを起動するときは、`KANSEI_DATA_DIR`（データの置き場所）と `KANSEI_PORT` を指定し、本番のデータ（`%LOCALAPPDATA%\kanseishitsu`）とポート 8790 を使わない。

## 規約
- `~/.claude/sessions/<pid>.json` と会話記録は公開された仕様ではない。読み取りは `apps/server/src/local/` にまとめ、項目がない・形が違うときも画面全体は止めない。確かめた Claude Code の版をコメントに残す。
- 送り先・待ち受けは同じ PC の中（localhost）だけにする。
- コミットメッセージは英語・命令形。ブランチは `feature/`・`fix/`・`chore/` を付ける。
- 手元だけの作業メモは `CLAUDE.local.md`（git の管理外）に書く。
