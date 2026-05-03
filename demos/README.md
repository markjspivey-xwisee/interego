# Interego demos — eighteen end-to-end scenarios

Self-contained scenarios that drive **real Claude Code CLI agents**
against **real per-vertical bridges**, a **real Solid pod** (Azure CSS),
and **real cryptography**. No mocks. No API keys (the agents use your
existing Claude Code subscription).

Each scenario:

1. Spawns the bridges it needs (independent child processes).
2. Generates an MCP config pointing those bridges at the agent(s).
3. Invokes `claude -p ... --mcp-config <file>` headless, sometimes
   with a specific `--model`, sometimes in parallel.
4. Parses the agent's tool-use chain + final response.
5. Asserts invariants and writes a markdown report to `demos/output/`.

## Prerequisites

- **Claude Code CLI** on `PATH`, already authenticated. No API key needed.
- **Node 20+** and `npm install` done at the repo root.
- Demo bridges installed:
  ```bash
  (cd demos/interego-bridge && npm install)
  (cd applications/learner-performer-companion/bridge && npm install)
  (cd applications/agent-development-practice/bridge && npm install)
  (cd applications/lrs-adapter/bridge && npm install)
  (cd applications/agent-collective/bridge && npm install)
  (cd examples/personal-bridge && npm install)
  ```
- ~25 minutes for the full suite (longest single demo is Demo 04 at
  ~120s; most are 30–90s).

## Run them

```bash
# all fourteen
./demos/run-all.sh

# subset
./demos/run-all.sh 01
./demos/run-all.sh 02 04
./demos/run-all.sh 05 06 07

# directly via tsx
CLAUDECODE= npx tsx demos/scenarios/14-zk-confidence-without-disclosure.ts
```

> The `CLAUDECODE=` prefix matters when you're already inside a Claude
> Code session — it lets the child `claude` processes start fresh.
> `run-all.sh` handles this automatically.

## What each demo proves

### Foundation: protocol + verticals (01–04)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 01 | [Path A — generic affordance walk](scenarios/01-path-a-affordance-walk.ts) | A protocol-only agent (Bash / curl, no MCP tools) discovers an LPC capability via `GET /affordances`, parses the Hydra-typed manifest, and POSTs to its `hydra:target`. Verticals are emergent: zero per-vertical code at the agent. |
| 02 | [Path B — named MCP tools](scenarios/02-path-b-named-tools.ts) | Same end result via the per-vertical bridge's named MCP-tool surface. The bridge derives MCP tool schemas from the same `cg:Affordance` declarations Path A walks — single source of truth, two surfaces. |
| 03 | [Cross-vertical single-agent journey](scenarios/03-cross-vertical-user-journey.ts) | One agent, **all four bridges** (LPC, ADP, LRS, AC) on different ports, six MCP tools across three verticals invoked in one coherent flow. No central orchestrator. |
| 04 | [Multi-agent teaching transfer](scenarios/04-multi-agent-teaching-transfer.ts) | Two independent claude processes with their own wallets + personal-bridges + AC-bridges. Alice authors a tool, attests, promotes, bundles a teaching package, and **encrypts it to Bob**. Bob queries his inbox, decrypts, and audits. Real NaCl cryptography over a shared in-process Nostr relay. |

### Belief & truth dynamics (05, 06)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 05 | [Time-paradox memory](scenarios/05-time-paradox-memory.ts) | A Hypothetical claim collapses to Counterfactual via `cg:supersedes`. The agent's *current* view of a claim is the head of the supersedes chain; older descriptors remain on the pod (audit trail) but no longer represent live belief. The substrate makes belief revision legible without coordination. |
| 06 | [PGSL pullback of two diaries](scenarios/06-pgsl-pullback-two-diaries.ts) | Two agents independently log meeting events as PGSL atoms. Atoms are content-addressed: identical content → identical IRI. `pgsl_meet` at the atom layer is set intersection — not fuzzy match, not LLM mediation. "Agreement" between Alice and Bob is structural, recoverable from the lattice itself. |

### Algebra of context (07, 11)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 07 | [Mind-merge under contention](scenarios/07-mind-merge-under-contention.ts) | Five agents write to the SAME pod manifest in parallel. The HTTP If-Match guard in `publish()` (retry-on-412 with jittered backoff) makes every write durable. The "merge" is the union of perspectives the manifest now holds — no coordinator, no lock, no lost descriptor. |
| 11 | [One pod, three regulators](scenarios/11-three-regulators-one-pod.ts) | Three regulator agents (SOC 2, EU AI Act, NIST RMF) query the same pod in parallel, each with its framework's IRI prefix. Each gets back exactly its slice of evidence — no rewriting, no per-framework data store. The substrate IS the audit trail; the framework is the lens. |

### Adversarial / scientific (08)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 08 | [Adversarial Cynefin science](scenarios/08-adversarial-cynefin-science.ts) | Two agents in a Popperian falsification loop. Agent A proposes a Hypothetical probe with an explicit dampening trigger (the falsification criterion) **before** B observes anything. Agent B records narrative fragments matching the trigger. Agent A's synthesis surfaces ≥2 coherent narratives — the spec structurally blocks single-narrative silent collapse. The substrate enforces honest science. |

### Cryptographic showpiece (09, 14)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 09 | [Cryptographic citation chain refusal](scenarios/09-citation-chain-refusal.ts) | Bob refuses to amplify any cited claim whose secp256k1 signature does not verify against Alice's expected key. Catches both content tampering (claim mutated) and signature tampering (signature byte-flipped). No trust authority — pure cryptography + a recipient agent willing to refuse on bad inputs. |
| 14 | [Knowledge-without-disclosure (commit + reveal)](scenarios/14-zk-confidence-without-disclosure.ts) | Alice publishes a hash commitment to a sensitive claim before disclosing it. Bob receives a selective reveal and verifies the commitment opens to the stated text. Carol receives a tampered reveal — same commitment, mutated claim — and `verifyCommitment` fails because H no longer matches. Auditable fingerprints + selective disclosure + tamper detection from L1 + crypto. |

### Substrate as product (15)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 15 | [Organizational working memory](scenarios/15-organizational-working-memory.ts) | A "company memory" surface (people, projects, decisions, follow-ups, content-addressed notes) recoverable from the substrate's primitives alone, plus a per-source navigation pattern that isolates external sources behind uniform `ls / cat / grep / recent` verbs. A Curator agent distills an external page into typed entities; a separate Surfacer agent — different process, no shared memory — recovers state from the org pod alone. |

### Self-evolving agentics (16, 17)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 16 | [Self-evolving tool population](scenarios/16-self-evolving-tool-population.ts) | Five claude processes — a four-agent Generation 1 plus one Generation 2 — produce a Darwinian tool population. Each Gen-1 agent authors a different variant; each cross-evaluates the other three across rotating amta axes. The substrate's promotion rule is a deterministic function of the resulting attestation set: aggregate ≥ threshold AND axes_covered ≥ 2. The winner emerges from arithmetic; in dry runs the *substrate has refused promotion* of the highest-scoring variant when its attestations clustered on a single axis — protocol-enforced epistemic humility that no agent or harness designed for. Generation 2 receives the teaching package and authors a refined successor whose `cg:supersedes` chain points back at the Gen-1 winner. The capability frontier moved without anyone outside the loop redesigning the agents. |
| 17 | [Constitutional regime change — upward + downward causation](scenarios/17-regime-change-upward-downward-causation.ts) | Eleven claude processes traverse a complete causal loop across four emergent layers. **Upward** (L1 → L2 → L3): Population A authors tools under regime R0; five voters propose and vote on amendment R1 ("tools may only be promoted if their attestations include the safety axis"); the per-amendment vote tally crosses the tier-3 threshold, triggering ratification — a binary phase transition emerging from continuous accumulation. **Downward** (L3 → L4 → L1): Population B (3 new agents) reads the ratified regime from the pod, recognizes that the Population-A attestation pattern would violate R1, and adapts by adding the safety axis BEFORE promoting. Their action is shaped by a higher-level structure that emerged from their peers' votes. **Loop closure**: the adaptation produces new lower-level actions (additional safety attestations) that re-enter the trust graph; tools that would otherwise have been refused promotion now succeed. Both directions of causation are recoverable from the pod alone — the substrate is the shared medium through which both flow. |
| 18 | [Weak signals → adjacent possible → dispositional shift → realignment](scenarios/18-weak-signals-dispositional-shift.ts) | Five claude processes plus harness aggregation exercise the four complexity-aware ontology shapes added to close `ARCHITECTURAL-FOUNDATIONS.md` §9: `wks:WeakSignal`, `wks:Reinforcement`, `sat:Disposition` (with `weakSignal` / `shiftedBy` / `dampedBy`), `cgh:isAdjacentPossibleTo`, and `cgh:RealignmentMeasure`. Four observers each publish an independent weak-signal Hypothetical descriptor pointing at the same phenomenon (codegen-agent post-deploy drift); the substrate's structural-sharing relation makes their reinforcement count a SPARQL query, not a consensus protocol. A sensemaker agent — different process, no shared memory — produces a typed disposition with candidate weak-signal / shift / damp interventions AND a typed adjacent-possible reachability claim (Hypothetical, with `cgh:reachabilityRationale`). The harness computes a `cgh:RealignmentMeasure` over the run's events-per-window. Verification confirms every named ontology shape appears on the pod; the substrate makes the dynamics of meaning legible (reinforcement, reachability, disposition, rate) without claiming any of them are settled. |

### Identity & democracy (10, 12, 13)

| # | Scenario | What it demonstrates |
|---|----------|----------------------|
| 10 | [Migration mid-conversation](scenarios/10-migration-mid-conversation.ts) | Same agent identity, same value commitment, two pods, two processes. A passport (JSON object holding stated values + life events + registry references) is sufficient to bind the agent's behavior across infrastructure migration. Phase B inherits ONLY the passport from Phase A — no in-memory state — and still honors the value commitment. |
| 12 | [Three-model-variant relay](scenarios/12-three-model-variant-relay.ts) | Three claude processes (`--model opus` / `sonnet` / `haiku`) attest the same tool through Interego's AC vertical. Different SKUs, different parameter counts, different costs — no shared memory. Substituting non-Anthropic agents in any of the three slots is mechanical (the only requirement is MCP support). |
| 13 | [Constitutional democracy live](scenarios/13-constitutional-democracy-live.ts) | Five voter agents cast votes in parallel on a Tier-3 amendment; ratification is a deterministic function of the tally and the tier rule. No central coordinator, no broadcast, no shared memory — per-voter DID dedup keeps the tally honest under retries. Self-amending policy machinery from L1 primitives. |

## Architecture

### Bridges and ports

| Bridge | Used by | Port |
|--------|---------|------|
| Learner-Performer Companion (`lpc-bridge`) | 01, 02, 03 | 6010 |
| Agent Development Practice (`adp-bridge`)  | 03, 08      | 6020 |
| LRS Adapter (`lrs-bridge`)                  | 03          | 6030 |
| Agent Collective (`ac-bridge`)              | 03, 04, 12  | 6040 |
| Bob's AC bridge (Demo 04)                   | 04          | 6041 |
| Generic interego-bridge (`interego-bridge`) | 05, 06, 07, 09, 10, 11, 13, 14 | 6050–6053 |
| Organizational Working Memory (`owm-bridge`) | 15         | 6060 |
| Personal-bridge (Alice)                     | 04          | 5050 |
| Personal-bridge (Bob)                       | 04          | 5051 |
| Shared Nostr relay (Demo 04 only)           | 04          | 7080 |

### Two reachability paths

Every vertical capability is reachable two ways from the same source:

- **Path A** — `GET /affordances` returns Turtle; any agent can walk
  it and POST to `hydra:target`. No MCP needed.
- **Path B** — `POST /mcp` exposes named MCP tools whose JSON schemas
  are derived from the affordance `hydra:expects` blocks. Ergonomic
  accelerant for opinionated clients.

The generic [`demos/interego-bridge/`](interego-bridge/) is a separate
HTTP MCP surface used by demos 5–7, 9–11, 13–14. It exposes
protocol-level operations (publish, discover, get_descriptor, PGSL
mint/meet, ZK commit/verify, secp256k1 sign/verify, constitutional
propose/vote/ratify). It is **not** part of the production deployment
surface — production's generic surface is the stdio
[`mcp-server/`](../mcp-server/). The HTTP variant exists so the demo
harness can drive multiple parallel agent processes uniformly without
fighting stdio.

### Where data lives

- **Pod:** Azure CSS at `https://interego-css.livelysky-….azurecontainerapps.io/u-pk-…/`,
  scoped per scenario via a unique sub-container path. Cleanup runs
  in the scenario's `finally` block — pods don't accumulate cruft.
- **Bridges:** child processes, killed on scenario exit.
- **Reports:** `demos/output/<scenario>-<timestamp>.md`, kept after
  the run for inspection. Gitignored.
- **MCP configs:** ephemeral, in `os.tmpdir()/interego-demos/`.

### Honest scoping

A few demos compromise on purity for tractability. We say so:

- **Demo 12** uses three Anthropic model variants (opus / sonnet /
  haiku) instead of three model families (Anthropic / OpenAI / Gemini).
  Adding non-Anthropic models is mechanical (any MCP-speaking agent
  works) but requires additional provider keys.
- **Demo 14** uses commitment-and-reveal rather than the half-stub
  range proof in `src/crypto/zk/proofs.ts` (`verifyConfidenceProof`
  currently checks lengths only, not the hash chain). Commit-and-
  reveal is rigorously verified by `verifyCommitment`, so it
  exercises real crypto end-to-end.
- **Demos 5, 6, 7, 11, 13, 14** use the demo-scoped HTTP wrapper
  bridge ([`demos/interego-bridge/`](interego-bridge/)) instead of
  the production stdio mcp-server. The same TS modules
  (`src/solid/client.ts`, `src/pgsl/`, `src/crypto/zk/`,
  `src/constitutional/`) underlie both surfaces.

## Troubleshooting

- **"agent did not call X via MCP" with 0 tool calls** — make sure
  `CLAUDECODE` is unset in the environment (`run-all.sh` does this).
  Inside a parent Claude Code session, the child claude refuses to
  start under the nested-session check.
- **Bridge fails to start on port 60xx** — kill leftover bridges from
  a previous failed run:
  ```bash
  # Windows
  netstat -ano | findstr ":6050 :6051 :6052 :6053"
  # then taskkill /F /PID <pid>
  # macOS / Linux
  lsof -i :6050 -i :6051 -i :6052 -i :6053
  pkill -f "tsx server.ts"
  ```
  Demo cleanup uses `proc.kill('SIGTERM')` then `SIGKILL` after
  1.5–2s, but on Windows `npx → tsx → node` doesn't always propagate
  SIGTERM cleanly to the inner node. Repeated failed runs accumulate.
- **Demo 04 inbox empty** — bridges talk through the in-process Nostr
  relay on `ws://127.0.0.1:7080`; if a previous run held the port,
  restart. The script sets `INBOUND_AUTHORS=<alice-pubkey>` on Bob's
  bridge automatically (default is outbound-only).
- **Demo 11 reports "14 descriptors"** — pod sub-container is being
  reused. Stop any stale bridge process on port 6052 and re-run.
