# Privacy Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + before any new processing activity

## 1. Purpose

To define how Interego protects personal data, supports data subject rights, complies with applicable privacy regimes (GDPR, CCPA, future regulations), and aligns with the AICPA Privacy Trust Service Criteria.

This is the *internal* privacy policy. The customer-facing Privacy Notice (TBD) summarizes this for end users.

## 2. Scope

Personal data Interego may process:

- Customer DIDs (canonical identifiers; not strictly personal but linkable)
- Customer auth-method records (WebAuthn credential IDs, wallet addresses, did:key public keys)
- Customer descriptor content (only where the customer chooses to publish it; operator does not have access except via cryptographic share-with)
- Operator's own contact info as recorded with vendors
- Audit-trail metadata (operator's pod) referencing customer activity (e.g., share events)

## 3. Lawful Bases / Justification

Interego processes personal data on the following bases:

| Activity | Basis |
|---|---|
| Customer authentication | Contract / customer request |
| Customer descriptor storage on Interego-hosted pods | Contract / customer request |
| Operational logs (access patterns, error events) | Legitimate interest in service operation |
| Compliance evidence retention | Legal obligation (where customer's regulatory regime requires) + legitimate interest |

## 4. Policy Statements

### 4.1 Data minimization

- The protocol's design minimizes operator-side personal data: customers control their own keys, content, and identity.
- The operator MUST NOT collect personal data beyond what's needed for the stated purpose.
- New data collection requires policy update and lawful basis articulation.

### 4.2 Purpose limitation

- Personal data collected for one purpose MUST NOT be repurposed without customer consent or new lawful basis.
- Internal analytics on operator-side data MUST be aggregate / anonymized; per-customer behavioral profiling is prohibited without explicit consent.

### 4.3 Transparency

- Customers MUST be able to access:
  - What personal data the operator holds about them
  - Where it is stored
  - Who it is shared with (subprocessors per [`06-vendor-management.md`](06-vendor-management.md))
  - The basis for processing
  - The retention schedule
- Customer-facing Privacy Notice MUST cover the above and be updated within 30 days of material change.

### 4.4 Data subject rights

The following rights MUST be supported:

| Right | Mechanism | SLA |
|---|---|---|
| Access | `GET /auth-methods/me` for auth records; pod is customer-controlled for descriptors | 30 days |
| Rectification | Customer rectifies in their pod directly | Real-time |
| Erasure | Customer deletes from pod; for Interego-hosted pods, request via documented contact | 30 days |
| Restriction | Customer suspends share-with grants in their pod; for operator-side processing, contact operator | 30 days |
| Portability | Pods are portable by design (export Turtle/JSON-LD); auth records exportable via `/auth-methods/me` | 30 days |
| Objection | Documented contact for objection requests | 30 days |
| Automated decision-making | No automated decisions about individuals based on processing | N/A |

### 4.5 Subprocessor disclosure

The current subprocessor list is in [`06-vendor-management.md`](06-vendor-management.md) §3 and is reflected in the customer-facing Privacy Notice.

### 4.6 International transfers

- Production infrastructure currently runs in Microsoft Azure `eastus` region (United States).
- Customers in jurisdictions with data localization requirements (EU/EEA, UK) MUST be informed of the US hosting.
- Customers may host their own pods in their preferred jurisdiction; the operator's identity service does not require localization since it stores DIDs, not personal content.
- Where Standard Contractual Clauses (SCCs) or equivalent transfer mechanism is required, the operator commits to executing them.

### 4.7 Breach notification

- Personal data breach: any unauthorized access, disclosure, alteration, or loss of personal data.
- Internal acknowledgment: within 1 hour of confirmed breach (Sev-1 per [`04-incident-response.md`](04-incident-response.md)).
- Authority notification: within 72 hours where required (GDPR Article 33).
- Affected individual notification: without undue delay where required (GDPR Article 34).
- Breach descriptor publication: within 24 hours, with `dct:conformsTo soc2:P6.1`.

### 4.8 Children

- The Interego service is not directed at children under 13 (or under the local equivalent).
- The operator does not knowingly collect data from children. Discovered child accounts result in account closure and data deletion within 30 days.

### 4.9 Marketing

- The operator does not engage in unsolicited marketing using customer data.
- Operator-initiated communications relate to service operation, security, and policy changes only — not promotion of unrelated products.

### 4.10 Privacy hygiene controls

- The MCP server's `screenForSensitiveContent` preflight detects PII patterns (emails, phones, credit cards, SSNs) before publication. Customers can review flagged matches and decide.
- Field-level encryption available for highly sensitive facets even within otherwise-shared descriptors.
- The protocol's E2EE design means even the operator cannot access plaintext customer content unless the customer chose to share.

## 5. Procedures

### 5.1 Data subject request handling

1. Receive request (documented contact)
2. Verify requester identity (DID signature preferred; alternative methods on case basis)
3. Execute request per §4.4
4. Confirm completion to requester
5. Publish compliance descriptor with appropriate `dct:conformsTo` mapping (P-series controls)

### 5.2 Privacy impact assessment

For new features that introduce new personal data processing:

1. Document: what data, why, retention, sharing
2. Apply data minimization (§4.1) + purpose limitation (§4.2)
3. Confirm lawful basis
4. Update Privacy Notice if customer-facing
5. Publish PIA descriptor

### 5.3 Annual privacy review

In January each year:

1. Re-confirm lawful bases
2. Review subprocessor list + transfer mechanisms
3. Audit data subject request handling SLAs
4. Update Privacy Notice if needed
5. Publish review descriptor

## 6. Exceptions

- Legal obligation (subpoena, court order) MAY require disclosure beyond customer consent. Such disclosures MUST be:
  - Verified for legal validity
  - Limited in scope to what's compelled
  - Customer-notified where legally permitted
  - Recorded as compliance descriptor

## 7. Mapping

- SOC 2: P1.1 (notice), P5.1 (access), P5.2 (correction), P6.1 (breach notice), P8.1 (data subject rights)
- GDPR: Articles 5, 6, 12–22, 33, 34, 44–49
- CCPA / CPRA: §1798.100, .105, .110, .115, .120, .130
- ISO 27701
