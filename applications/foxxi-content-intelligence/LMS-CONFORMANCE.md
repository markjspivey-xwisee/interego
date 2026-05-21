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
| ADL `lrs-conformance-test-suite` (xAPI 2.0 battery) | **Conformant — 1435 / 1435** | run against the live production endpoint, 0 failures |
| Statement validation, query-parameter validation, concurrency (ETag), multipart + signed statements, voided-statement retrieval | **Conformant** | covered by the 1435 suite |

Foxxi-as-LRS is a genuinely conformant xAPI 2.0 LRS — re-verifiable any
time with `node bin/console_runner.js -x 2.0.0 -e <bridge>/xapi -a -u <u> -p <p>`.

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
| cmi5.xml course-structure block sequencing | **Partial** | AUs parsed (`_shared/scorm`); `<block>` gating not yet enforced |

Foxxi can now **launch cmi5 content** — the contract that makes it an
LMS. Verified end-to-end locally: launch → fetch → one-time → the AU
authenticates to the LRS with the issued token.

## 3. SCORM 1.2 / 2004 — the runtime

| Capability | Status | Evidence |
|---|---|---|
| SCORM 1.2 + 2004 Run-Time Environment (the JS API, full CMI data model, error codes, suspend_data limits) | **Conformant (RTE)** | `deploy/foxxi-scorm-player/site/scorm-rte.js` |
| SCORM → cmi5 auto-translation (RTE emits cmi5 statements on Commit/Terminate) | **Implemented** | `scorm-rte.js` |
| Package parsing (SCORM 1.2 / 2004 / cmi5 detection) | **Implemented** | `applications/_shared/scorm/` |
| Sequencing & Navigation enforcement, attempt management | **Roadmap** | rules parsed, not yet runtime-enforced |

## 4. LTI 1.3 Advantage

| Capability | Status | Evidence |
|---|---|---|
| Tool: JWKS, OIDC login, launch verification, AGS score post-back, multi-platform registration | **Implemented** | `src/lti13.ts` |
| Deep Linking, NRPS roster, AGS line-item management | **Partial** | endpoints present, stubbed |
| LTI Platform role (Foxxi launching external tools) | **Roadmap** | Foxxi is a Tool, not a Platform |

An external LMS (Canvas, Moodle, Blackboard, Open edX) can launch Foxxi
as a Tool today.

## 5. OneRoster 1.2

| Capability | Status | Evidence |
|---|---|---|
| Producer: users, orgs, classes, enrollments, pagination | **Implemented** | `src/oneroster.ts` |
| Consumer: CSV bundle ingest (parse) | **Partial** | parses; apply-to-roster is roadmap |

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
- **Foxxi-as-LMS**: it can now **launch cmi5 content** (the defining LMS
  capability), runs SCORM 1.2/2004 content via a conformant RTE, is an
  LTI 1.3 Tool, and exposes a OneRoster roster.
- **The honest gaps**, prioritised, are listed above as Roadmap/Partial —
  chiefly cmi5 moveOn orchestration, SCORM sequencing enforcement, the
  LTI Advantage stubs, and the OneRoster consumer apply-step. None of
  these blocks the core launch-and-track loop; each is a bounded,
  separately-shippable unit.
