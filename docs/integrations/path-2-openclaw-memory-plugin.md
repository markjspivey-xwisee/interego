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
  `recallMemories`, `forgetMemory`). No OpenClaw imports. Reusable by
  any runtime; this is the contract.
* **`plugin.ts`** — OpenClaw glue that calls
  `api.registerMemoryCapability(...)`, registers tools, and wires the
  `before_prompt_build` / `after_assistant_response` hooks.

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
* Optional E2EE share via `share_with`
* `cg:supersedes` for revisions (and the `forgetMemory` API uses
  Counterfactual + supersedes — never destructive delete)
* Cross-pod federation via `discover_all` / `subscribe_to_pod`
* Multi-axis attestation via `amta:` (the same flow that attests
  tools and skills attests memories)

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
* [Path 1 — MCP server](agent-runtimes-mcp.md)
* [Path 3 — skills as affordances](path-3-skills-as-affordances.md)
* [Path 4 — compliance overlay](path-4-compliance-overlay.md)
