# Durable learning storage: implementation candidate

Status: source changes only. The live Foxxi service has not been migrated or switched to this backend. Do not merge for automatic deployment until the rollout gates below pass.

## Storage contract

Private PostgreSQL holds tenant-scoped xAPI records, a transactional forwarding outbox, and operational snapshots for SCORM sessions, cmi5 launches and tokens, LTI keys and gradebook state, documents, attachments, and associated bridge state. Responses are acknowledged after commit. Failed commits roll back registered runtime state and return an error. Memory is a working cache rather than the authority when this mode is configured.

PGSL/pod evidence remains separately addressable. Its existing best-effort projections are not a guaranteed synchronous second copy. Private operational snapshots, including credentials and keys, must never be published as public pod evidence.

Forwarding requires an explicitly configured destination. Undelivered records remain in the outbox. Delivery is at least once and uses stable statement identifiers; it is not an exactly-once guarantee. An identical accepted statement retry can recreate a delivery job.

## Activation after migration verification

Set `FOXXI_REQUIRE_DURABLE_LEARNING=1` and either `FOXXI_LEARNING_DATABASE_URL` or the split `FOXXI_LEARNING_DB_HOST`, `FOXXI_LEARNING_DB_PORT`, `FOXXI_LEARNING_DB_USER`, `FOXXI_LEARNING_DB_PASSWORD`, and `FOXXI_LEARNING_DB_NAME` variables. Use private-network database references and a persistent database volume. The startup guard refuses missing durable configuration, and database initialization must succeed before listening.

Do not put secret values in this document or commit them. Enable backup and restoration for the private database. Runtime snapshot serialization uses Node's V8 codec and must be validated during runtime upgrades.

## Verification completed locally

TypeScript bridge compilation and diff validation pass. Thirteen persistence tests and selected xAPI, SCORM, cmi5, and LTI regression suites pass: 160 tests across 12 files. The persistence harness uses disk-backed PGlite through its PostgreSQL socket adapter and the actual pg client. A separate Node process reopens the database, reads an xAPI record, restores a cyclic SCORM session, and advances it to the next activity. Failure tests cover record/outbox atomicity and withholding HTTP success when checkpointing fails.

This is not live PostgreSQL deployment verification, official protocol certification, or a complete repository test run.

## Release gates

1. Inventory and migrate existing pod records, saved configuration, attachments, and active memory-only sessions. Existing memory state has no complete proven export; restarting the live service can lose it. Prove a safe migration or controlled quiescence before deploying.
2. Validate the configured backend and restart recovery against the actual private PostgreSQL service, including credentials, learner identity, tenant isolation, backups, and failure recovery.
3. Verify a named forwarding destination with real retry and duplicate handling. Confirm attachment delivery and any desired PGSL evidence projection separately.
4. Benchmark and improve the coarse runtime checkpoint transaction. It serializes requests and currently holds its lock during outbox network delivery. Ordinary response buffering and snapshots need bounded-load tests; xAPI queries currently scan tenant records before filtering. These are unresolved throughput and availability concerns.
5. Prove actual PostgreSQL multi-replica coordination and crash behavior, runtime-version compatibility, and deployment rollback.
6. Complete the Course Import and Player app integration, isolated content hosting, native cmi5 launch verification, and any SCORM-to-cmi5 wrapper conformance. Those features are not supplied by this persistence change.

Legacy unconfigured development modes remain available. They do not meet the production persistence requirement. Keep release held until durable configuration and the relevant gates are verified.
