# Security Policy

## Reporting a vulnerability

**Contact:** security@interego.dev (or open a private GitHub Security Advisory on this repository).

**Response targets:**

- **Acknowledgment:** within 5 business days of receipt
- **Triage:** within 10 business days, with severity classification + initial impact analysis
- **Fix or compensating control:** per the SLAs in [`spec/policies/14-vulnerability-management.md`](spec/policies/14-vulnerability-management.md) §5.1

| Severity | Triage | Remediation |
|---|---|---|
| Critical (CVSS 9.0–10.0) | < 4 hours | < 7 days |
| High (CVSS 7.0–8.9) | < 1 business day | < 30 days |
| Medium (CVSS 4.0–6.9) | < 5 business days | < 90 days |
| Low (CVSS 0.1–3.9) | < 10 business days | Best effort |

## Coordinated disclosure

We support coordinated disclosure. The default disclosure window is 90 days from acknowledgment, extendable by mutual agreement when remediation requires more time.

If you require an alternative arrangement (e.g., longer embargo for a critical-impact upstream library issue, or shorter for an active-exploitation case), state that in your initial report.

## Scope

In scope:

- `@interego/core` library
- `@interego/mcp` MCP server
- The relay (`deploy/mcp-relay/`) and identity service (`deploy/identity/`)
- The validator and dashboard
- The Interego protocol specification itself (zero-day cryptographic, identity, or composition vulnerabilities)

Out of scope:

- Customer-hosted pods (responsibility of the customer / their pod provider)
- Third-party agent frameworks consuming the MCP (please report to those projects directly)
- Denial-of-service via volumetric attack (covered by infrastructure rate limits, not application logic)
- Issues requiring physical access to a developer workstation

## What you can expect from us

- Prompt acknowledgment per the targets above
- Honest assessment of severity (we won't downgrade to avoid embarrassment)
- Public credit on the published advisory if you consent (default: yes, with your preferred name and link)
- Listing in [`SECURITY-ACKNOWLEDGMENTS.md`](SECURITY-ACKNOWLEDGMENTS.md) after responsible disclosure

## What we ask of you

- Give us a reasonable opportunity to remediate before public disclosure
- Don't access, modify, or destroy customer data while researching
- Don't target individuals — focus on the system
- If you encounter customer data while investigating, stop and report immediately

## RFC 9116 security.txt

This policy is also reachable at:

- `https://<service-host>/.well-known/security.txt`

on every Interego-operated container app (relay, identity, validator, dashboard, pgsl-browser).

## Vulnerability management policy

The full operational policy (intelligence sources, SLA enforcement, post-incident review) lives in [`spec/policies/14-vulnerability-management.md`](spec/policies/14-vulnerability-management.md).
