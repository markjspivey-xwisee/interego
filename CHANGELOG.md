# Changelog

Notable changes to @interego/core. Dates are UTC.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with RFC 2119-style
capability descriptions. Commit hashes link back to the git history; the README
describes what the system IS, this file describes what changed and when.

---

## 2026-05-14 — Production hardening, Hermes integration, HATEOAS surface, hosted onboarding, name service

A multi-part pass: harden the substrate, land the Hermes Agent
integration, give both memory plugins a bloat-free HATEOAS tool surface,
make the hosted deployment a retail-grade front door (with origin-aware
WebAuthn so `/connect` passkey enrollment works), and ship the Interego
name service — attestation-based, federated, no central registrar.

### Production hardening — real bugs + coverage on untested public API

Cross-referenced all 743 `src/index.ts` exports against the test suite;
the gaps surfaced real, shipped bugs:

- **`detectValueDrift` always returned `[]`** (`5490fa4`) — the heuristic
  loop computed vocabulary overlap but its `if` block was empty. Wired
  it, restricted the scan to conduct-bearing event kinds, + 4 tests.
- **`countUniquePGSL` was dead on arrival** (`bdba0d9`) — it loaded its
  deps with `require()` inside an ESM module, throwing "Cannot find
  module" on every call; also swallowed embed failures with `catch {}`.
  Converted to ESM imports, made the failure path non-silent, added the
  missing barrel export, + 2 tests.
- **Zero-coverage modules locked down** — `src/pgsl/computation.ts` (13
  functions, `b8ca403`), BIP-340 Schnorr (`f87081c`, also exported the
  unreachable `sha256Hex`), `src/model/delegation.ts` — the
  authorization gate (`f724410`), `src/solid/sharing.ts` — cross-pod
  recipient resolution incl. the Sec #12 rollover window (`47c7f1e`).
- **Validator-as-agent: bring-your-own SHACL engine** (`814180e`) —
  `deploy/validator/` hands descriptors to an operator-provided SHACL
  engine over a W3C-standard HTTP contract; dropped `n3` +
  `rdf-validate-shacl` (the container keeps only `express` + `ws`).
  Graceful no-op when unconfigured.
- **Multiplayer playtest** (`08075bb`) — 8 end-to-end journey scenarios
  (solo / device-migration / pairwise + group E2EE / revocation /
  key-rollover / adversarial / efficiency / cross-device parity), each
  judged against a production-quality property. The substrate held.

Full suite: 1238 passing.

### Hermes Agent memory provider (Path 5)

`integrations/hermes-memory/` (`b558f4b`) — a `MemoryProvider` plugin for
Nous Research's Hermes Agent (the most-used agent runtime, ~140k stars).
stdlib-only Python; maps Hermes' memory hooks (`sync_turn`, `prefetch`,
`on_memory_write`) onto the relay's `publish_context` / `discover_context`
REST surface. Same `cgh:AgentMemory` graph shape as the OpenClaw
provider — Hermes bots and OpenClaw agents on one pod read each other's
memories. New `docs/integrations/path-5-hermes-memory-provider.md`;
integration map grew from four paths to five.

### HATEOAS tool surface — reach the whole substrate without tool bloat

Both memory plugins now reach *all* of Interego from a fixed, tiny tool
surface instead of carrying a flat list of ~15–60 substrate tools:

- **Hermes** (`e98ebce`) — `get_tool_schemas()` exposes three schemas:
  `interego_recall` / `interego_discover` / `interego_act`.
- **OpenClaw** (`423acb2`) — five: the three memory-slot tools +
  `interego_discover` / `interego_act`. Also fixed two pre-existing
  bridge bugs (an unsupported `{ shareWith }` option `publish()`
  silently ignored; `entry.confidence` read off a type that lacks it)
  and corrected `forgetMemory` to publish `Counterfactual`, not
  `Hypothetical`, matching its own contract.

Every `recall` / `discover` result is decorated with `affordances` —
self-describing `{action, target, …}` records, gated by delegation
scope. The agent acts by passing one to `*_act`. Capability travels as
data: new substrate capability is a new affordance verb in a result,
never a new tool schema. New docs:
`docs/integrations/{hermes,openclaw}-full-substrate.md`.

### Retail-grade hosted onboarding

`deploy/identity/server.ts` (`bee7429`) — the hosted landing page is now
a two-track "try it" experience (person → passkey/wallet enroll; agent →
copy the relay URL into an MCP client). `/connect` does in-browser
passkey enrollment (Touch ID / Windows Hello / security key) **and**
Ethereum-wallet enrollment — no password, no email, no account
database; DID + pod minted from the credential. The relay landing page
cross-links the identity front door so neither hosted surface dead-ends.

### Origin-aware WebAuthn RP — fixes the `/connect` passkey rpID mismatch

`deploy/identity/server.ts` (`dc9a9d4`) — the new `/connect` page ran the
passkey ceremony on the identity server's own domain, but the server
returned a single static `WEBAUTHN_RP_ID` (pinned to the relay's domain,
which the relay's OAuth flow needs) — so the ceremony failed with an
rpID mismatch. The ceremony is now origin-aware: `resolveRp(req)` derives
the relying party from the browser-sent `Origin` against a
`WEBAUTHN_RP_ORIGINS` allowlist; the resolved `{rpId, origin}` is stashed
on the challenge so `/register` + `/authenticate` verify against the
origin the ceremony actually used. Falls back to the static RP for
unrecognized origins — single-origin deployments unaffected.
`deploy-azure.yml` also gained the missing "Wire identity env vars" step
(the workflow wired the dashboard's env but never the identity server's).

### Interego name service — attestation-based naming

`docs/NAME-SERVICE.md` (`17169fe`) + `src/naming/` (`a07a81c`) — a name
is a **verifiable attestation**, not a claimed registration:
`<did> foaf:nick "alice"` inside an ordinary Context Descriptor with
Trust + Provenance facets and `cg:supersedes` chains. Resolution is
federated discovery + a pluggable trust policy — conflicts resolve by
the resolver's policy, never first-come-first-served. No central
registrar, no root, no namespace governance; the honest cost is no
global-uniqueness guarantee (the correct trade for a federated,
verifiable substrate — ENS-style global uniqueness is available as an
opt-in resolution tier, not the root). Shipped:
`buildNameAttestation` / `attestName` / `resolveName` (forward,
trust-ranked) / `namesFor` (reverse) / `defaultNameTrustPolicy`
(pluggable), all with an injectable `fetch`. 14 tests. **No new L1/L2
ontology terms** — `foaf:nick` is W3C FOAF; L2 pattern, sibling of
`registry:` / `passport:`.

### Fixes

- **Relay hostname** (`a0ec397`) — the Hermes plugin + the identity
  server's `RELAY_URL` default were written against a non-existent
  `interego-mcp-relay` host (an invented `mcp-` segment); the real
  Azure Container App is `interego-relay`. Corrected — left as-is the
  Hermes provider would have failed out of the box.

## 2026-05-13 — Production hardening, batches 1–4

A four-batch pass tightening the substrate for consumer-grade
deployment — error handling, resource bounds, race fixes, and the
identity/relay attack surface.

- **Escape correctness + privacy preflight** (`4cdf0ea`) — fixed Turtle
  literal escaping across the pod-publishers, added API-key / PII
  sensitivity detectors, resource caps, timeouts, and concurrency-race
  fixes.
- **Identity + relay hardening** (`edc1f25`) — per-IP rate limiting on
  every auth endpoint; browser-friendly landing pages so a non-technical
  visitor sees an actionable page, not `Cannot GET /`.
- **Batch 2** (`b00f171`) — Merkle BIP-98 leaf/internal domain tags,
  discovery diagnostics, a connector-failure surface (`getLastFailures`).
- **Batch 3** (`92af768`) — actionable error messages, atomic agent-key
  write (tmp + rename), Turtle-injection defense, relay-replay
  diagnostics.
- **Batch 4** (`d4d50c2`) — CAS exponential backoff, PGSL ingest cap,
  WebSocket reconnect, `discover_all` partial-failure summaries.
- `cg:supersedes` round-trips through `ManifestEntry` (`ba4712f`).

## 2026-05-02 — Complexity-science foundations, demo set 16–23, agent-runtime integration scaffolding

Three arcs landed over early May.

### Categorical foundations + complexity-aware extensions
- `docs/ARCHITECTURAL-FOUNDATIONS.md` (`d7f0d04`) — the formal account
  of the substrate (holonic hypergraphics, PGSL as Grothendieck
  fibration, HELA as topos, the four invariants, Peircean correspondence).
- §9 complexity-aware extensions, then §10 — the substrate
  self-bootstraps an emergent protocol-and-app (`d768e81`, `a6a5257`,
  `5514c82`). Three engineering-honesty gaps closed alongside:
  tree-kill, real range-proof verification, substrate-enforced
  constitutional constraints (`9f5e367`).

### Benchmark honesty
- Stripped cross-run study-notes from the LongMemEval prompts; reported
  an honest cold-start baseline (`48ac9f5`, `7c89e33`). The system's
  value is infrastructure, not test-set fitting.

### Demos 16–23 + agent-runtime integration paths 1–4
- Demos 16–23 (`e6408e4`, `0f8fc72`, `fcdf30f`, `85f0b3e`, …) — including
  Demo 22 (autonomous game design/build/play) and Demo 23 (federated
  zero-copy semantic layer).
- **Agent-runtime integration paths 1–4** (`f3fb1c1`) — the skills
  bridge (SKILL.md ↔ `cg:Affordance`), the OpenClaw memory plugin, the
  compliance overlay, and the integration map. The Hermes provider
  (Path 5) and the HATEOAS surface for both plugins followed on
  2026-05-14.
- Review follow-ups (`a1bf4b1`) — a real subject-extraction TriG parser
  replacing regex, range-proof hardening, hardened readiness probes.

## 2026-04-28 (later) — Layering correction: verticals out of generic deployments; affordance-first

Earlier commits today bundled vertical-application MCP tools (`lpc.*` /
`adp.*` / `lrs.*` / `ac.*`) into both `examples/personal-bridge/` AND
`deploy/mcp-relay/`. That conflated the foundation layer (generic
Interego protocol) with application-over-L3 emergent reifications.

Reverted the bundling and restructured around the protocol's first
principles:

### Phase 1 — strip the violations
  - examples/personal-bridge: back to 6 core p2p tools only
  - deploy/mcp-relay: back to 15 protocol tools only (Azure deployment
    redeploys via CI back to that baseline)
  - tests/personal-bridge.test.ts: assertions back to 6-tool baseline

### Phase 2 — affordance-first capability declarations
  - applications/_shared/affordance-mcp/index.ts — typed Affordance
    shape + affordanceToMcpToolSchema(a) + affordanceToTurtle(a, base) +
    affordancesManifestTurtle(...)
  - applications/<vertical>/affordances.ts — single source of truth
    for each vertical's capabilities (LPC: 6, ADP: 8, LRS: 4, AC: 5)
  - Action IRIs follow urn:cg:action:<vertical>:<verb> convention
  - Both protocol-level (cg:Affordance) and ergonomic (MCP tool schema)
    surfaces derive from the same affordance declarations

### Phase 3 — per-vertical bridges as separate optional deployments
  - applications/_shared/vertical-bridge/index.ts — createVerticalBridge()
    framework: HTTP endpoints per affordance hydra:target +
    /mcp with derived tool schemas + /affordances Turtle manifest
  - applications/<vertical>/bridge/ — small standalone Express + MCP
    servers (~100 lines each) on their own ports (6010 LPC / 6020 ADP /
    6030 LRS / 6040 AC). Naming: @interego/<vertical>-bridge-EXAMPLE
    — the suffix signals NOT first-party
  - Each bridge has its own package.json (depends on @interego/core),
    its own tsconfig.json, its own dist/

### First-principles position now encoded
  - Generic Interego deployments (mcp-server, personal-bridge,
    deploy/mcp-relay) expose ONLY protocol-level tools
  - Verticals are emergent applications, not protocol extensions
  - Verticals are ALWAYS reachable via the protocol-level cg:Affordance
    discovery path — no per-vertical client code required at the
    consuming agent
  - Per-vertical bridges are an optional convenience reification,
    deployed independently per vertical (Path B); the protocol path
    (Path A) always works regardless

Generic Interego CI / tests / conformance suite are unaffected by any
vertical's state. A vertical can fail to build without breaking the
project; vertical bridges deploy independently per the verticals doc
([applications/README.md](applications/README.md)).

---

## 2026-04-28 (earlier) — Four production-grade vertical applications + CAS-safe `publish()`

Closes the gap between protocol substrate and end-user-facing applications.
Each of the four verticals under [`applications/`](applications/) now ships
a production runtime (pod-publisher + pod-loader + MCP tools registered in
the personal-bridge) + a Tier 8 integration test against real
infrastructure (Azure CSS + Lrsql + SCORM Cloud + public Nostr relay).

### Verticals

- **`learner-performer-companion/`** ([`applications/learner-performer-companion/`](applications/learner-performer-companion/))
  Human-protagonist wallet: SCORM/cmi5 ingestion, W3C VC import (vc-jwt + DataIntegrityProof eddsa-jcs-2022), xAPI history via lrs-adapter, performance records with manager attribution. Grounded chat with verbatim citation, honest no-data on unanswerable questions, content-hash tamper detection. New `src/grounded-answer.ts` + `src/pod-wallet.ts` + `src/pod-publisher.ts`.

- **`agent-development-practice/`** ([`applications/agent-development-practice/`](applications/agent-development-practice/))
  Agent-as-subject Cynefin/Snowden complexity-informed practice. Probes/fragments/syntheses always Hypothetical; syntheses REQUIRE ≥2 coherent narratives (silent collapse prevention); evolution steps require `explicitDecisionNotMade`; capability evolution events as `passport:LifeEvent` carry humility forward across deployments. New `src/pod-publisher.ts` + `src/pod-loader.ts`.

- **`lrs-adapter/`** ([`applications/lrs-adapter/`](applications/lrs-adapter/))
  Bidirectional xAPI ↔ Interego boundary translator. Auto-negotiates xAPI version (2.0.0 preferred; falls back to 1.0.3 for legacy LRSes — real-world finding: SCORM Cloud is 1.0.3-only). Counterfactual descriptors ALWAYS skipped on projection; Hypothetical skipped without explicit opt-in; multi-narrative descriptors lossy with audit-loud `lossNote` rows. New `src/lrs-client.ts` + `src/pod-publisher.ts`.

- **`agent-collective/`** ([`applications/agent-collective/`](applications/agent-collective/))
  Multi-agent federation: tool authoring with attestation discipline (publisher REFUSES tool promotion below 5 self + 2 peer + 2 axes); teaching packages bundle artifact + practice (REFUSES without narrative fragments); cross-agent audit entries live in HUMAN OWNER's pod (not the agent's). New `src/pod-publisher.ts`.

### Personal-bridge: 23 MCP tools

The personal-bridge ([`examples/personal-bridge/`](examples/personal-bridge/)) now exposes 23 MCP tools any client can call (Claude Desktop / Code / Cursor / ChatGPT app / custom): 6 core p2p (existing) + 6 `lpc.*` + 8 `adp.*` + 4 `lrs.*` + 5 `ac.*`. Per-vertical env vars (`LPC_POD_URL`, `ADP_OPERATOR_DID`, `LRS_ENDPOINT`, `AC_AGENT_DID`, ...) configure the targets; per-call argument overrides supported.

### CAS-safe `publish()`

[`src/solid/client.ts`](src/solid/client.ts) — manifest update now uses HTTP If-Match (RFC 7232 optimistic concurrency) with retry on 412 Precondition Failed (jittered backoff, 5 attempts). Cold-start uses `If-None-Match: *`. Fixes the read-then-write race where parallel publishes against the same pod could clobber each other's manifest entries — bit production agents writing in parallel AND the cross-suite parallel test run.

### Test surface

Single full-suite run (`SCORM_CLOUD_KEY=... SCORM_CLOUD_SECRET=... SCORM_CLOUD_ENDPOINT=... npx vitest run`):
- **1068 tests pass / 3 skipped (env-gated) / 0 failures**
- 60 test files including 4 new Tier 8 production tests (one per vertical)
- Real systems exercised in a single suite run: Yet Analytics Lrsql (xAPI 2.0.0), SCORM Cloud (xAPI 1.0.3), Azure Community Solid Server, relay.damus.io public Nostr relay, real ECDSA + Ed25519 + X25519 cryptography, real W3C VC vc-jwt + Data Integrity Proofs, real SCORM 1.2/2004/cmi5 zip parsing, real cross-bridge p2p

vitest config now uses singleThread/singleFork pools to serialize pod-touching tests for deterministic CI gates.

### Honesty discipline encoded at the publisher layer

Across all four verticals, publishers REFUSE bad input rather than warn. Examples:
- ADP: probes refused without amplification + dampening triggers; syntheses refused with <2 coherent narratives; evolution steps refused without `explicitDecisionNotMade`; constraints refused without `emergedFrom` + `boundary` + `exits`
- LRS: Counterfactual descriptors ALWAYS skipped on projection; Hypothetical skipped without opt-in
- AC: tool promotion refused below threshold; teaching package refused without narrative fragments
- LPC: bad VCs never land in the pod under credential IRIs (verification before persist)

The behavior contract — verbatim citation, honest no-match, tamper detection, cross-link integrity, provenance honesty — is what the Tier 7+8 tests validate.

---

## 2026-04-26 — Tier 5 P2P transport (Schnorr + 1:N encrypted share)

Ships the local-first storage tier ladder + a working P2P option. Three commits land in sequence:

### Tier ladder ([`spec/STORAGE-TIERS.md`](spec/STORAGE-TIERS.md))

- 5-tier deployment progression: Tier 0 (library only) → Tier 1 (default — MCP auto-spawns CSS) → Tier 2 (LAN) → Tier 3 (self-hosted public) → Tier 4 (federated cross-pod) → Tier 5 (P2P relay-mediated).
- Each tier is a strict superset of the one below; protocol surface unchanged across the stack.
- Smoke tests for tiers 0/1/4 in [`tests/storage-tiers.test.ts`](tests/storage-tiers.test.ts) using an `InMemoryPod` class that backs a real fetch handler. 6 tests pass.

### Tier 5 base — Nostr-style relay transport ([`src/p2p/`](src/p2p/))

- `P2pClient` + `InMemoryRelay` + `P2pRelay` interface. Same client API works against in-memory (tests), WebSocket → public Nostr relay (production), or libp2p (future Tier 6).
- Three custom kinds in NIP-33 parameterized-replaceable range: `KIND_DESCRIPTOR` (30040), `KIND_DIRECTORY` (30041), `KIND_ATTESTATION` (30042).
- Mobile + desktop interop with no central server: cross-surface deployment topology in [`docs/p2p.md`](docs/p2p.md).

### Schnorr (BIP-340) signatures — public-Nostr interop

- New [`src/crypto/schnorr.ts`](src/crypto/schnorr.ts) wraps `@noble/curves` BIP-340 schnorr sign/verify + `getNostrPubkey(privateKey)` deriving the 32-byte x-only pubkey.
- `P2pClient` gains `signingScheme: 'ecdsa' | 'schnorr'` option. Same wallet, two pubkey representations (Ethereum address / x-only hex). `verifyEvent` auto-dispatches by pubkey format — both schemes coexist on the wire.
- New runtime dep: `@noble/curves ^2.2.0` (replaces `@noble/secp256k1` which dropped Schnorr in v2.3).
- Means: an Interego deployment can publish to public Nostr relays with Schnorr-signed events that interop with non-Interego Nostr clients. One wallet, two faces, full Nostr-ecosystem participation.

### 1:N encrypted share — closes Tier 4 / Tier 5 gap

- New `KIND_ENCRYPTED_SHARE = 30043`. Reuses Tier 4's existing 1:N NaCl envelope (`createEncryptedEnvelope` / `openEncryptedEnvelope`), wrapped in a relay-routable event.
- `publishEncryptedShare` / `queryEncryptedShares` / `subscribeEncryptedShares` / `decryptEncryptedShare` on `P2pClient`.
- Recipients tagged via `p` (signing pubkey for filtering); X25519 encryption pubkeys live inside the envelope, invisible to the relay. Same security model as Tier 4 cross-pod share, transport-agnostic.

### Side fixes

- `FRAMEWORK_CONTROLS.soc2` catalog gained CC6.2, CC6.7, CC7.3, CC7.4, CC7.5, CC9.2 — all controls the `src/ops/` event builders emit but the framework report wouldn't recognize. Caught by THE ADVERSARIAL AUDIT test ([`tests/adversarial-audit.test.ts`](tests/adversarial-audit.test.ts)).
- Added `signMessageRaw(wallet, message)` + `recoverMessageSigner(message, sig)` exports from `crypto/wallet.ts` for use by P2P (also useful for x402, ad-hoc challenges).

### Stats

- Tests: 859 → **903 passing** (+6 storage-tier, +7 adversarial-audit, +16 P2P, +5 wallet, +10 connectors, less 8 deltas / cleanups)
- New runtime dep: `@noble/curves ^2.2.0`
- New modules: [`src/p2p/`](src/p2p/), [`src/crypto/schnorr.ts`](src/crypto/schnorr.ts)
- New docs: [`spec/STORAGE-TIERS.md`](spec/STORAGE-TIERS.md), [`docs/p2p.md`](docs/p2p.md)
- All 3 lints clean throughout.

### THE ADVERSARIAL AUDIT — six-act demonstration

[`tests/adversarial-audit.test.ts`](tests/adversarial-audit.test.ts) ships a single 548-line vitest test that's also a six-act narrative demonstration. Each act is backed by hard cryptographic assertions. Demonstrates capabilities that, taken together, no other system in the world has all of: (1) operator with valid creds CANNOT rewrite history; (2) ONE signed action satisfies MULTIPLE regulatory regimes; (3) independent witnesses on DIFFERENT pods can verify; (4) audit substrate self-protects (attacks become evidence); (5) time-locked attribution survives key rotation; (6) O(log n) third-party Merkle verification with no central authority.

---

## 2026-04-26 — broad codebase pass (post-review fixes)

Acted on the broader code-review survey across the whole project — not just SOC 2/security. Tightened security at the relay, fixed two real ESM bugs in the compliance module, added subscription cap to the stdio MCP server, formalized deploy/access/key documentation, promoted the architecture spec status, and adopted Proposal B as the v1.1 path for descriptor self-revocation.

### Fixed — silent ESM bugs in `src/compliance/`

- `generatePrivateKey()` and `addressFromPrivateKey()` used CJS `require('ethers')` inside an ESM module. Worked at compile time, threw `ReferenceError: require is not defined` at runtime for any caller of `loadOrCreateComplianceWallet`. Replaced with `import { Wallet } from 'ethers'`. The bug shipped silently because no test exercised the wallet code path; a regression test now exists in `tests/compliance.test.ts`.
- `loadOrCreateComplianceWallet().fresh` was hardcoded `false` (the `!existsSync(path) ? false : false` ternary always evaluated to `false`). Operators relying on the `fresh` flag to back up newly-minted wallets received no signal. Now correctly returns `true` on first mint, `false` on subsequent loads.

### Added — `tools/publish-ops-event.mjs` integrations

- Relay's `/agents/:agentIri/revoke` endpoint now emits a `soc2:AccessChangeEvent` audit descriptor in the response (using `buildAccessChangeEvent`). Operators can pipe directly into `publish_context` with `compliance:true` for SOC 2 CC6.2/CC6.3 evidence. Failure here MUST NOT fail the revoke; surfaced as `auditWarning`.
- `examples/compliance-end-to-end.mjs` walks the full pipeline: build event → check compliance grade → generate framework report → load/rotate wallet. Self-contained, no live pod. Catches three real bugs (above + a stale ContextDescriptor reference).

### Added — `mcp-server` subscription cap + `unsubscribe_from_pod` tool

- Per-process cap of 32 active WebSocket subscriptions, configurable via `CG_MAX_SUBSCRIPTIONS`. Prior behavior allowed unbounded accumulation as the agent explored federation.
- New `unsubscribe_from_pod` tool releases a slot. PodRegistry gains `unsubscribe(url)` + `activeSubscriptionCount` getter.

### Hardened — relay startup

- `relay-agent-key.json` parse failures are now fatal at startup. Prior behavior silently regenerated a fresh key, orphaning every envelope encrypted to the prior public key. Operators see a clear error and a hint to restore from backup.
- Startup logs sha256 fingerprints (12-char hex) of: `RELAY_MCP_API_KEY`, `relayAgentKey.publicKey`, `ORG_CDP_API_KEY_PRIVATE`, `ORG_IPFS_API_KEY`. Operator can confirm key identity at boot without ever logging the secret itself.
- `/oauth/verify` now rate-limited (30 req/min/IP, RFC 6585 standard headers). Was previously the only auth-relevant endpoint outside `mcpAuthRouter`'s rate limiter.
- CORS open-origin design rationale documented inline (claude.ai connector + OpenAI plugin compatibility) with explicit "do not tighten" guidance.

### Resolved — `mcp-server` wallet TODO

- `check_balance` falls back to the persisted ECDSA compliance wallet address when no `address` arg is provided, instead of the meaningless `MY_DID` (a `did:web:` identifier, not a fundable address).

### Added — coverage gating + new shared helper module

- `vitest.config.ts` thresholds (50% baseline, 80–100% on protocol-critical modules: `compliance`, `security-txt`, `ops`, `privacy`). `npm run test:coverage` enforces; `npm test` is unaffected.
- `src/security-txt/` — RFC 9116 body builder, single source of truth across the 3 servers that depend on `@interego/core`. Identity + validator inlines kept (no-core-dep design) but verified byte-identical via `tests/security-txt.test.ts`.
- `tools/security-txt-expiry-check.mjs` — fails CI when `Expires` is within 30 days, per the annual-refresh policy commitment.

### Examples — now parameterizable

- `examples/_lib.mjs` reads `CG_DEMO_POD`, `CG_DEMO_POD_B`, `CG_DEMO_POD_BASE` env vars; defaults preserved. External users can run any demo against their own pod without editing source.

### Connectors — surface clarified

- `src/connectors/index.ts` docstring now reflects what's actually implemented (Notion, Slack, Web) vs. the four declared-but-unimplemented types. New `tests/connectors.test.ts` exercises the dispatch + each implemented type with mocked `fetch`.

### Spec status promotions

- `spec/architecture.md` — promoted from "Draft" to "Working Draft" with explicit stability commitments per section. Promotion to Candidate Recommendation now has documented criteria (two interoperable implementations + 30-day review window).
- `spec/revocation.md` — Proposal B (predicate form) adopted as the recommended path; Proposal A retained as an L2 extension for cross-org governance. Both interop per §8 (existing); migration plan documented.
- `spec/OPS-RUNBOOK.md` — TBDs filled (custom-domain mapping plan, gitleaks chosen for pre-commit secret scanning).

### Hygiene

- `tsconfig.json` `exactOptionalPropertyTypes: false` decision documented inline with the rationale.
- `benchmarks/README.md` — schema doc for `eval-history.json`, file inventory, methodology notes.
- 304MB of `benchmarks/*.log` files now gitignored (already done in prior pass).

### Stats

- Tests: 859 → 874 (+5 wallet regression tests + 10 connector tests, less the 3 redundant)
- Coverage: now measured + gated; 60.07% overall (well above the 50% baseline; per-module gates at 80–100% on protocol-critical modules)
- Real bugs caught + fixed: 3 (CJS-in-ESM × 2; `fresh` flag stuck on `false`)

---

## 2026-04-25 — SOC 2 readiness package (eats own dog food)

Builds on the same-day compliance-grade publish work. Provides the human + operational scaffolding to take Interego itself through a SOC 2 examination, and demonstrates that the protocol's compliance-evidence substrate is what the operator uses to record the operator's own behavior.

### Added — written policy set ([`spec/policies/`](spec/policies/))

15 policies, each with Purpose / Scope / Roles / Statements / Procedures / Exceptions / Review / Mapping to CC IDs:

- 01 Information Security · 02 Access Control · 03 Change Management · 04 Incident Response · 05 Business Continuity · 06 Vendor Management · 07 Data Classification · 08 Encryption · 09 Secure SDLC · 10 Logging & Monitoring · 11 Acceptable Use · 12 Data Retention · 13 Risk Management · 14 Vulnerability Management · 15 Privacy

### Added — strategic + operational docs

- [`spec/SOC2-PREPARATION.md`](spec/SOC2-PREPARATION.md) — scope, current-vs-target gap, mapping of Interego features to SOC 2 controls, vendor inventory, solo-operator compensating controls, candidate Type 1 → Type 2 timeline + cost estimate.
- [`spec/OPS-RUNBOOK.md`](spec/OPS-RUNBOOK.md) — production topology, deploy procedure, access management, wallet rotation, backup, monitoring, incident response, quarterly + annual reviews. Calls out current state vs target for each section.
- [`SECURITY.md`](SECURITY.md) + [`SECURITY-ACKNOWLEDGMENTS.md`](SECURITY-ACKNOWLEDGMENTS.md) — coordinated disclosure contact, severity SLA, scope.

### Added — RFC 9116 `/.well-known/security.txt`

Served by every Interego-operated container app: relay, identity, validator, dashboard, pgsl-browser. Single contact + policy URL across the surface area.

### Added — operational event builders ([`src/ops/`](src/ops/index.ts))

Eat own dog food: every operational action becomes a compliance descriptor on the operator's pod.

- `buildDeployEvent` → `soc2:DeployEvent`, cites `soc2:CC8.1`
- `buildAccessChangeEvent` → `soc2:AccessChangeEvent`, cites `soc2:CC6.1`+`soc2:CC6.3`
- `buildWalletRotationEvent` → `soc2:KeyRotationEvent`, cites `soc2:CC6.7`
- `buildIncidentEvent` → `soc2:IncidentEvent`, cites `soc2:CC7.3`(open) / `soc2:CC7.3`+`CC7.4`+`CC7.5`(resolved)
- `buildQuarterlyReviewEvent` → `soc2:QuarterlyReviewEvent`, controls per kind (access / change / risk / vendor / monitoring)

CLI: `tools/publish-ops-event.mjs` — emits the JSON payload ready for `publish_context(..., compliance: true)`. Wired into `deploy/azure-deploy.sh` end-of-run hint.

### Added — five new operational event classes + 22 properties on `soc2:`

`docs/ns/soc2.ttl` extended with `DeployEvent`, `AccessChangeEvent`, `KeyRotationEvent`, `IncidentEvent`, `QuarterlyReviewEvent` (all subclasses of `soc2:ControlEvidence`) plus 22 datatype properties (component, commitSha, accessAction, principal, system, scope, justification, rotationReason, retiredKeyAddress, newKeyAddress, incidentSeverity, incidentStatus, summary, detectionSource, detectedAt, affectedComponent, reviewQuarter, reviewKind, findingCount, finding, environment, rollbackPlan). Plus three previously-implicit controls: `CC7.4`, `CC7.5`, `CC9.2`.

### Fixed — `tools/derivation-lint.mjs` regex

Same-file transitive grounding was failing for any prefix containing a digit (e.g., `soc2:`). Regex updated from `[a-zA-Z]+:` to `[a-zA-Z][a-zA-Z0-9-]*:` (matches valid TTL prefix names). All 91 L2/L3 classes now grounded (was 86/91).

### Stats

- Tests: 817 → 835 (+18 ops builder tests)
- Derivation-lint: 86/91 → 91/91 grounded (closed the bug + added 5 new classes that resolve transitively)
- SOC 2 controls covered: 10 → 13 (+CC7.4, CC7.5, CC9.2)
- Policies: 0 → 15 written

---

## 2026-04-25 — compliance grade publish (regulatory audit-trail substrate)

Closes the "Federated Compliance Graph for AI Agent Governance" gap.
Customers in regulated industries (EU AI Act, NIST AI RMF, SOC 2) can
now use Interego as the audit-trail substrate, with cryptographic
provenance, framework conformance reports, and a verification API that
doesn't trust the relay.

### Added — L3 regulatory mapping ontologies

- `docs/ns/eu-ai-act.ttl` — Articles 6, 9, 10, 12, 13, 14, 15, 50
- `docs/ns/nist-rmf.ttl` — Govern / Map / Measure / Manage
- `docs/ns/soc2.ttl` — Trust Services Criteria (CC, A, PI, C, P)
- 20 new classes total, all derivation-lint grounded.

### Added — `compliance: true` flag on `publish_context` (both surfaces)

When set:
- Trust upgraded to `cg:CryptographicallyVerified`
- Descriptor signed with persisted ECDSA wallet (secp256k1)
- Inline `cg:proof` reference embedded in TrustFacet (proofScheme,
  proofUrl, proofSigner) — included in the SIGNED Turtle so tampering
  invalidates
- Sibling `.sig.json` written to the pod
- Both Turtle + signature auto-pinned to IPFS when provider configured
- Compliance check report appended to response (modal/trust/sig
  validation against L4 conformance)

### Added — Wallet rotation + history

- `loadOrCreateComplianceWallet(path, label)` — loads or creates
- `rotateComplianceWallet(path)` — moves active to history, generates new
- `importComplianceWallet(path, privateKey)` — replace active with
  externally-managed key (HSM, custodial); previous → history
- `listValidSignerAddresses(path)` — all addresses considered valid
  for verification (active + history)
- Backward-compat: pre-rotation single-key wallet files auto-migrate
  on next load.

### Added — Audit endpoints on the relay (public read)

- `GET /audit/frameworks` — list frameworks + their controls
- `GET /audit/events?pod=...&since=...&until=...` — recent descriptors
- `GET /audit/lineage?descriptor=...` — walk derivedFrom + supersedes
- `GET /audit/compliance/<framework>?pod=...` — per-control evidence aggregation
- `GET /audit/verify-signature?descriptor=...` — fetch descriptor +
  sibling .sig.json, recover signer, verify content hash. Auditors
  validate without trusting the relay.

### Added — `examples/compliance-dashboard.html`

Single-page UI. Pod URL + framework selector → summary panel +
recent events + per-control status table with score bar. Reads
the relay's `/audit/*` endpoints. No build step.

### Added — L4 Compliance conformance tier (spec/CONFORMANCE.md)

7 normative requirements (L4.1–L4.7) — trust upgrade, modal commitment,
ECDSA signature, anchored CID, append-only via supersedes, framework
control citations, privacy preflight HIGH-pass.

### Added — Privacy hygiene preflight

`screenForSensitiveContent` runs in `publish_context` on both surfaces;
flags API keys (Anthropic, OpenAI, AWS, GitHub, Stripe, generic), JWTs,
PEM private keys, Luhn-valid credit cards, US SSNs, emails, phone
numbers, IPv4 addresses across three severity tiers. Warning surfaced
to the calling agent; never silently filtered.

### Added — Agent enablement docs

- `docs/AGENT-PLAYBOOK.md` — operational "when X do Y" rules for any
  LLM driving the MCP. Fetched via `docs://interego/playbook`.
- `docs/AGENT-INTEGRATION-GUIDE.md` — one-page integrator guide for
  AI agent harnesses. Fetched via `docs://interego/integration-guide`.
- SERVER_INSTRUCTIONS in BOTH stdio + relay strengthened from
  descriptive to prescriptive: proactive triggers, privacy hygiene
  rules, modal defaults, versioning, error patterns.
- New prompt `whats-on-my-pod` added to both surfaces.

### Tooling fixes

- `computeCid` now produces real CIDv1 (raw codec, sha2-256, base32
  multihash). Was concatenating `bafkrei` + raw hex — looked like a
  CID but never resolved on any IPFS gateway.
- `publish_context` auto-supersedes prior descriptors for the same
  `graph_iri` on the same pod (`auto_supersede_prior` defaults true).
  Republishing-to-add-recipients now cleanly marks older versions as
  superseded; federation queries surface only the canonical current.

### Stats

- Tests: 727 → 817 (+90 across registry, passport, abac, transactions,
  constitutional, ipfs-cid, privacy, compliance)
- Derivation-lint: 41/41 → 86/86 grounded
- Ontologies: 12 → 19
- New runtime modules: `src/abac/`, `src/registry/`, `src/passport/`,
  `src/transactions/`, `src/constitutional/`, `src/privacy/`,
  `src/compliance/`

---

## 2026-04-23 (latest) — MCP discoverability across both surfaces

Both MCP entry points now advertise system-level instructions, doc
resources, and workflow prompts so a brand-new agent learns *what*
this server is, not just *which* tools it exposes.

### `@interego/mcp` (stdio server) — 0.4.1 → 0.5.0

For Claude Code CLI, Codex CLI, and IDE-embedded agents.

- **Instructions block** returned in MCP `initialize`. Concise
  narrative: what Interego is, when to use each tool family, key
  invariants, pointers to doc:// resources for deeper context.
- **7 doc:// resources** (read on demand): `overview`, `architecture`,
  `layers`, `derivation`, `emergence`, `abac-pattern`, `code-domain`.
  Files resolved via candidate-path walk so dev (mcp-server/) and
  dist (mcp-server/dist/) layouts both work.
- **5 prompts** with `prompts: {}` capability: `publish-memory`,
  `discover-shared-context`, `verify-trust-chain`,
  `compose-contexts`, `explain-interego`.

### `@interego/mcp-relay` (HTTP/SSE) — 0.2.0 → 0.3.0

For claude.ai connectors and any other remote MCP client.

- Same instructions block as the stdio server (mirror, not proxy —
  the relay maintains its own MCP Server instance).
- Same 7 doc:// resources. `Dockerfile.relay` now bakes README +
  spec/*.md + docs/EMERGENCE.md + docs/ns/{abac,code}.ttl into
  `/app/relay-docs/` at build time so the container serves them
  with no network dependency.
- 4 prompts (omits `compose-contexts` — relay tool surface differs
  slightly from the stdio server's; will add when relay implements
  the corresponding tool).

### Why

Before: a new agent connecting saw 25 tool descriptions in
isolation and had to infer that publish + share + discover + compose
form one coherent system. Now: it reads a single instructions block
on initialize, fetches docs on demand, and offers users 4-5 concrete
workflows out of the box.

The TurboTax MCP and similar production servers established this
pattern; this commit brings parity.

No tests added (handlers are plumbing — verified by build + manual
JSON-RPC probe). Main project still 727/727. CI auto-deploys the
relay container on push to master; mcp-server publishes on tag.

---

## 2026-04-23 (later still) — attribute-based access control

ABAC built out as a first-class protocol mechanism: policies are typed
context descriptors, predicates are SHACL shapes, attributes are
resolved across the federation, and decisions are themselves linked
data. The structural primitives live at L1 (`cg:`); the evaluation
pattern is L2 (`abac:`); the reference runtime is L3 (`src/abac/`).

### Added (L1 — Protocol)

- **`cg:AccessControlPolicy`** — a policy IS a `cg:ContextDescriptor`.
  Every implementation now has the same policy shape.
- **`cg:DeonticMode`** + individuals `cg:Permit` / `cg:Deny` / `cg:Duty`
  — ODRL-aligned modal labels without the full ODRL dependency.
- **`cg:policyRef`** on `cg:AccessControlFacet` — links a facet to one
  or more policies. WAC-shaped authorizations coexist, so deployments
  migrate ACL → ABAC incrementally.
- **`cg:policyPredicate`** (→ `sh:NodeShape`), **`cg:governedAction`**,
  **`cg:deonticMode`**, **`cg:policyDuty`** properties.
- **`AccessControlFacetData.policyRefs`** TS field; new
  `AccessControlPolicyData` + `DeonticMode` types.

### Added (L2 — Architecture pattern: `abac:`)

- **`docs/ns/abac.ttl`** (new) — 5 classes:
  - `abac:Evaluator` — stateless (policy, context) → decision.
  - `abac:PolicyContext` — resolved subject attributes + resource + env.
  - `abac:AttributeResolver` — federates the subject's attribute graph.
  - `abac:DecisionCache` — cached decisions as verifiable attestations
    (issuer + validity window), so stale cache is verifiably stale.
  - `abac:EvaluationRecord rdfs:subClassOf cg:ContextDescriptor` — the
    audit trail is itself linked data.
- 5 properties + 3 verdict individuals (`abac:Allowed`,
  `abac:Denied`, `abac:Indeterminate` — the Indeterminate case matters
  under open-world federation).

### Added (L3 — Reference runtime `src/abac/`)

- `src/abac/evaluator.ts` — `evaluate(policies, predicates, context)` +
  `evaluateSingle(...)` + `validateAgainstShape(...)`. Deny overrides
  Permit. Duties accumulate. No matching policy → Indeterminate.
- `src/abac/attribute-resolver.ts` — `resolveAttributes(subject,
  descriptors)` aggregates facets from every descriptor that describes
  or attributes to the subject. `extractAttribute(graph, path)` reads
  SHACL-style paths including AMTA-axis attestations.
- `src/abac/cache.ts` — `createDecisionCache()` + `defaultValidUntil`.
- `src/abac/types.ts` — `AttributeGraph`, `PolicyContext`,
  `PolicyDecision`, `PolicyPredicateShape`, `PredicateConstraint`,
  `AbacVerdict`, `DecisionCacheEntry`.
- `src/abac/index.ts` — public entry point; re-exported from the
  top-level package as `evaluateAbac`, `resolveAttributes`,
  `extractAttribute`, `createDecisionCache`, etc.

### Tests

- `tests/abac.test.ts` — 18 new tests across five scenarios:
  single-policy Permit/Deny/Duty; Deny-overrides-Permit composition;
  action mismatch short-circuit; attribute resolver aggregation;
  extractAttribute for standard + AMTA paths; cache hit/miss/stale.

### Demo

- `examples/demo-abac-cross-pod.mjs` — reviewer merge-gate scenario:
  two peer pods issue AMTA attestations about alice on `amta:codeQuality`
  axis; policy requires ≥ 2 attestations ≥ 0.8 + present validity window;
  evaluator aggregates the attribute graph cross-pod and returns
  Allowed. Counterfactual (one attestation missing) flips to
  Indeterminate; adding a Deny-self-asserted policy flips to Denied
  (deny-overrides-permit); cache entries expire into verifiable-stale.

### Lint changes

- `tools/derivation-lint.mjs` adds `abac.ttl` to L2_L3_FILES.
  Passes: 5/5 classes grounded.
- `tools/ontology-lint.mjs` registers `abac` prefix. Passes.
- `cg.ttl` grew from 318 → 328 terms (L1 ABAC additions).
- `abac.ttl` adds 5 classes + 9 terms.

### Deferred

- PGSL deontic-engine bridge (`src/pgsl/agent-framework.ts`) —
  its `PolicyRule` format is tightly coupled to PGSL atom access,
  and `src/abac/` is the general-purpose integration point. A
  converter `policyToDeonticRule(policy)` is a follow-up, not a
  blocker.

### Why

`cg:AccessControlFacet` was WAC-shaped only (identity-based). The
federation model already provides attribute-rich facets (Trust,
Semiotic, Provenance, AMTA-axis attestations) but we had no
evaluator that consumed them as policy inputs. This lands one.

725/725 tests pass (707 + 18 new). Derivation-lint 56/56 grounded.
Ontology-lint clean.

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
