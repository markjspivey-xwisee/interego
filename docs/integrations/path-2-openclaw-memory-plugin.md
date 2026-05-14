# Path 2 — OpenClaw memory-engine plugin

> Path 2 of [agent-runtime-integration.md](agent-runtime-integration.md).
> Tighter than Path 1 (the MCP server): the plugin claims OpenClaw's
> exclusive `plugins.slots.memory` slot, so every memory write flows
> through Interego transparently — no LLM discretion required.

## What this is

OpenClaw exposes a documented memory-engine plugin slot. Built-in
options include the local SQLite engine, the Honcho service, and the
LanceDB vector store. The
[`@interego/openclaw-memory`](../../integrations/openclaw-memory/)
package implements the same slot — backed by Interego pods.

Two layers, deliberately separated:

* **`bridge.ts`** — substrate-pure functions (`storeMemory`,
  `recallMemories`, `forgetMemory`, plus the HATEOAS navigation pair
  `discoverContexts` / `followAffordance` and the `affordancesFor`
  decorator). No OpenClaw imports. Reusable by any runtime; this is the
  contract.
* **`plugin.ts`** — OpenClaw glue that calls
  `api.registerMemoryCapability(...)`, registers the fixed five-tool
  surface, and wires the `before_prompt_build` /
  `after_assistant_response` hooks.

## What it gains over Path 1

Path 1 surfaces Interego tools to the LLM, which decides when to call
them. That's loose coupling — fine for many cases.

Path 2 is tighter:

* `memory_store` / `memory_recall` / `memory_forget` calls *always*
  go to the substrate, not the LLM's idea of where to write.
* OpenClaw's auto-recall / auto-capture loops fire substrate calls
  by default — every turn produces a typed descriptor.
* The plugin claims the exclusive memory slot; the local SQLite
  engine, Honcho, LanceDB are off (or coexisting via composition,
  per OpenClaw's `memory-wiki` companion pattern).

## What composes for free

Same as Path 1 — every memory write is a typed descriptor with:

* Agent + Trust + Provenance + Temporal + Semiotic facets
* `cg:supersedes` for revisions (and `forgetMemory` publishes a
  Counterfactual that supersedes — never a destructive delete)
* Cross-pod federation via `discover_all` / `subscribe_to_pod`
* Multi-axis attestation via `amta:` (the same flow that attests
  tools and skills attests memories)

## Reaching the whole substrate without tool bloat (HATEOAS)

The plugin registers a **fixed five-tool surface** — `memory_store`,
`memory_recall`, `memory_forget` (the slot contract) plus
`interego_discover` and `interego_act` — and it never grows. The
substrate has far more capability than five operations, but the agent
does not carry it as a flat list.

Every result from `memory_recall` / `interego_discover` is decorated
with an `affordances` list — self-describing `{action, target,
descriptorUrl, hint}` records, gated by the agent's delegation scope,
naming what it can do with that item. The agent acts by passing one to
`interego_act`. Capability **travels as data**: new substrate capability
shows up as a new affordance verb in a result, never a new tool schema,
never extra context cost. This is the same HATEOAS shape as the Hermes
provider — full rationale in
[openclaw-full-substrate.md](openclaw-full-substrate.md).

## Use

```bash
npm install @interego/openclaw-memory
openclaw plugin install @interego/openclaw-memory \
  --config '{"podUrl": "https://your-pod.example/me/", "agentDid": "did:web:your-pod.example"}'
```

The bridge module is also importable from any other runtime — Hermes,
Codex, Cursor, Claude Code:

```typescript
import { storeMemory, recallMemories } from '@interego/openclaw-memory/bridge';
```

## See also

* [`integrations/openclaw-memory/`](../../integrations/openclaw-memory/)
  — the package itself
* [openclaw-full-substrate.md](openclaw-full-substrate.md) — reaching
  *all* of Interego from OpenClaw via the 5-tool HATEOAS surface
* [Path 5 — Hermes memory provider](path-5-hermes-memory-provider.md) —
  the same shape, against Hermes Agent's interface
* [Path 1 — MCP server](agent-runtimes-mcp.md)
* [Path 3 — skills as affordances](path-3-skills-as-affordances.md)
* [Path 4 — compliance overlay](path-4-compliance-overlay.md)
