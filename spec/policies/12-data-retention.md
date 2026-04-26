# Data Retention & Disposal Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual

## 1. Purpose

To define how long Interego retains different categories of data, and how data is securely disposed of when retention expires or upon customer request.

## 2. Scope

- Customer-facing data on Interego-hosted pods
- Operator-controlled data (logs, evidence, backups, configuration)
- Customer-controlled data on customer-hosted pods (only insofar as the operator's documentation and tooling impact retention)

## 3. Retention Schedule

| Data type | Retention | Disposal trigger |
|---|---|---|
| Customer descriptors (current versions) | Customer-controlled | Customer deletion |
| Customer descriptors (superseded versions) | Customer-controlled (default: indefinite for audit) | Customer deletion |
| Customer authentication records (`auth-methods.jsonld`) | Lifetime of pod | Pod deletion |
| Compliance descriptors (operator's pod) | Indefinite | Never (audit trail) |
| Application logs | 90 days | Automatic rolling |
| Access logs | 90 days | Automatic rolling |
| Performance metrics | 30 days | Automatic rolling |
| Backup snapshots (Azure Files) | 30 days minimum, 90 days target | Rolling retention policy |
| Pre-destructive snapshots | 7 days minimum | After incident closeout |
| Vendor SOC 2 reports | 7 years (audit support) | Time-based |
| Pentest reports | 7 years | Time-based |
| Operator personnel records (background checks, training) | 7 years post-departure | Time-based |
| Compliance wallet history | Indefinite | Never (signature verification depends on it) |

## 4. Policy Statements

### 4.1 Customer data ownership

- Customer pods are owned by the customer. The operator cannot retain customer data after the customer deletes it.
- For Interego-hosted pods (CSS instances), pod deletion deletes all customer data within 30 days. Snapshots may persist up to the snapshot retention window (max 90 days).
- The operator commits to honoring customer deletion requests in writing within 30 days.

### 4.2 Compliance evidence

- Compliance evidence (signed descriptors on the operator's pod) is retained indefinitely. SOC 2 audit windows can extend years; key compromise investigations can require historical data.
- Compliance descriptors are not customer data even when they reference customer activity (they describe the operator's behavior, not customer content).

### 4.3 Cryptographic key retention

- Compliance wallet history (`compliance.history.json`) is retained indefinitely. Old descriptors must remain verifiable.
- Customer envelope keys are not held by the operator; customer retention rules govern.

### 4.4 Backup retention

- Backups inherit the sensitivity of their source data. Customer data backups MUST be deleted on the schedule above.
- Backup encryption keys are retained as long as backups exist.

### 4.5 Deletion verification

- Deletion is not "the file is gone from the application's view." Deletion is "the data cannot be recovered without exceptional measures."
- For Azure Files: snapshot deletion + retention expiry constitute deletion.
- For Azure Blob (if used): immutable delete with retention expiration.
- For physical media: cryptographic erasure (destroying the encryption key) is acceptable for fully-encrypted volumes.

### 4.6 Customer deletion requests

- Customers may request deletion of their pod and associated data at any time.
- Request channel: documented contact (TBD email + form).
- Acknowledgment within 5 business days; completion within 30 days.
- Confirmation provided to customer; completion recorded as compliance descriptor with `dct:conformsTo soc2:P4.2`.

### 4.7 Litigation hold

- Receipt of a litigation hold notice suspends the retention schedule for the affected data until the hold is lifted.
- Litigation holds recorded as compliance descriptors (with appropriate confidentiality).

## 5. Procedures

### 5.1 Automated retention

- Azure log analytics retention configured to 90 days
- Azure Files snapshot retention configured to 90 days target
- Performance metric retention configured to 30 days

### 5.2 Customer deletion

1. Receive request
2. Verify customer identity (DID signature)
3. Acknowledge within 5 business days
4. Initiate deletion: delete pod + remove from federation discovery
5. Confirm to customer; provide deletion receipt
6. Publish compliance descriptor

### 5.3 Annual retention review

Once per year, the Operator + Advisor:

1. Review retention schedule for fitness
2. Verify automation enforces the schedule
3. Identify drift (data retained longer than intended)
4. Publish review descriptor

## 6. Exceptions

- Litigation hold MUST suspend deletion for affected data.
- Active incident investigation MAY suspend deletion of relevant evidence; suspension recorded.
- Other exceptions per [`01-information-security.md`](01-information-security.md) §6.

## 7. Mapping

- SOC 2: C1.2 (confidentiality protection through retention/disposal), P4.2 (data subject deletion)
- ISO 27001 Annex A: A.8.3, A.18.1.3
- GDPR: Article 17 (right to erasure)
