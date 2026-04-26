# Vendor / Third-Party Management Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual + before any new vendor onboarding

## 1. Purpose

To ensure third-party vendors processing or storing Interego data are appropriately vetted, contracted, monitored, and reviewed; and to prevent supply-chain risk from undermining the project's security posture.

## 2. Scope

Any external party that:

- Hosts production infrastructure (Azure)
- Stores or processes customer data (Azure Storage, customer pods)
- Distributes Interego artifacts (NPM, GitHub Releases)
- Provides identity / DNS / TLS / certificate / DDoS / CDN services
- Provides operational tooling that holds production credentials (deploy tools, secrets managers)

## 3. Vendor Inventory

The current authoritative list:

| Vendor | Service | Data type | Criticality | SOC 2 Type 2 |
|---|---|---|---|---|
| Microsoft Azure | Container Apps, Files, Monitor, RBAC | Production application + customer pods (encrypted) | Critical | Yes (Service Trust Portal) |
| GitHub (Microsoft) | Source code, CI, package release | Source + build artifacts | Critical | Yes (same source) |
| NPM (GitHub) | Package distribution | Built artifacts (public) | High | Yes (same source) |
| Pinata Cloud, Inc. | IPFS pinning of compliance anchors | Public Turtle + signature blobs | Medium | Request annually |
| Domain registrar (TBD) | DNS registration | Operator contact info | Low | Not standard |
| Let's Encrypt / Azure-managed certs | TLS issuance | Certificate metadata | Medium | CA/Browser Forum baseline |
| Cloudflare (if used) | DNS / CDN / DDoS | Hostnames, cached public assets | Medium | Yes (public) |

This inventory MUST be kept current. Any vendor addition or change publishes a compliance descriptor with `dct:conformsTo soc2:CC9.2`.

## 4. Policy Statements

### 4.1 Vendor selection criteria

Before engaging a new vendor that handles customer data, the Operator MUST:

1. Document the data the vendor will receive
2. Verify the vendor offers a SOC 2 Type 2 report or equivalent (ISO 27001, regulatory certification)
3. Verify the vendor's terms of service do not claim ownership of customer data
4. Verify the vendor offers data deletion / export on termination
5. Confirm the vendor's region of operation aligns with applicable customer data residency requirements
6. Document the migration / exit plan

### 4.2 Contracts

- All vendors with access to customer data MUST be under a written contract or attested terms of service.
- Where personal data is processed, a Data Processing Agreement (DPA) MUST be in place.
- Where the contract type permits, an SLA with availability + incident notification commitments MUST be agreed.

### 4.3 Annual vendor review

Once per year, for each vendor on the inventory:

1. Fetch latest SOC 2 / ISO 27001 / equivalent report
2. Review for material findings (qualifications, exceptions, control failures)
3. Re-confirm scope of data handled
4. Re-confirm contract validity + DPA presence
5. Document review as compliance descriptor

If a vendor's report shows material findings without remediation, escalate to consideration of vendor replacement.

### 4.4 Subprocessor changes

- Vendors that change their own subprocessors MUST notify under their DPA.
- Material subprocessor changes MUST be reviewed within 30 days.
- Customers MUST be notified of subprocessor changes that affect their data residency or security posture.

### 4.5 Vendor offboarding

When a vendor is removed from production:

1. All credentials issued by the vendor MUST be revoked
2. All customer data stored with the vendor MUST be exported or deleted (whichever applies)
3. Offboarding recorded as compliance descriptor

### 4.6 Customer-controlled vendors

Customer pods are hosted by the customer's chosen pod provider. The provider is the customer's vendor, not Interego's. Interego provides documentation on pod-provider evaluation but does not warrant the customer's choice. This boundary MUST be made clear in customer-facing documentation.

## 5. Procedures

### 5.1 Onboarding a new vendor

1. Open issue / descriptor describing vendor + scope
2. Apply selection criteria (§4.1)
3. Sign contract / accept terms; record date
4. Provision access (with MFA per [`02-access-control.md`](02-access-control.md))
5. Add to inventory (§3)
6. Publish onboarding descriptor

### 5.2 Annual review

Performed in January for the prior calendar year:

1. Iterate through inventory
2. For each: download report, review, document findings
3. Publish review summary descriptor referencing each per-vendor finding

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6. Engaging a vendor without a SOC 2 report MUST cite a specific business justification + alternative assurance (e.g., open-source code review, third-party audit, low data sensitivity).

## 7. Mapping

- SOC 2: CC9.2 (vendor risk management)
- ISO 27001 Annex A: A.15.1, A.15.2
