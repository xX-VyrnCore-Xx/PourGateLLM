# Removes the PourGateLLM CLI installed by install.ps1 (Windows).
#   pourgate uninstall            (or)   powershell -File uninstall.ps1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install/uninstall.ps1))) -Purge
# Parameters: -Purge  also delete your data and config (database, provider keys, master key, config.env)
#             -Yes    do not ask for confirmation
# By default your data and config are KEPT, so a later reinstall picks up where you left off.
param([switch]$Purge, [switch]$Yes)
$ErrorActionPreference = 'Stop'

$Root = if ($env:POURGATE_HOME) { $env:POURGATE_HOME } else { Join-Path $env:USERPROFILE '.pourgate' }
$Root = [IO.Path]::GetFullPath($Root)
if ($Root -eq [IO.Path]::GetPathRoot($Root) -or $Root -eq $env:USERPROFILE) { throw "Refusing to use '$Root' as the PourGateLLM directory" }
if (-not (Test-Path $Root)) { Write-Host "Nothing to remove: $Root does not exist."; return }

$BinDir = Join-Path $Root 'bin'
$App = Join-Path $Root 'app'

$PortNum = 3000
$Config = Join-Path $Root 'config.env'
if (Test-Path $Config) {
  $m = Select-String -Path $Config -Pattern '^PORT=(\d+)' | Select-Object -First 1
  if ($m) { $PortNum = [int]$m.Matches[0].Groups[1].Value }
}
$Running = $false
try { Invoke-WebRequest "http://127.0.0.1:$PortNum/health" -TimeoutSec 2 -UseBasicParsing | Out-Null; $Running = $true } catch { }
if ($Running) { throw "A PourGateLLM server is still running on port $PortNum. Stop it first (Ctrl+C in its window, or 'pourgate service uninstall' if it runs as a task), then run this again." }

Write-Host 'This will remove:'
if (Test-Path $BinDir) { Write-Host "  - command   $BinDir (and its PATH entry)" }
if (Test-Path $App) { Write-Host "  - program   $App" }
if ($Purge) { Write-Host "  - ALL DATA  $Root  (database, stored provider keys, master key, config.env)" }
else { Write-Host "It will KEEP your data and config in $Root (use -Purge to delete them too)." }

if (-not $Yes) {
  $answer = Read-Host 'Continue? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled.'; return }
}

# Stop and remove the auto-start task, if one was installed.
schtasks /Query /TN PourGateLLM *> $null
if ($LASTEXITCODE -eq 0) {
  schtasks /End /TN PourGateLLM *> $null
  schtasks /Delete /TN PourGateLLM /F *> $null
  Write-Host 'Removed the PourGateLLM scheduled task.'
}

# Drop the PATH entry we added.
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath) {
  $kept = ($UserPath -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $BinDir.TrimEnd('\')) }
  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}

if (Test-Path (Join-Path $App 'bin\pourgate.mjs')) { Remove-Item $App -Recurse -Force }
if (Test-Path $BinDir) { Remove-Item $BinDir -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $Root 'install.json') -Force -ErrorAction SilentlyContinue
if ($Purge) {
  Remove-Item $Root -Recurse -Force
  Write-Host 'PourGateLLM and all its data were removed.'
} else {
  Write-Host "PourGateLLM was removed. Your data is still in $Root."
}
