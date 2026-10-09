# WiFi 自动认证 —— 计划任务调用入口
# 由 install.ps1 注册的计划任务调用，也会被开机/联网事件触发。
#
# 说明：日志由 node 自己写入 logs\autologin-YYYY-MM-DD.log（UTF-8，内容完整）。
# 本脚本只额外写 ASCII 标记行，避免 Windows PowerShell 5.1 重定向时的编码转换问题。

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runnerLog = Join-Path $logDir 'runner.log'

function Write-Marker($msg) {
  try { Add-Content -Path $runnerLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding ASCII } catch {}
}

# ---- 定位 node.exe ----
$node = $null
$preferred = @(
  'D:\tool\node.exe',
  "$env:ProgramFiles\nodejs\node.exe",
  "${env:ProgramFiles(x86)}\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)
foreach ($p in $preferred) { if (Test-Path $p) { $node = $p; break } }
if (-not $node) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $node = $c.Source }
}
if (-not $node) {
  Write-Marker 'ERROR: node.exe not found'
  exit 1
}

# 日志别长太大：超过 2MB 就滚动一次
if ((Test-Path $runnerLog) -and (Get-Item $runnerLog).Length -gt 2MB) {
  Move-Item -Force $runnerLog "$runnerLog.old"
}

$script = Join-Path $root 'autologin.js'
Write-Marker 'start'

Push-Location $root
& $node $script
$code = $LASTEXITCODE
Pop-Location

Write-Marker "exit $code"

# ---- 看门狗：常驻监听还活着吗？挂了就拉起来 ----
# 常驻进程用 127.0.0.1:9334 做单例锁，端口在监听就说明它还活着。
$watcherAlive = $false
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $client.Connect('127.0.0.1', 9334)
  $watcherAlive = $client.Connected
  $client.Close()
} catch {
  $watcherAlive = $false
}

if (-not $watcherAlive) {
  Write-Marker 'watchdog: watcher not running, restarting'
  schtasks /run /tn 'WiFi自动认证-常驻' 2>&1 | Out-Null
}

exit $code
