# Private PGSL reclamation

This worker reclaims unreachable PGSL rows in the existing PostgreSQL table. It needs no second payload table, public database proxy, or database export. Ordinary VACUUM makes deleted heap and TOAST pages reusable; allocated volume size does not shrink.

Install only after the replacement database has passed its migration checks. Installation adds two small private journal/state tables and an always-enabled trigger. It preserves every current root (including all native historical C resources) and every mutable root retired during the preceding hour. Its first hour never deletes rows.

Use the self-contained Bun Function source `tools/pgsl-store-sweep.railway.mjs`; its embedded modules are checked against repository source in CI. It pins pg8.22.0 and needs no container registry credentials. The optional Docker image uses the repository-root context and `deploy/Dockerfile.pgsl-sweep`. Run in the same Railway project and environment as PostgreSQL, without a public domain. Configure:

- `PGSL_PG_CONNSTR`: a reference to the PostgreSQL private connection string; the hostname must end in `.railway.internal`.
- `RAILWAY_PROJECT_TOKEN`: an environment-scoped Railway project token used only to obtain volume capacity metadata.
- `PGSL_SWEEP_POSTGRES_SERVICE_ID`: the exact PostgreSQL service ID.
- `PGSL_SWEEP_ACTION`: defaults to `off`, which opens no database connection. The only enabled actions are `install`, `measure`, and `run`.
- Optional `PGSL_SWEEP_TABLE`, default `pgsl_kv`.

After independent review and an explicit recovery-owner rollout decision, create the dedicated `pgsl-private-sweep` Bun Function with restart policy NEVER, no public domain, no cron, and action `off`. Set action `install` for one controlled execution after migration validation. Then use `measure`: it executes the same fenced mark, including the independent watchdog and temporary keyset, and rolls back before any persistent DELETE or VACUUM. Its receipt reports markMilliseconds. This works during the one-hour warmup. Verify production timing with reserve before setting action `run` and Railway cron `17 * * * *`. Deployment alone does not install or reclaim anything. The process exits after each run; it has no HTTP listener.

Every sweep obtains the existing collector advisory lock and an ACCESS EXCLUSIVE NOWAIT fence. A transaction that already read the table makes maintenance defer. A new reader or writer briefly waits until the watchdog cancels and rolls back maintenance; no dedup reader can observe an orphan and later root a deleted node. Current and journaled roots are marked together. Unknown namespaces, malformed node keys, corrupt roots, incomplete closure, missing journal proof, insufficient fresh free space, a queued table reader or writer observed by the independent watchdog, or the maintenance deadline abort the transaction and roll back all DELETE batches. The table fence protects the graph through COMMIT; a transaction arriving after the final watchdog check cannot read the table until COMMIT and therefore sees the post-GC state.

Default bounds are a 300-second pre-COMMIT work deadline, at most 8 GiB of deleted value bytes, batches of at most 64 MiB / 256 keys, and at least 2 GiB free reserve plus two deletion batches. Atom topology uses bounded header probes. Fragment topology is grouped from octet_length metadata, at most 4096 keys and 8 MiB of stored JSON per query and 64 MiB across a frontier; a larger individual retained fragment fails closed. Exceptional JSON fallback fetches one node at a time. This is intentionally separate from the old copy-and-swap collector, whose guards remain unchanged.

A successful JSON receipt includes `deletedKeys`, `deletedBytes`, and `vacuumed`. `vacuumed:false` means deletion committed but ordinary VACUUM needs a subsequent retry; it does not mean rollback. A warming receipt reports no deletion. Errors never log credentials or database payloads.

The PostgreSQL16 fixture covers continuous one-hour root history, native historical resources, URL/URN closure, unknown and malformed input, low space, actual READ COMMITTED adapter dedup-reader rollback after a completed DELETE batch, deferral for an existing adapter reader, bounded wide-fragment traversal, honest post-commit VACUUM failure, and physical TOAST-page reuse. Before production scheduling, measure a read-only closure on the migrated database and verify it fits the 300-second transaction bound with reserve. Tiny fixture success does not establish production throughput.

The watchdog stops after its final check before durable COMMIT. The work deadline is not an absolute wall-clock bound on PostgreSQL COMMIT, cancellation, rollback, or network/scheduling latency.

The worker makes old overwritten snapshots reclaimable. It does not change Foxxi's remaining full-snapshot write amplification for genuine active events, nor expire historical native-LRS resources. Capacity must still be checked against the live retained corpus; a live set approaching volume capacity requires a separate reviewed retention or storage change.

The reviewed dedicated service is `549ce5f1-297c-42b0-9c1a-7e1ff977ff2b` in project `b88ceabb-7461-4949-81d7-3d29132e7806`, environment `449996a2-3533-462f-98c6-4ab4c05dd777`. The trusted-master-only provisioning workflow copies the existing GitHub `RAILWAY_PROJECT_TOKEN` secret directly to that one service through a single `variableUpsert` with `skipDeploys:true`. It verifies token scope and exact service identity, never reads variables back or logs the token, and does not deploy, install, run, or schedule the worker. The secretless fixture workflow checks the helper using mock credentials. Agents do not receive the secret value.

The old GitHub `Pod store collector` workflow is manual-only: its schedule trigger is removed in this change. It cannot automatically open a public database proxy or scan alongside the private cron. Enable the private cron only after production measurement and warmup/rollout gates. Manual recovery tools remain available with their existing copy headroom and lock guards.
