# Incident Response Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + after every Sev-1 incident

## 1. Purpose

To define how Interego detects, responds to, contains, recovers from, and learns from security and operational incidents.

## 2. Scope

Any event that:

- Affects confidentiality, integrity, or availability of customer data
- Affects confidentiality, integrity, or availability of Interego production services
- Indicates compromise of a credential, key, or system
- Constitutes a privacy breach (unauthorized access to plaintext customer content)
- Triggers regulatory notification under applicable law

Includes near-misses (events that *could have* compromised the above).

## 3. Roles & Responsibilities

| Role | During an incident |
|---|---|
| Incident Commander | Operator (default); declared at incident start |
| Communicator | Posts updates to status page + customer notifications |
| Investigator | Performs root cause analysis |
| Compliance scribe | Publishes evidence descriptors throughout |

For solo-operator periods, all roles default to the Operator. Independent Advisor is notified within 4 hours of any Sev-1 declaration.

## 4. Severity Classification

| Severity | Definition | Examples | Response time |
|---|---|---|---|
| Sev-1 | Confirmed breach of confidentiality OR full outage > 30 min | Key compromise; database exfiltration; CSS pods returning 5xx for all users | Immediate (< 15 min ack) |
| Sev-2 | Suspected breach OR partial outage OR severe degradation | Anomalous access pattern; one container app down; latency 10x baseline | < 1 hour ack |
| Sev-3 | Bug or single-customer issue with workaround | Discover endpoint returning incorrect federation results for one pod | < 1 business day ack |
| Sev-4 | Internal-only or near-miss | Failed deploy caught before traffic shift; alarm tuning needed | Best effort |

## 5. Policy Statements

### 5.1 Detection

- Production services MUST emit health metrics and structured logs.
- Critical alerts (Sev-1 conditions) MUST page the Operator via at least two channels (e.g., email + SMS).
- All alerts MUST produce a compliance descriptor with `dct:conformsTo soc2:CC7.2`.

### 5.2 Response

- The Operator MUST acknowledge alerts per the Severity Classification table.
- Sev-1 incidents MUST trigger immediate creation of an incident descriptor with `dct:conformsTo soc2:CC7.3` and `cg:modalStatus Asserted`.
- Containment actions take precedence over investigation. Stop the bleeding first.

### 5.3 Communication

- Sev-1 customer-impacting incidents MUST be communicated to affected customers within 4 hours of detection, with status updates at minimum every 4 hours until resolution.
- Status page (TBD URL) MUST be updated within 30 minutes of Sev-1 acknowledgment.
- Regulatory notifications (e.g., GDPR 72-hour breach notification) MUST be triggered by Sev-1 personal data breach declarations.

### 5.4 Investigation

- Root cause analysis MUST begin within 24 hours of containment.
- All evidence MUST be preserved (logs, traces, descriptor lineage).
- Investigation findings recorded as compliance descriptors chained to the incident descriptor via `prov:wasDerivedFrom`.

### 5.5 Recovery

- Service restoration MUST be verified against pre-incident baseline metrics.
- Any restored data integrity MUST be verified via descriptor signature validation, not assumed.

### 5.6 Post-mortem

- Sev-1 and Sev-2 incidents MUST have a written post-mortem within 5 business days of resolution.
- Post-mortems MUST be blameless (focus on systems and processes, not individuals).
- Post-mortems MUST list: timeline, root cause, contributing factors, remediation actions with owners + due dates.
- Post-mortem published as compliance descriptor with `dct:conformsTo soc2:CC7.4`, chained to the incident descriptor via `cg:supersedes`.

### 5.7 Key compromise

If the compliance signing wallet is suspected compromised:

1. Immediate rotation via `rotateComplianceWallet()` (see [`08-encryption.md`](08-encryption.md))
2. Publish key-rotation descriptor citing the suspected compromise as triggering event
3. All descriptors signed by the compromised key remain verifiable historically (wallet history retains the key) but new descriptors use the new active key
4. If actual compromise is confirmed, customers MUST be notified that descriptors signed by the compromised key during the suspected window may have been forged; provide validation guidance

### 5.8 Credential compromise

If any production credential is suspected compromised (Azure, GitHub, NPM, Pinata):

1. Immediate revocation
2. Issue new credential with MFA reaffirmed
3. Audit log review for misuse during suspected window
4. Compliance descriptor recording the rotation

## 6. Procedures

### 6.1 Incident declaration

1. Detector → operator (alert, customer report, manual observation)
2. Operator declares severity
3. Operator publishes incident descriptor (template in `examples/incident-template.ttl`)
4. Operator notifies Advisor for Sev-1
5. Operator begins response

### 6.2 Tabletop exercise

Annually, the Operator + Advisor MUST run a tabletop exercise simulating a Sev-1 incident (key compromise, breach, full outage). Exercise itself recorded as compliance descriptor.

## 7. Exceptions

Not applicable. Incidents bypass change management — fix first, document immediately, review later.

## 8. Mapping

- SOC 2: CC7.3 (security event evaluation), CC7.4 (response to incidents), CC7.5 (recovery)
- ISO 27001 Annex A: A.16.1
