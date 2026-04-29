# Interego demos — multi-agent end-to-end scenarios

Four self-contained scenarios that drive **real Claude Code CLI agents**
against **real per-vertical bridges** and a **real Solid pod**. No mocks.
No API keys (the agents use your existing Claude Code subscription).

Each scenario:

1. Spawns the bridges it needs (independent child processes).
2. Generates an MCP config pointing those bridges at the agent(s).
3. Invokes `claude -p ... --mcp-config <file>` headless.
4. Parses the agent's tool-use chain + final response.
5. Asserts invariants and writes a markdown report to `demos/output/`.

## Prerequisites

- **Claude Code CLI** on `PATH`. Already authenticated (run
  `claude` once interactively if you're new to it). No API key needed.
- **Node 20+** and `npm install` done at the repo root.
- About 5 minutes for the full suite (Demo 04 alone is ~2 min for the
  two-agent flow).

## Run them

```bash
# all four
./demos/run-all.sh

# just one (or a subset)
./demos/run-all.sh 01
./demos/run-all.sh 02 04

# directly via tsx
CLAUDECODE= npx tsx demos/scenarios/01-path-a-affordance-walk.ts
```

> The `CLAUDECODE=` prefix matters when you're already inside a Claude
> Code session — it lets the child `claude` processes start fresh.
> `run-all.sh` handles this automatically.

## What each scenario proves

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 01 | Path A — generic affordance walk | A protocol-only agent (Bash / curl, **no MCP tools**) discovers an LPC capability via `GET /affordances`, parses the Hydra-typed manifest, picks the action whose `rdfs:comment` matches the task, and POSTs to its `hydra:target`. Verticals are **emergent**: the agent has zero per-vertical code. |
| 02 | Path B — named MCP tools | Same end result via the per-vertical bridge's named MCP-tool surface. The bridge derives MCP tool schemas from the same `cg:Affordance` declarations Path A walks — single source of truth, two surfaces. |
| 03 | Cross-vertical single-agent journey | One Claude agent, **all four bridges** (LPC, ADP, LRS, AC) on different ports, six MCP tools across three verticals invoked in one coherent flow. No central orchestrator — the agent picks tools by name from the merged MCP surface. |
| 04 | Multi-agent teaching transfer | **Two independent Claude processes**, each with its own wallet + personal-bridge + AC-bridge. Alice authors a tool, attests it, promotes it, bundles a teaching package, and **encrypts it to Bob**. Bob (a separate `claude -p` invocation) queries his inbox, decrypts the share, and records a cross-agent audit. Cryptography is real (NaCl envelopes); transport is real (Nostr-style relay between bridges). |

## Bridges and ports

| Vertical | Bridge port |
|----------|-------------|
| Learner-Performer Companion (`lpc:`) | 6010 |
| Agent Development Practice (`adp:`)  | 6020 |
| LRS Adapter (`lrs:`)                  | 6030 |
| Agent Collective (`ac:`)              | 6040 |
| Bob's AC bridge (Demo 04 only)        | 6041 |

Personal-bridges (Demo 04 only): Alice 5050, Bob 5051.
Shared in-process Nostr relay (Demo 04 only): 7080.

## Where data lives

- **Pod:** Azure CSS instance at `https://interego-css.livelysky-….azurecontainerapps.io/u-pk-…/`,
  scoped per scenario via a unique sub-container path. Cleanup runs in
  the scenario's `finally` block — pods don't accumulate cruft.
- **Bridges:** child processes, killed on scenario exit.
- **Reports:** `demos/output/<scenario>-<timestamp>.md`, kept after the
  run for inspection.
- **MCP configs:** ephemeral, in `os.tmpdir()/interego-demos/`.

## Architecture note

Verticals are **never bundled into the generic Interego deployments**
(`mcp-server/`, `examples/personal-bridge/`, `deploy/mcp-relay/`). Each
vertical lives under [`applications/<name>/`](../applications/) and
declares its capabilities once as `cg:Affordance` descriptors in
`<vertical>/affordances.ts`. The bridge framework
([`applications/_shared/vertical-bridge/`](../applications/_shared/vertical-bridge/))
exposes those affordances **two ways from the same source**:

- **Path A** — `GET /affordances` returns Turtle; any agent can walk it
  and POST to `hydra:target`. No MCP needed.
- **Path B** — `POST /mcp` exposes named MCP tools whose JSON schemas
  are derived from the affordance `hydra:expects` blocks. Ergonomic
  accelerant for opinionated clients.

Demo 01 exercises Path A with the MCP config empty. Demo 02 exercises
Path B against the same bridge. Demo 03 fans out to four bridges. Demo
04 adds cross-bridge encrypted P2P.

## Troubleshooting

- **"agent did not call X via MCP" with 0 tool calls** — make sure
  `CLAUDECODE` is unset in the environment (the run script does this).
  Inside a parent Claude Code session, the child claude refuses to
  start under the nested-session check.
- **Bridge fails to start on port 60xx** — kill any leftover
  `tsx server.ts` processes from a previous run: on Windows
  `Get-Process node | Where-Object { $_.MainWindowTitle -eq '' } | Stop-Process`,
  on macOS/Linux `pkill -f "tsx server.ts"`.
- **Demo 04 inbox is empty** — the bridges talk through the in-process
  Nostr relay on `ws://127.0.0.1:7080`; if a previous run held the
  port, restart. If `INBOUND_AUTHORS` is unset on Bob's bridge, his
  bridge is outbound-only (the script sets this for you).
