# LRS durability and preservation

## Rollout is held

Do not restart the current Foxxi process, merge a change that automatically deploys it,
or apply the desired PostgreSQL configuration before resolving preservation of the old store.
The dependency manifest and shared lockfile also participate in other image scopes. Inspect
the actual deployment plan before release and preserve primary state and keys for every
affected service; this is not permission to restart the rest of the fleet.
At 2026-10-15 05:18 UTC the live `/xapi/about` reported 779 process-wide RAM-resident xAPI statements.
This is an event-record count, not a verified count of unrecoverable primary records.

The mesh logs repeatedly derived 776 event candidates from three pods across three agents.
`projected` counts candidates, and `landed` counts successful new writes: these logs cannot prove
the composition of the 779 stored records or establish that only three need preservation.
The old `lens:` namespaces also accepted HTTP writes, so a tenant name is not a durability proof.

An isolated read-only inventory used only the existing configured Basic credentials. Its one
authorized scope was empty. Other runtime-created scopes, voided targets, document state and
attachment bytes were not inspected. No complete backup was made. Full inventory requires a
genuine configured operator session; Interego agent delegation does not replace that authority.

## Durable primary configuration

The desired Railway preset selects `FOXXI_LRS_BACKEND=postgres` and references the existing
`postgres.DATABASE_URL` through `FOXXI_LRS_POSTGRES_URL`. This preset is not a claim that the
live environment has changed. Its PostgreSQL service already has a persistent volume.

The backend requires a stable `FOXXI_LRS_ENCRYPTION_KEY`, or the existing
`FOXXI_BRIDGE_PRIVATE_KEY` as its fallback. Never generate that key at boot. Both database
backups and the original key are needed for recovery. An encrypted key-verification sentinel
refuses a changed key instead of silently presenting an empty database. Key rotation requires
an explicit re-encryption migration.

All tenants, including projected lenses, use the same durable policy. Statements, void markers,
attachment bytes, State documents, activity profiles and agent profiles have encrypted,
tenant-bound database records. Tenant names and logical resource identifiers are encrypted or
keyed indexes. Private documents are not published through the old public snapshot mechanism.
Successful writes await commit. Database errors do not switch the primary to memory.

Deployed environments refuse a volatile primary or a legacy statement-only backend that leaves
documents and attachments volatile. Development and test memory stores are explicitly separate.

## Preservation and migration requirements

1. Obtain a complete, authorized export from the still-running old process, including exact
   tenant identities, full stored statement envelopes, voided records and voiding relationships,
   document bytes and metadata, and attachment bytes. Ordinary xAPI statement paging and the
   projected admin feed alone are not complete exports.
2. Encrypt the backup under an operator-held key in durable storage. Verify record and byte
   counts and test restoration in isolation. An HTTP 200 or an export filename is not a receipt
   of complete preservation.
3. Reconcile writes made after the export and establish an explicit cutover boundary. Keep the
   old service available until coverage is established or the owner knowingly accepts specified
   losses. A volume attachment or backend setting must not be used as the first preservation step:
   either can restart the old process before its RAM has been copied.
4. Apply durable connection configuration, deploy the exact reviewed image, and import the
   verified data without replacing identities, changing roles or fabricating learning evidence.
5. Verify counts and encrypted readback, then restart the new process and repeat authenticated
   reads for statements, voids, attachments, State/Profile documents and tenant discovery.

The existing process exposes no complete checkpoint endpoint. No current-tool-path backup is
claimed; operator access and complete live export remain an explicit rollout requirement.

## Verification and remaining scope

The Bridge Typecheck workflow includes an isolated PostgreSQL 16 service and requires the real
store and HTTP recovery suites with `REQUIRE_LRS_PG_TESTS=1`. These exercise committed writes,
tenant isolation, process restart, binary resources, conditional documents, concurrency and
failure behavior. They do not use production credentials or establish preservation of live data.

The bounded source audit in `docs/audits/primary-state-durability-74475.json` tracks other
primary-state gaps, including SCORM attempts, native agent work, pending forwarding,
OAuth persistence and identity key custody. This LRS change does not claim to repair all of
those systems. Rebuildable caches and expiring authentication challenges may use RAM;
acknowledged primary records and durable keys need verified persistence and recovery.
