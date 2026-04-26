# Operations Runbook

**Audience:** the Interego operator. Day-to-day procedures for deploying, monitoring, rotating credentials, responding to incidents, and producing the evidence the SOC 2 controls expect.

**Status:** documents the operational state as of 2026-04-25 and the target state for SOC 2 readiness. Each section calls out current vs target so the gap is visible.

**Companion documents:**
- [`SOC2-PREPARATION.md`](SOC2-PREPARATION.md) — strategic framing, scope, gap analysis
- [`policies/`](policies/) — written policy commitments
- [`CONFORMANCE.md`](CONFORMANCE.md) — protocol-level conformance levels

---

## 1. Production topology

| Component | Resource | Notes |
|---|---|---|
| Relay | Azure Container App `mcp-relay` (eastus) | OAuth-gated MCP HTTP/SSE; 2 replicas min |
| Identity | Azure Container App `identity` (eastus) | Stateless DID resolver + signature verifier; 1 replica |
| Validator | Azure Container App `validator` (eastus) | SHACL validation + finding publisher |
| Dashboard | Azure Container App `dashboard` (eastus) | Operator + customer dashboard |
| pgsl-browser | Azure Container App `pgsl-browser` (eastus) | Public PGSL exploration UI |
| CSS pods | Azure Container App `css` (eastus) + Azure Files share `css-data` | Per-customer Solid pod hosting |

All container apps share a Container Apps environment in `eastus`. Public ingress today uses Azure-assigned `*.azurecontainerapps.io` hostnames with Azure-managed TLS certificates. Custom-domain mapping (e.g., `relay.interego.dev`, `identity.interego.dev`) is on the roadmap for production launch — when added, point the apex of the chosen domain at the Azure Container Apps environment IP and request managed certs per [Azure custom domain docs](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-certificates). Until then the `*.azurecontainerapps.io` hostnames are the canonical URLs (set as `PUBLIC_BASE_URL` env var on each app).

## 2. Deploy

### Current state (2026-04-25)

- Operator runs `deploy/azure-deploy.sh` from local workstation
- Deploys current `main` after manual `git pull` + `npm test`
- No CI gating on deploy
- No automated deploy event log
- Container revisions retained (default Azure behavior)

### Target state

- CI builds + tests every push to `main`
- Deploy job triggered by tag push (e.g., `release/*` or `deploy/*`) requiring manual approval gate
- Deploy event automatically published as `compliance: true` descriptor with `dct:conformsTo soc2:CC8.1`
- Rollback runbook validated quarterly

### Deploy procedure (current)

1. Ensure local checkout is clean and on `main`:
   ```bash
   git status        # clean
   git pull          # up to date
   npm test          # passes
   npm run build     # passes
   ```
2. Confirm Azure subscription:
   ```bash
   az account show
   ```
3. Run the deploy script:
   ```bash
   bash deploy/azure-deploy.sh <component>
   ```
   where `<component>` is one of: `relay`, `identity`, `validator`, `dashboard`, `pgsl-browser`, `css`, or `all`.

4. Validate deploy:
   - Hit `/health` on each affected service
   - Confirm new revision is `Active` in Azure portal
   - Confirm 100% traffic shifted (or staged percentage if doing blue/green)

5. Publish deploy event descriptor (target state — manual today):
   ```typescript
   await publish_context({
     graph_iri: `urn:graph:ops:deploy:${new Date().toISOString()}`,
     graph_content: `
       <urn:event:deploy> a soc2:DeployEvent ;
         dct:conformsTo soc2:CC8.1 ;
         soc2:commitSha "${commitSha}" ;
         soc2:component "${component}" ;
         soc2:deployedBy <${operatorDid}> ;
         soc2:deployedAt "${new Date().toISOString()}"^^xsd:dateTime .`,
     compliance: true,
     compliance_framework: 'soc2',
     modal_status: 'Asserted',
   });
   ```

### Rollback procedure

1. Identify the prior known-good revision in Azure Portal → Container App → Revisions
2. Activate the prior revision (`az containerapp revision activate`)
3. Shift 100% traffic to it (`az containerapp ingress traffic set`)
4. Confirm via `/health` and customer-facing smoke test
5. Publish rollback event descriptor citing the deploy that triggered rollback

---

## 3. Access management

### Current state

- Operator holds all admin credentials
- MFA enabled on Azure portal, GitHub, NPM (operator account)
- No quarterly access reviews on record yet
- Service principals for CI exist but not yet federated (using stored secrets)

### Target state

- MFA on every system, hardware-backed where supported
- Quarterly access reviews recorded as compliance descriptors
- All CI uses federated identity (Azure Workload Identity, GitHub OIDC) — no stored credentials
- PIM (or equivalent) for time-bound elevation

### Quarterly access review procedure

1. Export Azure RBAC:
   ```bash
   az role assignment list --all -o table > access-review-azure-$(date +%Y%m%d).txt
   ```
2. Export GitHub org members:
   ```bash
   gh api orgs/markjspivey-xwisee/members --paginate > access-review-github-$(date +%Y%m%d).json
   ```
3. Export NPM access:
   ```bash
   npm access list collaborators @interego/core > access-review-npm-$(date +%Y%m%d).txt
   ```
4. Pinata: export API key list from dashboard
5. For each principal: confirm role still required + scope still appropriate
6. Revoke unneeded access; rotate any shared credentials
7. Publish review record:
   ```typescript
   await publish_context({
     graph_iri: `urn:graph:ops:access-review:${quarter}`,
     graph_content: /* SPARQL/Turtle listing principals + scopes + decisions */,
     compliance: true,
     compliance_framework: 'soc2',
     modal_status: 'Asserted',
   });
   ```

### Onboarding a new principal

1. Identify role + minimum required scope
2. Verify principal's DID
3. Provision MFA-required accounts in scope systems
4. Record onboarding as compliance descriptor (`dct:conformsTo soc2:CC6.2`)
5. Schedule first quarterly access review for the new principal

### Departure / role change

Within 24 hours of role change:

1. Revoke production access in every in-scope system
2. Rotate any credentials the principal had shared access to
3. Record offboarding as compliance descriptor

---

## 4. Compliance wallet management

### Current state

- Wallet at `~/.interego/compliance.wallet.json` (operator workstation)
- History at `~/.interego/compliance.history.json`
- Generated via `loadOrCreateComplianceWallet()` on first compliance:true publish
- Operator password held in secure password manager
- Backed up manually before rotations

### Target state

- Daily automated backup to encrypted off-site storage
- Annual scheduled rotation
- Restore tested quarterly

### Annual rotation procedure (each January)

1. Confirm current wallet + history backed up
2. Run rotation:
   ```typescript
   import { rotateComplianceWallet } from '@interego/core';
   const result = await rotateComplianceWallet(WALLET_PATH);
   console.log('Retired:', result.retired.address);
   console.log('New active:', result.active.address);
   ```
3. Publish rotation event:
   ```typescript
   await publish_context({
     graph_iri: `urn:graph:ops:wallet-rotation:${new Date().toISOString()}`,
     graph_content: /* turtle citing retired + new addresses, reason: scheduled */,
     compliance: true,
     compliance_framework: 'soc2',
     modal_status: 'Asserted',
   });
   ```
4. Validate: publish a test compliance descriptor + verify it signs with new key
5. Validate: fetch a pre-rotation descriptor + verify it still validates via history walk

### Compromise rotation procedure

1. Within 1 hour of suspected compromise: rotate per above
2. Within 4 hours: publish compromise descriptor citing the suspected event
3. Within 24 hours: scope investigation (which descriptors signed during suspect window)
4. If actual compromise confirmed: customer notification + advisory

---

## 5. Backups

### Current state

- Manual snapshots taken before destructive operations (e.g., wipe-and-restart)
- No scheduled snapshot policy on Azure Files
- Source code backed up via GitHub + local clone

### Target state

- Daily automated snapshots of `css-data` Azure Files share (30-day retention min, 90-day target)
- Pre-destructive snapshot retention: 7 days minimum
- Compliance wallet daily backup to encrypted off-site
- Quarterly restore exercise

### Configuring daily snapshots (target)

```bash
az backup policy create \
  --resource-group <rg> \
  --vault-name <vault> \
  --name daily-css-snapshot \
  --policy '{
    "schedulePolicy": { "scheduleRunFrequency": "Daily", "scheduleRunTimes": ["02:00"] },
    "retentionPolicy": { "retentionDuration": { "count": 90, "durationType": "Days" } }
  }'

az backup protection enable-for-azurefileshare \
  --resource-group <rg> \
  --vault-name <vault> \
  --policy-name daily-css-snapshot \
  --storage-account <sa> \
  --azure-file-share css-data
```

### Quarterly restore exercise

1. Pick a recent snapshot (not the latest — exercise the "older snapshot" path)
2. Spin up a clean resource group
3. Restore the snapshot to a new Azure Files share
4. Bring up CSS instances reading the restored share
5. Validate: descriptor signatures verify, federation queries return, sample auth works
6. Tear down restored environment
7. Publish result descriptor (time-to-restore, integrity check, lessons learned)

---

## 6. Monitoring + alerting

### Current state

- Application logs to stdout → Azure Container Apps log analytics
- Azure Monitor metrics (CPU, memory, request count) per container app
- No central SIEM
- No structured alerting beyond manual dashboard checks

### Target state

- Sev-1 conditions page operator (email + SMS minimum)
- Sev-2 notify operator within 1 hour
- Anomaly detection on auth failure rate, error rate, latency
- Compliance pipeline health monitored separately

### Daily check (5 min)

- Skim Azure portal metrics for each container app
- Check `/health` on each service
- Check for any new GitHub Dependabot alerts

### Weekly check (15 min)

- Review error rate trends (last 7 days)
- Review auth failure rate trends
- Address any patterns
- Confirm log retention is shipping correctly

### Monthly check (30 min)

- Compile compliance descriptor activity summary
- Forward to Independent Advisor
- Review subprocessor SOC 2 report freshness

### Alert rules to configure (target)

| Condition | Severity | Channel |
|---|---|---|
| Any service `/health` returns non-200 for > 5 min | Sev-1 | Email + SMS |
| Error rate > 10x baseline for > 10 min | Sev-2 | Email |
| Auth failure rate > 10x baseline for > 10 min | Sev-2 | Email |
| Latency p99 > 10x baseline for > 15 min | Sev-3 | Email |
| Compliance descriptor publish failure | Sev-2 | Email |
| Wallet load failure | Sev-1 | Email + SMS |
| Cert expiring in < 14 days | Sev-2 | Email |

---

## 7. Incident response

Detailed in [`policies/04-incident-response.md`](policies/04-incident-response.md). Operational summary:

### On Sev-1 declaration

1. Acknowledge alert
2. Open incident descriptor (`dct:conformsTo soc2:CC7.3`)
3. Notify Independent Advisor within 4 hours
4. Begin containment (stop the bleeding)
5. Update status page within 30 minutes
6. Notify affected customers within 4 hours
7. Document timeline as you go (incident descriptor + chained updates via `cg:supersedes`)

### Post-incident

1. Within 5 business days: blameless post-mortem published as compliance descriptor (`dct:conformsTo soc2:CC7.4`)
2. Action items assigned with owners + due dates
3. Process improvements implemented within 30 days

---

## 8. Quarterly compliance review

End of each quarter (within 10 business days):

1. Run access review (§3)
2. Run change review (list deploys + classify)
3. Run risk review (update risk register per [`policies/13-risk-management.md`](policies/13-risk-management.md))
4. Review log retention + monitoring fitness
5. Review subprocessor list freshness
6. Aggregate quarter's compliance descriptors → summary report
7. Forward to Independent Advisor
8. Publish quarterly review descriptor

---

## 9. Annual review

Calendar year start (January):

1. Policy review (every policy in [`policies/`](policies/))
2. Risk register annual review
3. Compliance wallet rotation
4. Subprocessor SOC 2 report collection (all in-scope vendors)
5. Pentest scheduled
6. Tabletop exercise (Sev-1 simulation)
7. Annual review descriptor published

---

## 10. Vendor changes

### Adding a vendor

1. Apply selection criteria in [`policies/06-vendor-management.md`](policies/06-vendor-management.md) §4.1
2. Sign contract / accept terms
3. Provision access with MFA per [`policies/02-access-control.md`](policies/02-access-control.md)
4. Add to inventory ([`policies/06-vendor-management.md`](policies/06-vendor-management.md) §3)
5. Update Privacy Notice if customer-facing data flow
6. Publish onboarding descriptor

### Removing a vendor

1. Identify all credentials issued by vendor → revoke
2. Identify all customer data with vendor → export or delete
3. Remove from inventory
4. Update Privacy Notice
5. Publish offboarding descriptor

---

## 11. Developer environment hygiene

The workstation used for production access is itself in scope per [`policies/11-acceptable-use.md`](policies/11-acceptable-use.md) §3.2.

Required:

- Disk encryption (BitLocker on Windows, FileVault on macOS)
- Screen lock ≤ 5 min
- Auto-update OS + security patches
- Hardware MFA available (YubiKey or platform authenticator)
- Password manager (no credentials in plaintext anywhere on disk)
- Pre-commit hooks: secret scanning via `gitleaks` (preferred — actively maintained, fast, low false-positive rate). Install once with `gitleaks install --source .` then use the `pre-commit` framework or husky to wire `gitleaks protect --staged` on every commit. Failure modes: gitleaks reports a finding → commit is blocked → operator either redacts the secret or, if the finding is a false positive, adds a targeted `.gitleaksignore` entry citing why. GitHub-side defense-in-depth: the repo's GitHub Advanced Security secret scanning is enabled and will catch any secret that slipped past the pre-commit hook
- No production credentials in shell history (verify with `history` review monthly)

---

## 12. Common operations reference

### Restart a container app

```bash
az containerapp revision restart \
  --resource-group <rg> \
  --name <containerapp> \
  --revision <revision>
```

### View recent logs

```bash
az containerapp logs show \
  --resource-group <rg> \
  --name <containerapp> \
  --tail 200 --follow
```

### Roll back to prior revision

```bash
# List revisions
az containerapp revision list --resource-group <rg> --name <containerapp> -o table

# Activate prior revision
az containerapp revision activate --resource-group <rg> --name <containerapp> --revision <prior>

# Shift traffic
az containerapp ingress traffic set \
  --resource-group <rg> --name <containerapp> \
  --revision-weight <prior>=100
```

### Take an Azure Files snapshot

```bash
az storage share snapshot \
  --account-name <sa> \
  --name css-data
```

### Restore from Azure Files snapshot

```bash
# Snapshots are listed in the portal under Storage account → File shares → Snapshots
# Mount the snapshot read-only, copy what you need, or attach as a new share
```

### Verify a compliance descriptor signature independently

```bash
curl -s "https://<relay>/audit/verify-signature?descriptor=<descriptorUrl>" | jq
```

### Generate a per-framework compliance report

```bash
curl -s "https://<relay>/audit/compliance/soc2?pod=<podUrl>" | jq
```

---

## 13. Known gaps + roadmap

| Gap | Plan | Target |
|---|---|---|
| No CI deploy gating | Add GitHub Action triggered by tag push | Q3 2026 |
| No automated deploy descriptors | Wrap `azure-deploy.sh` in publisher | Q3 2026 |
| No cross-region redundancy | Document; add when scale warrants | Backlog |
| No SIEM | Centralize logs in Log Analytics + alert rules | Q3 2026 |
| No automated backup policy | Configure Azure Backup Vault | Q2 2026 |
| Solo operator | Engage Independent Advisor | Before audit engagement |
| No formal entity | Incorporate | Before audit engagement |
| No security.txt acknowledgments | Maintain SECURITY-ACKNOWLEDGMENTS.md as researchers report | Ongoing |

Each gap above MUST appear in the risk register per [`policies/13-risk-management.md`](policies/13-risk-management.md) §4.6 with treatment plan + owner + target date.
