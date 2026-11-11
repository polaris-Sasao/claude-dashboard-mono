# Windows での自動起動

監視サーバーを、Windows にサインインしたときに自動で起動します。対象は Windows 11 です。

## 準備

```powershell
bun install
bun run build:web
```

## 登録

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1
Start-ScheduledTask -TaskName kanseishitsu   # いますぐ起動する場合
```

- タスク スケジューラに、今のユーザーだけで動くタスク「kanseishitsu」を登録します。管理者の権限は要りません。
- 窓を出さずに動かします。出力は `%LOCALAPPDATA%\kanseishitsu\server.log` に追記します。
- 画面は `http://localhost:8790` で開きます。同じ PC の中からしか開けません。
- リポジトリの場所を動かしたときは、もう一度登録してください。

## エージェント（利用枠と危険操作のガード）

セッションの一覧・会話・放置・ファイル競合は、監視サーバーが `~/.claude` のファイルを直接読むため、エージェントは要りません。
利用枠の表示と危険操作のガードを使うときだけ、エージェントを Claude Code に登録します。

```powershell
bun run build:agent
apps\agent\bin\kanseishitsu-agent.exe setup          # 登録する内容を表示するだけ
apps\agent\bin\kanseishitsu-agent.exe setup --apply  # 確認のうえ ~/.claude/settings.json を書き換える
```

- 実行ファイルを `~/.kanseishitsu/bin/kanseishitsu-agent.exe` に置き、`~/.claude/settings.json` に次を登録します（書き換える前にバックアップを取ります）。
  - 危険操作のガード（`PreToolUse`、Bash・PowerShell。待ち時間 5 秒）
  - statusLine（ターミナルの利用枠とモデル）
  - 利用枠の mod（VS Code の拡張・Claude Desktop の利用枠）
- 送り先は `http://localhost:8790` だけです。前身（複数 PC 版）の設定（ほかの PC の送り先・トークン）が残っていても、ほかの PC には送りません。`setup` を実行すると、その設定を書き直します。
- 前身が登録したイベント送信（`kanseishitsu-agent hook <イベント>`）が残っていれば、`setup --apply` で外します。
- 新しく起動した Claude Code のセッションから反映されます。

## 取り消し

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-autostart.ps1
```

データ（`%LOCALAPPDATA%\kanseishitsu`）は消しません。
