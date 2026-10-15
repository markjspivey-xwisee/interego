# LRS durability and preservation

## Architecture and rollout holds

Foxxi's canonical learning records must persist through native Interego/PGSL
contracts. A separate PostgreSQL LRS primary is rejected. The binding decision,
atomic commit requirements and existing substrate engine dependency are recorded
in [native-learning-storage.md](native-learning-storage.md).

Do not restart the current Foxxi process, merge a change that automatically deploys
it, or activate a replacement before resolving preservation of the old store.
Shared packages and lockfiles also affect other images: recompute the actual
deployment scope before release and preserve primary records and keys for every
affected service.

At 2026-10-15 05:55 UTC the live `/xapi/about` reported 779 process-wide RAM-resident
xAPI statements. This is an event-record count, not a verified count of
unrecoverable primary records. Mesh logs derived 776 event candidates from three
pods across three agents; candidates and newly landed writes do not identify the
composition of the 779 records. Do not subtract these counts to infer losses.
The old `lens:` namespaces also accepted HTTP writes.

A read-only inventory using existing configured Basic credentials found its one
authorized scope empty. Other runtime-created scopes, voided targets, document
state and attachment bytes were not inspected. No complete backup was made.
Full inventory requires genuine configured operator authority; Interego agent
delegation does not replace that authority. Website inspection is authorized,
but the attempted interactive browser connection was blocked by the execution
environment's network policy. A public HTML response is not an operator session.

## Native primary requirements

The replacement requires `FOXXI_LRS_BACKEND=interego` and must not carry a Foxxi
database connection. Native pod, owner scope, existing capability and stable
private key must be explicitly configured and verified before startup. The
historical Azure-to-Railway migration manifest is a frozen snapshot, not current
configuration; its old memory setting must not be used to configure this release.
No live configuration has been changed.

Successful writes await a verified native commit receipt. Statements, attachments,
void relationships, State documents, activity and agent profiles and the durable
tenant registry share the same native transaction policy. Tenant registration
occurs with its first committed data; merely reading a tenant must not register
it. Queries are rebuildable views of canonical native records.

Private records remain encrypted to the intended owner. Stable key custody and
the underlying substrate's recovery are both required. An unreadable existing
head, missing capability or storage failure must stop startup or the operation,
without treating it as an empty store or switching to RAM or a public snapshot.
Explicit development/test memory fixtures are separate from production storage.

## Preservation and migration requirements

1. Obtain a complete authorized export from the still-running old process,
   including tenant identities, exact stored statement envelopes, voided records
   and voiding relationships, document bytes and metadata and attachment bytes.
   Ordinary statement paging and the projected admin feed are incomplete exports.
2. Encrypt the backup with an operator-held key in durable storage. Verify record
   and byte counts and demonstrate restoration in isolation. A response status,
   export filename or count-only report is not proof of preservation.
3. Reconcile writes after the export and establish a cutover boundary. Keep the
   old process running until coverage is established or the owner knowingly
   accepts specific losses. Attaching storage or changing a backend can restart
   the process before its RAM has been preserved.
4. Only after both holds are resolved, apply reviewed native configuration and
   deploy the exact reviewed image. Import preserved records without replacing
   identities, changing roles or fabricating learning evidence.
5. Verify counts, encrypted native readback, attachments, voids, documents and
   tenant discovery. Restart the replacement process in isolation and repeat
   authenticated reads before declaring recovery verified.

The current process exposes no complete checkpoint endpoint. Importing its module
in a second process creates different empty Maps. No current-tool-path full
backup or production recovery is claimed.

## Remaining scope

The bounded source audit in `docs/audits/primary-state-durability-74475.json` tracks
other primary-state gaps, including SCORM attempts, native agent workflows,
pending forwarding, OAuth persistence and identity key custody. The LRS change
does not repair every audited system. The detailed service map and preservation
limits remain in [primary-state-rollout-hold.md](primary-state-rollout-hold.md).
Rebuildable caches and expiring authentication challenges may use RAM;
acknowledged primary records and durable keys require persistence and recovery.
