# Information Security Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator (CISO function)
**Review cadence:** Annual

## 1. Purpose

To establish the high-level security commitments under which Interego operates: confidentiality of customer data, integrity of the protocol implementation, availability of customer-facing services, and the assignment of accountability for each.

This policy is the umbrella document. All other policies in [`spec/policies/`](.) implement specific aspects of this commitment.

## 2. Scope

Applies to:

- All Interego software (`@interego/core`, `@interego/mcp`, the relay, dashboards)
- All production infrastructure (Azure Container Apps, Azure Files, Azure Monitor, the production CSS pod hosts)
- All source code repositories under github.com/markjspivey-xwisee/interego
- All credentials and secrets used to operate the service
- All persons with operational access (currently: the operator and named advisor)
- All third-party services that process Interego customer data (see [`06-vendor-management.md`](06-vendor-management.md))

## 3. Roles & Responsibilities

| Role | Person | Responsibilities |
|---|---|---|
| Operator (CISO) | Mark Spivey | Owns the policy set, approves exceptions, holds production credentials, signs compliance descriptors with the operator wallet |
| Independent Advisor | TBD | Reviews critical PRs (security, deploy, key management); receives quarterly access + risk reports; provides compensating-control sign-off |
| Auditor (when engaged) | TBD | Read-only access to evidence sources; not part of operational team |

The Operator may delegate operational tasks but retains accountability. Delegation events MUST be recorded as compliance descriptors.

## 4. Policy Statements

### 4.1 Confidentiality

The protocol MUST treat all customer descriptor content as confidential by default. Customer-controlled visibility (owner-only, share-with-list) is the only basis for any party other than the customer or their delegated agents reading customer content.

The operator MUST NOT have technical access to plaintext customer content unless the customer has explicitly shared with the operator's agent.

### 4.2 Integrity

All compliance evidence (signed descriptors) MUST be cryptographically verifiable independently of the operator. The operator MUST NOT be the sole party able to verify their own claims.

The operator MUST sign all production deploys via signed git tags or equivalent, and MUST publish a deploy event as a compliance descriptor.

### 4.3 Availability

The relay and identity service SHOULD maintain 99.5% monthly availability measured externally. Planned maintenance windows MUST be announced 48 hours in advance via the project changelog and operator's pod.

### 4.4 Accountability

Every operational action that affects production (deploy, access change, key rotation, incident response) MUST be recorded as a `compliance: true` descriptor with appropriate `dct:conformsTo` mapping to a SOC 2 CC ID. Absence of such a record is itself a finding.

### 4.5 Least privilege

Access to production systems MUST follow least privilege. Standing admin access is acceptable for the Operator role only. All other access MUST be time-bound and recorded.

### 4.6 Defense in depth

No single control is treated as sufficient. The protocol's E2EE is backed by storage-provider access controls; the storage controls are backed by network segmentation; the network controls are backed by audit logging. Every layer has independent failure modes.

### 4.7 Secure by default

New features, deployments, and integrations MUST default to the most restrictive security posture. Opening a default requires documentation in the relevant policy and a corresponding compliance descriptor.

## 5. Procedures

### 5.1 Annual review

Once per calendar year, the Operator and Independent Advisor MUST:

1. Review every policy in this directory
2. Update outdated content
3. Publish a `compliance: true` descriptor with `dct:conformsTo soc2:CC2.2` recording the review
4. Republish each policy file with an updated **Version** + **Effective** header

### 5.2 Material change review

Any of the following triggers an out-of-cycle review:

- A new major feature in the protocol affecting trust, identity, or storage
- A security incident with operational implications
- A change in subprocessor or hosting region
- A change in regulatory regime that the project is asserting conformance to

## 6. Exceptions

Exceptions to any policy MUST be:

1. Requested in writing (issue or descriptor)
2. Approved by the Operator
3. Time-bound (default: 30 days)
4. Recorded as a compliance descriptor with `cg:modalStatus Hypothetical` until the exception expires or is closed

## 7. Mapping

- SOC 2: CC1.1 (control environment), CC1.2 (board oversight — N/A solo, see compensating controls in [`SOC2-PREPARATION.md`](../SOC2-PREPARATION.md) §6), CC2.1 (communication of policies), CC3.1 (risk identification)
- ISO 27001 Annex A: A.5.1, A.5.2
