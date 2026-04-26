# Interego 1.0 — Revocation Extension

**Layer:** Layer 1 — Protocol extension. Normative. See [`LAYERS.md`](LAYERS.md).

**Status:** Working Draft (2026-04-26). **Proposal B (predicate form) is the recommended path** — it is the common case (descriptor author == revocation issuer), ships on top of v1.0 validators without a spec-version bump, and treats revocation as an intrinsic part of the claim's truth state rather than an external governance relationship. **Proposal A (facet form)** remains documented as an extension point for the rarer case where the revocation issuer is structurally distinct from the descriptor author (cross-organization governance, separately-evolving revocation policies, named policy IRIs). Implementations MUST support Proposal B; they MAY additionally support Proposal A. The two are interoperable per §8 — a descriptor written under one form is mechanically rewritable to the other.

**Migration plan (v1.0 → v1.1):** Proposal B graduates to Layer 1 Core in v1.1; Proposal A becomes an optional L2 extension. The reference implementation already extracts both forms from encrypted graph content (`normalizePublishInputs`) so existing pods need no rewrite. Conformance fixtures under [`conformance/fixtures/revocation/`](conformance/fixtures/revocation/) cover both forms; the L1 subset is Proposal B only.

**Latest version:** This document

**Editors:** Interego

**Normative language:** MUST / SHOULD / MAY per RFC 2119 / RFC 8174.

**Scope:** Declarative self-revocation of context graphs. A claim publishes, alongside itself, the conditions under which it ceases to be true. Federation-layer readers evaluate the condition without needing to decrypt the payload. When the condition is satisfied, the claim's effective `cg:groundTruth` transitions according to the declared action.

**Out of scope:** Unilateral revocation by the owner (already covered by `revoke_agent` + `validUntil`), cryptographic revocation tokens (out of scope for this spec; potentially a future extension), and revocation of a claim by its *successor* claim (that's `cg:supersedes`, already in v1.0).

---

## 1. Why this exists

A claim that says "X is true as long as Y hasn't happened" is common and load-bearing. Examples crossing domains:

- "This cached result is valid until the source document changes."
- "This software dependency is secure until CVE Z is published against it."
- "This assumption holds until the production workload's pattern shifts."
- "This assertion is void if the counterparty publishes a revocation of their signing key."

Today, each of these patterns is expressed with prose comments, out-of-band monitors, and hand-rolled invalidation logic. None of it is discoverable by federation readers, none of it is cryptographically signed, and none of it outlives the system that wrote it.

The architectural principle (spec/architecture.md §5.2.1, normative): any claim the federation must reason about MUST be expressible in the cleartext descriptor layer. Revocation conditions are exactly such a claim — a federation reader deciding whether to trust a descriptor needs to know whether its revocation condition has fired, and it cannot decrypt every envelope on every read to find out.

This extension makes revocation conditions first-class, cleartext, and SPARQL-queryable.

**Cleartext-mirror pattern — generalized.** Revocation was the first concrete use of the pattern, but the mirror is not revocation-specific. The reference implementation's `normalizePublishInputs` helper (see [`src/model/publish-preprocess.ts`](../src/model/publish-preprocess.ts)) extracts four classes of cross-descriptor relationship from encrypted graph content and threads them onto the cleartext descriptor at publish time:

| Predicate in content | Mirrored to | Federation-queryable? |
|---|---|---|
| `cg:revokedIf` / `cg:revokedBy` | `cg:SemioticFacet.revokedIf` (Proposal B) or `cg:RevocationFacet` (A) | yes |
| `prov:wasDerivedFrom` | `cg:ProvenanceFacet.wasDerivedFrom` | yes |
| `cg:supersedes` | descriptor-level `cg:supersedes` | yes (manifest) |
| `dct:conformsTo` | descriptor-level `dct:conformsTo` + manifest entry | yes (manifest) |

Any future cross-descriptor predicate a reader must reason about without decryption follows the same shape: add the extraction, add the threading, add the manifest emission. The encrypted payload remains the source of truth; the cleartext mirror is a federation-index over it.

## 2. Shared model (both proposals)

Both proposals use the same `cg:RevocationCondition` structure. This is deliberate — a condition written under one proposal is a blank-node rewrite away from the other. Implementations MUST treat these terms as portable across whichever of A or B is adopted.

```turtle
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .

[] a cg:RevocationCondition ;
    cg:successorQuery """
        PREFIX ex: <https://example.com/ns#>
        ASK WHERE {
            ?g { ?s ex:supersedes <urn:graph:original-claim> . }
        }
    """ ;
    cg:evaluationScope cg:KnownFederation ;
    cg:onRevocation cg:MarkInvalid ;
    cg:revocationIssuer <https://id.example.com/users/alice/profile#me> .
```

### 2.1 `cg:successorQuery`

- MUST be SPARQL 1.1 ASK / SELECT / CONSTRUCT.
- MUST NOT reference the enclosing descriptor's own graph IRI (self-revocation-by-existence is malformed; caught by `cg:RevocationConditionNoSelfReferenceShape` in [`cg-shapes.ttl`](../docs/ns/cg-shapes.ttl)).
- Evaluators MAY reject queries that use update operations (INSERT / DELETE); readers SHOULD treat such queries as advisory-only.

### 2.2 `cg:evaluationScope`

Closed vocabulary:

| Value | Evaluation surface | Expected latency |
|---|---|---|
| `cg:LocalPod` | Descriptors on the declaring pod only | Cheap — no federation calls |
| `cg:KnownFederation` | Every pod in the reader's known-pods registry | Moderate — cached federation state acceptable; eventual consistency OK |
| `cg:WebFingerResolvable` | Any pod reachable via WebFinger / DID resolution from handles cited in the query | Expensive — used only when the strongest guarantee is needed |

### 2.3 `cg:onRevocation`

Closed vocabulary. Implementations MUST support `cg:MarkInvalid`; the others are RECOMMENDED:

| Action | Effect |
|---|---|
| `cg:MarkInvalid` | Effective `cg:groundTruth` → `false`. Modal status behaves as Counterfactual for currently-valid queries. |
| `cg:DowngradeToHypothetical` | Modal status → `cg:Hypothetical`; `groundTruth` → undefined. Signals unsettled truth. |
| `cg:RequireReconfirmation` | Modal status preserved; descriptor flagged as requiring issuer re-signature before use for downstream claims. |

### 2.4 `cg:revocationIssuer`

The agent or principal asserting the condition. MAY differ from the enclosing descriptor's author (a regulator, auditor, or domain authority attaches a revocation policy to someone else's claim). When absent, the enclosing descriptor's author is assumed.

---

## 3. Proposal A — seventh facet `cg:RevocationFacet`

### 3.1 Structure

Revocation gets its own facet class extending `cg:ContextFacet`. A descriptor MAY carry zero or one `cg:RevocationFacet` in addition to the six core facets.

```turtle
<urn:cg:example:1> a cg:ContextDescriptor ;
    cg:hasFacet [ a cg:TemporalFacet ; ... ] ;
    cg:hasFacet [ a cg:ProvenanceFacet ; ... ] ;
    cg:hasFacet [ a cg:AgentFacet ; ... ] ;
    cg:hasFacet [ a cg:SemioticFacet ; ... ] ;
    cg:hasFacet [ a cg:TrustFacet ; ... ] ;
    cg:hasFacet [ a cg:FederationFacet ; ... ] ;
    cg:hasFacet [
        a cg:RevocationFacet ;
        cg:revokedBy [
            a cg:RevocationCondition ;
            cg:successorQuery "..." ;
            cg:evaluationScope cg:KnownFederation ;
            cg:onRevocation cg:MarkInvalid
        ] ;
        cg:revocationIssuer <https://regulator.example.com/profile#me>
    ] .
```

### 3.2 Tradeoffs

**Pros:**

- **Discoverable by facet type.** `discover_context(facet_type=Revocation)` returns every graph declaring a revocation rule without inspecting other facets.
- **Independent issuer.** The facet's `cg:revocationIssuer` MAY point to a third party — a regulator or auditor can attach a revocation policy to a claim whose author they have no control over.
- **Reusable policies.** A revocation policy with its own IRI can be referenced by many descriptors.

**Cons:**

- **Relaxes the six-facet invariant.** v1.0 validators that assert `hasFacet` cardinality `= 6` need updating to `≥ 6` with an at-most-one `RevocationFacet`. That's a v1.1 change, not a patch.
- **Extra schema surface.** New class, new shape, new validator path.

### 3.3 SHACL

`cg:DescriptorSixFacetShape` in [`cg-shapes.ttl`](../docs/ns/cg-shapes.ttl) is already structured as "at least one of each of the six core facets, exactly one of each core facet." Adding Proposal A's extension shape is a separate sh:NodeShape declaring `[ qualifiedValueShape [ sh:class cg:RevocationFacet ] ; qualifiedMaxCount 1 ]` — no conflict with the core.

### 3.4 Example

See [`../spec/conformance/fixtures/revocation/facet-form.ttl`](conformance/fixtures/revocation/facet-form.ttl).

---

## 4. Proposal B — predicate `cg:revokedIf` on `cg:SemioticFacet`

### 4.1 Structure

`cg:revokedIf` is an object property whose domain is `cg:SemioticFacet` and range is `cg:RevocationCondition`. The condition is nested inside the facet that already owns the descriptor's truth state.

```turtle
<urn:cg:example:1> a cg:ContextDescriptor ;
    cg:hasFacet [
        a cg:SemioticFacet ;
        cg:modalStatus cg:Asserted ;
        cg:groundTruth true ;
        cg:epistemicConfidence 0.88 ;
        cg:revokedIf [
            a cg:RevocationCondition ;
            cg:successorQuery "..." ;
            cg:evaluationScope cg:KnownFederation ;
            cg:onRevocation cg:MarkInvalid
        ]
    ] ;
    ... .
```

### 4.2 Tradeoffs

**Pros:**

- **Preserves the exactly-six-facet invariant.** v1.0 validators remain untouched. Ships as v1.0.1 rather than v1.1.
- **Self-contained SemioticFacet.** The facet that declares the current modal status also declares the conditions under which it flips. Natural cohesion.

**Cons:**

- **Not cheaply facet-type-filterable.** `discover_context(facet_type=Revocation)` is not a thing; instead readers filter `facet_type=Semiotic` and inspect the `cg:revokedIf` sub-predicate. Every descriptor has a SemioticFacet, so the filter is not selective.
- **Implicit issuer.** Without a separate facet, there's no natural attachment point for `cg:revocationIssuer` — the enclosing descriptor's author is assumed. Third-party revocation policies don't fit.
- **Overloads the SemioticFacet.** Two jobs now: declare the current modal status, and declare the conditions under which it flips.

### 4.3 SHACL

Proposal B extends `cg:SemioticFacetModalTruthConsistencyShape` (already present in [`cg-shapes.ttl`](../docs/ns/cg-shapes.ttl)) with an `sh:property [ sh:path cg:revokedIf ; sh:class cg:RevocationCondition ; sh:maxCount 8 ]` — the max cardinality is a pragmatic cap; beyond that readers should use Proposal A with an external policy document.

### 4.4 Example

See [`../spec/conformance/fixtures/revocation/predicate-form.ttl`](conformance/fixtures/revocation/predicate-form.ttl).

---

## 5. When to use which (informative)

Use **Proposal A (facet)** when:

- The revocation issuer is different from the descriptor author.
- The revocation policy is reusable across many descriptors and wants its own IRI.
- Discovery by `facet_type=Revocation` matters for the deployment.

Use **Proposal B (predicate)** when:

- The descriptor author is also the revocation issuer (the common case).
- You want to ship on top of v1.0 validators without a spec-version bump.
- The revocation is an intrinsic part of the claim's truth state, not a governance relationship from outside.

---

## 6. Evaluation semantics (normative for any adopter)

A conforming implementation that chooses to support this extension MUST:

1. Before deciding whether a descriptor's claim is currently valid, evaluate every attached `cg:RevocationCondition` against its declared `cg:evaluationScope`.
2. If any condition's `cg:successorQuery` returns a non-empty result (ASK → true, SELECT → ≥ 1 binding, CONSTRUCT → ≥ 1 triple), apply the associated `cg:onRevocation` action.
3. If the successor query cannot be evaluated (engine missing, scope unreachable, query malformed), the implementation MUST fail closed: treat the revocation as undecidable and MUST NOT downgrade the claim silently. Readers SHOULD surface the undecidable state explicitly.
4. Self-reference MUST be rejected: a query containing the enclosing descriptor's own graph IRI is malformed and the entire condition MUST be ignored (with a validation report warning).
5. Revocation actions MUST be idempotent — re-evaluating the same condition MUST produce the same action outcome given the same federation state.

---

## 7. Conformance

See [`conformance/fixtures/revocation/`](conformance/fixtures/revocation/) for the fixture set. Once Proposal A or Proposal B is adopted into v1.1 Core, these fixtures graduate from extension fixtures to core fixtures and the rival form moves to an "archaic" term-status.

## 8. Migration (if both were adopted)

The two proposals are compatible. A descriptor declaring both:

```turtle
<...> a cg:ContextDescriptor ;
    cg:hasFacet [
        a cg:SemioticFacet ;
        cg:revokedIf [ ... Condition-B ... ]
    ] ;
    cg:hasFacet [
        a cg:RevocationFacet ;
        cg:revokedBy [ ... Condition-A ... ]
    ] .
```

...is legal but MUST be interpreted as a logical union: the claim is revoked if EITHER condition fires. Implementations MAY emit a validation warning flagging the mixed form (migration in progress); readers SHOULD prefer the facet when both are present, to encourage consolidation on Proposal A if it wins adoption.

---

## 9. References

- `spec/architecture.md` §5.2.1 — cleartext / ciphertext layering (normative)
- `spec/LAYERS.md` — layering discipline
- `docs/ns/cg.ttl` — shared `cg:RevocationCondition` + both proposals' terms
- `docs/ns/cg-shapes.ttl` — `RevocationConditionNoSelfReferenceShape`
- `spec/conformance/README.md` §6 — revocation-condition evaluation test category
