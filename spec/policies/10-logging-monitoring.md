# Logging & Monitoring Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + after any incident exposing logging gaps

## 1. Purpose

To define what Interego logs, where logs go, how long they're retained, and how they're monitored — enabling detection, investigation, and audit.

## 2. Scope

- Application logs from relay, identity, validator, dashboard
- Access logs (HTTP request logs)
- Authentication events
- Authorization decisions (ABAC)
- Compliance descriptor publications
- Deploy events
- Key rotation events
- Infrastructure metrics (Azure Container Apps)
- Operator's pod activity (compliance evidence store)

## 3. Log Types & Retention

| Log type | Retention | Storage |
|---|---|---|
| Application stdout/stderr | 90 days | Azure Container Apps log analytics |
| Access logs (HTTP) | 90 days | Azure Container Apps log analytics |
| Authentication events | 1 year | Application + compliance descriptors |
| Authorization decisions (ABAC) | 1 year | abac:EvaluationRecord descriptors |
| Compliance descriptors (any kind) | Indefinite | Operator's pod |
| Deploy events | Indefinite | Compliance descriptors |
| Incident artifacts | Indefinite | Compliance descriptors |
| Performance metrics | 30 days | Azure Monitor |
| Customer pod content | Customer-controlled | Customer's pod |

## 4. Policy Statements

### 4.1 What MUST be logged

- All authentication attempts (success + failure) at the identity service
- All admin actions (deploys, RBAC changes, credential rotations, env var changes)
- All cross-pod sharing decisions (resolveRecipients calls + outcomes)
- All ABAC policy decisions
- All compliance descriptor publications (including the descriptor URL)
- All key rotations
- All errors at WARN+ severity

### 4.2 What MUST NOT be logged

- Plaintext customer descriptor content
- Customer envelope private keys (these never reach the operator)
- Compliance wallet private key (never logged; only address)
- Authorization tokens, bearer tokens, session secrets
- Customer-supplied PII unless redacted

The privacy preflight (`screenForSensitiveContent`) is a defensive check; the primary control is "don't log it in the first place."

### 4.3 Log integrity

- Application logs are flushed to Azure log analytics in real time.
- Compliance descriptors carry their own integrity (ECDSA signature + IPFS anchor) — no separate integrity layer needed.
- Logs MUST NOT be silently dropped. Log shipping failures MUST themselves be logged.

### 4.4 Monitoring + alerting

- Sev-1 conditions (per [`04-incident-response.md`](04-incident-response.md)) MUST page the operator immediately.
- Sev-2 conditions MUST notify within 1 hour.
- Anomalies (10x baseline error rate, 10x baseline latency, unusual auth-failure spikes) MUST trigger investigation alerts.
- Compliance evidence pipeline failures (signature errors, pod-write failures during compliance:true publish) MUST page the operator.

### 4.5 Audit trail

- The operator's pod functions as the audit trail of record for SOC 2 evidence.
- Audit trail integrity is provided by ECDSA signatures + IPFS anchors per [`08-encryption.md`](08-encryption.md).
- Auditors access via `/audit/*` relay endpoints (read-only) and `/audit/verify-signature` (independent verification).
- The operator MUST NOT modify or delete audit trail descriptors. Corrections occur via `cg:supersedes` chains, not in-place edits.

### 4.6 Log review

- The operator MUST review error-rate and auth-failure dashboards weekly.
- The Independent Advisor MUST receive monthly summary of compliance descriptor activity (counts, framework breakdown, anomalies).
- Quarterly review of log retention + content for fitness.

## 5. Procedures

### 5.1 Daily

- Operator skims dashboards for anomalies (5 min)

### 5.2 Weekly

- Operator reviews error rates + auth failure rates
- Address recurring patterns

### 5.3 Monthly

- Compliance descriptor activity summary published as descriptor (`dct:conformsTo soc2:CC4.1`)
- Forwarded to Advisor

### 5.4 Quarterly

- Review log retention + types
- Verify alert routing still works (test alert)
- Publish review descriptor

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6.

## 7. Mapping

- SOC 2: CC4.1 (monitoring activities), CC4.2 (evaluation of monitoring results), CC7.2 (system event detection)
- ISO 27001 Annex A: A.12.4
