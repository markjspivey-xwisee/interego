# @interego/openclaw-memory

OpenClaw memory-engine plugin backed by Interego pods.

## What this is

Path 2 of the [agent-runtime-integration](../../docs/integrations/agent-runtime-integration.md)
map. Where Path 1 (the MCP server) gives the LLM Interego tools to
*choose* to call, this plugin replaces OpenClaw's memory-engine slot
entirely — every `memory_store`, `memory_recall`, and `memory_forget`
operation flows through the substrate transparently.

## Architecture

Two layers:

* `src/bridge.ts` — **substrate-pure**. Async functions that compose
  Interego primitives (`publish`, `discover`, `cg:supersedes`): the
  memory trio (`storeMemory`, `recallMemories`, `forgetMemory`) plus the
  HATEOAS navigation pair (`discoverContexts`, `followAffordance`) and
  the `affordancesFor` decorator. No OpenClaw imports. Reusable by any
  runtime.

* `src/plugin.ts` — **OpenClaw glue**. Calls
  `api.registerMemoryCapability(...)` to claim the exclusive
  `plugins.slots.memory` slot, registers the fixed five-tool surface
  (see below), and (when configured) subscribes to OpenClaw's
  `before_prompt_build` and `after_assistant_response` hooks for
  auto-recall / auto-capture.

## Reaching the whole substrate without tool bloat (HATEOAS)

The plugin registers **exactly five tool schemas, and it never grows**:
`memory_store` / `memory_recall` / `memory_forget` (the slot contract)
plus `interego_discover` / `interego_act` (navigation). The substrate
has far more capability than five operations — but the agent does not
carry it as a flat tool list.

Every result from `memory_recall` / `interego_discover` is decorated
with an `affordances` list — self-describing `{action, target,
descriptorUrl, hint}` records, gated by the agent's delegation `scope`,
naming exactly what it can do with that item. The agent acts by passing
one to `interego_act` (→ `followAffordance`). Capability **travels as
data**, not as preloaded tools: new substrate capability shows up as a
new affordance verb in a result — never a new tool schema, never extra
context cost. This is the same HATEOAS shape as the Hermes provider.

Full rationale: [`docs/integrations/openclaw-full-substrate.md`](../../docs/integrations/openclaw-full-substrate.md).

## Substrate guarantees

Every memory write is a typed `cg:ContextDescriptor` with:

* **Agent + Trust facets** — wallet-rooted DID, self-asserted at publish
  time. Peer attestations land via the existing AC vertical's flow.
* **Provenance facet** — PROV-O `wasAttributedTo` (owner) +
  `wasAssociatedWith` (agent). Audit-walkable.
* **Temporal facet** — `validFrom = now`. Backdating / scheduling
  available via the bridge's optional args.
* **Semiotic facet** — `Asserted` (committed facts, the default) /
  `Hypothetical` (inferences) / `Counterfactual` (retractions — what
  `forgetMemory` and the `retract` affordance publish).

What you get for free, by composition:

* `cg:supersedes` — every revised fact links back to its predecessor;
  no destructive overwrites.
* Signed authorship — pod-side wallet signature on save.
* Federated discovery — `discover_all` / `subscribe_to_pod` work
  unchanged.
* Multi-axis attestation — `amta:` review axes (correctness, safety,
  efficiency, generality) attach to memories the same way they attach
  to tools, decisions, or skills. The substrate doesn't care.
* Compliance overlay — pass `compliance: true` + a framework citation
  to `publish_context` directly when the runtime decides the write is
  audit-grade.

## Install (when you have a live OpenClaw)

```bash
npm install @interego/openclaw-memory
openclaw plugin install @interego/openclaw-memory \
  --config '{"podUrl": "https://your-pod.example/me/", "agentDid": "did:web:your-pod.example"}'
```

OpenClaw will read `openclaw.plugin.json` and surface the five tools
(`memory_store` / `memory_recall` / `memory_forget` / `interego_discover`
/ `interego_act`) to the agent. Built-in OpenClaw memory engines are
disabled while this plugin holds the slot.

## Use directly without OpenClaw

The bridge is substrate-pure — you can import it from any runtime:

```typescript
import {
  storeMemory, recallMemories, discoverContexts, followAffordance,
} from '@interego/openclaw-memory/bridge';

const config = {
  podUrl: 'https://your-pod.example/me/',
  authoringAgentDid: 'did:web:your-pod.example',
  scope: 'ReadWrite' as const, // gates which affordances results carry
};

await storeMemory(
  { text: 'Bob prefers async standups', kind: 'preference', tags: ['team:beta'] },
  config,
);

// Recall — each hit is decorated with `affordances`.
const hits = await recallMemories({ query: 'standup', limit: 5 }, config);

// HATEOAS: follow an affordance the result handed you.
const derive = hits[0]?.affordances.find(a => a.action === 'derive');
if (derive) {
  await followAffordance({ affordance: derive, content: 'Bob now prefers daily standups' }, config);
}
```

Same for Hermes, Codex, Cursor, Claude Code — anywhere you want pod-
rooted typed memory but don't have an OpenClaw-shaped plugin slot.

## Honest scoping

* The plugin glue (`plugin.ts`) is written against the
  documented OpenClaw plugin SDK shape (sdk-overview, memory-lancedb,
  memory-honcho). Exact TypeScript signatures may differ in the live
  SDK; match them at integration time. The bridge functions are stable.
* Substrate-side recall is **structural** (kind / tags / modal status
  / keyword-in-text). Semantic / vector ranking is the runtime's job —
  pass top-K candidates through your embedding model after this
  returns. The runtimes that adopt this plugin already do that.
* `forgetMemory` (and the `retract` affordance) is **a retraction, not
  a delete** — it publishes a `Counterfactual` descriptor that
  supersedes the target. The original descriptor + graph stay on the
  pod; an auditor walking `cg:supersedes` can reach them. For GDPR-style
  erasure, do that separately at the pod's storage layer.
* Cross-pod **E2EE share** (`shareWith` / `defaultShareWith`) is *not*
  applied by the direct bridge — `publish()`'s encryption path needs a
  sender X25519 keypair the substrate-pure bridge does not hold. Encrypted
  share is routed through the relay's `publish_context` `share_with`
  argument (the relay holds the keypair). The fields stay in the API for
  that path; the direct bridge publishes plaintext to the pod (pod ACLs
  still apply).
* `followAffordance` dispatches the verbs `read` / `derive` / `retract`
  / `challenge` / `annotate` / `forward` — a scope-gated subset of the
  substrate's `AffordanceAction` set that composes cleanly with the
  bridge's one-shot primitives. `subscribe` is intentionally absent (a
  long-lived operation, driven through OpenClaw's hook mechanism).

## See also

* [`docs/integrations/openclaw-full-substrate.md`](../../docs/integrations/openclaw-full-substrate.md)
  — reaching all of Interego from OpenClaw via HATEOAS, in full
* [`docs/integrations/agent-runtime-integration.md`](../../docs/integrations/agent-runtime-integration.md)
  — the five integration paths
* [`docs/integrations/agent-runtimes-mcp.md`](../../docs/integrations/agent-runtimes-mcp.md)
  — Path 1: the lighter MCP-server route
* [`integrations/hermes-memory/`](../hermes-memory/) — the sibling
  Hermes provider; same HATEOAS shape, different transport
