# Start the gateway with an optional tunnel mode (Windows equivalent of start.sh).
#   .\scripts\start.ps1
#   .\scripts\start.ps1 --tunnel ngrok
param(
  [string]$Tunnel
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if ($Tunnel) {
  $env:TUNNEL = $Tunnel
}
$mode = if ($env:TUNNEL) { $env:TUNNEL } else { 'local' }
if (@('local', 'cloudflare', 'tailscale', 'ngrok') -notcontains $mode) {
  throw "invalid TUNNEL=$mode — expected local|cloudflare|tailscale|ngrok"
}

if (-not (Test-Path 'server/dist/index.js')) {
  Write-Host 'server not built — running npm run build first'
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "starting FreeLLMAPI with TUNNEL=$mode"
npm start
exit $LASTEXITCODE
