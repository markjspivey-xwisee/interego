@echo off
:: demos/run-all.cmd — Windows batch equivalent of run-all.sh.
::
:: Native Windows path for users without WSL. Same semantics as
:: run-all.sh: spawns each scenario sequentially, captures pass/fail,
:: reports a summary at the end.
::
:: Requirements:
::   - claude CLI on PATH (npm i -g @anthropic-ai/claude-code)
::   - Already authenticated (run `claude` once interactively)
::   - Node 20+ and `npm install` done at the repo root
::
:: Usage:
::   demos\run-all.cmd                       run all 23 scenarios
::   demos\run-all.cmd 01 02                 run only scenarios 01 + 02
::   demos\run-all.cmd 22                    run only Demo 22
::
:: Notes for Windows users:
::   - Demos use `npx tsx` so no build step is needed; tsx loads .ts directly.
::   - On Windows, treeKill (in demos/agent-lib.ts) uses `taskkill /T /F`
::     to terminate the npx-tsx-node process chain. SIGTERM alone
::     wouldn't propagate to the inner node process.
::   - If port 6050+ is held by a stale process, run:
::       powershell -Command "Get-NetTCPConnection -State Listen -LocalPort 6050,6051,6052,6053,6062,6063,6064,6065"
::     then `taskkill /T /F /PID <pid>` for any holders.

setlocal EnableDelayedExpansion
cd /d "%~dp0\.."

:: Reset CLAUDECODE so spawned `claude` processes start independent
:: runtimes rather than inheriting the parent VS Code session's flag.
set "CLAUDECODE="

set "SCENARIOS=01-path-a-affordance-walk 02-path-b-named-tools 03-cross-vertical-user-journey 04-multi-agent-teaching-transfer 05-time-paradox-memory 06-pgsl-pullback-two-diaries 07-mind-merge-under-contention 08-adversarial-cynefin-science 09-citation-chain-refusal 10-migration-mid-conversation 11-three-regulators-one-pod 12-three-model-variant-relay 13-constitutional-democracy-live 14-zk-confidence-without-disclosure 15-organizational-working-memory 16-self-evolving-tool-population 17-regime-change-upward-downward-causation 18-weak-signals-dispositional-shift 19-substrate-enforced-regime-change 20-socio-constructed-protocol-and-app 21-federated-inquiry-emergent-paradigm 22-game-design-build-play 23-zero-copy-semantic-layer"

:: Optional positional filter — if any args given, only run scenarios
:: whose name starts with that prefix.
set "FILTERED="
if not "%~1"=="" (
    for %%s in (%SCENARIOS%) do (
        for %%a in (%*) do (
            set "name=%%s"
            set "prefix=%%a"
            :: Match by leading 2 characters (scenario number)
            if "!name:~0,2!"=="!prefix:~0,2!" set "FILTERED=!FILTERED! %%s"
        )
    )
    if not "!FILTERED!"=="" set "SCENARIOS=!FILTERED!"
)

echo =====================================================================
echo   Interego demo suite (Windows native)
echo =====================================================================
set "COUNT=0"
for %%s in (%SCENARIOS%) do set /a COUNT+=1
echo   Running %COUNT% scenario(s)
echo.

set "PASSED="
set "FAILED="

for %%s in (%SCENARIOS%) do (
    echo.
    echo ---------------------------------------------------------------------
    echo   ^> %%s
    echo ---------------------------------------------------------------------
    call npx tsx "demos\scenarios\%%s.ts"
    if errorlevel 1 (
        set "FAILED=!FAILED! %%s"
    ) else (
        set "PASSED=!PASSED! %%s"
    )
)

echo.
echo =====================================================================
echo   Summary
echo =====================================================================
if not "!PASSED!"=="" (
    echo PASS:
    for %%s in (!PASSED!) do echo     ^+ %%s
)
if not "!FAILED!"=="" (
    echo FAIL:
    for %%s in (!FAILED!) do echo     - %%s
    echo.
    echo   Reports written to: demos\output\
    exit /b 1
)
echo.
echo   Reports written to: demos\output\
endlocal
exit /b 0
