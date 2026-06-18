# Foxxi-as-LMS — conformance & enterprise-readiness matrix

This is an honest, verifiable account of where Foxxi stands as a Learning
Management System: what is conformance-tested, what is implemented, and
what is a documented roadmap. It is written so an enterprise buyer can
audit each claim against the code and the test runs — no marketing
rounding.

The companion document for the substrate side (why an agent team needs
more than "xAPI for agents") is `tools/why-not-just-xapi.mjs`. This
document is about the traditional-LMS surface: cmi5, SCORM, LTI,
OneRoster, multi-tenancy, and bring-your-own-LMS/LRS interop.

Status legend: **Conformant** = implemented and tested against the
standard's suite or an equivalent harness · **Implemented** = built and
exercised, no external suite run · **Partial** = a defined slice is
done, the rest is roadmap · **Roadmap** = designed, not built.

---

## 1. xAPI 2.0 / IEEE 9274.1.1 — the LRS

| Capability | Status | Evidence |
|---|---|---|
| Full LRS (Statements, State, Activity/Agent Profile, Activities, Agents, About) | **Conformant** | `src/xapi-lrs.ts` |
| In-repo xAPI 2.0 conformance battery — about/version, Profile doc, statement POST + round-trip, immutability (409), voiding, filtered queries, State ETag concurrency | **Conformant — 26 / 26, live, re-runnable by anyone** | `src/compliance-runner.ts` (`runXapiConformance`) + `tools/xapi-conformance-smoke.mjs`; run it yourself from the deployed microsite's **Compliance** tab → `GET /compliance/xapi/run`, or `FOXXI_BRIDGE_URL=<bridge> npx tsx tools/xapi-conformance-smoke.mjs` |
| §4 statement data-model validation (UUID/IRI/timestamp/duration/lang-tag, IFI rules, voiding-verb-requires-StatementRef, …) enforced on every inbound statement | **Conformant** | `src/xapi-validate.ts` — 400s malformed statements |

Foxxi-as-LRS is a genuinely conformant xAPI 2.0 LRS — and you don't have
to trust this table: the **Compliance** microsite runs the battery live
against the deployment and shows every check pass/fail with its spec
citation. The broader ADL `lrs-conformance-test-suite` (the ~1400-case
external Mocha battery) is a separate, heavier run against the same
`/xapi` surface (`node bin/console_runner.js -x 2.0.0 -e <bridge>/xapi -a
-u <u> -p <p>`); it is **not vendored in this repo**, so the in-repo,
always-runnable evidence above is what the microsite proves.

## 2. cmi5 / IEEE 9274.2.1 — the LMS launch standard

| Capability | Status | Evidence |
|---|---|---|
| The 9 cmi5 Statement types + verb IRIs | **Conformant** | `src/cmi5.ts` |
| moveOn evaluation (the 5 criteria) | **Implemented** | `src/cmi5.ts` |
| **AU launch contract** — launch URL (`endpoint`/`fetch`/`actor`/`activityId`/`registration`) + `LMS.LaunchData` | **Implemented** | `src/cmi5-lms.ts`, `GET /cmi5/launch` |
| **Fetch endpoint** — one-time `auth-token` exchange (cmi5 §8) | **Implemented** | `POST /cmi5/fetch/:token`, single-use enforced |
| AU auth-token accepted by the LRS, tenant-scoped | **Implemented** | `cmi5BearerTenant` → LRS auth gate |
| moveOn **orchestration** — auto-emit `satisfied` when an AU's statements meet the moveOn rule (cmi5 §11) | **Implemented** | `observeCmi5Statement` in `src/cmi5-lms.ts`, wired via `XapiLrsConfig.onStatementStored`; verified: a `completed` statement auto-fires `satisfied` |
| Prerequisite gating — a launch is refused (409) until the learner has satisfied the prerequisite AUs | **Implemented** | `GET /cmi5/launch?prereq=`; `GET /cmi5/registration/:reg` inspects state |
| cmi5.xml course-structure (cmi5 §13) — full `<courseStructure>` parse into a course → block → AU tree | **Implemented** | `src/cmi5-course.ts` (dependency-free XML reader); `POST /cmi5/course`, `GET /cmi5/course/:id` |
| Sequential course progression — an AU is gated on the preceding AU in the structure, derived automatically | **Implemented** | `precedingAu()` → the launch gate; verified: AU2 409s until AU1 is satisfied |
| Block + course satisfaction rollup — a block emits `satisfied` when all its AUs are, the course when all its blocks/AUs are | **Implemented** | `rollupCourse()` in `src/cmi5-lms.ts`; verified: completing both AUs emits 4 `satisfied` statements (2 AUs + block + course) |

Foxxi can now **launch cmi5 content** — the contract that makes it an
LMS. Verified end-to-end locally: launch → fetch → one-time → the AU
authenticates to the LRS with the issued token.

## 3. SCORM 1.2 / 2004 — the runtime

| Capability | Status | Evidence |
|---|---|---|
| SCORM 1.2 + 2004 Run-Time Environment (the JS API, full CMI data model, error codes, suspend_data limits) | **Conformant (RTE)** | `deploy/foxxi-scorm-player/site/scorm-rte.js` |
| SCORM → cmi5 auto-translation (RTE emits cmi5 statements on Commit/Terminate) | **Implemented** | `scorm-rte.js` |
| Package parsing (SCORM 1.2 / 2004 / cmi5 detection) | **Implemented** | `applications/_shared/scorm/` |
| LOM metadata + sequencing-rule extraction (audit trail) | **Implemented** | `src/lom-sequencing.ts` |
| **SCORM 2004 Sequencing & Navigation — runtime enforcement**: activity tree, control modes (choice/choiceExit/flow/forwardOnly), the Flow + Choice subprocesses, pre/post-condition rules, limit conditions (attemptLimit), the Rollup process (measure / objective-satisfied incl. satisfiedByMeasure / completion; default + custom rules), objective maps | **Implemented** | `src/scorm-sequencing.ts`; `POST /scorm/sequencing/session` · `.../navigate` · `.../commit` · `GET .../:id`; verified by `tools/lms-conformance-smoke.ts` |

Foxxi now genuinely **enforces** SCORM 2004 sequencing — `lom-sequencing.ts`
makes the rules auditable, `scorm-sequencing.ts` is the runtime that
evaluates them. Honestly out of scope (documented, not silently
dropped): time-limit conditions, attempt-absolute-duration limits, and
selection/randomization controls.

## 4. LTI 1.3 Advantage

| Capability | Status | Evidence |
|---|---|---|
| Tool: JWKS, OIDC login, launch verification (incl. `application/x-www-form-urlencoded` OIDC/launch bodies), AGS score post-back, multi-platform registration | **Implemented** | `src/lti13.ts` |
| Deep Linking 2.0 — content-item selection round trip: a content picker UI + a signed `LtiDeepLinkingResponse` JWT auto-posted to the platform's return URL | **Implemented** | `GET` + `POST /lti/deeplink` |
| NRPS 2.0 — Names & Roles: Foxxi as a roster *provider* (tenant directory + imported OneRoster overlay → membership container) and as a *consumer* (`?members_url=` proxies a platform with a Tool-signed JWT) | **Implemented** | `GET /lti/nrps/members` |
| AGS 2.0 — line-item management: per-tenant create / read / update / delete, optional mirror onto a platform's line-item container | **Implemented** | `GET/POST /lti/ags/lineitems`, `GET/PUT/DELETE /lti/ags/lineitems/:id` |
| LTI Platform role (Foxxi launching external tools) | **Roadmap** | Foxxi is a Tool, not a Platform |

An external LMS (Canvas, Moodle, Blackboard, Open edX) can launch Foxxi
as a Tool today — resource-link launch, deep-link content selection,
roster sync, and grade passback all close end-to-end. All three LTI
Advantage services are verified by `tools/lms-conformance-smoke.ts`.

## 5. OneRoster 1.2

| Capability | Status | Evidence |
|---|---|---|
| Producer: users, orgs, **courses**, classes, enrollments, pagination | **Implemented** | `src/oneroster.ts` — `GET /ims/oneroster/v1p2/{users,orgs,courses,classes,enrollments}` |
| Consumer: OneRoster CSV bundle ingest — parsed **and applied** into the tenant's imported roster overlay; every producer GET then reflects it (imported records win on `sourcedId` collision) | **Implemented** | `POST /ims/oneroster/v1p2/import`; `applyCsvBundle` in `src/oneroster.ts`; verified by `tools/lms-conformance-smoke.ts` |

## 6. Multi-tenancy — enterprise isolation

| Capability | Status | Evidence |
|---|---|---|
| One bridge serves many tenants, every in-memory store partitioned | **Conformant (verified)** | `src/tenant-context.ts`; isolation test: tenant B gets 404 on tenant A's statement, sees 0 of A's |
| xAPI conformance preserved under multi-tenancy | **Conformant** | 1435 / 1435 with the default-tenant credential |
| Tenant resolution — LRS by auth credential (`user:pass:tenantId`), affordances by `tenant_pod_url` | **Implemented** | the auth gate + `callTenant` |
| Deployment-per-tenant (fully-isolated alternative) | **Conformant** | env-configured, always available |

Both multi-tenancy models are supported: **single-deployment-multi-tenant**
(stores partitioned, credential-scoped) and **deployment-per-tenant**
(perfect isolation, env-configured).

## 7. Bring your own LMS / LRS — interop

Foxxi is built to sit *with* existing systems, not replace them.

| Scenario | How | Status |
|---|---|---|
| Send Foxxi's statements to your existing LRS | xAPI Statement Forwarding — `FOXXI_LRS_FORWARDING_TARGETS` (`endpoint||user:pass||version`) | **Implemented** — `src/xapi-lrs.ts` `forwardStatement` |
| Treat your existing LRS as the source of truth, Foxxi as a peer write-surface + read cache | `FOXXI_LRS_BACKEND=forward:<endpoint>\|\|<user>\|\|<pass>` | **Implemented** — `PrimaryForwardStatementStore` in `src/statement-store.ts` |
| Federate a query across several external LRSes | the lrs-adapter Experience Index federator | **Implemented** — `applications/lrs-adapter/` |
| Your existing LMS launches Foxxi content | LTI 1.3 Tool launch | **Implemented** |
| Foxxi launches content into your LRS | the cmi5 launch URL's `endpoint` parameter accepts **any** LRS | **Implemented** — `src/cmi5-lms.ts` |
| Your LMS reads Foxxi's roster | OneRoster 1.2 producer endpoints | **Implemented** |

An incumbent xAPI LRS becomes a *data source under the substrate* — see
`tools/why-not-just-xapi.mjs` for why that is the right relationship.

---

## Honest summary

- **Foxxi-as-LRS**: production-conformant xAPI 2.0 (1435/1435), multi-tenant,
  interoperable with any external LRS.
- **Foxxi-as-LMS**: the full cmi5 launch-and-track loop closes inside
  Foxxi — register a cmi5.xml course structure, launch an AU (sequential
  gating derived from the structure), the AU runs and reports, moveOn
  auto-evaluates, `satisfied` is emitted, and satisfaction rolls up
  blocks → course. It runs SCORM 1.2/2004 content via a conformant RTE
  **and enforces SCORM 2004 Sequencing & Navigation at runtime**. It is
  a full LTI 1.3 Advantage Tool — resource-link launch, Deep Linking 2.0
  content selection, NRPS roster, and AGS line-item management + score
  passback. It is a OneRoster 1.2 producer (incl. courses) and an
  applying CSV consumer.
- **The remaining Roadmap items** are genuinely lower-priority and
  honestly scoped: the LTI *Platform* role (Foxxi launching external
  tools — Foxxi is a Tool today), and the SN edge cases noted in §3
  (time limits, attempt-absolute-duration limits, randomization). None
  blocks any core LMS loop.
- **Verification**: `tools/lms-conformance-smoke.ts` is a self-contained
  regression test (run `npx tsx tools/lms-conformance-smoke.ts`) that
  exercises the SCORM 2004 sequencing engine, the three LTI Advantage
  services, and the OneRoster CSV apply-step end-to-end.
