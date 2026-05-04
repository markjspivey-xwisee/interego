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

* `src/bridge.ts` — **substrate-pure**. Three async functions
  (`storeMemory`, `recallMemories`, `forgetMemory`) that compose
  Interego primitives (`publish`, `discover`, `cg:supersedes`). No
  OpenClaw imports. Reusable by any runtime.

* `src/plugin.ts` — **OpenClaw glue**. Calls
  `api.registerMemoryCapability(...)` to claim the exclusive
  `plugins.slots.memory` slot, registers the three tools, and (when
  configured) subscribes to OpenClaw's `before_prompt_build` and
  `after_assistant_response` hooks for auto-recall / auto-capture.

## Substrate guarantees

Every memory write is a typed `cg:ContextDescriptor` with:

* **Agent + Trust facets** — wallet-rooted DID, self-asserted at publish
  time. Peer attestations land via the existing AC vertical's flow.
* **Provenance facet** — PROV-O `wasAttributedTo` (owner) +
  `wasAssociatedWith` (agent). Audit-walkable.
* **Temporal facet** — `validFrom = now`. Backdating / scheduling
  available via the bridge's optional args.
* **Semiotic facet** — `cg:Hypothetical` (default for inferences) /
  `cg:Asserted` (for committed facts) / `cg:Counterfactual` (for
  retracted).
* **Optional E2EE envelopes** — per-publish `share_with` recipients;
  no infrastructure change.

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

OpenClaw will read `openclaw.plugin.json` and surface the three tools
to the agent. Built-in OpenClaw memory engines are disabled while this
plugin holds the slot.

## Use directly without OpenClaw

The bridge is substrate-pure — you can import it from any runtime:

```typescript
import { storeMemory, recallMemories } from '@interego/openclaw-memory/bridge';

const config = {
  podUrl: 'https://your-pod.example/me/',
  authoringAgentDid: 'did:web:your-pod.example',
};

await storeMemory(
  { text: 'Bob prefers async standups', kind: 'preference', tags: ['team:beta'] },
  config,
);

const hits = await recallMemories({ query: 'standup', limit: 5 }, config);
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
* `forgetMemory` is **a retraction, not a delete**. The original
  descriptor + graph stay on the pod; an auditor walking
  `cg:supersedes` can reach them. For GDPR-style erasure, do that
  separately at the pod's storage layer.

## See also

* [`docs/integrations/agent-runtime-integration.md`](../../docs/integrations/agent-runtime-integration.md)
  — the four integration paths
* [`docs/integrations/agent-runtimes-mcp.md`](../../docs/integrations/agent-runtimes-mcp.md)
  — Path 1: the lighter MCP-server route
