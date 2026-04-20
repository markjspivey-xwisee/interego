# Conformance fixtures — Revocation (category #6)

Fixtures exercising the Revocation Extension proposals (see [`../../../revocation.md`](../../../revocation.md)).

Scope: the SEMANTICS are normative for any adopter of either proposal; the PROPOSALS themselves (facet form vs. predicate form) are rival drafts and neither is required for v1.0 conformance.

## Fixtures

| File | Form | Scenario | Expected |
|---|---|---|---|
| `facet-form.ttl` | Proposal A | Valid 7th-facet revocation condition | Passes SHACL (with Proposal A's extension shapes loaded); triggers revocation when paired with `trigger-hits.ttl`. |
| `predicate-form.ttl` | Proposal B | Valid `cg:revokedIf` predicate on SemioticFacet | Passes SHACL (with Proposal B's extension shapes loaded); triggers revocation when paired with `trigger-hits.ttl`. |
| `self-reference-violation.ttl` | Either | Successor query contains the enclosing descriptor's own graph IRI | `cg:RevocationConditionNoSelfReferenceShape` MUST fire (violation, regardless of proposal). |
| `trigger-hits.ttl` | — | A graph that satisfies the successor query of `facet-form.ttl` and `predicate-form.ttl` | When loaded alongside either proposal's fixture, revocation evaluator MUST transition the original claim's effective `groundTruth` to false (per `cg:MarkInvalid`). |
| `trigger-misses.ttl` | — | A graph that does NOT satisfy the successor query | Evaluator MUST NOT revoke the original claim. |

## Using the fixtures

The conformance-runner skeleton (TBD) loads each paired set into a quad store, runs the revocation evaluator, and compares the resulting `groundTruth` state of the original claim against the expected value in `../expected/revocation-outcomes/`.

## Namespaces

All fixtures use only:

- `cg:` — core protocol (normative terms defined in `cg.ttl`)
- `ex:` — illustrative only; NOT a domain ontology. Any domain predicate appearing in fixtures is `ex:*` and carries no real-world semantics.
- `test:` — fixture identifiers

No domain ontology (`code:`, `med:`, `learning:`, etc.) may appear in conformance fixtures — the conformance suite defines the protocol, not any domain application.
