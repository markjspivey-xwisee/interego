# Persistent Agent Loop

**Audience:** integrators wiring a runtime (always-on bridge, plugin worker, OS-cron, in-session loop) to keep an Interego agent doing useful work between user turns.

**TL;DR.** This document is a reference *composition*, not a new feature. The substrate already has every primitive needed for an agent to wake up, look around its pods, decide, act, and record what changed. This page shows how to glue those primitives into the canonical loop, and how each runtime in the agent ecosystem mounts that loop on its own scheduler.

If you find yourself wanting to invent a new MCP tool, a new `iep:` / `ieh:` term, or a new `LifeEventKind` to make this loop work — stop. The point of the pattern is that everything it needs already exists.

---

## What this composes — and nothing else

The loop is the assembly of five things already in the tree:

| Primitive | Location | Role in the loop |
|---|---|---|
| `verifyAgentDelegation(agentId, podUrl)` / `readAgentRegistry(podUrl)` | [`src/solid/client.ts`](../src/solid/client.ts) | Confirm the runtime is still allowed to act on the user's behalf before doing anything. |
| `subscribe(podUrl, callback)` (drains an internal `notificationLog`) | [`src/solid/client.ts`](../src/solid/client.ts) | Held-open WebSocket for push delivery of `ContextChangeEvent` from the pod. |
| `discover_all({ since, ... })` | [`mcp-server/server.ts`](../mcp-server/server.ts) | Pull-mode fallback when push isn't available (sleeping laptop, OS-cron runtime, mobile bridge). |
| OODA cycle — `observe(descriptors)` → `orient(profile, state)` (builds the affordance cache) → `decide(desires)` → `act(action, target, outcome)` | [`src/affordance/engine.ts`](../src/affordance/engine.ts) | The deliberation step. Same engine the in-session agent uses; the loop just feeds it pod-derived inputs. |
| `publish(descriptor, graphContent, podUrl, options)` — with optional `encrypt` envelope for cross-pod sharing | [`src/solid/client.ts`](../src/solid/client.ts) | Outbound writes that the loop produces. |
| `executeTransaction(txn)` — saga with `forwardAction` + `compensatingAction` per step | [`src/transactions/index.ts`](../src/transactions/index.ts) | Wraps multi-pod writes; on first failure walks committed steps in reverse and runs compensations. |
| `recordHeartbeatTickIfChanged(passport, outcomes)` | [`src/passport/heartbeat.ts`](../src/passport/heartbeat.ts) | One honest `LifeEvent` on the agent's `Passport` iff the tick was biographically significant. Uses existing kinds — `infrastructure-migration`, `registry-registration`, `milestone` — and the existing `recordLifeEvent` appender. |

No new tools. No new ontology terms. No new event kinds. The `Passport` shape, the saga shape, the OODA shape, and the subscription shape are all unchanged.

---

## The canonical loop

In prose: at each tick the runtime verifies it still has delegation, drains whatever the pod has surfaced since last tick (push if available, pull otherwise), runs one OODA cycle, performs any writes through the saga primitive so partial failures compensate cleanly, then records a single `LifeEvent` *if and only if* something biographically significant happened. Uneventful ticks are dropped on the floor — no version bump, no log noise.

In pseudo-code:

```ts
async function tick(ctx: LoopContext): Promise<void> {
  // 1. Are we still allowed to act on the user's behalf?
  const ok = await verifyAgentDelegation(ctx.agentId, ctx.podUrl);
  if (!ok) {
    ctx.passport = recordHeartbeatTickIfChanged(ctx.passport, { delegationRevoked: true });
    return; // stop acting; let the runtime decide whether to retry
  }

  // 2. Observe — drain push, or fall back to pull
  const events = ctx.subscription
    ? drainNotificationLog(ctx.subscription)             // src/solid/client.ts
    : await discoverAll({ since: ctx.lastTickAt, pods: ctx.knownPods });

  // 3. OODA — same engine the in-session agent runs
  const oriented = orient(ctx.profile, observe(ctx.state, events));
  const decision = decide(oriented, ctx.desires);

  // 4. Act — if any write crosses a pod boundary, wrap it as a saga
  const outcomes: HeartbeatOutcomes = {};
  if (decision.intendsWrite) {
    const txn = buildTransaction(decision);              // forward + compensate per step
    const result = await executeTransaction(txn);        // src/transactions/index.ts
    if (result.state === 'Committed') {
      outcomes.transactionsExecuted = [txn.id];
      outcomes.publishedDescriptors = result.committedSteps
        .map(s => s.publishedDescriptor)
        .filter(Boolean);
    }
  }

  // 5. Biography — one LifeEvent iff something changed
  ctx.passport = recordHeartbeatTickIfChanged(ctx.passport, outcomes);
  ctx.lastTickAt = new Date().toISOString();
}
```

`recordHeartbeatTickIfChanged` is the cheap predicate + appender that keeps the passport honest. The empty-outcomes case returns the passport unchanged, so the version counter only advances when there is real biography to record (see the module header in [`src/passport/heartbeat.ts`](../src/passport/heartbeat.ts) for the rationale).

---

## Built-in resilience: withTransientRetry + loadAgentKeypair

Two pieces of plumbing the loop relies on are worth knowing about because they remove boilerplate that every runtime would otherwise reinvent. Neither adds a protocol primitive — they are network and identity helpers the substrate uses internally.

**Transient retry is automatic.** The network calls in the loop — `subscribe`, `discover_all`, `publish`, `fetchGraphContent` — are wrapped in `withTransientRetry` inside the client. Callers don't need to add their own retry loop. The schedule is 4 attempts with exponential backoff (~1 s, 2 s, 4 s, 8 s; ~15 s total ceiling), and it triggers on the classes of failure that are worth retrying: `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_CONNECT*`, `UND_ERR_SOCKET*`, `fetch failed`, and 5xx responses. Non-transient errors (4xx other than 412, malformed responses, signature failures) bypass the retry and surface immediately. The existing manifest 412 CAS retry in `publish` composes through the same helper, so all retry paths are consistent. Lives in [`src/solid/retry.ts`](../src/solid/retry.ts).

**A stable agent identity is one call.** Most persistent runtimes want the same wallet across restarts so the agent's pod-rooted identity survives the loop being relaunched. `loadAgentKeypair` is the canonical place to ask for it:

```ts
const me = loadAgentKeypair({ envVar: 'MY_AGENT_KEY', label: 'agent' });
// me.wallet — ethers Wallet
// me.did    — did:key:<lower(address)>#agent
// me.address — 0x…
// me.source — 'env' | 'ephemeral'
```

If the env var holds a `0x`-prefixed 64-hex private key, the helper imports it; otherwise it mints a fresh wallet and returns `source: 'ephemeral'`. The helper itself is silent — the caller decides whether an ephemeral identity is worth a `console.warn` (always-on bridges usually want the warning; one-shot OS-cron processes usually don't). Lives in [`src/passport/wallet.ts`](../src/passport/wallet.ts).

---

## Per-runtime mountings

Every runtime below mounts the *same* canonical loop. What changes is the scheduler, the channel for push notifications, and the failure mode when the host is suspended.

### personal-bridge (always-on, reference implementation)

- **Scheduler:** `setInterval` in the long-running Node process.
- **Push channel:** holds `subscribe(podUrl, …)` open at startup for every pod in the known-pod list; tick consumes whatever the WebSocket has buffered into `notificationLog`.
- **Cadence:** 60 s default. The subscription does the heavy lifting; the interval exists to drive OODA and the heartbeat appender.
- **Where it lives:** the bridge binary in [`examples/personal-bridge/server.ts`](../examples/personal-bridge/server.ts). It is the reference shape — all the other runtimes are variations.

### OpenClaw

- **Scheduler:** plugin worker thread with `setInterval`, owned by the memory-engine plugin (Path 2 in [`docs/integrations/agent-runtime-integration.md`](integrations/agent-runtime-integration.md)).
- **Push channel:** when the worker process can hold a socket, `subscribe()` on the user's pod; otherwise it falls back to `discover_all({ since })`.
- **Cadence:** 60 s default, matching the bridge.
- **Notes:** the OpenClaw plugin already routes `memory_store` / `memory_recall` through the substrate. The loop just keeps that pathway warm between explicit memory calls — picking up federated updates the user produced from a different surface.

### Hermes Agent

- **Scheduler:** Hermes' `sync_turn` for the in-turn write, plus a background worker for between-turn ticks.
- **Push channel:** the same `subscribe()` if Hermes' worker can hold a socket; otherwise periodic `discover_all({ since })`.
- **Cadence:** 60 s background worker; `sync_turn` is event-driven by the chat.
- **Notes:** the memory-graph shape is identical to the OpenClaw plugin (Path 5). Two runtimes ticking on one pod converge through `iep:supersedes` chains — no extra coordination needed.

### Claude Code

- **Scheduler:** `CronCreate` for wall-clock recurrence between sessions (the cron survives the session ending); `Monitor` for in-session loops where the user wants the agent to watch something live.
- **Push channel:** `subscribe()` while the session is open; cron-fired ticks use `discover_all({ since })`.
- **Cadence:** 5 min for `CronCreate` (OS-style), sub-minute for `Monitor` polling cheap local state.
- **Notes:** `CronCreate` invocations are short-lived processes — they do one tick and exit. Hold no subscription; pull only.

### OpenAI Codex CLI

- **Scheduler:** OS-level cron on macOS / Linux, Task Scheduler on Windows.
- **Push channel:** none. Pull-only via `discover_all({ since })`.
- **Cadence:** 5 min minimum (OS schedulers don't enjoy sub-minute jobs).
- **Notes:** the CLI is invoked, ticks once, writes through `executeTransaction`, appends a heartbeat if warranted, exits. The `since` cursor must be persisted across invocations — store it on the pod itself if no local state is available.

### Cursor / Windsurf / Cline

- **Scheduler:** a parallel personal-bridge running on the same machine.
- **Push channel:** the bridge holds `subscribe()`; the editor talks to the bridge over MCP.
- **Cadence:** 60 s on the bridge; the editor doesn't tick at all.
- **Notes:** treat the editor as a thin MCP client. The bridge is where the loop lives. Multiple editors on one machine share one bridge.

### ChatGPT and Claude.ai

- **Scheduler:** a parallel always-on bridge (personal-bridge or operator-hosted equivalent).
- **Push channel:** the bridge holds `subscribe()`; the web client reads what the bridge has already written.
- **Cadence:** 60 s on the bridge.
- **Notes:** the chat client has no opportunity to run a background loop in the browser — the bridge does it on the user's behalf. When the chat next opens, `discover_context` surfaces whatever the bridge has been doing in the meantime.

---

## Cadence guidance

- **60 s** is the right default for any always-on runtime (personal-bridge, OpenClaw worker, Hermes background, Cursor-side bridge). The subscription does most of the work; the interval is just there to drive OODA and the heartbeat appender.
- **5 min** is the right default for OS-cron and `CronCreate` style runtimes. Schedulers above the process don't enjoy sub-minute jobs and the marginal value of more frequent pull-mode polling is low.
- **Sub-minute** ticks are only appropriate for cheap local checks — for instance, draining `notificationLog` on a held-open subscription, or polling a local file. Don't run sub-minute `discover_all` against remote pods; the federation cost is not worth it.

When in doubt, pick the slower cadence and rely on the push subscription to surface anything urgent in between ticks.

---

## Principle integrity

The loop preserves the four invariants the substrate is built on. Each invariant maps to a concrete thing the loop does (or refuses to do):

1. **No new primitives.** The loop is `verifyAgentDelegation` + `subscribe` / `discover_all` + the OODA engine + `publish` + `executeTransaction` + `recordHeartbeatTickIfChanged`. Every name in that list already exists in the tree. No new MCP tool is introduced, no new `iep:`/`ieh:` term, no new `LifeEventKind`. If a runtime needs the heartbeat to express a new biographical fact, the right move is to map it onto the existing kinds (`infrastructure-migration`, `registry-registration`, `milestone`), not to extend the ontology — see the kind-selection comment in [`src/passport/heartbeat.ts`](../src/passport/heartbeat.ts).
2. **Storage stays zero-trust.** The loop reads and writes only through `publish` and `subscribe` (and the MCP tools that wrap them). Both already encrypt private content via NaCl envelopes with recipient-wrapped X25519 keys. The pod server sees only ciphertext for private graphs; the loop adds nothing to that path.
3. **Federation stays cryptographic.** Cross-pod writes go through `executeTransaction`, where each step's `targetPod` is reached over the same federation primitives the substrate already uses — signed publishes, envelope-encrypted graphs, no membership service. There is no central broker the loop calls out to.
4. **Identity stays portable.** `verifyAgentDelegation` resolves against the user's pod-rooted agent registry (`auth-methods.jsonld` and friends). Pod migration during a tick is a first-class outcome — `recordHeartbeatTickIfChanged` records it as an `infrastructure-migration` `LifeEvent` and the loop keeps running against the new pod URL. No identifier is minted by the loop itself; the `Passport`'s `agentIdentity` is the only canonical handle.

If a change to the loop would violate any of these, the change is wrong — not the invariant.

---

## Composition with sagas and replay

When a tick crosses more than one pod (cross-pod review, multi-party agreement, capability acquisition), wrap the writes in `executeTransaction`. Compensating actions run in reverse order on first failure; both `forwardAction` and `compensatingAction` must be idempotent. The transaction descriptor on the coordinator's pod records every step's state so an interrupted tick can be picked up on the next one.

The replay convention — how a long-lived loop notices a `iep:TxnPending` transaction it owns and resumes it — lives in [`spec/FEDERATED-TRANSACTIONS.md`](../spec/FEDERATED-TRANSACTIONS.md) (see *Failure modes* and the *Reference runtime* section). Resumed transactions are surfaced through `HeartbeatOutcomes.transactionsResumed`, which `recordHeartbeatTickIfChanged` already understands.

---

## See also

- [`docs/integrations/agent-runtime-integration.md`](integrations/agent-runtime-integration.md) — how each runtime mounts the MCP; the persistent loop is the in-process companion to those integration paths.
- [`docs/AGENT-INTEGRATION-GUIDE.md`](AGENT-INTEGRATION-GUIDE.md) — what to put in your system prompt so the agent uses the substrate well during a turn.
- [`docs/AGENT-PLAYBOOK.md`](AGENT-PLAYBOOK.md) — the WHEN-to-use-what guide the in-session agent loads on demand.
- [`spec/FEDERATED-TRANSACTIONS.md`](../spec/FEDERATED-TRANSACTIONS.md) — saga shape, isolation levels, failure modes, the replay convention referenced above.
- [`src/passport/heartbeat.ts`](../src/passport/heartbeat.ts) — the predicate + appender; reusing existing `LifeEventKind` values is intentional, not a TODO.
