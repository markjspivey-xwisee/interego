# Interego Policies

This directory holds the written policy set Interego operates under. Together they form the documented basis for SOC 2 Trust Services Criteria conformance and a candidate framework for ISO 27001 Annex A control mapping.

Each policy follows the same structure:

1. **Purpose** — what risk the policy addresses
2. **Scope** — what systems, data, and people the policy covers
3. **Roles & Responsibilities** — who does what
4. **Policy Statements** — the binding rules (RFC 2119 MUST / SHOULD)
5. **Procedures** — how the policy is operationalized
6. **Exceptions** — how to request and document an exception
7. **Review** — cadence and trigger for review
8. **Mapping** — SOC 2 Common Criteria + AICPA Trust Service Criteria control IDs

## Policy index

| # | Policy | SOC 2 mapping |
|---|---|---|
| 1 | [Information Security Policy](01-information-security.md) | CC1.1, CC2.1, CC3.1 |
| 2 | [Access Control Policy](02-access-control.md) | CC6.1, CC6.2, CC6.3 |
| 3 | [Change Management Policy](03-change-management.md) | CC8.1 |
| 4 | [Incident Response Policy](04-incident-response.md) | CC7.3, CC7.4, CC7.5 |
| 5 | [Business Continuity & Disaster Recovery](05-business-continuity.md) | A1.2, A1.3 |
| 6 | [Vendor / Third-Party Management](06-vendor-management.md) | CC9.2 |
| 7 | [Data Classification & Handling](07-data-classification.md) | C1.1, C1.2 |
| 8 | [Encryption Policy](08-encryption.md) | CC6.7 |
| 9 | [Secure Software Development Lifecycle](09-secure-sdlc.md) | CC8.1, CC7.1 |
| 10 | [Logging & Monitoring Policy](10-logging-monitoring.md) | CC4.1, CC4.2, CC7.2 |
| 11 | [Acceptable Use Policy](11-acceptable-use.md) | CC1.4 |
| 12 | [Data Retention & Disposal Policy](12-data-retention.md) | C1.2, P4.2 |
| 13 | [Risk Management Policy](13-risk-management.md) | CC3.1, CC3.2, CC3.3 |
| 14 | [Vulnerability Management Policy](14-vulnerability-management.md) | CC7.1, CC7.2 |
| 15 | [Privacy Policy](15-privacy.md) | P1, P5, P6, P8 |

## Adoption

These policies are adopted by the operator and reviewed annually (or upon material change).

The first adoption record is the publication of this directory; future adoptions are recorded as `compliance: true` descriptors with `dct:conformsTo soc2:CC2.2` and `prov:wasAttributedTo` set to the operator's DID.

## How policies relate to the Interego protocol

Interego is the substrate that produces evidence; the policies are the human commitments that say what the evidence will show. A policy without evidence is aspirational; evidence without a policy is unmoored from intent. SOC 2 wants both. So does the operator.
