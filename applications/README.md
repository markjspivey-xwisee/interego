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
| [`agent-development-practice/`](agent-development-practice/) | Complexity-informed (Cynefin / Snowden) framing for managing AI agent development in genuinely Complex situations — open-ended capability spaces (not targets), parallel safe-to-fail probes, narrative observation with signifiers, sensemaking syntheses that preserve multiple coherent narratives, amplify+dampen evolution (not "fix"), constraint-based governance, and emergent-recognition capability evolution events with explicit-decision-not-made statements that travel with the agent. Composes `passport:` + `olke:` + `amta:` + `registry:` + `abac:`; xAPI is intentionally NOT used inside (an `applications/lrs-adapter/` would translate at the boundary if needed). |

## Adding a vertical

1. Create a subdirectory under [`applications/`](.) named after the vertical.
2. Inside, write a `README.md` that opens with the standard "vertical application — not protocol, not reference implementation" banner.
3. Document the workflow patterns and how the vertical composes existing L1/L2/L3 primitives.
4. If the vertical needs unique vocabulary, put it in `<vertical>/ontology/<prefix>.ttl` with the prefix clearly scoped to the vertical.
5. Code examples go in `<vertical>/examples/`.
6. Tests for the vertical's specific code (not for the underlying protocol) go in `<vertical>/tests/`.

The protocol's CI (lints, conformance suite, core tests) is unaffected by anything in `applications/`. A vertical can fail to build without breaking the project.
