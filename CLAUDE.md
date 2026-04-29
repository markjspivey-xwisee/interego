# CLAUDE.md — @interego/core

## What is this project?

Reference implementation of **Interego 1.0**, a specification by Interego that defines a compositional framework for typed graph contexts over RDF 1.2 Named Graphs.

**Spec:** `context-graphs-1.0-wd.html` (co-located or at https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html)

## Architecture

TypeScript library (ESM, Node 20+):

```
src/
  model/        Core data model: types, ContextDescriptor builder, composition operators
  rdf/          Namespaces, Turtle serializer, JSON-LD serializer/parser
  validation/   Programmatic SHACL-equivalent validator, SHACL shapes as Turtle export
  sparql/       Parameterized SPARQL 1.2 query pattern builders
  solid/        publish(), discover(), subscribe(), DID resolution, WebFinger,
                cross-pod sharing (resolveRecipients), hypermedia distribution
                link serialization (buildDistributionBlock + parseDistribution…)
  pgsl/         Poly-Granular Sequence Lattice — atoms, fragments, pullbacks,
                mintAtom / mintEncryptedAtom / resolveAtomValue
  crypto/       Real cryptography — nacl/tweetnacl E2EE envelopes
                (createEncryptedEnvelope, openEncryptedEnvelope), field-level
                encryption (encryptFacetValue / decryptFacetValue), ethers.js
                ECDSA / SIWE, BIP-340 Schnorr (@noble/curves) for public-Nostr
                interop, ZK proofs (Merkle / range / temporal), IPFS CID,
                Pinata pinning
  affordance/   Affordance engine — cgh:Affordance generation at runtime
  abac/         Attribute-Based Access Control (L2): policies as descriptors,
                cross-pod attribute resolution, sybil resistance
  registry/     Public agent attestation registry (L2): federated NPM-for-AI
  passport/     Capability passport (L2): persistent agent biographical identity
  compliance/   Compliance-grade publish (L4): ECDSA signing, framework reports,
                wallet rotation w/ history, lineage walking
  ops/          SOC 2 evidence builders: deploy / access change / wallet rotation /
                incident / quarterly review events ready for publish_context
  privacy/      Pre-publish sensitivity screening (API keys, JWTs, PII patterns)
  security-txt/ RFC 9116 body builder (single source of truth across 5 servers)
  p2p/          Tier 5 transport: Nostr-style relay-mediated, ECDSA + Schnorr
                dual signing, 1:N encrypted share via KIND_ENCRYPTED_SHARE.
                Mobile + desktop interop with no central server.
  transactions/ Federated saga transactions (cross-pod atomic writes)
  constitutional/ Self-amending policies (amendments, voting, ratification)
  connectors/   Source connectors: Notion / Slack / Web (extensible)
  extractors/   Content extraction: PDF / JSON / CSV / HTML
```

Plus surrounding infrastructure:

```
mcp-server/    Stdio MCP server — 60 tools including publish_context + share_with;
               subscriptions capped at CG_MAX_SUBSCRIPTIONS (default 32);
               unsubscribe_from_pod tool releases a slot
deploy/
  identity/    Stateless DID resolver + signature verifier;
               auth-methods live in each user's pod (auth-methods.jsonld)
  mcp-relay/   HTTP/SSE OAuth-gated MCP proxy for claude.ai connectors;
               per-surface agent minting; cross-pod sharing
docs/ns/       Nineteen OWL ontologies + three SHACL shape files (~840 terms — see docs/ns/README.md)
tools/
  ontology-lint.mjs  Scans TS for cg:/cgh:/pgsl:/ie:/hyprcat:/hypragent:/hela:/
                     sat:/cts:/olke:/amta: usages vs ontology definitions.
                     CI-gated: new drift fails the build.
```

### Key design decisions

- **Zero runtime dependencies.** Validation is implemented programmatically (no SHACL engine needed). SHACL shapes are exported as Turtle strings for use with external engines.
- **Discriminated union pattern.** All seven facet types use `{ type: 'Temporal' | 'Provenance' |... }` for exhaustive switch matching.
- **Composition is algebraic.** The four operators (union, intersection, restriction, override) form a bounded lattice. Each facet type defines its own merge semantics per the spec.
- **W3C vocabulary reuse.** Every namespace constant, class IRI, and property IRI is typed and exported. The `expand()`/`compact()` helpers handle prefix ↔ full IRI conversion.

### Related concepts (all now formal ontologies in `docs/ns/`)

- **HELA** ([`hela.ttl`](docs/ns/hela.ttl)) — topos-theoretic xAPI stack (presheaf category ℰ = Set^(𝒞_xAPI^op))
- **SAT** ([`sat.ttl`](docs/ns/sat.ttl)) — Semiotic Agent Topos; `sat:SemioticFieldFunctor owl:equivalentClass cg:SemioticFacet`
- **CTS** ([`cts.ttl`](docs/ns/cts.ttl)) — Compositional Tuple Store; usage-based linguistics; `cts:Pattern owl:equivalentClass cg:SyntagmaticPattern`
- **HyprCat** ([`hyprcat.ttl`](docs/ns/hyprcat.ttl)) — federated data-product catalog decorating DCAT + DPROD + Hydra with distributed identity + three-world federation boundary
- **HyprAgent** ([`hypragent.ttl`](docs/ns/hypragent.ttl)) — agent machinery for HyprCat; cross-world delegation; capability typing
- **OLKE** ([`olke.ttl`](docs/ns/olke.ttl)) — Organizational Learning & Knowledge Evolution (Tacit → Articulate → Collective → Institutional)
- **AMTA** ([`amta.ttl`](docs/ns/amta.ttl)) — Agent-Mediated Trust Attestation (multi-axis ratings)
- **abac** ([`abac.ttl`](docs/ns/abac.ttl)) — L2 attribute-based-access-control evaluation pattern. Specifies `Evaluator`, `AttributeResolver`, `DecisionCache`, `PolicyContext`, `EvaluationRecord` as constructions over L1 primitives. Reference runtime in [`src/abac/`](src/abac/).
- **registry** ([`registry.ttl`](docs/ns/registry.ttl)) — L2 public-agent-attestation-registry pattern. Federated NPM-for-AI-agents primitive. Reference runtime in [`src/registry/`](src/registry/).
- **passport** ([`passport.ttl`](docs/ns/passport.ttl)) — L2 capability-passport pattern. Persistent agent biographical identity that survives infrastructure migration. Reference runtime in [`src/passport/`](src/passport/).
- **code** ([`code.ttl`](docs/ns/code.ttl)) — L3 domain ontology for source-code artifacts (Repository, Commit, Branch, PullRequest, Review, Defect, TestRun, BuildResult). Commits are `pgsl:Fragment`; branches are `cg:ParadigmSet`; reviews `cg:constructedFrom (cg:SemioticFacet cg:ProvenanceFacet)`.
- **eu-ai-act** ([`eu-ai-act.ttl`](docs/ns/eu-ai-act.ttl)) — L3 regulatory mapping ontology for the EU AI Act (Articles 6, 9, 10, 12, 13, 14, 15, 50). Lets compliance teams query an Interego pod using the regulation's own vocabulary.
- **nist-rmf** ([`nist-rmf.ttl`](docs/ns/nist-rmf.ttl)) — L3 mapping for NIST AI Risk Management Framework (Govern / Map / Measure / Manage four-function model).
- **soc2** ([`soc2.ttl`](docs/ns/soc2.ttl)) — L3 mapping for AICPA SOC 2 Trust Services Criteria (Security/Availability/Processing Integrity/Confidentiality/Privacy). Operational event subtypes (DeployEvent, AccessChangeEvent, KeyRotationEvent, IncidentEvent, QuarterlyReviewEvent) live alongside the control IRIs and are emitted by [`src/ops/`](src/ops/) — Interego eats its own dog food as the SOC 2 evidence substrate. See [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md), [`spec/policies/`](spec/policies/), [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md).

### Ontology hygiene

**Do not invent new `cg:`/`cgh:`/`pgsl:`/`ie:`/`hyprcat:`/`hypragent:`/`hela:`/`sat:`/`cts:`/`olke:`/`amta:`/`abac:`/`registry:`/`passport:`/`code:`/`eu-ai-act:`/`nist-rmf:`/`soc2:` terms in TS code without adding a matching declaration to the corresponding `docs/ns/<prefix>.ttl` file.** CI will block the PR (see `.github/workflows/ontology-lint.yml`). Use existing W3C vocabularies (dcat:, hydra:, prov:, foaf:, etc.) whenever they fit.

### Layering discipline (read before authoring specs, ontologies, or docs)

See [`spec/LAYERS.md`](spec/LAYERS.md). Every artifact in this repository sits on one of three layers — plus a separate non-normative "vertical" surface:

- **Layer 1 — Protocol** (normative): `cg:`, `cgh:`, `pgsl:`, `ie:`, `align:`; `spec/architecture.md`; `spec/conformance/**`. RFC 2119 language.
- **Layer 2 — Architecture** (informative patterns): `hyprcat:`, `hypragent:`, `abac:`, `registry:`, `passport:`; applicability notes; `docs/e2ee.md` architecture sections.
- **Layer 3 — Implementation & Domain** (non-normative): `hela:`, `sat:`, `cts:`, `olke:`, `amta:`; everything under `src/`, `deploy/`, `examples/`; any future domain vocabulary (`code:`, `med:`, `learning:`, ...).
- **Vertical applications** (non-normative, application-over-L3): [`applications/`](applications/) holds vertical use cases that COMPOSE the protocol without extending it. Each has its own scoped namespace OUTSIDE the protocol IRI space (e.g., `lpc:`, `adp:`, `lrs:`, `ac:`, `owm:`). Verticals MUST NOT propose changes to L1/L2/L3 ontologies. Current example verticals: `learner-performer-companion/`, `agent-development-practice/`, `lrs-adapter/`, `agent-collective/`, `organizational-working-memory/`. See [`applications/README.md`](applications/README.md) for layering discipline. **Verticals are NEVER bundled into the generic Interego deployments** (mcp-server, examples/personal-bridge, deploy/mcp-relay). Each vertical declares capabilities as `cg:Affordance` descriptors in `<vertical>/affordances.ts` (single source of truth) and exposes them two ways: (Path A) generic protocol-level discovery via the standard `discover_context` flow + standard HTTP POST to `hydra:target`, (Path B) optional per-vertical MCP bridge under `<vertical>/bridge/` that derives MCP tool schemas from the affordances. Path A is primary; Path B is ergonomic only.

**Five drift triggers — STOP and flag before proceeding if any appears:**

1. **Adding a domain-specific term to a core namespace.** `cg:CommitDescriptor`, `cg:MedicalFacet`, `cg:CodeReview` → No. Domain semantics go in their own namespace (`code:`, `med:`, etc.), not in the Layer 1 core.
2. **Writing a MUST/SHOULD in a Layer 1 document that names a specific technology.** "Implementations MUST use Solid Notifications" → No. "Implementations MUST provide a subscription mechanism that delivers descriptor-creation events" → Yes. Layer 1 claims are technology-neutral.
3. **Bundling multiple layers into a single task or PR.** "Build the coding-agent substrate" is actually three things: (a) a Layer 2 applicability note on lifecycle-mirroring, (b) a Layer 3 domain ontology (`code:`), (c) a Layer 3 reference adapter (GitHub App). Split before writing.
4. **Cross-layer contamination detected in an existing artifact.** A Layer 1 spec importing `ex:` in a normative section, a Layer 2 applicability note depending on a specific implementation repo — open an issue and restructure rather than building on top.
5. **A new artifact cannot be classified as L1, L2, or L3.** If the layer is ambiguous, the artifact is probably bundling layers. Apply the transplant test: "would this claim still make sense transplanted into a completely different domain or stack?" — yes → L1/L2; no → L3.

These triggers are enforced by the transplant test at review time. Ontology-lint handles the namespace side of trigger #1 for the current list of core/pattern/adjacent prefixes — do not weaken it to let a domain term into `cg:`.

### E2EE + hypermedia conventions

- Encrypted pod content: use `publish(descriptor, graph, podUrl, { encrypt: { recipients, senderKeyPair } })`. Serialized at `<slug>-graph.envelope.jose.json` with `Content-Type: application/jose+json`.
- Descriptor link to payload: `buildDistributionBlock()` emits `<> cg:affordance [ a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ; cg:action cg:canDecrypt ; hydra:target <…> ; dcat:mediaType "…" ; cg:encrypted true ; ... ]` — clients follow the link; never reconstruct URLs by filename convention.
- Field-level encryption: `encryptFacetValue(value, recipients, sender)` → embeddable `cg:EncryptedValue` blank node in Turtle.
- PGSL atom encryption: `mintEncryptedAtom(pgsl, value, recipients, sender)` → URI content-addressed but stored value is `'__ENCRYPTED__'` placeholder; `resolveAtomValue(pgsl, uri, keypair)` decrypts.
- Cross-pod sharing: `publish_context(..., share_with: ['did:web:…', 'acct:bob@…'])` — resolves to external pods' agent registries and adds their X25519 keys to envelope recipients. Per-graph; no pod-level ACL change.

### First-principles guardrails

- **No passwords anywhere.** Auth is SIWE / WebAuthn / did:key signatures over server-issued nonces.
- **DIDs are canonical identifiers; userId is derived, not claimed.** The server never accepts a user-supplied userId. New userIds are deterministic functions of the user's first credential (`u-pk-<sha256(credId)[:12]>` for passkeys, `u-eth-<addr[:12]>` for wallets, `u-did-<sha256(did)[:12]>` for DIDs). `markj` and other seeded legacy userIds are gated behind single-use `BOOTSTRAP_INVITES` env tokens — they function as display aliases + pod-path slugs, not as identifiers anyone can claim. `/register` returns 410 Gone.
- **Per-surface agents are relay-detected.** The relay maps the OAuth client's DCR `client_name` to a surface slug (`chatgpt`, `claude-code-vscode`, `openai-codex`, `cursor`, etc.) and mints `<slug>-<userId>` on identity. Unknown clients fall back to the generic `mcp-client`, never `claude-*`. See `deploy/mcp-relay/server.ts:surfaceAgentFromClient`.
- **Pods are the source of truth.** Identity server is stateless — user auth state (walletAddresses, webAuthnCredentials, didKeys) lives in `<pod>/auth-methods.jsonld`. Users can self-audit via `GET /auth-methods/me` (bearer-gated) to spot any foreign credentials.
- **Storage is zero-trust.** Storage provider sees only ciphertext for private content.
- **Federation is cryptographic.** Recipients via envelope wrapped-keys; no membership service; no central authority.

## Commands

```bash
npm install          # Install devDependencies
npm run build        # Compile TypeScript → dist/
npm test             # Run vitest test suite
npm run test:watch   # Watch mode
npm run lint         # ESLint
```

## Test expectations

- Tests are in `tests/context-graphs.test.ts`
- All composition operator tests use `resetComposedIdCounter()` in `beforeEach` for deterministic IDs
- Currently 40+ test cases covering: builder, composition, validation, Turtle, JSON-LD, namespaces, SPARQL, SHACL

## Conventions

- Immutable data: all `ContextDescriptorData` fields are `readonly`
- IRI type is a branded string for type safety (no runtime overhead)
- Facet type names match the spec's §5 headings: `Temporal`, `Provenance`, `Agent`, `AccessControl`, `Semiotic`, `Trust`, `Federation`
- Composition operators follow §3.4 naming: `union`, `intersection`, `restriction`, `override`
- The `effectiveContext()` function implements the triple-level inheritance rule from §3.5
