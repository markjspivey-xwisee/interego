# OpenClaw adopts Interego — whole, not in pieces

> How an OpenClaw agent reaches **all** of Interego — supersession,
> federation, sharing, retraction, navigation — without a flat list of
> substrate operations bloating its context. The answer is HATEOAS: a
> small fixed tool surface plus capability that travels as data. This
> is the OpenClaw counterpart of
> [hermes-full-substrate.md](hermes-full-substrate.md); the two
> integrations share the shape by design.

## The surface

The [`@interego/openclaw-memory`](../../integrations/openclaw-memory/)
plugin claims OpenClaw's exclusive `plugins.slots.memory` slot and
registers a **fixed five-tool surface** — and it never grows:

| Tool | Role |
|---|---|
| `memory_store` | persist a memory (slot contract) |
| `memory_recall` | recall memories — each decorated with `affordances` (slot contract) |
| `memory_forget` | retract a memory — Counterfactual supersession (slot contract) |
| `interego_discover` | discover descriptors — each decorated with `affordances` (HATEOAS navigation) |
| `interego_act` | **follow** an affordance — the single substrate-acting path (HATEOAS engine) |

The first three satisfy OpenClaw's memory-slot contract. The last two
turn the plugin from "a memory backend" into "a window onto the whole
substrate."

## The bloat problem

Interego has ~15 relay tools and ~60 in the full MCP server
(`publish_context`, `register_agent`, `verify_agent`, `discover_all`,
`compose_contexts`, `subscribe_to_pod`, …). Register them flat and every
one costs context budget on every turn, forever — whether the agent
uses it or not. Any fixed flat list is either too big or too limiting.

## The HATEOAS fix: capability travels as data

Every result from `memory_recall` and `interego_discover` is
**decorated** with an `affordances` list — self-describing
`{action, target, descriptorUrl, hint}` records naming exactly what the
agent can do with that item, **gated by its delegation scope**. To act,
the agent passes one affordance to `interego_act`, which dispatches it
to the matching substrate primitive.

This is [HATEOAS](https://en.wikipedia.org/wiki/HATEOAS) — *Hypermedia
As The Engine Of Application State* — applied to an agent's tool
surface:

* The agent never holds the API. It holds five tools and follows links.
* New substrate capability appears as a **new affordance verb in the
  data** — never a new tool schema. Context cost is fixed and tiny no
  matter how the substrate grows.
* Affordances are **distributed**: computed at the edge, per descriptor,
  per the agent's scope (`affordancesFor()` mirrors the affordance
  engine's `SCOPE_PERMISSIONS`) — decorating the data, not centralized
  in a registry the agent must preload.
* `interego_act` / `followAffordance()` is the engine: the affordance it
  receives already names its verb + target; it just dispatches.

```
   Without HATEOAS                With HATEOAS
   ───────────────                ────────────
   ~15-60 tool schemas            5 tool schemas, fixed forever
   capability = static list       capability = affordances on the data
   new capability = new schema    new capability = new verb in a result
   agent must know the API        agent follows the links it is handed
```

The affordance verbs the bridge dispatches — `read`, `derive`,
`retract`, `challenge`, `annotate`, `forward` — are a scope-gated subset
of the substrate's canonical `AffordanceAction` set
([`src/affordance/types.ts`](../../src/affordance/types.ts)). Each maps
to a substrate primitive: `derive` → publish-with-supersedes, `retract`
→ Counterfactual supersession, `read` → fetch the graph, and so on.

## Same shape as Hermes — on purpose

The Hermes provider ([Path 5](path-5-hermes-memory-provider.md)) reaches
the substrate over the MCP relay's REST surface; the OpenClaw plugin
composes `@interego/core` directly. Different transport, identical
shape: a fixed handful of tools, affordance-decorated results, one
`*_act` tool that follows them. An OpenClaw agent and a Hermes bot on
the same pod write the same `cgh:AgentMemory` graph shape and navigate
it the same way.

## Setup

```bash
npm install @interego/openclaw-memory
openclaw plugin install @interego/openclaw-memory \
  --config '{"podUrl": "https://your-pod.example/me/", "agentDid": "did:web:your-pod.example", "scope": "ReadWrite"}'
```

OpenClaw reads `openclaw.plugin.json`, claims the memory slot, and
surfaces the five tools. The agent now has automatic memory (the slot
contract + auto-recall / auto-capture hooks) **and** the whole substrate
reachable through `interego_discover` + `interego_act` — five tool
schemas, unbounded capability.

Optionally also wire the Interego **MCP server** ([Path 1](agent-runtimes-mcp.md))
into OpenClaw's MCP config for the raw tool surface. For the agent's own
loop, the HATEOAS plugin is the better shape: same reach, a fraction of
the context cost.

## Why this is the substrate's natural shape

`cg:Affordance` / `cgh:Affordance` / `hydra:Operation` are L1/L2
primitives — the affordance engine ([`src/affordance/`](../../src/affordance/))
computes them as a Gibsonian relation between an agent and a descriptor.
The OpenClaw plugin isn't inventing a navigation scheme; it surfaces one
the substrate already has. The integration's job, as always, is
translation — here, translating "the affordances Interego computes" into
"the links an OpenClaw tool-caller follows."

## See also

* [Path 2 — OpenClaw memory plugin](path-2-openclaw-memory-plugin.md)
* [hermes-full-substrate.md](hermes-full-substrate.md) — the Hermes
  counterpart; same shape, different transport
* [`integrations/openclaw-memory/`](../../integrations/openclaw-memory/)
  — the plugin (the 5-tool surface lives in `plugin.ts`; the affordance
  machinery in `bridge.ts`)
* [`src/affordance/`](../../src/affordance/) — the affordance engine the
  decoration mirrors
