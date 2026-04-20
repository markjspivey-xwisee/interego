# Layering Discipline

**Status:** Normative process document for the Interego project.
**Scope:** Applies to every artifact produced in this repository — specs, ontologies, reference implementations, examples, documentation.

This document defines the three layers of work that sit under the Interego umbrella, the test that distinguishes them, and the forcing functions that keep the layers from contaminating each other. It exists because the single most common failure mode for a protocol is drift: implementation-specific assumptions leak into the normative spec, and second implementations become impossible.

---

## 1. The three layers

### Layer 1 — Protocol

Normative claims any conforming implementation MUST satisfy to be interoperable.

Examples:

- A descriptor has exactly one of each of the six core facets.
- A revocation condition declares a successor query in SPARQL 1.1.
- An agent credential is a dereferenceable JSON-LD resource conforming to W3C Verifiable Credentials 2.0.
- The descriptor layer is plaintext; the payload layer is encrypted; clients MUST be able to run federation queries over descriptors without decrypting payloads.

Layer 1 artifacts are what a hostile second implementation, written in a different language by a stranger, MUST agree to in order to interoperate.

Normative terminology uses RFC 2119 / RFC 8174 keywords (MUST, SHOULD, MAY, MUST NOT, SHOULD NOT) in the precise senses defined by those RFCs.

### Layer 2 — Architecture

Informative patterns conforming implementations tend to adopt because the protocol makes them natural, but which the protocol does not mandate.

Examples:

- Validator-agents subscribe to Solid Notifications and publish findings as context graphs.
- Ruleset bundles are pinned by IPFS CID so historical validation results remain verifiable.
- Delegation chains are verified by walking up to a registry resource on the owner's pod.
- Disputes are expressed as Counterfactual graphs rather than mutations of the disputed artifact.

Layer 2 artifacts are advice, not mandate. A conformant implementation MAY choose a different pattern (e.g. ActivityPub in place of Solid Notifications, Arweave in place of IPFS) and remain protocol-conformant.

Normative terminology MAY appear in Layer 2 documents, but the RFC 2119 MUST/SHOULD always scope to "to follow this pattern, you MUST..." — never "to conform to Interego 1.0, you MUST follow this pattern."

### Layer 3 — Implementation & Domain

Specific choices bound to a particular deployment, stack, timeline, or domain.

Examples:

- `@interego/core` is a TypeScript reference implementation.
- The relay runs on Azure Container Apps with an Azure Files-backed CSS pod.
- The `code:` vocabulary is one domain ontology that rides on top of Context Graphs.
- The `ex:` namespace used in worked examples is illustrative, not normative.

Layer 3 artifacts have zero normative weight. A second implementation that picked GitLab instead of GitHub, Postgres instead of Azure Files, or a different domain ontology would be identical at Layer 1.

---

## 2. The transplant test

> If you transplanted this artifact into a completely different deployment, stack, or domain, would the claim still make sense?

- **Yes** — Layer 1 or Layer 2. Keep it.
- **No, because it names specific technologies or domains** — Layer 3. Strip the specifics from the normative/pattern text and move the concrete version into a Layer 3 example or a reference-implementation README.
- **No, and it's hard to tell why** — you have a layer-bundled artifact. Split it into its L1 / L2 / L3 constituents before proceeding.

Every artifact produced under this repository MUST pass the transplant test for the layer it claims.

---

## 3. Namespace authority

Layer 1 and Layer 2 namespaces evolve on different timelines than Layer 3 domain ontologies, and they belong under different governance.

- **Core protocol namespaces** (currently `cg:`, `cgh:`, `pgsl:`, `ie:`, `align:`) — governed by the Interego protocol authority. Changes require spec version bumps and conformance-suite updates.
- **Federation-pattern namespaces** (currently `hyprcat:`, `hypragent:`) — Layer 2 applicability patterns. Changes are informative; no conformance-suite impact.
- **Adjacent-framework namespaces** (currently `hela:`, `sat:`, `cts:`, `olke:`, `amta:`) — Layer 3 domain ontologies that happen to live alongside the protocol in this repository for convenience. They MAY be spun out to separate repositories with separate governance without affecting protocol conformance.
- **Illustrative namespaces** (`ex:`, `code:`, any future `med:` / `learning:` / `finance:` / etc.) — Layer 3 domain content. Not part of the protocol. Implementations targeting those domains SHOULD publish their vocabularies under authorities appropriate to those communities.

No domain-specific term is ever added to `cg:`. If a coding-agent use case needs a term, it goes under `code:`, not `cg:`. Same for medical, learning analytics, finance, and every future domain. This rule is enforced by the ontology-lint step and by the transplant test.

---

## 4. Forcing functions

Layer discipline cannot be self-enforcing. Three mechanisms are required to keep it honest:

### 4.1 Conformance test suite

The operational definition of Layer 1. See [conformance/README.md](conformance/README.md).

A change to the Interego protocol is defined as any change that requires an update to the conformance test suite. A change that does not require a conformance-suite update is not a protocol change — it is a Layer 2 or Layer 3 change and ships without a version bump of the protocol.

Every proposal for a Layer 1 change MUST be accompanied by the conformance fixtures that validate the claim.

### 4.2 Transplant-test review gate

Every PR that touches `spec/**`, `docs/ns/**`, or `docs/**` MUST state the layer of the change in the PR description. Reviewers apply the transplant test before approving.

Layer-mislabeled changes are a review-blocking issue: a Layer 3 change masquerading as a Layer 1 change silently contaminates the protocol.

### 4.3 Five drift triggers

If any of the following conditions appear while working on an artifact, work MUST stop and escalate to the protocol authority before proceeding:

1. **Adding a domain-specific term to `cg:` / `cgh:` / `pgsl:` / `ie:` / `align:`.** Domain terms belong in their own namespace.
2. **Writing a MUST / SHOULD in a Layer 1 document that names a specific technology.** "Implementations MUST use Solid Notifications" is not a Layer 1 claim; "implementations MUST provide a subscription mechanism that delivers descriptor creation events" is.
3. **A single work item bundles protocol, pattern, and implementation/domain into one task.** Split into three tasks with three different authorities, three different review surfaces, three different version policies.
4. **Cross-layer contamination detected in an existing artifact.** A Layer 1 spec that imports an `ex:` namespace in a normative section, a Layer 2 applicability note that depends on a specific implementation repo — file an issue and restructure before building on top.
5. **A new artifact cannot be classified as L1, L2, or L3.** If the layer is ambiguous, the artifact is probably bundling multiple layers. Decompose before writing.

---

## 5. How to apply this to new work

Before writing a new spec, proposal, ontology, or applicability note:

1. State the claim in one sentence.
2. Apply the transplant test. Determine the layer.
3. Choose the authority that owns the namespace the claim refers to.
4. Decide whether the claim requires a conformance fixture.
5. Write the artifact in the format appropriate to its layer:
   - **L1:** RFC 2119 prose, SHACL shapes as normative artifacts where applicable, conformance fixtures alongside.
   - **L2:** informative applicability note. Titled "Applicability Note" or "Implementer's Guide." Describes patterns and tradeoffs; never requires them for conformance.
   - **L3:** code repository, worked example, or domain-specific document. Clearly marked as implementation or domain.

If steps 1–5 surface that the claim actually spans layers, decompose before writing.

---

## 6. Current state of this repository

An inventory of the primary artifacts and their layers, for review and gradual correction:

| Artifact | Layer | Notes |
|---|---|---|
| `spec/architecture.md` | L1 + scattered L2 | Core descriptor + facet model is L1. Azure/TypeScript/specific-implementation references should be migrated out or clearly labeled as examples. |
| `spec/paradigm-constraints.md` | L1 | Extension spec. Check for domain examples. |
| `spec/progressive-persistence.md` | L1 | Extension spec. Check for implementation specifics. |
| `spec/presentation-notes.md` | L3 | Talk/speaker notes. Not normative. |
| `spec/conformance/` | L1 (once populated) | The operational definition of conformance. Highest-priority missing artifact. |
| `docs/ns/cg.ttl`, `cgh.ttl`, `pgsl.ttl`, `ie.ttl`, `align.ttl` | L1 | Core protocol ontologies. `cg:` terms MUST NOT carry domain semantics. |
| `docs/ns/hyprcat.ttl`, `hypragent.ttl` | L2 | Federation-pattern ontologies. |
| `docs/ns/hela.ttl`, `sat.ttl`, `cts.ttl`, `olke.ttl`, `amta.ttl` | L3 (adjacent) | Domain/framework ontologies. May later be spun out to separate repositories. |
| `docs/e2ee.md` | L2 + L3 | E2EE envelope architecture is L2 (pattern); deployment specifics are L3. |
| `docs/developer-guide.md` | L3 | Implementation guide. Explicitly targets `@interego/core`. |
| `docs/architecture-context-layer-and-harness.md` | L2 | Applicability note on the context layer / harness duality. |
| `deploy/**` | L3 | Reference deployment only. Not normative. |
| `src/**` | L3 | Reference implementation. Not normative. |
| `examples/**` | L3 | Worked examples. Illustrative only. |

Gradual migration is acceptable. New work MUST be layer-tagged from the start.

---

## 7. Why this matters

The projects most commonly cited as "successful protocols" (HTML, CSS, SPARQL, Solid, DID Core, VC Data Model) all have a conformance test suite and an explicit separation between protocol authority and reference-implementation authority. The projects most commonly cited as "useful products that would have made great protocols" (Rails, Kubernetes, xAPI's 2010-era design, early ActivityPub) failed to maintain this separation and ended up with the first implementation's assumptions welded into the normative spec.

Interego is in the early window where drift can still be reversed. Maintaining layer discipline from here on is the single most important discipline for the project to ship as a protocol rather than as a product that happens to have a schema.
