# Agent-runtime integration — five paths

The agent-runtime ecosystem (OpenClaw, Hermes Agent, Codex, Cursor,
Copilot, Claude Code, …) has converged on a common shape:

* **Local-first agent process** with a tool-calling loop
* **MCP** for plug-in tools
* **Markdown / SQLite** for memory
* **agentskills.io SKILL.md** for portable skill packaging
* **Honcho** as a third-party persistent user-model service

What none of them ship: cryptographic identity, cross-user shared
memory, typed context, modal status, multi-axis attestation,
governance, signed-and-anchored audit trails.

That gap is the substrate's edge. Rather than build another runtime,
Interego is positioned **under** them — every primitive exposed as MCP
tools by default, with deeper-coupling paths available as the
integration matures.

This document is the map. Each path links to a concrete how-to under
[docs/integrations/](.). Every path composes the same Layer-1
primitives — what changes is how tightly the runtime wraps them.

---

## Layering, in one diagram

```
                    Agent runtime              Layer adopted
    ─────────────────────────────────────────────────────────
    OpenClaw / Hermes / Codex / Cursor / …    runtime ergonomic
                       │
                       │  4 paths from ergonomic → substrate
                       ▼
    ┌─ Path 1 ─ MCP server (config-only)        ── L1 primitives
    │  Path 2 ─ OpenClaw memory-engine plugin   ── L2 patterns
    │  Path 3 ─ SKILL.md as cg:Affordance       ── L1 primitives
    │  Path 4 ─ Compliance overlay              ── L3 mappings
    └─ Path 5 ─ Hermes memory provider          ── L2 patterns
                       │
                       ▼
    Interego substrate (Context Graphs 1.0):
      typed descriptors / 7 facets / 4 ops /
      modal status / supersedes chains / PGSL /
      DIDs / E2EE / federated pods / amta: / cgh:
```

Each path is independently adoptable. Adopting Path 1 does not block
Path 3. Adopting all four does not require any change to the substrate
itself — they are translators, not extensions.

---

## Path 1 — Interego as MCP server

**Effort:** config-file change. **What you gain:** every substrate
primitive (`publish_context`, `discover_context`, `register_agent`,
`compose_contexts`, all 60+ tools) appears as ordinary tools the
agent can call. Cryptographic provenance, typed memory, federated
share, modal reasoning — all of it — without writing a line of code.

**Read:** [agent-runtimes-mcp.md](agent-runtimes-mcp.md)

**Trade-off:** the LLM decides when to reach for memory. Loose
coupling. The proactive triggers in the MCP server's instructions
help, but Path 2 is tighter when you want every agent turn to write
through the substrate without LLM discretion.

---

## Path 2 — OpenClaw memory-engine plugin

**Effort:** small adapter (~1 file, ~250 LOC). **What you gain:**
OpenClaw's `memory_store` / `memory_recall` / `memory_forget` tool
calls — and OpenClaw's auto-recall / auto-capture hooks — flow through
the substrate transparently. Every memory write becomes a typed,
signed `cg:ContextDescriptor` with proper modal status.

The plugin claims OpenClaw's exclusive `plugins.slots.memory` slot.
It does not introduce any Interego concept OpenClaw doesn't already
have a place for; it just rebinds the same three operations to the
substrate's `publish_context` / `discover_context` /
`supersede-with-Counterfactual` primitives.

**Read:** [path-2-openclaw-memory-plugin.md](path-2-openclaw-memory-plugin.md)

**Trade-off:** OpenClaw-specific. Hermes Agent now exposes its own
external-memory-provider interface — that is **Path 5** below, the same
shape against Hermes' contract. For runtimes with no memory-plugin slot,
fall back to Path 1.

---

## Path 3 — SKILL.md as `cg:Affordance`

**Effort:** small library + bidirectional translator (~1 file). **What
you gain:** the entire agentskills.io ecosystem — already adopted by
OpenClaw, Hermes, VS Code Copilot, Codex, Microsoft Agent Framework —
becomes a federated, attestable, governable layer.

A SKILL.md is *structurally* an affordance: a discoverable named
capability with metadata, instructions, and optional resources. The
substrate already has `cg:Affordance` and the affordance engine. The
translator goes both ways:

* **publish:** `SKILL.md` directory → typed `cg:Affordance` descriptor
  on a pod, with PROV provenance, modal status, signed authorship.
* **discover:** any cross-pod `discover` for affordances yields back
  a SKILL.md directory the runtime can drop into `~/.hermes/skills/` or
  OpenClaw's skill folder.

What falls out by composition (no new code):

* Multi-axis attestation via `amta:` (correctness / safety / efficiency)
* Modal-status promotion from Hypothetical → Asserted
* `cg:supersedes` for skill versioning
* `cgh:PromotionConstraint` for governance ("safety axis required
  before this skill is Asserted")
* Federated discovery — bob's skill is discoverable from alice's pod
  if bob has shared with her

The runtime keeps using SKILL.md. The substrate gives the
shared-skill-ecosystem properties for free.

**Read:** [path-3-skills-as-affordances.md](path-3-skills-as-affordances.md)

---

## Path 4 — Compliance overlay

**Effort:** thin adapter + per-framework citations (~1 file). **What
you gain:** every agent action emits a signed, anchored, framework-
cited `cg:ContextDescriptor` with `compliance: true`. Framework
mappings already exist (`docs/ns/eu-ai-act.ttl`,
`docs/ns/nist-rmf.ttl`, `docs/ns/soc2.ttl`); the overlay is the bridge
from the runtime's tool-call event to a typed compliance event.

Composes against `src/ops/` (DeployEvent, AccessChangeEvent, etc.) and
`src/compliance/` (signing, anchoring, lineage).

**Read:** [path-4-compliance-overlay.md](path-4-compliance-overlay.md)

**When to adopt:** regulated-vertical pilots. SOC 2 / EU AI Act /
NIST RMF deployments where "the runtime is making decisions on the
auditor's behalf" needs the full provenance trail.

---

## Path 5 — Hermes Agent memory provider

**Effort:** small plugin (4 files, stdlib-only Python). **What you
gain:** Hermes Agent — the most-used agent runtime — gains pod-rooted,
verifiable, federated, *portable* memory. Hermes ships an external
memory-provider plugin interface (8 third-party providers already
exist); Interego is the ninth, and the only one that makes the bot's
memory and identity something the user owns and can take anywhere —
across machines, across Hermes backends, even off Hermes entirely.

It is Path 2's shape against Hermes' contract: `sync_turn` →
`publish_context`, `prefetch` → `discover_context`, `on_memory_write`
mirrors `MEMORY.md` / `USER.md` edits. The memory-graph shape is
identical to the OpenClaw provider's (`cgh:AgentMemory`) — Hermes bots
and OpenClaw agents on one pod read each other's memories. No substrate
code is duplicated; the MCP relay does the descriptor work.

**Read:** [path-5-hermes-memory-provider.md](path-5-hermes-memory-provider.md)

**Trade-off:** Hermes-specific glue (the bridge logic is shared). For
runtimes with no memory-provider slot, fall back to Path 1.

---

## Picking a starting point

| You want… | Start with |
|---|---|
| The agent to be able to remember + recall across sessions, with provenance | Path 1 |
| Every memory write to flow through the substrate without LLM discretion | Path 2 (OpenClaw) / Path 5 (Hermes) |
| Agents to share, attest, and govern skills across users | Path 3 |
| The agent's actions to be EU AI Act / NIST RMF / SOC 2 audit-grade | Path 4 |
| A new Hermes bot to use pod-rooted memory from `hermes memory setup` | Path 5 |
| All of them | Adopt 1 first (5 minutes), then the rest in any order |

Adopting any of them does NOT require touching the substrate, the
ontologies, or the L1 spec. They are flavors of translator, plugged
into the same primitives, by design.

---

## See also

* [ARCHITECTURAL-FOUNDATIONS.md](../ARCHITECTURAL-FOUNDATIONS.md) — formal
  account of why the substrate composes this way
* [spec/LAYERS.md](../spec/LAYERS.md) — layering discipline; verticals
  vs L1/L2/L3
* [applications/README.md](../../applications/README.md) — the existing
  vertical surface (LPC, ADP, LRS, AC, OWM)
