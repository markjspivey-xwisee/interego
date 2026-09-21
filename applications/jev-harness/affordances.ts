/**
 * Affordance declarations for the jev-harness vertical.
 *
 * Each capability is declared ONCE here. The bridge derives its HTTP routes and the
 * /affordances manifest from this array; generic Interego agents discover the vertical by
 * dereferencing that manifest and act by following hydra:target — the same
 * discover → dereference → act loop the kernel's `act` verb and the relay's
 * `invoke_affordance` perform. Action IRIs use the urn:iep:action:jev-harness:<verb>
 * convention; targets use {base} for the bridge's deployment URL.
 *
 * Every judgment affordance READS the repository the bridge is bound to (JEV_HARNESS_REPO) —
 * declared under `reads` so a caller can tell an empty answer from a wrong repository.
 */

import { actionIri, type Affordance } from './src/affordance-types.js';
import { DEFAULT_NS } from './src/descriptor.js';

const NS = process.env['JEV_HARNESS_NS'] ?? DEFAULT_NS;

const REPO_READ = {
  store: 'JEV_HARNESS_REPO',
  label: 'The git working tree the bridge is bound to',
  populatedBy: 'the operator, at bridge start; the answer names its commit',
} as const;

export const jevHarnessAffordances: ReadonlyArray<Affordance> = [
  {
    action: actionIri('urn:iep:action:jev-harness:navigate'),
    toolName: 'jev_harness.navigate',
    title: 'Navigate: where does this task belong',
    description: 'Given a task sentence, rank the repository files most likely to change, the test that most directly covers the behaviour, and the document to read first, with a probability each and an advice level (open-top-file, open-top-three, widen-search) derived from the model\'s confidence. Publishes a Hypothetical jvh:Navigation whose payload carries the next controls: select-tests for the candidates, a narrowed refine pass when confidence is low, and record-outcome.',
    method: 'POST',
    targetTemplate: '{base}/jev-harness/navigate',
    inputShape: `${NS}NavigateInputShape`,
    returns: `${NS}Navigation`,
    mediaType: 'application/json',
    annotations: { title: 'Navigate a task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputs: [
      { name: 'task', type: 'string', required: true, description: 'The task sentence: what is to be changed or found.' },
      { name: 'scope', type: 'string', required: false, description: 'Repository-relative directory to search within.' },
      { name: 'top_k', type: 'integer', required: false, description: 'Candidates per role, 1 to 10.', minimum: 1, maximum: 10 },
    ],
    reads: [REPO_READ],
    outputs: {
      description: 'The jvh:Navigation judgment plus its descriptor URL and controls.',
      properties: {
        judgment: { type: 'object', description: 'files, tests, docs (path + probability), covered, advice, confidence.' },
        url: { type: 'string', description: 'Dereferenceable judgment URL (JSON, text/turtle, application/trig, text/markdown).' },
        controls: { type: 'array', description: 'The next-step controls the judgment affords.' },
      },
      required: ['judgment', 'url', 'controls'],
    },
  },
  {
    action: actionIri('urn:iep:action:jev-harness:select-tests'),
    toolName: 'jev_harness.select_tests',
    title: 'Select the tests a change warrants',
    description: 'For a set of changed files (or a git base_ref to diff against), return the tests to run: every test that imports a changed file (deterministic), plus the tests the model judges to cover a changed file without importing it (semantic, with probabilities). Sensitive paths, infrastructure files and oversized changes return mode=full with the reason. Publishes a Hypothetical jvh:TestSelection whose controls are run-selected-tests (declarative), triage and record-outcome.',
    method: 'POST',
    targetTemplate: '{base}/jev-harness/select-tests',
    inputShape: `${NS}SelectTestsInputShape`,
    returns: `${NS}TestSelection`,
    mediaType: 'application/json',
    annotations: { title: 'Select tests', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputs: [
      { name: 'changed_files', type: 'array', required: false, description: 'Repository-relative paths that changed.', itemType: 'string' },
      { name: 'base_ref', type: 'string', required: false, description: 'Git ref to diff against when changed_files is not given.' },
      { name: 'head_ref', type: 'string', required: false, description: 'Git ref of the change; defaults to the working tree.' },
      { name: 'task', type: 'string', required: false, description: 'Optional task sentence for context.' },
    ],
    reads: [REPO_READ],
  },
  {
    action: actionIri('urn:iep:action:jev-harness:triage'),
    toolName: 'jev_harness.triage',
    title: 'Triage a failing test run',
    description: 'Parse a test-runner log into distinct failures and classify each one\'s cause (code-defect, test-defect, environment, flaky, missing-dependency-or-fixture, unclear) with a probability distribution; the class-to-action table is published on the judgment. Publishes a Hypothetical jvh:FailureTriage whose controls are one declarative action per cause class plus record-outcome.',
    method: 'POST',
    targetTemplate: '{base}/jev-harness/triage',
    inputShape: `${NS}TriageInputShape`,
    returns: `${NS}FailureTriage`,
    mediaType: 'application/json',
    annotations: { title: 'Triage failures', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputs: [
      { name: 'log', type: 'string', required: true, description: 'The test runner\'s output.' },
      { name: 'changed_files', type: 'array', required: false, description: 'Files changed in the run under test.', itemType: 'string' },
    ],
  },
  {
    action: actionIri('urn:iep:action:jev-harness:review-gate'),
    toolName: 'jev_harness.review_gate',
    title: 'Gate a diff for human review',
    description: 'Decide whether a diff may proceed without a person: deterministic checks (secret in diff, sensitive path, deleted test, oversized change), then model hazards (authorization change, weakened validation, removed assertions, undeclared external effect, behaviour beyond the description), a description-match score and a risk rating. The verdict — auto-ok, needs-human-review or block — is derived by the policy text published on the judgment. auto-ok means only that the gate does not demand a person. Publishes a Hypothetical jvh:ReviewVerdict.',
    method: 'POST',
    targetTemplate: '{base}/jev-harness/review-gate',
    inputShape: `${NS}ReviewGateInputShape`,
    returns: `${NS}ReviewVerdict`,
    mediaType: 'application/json',
    annotations: { title: 'Review gate', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputs: [
      { name: 'diff', type: 'string', required: false, description: 'A unified diff. Either this or base_ref.' },
      { name: 'base_ref', type: 'string', required: false, description: 'Git ref to diff against.' },
      { name: 'head_ref', type: 'string', required: false, description: 'Git ref of the change; defaults to the working tree.' },
      { name: 'title', type: 'string', required: false, description: 'Change title (PR title or commit subject).' },
      { name: 'description', type: 'string', required: false, description: 'Change description (PR body).' },
    ],
    reads: [REPO_READ],
  },
  {
    action: actionIri('urn:iep:action:jev-harness:record-outcome'),
    toolName: 'jev_harness.record_outcome',
    title: 'Record what actually happened',
    description: 'Score a prior judgment against what happened: files_changed for a navigation, tests_failed for a test selection, human_decision for a review verdict, confirmed_classes for a triage. Publishes an Asserted jvh:Outcome that iep:supersedes the Hypothetical judgment (hit@1, hit@3, Brier, agreement). This is the evidence atom of the calibration view.',
    method: 'POST',
    targetTemplate: '{base}/jev-harness/outcome',
    inputShape: `${NS}RecordOutcomeInputShape`,
    returns: `${NS}Outcome`,
    mediaType: 'application/json',
    annotations: { title: 'Record outcome', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'judgment_iri', type: 'string', required: true, description: 'urn:graph:jev-harness:* IRI of the judgment being scored.' },
      { name: 'files_changed', type: 'array', required: false, description: 'Files that actually changed.', itemType: 'string' },
      { name: 'tests_run', type: 'array', required: false, description: 'Tests that ran.', itemType: 'string' },
      { name: 'tests_failed', type: 'array', required: false, description: 'Tests that failed.', itemType: 'string' },
      { name: 'human_decision', type: 'string', required: false, description: 'approved, changes-requested or blocked.', enum: ['approved', 'changes-requested', 'blocked'] },
      { name: 'confirmed_classes', type: 'string', required: false, description: 'JSON object: failure id to confirmed cause class.' },
    ],
  },
  {
    action: actionIri('urn:iep:action:jev-harness:calibration'),
    toolName: 'jev_harness.calibration',
    title: 'Read the calibration view',
    description: 'Per judgment kind, over every recorded outcome: sample count, hit@1 and hit@3 rates, mean Brier score, agreement counts. A cell is Hypothetical until it has five samples and Asserted after. A view over the judgment-to-outcome supersession chains, not a store.',
    method: 'GET',
    targetTemplate: '{base}/jev-harness/calibration',
    returns: `${NS}Calibration`,
    mediaType: 'application/json',
    annotations: { title: 'Calibration', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [],
  },
  {
    action: actionIri('urn:iep:action:jev-harness:publish-calibration'),
    toolName: 'jev_harness.publish_calibration',
    title: 'Publish the calibration view to the pod, and the attestation it grounds',
    description: 'Publishes the current calibration view as an Asserted jvh:Calibration descriptor under one graph IRI per repository, each publish superseding the last so the chain is the calibration history, and — once a cell has reached its sample floor — an amta:Attestation the harness issues about itself (direction Self: competence from navigation hit@3, accuracy from review-verdict agreement, relevance from test-selection coverage, honesty from navigation Brier), grounded in the calibration descriptor. Answers with where both landed; skipped without a relay. The bridge also publishes on its own after a pod read-back that added outcomes, and CI after scoring a merged pull request.',
    method: 'POST',
    targetTemplate: '{base}/jev-harness/calibration/publish',
    returns: `${NS}Calibration`,
    mediaType: 'application/json',
    annotations: { title: 'Publish calibration', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [],
  },
  {
    action: actionIri('urn:iep:action:jev-harness:reputation'),
    toolName: 'jev_harness.reputation',
    title: 'Read what the pod attests about this agent',
    description: 'Every amta:Attestation about the harness agent on its pod — the bridge\'s own self-attestation, grounded in the calibration descriptor it names, and any a peer publishes — aggregated by @interego/registry under the harness policy (a grounded self-attestation counts at a quarter of a peer\'s word, half of a high-assurance one\'s; thirty-day recency half-life). Answers with the attestations read, the snapshot (per-axis ratings and the contributing descriptors) or null when nothing attests, and the policy. The gated auto-merge reads the accuracy axis when a person is required.',
    method: 'GET',
    targetTemplate: '{base}/jev-harness/reputation',
    returns: `${NS}Calibration`,
    mediaType: 'application/json',
    annotations: { title: 'Reputation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [],
  },
];
