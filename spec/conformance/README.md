# Interego Conformance Test Suite

**Status:** Initial scaffolding. Test fixtures and runners are being added incrementally.
**Role:** Operational definition of Layer 1 (protocol) conformance for Interego.

---

## What this is

A conformance-test suite that any implementation of the Interego protocol runs to verify it behaves according to spec. Implementations that pass the suite can claim conformance with a given protocol version. Implementations that do not pass cannot.

The suite is the *operational definition of Layer 1*. A change to the protocol is, by definition, a change that requires updating this suite. A change that does not require updates here is a Layer 2 or Layer 3 change and ships without a protocol version bump. See [`../LAYERS.md`](../LAYERS.md).

## What this is not

- Not a test runner for the reference implementation (`@interego/core`). That lives under `tests/` at the repository root.
- Not a linter or a CI hook. Those enforce things that are useful but not normative.
- Not a benchmark. Performance is a Layer 3 concern.
- Not a tutorial. Tutorials belong under `docs/`.

## Structure

```
conformance/
  README.md                     this file
  fixtures/                     input artifacts (Turtle, JSON-LD, SPARQL, Manifest JSON)
    descriptors/                sample ContextDescriptors, both valid and invalid
    envelopes/                  sample E2EE envelopes with known recipient sets
    delegation/                 sample agent registries + credentials + revocation traces
    revocation/                 sample graphs with revocation conditions + trigger graphs
  expected/                     expected evaluation results
    shacl-reports/              expected SHACL validation reports per fixture
    delegation-outcomes/        expected verify_agent outcomes per fixture
    revocation-outcomes/        expected evaluation outcomes per fixture + trigger pair
  manifest.json                 index of test cases; binds fixture -> expected
```

## Fixture namespaces

Conformance fixtures MUST use synthetic, generic namespaces — never a real domain vocabulary. The test suite is the protocol; it MUST NOT accidentally encode domain semantics into Layer 1.

- `cg:` — core protocol namespace, as defined.
- `ex:` — fixture-only illustrative namespace. Not a real vocabulary.
- `test:` — reserved for fixture identifiers and test metadata.

Domain ontologies like a notional `code:` / `med:` / `learning:` MUST NOT appear in fixtures. If a test case needs a domain-shaped predicate, it uses `ex:whatever` and documents the shape, not the meaning.

## Test categories

The target suite covers these categories. Each category is a set of (fixture → expected-outcome) pairs.

1. **Descriptor well-formedness.** Valid and invalid ContextDescriptors. Expected: SHACL validation report. Any conforming implementation MUST produce the same report (up to cosmetic differences in blank-node labeling and string ordering).

2. **Facet semantics.**
   - `SemioticFacet`: modal-status ↔ groundTruth consistency (Asserted ↔ true, Counterfactual ↔ false, Hypothetical ↔ any). Uses SHACL-SPARQL constraints.
   - `TemporalFacet`: `validFrom` ≤ `validUntil`; no upper bound on future `validFrom` other than a future-dated SHOULD warning.
   - `TrustFacet`: closed vocabulary for `trustLevel`.
   - `AgentFacet` and `ProvenanceFacet`: agent-identity cross-check (the agent named in AgentFacet is the same as the one `wasAssociatedWith` in ProvenanceFacet).

3. **Hypermedia affordance block.** Descriptors MUST expose a `cg:affordance` RDF block that is simultaneously `cg:Affordance`, `cgh:Affordance`, `hydra:Operation`, and `dcat:Distribution`, with the properties required by each of those vocabularies satisfied. Fixtures cover both plaintext distributions and encrypted-envelope distributions.

4. **Cleartext / ciphertext boundary.** Descriptor-layer triples MUST be queryable via SPARQL without decrypting the payload. Fixtures: descriptor-only query returns full metadata; payload-layer query against an encrypted envelope fails closed.

5. **Delegation chain verification.** `register_agent` → `verify_agent` → `revoke_agent` → `verify_agent` round-trips. Expected: verify returns `valid: true` after register, `valid: false` with an explicit reason after revoke. Revoked credentials MUST no longer appear in recipient sets of new envelopes (but MUST remain usable to decrypt envelopes encrypted to them prior to revocation).

6. **Revocation condition evaluation.** A graph declares `cg:revokedIf` (or the equivalent on a seventh facet once standardized). A trigger graph satisfies the successor query. Evaluation result: the original claim's effective `cg:groundTruth` transitions to `false`.
   - MUST fail closed: if the successor query cannot be evaluated (scope unreachable, engine unavailable), the claim's `groundTruth` MUST NOT be silently downgraded.
   - MUST reject self-reference: a successor query whose SPARQL text references the enclosing descriptor's own graph IRI is malformed.

7. **Modal status fork integrity.** Given a root activity and two sibling graphs derived from it — one Asserted, one Counterfactual — both MUST be addressable, queryable by `cg:modalStatus`, and distinguishable at the descriptor layer without decryption.

8. **Temporal expiry behavior.** A graph whose `validUntil` has passed MUST be filterable out of "currently-valid" queries. Implementations MAY still expose it via an explicit "include-expired" flag.

9. **Agent role vocabulary closure.** `cg:agentRole` takes one of the closed set `Author | Transformer | Forwarder | Validator | Observer`. Implementations MUST reject values outside this set.

10. **Federation resolvability.** WebFinger (RFC 7033) resolution of an `acct:user@host` handle returns a storage endpoint. DID (`did:web` at minimum) resolution returns a DID document. An implementation that cannot resolve either via the appropriate standard MUST NOT claim conformance.

The list is not exhaustive. Additions go through the same PR gate as any other Layer 1 change: proposal, fixture, expected-outcome, review.

## Running the suite

Once populated, the suite ships a small runner that takes an implementation endpoint (or a library entry point) and a manifest file, and produces a pass/fail report. The runner itself is Layer 3 tooling; the protocol does not require any particular runner, only that the fixtures and expected outcomes are honored.

Draft runner command (not yet implemented):

```
interego-conformance run --impl <endpoint-or-module> --manifest ./manifest.json
```

## Versioning

The suite is versioned alongside the protocol. A protocol version bump MUST be accompanied by a test-suite version bump. Fixtures and expected outcomes from older versions are preserved so that historical claims of conformance remain verifiable.

## Contributing fixtures

Any Layer 1 change proposal MUST include the fixtures that demonstrate the change. The review checklist:

1. Does the fixture use only `cg:`, `ex:`, or `test:` namespaces? (No domain leakage.)
2. Does the fixture exercise a single protocol claim, not a bundle?
3. Does the expected outcome specify behavior precisely enough that two independent implementations would produce the same result?
4. Does the new fixture break any existing fixture? (If yes, declare whether this is a protocol version bump.)

## Next steps (tracked, not done yet)

- [ ] Write the runner skeleton (`runner/`) — walks the manifest, invokes the implementation, compares outputs.
- [ ] Populate `fixtures/descriptors/` with 6–8 valid + invalid descriptors covering the facet-semantics categories.
- [ ] Populate `fixtures/envelopes/` with known-recipient-set envelopes for boundary testing.
- [ ] Publish the first `shacl-core-1.0.ttl` bundle under `fixtures/shapes/` so delegation-chain and facet-semantics tests have a pinnable validator to run against.
- [ ] Pin each bundle by IPFS CID so historical runs remain verifiable.

Until the runner and fixtures ship, "conformance" as a claim is incomplete. Implementations MAY claim "provisional conformance to Interego 1.0 subject to conformance-suite ratification," but no full conformance claim is possible until this suite exists.
