# Changelog

Notable changes to @interego/core. Dates are UTC.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with RFC 2119-style
capability descriptions. Commit hashes link back to the git history; the README
describes what the system IS, this file describes what changed and when.

---

## 2026-04-23 (later) — first L3 domain ontology (`code:`)

The project now ships with a working, lint-gated, runtime-demonstrated
domain-specific knowledge graph — a practical test that the protocol
is sufficient for non-trivial domains without new L1 primitives.

### Added (L3 — Domain)

- **`docs/ns/code.ttl`** — 10 classes + 18 properties for source-code
  artifacts: Repository, Commit, Branch, PullRequest, Review, Defect,
  TestRun, BuildResult, ReviewVerdict, Severity. Every class grounds
  in L1 (cg:/pgsl:) or a W3C vocabulary. Commits are `pgsl:Fragment`;
  branches are `cg:ParadigmSet`; reviews `cg:constructedFrom
  (cg:SemioticFacet cg:ProvenanceFacet)`; defects
  `cg:constructedFrom (cg:SemioticFacet)`.
- **`examples/demo-code-domain.mjs`** — runtime demo of creation +
  utilization. Builds a repo + PR + reviews as `code:` instances,
  composes two opposing reviews via `ModalAlgebra.meet` to derive
  effective PR state, propagates a defect's modal downgrade onto the
  implicated commit via `ModalAlgebra.not + meet`, exhibits branches
  as paradigm alternatives, and composes review × trust × build as
  three independent semiotic facets into a single merge verdict —
  all with zero adapter code.

### Tooling changes

- `tools/derivation-lint.mjs` — adds `code.ttl` to `L2_L3_FILES`.
  Passes: 10/10 classes grounded.
- `tools/ontology-lint.mjs` — registers `code` prefix in
  `OWNED_NAMESPACES`. Passes: 32 terms defined.
- `tools/ontology-lint.allowlist.txt` (new) — single-entry allowlist
  for `code:local`, a false positive from the regex tokenizer
  matching the literal `claude-code:local` URN default in
  `mcp-server/server.ts`. Mechanism now exists for future known-drift
  tracking.
- `CLAUDE.md` — adds `code` to the ontology-hygiene prefix list.

### Why

CLAUDE.md has long listed `code:`, `med:`, `learning:` as example
future domain namespaces to prove the protocol is domain-neutral.
This commit makes that claim concrete for `code:` and verifiable:

- Grounded by derivation-lint (machine-checkable).
- Used by a runnable demo (observable).
- Composed with L1 primitives (`ModalAlgebra`, paradigm set) with
  no new protocol machinery.

If the protocol needs a patch to support a new domain, the
compositional claim is false. It didn't, so the claim holds for at
least one non-trivial case.

707/707 tests pass. Derivation-lint 51/51 grounded. Ontology-lint
clean (1 allowlisted entry).

---

## 2026-04-23 — emergence demo set

Four self-contained simulations showing emergent properties of the
protocol, each isolating one first-principle and exhibiting the
phenomenon it enables. All run under a second, zero network
dependencies, reproducible on any machine.

### Added (L3 — Demos + documentation)

- **`examples/demo-vocabulary-emergence.mjs`** — two agents with
  incompatible vocabularies converge on aligned semantic classes
  through co-occurrence alone. Paradigm operations + `ModalAlgebra`
  modal promotion produce the pullback of the two vocabularies
  without a translator, alignment file, or central coordinator.
- **`examples/demo-emergent-mediator.mjs`** — two pods assert
  disagreeing facts about the same subject; a third "mediator" pod
  is derived at query time as the pullback of the two source
  presheaves. Modal states track the correctness of the mediator's
  inference as sources drift (Asserted → Hypothetical on
  out-of-range updates).
- **`examples/demo-localized-closed-world.mjs`** — same query
  returns different, both-correct authoritative answers inside a
  SHACL closed-shape boundary vs across the open federation.
  Three-way distinction visible: in-scope-present /
  in-scope-absent / out-of-scope.
- **`examples/demo-stigmergic-colony.mjs`** — agents with no map,
  no coordination, and no messaging converge on the globally
  optimal path through a concept graph via shared-pod trace
  dynamics. Reliably finds optimum (91–96% path concentration
  across runs) when the landscape gradient is sufficient to escape
  early lock-in.
- **`docs/EMERGENCE.md`** — documents all four demos, principles
  exercised, falsifiable success criteria, captured outputs, and
  honest limits. Organized so each demo's claim can be verified
  by running the script.

### Why

The existing demos (teach-teach, accumulation-emergence, emergent-dao,
sybil-detection, zk-reputation) exercise the HTTP/Solid surface. These
four isolate the protocol's compositional and categorical dynamics so
emergent properties are visible in a ≤60-line trace. They answer
*what does federation without central authority actually buy*.

No test changes; no ontology changes; 707/707 pass; derivation-lint
41/41 grounded; ontology-lint clean.

---

## 2026-04-22 (later) — derivation discipline

Higher layers now built from lower layers, operationally. Every
L2/L3 ontology class has explicit L1 grounding; every
construction named in the ontology has a runtime constructor.

### Added (L1 — Protocol)

- **`spec/DERIVATION.md`** — normative construction rules for
  L1 → L2 → L3. A class is grounded if it has
  `owl:equivalentClass` / `rdfs:subClassOf` / `cg:constructedFrom`
  or is explicitly marked primitive. Dependencies are
  machine-checkable via `tools/derivation-lint.mjs`.
- **`cg:constructedFrom`** predicate added to `docs/ns/cg.ttl`.
  Declares that a class is constructed at runtime from named L1
  primitives.

### Added (L2/L3 — Ontology grounding)

All seven L2/L3 ontology files now fully grounded (41/41 classes):

- **SAT** (8/8) — Situation, SemioticField, Interpretant, Sign
  all `rdfs:subClassOf cg:*`; Semiosis + EmergentMeaning
  `cg:constructedFrom`.
- **HELA** (6/6) — Trace, LearningObject subclass cg:ContextDescriptor;
  Omega `cg:constructedFrom (pgsl:Fragment cg:SemioticFacet)`.
- **CTS** (7/7) — Tuple subclass pgsl:Fragment; Position/Filler
  subclass pgsl:Atom; Pattern `owl:equivalentClass cg:SyntagmaticPattern`.
- **OLKE** (2/2) — KnowledgeStage subclass cg:SemioticFacet;
  Transition subclass cg:ProvenanceFacet.
- **AMTA** (6/6) — every rating subclass cg:TrustFacet or
  cg:SemioticFacet; Reputation `cg:constructedFrom (amta:Attestation)`.
- **HyprCat** (6/6) — World now subclass cg:FederationFacet;
  others transitively via same-file subclassing.
- **HyprAgent** (6/6) — already grounded.

### Added (L3 — Implementation, `src/model/derivation.ts`)

Runtime constructors for every `cg:constructedFrom`-tagged term:

- **`constructOmega(name, candidates, validityFn)`** — subobject
  classifier for a presheaf topos. Returns three-valued
  `OmegaVerdict` (true / false / indeterminate) consistent with
  the modal algebra.
- **`makeGeometricMorphism(podA, podB)`** — cross-pod citation
  relation (honestly labelled as weaker than a true adjunction
  in the doc comment; the substrate is bipartite-symmetric, not
  directional, which holds monotonicity + emptiness laws but
  not full f* ⊣ f_*).
- **`ModalAlgebra`** — three-valued Heyting algebra on
  {Asserted, Hypothetical, Counterfactual} with meet, join,
  intuitionistic negation, Heyting implication. Modal
  reasoning is now compositional with the bounded-lattice
  composition operators.
- **`FacetTransformation<F>`** — natural-transformation typing
  for merge operations; `composeFacetTransformations` forms a
  monoid.

### Added (Tests + Tooling)

- **`tests/derivation.test.ts`** — 17 tests covering Ω
  classification, geometric-morphism monotonicity, modal-algebra
  laws (idempotence + commutativity + absorption + intuitionistic
  double-negation + Heyting implication reductions), and
  FacetTransformation composition.
- **`tools/derivation-lint.mjs`** — checks every L2/L3 class is
  grounded. Currently passes 41/41; fails CI with a non-zero
  exit if any class becomes ungrounded.

### Closed honest limits from earlier

- ✓ Natural-transformation typing of merge strategies
  (FacetTransformation<F> with monoid laws in code).
- ✓ Ω as a runtime object (constructOmega).
- ✓ Geometric morphisms exist — with an honest caveat that our
  citation-relation model doesn't satisfy full adjunction;
  monotonicity + emptiness laws do hold.
- ✓ Modal Kripke-like semantics via Heyting algebra.

### Remaining (future)

- True directional geometric morphism over a pod inclusion
  (requires refactoring pod representation).
- Full subobject-classifier transport across pods (builds on
  the above).
- Spec-as-descriptor bootstrap (tabled).

Test totals: 694/694 passing. Ontology-lint clean.
Derivation-lint: 41/41 classes grounded.

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
