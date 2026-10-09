# WiFi 自动认证 —— 常驻监听模式入口
# 由 install.ps1 注册的「WiFi自动认证-常驻」计划任务调用，登录后一直运行，
# 每 15 秒检查一次网络，掉线后尽快补认证。

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runnerLog = Join-Path $logDir 'watch.log'

function Write-Marker($msg) {
  try {
    Add-Content -Path $runnerLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding ASCII
  } catch {}
}

# 日志别长太大
if ((Test-Path $runnerLog) -and (Get-Item $runnerLog).Length -gt 2MB) {
  Move-Item -Force $runnerLog "$runnerLog.old"
}

$node = $null
foreach ($p in @('D:\tool\node.exe', "$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
  if (Test-Path $p) { $node = $p; break }
}
if (-not $node) {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c) { $node = $c.Source }
}
if (-not $node) {
  Write-Marker 'ERROR: node.exe not found'
  exit 1
}

Write-Marker 'watcher start'
Push-Location $root
& $node (Join-Path $root 'autologin.js') --watch
$code = $LASTEXITCODE
Pop-Location
Write-Marker "watcher exit $code"
exit $code
