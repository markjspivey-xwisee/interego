# Change Management Policy

**Version:** 1.0
**Effective:** 2026-04-25
**Owner:** Operator
**Review cadence:** Annual

## 1. Purpose

To ensure changes to Interego production code, infrastructure, and configuration are reviewed, tested, recorded, and reversible; and that every production change produces a verifiable evidence trail.

## 2. Scope

- All commits to the `main` branch of github.com/markjspivey-xwisee/interego
- All deploys to Azure Container Apps in production
- All changes to production configuration (env vars, secrets, scaling settings)
- All changes to ontology files in `docs/ns/`
- All schema-affecting changes to descriptors

## 3. Roles & Responsibilities

| Role | Responsibility |
|---|---|
| Author | Writes the change; opens the PR |
| Reviewer | Reads the PR; approves or requests changes |
| Operator | Final approver; runs the deploy; signs the deploy event descriptor |

For solo-operator periods, the Author and Operator are the same; the Reviewer is the named Independent Advisor. See compensating controls in [`SOC2-PREPARATION.md`](../SOC2-PREPARATION.md) §6.

## 4. Policy Statements

### 4.1 No direct push to main

- Direct push to `main` is prohibited except for documentation-only changes by the Operator.
- All other changes MUST go through PR with at least one approving review.
- Branch protection rules in GitHub MUST enforce this.

### 4.2 Tests must pass

- The full test suite (`npm test`) MUST pass before merge.
- Ontology lint (`tools/ontology-lint.mjs`) MUST pass.
- Derivation lint MUST pass.
- Test failures bypass via `--no-verify`, `--force`, or merge override is prohibited.

### 4.3 Signed commits

- All commits to `main` SHOULD be signed (GPG / SSH signature). The Operator's commits MUST be signed.

### 4.4 Versioning

- Public package releases MUST follow semver.
- Breaking changes MUST be documented in `CHANGELOG.md` with migration guidance.

### 4.5 Deploy gating

- Production deploys are run from a clean checkout of `main` after the PR has merged + tests have passed in CI.
- Deploy script (`deploy/azure-deploy.sh`) MUST be invoked from the Operator's workstation with the active subscription confirmed (`az account show`).
- Deploy events MUST publish a compliance descriptor with `dct:conformsTo soc2:CC8.1` containing: commit SHA, deployer DID, target environment, components changed, rollback plan.

### 4.6 Rollback

- Every deploy MUST have a documented rollback path before execution.
- Container App revisions MUST be retained (minimum 3) to enable revision-pin rollback.
- Rollback events MUST themselves be recorded as compliance descriptors.

### 4.7 Configuration changes

- Production env var or secret changes MUST be made via `az containerapp` commands logged to deploy history, not via portal click-through.
- Each config change publishes a compliance descriptor including: variable name, change reason, prior value hash (NOT plaintext for secrets), new value hash.

### 4.8 Schema / ontology changes

- Adding terms to any `cg:`, `cgh:`, `pgsl:`, `ie:`, `hyprcat:`, `hypragent:`, `abac:`, `registry:`, `passport:`, `code:`, `eu-ai-act:`, `nist-rmf:`, `soc2:` namespace requires updating the corresponding `docs/ns/*.ttl` file in the same PR.
- Removing or renaming a term MUST go through a deprecation cycle: marked deprecated for one minor version before removal.

## 5. Procedures

### 5.1 Standard PR flow

1. Author creates branch from `main`
2. Author commits + pushes; opens PR with description
3. CI runs tests + lints
4. Reviewer reads + approves (or requests changes)
5. Author merges using "Squash and merge" (default) or "Create merge commit" (for multi-commit semantic PRs)
6. CI builds artifacts
7. Operator runs deploy script
8. Operator publishes deploy event descriptor

### 5.2 Emergency / hotfix flow

When a security incident or critical bug warrants out-of-band deploy:

1. Operator creates `hotfix/<issue>` branch
2. Minimum-scope fix
3. Self-merge permitted; Reviewer notified within 24 hours
4. Post-incident PR for review + improvement opens within 5 business days
5. Hotfix descriptor MUST cite the originating incident descriptor via `prov:wasDerivedFrom`

### 5.3 Quarterly change review

Once per quarter, the Operator + Independent Advisor:

1. List all deploys (filter compliance descriptors by `dct:conformsTo soc2:CC8.1`)
2. Confirm each had appropriate review or hotfix justification
3. Identify any pattern (frequent hotfixes → process improvement)
4. Publish review descriptor

## 6. Exceptions

Per [`01-information-security.md`](01-information-security.md) §6. Exception requests for skipping review on a specific change MUST cite a documented business justification.

## 7. Mapping

- SOC 2: CC8.1 (change management)
- ISO 27001 Annex A: A.12.1.2, A.14.2
