# Trusted native LRS import maintenance

This isolated operator tool restores the authenticated tagged snapshot created by
`lrs-inprocess-export/export.mjs`. It adds no runtime HTTP endpoint and changes no
application source, role, credentials, capture consent, or learner achievement.

`runtime.mjs` bundles the actual native Interego LRS/database and commit classes
from source commit `88aec11320e594ae1180a9be27c0aeefc5a6d910`, plus their npm
dependencies. It requires Node 22 or later and Node builtins only. The build
manifest records source hashes and the bundle digest. The test client simulates
native commit storage; unit tests do not establish physical production durability.

## Execution inside the existing container

Upload `import.mjs`, `run-in-container.mjs`, `runtime.mjs`, and the build manifest
under a private maintenance directory in the existing Foxxi container. Keep the
application process running. The wrapper inherits the existing container's
environment and uses secrets internally; do not download or print its environment.
It does not alter the running application's environment.

The default wrapper path requires an existing matching published owner key and
encrypted tenant directory. When the operator explicitly chooses to establish
the native pin from the existing container configuration, add
`--establish-operator-pin` to the wrapper command. This flag is consumed by the
wrapper and never forwarded to the importer. It derives the owner key twice from
the existing `FOXXI_ADMIN_KEY_SEED`, derives the stable bridge recipient from the
existing bridge private key and owner scope, and locally encrypts a synthetic
native-format artifact to both recipients. Both keys must decrypt and verify the
exact native artifact and byte digest. No pod publication is required or created
in this explicit mode. The assurance is reported accurately as
`operator-established pin from preexisting container configuration`, alongside
key fingerprints and booleans. It proves local key custody and repeatability; it
does not prove historical publication, WebID control, or live write authority.
The existing pod, configured owner and existing capability are reused, an
existing conflicting native pin is refused, and only the child receives the pin.
Actual Railway service pin configuration remains a separate operator action.
To make that public key available for service configuration without exporting
secrets, the operator may also pass `--operator-pin-output PATH`. The wrapper
writes a mode-0600 public JSON artifact containing the pod, owner, public key,
fingerprints and stated assurance. It includes no seed, private key or capability.
The output is create-only; an existing identical artifact is accepted, and any
different existing content (including an archive) is never overwritten. Both
wrapper flags are consumed before invoking the importer. Public-key setting in
Railway still requires the explicit service-scoped configuration operation.

The wrapper checks the configured pod and owner, compares the existing published
tenant-admin encryption key with the key derived from the existing admin seed,
and actually decrypts the existing encrypted tenant directory. Descriptor and
decrypted graph attribution must match the configured owner. Every retrieval
stays within the configured HTTPS pod and rejects redirects. It then maps the
native settings for its maintenance child only, reusing the existing pod write
capability and bridge private key. It never mints an identity or session token.

First perform a dry run, which reads the destination and writes no native record:

```bash
node /app/maintenance/run-in-container.mjs \
  --archive /app/lrs-live-output/lrs-live.encrypted.json \
  --checkpoint /app/lrs-live-output/native-import.checkpoint.encrypted.json \
  --expect-source-sha ACTUAL_TARGET_SCRIPT_SHA256_FROM_EXPORT_RECEIPT
```

Only after verifying preservation, authority, substrate durability, and the native
protocol on CSS/gate, repeat the identical command with `--apply`. Both the
archive and checkpoint must remain available privately. The native destination
must be empty or contain this exact import, and **no replacement bridge or other
native writer may run during import**. Withholding public traffic is insufficient
because bridge startup and background tasks can write.

The default native scope is the existing configured pod, owner and the adapter's
`foxxi/lrs/native/head` plus `foxxi/lrs/native/artifacts/` paths. The wrapper refuses
a conflicting existing native pod, owner, or public-key pin. Setting those
maintenance child variables does not update Railway service configuration.

## Atomic publication and recovery

The tool validates every archived original and encodes every accepted native
value before committing. One native CAS
publishes all primary records: original statements, exact document keys/metadata
and bytes, attachments, explicit void edges, and the union of tenant registries,
including document-only and empty partitions. Native statement bases store
`voided:false`; the original void flags and voiding ID reconstruct through the
validated native relation. Statement JSON, `stored`, `authority` and timestamps
remain unchanged. With the explicit optional-property projection described below,
the original JSON wire form remains unchanged while undefined own object
properties are omitted from native objects. No HTTP enrichment, forwarding,
cmi5 callbacks, or new evidence
generation runs.

The unchanged native commit limit is 1,000 changes. The importer refuses a source
whose primary record set exceeds that bound. A 779-statement fixture with three
documents, an attachment, a void edge and four tenant registrations produces 788
primary changes. Its 779 rebuildable query aliases publish in a **second CAS**.
The replacement must remain unserved until both phases and exact fixed-head
readback complete. A failure after the first CAS leaves primary data committed
and the checkpoint explicitly unready; it is not a completed restore.

The tool writes and fsyncs an encrypted checkpoint before the first commit and
after each phase. Its binding covers source/archive hashes, exact destination
scope, deterministic native provenance, every planned native key/artifact, and
the explicit projection policy plus source wire hashes.
Stable operation IDs and source-derived provenance support retries after lost
acknowledgments. Re-running the same archive with the same checkpoint either
finishes the interrupted phase or verifies the completed head without duplicating
records. Altered originals, keys, scope, extra destination records, missing void
targets, or changed destination heads fail closed.

Keep the encrypted checkpoint and source archive together in durable private
storage after each phase; a container-local file alone is not a durable backup.
The checkpoint is encrypted under the existing admin seed using a separate HKDF
domain. Output contains counts, hashes and native receipt/head metadata, with no
record bodies or keys. `cutoverReady:true` describes this fixed imported head and
snapshot only. It is not proof of final cutover or new-process recovery.

## Limits and final cutover

The default mode rejects source values whose native object fidelity it cannot
preserve. An operator may explicitly pass `--omit-legacy-undefined-properties`
to the wrapper or importer to omit only own object properties whose value is
`undefined`, recursively. This narrow migration policy asserts
`JSON.stringify(original) === JSON.stringify(projected)` for every source value;
binary bytes stay exact. It refuses undefined array elements or root values,
nonfinite numbers, negative zero, null-prototype objects, and all other unsupported
changes. A required field that becomes absent still fails structural validation.
The original encrypted tagged archive is never altered; its original plaintext
and ciphertext hashes bind the checkpoint. Native verification compares against
the projected object, without claiming tagged object identity was preserved.
Reports include `projectPolicy`, `undefinedPropertiesOmitted`, `recordsAffected`,
`wireJsonUnchanged`, and a source wire hash, plus fixed-name aggregate
`nonJsonKindCounts` diagnostics without record bodies or property names.
Use the same flag for dry run, apply and every retry. Missing/orphan voiders fail restoration. A stored
orphan attachment can be preserved; a statement requiring bytes absent from its
tenant's attachment collection fails. Per-artifact native encrypted size limits
still apply and may fail staging before the atomic primary head publishes.

The old process can change after the export pause. **This tool does not apply
changed-snapshot deltas or overwrite an existing import.** Establish a final old
write boundary and reconcile any later statements, voids, attachments and mutable
documents before routing canonical traffic or stopping the old process. A fresh
changed archive must not be presented as an idempotent retry. Retaining the old
process preserves a recovery opportunity, but is not an archive.

After restoration, configure the replacement with the same verified native scope,
keys and capability, then verify authenticated reads, documents, voids and binary
resources after a replacement-process restart. Recheck the current head against
the restored head and explicitly reconcile any later legitimate native writes.

`node import.mjs --offline --archive PATH` performs genuinely offline archive
validation using `FOXXI_ADMIN_KEY_SEED` already available in that process. It does
not test native representability, authority, protocol or storage. The container
wrapper always performs its custody reads before invoking the importer.

## Rebuild and tests

From this directory, with existing dependency installations available:

```bash
INTEREGO_SOURCE_ROOT=/path/to/exact88 \
INTEREGO_DEPENDENCY_ROOT=/path/to/dependency-checkout \
  node build-runtime.mjs
node --test import.test.mjs operator-pin.test.mjs
```

The fixture tests also read the adjacent `lrs-inprocess-export/export.mjs` to
verify the actual exporter's authenticated encryption format. Fourteen tests pass
under Node 22.23.3, including the 779-record atomic import, exact public-native
readback after a fresh database readiness cycle, lost acknowledgments in either
phase, interrupted alias generation, strict source/scope/cursor changes,
binary/JSON distinction, invalid voids, capacity refusal, archive/checkpoint
tampering, concurrent head drift, operator output-path collisions, exact JSON-wire
projection with unchanged archive binding and binary readback, refusal of every
other non-JSON kind, and checkpoint binding to policy and source wire hashes.
Five additional `operator-pin.test.mjs` tests verify the explicit mode's actual
two-recipient cryptography, unchanged default publication requirement,
fingerprint-only log reporting, conflict refusal, wrapper flag consumption and
the public-pin artifact's exact whitelist, private permissions and overwrite refusal.
