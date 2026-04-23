# CLAUDE.md — @interego/core

## What is this project?

Reference implementation of **Interego 1.0**, a specification by Interego that defines a compositional framework for typed graph contexts over RDF 1.2 Named Graphs.

**Spec:** `context-graphs-1.0-wd.html` (co-located or at https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html)

## Architecture

TypeScript library (ESM, Node 20+) with eight modules:

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
                ECDSA / SIWE, ZK proofs (Merkle / range / temporal), IPFS CID,
                Pinata pinning
  affordance/   Affordance engine — cgh:Affordance generation at runtime
```

Plus surrounding infrastructure:

```
mcp-server/    Stdio MCP server — 25 tools including publish_context + share_with
deploy/
  identity/    Stateless DID resolver + signature verifier;
               auth-methods live in each user's pod (auth-methods.jsonld)
  mcp-relay/   HTTP/SSE OAuth-gated MCP proxy for claude.ai connectors;
               per-surface agent minting; cross-pod sharing
docs/ns/       Twelve OWL ontologies + three SHACL shape files (607 terms)
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
- **code** ([`code.ttl`](docs/ns/code.ttl)) — L3 domain ontology for source-code artifacts (Repository, Commit, Branch, PullRequest, Review, Defect, TestRun, BuildResult). Commits are `pgsl:Fragment`; branches are `cg:ParadigmSet`; reviews `cg:constructedFrom (cg:SemioticFacet cg:ProvenanceFacet)`. First domain-specific L3 ontology added to the repo — demonstrates that a non-trivial domain can be expressed without new L1 primitives.

### Ontology hygiene

**Do not invent new `cg:`/`cgh:`/`pgsl:`/`ie:`/`hyprcat:`/`hypragent:`/`hela:`/`sat:`/`cts:`/`olke:`/`amta:`/`abac:`/`code:` terms in TS code without adding a matching declaration to the corresponding `docs/ns/<prefix>.ttl` file.** CI will block the PR (see `.github/workflows/ontology-lint.yml`). Use existing W3C vocabularies (dcat:, hydra:, prov:, foaf:, etc.) whenever they fit.

### Layering discipline (read before authoring specs, ontologies, or docs)

See [`spec/LAYERS.md`](spec/LAYERS.md). Every artifact in this repository sits on one of three layers:

- **Layer 1 — Protocol** (normative): `cg:`, `cgh:`, `pgsl:`, `ie:`, `align:`; `spec/architecture.md`; `spec/conformance/**`. RFC 2119 language.
- **Layer 2 — Architecture** (informative patterns): `hyprcat:`, `hypragent:`, `abac:`; applicability notes; `docs/e2ee.md` architecture sections.
- **Layer 3 — Implementation & Domain** (non-normative): `hela:`, `sat:`, `cts:`, `olke:`, `amta:`; everything under `src/`, `deploy/`, `examples/`; any future domain vocabulary (`code:`, `med:`, `learning:`, ...).

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
