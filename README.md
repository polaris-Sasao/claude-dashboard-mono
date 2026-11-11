# Claude 管制室（単独 PC 版）

1 台の PC（Windows 11）で動いている Claude Code の複数のセッションを、同じ PC のブラウザから見守るツールです。

- 起動元ごとにまとめて表示します：VS Code の拡張（窓ごと）・VS Code のターミナル・Windows Terminal・Claude Desktop
- セッションの状態（作業中・入力待ち・許可待ち・回答待ち）を表示します
- セッションを選ぶと、プロンプトと、それに対する最後の応答を組にして表示します
- アラート：許可待ち・回答待ちの放置、複数のセッションによる同じファイルの編集（ファイル競合）、危険な操作
- サブエージェントと Codex CLI の稼働状況、ToDo、Remote Control への導線、利用枠（5 時間枠・週間枠）の表示

## しくみ

監視サーバーが、Claude Code が PC に書き出しているファイルを直接読みます。

| 読むもの | 使い道 |
| --- | --- |
| `~/.claude/sessions/<pid>.json` | 起動中のセッション・状態・起動元 |
| `~/.claude/projects/<フォルダ>/<セッション ID>.jsonl`（会話記録） | プロンプトと応答・プレイヤー・ToDo・ファイルの編集 |
| プロセスの親子関係 | VS Code の窓・ターミナルの見分け |

利用枠の表示と危険操作のアラートを使うときだけ、エージェントを Claude Code に登録します（statusLine・利用枠の mod・PreToolUse フック）。詳しくは [docs/plan.md](docs/plan.md) を参照してください。

## 必要なもの

- Windows 11
- [Bun](https://bun.sh/)
- Claude Code（確認した版：2.1.319〜2.1.321）

## 使い方

```powershell
bun install
bun run build:web
bun apps/server/src/index.ts
```

ブラウザで `http://localhost:8790` を開きます。

- サインインしたときに自動で起動するには、[deploy/windows/README.md](deploy/windows/README.md) の手順でタスク スケジューラに登録します。
- 利用枠の表示と危険操作のアラートを使うには、同じ手順書の「エージェント」の手順で登録します。エージェントなしでも、一覧・会話・放置・ファイル競合は動きます。

## 安全のための作り

- 監視サーバーは `127.0.0.1` だけで待ち受けます。ほかの端末からは開けません。
- `Host`・`Origin` が `localhost` でないリクエストは断ります（ブラウザで開いたほかのサイトからの送信・読み取りを防ぎます）。
- エージェントの送り先は `localhost` だけです。
- プロンプトや応答の中の、トークン・パスワードらしい文字列は伏せ字にして表示します。
- 会話の本文は保存しません。保存するのは、利用枠・費用の見積もり・アラートの記録と、セッションのプロジェクト名・開始時刻（費用の内訳に使う）だけで、15 日で消します（`%LOCALAPPDATA%\kanseishitsu`）。

## 注意

- `~/.claude/sessions` のファイルと会話記録は、公開された仕様ではありません。Claude Code の版が変わると、正しく読めなくなる可能性があります。
- 対象は Windows 11 だけです。

## 開発

```powershell
bun test
bun run typecheck
bun run dev:server   # 監視サーバー（変更を見て再起動）
bun run dev:web      # 画面（http://127.0.0.1:5179）
bun run build:agent  # エージェント（apps/agent/bin/kanseishitsu-agent.exe）
```

## ライセンス

[MIT](LICENSE)
