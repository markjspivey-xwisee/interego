# Learner-performer companion: every affordance

Derived from `applications/learner-performer-companion/affordances.ts` by `tools/build-skills.ts`; the skill is [SKILL.md](SKILL.md). 11 affordances.

## `lpc.ingest_training_content`

**Ingest training content**

Unwrap a SCORM 1.2 / SCORM 2004 / cmi5 zip package, extract launchable lesson content, mint content-addressed PGSL atoms, and publish lpc:TrainingContent + lpc:LearningObjective descriptors to the user's pod.

- Action: `urn:iep:action:lpc:ingest-training-content`
- HTTP: `POST {base}/lpc/ingest_training_content`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `zip_base64` | string | yes | SCORM zip package, base64-encoded. |
| `authoritative_source` | string | yes | DID of the training content publisher (e.g., did:web:acme-training.example). |
| `pod_url` | string | no | Pod URL (default: authenticated user's pod). |
| `user_did` | string | no | User DID (default: derived from authentication). |

## `lpc.import_credential`

**Import a verifiable credential**

Verify a W3C Verifiable Credential (vc-jwt or DataIntegrityProof JSON-LD) and publish as lpc:Credential to the user's pod. Verification failures throw — bad VCs never land in the pod under credential IRIs.

- Action: `urn:iep:action:lpc:import-credential`
- HTTP: `POST {base}/lpc/import_credential`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `vc_jwt` | string | no | Compact JWS encoding of the VC (use this OR vc_jsonld). |
| `vc_jsonld` | object | no | JSON-LD VC with embedded DataIntegrityProof (use this OR vc_jwt). |
| `for_content` | string | no | IRI of the lpc:TrainingContent this credential certifies. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lpc.record_performance_review`

**Record a performance review**

Publish a performance review with iep:ProvenanceFacet attributing it to the manager (NOT the user). Stays in the user's pod portably.

- Action: `urn:iep:action:lpc:record-performance-review`
- HTTP: `POST {base}/lpc/record_performance_review`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | string | yes | Review text. |
| `manager_did` | string | yes | DID of the reviewing manager. |
| `signature` | string | yes | Manager's ECDSA signature over the content. |
| `recorded_at` | string | yes | ISO timestamp. |
| `flags_capability` | string | no | Optional capability IRI flagged by the review. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lpc.record_learning_experience`

**Record a learning experience from an xAPI Statement**

Ingest an xAPI Statement (any version 1.0.x or 2.0.x) as an lpc:LearningExperience descriptor in the user's pod, cross-linked to training content and credential earned.

- Action: `urn:iep:action:lpc:record-learning-experience`
- HTTP: `POST {base}/lpc/record_learning_experience`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `statement` | object | yes | xAPI Statement object. |
| `for_content` | string | yes | IRI of the related lpc:TrainingContent. |
| `earned_credential` | string | no | Optional IRI of the lpc:Credential earned. |
| `lrs_endpoint` | string | no | Optional source LRS endpoint URL. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lpc.grounded_answer`

**Answer a grounded chat question**

Answer a natural-language question by retrieving from the user's pod with verbatim citation. Returns null when nothing in the wallet grounds the question — honest no-data, no confabulation. Persists an lpc:CitedResponse audit record.

- Action: `urn:iep:action:lpc:grounded-answer`
- HTTP: `POST {base}/lpc/grounded_answer`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `question` | string | yes | The user's question. |
| `persist_response` | boolean | no | Whether to persist the response as audit. Default true. |
| `assistant_did` | string | no | DID of the answering assistant. |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lpc.list_wallet`

**Summarize the user's wallet**

Return a summary of training content, credentials, performance records, and learning experiences in the user's pod-backed wallet.

- Action: `urn:iep:action:lpc:list-wallet`
- HTTP: `POST {base}/lpc/list_wallet`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `pod_url` | string | no | Pod URL. |
| `user_did` | string | no | User DID. |

## `lpc.opt_into_cohort`

**Opt the learner into an institutional cohort aggregate**

Learner-side: publish a SIGNED agg:CohortParticipation descriptor on the learner's pod, declaring willingness to be counted in an institutional aggregate-cohort-query for the named cohort_iri. The institution's lpc.aggregate_cohort_query with privacy_mode = merkle-attested-opt-in will include this learner's pod in the count and emit a Merkle inclusion proof. Revoke by re-publishing the same descriptor with modal status Counterfactual (auto-supersedes the prior Asserted one). The substrate's consent boundary — the institution cannot include a learner who has not opted in.

- Action: `urn:iep:action:lpc:opt-into-cohort`
- HTTP: `POST {base}/lpc/opt_into_cohort`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cohort_iri` | string | yes | IRI of the institutional cohort the learner is opting into. |
| `policy_iri` | string | no | IRI of the cohort-aggregation policy descriptor (on the institution's pod) the learner is consenting to. |
| `pod_url` | string | no | Learner pod URL. |
| `user_did` | string | no | Learner DID. |

## `lpc.publish_authoritative_content`

**[institutional] Publish authoritative training content**

Institution-side: publish lpc:TrainingContent + lpc:LearningObjective descriptors to the INSTITUTION's own pod (NOT the learner's) from a caller-supplied catalog entry — a stable content IRI, a title, and optional objectives, launch URL, format and ADL TLA LAP metadata. It does NOT parse a content package: the descriptor is minted from what the caller states, so nothing here is content-addressed or verified against a package. To unwrap a SCORM / cmi5 archive first, use foxxi.upload_scorm_package and publish its resulting IRI here. Learners' agents discover via federated discovery and pull selectively into their own wallets per their own consent. The institution is a peer, not a hub.

- Action: `urn:iep:action:lpc:publish-authoritative-content`
- HTTP: `POST {base}/lpc/publish_authoritative_content`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `content_iri` | string | yes | Stable IRI naming the content — a SCORM activity, a TLA LAP entry, or any dereferenceable identifier the institution controls. Echoed back as contentIri; nothing is fetched from it here. |
| `title` | string | yes | Human-readable name. Required: the handler refuses an empty one. |
| `institution_pod_url` | string | yes | Pod URL of the publishing institution. |
| `issuer_did` | string | yes | DID of the institution's authoritative-content signing key. |
| `description` | string | no | One-paragraph summary; surfaces to learners' agents. |
| `learning_objectives` | array | no | Objective strings the content covers. Each becomes an lpc:LearningObjective IRI in objectiveIris. |
| `launch_url` | string | no | Where learners actually launch the content. |
| `format` | string | no | SCORM 1.2 / SCORM 2004 / cmi5 / pdf / video / tla-lap-entry. A LABEL the caller states — no package is read to confirm it. |
| `tla_lap_metadata` | object | no | Optional ADL TLA Learning Activity Provider metadata for catalog discoverability. |

## `lpc.issue_cohort_credential_template`

**[institutional] Issue a cohort credential template**

Institution-side: publish a SIGNED credential TEMPLATE (the rubric for what is earned) to the institution's pod. Eligible learners' agents discover, verify the issuer's signature, and call lpc.import_credential to accept the issuance into their own wallet. Conforms to Open Badges 3.0 / IMS CLR 2.0 / IEEE LERS shapes per the `credential_format` parameter. The institution issues; the learner consents to acceptance.

- Action: `urn:iep:action:lpc:issue-cohort-credential-template`
- HTTP: `POST {base}/lpc/issue_cohort_credential_template`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cohort_iri` | string | yes | IRI naming the cohort the template applies to (e.g., a course-completion cohort). |
| `credential_format` | string | yes | One of: open-badges-3.0 \| ims-clr-2.0 \| ieee-lers. |
| `credential_subject_template` | object | yes | The W3C VC credentialSubject template; learner DID substituted on acceptance. |
| `issuer_did` | string | yes | DID of the credential-signing institution. |
| `institution_pod_url` | string | yes | Pod URL where the template is published. |

## `lpc.aggregate_cohort_query`

**[institutional] Run an aggregate-privacy query over a cohort**

Institution-side: query aggregate metrics over consenting learners' pods — completion counts, score distributions, competency-coverage thresholds — without seeing individuals. Privacy modes on this surface: v1 abac (default) | v2 merkle-attested-opt-in (verifiable count + Merkle inclusion proofs) | v3 zk-aggregate (homomorphic Pedersen sum + DP-Laplace noise) | v3.1 + require_signed_bounds (regulator-grade attribution) | v3.2 + epsilon_budget_max (cumulative ε discipline). zk-distribution (v3 histogram) is NOT implemented here and is refused with 501 rather than answered on the weaker path — it is wired in the foxxi vertical. See applications/_shared/aggregate-privacy/. Refuses any query that would expose an individual record under the chosen mode.

- Action: `urn:iep:action:lpc:aggregate-cohort-query`
- HTTP: `POST {base}/lpc/aggregate_cohort_query`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `cohort_iri` | string | yes | IRI of the cohort being queried. |
| `metric` | string | yes | One of: completion-count \| score-distribution \| competency-threshold-met \| credential-coverage. |
| `predicate` | object | no | Optional SHACL-shaped filter (e.g., "score >= 0.8"). The query returns the count / proof of how many learners satisfy; not which. |
| `institution_pod_url` | string | yes | Pod URL of the querying institution (used for authorization + result publication). |
| `privacy_mode` | string | no | One of: abac (default v1) \| merkle-attested-opt-in (v2) \| zk-aggregate (v3 single-sum) \| zk-distribution (v3 histogram). The bundle returned in the response advertises which path was taken. |
| `epsilon` | number | no | DP ε budget for zk-aggregate / zk-distribution modes. Required when privacy_mode is one of those. For zk-distribution this is the per-bucket ε; histogram-level cumulative ε under sequential composition is k * ε where k = number of buckets. |
| `distribution_edges` | array | no | v3 zk-distribution: ascending bucket-edge boundaries (bigints) as decimal strings. Required when privacy_mode=zk-distribution. Each bucket is right-open except the last which is right-closed at distribution_max_value. For an edges array of length k+1 there are k buckets. |
| `distribution_max_value` | string | no | v3 zk-distribution: upper bound (decimal-string bigint) for the last bucket. Values above this throw at contribution time. Required when privacy_mode=zk-distribution. |
| `require_signed_bounds` | boolean | no | v3.1: when true, every contribution must carry a SignedBoundsAttestation. Aggregator refuses contributions without a valid signature. Default false. |
| `epsilon_budget_max` | number | no | v3.2: declare a cumulative ε cap for this cohort. The aggregator constructs a per-call EpsilonBudget and refuses to run if cumulative consumption would exceed cap. For persistent cross-call budgets, persist the EpsilonBudget snapshot via lpc.publish_authoritative_content or a sibling pattern. |
| `threshold_reveal_n` | number | no | v4-partial+VSS: total number of pseudo-aggregators in the threshold-reveal committee. When set with privacy_mode=zk-aggregate, the trueBlinding is Shamir-split into n shares AND Feldman VSS coefficient commitments are emitted alongside (every recipient verifies their share against `coefficientCommitments` before reconstruction, so a tampered share is caught BEFORE Lagrange poisons the result). The trueBlinding is omitted from audit fields (no single party including the auditor knows it). Trusted-dealer caveat: the aggregator running the query knows the polynomial during the split; full DKG is the remaining v4 piece. |
| `threshold_reveal_t` | number | no | v4-partial+VSS: threshold for reconstruction. Any t-of-n committee can reconstruct trueBlinding via reconstructThresholdRevealAndVerify (which filters shares against the bundle's coefficientCommitments BEFORE Lagrange); any t-1 shares reveal nothing. Required when threshold_reveal_n is supplied. Chain-of-custody: after a successful reconstruction, the committee signs a CommitteeReconstructionAttestation via signCommitteeReconstruction + publishCommitteeReconstructionAttestation so the regulator can see who participated. |

## `lpc.project_to_lrs`

**[institutional] Project descriptors as xAPI Statements outbound to an LRS**

Institution-side: with the learner's per-graph consent, translate lpc:LearningExperience descriptors from the learner's pod into xAPI 2.0 Statements and POST to a target LRS (Watershed / Veracity / SCORM Cloud / Yet Analytics / Learning Locker). Wraps the boundary translator in ../lrs-adapter/. The result is lossy by definition (xAPI cannot express modal status / supersedes chains); the adapter records this lossiness in result.extensions.

- Action: `urn:iep:action:lpc:project-to-lrs`
- HTTP: `POST {base}/lpc/project_to_lrs`

| Input | Type | Required | Description |
| --- | --- | --- | --- |
| `descriptor_iri` | string | yes | IRI of the lpc:LearningExperience descriptor to project. |
| `target_lrs_url` | string | yes | Statements endpoint of the target LRS (e.g. https://cloud.scorm.com/lrs/<APP>/sandbox/statements). |
| `lrs_username` | string | yes | Basic-auth username — the xAPI activity-provider key. |
| `lrs_password` | string | yes | Basic-auth password — the xAPI activity-provider secret. |
| `learner_pod_url` | string | yes | Pod URL hosting the learner's lpc:LearningExperience descriptor. |
| `learner_did` | string | yes | Learner's DID — used as the xAPI actor on the projected Statement. |
| `verb_id` | string | yes | xAPI verb IRI (e.g. http://adlnet.gov/expapi/verbs/completed). |
| `object_id` | string | yes | xAPI object IRI, typically the lpc:TrainingContent IRI. |
| `verb_display` | string | no | Optional human-readable verb display string. |
| `object_name` | string | no | Optional human-readable object name. |
| `modal_status` | string | no | Modal status of the source descriptor. The adapter skips Counterfactual unconditionally, and Hypothetical unless allow_hypothetical is set. |
| `allow_hypothetical` | boolean | no | Project a Hypothetical source anyway, with audit-loud lossy markers. |
| `learner_consent_descriptor_iri` | string | yes | IRI of the per-graph share_with policy descriptor on the learner's pod authorizing this projection. |

