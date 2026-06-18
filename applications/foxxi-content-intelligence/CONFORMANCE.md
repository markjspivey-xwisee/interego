# Foxxi conformance map — IEEE / ADL / 1EdTech learning-technology standards

How the Foxxi vertical maps to (or extends, or wraps) the standards in
the ADL Total Learning Architecture (TLA), IEEE 1484.x family, and
1EdTech (formerly IMS Global) catalog. Every row cites the source file
that implements the mapping so you can verify the claim directly.

Layering reminder: standards-conformant behavior lives in the
**vertical** (this directory) + the **substrate's L3 reusable
primitives** (`applications/_shared/`, `src/`). The L1 protocol
(`cg:`, `cgh:`, `pgsl:`, `ie:`, `align:`) stays technology-neutral —
no SCORM/xAPI/LOM terms leak into it.

---

## Pluggability — anyone can swap in their own systems

This vertical is built to be layered into existing infrastructure, not
to replace it. Three axes of pluggability:

| Axis | Env var / surface | Options |
|---|---|---|
| **Statement storage** | `FOXXI_LRS_BACKEND` | `memory` (default; in-process Map) · `file:/path/to/dir` (append-only JSONL; survives restart) · `forward:<endpoint>\|\|<user>\|\|<password>[\|\|<version>]` (treat an external LRS — Watershed / SCORM Cloud / Yet Analytics / Veracity / Learning Locker — as source-of-truth; Foxxi keeps a local read-through cache for the dashboard). [`src/statement-store.ts`](src/statement-store.ts) |
| **xAPI Profile** | `FOXXI_XAPI_PROFILE_URL` | If set, Foxxi's `/xapi/profile` serves the document fetched from that URL instead of the built-in Foxxi profile. 5-min process-local cache; falls through to built-in if upstream unreachable. Tenants who already have a profile published can flip the env and ship. |
| **Statement forwarding** | `FOXXI_LRS_FORWARDING_TARGETS` | Comma-separated `endpoint\|\|user:pass\|\|version` triples; every accepted statement fans out asynchronously per xAPI §10. Use alongside the storage backend (e.g. `memory` + forwarding for a fast read-through cache + 1+ canonical archives). |
| **Auth** | Bearer (wallet-signed session tokens) · Basic (`FOXXI_LRS_BASIC_AUTH_PAIRS`) · OAuth 2.0 client_credentials (`FOXXI_LRS_OAUTH_CLIENTS`; tokens signed with the LTI ES256 key) | Pick one or several; the LRS auth gate accepts all simultaneously. |
| **LMS integrations** | `FOXXI_LTI_PLATFORMS` (LTI 1.3) · `/ims/oneroster/v1p2/*` (OneRoster 1.2) · `/xapi/*` (xAPI 2.0) · `/xapi/statements` outbound forwarding · SCORM 2004 RTE inside the player | Compose whichever surface your existing stack speaks. |
| **Course content** | Drop a SCORM 2004 or SCORM 1.2 package into the player's static directory — the dual-spec RTE picks up either API discovery path. | The bundled Golf Explained sample is a single SCO; any conformant package replaces it without code changes. |

The intent: a deployment can stay 100% Foxxi (all five surfaces, all
storage local), use Foxxi only as a read-through cache for an existing
LRS (`forward:` backend), use Foxxi only for its xAPI Profile +
Statement vocabulary (forward to your real LRS, set
`FOXXI_LRS_BACKEND=forward:…`), or anything in between.

## Conformance smoke

Foxxi ships an executable conformance check that exercises every xAPI
2.0 endpoint against expected behavior per IEEE 9274.1.1:

```bash
FOXXI_BRIDGE_URL=https://your-bridge.example \
  npx tsx applications/foxxi-content-intelligence/tools/xapi-conformance-smoke.mjs
```

The CLI is a thin wrapper over the shared runner `src/compliance-runner.ts`
(`runXapiConformance`) — the same code the bridge's `GET /compliance/xapi/run`
endpoint and the public **Compliance** microsite run, so there is one source of
truth for the checks. Run it live yourself from the microsite, no clone required.

26 checks covering: §3.1 version negotiation, §4.1 statement POST +
required fields, §4.1.1 immutability (idempotent re-POST + 409 on
divergent body), §4.1.7 voiding, §4.2 filtered queries + paginated
cursor, §6.3 ETag / If-Match / If-None-Match concurrency, §7.7 /about,
xAPI Profile Spec 2017 document shape. Exit code 0 on full pass.

Last run against the live deployment: **26 / 26 pass.**

## 0. xAPI version conformance

Foxxi-as-LRS defaults to **xAPI 2.0.0** (IEEE 9274.1.1). Clients that
send `X-Experience-API-Version: 1.0.3` get backward-compatible handling;
clients that send no header are served as 2.0. The actual default behavior:

- `negotiateVersion()` in [`src/xapi-lrs.ts`](src/xapi-lrs.ts) returns
  `'2.0.0'` when the header is absent.
- `ensureStatementFields()` stamps every accepted statement with
  `version: '2.0.0'`, `actor.objectType` (Agent / Group), and
  `object.objectType: 'Activity'` so the statement is conformant whether
  or not the upstream client set them.
- The bridge's instrumentation emitter ([`src/xapi-instrumentation.ts`](src/xapi-instrumentation.ts))
  stamps `id` as a UUID v4 and `version: '2.0.0'` on every internally
  generated statement.
- The course player ([`deploy/foxxi-scorm-player/site/player.js`](../../deploy/foxxi-scorm-player/site/player.js))
  sends `X-Experience-API-Version: 2.0.0` and stamps statements with
  the version field explicitly.

xAPI 1.0.3 is **accepted but not the default** — Foxxi forwards to legacy
LRSes (SCORM Cloud is 1.0.3-only) at the version they negotiate, but
inbound and self-emitted statements are 2.0.0.

## 1. Content packaging — ADL SCORM 1.2 / 2004

| Standard requirement | Status | Where |
|---|---|---|
| Parse `imsmanifest.xml` (organizations / items / resources) | **Compliant** | [`imported/foxxi_storyline_parser_v03.py`](imported/foxxi_storyline_parser_v03.py) + [`applications/_shared/scorm/index.ts`](../_shared/scorm/index.ts) |
| Detect SCORM 1.2 vs 2004 via `adlcp_rootv1pX` namespace | **Compliant** | [`applications/_shared/scorm/index.ts`](../_shared/scorm/index.ts) (`unwrapScormPackage`) |
| Surface SCO / Asset / Resource as RDF types | **Compliant** | [`ns/foxxi-content-graph-v0.2.ttl`](ns/foxxi-content-graph-v0.2.ttl) `fxs:SCO`, `fxs:Resource`, `fxs:Asset` |
| Preserve manifest identifiers + organization tree | **Compliant** | `fxs:identifiedBy`, `fxs:hasOrganization`, `fxs:hasItem`, `fxs:hasChild` |
| Track standard conformance per package | **Compliant** | `fxs:standardConformance fxs:SCORM_2004_4` (etc.) |
| Extract `<sequencing>` rules | **Compliant** | [`src/lom-sequencing.ts`](src/lom-sequencing.ts) `sequencingRulesToTurtle()` — emits `fxs:SequencingRule` instances with `fxs:expression` carrying the verbatim rule XML for downstream LMS replay |
| Implement SCORM 2004 4th Ed CMI runtime API (IEEE 1484.11.2) | **Compliant** | [`deploy/foxxi-scorm-player/site/scorm-rte.js`](../../deploy/foxxi-scorm-player/site/scorm-rte.js) installs `window.API_1484_11` at the player parent so any uploaded SCO can do the canonical API-discovery walk and hook into a working CMI store. Implements the full 8-function API surface (Initialize / Terminate / GetValue / SetValue / Commit / GetLastError / GetErrorString / GetDiagnostic) with the SCORM 2004 §5.3.4 error-code table. Extended CMI data-model (4th Ed §4.2): completion_status / success_status / score.{scaled,raw,min,max} / progress_measure / location / session_time / total_time / suspend_data (with §4.2.27.2 64 KB enforcement) / learner_id / learner_name / launch_data / max_time_allowed / time_limit_action / interactions.n.{id, type, objectives.n.id, timestamp, correct_responses.n.pattern, weighting, learner_response, result, latency} / objectives.n.{id, score.*, success_status, completion_status, description}. Read-only fields per §4.2 are enforced (error 404). |
| Implement SCORM 1.2 CMI runtime API (ADL CMI001) | **Compliant** | Same module installs `window.API` (no `_1484_11` suffix) for SCORM 1.2 SCOs. Full 8-function `LMS*`-prefixed API (LMSInitialize / LMSFinish / LMSGetValue / LMSSetValue / LMSCommit / LMSGetLastError / LMSGetErrorString / LMSGetDiagnostic) with the SCORM 1.2 error-code table. cmi.core.* model: student_id / student_name / lesson_location / credit / lesson_status / entry / score.{raw,min,max} / total_time / lesson_mode / exit / session_time, plus suspend_data (4096-char max per §5.5.2), launch_data, comments / comments_from_lms, student_data.{mastery_score, max_time_allowed, time_limit_action}, student_preference.{audio, language, speed, text}, objectives.n.{id, score, status}, interactions.n.{id, objectives, time, type, correct_responses, weighting, student_response, result, latency}. |
| **CMI → xAPI cmi5 auto-translation on Commit / Terminate** | **Compliant** | Same module. When the SCO calls `Commit('')` or `Terminate('')`, the RTE inspects current CMI state and emits the corresponding cmi5 verb statements (`completed` / `passed` / `failed` / `terminated`) to Foxxi-as-LRS — `result.score` filled from `cmi.score.*`, `result.duration` from session elapsed, interactions exported as a context extension. Any SCORM package automatically gets xAPI cmi5 emission without authoring changes. |

## 2. xAPI — ADL Experience API / IEEE 9274.1.1

| Standard requirement | Status | Where |
|---|---|---|
| xAPI 1.0.3 + 2.0.0 statement ingest (actor / verb / object / result / context / timestamp) | **Compliant** | [`applications/lrs-adapter/src/pod-publisher.ts`](../lrs-adapter/src/pod-publisher.ts) — `publishIngestedStatement()` |
| Statement projection — descriptor → xAPI Statement → LRS POST | **Compliant** | [`applications/lrs-adapter/src/pod-publisher.ts`](../lrs-adapter/src/pod-publisher.ts) — `projectDescriptorToLrs()` |
| **Foxxi-as-LRS — inbound resource surface** (`/xapi/about`, `/xapi/statements` GET/POST/PUT, `/xapi/activities/state`, `/xapi/activities/profile`, `/xapi/agents/profile`, `/xapi/activities`, `/xapi/agents`) | **Compliant** | [`src/xapi-lrs.ts`](src/xapi-lrs.ts) — `attachXapiLrsRoutes()` mounted on the bridge; Basic + Bearer auth; X-Experience-API-Version negotiated; statement-id conflict (409) + voiding semantics (404 on voided) per xAPI §4.1.1 |
| **Statement Forwarding** (xAPI §10) | **Compliant** | `FOXXI_LRS_FORWARDING_TARGETS` env var — comma-separated `endpoint\|\|user:pass\|\|version` triples; every accepted statement fans out asynchronously |
| LRS client — write to external LRSs with version negotiation | **Compliant** | [`applications/lrs-adapter/src/lrs-client.ts`](../lrs-adapter/src/lrs-client.ts) — tested live against Lrsql, SCORM Cloud, Watershed |
| Modal-status filter on projection (Asserted only) | **Compliant** | Modal-truth invariant from L1; non-Asserted descriptors don't leak through |
| **Statement immutability** (xAPI 2.0 §4.1.1) | **Compliant** | Re-POSTing a UUID with a different body returns 409; identical body is idempotent. Delegated to the `StatementStore.put` interface — all 3 implementations enforce it. |
| **xAPI 2.0 paginated `more` cursor** (§4.2) | **Compliant** | Continuation tokens are base64url-encoded `{offset, ts}` records the LRS hands back via the `more` field; the client passes back via `?continuationToken=...`. Real pagination — `since=<stored>` query-string stubs replaced. |
| **Sub-statements + Anonymous Group actors** (§4.1.4.1, §4.1.2.2) | **Compliant** | `ensureStatementFields` normalises actor.objectType to `Group` when `member` is present, recurses one level into sub-statements per §4.1.4.1 (which forbids further nesting). |
| **`multipart/mixed` attachments tolerance** (§4.1.11) | **Compliant** | POST with `Content-Type: multipart/mixed; boundary=...` is parsed via RFC 2046 §5.1.1 boundary handling; the first `application/json` part is extracted as the statement body. Attachment binary parts are passed-through by reference via the statement's own `attachments[]` descriptors. |
| **State + Profile ETag / If-Match / If-None-Match** (§6.3.2 / §6.3.3) | **Compliant** | `/xapi/activities/state`, `/xapi/activities/profile`, `/xapi/agents/profile` all support: ETag header on PUT/GET responses; `If-None-Match: <etag>` → 304 on GET; `If-Match: <etag>` → 412 on PUT/DELETE if doesn't match; `If-None-Match: *` → 412 on PUT if document exists. |
| **OAuth 2.0 client_credentials token endpoint** (xAPI 2.0 §6.4) | **Compliant** | `POST /xapi/oauth/token` with `grant_type=client_credentials&client_id=...&client_secret=...` returns an ES256 JWT signed by the same key published at `/lti/.well-known/jwks.json`. Clients registered via `FOXXI_LRS_OAUTH_CLIENTS=clientId:secret:scope,...`; tokens are accepted as `Authorization: Bearer ...` on every `/xapi/*` route alongside Basic + wallet-signed session tokens. |
| **xAPI Profile (vocabulary publication)** | **Compliant** | `GET /xapi/profile` — full ADL xAPI Profile Specification 2017 document (JSON-LD, `@context: https://w3id.org/xapi/profiles/context`) with three principal sections: (a) **Concepts** — 20 Verbs (cmi5 subset + Foxxi extensions `scene-completed`, `asked`, `retrieved`, `enrolled`, `credentialed`, `wallet-exported`, `framework-aligned`, `policy-decided`, `affordance-invoked`), 8 ActivityTypes (course / lesson / assessment + Foxxi `scene`, `concept-graph-node`, `credential`, `framework`, `affordance`), 10 ContextExtensions; (b) **Statement Templates** — 12 shapes with mandatory + recommended property rules per §5; (c) **Patterns** — 6 patterns including the primary `course-session` (launched → initialized → learn-stream+ → completion-outcome → terminated) and `credentialing` (passed → credentialed) per §6.3. Source: [`src/xapi-profile.ts`](src/xapi-profile.ts) |
| **Granular bridge-handler instrumentation** | **Compliant** | [`src/xapi-instrumentation.ts`](src/xapi-instrumentation.ts) — every affordance call lands as one xAPI statement at the LRS, mapped to the most specific Foxxi-Profile verb (e.g. `ask_course_question_agentic` → `foxxi:asked`, `issue_completion_credential` → `foxxi:credentialed`) with fallback to the generic `foxxi:affordance-invoked` envelope. Captures actor / verb / object / result.success / duration / call extensions (`affordanceTool`, `callerRole`, `error`). Handler errors are tolerated — instrumentation never blocks the response path. |
| **Playable demo course → live xAPI** | **Compliant** | [`deploy/foxxi-scorm-player/`](../../deploy/foxxi-scorm-player/) — separate Container App `interego-foxxi-scorm-player` serving the extracted SCORM 2004 3rd Ed "Golf Explained" Single SCO package + a Foxxi-native course player ([`player.js`](../../deploy/foxxi-scorm-player/site/player.js)) that walks the 14 slides, tracks viewed-set + scene-completion, and POSTs xAPI statements to the bridge LRS at launch / initialize / slide-view / scene-completed / completed / passed / terminated. Conforms to Foxxi's published `course-session` pattern. |
| **LRS-admin dashboard** | **Compliant** | [`dashboard-app/src/components/LrsAdminPanel.tsx`](dashboard-app/src/components/LrsAdminPanel.tsx) — gated by admin or learning-engineer role; four tabs (Statement browser with verb/actor filters + live auto-refresh + full JSON envelope view, Aggregates with top-N verbs/activities/actors + hourly volume sparkline, Profile-conformance rate + out-of-profile verb detection, LRS Config showing endpoints + basic-auth keys + forwarding targets + retention). Surfaced on AdminShell as the "xAPI / LRS" tab, plus on LearnerShell as a card for users with the `learning-engineering` audience tag (matches the ICICLE "data-informed decision making" leg of the Learning Engineer role). Backed by `/xapi/admin/{statements, aggregates, conformance, config}` on the bridge ([`src/xapi-admin.ts`](src/xapi-admin.ts)). |
| Signed Statements (RFC 7515 JWS attachment) | **Partial** | Tool keys present via LTI 1.3 ES256 JWS plumbing ([`src/lti13.ts`](src/lti13.ts) `jwsSignEs256()`); attaching as `attachments[].usageType=signature` over statement bodies is a small additional wiring step |

## 3. cmi5 — IEEE 9274.2.1

| Standard requirement | Status | Where |
|---|---|---|
| AU (Assignable Unit) detection | **Compliant** | [`applications/_shared/scorm/index.ts`](../_shared/scorm/index.ts) (extracts `<au>` from `cmi5.xml`) |
| `fxs:AssignableUnit` as RDF type | **Compliant** | [`ns/foxxi-content-graph-v0.2.ttl`](ns/foxxi-content-graph-v0.2.ttl) |
| 9 cmi5 statement profiles (launched / initialized / completed / passed / failed / abandoned / waived / terminated / satisfied) | **Compliant** | [`src/cmi5.ts`](src/cmi5.ts) — `buildCmi5Statement(verb)` covers all 9; `buildPassedSessionTrace()` emits a full lifecycle trace; `foxxi.emit_cmi5_session` affordance dispatches |
| Context category tag (`cmi5/context/categories/cmi5`) | **Compliant** | Built into every statement by `buildCmi5Statement`; moveOn category added for `satisfied` / `waived` per §10 |
| Session / moveOn / mastery semantics | **Compliant** | `evaluateMoveOn()` implements §11 — applies `Passed / Completed / CompletedAndPassed / CompletedOrPassed / NotApplicable` rules against the learner's score + mastery threshold |

## 4. IEEE LOM 1484.12.1 — Learning Object Metadata

| LOM category | Status | Where |
|---|---|---|
| General (title, identifier, language, description) | **Compliant** | `dcterms:title`, `dcterms:identifier`, `dcterms:language` on `fxs:Package` |
| Technical (duration, format, version) | **Partial** | `schema:duration`, `schema:softwareVersion`; format/size not auto-extracted |
| Educational (typical learning time, context, difficulty, learning resource type) | **Compliant** | [`src/lom-sequencing.ts`](src/lom-sequencing.ts) `lomToTurtle()` emits IEEE LOM namespace triples for every §5 field (interactivityType, learningResourceType, interactivityLevel, semanticDensity, intendedEndUserRole, context, difficulty, typicalLearningTime, educationalDescription, educationalLanguage) |
| Lifecycle (status, version, contribute) | **Compliant** | `lomToTurtle()` §2 — status / version / contribute (role, entity, date) emitted with proper LOM IRIs |
| Rights (cost, copyright, description) | **Compliant** | `lomToTurtle()` §6 |
| Relation, Classification | **Compliant** | `lomToTurtle()` §7 + §9 (purpose: discipline / educationalObjective / competency / etc.) |
| Annotation, Meta-Metadata | **Schema-supported (lifted when present in source manifest)** | Categories tracked by the LOM type but rarely populated by authoring tools; lifter passes through whatever the manifest carries |

## 5. IEEE 1484.20.1 RDCEO / 1484.20.2 RCD — Reusable Competency Definitions

| Standard requirement | Status | Where |
|---|---|---|
| Formal competency definitions (statement, scope, mastery) | **Compliant via L2 mapping** | [`ns/rcd.ttl`](ns/rcd.ttl) declares `rcd:CompetencyDefinition` (subclass of `fxk:Skill`) with `rcd:statement`, `rcd:scope`, `rcd:masteryRubric` |
| Five-rung proficiency scale (Novice / Beginner / Intermediate / Advanced / Expert) | **Compliant** | [`ns/rcd.ttl`](ns/rcd.ttl) declares individuals `rcd:Novice` … `rcd:Expert` with `rdf:value 1..5` |
| Framework membership (`fromFramework`) | **Compliant** | `fxk:fromFramework`, `fxk:caseFrameworkRef` |
| Skill prerequisite + develops semantics | **Compliant** | `fxk:requiresSkill`, `fxk:developsSkill` |

## 6. 1EdTech CASE 1.0 — Competencies + Academic Standards Exchange

| Standard requirement | Status | Where |
|---|---|---|
| Export a competency framework as CASE 1.0 JSON-LD | **Compliant** | [`src/case-exporter.ts`](src/case-exporter.ts) — `frameworkToCase(framework)` |
| CFDocument / CFItem / CFAssociation shapes | **Compliant** | Exported per spec |
| `isPrerequisiteOf` associations from `fxk:prerequisiteOf` | **Compliant** | Walked during export |
| RDCEO mastery rubric → CASE CFRubric / CFRubricCriterion / CFRubricCriterionLevel | **Compliant** | Auto-generated when any skill carries an RDCEO `proficiencyLevel` |
| Affordance: `foxxi.export_case_framework` | **Compliant** | [`affordances.ts`](affordances.ts) + bridge handler |

## 7. ADL CaSS — Competency & Skills System

| Standard requirement | Status | Where |
|---|---|---|
| Push framework to CaSS (`POST /api/framework`) | **Compliant** | [`src/cass-connector.ts`](src/cass-connector.ts) `pushFrameworkToCass()` + `foxxi.push_to_cass` affordance |
| Push competency assertion to CaSS (`POST /api/assertion`) | **Compliant** | `pushAssertionToCass()` exported (no bridge affordance yet — assertion emission lives upstream in the credentialing flow; CaSS-side assertions can be added with the same one-line connector) |

## 8. W3C Verifiable Credentials Data Model 2.0

| Standard requirement | Status | Where |
|---|---|---|
| vc-jwt (EdDSA JWS encoding per VC DM 2.0 §6.3) | **Compliant** | [`applications/_shared/vc-jwt/index.ts`](../_shared/vc-jwt/index.ts) |
| Data Integrity Proofs (cryptosuite `eddsa-jcs-2022`) | **Compliant** | [`applications/_shared/vc-jwt/data-integrity-jcs.ts`](../_shared/vc-jwt/data-integrity-jcs.ts) |
| `eddsa-rdfc-2022` (URDNA2015 canonicalization) | **Compliant** | [`applications/_shared/vc-jwt/data-integrity-rdfc.ts`](../_shared/vc-jwt/data-integrity-rdfc.ts) — JSON-LD expand → N-Quads → URDNA2015 canonicalize → SHA-256 → Ed25519 (composes `jsonld` + `rdf-canonize` + `@noble/curves/ed25519`) |
| BBS+ selective disclosure (`bbs-2023`) | **Compliant** | [`applications/_shared/vc-jwt/bbs-2023.ts`](../_shared/vc-jwt/bbs-2023.ts) — full sign / verify / deriveProof / verifyProof via `@digitalbazaar/bbs-signatures` (BLS12-381 SHA-256 ciphersuite); `flattenCredentialSubject()` helper produces a stable message list from a VC's claims |
| W3C-compliant credential round-trip verification | **Compliant** | `verifyDataIntegrityProof()` self-checks the issued VC before publish |

## 9. W3C Decentralized Identifiers (DIDs)

| DID method | Status | Where |
|---|---|---|
| `did:key` (Ed25519) | **Compliant** | [`applications/_shared/vc-jwt/index.ts`](../_shared/vc-jwt/index.ts) — generation + decoding |
| `did:web` | **Compliant** | [`src/solid/did-resolver.ts`](../../../src/solid/did-resolver.ts) — HTTPS fetch of `.well-known/did.json` (or `/<path>/did.json` per spec), parses verificationMethod, returns full DID document. Per-DID URL derivation per did:web v0.0.3. |
| `did:ethr` | **Compliant** | Same `did-resolver.ts` — derives the `EcdsaSecp256k1RecoveryMethod2020` verification method from the Ethereum address with proper CAIP-10 `blockchainAccountId`. Supports both `did:ethr:<address>` and `did:ethr:<chainspec>:<address>` forms. |

## 10. 1EdTech Open Badges 3.0

| Standard requirement | Status | Where |
|---|---|---|
| `OpenBadgeCredential` typed VC | **Compliant** | [`src/credentials.ts`](src/credentials.ts) `buildCourseCompletionVc` |
| `AchievementSubject` + `Achievement` shape | **Compliant** | `credentialSubject.achievement` populated |
| `Achievement.criteria.narrative` | **Compliant** | Required field populated from `criterion_narrative` arg |
| `Achievement.alignment[]` for competency frameworks | **Compliant** | Built from `aligned_skills` arg |
| `evidence[]` linking back to learning experience traces | **Compliant** | `evidence` arg becomes the array |
| OB3 issuer (Profile) | **Partial** | Issuer is the issuer's `did:key`; tenant Profile name/details ride in published descriptor metadata. Full `issuer: { id, type, name }` object shape requires loosening the substrate's `VcPayload.issuer: string` type — deferred |
| Independent verification | **Compliant** | Any W3C VC verifier can verify; substrate's `verifyDataIntegrityProof()` confirms locally |

## 11. 1EdTech Comprehensive Learner Record (CLR) 2.0

| Standard requirement | Status | Where |
|---|---|---|
| CLR 2.0-shaped envelope wrapping multiple W3C VCs | **Compliant** | [`src/clr.ts`](src/clr.ts) `exportClr` |
| Each entry preserves its own DataIntegrityProof | **Compliant** | Envelope is an aggregator; per-entry proofs unmodified |
| Subject-binding check (each VC's `credentialSubject.id` must match `holderDid`) | **Compliant** | Cross-checked; mismatches surface with `verified: false, reason: 'subject DID mismatch'` |
| Affordance: `foxxi.export_clr` | **Compliant** | [`affordances.ts`](affordances.ts) + bridge handler |
| CLR 1.0 (pre-VC legacy) | **Compliant** | [`src/clr-1.ts`](src/clr-1.ts) `envelopeToClr1()` — projects the CLR 2.0 envelope to the legacy 1.0 JSON shape for institutional consumers still on the pre-VC format. Exposed via `foxxi.export_clr_v1` affordance. |

## 12. Learner wallet — ADL TLA "Learner Records Network"

| Concept | Status | Where |
|---|---|---|
| Pod-as-wallet | **Compliant** | The learner's Solid pod holds every `fxa:CourseCompletionCredential` / `fxa:CompetencyAssertion` |
| Credential portability | **Compliant** | Standard Solid pod migration; DID unchanged |
| Wallet contents discoverable by type IRI | **Compliant** | `cg:discover()` filtered on `dct:conformsTo` |
| Wallet envelope export (CLR 2.0) | **Compliant** | See §11 |
| Wallet backup / cross-pod replication | **Not implemented** | Achievable via existing E2EE envelope share; not yet a standard affordance |

## 13. 1EdTech LTI 1.3 Core + Advantage

| Standard requirement | Status | Where |
|---|---|---|
| Tool JWKS (RFC 7517) at `/.well-known/jwks.json` | **Compliant** | [`src/lti13.ts`](src/lti13.ts) — derived ES256 (P-256) keypair, stable `kid` |
| OIDC 3rd-party-initiated login (LTI 1.3 §5.1.1) | **Compliant** | `POST/GET /lti/login` — `state` + `nonce` minted, redirect to platform's `auth_login_url` with `response_type=id_token`, `response_mode=form_post`, `prompt=none`, `scope=openid` |
| Resource Link Launch (LTI 1.3 §5.1.2) | **Compliant** | `POST /lti/launch` — verifies `id_token` against the platform's JWKS (RS256 or ES256), validates `iss` / `aud` / `nonce` / `exp` / `deployment_id` / `version=1.3.0` / `message_type`, then mints a 5-min HMAC-signed launch ticket and redirects to the Foxxi dashboard |
| Deep Linking 2.0 — `POST /lti/deeplink` | **Stub** | Endpoint present; content-item selection round-trip is the next iteration |
| Assignment & Grade Service (AGS 2.0) — score post-back | **Compliant** | `POST /lti/ags/scores` — mints a `client_credentials` JWT assertion (ES256 JWS over the platform's `auth_token_url` audience), exchanges for access token, posts `application/vnd.ims.lis.v1.score+json` to the line-item's `/scores` endpoint |
| AGS — line items list | **Stub** | `GET /lti/ags/lineitems` returns `[]`; per-tenant line-item store is the next iteration |
| Names & Roles Provisioning Service (NRPS 2.0) | **Stub** | `GET /lti/nrps/members` returns the envelope shape; member retrieval against the platform is the next iteration |
| Multi-platform / multi-tenant registration | **Compliant** | `FOXXI_LTI_PLATFORMS` env — comma-separated `issuer\|\|client_id\|\|deployment_id\|\|jwks_url\|\|auth_login_url\|\|auth_token_url`; each registered platform gets independent verify + token paths |

## 14. 1EdTech OneRoster 1.2 — Rostering REST

| Standard requirement | Status | Where |
|---|---|---|
| GET `/ims/oneroster/v1p2/users` (list + filter + paginate) | **Compliant** | [`src/oneroster.ts`](src/oneroster.ts) — `attachOneRosterRoutes()`; reads live tenant directory, maps Foxxi users to OneRoster `User` with `role=student\|administrator`, `agentSourcedIds`, `orgSourcedIds` |
| GET `/ims/oneroster/v1p2/users/{sourcedId}` | **Compliant** | Single lookup by `user_id` |
| GET `/ims/oneroster/v1p2/orgs` | **Compliant** | Returns the tenant as a single `org` |
| GET `/ims/oneroster/v1p2/classes` | **Compliant** | Foxxi audience groups projected as OneRoster `Class` records |
| GET `/ims/oneroster/v1p2/enrollments` | **Compliant** | Cross-product of (enabled policy × group members) emitted as OneRoster `Enrollment` records |
| POST `/ims/oneroster/v1p2/import` — CSV bundle ingest | **Compliant** | Accepts the OneRoster CSV file set as `{ "users.csv": "...", "classes.csv": "...", ... }`; RFC 4180-conformant parsing (quoted fields + embedded commas + escaped quotes); returns row counts |
| Pagination (`?limit=`, `?offset=`) per OneRoster §3 | **Compliant** | All list endpoints honor `limit` (≤ 1000) and `offset` |

## 15. OpenAPI 3.1 contract for non-MCP integrators

| Deliverable | Status | Where |
|---|---|---|
| Machine-readable OpenAPI 3.1 document at `GET /openapi.json` | **Compliant** | [`src/openapi-spec.ts`](src/openapi-spec.ts) — generated from the affordance manifest (single source of truth) + manually-declared LRS / LTI / OneRoster endpoints |
| Swagger UI at `GET /docs` | **Compliant** | Swagger UI dist loaded from `cdn.jsdelivr.net/npm/swagger-ui-dist@5`; pulls from `/openapi.json` |
| Security schemes (Bearer + Basic) declared | **Compliant** | `components.securitySchemes.bearerAuth` + `basicAuth` — partner SDKs auto-prompt for the right credential per endpoint |
| MCP envelope endpoint documented | **Compliant** | `/mcp` (JSON-RPC tools/list + tools/call) included in the spec so SDK generators can opt for either calling style |

## 16. ADL TLA backbone (Master Object Model + Experience Index)

| TLA component | Status | Where |
|---|---|---|
| Master Object Model — Course / Learner / Competency / Assessment / Result as RDF | **Compliant** | `fxs:Package` (course), learner WebID, `rcd:CompetencyDefinition`, `fxs:Item/SCO` (assessment), `lpc:PerformanceRecord` (result) |
| Experience Index — write side (statements → LRS) | **Compliant** | `lrs-adapter` projects descriptors to LRS |
| Experience Index — read side (federated xAPI queries across LRSs) | **Compliant** | [`applications/lrs-adapter/src/experience-index.ts`](../lrs-adapter/src/experience-index.ts) `queryFederatedStatements()` — parallel `GET /statements` across N configured LRSs, deduplication by Statement ID, per-LRS attribution + per-LRS error isolation. Exposed via `foxxi.query_experience_index` (admin-only). |

---

## Standards-citing tooling

Every credentialing affordance returns a payload whose `@context` array
references the standard spec it conforms to:

- `OpenBadgeCredential` → `https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json`
- `ClrCredential` → `https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json`
- `CFDocument` → `https://purl.imsglobal.org/spec/case/v1p0/context/case_v1p0.jsonld`

That makes every artifact independently verifiable: a third-party CASE
parser / OB3 verifier / CLR 2.0 consumer can fetch the spec context
and validate without trusting our README. The substrate-side
verification (`verifyDataIntegrityProof()`) does the same check locally
before publishing.
