# Secure Software Development Lifecycle Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual

## 1. Purpose

To embed security into every stage of the Interego software lifecycle: design, implement, test, deploy, monitor, retire.

## 2. Scope

All code, configuration, and deployment artifacts in:

- `@interego/core` (`src/`)
- `@interego/mcp` (`mcp-server/`)
- Relay (`deploy/mcp-relay/`)
- Identity service (`deploy/identity/`)
- Validator (`deploy/validator/`)
- Dashboard (`deploy/Dockerfile.dashboard` + `examples/compliance-dashboard.html`)
- All CI configuration (`.github/workflows/`)
- All supporting tooling (`tools/`)

## 3. Lifecycle Stages

### 3.1 Design

- New features affecting trust, identity, encryption, or composition MUST start with a design note (PR description, issue, or descriptor with `cg:modalStatus Hypothetical`).
- Designs MUST identify: data sensitivity, trust boundaries crossed, threat model implications.
- For features at the protocol layer, the design MUST be classified per [`spec/LAYERS.md`](../LAYERS.md). Layer-1 work requires architectural review.

### 3.2 Implement

- Coding standards: TypeScript strict mode, no `any` without justification, no runtime dependencies on packages not vetted via [`06-vendor-management.md`](06-vendor-management.md) §4.1 supply-chain criteria.
- Cryptographic operations MUST use approved primitives per [`08-encryption.md`](08-encryption.md). Hand-rolled cryptography is prohibited.
- User input MUST be validated at trust boundaries (MCP tool calls, API endpoints, file reads from customer-controlled locations).
- Sensitive content (API keys, JWTs, etc) MUST NOT be logged. The privacy preflight check (`screenForSensitiveContent`) is a defense in depth, not a substitute for not logging in the first place.
- SQL / SPARQL injection: parameterized queries only.

### 3.3 Test

- Every new feature MUST land with tests.
- Test coverage targets: ≥ 80% on `src/` (overall); 100% on `src/compliance/`, `src/crypto/`, `src/abac/`.
- Property tests preferred for composition, lattice, and cryptographic operations.
- Negative tests required for security-relevant code (verify rejection of malformed signatures, expired tokens, missing facets).
- The full test suite MUST pass before merge per [`03-change-management.md`](03-change-management.md).

### 3.4 Review

- All PRs require approving review per [`03-change-management.md`](03-change-management.md).
- Security-relevant PRs (any change to `src/crypto/`, `src/compliance/`, `src/abac/`, identity service, relay auth flow) MUST be reviewed by the Independent Advisor.
- Review checklist embedded in PR template (TBD).

### 3.5 Deploy

- Deploys via the documented procedure per [`03-change-management.md`](03-change-management.md) §5.1.
- Deploy events publish compliance descriptors per same.

### 3.6 Monitor

- Production telemetry per [`10-logging-monitoring.md`](10-logging-monitoring.md).
- Alerts route to operator per [`04-incident-response.md`](04-incident-response.md).

### 3.7 Retire

- Deprecated APIs / endpoints MUST be marked deprecated for one minor version before removal.
- Customers depending on deprecated APIs MUST be notified.
- Removal recorded as compliance descriptor.

## 4. Policy Statements

### 4.1 Threat modeling

- Major features MUST include a brief threat model (could be a paragraph in the design note).
- Reference framework: STRIDE.
- Threat model artifacts retained as compliance descriptors with `cg:modalStatus Hypothetical`.

### 4.2 Dependency management

- New runtime dependencies require justification + license + maintenance posture review.
- Direct runtime dependencies SHOULD be minimized. Current core has zero runtime deps; preserve this posture wherever possible.
- DevDependencies are less restricted but still subject to license compatibility.

### 4.3 Vulnerability response

Per [`14-vulnerability-management.md`](14-vulnerability-management.md).

### 4.4 Secrets management

- No secrets in source code, ever.
- No secrets in CI configuration except via GitHub Actions encrypted secrets store.
- Production secrets in Azure Key Vault (target state) or environment variables (current state for low-tier secrets).
- Pre-commit hook runs `trufflehog` or equivalent (TBD).

### 4.5 Supply chain

- All `npm install` MUST use `package-lock.json` for reproducibility.
- Releases MUST be from a clean checkout, not from a working directory with uncommitted changes.
- NPM publishes MUST require MFA on the publisher account.
- Provenance attestation (`npm publish --provenance`) MUST be enabled when shipping public packages.

### 4.6 Static analysis

- ESLint MUST run on all PRs.
- TypeScript strict mode MUST remain enabled.
- Ontology lint MUST run on all PRs touching `src/` or `docs/ns/`.
- Derivation lint MUST run on `docs/ns/` changes.

### 4.7 Secure defaults

- New configuration options MUST default to the most secure value.
- Permissive options require explicit opt-in + documentation.

### 4.8 Backwards compatibility

- Breaking changes to the protocol require a major version bump + migration guide.
- Breaking changes to internal APIs may proceed at minor versions but MUST be documented in CHANGELOG.

## 5. Procedures

### 5.1 New feature checklist

Before opening PR for a new feature:

- [ ] Design note exists
- [ ] Threat model section in design
- [ ] Tests written
- [ ] No new runtime deps without justification
- [ ] Layer classification confirmed (L1/L2/L3)
- [ ] Documentation updated
- [ ] Ontology terms (if any) added to corresponding `.ttl`

### 5.2 Annual security review

Once per year, the Operator + Advisor:

1. Review the policy itself for fitness
2. Audit recent dependency additions
3. Review vulnerability response history
4. Identify recurring code-review findings → process improvement

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6.

## 7. Mapping

- SOC 2: CC8.1 (change management), CC7.1 (security operations), CC2.3 (commitment to competence)
- ISO 27001 Annex A: A.14.2
