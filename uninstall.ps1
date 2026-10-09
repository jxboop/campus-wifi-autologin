# 卸载 WiFi 自动认证计划任务
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# 注意：本机 Get-ScheduledTask/Unregister-ScheduledTask 存在 CIM 读取缺陷
# （连系统自带任务都读不了），因此统一改用 schtasks.exe。

$tasks = @('WiFi自动认证', 'WiFi自动认证-常驻')

foreach ($taskName in $tasks) {
  schtasks /query /tn $taskName *> $null
  if ($LASTEXITCODE -eq 0) {
    schtasks /end /tn $taskName *> $null      # 常驻任务需要先结束
    schtasks /delete /tn $taskName /f | Write-Host
    Write-Host "已删除计划任务：$taskName" -ForegroundColor Green
  } else {
    Write-Host "未找到计划任务：$taskName"
  }
}

# 清掉可能残留的常驻锁文件
$lock = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs\watch.lock'
if (Test-Path $lock) { Remove-Item $lock -Force; Write-Host '已清理 watch.lock' }
