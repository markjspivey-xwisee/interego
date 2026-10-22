# PGSL recovery handoff — 2026-10-21

Snapshot: 2026-10-21 14:13 UTC. This is a continuation checkpoint, not a successful-restoration report. It is based on verified recovery receipts, Railway configuration/log readbacks, published-image CI, and the recovery owner's cutover record.

## Current blocker and committed state

Railway's [official status page](https://status.railway.com/) reports a major incident affecting its dashboard/API and pausing builds. The incident began at 07:24 UTC; its 13:40 UTC update still reported paused builds and some unavailable API features. This was independently checked at approximately 14:13 UTC.

The volume move **has committed**. The compact 64 GB volume is attached to the original PostgreSQL service at its existing data mount. The old 200 GB volume is detached and retained. Both PostgreSQL services are **OFFLINE**, with their prior deployments removed. No post-move verification or activation has run.

Attempts to redeploy the removed original deployment returned that there was no build to copy; an attempt to deploy the current `postgres:16` source image returned Railway's temporary deployment-pause error. These are platform errors, not an approval rejection. Do not create a replacement database or bypass the platform pause.

The recovery controller is durably **prepared**, not activated. Application roles on the compact database remain quarantined; this is intentional. The elapsed original receipt deadline does not erase the prepared handoff. Do not reset the journal or repeat preflight/fence/prepare after the volume move.

## Exact resources

Interego project: `b88ceabb-7461-4949-81d7-3d29132e7806`  
Production environment: `449996a2-3533-462f-98c6-4ab4c05dd777`

| Resource | ID / verified state |
|---|---|
| Original PostgreSQL service; restore this service | `ed1eee24-540a-4f41-b33f-0cf2d2511c45`; current source `postgres:16`; OFFLINE |
| Compact volume, now mounted on original | `54013c9e-2954-4332-a4e9-e6dd2b0efca1`; `pgsl-compact-64gb-20261021`; 64,000 MB; `/var/lib/postgresql/data`; us-west2 |
| Old 200 GB volume, now detached | `39097cdd-1093-420a-bc39-572aa2668bbd`; retain until restoration verified |
| Temporary compact-target service | `3a5d33b1-159d-4fad-8a56-2b92780aea0e`; OFFLINE; no volume; start command `sh -c 'echo recovery-target-retired'` |
| Copy worker | `58be2fe6-684a-414b-8e04-dbed553bab48` |
| Cutover controller | `af00805e-de13-4b6c-8ddb-a5c8b8ec355e` |
| Private command service | `a8177fd9-2655-4de8-927c-738e6339f2ed` |
| CSS | `05ec34ca-da58-464d-a548-69c7ccc95f42` |
| Relay | `3e406472-9e03-4cfc-ac0a-1f3700dadd00` |
| Foxxi bridge | `62242b69-dae2-4798-ae0d-d9ea5234d985` |
| Private sweep | `549ce5f1-297c-42b0-9c1a-7e1ff977ff2b`; disabled, no cron/domain |

Removed original deployment: `e98add2c-0a17-49ae-a99a-f8a383bc1e8a`. Removed target deployment: `cc48985f-3e68-416d-94cb-1b0b89ee0141`. Committed volume/configuration patch: `e6eb9666-70cd-44de-838e-ffa93643e0d8`; pending changes were empty after readback.

Original physical system identifier: `7660972292431302690`. **Expected identifier after restart on the compact volume: `7698943519239290914`.** Seeing the old identifier or an empty initialized cluster is a stop condition.

## Verified copy and handoff evidence

The worker completed full verification at **04:52:27.649 UTC**. Values below are exact, not rounded progress estimates.

| Table | Rows | Value bytes | Framed SHA-256 digest |
|---|---:|---:|---|
| `pgsl_kv` | 2,770,097 | 33,612,850,247 | `0095bbf186b9f07245bb452ba6beedca85db429aa492dbe534e4cd6d3738f972` |
| `relay_pgsl_published` | 5,058 | 14,160,622 | `805f03b4654a51859b81bc183cfde9f3ac652aeca9edf96322394cf25c43667d` |

Target database physical size was **35,257,130,007 bytes**. Receipt key: `c17ca319bce3d839e50ee56b5400641152566e395a7c4c73df8b119ea623c6a6`.

Controller preflight succeeded at 04:53:36 UTC; prepare succeeded at **04:54:26 UTC**. PostgreSQL clean-shutdown logs were observed for the target at **04:56:05.960 UTC** and original at **04:56:36.847 UTC**, before moving the volume. Both deployments then reached REMOVED.

The original database was connection-blocked for the copy. The compact database's `iegoadmin` and `relay_pgsl` application roles remain NOLOGIN until activation; a temporary recovery role remains. CSS's six-second startup lock timeout against `/.internal/setup/current-base-url` was explained by the intentional recovery table fence: the startup verifier writes that value. Do not treat this as evidence that data activation has occurred.

## Resume in this order

1. **Wait for supported Railway deployment operations to recover, then deploy the original service's current Docker source image.** First reread its current source and mount and confirm the compact volume above is attached. Use Railway's “Redeploy source image” / current service-instance deploy for `postgres:16`, preserving the current mount and existing PGDATA. Do not blindly replay an old deployment configuration or create a new cluster. A restart/redeploy requiring a removed deployment's missing build is not the appropriate recovery path. The official CLI uses `serviceInstanceDeployV2(environmentId: String!, serviceId: String!)` for a current service-source deploy; any such call must target the exact original service/environment above. Observe terminal deployment success and PostgreSQL readiness before proceeding.

2. **Verify the physical system identifier, then run the existing controller's `verify-activate` phase from its durable prepared state.** Use private connectivity and the existing controller/command services. Do not run source preflight/fence/prepare again. The controller must see expected system ID `7698943519239290914` at the original endpoint, check exact schema/access metadata, recompute both full framed table digests, record activation proof, and only then restore application logins/remove the temporary recovery role. Require the successful activation receipt. **Do not install sweep tables/triggers before this step:** activation expects exactly the two original tables and no added triggers/routines.

3. **Deploy the fixed CSS and relay images and enforce the ceiling on both writers.** Use exact commit `4d41980040f08123bf787523938596d304a77e35`:
   - `ghcr.io/markjspivey-xwisee/interego-css-pgsl:4d41980040f08123bf787523938596d304a77e35`
   - `ghcr.io/markjspivey-xwisee/interego-relay:4d41980040f08123bf787523938596d304a77e35`
   - `PGSL_PG_MAX_DATABASE_BYTES=48000000000` on **both CSS and relay**.
   
   Both images were published successfully. CSS build: run `39546188498`, job `119045872310`; relay: run `39546154800`, job `119045198525`. Final PostgreSQL compatibility/concurrency tests passed **29/29**, including large packages, pressure-safe conditional deletion and lock ordering. Do not deploy superseded `9320653` or `0c2b626` images. A variable configured on an older image does not establish an active guard. Confirm terminal deployment success and service health/read-write behavior. The guard preserves reads/deletes and rejects unsafe positive growth; WAL/other databases are outside `pg_database_size`, so the 48 GB ceiling is headroom, not an absolute volume guarantee.

4. **Restore Foxxi and Hallow only after CSS/relay are healthy.** Verify durable native reads/writes and idle behavior. Keep Hallow's existing /data volumes and native ownership; no world reset or automatic local-JSON fallback. Hallow details and unresolved RAM risk are below.

5. **Enable private reclamation only after its production gates pass.** Follow the measured rollout below. Do not extend this database outage by attempting a pre-activation sweep.

6. **Clean up verified unused recovery resources last.** Retain the old 200 GB volume until the compact database is activated and application restoration/data checks pass. Prove any other recovery database/volume is unused and contains no required data before deletion. An idle metric alone is insufficient.

## Private sweep rollout and retention

Implementation is included in the fixed commit. See [the private sweep procedure](../pgsl-private-sweep.md), `tools/pgsl-store-sweep.railway.mjs`, and `tools/pgsl-store-sweep.mjs`.

Prepared configuration, without a new execution: `PGSL_PG_CONNSTR=${{css.PGSL_PG_CONNSTR}}`, `PGSL_SWEEP_POSTGRES_SERVICE_ID=ed1eee24-540a-4f41-b33f-0cf2d2511c45`, `PGSL_SWEEP_ACTION=off`. The dedicated Bun Function has restart policy NEVER, no public domain, and no cron. The scoped project token was provisioned without exposing its value. No install, mark measurement, or deletion has occurred.

After activation, run one controlled `install` to add the retirement journal/state and trigger; inspect its receipt. Run `measure` in an agreed quiet window with other PGSL reads/writes paused. It uses the actual production mark/fence/watchdog and rolls back before persistent deletion. Copy-worker timing is not a substitute. Require a `measured` receipt whose `markMilliseconds` fits comfortably below 300,000 ms with reserve.

Only after successful measurement, set action `run` and the recovery-owner-approved **15-minute cron `*/15 * * * *`**. This incident cadence supersedes the general document's hourly example; retention remains **at least one hour**, not fifteen minutes. The persisted installation timestamp enforces a first hour with zero deletions; repeated installation does not reset it. Verify a warming receipt and later a successful eligible run. Do not claim scheduled cleanup is operational until receipts prove it.

The sweep preserves every current root, all native historical C resources, and mutable roots retired within the preceding hour. It does not expire `relay_pgsl_published` or canonical native-LRS history. Bounds remain 300 seconds of pre-COMMIT work, 8 GiB deleted value bytes per run, 64 MiB / 256-key batches, and at least 2 GiB free reserve plus two batches. ACCESS EXCLUSIVE NOWAIT and an independent watchdog fail closed on contention, unknown/corrupt/incomplete graph state, low space, or deadline. The watchdog is not an absolute wall-clock bound on COMMIT/rollback/network latency. Ordinary VACUUM makes pages reusable; it does not reduce allocated volume size.

If measurement cannot complete within its bound or traffic repeatedly prevents it, keep action off and cron absent. Report **guard active / collector blocked** explicitly; do not weaken safety gates. The old GitHub collector schedule is removed/manual-only. No automatic resumption or recurring status job was created during this incident.

## Hallow: restoration candidate and unconfirmed RAM interval

Hallow project `860f4b49-828a-4abd-b97c-7977c03a0a29`, environment `5c393020-fcc0-4813-8dae-7d041d21fbbc`.

| Service | Service ID | Existing /data volume |
|---|---|---|
| march | `0fb533ab-a3bb-446f-aee6-2269cd3ce99d` | `eb23522a-7a77-4d33-90df-0c1070311bbc` |
| march-native-preview | `f3bbf863-04b6-44dd-a47f-36443ce79bd6` | `bb765dc7-ddc6-4a37-900d-5e884c04f21a` |

Restoration candidate: [Hallowmarch PR32](https://github.com/markjspivey-xwisee/hallowmarch/pull/32), merged commit `d86c7fc31bbb008006e5658b4b3586d82d78cd8c`; all 11 full jobs and 291 focused tests passed. Sources were pinned to it, but deployment attempts `d0e09fae-7fbd-4465-8704-9bf9adaf5ec2` and `4f896299-cb97-4090-99e2-f8f6faddc95d` failed STARTUP_UNCONFIRMED while CSS was unavailable. The idle fix is **not confirmed live**.

The old Hallow processes were stopped before their final native persistence was confirmed. Shutdown logs at **04:20:55.806 UTC** (march) and **04:21:10.094 UTC** (preview) warned that restart would recover the last confirmed checkpoint. Pending world/season state held only in RAM is unconfirmed. Do not claim zero RAM loss or assert player progress was lost without evidence. Local JSON can be a stale migration seed, not a proven current checkpoint.

[Hallowmarch PR35](https://github.com/markjspivey-xwisee/hallowmarch/pull/35) was merged into the existing repair branch as `539ef75bf7e1715f1c028fa3616e3aa00358ff61` (tested head `fab17669`). It adds a CHECKPOINT_UNCONFIRMED fence and operator preflight requiring idle originals and a confirmed, unchanged checkpoint with no pending work. Thirteen focused tests and 292 idle checks passed; two independent reviews found no blockers. **It is undeployed; the full 11 browser/network CI jobs remain pending before treating it as the next live game candidate.** Recheck those jobs before choosing a restore commit. Startup must load the native owner before constructing runtime state and fail closed when that read is unavailable. The recovery owner has not authorized a global strict-mode switch during this incident; realtime `durable:false` acknowledgments remain a separate, explicit durability limitation.

## Completion evidence still required

Record the successful original PostgreSQL deployment, expected physical system ID, controller activation receipt/digests, exact running CSS/relay image SHAs and ceiling values, Foxxi/Hallow health and persistence checks, sweep install/measurement/warmup/eligible-run receipts, and any volume deletion proof. Until these exist, recovery is blocked or incomplete.

## Provider security-incident update — 2026-10-21 23:04 UTC

The [official Railway status page](https://status.railway.com/) was rechecked at 2026-10-21T23:04:51.607Z. Its latest update is October 21 at 22:45 UTC. Railway reports a security incident and revocation of all existing storage-bucket credentials; its 22:10 update says replacement credentials appear automatically in the dashboard, but services cannot redeploy to pick them up until builds resume. The 22:37 update explicitly says builds remain paused, and the 21:59 update includes Enterprise deployments. The same status page recommends revoking environment-stored credentials and reviewing service logs; it says confirmed affected accounts will be contacted directly. This is a provider report, not evidence that this account or retained data was compromised.

A bounded connected-Railway environment-status request timed out during this check. No fresh SQL, deployment, mount, or journal readback was obtained. The earlier verified resource and prepared-controller state above remains the last confirmed baseline; no production recovery, configuration, credential, or deletion mutations were performed during this check.

The private recovery bucket (`7e2e03cf-fde2-4644-8f2f-f79c25bbf58f`, `pgsl-recovery-private-20261021`) holds the durable prepared CAS journal. **Inference requiring verification:** provider-wide credential revocation may leave the existing controller with stale bucket credentials; journal contents or loss have not been verified. Once supported operations return, inspect how the existing controller resolves bucket credentials, securely refresh only necessary stale references using current provider credentials, and prove the original prepared journal is readable before running `verify-activate`. Never print credential values, replace/reset the journal, rerun prepare, or treat expired credentials as permission to create a new recovery state.

Reconcile the provider's current security notice, credential state, account-specific notices if available, and logs before restoring application access. Coordinate any required credential rotation with the existing service dependencies and deployment availability. No broad credential revocation was attempted while deployments remain paused. Preserve the exact original-service deployment, compact physical-system-ID, full digest/schema/access, native ownership, sweep measurement, and cleanup gates above.

## Recovery resumed — 2026-10-22 14:14 UTC

**Active recovery owner:** the original recovery conversation resumed after the user reconnected Railway. Do not launch overlapping recovery operations while the controller or the deployments listed here are active. Read their live state before continuing; never blindly replay a command whose outcome is not yet recorded.

The reconnected Railway OAuth link successfully read project/environment state. The original service had no active deployment, no pending staged work, current source `postgres:16`, and compact volume `54013c9e-2954-4332-a4e9-e6dd2b0efca1` live at `/var/lib/postgresql/data`, 64,000 MB, us-west2. This project has only the production environment.

Current-source deployment `d3f5afd7-d638-42cc-8838-4dbee6e196e6` was created at 14:10:41.728 UTC. Logs at 14:13:23 show the existing database directory was used, initialization skipped, the previous clean shutdown at 2026-10-21 04:56:05 UTC, and PostgreSQL 16.15 ready for connections. **Terminal SUCCESS and physical identity are not yet recorded.**

Private status command deployment `6ee48dab-be4a-46ef-b3d4-68528429fc7f` returned HTTP 503 / recovery journal unavailable at 14:13:11 UTC, without a running operation. The provider rotated this bucket's credentials at 2026-10-21 22:35:05.921 UTC (verified bucket metadata). The controller's five `RECOVERY_S3_*` values were updated to references to the existing `pgsl-recovery-private-20261021` bucket's ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY, triggering controller deployment `dfe85efb-4ac6-4d37-93e8-a19c445bbd61`. No secret values were read or printed. Journal access must be rechecked after it settles; no journal contents have been replaced or reset.

The existing command helper now supports only read-only `status`, read-only `identity`, and `verify-activate`; the earlier preflight/fence/prepare modes were removed from this helper to prevent accidental replay. Its PGSL_PG_CONNSTR is a reference to the existing controller's connection string. Identity probe deployment `60d254bc-27d4-42ac-a0c6-b2121b59c7a8` is pending: it requires compact system ID `7698943519239290914`, all three expected roles, both application roles NOLOGIN, and only the recovery role able to log in. It logs only IDs/role flags/size, with no payload or credential output. **Do not run verify-activate until the independent identity proof and original deployment SUCCESS are observed.**

Hallow follow-up `539ef75bf7e1715f1c028fa3616e3aa00358ff61` broad verification run `39615672777` completed with 10 of 11 jobs successful. Networking failed in the new real-server outage/recovery test at a reconnect with "No welcome"; focused durability and idle workflows passed. One retry of the failed job was requested to distinguish transient test timing from a reproducible defect. Do not treat the follow-up as fully green or deploy it on the strength of focused tests alone.

No activation, application-image rollout, sweep installation/deletion, or recovery-resource deletion has occurred in this continuation.

### Verified restart and activation attempt — 2026-10-22 14:21 UTC

Original deployment `d3f5afd7-d638-42cc-8838-4dbee6e196e6` reached **SUCCESS at 14:15:34.933 UTC**, with one running replica. Identity probe `60d254bc-27d4-42ac-a0c6-b2121b59c7a8` returned successful read-only proof at **14:16:38.283 UTC**: system ID `7698943519239290914`; `iegoadmin` and `relay_pgsl` NOLOGIN, `pgsl_cutover_recovery` LOGIN; pgsl_prod allows connections and physical size is 35,257,138,199 bytes. The small physical-size change from the earlier receipt is not a payload-digest result.

Refreshed controller deployment `dfe85efb-4ac6-4d37-93e8-a19c445bbd61` reached SUCCESS. Status command `dc3ae917-3c95-4085-a09f-578094ab31a0` read the **original durable journal successfully at 14:19:48 UTC**, HTTP 200, phase prepared, original source/compact system IDs, exact receipt key `c17ca319bce3d839e50ee56b5400641152566e395a7c4c73df8b119ea623c6a6`, no running operation. This resolves the journal access failure without replacing journal contents.

**One verify-activate attempt is now queued:** command deployment `5fe99e1f-5914-42ea-9f2d-fb60a936ac01`, created 14:20:39.920 UTC. Inspect this deployment and controller logs before doing anything else; do not create another attempt while it is queued/running. The command helper checks current journal identity/receipt/no-running-operation before submitting verify-activate, and polls status every 30 seconds for at most 45 minutes. A helper timeout does not prove the controller stopped. It requires the original full byte/schema/access gates and activated receipt. The helper's current start source is durably stored in the Railway service config. Its only supported modes are identity, status, verify-activate.

CSS/relay fixed images, Foxxi/Hallow restoration, sweep install/measurement/retention warmup, and cleanup remain unexecuted. The Hallow networking rerun remains queued. Railway also reports all API tokens invalidated (official October 22 04:17 UTC notice); the sweep's older project token must be tested/replaced securely if invalid. Do not bypass its live volume-capacity or measurement gates.

### Hallow restore gate and CI — 2026-10-22 14:28 UTC

Hallow follow-up `539ef75bf7e1715f1c028fa3616e3aa00358ff61` now has **all 11 broad verification jobs successful** in run `39615672777`, including networking job `119876116268` on retry. World durability guard `39615672898` and live human idle lifecycle `39615672787` are also terminal SUCCESS. The initial "No welcome" failure remains historical evidence; the retry passing does not by itself explain its cause. This follow-up is eligible as the restoration candidate once CSS/relay are verified healthy.

A narrowly scoped operator startup gate is retained at [tools/operations/hallow-native-restart-gate-20261022.mjs](../../tools/operations/hallow-native-restart-gate-20261022.mjs), commit `791c8079f86fa14c18820a32861a53c79a42a625`. It loads the mounted existing service identity, reads and validates the native world stream before importing the game server, and refuses missing/empty/foreign/incomplete checkpoints. Its fixture accepted an existing native checkpoint and rejected those four invalid cases. It disables optional monitoring only in the precheck's composed environment; it preserves the normal server environment. It does not load local worlds/season JSON as a migration seed. Keep the existing `HM_GAMING_BOOTSTRAP` setting: that flag loads the existing mounted identity, and disabling it would remove required derived native credentials.

At 14:27:18 UTC the single verify-activate controller operation was still running from 14:22:38.362 UTC, journal phase prepared, exact receipt binding intact. The command deployment being SUCCESS means its container is running; **it does not establish activation**. Require the controller's actual activated receipt and hashes before writer deployment or sweep installation.

### Provider disclosure and connectivity review — 2026-10-22 14:34 UTC

The provider's [October 21 disclosure](https://blog.railway.com/p/security-disclosure-wednesday-october-21st) is now readable. It says an unauthorized party may have accessed encrypted customer environment variables and decrypted some, recommends rolling stored secrets and registry credentials, and does not establish that this account was affected. Bucket/API-token resets do not prove other application/database secrets were rotated. Preserve stable native identities and ownership while planning dependency-aware credential rotation; do not blindly replace signing/encryption keys.

The original PostgreSQL service still has public TCP proxy `ed573427-b4d2-4e3d-8e3f-3504a209d896`, port 5432. An attempted removal was **rejected by automatic approval review**, stating that it could disrupt external clients and lacked specific authorization for that connectivity change. **No proxy change occurred; do not bypass this rejection through another API or UI.** Continue unaffected recovery. A bounded network-flow sample since startup showed private service traffic only, but was truncated (101 records) and is not proof that no external dependency exists. Public-proxy removal remains a separate authorization/dependency item.

The authenticated project Tokens dashboard showed no current token entries. No credential was created or entered there. The sweep's existing project token therefore requires an actual validation/replacement before measurement can pass its live-capacity gate; do not substitute stale metadata or weaken the gate.

At 14:33:18 UTC verify-activate remained the single active operation, phase prepared with the exact receipt binding intact. Retained source volumes, game volumes, journal and disabled sweep are unchanged.

## Activated compact database — 2026-10-22 14:36 UTC

**Recovery activation succeeded. Do not rerun preflight/fence/prepare or restart a new activation attempt.** The existing private controller completed verify-activate; command logs at 14:36:18 UTC prove journal phase activated, no running operation, last.ok true, exact receipt binding, and full retained-data digests matching the original verified receipt. Full verification time: **2026-10-22T14:36:10.406Z**. Original source remains connection-blocked.

| Table | Rows | Value bytes | SHA-256 |
|---|---:|---:|---|
| pgsl_kv | 2770097 | 33612850247 | `0095bbf186b9f07245bb452ba6beedca85db429aa492dbe534e4cd6d3738f972` |
| relay_pgsl_published | 5058 | 14160622 | `805f03b4654a51859b81bc183cfde9f3ac652aeca9edf96322394cf25c43667d` |

Structured proof: [receipts/pgsl-activation-20261022.json](./receipts/pgsl-activation-20261022.json), commit `0d5ebcd90e3ee5c0ae02b5dfd801515ee4b2c8fb`. Expected physical ID, exact schema/access metadata, both full byte receipts, login restoration and removal of the temporary recovery role were enforced by the existing controller. This proves preservation of the verified retained copy, not unconfirmed earlier Hallow RAM state.

Both writer ceilings were explicitly set to `PGSL_PG_MAX_DATABASE_BYTES=48000000000` with skipDeploys true, then current source images were set to the exact published `4d41980040f08123bf787523938596d304a77e35` images:
- CSS deployment `e33db3d8-082e-41e0-903b-e350b4be7ab7`, created 14:37:40.090 UTC.
- Relay deployment `ef4e51a5-2d4c-49a1-a862-115c95df24bc`, created 14:37:44.015 UTC.

These writer deployments are pending; terminal success/native health are not yet recorded. Next: verify both, restore Foxxi and both stopped Hallow services (candidate 539ef75, existing volumes/identity, confirmed-native startup gate), then sweep install/measurement/one-hour warmup/cadence and proven-unused cleanup. The sweep API token and blocked public-proxy removal/security rotation remain as noted above.

### Writer image-pull blocker and independent SQL audit — 2026-10-22 14:51 UTC

Both fixed-image deployments above reached terminal **FAILED at CREATE_CONTAINER**, with no build/deploy application logs. The platform diagnosis is inability to connect to the registry; private-image credentials may be invalid. Do not infer an application startup fault or claim the 48 GB guard is live. The old relay image remains the only running relay; CSS has no healthy writer deployment.

Authenticated GitHub package pages confirm both exact `4d41980040f08123bf787523938596d304a77e35` tags exist and both packages remain Private. Neither fixed tag had downloads at inspection. Do not rebuild a different source, make packages public, or weaken authentication to get past the pull failure.

Independent read-only SQL audit deployment `70299af1-e412-4b06-a7ce-7a73718345a3` succeeded at **14:44:19.828 UTC**: compact system ID unchanged; iegoadmin and relay_pgsl LOGIN, temporary recovery role absent; exactly the original two tables, both owned by iegoadmin; pgsl_prod physical bytes 35,257,138,199. Both writers reference private host `postgres.railway.internal` and have configured ceiling `48000000000`, but configuration readback is not proof those guards run.

A **read-only credential audit** was dispatched from the incident branch, workflow file commit `27d2be5ed50827cc8d542df54f2ad0c9c66bde12`, [run 39799326675](https://github.com/markjspivey-xwisee/interego/actions/runs/39799326675). It has no production mutation and prints only credential validity/scope flags, HTTP statuses and image digests. It checks existing Actions RAILWAY_PROJECT_TOKEN against this exact project/environment and GHCR_TOKEN against HEAD manifests of the two approved images. The default branch workflow is unchanged. Inspect the run before attempting credential transfer or re-deployment; never print secrets or substitute an expiring job GITHUB_TOKEN for persistent registry credentials.

The existing scheduled recovery task was freshly inspected and is **already disabled** (last updated 2026-10-21 21:17 UTC). No new task was created or enabled. Application restore, sweep installation/measurement/deletion/cadence and resource cleanup remain incomplete. Preserve all retained volumes and native identities.

### Credential audit failed; recovery paused for secure credential refresh — 2026-10-22 14:54 UTC

The audit actually executed at **14:51:09–14:51:13 UTC** and exited 1. GitHub's jobs wrapper temporarily continued to report queued; the actual completed job log is authoritative. Results:
- Existing Actions RAILWAY_PROJECT_TOKEN: HTTP 200 with API errors, no matching project/environment scope. It cannot authorize this recovery. The provider reports all API tokens invalidated at October 22 04:17 UTC; the stored secret's UI timestamp is August 6.
- Existing Actions GHCR_TOKEN: GHCR authentication **HTTP 403** for both exact CSS and relay image scopes. This proves unusable pull credentials; it does not independently prove the cause or account compromise. The secret's UI timestamp is August 11.

Secretless structured evidence: [receipts/pgsl-credential-audit-20261022.json](./receipts/pgsl-credential-audit-20261022.json), commit `c7e516a68b9bf908bbc3eac7a5972b7e19a7a3ff`. No credentials were transferred or exposed and no production mutations were made by this audit.

**Current recovery owner is paused at a user credential-entry handoff**, not running an activation or deployment. Secure settings pages are prepared:
- [Railway project Tokens](https://railway.com/project/b88ceabb-7461-4949-81d7-3d29132e7806/settings/tokens?environmentId=449996a2-3533-462f-98c6-4ab4c05dd777): user creates a replacement project token scoped to the existing production environment.
- [Interego Actions secrets](https://github.com/markjspivey-xwisee/interego/settings/secrets/actions): user updates RAILWAY_PROJECT_TOKEN and GHCR_TOKEN directly. GHCR needs a persistent classic PAT with package pull access (`read:packages`), not the job-scoped GITHUB_TOKEN. Do not paste either into chat or shell history. Primary build-ghcr.yml already publishes with its workflow GITHUB_TOKEN.

Once refreshed, rerun the **read-only audit at commit 27d2be5** (or recheck its exact branch file and dispatch); require both package HEAD checks and exact Railway scope success. Then use a reviewed CI-only transfer of the existing secrets to exact existing CSS/relay/Foxxi service registry credentials and the existing private sweep's project-token variable, with exact project/environment/service guards and no secret logging. Deploy the two approved 4d images once, verify terminal success and native reads/writes, then continue the ordered Foxxi/Hallow and sweep procedure above. The stored 48 GB configuration is still not confirmed active. Do not replay completed activation, bypass registry auth, reset identity/worlds or journal, enable deletion, enlarge storage, or clean retained volumes while blocked.

The optional PostgreSQL public-proxy removal remains blocked by automatic approval review as previously recorded; it is separate from the credential refresh needed for the application rollout. No proxy mutation occurred. Other credential rotation is not claimed complete.
