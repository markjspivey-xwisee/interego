# Railway recovery checkpoint — 2026-10-21

Verified at approximately 20:15 UTC. Recheck live state before each action.

## Current blocker

Railway has paused deployments during its platform incident:
https://status.railway.com/

An attempted Postgres redeploy returned "Deploys have been paused temporarily".
The removed historical deployment also has no reusable build, despite
list-deployments reporting canRedeploy=true. No new Postgres deployment was
accepted by this recovery session.

## Verified database state

Project: b88ceabb-7461-4949-81d7-3d29132e7806
Environment: 449996a2-3533-462f-98c6-4ab4c05dd777
Original Postgres service: ed1eee24-540a-4f41-b33f-0cf2d2511c45
Configured source: postgres:16
Current attached volume: 54013c9e-2954-4332-a4e9-e6dd2b0efca1 (64000 MB)
Expected physical system identifier: 7698943519239290914

The retained copy completed and passed ordered, length-framed raw key/value
SHA-256 verification at 2026-10-21T04:52:27.649Z, including full node validation
and an independent rooted-graph check. It contains 2,770,097 PGSL keys and
507,097 live nodes. Target database size: 35,257,130,007 bytes.

| Table | Rows | Value bytes | SHA-256 |
|---|---:|---:|---|
| pgsl_kv | 2770097 | 33612850247 | 0095bbf186b9f07245bb452ba6beedca85db429aa492dbe534e4cd6d3738f972 |
| relay_pgsl_published | 5058 | 14160622 | 805f03b4654a51859b81bc183cfde9f3ac652aeca9edf96322394cf25c43667d |

The target shut down cleanly at 04:56:05.960Z. Original Postgres shut down
cleanly at 04:56:36.847Z. The new volume is attached to the original service,
but that service is currently OFFLINE with no active deployment.

The original 200000 MB volume, 39097cdd-1093-420a-bc39-572aa2668bbd, remains
detached and retained. Its source database was persistently fenced with
ALLOW_CONNECTIONS false. A separate initialized 64000 MB volume,
4471d983-aa9a-46d0-882b-13f5537d8f68, remains on the unused recovery service.
Do not confuse it with the completed copy.

## Complete activation after Railway resumes deployments

1. Recheck the original service source, attached volume, pending environment
   patch and active deployments. Preserve the original database hostname and
   credentials. Start its configured postgres:16 source with the current
   attached copy; never initialize or reset the data directory.
2. The official CLI source-deploy path avoids the removed build:
   railway redeploy --project b88ceabb-7461-4949-81d7-3d29132e7806 --environment 449996a2-3533-462f-98c6-4ab4c05dd777 --service ed1eee24-540a-4f41-b33f-0cf2d2511c45 --from-source --yes --json
3. Require terminal SUCCESS and privately confirm physical system identifier
   7698943519239290914. Both application roles must remain quarantined.
4. Read the existing private controller status and require the prepared
   journal binding. Controller service:
   af00805e-de13-4b6c-8ddb-a5c8b8ec355e.
   Existing one-shot command service:
   a8177fd9-2655-4de8-927c-738e6339f2ed.
   Its PGSL_CONTROLLER_MODE=status performs a private status read;
   verify-activate explicitly requests activation.
5. Run verify-activate and monitor until the controller reports activated.
   Do not rerun preflight, fence or prepare. The controller checks the newly
   attached physical identity, exact catalog/ACL/role baseline, and both full
   table hashes. It persists activation-ready proof before atomically
   restoring iegoadmin and relay_pgsl LOGIN, then verifies normal access and
   drops the temporary recovery role.
6. Restore CSS and application deployments only after activation is verified.
   Recheck real storage requests; gateway /healthz alone is insufficient.
7. Keep the old volume for at least the authorized one-hour rollback period
   after successful activation and validation. Once applications accept new
   writes, reverting to the old volume requires reconciliation.

Exact deployed controller matches tested commit
e191de3f6863acb866639fdf38866f5dc70bf70d.
Two-Postgres16 fixture:
https://github.com/markjspivey-xwisee/interego/actions/runs/39537099711

## Application rollout and write-pressure guard

Master 4d41980040f08123bf787523938596d304a77e35 passed PostgreSQL integration,
CSS accessor/server, LRS, FDB, lint, identity and relay checks. CSS and relay
images for that SHA were built successfully. Its auto-rollout was cancelled;
do not infer those adapters are running.

Deploy the tested current adapters and set
PGSL_PG_MAX_DATABASE_BYTES=48000000000 on every CSS/PGSL writer for the 64 GB
database. See docs/PGSL-WRITE-PRESSURE.md. Verify the exact running images,
configured ceiling and ordinary reads/writes after rollout.

Foxxi remains online on fd209c9ecb456cf309387c80c4da8bda0d10df84,
deployment 7e0c0cad-24ff-4923-b78c-58dda258c004. Recent sampled flows used the
private gateway on port8080; old mesh/Native-LRS scan requests were absent.
A smaller boot/five-minute directory refresh remains under investigation.

Hallowmarch PR32 merged as d86c7fc31bbb008006e5658b4b3586d82d78cd8c.
Tested head 9d6fa85a795a78c51fa5a6135a9d9c66efafa80f passed all11 broad jobs
and the idle-lifecycle workflow. Its production/preview deployments were
removed after native startup reads failed; the older container also stopped.
After storage recovery, retry the exact merged builds for both services and
verify fresh health plus idle/live-play behavior.

## Reclamation after activation

The old public Pod store collector schedule is removed. The replacement
private sweep remains unscheduled and last exited disabled. Its token was
provisioned successfully without exposing the value.

Worker: 549ce5f1-297c-42b0-9c1a-7e1ff977ff2b
Reviewed source: 4faead163da0b958c4aa90fff3dbd3302748c36e
Bundle: tools/pgsl-store-sweep.railway.mjs
Bundle Git blob: c210e61bb2c80f8a28be1959709d5d7ec97228ba

After activation finishes and its exact two-table comparison is no longer
needed: refresh the exact worker bundle with action off, cron absent,
restart NEVER, no public domain. Verify the private database reference,
original Postgres service ID and token scope. Run install once, then measure
once. Measure must return measured with zero persistent deleted rows/bytes
and markMilliseconds comfortably below the300-second limit.

Require at least one hour of continuously verified retirement journaling
before the first run. Verify that controlled run, then configure hourly cron
17 * * * *. Unknown/corrupt graphs, queued app traffic, low headroom or
deadline expiry must fail closed. Historical Native-LRS resources remain
roots. Ordinary VACUUM reuses pages; it does not shrink the volume.

## Operational limits

The platform outage currently blocks starting services and applying the final
rollouts. This checkpoint is evidence of preparation, not a claim of restored
service. Successful current deployment and activated receipts remain required.

Automatic approval review rejected deleting the completed dashboard-probe
service (edb93e2b-211e-4324-aa7d-e7e27ab627fc) because irreversible deletion
lacked specific authorization. It is exited. Do not bypass that rejection.
