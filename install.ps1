# 安装 WiFi 自动认证：注册计划任务
# 无需管理员权限，任务在当前用户会话中运行（WiFi 依赖用户会话）。
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# 会注册两个任务：
#   WiFi自动认证        —— 开机登录时 + 每 5 分钟兜底
#   WiFi自动认证-常驻   —— 登录后常驻，每 15 秒检查，掉线即补认证

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'WiFi自动认证'
$watchTaskName = 'WiFi自动认证-常驻'
$runScript = Join-Path $root 'run.ps1'
$runWatchScript = Join-Path $root 'run-watch.ps1'

foreach ($f in @($runScript, $runWatchScript)) {
  if (-not (Test-Path $f)) { throw "找不到脚本：$f" }
}

Write-Host "安装目录：$root"
Write-Host ''

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

function New-HiddenAction($scriptPath) {
  New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $root
}

# ==================================================================
# 任务 1：WiFi自动认证（一次性执行）
# ==================================================================
$triggers = @()

# 1) 登录时触发（脚本内部会自行等待 WiFi 就绪，无需额外延时）
$triggers += New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

# 2) 网络连接事件（保留；实测本机该触发器不一定生效，真正的保障是常驻任务）
$evtClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$t2 = New-CimInstance -CimClass $evtClass -ClientOnly
$t2.Enabled = $true
$t2.Subscription = @'
<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[EventID=10000]]</Select></Query></QueryList>
'@
$triggers += $t2

# 3) 每 5 分钟兜底（已联网时脚本立即退出，开销极小；也用于常驻任务意外退出时的兜底）
$triggers += New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action (New-HiddenAction $runScript) `
  -Trigger $triggers -Settings $settings -Principal $principal `
  -Description '连上校园网 WiFi 后自动完成门户认证登录' -Force | Out-Null

Write-Host "✅ 已注册：$taskName" -ForegroundColor Green

# ==================================================================
# 任务 2：WiFi自动认证-常驻（常驻监听，掉线即补）
# ==================================================================
$watchSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $watchTaskName -Action (New-HiddenAction $runWatchScript) `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
  -Settings $watchSettings -Principal $principal `
  -Description '常驻监听网络状态，WiFi 掉线后尽快自动补认证' -Force | Out-Null

Write-Host "✅ 已注册：$watchTaskName" -ForegroundColor Green

# 注意：本机 Get-ScheduledTask/Start-ScheduledTask 存在 CIM 读取缺陷（连系统任务都读不了），
# 因此统一改用 schtasks.exe。
Write-Host ''
schtasks /query /tn $taskName | Write-Host
schtasks /query /tn $watchTaskName | Write-Host

Write-Host '立即试跑一次常规任务…'
schtasks /run /tn $taskName | Out-Null
Start-Sleep -Seconds 10

Write-Host '启动常驻监听…'
schtasks /run /tn $watchTaskName | Out-Null
Start-Sleep -Seconds 5

Write-Host ''
Write-Host "日志目录：$root\logs"
Write-Host '  autologin-*.log  每次认证的详细过程'
Write-Host '  watch.log        常驻监听的启停记录'
Write-Host '  runner.log       常规任务是否被触发、退出码'
