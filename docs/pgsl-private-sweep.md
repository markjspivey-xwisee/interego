# Private PGSL reclamation

This worker reclaims unreachable PGSL rows in the existing PostgreSQL table. It needs no second payload table, public database proxy, or database export. Ordinary VACUUM makes deleted heap and TOAST pages reusable; allocated volume size does not shrink.

Install only after the replacement database has passed its migration checks. Installation adds two small private journal/state tables and an always-enabled trigger. It preserves every current root (including all native historical C resources) and every mutable root retired during the preceding hour. Its first hour never deletes rows.

Build the repository-root Docker context using `deploy/Dockerfile.pgsl-sweep`. Run in the same Railway project and environment as PostgreSQL, without a public domain. Configure:

- `PGSL_PG_CONNSTR`: a reference to the PostgreSQL private connection string; the hostname must end in `.railway.internal`.
- `RAILWAY_PROJECT_TOKEN`: an environment-scoped Railway project token used only to obtain volume capacity metadata.
- `PGSL_SWEEP_POSTGRES_SERVICE_ID`: the exact PostgreSQL service ID.
- Optional `PGSL_SWEEP_TABLE`, default `pgsl_kv`.

After independent review and an explicit recovery-owner rollout decision, run the image once with command `bun tools/pgsl-store-sweep.mjs --install`. Leave its default command as the hourly job and configure Railway cron `17 * * * *`. Deployment alone must not run installation. The process exits after each run; it has no HTTP listener.

Every sweep obtains the existing collector advisory lock and a SHARE ROW EXCLUSIVE writer fence. Reads remain available. Current and journaled roots are marked together. Unknown namespaces, malformed node keys, corrupt roots, incomplete closure, missing journal proof, insufficient fresh free space, a queued table writer observed by the independent watchdog, or the maintenance deadline abort the transaction and roll back all DELETE batches. The table fence protects the graph through COMMIT; a writer arriving after the final watchdog check waits until COMMIT.

Default bounds are a 300-second transaction, at most 8 GiB of deleted value bytes, batches of at most 64 MiB / 256 keys, and at least 2 GiB free reserve plus two deletion batches. Atom topology uses bounded header probes. Fragment topology is grouped from octet_length metadata, at most 4096 keys and 8 MiB of stored JSON per query and 64 MiB across a frontier; a larger individual retained fragment fails closed. Exceptional JSON fallback fetches one node at a time. This is intentionally separate from the old copy-and-swap collector, whose guards remain unchanged.

A successful JSON receipt includes `deletedKeys`, `deletedBytes`, and `vacuumed`. `vacuumed:false` means deletion committed but ordinary VACUUM needs a subsequent retry; it does not mean rollback. A warming receipt reports no deletion. Errors never log credentials or database payloads.

The PostgreSQL16 fixture covers continuous one-hour root history, native historical resources, URL/URN closure, unknown and malformed input, low space, queued-writer rollback after a completed DELETE batch, bounded wide-fragment traversal, honest post-commit VACUUM failure, and physical TOAST-page reuse. Before production scheduling, measure a read-only closure on the migrated database and verify it fits the 300-second transaction bound with reserve. Tiny fixture success does not establish production throughput.

The worker makes old overwritten snapshots reclaimable. It does not change Foxxi's remaining full-snapshot write amplification for genuine active events, nor expire historical native-LRS resources. Capacity must still be checked against the live retained corpus; a live set approaching volume capacity requires a separate reviewed retention or storage change.
