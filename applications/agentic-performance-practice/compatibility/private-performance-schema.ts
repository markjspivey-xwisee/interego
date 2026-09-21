/** Public contract only; no user evidence is exposed by this schema. */
export const PRIVATE_PERFORMANCE_SCHEMA = {
  version: '1',
  planner: { path: '/agent/contextualize-and-plan', optIn: 'private_evidence', reviewOnly: 'private_review: true reads own empirical profile without a new plan or counted episode' },
  transport: 'Use existing sign_request then act. agent_id/timestamp are required by signed transport. Automatically stamped subject_pod_url is accepted only when equivalent to the authenticated own pod, then excluded from logical plan identity.',
  ref: { uri: 'HTTP(S) or URN immutable evidence identifier', version: 'nonempty version string', sha256: 'lowercase SHA-256 hex of evidence bytes; report uses canonical JSON below' },
  private_evidence: {
    episode_id: 'stable id for one learner/intervention episode', study_id: 'study id', learner_id: 'learner label (not an independently verified identity)',
    policy: 'ref', baseline: 'measurement with phase=baseline', assistance: 'baseline assistance description', independence: 'same-account-procedural | self-assessed',
    target: { minimum_score: 'number >0 and <=1', maximum_unsafe: 'nonnegative integer' },
  },
  measurement: {
    phase: 'baseline | post | fresh', correct: 'integer >=0', total: 'integer >0, >=correct', unsafe: 'integer >=0, <=total', assessed_at: 'observed ISO UTC timestamp',
    assessment: 'ref', responses: 'ref', scorer: 'ref, same hash/version in every phase', report: 'ref whose sha256 hashes report_content',
    report_content: { phase: 'exact matching phase', correct: 'exact matching correct', total: 'exact matching total', unsafe: 'exact matching unsafe', assessed_at: 'exact matching timestamp', policy_sha256: 'policy.sha256', assessment_sha256: 'assessment.sha256', responses_sha256: 'responses.sha256', scorer_sha256: 'scorer.sha256' },
  },
  canonicalHash: 'SHA-256 UTF-8 JSON with object keys recursively lexicographically sorted, compact separators, array order retained, finite JSON values only. report_content accepts exactly the nine declared fields.',
  outcome: {
    episode_id: 'same as private_evidence.episode_id', plan_id: 'returned privatePlan.plan_id', plan_sha256: 'returned privatePlan.sha256',
    intervention: { type: 'a selected intervention in the bound server plan', delivered: 'boolean', artifact: 'ref', delivered_at: 'UTC time >= baseline and server plan creation, <= post' },
    post: 'measurement phase=post', fresh: 'optional additional measurement phase=fresh; omit if no additional follow-up occurred', assistance: 'post/fresh assistance description', observed_at: 'UTC time >= last assessment',
  },
  actionPayloads: {
    record: '{agent_id,timestamp,subject_pod_url?,outcome}', read: '{agent_id,timestamp,subject_pod_url?,episode_id?}', calibration: '{agent_id,timestamp,subject_pod_url?}',
  },
  limits: '1000 plans and 1000 episodes, 4 MB encrypted snapshot per account. Private content is encrypted to owner+bridge; trusted bridge can decrypt. No public projection or shared-seed update.',
  verification: 'Arithmetic, submitted report content hashes and fixed evidence bindings are checked. Evidence URIs are not fetched. Server plans/outcomes carry a bridge-secret authentication tag. Assessor truth, independent sampling and causal learning are not verified.',
  calibration: 'Only derived Knowable gap-analysis with named cause, baseline gap, newly delivered selected intervention and non-self-assessed reports is eligible. Eligible rates are tentative: this caller-supplied evidence trust class always remains Hypothetical and cannot trigger automatic rate-driven intervention swapping. Manager may use observations for review/stop. Seeds excluded.',
} as const;
