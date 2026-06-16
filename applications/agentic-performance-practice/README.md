# Agentic Performance Practice (`agp:`)

> **Vertical application — not protocol, not reference implementation.** This is one
> use case that COMPOSES the Interego protocol (L1/L2/L3) and other verticals. The
> protocol does not depend on it. Its vocabulary (`agp:`) is non-normative and lives
> in its own namespace.
>
> **Layer: application-over-L3.**

A complexity-aware, **regime-first** theory of performance for agents and teams of
agents + humans — agentic performance consulting / management / improvement.

## Why this is its own vertical

There are three layers, and they should not be conflated:

- **Interego (substrate).** Context infrastructure: signed descriptors, trust /
  provenance / federation, PGSL, and the L0 **HATEOAS / hypermedia affordances**
  (`cg:Affordance` — discover → dereference → `act`). Everything here is
  ontology-driven and dereferenceable as RESTful linked data.
- **Foxxi (standards vertical).** Composes / implements the *external standards* as
  its substrate: xAPI 2.0 (IEEE 9274.1.1) LRS, IEEE-LER / P2997, ADL-TLA, plus
  cmi5 / SCORM / LTI / OneRoster. Foxxi is faithful, conformant projection — not a
  theory of performance.
- **This vertical (`agp:`).** A *theory of performance*. It **composes** Foxxi's
  standards (records performance as xAPI, assembles learner records) and the
  Interego substrate, and it composes the sibling verticals `adp:` and `ac:`. The
  theory does not belong inside Foxxi (a standards/content vertical), so it lives
  here.

The [`agent-development-practice/`](../agent-development-practice/) README deferred a
performance sibling (its placeholder `agent-hpt/`). This vertical is that sibling —
but **reframed regime-first** rather than as Human Performance Technology: ADP covers
only the Complex / Emergent regime; `agp:` routes across **all** regimes and composes
ADP for the Emergent row rather than absorbing it. Idealize-a-future-state /
gap-analysis is the method of **one** regime (Knowable), never the universal frame.

## The two senses of "affordance" (kept deliberately distinct)

- **`cg:Affordance` (L0).** A machine-followable REST / HATEOAS transition — what you
  can *do* with a resource right now (`hydra:method` + `hydra:target`). The bridge's
  `affordances.ts` declares these.
- **`agp:PerformanceAffordance` (this vertical).** Affordance theory in the
  *ecological* sense — what a *situation offers a performer given its capabilities*.
  Its **actualization** (`agp:Actualization`) is the productive join
  `Capability × Situation × PerformanceAffordance → Performance`.

They relate — a performance affordance may ultimately be *realized through*
`cg:Affordances` — but they are different layers, in different namespaces, and the
ontology comments enforce the distinction.

## What the ontology formalizes

The centerpiece is [`ontology/agp.ttl`](ontology/agp.ttl) (OWL) +
[`ontology/agp-shapes.ttl`](ontology/agp-shapes.ttl) (SHACL), served dereferenceably
(see below). Every class subclasses an existing substrate class; nothing modifies the
protocol.

- **Regime-first contextualization** — `agp:PerformanceSituation` (the *unit*),
  `agp:WorkRegime` (Evident / Knowable / Emergent / Turbulent, each `skos:closeMatch`
  the corresponding `adp:CynefinDomain`), `agp:regimeSource` (derived | asserted |
  default | unclassified — only *derived* may gap-analyse or accrue calibration), and
  the regime-routed `agp:PerformanceMethod` (gap-analysis bound to Knowable only).
- **Capability composition (net-new)** — `agp:Capability` `agp:composedOf` /
  `cg:constructedFrom` its constituent `agp:Skill` + `agp:Tool` (`skos:closeMatch`
  `ac:AgentTool`) + `agp:Knowledge` (by codifiability). An empty capability is
  rejected by SHACL.
- **Affordance actualization (net-new)** — `agp:PerformanceAffordance`
  (`agp:requiresCapability`), `agp:Actualization` (`agp:engages` a capability
  `agp:inSituation`, `agp:actualizes` an affordance, `agp:yields` a
  `agp:Performance`), `agp:Performance` (`agp:recordedAs` a single xAPI `performed`
  statement). The `ActualizationShape` requires all four references — actualization
  is a first-class, validated object.
- **Diagnosis → intervention → evaluation → calibration** — `agp:Diagnosis`,
  `agp:PerformanceFactor` (the six-factor cause model, Knowable-only),
  `agp:InterventionPlan` / `agp:Intervention`, `agp:InterventionEvaluation`
  (`amta:Attestation`, four levels), `agp:CalibrationProfile` (the reflexive
  per-`regime × cause × intervention` track record).

Cross-property rules that exceed the in-process SHACL engine's subset (e.g.
"gap-analysis requires a *derived* Knowable regime") are enforced in **code** by the
regime-source discipline, not by SHACL — see `ontology/agp-shapes.ttl`.

## Ontology-driven, served as linked data

The bridge serves the ontology dereferenceably with content negotiation + HATEOAS —
the *author-AND-serve* pattern (sibling verticals author `.ttl` but do not serve it):

| Route | Returns |
|---|---|
| `GET /ns/agp` (`Accept: text/turtle`) | the full OWL ontology (Turtle) |
| `GET /ns/agp` (`Accept: application/ld+json`) | a JSON-LD summary projection |
| `GET /ns/agp/term/:name` | per-term JSON-LD (never 404s an owned-namespace fragment) |
| `GET /ns/agp/shapes` | the SHACL node shapes (Turtle) |

Instances are published as `cg:ContextDescriptor`s carrying `dct:conformsTo` the
relevant shape; the container declares the shapes so the relay conformance gate
(`runConformanceGate`) validates them **before** the pod write.

## How agents (and teams of agents) reach it

- **Path A (protocol-native):** discover the `cg:Affordance` manifest at
  `GET /affordances`, read `hydra:method` + `hydra:target`, POST the typed inputs.
- **Path B (named MCP tools):** the optional bridge at [`bridge/`](bridge/) exposes
  the same capabilities as `agp.*` tools (port 6030 by default).

Both invoke the same publishers under `src/`. Teams of agents continue to use **Foxxi**
for the xAPI side — including authoring a custom xAPI Profile for performance tracking
(the `agp:` Profile is authored against Foxxi's profile machinery in Stage 2).

## What this is NOT

- NOT a protocol change. It introduces no `cg:` / `pgsl:` terms and requires no L1/L2/L3
  ontology to bend toward it.
- NOT a re-implementation of xAPI / LER / TLA — it **composes** Foxxi for those.
- NOT a leaderboard or a universal gap-analysis. The unit is a performance situation;
  the method follows the regime.
- NOT the L0 affordance layer. `agp:PerformanceAffordance` ≠ `cg:Affordance`.

## Status — staged extraction

This vertical is being carved out of `foxxi-content-intelligence`, where the
regime engine + performance architecture currently live, **without breaking Foxxi**.

- **Stage 1 (this scaffold — done):** the vertical exists; the `agp:` ontology (OWL +
  SHACL) is authored and served dereferenceably; the affordance manifest + MCP surface
  are live. Capability **handlers are pending-Stage-2 stubs** — they validate and echo
  inputs and return an explicit `pending: 'stage-2'` marker; they do **not** fabricate
  results or publish yet.
- **Stage 2 (next):** move the engine modules (`agent-disposition`,
  `performance-architecture`, `performance-calibration`, `knowledge-architecture`,
  `agent-portfolio`, `agent-teaching`, `agent-trajectory`) out of Foxxi into this
  vertical's `src/`; add the publishers; parameterize Foxxi's xAPI-Profile builder so
  `agp:` authors its **own** custom Profile; and rewire Foxxi to compose this vertical.
  Seven specific seams (the `emergent-content` coupling, the `PERFORMED_VERB`
  namespace, the profile-authoring refactor, runtime-store ownership, conformance-IRI
  preservation, the ADP/AC `owl:equivalentClass` mappings, and the SHACL-serving route)
  are tracked from the extraction survey and resolved before any Foxxi code moves.
