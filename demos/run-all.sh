#!/usr/bin/env bash
# demos/run-all.sh — execute every demo scenario in sequence.
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
#
# Usage:
#   ./demos/run-all.sh                # run all four scenarios
#   ./demos/run-all.sh 02 04          # run only specific scenarios
#   ./demos/run-all.sh --no-cleanup   # leave reports + temp configs

set -e

cd "$(dirname "$0")/.."

# Reset CLAUDECODE so child claude processes don't refuse to start
# (parent VS Code session sets CLAUDECODE=1 — defeating that here is
# safe because each child spawns an independent runtime).
export CLAUDECODE=

scenarios=(
  "01-path-a-affordance-walk"
  "02-path-b-named-tools"
  "03-cross-vertical-user-journey"
  "04-multi-agent-teaching-transfer"
)

# Optional filter — accept positional args like "01" or "01 03"
if [ "$#" -gt 0 ]; then
  filtered=()
  for arg in "$@"; do
    case "$arg" in
      --no-cleanup) NO_CLEANUP=1 ;;
      *)
        for s in "${scenarios[@]}"; do
          [[ "$s" == ${arg}* ]] && filtered+=("$s")
        done
        ;;
    esac
  done
  if [ "${#filtered[@]}" -gt 0 ]; then
    scenarios=("${filtered[@]}")
  fi
fi

echo "═════════════════════════════════════════════════════════════════════"
echo "  Interego demo suite"
echo "═════════════════════════════════════════════════════════════════════"
echo "  Running ${#scenarios[@]} scenario(s):"
for s in "${scenarios[@]}"; do echo "    - $s"; done
echo

passed=()
failed=()

for s in "${scenarios[@]}"; do
  echo
  echo "─────────────────────────────────────────────────────────────────────"
  echo "  ▶ ${s}"
  echo "─────────────────────────────────────────────────────────────────────"
  if npx tsx "demos/scenarios/${s}.ts"; then
    passed+=("$s")
  else
    failed+=("$s")
  fi
done

echo
echo "═════════════════════════════════════════════════════════════════════"
echo "  Summary"
echo "═════════════════════════════════════════════════════════════════════"
echo "  PASS (${#passed[@]}):"
for s in "${passed[@]}"; do echo "    ✓ $s"; done
if [ "${#failed[@]}" -gt 0 ]; then
  echo "  FAIL (${#failed[@]}):"
  for s in "${failed[@]}"; do echo "    ✗ $s"; done
  exit 1
fi
echo
echo "  Reports written to: demos/output/"
