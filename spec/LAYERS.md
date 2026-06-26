# Layering Discipline

**Status:** Normative process document for the Interego project.
**Scope:** Applies to every artifact produced in this repository — specs, ontologies, reference implementations, examples, documentation.

This document defines the three layers of work that sit under the Interego umbrella, the test that distinguishes them, and the forcing functions that keep the layers from contaminating each other. It exists because the single most common failure mode for a protocol is drift: implementation-specific assumptions leak into the normative spec, and second implementations become impossible.

---

## 0. Motivating principle: a namespace is a domain's boundary contract

Every namespace in this project (`iep:`, `pgsl:`, `code:`, `med:`, `learning:`, ...) is the published interface of one domain to all others. The terms inside a namespace are what that domain commits to expose; everything else stays inside the domain's own implementation.

This produces three concrete consequences that the rest of this document operationalises:

1. **Domain-specific terms stay out of core namespaces.** `iep:CodeReview` is wrong because the L1 protocol shouldn't know about source code. The right home is `code:Review` in its own L3 ontology that grounds back to L1 via `rdfs:subClassOf` / `iep:constructedFrom`. The protocol's surface area is the contract it offers; if domain terms creep into it, every consumer has to understand every domain.

2. **What's in the ontology is the public commitment.** A `iep:` term that exists in the ontology is something every conformant implementation must understand. A term that's emitted in TS code without an ontology declaration is implicit drift — invisible to outside readers, undocumented, ungraspable by other implementations. The CI lint enforces this asymmetry.

3. **Versioning + deprecation are first-class.** Because the namespace is a contract, changing it is a breaking change to that contract. The `align:` schema-evolution machinery (NamespaceBridge / VersionMigration / DeprecationMarker) gives ratifiable, queryable migration paths so the contract can evolve without silently breaking consumers.

The three layers below are the operational form of this principle: L1 is the universal contract, L2 is patterns over that contract, L3 is per-domain extensions that publish their own contracts grounded in L1.

For background on the broader thesis — how interfaces and projection schemas relate to federated knowledge graphs — see Cagle & Shannon, ["The Interface Is the Contract"](https://theontologist.substack.com/p/the-interface-is-the-contract) (2026).

---

## 1. The three layers

### Layer 1 — Protocol

Normative claims any conforming implementation MUST satisfy to be interoperable.

Examples:

- A descriptor has exactly one of each of the seven core facets.
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
- The `code:` vocabulary is one domain ontology that rides on top of Interego Protocol.
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

- **Core protocol namespaces** (currently `iep:`, `ieh:`, `pgsl:`, `ie:`, `align:`) — governed by the Interego protocol authority. Changes require spec version bumps and conformance-suite updates.
- **Federation-pattern namespaces** (currently `hyprcat:`, `hypragent:`) — Layer 2 applicability patterns. Changes are informative; no conformance-suite impact.
- **Adjacent-framework namespaces** (currently `hela:`, `sat:`, `cts:`, `olke:`, `amta:`) — Layer 3 domain ontologies that happen to live alongside the protocol in this repository for convenience. They MAY be spun out to separate repositories with separate governance without affecting protocol conformance.
- **Illustrative namespaces** (`ex:`, `code:`, any future `med:` / `learning:` / `finance:` / etc.) — Layer 3 domain content. Not part of the protocol. Implementations targeting those domains SHOULD publish their vocabularies under authorities appropriate to those communities.

No domain-specific term is ever added to `iep:`. If a coding-agent use case needs a term, it goes under `code:`, not `iep:`. Same for medical, learning analytics, finance, and every future domain. This rule is enforced by the ontology-lint step and by the transplant test.

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

1. **Adding a domain-specific term to `iep:` / `ieh:` / `pgsl:` / `ie:` / `align:`.** Domain terms belong in their own namespace.
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
| `docs/ns/cg.ttl`, `cgh.ttl`, `pgsl.ttl`, `ie.ttl`, `align.ttl` | L1 | Core protocol ontologies. `iep:` terms MUST NOT carry domain semantics. |
| `docs/ns/hyprcat.ttl`, `hypragent.ttl` | L2 | Federation-pattern ontologies. |
| `docs/ns/hela.ttl`, `sat.ttl`, `cts.ttl`, `olke.ttl`, `amta.ttl` | L3 (adjacent) | Domain/framework ontologies. May later be spun out to separate repositories. |
| `docs/e2ee.md` | L2 + L3 | E2EE envelope architecture is L2 (pattern); deployment specifics are L3. |
| `docs/developer-guide.md` | L3 | Implementation guide. Explicitly targets `@interego/core`. |
| `docs/architecture-context-layer-and-harness.md` | L2 | Applicability note on the context layer / harness duality. |
| `deploy/**` | L3 | Reference deployment only. Not normative. |
| `src/**` | L3 | Reference implementation. Not normative. |
| `examples/**` | L3 | Worked examples. Illustrative only. |

Gradual migration is acceptable. New work MUST be layer-tagged from the start.

### 6.1 Derivation discipline (additive)

Layer discipline says "don't bundle layers." Derivation discipline
(see [`DERIVATION.md`](DERIVATION.md)) says "every non-primitive
term at L2/L3 MUST be grounded in L1."

Grounding means one of:
  (a) `owl:equivalentClass <L1-or-W3C-term>`
  (b) `rdfs:subClassOf <L1-or-W3C-term-or-same-file-grounded-class>`
  (c) `iep:constructedFrom (<primitive> ...)` with a corresponding
      runtime constructor in the reference implementation
  (d) Explicit primitive marker (`rdfs:comment` contains "primitive")

`tools/derivation-lint.mjs` enforces (a)-(d) across every L2/L3
`.ttl`. CI blocks on ungrounded classes. Current status: **41/41
classes grounded**.

Why: the whole point of L1 being the normative protocol is that
higher constructs EMERGE from it via composition. A
`sat:SemiosisEndofunctor` or `amta:Reputation` that's introduced
as a novel primitive at L2/L3 is a covert L1 extension. Grounding
requires you to show your work: either the term specializes an L1
type (a/b), or it's constructible at runtime from L1 primitives
(c, with an actual function in `src/model/derivation.ts`), or
you've declared it primitive (d) and taken responsibility for why.

---

## 7. Why this matters

The projects most commonly cited as "successful protocols" (HTML, CSS, SPARQL, Solid, DID Core, VC Data Model) all have a conformance test suite and an explicit separation between protocol authority and reference-implementation authority. The projects most commonly cited as "useful products that would have made great protocols" (Rails, Kubernetes, xAPI's 2010-era design, early ActivityPub) failed to maintain this separation and ended up with the first implementation's assumptions welded into the normative spec.

Interego is in the early window where drift can still be reversed. Maintaining layer discipline from here on is the single most important discipline for the project to ship as a protocol rather than as a product that happens to have a schema.
