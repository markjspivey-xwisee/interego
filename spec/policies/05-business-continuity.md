# Business Continuity & Disaster Recovery Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + after every restore exercise

## 1. Purpose

To ensure Interego services can be restored after disruption (regional outage, data corruption, vendor failure, ransomware, operator unavailability) within targeted recovery objectives.

## 2. Scope

- Production Azure Container Apps (relay, identity, validator, dashboard)
- Production CSS pod hosts and Azure Files storage
- Operator's compliance wallet + history
- Source code and CI artifacts
- Customer pods (recovery responsibility shared per [`07-data-classification.md`](07-data-classification.md))

## 3. Recovery Objectives

| Asset | Recovery Time Objective (RTO) | Recovery Point Objective (RPO) |
|---|---|---|
| Relay (read-only failover) | 1 hour | 0 (stateless) |
| Identity service | 1 hour | 0 (stateless) |
| Validator | 4 hours | 0 (stateless) |
| Dashboard | 4 hours | 0 (stateless) |
| CSS pod hosts (full) | 24 hours | 24 hours |
| CSS pod hosts (read-only) | 4 hours | 24 hours |
| Source code | 1 hour (rehydrate from GitHub) | 0 (mirrored) |
| Compliance wallet | 1 hour (encrypted backup) | 24 hours |

These are targets. Actual capabilities MUST be measured during quarterly restore exercises.

## 4. Policy Statements

### 4.1 Backup

- Azure Files storage backing CSS pods MUST be snapshot daily.
- Snapshots MUST be retained for minimum 30 days; 90 days preferred.
- Pre-destructive-operation snapshots (e.g., wipe-and-restart) MUST be retained for minimum 7 days.
- Compliance wallet + history file MUST be backed up to encrypted off-site storage daily.
- Source code is implicitly backed up by GitHub; the Operator MUST maintain a local clone of all repositories as redundancy.

### 4.2 Restore testing

- Restore exercises MUST be performed quarterly.
- Each exercise restores from a known-good backup to a non-production environment, validates data integrity, and measures actual RTO/RPO against targets.
- Results published as compliance descriptors with `dct:conformsTo soc2:A1.3`.

### 4.3 Geographic redundancy

- Production currently runs in `eastus`. Cross-region redundancy is a future objective; until then, the project documents geographic single-point-of-failure risk in the risk register.
- Customers requiring geographic redundancy MUST be told this is not currently provided and offered to deploy their own pod in their preferred region.

### 4.4 Operator unavailability

- The Operator MUST document: emergency contact escalation, location of credential vault, location of backup keys, whom to notify of operator incapacitation.
- Independent Advisor MUST have documented break-glass procedure (sealed envelope or equivalent) to recover service for at least read-only operation if the Operator is unreachable for > 7 days.
- Break-glass invocation MUST be recorded as a compliance descriptor.

### 4.5 Vendor failure

- If Azure availability is degraded:
  - Read-only mode via cached artifacts where possible
  - Affected customers notified per [`04-incident-response.md`](04-incident-response.md)
- If GitHub is unavailable:
  - Local clones serve as fallback for source code
  - Deploys can proceed from local checkout
- If Pinata is unavailable:
  - IPFS pinning falls back to no-op; descriptors still signed and stored on pod; pinning retried when service returns
- If a customer's chosen pod provider fails:
  - Customer responsibility; project provides documentation on pod migration

### 4.6 Ransomware / destructive intrusion

- Daily snapshots are the primary defense against destructive intrusion.
- Snapshots MUST be stored with separate access credentials from production (no single credential compromise affects both).
- A confirmed destructive intrusion triggers Sev-1 per [`04-incident-response.md`](04-incident-response.md), with specific recovery from the most recent pre-intrusion snapshot.

## 5. Procedures

### 5.1 Backup configuration

Documented in [`OPS-RUNBOOK.md`](../OPS-RUNBOOK.md) §Backups.

### 5.2 Quarterly restore exercise

1. Identify a recent snapshot
2. Spin up a clean Azure resource group
3. Restore the snapshot to that group
4. Bring up CSS instances reading the restored share
5. Validate: descriptor signatures verify, federation queries return, sample customer auth works
6. Tear down restored environment
7. Publish result descriptor with metrics: time-to-restore, data integrity check pass/fail, lessons learned

### 5.3 Disaster declaration

A disaster is declared when normal incident response cannot restore service within RTO. Declaration:

1. Operator (or Advisor under break-glass) declares disaster
2. Customers notified within 1 hour
3. Recovery plan executed (failover region; restore from backup; manual workaround)
4. Disaster descriptor published with `dct:conformsTo soc2:A1.2`
5. Post-disaster review within 7 days

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6.

## 7. Mapping

- SOC 2: A1.2 (system availability), A1.3 (recovery testing)
- ISO 27001 Annex A: A.17.1, A.17.2
