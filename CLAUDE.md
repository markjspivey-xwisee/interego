# CLAUDE.md — @interego/core

## What is this project?

Reference implementation of **Interego** — a verifiable, federated substrate for AI-agent context, identity, and coordination. Three pillars sit on one cryptographic root:

1. **Typed context.** The L1 protocol is **Interego Protocol 1.0** — typed Context Descriptors over RDF 1.2 Named Graphs, with seven facets (Temporal / Provenance / Agent / AccessControl / Semiotic / Trust / Federation), the composition algebra (union / intersection / restriction / override), modal status (Asserted / Hypothetical / Counterfactual), `iep:supersedes` chains, and the PGSL content-addressed lattice.
2. **Verifiable identity.** Wallet-rooted DIDs, capability passports that survive infrastructure migration, public attestation registries, ABAC over typed attributes.
3. **Coordination.** Multi-axis attestation, self-amending constitutional policies, federated saga transactions, p2p relays, vertical applications.

Verticals (LPC, ADP, LRS, AC, OWM) and quickstart deployments compose the substrate — they are NOT part of the protocol. When this document refers to "Interego," it means the system as a whole; when it refers to "Interego Protocol" or "the L1 protocol" or `iep:`, it means the L1 spec specifically.

**L1 Protocol Spec:** `interego-protocol-1.0-wd.html` (co-located or at https://markjspivey-xwisee.github.io/interego/spec/interego-protocol-1.0-wd.html). The `iep:` namespace (`/ns/iep#`) is canonical; the former `cg:` ("Context Graphs") namespace is retained as a deprecated read-alias (`docs/ns/cg.ttl`) so pre-rename signed/persisted descriptors still verify, dereference, and type-match via `canonicalize()`. For why the protocol was renamed away from "Context Graphs" and how Interego relates to the W3C Context Graphs CG + Holon CG, see [`docs/NAME-PROVENANCE.md`](docs/NAME-PROVENANCE.md).

**Architectural foundations:** [`docs/ARCHITECTURAL-FOUNDATIONS.md`](docs/ARCHITECTURAL-FOUNDATIONS.md) — categorical interpretation of the substrate (holonic hypergraphics, PGSL as Grothendieck fibration, HELA as topos, the four invariants, Peircean correspondence). Read this before writing about why the protocol's choices fit together; it is the formal account underneath the informal naming used in the rest of the docs.

## Architecture

TypeScript monorepo (npm workspaces; ESM, Node 20+). The repo is split
into a substrate kernel package and one package per particular
composition over that substrate — the operational reification of the
substrate-vs-vertical line documented in
`docs/ARCHITECTURAL-FOUNDATIONS.md §12`.

```
packages/
  core/          @interego/core — the substrate kernel.
    src/kernel/       The categorical kernel — the substrate's primitives
                      as a first-class API. Eight verbs (mint / dereference
                      / compose / act / restrict / extend / promote /
                      decompose) backed by intra-substrate composition of
                      model/, rdf/, pgsl/, solid/. The operational
                      realization of docs/ARCHITECTURAL-FOUNDATIONS.md
                      §3–§5; see §11 there for the surface itself.
    src/model/        Typed Context Descriptor + 7 facets + composition
                      algebra (HELA's typed-hyperedge category + the 4
                      limit/colimit operators: union, intersection,
                      restriction, override). The substrate's SHAPE.
    src/rdf/          Turtle / TriG / JSON-LD serialization, RDF 1.2
                      helpers, parseTrig subject-extraction parser,
                      virtualized RDF layer + system ontology.
    src/validation/   Shape conformance / SHACL primitives.
    src/sparql/       Standards-compliant SPARQL pattern builders.
    src/crypto/       Abstract signing/verification + ZK primitives.
                      Ethers/nacl-backed wallet impls live here for now;
                      a follow-up `@interego/crypto-impls` split is on
                      the roadmap once the abstract surface stabilizes.
    src/naming/       Naming conventions (L2 attestation-based naming).
    src/affordance/   iep:Affordance shape + OODA/BDI/Active-Inference
                      runtime. The runtime is slated for extraction
                      into @interego/affordance-engine once its PGSL
                      cross-cuts are decoupled.
    src/solid/        Solid+LDP binding (publish/discover/subscribe,
                      anchors, DID resolution, WebFinger, sharing).
                      Currently inside core because the kernel composes
                      against it; planned split to @interego/solid.
    src/pgsl/         Grothendieck-fibration realization (atoms,
                      fragments, pullbacks, agent framework, decision
                      functor, SPARQL engine, SHACL, ontology loaders).
                      Currently inside core because rdf/system-ontology
                      + rdf/virtualized-layer back-reference PGSL;
                      planned split to @interego/pgsl.
  abac/          @interego/abac — Attribute-Based Access Control over
                 substrate descriptors (evaluator + attribute resolver +
                 decision cache + SHACL-shape policy validation).
  compliance/    @interego/compliance — EU AI Act / NIST RMF / SOC 2
                 framework reports + ECDSA-signed lineage walks.
  connectors/    @interego/connectors — Notion / Slack / Web source
                 connectors. Composes @interego/extractors.
  constitutional/ @interego/constitutional — self-amending policies
                 (amendments, votes, ratification, forking, community
                 modal). Built on substrate modal algebra.
  extractors/    @interego/extractors — multi-format content extractors
                 (PDF / JSON / CSV / HTML / plain text) that hash +
                 chunk source content for substrate ingestion.
  ops/           @interego/ops — SOC 2 operational evidence event
                 builders (deploys, access changes, wallet rotations,
                 incidents, quarterly reviews). Uses @interego/compliance.
  p2p/           @interego/p2p — Nostr-style relay-mediated federation.
                 Dual ECDSA + Schnorr signing; in-memory / file-backed /
                 WebSocket-mirror relays.
  passport/      @interego/passport — capability-passport biography
                 (life-event log, demonstrated capabilities, stated
                 values + drift detection, agent keypair loader).
  privacy/       @interego/privacy — pre-publish sensitivity screening
                 (API keys, JWTs, private keys, PII patterns).
  registry/      @interego/registry — public agent attestation registry
                 (register / refresh reputation / federate lookup /
                 aggregate cross-pod reputation).
  security-txt/  @interego/security-txt — RFC 9116 body builder shared
                 by every deployed Interego service.
  skills/        @interego/skills — agentskills.io ↔ iep:Affordance
                 bidirectional translator (parses + emits skill.md
                 frontmatter; maps to descriptor bundles).
  transactions/  @interego/transactions — federated saga-style
                 transactions over substrate descriptors.
```

Plus surrounding infrastructure:

```
mcp-server/    Stdio MCP server — surface = 8 kernel verbs (mint / dereference /
               compose / act / restrict / extend / promote / decompose) AS
               first-class tools + 27 compatibility-shim named tools
               (publish_context / discover_context / register_agent / pgsl_* /
               invoke_affordance / ...). Each shim's description is tagged
               `Compatibility shim — internally composes kernel(...)`. The
               wire format of every shim is unchanged so existing connectors
               keep working. New clients should call the kernel verbs
               directly.
               subscriptions capped at CG_MAX_SUBSCRIPTIONS (default 32);
               unsubscribe_from_pod tool releases a slot.
               invoke_affordance is the universal Path A entry point —
               any vertical's affordances reachable via discover_context
               + get_descriptor + invoke_affordance without a per-vertical
               MCP install (it is internally `act({descriptorUrl, actionIri},
               payload)`). Per-vertical bridges still ship their own native
               MCP surfaces (Path B ergonomics) alongside.
deploy/
  identity/    Stateless DID resolver + signature verifier;
               auth-methods live in each user's pod (auth-methods.jsonld)
  mcp-relay/   HTTP/SSE OAuth-gated MCP proxy for claude.ai connectors;
               per-surface agent minting; cross-pod sharing. Same surface as
               mcp-server: 8 kernel verbs + 27 compatibility-shim named tools.
integrations/
  openclaw-memory/      Path 2 — OpenClaw memory-engine plugin backed by
                        Interego pods. Substrate-pure bridge.ts +
                        OpenClaw glue plugin.ts. Fixed 5-tool HATEOAS
                        surface (3 memory-slot tools + interego_discover
                        + interego_act): results decorated with
                        affordances, followed via followAffordance —
                        reaches the whole substrate without tool bloat.
                        Bridge importable from any runtime (Codex, Cursor).
  hermes-memory/        Path 5 — Hermes Agent MemoryProvider plugin
                        (stdlib-only Python) backed by Interego pods over
                        the MCP relay's REST surface. Same ieh:AgentMemory
                        shape + HATEOAS affordance navigation as the
                        OpenClaw provider.
  compliance-overlay/   Path 4 — generic agent-action → compliance-grade
                        descriptor translator. Cites EU AI Act / NIST RMF /
                        SOC 2 controls via dct:conformsTo into the existing
                        FRAMEWORK_CONTROLS table. No new compliance vocab.
docs/integrations/      Path-1-to-5 integration map for OpenClaw / Hermes /
                        Codex / Cursor / Claude Code etc.
docs/ns/       Twenty OWL ontologies + three SHACL shape files (~880 terms — see docs/ns/README.md)
tools/
  ontology-lint.mjs  Scans TS for iep:/ieh:/pgsl:/ie:/hyprcat:/hypragent:/hela:/
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
- **SAT** ([`sat.ttl`](docs/ns/sat.ttl)) — Semiotic Agent Topos; `sat:SemioticFieldFunctor owl:equivalentClass iep:SemioticFacet`
- **CTS** ([`cts.ttl`](docs/ns/cts.ttl)) — Compositional Tuple Store; usage-based linguistics; `cts:Pattern owl:equivalentClass iep:SyntagmaticPattern`
- **HyprCat** ([`hyprcat.ttl`](docs/ns/hyprcat.ttl)) — federated data-product catalog decorating DCAT + DPROD + Hydra with distributed identity + three-world federation boundary
- **HyprAgent** ([`hypragent.ttl`](docs/ns/hypragent.ttl)) — agent machinery for HyprCat; cross-world delegation; capability typing
- **OLKE** ([`olke.ttl`](docs/ns/olke.ttl)) — Organizational Learning & Knowledge Evolution (Tacit → Articulate → Collective → Institutional)
- **AMTA** ([`amta.ttl`](docs/ns/amta.ttl)) — Agent-Mediated Trust Attestation (multi-axis ratings)
- **abac** ([`abac.ttl`](docs/ns/abac.ttl)) — L2 attribute-based-access-control evaluation pattern. Specifies `Evaluator`, `AttributeResolver`, `DecisionCache`, `PolicyContext`, `EvaluationRecord` as constructions over L1 primitives. Reference runtime in [`packages/abac/`](packages/abac/).
- **registry** ([`registry.ttl`](docs/ns/registry.ttl)) — L2 public-agent-attestation-registry pattern. Federated NPM-for-AI-agents primitive. Reference runtime in [`packages/registry/`](packages/registry/).
- **passport** ([`passport.ttl`](docs/ns/passport.ttl)) — L2 capability-passport pattern. Persistent agent biographical identity that survives infrastructure migration. Reference runtime in [`packages/passport/`](packages/passport/).
- **code** ([`code.ttl`](docs/ns/code.ttl)) — L3 domain ontology for source-code artifacts (Repository, Commit, Branch, PullRequest, Review, Defect, TestRun, BuildResult). Commits are `pgsl:Fragment`; branches are `iep:ParadigmSet`; reviews `iep:constructedFrom (iep:SemioticFacet iep:ProvenanceFacet)`.
- **eu-ai-act** ([`eu-ai-act.ttl`](docs/ns/eu-ai-act.ttl)) — L3 regulatory mapping ontology for the EU AI Act (Articles 6, 9, 10, 12, 13, 14, 15, 50). Lets compliance teams query an Interego pod using the regulation's own vocabulary.
- **nist-rmf** ([`nist-rmf.ttl`](docs/ns/nist-rmf.ttl)) — L3 mapping for NIST AI Risk Management Framework (Govern / Map / Measure / Manage four-function model).
- **soc2** ([`soc2.ttl`](docs/ns/soc2.ttl)) — L3 mapping for AICPA SOC 2 Trust Services Criteria (Security/Availability/Processing Integrity/Confidentiality/Privacy). Operational event subtypes (DeployEvent, AccessChangeEvent, KeyRotationEvent, IncidentEvent, QuarterlyReviewEvent) live alongside the control IRIs and are emitted by [`packages/ops/`](packages/ops/) — Interego eats its own dog food as the SOC 2 evidence substrate. See [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md), [`spec/policies/`](spec/policies/), [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md).

### Ontology hygiene

**Do not invent new `iep:`/`ieh:`/`pgsl:`/`ie:`/`hyprcat:`/`hypragent:`/`hela:`/`sat:`/`cts:`/`olke:`/`amta:`/`abac:`/`registry:`/`passport:`/`code:`/`eu-ai-act:`/`nist-rmf:`/`soc2:` terms in TS code without adding a matching declaration to the corresponding `docs/ns/<prefix>.ttl` file.** CI will block the PR (see `.github/workflows/ontology-lint.yml`). Use existing W3C vocabularies (dcat:, hydra:, prov:, foaf:, etc.) whenever they fit.

### Layering discipline (read before authoring specs, ontologies, or docs)

See [`spec/LAYERS.md`](spec/LAYERS.md). Every artifact in this repository sits on one of three layers — plus a separate non-normative "vertical" surface:

- **Layer 1 — Protocol** (normative): `iep:`, `ieh:`, `pgsl:`, `ie:`, `align:`; `spec/architecture.md`; `spec/conformance/**`. RFC 2119 language.
- **Layer 2 — Architecture** (informative patterns): `hyprcat:`, `hypragent:`, `abac:`, `registry:`, `passport:`; applicability notes; `docs/e2ee.md` architecture sections.
- **Layer 3 — Implementation & Domain** (non-normative): `hela:`, `sat:`, `cts:`, `olke:`, `amta:`; everything under `src/`, `deploy/`, `examples/`; any future domain vocabulary (`code:`, `med:`, `learning:`, ...).
- **Vertical applications** (non-normative, application-over-L3): [`applications/`](applications/) holds vertical use cases that COMPOSE the protocol without extending it. Each has its own scoped namespace OUTSIDE the protocol IRI space (e.g., `lpc:`, `adp:`, `lrs:`, `ac:`, `owm:`). Verticals MUST NOT propose changes to L1/L2/L3 ontologies. Current example verticals: `learner-performer-companion/`, `agent-development-practice/`, `lrs-adapter/`, `agent-collective/`, `organizational-working-memory/`. See [`applications/README.md`](applications/README.md) for layering discipline. **Verticals are NEVER bundled into the generic Interego deployments** (mcp-server, examples/personal-bridge, deploy/mcp-relay). Each vertical declares capabilities as `iep:Affordance` descriptors in `<vertical>/affordances.ts` (single source of truth) and exposes them two ways: (Path A) generic protocol-level discovery via the standard `discover_context` flow, then invocation through the substrate's `invoke_affordance` tool — which proxies the HTTP POST to `hydra:target` so MCP clients without raw-HTTP access can still follow the link, (Path B) optional per-vertical MCP bridge under `<vertical>/bridge/` that derives MCP tool schemas from the affordances. Path A is primary and the only path needed for full access; Path B remains useful as ergonomic native tool surface AND as the mandatory handler runtime for verticals with complex domain logic (PDF/SCORM/BBS+/cmi5 etc.) — even when an MCP client uses Path A to invoke, the handler still executes on the per-vertical bridge process behind `hydra:target`.

**Five drift triggers — STOP and flag before proceeding if any appears:**

1. **Adding a domain-specific term to a core namespace.** `iep:CommitDescriptor`, `iep:MedicalFacet`, `iep:CodeReview` → No. Domain semantics go in their own namespace (`code:`, `med:`, etc.), not in the Layer 1 core.
2. **Writing a MUST/SHOULD in a Layer 1 document that names a specific technology.** "Implementations MUST use Solid Notifications" → No. "Implementations MUST provide a subscription mechanism that delivers descriptor-creation events" → Yes. Layer 1 claims are technology-neutral.
3. **Bundling multiple layers into a single task or PR.** "Build the coding-agent substrate" is actually three things: (a) a Layer 2 applicability note on lifecycle-mirroring, (b) a Layer 3 domain ontology (`code:`), (c) a Layer 3 reference adapter (GitHub App). Split before writing.
4. **Cross-layer contamination detected in an existing artifact.** A Layer 1 spec importing `ex:` in a normative section, a Layer 2 applicability note depending on a specific implementation repo — open an issue and restructure rather than building on top.
5. **A new artifact cannot be classified as L1, L2, or L3.** If the layer is ambiguous, the artifact is probably bundling layers. Apply the transplant test: "would this claim still make sense transplanted into a completely different domain or stack?" — yes → L1/L2; no → L3.

These triggers are enforced by the transplant test at review time. Ontology-lint handles the namespace side of trigger #1 for the current list of core/pattern/adjacent prefixes — do not weaken it to let a domain term into `iep:`.

### E2EE + hypermedia conventions

- Encrypted pod content: use `publish(descriptor, graph, podUrl, { encrypt: { recipients, senderKeyPair } })`. Serialized at `<slug>-graph.envelope.jose.json` with `Content-Type: application/jose+json`.
- Descriptor link to payload: `buildDistributionBlock()` emits `<> iep:affordance [ a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ; iep:action iep:canDecrypt ; hydra:target <…> ; dcat:mediaType "…" ; iep:encrypted true ; ... ]` — clients follow the link; never reconstruct URLs by filename convention.
- Field-level encryption: `encryptFacetValue(value, recipients, sender)` → embeddable `iep:EncryptedValue` blank node in Turtle.
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
