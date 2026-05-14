# @interego/core

**Interego is the verifiable, federated substrate AI agents share** — typed context, signed provenance, and coordination across organizations, all on by default. Three pillars over one cryptographic root:

- **Typed context** — typed Context Descriptors (seven facets), composition algebra, modal status, `cg:supersedes` chains, the PGSL content-addressed lattice. The L1 protocol underneath is [**Context Graphs 1.0**](https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html).
- **Verifiable identity** — wallet-rooted DIDs, capability passports that survive infrastructure migration, public agent-attestation registries, attribute-based access control over typed attributes.
- **Coordination** — multi-axis attestation, self-amending constitutional policies, federated saga transactions, Nostr-style p2p relays, and a growing surface of vertical applications.

Wrapped in real cryptography — NaCl envelopes, secp256k1 signatures, ZK commitments, IPFS anchoring — and federated across Solid pods by default. This repository is the reference implementation; `@interego/core` is the L1 library, `@interego/mcp` is the stdio MCP server, [`examples/personal-bridge/`](examples/personal-bridge/) is the local-first deployment, and [`applications/`](applications/) holds independent vertical packages that compose the substrate.

**Author:** Mark Spivey
**License:** MIT

---

## Quick start — pick the path that matches what you're doing

| If you want to… | Go here |
|---|---|
| Use Interego from an AI coding agent right now (Claude Code / Cursor / Windsurf / Cline) | [Recipe: add the MCP server](#-im-an-ai-coding-agent-claude-code-cursor-windsurf-cline--protocol-level-access) |
| Try the hosted reference deployment without running anything | [The deployed Azure surfaces](#hosted-vs-self-hosted-which-path-is-right-for-you) |
| Mount Interego under an OpenClaw / Hermes / Codex runtime | [Agent-runtime integration paths](docs/integrations/agent-runtime-integration.md) — pick Path 1 (MCP), 2 (OpenClaw memory plugin), 3 (skills), 4 (compliance overlay), or 5 (Hermes memory provider) |
| Build a TypeScript app on top of the substrate | [Developer entry point](#-im-a-developer-building-a-typescript-app) |
| Build a vertical (LRS adapter, agent collective, organizational memory) | [Vertical applications](applications/README.md) |
| Run a live demo of multi-agent emergent coordination | [`demos/`](demos/README.md) — 23 end-to-end scenarios |
| Understand the spec / category-theoretic foundations | [`spec/architecture.md`](spec/architecture.md) + [`docs/ARCHITECTURAL-FOUNDATIONS.md`](docs/ARCHITECTURAL-FOUNDATIONS.md) |
| Run a SOC 2 / EU AI Act / NIST RMF audit against an Interego pod | [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) |
| Set up Interego for a non-technical friend or family member | [The hosted front door](https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/) — they enroll a passkey or wallet directly (~30s, no command line), or their MCP client drives it on first call |
| Browse the protocol primitives via web UI | [Dashboard](https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io) + [PGSL Browser](https://interego-pgsl-browser.livelysky-8b81abb0.eastus.azurecontainerapps.io) |

---

## What products inherit

Anything built on Interego inherits five properties without writing them itself:

1. **Federation across organizations** — agent identity is wallet-rooted; cross-pod sharing is per-graph and cryptographically scoped. Single-tenant assumptions don't bind you.
2. **Belief revision as a primitive** — `cg:modalStatus` (Asserted / Hypothetical / Counterfactual) plus `cg:supersedes` chains make claim history and reversal first-class.
3. **Composition on typed data** — union / intersection / restriction / override operators on descriptors, plus PGSL meet/pullback at the atom layer, give structural — not heuristic — answers to "what do these views agree on."
4. **Identity portability** — capability passports survive pod migrations, framework changes, and wallet rotations.
5. **Audit by construction** — every regulatory framework with an L3 mapping (`eu-ai-act:`, `nist-rmf:`, `soc2:`) queries the same descriptors with its own vocabulary. The substrate IS the audit trail.

The verticals under [`applications/`](applications/) are intentionally separate packages, each demonstrating a different shape of product riding the substrate. The most product-shaped of the bunch — [`applications/organizational-working-memory/`](applications/organizational-working-memory/) — turns the substrate into a typed people / projects / decisions / follow-ups surface with per-source navigation isolated behind uniform verbs so the consuming agent's context never sees the per-source noise. The [10-minute quickstart](quickstart/README.md) brings it up via `docker compose`.

---

## Recent additions

The protocol surface has grown substantially. Highlights:

- **Vertical-application examples** (NOT first-party — emergent use cases on top of the protocol) — [`applications/`](applications/) holds reference implementations of how the protocol can be composed for specific industries / domains. They are **separate from Interego itself**: the generic personal-bridge and Azure relay don't load them. Each vertical has:
  1. **A first-principles affordance declaration** ([`applications/<vertical>/affordances.ts`](applications/learner-performer-companion/affordances.ts)) — the spec-level artifact. A generic Interego agent discovers + invokes vertical capabilities via `cg:Affordance` descriptors using only the protocol's own primitives. No vertical-specific client code needed at the agent.
  2. **An optional per-vertical bridge** ([`applications/<vertical>/bridge/`](applications/learner-performer-companion/bridge/)) — a tiny standalone Express + MCP server that reifies the affordances as named MCP tools. Run it when you want LLM tool-name ergonomics; the bridge derives MCP tool schemas from the affordance declarations (single source of truth — never hand-written).

  Current example verticals:
  - **[`learner-performer-companion/`](applications/learner-performer-companion/)** — human-protagonist wallet: SCORM/cmi5/PDF training content + W3C VCs (Open Badges 3.0 / IMS CLR / IEEE LERS) + xAPI history + performance records. Grounded chat with verbatim citation, honest no-data, tamper detection.
  - **[`agent-development-practice/`](applications/agent-development-practice/)** — agent-as-subject: complexity-informed (Cynefin) probe-sense-respond cycle. Probes Hypothetical; multi-coherent-narrative syntheses; evolution steps require `explicitDecisionNotMade`; `passport:LifeEvent` biographical record carries humility forward.
  - **[`lrs-adapter/`](applications/lrs-adapter/)** — boundary translator: bidirectional xAPI ↔ Interego with version negotiation (2.0.0 → falls back to 1.0.3). Counterfactual always skipped on projection; Hypothetical skipped without opt-in.
  - **[`agent-collective/`](applications/agent-collective/)** — multi-agent federation: tool authoring + attestation + teaching packages + cross-bridge encrypted chime-ins.
  - **[`organizational-working-memory/`](applications/organizational-working-memory/)** — federated organizational memory: typed people / projects / decisions / follow-ups / content-addressed notes on the org pod, plus a per-source navigation surface (uniform `ls / cat / grep / recent` verbs) that isolates each external source behind its own sub-handler so the main agent's context is never polluted by per-source tool noise. Demo 15 walks the closed loop: a Curator distills an external page into typed entities; a separate Surfacer agent — different process, no shared memory — recovers the state from the org pod alone.

  See [`applications/README.md`](applications/README.md) for the vertical framing + the layering discipline.

- **CAS-safe `publish()`** — manifest updates use HTTP If-Match (RFC 7232 optimistic concurrency) with retry on 412. Fixes the read-then-write race where parallel publishes against the same pod could clobber each other's manifest entries. Cold-start uses `If-None-Match: *` so two cold-start clients don't race either.

- **Local-first 5-tier storage ladder** — [`spec/STORAGE-TIERS.md`](spec/STORAGE-TIERS.md) documents the deployment progression from Tier 0 (library only, no daemon) → Tier 1 (default — MCP auto-spawns local CSS) → Tier 4 (federated cross-pod) → Tier 5 (P2P relay-mediated). Tier 1 is zero-config; everything else inherits up the stack. Smoke tests for tiers 0/1/4 in [`tests/storage-tiers.test.ts`](tests/storage-tiers.test.ts).
- **P2P transport (Tier 5)** — [`src/p2p/`](src/p2p/) ships a Nostr-style relay-mediated transport so mobile (claude.ai app, ChatGPT app) and desktop (Claude Code, custom MCP clients) interop with no central server we operate. **Two signing schemes coexist on the wire:** ECDSA (Ethereum-style address — matches the existing wallet identity used everywhere else) and BIP-340 Schnorr (32-byte x-only pubkey — for public-Nostr-relay interop). Same wallet, two pubkey representations, `verifyEvent` auto-dispatches by format. **1:N encrypted share** via `KIND_ENCRYPTED_SHARE` (30043) — Tier 4's cross-pod E2EE works over P2P transport too. See [`docs/p2p.md`](docs/p2p.md) for the cross-surface deployment topology + 16 passing tests in [`tests/p2p.test.ts`](tests/p2p.test.ts).
- **Personal bridge** — [`examples/personal-bridge/`](examples/personal-bridge/) is the ready-to-run reference deployment for Tier 5: a small Node process you run on your own infrastructure (laptop / Raspberry Pi / NAS / Tailscale-exposed home server). Embeds `InMemoryRelay`, exposes MCP at `POST /mcp` + REST + an admin UI. **One URL forever, all your devices.** Local-first by default (`EXTERNAL_RELAYS` env var is empty); sharing is per-publish (`share_with`) or per-bridge (broadcast to public Nostr relays). See [`examples/personal-bridge/README.md`](examples/personal-bridge/README.md) for quick start + cross-device connection table.
- **SOC 2 readiness package** — [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) (scope, timeline, vendor inventory, mapping of Interego features to SOC 2 controls, solo-operator compensating controls), [`spec/policies/`](spec/policies/) (15 written policies covering CC1–CC9, A1, C1, P-series), [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md) (deploy/access/key-rotation/backup procedures with current vs target state). [`SECURITY.md`](SECURITY.md) + RFC 9116 `/.well-known/security.txt` on every container app. Operational events (deploy, access change, wallet rotation, incident, quarterly review) build into compliance-grade descriptors via `buildDeployEvent` / `buildAccessChangeEvent` / `buildWalletRotationEvent` / `buildIncidentEvent` / `buildQuarterlyReviewEvent` and `tools/publish-ops-event.mjs` — Interego eats its own dog food as the SOC 2 evidence substrate.
- **Compliance grade publish + regulatory mapping (L4 conformance)** — `publish_context(..., compliance: true, compliance_framework: 'eu-ai-act' | 'nist-rmf' | 'soc2')` produces audit-trail-grade descriptors. Upgrades trust to `CryptographicallyVerified`, signs with ECDSA (secp256k1), embeds inline `cg:proof` in the TrustFacet, writes a sibling `.sig.json` to the pod, auto-pins both to IPFS when configured, validates against the named framework. Wallet rotation + history supported via `rotateComplianceWallet` / `importComplianceWallet`. See [`spec/CONFORMANCE.md`](spec/CONFORMANCE.md) §L4 + [`docs/ns/eu-ai-act.ttl`](docs/ns/eu-ai-act.ttl) / [`nist-rmf.ttl`](docs/ns/nist-rmf.ttl) / [`soc2.ttl`](docs/ns/soc2.ttl).
- **Audit endpoints on the relay** — `/audit/events`, `/audit/lineage`, `/audit/compliance/<framework>`, `/audit/verify-signature`, `/audit/frameworks`. Public read; auditors verify any compliance descriptor's signature without trusting the relay. Companion: [`examples/compliance-dashboard.html`](examples/compliance-dashboard.html) — open in a browser, no install.
- **Privacy-hygiene preflight** — `screenForSensitiveContent` runs in `publish_context` on both surfaces; flags API keys, JWTs, PEM keys, Luhn-valid credit cards, US SSNs, emails/phones/IPs across three severity tiers. Warning surfaced to the calling agent; never silently filtered.
- **Agent enablement** — [`docs/AGENT-PLAYBOOK.md`](docs/AGENT-PLAYBOOK.md) (operational "when X do Y" rules for any LLM driving the MCP) + [`docs/AGENT-INTEGRATION-GUIDE.md`](docs/AGENT-INTEGRATION-GUIDE.md) (one-page integrator guide for OpenClaw/Cursor/Cline/Aider/custom). Both fetched on demand via `docs://interego/playbook` + `docs://interego/integration-guide`. SERVER_INSTRUCTIONS strengthened from descriptive to prescriptive (proactive triggers, modal defaults, error patterns).
- **MCP discoverability** — both stdio (`@interego/mcp` 0.5.0) and HTTP relay (`@interego/mcp-relay` 0.3.0) advertise system instructions, doc resources, workflow prompts on `initialize`. Prompts include `publish-memory`, `discover-shared-context`, `verify-trust-chain`, `whats-on-my-pod`, `publish-audit-record`, `compose-contexts`, `explain-interego`.
- **[Attribute-Based Access Control](docs/ns/abac.ttl) (L2 `abac:`)** — policies are typed context descriptors with SHACL predicates; attributes resolve cross-pod; sybil-resistant via `filterAttributeGraph`. See `examples/demo-abac-cross-pod.mjs`, `demo-abac-sybil-resistance.mjs`, `demo-abac-zk-proof.mjs`, `demo-abac-emergent-policy.mjs`, `demo-abac-policy-supersession.mjs`.
- **[Public Agent Attestation Registry](docs/ns/registry.ttl) (L2 `registry:`)** — federated NPM-for-AI-agents primitive; multiple registries co-exist; reputation aggregates cross-registry.
- **[Capability Passport](docs/ns/passport.ttl) (L2 `passport:`)** — agent biographical identity that survives infrastructure migration (framework / pod / model changes).
- **[Interego Name Service](docs/NAME-SERVICE.md) (L2 — attestation-based naming)** — a name is a verifiable attestation (`<did> foaf:nick "alice"`), not a claimed registration: federated discovery + a pluggable trust policy, no central registrar, no root. Reference runtime in [`src/naming/`](src/naming/index.ts) — `attestName` / `resolveName` (forward, trust-ranked) / `namesFor` (reverse). No new ontology terms.
- **[Code domain ontology](docs/ns/code.ttl) (L3 `code:`)** — first L3 domain example. Demonstrates that a non-trivial domain expresses fully on top of L1 primitives.
- **[RDF 1.2 + SHACL 1.2 alignment](docs/ns/cg-shapes-1.2.ttl)** — triple-term annotations (`{| ... |}`), directional language tags, `sh:reifierShape` validation per April 2026 CR/WD.
- **[Conformance test suite](spec/CONFORMANCE.md)** — four levels (L1 Core / L2 Federation / L3 Advanced / L4 Compliance) with badge output. Run `node spec/conformance/runner.mjs`.
- **[Federated transactions](spec/FEDERATED-TRANSACTIONS.md)** + **[Constitutional layer](spec/CONSTITUTIONAL-LAYER.md)** + **[CRDT offline merge spec](spec/CRDT-OFFLINE-MERGE.md)** + **[DP+ZK aggregate spec](spec/AGGREGATE-PRIVACY.md)** + **[TLA+ proof outlines](spec/proofs/)** — protocol-level guarantees and design specs.
- **45+ runnable demo scripts** in [`examples/`](examples/) including emergence demos, ABAC scenarios, Idehen-inspired (federated reasoning, nanotation pipeline), Verborgh-inspired (distributed affordances, cross-app interop, pod-as-graph views), agent registry, code domain. End-to-end compliance walkthrough at [`examples/compliance-end-to-end.mjs`](examples/compliance-end-to-end.mjs) — `node examples/compliance-end-to-end.mjs` to see ops event → check → framework report → wallet load, no live pod required. Most demos read `CG_DEMO_POD` / `CG_DEMO_POD_B` env vars; defaults point at the maintainer's deployed pods.

- **Twenty-three end-to-end demo scenarios** in [`demos/scenarios/`](demos/scenarios/) — autonomous multi-agent runs against the real Claude Code CLI, including Demo 22 (two agents design + ratify + play a commit-reveal RPS game) and Demo 23 (four agents emerge a federated zero-copy semantic layer over heterogeneous data sources via `hyprcat:`/`align:`/`amta:` composition). See [`demos/README.md`](demos/README.md).

- **Agent-runtime integration paths** — [`docs/integrations/agent-runtime-integration.md`](docs/integrations/agent-runtime-integration.md) maps five ways an OpenClaw / Hermes Agent / Codex / Cursor / Claude Code runtime can mount Interego: (1) MCP server (config-only — every substrate primitive becomes an LLM tool), (2) [OpenClaw memory plugin](integrations/openclaw-memory/) (pod-rooted typed memory replacing the local SQLite, with a fixed 5-tool HATEOAS surface that reaches the whole substrate), (3) [agentskills.io SKILL.md as `cg:Affordance`](docs/integrations/path-3-skills-as-affordances.md) (skills become federated, attestable, governable via existing primitives), (4) [compliance overlay](integrations/compliance-overlay/) (every agent action becomes a signed, framework-cited descriptor), (5) [Hermes memory provider](integrations/hermes-memory/) (a `MemoryProvider` plugin for Nous Research's Hermes Agent — same pod-rooted memory + HATEOAS shape). All five are translators, not extensions — no protocol surface added. [`hermes-full-substrate.md`](docs/integrations/hermes-full-substrate.md) / [`openclaw-full-substrate.md`](docs/integrations/openclaw-full-substrate.md) explain how a runtime reaches *all* of Interego without tool-list bloat.

For dated detail see [`CHANGELOG.md`](CHANGELOG.md).

---

## Hosted vs self-hosted: which path is right for you

Two complementary deployment paths. Both are open-source; both federate; pick by what you need.

| Path | What it is | Best for |
|---|---|---|
| **Hosted reference** ([interego-relay.eastus...](https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io)) | Publicly-hosted Azure deployment. OAuth-gated MCP at `/mcp` exposing **15 protocol-level tools** (publish_context, discover_context, registry/federation, ABAC verification, etc.), per-user pods, claude.ai custom-connector compatible. Operated by the maintainer as a reference instance. | **Evaluation without running your own infrastructure.** You still enroll an identity (passkey / wallet — 2 min via the [landing page](https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/)) and wire up an MCP client; what you skip is hosting the relay / pod / identity server yourself. See the [first-hour walkthrough](docs/FIRST-HOUR.md). Tier 3 substrate. Vertical applications are NOT bundled into this relay — they deploy independently per the [verticals doc](applications/README.md). |
| **Personal bridge** ([`examples/personal-bridge/`](examples/personal-bridge/)) | A small Node binary you run on your own infrastructure (laptop / Pi / NAS / Tailscale-exposed home server). Embedded relay, MCP at `/mcp` exposing **6 core p2p tools** (publish_p2p, share_encrypted, etc.), REST + admin UI. | **Self-hosting + local-first.** Your data on your network; one URL all your devices; sharing is per-publish (`share_with`) or per-bridge (mirror to public Nostr relays via `EXTERNAL_RELAYS`). Tier 5 substrate. Vertical bridges run alongside this generic bridge on different ports — see [`applications/`](applications/). |

**They federate when you need it.** A user on the hosted relay can share with a personal-bridge user via cross-pod E2EE share (Tier 4) or via a common public Nostr relay (Tier 5 with `WebSocketRelayMirror`). Identity stays the same — your wallet's secp256k1 key is your identity on every surface.

**Recommendation:** start on the hosted instance to evaluate; graduate to the personal bridge when you want self-hosting; federate between them whenever it's useful. The hosted instance is *not* the recommended path for production — the personal bridge is. The hosted instance exists so the protocol is approachable; the bridge exists so it's owned.

The hosted relay is intentionally not adding P2P endpoints. Re-centralizing what's deliberately decentralized would defeat the point. P2P lives in your bridge.

---

## Features

For runnable demos of the trust substrate (auditor, ERC-8004 T0-T2, x402, affordance bridge, federation health check) see [`examples/SEMANTIC-ALIGNMENT-README.md`](examples/SEMANTIC-ALIGNMENT-README.md).

### Storage & content

- **End-to-end encrypted pod content.** Every named graph is wrapped in an `X25519 + XSalsa20-Poly1305` envelope with one wrapped key per authorized agent. CSS / Azure Files / IPFS pinning services see only ciphertext. Descriptor *metadata* (facets, manifest entries) stays plaintext so federation queries still work. See [`docs/e2ee.md`](docs/e2ee.md).
- **Persistent pod state.** Solid pod storage is file-backed with an Azure Files volume mounted at `/data`. State survives container restarts.
- **Cleartext mirror for federation reasoning.** Cross-descriptor relationships inside encrypted payloads — `cg:revokedIf`, `prov:wasDerivedFrom`, `cg:supersedes`, `dct:conformsTo` — are extracted at publish time and threaded onto the cleartext descriptor so federation readers evaluate lineage, supersession, and schema conformance without decryption keys. One consolidated helper (`normalizePublishInputs`) runs on every publish path.

### Hypermedia & capabilities

- **Hypermedia-native data products.** Every descriptor self-describes its graph payload via a single RDF block that is simultaneously `cg:Affordance`, `cgh:Affordance`, `hydra:Operation`, and `dcat:Distribution`. Works with DCAT catalogs, Hydra clients, and the affordance-bridge resolver without Interego-specific code.
- **Runtime affordance-to-tool resolution.** An agent walks the pod's manifest, enumerates `cg:affordance` blocks by `cg:action`, and invokes any declared capability without the harness pre-registering it. Invocations publish back as descriptors with `prov:wasDerivedFrom` citing the source affordance — discovered capabilities carry full provenance. See [`examples/affordance-bridge.mjs`](examples/affordance-bridge.mjs).

### Identity & trust

- **Per-surface agents, auto-detected.** Each client (Claude Code, Claude Desktop, Claude Mobile, ChatGPT, Cursor, Codex, Windsurf, …) registers as its own `cg:AuthorizedAgent` with its own `did:web` identity and X25519 keypair. The relay maps the OAuth `client_name` to a surface slug automatically; unknown clients get their slugified name, never a silent fallback.
- **Cross-pod selective sharing.** `publish_context(..., share_with: ["did:web:...", "acct:bob@example.com"])` resolves handles via DID / WebFinger, pulls target agents' keys, adds them as envelope recipients on that one graph. Per-graph; no pod-level ACL change.
- **Decentralized auth — no passwords, no user-claimable identifiers.** SIWE (ERC-4361), WebAuthn passkeys, or `did:key` Ed25519 signatures. userId is *derived* from the first credential (`u-pk-<hash>` / `u-eth-<addr>` / `u-did-<hash>`). Identity server is a stateless DID resolver + signature verifier; user auth state lives in `<pod>/auth-methods.jsonld`. See [`deploy/identity/AUTH-ARCHITECTURE.md`](deploy/identity/AUTH-ARCHITECTURE.md).
- **ERC-8004 progressive support.** T0 federation-native attestations; T1 ECDSA-signed (secp256k1 via ethers.js); T2 IPFS-pinned + signed EIP-1559 transaction against the Reputation Registry. T0 readers parse T1+T2 by ignoring the additive fields — no forking.
- **x402 payment integration.** HTTP-402 challenge → EIP-191 signed authorization → retry with `X-Payment` → 200 with tx hash. Real signatures + nonce enforcement + replay detection. Production settlement is one swap away (EIP-712 `transferWithAuthorization` + x402.org facilitator).

### Discovery

- **`effective_at` interval-contains semantics.** `discover_context(..., effective_at: "...")` returns only descriptors whose validity interval contains the given instant — the "what's valid right now?" query, distinct from endpoint-only filters.
- **Composable auditing.** Structural auditor (vocabulary × modal × independence × derivation) + cross-auditor consensus + per-issuer reputation aggregator. Every audit is itself a descriptor conforming to `audit-result-v1`; monitoring lives inside the system being monitored.

### Ontology & protocol discipline

- **Twenty formal ontologies** covering L1 protocol (`cg:`, `cgh:`, `pgsl:`, `ie:`, `align:`), L2 architecture patterns (`hyprcat:`, `hypragent:`, `abac:`, `registry:`, `passport:`), L3 implementation/domain (`hela:`, `sat:`, `cts:`, `olke:`, `amta:`, `code:`), L3 regulatory mappings (`eu-ai-act:`, `nist-rmf:`, `soc2:`), L3 complexity-aware vocabulary (`wks:`). See [`docs/ns/README.md`](docs/ns/README.md). All terms enforced by CI lint.
- **CI ontology-lint gate.** `tools/ontology-lint.mjs` scans TS source for `<prefix>:<Term>` emissions and verifies each against its corresponding `docs/ns/<prefix>.ttl`. New code cannot land `cg:NewType` without a matching OWL declaration.
- **CI derivation-lint gate.** `tools/derivation-lint.mjs` enforces that every L2/L3 ontology class has explicit L1 grounding (`owl:equivalentClass` / `rdfs:subClassOf` / `cg:constructedFrom` / declared primitive). Currently 91/91 grounded.
- **Layering discipline** (L1 protocol / L2 architecture / L3 implementation). See [`spec/LAYERS.md`](spec/LAYERS.md). Namespace is the boundary contract — domain terms stay out of core namespaces.
- **Conformance test suite** ([`spec/CONFORMANCE.md`](spec/CONFORMANCE.md)) defines L1 / L2 / L3 conformance levels with badge output. Third-party implementations can claim a level by passing the suite against their serialized output.

---

## What It Does

Every Named Graph has context: who created it, when, under what interpretive frame, at what confidence, with what trust credential, through what causal model. Interego makes that context **structured, composable, machine-readable, and cryptographically verifiable**.

An AI agent (Claude Code, Codex, OpenClaw, etc.) produces a knowledge graph. This library wraps that graph with a **Context Descriptor** declaring:

| Facet | What it captures | W3C Alignment |
|-------|-----------------|---------------|
| **Temporal** | When is this valid? | OWL-Time, Dublin Core |
| **Provenance** | Who generated it, from what? | PROV-O |
| **Agent** | Which AI agent, on behalf of which human? | PROV-O, ActivityStreams |
| **AccessControl** | Who can read/write? | WAC |
| **Semiotic** | Asserted or hypothetical? At what confidence? | Peircean triadic semiotics |
| **Trust** | Self-asserted, attested, or cryptographically verified? | VC 2.0, DID Core |
| **Federation** | Where is this stored, how does it sync? | DCAT 3, Solid Protocol |
| **Causal** | What structural causal model governs this? | Pearl's SCM framework |
| **Projection** | How does this map to other vocabularies? | SKOS, Hydra |

Two agents can then **compose** their descriptors via set-theoretic operators (union, intersection, restriction, override) forming a **bounded lattice** — merging knowledge with full provenance chains preserved.

---

## Architecture

```
@interego/core
├── src/
│   ├── model/        Core types, ContextDescriptor builder, composition operators,
│   │                 delegation, category theory (presheaf, naturality, lattice laws),
│   │                 semiotic formalization (Sign functor, adjunction, field functor),
│   │                 open facet registry with merge strategies
│   ├── rdf/          Namespaces (23+), Turtle/JSON-LD/TriG serializers,
│   │                 RDF 1.2 triple annotation support, system ontology (OWL),
│   │                 virtualized RDF layer, SPARQL Protocol, Hydra API descriptions,
│   │                 DCAT/DPROD federation catalog
│   ├── validation/   Programmatic SHACL-equivalent validator, SHACL shapes export
│   ├── sparql/       Parameterized SPARQL 1.2 query pattern builders
│   ├── solid/        publish(), discover(), subscribe(), directory, WebFinger,
│   │                 DID resolution, IPFS anchoring
│   ├── pgsl/         Poly-Granular Sequence Lattice — content-addressed substrate,
│   │                 in-memory SPARQL engine, three-layer SHACL validation,
│   │                 LLM tool interface, ingestion profiles (xAPI, LERS, RDF),
│   │                 entity/relation extraction, fact extraction, computation
│   │                 (date arithmetic, counting, aggregation, abstention detection),
│   │                 coherence verification, decision functor (OODA), paradigm constraints,
│   │                 progressive persistence (5-tier), lazy lattice construction
│   ├── affordance/   Affordance engine integrating 8 frameworks:
│   │                 Gibson, Norman, Pearl, Boyd (OODA), Endsley (SA),
│   │                 Bratman (BDI), Friston (active inference), stigmergy
│   ├── crypto/       Real cryptography — ethers.js ECDSA, NaCl E2E encryption,
│   │                 ZK proofs (Merkle, range, temporal), SIWE (ERC-4361),
│   │                 ERC-8004 agent identity, IPFS CID computation, Pinata pinning,
│   │                 progressive persistence tier system
│   └── causality     Pearl's SCM: do-calculus, d-separation, backdoor/front-door
│                     criteria, counterfactual evaluation
│   │                 coherence verification (usage-based, certificates, coverage),
│   │                 decision functor (OODA: observe→orient→decide→act),
│   │                 paradigm constraints (5 set operations, emergent typing),
│   │                 progressive persistence (memory→local→pod→IPFS→chain),
│   │                 lazy lattice construction (deferred chains, level capping)
├── src/abac/         Attribute-Based Access Control evaluator —
│                     evaluate(), filterAttributeGraph (sybil-resistant),
│                     resolveAttributes (federated), createDecisionCache
├── src/registry/     Public agent attestation registry —
│                     createRegistry, registerAgent, refreshReputation,
│                     federateLookup, aggregateReputation
├── src/passport/     Capability passport (persistent agent biography) —
│                     migrateInfrastructure, recordLifeEvent, stateValue,
│                     passportToDescriptor, passportSummary
├── src/transactions/ Federated saga-pattern transactions —
│                     createTransaction, executeTransaction (with
│                     reverse-compensation on failure)
├── src/constitutional/ Self-amending policies — proposeAmendment, vote,
│                     tryRatify (tier-aware), forkConstitution
├── src/skills/      agentskills.io SKILL.md ↔ cg:Affordance translator —
│                     skillBundleToDescriptor, descriptorGraphToSkillBundle,
│                     parseSkillMd, emitSkillMd. Composes existing affordance
│                     + amta: + supersedes + PromotionConstraint primitives.
├── mcp-server/       MCP server (60 tools) — stdio + SSE + Streamable HTTP.
│                     v0.5.0 ships system-level instructions, doc resources,
│                     workflow prompts so connecting agents understand the
│                     system without trial-and-error tool calls. Subscriptions
│                     capped at CG_MAX_SUBSCRIPTIONS (default 32) per process;
│                     unsubscribe_from_pod releases a slot.
├── deploy/           Dockerfiles, Azure Container Apps, identity server, relay
│   ├── identity/     WebID + DID + Ed25519 + WebFinger + bearer tokens + SIWE
│   ├── mcp-relay/    HTTP/SSE bridge — v0.3.0 mirrors stdio discoverability
│   │                 (instructions / doc resources / prompts) for claude.ai
│   │                 and other web-based MCP clients
│   └── css-config/   Community Solid Server configuration
├── examples/         17+ runnable demos — emergence (vocabulary alignment,
│                     mediator pullback, stigmergic colony, localized
│                     closed-world), ABAC (cross-pod, sybil-resistance, ZK,
│                     emergent policy, supersession), code domain, agent
│                     registry, distributed affordances, cross-app interop,
│                     pod-as-graph views, federated reasoning, nanotation
│                     pipeline, scripts/ for multi-CLI-session orchestration
├── spec/             Specs: architecture, LAYERS, DERIVATION, CONFORMANCE,
│                     FEDERATED-TRANSACTIONS, CONSTITUTIONAL-LAYER,
│                     CRDT-OFFLINE-MERGE, AGGREGATE-PRIVACY, proofs/ (TLA+)
├── benchmarks/       LongMemEval (89.2% agentic, 92.4% raw) evaluation suite
├── integrations/     Path 2 (OpenClaw memory plugin) + Path 4 (compliance overlay)
│                     + Path 5 (Hermes memory provider) — all HATEOAS-shaped
└── tests/            1200+ tests across ~70 files
```

### Design Principles

- **Zero runtime dependencies for the core.** Validation is programmatic. SHACL shapes exported as Turtle strings.
- **Discriminated union pattern.** All 9+ facet types use `{ type: 'Temporal' | 'Provenance' |... }` for exhaustive switch matching.
- **Composition is algebraic.** Four operators form a bounded lattice with category-theoretic proofs (presheaf naturality, idempotence, commutativity, associativity, absorption).
- **Semiotic foundation.** Descriptors are Peircean signs. The Sign functor phi/psi forms an adjunction between the descriptor category and the semiotic category. The Semiotic Field Functor maps to SAT.
- **PGSL substrate.** Content is canonically addressed via the Poly-Granular Sequence Lattice — deterministic, structurally shared, with categorical pullback construction.
- **Real cryptography.** No mocks. ethers.js v6 for ECDSA, tweetnacl for NaCl encryption, real IPFS CIDs, real SIWE verification.
- **Local-first.** Everything works on localhost with zero internet. Cloud deployment is additive.
- **W3C vocabulary reuse.** 23+ standard namespaces (PROV-O, OWL-Time, DCAT, WAC, VC, DID, Solid, Hydra, DPROD, SKOS, FOAF).

---

## Quick Start

Pick the path that matches who you are:

### 🎯 I want to actually USE one of the example verticals (chat with my training content, run a probe cycle, bridge xAPI, etc.)

The example verticals under [`applications/`](applications/) are **separate from Interego** — the generic protocol-level deployments don't bundle them. You reach a vertical's capabilities one of two ways:

**Path A — first-principles (use ANY generic Interego MCP client; no per-vertical install):**

The vertical exposes its capabilities as `cg:Affordance` descriptors. Run any generic Interego agent (e.g., the [stdio MCP server](#-im-an-ai-coding-agent-claude-code-cursor-windsurf-cline--protocol-level-access)), point it at the vertical's affordance manifest, and it discovers + invokes via `discover_context` + a standard HTTP POST to `hydra:target`. No vertical-specific code anywhere on the client side. This is the spec-level path — works for any vertical anyone publishes.

**Path B — opinionated reified bridge (when you want named MCP tools — `lpc.*`, `adp.*`, `lrs.*`, `ac.*` — for ergonomic LLM tool selection):**

Each example vertical has a tiny optional bridge in `applications/<vertical>/bridge/`. Build + run only the ones you want; each is independent, depends on `@interego/core`, and exposes its named tools at its own port:

```bash
# Example: run the learner-performer-companion bridge
cd applications/learner-performer-companion/bridge
npm install && npm run build

export LPC_DEFAULT_POD_URL=https://your-pod.example/me/
export LPC_DEFAULT_USER_DID=did:web:you.example
PORT=6010 BRIDGE_DEPLOYMENT_URL=http://localhost:6010 npm start
```

Add `http://localhost:6010/mcp` to your MCP client config. That bridge exposes the LPC vertical's 6 named MCP tools. Run the others (ADP at 6020, LRS at 6030, AC at 6040) the same way.

**Either path, you can now do (Path A via affordance walking; Path B via named tool):**

- *"Ingest this SCORM zip into my pod"* → `lpc.ingest_training_content` (Path B) or `discover_context` → find `urn:cg:action:lpc:ingest-training-content` → POST (Path A)
- *"What did the customer-service training say about second-contact escalation?"* → `lpc.grounded_answer` — verbatim citation, honest no-data, tamper detection
- *"Define a capability space and record three parallel probes"* → `adp.define_capability` + `adp.record_probe`
- *"Pull this xAPI Statement from our LRS into my pod"* → `lrs.ingest_statement` (auto-negotiates xAPI 2.0 / 1.0.3)
- *"Author this tool, attest it, bundle it as a teaching package"* → `ac.author_tool` → `ac.attest_tool` → `ac.bundle_teaching_package`

Each vertical has Tier 8 integration tests against real Azure CSS + real Lrsql + real SCORM Cloud + public Nostr relay. See [`applications/README.md`](applications/README.md) for the per-vertical framing.

### 🤖 I'm an AI coding agent (Claude Code, Cursor, Windsurf, Cline) — protocol-level access

The fastest way to use the **protocol layer** is via the stdio MCP server, which exposes 60+ tools (publish, discover, ingest, resolve, compose, ontology lookup, runtime eval, identity, federation) to any MCP-capable client.

Add this to your MCP client config:

```jsonc
// Claude Code: ~/.claude.json   |   Claude Desktop: claude_desktop_config.json
// Cursor:.cursor/mcp.json      |   Windsurf: ~/.codeium/windsurf/mcp_config.json
{
  "mcpServers": {
    "context-graphs": {
      "command": "npx",
      "args": ["-y", "@interego/mcp"]
    }
  }
}
```

Restart your client. You can now say things like *"publish this graph to my pod with high trust"*, *"what affordances does this lattice node have?"*, *"resolve this PGSL atom and show its containment chain"* — and the LLM will pick the right tool.

[→ Full MCP server docs](mcp-server/README.md)

### 🧑‍💻 I'm a developer building a TypeScript app

```bash
npm install @interego/core
```

```typescript
import {
  ContextDescriptor,
  createPGSL,
  embedInPGSL,
  loadOntology,        // load any of the four canonical.ttl ontologies
  computeConfidence,   // runtime eval over PGSL signals
} from '@interego/core';

// 1. Build a context descriptor (the typed-context layer)
const desc = ContextDescriptor.create('urn:cg:my-analysis:1')
.describes('urn:graph:my-data')
.temporal({ validFrom: '2026-04-13T00:00:00Z' })
.asserted(0.92)
.build();

// 2. Use the PGSL substrate
const pgsl = createPGSL({ wasAttributedTo: 'urn:my-app', generatedAtTime: new Date().toISOString() });
embedInPGSL(pgsl, "The user prefers Adobe Premiere Pro for video editing.");

// 3. Load the canonical harness ontology
const harnessTtl = loadOntology('harness');  // 982 lines, 810 triples
```

[→ See the full developer guide](docs/developer-guide.md)

### 🐍 I'm scripting in Python / Go / Rust / anything else

Hit the deployed HTTP relay (any HTTP client works — no MCP, no SDK):

```bash
curl -X POST https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/tools/discover_context \
  -H "Content-Type: application/json" \
  -d '{"namespace": "cg"}'
```

Every MCP tool is exposed as a `POST /tools/{tool_name}` endpoint with a JSON body matching the tool's input schema.

### 👀 I just want to look around

Open one of the deployed web UIs in your browser — no install required:

- **Landing page / enroll:** https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io — passkey / wallet / DID enrollment, friendly first-time-user surface
- **Your dashboard:** https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/dashboard — your DID, registered credentials, pod inbox (requires you've enrolled first)
- **PGSL Browser:** https://interego-pgsl-browser.livelysky-8b81abb0.eastus.azurecontainerapps.io
- **Compliance Dashboard:** https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io

### 👶 I'm new — what's the actual first-hour experience?

[**First-hour walkthrough**](docs/FIRST-HOUR.md) — guided tour for non-developers. Enroll an identity, visit your dashboard, wire up an AI client, publish your first memory, recall it later, share with a friend. 30 minutes, no CLI.

Companion docs:
- [Recovery flows](docs/RECOVERY-FLOWS.md) — what to do when you lose a credential or rotate keys
- [Mobile parity](docs/MOBILE-PARITY.md) — what works from phone-based clients
- [OAuth setup per client](deploy/mcp-relay/OAUTH-SETUP.md) — Claude Code / Cursor / Hermes / OpenClaw / ChatGPT

### 🛠 I want to clone and hack on the system itself

```bash
git clone https://github.com/markjspivey-xwisee/interego.git
cd context-graphs
npm install
npm run build
npm test  # 1119+ tests across 65 files (3 env-gated tests skip when their creds are unset)

# Build the MCP server too
cd mcp-server
npm install ../interego-core-*.tgz --no-save
npm run build

# Deploy to your own Azure (one-time)
./deploy/azure-deploy.sh
```

CI auto-deploys to Azure Container Apps on every push to `master` ([workflow](.github/workflows/deploy-azure.yml)). Tagging a release as `vX.Y.Z` triggers npm publish for both packages ([workflow](.github/workflows/publish-npm.yml)).

---

## Detailed Examples

### Build a Context Descriptor

```typescript
import { ContextDescriptor, validate, toTurtle } from '@interego/core';
import type { IRI } from '@interego/core';

const descriptor = ContextDescriptor.create('urn:cg:my-analysis:1' as IRI)
.describes('urn:graph:project:arch-v1' as IRI)
.temporal({ validFrom: '2026-03-20T00:00:00Z' })
.delegatedBy(
    'https://id.example.com/alice/profile#me' as IRI,  // owner (human)
    'urn:agent:anthropic:claude-code:vscode' as IRI,    // agent (AI)
  )
.asserted(0.92)
.selfAsserted('did:web:alice.example' as IRI)
.federation({
    origin: 'https://pod.example.com/alice/' as IRI,
    storageEndpoint: 'https://pod.example.com/alice/' as IRI,
    syncProtocol: 'SolidNotifications',
  })
.version(1)
.build();

const result = validate(descriptor);
console.log(result.conforms); // true
console.log(toTurtle(descriptor));
```

### Publish to a Solid Pod

```typescript
import { publish, discover, subscribe } from '@interego/core';

const result = await publish(descriptor, graphTurtle, 'https://pod.example.com/alice/');
// → { descriptorUrl, graphUrl, manifestUrl }
// → IPFS pinned (if configured): ipfs://Qm...
// → Anchor receipt written to pod: /anchors/{id}.json

const entries = await discover('https://pod.example.com/bob/', {
  facetType: 'Semiotic', validFrom: '2026-01-01T00:00:00Z',
});

const sub = await subscribe('https://pod.example.com/bob/', (event) => {
  console.log(`${event.type} on ${event.resource}`);
});
```

### Compose Descriptors

```typescript
import { union, intersection, restriction } from '@interego/core';

const merged = union(descriptorA, descriptorB);
const common = intersection(descriptorA, descriptorB);
const trustOnly = restriction(merged, ['Trust', 'Semiotic']);
```

---

## PGSL — Poly-Granular Sequence Lattice

The content substrate. Deterministic hierarchical data structure representing sequential data as a lattice of overlapping sub-structures with content-addressed canonical URIs.

```typescript
import { createPGSL, embedInPGSL, pgslResolve, latticeMeet } from '@interego/core';

const pgsl = createPGSL({ wasAttributedTo: 'did:web:alice', generatedAtTime: new Date().toISOString() });

const uriA = embedInPGSL(pgsl, 'autonomous agents share knowledge graphs');
const uriB = embedInPGSL(pgsl, 'knowledge graphs enable semantic interoperability');

const meet = latticeMeet(pgsl, uriA, uriB);
const shared = pgslResolve(pgsl, meet!); // "knowledge graphs" — structural overlap
```

PGSL provides:
- **Content-addressed atoms** — same input always produces the same URI
- **Structural sharing** — two texts sharing sub-sequences share lattice fragments
- **Lattice meet** — greatest lower bound finds the largest shared sub-sequence
- **Categorical pullback** — overlapping pair construction as a universal property
- **Entity/relation extraction** — extract structured facts from natural language
- **Ontological inference** — synonym groups, IS-A hierarchies, part-of relations
- **Usage-based semantics** — co-occurrence mining, Yoneda embedding, emergent synonyms
- **Structural computation** — date arithmetic, counting, aggregation, abstention detection
- **In-memory SPARQL engine** — materialize lattice as triple store, execute SELECT/ASK/FILTER/OPTIONAL/UNION/aggregates
- **Three-layer SHACL validation** — core (node constraints), structural (lattice invariants), domain (user-defined shapes)
- **LLM tool interface** — 5 tools (sparql_query, lookup_entity, count_items, temporal_query, validate_shacl) with multi-turn dispatch loop
- **Ingestion profiles** — domain-specific data mapping (xAPI, LERS, RDF, custom)

### SPARQL Engine

```typescript
import { sparqlQueryPGSL, materializeTriples, executeSparqlString } from '@interego/core';

// Execute SPARQL against the PGSL lattice
const result = sparqlQueryPGSL(pgsl, `
  PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
  SELECT ?atom ?value WHERE {
    ?atom a pgsl:Atom ; pgsl:value ?value.
  } LIMIT 10
`);
console.log(result.bindings.length); // number of matching atoms
```

### SHACL Validation

```typescript
import { validateAllPGSL, validateDomainShapes } from '@interego/core';

// Validate lattice with all 3 layers (core + structural + domain)
const result = validateAllPGSL(pgsl);
console.log(result.conforms); // true if no violations

// Custom domain shapes
const result = validateDomainShapes(pgsl, [{
  name: 'AtomMustHaveValue',
  targetClass: 'https://...pgsl#Atom',
  properties: [{ path: 'https://...pgsl#value', minCount: 1 }],
}]);
```

### Coherence Verification

Usage-based semantic agreement between agents. Two agents share a SIGN (atom) but only share MEANING if they USE it in the same syntagmatic contexts.

```typescript
import { createPGSL, embedInPGSL, verifyCoherence, computeCoverage } from '@interego/core';

const pgslA = createPGSL({ wasAttributedTo: 'agent-a', generatedAtTime: new Date().toISOString() });
const pgslB = createPGSL({ wasAttributedTo: 'agent-b', generatedAtTime: new Date().toISOString() });
embedInPGSL(pgslA, 'patient status critical');
embedInPGSL(pgslB, 'account status active');

const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'status');
// cert.status === 'divergent' — "status" is shared but used differently
// cert.semanticOverlap === 0.15 — continuous 0-1 measure
// cert.obstruction.type === 'term-mismatch'
// cert.semanticProfile — per-atom usage analysis

const coverage = computeCoverage(['agent-a', 'agent-b', 'agent-c']);
// coverage.unexamined === 2 — the DANGEROUS state
```

Three states: **Verified** (sections glue), **Divergent** (obstruction found), **Unexamined** (dangerous — agents proceed as if aligned without verification).

### Paradigm Constraints

Structural rules on what can fill positions in chains. The paradigm set P(S, i) is the set of all atoms appearing at position i across chains matching pattern S. Five operations: subset, intersect, union, exclude, equal.

```typescript
// P(?, completed, ?) — everything anyone completed
// P(chen, ?, ?) — everything chen did  
// P(?, type, Class) — all classes
// Constraint: P(?, severity, critical) ⊆ P(?, escalate, ?) — criticals must be escalated
```

### Decision Functor (OODA Loop)

Natural transformation from observation presheaves to action categories: Observe → Orient → Decide → Act.

```typescript
import { extractObservations, decide } from '@interego/core';

const obs = extractObservations(pgsl, 'agent-a', certificates);
const result = decide(pgsl, 'agent-a', certificates);
// result.strategy === 'exploit' | 'explore' | 'delegate' | 'abstain'
// result.decisions — ranked affordances with confidence scores
```

### Progressive Persistence

Five-tier persistence with URI invariance — same content hash across all tiers:

| Tier | Storage | Durability | Resolution |
|------|---------|-----------|------------|
| 0 | Memory | Ephemeral | Direct lookup |
| 1 | Local disk | Survives restart | File read |
| 2 | Solid Pod | Federated | HTTP + WAC auth |
| 3 | IPFS | Global, immutable | CID gateway |
| 4 | Blockchain | Permanent | On-chain hash verification |

```typescript
import { createPersistenceRegistry, recordPersistence, promoteToIpfs } from '@interego/core';

const registry = createPersistenceRegistry();
recordPersistence(registry, atomUri, 0, { promotedBy: 'agent-a' });
const record = await promoteToIpfs(pgsl, atomUri, { provider: 'pinata', apiKey: '...' });
// record.cid — globally dereferenceable IPFS CID
```

### Virtualized RDF Layer

The entire system is queryable as standard RDF. Any SPARQL client (Comunica, Apache Jena, Protege) works.

| Endpoint | What |
|----------|------|
| `GET /ontology` | Full OWL ontology (cg:, pgsl:, Hydra, DCAT, PROV-O) |
| `GET /ontology/shacl` | System SHACL shapes |
| `GET /api-doc` | Hydra API description |
| `GET /catalog` | DCAT/DPROD federation catalog |
| `GET/POST /sparql` | W3C SPARQL Protocol — full system materialized |
| `POST /sparql/update` | SPARQL INSERT DATA with PGSL write-back |
| `GET /dump.ttl` | Full system Turtle export |
| `GET /dump.jsonld` | Full system JSON-LD export |

Tested with Comunica SPARQL engine — standard RDF tooling interoperability confirmed.

### Ingestion Profiles

```typescript
import { ingestWithProfile } from '@interego/core';

// xAPI profile: preserves actor/verb/object/result nesting
const uri = ingestWithProfile(pgsl, 'xapi', {
  actor: { account: { homePage: 'https://example.com', name: 'chen' }, name: 'CPT Sarah Chen' },
  verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
  object: { id: 'urn:activity:ils-approach', definition: { name: { 'en-US': 'ILS Approach Rwy 28L' } } },
  result: { score: { raw: 92, max: 100 }, success: true, duration: 'PT45M' },
});
// Ingested as multiple chains: core statement + identity/name/result chains
// (chen, completed, ils-approach-rwy-28L) — core, short atoms
// (chen, identity, https://learner.airforce.mil:chen) — IFI binding
// (chen, name, Sarah) — display name
// (chen, ils-approach-rwy-28L, score, 92) — result property

// LERS profile: issuer/subject/achievement/evidence nesting
const credUri = ingestWithProfile(pgsl, 'lers', {
  issuer: 'credential.training.airforce.mil',
  subject: { name: 'CPT Sarah Chen' },
  achievement: { name: 'USAF Instrument Rating', level: 'Proficient', framework: 'USAF v3' },
  evidence: { statementCount: 5, averageScore: 91.6 },
});

// Custom profiles: register your own
import { registerProfile } from '@interego/core';
registerProfile({
  name: 'fhir',
  description: 'FHIR observation: patient/encounter/observation nesting',
  transform(input) { /* domain-specific mapping */ return '((patient),(encounter),(observation))'; },
});
```

---

## Observatory

The Interego Observatory is a real-time dashboard for monitoring multi-agent federation:

```bash
CSS_URL=http://localhost:3456/ \
KNOWN_PODS=http://localhost:3456/lrs/,http://localhost:3456/competency/ \
PORT=5001 npx tsx examples/pgsl-browser/server.ts
# → Observatory at http://localhost:5001/observatory
# → PGSL Lattice Browser at http://localhost:5001/
```

**Tabs:** Federation (pod registry), Descriptors (facet browsing), Trust (chain visualization), Composition (algebraic operators), SPARQL (query interface), SHACL (validation), Coherence (usage-based verification with semantic profiles), Decisions (OODA decision functor per agent), PGSL Lattice (browser + Node Explorer)

**Interactive Demo:** Click through 7 phases of the TLA pipeline — agents publishing, discovering, signing, composing, verifying, and running coherence verification + decision functor across live Solid pods.

---

## Multi-Agent Demos

### TLA / xAPI / IEEE LERS Demo

A flight training pipeline for a 3-pilot cohort across 6 Solid pods:

```bash
npx tsx examples/multi-agent/tla-demo.ts --keep-alive
```

**6 Phases:**
1. **Setup** — 6 pods, 6 ethers.js wallets, 3 EIP-712 delegations
2. **xAPI Ingestion** — 15 statements from flight simulator, PGSL structural ingestion via xAPI profile, ECDSA-signed descriptors
3. **Competency Assessment** — SPARQL queries, affordance engine, Pearl's causal model (SCM + counterfactual), competency mapping
4. **Credential Issuance** — Composition (intersection), SHACL validation, IEEE LERS credentials, ECDSA signatures
5. **Learner Discovery** — Bidirectional: learners discover, verify signatures + delegation chains, republish to own pods
6. **External Verification** — Full trust chain audit, cohort overlap via SPARQL

### Team Security Audit Demo

3 agents (Scanner, Analyst, Lead) across 3 pods:

```bash
npx tsx examples/multi-agent/team-demo.ts --keep-alive
```

Shows: trust escalation (SelfAsserted → ThirdPartyAttested → CryptographicallyVerified), composition operators, PGSL structural overlap, provenance chains.

### Healthcare Coherence Demo

Three agents (ER, Radiology, Pharmacy) independently document a patient visit, then verify semantic alignment:

```bash
npx tsx examples/multi-agent/coherence-demo.ts
```

Shows: usage-based coherence verification, emergent data contracts from structural overlap, coherence certificates with per-atom semantic profiles.

---

## Affordance Engine

Integrates 8 theoretical frameworks for autonomous agent decision-making:

| Framework | What it provides | Module |
|-----------|-----------------|--------|
| **Gibson** | Relational affordances (agent x environment) | `computeAffordances()` |
| **Norman** | Signifiers + anti-affordances | `extractSignifiers()` |
| **Pearl** | Affordances as interventional queries P(Y\|do(X)) | `CausalAffordanceEffect` |
| **Boyd (OODA)** | Observe -> Orient -> Decide -> Act with IG&C | `OODACycle` |
| **Endsley (SA)** | Perception -> Comprehension -> Projection | `SituationalAwarenessLevel` |
| **Bratman (BDI)** | Beliefs -> Desires -> Intentions | `AgentState` |
| **Friston** | Active inference, surprise evaluation | `evaluateSurprise()` |
| **Stigmergy** | Affordance landscape tracking across pods | `StigmergicField` |

```typescript
import { computeAffordances, computeCognitiveStrategy } from '@interego/core';

// What can this agent do with this descriptor?
const affordances = computeAffordances(agentProfile, descriptor);
// → { affordances: [...], antiAffordances: [...], signifiers: [...], saLevel: {...} }

// What cognitive strategy should answer this question?
const strategy = computeCognitiveStrategy('How many days between X and Y?');
// → { strategy: 'temporal-twopass', computationType: 'date-arithmetic',... }
```

---

## Causality — Pearl's SCM Framework

```typescript
import { buildSCM, doIntervention, isDSeparated, evaluateCounterfactual } from '@interego/core';

const scm = buildSCM({
  variables: [{ name: 'X' }, { name: 'Y' }, { name: 'Z' }],
  edges: [{ from: 'X', to: 'Y' }, { from: 'Y', to: 'Z' }],
});

const mutilated = doIntervention(scm, { variable: 'Y', value: '1' });
const separated = isDSeparated(scm, 'X', 'Z', new Set(['Y'])); // true
const counterfactual = evaluateCounterfactual(scm, {
  intervention: { variable: 'X', value: '0' },
  outcome: 'Z',
  evidence: { Y: '1' },
});
```

---

## Cryptography

All real. No mocks.

### E2E Encryption (NaCl)

```typescript
import { generateKeyPair, createEncryptedEnvelope, openEncryptedEnvelope } from '@interego/core';

const owner = generateKeyPair();  // X25519
const agent = generateKeyPair();
const envelope = createEncryptedEnvelope(turtleContent, [agent.publicKey, owner.publicKey], owner);
const decrypted = openEncryptedEnvelope(envelope, agent); // only authorized agents can read
```

### Zero-Knowledge Proofs

```typescript
import { proveConfidenceAboveThreshold, proveDelegationMembership, proveTemporalOrdering } from '@interego/core';

// Prove confidence > 0.8 without revealing exact value
const { proof } = proveConfidenceAboveThreshold(0.95, 0.8);

// Prove "I'm in the authorized agent set" without revealing which agent
const membershipProof = proveDelegationMembership(myAgentId, authorizedAgents);

// Prove "published before time T" without revealing exact time
const temporalProof = proveTemporalOrdering(myTimestamp, deadline);
```

### Wallets & SIWE

```typescript
import { createWallet, createDelegation, signDescriptor, verifySiweSignature } from '@interego/core';

const humanWallet = await createWallet('human', 'Alice');  // real secp256k1
const agentWallet = await createWallet('agent', 'Claude');
const delegation = await createDelegation(humanWallet, agentWallet, 'ReadWrite'); // EIP-712
const signed = await signDescriptor(descriptorId, turtle, agentWallet); // real ECDSA
```

### IPFS Pinning

```typescript
import { pinDescriptor, computeCid } from '@interego/core';

const cid = computeCid(turtleContent);  // real SHA-256 CID
const anchor = await pinDescriptor(descriptorId, turtle, { provider: 'pinata', apiKey: '...' });
// → pinned to IPFS, dereferenceable globally
```

---

## MCP Server — 60+ Tools for AI Agents

### Setup

Add to `.mcp.json` (VS Code) or `claude_desktop_config.json` (Desktop):

```json
{
  "mcpServers": {
    "context-graphs": {
      "command": "cmd",
      "args": ["/c", "npx", "tsx", "path/to/context-graphs/mcp-server/server.ts"],
      "env": {
        "CG_POD_NAME": "your-name",
        "CG_AGENT_ID": "urn:agent:anthropic:claude-code:vscode",
        "CG_OWNER_WEBID": "https://your-identity-server/users/you/profile#me",
        "CG_OWNER_NAME": "Your Name",
        "CG_BASE_URL": "https://your-css-instance/"
      }
    }
  }
}
```

Auto-onboarding: first tool call provisions pod + registry + credential automatically.

### Tool Categories

**Core (6):** `publish_context`, `discover_context`, `get_descriptor`, `subscribe_to_pod`, `get_pod_status`, `analyze_question`

**Delegation (3):** `register_agent`, `revoke_agent`, `verify_agent`

**Federation (9):** `discover_all`, `subscribe_all`, `list_known_pods`, `add_pod`, `remove_pod`, `discover_directory`, `publish_directory`, `resolve_webfinger`, `unsubscribe_from_pod` (releases a CG_MAX_SUBSCRIPTIONS slot)

**Identity (2):** `setup_identity`, `link_wallet`

**PGSL (5):** `pgsl_ingest`, `pgsl_resolve`, `pgsl_lattice_status`, `pgsl_meet`, `pgsl_to_turtle`

### Progressive Tiers

Set `CG_TOOL_TIER` to control which tools are exposed:

| Tier | Tools | For |
|------|-------|-----|
| `core` | 6 | New users learning the basics |
| `standard` | 17 | Teams federating across pods |
| `full` | 19 | Users with crypto/wallet integration |
| `all` (default) | 24 | Power users, researchers |

---

## Identity & Delegation

The pod belongs to the **owner** (human/org). Agents are **delegates**.

```
Owner (human)
├── WebID: https://identity-server/users/alice/profile#me
├── DID: did:web:identity-server:users:alice
├── Pod: https://css-server/alice/
├── Authorized agents:
│   ├── claude-code-vscode  [ReadWrite]
│   ├── claude-desktop      [ReadWrite]
│   └── codex-cli           [DiscoverOnly]
└── Delegation credentials: /alice/credentials/*.jsonld (VC format)
```

Supports: WebID, DID (did:web), W3C Verifiable Credentials, Open Badges 3.0, IEEE LERS, SIWE (ERC-4361), ERC-8004 agent identity tokens, Universal Wallet.

---

## Federation — Three Discovery Approaches

1. **Known Pods** — `CG_KNOWN_PODS` env var
2. **Pod Directory Graphs** — decentralized RDF registries
3. **WebFinger** — RFC 7033 DNS-rooted discovery (same as ActivityPub)

---

## Benchmarks

| Approach | Raw (500q) | Adjusted | Excl Preference |
|----------|-----------|----------|-----------------|
| **Agentic v3** (SPARQL + fact extraction) | **86.6%** | **89.2%** | **92.1%** |
| Raw LLM (no system) | 92.4% | — | — |
| Agentic v1 (first run) | 83.0% | — | — |

The system adds value on structural tasks (counting, temporal reasoning, knowledge-update tracking) but a raw LLM with a large context window is competitive at pure text comprehension. The system's real value is **not** in beating LLMs at reading text — it's in providing **composable, verifiable, federated context infrastructure** that LLMs cannot provide: typed metadata, trust chains, access control, algebraic composition, structural dedup, and provenance.

---

## Deployment

### Local (zero internet)

```bash
# Just works — auto-starts Community Solid Server
CG_BASE_URL=http://localhost:3456/ npx tsx mcp-server/server.ts
```

### Azure Container Apps

```bash
cd deploy && bash azure-deploy.sh
```

Deploys: CSS (Solid server), Dashboard (observation UI), MCP Relay (HTTP bridge), Identity Server (WebID + DID + SIWE).

---

## Development

```bash
npm install
npm run build        # TypeScript → dist/
npm test             # ~1119 tests across ~65 files
npm run test:watch   # Watch mode
```

### Test Suites

| Suite | Tests | Coverage |
|---|---|---|
| `context-graphs.test.ts` | 44 | Builder, composition, validation, serialization |
| `solid.test.ts` | 20 | Publish, discover, subscribe, agent registry |
| `federation.test.ts` | 21 | Pod directory, multi-pod, WebFinger, Hydra |
| `causality.test.ts` | 38 | SCM, do-calculus, d-separation, counterfactual |
| `pgsl.test.ts` | 31 | Lattice, category, geometric morphism |
| `pgsl-sparql.test.ts` | 19 | Triple store, SPARQL execution, existing generators |
| `pgsl-shacl.test.ts` | 13 | Core/structural/domain SHACL validation |
| `pgsl-tools.test.ts` | 19 | LLM tools, tool call parsing, tool loop |
| `projection.test.ts` | 15 | Vocabulary mapping, binding strength |
| `affordance.test.ts` | 23 | Gibson, Norman, OODA, BDI, Friston, stigmergy |
| `crypto.test.ts` | 25 | Wallets, ECDSA, delegation, SIWE |
| `encryption-zk.test.ts` | 30 | NaCl encryption, ZK proofs, selective disclosure |
| `sdk-extractors.test.ts` | 17 | Category theory, semiotic functor |
| `xapi-conformance.test.ts` | 60 | xAPI profile, IFI priority, result/context structure |
| `pgsl-coherence.test.ts` | 9 | Coherence verification, coverage, certificates |
| `agent-framework.test.ts` | 68 | AAT, Policy, PROV tracing, Personal Broker, AAT Decorator |
| `infrastructure.test.ts` | 47 | Enclaves, Checkpoints, CRDT sync |
| `discovery.test.ts` | 50 | Introspection, Virtual Layer, Metagraph, Marketplace |
| `multi-agent-integration.test.ts` | 59 | 8 scenarios: AAT enforcement, enclave merge, CRDT sync, full pipeline |

---

## Specifications

| Document | What it covers |
|----------|---------------|
| [Interego 1.0 WD](https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html) | Core spec: descriptors, facets, composition, serialization |
| [`spec/architecture.md`](spec/architecture.md) | Architecture overview + RDF 1.2 / SHACL 1.2 alignment statement |
| [`spec/LAYERS.md`](spec/LAYERS.md) | Layering discipline (L1 / L2 / L3); namespace-as-projection-contract; drift triggers |
| [`spec/DERIVATION.md`](spec/DERIVATION.md) | Construction rules: every L2/L3 class must ground in L1 (CI-enforced) |
| [`spec/CONFORMANCE.md`](spec/CONFORMANCE.md) | Four-level conformance test suite + badge program (L1 Core, L2 Federation, L3 Advanced, L4 Compliance) |
| [`spec/STORAGE-TIERS.md`](spec/STORAGE-TIERS.md) | Local-first by design: 5-tier deployment ladder from library-only → P2P. Tier 1 (local pod) is the zero-config default; the MCP auto-spawns CSS on first publish |
| [`docs/p2p.md`](docs/p2p.md) | Tier 5 P2P transport — Nostr-style relay-mediated, ECDSA + Schnorr (BIP-340) dual signing, 1:N encrypted share via `KIND_ENCRYPTED_SHARE`. Mobile + desktop deployment topology (operator-bridge or user-bridge). |
| [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) | SOC 2 readiness package: scope, gap analysis, vendor inventory, solo-operator compensating controls, Type 1 → Type 2 timeline |
| [`spec/policies/`](spec/policies/) | 15 written policies (info sec, access, change, IR, BCP, vendor, classification, encryption, SDLC, logging, AUP, retention, risk, vulnmgmt, privacy) |
| [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md) | Operational procedures: deploy, access reviews, wallet rotation, backup, monitoring, quarterly + annual cadence |
| [`SECURITY.md`](SECURITY.md) | Coordinated disclosure contact + severity SLA + scope. Mirrored at `/.well-known/security.txt` (RFC 9116) on every container app |
| [`spec/FEDERATED-TRANSACTIONS.md`](spec/FEDERATED-TRANSACTIONS.md) | Saga pattern for cross-pod atomic writes; isolation levels; failure modes |
| [`spec/CONSTITUTIONAL-LAYER.md`](spec/CONSTITUTIONAL-LAYER.md) | Self-amending policies; tiered ratification; graceful forks |
| [`spec/CRDT-OFFLINE-MERGE.md`](spec/CRDT-OFFLINE-MERGE.md) | Descriptor-fragment-level CRDTs for offline-first collaboration |
| [`spec/AGGREGATE-PRIVACY.md`](spec/AGGREGATE-PRIVACY.md) | Privacy-preserving aggregate queries (DP + ZK) across pods |
| [`spec/proofs/`](spec/proofs/) | TLA+ formal-spec outlines (modal lattice, supersession, ABAC composition) |
| [`docs/AGENT-PLAYBOOK.md`](docs/AGENT-PLAYBOOK.md) | Operational "when X do Y" rules for any LLM driving the MCP — proactive triggers, privacy, modal defaults, error patterns |
| [`docs/AGENT-INTEGRATION-GUIDE.md`](docs/AGENT-INTEGRATION-GUIDE.md) | One-page integrator guide for AI agent harnesses (OpenClaw, Cursor, Cline, Aider, custom) |
| [`docs/ns/eu-ai-act.ttl`](docs/ns/eu-ai-act.ttl) | EU AI Act mapping (Articles 6, 9, 10, 12, 13, 14, 15, 50) |
| [`docs/ns/nist-rmf.ttl`](docs/ns/nist-rmf.ttl) | NIST AI Risk Management Framework — Govern / Map / Measure / Manage |
| [`docs/ns/soc2.ttl`](docs/ns/soc2.ttl) | SOC 2 Trust Services Criteria — CC + Availability + PI + Confidentiality + Privacy |
| [Paradigm Constraints](spec/paradigm-constraints.md) | Emergent semantics, coherence verification, decision functor |
| [Progressive Persistence](spec/progressive-persistence.md) | 5-tier persistence, URI invariance, structural encryption |
| [Presentation Notes](spec/presentation-notes.md) | 10-slide W3C presentation outline with demo instructions |
| [`docs/EMERGENCE.md`](docs/EMERGENCE.md) | Four emergent-property demos with falsifiable success criteria |
| [`docs/ARCHITECTURAL-FOUNDATIONS.md`](docs/ARCHITECTURAL-FOUNDATIONS.md) | Holonic hypergraphics + polygranular composition + Peircean substrate — categorical interpretation of why the protocol's choices hang together as one construction |

---

## Related Concepts

This library is designed to compose with several adjacent theoretical frameworks:

- **HELA** — a topos-theoretic xAPI stack using the presheaf category ℰ = Set^(𝒞_xAPI^op)
- **SAT (Semiotic Agent Topos)** — the Semiotic Facet maps directly to SAT's Semiotic Field Functor (Σ)
- **PGSL (Poly-Granular Sequence Lattice)** — the substrate layer included in this repo; abstract data type for canonical sequence addressing

---

## Spec Compliance

Implements the [Interego 1.0 Working Draft](https://markjspivey-xwisee.github.io/interego/spec/interego-1.0.html):

- Section 3.1: Context Descriptor structure
- Section 3.4: Composition operators forming a bounded lattice
- Section 3.5: Triple-level inheritance via `effectiveContext()`
- Section 5: All facet types with W3C vocabulary alignment
- Section 6: Serialization (Turtle, JSON-LD, TriG)
- Section 7: SPARQL 1.2 query patterns

- Paradigm Constraints (spec/paradigm-constraints.md): syntagm/paradigm, 5 operations, emergent semantics, coherence protocol, decision functor
- Progressive Persistence (spec/progressive-persistence.md): 5-tier persistence, URI invariance, resolution protocol, structural encryption

Extensions beyond the spec: PGSL substrate, Pearl causality, affordance engine, E2E encryption, ZK proofs, IPFS anchoring, structural computation, cognitive strategy routing.
