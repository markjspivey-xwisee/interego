# Data Classification & Handling Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual

## 1. Purpose

To classify Interego data assets by sensitivity, define handling requirements per class, and ensure the protocol's E2EE + pod ownership model is correctly mapped to operational practice.

## 2. Scope

All data that flows through, is stored by, or is produced by Interego production systems and the operator's working environment.

## 3. Classification Schema

| Class | Definition | Examples |
|---|---|---|
| **Public** | Intentionally published to the world | Spec documents, OWL ontologies, source code, public descriptors with `cg:visibility cg:Public`, README content |
| **Internal** | Operator's own non-customer data | Internal policy drafts, operational notes, deploy logs, infrastructure config (non-secret) |
| **Confidential** | Customer-controlled descriptors and metadata | All customer pod contents, customer DIDs (when not self-published), customer auth methods, share-with recipient lists |
| **Restricted** | Cryptographic material + credentials | Compliance wallet keys, service principal credentials, API tokens, PII the operator legitimately holds (contact info), breach evidence |

## 4. Handling Requirements

### 4.1 Public

- May be stored anywhere
- May be transmitted in cleartext
- May be cached by CDNs / search engines
- MUST still be authenticity-verifiable (signed where possible)

### 4.2 Internal

- Stored on operator-controlled systems
- Transmitted over TLS
- Not shared externally without classification review
- Retained per [`12-data-retention.md`](12-data-retention.md)

### 4.3 Confidential

- The protocol's design MUST keep confidential data encrypted at rest in the customer's pod (E2EE envelopes via NaCl).
- The operator MUST NOT possess plaintext customer descriptor content unless the customer explicitly shared with the operator's agent.
- If accidental access occurs (e.g., bug exposes plaintext), it MUST be treated as a Sev-2 incident per [`04-incident-response.md`](04-incident-response.md) with immediate isolation and forensic capture.
- Storage providers MUST see ciphertext only; this is a structural property of the architecture and MUST NOT be weakened.

### 4.4 Restricted

- MUST be encrypted at rest using strong symmetric cryptography (AES-256 / equivalent) with passwords/keys held only by the Operator.
- MUST be transmitted only over TLS 1.2+ to authenticated endpoints.
- MUST be backed up to encrypted off-site storage.
- MUST NOT be embedded in source code or commit messages.
- MUST NOT be shared via unencrypted channels (email, chat).
- Compromise (or suspected compromise) MUST trigger Sev-1 incident response.

## 5. Policy Statements

### 5.1 Default classification

- Customer data is **Confidential** by default.
- Cryptographic material is **Restricted** by default.
- Source code is **Public** unless it contains restricted material (which it must not).

### 5.2 Reclassification

- Reclassifying data downward (e.g., Confidential → Internal) MUST be deliberate, justified, and recorded.
- Reclassifying data upward (e.g., Internal → Restricted) is a unilateral protective action; record but no approval required.

### 5.3 Data labeling in the protocol

- Descriptor `cg:visibility` carries the customer's intended audience. Classification policy reads this as the source of truth for customer descriptors.
- The operator's own descriptors (compliance evidence, infrastructure events) MUST carry explicit `cg:visibility` matching their classification (often `cg:OperatorOnly` or, when audit-grade, `cg:AuditorReadable`).

### 5.4 PII identification

- The Operator MUST be able to enumerate every system that processes customer PII.
- Customer pods are the only system holding customer-identifying content; the operator's identity service holds DIDs only (canonical, not personal).
- Operator's own accounting / customer management systems are out of scope of the protocol but in scope for general data protection.

### 5.5 Privacy hygiene

- The MCP server's `screenForSensitiveContent` preflight check is the front-line control against accidentally publishing restricted material as a customer descriptor.
- The operator MUST NOT bypass this check without explicit cause.
- The check's findings (when blocked) MUST be reviewed; repeated triggering on the same content type indicates a process problem worth addressing.

## 6. Procedures

### 6.1 New data type assessment

When a new feature introduces a new data type:

1. Classify per §3
2. Document in this policy (or descriptor)
3. Apply handling requirements per §4
4. Publish assessment as compliance descriptor

### 6.2 Annual classification review

Once per year, the Operator reviews the classification schema for fitness:

1. Confirm classes still cover all data types
2. Identify drift (data classified one way but handled as another)
3. Update policy if necessary

## 7. Mapping

- SOC 2: C1.1 (confidentiality designation), C1.2 (confidentiality protection)
- ISO 27001 Annex A: A.8.2
