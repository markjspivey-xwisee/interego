# Hermes adopts Interego — whole, not in pieces

> How a Hermes Agent bot reaches **all** of Interego — identity,
> delegation, federation, skills, compliance, attestation, composition —
> without 60 tool schemas bloating its context. The answer is HATEOAS:
> a tiny fixed tool surface plus capability that travels as data.

## The two surfaces, and why you want both

Hermes exposes two extension points that matter here:

* **Memory provider plugin** ([Path 5](path-5-hermes-memory-provider.md))
  — runs *automatically*: Hermes calls `sync_turn` after every turn and
  `prefetch` before every API call. Memory flows through the substrate
  with no LLM discretion.
* **MCP integration** ([Path 1](agent-runtimes-mcp.md)) — Hermes speaks
  MCP natively. Point it at the Interego MCP server and *every* substrate
  primitive becomes a callable tool.

The memory provider is the automatic spine. MCP is the full reach. You
want both — and the `interego` memory provider is designed so that
adopting it *also* gives you the full reach, through one mechanism, so
you don't actually need two installs to get "the whole thing."

## The bloat problem

Interego's relay exposes ~15 tools; the full MCP server exposes ~60
(`publish_context`, `discover_context`, `register_agent`,
`verify_agent`, `discover_all`, `compose_contexts`, `subscribe_to_pod`,
…). Surface them flat and every one costs context budget on every turn,
forever — whether or not the agent ever uses it. The agent's working
memory gets crowded out by an API reference it mostly ignores.

That is the wrong shape. The fix is not "curate a smaller flat list" —
any fixed list is either too big or too limiting. The fix is to stop
treating capability as a static list at all.

## The HATEOAS fix: capability travels as data

The `interego` memory provider gives the agent **exactly three tool
schemas**, and never more:

| Tool | What it does |
|---|---|
| `interego_recall(query)` | recall pod memories — each result decorated with its `affordances` |
| `interego_discover(query, federated?)` | discover descriptors on the pod or across the federation — each decorated with its `affordances` |
| `interego_act(affordance, content?, params?)` | **follow** an affordance — the single substrate-acting path |

Every memory or descriptor the agent receives is **decorated** with an
`affordances` list — self-describing `{action, tool, args}` records
naming exactly what the agent can do with that item, gated by its
delegation scope. To act, the agent passes one affordance to
`interego_act`, which executes it.

This is [HATEOAS](https://en.wikipedia.org/wiki/HATEOAS) — *Hypermedia
As The Engine Of Application State* — applied to an agent's tool
surface:

* The agent never holds the API. It holds three verbs and follows links.
* New substrate capability appears as a **new affordance verb in the
  data** — never a new tool schema. Context cost is fixed and tiny no
  matter how the substrate grows.
* Affordances are **distributed**: computed at the edge, per descriptor,
  per the agent's scope — decorating the data, not centralized in a
  registry the agent has to load.
* `interego_act` is a near-pure executor: the affordance it receives
  already names its `tool` and base `args`. The server told the client
  what it could do; the tool just does it.

Entry-point affordances that aren't tied to a descriptor —
`register_agent`, `verify_agent`, `discover_all` — are listed in the
provider's `system_prompt_block()` as ready-to-follow affordance objects.
So identity and federation are reachable through the same one
`interego_act` tool. **Any** relay tool is reachable this way: the agent
reaches *all of Interego* through three schemas.

```
   Without HATEOAS                With HATEOAS
   ───────────────                ────────────
   60 tool schemas in context     3 tool schemas in context
   capability = static list       capability = affordances on the data
   new capability = new schema    new capability = new verb in a result
   agent must know the API        agent follows the links it is handed
```

## Setup — the whole substrate, one install

```bash
mkdir -p ~/.hermes/plugins/memory/interego
cp -r integrations/hermes-memory/* ~/.hermes/plugins/memory/interego/
hermes memory setup        # pick "interego"; set relay_url / pod_url / agent_bearer / scope
hermes interego status
```

That's it. The bot now has:

* **Automatic memory** — every turn synced to the pod as a signed,
  provenance-attributed descriptor (`sync_turn`), recall injected before
  every turn (`prefetch`).
* **The whole substrate, reachable** — `interego_discover` +
  `interego_act` navigate identity, delegation, federation, supersession,
  sharing, subscription, and more, by following affordances. Three tool
  schemas, unbounded capability.

Optionally also wire the Interego **MCP server** (Path 1) into Hermes'
MCP config — useful if you want the raw 60-tool surface available to
power users or other plugins. For the agent's own loop, the HATEOAS
provider is the better shape: same reach, a fraction of the context
cost.

## Why this is the substrate's natural shape, not a workaround

`cg:Affordance` / `cgh:Affordance` / `hydra:Operation` are L1/L2
primitives — the affordance engine (`src/affordance/`) computes them as
a Gibsonian relation between an agent and a descriptor. The Hermes
provider isn't inventing a navigation scheme; it's surfacing one the
substrate already has. The integration's job, as always, is translation
— here, translating "the affordances Interego computes" into "the links
a Hermes tool-caller follows."

## See also

* [Path 5 — Hermes memory provider](path-5-hermes-memory-provider.md)
* [Path 1 — Interego as MCP server](agent-runtimes-mcp.md)
* [`integrations/hermes-memory/`](../../integrations/hermes-memory/) —
  the plugin (the 3-tool surface lives in `get_tool_schemas()`)
* [`src/affordance/`](../../src/affordance/) — the affordance engine the
  decoration mirrors
