# interego — Hermes Agent memory provider

Pod-rooted, **verifiable, federated, portable** memory for [Hermes
Agent](https://hermes-agent.nousresearch.com/). Drop it in and every
memory your Hermes bot keeps becomes a signed, provenance-attributed
record on an Interego pod — without giving up anything Hermes already
does well.

## Why a new Hermes bot should turn this on

Hermes' promise is *"the agent that grows with you."* It grows a
`MEMORY.md`, a `USER.md`, and a `state.db` — all in one `~/.hermes`
directory on one machine. That's excellent for a single bot on a single
box. It is also where the story stops.

This provider extends that story without replacing it:

| Hermes built-in memory | + Interego provider |
|---|---|
| Local markdown + SQLite, one machine | Pod-rooted — survives a machine change, a Hermes backend switch (local → Docker → SSH → Modal), or a move off Hermes entirely |
| Trusted by convention | **Verifiable** — every write is a signed `cg:ContextDescriptor` carrying who wrote it, when, and on whose behalf |
| One bot's private memory | **Federated** — two Hermes bots, or a Hermes bot + a Claude Code agent + a Cursor agent, can share context on the same pod |
| `remove` deletes the line | **Non-destructive** — "forget" is a Counterfactual supersession; the prior record stays audit-walkable |
| No cross-agent attestation | Multi-axis attestation (`amta:`), modal status, governance — all available by composition, no extra code |

Hermes runs the loop and owns the ergonomics. Interego is the substrate
*under* the memory — so the thing your bot grows is something **you own
and can take anywhere**, not something locked to one directory.

Built-in `MEMORY.md` / `state.db` keep working. Per Hermes' design, an
external provider runs *alongside* the built-in memory, never replacing
it — so there is no downside to enabling it.

## Local-first is preserved

Hermes keeps all data on your machine by default. This provider does too
— point `relay_url` at a relay you run yourself (or a local
`personal-bridge`) and the pod is just storage you control. The hosted
relay is the zero-setup default *for evaluation*; production / privacy
deployments run it local. Either way, no telemetry, no lock-in.

## Install

```bash
# Drop the provider into Hermes' user-plugin directory
mkdir -p ~/.hermes/plugins/memory/interego
cp -r integrations/hermes-memory/* ~/.hermes/plugins/memory/interego/

# Configure + select it (Hermes writes the bearer to .env, the rest to interego.json)
hermes memory setup        # pick "interego", fill relay_url / pod_url / agent_bearer
hermes interego status     # verify config + relay reachability
```

`hermes memory setup` is Hermes' standard provider picker — `interego`
appears in the list once the directory is in place. User plugins at
`~/.hermes/plugins/memory/<name>/` override bundled plugins of the same
name, so no Hermes repo edit is needed.

## How it works

A *translator*, not an extension. It maps Hermes' memory hooks onto
Interego's existing primitives, reached over the Interego MCP relay's
stable REST surface (`POST /tool/publish_context`,
`POST /tool/discover_context`):

| Hermes hook | → Interego |
|---|---|
| `sync_turn(user, assistant)` | `publish_context` — the turn as a `cgh:AgentMemory` graph, modal `Asserted` (non-blocking, daemon thread, per Hermes' contract) |
| `prefetch(query)` / `interego_recall` tool | `discover_context` — structural recall over the pod's memory descriptors; Hermes' own FTS5 / vector layer ranks on top |
| `on_memory_write(action, target, content)` | mirrors `MEMORY.md` / `USER.md` edits: `add`/`replace` → `publish_context` (the relay's auto-supersede links the prior record); `remove` → a Counterfactual retraction |
| `system_prompt_block()` | tells the agent its memory is verifiable + portable, so it uses it well |

No Interego substrate code is duplicated here — the relay (running
`@interego/core`) does descriptor construction, signing, and
`cg:supersedes` chaining. The memory-graph shape written here is
deliberately **identical** to the OpenClaw memory bridge's
(`cgh:AgentMemory`), so a Hermes bot and an OpenClaw agent on the same
pod read each other's memories.

Stdlib-only Python (`urllib`, `json`, `threading`) — no pip
dependencies, matching Interego's zero-runtime-deps ethos.

## Honest scoping

* Written against the documented Hermes `MemoryProvider` plugin contract
  (`developer-guide/memory-provider-plugin`). Exact method signatures may
  shift with the live SDK — match them at integration time. The relay
  REST contract is stable.
* Substrate-side recall is **structural** (modal status + keyword over
  descriptor graphs). Semantic / vector ranking is Hermes' job — it
  already has FTS5 and pluggable vector layers; this returns the
  candidate pool.
* `on_memory_write` `remove` is a **retraction, not a delete**. The
  original descriptor + graph stay on the pod (audit-walkable via
  `cg:supersedes`). For data-subject erasure, delete at the pod's
  storage layer separately.
* Memory writes are **best-effort**: a flaky relay is swallowed, never
  blocking the agent loop — Hermes' built-in `MEMORY.md` still holds the
  local copy.

## See also

* [`docs/integrations/path-5-hermes-memory-provider.md`](../../docs/integrations/path-5-hermes-memory-provider.md)
  — the integration path in full
* [`docs/integrations/agent-runtime-integration.md`](../../docs/integrations/agent-runtime-integration.md)
  — all integration paths (MCP / memory plugin / skills / compliance)
* [`integrations/openclaw-memory/`](../openclaw-memory/) — the
  sibling OpenClaw provider; same `cgh:AgentMemory` shape
