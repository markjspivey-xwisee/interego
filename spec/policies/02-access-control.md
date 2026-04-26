# Access Control Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + after every staffing change

## 1. Purpose

To control who can access Interego systems, data, and credentials, and to ensure access is granted on least-privilege basis, reviewed regularly, and revoked promptly when no longer needed.

## 2. Scope

- Azure tenant + subscriptions hosting production infrastructure
- GitHub organization + repositories under github.com/markjspivey-xwisee
- NPM publish access for `@interego/*` packages
- Pinata account (IPFS pinning)
- Domain registrar access
- Production CSS pods (admin pages)
- Production compliance wallet keys
- Operator's personal pod (acting as compliance evidence store)

## 3. Roles & Responsibilities

| Role | Access scope |
|---|---|
| Operator | Full admin to all in-scope systems |
| Independent Advisor | Read-only to evidence sources; PR review on protected branches; no production credential access |
| Auditor (engaged) | Time-bound read-only to Azure RBAC + pod `/audit/*` endpoints |
| Customer | Their own pod only |

## 4. Policy Statements

### 4.1 Authentication

- All admin access MUST require multi-factor authentication. Single-factor (password-only) login is prohibited.
- Where supported, MFA MUST be hardware-backed (FIDO2 / WebAuthn / YubiKey). SMS-based MFA is permitted only as fallback when no hardware option exists.
- Service accounts (CI deploy, automated jobs) MUST authenticate via federated identity (Azure Workload Identity, GitHub OIDC) — not stored secrets — wherever the platform supports it.
- Customer-facing identity uses DID/SIWE/WebAuthn per the [auth architecture document](../../deploy/identity/AUTH-ARCHITECTURE.md). No passwords are accepted for any customer-facing surface.

### 4.2 Authorization

- All access MUST be granted explicitly. Default deny.
- Roles MUST be scoped to the smallest subscription / repository / pod necessary.
- Standing admin access is restricted to the Operator role.
- Time-bound access for advisors, contractors, or auditors MUST be granted via Azure PIM (or equivalent) with documented start + end dates.

### 4.3 Access reviews

- The Operator MUST review all production access quarterly.
- Each review MUST be recorded as a compliance descriptor (`dct:conformsTo soc2:CC6.2`) listing every principal with access, their scope, and a justification statement.
- Findings MUST be acted on within 5 business days; revocation events recorded as compliance descriptors.

### 4.4 Provisioning + deprovisioning

- New access requests MUST go through the Operator and be recorded as compliance descriptors before granting.
- Deprovisioning MUST occur within 24 hours of role change or departure. Recorded as compliance descriptor.
- Shared credentials are prohibited. Each principal has their own.

### 4.5 Customer access

- Customers authenticate via DID/SIWE/WebAuthn — no credentials touch the operator's systems.
- Cross-pod sharing is cryptographic (envelope-encrypted to recipient public keys), not access-list-based; the operator cannot grant or revoke access to customer descriptors.
- Customer pod owners control all access to their pod via Solid WAC; operator role on customer pod is limited to platform administration of the CSS instance.

### 4.6 Privileged keys

- The compliance signing wallet MUST be stored on disk encrypted with a password held only by the Operator.
- The wallet history file (`compliance.history.json`) MUST be backed up before any rotation.
- Rotation events MUST be recorded as compliance descriptors with `dct:conformsTo soc2:CC6.7`.
- Loss or suspected compromise of the active wallet key triggers immediate rotation per [04-incident-response.md](04-incident-response.md).

## 5. Procedures

### 5.1 Quarterly access review

Performed within 10 business days of each quarter end:

1. Export Azure RBAC role assignments (`az role assignment list`)
2. Export GitHub organization member + team list
3. Export NPM `@interego` access list (`npm access list collaborators @interego/core`)
4. Export Pinata API key list
5. For each principal: confirm access still required + scope still appropriate
6. Document any changes; revoke unneeded access
7. Publish review record as `compliance: true` descriptor

### 5.2 New principal onboarding

1. Identify role and minimum required scope
2. Request principal's DID + verify
3. Provision MFA-required accounts in each system in scope for the role
4. Record onboarding as compliance descriptor with `prov:wasAttributedTo` operator
5. Schedule first quarterly access review

### 5.3 Departure / role change

1. Within 24 hours: revoke all production access
2. Rotate any credentials the principal held shared access to
3. Record offboarding as compliance descriptor

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6.

## 7. Mapping

- SOC 2: CC6.1 (logical access controls), CC6.2 (provisioning + deprovisioning), CC6.3 (authorization based on role)
- ISO 27001 Annex A: A.9.1, A.9.2, A.9.4
