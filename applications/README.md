# Applications

> **Vertical use cases that COMPOSE the Interego protocol. NOT part of the protocol. NOT reference implementations of the protocol.**

This directory holds vertical / industry / domain-specific application designs that ride on top of Interego. They are explicitly **separated** from the protocol layers and from the reference implementation:

- [`spec/`](../spec/) — the **protocol** (L1 normative; L2 informative patterns; L3 ontology mappings). Must be technology-neutral and domain-neutral.
- [`src/`](../src/), [`mcp-server/`](../mcp-server/), [`deploy/`](../deploy/), [`examples/personal-bridge/`](../examples/personal-bridge/) — the **reference implementation** of the protocol and the recommended local-first deployment.
- [`applications/`](.) — **verticals**. Each vertical is *one* application of the protocol; many can coexist; none has special status; the protocol does not depend on any of them.

## Layering discipline

Per [`spec/LAYERS.md`](../spec/LAYERS.md), every artifact in this repo sits on one of three layers. Verticals here are application-layer over L3 — they MUST NOT introduce protocol-level claims and MUST live in their own namespace.

Concretely, a vertical in this directory:

- **MAY** introduce vertical-scoped vocabulary in its own namespace (e.g., `agent-hpt:`, `healthcare-rcm:`, `code-review:`). Those terms are non-normative.
- **MAY** define workflow patterns that compose existing L1/L2/L3 primitives.
- **MAY** ship code, ontology files, and examples specific to the vertical.
- **MUST NOT** propose changes to L1 protocol terms (`cg:`, `cgh:`, `pgsl:`, `ie:`, `align:`).
- **MUST NOT** require L2 / L3 ontologies to bend toward the vertical's needs — if a generic L3 ontology would benefit from the term, propose it there separately.
- **MUST** include a clear status banner explaining the vertical is non-normative and non-protocol.

The transplant test from [`spec/LAYERS.md`](../spec/LAYERS.md): "would this claim still make sense transplanted into a completely different domain or stack?" — if no, it belongs in a vertical, not in the protocol.

## Current verticals

| Vertical | What it does |
|---|---|
| [`agent-development-practice/`](agent-development-practice/) | **Agent-as-subject.** Complexity-informed (Cynefin / Snowden) framing for managing AI agent development in genuinely Complex situations — open-ended capability spaces (not targets), parallel safe-to-fail probes, narrative observation with signifiers, sensemaking syntheses that preserve multiple coherent narratives, amplify+dampen evolution (not "fix"), constraint-based governance, and emergent-recognition capability evolution events with explicit-decision-not-made statements that travel with the agent. Composes `passport:` + `olke:` + `amta:` + `registry:` + `abac:`; xAPI is intentionally NOT used inside. |
| [`learner-performer-companion/`](learner-performer-companion/) | **Human-as-protagonist.** Humans (learners / workers) keep a portable wallet of credentials (Open Badges 3.0, W3C VC, IMS CLR 2.0, IEEE LERS), xAPI learning history (TLA-flavored, brought in via [`lrs-adapter/`](lrs-adapter/)), authoritative training-content KGs (SCORM / cmi5 / PDF / video), and performance records — all in their own pod. An Interego-grounded assistant chats with the user, citing grounding atoms verbatim (never confabulating). Composes `passport:` + `olke:` + `pgsl:` + `connectors/` + `extractors/` + `compliance/` for VC verification. |
| [`lrs-adapter/`](lrs-adapter/) | **Boundary translator** (sibling of the two above, not a vertical with its own framework). Lossy two-way translation between xAPI Statements and Interego Context Descriptors. Skips Hypothetical / Counterfactual descriptors with audit notes; preserves multi-narrative + supersedes chains in `result.extensions` with explicit `lossy=true`. Used by `learner-performer-companion/` for ingest direction; available to `agent-development-practice/` for projection direction when employer-side dashboards require it. |
| [`agent-collective/`](agent-collective/) | **Multi-agent federation.** Patterns for autonomous agents owned by different humans to author tools, teach each other, and coordinate across personal-bridges. Three workflow surfaces: (a) tool authorship with modal discipline (Hypothetical → Asserted via attestation threshold), `cg:supersedes` for cross-agent refinement, registry publication for discovery; (b) teaching packages that compose artifact + narratives + synthesis + constraints + capability evolution (using `agent-development-practice/` substrate); (c) inter-agent coordination — capability advertisements, request/response with thread IDs, chime-ins, recurring check-ins, and `ac:CrossAgentAuditEntry` audit logs in the human owner's pod. Permission-gated via `passport:DelegationCredential`; everything signed; `code:` + `pgsl:` + `amta:` + `registry:` + `abac:` + `passport:` + `olke:`. |
| [`organizational-working-memory/`](organizational-working-memory/) | **Federated organizational memory.** A reference vertical demonstrating that a "company memory" surface is recoverable from the protocol's primitives alone. Typed entity surface — `owm:Person` / `owm:Project` / `owm:Decision` / `owm:FollowUp` / `owm:KnowledgeNote` — published as Context Descriptors on the org's pod with auto-`cg:supersedes` for upserts, modal status driving decision lifecycle (Hypothetical → Asserted → Counterfactual), content-addressed notes via `pgsl:Atom` (two observers minting identical text collide on IRI), and a per-source navigation surface that isolates each external source (web, drive, slack, github, ...) behind uniform `ls / cat / grep / recent` verbs — the main agent sees one navigation tool regardless of how many sources are wired, and never accumulates per-source tool noise in its context. Composes `olke:` (knowledge-stage classification) + `passport:` (for agent-people) + `pgsl:` (content-addressed atoms) + the standard L1 publish / discover / supersedes machinery. The closed observe-and-revise loop: a Curator agent distills sources into typed entities; a separate Surfacer agent — different process, no shared memory — recovers state from the org pod alone (Demo 15). |

## Two reachability paths per vertical

Per first principles, a vertical is reachable two ways — and **the protocol-level path is primary**. The opinionated MCP-bridge path is just an ergonomic accelerant for clients that prefer named tools.

### Path A — protocol-level (always works; no per-vertical client install)

Each vertical declares its capabilities as `cg:Affordance` descriptors in [`<vertical>/affordances.ts`](learner-performer-companion/affordances.ts). A generic Interego agent (e.g., the [stdio MCP server](../mcp-server/) or any standard Solid client) can:

1. `discover_context` against the vertical's pod / manifest URL
2. Filter for `cg:Affordance` entries with the `cg:action` of interest
3. Read `hydra:method` + `hydra:target` + `hydra:expects`
4. POST to `hydra:target` with the typed inputs

No vertical-specific client code needed at the consuming agent. The vertical's ENTIRE capability surface is protocol-native data — anyone can write a generic affordance-walker that handles new verticals with zero code changes.

### Path B — per-vertical bridge (optional; opinionated; named MCP tools)

For each vertical popular enough to warrant the convenience, a small standalone bridge under [`<vertical>/bridge/`](learner-performer-companion/bridge/) exposes the same capabilities as named MCP tools (`lpc.*`, `adp.*`, `lrs.*`, `ac.*`). The bridge:

- Depends on `@interego/core`
- Imports the vertical's affordance declarations
- Derives MCP tool schemas from them (single source of truth — never hand-written)
- Also serves the affordance manifest at `GET /affordances` for Path A consumers

Run the bridge ON ITS OWN PORT (e.g., 6010 for LPC, 6020 for ADP). The generic [`personal-bridge`](../examples/personal-bridge/) is **separate** — it does NOT load these. Vertical bridges are independent deployments.

Both paths invoke the same publishers under [`<vertical>/src/`](learner-performer-companion/src/) — the named-tool layer is just a derived projection.

## Adding a vertical

1. Create a subdirectory under [`applications/`](.) named after the vertical.
2. Inside, write a `README.md` that opens with the standard "vertical application — not protocol, not reference implementation" banner.
3. Document the workflow patterns and how the vertical composes existing L1/L2/L3 primitives.
4. If the vertical needs unique vocabulary, put it in `<vertical>/ontology/<prefix>.ttl` with the prefix clearly scoped to the vertical.
5. Capabilities go in `<vertical>/affordances.ts` (typed Affordance objects). The bridge framework derives MCP tool schemas + Hydra Turtle from these.
6. Implementation under `<vertical>/src/` (publishers, loaders, etc.).
7. Tier 1-8 tests under `<vertical>/tests/` for behavior + protocol-level shape verification.
8. Optional: `<vertical>/bridge/` with a small server.ts using `createVerticalBridge()` from [`_shared/vertical-bridge/`](_shared/vertical-bridge/) — enables Path B for clients that want it.

The protocol's CI (lints, conformance suite, core tests) is unaffected by anything in `applications/`. A vertical can fail to build without breaking the project.
