# PourGateLLM installer for Windows (needs Node >= 22.13).
#   irm https://raw.githubusercontent.com/xX-VyrnCore-Xx/PourGateLLM/main/install/install.ps1 | iex
# To pick a version:  $env:POURGATE_VERSION = '0.1.1'  before running.
$ErrorActionPreference = 'Stop'
$Repo = 'xX-VyrnCore-Xx/PourGateLLM'
$Version = if ($env:POURGATE_VERSION) { $env:POURGATE_VERSION } else { 'latest' }
$Root = if ($env:POURGATE_HOME) { $env:POURGATE_HOME } else { Join-Path $env:USERPROFILE '.pourgate' }
$BinDir = Join-Path $Root 'bin'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.13 or newer is required: https://nodejs.org' }
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if ($LASTEXITCODE -ne 0) { throw "Node $(node -v) is too old: 22.13 or newer is required" }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw 'tar.exe is required (included in Windows 10 1803 and later)' }

if ($Version -eq 'latest') {
  $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
}
$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Invalid version: $Version" }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("pourgate-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "Downloading PourGateLLM $Version..."
  $Archive = Join-Path $Tmp 'pg.tar.gz'
  Invoke-WebRequest "https://github.com/$Repo/releases/download/v$Version/pourgatellm-$Version.tar.gz" -OutFile $Archive

  # Replace the application; data and config.env in $Root are kept.
  $App = Join-Path $Root 'app'
  if (Test-Path $App) { Remove-Item $App -Recurse -Force }
  New-Item -ItemType Directory -Path $App, $BinDir -Force | Out-Null
  tar -xzf $Archive -C $App --strip-components=1
  if (-not (Test-Path (Join-Path $App 'bin\pourgate.mjs'))) { throw 'This release has no launcher (bin\pourgate.mjs); use a newer version.' }
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$Shim = "@echo off`r`nset ""POURGATE_HOME=$Root""`r`nnode ""$App\bin\pourgate.mjs"" %*`r`n"
Set-Content -Path (Join-Path $BinDir 'pourgate.cmd') -Value $Shim -Encoding ASCII

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', "$UserPath;$BinDir", 'User')
  Write-Host "Added $BinDir to your PATH (open a new terminal)."
}
Write-Host "Installed PourGateLLM $Version to $Root"
Write-Host "Start it with:  pourgate start   (first run prints your dashboard password and API token)"
