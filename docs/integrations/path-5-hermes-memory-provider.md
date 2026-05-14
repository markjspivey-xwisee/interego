# Path 5 — Hermes Agent memory provider

> Path 5 of [agent-runtime-integration.md](agent-runtime-integration.md).
> The same tightness as Path 2 (OpenClaw), against Hermes Agent's own
> external-memory-provider plugin interface. Every memory Hermes keeps
> also becomes a verifiable, federated, portable record on an Interego
> pod — no LLM discretion required.

## Why this path matters

Hermes Agent (Nous Research, Feb 2026) is, by adoption, the agent
runtime that matters: ~140k GitHub stars in under three months and the
most-used agent on OpenRouter. Its whole pitch is *"the agent that grows
with you"* — persistent memory, auto-generated skills, a deepening model
of who you are.

It grows all of that into one `~/.hermes` directory on one machine
(`MEMORY.md`, `USER.md`, `state.db` with FTS5). That is the seam.

Hermes ships an **external memory provider plugin interface** — and
already has eight third-party providers (Honcho, Mem0, Supermemory,
…). Interego is the ninth, and the only one that is **verifiable +
federated + portable-identity**. The others add vector search or fact
extraction *to* a local store. Interego changes *what the store is*: a
pod the user owns, with cryptographic provenance and cross-agent
federation, that outlives the machine and even Hermes itself.

The strategic position is not "use Interego *instead of* Hermes." Hermes
is the runtime; it has the channels (Telegram / Discord / Slack /
WhatsApp / Signal / Email / CLI), the learning loop, the skills hub.
Interego is the substrate *under* its memory. The goal: when someone
sets up a new Hermes bot and runs `hermes memory setup`, `interego` is
the obvious pick — because it is the only one that makes the bot's
memory and identity genuinely *theirs*.

## What this is

[`integrations/hermes-memory/`](../../integrations/hermes-memory/) is a
Hermes memory provider plugin — `__init__.py` (the
`InteregoMemoryProvider`), `plugin.yaml`, `cli.py`, `README.md` — laid
out exactly as Hermes' developer guide specifies. Drop it in
`~/.hermes/plugins/memory/interego/` and it appears in
`hermes memory setup`.

It is a *translator*, not an extension. Hermes' memory hooks map onto
Interego's existing primitives, reached over the MCP relay's stable REST
surface — no Interego substrate code is duplicated, and the memory-graph
shape is identical to the OpenClaw provider's (`cgh:AgentMemory`), so
Hermes bots and OpenClaw agents on the same pod read each other's
memories.

| Hermes `MemoryProvider` hook | → Interego primitive |
|---|---|
| `sync_turn(user, assistant)` | `publish_context` — the turn as a typed memory graph, modal `Asserted` (non-blocking daemon thread, per the contract) |
| `prefetch(query)` + the `interego_recall` tool | `discover_context` — structural recall; Hermes' FTS5 / vector layer ranks on top |
| `on_memory_write(action, target, content)` | mirrors `MEMORY.md` / `USER.md` edits — `add`/`replace` → `publish_context`; `remove` → Counterfactual retraction |
| `system_prompt_block()` | tells the agent its memory is verifiable + portable |
| `get_config_schema()` / `save_config()` | `relay_url`, `pod_url`, `agent_bearer` (secret) |

## What it gains over Path 1

Path 1 (the MCP server) surfaces Interego tools to the LLM, which
decides when to call them. Path 5 is tighter: Hermes calls `sync_turn`
after *every* completed turn and `prefetch` before *every* API call —
so memory flows through the substrate by default, not by the model
remembering to.

## What composes for free

Same as every path — every memory write is a typed descriptor with
Agent + Trust + Provenance + Temporal + Semiotic facets, optional E2EE
`share_with`, `cg:supersedes` for revisions, cross-pod federation via
`discover_all` / `subscribe_to_pod`, and multi-axis `amta:` attestation.
Nothing extra to write.

## Local-first is preserved

Hermes keeps all data on the user's machine and has no telemetry. This
path keeps that property: `relay_url` points at the hosted relay *for
evaluation only* — production / privacy deployments point it at a relay
the user runs, or a local `personal-bridge`. The pod is then just
storage the user controls.

## Use

```bash
mkdir -p ~/.hermes/plugins/memory/interego
cp -r integrations/hermes-memory/* ~/.hermes/plugins/memory/interego/
hermes memory setup        # pick "interego"
hermes interego status     # verify config + relay reachability
```

## Honest scoping

* Written against the documented Hermes `MemoryProvider` plugin contract
  (`developer-guide/memory-provider-plugin`). Exact method signatures
  may shift with the live SDK — match at integration time. The relay
  REST contract (`POST /tool/publish_context`,
  `POST /tool/discover_context`) is stable.
* Substrate-side recall is structural; Hermes' own ranking layers on top.
* `remove` is a retraction, not a delete (audit trail survives).
* Memory writes are best-effort — a flaky relay never blocks the agent
  loop; Hermes' built-in `MEMORY.md` still holds the local copy.

## See also

* [`integrations/hermes-memory/`](../../integrations/hermes-memory/) —
  the plugin itself
* [Path 2 — OpenClaw memory plugin](path-2-openclaw-memory-plugin.md) —
  the sibling provider, same `cgh:AgentMemory` shape
* [Path 1 — MCP server](agent-runtimes-mcp.md) — the lighter route for
  runtimes without a memory-provider slot
