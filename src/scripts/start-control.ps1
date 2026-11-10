param(
  [string]$DataDirectory = (Join-Path $env:USERPROFILE '.aiws/control'),
  [int]$Port = 4317,
  [switch]$Desktop
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules'))) {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
  }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  $env:AIWS_CONTROL_DATA_DIR = $DataDirectory
  $env:AIWS_CONTROL_PORT = [string]$Port
  if ($Desktop) { & npm run desktop:start }
  else { & node dist/cli/index.js control serve --data-dir $DataDirectory --port $Port }
  if ($LASTEXITCODE -ne 0) { throw "Control exited with code $LASTEXITCODE." }
} finally { Pop-Location }
