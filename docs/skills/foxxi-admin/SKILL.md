---
name: interego-foxxi-admin
description: "Foxxi content intelligence, administration as Interego affordances: 73 tools (read-intervention-methods, review-method-evidence, ingest-content-package, publish-authoring-policy, connect-lms, assign-audience, and more). Use when administering a Foxxi tenant: ingesting SCORM, cmi5 or xAPI packages, assigning audiences, publishing policies and ontologies, running coverage and audit queries, issuing credentials, judging and confirming content claims, or connecting an LMS."
license: MIT
metadata:
  vertical: foxxi-content-intelligence
  source: applications/foxxi-content-intelligence/affordances.ts
  affordances: 73
  manifest: "https://foxxi-bridge.interego.xwisee.com/affordances"
  generator: tools/build-skills.ts
---

# Foxxi content intelligence, administration

Use when administering a Foxxi tenant: ingesting SCORM, cmi5 or xAPI packages, assigning audiences, publishing policies and ontologies, running coverage and audit queries, issuing credentials, judging and confirming content claims, or connecting an LMS.

Everything here is derived from `applications/foxxi-content-intelligence/affordances.ts`, the vertical's single source of truth, by `tools/build-skills.ts`; do not edit it by hand. The live contract is the bridge's manifest at `https://foxxi-bridge.interego.xwisee.com/affordances` (Turtle; `?format=jsonld` or `?format=markdown` for other projections), and each tool's input contract is at `https://foxxi-bridge.interego.xwisee.com/affordances/<tool>/input` (JSON Schema, or SHACL with `?format=shacl`). Full descriptions and inputs for every affordance: [reference.md](reference.md).

## How to invoke

1. **Through any Interego MCP connector** (the relay or the stdio server): call `invoke_affordance` with `descriptor_url` = `https://foxxi-bridge.interego.xwisee.com/affordances`, `action_iri` = the affordance's action IRI below, and `payload` = its inputs. The connector follows `hydra:target` for you. An affordance whose description says the request must be signed needs `sign_request` first.
2. **Through the bridge's own MCP endpoint**: `POST https://foxxi-bridge.interego.xwisee.com/mcp` with JSON-RPC `tools/call`, `name` = the tool name, `arguments` = its inputs. Affordances marked *HTTP only* below are served by a bespoke route and are not callable this way.
3. **Directly over HTTP**: the method and target in the table, inputs as the JSON body (or query parameters for GET).

Every answer is a JSON object; a refusal is typed `iep:Refusal` with `iep:refusalStatus` naming the HTTP status and says what would be accepted instead.

## Affordances

| Tool | Does | Invoke |
| --- | --- | --- |
| `foxxi.read_intervention_methods` | Discover the versioned consulting and management cycle and the implementation method for each intervention. | `GET https://foxxi-bridge.interego.xwisee.com/performance/methods` *(HTTP only)* |
| `foxxi.review_method_evidence` | Check supplied artifact pointers and notes against the selected method criteria. | `POST https://foxxi-bridge.interego.xwisee.com/performance/methods/review` *(HTTP only)* |
| `foxxi.ingest_content_package` | Unwrap a SCORM 1.2 / SCORM 2004 / cmi5 zip package, run the Foxxi storyline parser (deterministic structural rendering + Whisper-transcribed audio + concept ex… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ingest_content_package` |
| `foxxi.publish_authoring_policy` | Declare which authoring tools (Articulate Storyline, Adobe Captivate, Camtasia, etc.) and which package standards (SCORM 1.2, SCORM 2004, cmi5, xAPI) are accep… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_authoring_policy` |
| `foxxi.connect_lms` | Register an external LMS (Cornerstone OnDemand, Workday Learning, SAP SuccessFactors, etc.) as a content source. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/connect_lms` |
| `foxxi.assign_audience` | Bind a course to an audience group (by audience_tag) via a Foxxi assignment policy descriptor. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/assign_audience` |
| `foxxi.coverage_query` | Privacy-respecting coverage query: across the catalog, which concepts are taught vs only mentioned, by which courses, in which categories. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/coverage_query` |
| `foxxi.publish_concept_map` | Publish the fxk: knowledge-stratum graph for a course as a federated pod artifact (using the federation_iri_base pattern from federation_payload.json). | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_concept_map` |
| `foxxi.publish_compliance_evidence` | Emit an ops event (assignment/completion/exception/audit) wrapped via compliance-overlay so the L&D activity becomes a framework-cited descriptor. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_compliance_evidence` |
| `foxxi.issue_completion_credential` | Mint a W3C Verifiable Credential (Open Badges 3.0-shaped) for a learner who completed a course, sign it with the tenant's deterministic Ed25519 issuer key (edd… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/issue_completion_credential` |
| `foxxi.export_clr` | Walk the learner's pod via iep:discover(), aggregate every fxa:CourseCompletionCredential + fxa:CompetencyAssertion the pod holds, verify each embedded W3C VC'… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/export_clr` |
| `foxxi.assemble_learner_record` | Compose an IEEE P2997 Enterprise Learner Record — the unified, provenance-pointed aggregate of a subject's path. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/assemble_learner_record` |
| `foxxi.record_performance` | Record one unit of on-the-job production work as an xAPI `performed` statement — the IEEE P2997 employment-history leg, kept distinct from training experiences. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_performance` |
| `foxxi.record_agent_trajectory` | Record an agent run in the AGENTIC-NATIVE form — not as flat xAPI statements but as a trajectory of Context Descriptors emergent from Interego L1: each step is… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_agent_trajectory` |
| `foxxi.get_agent_trajectory` | Return an agent's full agentic-native trajectory — every step at every modal status (including the Hypothetical intentions + Counterfactual branches xAPI canno… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/get_agent_trajectory` |
| `foxxi.assess_agent_disposition` | Read a team of agents' DISPOSITION from their trajectories — deliberately NOT a gap analysis. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/assess_agent_disposition` |
| `foxxi.run_performance_probe` | Record a safe-to-fail probe on an agent team — the disposition-based intervention. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/run_performance_probe` |
| `foxxi.open_agent_evaluation` | Open a named, shared evaluation — the place where several teams' competing agents or harnesses are compared head-to-head. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/open_agent_evaluation` |
| `foxxi.request_evaluation_enrollment` | A team requests that its agent / harness join an evaluation cohort as a candidate. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/request_evaluation_enrollment` |
| `foxxi.decide_evaluation_candidate` | The evaluation owner accepts or declines a requested candidate. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/decide_evaluation_candidate` |
| `foxxi.record_external_agent_run` | The one-call adapter for an EXTERNAL agent — one that does its work outside Foxxi (a Codex doing real coding, an OpenClaw or Hermes agent, a custom enterprise… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_external_agent_run` |
| `foxxi.get_agent_evaluation` | Return an evaluation cohort: the decision question, the shared task set, and every candidate with its team, harness, enrollment status (requested / accepted /… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/get_agent_evaluation` |
| `foxxi.compare_agent_evaluation` | Produce the comparative read for an evaluation cohort — deliberately NOT a benchmark leaderboard and it emits no overall score. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/compare_agent_evaluation` |
| `foxxi.export_case_framework` | Project the tenant's fxk:SkillFramework + fxk:Skill (+ rcd:CompetencyDefinition for skills that have RDCEO proficiency levels) into a 1EdTech CASE 1.0 CFDocume… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/export_case_framework` |
| `foxxi.emit_cmi5_session` | Build the full cmi5 statement trace (launched + initialized + completed + passed/failed + terminated, plus optional satisfied if moveOn rule fires) for a learn… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/emit_cmi5_session` |
| `foxxi.resolve_did` | Composes the substrate's DID resolver. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/resolve_did` |
| `foxxi.query_experience_index` | Implements the read side of the ADL Total Learning Architecture Experience Index. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/query_experience_index` |
| `foxxi.push_to_cass` | POST the tenant's CASE 1.0 CFDocument (from foxxi.export_case_framework) to a CaSS server's /api/framework endpoint. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/push_to_cass` |
| `foxxi.export_clr_v1` | Project the learner's pod credentials into the legacy 1EdTech CLR 1.0 shape for institutional consumers still on the pre-VC format. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/export_clr_v1` |
| `foxxi.issue_bbs_credential` | Build an OB3-shaped W3C VC, sign it with the tenant's BBS+ key over a flattened message list. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/issue_bbs_credential` |
| `foxxi.derive_bbs_presentation` | Holder-side. Given a BBS+-issued credential + a list of which claim paths to reveal, produce a zero-knowledge BBS+ proof + the revealed claims for the verifier. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/derive_bbs_presentation` |
| `foxxi.verify_bbs_presentation` | Verifier-side. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/verify_bbs_presentation` |
| `foxxi.prove_competency` | Holder-facing competency proof. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/prove_competency` |
| `foxxi.launch_au_with_prereq_check` | Compose: walk the learner's pod for a credential satisfying the declared prereq (verify Data Integrity Proof, check achievement IRI + proficiency level + expir… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/launch_au_with_prereq_check` |
| `foxxi.ai_assess_competency` | AI agent reviews evidence (cited slide IDs, Q&A traces, performance results) and signs a CompetencyAssertion VC with its own did:key. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/ai_assess_competency` |
| `foxxi.countersign_assessment` | Human admin reviews + countersigns the AI mentor's Hypothetical CompetencyAssertion. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/countersign_assessment` |
| `foxxi.audit_compliance_trail` | Walk the learner's pod, pull every descriptor with a Provenance facet or dct:conformsTo tag in the time window, return them ordered as a chain. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/audit_compliance_trail` |
| `foxxi.declare_framework_alignment` | Publishes a fxa:CASEAlignment descriptor binding one of this tenant's fxk:Skill / rcd:CompetencyDefinition items to an item in a foreign tenant's framework. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/declare_framework_alignment` |
| `foxxi.resolve_aligned_competency` | Given the held credential's competency IRI + a required competency IRI + the alignment graph, BFS over isAlignedTo / isEquivalentTo edges. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/resolve_aligned_competency` |
| `foxxi.cohort_concept_intelligence` | Walk a list of learner pods, pull every fxa:LearnerQuestionEvent in the time window, compute concept overlap across the cohort: which concepts >= 50% of learne… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/cohort_concept_intelligence` |
| `foxxi.register_self_sovereign_learner` | Self-enroll into a self-sovereign tenant. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/register_self_sovereign_learner` |
| `foxxi.publish_ontology` | Host an OWL/SHACL ontology the substrate way — not a raw file PUT, and not a developer-baked route. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/publish_ontology` |
| `foxxi.bootstrap_tenant` | Publish tenant-metadata + emit env-var configuration so the bridge can switch over to a new tenant. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/bootstrap_tenant` |
| `foxxi.scorm_cloud_pull` | Use SCORM Cloud Application API v2 to list courses + project them as fxs:CourseCatalog stub entries on the tenant pod. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/scorm_cloud_pull` |
| `foxxi.scorm_cloud_register` | POST to /registrations on SCORM Cloud; the returned registration ID becomes the cmi5 sessionId. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/scorm_cloud_register` |
| `foxxi.upload_scorm_package` | Upload a SCORM / cmi5 .zip. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/upload_scorm_package` |
| `foxxi.derive_adaptive_policy` | Takes the output of foxxi.cohort_concept_intelligence and derives a fxa:AdaptiveSequencingPolicy document naming the concepts a cohort is struggling with and t… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/derive_adaptive_policy` |
| `foxxi.schedule_spaced_repetition` | Ebbinghaus 1/7/30-day intervals, with early-week reminders for concepts other concepts depend on (foundation signal). | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/schedule_spaced_repetition` |
| `foxxi.discover_framework_registry` | Walk N pod URLs, return every fxs:CourseCatalog / fxs:SkillFramework / fxa:CASEAlignment descriptor — the public-registry pattern without a central registry. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/discover_framework_registry` |
| `foxxi.register_tutor_agent` | Builds a fxa:TutorAgentProfile descriptor from your specialties + contact endpoint. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/register_tutor_agent` |
| `foxxi.find_tutor_for_competency` | Rank-search tutor candidates by competency match + number of independent human-countersigned competency assertions they've signed (a proxy for teaching quality… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/find_tutor_for_competency` |
| `foxxi.generate_dpia` | Wraps foxxi.audit_compliance_trail. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/generate_dpia` |
| `foxxi.manager_team_view` | Walk each report's pod, aggregate credentials, return per-report breakdown + team skill coverage roll-up. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/manager_team_view` |
| `foxxi.build_did_web_document` | Returns the DID document JSON the operator uploads to https://<tenant-domain>/.well-known/did.json so verifiers can resolve tenant credentials. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/build_did_web_document` |
| `foxxi.backup_tenant_pod` | Pulls the manifest + every descriptor + every reachable graph into one JSON object. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/backup_tenant_pod` |
| `foxxi.le_design_ab_experiment` | Power-analysis + analysis plan for an instructional A/B. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_design_ab_experiment` |
| `foxxi.judge_content_claim` | One narrow question to TypeSafe System One about a unit of course content, answered as typed probabilities rather than prose. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/judge_content_claim` |
| `foxxi.confirm_content_judgment` | A person confirms or refutes a ContentJudgment: confirmed_answer must be one of the answers the judgment weighed (an evidence level, or a work regime). | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/confirm_content_judgment` |
| `foxxi.content_judgment_calibration` | Reads every foxxi:ContentJudgmentOutcome on the tenant pod and reports, per question kind (evidence-level, work-regime), how often the model had the confirmed… | `GET https://foxxi-bridge.interego.xwisee.com/foxxi/content_judgment_calibration` |
| `foxxi.attest_content_judgments` | Reads every foxxi:ContentJudgmentOutcome on the tenant pod, computes the calibration, and publishes a Self amta-shaped attestation by the judging agent about i… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/attest_content_judgments` |
| `foxxi.content_judgment_reputation` | Every foxxi:ContentJudgmentAttestation on the tenant pod about the judging agent (its own, grounded in the calibration, and any a learning engineer publishes a… | `GET https://foxxi-bridge.interego.xwisee.com/foxxi/content_judgment_reputation` |
| `foxxi.confirm_next` | The pending Hypothetical foxxi:ContentJudgment entities on the tenant pod, ranked by what a person's confirmation would teach: the model's own uncertainty (1 −… | `GET https://foxxi-bridge.interego.xwisee.com/foxxi/confirm_next` |
| `foxxi.record_content_judgment` | The same foxxi:ContentJudgment entity foxxi.judge_content_claim publishes for the bridge's model, with the answer, the distribution and the model you declare,… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/record_content_judgment` |
| `foxxi.cross_confirm` | For every claim two or more judges have judged, each judge's newest judgment gets an outcome from each other judge's answer — an agent confirmation naming the… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/cross_confirm` |
| `foxxi.best_judge` | Every judge the pod holds attestations about, ranked by the registry's rating on the axis that kind of question is scored on — accuracy for evidence-level, com… | `GET https://foxxi-bridge.interego.xwisee.com/foxxi/best_judge` |
| `foxxi.set_autonomy_policy` | Per kind of question, the registry rating on its axis a judge must reach (accuracy for evidence-level, competence for work-regime), over how many outcomes the… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/set_autonomy_policy` |
| `foxxi.autonomy_status` | The autonomy policy in force and, for every judge the pod attests about and every kind of question, whether that judge may assert without a person: its registr… | `GET https://foxxi-bridge.interego.xwisee.com/foxxi/autonomy_status` |
| `foxxi.weakest_claims` | Every evidence-level claim judged on the pod, graded and ranked weakest first: a person's confirmation if one exists, else an agent's, else the judges' answers… | `GET https://foxxi-bridge.interego.xwisee.com/foxxi/weakest_claims` |
| `foxxi.revise_claim` | Records a foxxi:ContentRevision — the claim as it stood and the grade it had, the words now and the evidence cited, who revised it (a person, or an agent recor… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/revise_claim` |
| `foxxi.le_estimate_concept_difficulty` | Composes prereq-graph topology + cohort question-frequency to produce a per-concept difficulty score (0..1). | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_estimate_concept_difficulty` |
| `foxxi.le_analyze_learning_curve` | Plots mastery-rate-per-attempt + detects plateaus (3 consecutive attempts with <1pp improvement). | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_analyze_learning_curve` |
| `foxxi.le_calibrate_mastery_threshold` | Find the score threshold that maximizes Youden's J (sensitivity + specificity − 1) against downstream prereq-dependent performance. | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_calibrate_mastery_threshold` |
| `foxxi.le_framework_gap_analysis` | Finds (a) competencies in the framework with no taught concept (assessments can't be grounded) and (b) taught concepts not aligned to any competency (credentia… | `POST https://foxxi-bridge.interego.xwisee.com/foxxi/le_framework_gap_analysis` |

