# Start the holodeck.
#
#   .\examples\holodeck\bin\start.ps1
#   open http://127.0.0.1:7200

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host '═══════════════════════════════════════════════════════════════════'
Write-Host '  Holodeck — Interego multi-agent control room'
Write-Host '═══════════════════════════════════════════════════════════════════'
Write-Host ''
Write-Host '  identities:  examples\holodeck\.holodeck\identities\'
Write-Host '  loops:       examples\holodeck\.holodeck\loops\'
Write-Host '  run history: examples\holodeck\.holodeck\runs\'
Write-Host ''
Write-Host '  dashboard:   http://127.0.0.1:7200'
Write-Host ''
Write-Host '  Stop: Ctrl+C'
Write-Host ''

& node server.mjs
