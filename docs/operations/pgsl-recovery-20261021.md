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
