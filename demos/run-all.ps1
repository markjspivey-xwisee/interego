# demos/run-all.ps1 — Windows PowerShell mirror of run-all.sh.
#
# Each scenario is independent: it spawns its own bridges, drives one
# or more real Claude Code CLI agents, then tears down. No shared
# state between scenarios.
#
# Requirements:
#   - claude CLI on PATH (npm i -g @anthropic-ai/claude-code, or via
#     the desktop / VS Code extension's bundled CLI)
#   - You're already authenticated with Claude Code (run `claude` once
#     interactively if not). No API key needed.
#   - Node 20+, the repo's `npm install` already done.
#   - Demo bridges' deps installed:
#       (cd demos/interego-bridge; npm install)
#       (cd applications/<vertical>/bridge; npm install) for each vertical
#
# Usage:
#   .\demos\run-all.ps1                # run all scenarios
#   .\demos\run-all.ps1 02 04          # run only specific scenarios
#   .\demos\run-all.ps1 -NoCleanup     # leave reports + temp configs
#
# Env: source demos/.env if present (so a runner can drop their
# DEMO_POD_OWNER / AZURE_CSS_BASE there without editing source).

param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Filters = @(),
    [switch]$NoCleanup
)

$ErrorActionPreference = 'Stop'

# Move to repo root (this script lives in demos/).
Set-Location (Join-Path $PSScriptRoot '..')

# Reset CLAUDECODE so child claude processes don't refuse to start
# (parent VS Code session sets CLAUDECODE=1 — defeating that here is
# safe because each child spawns an independent runtime).
$env:CLAUDECODE = ''

# Source demos/.env if it exists, so DEMO_POD_OWNER, AZURE_CSS_BASE
# etc are present without manual export.
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
    Write-Host "  (sourcing $envFile)"
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#' -or $line -match '^\s*$') { continue }
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $name = $Matches[1]
            $value = $Matches[2].Trim('"').Trim("'")
            Set-Item -Path "Env:$name" -Value $value
        }
    }
}

if ($NoCleanup) { $env:NO_CLEANUP = '1' }

$scenarios = @(
    '01-path-a-affordance-walk',
    '02-path-b-named-tools',
    '03-cross-vertical-user-journey',
    '04-multi-agent-teaching-transfer',
    '05-time-paradox-memory',
    '06-pgsl-pullback-two-diaries',
    '07-mind-merge-under-contention',
    '08-adversarial-cynefin-science',
    '09-citation-chain-refusal',
    '10-migration-mid-conversation',
    '11-three-regulators-one-pod',
    '12-three-model-variant-relay',
    '13-constitutional-democracy-live',
    '14-zk-confidence-without-disclosure',
    '15-organizational-working-memory',
    '16-self-evolving-tool-population',
    '17-regime-change-upward-downward-causation',
    '18-weak-signals-dispositional-shift',
    '19-substrate-enforced-regime-change',
    '20-socio-constructed-protocol-and-app',
    '21-federated-inquiry-emergent-paradigm',
    '22-game-design-build-play',
    '23-zero-copy-semantic-layer',
    '24-dual-audience-owm',
    '25-dual-audience-learning'
)

# Apply optional positional filters (e.g. "01" or "01 03 14"). Match
# by prefix so the user can pass either "01" or "01-path-a..." style.
if ($Filters.Count -gt 0) {
    $filtered = @()
    foreach ($arg in $Filters) {
        foreach ($s in $scenarios) {
            if ($s -like "$arg*") { $filtered += $s }
        }
    }
    if ($filtered.Count -gt 0) {
        $scenarios = $filtered
    }
}

# Preflight: confirm claude CLI is on PATH + responsive. Catches the
# most common silent-timeout failure (unauthenticated or missing claude).
try {
    $null = & claude --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "exit $LASTEXITCODE" }
} catch {
    Write-Host '═════════════════════════════════════════════════════════════════════' -ForegroundColor Yellow
    Write-Host '  Preflight FAILED: `claude --version` did not succeed.' -ForegroundColor Yellow
    Write-Host '  Install Claude Code: npm i -g @anthropic-ai/claude-code' -ForegroundColor Yellow
    Write-Host '  Authenticate once: run `claude` interactively to OAuth-handshake.' -ForegroundColor Yellow
    Write-Host '═════════════════════════════════════════════════════════════════════' -ForegroundColor Yellow
    exit 2
}

Write-Host '═════════════════════════════════════════════════════════════════════'
Write-Host '  Interego demo suite'
Write-Host '═════════════════════════════════════════════════════════════════════'
Write-Host ("  Running {0} scenario(s):" -f $scenarios.Count)
foreach ($s in $scenarios) { Write-Host "    - $s" }
Write-Host ''

$passed = @()
$failed = @()

foreach ($s in $scenarios) {
    Write-Host ''
    Write-Host '─────────────────────────────────────────────────────────────────────'
    Write-Host "  > $s"
    Write-Host '─────────────────────────────────────────────────────────────────────'
    & npx tsx "demos/scenarios/$s.ts"
    if ($LASTEXITCODE -eq 0) {
        $passed += $s
    } else {
        $failed += $s
    }
}

Write-Host ''
Write-Host '═════════════════════════════════════════════════════════════════════'
Write-Host '  Summary'
Write-Host '═════════════════════════════════════════════════════════════════════'
Write-Host ("  PASS ({0}):" -f $passed.Count)
foreach ($s in $passed) { Write-Host "    [ok]   $s" }
if ($failed.Count -gt 0) {
    Write-Host ("  FAIL ({0}):" -f $failed.Count) -ForegroundColor Red
    foreach ($s in $failed) { Write-Host "    [fail] $s" -ForegroundColor Red }
    exit 1
}
Write-Host ''
Write-Host '  Reports written to: demos/output/'
