# Changelog

Notable changes to @interego/core. Dates are UTC.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with RFC 2119-style
capability descriptions. Commit hashes link back to the git history; the README
describes what the system IS, this file describes what changed and when.

---

## 2026-04-22 — protocol streamlining pass

Full-stack audit addressing real gaps surfaced by the "is it
streamlined / dogfooded / composite enough?" self-critique.
Changes layer across protocol → ontology → implementation →
tests → demos.

### Added (L1 — Protocol, `spec/architecture.md`)

- **§6.5a Multi-affordance descriptors and runtime resolution
  (normative).** A descriptor MAY carry multiple `cg:affordance`
  blocks with distinct `cg:action` values. Defines canonical
  action vocabulary (canDecrypt / canFetchPayload / canAudit /
  canPay / canVerify / canCompose), cross-pod affordance rules,
  and the runtime-resolution pattern that turns HATEOAS controls
  into callable tools without harness pre-registration.
- **§6.5b Shape discovery (normative).** Convention for hosting
  shapes at `<pod>/schemas/<shape-id>.ttl` + optional index at
  `<pod>/schemas/index.ttl`. Normative rules for consumers
  distinguishing nominal vs structural conformance when the
  schema URL is unreachable.
- **§6.5c `wasDerivedFrom` consistency (normative).** When a
  descriptor carries `prov:wasDerivedFrom` both inside
  `ProvenanceFacet` and at the top level, the two sets MUST be
  consistent. Divergence is malformed and SHOULD emit a
  diagnostic.

### Added (L1 — Ontology, `docs/ns/cg.ttl`)

- **Four canonical affordance actions:** `cg:canAudit`,
  `cg:canPay`, `cg:canVerify`, `cg:canCompose`. Each declared as
  `cg:Affordance` with rdfs:label + rdfs:comment per lint
  conventions.

### Added (L3 — Implementation, `src/solid/shapes.ts`)

- **Shape-discovery helpers.** `resolveShape(url)` returns a
  `ResolvedShape { body, status, resolved }` so callers
  distinguish network-failure from HTTP-error from success.
  `listPodShapes(podUrl)` reads the index if present.
  `shapeIndexTurtle(entries)` emits the canonical index format.
  Exported from `src/solid/index.ts`.
- **`getDefaultFetch` promoted** from module-private to exported
  so sibling solid/ modules share the same default fetch.

### Added (Tests, `tests/lattice-laws.test.ts`)

- **Seven lattice-law tests** pinning the composition operators'
  algebraic properties: idempotence (type-set level),
  commutativity, associativity, absorption. Tests recognize the
  intentional design decision that Interego union preserves
  multi-facet siblings (modal polyphony) — classical idempotence
  holds at the facet-TYPE-SET level rather than multiset, and
  the test comments document why.

### Added (Demos, `examples/_lib.mjs`)

- **Shared helpers module** eliminating ~150 lines of copy-paste
  across 22+ demo scripts: fetch/put/pool, manifest parse,
  descriptor parse, mini-SHACL shape parse + validate,
  `buildDescriptorTurtle` dogfooding `ContextDescriptor.create()`
  + `toTurtle()`, `publishDescriptorTurtle` as the canonical
  publish path.
- **`demo-accumulation-emergence-v2.mjs`** — demonstrates the
  new pattern. Same semantics as v1 in ~65 lines (v1 was ~125).
  All descriptor authoring via the library builder.

### Rationale (dogfooding path)

Protocol-first: spec gets normative sections for affordance
runtime resolution and shape discovery (neither was
normatively documented before). Ontology absorbs the canonical
action vocabulary. Implementation adds the shape-discovery
helpers the spec now requires. Tests pin the lattice algebra
normatively. Demos migrate to the canonical authoring path.
Each layer's changes enable the next; nothing is left hanging.

### Skipped this pass (legitimate architectural debates)

- **Modal-status promotion to descriptor top level** — the
  Peircean Semiotic facet is the right home; promoting it would
  flatten the interpretant-lens abstraction. Keeping it inside
  `SemioticFacet`.
- **issuer / attester / wasAttributedTo unification** — these
  have legitimately distinct semantics (trust vs provenance vs
  attestation). Kept separate; applicability notes remain a
  future docs task.
- **Spec-as-descriptor bootstrap** — genuinely cool but requires
  meta-shape infrastructure. Tabled until there's a second
  implementation to co-validate against.

---

## 2026-04-21 / 2026-04-22 session

Trust substrate + monetization primitives landed. 25 commits
`242f054` → `499b5be`.

### Added

- **Layered trust demos under `examples/`** — semantic-alignment auditor (v1 → v4,
  recursive meta-audit, adversarial-robust trust fixpoint with phantom-evidence /
  conflict-of-interest / shape-violation detection), cross-auditor consensus
  tool, per-issuer reputation aggregator, federation health check (21 assertions
  covering connectivity, schema resolvability, citation integrity, signature
  validity, cross-pod integrity, affordance execution, adversarial regression,
  audit-chain coherence). Each audit publishes as a descriptor conforming to
  `audit-result-v1`. See [`examples/SEMANTIC-ALIGNMENT-README.md`](examples/SEMANTIC-ALIGNMENT-README.md).
- **ERC-8004 progressive support (T0 → T2).** T0 federation-native attestations
  (`erc8004-attestation-v1.ttl`); T1 ECDSA-signed (secp256k1 via ethers.js,
  tamper-detection verified); T2 IPFS-pinned + signed EIP-1559 transaction
  against the draft Reputation Registry ABI (dry-run — broadcast deferred to
  a funded environment). Descriptor structure is additive across tiers.
  Commits `7ae39c7`, `2bad4bb`, `13f840b`.
- **x402 payment protocol demo.** HTTP-402 challenge → EIP-191 signed
  authorization → retry with `X-Payment` → 200 with tx hash. Real signatures,
  nonce enforcement, replay detection verified live. Settlement stubbed.
  Commit `13f840b`.
- **HATEOAS affordance → callable tool bridge.** Walks the manifest, enumerates
  `cg:affordance` blocks by `cg:action`, resolves each into a runtime-callable
  tool, invokes and publishes the invocation as a first-class descriptor with
  `prov:wasDerivedFrom` back to the source affordance. Commit `9e44b98`.
- **Descriptor-level `conformsTo`.** `ContextDescriptorData.conformsTo?: IRI[]`;
  builder `.conformsTo()`; serializer emits top-level `dct:conformsTo`; manifest
  writer surfaces it for cleartext federation filtering. Commit `0b29028`.
- **Generalized cleartext mirror.** Four cross-descriptor predicates
  (`cg:revokedIf`, `prov:wasDerivedFrom`, `cg:supersedes`, `dct:conformsTo`)
  extracted at publish and threaded onto the cleartext descriptor layer.
  Commit `0b29028`.
- **`effective_at` discover semantics** (spec `§5.2.3`, normative). Interval-
  contains filter distinct from endpoint `valid_from` / `valid_until`. Commits
  `242f054`, `0b29028`.
- **Cross-pod demos.** End-to-end verified: POD-B claims cite POD-A evidence
  by URL; an auditor reading POD-B walks citations into POD-A, fetches
  evidence, and publishes result descriptors citing both pods. No central
  index, no coordination. Commits `af1205a`, `7139346`.

### Changed

- **Turtle-aware extractor** for `normalizePublishInputs`. Two-pass tokenizer
  strips string literals and comments before the IRI-list extractor runs,
  then uses a bracket-counting parser on the raw body for revocation
  conditions. Object-list shorthand (`pred <a>, <b>, <c>`) now extracts
  all three IRIs, not just the first. Commits `280160b`, `8b1a3df`.
- **`xsd:double` serialization** for `cg:epistemicConfidence`. `confidence=1`
  produces `"1.0"^^xsd:double`, not `"1"^^xsd:integer`. Commit `242f054`.
- **Three-valued modal truth.** `Hypothetical` claims no longer auto-write
  `cg:groundTruth false`; the field is omitted (three-valued). `Asserted` →
  true, `Counterfactual` → false. Commits `63e080b`, `cc50be7`.
- **Aggregator + alt-auditor parallelized.** Sequential HTTP fan-out was
  timing out at 60s past ~90 descriptors. Now uses a bounded concurrency
  pool (16 workers) + batched manifest PUT. Full pipeline: 67s.
  Commit `e5553d9`.
- **Dashboard polling** reduced from 3s to 30s default, with a concurrency
  cap of 2. Was exhausting CSS's 6s lock expiry pool. Commit `31e3d26`.
- **Consolidated publish preprocess.** `normalizePublishInputs` helper in
  `@interego/core` replaces the duplicated logic previously inlined in
  `mcp-server` and `deploy/mcp-relay`. Commits `242f054`, `4ba718a`.

### Fixed

- **`cssUnavailable` one-way latch** in mcp-server. Used to poison the whole
  session on a single cold-start fetch failure; now treated as advisory.
  Commit `280160b` (also the Turtle-tokenizer commit).
- **Regex extractor cross-string-literal matching.** An IRI mentioned inside
  a `cg:revokedIf` SPARQL successorQuery was mis-lifted as a top-level
  `dct:conformsTo`. Fixed with the two-pass tokenizer. Commit `280160b`.
- **Revocation SHACL spec.** First-class extension with proposals A
  (`cg:RevocationFacet`) + B (`cg:revokedIf` predicate on `cg:SemioticFacet`).
  Commits `a3c305f`, `cc50be7`.

### Tests

- **`tests/publish-preprocess.test.ts`** — 15 cases pinning string-literal
  blanking, comment skipping, object-list shorthand, and combined
  interactions. Total suite: 670 passing.

---

## Earlier work

Pre-session capability baseline (inherited):

- End-to-end encrypted pod content (X25519 + XSalsa20-Poly1305 envelopes)
- Hypermedia-native data products (cg:Affordance + cgh:Affordance +
  hydra:Operation + dcat:Distribution type union)
- Per-surface agent minting (relay maps OAuth client_name to surface slug)
- Decentralized auth (SIWE / WebAuthn / did:key; no passwords; derived userId)
- Twelve formal ontologies + CI ontology-lint gate
- Six-facet ContextDescriptor model (Temporal / Provenance / Agent /
  AccessControl / Semiotic / Trust / Federation)
- Composition operators (union / intersection / restriction / override)
  forming a bounded lattice
- PGSL content-addressed sequence lattice
- Persistent Solid pod backed by Azure Files
- Validator module (programmatic SHACL-equivalent) + SHACL shapes export
