# Primary-state rollout hold

Source review dated 2026-10-15. Audit source baseline and observed Foxxi image: `74475d4a0220abc6f7d3e8134258d0908d1607a9`. Other services have distinct observed pins; their source findings are not claims of exact live behavior. The former separate-SQL candidate, including `ef75de585cc82c64f2a81bea5c1d8b5dcf104573`, is rejected as the final architecture. Its native replacement must follow [native-learning-storage.md](native-learning-storage.md). The scope below was measured for the earlier candidate and must be recomputed for the final native source against current image pins. Neither this document nor passing tests verifies production recovery or authorizes record deletion.

**Keep the rollout held. Do not restart the old processes that may hold the only copy of primary records before preservation coverage is established.** A new durable backend protects subsequent writes; it cannot recover records erased by the restart that activates it. Attaching storage or changing configuration can itself redeploy a service.

## Status note, 2026-11-25: foxxi-bridge was restarted

This note records what happened. It does not lift the hold, and it is not evidence about any other service.

`foxxi-bridge` was replaced three times on 2026-11-25 by merges to master that the deploy workflow rolled out (#1001, #1002, #1003). The first two were merged before this document had been read by the session that merged them. Before the third, the host's retained HTTP request logs for the service were read: in the window they covered, the only write requests were that session's own tests. That is a statement about requests the host logged in that window. It is not an inventory of the memory-only stores listed below, and records written before the window, or by a path that makes no HTTP request, are not covered by it.

Nothing about the stores has changed: the gaps below are still gaps, and every later restart of this service needs the same check made again, or preservation in place, before it happens.

## Status note, 2026-11-26: seven of Foxxi's ten gaps are addressed, and three clear registries are sealed

Source change, not a statement about records in any running process.

- `native-trajectories`, `performance-probes` and `evaluation-workflow` are written to the tenant pod, sealed, before the call that made them is answered, and read back when the process does not hold them (`applications/foxxi-content-intelligence/src/sealed-store.ts`). A write the pod does not take is a refusal. Their old snapshot collectors are still registered and still never marked dirty; they are not what keeps these records.
- This is the pod's ordinary resource store with a sealed body, the mechanism `admissions` and the forwarding config already use. It is not the native commit path of [native-learning-storage.md](native-learning-storage.md): one writer, last write wins, no revision check. It survives a restart of one bridge process and is not safe for two.
- Records made before this change were only in a process's memory and are not recovered by it.
- `cmi5-rollup-dedup`: what the rollup has said, and the registration it says it under, are in the cmi5 snapshot and restored from it. That snapshot is sealed and debounced (two seconds), not awaited, so this gap moves to the audit's "conditional" class, not to "durable".
- `course-author-index`: written only after a read that succeeded or found nothing, the PUT is checked, a failed write is retried with backoff, and authoring awaits it and reports `authorIndexKept`. It stays plain JSON: it says who authored which course, which the course pages say too.
- `agent-scorm-attempts`: an attempt is written sealed when it is launched and after each step, before the answer, read back when the process does not hold it, and removed once its outcome is in the learner's record. Same mechanism and limits as the three stores above.
- `scorm-sequencing-sessions`: the snapshot's collect threw on every call (a session's tree is cyclic) and its restore discarded every entry. Sessions are now written and rebuilt (`sessionToJson`, `sessionFromJson`). That snapshot is sealed and debounced, not awaited: "conditional", not "durable".
- Later the same day, `forwarding-config` and `forwarding-queue`: the config was already sealed on the owner's pod, but a copy that could not be read was treated as none and overwritten by the next change, and a failed write was answered `ok`. Unreadable is now a 503 that changes nothing, and both routes report `durable`. The dead-letter queue is written into that same config when it changes (debounced, with retries, after the failed delivery, not before the statement's answer) and restored by a process that does not hold it. "Conditional", not "durable".
- `xapi-attachments`: when the statement store is the native Interego store, attachment bytes commit with their statement through `NativeInteregoLrsStore.putWithAttachments` and are read back from it; the per-process map is used only when the store is not native (`putStatementWithAttachments` in `src/xapi-lrs.ts`). Whether a given deployment runs native is a fact about that deployment's configuration, not about this source.
- Separately, three registries were plain JSON on the pod, readable by anyone with the address: a person's assignments to their own agents and who brought which package (added 2026-11-25 and 26), and the personal launch links (which name each link's learner, pod and course). All three are now sealed. At start the bridge reads each clear copy, writes it sealed, removes the clear one, and keeps trying until it is gone. `course-authors.json` and `content-locations.json` in the same folder are still plain and were not changed.

## Status note, 2026-11-27: the three debounced stores are written before the answer

Source change, not a statement about records in any running process.

- `scorm-sequencing-sessions`, `cmi5-rollup-dedup` and `forwarding-queue` were "conditional": written by a two-second timer nothing waited for. Each is now written before the call that changed it returns (`keepSnapshot`, and the awaited queue listener), and the SCORM session routes say `sessionKept`.
- A write the pod refuses is still not a refusal of the step: the engine has processed it, or the statement has been said. It is reported where there is an answer to carry it, and tried again.
- Still the pod's ordinary resource store with a sealed body, one writer, last write wins. Not the native commit path.
## Status note, 2026-11-27: four stores move to the native commit path

Source change, not a statement about records in any running process.

- `native-trajectories`, `performance-probes`, `evaluation-workflow` and `agent-scorm-attempts` are committed through the native record store where the tenant's store is native (`applications/foxxi-content-intelligence/src/kept-records.ts`): an encrypted artifact under the tenant, published by the conditional head commit a statement uses. Their sealed pod records of 2026-11-26 are read once, committed natively and removed.
- Evidence: the routing against a stand-in; the real native client, encryption and resource CAS over a local engine with two database instances; and one case in `native-lrs-store.test.ts` over the actual CSS and PostgreSQL engine across a storage process restart, which CI requires.
- Not moved: `scorm-sequencing-sessions` and `cmi5-rollup-dedup` (whole-surface sealed snapshots), `forwarding-config` and `forwarding-queue` (on the owner's own pod), `course-author-index`, and the three sealed registries.

## Exact affected service scope

For the earlier candidate, the existing deployment-scope tool and observed live image pins reported these **12** affected services. Identity and acme-id were outside that measured candidate. Changes to shared native storage require a fresh scope calculation; this historical list is not a deployment allowlist for the replacement.

| Services | Bounded source finding and release consequence |
|---|---|
| `foxxi-bridge` | Hosts the LRS and 27 server-side entries in the 39-store audit below. Primary-state gaps require inventory and preservation; pod-derived lens caches are a different category. |
| `relay` | Hosts eight audited entries, including OAuth persistence races, conditional AMEP/PGSL persistence and a separate RAM kernel workspace. |
| `css` | Canonical pod storage is backed by PostgreSQL in the intended configuration. `integrations/pgsl-css-accessor/docker-entrypoint.sh` requires `PGSL_PG_CONNSTR`; `src/PgslDataAccessorFactory.ts` nevertheless permits explicit `PGSL_INMEM=1`. Confirm the actual durable mode and database backup/recovery before relying on pod copies. Redis/process-local locks are coordination state, not evidence that pod data is RAM-only. |
| `bridge` | Additional source finding outside the 39-store audit: local PGSL atoms/attestations and in-flight constitutional amendments/votes are held in process Maps. `demos/interego-bridge/server.ts:97–99,315–437`. No complete existing export/restore route was found in this bounded review. |
| `pgsl-browser` | Additional finding: the startup pod-derived lattice is rebuildable, but `/api/ingest` and `/api/ingest-uris` also acknowledge RAM-only additions. A startup rebuild cannot reproduce those additions merely because other lattice content came from pods. `examples/pgsl-browser/server.ts:122–218,1175–1230`. Other demonstration registries need separate coverage assessment. |
| `jev-harness-bridge` | Additional finding: judgment artifacts, indexes and outcomes are written to local `<repo>/.jev-harness/`; this is disk, **not RAM**, but image/container-local disk is not established durable storage. Default image uses `/app`. `applications/jev-harness/src/store.ts:90–114`, `src/service.ts:87`, `deploy/Dockerfile.jev-harness-bridge`. Verify persistent mount or complete pod-backed copies. |
| `agp-bridge`, `wsp-bridge`, `discord` | None of the 39 entries is assigned to these separate processes. Inspected entrypoints use pod-backed outputs or sessions/queues; this is not a complete audit of their imported libraries or running work. Confirm outstanding work and write receipts before replacing them. Sources: their `bridge/server.ts`, AGP `bridge/handlers.ts`, Discord `src/main.ts`. |
| `dashboard` | Inspected server aggregates pod/relay discovery into a resident view. No sole primary record found in that bounded read; this is not a full durability proof. `examples/dashboard/server.ts:93,354,575`. |
| `foxxi-microsite`, `foxxi-dashboard` | These images serve built frontend assets with nginx. No server-side primary record store found in the inspected Dockerfiles. Existing browser drafts/session keys are client state, not the contents of the nginx process. `deploy/Dockerfile.foxxi-microsite`, `deploy/Dockerfile.foxxi-dashboard`. |

## Most recent native candidate scope

A fresh read-only pin comparison at native candidate `ee2dcf094dce4889506a6c6bc30dbabb74a0ee7e`, using the unchanged deployment selector, selected **13 services**: `css-gate`, `css`, `foxxi-bridge`, `agp-bridge`, `relay`, `wsp-bridge`, `bridge`, `pgsl-browser`, `jev-harness-bridge`, `discord`, `dashboard`, `foxxi-microsite` and `foxxi-dashboard`. The preceding twelve-service map describes the earlier source findings; the native revision also changes `css-gate`.

The inspected gate holds an expiring authentication cache, rather than a sole primary record store. Its addition does not remove the other services' preservation obligations. Native CSS changes affect canonical pod resources and metadata: confirm actual durable mode, backups, stable keys and restoration before replacement. No variable values or record payloads were read for this scope calculation.

Foxxi's live variable-name metadata lacked four mandatory native authority settings: pod URL, owner, capability and pinned owner encryption public key. Its existing bridge key can provide the documented private-key fallback. Presence of names alone would not prove correct configuration or recovery. Apply reviewed native configuration only after preservation; a partially configured replacement must fail closed.

The automatic parallel rollout does not establish CSS/gate-before-Foxxi ordering. Stage native protocol readiness and existing authority checks before replacing the Foxxi primary. Neither rollback nor a successful new readiness transaction can restore the old process's heap. Recompute this measured scope against fresh pins and the exact final release before any deployment.

## Mapping the 39-store audit

Canonical inventory: [`../audits/primary-state-durability-74475.json`](../audits/primary-state-durability-74475.json). Its classifications describe source behavior and prerequisites, **not measured live record counts**. The LRS statement store itself was investigated separately and is not one of these 39 rows.

| Runtime | Audit entries | Meaning for this rollout |
|---|---|---|
| Foxxi: 10 gaps | `xapi-attachments`, `scorm-sequencing-sessions`, `agent-scorm-attempts`, `cmi5-rollup-dedup`, `native-trajectories`, `performance-probes`, `evaluation-workflow`, `course-author-index`, `forwarding-config`, `forwarding-queue` | Potential primary attachment bytes, live course attempts, enrollment/dedup state, native plans/trajectories, probe baselines, evaluation decisions/bindings, ownership/discovery index, forwarding credentials/config and pending deliveries. Presence and counts remain unknown. |
| Foxxi: 10 conditional | `xapi-documents`, `cmi5-launches`, `cmi5-course-registry`, `lti-registrations`, `lti-tool-lineitems`, `lti-platform-gradebook`, `oneroster-overlay`, `authored-course-content`, `content-items`, `mesh-enrollment` | A mechanism or partial recovery path exists; confirm publication, complete coverage, privacy, stable keys and actual restoration. |
| Foxxi: 3 durable mechanisms | `admissions`, `capture-consent`, `collector-grants` | Awaited encrypted own-pod writes/readback exist. Verify stable key/custody and source availability; source alone does not establish live recovery. |
| Foxxi: 4 ephemeral/rebuildable | `cmi5-auth-tokens`, `lti-ephemeral-auth`, `oneroster-base`, `mesh-trajectories` | Short-lived tokens may require relaunch; bundled roster base and genuine pod-derived mesh views can be reconstructed. This does not classify every statement in the same process. |
| Client: 1 ephemeral | `browser-session-keys` | Per-tab delegated signing key. Do not export or persist it as a business-record backup. |
| Relay: 3 gaps | `relay-oauth-clients`, `relay-oauth-grants`, `relay-pgsl-kernel` | Client/token acknowledgments can precede pod persistence; grant retirement can fail to persist; the private kernel singleton is RAM. Do not assume published PGSL closures cover the separate kernel workspace. |
| Relay: 3 conditional | `relay-amep`, `relay-pgsl-published`, `relay-key-custody` | AMEP/selected published closures have PostgreSQL recovery only in configured reachable mode. Encryption/signing key custody must survive replacement. |
| Relay: 1 durable mechanism | `relay-handoffs` | Encrypted conditional service-pod records/queues are awaited; verify stable key and storage recovery. |
| Relay: 1 ephemeral | `relay-auth-transport` | Short-lived authorization codes and MCP transports; reauthorization/reinitialization is expected. |
| Identity: 3, outside this rollout | `identity-account-metadata`, `identity-private-keys`, `identity-jwt` | Separate unresolved durability/custody concerns. Do not restart identity as part of this release or claim these issues were fixed by Foxxi changes. |

## Existing preservation paths and their limits

1. **LRS operator API:** an existing verified admin session can enumerate `/xapi/admin/tenants`, inspect `/xapi/admin/aggregates`, and enumerate statement metadata. The standard `/xapi/statements` API returns complete statements/attachments for the credential's scope; known voided IDs require `voidedStatementId`, and attachment bytes require `attachments=true`. Ordinary paging excludes voided targets. An operator-controlled encrypted export must prove tenant, voided-record and attachment coverage before being called complete. Existing configured Basic credentials cover only their actual mapped tenants. The count-only inventory workflow is neither such an export nor a backup. Sources: `src/xapi-admin.ts`, `src/xapi-lrs.ts`.
2. **Already persisted Foxxi data:** encrypted own-pod canonical lattice resources, admission envelopes and forwarding config files, plus successfully written LMS snapshots, are legitimate recovery sources. Verify fresh readback and restore compatibility without printing their contents. `foxxi.backup_tenant_pod` reads already published descriptors; it does not capture resident Maps, failed writes, attachment bytes or arbitrary non-descriptor files. Do not treat it as a full process snapshot. `src/composed-extensions.ts:964+`, `src/foundation-shared-lattice.ts`, `src/admission-store.ts`, `src/forwarding-persist.ts`.
3. **No safe generic Foxxi RAM flush endpoint found:** `pod-snapshot-publisher.ts` exports an internal `flushAll()`, but baseline bridge code does not mount it as a maintenance endpoint or wire a proven shutdown flush. Some collectors are incomplete or never dirtied. Its generic publisher also uses public-read, reversibly encoded JSON rather than private encryption; blindly calling it is not an acceptable preservation plan for private records. Importing the module in a second process creates different empty Maps. Existing source does not provide a complete authenticated encrypted live-process checkpoint route.
4. **Relay durable stores:** preserved service-pod OAuth/client/handoff files plus stable relay keys, and PostgreSQL-backed AMEP/selected PGSL closures, are existing recovery paths where confirmed written. Inspect completeness and retired-grant state; pending fire-and-forget writes are not covered by merely finding some files. Do not use `pgsl_to_turtle` or `pgsl_ingest` with `publish_to_pod` as a private backup: source serializes the shared kernel singleton and does not supply a safe tenant-isolated encrypted snapshot. Sources: `deploy/mcp-relay/oauth-{client,token}-store.ts`, `engagement-store.ts`, `pgsl-node-store.ts`, `server.ts:9771–9885`.
5. **JEV local artifacts:** existing GET `/jev-harness/judgments` and `/jev-harness/judgments/:ref` expose stored judgment representations, including `.trig`, `.ttl`, `.md` and JSON. A legitimate operator can preserve these privately and verify coverage against the local store, including indexes, outcomes and relay mappings. Published pod outcomes alone do not prove every local judgment/artifact was preserved. Do not print artifact bodies into a chat or build log. `applications/jev-harness/bridge/server.ts:203–216`, `src/store.ts`.

## Operator handoff required before release

- Keep affected stateful old processes running. Inventory primary record kinds/counts and outstanding work first; make no deletion decision from the aggregate resident-statement count or projector candidate logs.
- Use existing authorized operator access to establish inventory/export coverage. No role or credential fabrication, public plaintext publication, credential disclosure or consent change is part of this handoff.
- Preserve current sole copies privately with stable owner/operator key custody, validate integrity and record counts, and demonstrate restoration in isolation. Where the baseline lacks a complete export path, obtain a reviewed non-restarting maintenance path before replacement; do not assume a fresh process can read the old heap.
- Confirm actual PostgreSQL-backed CSS/Relay modes and backup coverage; confirm JEV storage persistence. Configuration presence alone is not a restoration test.
- Fix primary writers to await durable receipts and fail closed on storage errors; include voiding, attachments, native workflow state, pending deliveries and ownership indexes. A statement-store migration alone does not close the 39-store inventory.
- Recompute deployment scope against current pins and rerun required tests after the final change. Resume rollout only once preservation/recovery coverage is concrete and reviewable.

This is a bounded source-derived release hold, **not a claim that every system is RAM-only or that the whole fleet has been verified**. Intentionally ephemeral credentials, locks and reproducible views differ from acknowledged primary records.
