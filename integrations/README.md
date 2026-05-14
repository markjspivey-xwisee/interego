# Integrations

Thin translators that bridge Interego's substrate primitives into the
ergonomic surfaces of external agent runtimes.

Each integration in this directory is a translator, not an extension.
It does NOT introduce new substrate types, namespaces, or composition
rules. It maps the runtime's existing concepts (a memory write, a skill
file, an audit event) onto the substrate's existing primitives
(`publish_context`, `discover_context`, `supersede`, `register_agent`).

## What's here

| Integration | Runtime | What it bridges |
|---|---|---|
| [`openclaw-memory/`](openclaw-memory/) | OpenClaw | OpenClaw memory-engine slot ↔ Interego pod-rooted typed memory; fixed 5-tool HATEOAS surface (results decorated with `affordances`, followed via `interego_act`) reaches the whole substrate |
| [`hermes-memory/`](hermes-memory/) | Hermes Agent | Hermes `MemoryProvider` plugin ↔ Interego pod-rooted typed memory; same `cgh:AgentMemory` shape + 3-tool HATEOAS surface as the OpenClaw provider |
| [`compliance-overlay/`](compliance-overlay/) | any runtime | agent-action event ↔ compliance-grade signed descriptor |

(More may land — Codex skill federator, etc. The shape is the same: a
thin glue file calling substrate primitives.)

## Why integrations live here, not under `applications/`

`applications/` holds **verticals** — domain-specific compositions of
the substrate (LPC, ADP, LRS, AC, OWM). Each vertical defines its own
typed affordances and is internally consistent.

Integrations target **external systems** that already have their own
ontology and ergonomics. The integration's only job is to translate
between the external system's vocabulary and the substrate's. There is
no new vertical, no new affordance set — just `runtime concept X → call
publish_context` and back.

The two structurally feel similar but the layering intent differs.
Verticals are non-normative L3 *over* the substrate; integrations are
non-normative L3 *adjacent to* it.

## See also

* [docs/integrations/agent-runtime-integration.md](../docs/integrations/agent-runtime-integration.md)
  — the five integration paths (MCP / OpenClaw memory / skills /
  compliance / Hermes memory)
* [applications/README.md](../applications/README.md) — how verticals
  differ from integrations
