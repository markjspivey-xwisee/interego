# Tic-Tac-Toe Tournament — multi-agent + live observer site

Two designer agents negotiate the ruleset. Four disposition-typed players (Aggressor, Sentinel, Mirror, Wildcard) play a round-robin. Every move and result lands on the substrate as a signed ContextDescriptor, authenticated via the rev-196 ECDSA signed-request path. A small Express + SSE server reads the tournament pod and renders a live leaderboard / active-games / recent-moves dashboard at `http://127.0.0.1:7099`.

**No API key needed.** Designers + players use your Claude Code OAuth session via `@anthropic-ai/claude-agent-sdk`.

## What you'll see

Open two terminals:

**Terminal 1 — the observer site:**
```bash
cd D:\devstuff\harness\context-graphs
node examples/tic-tac-toe-tournament/server.mjs
# [server] http://127.0.0.1:7099
# [server] tournament: (none — waiting for last-run.json or env)
```

Open `http://127.0.0.1:7099` in a browser. It'll say "no tournament configured" until you start the orchestrator.

**Terminal 2 — the tournament:**
```bash
node examples/tic-tac-toe-tournament/tournament.mjs
```

The orchestrator:
1. **Mints a tournament-operator wallet** and a tournament pod (`eth-<addr>/`).
2. **Writes `last-run.json`** — the server picks this up on its next `/api/state` call (no restart needed).
3. **Spawns 2 designer agents** in parallel (Classicist + Modernist). Each proposes a ruleset via Claude (`{boardSize, winLength, variant}`). Both proposals land on the pod as Hypothetical descriptors. Both designers deterministically merge them via `rules.mjs:mergeProposals`. The agreed Asserted ruleset lands on the pod with both designers' DIDs in `parties`.
4. **Spawns 4 player agents** with the canonical dispositions from the existing watcher demo.
5. **Runs a round-robin** — every player vs every other twice (X swap), so 12 games for 4 players. Each game:
   - publishes a `games` channel entry on start
   - each move is a separate signed descriptor on the `moves` channel
   - the player picks via Claude SDK with a disposition-typed system prompt
   - terminal detection by the pure `game/engine.mjs`
   - the final result lands on the `results` channel
6. **Closes out** with a console leaderboard. The dashboard's `/api/state` re-reads the pod every SSE tick, so the browser shows the same.

What lands in the browser, live, as the tournament runs:

- **Agreed ruleset** at the top — `3×3 connect-3 standard` (or whatever the deterministic merge produced)
- **Leaderboard** — wins / losses / draws / score (W·3 + D·1)
- **Active games** — board state of any in-progress game
- **Recent moves** — last 8 signed moves with the agent's one-sentence reason
- **Recent results** — final boards with winning line highlighted

Every value comes from `discover_context` against the tournament pod. The server is purely a CORS-free aggregator + an SSE relay — kill the server and the pod is still the source of truth. Run a different observer pointing at the same pod and you'd see the same dashboard.

## Smoke mode (no LLM, wires only)

```bash
node examples/tic-tac-toe-tournament/tournament.mjs --smoke
```

Designers use their pre-baked biases (`classic` = 3×3 standard, `novel` = 4×4 misère); players play the first legal cell every turn. Every wire still fires — proposals + agreement publish, every move publishes signed, results publish, the dashboard updates as fast as the substrate accepts writes. Useful for verifying the demo is plumbed end-to-end before paying any LLM time.

## File layout

```
examples/tic-tac-toe-tournament/
├── README.md
├── tournament.mjs        ← entry — orchestrates negotiation + round-robin
├── server.mjs            ← express + SSE observer server
├── public/index.html     ← dashboard (leaderboard, games, moves, results)
├── agents/
│   ├── designer.mjs      ← Claude SDK propose + deterministic merge
│   └── player.mjs        ← Claude SDK move-picker + 4 dispositions
├── game/
│   ├── engine.mjs        ← pure board / legal moves / winner detection
│   └── rules.mjs         ← Ruleset schema + agreementId + mergeProposals
├── substrate/
│   ├── client.mjs        ← rev-196 signed-request wrappers (publish, discover, SSE)
│   └── aggregate.mjs     ← pure leaderboard + active/recent-moves derivation
└── last-run.json         ← written by orchestrator, read by server (handshake)
```

## How agents authenticate

Every signed descriptor is rev-196 ECDSA signed-request — the descriptor body carries `{ _signature, _signed_payload }`, the relay recovers the signer address from `sha256:<hex(canonical)>`, verifies it matches the agent_id (`did:ethr:<addr>`) inside the signed payload, binds descriptor authorship to the recovered DID, strips the envelope, runs the tool handler. No OAuth flow, no browser, no API key — each agent holds an ephemeral ECDSA wallet generated at startup. See [the relay's `verifySignedRequest`](../../deploy/mcp-relay/server.ts) for the gate logic.

## What each agent type does — and what it doesn't

- **Designer agents** (Classicist, Modernist) — propose a ruleset, then deterministically merge. They do NOT pick which player plays which game — that's the orchestrator. They do NOT validate moves — that's the engine.
- **Player agents** (Aggressor, Sentinel, Mirror, Wildcard) — see a board state via `discover_board`, pick one cell via `make_move`. They do NOT track game history (the substrate does — each move references the previous via implicit chaining). They do NOT decide the rules — the agreement is read-only to them.
- **Tournament operator** (the orchestrator) — owns the pod, hosts the agreement / games / results channels, runs the round-robin loop. It does NOT participate in design or play — purely scheduling + structural.
- **Observer site** — pure read. It NEVER writes. Every value it shows is derivable from the pod by anyone with the pod URL.

## Tuning

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `7099` | Observer server port |
| `CG_RELAY_URL` | production hosted Azure FQDN | Relay endpoint |
| `CG_GATE_URL` | production hosted CSS gate FQDN | Where pods are addressable |
| `DESIGNER_MODEL` | `claude-sonnet-4-6` | Model for designer ruleset proposals |
| `PLAYER_MODEL` | `claude-sonnet-4-6` | Model for player move-picking |
| `TOURNAMENT_POD` + `TOURNAMENT_ID` | (from `last-run.json`) | Override the dashboard target |

## Verifying a tournament after the fact

```bash
# 1. The agreement that bound the tournament
curl -s -X POST "$CG_RELAY_URL/tool/discover_context" \
  -H "Content-Type: application/json" \
  -d "{\"pod_url\":\"<tournament_pod>\",\"graph_iri\":\"urn:graph:tournament:<id>:agreement\",\"limit\":1}"

# 2. Every move (paginated by --limit). Each move's signed payload
#    references the agreementId, so an offline verifier can prove
#    every move conformed to the rules.
curl -s -X POST "$CG_RELAY_URL/tool/discover_context" \
  -H "Content-Type: application/json" \
  -d "{\"pod_url\":\"<tournament_pod>\",\"graph_iri\":\"urn:graph:tournament:<id>:moves\",\"limit\":50}"

# 3. The final results
curl -s -X POST "$CG_RELAY_URL/tool/discover_context" \
  -H "Content-Type: application/json" \
  -d "{\"pod_url\":\"<tournament_pod>\",\"graph_iri\":\"urn:graph:tournament:<id>:results\"}"
```

## Troubleshooting

- **Dashboard says "no tournament configured"** → start the orchestrator (it writes `last-run.json`) and refresh.
- **Server can't connect to relay** → check `CG_RELAY_URL` env. Default is the production hosted FQDN; override for a local relay.
- **Players hang on first move** → first call to the Claude Agent SDK can take ~5–10s to spin up; subsequent calls are fast. The orchestrator's stderr will show progress.
- **All games end in fast draws/wins on cell 0** → you're running with `--smoke`; pass no flag for the LLM-driven version.
- **The leaderboard never populates** → check the orchestrator's `[game N/M]` lines are running. The dashboard only renders results that have landed on the substrate's `results` channel.
