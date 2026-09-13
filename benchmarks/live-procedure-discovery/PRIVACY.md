# Privacy and evidence scope

This release contains an unsigned, allowlisted projection of private operational records. It permits checks of published counts and structure while withholding the live workspaces, task evidence, assessment prompts and answers, observations, state successors, receipts and raw audit proofs. The public files cannot independently authenticate those withheld records.

## Private publication and trust

Private publication uses **relay-managed encryption** for the authorized calling account. The relay can unwrap authorized content and manages signing. This is not client-held-key end-to-end encryption, a claim of metadata secrecy, or evidence of an independently held client signing key. Confidentiality observations cover the recorded artifacts and reported encryption settings; they do not establish secrecy against the relay or all infrastructure observers.

The privacy fix in PR #401 was deployed before protocol 1.0.4. Both exposure arms received the same completed synthetic preflight report and checked its linked private backing resources and advertised runtime build. That preflight covers the recorded synthetic transition. Per-run review separately inspects retained observations, state and receipts; a preflight cannot certify future writes.

The private audits inspect the recorded relay authorship/encryption assertions and correspondence of retained canonical content, descriptors and evidence references. Their scope is the exact recorded assertions and content checked. They do not establish independent signing-key resolution, transaction-wide cryptographic attestation, authorization through a separately held client key or evaluator-signed provenance. An observer's signed assessment report binds its observation; it does not make the raw evaluator response an independently signed evaluator attestation. The candidate/policy correspondence is a retained observer commitment check, without proof of every hidden reasoning step.

All runs use **one authenticated account**. Assigned workspace roots and reachable resources define the permitted discovery scope, reviewed after execution. They do not provide independent accounts or an access-control boundary between runs. Retained traces and self-disclosures cannot rule out every undisclosed read, local computation, external call or contact with another agent.

## Retained evidence and capture gaps

The private recorder retains intended arguments, their source references, noncredential responses, failures and polling events. Ephemeral signing envelopes and credentials are omitted. Some credential-shaped schema fields and an unstructured authority representation were also scrubbed; retained structured affordances support the narrower dispatch checks. Omitted bytes cannot be reconstructed or used to claim complete response-byte accounting.

Four original controller contexts and their final recorder captures were lost. Their restored recorders reconcile the available records, but do not prove complete original streams, absence of unknown pending operations or absence of an unrecorded tail. Those runs retain `captureComplete: false`, one controller restart each, lower-bound costs and explicit nonconformance. Run03's continuation-message provenance also remains uncorroborated.

Run06 has a separate recorder gap: transient stores vanished while the same original controller continued. Counters and the call index were restored from that run's retained files; the final completed-record store covers only the continuation. No new controller was launched. This run retains `captureComplete: false`, zero controller restarts, zero recorded assistance, one protocol deviation, lower-bound costs and explicit nonconformance. In total, five captures are incomplete and four replacement controllers were launched. All five affected runs preserve unknown (`null`) whole-stream assessment totals alongside their retained passing grades. These limitations remain separate from their completed task outcomes.

For uninterrupted cases, `captureComplete: true` means the original instrumented recorder capture was obtained and reconciled. It does not prove the absence of out-of-recorder activity. Assistance and deviation counters reflect reviewed retained events and disclosures, rather than exhaustive surveillance.

## Public projection

The exporter constructs each public object afresh. It permits anonymous run/pair labels, bounded generic categories, numeric measurements, booleans and explicit nulls. Every call is reduced to its ordinal index, ordinal batch alias, permitted generic operation name and reviewed failure flag. The procedure projection contains anonymous roles, steps and dependency edges.

The release excludes raw payloads; private identities and operational identifiers; addresses and endpoints; graph, content and session identifiers; digest values; timestamps; prompts and answers; source paths; signing envelopes; raw errors; encoded private content; and raw proofs. Numeric observations and anonymous topology still do not provide a formal anonymity or unlinkability guarantee for a small study.

Public validation enforces exact field sets, permitted values, fixed assignments, sequential call indices, contiguous batch aliases and reconciled retained counts. It checks that completion, grades, replay and verification declarations are mutually consistent. Missing observations stay null and absent grades stay empty; unsuccessful grades and deviations remain visible. Gaps or restarts force lower-bound accounting and unavailable paired cost differences. Initial protocol 1.0.3 setup history remains a separate required file.

`sourceAuditPassed`, `retainedCallsReconciled`, verification fields ending in `Verified`, and replay summaries report private-review assertions. They are not independently recomputed private facts in the public validator. Its `status: passed` means that the projection passes accounting and structure checks; both independent live-signature and private-source-correspondence verification remain false. Synthetic release tests exercise the exporter and rejection rules, not live benchmark outcomes.

## Local export

Only a reviewed private source with the required audit declarations is eligible for export. The program itself does not perform that private review. An unresolved capture gap must be classified and disclosed, never relabeled as complete to pass validation.

With `AUDITED_SOURCE` pointing to that local reviewed source and `PUBLIC_OUTPUT` to a new directory outside its containing private directory:

```sh
node benchmarks/live-procedure-discovery/export-public.mjs "$AUDITED_SOURCE" "$PUBLIC_OUTPUT"
node benchmarks/live-procedure-discovery/audit.mjs "$PUBLIC_OUTPUT"
```

The output directory must not already exist. Export refusal emits a fixed message without rejected values, private paths or stack traces. Exporting creates local derived files; it does not publish them or authenticate their private source. Review the derived files and this disclosure before any public release.
