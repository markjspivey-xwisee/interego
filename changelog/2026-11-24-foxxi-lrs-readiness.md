## 2026-11-24 — Foxxi verifies its durable LRS on synthetic records

A bridge check exercises Foxxi's HTTP endpoints over the actual native
CSS and gate fixture on PostgreSQL. It times statement ingest, concurrent
page reads, and a backup restored into a second database. It compares the
paged statement envelopes and verifies binary attachments, documents, ETags,
voiding, tenant isolation, and a new write after restoration.

The check runs the unmodified upstream ADL suites for xAPI 2.0 and 1.0.3
in separate synthetic scopes. The JSON artifact records the tested revision,
suite commit, dependency lock digest, counts and latency. Only the JSON
report is published. The compliance page labels the older memory-backend
result and points to the native fixture evidence.

When a controls request names a profile, Foxxi returns the exact version its
link uses. Following a historical decision exposes the offers from the profile
that judged the statement. Each offered action still applies its live access rules.

Profile checks can return the exact published version, the matching template
or pattern, and any skipped checks. The human workbench uses those same public
operations to inspect versions and check examples. It shows controls after a
fully evaluated match. The standard response remains available to xAPI clients.
