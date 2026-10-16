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

## 2026-10-16: Hallowmarch service-monitor rollout evidence

This bounded production check used public HTTP reads and scoped Railway HTTP/runtime
logs. It created no observation, signed request, identity, consent or deployment and
did not read a sealed canonical body or a human record.

| Observation (UTC) | Result |
| --- | --- |
| Foxxi `/health`, 15:05:15 | HTTP 200; build `d11bf9aba51ef0cdcf95a3e753af36e10d338a51`. Railway deployment `f40a6a11-0d77-4c56-9587-f7268a81b0f1` reported SUCCESS. |
| Foxxi `/affordances`, 15:05:15 | HTTP 200; 151 affordances, including existing signed xAPI read/write and public LRS discovery. |
| Natural xAPI write, 15:01:57.144 | Proxy HTTP 499 after 89,963 ms. |
| Natural xAPI write, 15:04:04.819 | Proxy HTTP 200 after 68,079 ms. Path-only logs do not independently attribute the request to a signer. |
| Hallowmarch `/gaming/status`, checked 15:08:02 | Export count advanced 4 to 5; last confirmed acknowledgement **15:05:15.236Z**, statement `c191dca7-e31a-8b12-8697-0c9fcbfc38f1`; HTTP 200 and uncertainty cleared. Count is local to the process. |
| Subsequent natural sample | One pending record, attempt 15:06:47.968Z; its HTTP request returned 499 at 15:08:17.983 after 89,949 ms. A prior acknowledgement does not make this newer delivery confirmed. |
| Durable game state, 15:08:02 | Live sequence 29, durable sequence 29, durable version 17, pending commands 0. These are `march-proof` game-service gauges, not client FPS, RTT or per-realm/player analytics. |

The current dedicated service actor was
`did:ethr:0xF4cce38Cd47B4c31960a21CD420a4A467f9b5CB8`. Its monitor status
continued to report human learning disabled. At 15:08:26, the public container
`https://gate.interego.xwisee.com/u-eth-f4cce38cd47b/foxxi-lattice/` returned 200
and listed `holon-0b57d9b6c5c9500102208f73.ttl`. The [public projection](https://gate.interego.xwisee.com/u-eth-f4cce38cd47b/foxxi-lattice/holon-0b57d9b6c5c9500102208f73.ttl)
returned 200 at 15:09:21. Its asserting-agent, on-behalf-of and attribution metadata
named that same service DID, with an observed timestamp of 15:02:12.324Z.
It has **no authorship proof**: this is evidence of projection placement, not an
independent cryptographic or private-body proof. The older `eth-*` projection
container remained present; this change does not migrate or merge old lenses.

Storage roles remain distinct. The LRS primary uses its configured service-owned
native Interego scope with private tenant/lens partitions. The signed xAPI adapter
additionally awaits an encrypted shared-lattice mirror in the selected,
ownership-checked subject pod. Hallowmarch stages its technical observation and
delivery acknowledgement in its encrypted game-owned outbox. The public status
acknowledgement therefore reports both exact Foxxi durable-receipt acceptance and
the subsequent game-outbox acknowledgement commit; it exposes no sealed-body proof.

The awaited source path is: native LRS batch commit, actual LRS-enriched readback,
then each statement's owner-pod mirror in sequence. Monitor batches contain at most
two statements. The mirror awaits lattice load, recipient-key lookup, container
creation, a per-resource write lock and encrypted CAS; even its best-effort public
descriptor PUT is awaited. The outer monitor HTTP deadline is 90 seconds; each
Foxxi loopback LRS request defaults to 120 seconds and native LRS HTTP operations
to 15 seconds. Four mirror CAS attempts and eight native LRS conflict attempts
bound retries, but do not establish one end-to-end deadline. The generic guarded
mirror fetch does not add a deadline itself. These source facts identify possible
waiting stages; the available logs do not identify which caused either 499.

Next diagnosis should time signature binding, LRS POST/readback, mirror load/key
lookup/CAS/projection and the separate Hallowmarch outbox-stage/ack commits using
fixed metric names and outcome codes, with no payloads, credentials, human IDs or
caller-selected URLs. Correlate an already retained observation and its normal
retry; do not create replacement events or widen consent. Keep both native LRS
and required owner-mirror receipt checks. A future bounded repair path for the
public projection can be assessed separately after measurements identify its cost.
