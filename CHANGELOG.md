# Changelog

Notable changes to @interego/core. Dates are UTC.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with RFC 2119-style
capability descriptions. Commit hashes link back to the git history; the README
describes what the system IS, this file describes what changed and when.

---

## 2026-06-14 — Foxxi: regime-first performance architecture + reflexive engagement (wi-001)

A complexity-aware performance-management layer on the Foxxi vertical, built
through a live three-agent + human engagement and then dogfooded on the team
that built it. No L1/L2/L3 ontology touches; substrate-composed.

### Added
- **Regime-first diagnosis** — `WorkRegime` (Evident / Knowable / Emergent /
  Turbulent) routed to its method (apply-practice / gap-analysis /
  dispositional-read / stabilise-first). `diagnose()` classifies a *performance
  situation* before planning; with no signal it returns a first-class
  `classify-first` / `unclassified` diagnosis and **refuses to gap-plan**
  (previously it silently defaulted to Knowable — the gap-first-via-default
  defect). `applications/foxxi-content-intelligence/src/performance-architecture.ts`.
- **`regimeSource` provenance** — `derived` | `asserted` | `default-gap-intent`
  | `unclassified`. Only *derived* (trajectory-signal) regimes carry calibration
  authority; asserted and default-gap-intent are excluded from the reflexive
  loop on both the consume and accrue sides. `src/performance-calibration.ts`.
- **Signed, followable classification affordance** — `GET /performance`
  self-describes its input schema; `contextualize-and-plan-signed` lets a mesh
  agent classify a situation *as itself* (delegation-verified `classifiedBy`).
  `src/performance-routes.ts`.
- **Multi-recipient durable-key records** — `record-performance` accepts
  `recipients`; each pod's durable `keys/encryption.json` is resolved and the
  content key wrapped to it. `src/durable-records.ts`, `src/foundation-holon-altitude.ts`.
- **Engagement docs** — [`ENGAGEMENT-REPORT.md`](ENGAGEMENT-REPORT.md) (full
  breakdown + Mermaid diagrams + a standalone `ENGAGEMENT-REPORT.html` viewer)
  and [`REFLEXIVE-DOGFOOD.md`](REFLEXIVE-DOGFOOD.md).

### Fixed
- **Confidentiality leak** — recipient-wrapped records no longer write the full
  xAPI statement in cleartext; it is redacted to structural metadata and the full
  statement lives only in the encrypted holon. Standing lesson: base64 ≠ encryption.
- **Cross-seat holon resolution** — the `cg:encryptedHolon` link is advertised on
  the gate host at mint time (write target + ciphertext untouched, so signed
  authorship still verifies). `src/foundation-persist.ts`.

---

## 2026-05-18 — Foxxi: thirteen-item product expansion (verifier portal, DPIA, SCORM Cloud, multi-tenant, manager view, marketplace, observability, …)

Single pass shipping every item from the "what else would be valuable
for this vertical" brainstorm — composed entirely from existing
substrate primitives. **13 new bridge affordances** + **observability
endpoints** (`/metrics` Prometheus, `/metrics.json` operator dashboard)
+ **2 new microsite pages** (Verify, DPIA) on the existing microsite
container. No L1/L2/L3 ontology touches; no substrate code touched.

### New bridge affordances (13)

| Affordance | Purpose |
|---|---|
| `foxxi.bootstrap_tenant` | Wizard backend — bootstrap a fresh tenant on a Solid pod, return env-var config for the operator |
| `foxxi.scorm_cloud_pull` | Pull a SCORM Cloud course catalog into the tenant via Application API v2 |
| `foxxi.scorm_cloud_register` | Create a SCORM Cloud registration whose ID becomes the cmi5 sessionId |
| `foxxi.upload_scorm_package` | Queue a SCORM zip — publishes `fxs:PackageUpload` (Hypothetical), separate parser-runner promotes via supersedes |
| `foxxi.derive_adaptive_policy` | Cohort intelligence → `fxa:AdaptiveSequencingPolicy` (moveOn gates for downstream learners) |
| `foxxi.schedule_spaced_repetition` | Ebbinghaus 1/7/30-day reminders + foundation-concept early reminders from the prereq graph |
| `foxxi.discover_framework_registry` | Federated multi-pod competency-framework discovery — no central registry |
| `foxxi.register_tutor_agent` | Tutor agent (human or AI) registers profile with specialties + contact endpoint |
| `foxxi.find_tutor_for_competency` | Rank-search tutors by competency match + independent countersigned-assertion count |
| `foxxi.generate_dpia` | GDPR Art. 35 + EU AI Act §13 Data Protection Impact Assessment from the audit chain |
| `foxxi.manager_team_view` | Manager-role-only — direct reports' competency state aggregated into a team skill map |
| `foxxi.build_did_web_document` | Generate publishable `did:web` document for a tenant domain |
| `foxxi.backup_tenant_pod` | One-shot dump of every descriptor + reachable graph on the pod |

**Bridge total now: 45 affordances** (was 32 before this commit).

### New microsite surfaces (existing container app)

- **Verify** (`/verify`) — recruiter / compliance officer / partner-org consumer of credentials. Pastes a learner WebID, picks competency + level, chooses **Review full wallet** (composes `foxxi.export_clr`) or **Request ZK proof only** (composes `foxxi.issue_bbs_credential` + `foxxi.derive_bbs_presentation` + `foxxi.verify_bbs_presentation`). Shows exactly what the verifier learned + what stayed cryptographically hidden.
- **DPIA** (`/dpia`) — compliance-officer dashboard. Generates a Data Protection Impact Assessment per learner: summary stats grid, framework-controls roll-up, GDPR data-category breakdown (encrypted vs plaintext), risk-rated findings with suggested mitigations.

### Observability

- **`GET /metrics`** — Prometheus text-format exposition: per-handler `calls_total` / `errors_total` counters, per-handler `latency_ms_p95` gauge, plus global counters for `llm_cost_cents_total` (approximate, via public Anthropic pricing), `rate_limit_hits_total`, `auth_failures_total`, `bbs_proofs_derived_total`, `vcs_issued_total`.
- **`GET /metrics.json`** — same data as JSON for operator dashboards; handlers sorted by call volume, p50 + p95 latencies.
- Every handler call is instrumented via a transparent wrapper around the `handlers` map — no per-handler edits.

### NEW files

| File | What |
|---|---|
| [`applications/foxxi-content-intelligence/src/observability.ts`](applications/foxxi-content-intelligence/src/observability.ts) | Per-handler counters + Prometheus + JSON renderers; bounded-cardinality (no PII in labels) |
| [`applications/foxxi-content-intelligence/src/scorm-cloud.ts`](applications/foxxi-content-intelligence/src/scorm-cloud.ts) | SCORM Cloud Application API v2 connector (list courses, create registrations, get launch links) |
| [`applications/foxxi-content-intelligence/src/composed-extensions.ts`](applications/foxxi-content-intelligence/src/composed-extensions.ts) | All 13 composition functions — tenant bootstrap, adaptive policy, spaced repetition, framework registry, tutor marketplace, DPIA, manager view, SCORM upload, did:web document, pod backup |
| [`applications/foxxi-content-intelligence/microsite-app/src/pages/Verify.tsx`](applications/foxxi-content-intelligence/microsite-app/src/pages/Verify.tsx) | Verifier portal page |
| [`applications/foxxi-content-intelligence/microsite-app/src/pages/Dpia.tsx`](applications/foxxi-content-intelligence/microsite-app/src/pages/Dpia.tsx) | Compliance-officer DPIA page |

### New env vars on the bridge

- `FOXXI_SCORM_CLOUD_APP_ID` — optional; enables `foxxi.scorm_cloud_*`. SCORM Cloud Application ID from cloud.scorm.com.
- `FOXXI_SCORM_CLOUD_SECRET_KEY` — paired with the above.
- `FOXXI_AGENTIC_RATE_LIMIT_PER_IP` — optional override; defaults to 10 calls per 5min per IP for the agentic ask handler.

### Layering audit (unchanged principles)

- Zero L1 (`cg:` / `cgh:` / `pgsl:` / `ie:` / `align:`) additions
- Zero L2/L3 ontology changes in `docs/ns/`
- Every new vocab term in `vocab.foxximediums.com/*` (vertical-scoped: `fxa:AdaptiveSequencingPolicy`, `fxs:PackageUpload`, `fxs:TenantMetadata`, `fxa:TutorAgentProfile` — referenced by the conformsTo strings in the new handlers; declarations follow in the next commit)
- All compositions use existing `publish` / `discover` / `fetchGraphContent` / `verifyDataIntegrityProof` / BBS+ / cmi5 primitives. No new substrate code.

## 2026-05-18 — Foxxi: try-it-now microsite live on Azure

Front-door microsite that gets a brand-new visitor with zero Interego /
Foxxi context from "what is this?" to "I just exercised every layer of
the substrate" in three minutes. Lives at its own URL, separate Container
App, separate Vite + React build, calls the same production bridge as
the dashboard.

**Live:** https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io

### What it is

A 3-page Vite + React SPA: landing page (hero + 4 value props + standards
strip + try-now CTAs), a try-it-now flow with role tabs (learner /
admin), and an architectural about page. The try-now flow runs **10
real bridge calls** across the two role tracks — 5 learner steps
(discover assignments → ask Golf Explained a question → export your CLR
wallet → receive a BBS+ credential → derive selective-disclosure proof
+ verify) and 5 admin steps (privacy-preserving coverage query → issue
OB3 credential → compose audit trail → declare cross-tenant alignment
→ export CASE 1.0 framework).

Each demo card has the same shape: short body explaining what's about
to happen, the action button, the JSON-RPC call trace (collapsible —
shows the request + raw bridge response), a result-summary chip, and a
"what just happened" explainer that decodes the response in plain
English. No prior Interego knowledge required.

### Auth without signup

Visitor never registers. The microsite auto-mints bearer tokens for the
two demo identities (Joshua / Jordan) using the same `ethers`-based
ECDSA `mintSessionToken` that the dashboard uses — shared via the
foxxi-vertical's `src/auth.ts`. The tokens carry 30-minute TTLs and
live only in browser memory; closing the tab evaporates them. The
bridge verifies them against the published tenant directory's
`wallet_address` map (E2EE-decrypted on the bridge side), so the same
real AuthN + AuthZ pipeline that protects the dashboard protects every
demo card.

### NEW files (all under [applications/foxxi-content-intelligence/microsite-app/](applications/foxxi-content-intelligence/microsite-app/))

| File | Purpose |
|---|---|
| `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx` | Vite + React scaffold. Same theme tokens (cream/navy/Garamond) as the dashboard, declared inline in `index.html`. |
| `src/bridge-client.ts` | Thin client over `fetch` + JSON-RPC. Mints session tokens via shared `auth.ts`; per-call returns a structured `BridgeCall` with the args / response / authed status / caller WebID / duration. |
| `src/App.tsx` | History-API routing (no React Router); top nav + footer. |
| `src/pages/Landing.tsx` | Hero (large italic Garamond display), 4-card value prop grid, standards monospace strip, dual CTA. |
| `src/pages/TryNow.tsx` | Role-tab switcher (learner / admin); identity card; renders 5 demo cards from `demos/learner.tsx` or `demos/admin.tsx`. |
| `src/pages/About.tsx` | Architectural explanation: three-layer separation, standards stack, what the demo actually does, where to go next. |
| `src/components/DemoCard.tsx` | The card primitive — numbered step header, body explainer, action button with `running…` blinking dots, collapsible call-trace renderer (raw JSON-RPC), result-summary chip, "what just happened" explainer pane. |
| `src/demos/learner.tsx` | 5 learner demo steps. Step 4 cross-tracks: bridge call is made as Jordan (only admins can issue) but the result lands in Joshua's wallet + threads through to step 5. Step 5 reuses the issued BBS+ credential to derive + verify a selective-disclosure presentation revealing 3 of 14 claims. |
| `src/demos/admin.tsx` | 5 admin demo steps. Each exercises a different layer: aggregate privacy (coverage_query), credential issuance (issue_completion_credential), compliance audit (audit_compliance_trail), cross-tenant interop (declare_framework_alignment), framework export (export_case_framework). |

### NEW deployment artifact

- [`deploy/Dockerfile.foxxi-microsite`](deploy/Dockerfile.foxxi-microsite) — same two-stage pattern as the dashboard. Vite build with `VITE_FOXXI_BRIDGE_URL` baked in; nginx:1.27-alpine serves the static bundle on port 8080 with SPA-style `/index.html` fallback for the `/try` + `/about` routes. Copies the foxxi-vertical's `src/` + `package.json` first so the microsite can `import` the shared `auth.ts` (resolves `ethers` from the vertical's node_modules).

### Bridge change: multi-origin CORS

[`applications/foxxi-content-intelligence/bridge/server.ts`](applications/foxxi-content-intelligence/bridge/server.ts):
the CORS middleware now treats `FOXXI_DASHBOARD_ORIGIN` as a
comma-separated allow-list. The middleware echoes the request's
`Origin` header back as `Access-Control-Allow-Origin` only when the
origin is in the allow-list (per CORS spec, the header can hold only
one value). Bridge env updated to
`FOXXI_DASHBOARD_ORIGIN=https://interego-foxxi-dashboard...,https://interego-foxxi-microsite...`.

### Live verification (just ran)

```
=== CORS preflight from dashboard origin → echoes dashboard ✓
=== CORS preflight from microsite origin → echoes microsite ✓
=== CORS preflight from attacker.example.com → no allow-origin header ✓
=== microsite-origin browser call (POST /mcp, bearer Joshua):
    HTTP 200 · CORS echo: microsite · result: Joshua Liu · 10 enrollments · allow/learner
```

### Container app summary

- Microsite: `interego-foxxi-microsite` rev `--0000001` (sha256:db6be493…), 0.25 CPU / 0.5 GiB / external ingress / port 8080
- Bridge: `interego-foxxi-bridge` rolled to rev `--0000010` (sha256:931076ca…), env updated with the 2-origin allow-list
- Existing apps (`interego-foxxi-dashboard`, `interego-css`, `interego-relay`, etc.) unchanged

### Why a separate surface from the dashboard

The dashboard is the production-grade tool for visitors who already know
what the substrate is and want to use it. The microsite is the
education / try-it surface — narrative, scripted, explains everything.
Splitting them lets each be honest about its job: the dashboard is
dense (12 admin tabs, full slide navigator, full chat) and the
microsite is sparse (3 pages, 10 buttons, lots of prose).

## 2026-05-18 — Foxxi: 10 "crazier" TLA demos composed from the standards stack

After closing every conformance gap, this pass wires the composed
demos that exercise the full ADL TLA / IEEE LERS / 1EdTech surface
in ways that are difficult-to-impossible in conventional ed-tech.
11 new bridge affordances, all composed from existing substrate
primitives + the eight standards modules from the previous commit.
No new substrate code; no new L1/L2/L3 ontology terms; new vertical-
side vocab IRIs only.

**Bridge: 32 affordances total** at `interego-foxxi-bridge--0000007`
(sha256:e5aba8de…).

### The 10 demos (all live + smoke-tested)

| # | Demo | Composition | Live verdict |
|---|---|---|---|
| 1 | **BBS+ selective-disclosure interview** | `issue_bbs_credential` + `derive_bbs_presentation` + `verify_bbs_presentation` | Issued 80-byte BBS+ sig over 14 claims, derived 624-byte ZK proof revealing 3 of 14; verifier accepted + learned ONLY the 3 disclosed claims |
| 2 | **Cross-tenant CASE alignment** | `declare_framework_alignment` + `resolve_aligned_competency` | Foxxi `handicap` ↔ PartnerCo `ac-distribution-l2` resolved as `satisfied via 1 alignment hop` |
| 3 | **AI agent as learner** | `register_self_sovereign_learner` (with `is_agent=true`) | Same affordance surface as humans — agent identity registered with own DID + pod |
| 4 | **Competency-gated AU launch** | `launch_au_with_prereq_check` (composes ABAC + VC verify + cmi5 launch) | Walks learner pod, verifies Data Integrity Proof on credentials, applies achievement + proficiency + issuer + expiry filters before emitting cmi5 `launched` |
| 5 | **Federated TLA Experience Index** | `query_experience_index` (from prior commit) | Parallel queries across N LRSs, dedup by Statement ID, per-LRS error isolation; demo'd with 2 fake LRS endpoints both failing cleanly |
| 6 | **Multi-issuer mosaic wallet** | `export_clr` (from prior commit) over a pod with credentials from multiple issuers | CLR envelope aggregates every fxa:CourseCompletionCredential + fxa:CompetencyAssertion regardless of issuer DID; preserves each entry's independent proof |
| 7a | **AI mentor competency assessor** | `ai_assess_competency` | Mentor's `did:key` signs a CompetencyAssertion VC with modalStatus: Hypothetical |
| 7b | **Human countersign → OB3** | `countersign_assessment` | Admin's `did:key` countersigns, type elevates to `[VerifiableCredential, OpenBadgeCredential, CompetencyAssertion]`, original mentor signature preserved |
| 8 | **Cohort intelligence via concept overlap** | `cohort_concept_intelligence` (gathers fxa:LearnerQuestionEvent across pods, computes overlap) | Walks N pods in parallel, summarises concept frequency, flags reinforcement candidates (>= 50% cohort coverage) |
| 9 | **Self-sovereign learner subscription** | `register_self_sovereign_learner` | Mints fxa:SelfSovereignLearner descriptor — learner takes credentials with them, no employer mediation |
| 10 | **EU AI Act audit-trail composer** | `audit_compliance_trail` (single-query descriptor chain walker) | Walks learner pod in time window, returns 13 descriptors classified by step kind (cmi5/OB3/CompetencyAssertion/CASE/AccessDecision), 10 unique framework citations |

### NEW vertical files (composition modules — no new substrate code)

- [`applications/foxxi-content-intelligence/src/bbs-credentials.ts`](applications/foxxi-content-intelligence/src/bbs-credentials.ts) — Demo #1. `issueBbsCompletionCredential()` builds an OB3-shaped VC + signs it with the tenant's deterministic BBS+ key over a flattened message list. `deriveCompletionPresentation()` (holder-side) takes the issued credential + a list of claim paths to reveal, derives a ZK BBS+ proof. `verifyCompletionPresentation()` (verifier-side) returns whether the issuer signed a credential containing the disclosed claims at the disclosed positions. The full credential never leaves the holder; only the proof + revealed claims reach the verifier.
- [`applications/foxxi-content-intelligence/src/composed-flows.ts`](applications/foxxi-content-intelligence/src/composed-flows.ts) — Demos #4, #7a, #7b, #10. `launchAuWithPrereqCheck()` composes `discover` + `verifyDataIntegrityProof` + `buildPassedSessionTrace`. `aiAssessCompetency()` mints a Hypothetical CompetencyAssertion VC with a mentor's `did:key`. `countersignAssessment()` elevates to a dual-issuer OB3 credential. `composeAuditTrail()` walks the pod for descriptors with Provenance facets or `dct:conformsTo` tags + returns them as an ordered chain.
- [`applications/foxxi-content-intelligence/src/framework-alignment.ts`](applications/foxxi-content-intelligence/src/framework-alignment.ts) — Demo #2. `serializeAlignment()` produces a CASE 1.0 CFAssociation-shaped descriptor binding one tenant's competency IRI to another's. `resolveAlignment()` BFSes over a list of alignments (`isAlignedTo` / `isEquivalentTo` are bidirectional; others are directed) to answer "does this held competency satisfy that required competency?"
- [`applications/foxxi-content-intelligence/src/cohort-intel.ts`](applications/foxxi-content-intelligence/src/cohort-intel.ts) — Demo #8. `gatherCohortQA()` walks N learner pods + pulls every fxa:LearnerQuestionEvent in the time window. `summarizeCohort()` computes per-concept stats (learner count, question count, cohort coverage %) + flags reinforcement candidates. Same intuition as the substrate's PGSL `meet` operator at the atom level; simpler set-intersection at the descriptor level for this affordance.

### NEW bridge affordances (11)

- `foxxi.issue_bbs_credential` (admin) — issue a BBS+-signed OB3 credential
- `foxxi.derive_bbs_presentation` — holder derives a ZK selective-disclosure proof
- `foxxi.verify_bbs_presentation` — verifier checks a ZK proof against revealed claims
- `foxxi.launch_au_with_prereq_check` — gated cmi5 launch
- `foxxi.ai_assess_competency` — AI mentor signs Hypothetical CompetencyAssertion
- `foxxi.countersign_assessment` (admin) — human countersigns → OB3
- `foxxi.audit_compliance_trail` (admin) — single-query descriptor chain
- `foxxi.declare_framework_alignment` (admin) — CASE-shaped cross-framework binding
- `foxxi.resolve_aligned_competency` — BFS over alignment graph
- `foxxi.cohort_concept_intelligence` (admin) — multi-pod concept-overlap analytics
- `foxxi.register_self_sovereign_learner` — learner-controlled DID + pod registration (humans + AI agents share the same path)

### Layering audit

Every demo composes existing primitives:
- BBS+ flow → `@digitalbazaar/bbs-signatures` (already added for the cryptosuite work)
- Gated launch → existing `discover` + `verifyDataIntegrityProof` + `buildPassedSessionTrace`
- AI mentor / countersign → existing `importDidKeyEd25519` + `issueDataIntegrityProof`
- Audit trail → existing `discover` filtered on `dct:conformsTo` + `facetTypes.includes('Provenance')`
- Alignment → pure functions over the alignment payload + BFS
- Cohort intelligence → existing `discover` + `fetchGraphContent` + plain set math

No L1 (`cg:` / `cgh:` / `pgsl:` / `ie:` / `align:`) terms invented. No L2/L3 ontologies in `docs/ns/` touched. No mcp-server / deploy/mcp-relay touched. All new vocab terms in foxxi-side namespaces (`fxa:` / `fxs:` / `fxk:` / `rcd:` / `wallet:` — all under `vocab.foxximediums.com/*`).

### Live URL unchanged

`https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io` — revision `--0000007`, sha256:e5aba8de…, 32 affordances total.

---

## 2026-05-17 — Foxxi standards-completion: closes every partial + not-implemented row

Finishes the conformance work the prior commit laid out. Every "Partial"
or "Not implemented" row in [CONFORMANCE.md](applications/foxxi-content-intelligence/CONFORMANCE.md)
that was achievable as a vertical-side or substrate-side composition is
now wired with real code, real cryptography, and local round-trip
verification. The only remaining "Out of scope" status is SCORM CMI
runtime — re-documented as an explicit architectural boundary (LMS
runtime layer, not the content-ingestion vertical).

### Local end-to-end smoke (all new modules, real crypto)

```
=== 1. eddsa-rdfc-2022 ===
  cryptosuite: eddsa-rdfc-2022 · verified: true

=== 2. BBS+ ===
  signature: 80 b · full verify: true
  selective proof: 336 b · verifies revealing [0,1]: true

=== 3. DIDs ===
  did:key: Ed25519VerificationKey2020
  did:web URL (example.com:user:bob): https://example.com/user/bob/did.json
  did:web URL (example.com): https://example.com/.well-known/did.json
  did:ethr: eip155:1:0x7358d650b0864e1dF42ee86955e26F5102878b06

=== 4. cmi5 ===
  trace: launched → initialized → completed → passed → terminated → satisfied
  moveOn: completed=true AND passed=true
```

### Standards status (after this pass)

| Standard | Before | After |
|---|---|---|
| SCORM 1.2 / 2004 sequencing | partial (vocab declared, parser didn't emit) | **compliant** — `lom-sequencing.ts` emits `fxs:SequencingRule` with verbatim XML preserved for LMS replay |
| cmi5 (9 statements + session + moveOn) | partial (2/9) | **compliant** — all 9 verbs + `evaluateMoveOn(Passed / Completed / CompletedAndPassed / CompletedOrPassed / NotApplicable)` |
| IEEE LOM 1484.12.1 (§5 Educational, §2 Lifecycle, §6 Rights, §7 Relation, §9 Classification) | partial (General + Technical only) | **compliant** — `lomToTurtle()` emits IEEE LOM namespace triples for every category present in the source manifest |
| W3C VC Data Integrity `eddsa-rdfc-2022` | not implemented | **compliant** — JSON-LD expand → URDNA2015 canonicalize → SHA-256 → Ed25519 |
| W3C VC `bbs-2023` (BBS+ selective disclosure) | not implemented | **compliant** — sign / verify / deriveProof / verifyProof via `@digitalbazaar/bbs-signatures` (BLS12-381 SHA-256) |
| W3C DID `did:web` | not implemented | **compliant** — HTTPS fetch of `.well-known/did.json` per did:web v0.0.3 |
| W3C DID `did:ethr` | not implemented | **compliant** — `EcdsaSecp256k1RecoveryMethod2020` verification method with CAIP-10 `blockchainAccountId` |
| TLA Experience Index read-side (federated xAPI query across LRSs) | not implemented | **compliant** — parallel `GET /statements` across N LRSs, dedup by Statement ID, per-LRS attribution + error isolation |
| ADL CaSS direct integration | not implemented | **compliant** — `POST /api/framework` + `POST /api/assertion` REST connector |
| 1EdTech CLR 1.0 (legacy pre-VC) | not covered | **compliant** — `envelopeToClr1()` projects the CLR 2.0 envelope to the legacy shape |
| SCORM CMI runtime API | out of scope | **out of scope (architectural boundary)** — re-documented as LMS runtime layer; not a vertical concern |

### NEW substrate-side files

- [`src/solid/did-resolver.ts`](src/solid/did-resolver.ts) — Unified `resolveDid(did)` dispatch by method (`did:key` / `did:web` / `did:ethr`). Returns a uniform DID document shape regardless of method. `didWebDocumentUrl()` helper exported for clients that want to construct the URL without resolving.
- [`applications/_shared/vc-jwt/data-integrity-rdfc.ts`](applications/_shared/vc-jwt/data-integrity-rdfc.ts) — `eddsa-rdfc-2022` Data Integrity cryptosuite. `issueDataIntegrityRdfcProof(unsigned, issuer)` and `verifyDataIntegrityRdfcProof(signed)`. Composes `jsonld` (expansion + N-Quads conversion), `rdf-canonize` (URDNA2015), `@noble/hashes/sha2`, `@noble/curves/ed25519`.
- [`applications/_shared/vc-jwt/bbs-2023.ts`](applications/_shared/vc-jwt/bbs-2023.ts) — BBS+ selective disclosure. `generateBbsKeyPair`, `bbsSign`, `bbsVerify`, `bbsDeriveProof`, `bbsVerifyProof`, plus a `flattenCredentialSubject()` helper that produces a stable message list from a VC's claims (so the holder can later disclose a subset by index without re-flattening). Composes `@digitalbazaar/bbs-signatures` (BLS12-381 SHA-256 ciphersuite).
- [`applications/lrs-adapter/src/experience-index.ts`](applications/lrs-adapter/src/experience-index.ts) — `queryFederatedStatements(endpoints, filter)` for the read side of the ADL TLA Experience Index. Parallel queries across N LRSs, dedup by Statement ID, per-LRS attribution + error isolation (one failed LRS doesn't fail the federation).

### NEW vertical-side files

- [`applications/foxxi-content-intelligence/src/cmi5.ts`](applications/foxxi-content-intelligence/src/cmi5.ts) — Full cmi5 v1.0 / IEEE 9274.2.1 statement suite. `buildCmi5Statement(verb)` covers all 9 cmi5 verbs (launched / initialized / completed / passed / failed / abandoned / waived / terminated / satisfied). `buildPassedSessionTrace()` emits a canonical lifecycle trace. `evaluateMoveOn(rule)` implements cmi5 §11 mastery/moveOn decision per the AU's declared rule. Validates cmi5 spec invariants at build time (e.g. `passed`/`failed` requires `result.score.scaled`).
- [`applications/foxxi-content-intelligence/src/lom-sequencing.ts`](applications/foxxi-content-intelligence/src/lom-sequencing.ts) — `lomToTurtle(subject, lom)` lifts every IEEE LOM 1484.12.1 category (General / Lifecycle / Meta-Metadata / Technical / Educational / Rights / Relation / Annotation / Classification) to Turtle triples using the IEEE LOM namespace. `sequencingRulesToTurtle()` emits SCORM 2004 `<imsss:sequencing>` rules as `fxs:SequencingRule` instances with the verbatim rule XML preserved as a literal (we don't evaluate sequencing — that's an LMS runtime concern — but auditors get a tamper-evident record of what the package SAID happens).
- [`applications/foxxi-content-intelligence/src/cass-connector.ts`](applications/foxxi-content-intelligence/src/cass-connector.ts) — `pushFrameworkToCass(caseDoc, config)` posts a CASE 1.0 CFDocument to a CaSS server's `/api/framework` endpoint. `pushAssertionToCass(assertion, config)` posts a learner competency assertion to `/api/assertion`. Pure adapter; no new vocab.
- [`applications/foxxi-content-intelligence/src/clr-1.ts`](applications/foxxi-content-intelligence/src/clr-1.ts) — `envelopeToClr1(envelope)` projects a CLR 2.0 envelope (from `clr.ts`) to the legacy 1EdTech CLR 1.0 JSON shape for institutional consumers still on the pre-VC format.

### NEW bridge affordances

| Affordance | Description |
|---|---|
| `foxxi.emit_cmi5_session` | Emit a full cmi5 lifecycle statement trace for a learner's AU session — 5–6 statements (launched → initialized → completed → passed/failed → terminated, plus satisfied if moveOn fires). |
| `foxxi.resolve_did` | Resolve a W3C DID via the substrate's pluggable `resolveDid()` — works for did:key, did:web, did:ethr. |
| `foxxi.query_experience_index` (admin-only) | Federated xAPI query across N LRSs per ADL TLA Experience Index. |
| `foxxi.push_to_cass` (admin-only) | Synthesize the tenant's competency framework via the CASE exporter and POST to a CaSS server. |
| `foxxi.export_clr_v1` | Export the learner's record as 1EdTech CLR 1.0 (legacy pre-VC JSON). |

### New dependencies

- `rdf-canonize@^4` — URDNA2015 RDF canonicalization (for `eddsa-rdfc-2022`)
- `jsonld@^8` — JSON-LD expansion to N-Quads (for `eddsa-rdfc-2022`)
- `@digitalbazaar/bbs-signatures@^1` — BLS12-381 BBS+ signing (for `bbs-2023`)

All three are pure-JS, no native compilation, work in browser + Node.

### Notes on the remaining row

**SCORM CMI runtime API** stays `out of scope` — explicitly. The vertical's stratum is content ingestion + post-hoc analytics; the CMI runtime data model (`cmi.core.*`, `cmi.interactions.*`) is the LMS runtime layer. Composing it would mean Foxxi becoming an LMS, which would dissolve the architectural boundary that lets Foxxi compose cleanly with any LMS. Documented as a boundary, not a gap.

## 2026-05-17 — Foxxi: ADL TLA / IEEE LERS / 1EdTech credential + competency stack live

Closes the loop on the credentialing side of the audit. When a learner
completes a course, the bridge mints a real W3C Verifiable Credential
shaped as an Open Badges 3.0 `OpenBadgeCredential`, signs it with the
tenant's deterministically-derived Ed25519 issuer key using the
substrate's `eddsa-jcs-2022` DataIntegrityProof machinery, and
publishes it to the learner's pod as a `fxa:CourseCompletionCredential`
descriptor. The learner can then export an aggregate
1EdTech Comprehensive Learner Record (CLR 2.0) envelope that wraps
every issued credential — each entry preserves its own proof so any
third-party verifier can re-check without trusting the envelope.
Tenant operators can export their competency framework as 1EdTech
CASE 1.0 JSON-LD for downstream institutional tooling.

No new substrate primitives. The Foxxi vertical composes existing
substrate machinery (`vc-jwt` + `data-integrity-jcs` for signing,
`solid.publish` + `solid.discover` for pod read/write, `did:key`
for issuer identity) with three new vertical-side modules + two L2
vocab files.

### Live end-to-end smoke (5 cases, real ECDSA + Ed25519)

| Case | Result |
|---|---|
| Learner tries to issue credential | **denied** — `only admins can issue completion credentials (role: learner)` |
| Admin issues OB3 VC for learner's Golf Explained completion | **OK** — `did:key:z6MkoKbMXTRh2d…` issuer, `eddsa-jcs-2022` proof, types `[VerifiableCredential, OpenBadgeCredential]`, achievement + alignment + evidence populated, published to `<pod>/foxxi-wallet/cred-…ttl` |
| Learner exports own CLR | **1 entry, verified: 1** — `holderDid=https://id.acme-training.example/jliu/profile#me`, issuer matches what was just issued |
| Learner tries to export another learner's CLR | **denied** — `non-admins can only export their own CLR` |
| Admin exports CASE 1.0 framework | **OK** — `CFDocument` with 18 audience-tag-derived items, `@context: https://purl.imsglobal.org/spec/case/v1p0/context/case_v1p0.jsonld` |

### Standards conformance map

Full conformance audit lives in [`applications/foxxi-content-intelligence/CONFORMANCE.md`](applications/foxxi-content-intelligence/CONFORMANCE.md) with file:line citations for every claim. Headline status:

| Standard | Status |
|---|---|
| ADL SCORM 1.2 / 2004 | Compliant for content packaging; sequencing rules partial; CMI runtime out of scope (LMS-layer concern) |
| xAPI 1.0.3 / 2.0.0 / IEEE 9274.1.1 | Compliant via `lrs-adapter` — tested live against Lrsql, SCORM Cloud, Watershed |
| cmi5 / IEEE 9274.2.1 | Partial — AU detection + 2/9 statement profiles; remaining 7 profiles + session/mastery semantics not yet wired |
| IEEE LOM 1484.12.1 | Partial — General + Technical categories; Educational/Lifecycle/Rights/Classification not auto-extracted |
| IEEE 1484.20.1 RDCEO / 1484.20.2 RCD | Compliant via [`ns/rcd.ttl`](applications/foxxi-content-intelligence/ns/rcd.ttl) — `rcd:CompetencyDefinition` subclass of `fxk:Skill`, five-rung `rcd:ProficiencyLevel` (Novice → Expert) |
| 1EdTech CASE 1.0 | Compliant via [`src/case-exporter.ts`](applications/foxxi-content-intelligence/src/case-exporter.ts) + `foxxi.export_case_framework` |
| ADL CaSS | Compose via CASE (CaSS imports CASE JSON-LD) |
| W3C VC Data Model 2.0 | Compliant (vc-jwt + eddsa-jcs-2022 DataIntegrity); BBS+ and eddsa-rdfc-2022 not implemented |
| W3C DIDs | Compliant for `did:key`; `did:web` / `did:ethr` not wired |
| 1EdTech Open Badges 3.0 | Compliant via [`src/credentials.ts`](applications/foxxi-content-intelligence/src/credentials.ts) + `foxxi.issue_completion_credential` |
| 1EdTech CLR 2.0 | Compliant via [`src/clr.ts`](applications/foxxi-content-intelligence/src/clr.ts) + `foxxi.export_clr` |
| TLA Master Object Model | Compliant — Course/Learner/Competency/Assessment/Result as RDF descriptors |
| TLA Experience Index (write) | Compliant via `lrs-adapter` projection |
| TLA Experience Index (read-side federation) | Not implemented — planned as thin federator on `lrs-client.ts` |
| ADL Learner Records Network ("learner wallet") | Pod-as-wallet operational; backup/replication pattern not yet a standard affordance |

### NEW vertical files

- [`applications/foxxi-content-intelligence/ns/rcd.ttl`](applications/foxxi-content-intelligence/ns/rcd.ttl) — IEEE 1484.20.2 mapping. Declares `rcd:CompetencyDefinition` (subclass of `fxk:Skill`), `rcd:ProficiencyLevel` with five individuals (`rcd:Novice` → `rcd:Expert`) carrying `rdf:value 1..5`, and `rcd:statement` / `rcd:scope` / `rcd:masteryRubric` predicates.
- [`applications/foxxi-content-intelligence/ns/wallet.ttl`](applications/foxxi-content-intelligence/ns/wallet.ttl) — Learner-wallet L2 pattern. Declares `wallet:WalletEnvelope` (subclass of `cg:ContextDescriptor`) for CLR-shaped aggregation, plus `wallet:holdsCredential`, `wallet:holderDid`, `wallet:exportedAt`.
- [`applications/foxxi-content-intelligence/src/credentials.ts`](applications/foxxi-content-intelligence/src/credentials.ts) — `deriveTenantIssuer(seed)` derives an Ed25519 `did:key` keypair deterministically from `FOXXI_ISSUER_KEY_SEED`; `buildCourseCompletionVc()` constructs the OB3-shaped W3C VC payload; `issueCourseCompletionCredential()` signs with `issueDataIntegrityProof` from the substrate and publishes to the learner's pod via the substrate's `publish()` — running a `verifyDataIntegrityProof()` self-check first so a misconfigured issuer never leaves a bad credential.
- [`applications/foxxi-content-intelligence/src/clr.ts`](applications/foxxi-content-intelligence/src/clr.ts) — `exportClr(config)` walks the learner's pod via `discover()` filtered on `dct:conformsTo=fxa:CourseCompletionCredential` (+ `fxa:CompetencyAssertion`), fetches each graph, parses the embedded VC out of the `fxs:bundleJson` base64 literal, verifies each `DataIntegrityProof`, cross-checks `credentialSubject.id === holderDid` (defends against an attacker writing someone else's credential to the pod), and emits a 1EdTech CLR 2.0-shaped JSON envelope.
- [`applications/foxxi-content-intelligence/src/case-exporter.ts`](applications/foxxi-content-intelligence/src/case-exporter.ts) — `frameworkToCase(framework)` maps `fxk:SkillFramework` + `fxk:Skill` (with optional `rcd:` proficiency) to `CFDocument` / `CFItem` / `CFAssociation` / `CFRubric` per CASE 1.0. Sets the proper CASE `@context`; emits one rubric per framework when any skill carries an RDCEO `proficiencyLevel`.

### NEW bridge affordances

| Affordance | Description |
|---|---|
| `foxxi.issue_completion_credential` (admin-only) | Mint a signed OB3 VC, publish to learner's pod. Args: `learner_did`, `learner_pod_url`, `course_id`, `course_title`, `course_description?`, `criterion_narrative?`, `aligned_skills?`, `evidence?`. AuthZ: admin role required (verified via the existing ABAC pipeline; access-decision trace emitted). |
| `foxxi.export_clr` | Aggregate the learner's wallet into a CLR 2.0 envelope. AuthZ: caller can export own CLR; admin can export any. |
| `foxxi.export_case_framework` (admin-only) | Export the tenant's competency framework as CASE 1.0 JSON-LD. |

### NEW bridge env

- `FOXXI_ISSUER_KEY_SEED` — required for credential issuance; same seed → same `did:key` issuer; persist this seed in the operator's secret manager (rotating the seed rotates the issuer DID, which requires a successor descriptor for continuity). Distinct from `FOXXI_ADMIN_KEY_SEED` (which is the X25519 decryption key for admin sections).
- `FOXXI_TENANT_PROFILE_DID` (optional, defaults to `FOXXI_AUTHORITATIVE_SOURCE`) — the tenant's OB3 Profile DID.
- `FOXXI_TENANT_PROFILE_NAME` (optional, defaults to `"Acme Training Co L&D"`) — human-readable issuer name.

### Foxxi vocab additions (in [`ns/foxxi-content-graph-v0.2.ttl`](applications/foxxi-content-intelligence/ns/foxxi-content-graph-v0.2.ttl))

- `fxa:CourseCompletionCredential` (subclass of `cgh:Credential`) — RDF type for the published credential descriptor
- `fxa:CompetencyAssertion` — RDF type for skill-mastery assertions (issued individually or aggregated into a CLR)
- `fxk:hasProficiencyLevel`, `fxk:caseFrameworkRef` — RDCEO + CASE binding properties on `fxk:Skill` / `fxk:SkillFramework`

### Bridge revision

- `interego-foxxi-bridge--0000004` (sha256:52f820ab…) — live at https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io

## 2026-05-17 — Foxxi: real AuthN + AuthZ + E2EE + ABAC (no shared-everything demo mode)

Closes the gap the previous deploys left wide open: every bridge call now
requires a real ECDSA-signed session token, admin-only sections are
end-to-end encrypted at rest on the pod, and per-call AuthZ filtering
respects the caller's role. No mock auth, no shared admin keys, no
hardcoded role tables — everything wired through substrate primitives.

**Live 6-case smoke (against the deployed bridge):**

| Case | Result |
|---|---|
| Anonymous (no bearer) | **denied** — "missing session token" |
| Joshua signs, asks about himself | **allow/learner** — 10 enrollments |
| Joshua signs, asks about Jordan | **forbidden** — "caller (role: learner) cannot query enrollments for ..." |
| Jordan (admin) signs, asks about Joshua | **allow/admin** — 10 enrollments |
| Forged signer claims Jordan's WebID | **denied** — "address 0x22C1... not in tenant directory" |
| Joshua asks Golf Explained question | **6 seeds, 5 cited slides** |

### Architecture

**Auth (ECDSA session tokens):**
- [`applications/foxxi-content-intelligence/src/auth.ts`](applications/foxxi-content-intelligence/src/auth.ts) — isomorphic (browser + node) signing helpers built on `ethers`. `deriveUserWallet(userId, seed)` produces a deterministic secp256k1 keypair per user, `mintSessionToken({userId, webId, ttlMs})` signs a canonical message `Foxxi session\n  sub:.\n  iat:.\n  exp:.\n  nonce:.` and returns a base64url token, `verifySessionToken(token, addressMap)` recovers the signer and resolves to the directory entry. The bearer-token format is plain JSON (no JWT lib) — `{sub, iat, exp, nonce, address, sig}`.
- Demo wallets derive from the configured seed; production swaps `deriveUserWallet` for the substrate's real auth flow (`auth-methods.jsonld` lookups, SIWE, WebAuthn) without touching the verifier.

**E2EE at publish time:**
- [`tenant-publisher.ts`](applications/foxxi-content-intelligence/src/tenant-publisher.ts) classifies five sections as admin-only (`TenantDirectory`, `AssignmentPolicySet`, `ConnectorRegistry`, `EnrollmentEventStream`, `AuditLogStream`) and encrypts their graph bodies to the admin's X25519 public key via the substrate's existing `publish(..., {encrypt: {recipients, senderKeyPair}})` path. Pod stores ciphertext (`.envelope.jose.json`); descriptor metadata stays plaintext so `discover()` still finds them without a key.
- The admin keypair derives deterministically from `FOXXI_ADMIN_KEY_SEED` (same seed → same keys; bridge + CLI use the same derivation). The admin's public key also gets published as a discoverable `fxs:AdminEncryptionKey` descriptor so any agent can verify "I'm about to encrypt to this key — is this the admin the tenant declares?"
- Anonymous fetch of an admin section: bridge gets `{content: null, encrypted: true}` from `fetchGraphContent` and throws `"is encrypted and bridge has no recipient key"`. Verified live.

**AuthZ (role-resolved filtering):**
- [`policy.ts`](applications/foxxi-content-intelligence/src/policy.ts) resolves caller role from directory (admin if `caller.webId === FOXXI_ADMIN_WEB_ID`, manager if any user lists caller as `manager_user_id`, else learner). Per-section filters trim responses: `filterEnrollmentEvents` (self + direct reports), `filterAuditEntries` (self + reports + entries targeting them), `filterPolicies` (only those targeting the caller's audience tags + groups), `filterUsers`, `filterGroups`, `filterConnections` (admin-only), `filterCoverage` (admin-only).
- `emitAccessDecision` produces an `fxa:AccessDecision` trace descriptor on every call — name of the tool, caller WebID, resolved role, decision (`allow` / `allow-filtered` / `deny`), and which policy applied. Returned alongside the result.

**Bridge wiring:**
- [`bridge/server.ts`](applications/foxxi-content-intelligence/bridge/server.ts) gains an auth middleware that extracts `Authorization: Bearer <token>` from the request, injects it into the JSON-RPC `params.arguments` as `__caller_token` for tools/call dispatch. `resolveCaller(args)` then fetches the (decrypted) directory, builds the address-map via `auth.buildAddressMap(users)`, verifies the token, and constructs a `CallerContext`.
- Every handler that touches user data calls `resolveCaller()` first. `foxxi.discover_assigned_courses` checks `caller can query this learner_did` and 403s otherwise; `foxxi.retrieve_course_context` and `foxxi.ask_course_question_agentic` require any authenticated caller and bind `learner_did` to the verified WebID (rejecting any spoofed value in args).

**ABAC policy descriptors (substrate-pure declaration):**
- Three policies published as `fxa:AbacPolicy` descriptors: `admin-full-access`, `manager-direct-reports`, `learner-self`. Each declares its role, the sections it can read, and the scoping rule. The bridge's `policy.ts` is the enforcer; the published descriptors are the auditor's authoritative declaration of what access decisions are baked in. Regulators / auditors can `cg:discover()` filtered on `dct:conformsTo=fxa:AbacPolicy` to verify the policy set without reading the bridge code.

**Tenant directory carries wallet addresses:**
- `publishTenantDirectory(...)` calls `attachDeterministicAddresses(users, walletSeed)` before publishing so each user record carries a `wallet_address` field. The bridge uses this map to verify incoming tokens. Since the directory itself is admin-encrypted, wallet addresses aren't publicly leaked — only the bridge (which holds the admin keypair) can build the address-map.

**Dashboard:**
- [`dashboard-app/src/auth/session.ts`](applications/foxxi-content-intelligence/dashboard-app/src/auth/session.ts) `sessionFromOption(opt, role, podUrl)` is now async — mints an 8h bearer token at login time via `mintSessionToken`. `FoxxiSession` gains `userId`, `bearerToken`, `bearerExpiresAt`.
- [`dashboard-app/src/interego/client.ts`](applications/foxxi-content-intelligence/dashboard-app/src/interego/client.ts) `callTool` reads `bearerToken` from localStorage per-call and attaches `Authorization: Bearer <token>` on every bridge request.
- Auth.ts is shared between dashboard and bridge — same signing/verification module, same wallet derivation, no parallel implementations to drift.

**Operator setup (live):**

```bash
FOXXI_TENANT_POD_URL=https://interego-css.../markj/ \
FOXXI_AUTHORITATIVE_SOURCE=did:web:acme-training.example \
FOXXI_ADMIN_WEB_ID="https://id.acme-training.example/admin/profile#me" \
FOXXI_ADMIN_KEY_SEED=acme-training-admin-2026-demo-v1 \
npx tsx applications/foxxi-content-intelligence/tools/publish-tenant.ts
# cleans foxxi/ container, publishes:
#   - adminKey (plaintext)
#   - catalog (plaintext)
#   - directory (E2EE to admin)
#   - policies (E2EE to admin)
#   - connectors (E2EE to admin)
#   - events (E2EE to admin)
#   - audit (E2EE to admin)
#   - 3 ABAC policy descriptors (plaintext)
#   - golf-explained + golf-fundamentals course bundles (plaintext)
```

Bridge container app gets the same `FOXXI_ADMIN_WEB_ID` + `FOXXI_ADMIN_KEY_SEED` env vars so it derives the matching X25519 keypair for decryption and the matching admin WebID for role elevation. `FOXXI_REQUIRE_AUTH=true` rejects unauthenticated calls.

Live deployments:
- Bridge: `interego-foxxi-bridge--0000003` (sha256:ab4b4971…)
- Dashboard: `interego-foxxi-dashboard--0000004` (sha256:4187a808…)

## 2026-05-17 — Foxxi: tenant-pod walk (bridge fetches via substrate discover, no inline data)

Closes the gap that made the deployed bridge useless to outside MCP
clients: handlers no longer require the caller to ship the entire
admin payload + course content inline. Given just `learner_did`
(and the env-set tenant pod URL), the bridge walks the pod via the
substrate's standard `discover()` machinery, fetches the sections it
needs, and composes them into the shape the existing
enrollment/coverage/Q&A handlers expect.

**Emergent — no hardcoded paths.** The bridge knows only its own
type IRIs (`fxs:CourseCatalog`, `fxs:TenantDirectory`,
`fxs:AssignmentPolicySet`, `fxs:ConnectorRegistry`,
`fxa:EnrollmentEventStream`, `fxa:AuditLogStream`,
`fxa:CoursePackageBundle`). It filters discover-returned manifest
entries by `dct:conformsTo` matching those IRIs, follows the
descriptor's `cg:affordance hydra:target` link to find the graph,
and pulls the payload from a `fxs:bundleJson` literal. The pod
operator can move files freely — only the type contract is stable.

**Substrate-pure — no new substrate primitives.** Everything uses
the existing `publish() / discover() / fetchGraphContent()` API
surface. The vertical's only contribution is its own type-IRI
vocabulary in `applications/foxxi-content-intelligence/ns/foxxi-content-graph-v0.2.ttl`
(extended with the seven types above + the `fxs:bundleJson`
datatype property as a pragmatic JSON-in-RDF carrier).

NEW vertical files:

- [`applications/foxxi-content-intelligence/src/tenant-publisher.ts`](applications/foxxi-content-intelligence/src/tenant-publisher.ts) —
  publishes each section of a tenant snapshot as a separate
  `cg:ContextDescriptor` + graph pair. Each descriptor carries a
  Provenance facet `wasAttributedTo` the authoritative source DID +
  a Temporal facet `validFrom` + a Semiotic facet `modalStatus:
  Asserted`. The graph contains one `fxs:bundleJson` literal with
  the section's payload base64-encoded (avoids Turtle string-escape
  round-trip brittleness). Exports `publishCourseCatalog`,
  `publishTenantDirectory`, `publishAssignmentPolicies`,
  `publishConnectorRegistry`, `publishEnrollmentEventStream`,
  `publishAuditLog`, `publishCoursePackage`, `publishTenantSnapshot`.

- [`applications/foxxi-content-intelligence/src/tenant-fetcher.ts`](applications/foxxi-content-intelligence/src/tenant-fetcher.ts) —
  bridge-side companion. `fetchAdminPayload(config)` walks the pod
  via `discover()`, filters by every required `conformsTo` type in
  parallel, fetches each graph via the descriptor's
  `hydra:target` (no hardcoded URL construction), base64-decodes
  the bundleJson, and composes a FoxxiAdminPayload-shaped object.
  60-second LRU cache to avoid re-walking on hot paths;
  `invalidateTenantCache(podUrl?)` for forced refresh.
  `fetchCoursePackage(courseId, config)` is the same pattern
  filtered to `fxa:CoursePackageBundle` + graph IRI ending in
  `:course:<courseId>`.

- [`applications/foxxi-content-intelligence/tools/publish-tenant.ts`](applications/foxxi-content-intelligence/tools/publish-tenant.ts) —
  one-time CLI that loads the bundled `imported/admin_payload.json`
  + every `*dashboard_data*.json` and calls the publishers. Cleans
  the foxxi/ container + manifest first (substrate `publish()`
  enforces If-None-Match: * so writes against existing resources
  silently 412; cleaning sidesteps that for the demo re-seed flow).
  Honors `POD_BEARER` env for authenticated fetch; falls back to
  anonymous (works on the demo CSS pod which has open ACL).

UPDATED:

- [`applications/foxxi-content-intelligence/bridge/server.ts`](applications/foxxi-content-intelligence/bridge/server.ts) —
  `foxxi.discover_assigned_courses`, `foxxi.ask_course_question_agentic`,
  and `foxxi.retrieve_course_context` handlers now call
  `autoFetchAdmin(args)` / `autoFetchCourse(args, courseId)` when
  their inline payload arg is missing. Auto-fetch returns null on
  error (caught), letting the existing stub-note response surface
  when the pod isn't seeded — backwards compatible with callers that
  still ship inline data.

- [`applications/foxxi-content-intelligence/ns/foxxi-content-graph-v0.2.ttl`](applications/foxxi-content-intelligence/ns/foxxi-content-graph-v0.2.ttl) —
  added `fxs:CourseCatalog`, `fxs:TenantDirectory`,
  `fxs:AssignmentPolicySet`, `fxs:ConnectorRegistry`,
  `fxa:EnrollmentEventStream`, `fxa:AuditLogStream`,
  `fxa:CoursePackageBundle`, `fxs:bundleJson` declarations.

**Live demo seeded:**

```
$ FOXXI_TENANT_POD_URL=https://interego-css.../markj/ \
  FOXXI_AUTHORITATIVE_SOURCE=did:web:acme-training.example \
  npx tsx applications/foxxi-content-intelligence/tools/publish-tenant.ts
cleaning old resources… 16 stale resources deleted + manifest cleared.
publishing tenant snapshot…
  catalog     → …/markj/foxxi/course-catalog.ttl
  directory   → …/markj/foxxi/tenant-directory.ttl
  policies    → …/markj/foxxi/assignment-policies.ttl
  connectors  → …/markj/foxxi/connector-registry.ttl
  events      → …/markj/foxxi/enrollment-events.ttl
  audit       → …/markj/foxxi/audit-log.ttl
publishing 4 course packages…
  golf-explained     → …/markj/foxxi/course-golf-explained.ttl
  golf-fundamentals     → …/markj/foxxi/course-golf-fundamentals.ttl
done.
```

**Live end-to-end smoke from any MCP client (no inline data):**

```bash
curl -X POST -d '{
  "jsonrpc":"2.0","id":1,"method":"tools/call",
  "params":{
    "name":"foxxi.discover_assigned_courses",
    "arguments":{"learner_did":"https://id.acme-training.example/jliu/profile#me"}
  }
}' https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp
# → learnerName: Joshua Liu, audienceTags: [engineering, all-employees],
#   10 enrollments (Phishing Awareness completed, industry onboarding standard overdue,
#   Golf Explained completed, …)

curl -X POST -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/call",
  "params":{
    "name":"foxxi.retrieve_course_context",
    "arguments":{
      "learner_did":"https://id.acme-training.example/jliu/profile#me",
      "question":"what is handicap?",
      "course_id":"golf-explained"
    }
  }
}' https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp
# → 6 seed concepts (current, handicap, score differential, …),
#   16 expanded, 5 cited slides, 2-step Interego trace
#   (LearnerQuestionEvent Asserted → RetrievalActivity Hypothetical).
```

Bridge image: `interego-foxxi-bridge@sha256:931ab8c5…`, container app
revision `interego-foxxi-bridge--0000002` (100% traffic).

## 2026-05-17 — Foxxi dashboard: feature parity with imported originals

Refactor pass to bring the deployed Vite + React dashboard up to the
feature surface of the original `imported/foxxi_admin_v01.jsx` +
`imported/foxxi_dashboard_v03.jsx` single-file React apps. The originals
had inlined `RAW_DATA` blobs at the top + a mocked login + no build
tooling; the refactor preserved the UX intent but had quietly dropped
several admin tabs and the entire learner slide-navigator surface
because the initial focus was wiring the bridge transport. This pass
adds them back, backed by the same bundled sample data.

Also removes the `mcp-client` LLM mode from the dashboard's settings
dialog — the human-mediated copy-paste handoff between the dashboard
and the user's own agent session was clunky enough to be worse than
just using `bridge-env` or `byok` here. The substrate primitive
`foxxi.retrieve_course_context` is unchanged — it's still the right
tool for agent-native MCP callers (Claude Code, Cursor, etc.) calling
the bridge directly without a key. It just isn't a sensible UI option
in a browser SPA.

NEW in [`applications/foxxi-content-intelligence/dashboard-app/`](applications/foxxi-content-intelligence/dashboard-app/):

**Admin shell ([`src/components/AdminShell.tsx`](applications/foxxi-content-intelligence/dashboard-app/src/components/AdminShell.tsx)):**
- Two new top-level tabs — **Access** (users + groups with audience-tag
  membership + manager hierarchy; click any user or group to open a
  detail modal showing WebID, audience tags, group memberships, and
  policies targeting that group) and **Integrations** (LMS / downstream
  connector cards with status pill, last sync, sync frequency, courses
  contributed, and auth warnings).
- **Catalog** tab gains a free-text search (title / category / owner /
  audience tag / LMS source) and a parsed-vs-LMS-stub filter; shows
  owner + parse date + LMS source per entry.
- **Audit log** tab gains actor-search, action-dropdown, and
  allowed/denied filters; each row now carries framework-citation pills
  (SOC2 / EU AI Act / NIST RMF) derived from the action prefix —
  walking the same naming convention the compliance-overlay
  (integrations/compliance-overlay/) uses internally.

**Learner shell:**
- New [`src/components/SlideNavigator.tsx`](applications/foxxi-content-intelligence/dashboard-app/src/components/SlideNavigator.tsx) — scene-by-scene + slide-by-slide
  browser for the parsed course. Each slide detail shows: audio segments
  with per-segment duration + transcript, concepts taught (clickable
  pills), and prereq edges (in + out). Clicking a prereq edge jumps to
  the first slide that teaches the dependency concept. Clicking a
  concept opens a modal with the concept's tier + confidence + frequency,
  every slide that teaches it, every slide that mentions it without
  declaring it, the concepts it depends on, and the concepts that depend
  on it.
- Course header now shows package metadata (authoring tool, standard,
  parser version) when present.

**Types + sample:**
- [`src/types.ts`](applications/foxxi-content-intelligence/dashboard-app/src/types.ts) extends `CourseContent`
  with `scenes`, `slides`, `prereqEdges`, `packageMeta` from the parsed
  `dashboard_data.json`. New `CourseScene` / `CourseSlide` /
  `CourseSlideTranscriptSegment` / `CoursePrereqEdge` / `CoursePackageMeta`
  types.
- [`src/sample/data.ts`](applications/foxxi-content-intelligence/dashboard-app/src/sample/data.ts) now exposes the full
  parsed structure (12 slides across 2 scenes, 92 concepts, 299 prereq
  edges for Golf Explained) instead of just the concepts
  list.

**App chrome:**
- New `Footer` in [`src/App.tsx`](applications/foxxi-content-intelligence/dashboard-app/src/App.tsx) showing
  tenant + tenant_id + signed-in WebID + role + transport mode + pod
  URL on every page (mirrors the originals' footer).

**LLM settings simplification:**
- [`src/auth/llm-settings.ts`](applications/foxxi-content-intelligence/dashboard-app/src/auth/llm-settings.ts):
  `LlmMode` shrunk from `'bridge-env' | 'byok' | 'mcp-client'` to
  `'bridge-env' | 'byok'`. Doc comment explains why mcp-client was
  dropped from the dashboard but kept as a substrate primitive for
  agent callers.
- [`src/components/LlmSettings.tsx`](applications/foxxi-content-intelligence/dashboard-app/src/components/LlmSettings.tsx):
  `MODE_INFO` drops the mcp-client entry + its warning panel.
- [`src/components/ChatPanel.tsx`](applications/foxxi-content-intelligence/dashboard-app/src/components/ChatPanel.tsx):
  drops the `McpClientHandoff` component, the `buildMcpClientPrompt`
  helper, and the `mode === 'mcp-client'` branches in the result-pill
  rendering + no-LLM-synthesis warning path. The chat panel always
  calls `foxxi.ask_course_question_agentic` now.
- [`src/interego/client.ts`](applications/foxxi-content-intelligence/dashboard-app/src/interego/client.ts):
  `LlmCallMode` matches the UI shrink; `askCourseQuestionAgentic`
  unconditionally calls the agentic tool. The substrate-side
  `'mcp-client'` value on `AgenticLlmKeySource` is preserved for the
  offline-sample fallback that mimics `foxxi.retrieve_course_context`.

**Live:**
- Same URL — https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io
- Rebuilt as `contextgraphsacr.azurecr.io/interego-foxxi-dashboard@sha256:8656af47…`
  (ACR run `cagu`) and rolled as Container App revision
  `interego-foxxi-dashboard--0000001` with 100% traffic. Type-check
  clean (`tsc --noEmit` exit 0).

---

## 2026-05-17 — Foxxi: live on Azure Container Apps (bridge + dashboard)

The Foxxi vertical now has a hosted deployment alongside the rest of
the Interego services. Two new Container Apps:

| Surface | URL | Image | Port |
|---|---|---|---|
| Foxxi vertical bridge (MCP `/mcp` + `/affordances` + REST) | https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io | `contextgraphsacr.azurecr.io/interego-foxxi-bridge:latest` (sha256:f773b612…) | 6080 |
| Foxxi dashboard (Vite + React SPA via nginx) | https://interego-foxxi-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io | `contextgraphsacr.azurecr.io/interego-foxxi-dashboard:latest` (sha256:7d7558a0…) | 8080 |

Built via `az acr build`; deployed into the existing
`context-graphs-env` Container Apps environment under
`context-graphs-rg` (eastus). Same naming convention as
`interego-css` / `interego-dashboard` / `interego-relay` /
`interego-pgsl-browser`.

NEW deployment artifacts:
- [`deploy/Dockerfile.foxxi-bridge`](deploy/Dockerfile.foxxi-bridge) —
  two-stage node:20-slim build that preserves the on-disk repo layout
  under `/app` so the bridge's relative imports (`../affordances.ts`,
  `../../../src/...`, `../../learner-performer-companion/src/grounded-answer.js`)
  work unchanged. `RUN npx tsc` compiles `@interego/core` once at
  build-time; runtime is `npx tsx applications/foxxi-content-intelligence/bridge/server.ts`.
  Bake-time env: `FOXXI_TENANT_POD_URL` (defaults to the
  `interego-css` pod), `FOXXI_AUTHORITATIVE_SOURCE`,
  `FOXXI_AUDIENCE=both`, `FOXXI_DASHBOARD_ORIGIN` (CORS allowed
  origin), `BRIDGE_DEPLOYMENT_URL` (self-URL the bridge advertises).
  Per-deployment overrides go via `--env-vars` on
  `az containerapp create`.
- [`deploy/Dockerfile.foxxi-dashboard`](deploy/Dockerfile.foxxi-dashboard) —
  two-stage: Vite builds the SPA with `VITE_FOXXI_BRIDGE_URL` baked
  in via `--build-arg`, then nginx:1.27-alpine serves
  `/usr/share/nginx/html` on port 8080 with SPA-style fallback to
  `/index.html` and long-cache headers on `/assets/`.

CORS is owned vertical-side via the bridge's `middleware` hook (the
substrate `applications/_shared/vertical-bridge/` stays
CORS-agnostic per [`docs/DEPLOYMENT-SPLIT.md`](docs/DEPLOYMENT-SPLIT.md)
discipline). Live preflight from the dashboard origin returns 204
with `access-control-allow-origin` echoing back exactly the
dashboard FQDN — no wildcard.

Smoke-tested live (curl from outside Azure):
- `GET /affordances` returns the proper Turtle manifest with 13
  Foxxi affordances (`foxxi.discover_assigned_courses` /
  `consume_lesson` / `ask_course_question[_agentic]` /
  `retrieve_course_context` / `explore_concept_map` /
  `ingest_content_package` / `publish_authoring_policy` /
  `connect_lms` / `assign_audience` / `coverage_query` /
  `publish_concept_map` / `publish_compliance_evidence`).
- `POST /mcp` with `{method: 'tools/list'}` returns the
  derived MCP tool schemas (foxxi.* with full inputSchema).
- Dashboard `/` returns the SPA shell.

Operational note: the 5 historical recursive Windows junctions in
`{demos,deploy/mcp-relay,examples/dashboard,examples/personal-bridge,examples/pgsl-browser}/node_modules/@interego/core`
(npm-install artifacts pointing back to the repo root via the
`file:../../../` self-dep) were removed before the build —
`az acr build`'s Windows context-upload walker follows junctions
before `.dockerignore` is applied and would otherwise loop forever.

No code change required for the substrate or vertical sources;
existing local-dev `npm run dev` still works the same way against
`http://localhost:6080` / `http://localhost:5173`.

## 2026-05-17 — Foxxi: three LLM architectures (mcp-client-as-LLM, BYOK, bridge-env)

Adds two more LLM-key paths so users aren't forced into either "the
bridge has a key" or "no LLM at all." Three architectures now, all
routed through the same substrate primitives:

| Mode | Who pays | Key location | Tool |
|---|---|---|---|
| `bridge-env` | Tenant op | `FOXXI_LLM_API_KEY` env | `foxxi.ask_course_question_agentic` |
| `byok` | End user | Per-request `llm_api_key` (browser localStorage → bridge transient) | `foxxi.ask_course_question_agentic` |
| `mcp-client` | End user's existing agent subscription | NO API key anywhere | `foxxi.retrieve_course_context` |

The `mcp-client` mode is the answer to "I'm already using Interego in
my own Claude/Cursor/Codex agent — can the Foxxi dashboard use THAT
LLM instead of needing its own key?" Yes: the dashboard's chat panel
calls the retrieval-only tool, gets back the federated concept graph +
verbatim cited transcripts, and offers a "Copy structured prompt"
button so you paste it into your existing agent session. The agent
synthesises the answer using its existing subscription. The
substrate's Interego trace records `keySource: 'mcp-client'` so the
audit chain is honest about who paid for the inference.

NEW substrate-side in [`applications/foxxi-content-intelligence/src/agentic-rag.ts`](applications/foxxi-content-intelligence/src/agentic-rag.ts):
- `retrieveCourseContext({question, learnerDid, primary, federation})`
  — pure retrieval path. Emits 2-step trace
  (`fxa:LearnerQuestionEvent` Asserted + `fxa:RetrievalActivity`
  Hypothetical). Caller's agent synthesises and optionally publishes
  its own `fxa:CitedAnswer` to close the chain.
- `LlmKeySource` type added: `'none' | 'bridge-env' | 'per-request-byok' | 'mcp-client'`.
- `askAgenticRag` now accepts `llmKeySource?: LlmKeySource` and records
  it on the result + on the `fxa:LlmCompletion` descriptor's
  `body.keySource`. Defaults to `'bridge-env'` when a key is supplied
  without explicit source, `'none'` when no key at all.

NEW bridge-side:
- `foxxi.retrieve_course_context` affordance + handler.
- `foxxi.ask_course_question_agentic` handler accepts `llm_api_key`
  per-request arg. Key precedence: per-request BYOK > server-side env
  (`FOXXI_LLM_API_KEY` / `ANTHROPIC_API_KEY`). Bridge uses the key
  transiently for the one outbound Anthropic call; never persists or
  logs it.

NEW dashboard-side in [`applications/foxxi-content-intelligence/dashboard-app/`](applications/foxxi-content-intelligence/dashboard-app/):
- `src/auth/llm-settings.ts` — load/save/clear LLM mode + BYOK key.
  Stored in browser localStorage; key is stripped when mode changes
  away from byok.
- `src/components/LlmSettings.tsx` — three-mode selector dialog with
  per-mode explanation (who pays / where the key lives / which tool
  is called) + masked password input for BYOK + warning panel for
  mcp-client mode.
- `src/components/ChatPanel.tsx` — `LLM ⚙` button opens the dialog;
  the active mode is shown as a header pill; each turn's response
  surfaces the `keySource` pill so the user sees which path actually
  ran. New `McpClientHandoff` component in mcp-client mode that
  generates a structured prompt (question + seed concepts + verbatim
  cited transcripts) ready to paste into any agent session, with
  Copy buttons for the full prompt OR the cited transcripts only.
- `src/interego/client.ts` — `askCourseQuestionAgentic` gains
  `mode: 'bridge-env' | 'byok' | 'mcp-client'` + `byokKey` args.
  Routes to `foxxi.retrieve_course_context` when `mode === 'mcp-client'`,
  otherwise sends `llm_api_key` in the request body when `mode === 'byok'`.
  Offline-sample mode adopts the appropriate `llmKeySource`.

4 new contract tests in [`tests/agentic-rag.test.ts`](applications/foxxi-content-intelligence/tests/agentic-rag.test.ts)
(12 total in that file now; 32 total in the vertical):
- `mode=none` → `llmKeySource: 'none'`, 2-step trace
- `mode=bridge-env` (mocked LLM) → `llmKeySource: 'bridge-env'` on
  result + on LLM descriptor body
- `mode=per-request-byok` (mocked LLM, explicit source) →
  `llmKeySource: 'per-request-byok'`
- `retrieveCourseContext` → no LLM call, `llmKeySource: 'mcp-client'`,
  `llmModel: 'mcp-client-as-llm'`, 2-step trace with seeds + cited
  slides

Live MCP smoke against the bridge for all three architectures:
- `tools/list` returns 13 tools (was 12; +1 for `foxxi.retrieve_course_context`)
- `foxxi.retrieve_course_context` for "what is handicap?"
  with full federation payload returns retrievalKind=graph, 6 seeds,
  16 expanded, 5 cited slides spanning golf-explained+golf-fundamentals,
  `llmKeySource: 'mcp-client'`, 2-step trace
- `foxxi.ask_course_question_agentic` with `llm_api_key: 'sk-ant-invalid-test-key-from-dashboard'`
  returns `llmKeySource: 'per-request-byok'`, the key actually reached
  Anthropic (proven by the response: `Anthropic API 401: invalid x-api-key`),
  honest error message bubbled back, full 4-step trace with
  `body.keySource: 'per-request-byok'` on the LlmCompletion descriptor

Why this matters: the dashboard now ships with a clean
"bring-your-existing-agent" path that doesn't require either the
bridge operator to provide an API key OR the end user to paste one.
Anyone who's already using Interego from Claude Code (the user's
described pattern) can switch the dashboard to `mcp-client` mode and
copy the substrate-retrieved prompt straight into their existing
session — Interego is the substrate, their agent is the LLM, no new
auth setup.

Repo tsc: clean. Dashboard tsc + Vite build: clean. Vertical tests:
32/32 passing (11 affordance + 9 learner-flow + 12 agentic-rag).

---

## 2026-05-17 — Foxxi: agentic RAG (replaces lexical Q&A in the dashboard)

The prior commit's dashboard used `foxxi.ask_course_question` (lexical
overlap via LPC's `groundedAnswer`). The original
`imported/foxxi_dashboard_v03.jsx` had actual agentic RAG (concept-
graph retrieval + prereq-edge expansion + federation + Claude
synthesis). This commit ports that retrieval pipeline to TypeScript,
wires it through Interego, and routes the dashboard's chat to it.

**New: [`applications/foxxi-content-intelligence/src/agentic-rag.ts`](applications/foxxi-content-intelligence/src/agentic-rag.ts)**
- `findRelevantConcepts(question, courses, topK)` — federated concept-
  graph search; score by exact match (5pt) + substring (2pt) + reverse
  substring (1pt); free-standing bonus.
- `expandConceptNeighborhood(seeds, depth)` — walks modifier-of pairs
  + prereq edges one hop within each seed's home course; gathers slide
  candidates from every expanded concept's `taught_in_slides`.
- `allocateCitedSlides(primary, candidates, cap)` — round-robin slide
  allocation so peer-course slides survive the citation cap even when
  the primary has many matches.
- `buildGraphContext({question, primary, federation, …})` — orchestrates
  the three steps + fallback (first 3 narrated slides of primary when
  no concepts match).
- `askAgenticRag({question, learnerDid, primary, federation, history,
  llmApiKey, …})` — full agentic loop: retrieval → optional Anthropic
  messages API call → emit Interego trace.
- `payloadToAgenticCourse` + `courseContentToAgenticCourse` — adapters
  from the parser's federation_payload shape (or LPC's
  FoxxiCourseContent) into the agentic-rag course shape.

**Interego trace** — every step of the agent loop is a typed
descriptor blueprint with proper modal status + provenance chain:

  `fxa:LearnerQuestionEvent`   Asserted     (the question itself)
  `fxa:RetrievalActivity`      Hypothetical (seeds + expansion + slides)
                               wasDerivedFrom: [question]
  `fxa:LlmCompletion`          Hypothetical (the LLM's raw response)
                               wasDerivedFrom: [retrieval]
  `fxa:CitedAnswer`            Asserted     (the final cited answer)
                               wasDerivedFrom: [llm, retrieval, question]
                               cg:supersedes  → llm

The auditor can walk the chain from the final answer back to the
original question. The trace descriptors are returned as data on the
response; production callers publish them to the tenant pod via the
standard `publish()` flow.

**LLM is pluggable.** With `FOXXI_LLM_API_KEY` (or `ANTHROPIC_API_KEY`)
configured server-side on the bridge, the substrate calls Anthropic's
messages API (`claude-sonnet-4-5` default; configurable via
`llm_model` arg). Without a key, retrieval scaffold + descriptor
trace ship alone — the dashboard renders cited slide transcripts
verbatim from the bridge response, so the learner still gets a useful
answer (just without LLM prose synthesis on top).

**New affordance** `foxxi.ask_course_question_agentic` declared in
[`affordances.ts`](applications/foxxi-content-intelligence/affordances.ts)
(12 total now — 4 learner + 8 admin). Bridge handler accepts either
the rich `FoxxiAgenticPayload` shape (with slides + prereq edges) or
the simpler `FoxxiCourseContent` (transcripts + concepts; auto-adapted
via `courseContentToAgenticCourse`).

**Dashboard wired** — [`dashboard-app/src/components/ChatPanel.tsx`](applications/foxxi-content-intelligence/dashboard-app/src/components/ChatPanel.tsx)
replaced. Routes to the agentic endpoint, renders:
- Synthesized prose (when LLM is configured)
- "no llm synthesis" pill + cited transcripts (when LLM isn't)
- Retrieval breadcrumbs: seed concepts (with scores + course
  attribution), cited slides (verbatim transcripts, expandable)
- The full Interego trace: each descriptor with its IRI, modal-status
  pill, `prov:wasDerivedFrom` chain, and `cg:supersedes` arrow
- Multi-turn history with prior-turn replay into `history` arg

Dashboard's [`interego/client.ts`](applications/foxxi-content-intelligence/dashboard-app/src/interego/client.ts)
gained `askCourseQuestionAgentic` typed wrapper + offline-mode synthesis
of the agentic call shape (so the dashboard's offline-sample mode
exercises the same UX without the bridge).

**8 new contract tests** in [`tests/agentic-rag.test.ts`](applications/foxxi-content-intelligence/tests/agentic-rag.test.ts):
- `buildGraphContext` against real `federation_payload.json`: seed
  matching for "handicap" finds primary-course concepts;
  cross-course "golf voltage current control" matches both
  lessons; truly off-topic question falls back; round-robin
  allocation respects primary-priority + slide cap
- `askAgenticRag` end-to-end:
  - no-LLM path: 2-step trace (question + retrieval)
  - mocked-LLM path: full 4-step trace, citedAnswer supersedes
    llmCompletion, wasDerivedFrom chains correctly
  - LLM failure path: honest error annotation + still 4-step trace
- `courseContentToAgenticCourse` adapter test (synthesizes slides
  from transcripts, computes taught_in_slides via label inclusion)

**Live MCP smoke** (bridge :6080):
- `tools/list` returns 12 tools incl. `foxxi.ask_course_question_agentic`
- Browser-origin `POST /mcp tools/call` with the full
  `federation_payload.json` (primary golf-explained + 1 federation peer
  golf-fundamentals) + question "what is handicap?" returns:
  - retrievalKind: graph
  - 6 seed concepts (top: "handicap" score 4.0 from Golf Explained)
  - 16 expanded concepts (after prereq + modifier-of edge expansion)
  - 5 cited slides spanning golf-explained AND golf-fundamentals (federation works)
  - contributingCourseIds: ['golf-explained', 'golf-fundamentals']
  - 2-step Interego trace (Asserted question + Hypothetical retrieval;
    full 4-step trace with the LLM key configured)

**Honest framing on what changed**: the keyword-overlap I shipped in
the prior commit composed LPC's `groundedAnswer` — which gave me the
honest-citation discipline but was strictly inferior to the prior
React app's agentic RAG. This commit catches up: same agentic
retrieval, now wired through Interego at every layer (substrate
primitive → bridge affordance → dashboard UI → descriptor trace).

---

## 2026-05-16 — Foxxi: browser dashboard refactored onto Interego

Refactors the standalone `foxxi_admin_v01.jsx` (2.4k LOC) + `foxxi_dashboard_v03.jsx`
(1.9k LOC) single-file React apps into a substrate-grounded Vite + React app
at [`applications/foxxi-content-intelligence/dashboard-app/`](applications/foxxi-content-intelligence/dashboard-app/).
The originals had inlined `RAW_DATA` JSON blobs and mock auth; the
refactor sources everything through the Foxxi vertical bridge.

**Files added** under `dashboard-app/`:
- `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` —
  Vite 6 + React 18 + TypeScript scaffold
- `src/main.tsx`, `src/App.tsx` — entry + role-routed shell
- `src/types.ts` — shared types mirroring the substrate-side
  enrollment + course-content shapes
- `src/sample/data.ts` — bundles the imported Acme Training Co admin
  payload + golf-explained transcripts + dashboard concepts as build-time
  JSON so the app works offline
- `src/interego/client.ts` — the new data layer:
  - Auto-probes the bridge at `${VITE_FOXXI_BRIDGE_URL}/affordances`
    (default `http://localhost:6080`). If reachable, every affordance
    call is a JSON-RPC `tools/call` against `/mcp`.
  - If unreachable, falls back to in-process synthesis using the
    bundled sample data — same call shape, dashboard works without
    the bridge.
  - Typed wrappers: `discoverAssignedCourses`, `askCourseQuestion`,
    `coverageQuery`.
- `src/auth/session.ts` — identity selector (admin = Jordan Doe;
  learners = curated picks from the Acme Training Co roster, prioritising
  audience-tag diversity). Selected `webId` becomes the `learner_did`
  on every affordance call.
- `src/components/`:
  - `common.tsx` — `Card`, `Pill`, `Button`, `TextInput`, `Header`
  - `Login.tsx` — role + identity selector
  - `LearnerShell.tsx` — enrolled-courses list + course detail view
  - `ChatPanel.tsx` — Q&A panel wired to `foxxi.ask_course_question`,
    renders verbatim citations + honest no-match indicator
  - `AdminShell.tsx` — tabs for catalog / policies / coverage / audit;
    coverage tab runs `foxxi.coverage_query` at all three privacy modes
- `README.md` — run instructions, old-vs-new mapping, substrate
  composition map
- `.gitignore` — node_modules, dist, logs

**CORS** added to the Foxxi bridge at `bridge/server.ts` via the
substrate-side vertical-bridge factory's `middleware` hook. The
substrate-side factory stays CORS-agnostic (server-to-server +
MCP-client deployments shouldn't be forced to declare an origin); the
vertical owns its own CORS policy. Configurable via
`FOXXI_DASHBOARD_ORIGIN` (default `http://localhost:5173`).

**Live verification done** (bridge on `:6080` + dashboard on `:5173`):
- CORS preflight passes (`OPTIONS /mcp` returns 204 with correct headers)
- `GET /affordances` from browser origin returns the Turtle manifest
- Browser-simulated `POST /mcp tools/call` for `foxxi.discover_assigned_courses`
  with Joshua Liu's webId returns 10 enrollments including Golf Explained
  (required, completed 2026-01-02)
- Browser-simulated `POST /mcp tools/call` for `foxxi.ask_course_question`
  "what is handicap?" returns 20 verbatim citations, first one
  starting "Golf voltage is controlled through handicap..."

**Architectural discipline maintained**:
- `mcp-server/` and `deploy/mcp-relay/` got 0 lines of new code
- The substrate-side vertical-bridge factory stays CORS-agnostic
- CORS lives in the foxxi bridge's middleware hook, owned by the vertical
- The dashboard is the third party that can drive the Foxxi vertical
  (after the contract tests + the live MCP smoke); a fourth party (any
  protocol-aware MCP agent walking `cg:Affordance` descriptors via Path A)
  works identically without any Foxxi-specific code

---

## 2026-05-16 — Foxxi content-intelligence vertical (third dual-audience pilot)

Integrates the Foxxi eLearning content-intelligence system (originally
built as standalone Python parsers + React dashboards + Foxximediums
TTLs) as a first-class Interego vertical at
[`applications/foxxi-content-intelligence/`](applications/foxxi-content-intelligence/).

**What landed**:
- [`applications/foxxi-content-intelligence/README.md`](applications/foxxi-content-intelligence/README.md)
  — full vertical description, three-stratum vocabulary table, dual-
  audience table, substrate-composition table.
- [`affordances.ts`](applications/foxxi-content-intelligence/affordances.ts)
  — 3 learner-side + 7 admin-side affordances, dual-audience split.
  Action IRIs follow `urn:cg:action:foxxi:<verb>`; tool names follow
  `foxxi.<verb>`.
- [`src/publisher.ts`](applications/foxxi-content-intelligence/src/publisher.ts)
  — substrate-side glue. `ingestContentPackage` emits three-stratum
  descriptors (fxs structural / fxk knowledge / fxa activity-schema),
  `publishAuthoringPolicy` declares accepted authoring tools +
  standards, `assignAudience` binds courses to audience groups via
  policy descriptors, `coverageQuery` composes the existing
  aggregate-privacy ladder (v2 merkle-attested-opt-in / v3
  zk-distribution histogram with per-bucket DP noise) for privacy-
  respecting cohort coverage analysis.
- [`bridge/server.ts`](applications/foxxi-content-intelligence/bridge/server.ts)
  — MCP-named-tool surface. Supports `FOXXI_AUDIENCE=learner|admin|both`
  split per [`docs/DEPLOYMENT-SPLIT.md`](docs/DEPLOYMENT-SPLIT.md).
- [`ns/`](applications/foxxi-content-intelligence/ns/) — the
  Foxximediums three-stratum vocabulary (fxs/fxk/fxa) preserved
  as vertical-scoped TTLs.
- [`imported/`](applications/foxxi-content-intelligence/imported/) —
  authoritative Foxxi system files preserved as-is: Python parsers
  (v0.1 / v0.2 / v0.3 with Whisper transcription + concept
  morphology + Peircean Sign/Object/Interpretant tagging), dashboard
  builders, admin payload generators, React admin + dashboard UIs,
  sample Acme Training Co tenant data (183 employees, full L&D state),
  parsed lesson graphs (Golf Controls / Golf Basics).

**Composition with existing substrate**:
- SCORM unwrap → [`applications/_shared/scorm/`](applications/_shared/scorm/)
- xAPI projection of consumption events → [`applications/lrs-adapter/`](applications/lrs-adapter/)
- Coverage query without per-learner reveal → [`applications/_shared/aggregate-privacy/`](applications/_shared/aggregate-privacy/) v2 / v3 / v3-distribution
- Per-action audit + compliance citation → [`integrations/compliance-overlay/`](integrations/compliance-overlay/)
- LMS connectors (Cornerstone OnDemand, etc.) → [`src/connectors/`](src/connectors/)
- Federated multi-course catalog → [`hyprcat:`](docs/ns/hyprcat.ttl)

**Layering hygiene**: the `fxs:`/`fxk:`/`fxa:` prefixes are vertical-
scoped (NOT L1/L2/L3); the vertical MUST NOT propose changes to core
ontologies (per [`spec/LAYERS.md`](spec/LAYERS.md)) and doesn't —
every descriptor it emits uses standard core facets + composes
existing primitives.

11 new contract tests in [`applications/foxxi-content-intelligence/tests/foxxi.test.ts`](applications/foxxi-content-intelligence/tests/foxxi.test.ts):
- Affordance shape + naming convention enforcement
- Dual-audience disjointness (no overlap between learner + admin
  action IRIs)
- MCP-tool-schema derivation completeness for every affordance
- `coverageQuery` composition across all three privacy modes (abac
  plain count, merkle-attested-opt-in bundle verification, zk-
  distribution histogram with per-bucket counts validated)
- zk-distribution required-args throws (epsilon missing, edges
  missing)

Originating Claude chat session preserved at
`course/AI agent for LMS content consumption and knowledge graph
building - Claude.pdf` (in the harness root, outside the
context-graphs subproject).

---

## 2026-05-16 — Privacy accountants: advanced composition + Rényi-DP

Ships [`src/crypto/dp-accountant.ts`](src/crypto/dp-accountant.ts) — the
"substrate-level distribution-shaped cumulative-budget composition
theorems" layer. Tighter cumulative-ε tracking than the naive
sequential summation that `EpsilonBudget` ships today.

**The problem.** Under basic sequential composition, k mechanisms
each ε-DP give the joint mechanism k·ε-DP. This is worst-case tight
but pessimistic — running many small-ε queries quickly exhausts a
per-cohort cap even though the actual cumulative privacy loss is
much smaller.

**Two accountants.**

1. `AdvancedCompositionAccountant` — Dwork-Rothblum-Vadhan 2010.
   At each consume(), tracks the naive sum. On demand:
     ε' = √(2k ln(1/δ)) · ε_max + k · ε_max · (e^{ε_max} − 1)
   gives the tightened (ε', δ)-DP at the caller's chosen δ. For
   small ε this is roughly √k · ε rather than k · ε.

2. `RenyiAccountant` — Mironov 2017. Tracks Rényi divergence at a
   fixed order α. For pure-DP mechanisms:
     ρ_α ≤ (1/(α−1)) · log( α/(2α−1) · e^{(α−1)ε} + (α−1)/(2α−1) · e^{−αε} )
   Conversion at session close-out:
     ε = ρ + log(1/δ) / (α − 1)
   Helper `sweepRenyiBestEpsilon` runs the conversion across a grid
   of α's and picks the tightest. Tightest in most practical
   regimes.

**Common interface.** Both implement `PrivacyAccountant`:
`consume({queryDescription, epsilon})`, `canAfford(epsilon)`,
`spent`, `maxEpsilon`, `log`. The existing aggregate primitives'
`epsilonBudget?` slot can be widened to accept any accountant in a
follow-up wiring step; for now the accountants are usable directly
by the caller (compute the tighter ε' end-of-session; verify
against the cohort cap).

16 new contract tests in `tests/dp-accountant.test.ts`:
- AdvancedCompositionAccountant: naive-sum tracking, overflow throw,
  DRV closed-form match, smaller-than-naive for k=50 small queries,
  zero-queries returns 0, invalid-input throws
- RenyiAccountant: ρ-monotonicity in ε, ρ-positivity across α
  values, cumulative tracking + overflow throw, convertToEpsilonDelta
  formula match, canAfford honors maxRho, invalid-input throws
- sweepRenyiBestEpsilon: best-α selection at target δ, custom α
  grid, invalid-δ throw
- Headline: both tighter accountants beat naive sum for k=100
  small queries

Substrate-pure: no new crypto primitives, no new ontology terms.
Just the mathematical accounting layer the user asked about.

Tests: 1522/1522 passing (tsc clean).

---

## 2026-05-16 — v6 distributed values + distributed blindings (operator sees neither)

Doubles the v5 composition: contributors VSS-split BOTH values AND
blindings to the same pseudo-aggregator committee. The operator
learns trueSum only via a t-of-n committee Lagrange reveal — never
sees any individual value. The audit-time blinding reveal works
identically.

**Emergent property:** the operator's trust assumption is now
honest-but-curious about TRUESUM ONLY (the aggregate). No party
(operator, any single pseudo-aggregator, the auditor) sees any
individual value or blinding without t-of-n cooperation. Closest
the substrate can get to a true zero-trust aggregator without
distributed noise generation (which is the natural v7 layer).

NEW exports in `applications/_shared/aggregate-privacy/index.ts`:
- `buildDistributedContributionV6({contributorPodUrl, value, bounds,
  committee, threshold, contributorSenderKeyPair, blindingSeed?,
  valueSeed?, withRangeProof?})` — contributor side. Pedersen-commits
  + VSS-splits BOTH value AND blinding + encrypts paired share sets
  for the committee. Note: returns no `value` field — operator never
  sees cleartext.
- `aggregatePseudoAggregatorSharesV6({contributions,
  pseudoAggregatorIndex, ownKeyPair})` — pseudo-aggregator j
  decrypts received value-shares + blinding-shares, verifies each
  via VSS, sums each into combined shares. Returns
  `{ combinedValueShare, combinedBlindingShare }`.
- `revealTrueSumFromCommittee({contributions, committeeValueShares,
  threshold})` — operator-side reveal. VSS-filters combined value
  shares against the combined value commitments, Lagrange-
  interpolates trueSum. The operator never sees individual values.
- `buildAttestedHomomorphicSumV6({cohortIri, aggregatorDid,
  contributions, revealedTrueSum, epsilon, threshold,
  includeAuditFields?, epsilonBudget?, queryDescription?})` —
  operator builds bundle from committee-revealed trueSum. Bundle's
  `privacyMode` is `'zk-aggregate-v6-no-value-disclosure'`.
- `verifyAttestedHomomorphicSumV6({bundle, committeeBlindingShares,
  claimedTrueSum})` — audit-time reveal. VSS-filters combined
  blinding shares, Lagrange-interpolates trueBlinding, confirms
  sumCommitment opens to (claimedTrueSum, reconstructedTrueBlinding).
- `DistributedContributionV6` + `AttestedHomomorphicSumV6Result`
  types.

8 new contract tests (132 total in aggregate-privacy.test.ts):
- contribution emission shape (no cleartext value)
- full v6 honest flow with operator-never-sees-values assertion
- insufficient value shares rejected
- tampered combined value share rejected via combined-VSS
- per-contribution value-share tamper throws at aggregation
- audit insufficient blinding shares rejected
- audit wrong claimedTrueSum rejected via sumCommitment open
- every-t-subset consistency for BOTH trueSum AND trueBlinding

Live walkthrough at
[`tools/walkthrough-v6-distributed-values.ts`](tools/walkthrough-v6-distributed-values.ts)
demonstrates 9 phases including both tampering simulations + full
trust analysis. Regression-protected via
[`tests/walkthrough-v6-distributed-values.test.ts`](tests/walkthrough-v6-distributed-values.test.ts).

Tests: 1506/1506 passing (tsc clean).

---

## 2026-05-16 — v5 contributor-distributed blinding sharing (no trusted dealer)

Solves the trusted-aggregator problem at the protocol layer. Where v3
/ v4-partial / v4-partial+VSS all had the operator KNOWING
`trueBlinding = Σ contributor_blindings` (contributors revealed their
blindings to the operator for the homomorphic sum), v5 ships a fresh
protocol where contributors split their OWN blindings via Feldman VSS
to a pseudo-aggregator committee. The operator never sees any blinding.

**Emergent composition.** The protocol assembles entirely from
existing primitives — no new crypto, no new ontology terms, no
trusted setup:
- Pedersen commitments (existing) for `c_i = v_i·G + b_i·H`
- Feldman VSS (existing) for each contributor's polynomial
- X25519/nacl envelopes (existing) for share distribution
- DKG-style per-coefficient point-sum (existing `dkgRound3` logic,
  extracted as `combineFeldmanCommitments` for v5 reuse) for the
  COMBINED VSS commitments
- Shamir's additive homomorphism: each pseudo-aggregator's combined
  share s_j = Σ_i b_i^{(j)} IS a Shamir share of `Σ_i b_i =
  trueBlinding` under the combined polynomial F(x) = Σ_i f_i(x)
- Lagrange reconstruction (existing) at audit time

NEW exports in `applications/_shared/aggregate-privacy/index.ts`:
- `buildDistributedContribution({contributorPodUrl, value, bounds,
  committee, threshold, contributorSenderKeyPair, blindingSeed?,
  withRangeProof?})` — contributor side. Pedersen-commits +
  VSS-splits own blinding + encrypts each share for its recipient
  pseudo-aggregator.
- `aggregatePseudoAggregatorShares({contributions,
  pseudoAggregatorIndex, ownKeyPair})` — pseudo-aggregator j
  decrypts received shares, verifies each against contributor's VSS
  commitments, sums into combined share s_j. Throws on any tampered
  share.
- `buildAttestedHomomorphicSumV5({cohortIri, aggregatorDid,
  contributions, epsilon, threshold, includeAuditFields?,
  epsilonBudget?, queryDescription?})` — operator side. Computes
  trueSum + sumCommitment + DP noise + COMBINED VSS commitments.
  Operator never sees blindings. Bundle's `privacyMode` is
  `'zk-aggregate-v5-no-trusted-dealer'`.
- `reconstructAndVerifyV5({bundle, committeeShares,
  claimedTrueSum})` — audit-time t-of-n reveal. VSS-filters
  combined shares against combinedBlindingCommitments, Lagrange-
  interpolates trueBlinding, verifies sumCommitment opens.
- `DistributedContribution` + `AttestedHomomorphicSumV5Result` types.

10 new contract tests (124 total in aggregate-privacy.test.ts):
- buildDistributedContribution emission shape
- combined-share verifies against combined VSS commitments
- full honest flow (operator-never-sees-blinding asserted)
- single pseudo-aggregator share insufficient (threshold enforced)
- tampered combined share rejected via combined-VSS BEFORE Lagrange
- aggregatePseudoAggregatorShares throws on tampered contribution share
- mismatched committee size / scheme rejection
- empty contributions throw
- wrong claimedTrueSum rejection via sumCommitment opening
- every t-subset converges on the same trueBlinding

Live walkthrough at
[`tools/walkthrough-v5-distributed-blinding.ts`](tools/walkthrough-v5-distributed-blinding.ts)
demonstrates the full 7-phase flow including trust-analysis
print-out (what each party sees and does NOT see). Regression-
protected via
[`tests/walkthrough-v5-distributed-blinding.test.ts`](tests/walkthrough-v5-distributed-blinding.test.ts).

**Trust model improvement.** v5 reduces the operator's trust
assumption to honest-but-curious about CLEARTEXT VALUES only; the
blinding-side of the privacy boundary is fully distributed across
the committee with no single trusted party. Hiding cleartext values
from the operator (additive secret-sharing of v_i too) is the
natural v6 layer — the substrate primitives for that already exist.

Tests: 1497/1497 passing (tsc clean).

---

## 2026-05-16 — v3.4: ZK range proofs wired into the v3 zk-aggregate path

Integration of the `proveRange` / `verifyRange` primitives (shipped at
`953ced8`) into the v3 zk-aggregate protocol. The auditor can now
verify per-contributor bounds end-to-end WITHOUT seeing cleartext
values — closes the prior gap where the bundle's `sensitivity` claim
had to be trusted at audit time.

CHANGED in `applications/_shared/aggregate-privacy/index.ts`:
- `buildCommittedContribution({withRangeProof: true})` emits a
  `rangeProof: RangeProof` field on the returned contribution.
- `CommittedContribution.rangeProof?: RangeProof` field added.
- `buildAttestedHomomorphicSum({requireRangeProof: true})` enforces
  that every contribution carries a rangeProof AND that the proof's
  declared bounds match the contribution's declared bounds AND that
  the proof verifies against the commitment. Throws on any failure.
- `AttestedHomomorphicSumResult.contributorRangeProofs?: RangeProof[]`
  field added; populated 1:1 with contributorCommitments when the
  bundle is built with requireRangeProof.
- NEW `verifyContributorRangeProofs(bundle)` — auditor-side cross-
  check. Confirms every per-contributor proof verifies against the
  matching contributorCommitment, every contributor agreed on the
  same cohort bounds, and the bundle's published `sensitivity`
  equals the bounds-derived `Number(max - min)`. Returns the agreed
  bounds on success.

7 new contract tests (114 total in aggregate-privacy.test.ts):
- buildCommittedContribution + withRangeProof emits rangeProof
- buildAttestedHomomorphicSum + requireRangeProof emits
  contributorRangeProofs; verifier accepts honest bundle
- REJECTS contributions missing rangeProofs when requireRangeProof
- REJECTS contributions whose proof bounds mismatch declared bounds
- verifyContributorRangeProofs rejects bundle without proofs
- verifyContributorRangeProofs rejects swapped-proofs (i vs j)
- verifyContributorRangeProofs rejects mixed-bound proofs across
  contributors

Substrate-pure: composes the existing range-proof + pedersen
primitives. No new ontology terms.

Honest framing on the DKG side: the v3 protocol fundamentally has
the operator KNOWING `trueBlinding = Σ contributor_blindings`
(contributors reveal blindings for the homomorphic sum). The
v4-partial trusted-dealer caveat is that the operator runs the
Shamir split; swapping that for DKG doesn't change the fact that
the operator already knew the secret. Full removal needs a fresh
protocol design where contributors blind with derivations of a
committee-collective secret the operator never sees — that's
research, not wiring. The DKG primitive ships ready for any future
protocol that needs it.

Tests: 1486/1486 passing (tsc clean).

---

## 2026-05-16 — Per-vertical bridge audience split (operator-only deployments)

Closes the "per-vertical operator-side bridges as standalone
deployments" item. Both LPC + OWM bridges now switch their exposed
affordance set based on a single env var, letting operators run an
operator-only deployment behind stricter network policy without
forking code.

CHANGED in `applications/learner-performer-companion/bridge/server.ts`:
- New `LPC_AUDIENCE` env var: `learner` | `institutional` | `both`
  (default `both`). Selects which subset of declared affordances the
  runtime exposes.

CHANGED in `applications/organizational-working-memory/bridge/server.ts`:
- New `OWM_AUDIENCE` env var: `contributor` | `operator` | `both`
  (default `both`). Same shape.

GET `/affordances` and MCP `tools/list` automatically reflect the
active subset — no client-side change required.

NEW in `docs/DEPLOYMENT-SPLIT.md`: the deployment-split pattern. Why
this is a configuration change rather than a code change, when to
split, pod-scope hygiene notes, and the recipe for new verticals.

---

## 2026-05-16 — Python verifier: first slice of the second-language story

Ships [`integrations/python-verifier/`](integrations/python-verifier/) —
a Python reference implementation of the v3.3 SignedBudgetAuditLog
verifier. Proves Interego's audit artifacts are language-portable:
regulators with Python tooling can re-verify the canonical signed
audit log without depending on the TS runtime.

Files:
- `verify_budget_audit.py` — module + CLI. Implements
  `canonicalize_budget_for_signing` (byte-for-byte mirror of the TS
  `canonicalizeBudgetForSigning`) + `verify_signed_budget_audit_log`
  (mirrors `verifyBudgetAuditLog`).
- `README.md` — usage, dependencies (only `eth-account`),
  cross-implementation contract notes.

Three checks (identical to the TS implementation):
1. Signature recovers an address present in `signerDid`.
2. Log entries sum to `snapshot.spent` (within 1e-9 rounding).
3. `snapshot.spent <= snapshot.maxEpsilon`.

A full Python port of the substrate is multi-month multi-person work,
properly tracked separately. This slice is the demonstration that
the audit interface is interoperable today — adopters porting other
primitives (Pedersen verification, Merkle inclusion, etc.) follow
the same pattern.

---

## 2026-05-16 — ZK range proofs (Chaum-Pedersen OR + bit-decomposition)

Ships [`src/crypto/range-proof.ts`](src/crypto/range-proof.ts) — non-
interactive zero-knowledge proofs that a Pedersen commitment opens to
a value in a declared range, without revealing the value. Closes the
v3.1 "lying contributor" cheat at the cryptographic layer.

Two primitives:

1. **proveBit / verifyBit** — Chaum-Pedersen OR proof for {0, 1}. The
   proof convinces a verifier that a Pedersen commitment C = vG + bH
   opens to either v=0 or v=1, without revealing which. Statement:
   ∃ b such that C = bH OR C - G = bH. Standard NIZK OR proof via
   Fiat-Shamir.

2. **proveRange / verifyRange** — bit-decomposition range proof for
   arbitrary [min, max]. Decompose v - min into n bits, commit to
   each bit separately, emit an OR proof per bit. Verifier checks
   each OR proof + that Σ 2^i · C_i ≡ C - min·G (the bit
   decomposition reconstructs the shifted commitment).

19 new contract tests in `tests/range-proof.test.ts`:
- Bit proof: honest-0/1 accept, forged-from-wrong-blinding reject,
  non-bit throw, cross-commitment reject, tampered-component reject,
  zero-knowledge shape parity (proof shape independent of bit value)
- Range proof: honest in-range / value=min / value=max / shifted
  range [50,150]; throws on below-min / above-max / max<min;
  tampered bit-commitment reject, tampered bit-proof reject,
  cross-commitment reject, trivial range (min=max, 1 bit), wider
  range (1000 values, ~10 bits)

Substrate-pure: composes existing pedersen + sha256 (Fiat-Shamir)
primitives. No new ontology terms.

Wiring `proveRange` into `buildCommittedContribution` +
`buildAttestedHomomorphicSum`'s bounds re-check as an optional
`requireRangeProof` mode is the remaining v3.4 integration step.

Tests: 1479/1479 passing (tsc clean).

---

## 2026-05-16 — DKG primitive (removes the v4-partial trusted-dealer caveat)

Ships [`src/crypto/dkg.ts`](src/crypto/dkg.ts) — a Distributed Key
Generation protocol (Pedersen 1991 / Gennaro et al 1999 variant) over
the ristretto255 scalar field. Composes existing `feldman-vss.ts`
directly: each participant runs Feldman VSS as the dealer for their
own random polynomial, the COLLECTIVE polynomial is the sum, and no
single participant ever learns the collective secret.

This removes the v4-partial threshold-reveal protocol's trusted-dealer
caveat: where v4-partial+VSS still has the operator running the split
(and therefore knowing every polynomial coefficient), DKG ensures NO
party — operator or pseudo-aggregator — sees the collective polynomial.

NEW exports:
- `dkgRound1({index, n, t})` — generate the party's random polynomial
  + Feldman commitments + per-recipient shares.
- `dkgRound2({recipientIndex, received})` — verify each received share
  against the sender's broadcast commitments; return qualified +
  rejected sender sets.
- `dkgRound3({recipientIndex, t, qualifiedReceived})` — combine the
  qualified shares into this party's share of the COLLECTIVE
  polynomial; compute the collective coefficient commitments + public
  key as the per-coefficient point-sum across qualified senders.
- `simulateDKG({n, t})` — single-process end-to-end honest run for
  tests + walkthrough. Returns the n final states with each party's
  combined share + collective public key.
- `DKGParticipantState`, `DKGReceivedShare`, `DKGRound2Result`,
  `DKGFinalState` types exported.

13 new contract tests in `tests/dkg.test.ts`:
- round 1: produces n shares + t commitments; rejects out-of-range
  index/threshold; every party's own shares verify against own
  commitments
- round 2: qualifies honest, rejects tampered y, rejects wrong-x
- round 3: combined share verifies against collective commitments;
  throws on empty input; throws on wrong commitment count
- end-to-end simulation: every participant agrees on PK + QUAL;
  every combined share verifies; any t-of-n combined shares Lagrange-
  interpolate to the collective secret; t-1 shares insufficient;
  collective PK equals the sum of each party's a_{i,0} · G

Wiring DKG into `buildAttestedHomomorphicSum`'s thresholdReveal path
is the remaining integration step — substrate-pure (composes existing
feldman-vss + shamir without new ontology terms).

Tests: 1460/1460 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy v3 distribution: publishable + compliance bridge

Completes the zk-distribution layer parity with v3 zk-aggregate.
The distribution bundle is now a fetchable pod artifact AND a
compliance-grade descriptor, so non-TS clients + regulators have the
same audit surface they get for single-sum aggregates.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `publishAttestedHomomorphicDistribution({bundle, podUrl})` —
  content-addressed on (firstBucketCommitmentBytes, cohortIri).
- `fetchPublishedHomomorphicDistribution({graphUrl})` — auditor side.

NEW in `integrations/compliance-overlay/src/aggregate-bridge.ts`:
- `buildDistributionQueryComplianceDescriptor({bundle, queryArgs,
  toolName, citation, startedAt?})` — embeds per-bucket noisy counts
  + scheme + bucketSumCommitment bytes + epsilon + cohort. Intentionally
  OMITS trueBucketCounts / trueBucketBlindings — those are the private
  aggregator-side values the privacy boundary explicitly hides.
- Re-exported from `integrations/compliance-overlay/src/index.ts`.

4 new contract tests:
- 1 in aggregate-privacy.test.ts (107 total): publish + fetch +
  re-verify round-trip via mock fetch.
- 3 in compliance-overlay aggregate-bridge.test.ts (17 total): per-
  bucket embedding shape, privacy-boundary non-leakage, default
  control mappings.

Tests: 1446/1446 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy v3 distribution: per-bucket homomorphic sums + DP noise

Closes the "verticals throw if metric isn't count-shaped" gap from the
"Honest remaining work" list. Operators can now compute histograms over
private contributor values (decision-distribution by quarter, learner
score-distribution, etc.) with the same homomorphic+DP guarantees v3
gives single sums.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `NumericBucketingScheme` — typed bucket boundaries (edges + maxValue).
  Right-open buckets except the last one (right-closed at maxValue).
- `bucketIndex(scheme, value)` — classify a value; throws on out-of-range.
- `bucketCount(scheme)` — number of buckets in the scheme.
- `BucketedCommittedContribution` — one-hot encoded contribution:
  the bucket the value falls into gets commit(1, blinding_i), every
  other bucket gets commit(0, blinding_i).
- `buildBucketedContribution({contributorPodUrl, value, scheme,
  blindingSeed?, blindingLabel?})` — produces the contribution
  vector. Deterministic when a seed is supplied.
- `buildAttestedHomomorphicDistribution({cohortIri, aggregatorDid,
  contributions, epsilon, includeAuditFields?, epsilonBudget?,
  queryDescription?})` — per-bucket homomorphic sum + per-bucket
  DP-Laplace noise. Per-bucket sensitivity = 1 (one-hot encoding
  bounds shift per bucket to ≤1). Composes the existing `EpsilonBudget`
  tracker.
- `verifyAttestedHomomorphicDistribution(result)` — auditor-side.
  Per-bucket structural check (sum equals homomorphic sum of
  contributor commitments) + per-bucket opening check (with audit
  fields). Catches: aggregator substituting per-bucket commitments,
  lying about per-bucket counts, scheme tampering.
- `AttestedHomomorphicDistributionResult` interface with
  `privacyMode: 'zk-distribution'`.

Sensitivity note: per-bucket ε is the standard DP guarantee; the
cumulative histogram ε under sequential composition is `k * ε` where
k = number of buckets. Callers wanting histogram-level ε divide
their budget by k before calling.

16 new contract tests (106 total in aggregate-privacy.test.ts):
- bucketing helpers: bucketCount, classification across all buckets,
  below-min throw, above-max throw, edges-too-few throw
- buildBucketedContribution: one-hot encoding correctness +
  distinguishable per-bucket commitments, seeded reproducibility
- buildAttestedHomomorphicDistribution + verify: noisy-count shape,
  true-count distribution correctness, honest verify, tampered
  bucketSumCommitments rejection, tampered trueBucketCounts
  rejection, scheme-mismatch throw, empty-contributions throw,
  ε-budget integration, boundary-value classification across all edges

Tests: 1442/1442 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy: distribution-vs-authorization cross-check

Closes the "operator authorizes 5 DIDs but ships shares to 3 sock-
puppets" cheat — the prior verifyCommitteeMatchesAuthorization
checks the reveal-time committee against the authorization, but
nothing checked the share-distribution phase against it. Now both
are covered.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `verifyShareDistributionsMatchAuthorization({authorization,
  distributions})` — confirms:
    - the authorization signature verifies
    - distributions.length matches authorization.threshold.n
    - every distribution.recipientDid is in
      authorization.authorizedDids
    - every authorization.authorizedDids member has a matching
      distribution (no silently-dropped recipient)
    - no duplicate distributions to the same recipient

4 new contract tests (90 total in aggregate-privacy.test.ts):
honest 1:1 distribution acceptance, sock-puppet recipient rejection,
count-mismatch rejection, silently-dropped-recipient rejection.

Tests: 1426/1426 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy: publishable committee authorization + compliance bridge

Closes the full v4-partial audit chain. The operator's pre-reveal
authorization is now a fetchable pod artifact + a compliance-grade
descriptor — a regulator can walk the entire chain: authorization →
reveal attestation → cross-check → reconstruction → compliance
descriptors.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `publishCommitteeAuthorization({authorization, podUrl})` —
  content-addressed on (bundleSumCommitment, operatorDid) for
  idempotent re-publish.
- `fetchPublishedCommitteeAuthorization({graphUrl})` — auditor side.

NEW in `integrations/compliance-overlay/src/aggregate-bridge.ts`:
- `buildCommitteeAuthorizationComplianceDescriptor({authorization,
  citation, toolName?})` — embeds bundleSumCommitment + sorted
  authorizedDids + (n, t) + operatorDid + issuedAt. Signature stays
  in the pod artifact (not the descriptor body) — same pattern as
  the committee reconstruction bridge.
- Default toolName: `aggregate-privacy.committee-authorization`.
- Re-exported from `integrations/compliance-overlay/src/index.ts`.

4 new contract tests:
- 1 in aggregate-privacy.test.ts (86 total): publish + fetch +
  re-verify round-trip via mock fetch.
- 3 in compliance-overlay aggregate-bridge.test.ts (14 total):
  embedding shape (sum-commitment, n, t, operator, DIDs), signature-
  non-leakage, default toolName.

Tests: 1421/1421 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy: operator-signed committee authorization (pre-reveal binding)

Closes the "operator forms a sock-puppet committee at reveal time"
audit gap. The operator now signs a CommitteeAuthorization BEFORE
distributing shares that binds them to the n authorized
pseudo-aggregator DIDs + the (n, t) threshold. The regulator
cross-checks the actual reveal committee (from the
CommitteeReconstructionAttestation) against this earlier
authorization and rejects any drift.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `committeeAuthorizationMessage(...)` — canonical message format
  (authorized DIDs sorted lexicographically; signing order is
  membership-independent).
- `signCommitteeAuthorization({bundleSumCommitment, authorizedDids,
  threshold, operatorDid, operatorWallet, issuedAt?})` — throws when
  authorizedDids.length != threshold.n OR when threshold.t is out
  of range [1, n].
- `verifyCommitteeAuthorization({authorization})` — auditor-side
  signature check + structural consistency.
- `verifyCommitteeMatchesAuthorization({authorization, attestation})`
  — cross-check: rejects unauthorized members, rejects
  bundleSumCommitment mismatch, rejects reveal-committee smaller
  than authorized threshold t.
- `CommitteeAuthorization` type exported.

7 new contract tests (85 total in aggregate-privacy.test.ts):
canonical-message DID-sort independence, honest sign/verify +
cross-check, n-mismatch throw, t-out-of-range throw,
unauthorized-member rejection (sock-puppet), bundle-mismatch
rejection, t-too-small rejection.

Tests: 1417/1417 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy: publishable encrypted share distribution

Closes the distribution loop. Operators can now publish encrypted
shares as normal pod descriptors instead of an out-of-band channel;
recipients discover them via standard pod-discovery flows and
decrypt via their own X25519 keypair.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `publishEncryptedShareDistribution({distribution,
  bundleSumCommitment, operatorDid, podUrl})` — writes the
  EncryptedShareDistribution as a `cg:ContextDescriptor` on the
  operator's pod. Content-addressed on (bundleSumCommitment,
  recipientDid) so republish is idempotent.
- `fetchPublishedEncryptedShareDistribution({graphUrl})` — recipient-
  side fetch + JSON.parse. The recipient then calls
  `decryptShareForRecipient` with their own keypair.

1 new contract test (78 total in aggregate-privacy.test.ts): publish
→ fetch → decrypt round-trip via the same mock-fetch pattern used by
the bundle / budget-log / committee-attestation publish helpers.

Tests: 1410/1410 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy: encrypted share distribution

Closes the "how does the operator actually distribute shares to
pseudo-aggregators securely" gap left in the v4-partial protocol.
The substrate now ships an encrypt-share-for-recipient primitive that
composes the existing X25519/nacl envelope machinery — no out-of-band
distribution protocol required.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `encryptShareForRecipient({share, recipientDid, recipientPublicKey,
  senderKeyPair})` — serializes the VerifiableShamirShare to JSON
  (bigint y preserved via `__bigint` wrapper) and wraps it in an
  X25519/nacl envelope keyed to the recipient's public key.
- `decryptShareForRecipient({distribution, recipientKeyPair})` —
  recipient unwraps + JSON.parses with the bigint reviver. Returns
  null if the recipient is not authorized or the envelope fails to
  decrypt.
- `encryptSharesForCommittee({shares, recipients, senderKeyPair})` —
  1:1 lockstep distribution. Throws on length mismatch. Each recipient
  can decrypt ONLY their own share.
- `EncryptedShareDistribution` type exported.

5 new contract tests (77 total in aggregate-privacy.test.ts): honest
encrypt/decrypt round-trip with bigint preservation, non-recipient
rejection, 1:1 committee distribution (cross-decrypt fails), length-
mismatch throw, end-to-end (encrypt → distribute → decrypt →
reconstruct → committee attestation).

Tests: 1409/1409 passing (tsc clean).

---

## 2026-05-16 — Compliance-overlay bridge for v4-partial committee attestation

Extends the compliance-overlay aggregate-bridge with a fourth wrapper:
the CommitteeReconstructionAttestation chain-of-custody artifact is
now a compliance-grade descriptor citing framework controls, ready
for the regulator audit trail.

NEW in `integrations/compliance-overlay/src/aggregate-bridge.ts`:
- `buildCommitteeReconstructionComplianceDescriptor({attestation,
  citation, toolName?})` — embeds bundleSumCommitment, claimedTrueSum,
  committeeDids (sorted), committeeSize, signatureCount, reconstructedAt
  in the resultSummary. Intentionally omits the individual signatures —
  those live in the published pod artifact (an auditor fetches the
  pod copy when they want the cryptographic re-verification).
  Default toolName: `aggregate-privacy.committee-threshold-reveal`.
- Re-exported from `integrations/compliance-overlay/src/index.ts`.

3 new contract tests in
`integrations/compliance-overlay/tests/aggregate-bridge.test.ts`
(11 total): embedding shape (sum-commitment + reconstructedAt +
committee membership + sizes), signature-non-leakage (descriptor
body must NOT contain the signature hex), default toolName.

Tests: 1404/1404 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy: publishable committee-reconstruction attestation

The CommitteeReconstructionAttestation is now publishable as a normal
`cg:ContextDescriptor` on the operator's pod. Parallels the existing
publishAttestedHomomorphicSum / publishSignedBudgetAuditLog pattern:
JSON body (with bigint-string round-trip) inside `agg:bundleJson`;
content-addressed on (bundleSumCommitment, reconstructedAt) so
republishing is idempotent.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `publishCommitteeReconstructionAttestation({attestation, podUrl})` —
  writes the attestation as a pod descriptor. The first canonical-
  sorted committee DID becomes the descriptor's provenance agent;
  full committee membership remains in the JSON body.
- `fetchPublishedCommitteeReconstructionAttestation({graphUrl})` —
  retrieves + JSON.parses with the bigint reviver. Returns null on
  fetch error or missing body.

1 new contract test (72 total in aggregate-privacy.test.ts): publish →
fetch → re-verify round-trip via the same mock-fetch pattern used by
the existing publishAttestedHomomorphicSum + publishSignedBudgetAuditLog
tests. Catches: Turtle ↔ JSON escape regressions, bigint loss,
signature-array shape changes through serialization.

---

## 2026-05-16 — Aggregate-privacy v4-partial committee-reconstruction attestation (chain-of-custody)

Closes the "who actually revealed the blinding" gap from the
v4-partial threshold-reveal protocol. When a t-of-n committee
successfully reconstructs trueBlinding, the reveal is now a
tamper-evident, signed artifact — no single operator can later
attribute the reveal to a fabricated committee or hide that the
reveal happened.

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `committeeReconstructionMessage({bundleSumCommitment, claimedTrueSum,
  committeeDids, reconstructedAt})` — canonical message format. DIDs
  sorted lexicographically before serialization so signing order is
  committee-membership-independent.
- `signCommitteeReconstruction({bundleSumCommitment, claimedTrueSum,
  committeeDids, reconstructedAt, signerWallet, signerDid})` — each
  pseudo-aggregator calls this with their own wallet + DID before the
  coordinator collects the signatures into a
  `CommitteeReconstructionAttestation`.
- `verifyCommitteeReconstruction({attestation})` — auditor side. Checks:
    - signature count matches committee size
    - every signature recovers an address inside its claimed memberDid
    - every committee member has at least one signature (no silent
      drops even when signatures.length == committeeDids.length)
    - no signature is attributed to a DID outside the committee
  Returns the array of recovered addresses on success.
- `CommitteeReconstructionAttestation` + `CommitteeMemberSignature`
  types exported.

8 new contract tests (71 total in aggregate-privacy.test.ts):
- canonicalMessage is deterministic + DID-order-independent
- honest committee: every signature recovers + verify accepts
- REJECTS signature count != committee size
- REJECTS signature attributed to a DID not in the committee
- REJECTS impersonation (wallet[i] signs but claim is dids[j])
- REJECTS silently-dropped member (two signatures for the same DID,
  one member listed in committee has no signature)
- REJECTS claimedTrueSum tampering after signing
- REJECTS bundleSumCommitment substitution

Tests: 1400/1400 passing (tsc clean).

---

## 2026-05-16 — Aggregate-privacy v4-partial + Feldman VSS: protocol-layer composition

Closes the "corrupted-share silently poisons Lagrange" gap from the
v4-partial Shamir-only path. The threshold-reveal protocol now uses
Feldman Verifiable Secret Sharing under the hood: the bundle carries
per-polynomial-coefficient commitments alongside the shares, and the
verifier filters bad shares BEFORE Lagrange reconstruction instead of
catching the corruption only via the after-the-fact sum-commitment
check (which a malicious tampering of just-enough-shares could still
defeat in the unguarded path).

CHANGED in `applications/_shared/aggregate-privacy/index.ts`:
- `buildAttestedHomomorphicSum`'s `thresholdReveal` branch now calls
  `splitSecretWithCommitments` (not plain `splitSecret`) from the
  new `src/crypto/feldman-vss.ts` module. The bundle emits
  `coefficientCommitments: FeldmanCommitments` alongside the
  existing `thresholdShares`. Shares are typed as
  `VerifiableShamirShare` (structurally compatible with `ShamirShare`).
- `AttestedHomomorphicSumResult.coefficientCommitments?: FeldmanCommitments`
  field added; serializes through the same publish/fetch helpers
  (JSON round-trip is preserved — `bigintReviver` doesn't touch the
  hex-encoded points).
- `reconstructThresholdRevealAndVerify` accepts both `ShamirShare` and
  `VerifiableShamirShare` (same fields). When the bundle carries
  `coefficientCommitments`, it filters the supplied shares via
  `filterVerifiedShares` BEFORE Lagrange; if the verified subset is
  smaller than `t`, it returns `valid: false` with the rejection
  count. New return fields: `verifiedShareCount` + `rejectedShareCount`.
- Backward compatible: bundles without `coefficientCommitments`
  (legacy / stripped) fall through to the unguarded path. The
  caller accepts the corrupted-share risk.

7 new contract tests (63 total in aggregate-privacy.test.ts now: 12
v2 + 9 v3 + 8 v3.1 + 9 v3.2 + 6 v3.3 + 3 publishable + 8 v4-partial + 7
v4-partial+VSS, plus 1 cohort-IRI):
- emits `coefficientCommitments` (one per coefficient = `t`) alongside
  `thresholdShares` when `thresholdReveal` is requested
- NO `coefficientCommitments` when threshold reveal is not requested
- honest VSS-composed flow: shares verify, reconstruction succeeds,
  zero rejected
- REJECTS a tampered share via VSS BEFORE Lagrange poisons the result
  (4 supplied, 1 rejected, 3 verified → still meets threshold,
  reconstruction valid)
- REJECTS when too many shares are tampered to meet threshold (1
  verified < t=3 → reason mentions "after VSS verification")
- every t-subset of n VSS shares converges on the same blinding
- legacy bundles without `coefficientCommitments` fall through to the
  unguarded path
- VSS commitments survive JSON round-trip through the publishable
  bundle helpers (bigint reviver doesn't disturb hex-encoded points)

Tests: 1392/1392 passing, 29 skipped (network / external).

---

## 2026-05-16 — Aggregate-privacy v3.3: signed audit-log descriptor

Closes the "honest accounting vs tamper-evident" gap from v3.2. The
EpsilonBudget consumption log now ships in a signed bundle whose
signature recovers the operator's DID; tamper-detection at every
angle (modified spent, dropped log entries, impersonated signer,
internal-consistency violations).

NEW in `applications/_shared/aggregate-privacy/index.ts`:
- `canonicalizeBudgetForSigning(snap)` — deterministic string with
  sorted keys + fixed numeric formatting + log entries in
  chronological insertion order. Both signer and verifier use the
  same canonicalization; format drift breaks signature verify.
- `signBudgetAuditLog({budget, signerWallet, signerDid})` — snapshots
  the budget, signs the canonical via `signMessageRaw` from the
  existing `src/crypto/wallet.ts`, returns the SignedBudgetAuditLog.
- `verifyBudgetAuditLog(signed)` — auditor side. Recovers the signer
  via `recoverMessageSigner`; checks the recovered address appears
  in the claimed signerDid (loose containment, catches the common
  did:ethr / did:pkh shapes); verifies log entries sum to spent
  (within 1e-9 rounding); verifies spent ≤ maxEpsilon.

6 new contract tests (44 total in aggregate-privacy.test.ts now: 12
v2 + 9 v3 + 8 v3.1 + 9 v3.2 + 6 v3.3):
- canonicalizeBudgetForSigning deterministic + correct shape
- honest round-trip: sign → verify accepts; recovered address
  matches wallet
- REJECTS bundle with snapshot.spent tampered after signing
- REJECTS bundle whose log entries were silently dropped
- REJECTS bundle whose signerDid claims a different identity than
  the signature recovers
- REJECTS bundle with internal consistency violation
  (snapshot.spent > maxEpsilon)

Composes existing primitives: no new ontology terms; the
SignedBudgetAuditLog is a plain typed object that can be serialized
into a normal ContextDescriptor's graph content on the operator's
pod (publish() handles the rest).

Validation: tsc clean; full vitest suite **1332/1332 passing** (1326
prior + 6 new).

STATUS.md updated: v3.3 row added; remaining-work signed-audit-log
item replaced with v4 (multi-party threshold reveal) as the next
genuine iteration.

The aggregate-privacy ladder now covers FIVE layered modes:

  v1   'abac'                           → ABAC-bounded count
  v2   'merkle-attested-opt-in'         → verifiable count + opt-in
  v3   'zk-aggregate'                   → homomorphic sum + DP noise
  v3.1 + requireSignedBounds            → regulator-grade attribution
  v3.2 + epsilonBudget                  → cumulative ε discipline
  v3.3 signBudgetAuditLog               → tamper-evident audit log

Every step composes the previous; no breaking changes to the
affordance signatures (every new field is optional). The four
PM-eval recommendations are all complete; the aggregate-privacy
ladder is end-to-end auditable; the honest remaining work is
v4 multi-aggregator threshold reveal (real distributed crypto
work) + the second-language Interego implementation needed to
advance L1 from Last Call → Candidate Recommendation.

---

## 2026-05-16 — Aggregate-privacy v3.2: cumulative ε-budget tracking

Closes the DP-discipline gap that's currently the caller's burden:
without budget tracking, a caller could run an aggregate query 1000
times at ε=0.01 each and effectively get ε=10 of accumulated leakage.
The per-query privacy claim stays sound; the cumulative claim is gone.

NEW: `EpsilonBudget` class in
`applications/_shared/aggregate-privacy/index.ts`. Construct with a
per-cohort max ε; call `consume({queryDescription, epsilon})` before
each query; the call throws if cumulative consumption would exceed
the cap. Records a log entry per successful consume so an auditor
can replay the budget consumption. `canAfford(ε)` lets the caller
preflight without consuming. `toJSON()` / `fromJSON(snap)` for
persistence.

`buildAttestedHomomorphicSum` gains optional `epsilonBudget` +
`queryDescription` args. When supplied, the function calls
`epsilonBudget.consume(...)` BEFORE building the bundle — budget
overrun aborts the query rather than producing a bundle the caller
has to throw away.

9 new contract tests (38 total in aggregate-privacy.test.ts now: 12
v2 + 9 v3 + 8 v3.1 + 9 v3.2):
- construction rejects non-positive maxEpsilon
- construction rejects initial.spent > maxEpsilon
- consume across queries: remaining decrements; spent tracks
- consume throws when it would exceed cap; spent does NOT advance
  on the failed attempt
- log entry recorded per successful consume
- canAfford preflight does not consume
- toJSON / fromJSON round-trips losslessly (cohortIri, maxEpsilon,
  spent, log)
- buildAttestedHomomorphicSum consumes ε from a supplied budget;
  log records the queryDescription
- buildAttestedHomomorphicSum REFUSES to run if budget would be
  exhausted (the first query succeeds; the second throws; spent
  reflects only the successful query)

Trust model: honest accounting, not tamper-evident. An auditor can
replay the log to verify the remaining-budget claim; a malicious
caller that bypasses the tracker still leaks DP info, but the audit
log shows the gap. Future v3.3 would wrap `EpsilonBudget.toJSON()`
in a signed pod descriptor so the log itself becomes a verifiable
artifact (`src/compliance/signDescriptor` + standard `publish()`).

Validation: tsc clean; full vitest suite **1326/1326 passing** (1317
prior + 9 new).

STATUS.md updated: v3.2 row added to the aggregate-privacy ladder;
remaining-work cumulative-ε-budget item replaced with v3.3 (signed
audit-log descriptor) as the next iteration.

The aggregate-privacy ladder now covers:
  v1 'abac'                          → ABAC-bounded count (default)
  v2 'merkle-attested-opt-in'        → verifiable count + opt-in
  v3 'zk-aggregate'                  → homomorphic sum + DP noise
  v3.1 + requireSignedBounds: true   → regulator-grade attribution
  v3.2 + epsilonBudget               → cumulative ε discipline

Each step composes the previous; no breaking changes to the
affordance signatures (every new field is optional).

---

## 2026-05-16 — Aggregate-privacy v3.1: aggregator-side bounds enforcement + signed-bounds attestations

Closes the "lying contributor" cheat that v3 alone could not catch.
v3 ships with the contributor's own client-side bounds check in
`buildCommittedContribution`. A malicious contributor that skipped or
hand-rolled around that check could publish a value outside their
declared `[min, max]` and inflate the noisy sum (the Pedersen
commitment still opens correctly; the verifier sees a clean bundle
that's nevertheless leaking information about that contributor).

Two layered fixes:

1. **Aggregator-side bounds re-check** in `buildAttestedHomomorphicSum`.
   Per contribution: `if (c.value < c.bounds.min || c.value > c.bounds.max) throw`.
   The aggregator NEVER trusts the contributor's self-bounds-check;
   the sensitivity invariant the DP claim rests on is now enforced
   at sum-time. Default v3 behaviour now includes this guard.

2. **Optional `SignedBoundsAttestation`** on each contribution.
   Canonical message:
     `interego/v1/aggregate/signed-bounds|<commitment-hex>|<min>|<max>|<contributorDid>`
   signed by the contributor's wallet. New `verifySignedBounds` helper
   uses ethers' message-signature recovery + a loose DID-address
   containment check. With `requireSignedBounds: true` on the build
   call, the aggregator refuses any contribution that lacks a valid
   attestation — regulator-grade mode where the aggregator is also
   under audit and cannot be trusted to attribute commitments
   correctly.

8 new contract tests in `applications/_shared/tests/aggregate-privacy.test.ts`
(29 total in that file now: 12 v2 + 9 v3 + 8 v3.1):
- aggregator REJECTS a contribution whose value is outside the
  declared bounds (the bypassed-client-side-check threat)
- aggregator ACCEPTS contributions with values exactly at min and
  exactly at max (boundary case)
- `signedBoundsMessage` matches the documented canonical format
- `verifySignedBounds` accepts honest signatures
- `verifySignedBounds` REJECTS a signature over a different
  commitment (cross-cohort replay)
- `verifySignedBounds` REJECTS a signature whose recovered address
  does not appear in the claimed contributorDid (impersonation)
- `requireSignedBounds: true` REJECTS contributions without an
  attestation
- `requireSignedBounds: true` ACCEPTS contributions with valid
  attestations

Validation: full vitest suite **1317/1317 passing** (1309 prior + 8
new); `tsc -p tsconfig.json --noEmit` clean.

STATUS.md updated: v3.1 row added to the aggregate-privacy ladder
with the bounds-enforcement + signed-bounds story. The earlier
"per-contribution range proofs" item in remaining-work moves to a
future v3.2 entry (non-interactive ZK range proofs for
"verify-without-revealing-value" — useful when the aggregator is
itself partially trusted).

Trust ladder is now:

  v1 'abac'                              → ABAC-bounded count
  v2 'merkle-attested-opt-in'            → verifiable count + opt-in
  v3 'zk-aggregate'                      → homomorphic sum + DP noise
  v3.1 + requireSignedBounds: true       → regulator-grade attribution

Each step composes the previous; no breaking changes to the affordance
signatures (the new field on CommittedContribution is optional).

---

## 2026-05-16 — Aggregate-privacy v3: real homomorphic Pedersen sum + DP-Laplace noise (zk-aggregate mode live)

Closes the last item from the prior PM-eval-driven session arc: v3 of
the aggregate-privacy ladder. The four `aggregate_*_query` affordances
now have `privacy_mode: 'zk-aggregate'` as a LIVE option, not a stub —
the aggregator commits each contributor's value with a Pedersen
commitment over ristretto255, sums commitments homomorphically WITHOUT
seeing individual values, adds DP-Laplace noise calibrated to a public
ε budget, and returns a re-verifiable bundle.

NEW: `src/crypto/pedersen.ts` (~250 lines)

- Pedersen commitments over the ristretto255 prime-order group (RFC
  9496 via `@noble/curves/ed25519.js`). C = v·G + b·H where G is
  ristretto255.Point.BASE and H is derived via RFC 9380 hash-to-curve
  from a public domain-separation label (`H_GENERATOR_LABEL` is
  exported so any implementor can re-derive and confirm).
- `commit(value, blinding)` / `verifyOpening(c, v, b)` /
  `addCommitments([c1, c2, …])` / `verifyHomomorphicSum(cs, sumV, sumB)`.
- Both scalars reduced mod L before point multiplication so sums
  ≥ L still verify; value=0 case handled cleanly via the explicit
  ristretto255.Point.ZERO additive identity (avoids `multiply(0n)`
  undefined-behaviour in `@noble/curves`).
- `sampleLaplaceFloat(sensitivity, ε)` / `sampleLaplaceInt(...)` —
  inverse-CDF Laplace sampling with cryptographically-secure
  53-bit uniform via `crypto.getRandomValues`; rejects samples at the
  boundary so the log argument is bounded.
- 17 vitest contract tests pin hiding, binding, homomorphic addition,
  cheat-rejection (inflated total, substituted blinding, swapped
  sum-commitment), Laplace ε-calibration (smaller ε ⇒ larger noise
  measured empirically), zero-mean noise, integer-valued sampling,
  H-generator reproducibility from the public label.

EXTENDED: `applications/_shared/aggregate-privacy/` (+200 lines)

- `buildCommittedContribution({podUrl, value, bounds, blindingSeed?})`
  — contributor builds a CommittedContribution: Pedersen commitment +
  bounds the contributor consents to + the plaintext value (held by
  the contributor, revealed once to the aggregator). Self-bounds
  check rejects values outside declared `[min, max]`.
- `buildAttestedHomomorphicSum({cohortIri, aggregatorDid, contributions,
  epsilon, includeAuditFields?})` — aggregator-side: reconstruct
  `trueSum + trueBlinding` from revealed openings; sum commitments
  homomorphically; add DP-Laplace noise (sensitivity = max - min, ε
  from caller); return AttestedHomomorphicSumResult. Bounds invariant
  enforced: every contributor's bounds must match for the sensitivity
  calculation to mean anything.
- `verifyAttestedHomomorphicSum(r)` — auditor-side: structural check
  (sumCommitment == homomorphic sum of contributor commitments) +
  audit-field check (sum opens to claimed trueSum/trueBlinding) +
  consistency check (noisySum == trueSum + noise). Catches: aggregator
  substituting a different sumCommitment, lying about reconstructed
  trueSum, inflating noisySum past consistency with claimed noise.

LIVE wiring in both aggregate queries

- `owm.aggregate_decisions_query` and `lpc.aggregate_cohort_query`
  gain `privacy_mode: 'zk-aggregate'` (the enum value previously
  declared as future-scope; now a real branch). v3 supports
  count-shaped metrics (decision-count, completion-count,
  credential-coverage, competency-threshold-met); throws a clear
  error for distribution-shaped metrics (which still work under v2's
  merkle-attested-opt-in mode). Requires `epsilon` arg; throws if
  unset or non-positive.
- Top-level `privacyMode` on the result advertises the actual path
  taken; the bundle's `homomorphic: AttestedHomomorphicSumResult`
  field is present when v3 was selected.
- The published `value` in v3 mode is the noisy sum, not the
  underlying count (DP-protected by construction).

9 v3 contract tests appended to
`applications/_shared/tests/aggregate-privacy.test.ts`:
- honest bundle accepted with + without audit fields
- aggregator substituting sumCommitment from a different cohort:
  REJECTED
- bundle whose trueSum doesn't open the commitment: REJECTED
- bundle whose noisySum is inconsistent with trueSum + noise:
  REJECTED
- contributor with value outside declared bounds: REJECTED at
  buildCommittedContribution
- contributors disagreeing on bounds (sensitivity invariant):
  REJECTED at buildAttestedHomomorphicSum
- invalid epsilon / sensitivity at verify time: REJECTED

Validation: project-wide `tsc -p tsconfig.json --noEmit` clean; full
vitest suite **1309/1309 passing** (1283 prior + 17 Pedersen + 9
v3 aggregate contract tests).

STATUS.md updated: v3 row moves from "future scope" to "live since
this commit"; remaining-work table replaced with the next-iteration
items (v4 multi-aggregator threshold reveal; v3.1 per-contribution
range proofs paired with the homomorphic sum; v3.1 distribution-
shaped metrics; cumulative ε-budget tracking; second-language
Interego impl for L1 CR advancement).

The aggregate-privacy ladder is now end-to-end:
  v1 'abac'                       → ABAC-bounded count (default)
  v2 'merkle-attested-opt-in'     → verifiable count + opt-in
  v3 'zk-aggregate'               → homomorphic sum + DP noise

All three modes ship in the same affordance signatures; callers pick
their privacy boundary at call time.

---

## 2026-05-16 — Dual-audience verticals fully implemented (operator + institutional + v2 attested-merkle aggregate-privacy + demo)

Closes PM rec #4 (pick verticals + ship to real users) through to
runnable code. The dual-audience design discipline shipped earlier
(`8216374`) named two pilot verticals (learning + OWM) and DECLARED 8
institutional/operator affordances as next-implementer hand-offs.
This pass implements all 8 + ships a v2 upgrade for the aggregate
queries + adds a runnable demo + codifies the v2 contract in vitest.

Implementations (commit `69959f7`):

- `applications/organizational-working-memory/src/operator-publisher.ts` (NEW,
  ~370 lines) — `aggregate_decisions_query`, `project_health_summary`,
  `publish_org_policy`, `publish_compliance_evidence`. Composes
  `discover()` + `publish()` + `src/ops/buildXEvent` + `src/compliance/`;
  no new ontology terms.
- `applications/learner-performer-companion/src/institutional-publisher.ts`
  (NEW, ~420 lines) — `publish_authoritative_content`,
  `issue_cohort_credential_template`, `aggregate_cohort_query`,
  `project_to_lrs`. Composes `publish()` + `discover()` +
  `lrs-adapter/projectDescriptorToLrs`. Honors consent at the LRS
  projection boundary (refuses unless a consent descriptor exists on
  the learner's pod).
- Both bridges' `server.ts` concatenate `<vertical>Affordances` +
  `<vertical>{Operator,Enterprise}Affordances` into one auto-
  registered set + dispatch the new handlers. Tools/list mirrors them.

v2 aggregate-privacy upgrade (this commit):

- New shared module `applications/_shared/aggregate-privacy/` —
  ~250 lines composing existing `src/crypto/zk/` Merkle primitives.
  Exports: `publishCohortParticipation` (learner opts-in by signing
  a CohortParticipation descriptor on their own pod);
  `gatherParticipations` (operator discovers opted-in participants);
  `buildAttestedAggregateResult` + `verifyAttestedAggregateResult`
  (operator returns a tamper-evident Merkle root + per-leaf
  inclusion proofs; auditor re-verifies in O(log n) per leaf).
- Aggregate IRIs are content-addressed on (cohort_iri,
  participant_did) so the operator can derive the expected IRI
  per (cohort, participant) without scanning every descriptor.
- Both `aggregate_*_query` affordances gain a `privacy_mode`
  argument; default `'abac'` (v1 behavior); when set to
  `'merkle-attested-opt-in'` the response includes an
  AttestedAggregateResult bundle. The privacyMode enum on the
  result advertises the v1 → v2 → v3 ladder; v3 (DP-noised
  homomorphic aggregates per `spec/AGGREGATE-PRIVACY.md`) is the
  remaining future scope.
- LPC gains a new learner-side affordance `lpc.opt_into_cohort` —
  the missing bilateral primitive. The institution cannot include a
  learner in a merkle-attested aggregate unless the learner has
  explicitly opted in via this affordance. Revocation = re-publish
  the same descriptor as Counterfactual (auto-supersedes the prior
  Asserted one); `gatherParticipations` filters out non-Asserted.

Test + demo + verification:

- `applications/_shared/tests/aggregate-privacy.test.ts` (NEW, 12
  tests) — pins the v2 contract: content-addressed IRIs are
  deterministic; Merkle root is sort-stable; verifier accepts honest
  bundles and REJECTS each cheat path (count inflation, count
  deflation, inclusion-proof root substitution, leaf tampering).
  12/12 passing.
- `demos/scenarios/24-dual-audience-owm.ts` (NEW, ~240 lines) — runs
  a Contributor agent + an Operator agent against ONE OWM bridge
  against ONE pod. Contributor authors a project, 3 decisions (one
  superseded by a 4th), a follow-up, and 2 notes. Operator runs the
  v2 attested aggregate, project_health_summary, publish_org_policy
  (retention), and publish_compliance_evidence (soc2:CC8.1-cited
  deploy). In-process auditor then verifies the attestation bundle
  AND confirms the cheat-protection works by mutating the count and
  re-verifying. End-to-end proof that the dual-audience surface,
  the v2 attested-merkle path, and the v1 institutional affordances
  all compose against real Claude Code agents.
- `demos/agent-lib.ts` `BridgeSpawnOptions` gains an optional `env`
  field so callers can wire operator-authority DIDs (and other
  conventional env vars) that the per-vertical defaults don't cover.

Validation: project-wide `tsc -p tsconfig.json --noEmit` clean; full
vitest suite 1283/1283 passing (1271 prior + 12 new aggregate-
privacy contract tests).

Where the PM-eval recommendations stand after this pass:

| # | Rec | Status |
|---|---|---|
| 1 | Front-door: one user, one wedge | live (`2b3a857`) |
| 2 | Zero-config `/try` | live + smoke-tested (`bbe960d` / `d123ee6` / `6e6be2c`) |
| 3 | L1 Last Call Working Draft + 12-mo backcompat | shipped (`0fe8ec7`) |
| 4 | Dual-audience verticals + 8 operator affordances + v2 attested-merkle + opt-in primitive + runnable demo | this commit |

The remaining honest future scope: v3 DP-noised homomorphic aggregates
(real crypto work, separate scope) + second-language Interego
implementation to advance L1 from Last Call → Candidate Recommendation
(multi-month, community ask).

---

## 2026-05-16 — L1 protocol → Last Call Working Draft; backcompat committed through 2027-05-16

Promoted the L1 protocol status in [`spec/architecture.md`](spec/architecture.md)
from *Working Draft* to **Last Call Working Draft**, and added
[`spec/STABILITY.md`](spec/STABILITY.md) as the adopter-facing summary
of what's now committed vs. what stays open.

Why now — the audit cadence of the past several weeks is the natural
maturity signal. Recent work has been correctness fixes layered on
existing primitives (the project-wide audit, escape consolidation,
intersection-meet correction, stateless tokens, the `/try`
provisioning endpoint), not new ontology terms or new protocol
capabilities. Layer 1 has reached coherence; the editors are now
hardening, not extending.

What's committed for the 12 months ending 2027-05-16:

- **Wire format frozen.** Turtle / TriG / JSON-LD serializations of
  any conforming descriptor written today will parse identically by
  any v1.x implementation.
- **Vocabulary frozen in `cg:` / `cgh:` / `pgsl:` / `ie:` /
  `align:`.** No removals, renames, or semantic narrowing.
  Additive changes (new optional terms, new optional facets) are
  permitted within v1.x.
- **Composition operator laws frozen.** `union` / `intersection` /
  `restriction` / `override` (and the lattice properties they
  satisfy) are normative.
- **Modal-truth invariants frozen.** The
  Asserted/Quoted/Hypothetical/Counterfactual/Retracted correspondence
  to `cg:groundTruth` is the L1 contract.
- **Conformance-level partition frozen.** L1 / L2 / L3 / L4 categories
  are fixed; tests may be added within a level.

Explicitly NOT in the L1 commitment (separate cadences, documented in
`STABILITY.md`): reference-implementation npm versions, L2 patterns
(`abac:` / `registry:` / `passport:` / `hyprcat:` / `hypragent:`), L3
ontologies (`hela:` / `sat:` / `cts:` / `olke:` / `amta:` / `code:` /
`eu-ai-act:` / `nist-rmf:` / `soc2:`), verticals, deployment topology,
and the regulator-owned control sets the compliance mappings track.

Forward path to **Candidate Recommendation** is documented and
gated: (a) two independent interoperable implementations passing the
L1 conformance fixtures, (b) a 30-day review window. Neither has
occurred yet; second implementations in any language are warmly
welcomed via the issue tracker. The conformance runner at
[`spec/conformance/runner.mjs`](spec/conformance/runner.mjs) is
intentionally dependency-free so any second implementation can validate
without a SHACL engine.

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
(pluggable), all with an injectable `fetch`; a runnable offline demo
(`examples/demo-name-service.mjs`); and two follow-on pieces —

- **`resolveIdentifier` TN tier** (`5fac93d`) — `resolveName` is now a
  tier of the unified identifier resolver. `resolveIdentifier(id,
  { naming })` populates `kind: 'name'` + `nameCandidates` (the full
  ranked set — a name is trust-relative) and mirrors the top
  candidate's `subject` into `webId` for single-answer callers.
  `naming/index.ts` imports from source modules (not the barrel) to
  keep the new `discovery → naming` edge cycle-free.
- **`@alice` host-free form** (`f2475aa`) — a leading `@` is a
  syntactic marker, like `did:` / `acct:`: `detectKind` recognizes
  `@alice` as `kind: 'name'`, so `resolveIdentifier` auto-runs the TN
  tier for it (a *bare* `alice` stays `unknown` and needs the opt-in
  `naming` flag). `resolveName` strips a leading `@`.

21 tests. **No new L1/L2 ontology terms** — `foaf:nick` is W3C FOAF;
L2 pattern, sibling of `registry:` / `passport:`.

## 2026-05-15 — Project-wide audit pass: 13 fixes across crypto / federation / substrate / MCP

A four-reviewer parallel audit covered crypto + identity, federation + RDF
I/O, substrate core (composition, validation, PGSL, compliance), and the
MCP + integrations + verticals surfaces. Of 17 raw findings, 3 turned out
to be reviewer false alarms (the corresponding code was already correct
or the rule had been misread), 1 was a clarifying-doc-only item, and 13
landed as code changes. Two patterns ran throughout: **make the safe
thing the default**, and **compose existing primitives instead of letting
helpers fork**.

### Correctness regressions caught + fixed

- **Turtle literal escape consolidated** (`82bb5bd`) — six places had
  their own escape helper (`escapeTurtle` / `escapeLit` /
  `escapeForTurtle` / `escapeLiteral` / two `escapeMulti`s + an inline
  `.replace`), each covering a different subset of `\\` / `"` / `\n` /
  `\r` / `\t`. The directory.ts pair shipped in [`bf171e6`](#)
  covered only `\\` and `"` while its inverse decoded all five — a
  nick with a control char produced malformed Turtle. New
  [`src/rdf/escape.ts`](src/rdf/escape.ts) is the single source of
  truth; all six call sites route through it. Adversarial round-trip
  test pins the regression in `tests/naming.test.ts`.
- **`intersection()` is the meet again** (`d443596`) — when
  `commonGraphs` was empty, the operator fell back to
  `allDescribedGraphs([d1, d2])` (the union), violating
  `d1 ∧ d2 ≤ d1`. Now returns the empty set, which is the correct
  meet. Regression test added with disjoint described-sets.

### Identity + auth hardening

- **Bootstrap-invite verify is constant-time** (`6f2cf96`) —
  `crypto.timingSafeEqual` on equal-length buffers, length-mismatch
  short-circuits. Closes a timing channel that could enumerate the
  single-use seeded-userId gate.
- **WebAuthn counter persistence respects clone-detection** (`6f2cf96`)
  — counter is captured, advanced in memory, persisted; on persist
  failure the in-memory value is rolled back AND the request returns
  503 so the client retries. The previous catch-and-warn path silently
  defeated WebAuthn §6.1.1 cloned-authenticator detection.
- **WebAuthn rpID allowlist fallback warns once per misconfig**
  (`6f2cf96`) — a browser Origin not on `WEBAUTHN_RP_ORIGINS` no
  longer silently uses the static `RP_ID`; the operator gets one
  warning per distinct Origin so the misconfig is visible before users
  hit the "rpID is not a registrable suffix" error.
- **DID-userId derivation is global by design — documented in code**
  (`6f2cf96`) — the auditor flagged "same DID, two pods, two userIds"
  as a federation bug, but the rule is actually the opposite: userId
  IS deterministic from the credential / wallet / DID; per-pod checks
  prevent enrolling the same credential twice on the same pod, not
  enrolling on a second pod. A pod-scoped userId would re-centralize
  the namespace. Source comment now states this explicitly.

### Compliance discipline

- **Framework-report status is bi-modal** (`94830c0`) — dropped the
  arbitrary "exactly one evidence → partial" rule from the default
  aggregation policy. One signed audit record fully satisfies a
  control; callers who genuinely need an N-evidence threshold derive
  status from `evidenceCount` themselves. The `'partial'` literal
  survives in the type for custom `AggregationPolicy` implementations.
- **Compliance overlay removes the `'allow'` screening bypass**
  (`19861f8`) — compliance evidence is the highest-stakes surface and
  cannot opt out of `screenForSensitiveContent`. Pre-screening
  pipelines should sanitize args before calling
  `buildAgentActionDescriptor`. Test pins the throw-on-HIGH behavior.
- **Wallet-rotation temporal verification** (no change needed) — the
  reviewer asked for it; [`listValidSignerAddressesAt`](src/compliance/index.ts)
  already provides exactly that bounded predicate. The unbounded
  variant survives for internal-audit walks.

### Crypto layered defense + SIWE pin

- **Optional `expectedSenderPublicKey` on decrypt** (`2a21cdf`) —
  `decryptFacetValue` and `resolveAtomValue` gain an optional
  expected-sender param. NaCl box.open authenticates an envelope but
  takes the sender pubkey from the envelope itself; passing the
  expected sender narrows the trusted-sender set from "anyone who knew
  the recipient's pubkey" to "exactly this sender." Layered defense —
  the primary integrity guarantee remains pod-write ACL +
  content-addressing.
- **SIWE format-stability regression test** (`2a21cdf`) —
  `formatSiweMessage` is now pinned byte-for-byte against a fixed
  input including Resources. A stylistic refactor that drifts the
  bytes would silently invalidate every prior signature; the test
  guards against that.

### Principled-call: modal status default

- **`publish-preprocess` defaults to `Hypothetical`** (`a1c9837`) — the
  MCP server's own published guidance to agents is explicit
  (*"don't drift to 'Asserted for safety'... USE Hypothetical DEFAULT
  for inferences"*), but `normalizePublishInputs` defaulted to
  `Asserted`. Substrate vs. guidance drifted. Flipped:
  `modalStatus ?? 'Hypothetical'`, paired confidence default
  `0.85 → 0.7` (high enough not to be ignored, low enough that the
  affordance engine's `Hypothetical with confidence ≥ 0.8` gate still
  blocks auto-apply on inferred claims). Compliance and
  human-verified callers set `Asserted` explicitly via their builders
  and are unaffected. Affordance-engine *consumption* of a descriptor
  missing the semiotic facet keeps the L1 default (`Asserted`); the
  rule is about authoring, not interpreting stored content.
- **`share_with` schema text emphasizes owner-only default**
  (`a1c9837`) — the implementation has always been owner-only when
  the field is omitted; the schema description now says so explicitly
  so an LLM reading the tool doesn't infer sharing is opt-out.

### False alarms (verified, no fix needed)

- Modal-status default `'Asserted'` in `src/affordance/compute.ts:293`
  was flagged as drift but is the L1 spec default for *consuming* a
  descriptor with no explicit modalStatus — the "Hypothetical default"
  rule is about *authoring*, not interpretation.
- Subscription slot leak on `subscribe_to_pod` failure: `setSubscription`
  is already called *after* the awaited `subscribe()` resolves, so a
  thrown subscribe never consumes a slot.
- Wallet-rotation history "append-only forever": addressed by
  `listValidSignerAddressesAt` already shipped.

Suite: **1271 passed / 29 skipped / 0 failed**; type-check clean;
ontology-lint clean.

## 2026-05-15 — Name service: pod-directory `name → did` index

Closes the last deferred item from the 2026-05-14 name-service entry —
a federation hint that lets a resolver narrow which pods it walks for a
given name.

- **`PodDirectoryEntry.ownerNicks` — schema decision recorded.** The
  question was "new directory predicate, or reuse a W3C term?" The
  resolution is to reuse `foaf:nick` (the same predicate the
  underlying attestation graph uses) and serialize it as plain top-level
  `<owner> foaf:nick "name"` triples in the directory document. The
  directory hint is then literally a projection of the attestations —
  re-derivable, never authoritative. No new ontology term in any
  `cg:` / `cgh:` / pattern namespace.
- **`directoryNameIndex(directories)` materializes a
  `lowercase-name → NameHint[]` map** across one or more pod
  directories. `NameHint` carries the directory ID for provenance.
- **`resolveName(name, config, { directories })` narrows the pod walk**
  to those advertising the queried name; `namesFor(subject, …)` narrows
  reverse-lookup the analogous way. Stale-hint safety: when no hint
  matches, the resolver falls through to the full `pods` list. The
  caller's own `config.podUrl` stays in the walk as a safety net so a
  local-only attestation is never missed.
- 28 naming tests (7 new) — round-trip, `directoryNameIndex` building,
  forward narrowing, stale-hint fallback, local-pod safety net, reverse
  narrowing. Federation tests (24) still pass; type-check + ontology-lint
  clean.
- Honest record: `docs/ns/naming.ttl` is **not** being added — the
  binding is plain `foaf:nick`, the directory hint reuses the same
  predicate, and nothing in the runtime references a `naming:` term.
  The absence is the design (the design note now records this; the
  prior deferred-list bullet for it has been removed).

### Deploy reliability — diagnosable + reproducible + rate-limit-resilient ACR builds

The Azure deploy workflow was intermittently failing the
`interego-identity` / `interego-pgsl-browser` image builds with a
generic `RunStatus.FAILED` and no detail.

- **`--no-logs` removed** (`44df8cc`) — the workflow ran `az acr build
  --no-logs`, which suppressed the actual build output. With it gone,
  the real error was immediately visible: `Step 1/N : FROM node:20-slim
  → toomanyrequests` — Docker Hub's anonymous pull rate limit on the
  egress IP that ACR build agents share. Never a code problem (a local
  repro of the exact Dockerfile build — fresh `npm ci` + `tsc` — passes
  clean).
- **Retry loop** (`303c277`) — `az acr build` is wrapped in a 3-attempt
  retry with 120 s backoff. Each invocation gets a fresh build agent
  (often a different egress IP), so a retry clears the intermittent
  limit. Kept as defense-in-depth.
- **`az acr import` dead end** (`cd043f0`, `32e94d8` — superseded) — the
  first durable-fix attempt added a `prime-base-images` job that
  `az acr import`ed `node:20-slim` into our own ACR so the build matrix
  could `FROM` it there. It does not work: **ACR's import pulls from
  Docker Hub anonymously too**, so it hit the identical `429
  TOOMANYREQUESTS` (proven in run `25879991403`'s logs). `cd043f0` also
  made it a SPOF — the matrix strictly `needs:` the prime job, so the
  failed import skipped the whole deploy; `32e94d8` reduced that to
  best-effort (fall back to a direct Docker Hub pull). Both are
  superseded by the ECR Public fix below.
- **Durable fix — base image from AWS ECR Public** (`161e576`) — the
  real fix is to stop pulling from Docker Hub at all. AWS ECR Public
  Gallery mirrors the Docker official images at
  `public.ecr.aws/docker/library/node:20-slim` — a different registry
  with far more generous anonymous limits (path + tag verified to
  resolve before committing). The `prime-base-images` job is removed
  entirely; `az acr build` passes
  `--build-arg NODE_BASE=public.ecr.aws/docker/library/node:20-slim`.
  All six Dockerfiles keep `ARG NODE_BASE=node:20-slim` as the default,
  so a local `docker build` still uses Docker Hub — only CI is
  redirected. No Docker Hub credential / GitHub secret required.
- **Reproducible installs** (`44df8cc`, `303c277`) — `Dockerfile.identity`
  and `Dockerfile.validator` copied only `package.json` and ran
  `npm install`, re-resolving caret ranges on every build. Both now copy
  `package-lock.json` and run `npm ci`.

### Fixes

- **Relay hostname** (`a0ec397`) — the Hermes plugin + the identity
  server's `RELAY_URL` default were written against a non-existent
  `interego-mcp-relay` host (an invented `mcp-` segment); the real
  Azure Container App is `interego-relay`. Corrected — left as-is the
  Hermes provider would have failed out of the box.
- **CI: Actions off the deprecated Node 20 runtime** (`c93f003`,
  `ccee717`) — the deploy logs flagged `actions/checkout@v4` (+
  same-class `setup-node@v4`, `upload-artifact@v4`) running on Node 20,
  which GitHub force-migrates 2026-06-02 and removes 2026-09-16. Bumped
  across all four workflows to the current majors (`checkout@v6`,
  `setup-node@v6`, `upload-artifact@v7`); a follow-up pass caught
  `azure/login@v2` in the same deprecation class and bumped it to `@v3`.
  Verified via the releases API; zero breaking-change surface (the
  inputs in use are stable).

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
