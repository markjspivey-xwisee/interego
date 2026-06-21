# Interego Conformance

This document specifies what it means for an implementation to be
**Interego-compliant**. Compliance is graded by *level* — an
implementation declares which levels it claims to support, and the
conformance test suite verifies the claim.

## Levels

### Level 1 — Core (MUST)

The minimum surface every Interego implementation must support to be
called Interego at all.

- **L1.1 Six-facet invariant:** every `iep:ContextDescriptor` MUST
  carry exactly one of each of the six core facets (Temporal,
  Provenance, Agent, Semiotic, Trust, Federation) plus optionally
  AccessControl. Extension facets (e.g. RevocationFacet, ProjectionFacet,
  CausalFacet) are permitted but never required.
- **L1.2 Modal-truth consistency:** the SemioticFacet's `iep:modalStatus`
  and `iep:groundTruth` MUST agree per spec §5.2.2:
  Asserted ↔ groundTruth=true; Counterfactual ↔ groundTruth=false;
  Hypothetical ↔ groundTruth absent.
- **L1.3 Composition operators:** union, intersection, restriction,
  override MUST be implemented per spec §3.4. Composition results MUST
  be valid descriptors (re-pass L1.1 + L1.2).
- **L1.4 iep:supersedes resolution:** when a descriptor is superseded,
  implementations MUST surface the latest non-superseded version when
  asked for "current" content. Cached views MUST be detectable as
  stale-by-version.
- **L1.5 Shape validation:** SHACL validation against `cg-shapes.ttl`
  MUST conform; an implementation MAY use any SHACL engine.

### Level 2 — Federation (SHOULD)

Required for an implementation to participate in the public
federation. Without L2, an implementation is "Interego-typed" but not
"Interego-federated."

- **L2.1 Pod manifest discovery:** implementations SHOULD read
  `<pod>/.well-known/context-graphs` as the canonical manifest entry
  point.
- **L2.2 Cross-pod attribute resolution:** when computing a subject's
  attribute graph, implementations SHOULD aggregate descriptors
  describing the subject from every reachable pod, not just the
  asking pod.
- **L2.3 WebID / DID resolution:** agent identifiers SHOULD be
  resolvable via at least one of WebID-TLS, did:web, or did:key.
- **L2.4 Solid Notifications:** subscriptions SHOULD use Solid
  Notifications when the source pod supports it; fall back to polling
  otherwise.
- **L2.5 Cross-pod E2EE:** content shared with specific recipients
  SHOULD be encrypted with the recipient's published encryption key
  per the envelope format in `docs/e2ee.md`.

### Level 3 — Advanced (MAY)

Optional capabilities that unlock specific use cases. Compliant
implementations declare which L3 features they support.

- **L3.1 ABAC evaluator:** evaluates `iep:AccessControlPolicy` against
  attribute graphs per `docs/ns/abac.ttl`.
- **L3.2 AMTA aggregation:** aggregates `amta:Attestation` descriptors
  into `registry:ReputationSnapshot` instances.
- **L3.3 RDF 1.2 triple annotations:** parses + emits `{| ... |}`
  triple-term syntax per the April 2026 CR.
- **L3.4 ZK proof verification:** verifies range/Merkle/temporal
  proofs from `src/crypto/zk/`.
- **L3.5 Capability passport:** maintains `passport:Passport` on the
  agent's pod across infrastructure migrations.
- **L3.6 PGSL lattice:** atom/fragment construction + pullbacks per
  `docs/ns/pgsl.ttl`.

### Level 4 — Compliance (deployment-specific MUST)

Required when an implementation is being used as a regulatory
audit-trail substrate (EU AI Act, NIST AI RMF, SOC 2). Strictly
opt-in per deployment; not required for L1+L2 conformance. When
declared, ALL of the following MUST hold for descriptors marked
`compliance: true`:

- **L4.1 Trust upgrade:** `iep:trustLevel` MUST be
  `iep:CryptographicallyVerified`. `SelfAsserted` is not acceptable
  for compliance-grade evidence.
- **L4.2 Modal commitment:** `iep:modalStatus` MUST be `Asserted` or
  `Counterfactual`. `Hypothetical` is not acceptable for audit-trail
  records (a hypothesis isn't evidence).
- **L4.3 Cryptographic signature:** the descriptor MUST carry an
  ECDSA signature over its serialized form via the `Trust` facet's
  `proof` field. Implementations should use ERC-8004 T1 or
  equivalent.
- **L4.4 Anchored:** the descriptor's content hash SHOULD be
  anchored — IPFS CID at minimum, ideally on-chain (ERC-8004 T2/T3).
- **L4.5 Append-only:** updates MUST use `iep:supersedes`; no
  in-place mutation of compliance descriptors.
- **L4.6 Framework citation:** if the descriptor is evidence for
  a specific regulatory framework, it MUST cite the framework's
  control IRI(s) — `eu-ai-act:appliesToSystem` /
  `nist-rmf:contributesTo` / `soc2:satisfiesControl`.
- **L4.7 Privacy preflight:** content MUST pass
  `screenForSensitiveContent` HIGH-severity checks. (Lower severity
  flags require user confirmation but don't block.)

The L4 framework reports (one per regulatory regime) are produced
by `generateFrameworkReport` from `@interego/core` and exposed via
the relay's `/audit/compliance/<framework>` endpoint.

L4 framework mappings shipped today:
- `eu-ai-act:` — Articles 6, 9, 10, 12, 13, 14, 15, 50
- `nist-rmf:` — Govern / Map / Measure / Manage four-function model
- `soc2:` — Trust Services Criteria (Security CC, Availability,
  Processing Integrity, Confidentiality, Privacy)

## Running the conformance suite

```bash
node spec/conformance/runner.mjs
```

The runner emits one of:

```
✓ Interego L1 (Core)
✓ Interego L1+L2 (Core + Federation)
✓ Interego L1+L2+L3 (Core + Federation + Advanced subset)
✗ Non-conformant: <list of failed checks>
```

## Running against a third-party implementation

Drop the third-party's serialized output into a directory under
`spec/conformance/fixtures/<their-impl-name>/` and re-run. The runner
operates on Turtle files at the directory level, so any implementation
that can serialize valid Turtle can be tested.

For the L2/L3 federation tests, the runner needs an HTTP endpoint to
query against. Set `INTEREGO_CONFORMANCE_ENDPOINT=https://your-pod-url/`
before running.

## Compliance badges

Implementations passing L1 may use:

```
[![Interego L1](https://img.shields.io/badge/Interego-L1-blue)](https://github.com/markjspivey-xwisee/interego)
```

L1+L2:

```
[![Interego L1+L2](https://img.shields.io/badge/Interego-L1%2BL2-green)](https://github.com/markjspivey-xwisee/interego)
```

L1+L2+L3:

```
[![Interego Full](https://img.shields.io/badge/Interego-Full-brightgreen)](https://github.com/markjspivey-xwisee/interego)
```

## Failure → debugging

Each runner failure prints:

- The fixture path that failed
- The level (L1/L2/L3) and rule (e.g. L1.2)
- The minimum reproducer
- The expected vs actual

Example:

```
✗ L1.2 modal-truth consistency
  fixture: spec/conformance/fixtures/modal-mismatch/asserted-without-groundtruth.ttl
  reason: descriptor has iep:modalStatus iep:Asserted but no iep:groundTruth
  fix:    add `iep:groundTruth "true"^^xsd:boolean` to the SemioticFacet
```

## Versioning

The conformance suite itself is versioned via `iep:supersedes` like any
other Interego artifact. A passing implementation should declare the
suite version it tested against:

```
[![Interego L1 v1.0](https://img.shields.io/badge/Interego-L1%20v1.0-blue)]
```

Version 1.0 is this document. Future amendments preserve backward
compatibility within a major version: a v1.0 conformant implementation
remains v1.x conformant unless explicitly downgraded by a major
version bump.
