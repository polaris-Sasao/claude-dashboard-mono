# install-autostart.ps1 で登録したタスクを止めて、登録を取り消す。
#   powershell -ExecutionPolicy Bypass -File deploy\windows\uninstall-autostart.ps1
# データ（%LOCALAPPDATA%\kanseishitsu）は消さない。

$ErrorActionPreference = 'Stop'
$TaskName = 'kanseishitsu'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "タスク「$TaskName」は登録されていません。"
  return
}
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "タスク「$TaskName」の登録を取り消しました。"
