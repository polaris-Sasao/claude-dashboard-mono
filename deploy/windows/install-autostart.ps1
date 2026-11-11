# 監視サーバーを、Windows にサインインしたときに自動で起動するよう、タスク スケジューラに登録する。
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install-autostart.ps1
# 登録するタスクは、今のユーザーだけで動く（管理者の権限は要らない）。
# 窓を出さずに動かすため conhost.exe --headless から起動し、出力は %LOCALAPPDATA%\kanseishitsu\server.log に追記する。
# 取り消すときは uninstall-autostart.ps1 を実行する。

$ErrorActionPreference = 'Stop'

$TaskName = 'kanseishitsu'
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $Bun) { throw 'bun が見つかりません。Bun を入れてから実行してください。' }
# npm で入れた bun はシェル用の入口（bun.cmd など）になっていることがあるため、実体の bun.exe を探す
if ($Bun -notmatch '\.exe$') {
  $exe = Join-Path (Split-Path $Bun) 'node_modules\bun\bin\bun.exe'
  if (Test-Path $exe) { $Bun = $exe }
}

$DataDir = Join-Path $env:LOCALAPPDATA 'kanseishitsu'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$Log = Join-Path $DataDir 'server.log'

if (-not (Test-Path (Join-Path $RepoDir 'apps\web\dist\index.html'))) {
  Write-Host '画面がビルドされていません。先に bun run build:web を実行してください。' -ForegroundColor Yellow
}

$cmd = "`"$Bun`" apps\server\src\index.ts >> `"$Log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless cmd.exe /d /c `"$cmd`"" -WorkingDirectory $RepoDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "タスク「$TaskName」を登録しました。"
Write-Host "  起動するもの：$Bun apps\server\src\index.ts（$RepoDir）"
Write-Host "  ログ：$Log"
Write-Host 'いますぐ起動するには：Start-ScheduledTask -TaskName kanseishitsu'
Write-Host '画面：http://localhost:8790'
