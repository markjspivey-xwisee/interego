# Acceptable Use Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual

## 1. Purpose

To establish norms for how the Operator and any future personnel use Interego production systems and operator-controlled resources, and to set expectations for customer use of the Interego service.

## 2. Scope

- Operator's use of production credentials, code repositories, and infrastructure
- Independent Advisor's use of granted access
- Customer use of the Interego MCP, identity service, and any Interego-hosted pod

## 3. Operator / Personnel Acceptable Use

### 3.1 General

- Production credentials MUST be used only for legitimate operational purposes.
- Development on production data is prohibited. Use synthetic data or restored snapshots in non-prod environments.
- Personal use of operator infrastructure (e.g., running personal workloads in the production tenant) is prohibited.

### 3.2 Workstation hygiene

- The workstation used for production access MUST have:
  - Disk encryption enabled
  - Screen lock with timeout ≤ 5 minutes
  - Auto-update for OS and security patches
  - Hardware MFA available (YubiKey or platform authenticator)
- Production credentials MUST NOT be stored in cleartext outside an approved password manager.

### 3.3 Communications

- Sensitive operational discussion (incident details, customer data, credentials) MUST occur over encrypted channels (Signal, encrypted email, secured chat) — not SMS or unencrypted email.
- Public commentary about customer-specific incidents requires customer consent.

### 3.4 Source control

- Personnel MUST NOT push secrets, credentials, or private keys to public repositories.
- Pre-commit secret scanning is mandatory.

## 4. Customer Acceptable Use

### 4.1 General

Customers using Interego services agree to:

- Use the protocol for lawful purposes
- Not attempt to compromise other customers' pods or descriptors
- Not abuse the relay (denial-of-service, scraping at unreasonable rate)
- Not publish content the customer does not have rights to publish
- Not impersonate other agents or DIDs
- Comply with applicable laws and regulations

### 4.2 Prohibited content

The following content MUST NOT be published to Interego-hosted pods (customer-hosted pods are out of operator scope):

- Content unlawful in the operator's or customer's jurisdiction
- CSAM (categorically prohibited regardless of jurisdiction; reported per applicable law)
- Material designed to defraud or deceive identifiable third parties
- Malware, exploit payloads, or attack tooling intended for unauthorized use

### 4.3 Rate limits

- The relay enforces per-DID rate limits (TBD specific values).
- Sustained abusive traffic results in DID-level throttling, then suspension if not resolved.

### 4.4 Enforcement

- Suspected violations MUST be investigated.
- Confirmed violations may result in: warning, temporary suspension, account termination, content removal (where operator-hosted), referral to law enforcement (where required).
- Enforcement actions recorded as compliance descriptors with `dct:conformsTo soc2:CC1.4`.

### 4.5 Customer pods on customer infrastructure

When a customer hosts their own pod, content moderation is the customer's responsibility. The Interego service does not police customer-hosted content.

## 5. Procedures

### 5.1 Onboarding acknowledgment

- Operator and Advisor MUST acknowledge this policy in writing (signed descriptor, dated).
- Customer terms of service incorporate the customer-facing portions.

### 5.2 Incident-driven enforcement

When a customer report or operator detection raises a violation concern:

1. Operator investigates within 5 business days
2. If confirmed: enforcement action per §4.4
3. If contested: documented review with reasoning
4. Outcome recorded

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6. Exceptions to acceptable use are unusual and require explicit operator approval.

## 7. Mapping

- SOC 2: CC1.4 (organizational structure), CC2.3 (communication of behavior expectations)
- ISO 27001 Annex A: A.7.2.2
