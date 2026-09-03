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
  (`iep:Affordance` — discover → dereference → `act`). Everything here is
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

- **`iep:Affordance` (L0).** A machine-followable REST / HATEOAS transition — what you
  can *do* with a resource right now (`hydra:method` + `hydra:target`). The bridge's
  `affordances.ts` declares these.
- **`agp:PerformanceAffordance` (this vertical).** Affordance theory in the
  *ecological* sense — what a *situation offers a performer given its capabilities*.
  Its **actualization** (`agp:Actualization`) is the productive join
  `Capability × Situation × PerformanceAffordance → Performance`.

They relate — a performance affordance may ultimately be *realized through*
`iep:Affordances` — but they are different layers, in different namespaces, and the
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
  `iep:constructedFrom` its constituent `agp:Skill` + `agp:Tool` (`skos:closeMatch`
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

Instances are published as `iep:ContextDescriptor`s carrying `dct:conformsTo` the
relevant shape; the container declares the shapes so the relay conformance gate
(`runConformanceGate`) validates them **before** the pod write.

## How agents (and teams of agents) reach it

- **Path A (protocol-native):** discover the `iep:Affordance` manifest at
  `GET /affordances`, read `hydra:method` + `hydra:target`, POST the typed inputs.
- **Path B (named MCP tools):** the optional bridge at [`bridge/`](bridge/) exposes
  the same capabilities as `agp.*` tools (port 6030 by default).

Both invoke the same publishers under `src/`. Teams of agents continue to use **Foxxi**
for the xAPI side. The `agp:` Profile is authored through Foxxi's parameterized profile
machinery, so the standards implementation is shared without moving performance theory
back into Foxxi.

## What this is NOT

- NOT a protocol change. It introduces no `iep:` / `pgsl:` terms and requires no L1/L2/L3
  ontology to bend toward it.
- NOT a re-implementation of xAPI / LER / TLA — it **composes** Foxxi for those.
- NOT a leaderboard or a universal gap-analysis. The unit is a performance situation;
  the method follows the regime.
- NOT the L0 affordance layer. `agp:PerformanceAffordance` ≠ `iep:Affordance`.

## Status — independent and composable

The extraction is complete at the ownership boundary: the regime, diagnosis,
intervention, evaluation, calibration, knowledge, teaching, and trajectory engines live
in this vertical's `src/`. Foxxi imports those modules only where a backwards-compatible
route or standards projection composes AGP; it does not own a second performance theory.
The `agp:` ontology, SHACL shapes, xAPI Profile, guidance, HTTP affordances, and named MCP
tools are all served by the AGP bridge.

All ten declared handlers execute real code. Mutation affordances publish validated AGP
artifacts; `agp.list_practice` performs the substrate's manifest walk; and
`agp.prepare_readiness_evidence` is intentionally a pure preparer. That last tool derives
a readiness decision for one exact candidate from held-out results and binds the AGP
diagnosis/evaluations to Foxxi xAPI and portable-record evidence. It does not sign or
publish on behalf of the caller: an authenticated Interego agent reviews and publishes
the prepared graph through the normal descriptor path.

The executable
[`FOXXI × AGP × Release Control cold-start proof`](../../examples/foxxi-agp-release-showcase/README.md)
shows the boundary end to end. A cold agent fails a held-out suite; AGP selects a warranted
A2A intervention; Foxxi emits SCORM, cmi5, xAPI, IEEE-LER, and TLA evidence; AGP derives a
typed readiness attestation; and the generic Application Lab consumes that signed evidence
without importing either vertical. Release Control advances declarative application state
only—it does not deploy infrastructure.
