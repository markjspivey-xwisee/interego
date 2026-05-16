# Interego L1 — Stability commitment

**Status of the L1 protocol as of 2026-05-16: Last Call Working Draft.**

This is the W3C-style step between "Working Draft" (the editors are still
adding things) and "Candidate Recommendation" (independent
implementations have verified interop). It means: **the editors believe
v1.0 is done and are now hardening, not extending.** This page tells an
adopter what they can rely on starting today, what's still moving, and
what would change either status.

The audit cadence of the past several weeks (correctness fixes layered
on existing primitives, no new ontology terms, conformance suite
extensions) is the natural maturity signal that triggered this status
change. See [CHANGELOG.md](../CHANGELOG.md).

## What you can rely on starting today

For the 12 months from 2026-05-16 through 2027-05-16, the editors
commit that **none of the following will change without a deprecation
cycle of at least one minor version (typically ≥ 90 days)**:

- **Wire format.** Turtle / TriG / JSON-LD serializations of any
  conforming descriptor written today will parse identically by any
  v1.x implementation.
- **Vocabulary in core namespaces.** No term in `cg:`, `cgh:`, `pgsl:`,
  `ie:`, or `align:` will be removed, renamed, or have its semantics
  narrowed. Additive changes (new optional terms, new optional facets)
  are permitted within v1.x.
- **Composition operator semantics.** `union`, `intersection`,
  `restriction`, `override` — the algebraic laws in
  [`spec/architecture.md`](architecture.md) §3.4 are normative and
  fixed. Implementations that rely on those laws (lattice properties,
  associativity, commutativity, absorption) are safe to do so.
- **Modal-truth invariants.** The four-way correspondence
  (Asserted/Quoted ↔ groundTruth=true; Counterfactual/Retracted ↔
  groundTruth=false; Hypothetical ↔ groundTruth absent) is the L1
  contract. No new modal status will be added without a minor version
  bump, and existing ones will not change semantics.
- **`cg:supersedes` chain resolution.** The "latest non-superseded"
  semantics for current-content queries are normative.
- **Conformance levels.** The Level 1 / Level 2 / Level 3 / Level 4
  partition in [`CONFORMANCE.md`](CONFORMANCE.md) is fixed. Tests may
  be added within a level; the partition itself does not move.

## What is explicitly out of scope of the L1 commitment

The protocol stability commitment does NOT extend to anything below.
These are independent surfaces with their own versioning and lifecycle:

- **Reference implementation versions** (`@interego/core`,
  `@interego/mcp`, the hosted relay / identity / dashboard /
  pgsl-browser / CSS containers). The npm packages follow semver
  independently and may have breaking changes in their TypeScript
  API; the L1 protocol they implement is stable. See
  [`RELEASING.md`](../RELEASING.md).
- **L2 patterns** (`hyprcat:`, `hypragent:`, `abac:`, `registry:`,
  `passport:`). These are informative architecture patterns; they
  evolve faster than L1 and are explicitly described in
  [`LAYERS.md`](LAYERS.md) as "informative." Adopters who depend on
  them get best-effort backcompat, not the L1 commitment.
- **L3 implementation and domain ontologies** (`hela:`, `sat:`,
  `cts:`, `olke:`, `amta:`, `code:`, `eu-ai-act:`, `nist-rmf:`,
  `soc2:`). Each evolves on its own cadence. The mappings to L1
  primitives are stable; the domain ontologies themselves can refine.
- **Verticals** (`lpc:`, `adp:`, `lrs:`, `ac:`, `owm:`). Application
  packages under [`applications/`](../applications/). Not part of the
  protocol; not part of the commitment.
- **Deployment topology.** The Tier 0–5 ladder in
  [`STORAGE-TIERS.md`](STORAGE-TIERS.md), the Azure Container Apps
  layout, the personal-bridge reference, the MCP relay — none are
  L1-normative.
- **Compliance frameworks** (SOC 2, EU AI Act, NIST RMF). The
  *mapping ontologies* are stable; the *control set* is the
  regulator's, not ours, and they revise on their own schedule.

If a change in any of the above breaks an adopter, that's on us to
make right pragmatically, but it does not require a minor-version
bump of the L1 protocol.

## What would change L1's status

Forward to **Candidate Recommendation**: when both
1. **Two independent interoperable implementations** pass the L1
   conformance fixtures (see [`conformance/README.md`](conformance/README.md)),
   and
2. **A 30-day review window** completes with no substantive change
   requests from the implementers or external reviewers.

Forward to **Recommendation** (full v1.0): when Candidate
Recommendation has been published for at least 60 days and no
breaking issues have been raised against the conformance suite.

Backward to **Working Draft** (which would be a withdrawal of this
commitment): only if a fatal flaw in §1–§5 is discovered that cannot
be fixed additively. The editors do not currently anticipate this.

## How a second implementation validates

The conformance suite ships under
[`spec/conformance/`](conformance/README.md). A second implementation
runs:

```bash
node spec/conformance/runner.mjs --fixtures spec/conformance/fixtures \
                                  --expected spec/conformance/expected
```

against its own descriptor output, then reports which Level 1
invariants pass. The suite is intentionally dependency-free
(string-level Turtle parsing); a future revision will swap in a full
SHACL engine without changing the fixtures.

We would love to hear from anyone implementing Interego in another
language — Python, Rust, Go, anything. Open an issue at
[github.com/markjspivey-xwisee/interego/issues](https://github.com/markjspivey-xwisee/interego/issues)
and we will work with you to ensure the conformance suite is
accessible from your toolchain.

## How to cite this status

In documentation that depends on Interego:

> Built on Interego v1.0 Last Call Working Draft (2026-05-16). See
> [Interego L1 Stability](https://github.com/markjspivey-xwisee/interego/blob/master/spec/STABILITY.md)
> for the editors' backcompat commitment.

In academic / specification work, cite [`spec/architecture.md`](architecture.md)
as the primary normative source.
