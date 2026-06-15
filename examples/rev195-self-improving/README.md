# rev-195 self-improving demo

The comprehensive demo of the [harness-engineering](https://openai.com/index/harness-engineering/) + [recursive-self-improvement](https://www.anthropic.com/institute/recursive-self-improvement) + "I write loops" theses over the Interego rev-195 substrate.

Two entry points: a single-agent loop (`one.mjs`) and a multi-agent collective (`collective.mjs`). Both exercise every rev-195 primitive — substrate-native trajectory recording, the OODA decision functor, calibration-driven replan, SSE-driven wake, A2A teaching, and (in collective mode) a judge + reduce_chain replayable verdict — against the live deployed relay at `https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io`.

**No API key required.** The Claude calls go through your local Claude Code OAuth session via `@anthropic-ai/claude-agent-sdk`.

## What you'll see

Each tick prints:

```
[tick N] ───────────────────────────────────────────
[tick N] observe: 3 of my steps; peers=[beta]
[tick N] orient: implementationExists=false
[tick N] decide: strategy=explore → intervention=reference (nextAction=search-codebase)
[tick N] [REPLAN] reference → instruction: <calibration-evidence reasoning>     ← Tier-3 fired
[tick N] verify: FAIL (180ms)
```

When the deterministic verifier (`node --test`) goes green:

```
[tick K] verify: PASS (210ms)
[controller] GREEN at tick K — exiting loop
[one] verdict:       pass
[one] ticks:         K
[one] replanned:     YES (Tier-3 fired)
[one] descriptors:   N signed trajectory steps on agent's pod
```

In collective mode, the judge also scores both agents and posts a teach event:

```
[judge] alpha: correctness=0.85 reuse=0.40
[judge] beta:  correctness=0.85 reuse=0.92
[judge] rationale: beta reused alpha's reducer instead of rewriting; both pass
[teach] beta → alpha: transferred=true modalStatus=Asserted signalShare 0 → 1
```

## Prerequisites

- **Node 20+** (uses ESM, `node:test`, `node --test` flag).
- **Claude Code** signed in (`claude --version` must work). This is what supplies the LLM session — no `ANTHROPIC_API_KEY` needed.
- **The Interego relay is reachable** at the URL the script defaults to. Override with `CG_RELAY_URL` if running against a local relay.
- **`@anthropic-ai/claude-agent-sdk` + `zod` + `ethers`** in the workspace (the live mode imports them; smoke mode doesn't need the SDK).

Install once from the repo root:

```bash
cd D:\devstuff\harness\context-graphs
npm i --no-save @anthropic-ai/claude-agent-sdk zod ethers
```

## Run

### Single-agent live

```bash
cd D:\devstuff\harness\context-graphs
node examples/rev195-self-improving/one.mjs
```

Wall-clock ~3–5 min. The agent runs the loop until tests pass or 12 ticks have elapsed.

### Multi-agent live

```bash
node examples/rev195-self-improving/collective.mjs --agents alpha,beta
```

Wall-clock ~7–10 min. Each agent works in its own workspace subdir; SSE-driven wake means whichever publishes first kicks the other's controller.

### Smoke mode (no LLM, wires only)

The smoke flag swaps Claude out for a scripted writer. The demo still hits the live relay, still publishes signed trajectory steps, still consults the calibration profile, still posts the teach event — every wire is exercised, no tokens spent.

```bash
node examples/rev195-self-improving/one.mjs --smoke
node examples/rev195-self-improving/collective.mjs --smoke --agents alpha,beta
```

Both should print `verdict: pass` and complete in seconds.

## Which thesis each piece touches

| Component | OpenAI harness | Anthropic RSI | Cherny loops | Multi-agent |
|---|---|---|---|---|
| `controller.mjs` outer loop | repo-as-source-of-truth, depth-first decompose | — | developer writes the loop | — |
| `record_trajectory_step` per tick | feedback signals reach the agent | engineering work measured | durable external state | shared memory |
| `pgsl_decide` per tick | — | research half delegated to the substrate | substrate decides next prompt | lattice-meet across pods |
| `calibrationDrivenReplan` | stacked verifier signal | learns what works | autonomous re-route | reads peers' outcomes |
| Deterministic `node --test` | green-light gate | reviewers off the critical path | — | — |
| `llmJudge` (collective) | LLM verifier on top of deterministic | research-taste delegated | generator/evaluator split | cross-agent scoring |
| SSE-driven wake | feedback the moment it lands | reactive loop | push wake-up | event-bus across pods |
| `/agent/teach` (collective) | — | capability transfer, attested | tools over rigid workflow | A2A teaching |
| `reduce_chain` verdict | replayable audit | content-addressed evidence | durable proof | third-party replayable |

## File layout

```
examples/rev195-self-improving/
├── README.md             ← this file
├── task.json             ← the engineering task fixture
├── controller.mjs        ← outer loop (Cherny: I write loops)
├── one.mjs               ← single-agent entry
├── collective.mjs        ← multi-agent entry + judge + teach
├── tick.mjs              ← one OODA tick (observe → orient → decide → act → verify → maybe-replan)
├── tools.mjs             ← substrate-client wrappers (relay HTTP)
├── verifiers.mjs         ← deterministic test runner + LLM judge
├── profile.mjs           ← calibration profile read + Tier-3 replan helper
└── workspace/            ← scratch dir the agent writes its implementation into
    └── tests/
        └── modalDistribution.test.mjs
```

## The task

> Implement `modalDistribution(input: string) => { Asserted, Hypothetical, Counterfactual, other, total }` that counts the `modalStatus` field across a stream of newline-separated JSON descriptors. Malformed JSON lines must be skipped without crashing; unknown / missing modal statuses count as `other`.

Five tests pin the contract (see `workspace/tests/modalDistribution.test.mjs`). Small, deterministic, self-contained. The collective entry rewards reuse over rewrite — `beta` can read `alpha`'s implementation via the `read_peer_implementation` MCP tool before writing its own, and the judge picks that up.

## Tuning

| Env var | Default | What |
|---|---|---|
| `CG_RELAY_URL` | `https://interego-relay.livelysky-...` | Where to send substrate calls. |
| `CG_GATE_URL` | `https://interego-css-gate.livelysky-...` | Where agent pods live (CSS gate). |
| `FOXXI_BRIDGE_URL` | `https://interego-foxxi-bridge.livelysky-...` | Where calibration + teach calls go. |
| `AGENT_MODEL` | `claude-sonnet-4-6` | Model the worker agents use. |
| `JUDGE_MODEL` | `claude-sonnet-4-6` | Model the collective judge uses. |
| (none — `--smoke` flag) | off | Run scripted-write mode; verifies wires without an LLM. |

## What to verify after a run

```bash
# 1. The agent's pod has fresh trajectory descriptors describing
#    urn:graph:trajectory:<agentSlug>
curl -s "https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/tool/discover_context" \
  -H "Content-Type: application/json" \
  -d '{"pod_url":"<from agent.did>","graph_iri":"urn:graph:trajectory:<agentSlug>","sort":"newest-first","limit":5}'

# 2. The Foxxi calibration profile shows a fresh OutcomeRecord
curl -s -X POST "https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/performance/calibration" \
  -H "Content-Type: application/json" -d '{}' | jq '.body.profile.totalSamples'

# 3. (Collective) the teach descriptor lives on Foxxi's tenant pod
#    — check the response from collective.mjs for "fetchAttestation"
```

## Troubleshooting

- **`@anthropic-ai/claude-agent-sdk` not found** → run the `npm i --no-save` from the repo root above. Smoke mode (`--smoke`) doesn't need it.
- **`fetch failed` on first call** → `CG_RELAY_URL` is unreachable. Check `curl -sI <relay-url>/.well-known/oauth-authorization-server`.
- **Controller hangs in collective mode** → SSE subscription may not be wakeable from your network; set `sseEnabled: false` in `collective.mjs` and re-run (the polling fallback kicks in).
- **Verifier always FAILs** → check `workspace/modalDistribution.mjs` was written by the agent; if it wasn't, the smoke mode script will help isolate whether it's the SDK or the verifier path.
