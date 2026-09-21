# Private empirical performance feedback

This vertical adapter composes AGP diagnosis/calibration with Foxxi's hosted signed-request identity and PGSL encrypted persistence. It adds no generic MCP tool or protocol vocabulary. Existing unsigned/legacy seeded performance routes keep their behavior; the private opt-in never consumes or writes their corpus.

## Followable contract

Discover the Foxxi catalog, then use its signed affordances through `sign_request` and `act`. Each descriptor embeds the complete input contract; `GET /agent/performance/schema` also returns it as JSON.

| Operation | Route | Action |
|---|---|---|
| Plan and bind baseline | `/agent/contextualize-and-plan` with `private_evidence` | `urn:iep:action:foxxi:contextualize-and-plan-signed` |
| Review using own evidence, no new episode | Same route with `private_review: true` | Same action |
| Record episode | `/agent/performance/outcome` | `urn:iep:action:foxxi:record-private-performance-outcome-signed` |
| Read own plans/outcomes | `/agent/performance/outcomes` | `urn:iep:action:foxxi:read-private-performance-outcomes-signed` |
| Read own empirical profile | `/agent/performance/calibration` | `urn:iep:action:foxxi:read-private-performance-calibration-signed` |

Every signed payload has `agent_id` and `timestamp`. Relay-added `subject_pod_url` is checked against the verified own pod and is never a storage destination supplied by the caller. Signature timestamp and this stamp do not affect logical plan retry identity. Other pod overrides are refused. Ordinary delegated `discover` + `publish` capabilities (ReadWrite) suffice; reads/reviews require `discover`. No tenant-admin membership or raw-wallet-only authentication is introduced.

`private_evidence` is `{episode_id,study_id,learner_id,policy,baseline,assistance,independence,target}`. `policy` is a reference `{uri,version,sha256}`. `independence` is `same-account-procedural` or `self-assessed`; independent signer attestation is not supported. `target` is `{minimum_score,maximum_unsafe}` (minimum score in (0,1]). Baseline observation must precede server plan creation. Returned `privatePlan` contains its immutable `plan_id` and `sha256`.

A measurement is `{phase,correct,total,unsafe,assessed_at,assessment,responses,scorer,report,report_content}`. References use the shape above. All counts are bounded nonnegative integers, total >0, correct/unsafe <=total. Scorer hash and version remain fixed, and phase assessment hashes and response identifiers are distinct. Different forms may legitimately produce identical response bytes.

`report_content` has exactly these fields: `{phase,correct,total,unsafe,assessed_at,policy_sha256,assessment_sha256,responses_sha256,scorer_sha256}`. Its SHA-256 is the UTF-8 hash of compact JSON with recursively sorted object keys and retained array order. The `report.sha256` must match. Policy, assessment, response, scorer and numeric fields must match the enclosing measurement. A canonical wrapper report can cite raw scorer report and answers through the preserved evidence artifacts; the wrapper is not a new scoring run.

Record payload: `{outcome:{episode_id,plan_id,plan_sha256,intervention:{type,delivered,artifact,delivered_at},post,fresh?,assistance,observed_at}}` plus signed transport fields. The intervention type must be selected by the actual persisted server plan. Delivery must follow baseline and plan creation, then post, optional fresh, and observation timestamps. `fresh` is an additional follow-up, not a second label for the same assessment. Omit it when absent; transfer is then explicitly not measured. The route rejects arbitrary `success` or verdict labels and calculates the numeric verdict itself.

## Persistence and privacy

The canonical resource is the verified account's `foxxi-lattice/private-performance-v1.holon.json`. This is a dedicated encrypted PGSL snapshot, separate from public and learner-record lattices. No `markLatticePublic`, public descriptor projection, competency promotion or seeded corpus mutation occurs. Authorized delegates on the same canonical account share it; each plan preserves `created_by` and each outcome `recorded_by`. Another account has a separate resource and cannot bind another account's plan.

Each read resolves the pod resource, decrypts it, validates schema/owner, plan hashes, bridge-secret HMAC authentication tags and derived outcome integrity. Owner-writable pod content cannot masquerade as server-issued plans by merely recomputing content hashes. HMAC uses the configured bridge encryption secret with a purpose-prefixed message; it is an internal integrity check, not an independent assessor signature. Content is encrypted for both owner and trusted bridge; this is not client-only E2EE. Owner key failure refuses the write instead of silently falling back to bridge-only encryption.

ETag compare-and-swap re-reads and revalidates logical identity after every conflict. Identical episode retries return the prior durable outcome; altered retries conflict. Ambiguous committed PUTs resolve by re-reading. No process-local mirror is authoritative. Corrupt/unreadable storage or missing ETags fail closed. One learner's identical assessment/response hashes cannot count twice merely through URI or study-label aliases. Stable plan/episode identity is still caller-chosen; this is not proof of independent sampling. The snapshot is capped at 1000 plans, 1000 episodes and 4 MB. No automatic archival workflow is provided. Immutability/deduplication are API guarantees; an owner can delete or roll back pod storage, and there is no external rollback witness. Bridge key rotation requires a migration; there is no silent key-loss recovery.

## Measurement and calibration limits

One row is one learner/intervention episode, never one test item. Outcomes expose baseline-to-post/fresh score changes, unsafe regressions, target attainment, extra fresh assessment presence, eligibility and evidence scope. A baseline ceiling returns no-change, not a manufactured learning gain. Different assistance conditions remain visible and may explain a measured difference.

Eligibility requires derived Knowable cause analysis, a named cause, a genuine baseline target gap, a newly delivered selected intervention and a non-self-assessed report. Other measured work remains stored but cannot populate cause/intervention calibration. Unknown rules may legitimately indicate missing information; this route never reclassifies that as deficient intelligence or forces a Knowable label.

Private profiles show zero seeds, raw measured/eligible/ineligible episode counts, distinct reported learner labels and source. They retain AGP's numeric threshold but **always remain Hypothetical for this trust class**: caller-supplied reports do not establish independently sampled empirical evidence. This is stronger than merely waiting for twelve episodes. Consequently, although private planning/review executes `calibrationDrivenReplan`, these profiles cannot trigger an automatic rate-based intervention swap. They can produce a tentative measured track record, and the manager can use evidence to continue/revise/stop. Trusted independent sampling and automatic empirical rate-based swapping are not established by this change.

Evidence URIs are bindings, not fetched/verbatim-verified remote resources. The route validates exact submitted report hashes, numeric arithmetic and server-plan provenance; it does not independently rerun a scorer, verify observations, prove causal learning, unaided retention, model-weight change or independent cryptographic assessor identities. Revised plans require a new episode identifier; routine reassessment uses `private_review:true` so it does not create extra outcomes. There is no server worker scheduler: agents orchestrate through affordances.

## Verification

`applications/foxxi-content-intelligence/tests/private-performance.test.ts` exercises actual encryption/decryption and HTTP adapters against a deterministic CAS pod double: independent authentication/scope checks, signed-transport stamps, cross-surface account sharing/cross-account denial, numeric and hash rejection, absent fresh assessment, immutable duplicate/conflict and ambiguous-write recovery, new-instance restart reads, no public projection, owner-forged plan rejection, and private planning/review without seed pollution. Unit fixtures that set a derived regime are explicitly fixtures, not measured live trajectories.
