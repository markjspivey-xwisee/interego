# Native Interego learning storage

## Binding architecture decision

Foxxi persists learning records and essential service state through native Interego
contracts. This records the owner's October 3 requirement, reaffirmed October 15,
2026. The separate PostgreSQL LRS proposed in draft PR 589 and repeated in the
earlier PR 626 implementation is rejected as the final architecture. Passing its
durability tests did not make that storage authority acceptable.

Canonical records belong to Interego: encrypted, content-addressed PGSL holons with
owner scope, provenance, and explicit durable commit receipts. xAPI/LRS, SCORM and
LMS interfaces are adapters and projections over those records. If Interego lacks
a required durability operation, implement that generic capability in Interego.
Foxxi must not bypass the substrate with its own SQL connection, tables, driver,
or independent primary database.

The existing CSS/PGSL deployment uses PostgreSQL beneath Interego's storage
contract. This decision does not remove that physical dependency or establish a
PostgreSQL-free platform. A future change of that engine belongs to the substrate
and must preserve its native contracts and verified recovery. Do not describe an
application SQL database as native merely because its interface has been renamed.

## Required commit properties

- Immutable encrypted native artifacts are staged and verified before publication.
  Validate canonical addresses, complete closure, exact recipient policy and
  readable content. An unreadable or corrupt resource is an error, not absence.
- One conditional native head commit publishes each logical transaction. Its
  expected revision check and canonical nodes, indexes, overlay and resource head
  update happen within the existing substrate transaction. A preflight HTTP check
  alone cannot protect multiple server replicas.
- The response binds our committed revision, resource, expected revision and body
  digest. A later HEAD response may belong to a different writer and is not our
  write receipt. Revisions must also change for repeated identical bodies; a
  millisecond timestamp is insufficient to prevent stale writes.
- Operation identities and immutable commit history support recovery after an
  ambiguous response. Retrying cannot duplicate a learning event or discard a
  competing committed update. Reads can rebuild projections from a fixed head.
- A statement, its attachment bytes and first tenant registration are one logical
  commit. Voiding relationships and document conditions must be checked against
  the same commit. Original xAPI identity and evidence remain intact.
- Statement queries and cursors use authenticated, bounded, tenant-isolated views
  bound to their committed head. Derived in-process indexes may be rebuilt;
  acknowledged primary records must survive process replacement.
- Production startup requires explicitly configured native storage, stable
  owner-held keys and existing write authority. No generated boot keys, role
  fabrication, public snapshot fallback or fallback to volatile storage.

## HTTP authority and receipts

The public native service uses the existing css-gate authority boundary. CSS's
allow-all internal configuration is not an independent authorization mechanism;
production must not expose a route that bypasses that boundary. The gateway
checks existing writer credentials and pod scope, strips verified opaque gate
credentials before CSS authentication, and preserves private-document policy.
No new operator role or production credential is created by this implementation.

Non-preflight OPTIONS forwards native capability evidence from CSS. Browser CORS
preflight remains local. Native commit acknowledgments alone receive a bounded,
validated target mapping from the actual internal storage IRI to the configured
public resource IRI; storageResource and storagePath retain the original engine
targets. Ordinary and encrypted application bodies remain unchanged. The native
recovery fixture includes the actual gateway and CSS with distinct origins,
rather than substituting an authentication shim.

When CSS uses its memory resource locker, reader counters also use process-local
MemoryMapStorage, scoped only to LockStorage. Their lifetime matches the local
mutexes. Durable KeyValueStorage and BackendKeyValueStorage remain unchanged;
the Redis configuration retains its existing shared bookkeeping. Independent
native writers still arbitrate through the shared engine's atomic head CAS.
This configuration does not establish general CSS multi-replica write safety.
Old internal lock documents are left intact; this is not a cleanup operation.

## Current interface scope

The initial adapter uses an explicitly configured private native service scope,
owner key and existing capability. OPTIONS advertises its commit protocol. This
is not a claim that learning records already have a published semantic Type Index
registration or are discoverable by every Interego agent. Any discovery descriptor
must be a repairable projection of the canonical commit and preserve record privacy.

Native head and trie objects are bounded individually. The initial compatibility
snapshot API still enumerates the complete index into a rebuildable in-process
view. The adapter's 4,096-record payload scan bound does not bound that initial
metadata traversal. Narrow native lookup/paging APIs and their consumption must
be validated before claiming bounded work per query at large record counts.

Native statement artifacts retain an internal flag when the LRS assigned the
timestamp. It is outside the xAPI statement and is never accepted from HTTP JSON.
A UUID replay may ignore a newly generated timestamp only when both immutable
records explicitly carry that provenance. Explicit client timestamps and older
unmarked artifacts remain strict. Accepted retries keep the first artifact,
query pointer and original envelope, and do not repeat callbacks or void effects.

Legacy ordinary-resource reads retain a separate stat-then-lazy-stream path. A
concurrent deletion can leave that reader with an empty stream. Native version-
bound reads use the captured native head and bytes instead. General legacy read
consistency requires its own change and validation.

## Evidence and rollout boundary

An OPTIONS advertisement demonstrates protocol support, not write authorization.
Startup readiness must await a native commit receipt using the configured service
authority. An empty readiness transaction is a real native write, even though it
does not register a tenant or create learning evidence. Do not execute it as a
read-only production inventory probe.

Tests must exercise the actual native CSS/PGSL path, conflicting independent
writers, stale revisions, storage failures, encrypted bytes and process restart.
A mocked CAS or an in-memory substrate does not prove physical durability.
Existing substrate engine dependencies must be disclosed in test reports.

The live-record preservation hold in [primary-state-rollout-hold.md](primary-state-rollout-hold.md)
continues to apply. A corrected writer protects future commits; it cannot recover
the previous process's sole copies after a restart. Neither implementation nor a
green test run authorizes discarding records, deploying the draft, changing live
credentials or restarting any affected service.
