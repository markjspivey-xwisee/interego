# SOC 2 Preparation

**Audience:** the Interego operator (currently a one-person org) preparing the project for a SOC 2 Type 1 examination, then Type 2 over a six-to-twelve-month observation window.

**Status:** roadmap, not a completed audit. Captures the work needed to make the project SOC 2-defensible — policies, controls, evidence collection, vendor inventory, and the order in which to do things.

**Why this document exists:** SOC 2 is auditor-judgement against the AICPA Trust Services Criteria, not a checklist. The audit asks (a) do you have policies, (b) do you operate by them, (c) can you prove it. This document gives the operator a concrete answer to all three for the Interego project.

---

## 1. Scope

### What's in scope

- The Interego protocol implementation (`@interego/core`, `@interego/mcp`, the relay)
- The Azure Container Apps deployment serving production traffic
- The customer-facing pods (CSS instances) holding customer descriptors
- The identity service (DID resolver + signature verifier)
- The compliance signing/verification pipeline (`src/compliance/`)
- Source code repositories, CI/CD, and access control to those systems

### What's deliberately out of scope (for now)

- Customer pods hosted off-Azure (the customer is responsible for their own pod)
- Third-party agent frameworks consuming the MCP (they are users, not subprocessors)
- IPFS public network (anchoring only; no customer data leaves the pod unencrypted)

### Trust Services Criteria targeted

- **Security (CC1–CC9):** required for all SOC 2 reports
- **Confidentiality (C1):** required because customer descriptors include sensitive content
- **Availability (A1):** required because customers depend on the relay being up

Not pursued initially: Processing Integrity (P1), Privacy (P1–P8). Both are reasonable extensions once the core report is established.

---

## 2. Operational reality vs target state

### Today (2026-04-25)

| Area | Current state |
|---|---|
| Org headcount | One operator |
| Code review | Self-review on personal repo |
| Deploys | `azure-deploy.sh` from operator's workstation, no CD gating |
| Access | Operator holds all admin credentials; no RBAC; no MFA enforcement on every system |
| Logging | Application logs to stdout → Azure log analytics; no centralized SIEM |
| Backups | Manual snapshots before destructive ops; no scheduled backup policy |
| Incident response | None defined — operator notices and reacts |
| Vendor management | Implicit (Azure, GitHub, IPFS, Pinata) — not tracked |
| Risk assessment | Implicit |
| Vulnerability mgmt | `npm audit` ad hoc |
| Asset inventory | Implicit |

### Target state for SOC 2 Type 1

| Area | Target |
|---|---|
| Code review | All changes merged via PR with review (operator + at least one other reviewer, or documented exception for solo maintenance) |
| Deploys | CI-gated; no direct prod push; deploy log retained |
| Access | MFA on every admin surface (Azure, GitHub, NPM, Pinata, domain registrar); access reviewed quarterly |
| Logging | Centralized log retention (Azure Monitor Workspace) with 1-year retention for security events |
| Backups | Daily automated snapshot of Azure Files share; restore tested quarterly |
| Incident response | Documented IR plan; on-call rotation (even if 1 person); incident post-mortems |
| Vendor inventory | All subprocessors named, contracted, monitored; SOC 2 reports collected for in-scope vendors |
| Risk assessment | Annual risk register; reviewed before significant change |
| Vulnerability mgmt | Dependabot enabled; CVE response SLA documented; quarterly external pentest |
| Asset inventory | All production resources tagged + tracked |

### Gap

The largest gaps are organizational, not technical: solo operator means several SOC 2 controls (segregation of duties, independent review) need either compensating controls or a co-signer arrangement before audit. Section 6 below proposes the compensating control structure.

---

## 3. Mapping Interego features to SOC 2 controls

The project has unusual leverage on SOC 2 because much of what auditors normally treat as "evidence" is already produced as cryptographically-signed first-class data in the system. This section names that mapping.

| SOC 2 control area | Common Criteria | Interego feature that delivers evidence |
|---|---|---|
| Logical access — authentication | CC6.1 | DID/SIWE/WebAuthn auth (no passwords). All credentials live in customer's pod, auditable via `GET /auth-methods/me`. |
| Logical access — authorization | CC6.1, CC6.3 | ABAC policies (`abac:Policy` descriptors); decision records (`abac:EvaluationRecord`) — every access decision is a queryable triple. |
| Encryption at rest | CC6.7 | Customer content E2EE via NaCl envelope encryption; storage provider sees ciphertext only. |
| Encryption in transit | CC6.7 | TLS on all Azure endpoints; pod-to-pod via HTTPS; envelope encryption inside the transport. |
| Change management | CC8.1 | Every code change → git commit → signed tag (recommended) → CI build → deploy log; deploy events publishable as `compliance: true` descriptors with `dct:conformsTo soc2:CC8.1`. |
| Risk assessment | CC3.1 | Risk register kept as descriptors with `cg:modalStatus Hypothetical` for identified risks, transitioning to `Counterfactual` when mitigated. |
| System monitoring | CC7.1 | Application emits operational events as descriptors; relay `/audit/events` aggregates them; lineage chains visible via `prov:wasDerivedFrom`. |
| Incident response | CC7.3, CC7.4 | Incidents recorded as `compliance: true` descriptors with `dct:conformsTo soc2:CC7.3`; post-mortem chain via `cg:supersedes`. |
| Backup and recovery | A1.2, A1.3 | Azure Files snapshot policy (manual today; automated target); restore evidence as audit-trail descriptor. |
| Vendor management | CC9.2 | Subprocessor list maintained as descriptor on the operator's pod; SOC 2 report fetch dates recorded. |
| Logging and audit trail | CC4.1, CC4.2 | The `/audit/*` relay endpoints + signed compliance descriptors *are* the audit trail. ECDSA-signed, IPFS-anchored. |
| Confidentiality | C1.1, C1.2 | `share_with` cryptographic recipient lists; pod-level WAC; field-level encryption for sensitive facets. |
| Availability monitoring | A1.1 | Azure Container Apps metrics; relay health endpoint; SLO tracked via descriptors. |

**Implication:** the auditor's questions ("show me access logs," "show me change records," "show me incident reviews") have a single answer for most controls: a SPARQL query against the operator's pod, returning signed descriptors with timestamps, attribution, and modal status. This is structurally stronger than a CSV export from a SIEM, because each row is independently verifiable without trusting the system that produced it.

---

## 4. Policy set required (item 1 deliverable)

SOC 2 expects written policies covering each control area. They live in [`spec/policies/`](policies/). Drafted as part of this preparation:

| # | Policy | File |
|---|---|---|
| 1 | Information Security Policy (umbrella) | [`policies/01-information-security.md`](policies/01-information-security.md) |
| 2 | Access Control Policy | [`policies/02-access-control.md`](policies/02-access-control.md) |
| 3 | Change Management Policy | [`policies/03-change-management.md`](policies/03-change-management.md) |
| 4 | Incident Response Policy | [`policies/04-incident-response.md`](policies/04-incident-response.md) |
| 5 | Business Continuity & Disaster Recovery | [`policies/05-business-continuity.md`](policies/05-business-continuity.md) |
| 6 | Vendor / Third-Party Management | [`policies/06-vendor-management.md`](policies/06-vendor-management.md) |
| 7 | Data Classification & Handling | [`policies/07-data-classification.md`](policies/07-data-classification.md) |
| 8 | Encryption Policy | [`policies/08-encryption.md`](policies/08-encryption.md) |
| 9 | Secure Software Development Lifecycle | [`policies/09-secure-sdlc.md`](policies/09-secure-sdlc.md) |
| 10 | Logging & Monitoring Policy | [`policies/10-logging-monitoring.md`](policies/10-logging-monitoring.md) |
| 11 | Acceptable Use Policy | [`policies/11-acceptable-use.md`](policies/11-acceptable-use.md) |
| 12 | Data Retention & Disposal Policy | [`policies/12-data-retention.md`](policies/12-data-retention.md) |
| 13 | Risk Management Policy | [`policies/13-risk-management.md`](policies/13-risk-management.md) |
| 14 | Vulnerability Management Policy | [`policies/14-vulnerability-management.md`](policies/14-vulnerability-management.md) |
| 15 | Privacy Policy (data subject rights) | [`policies/15-privacy.md`](policies/15-privacy.md) |

Each policy follows the same structure: Purpose, Scope, Roles, Policy statements, Procedures, Exceptions, Review cadence, Mapping to SOC 2 control IDs.

---

## 5. Vendor / subprocessor inventory

Initial list — kept as a living document. Each entry must end up in the vendor management policy with: contract date, SOC 2 report fetch date, data shared, criticality.

| Vendor | Service | Data shared | Criticality | SOC 2 report? |
|---|---|---|---|---|
| Microsoft Azure | Container Apps, Azure Files, Storage | All production data (encrypted) | Critical | Yes — request via Service Trust Portal |
| GitHub (Microsoft) | Source code, CI | Source code, build artifacts | Critical | Yes — same source |
| NPM (GitHub) | Package distribution | Built artifacts (public) | High | Yes — same source |
| Pinata (Piñata Cloud, Inc.) | IPFS pinning for compliance anchors | Public Turtle + signature blobs (descriptors are public-anchorable; private content stays in pod) | Medium | Request from vendor |
| Cloudflare (if used for DNS/proxy) | DNS, edge caching | Hostnames, TLS termination | Medium | Yes — public report |
| Domain registrar | Domain registration | Operator contact info | Low | Not typically required |
| Let's Encrypt / Azure-managed certs | TLS certificate issuance | Public certificate metadata | Medium | Operates per CA/Browser Forum baseline; SOC 2 not standard |

**Action items for vendor management:**
1. Request SOC 2 Type 2 reports from each in-scope vendor; record fetch date.
2. Document data flow per vendor in [`policies/06-vendor-management.md`](policies/06-vendor-management.md).
3. Set annual review reminder (descriptor with `cg:validUntilEvent` for 12 months out).

---

## 6. Solo-operator compensating controls

Two SOC 2 controls are structurally hard for a one-person org:

- **CC1.4 (segregation of duties):** the same person who writes the code deploys it, holds prod credentials, and reviews the audit log.
- **CC8.1 (independent review of changes):** no second pair of eyes on PRs.

Auditors accept compensating controls when designed transparently. Recommended set:

1. **Independent advisor** — name a designated reviewer (a peer or paid advisor) who:
   - Reviews critical PRs (security, deploy, key management) within 5 business days
   - Receives quarterly access review reports
   - Receives quarterly risk register snapshot
   - Their reviews are recorded as descriptors with `prov:wasAttributedTo` set to the reviewer's DID

2. **Append-only signed log** — every operational action (deploy, access change, key rotation) becomes a `compliance: true` descriptor on the operator's pod. Because they are ECDSA-signed and IPFS-anchored, even the operator cannot rewrite them undetected. This *is* the segregation-of-duties compensation: the system holds the operator accountable.

3. **Pre-commit signing** — commits signed with operator's GPG key; signing key on hardware (YubiKey). Establishes that "the operator approved this" is cryptographically distinct from "someone with repo write access pushed this."

4. **Read-only auditor account** — when entering audit, provision a read-only Azure RBAC role + read-only pod access for the auditor. Their queries against `/audit/*` produce evidence without operator mediation.

These four compensating controls are the minimum viable answer to "you're a solo operator, how is this defensible?" Document them in [`policies/01-information-security.md`](policies/01-information-security.md) §Roles.

---

## 7. Evidence collection plan

For Type 1: snapshot of evidence at a point in time. For Type 2: continuous evidence over the observation window (typically 6 months minimum).

The Interego architecture changes the evidence collection model. Most evidence is already produced by the system as signed descriptors. The plan:

### Continuous (automated)

- **Every deploy** → publish_context with compliance:true, dct:conformsTo soc2:CC8.1, content describing what was deployed, by whom, from which commit. See [`spec/policies/03-change-management.md`](policies/03-change-management.md) §Procedures.
- **Every access change** (Azure RBAC role assignment, GitHub team change, NPM access change) → publish_context with compliance:true, dct:conformsTo soc2:CC6.2.
- **Every key rotation** (compliance wallet, signing keys) → publish_context with compliance:true, dct:conformsTo soc2:CC6.7. The `rotateComplianceWallet` helper already produces the rotation event; wire it to publish.
- **Every incident** (any user-impacting event, security event, data integrity event) → publish_context with compliance:true, dct:conformsTo soc2:CC7.3 + CC7.4. Post-mortem chained via `cg:supersedes`.
- **Every quarterly review** (access, risk, vendor) → publish_context with compliance:true, dct:conformsTo soc2:CC1.1 + CC2.2.

### Manual (collected by operator)

- Vendor SOC 2 reports (annual)
- Pentest reports (annual)
- Background check evidence (one-time per person)
- Training records (annual)

### Stored where

- Signed descriptors → operator's compliance pod (`urn:graph:markj:soc2-evidence:v1`)
- Manual evidence → encrypted bucket, referenced from descriptor metadata via `cg:affordance`
- Auditor handoff → read-only access to `/audit/compliance/soc2?pod=<podUrl>`; the per-control report aggregates evidence per CC

---

## 8. Pre-audit timeline (illustrative)

The following is a candidate sequence when the operator decides to proceed. Each item is gated on the previous. Calendar weeks; relative to engagement start.

| Week | Milestone |
|---|---|
| 0 | Engage auditor; scope agreed; readiness assessment |
| 1–4 | Policies (item 1) finalized; advisor named; access reviews started |
| 4–8 | Operational events wired (item 2); CI gating in place; backup automation deployed |
| 8–12 | Quarter-1 evidence accrual; first quarterly access review on record |
| 12 | Type 1 fieldwork (point-in-time examination) |
| 16 | Type 1 report issued |
| 16–40 | Type 2 observation window (6 months minimum) — continuous evidence collection |
| 40–44 | Type 2 fieldwork |
| 44 | Type 2 report issued |

Total time-to-Type-2: ~10 months from engagement; ~4 months to Type 1. Both can be compressed if the operator is full-time on this and the controls are already operating before engagement begins.

---

## 9. Cost estimate (rough)

| Item | Estimate |
|---|---|
| Auditor (Type 1) | $15–25k |
| Auditor (Type 2 follow-on) | $15–35k |
| Pentest (annual) | $10–20k |
| Compliance advisor / vCISO (part-time) | $1–3k/month |
| Tooling (Vanta / Drata / Tugboat / equivalent) | $7–20k/year — *optional given Interego itself replaces much of what these tools do* |
| Operator time | 25–40% allocation for the prep window, 10–15% steady-state |

**Tooling note:** the value proposition of Vanta/Drata is automated evidence collection from cloud APIs. The Interego architecture provides this natively for everything except the bits that aren't yet wired (CI deploy events, RBAC change events). Wiring those (item 2 in the deliverable list) closes the gap and saves the per-year tool cost. The trade-off is that the auditor may be unfamiliar with verifying RDF + ECDSA signatures rather than CSV exports — building a one-page "auditor onboarding" document for the unusual evidence shape will be necessary.

---

## 10. What this preparation does not do

- Does not produce a SOC 2 report. That requires an AICPA-licensed CPA firm.
- Does not establish customer-facing trust by itself. Customers want the report, not the prep.
- Does not satisfy ISO 27001, HIPAA, or other regimes. SOC 2 controls overlap but don't substitute.
- Does not replace legal review of customer contracts (DPAs, BAAs).

---

## 11. Open questions

- Will Interego pursue Type 1 first (cheaper, faster, less defensible) or skip directly to Type 2 (industry-standard for B2B)?
- Will the operator engage a co-signer/advisor for the compensating controls, or remain genuinely solo (limits SOC 2 defensibility)?
- Will the project incorporate as a formal entity before audit? Auditors typically expect an entity, not a sole individual.
- Will customers' own compliance teams accept Interego signed-descriptor evidence in lieu of conventional log exports? Worth piloting with one customer before scaling.

---

## See also

- [`CONFORMANCE.md`](CONFORMANCE.md) — Interego protocol conformance levels (L1/L2/L3/L4); L4 is the technical foundation for SOC 2 evidence
- [`OPS-RUNBOOK.md`](OPS-RUNBOOK.md) — operational discipline: deploy, access, key rotation, backup
- [`policies/`](policies/) — written policy set
- `docs/AGENT-PLAYBOOK.md` §13 — agent-side guidance for emitting compliance descriptors
- [`../examples/compliance-end-to-end.mjs`](../examples/compliance-end-to-end.mjs) — runnable end-to-end walkthrough: ops event → pre-publish check → framework report → wallet load. Self-contained, no live pod required.
- [`../tools/publish-ops-event.mjs`](../tools/publish-ops-event.mjs) — CLI that emits a JSON payload ready for `publish_context` with `compliance: true`. One subcommand per operational event kind (deploy / access / wallet-rotation / incident / review).
