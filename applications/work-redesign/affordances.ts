/**
 * The work-redesign vertical's capabilities, declared once. The bridge mounts one route per
 * entry, derives each MCP tool schema from it, and serves the manifest a Path-A agent walks.
 *
 * Every write takes a signed envelope and nothing else that names a person: identity is the
 * address recovered from the signature, never an input. No affordance takes a key, a seed, a
 * regime, a modal status, a provenance source or a caller DID. Reads take a signed read too
 * (wrd.read_records, wrd.read_calibration); the GET read model answers only when the operator
 * opens reads.
 *
 * `wrdDemoAffordances` holds the one demo-only capability (signing with server-held demo
 * persona keys). Only the offline demo composes it; a production bridge neither advertises nor
 * routes it.
 */
import type { IRI } from '@interego/core';
import type { Affordance, AffordanceInput, AffordanceOutput } from '../_shared/affordance-mcp/index.js';
import { payloadSummary, ENVELOPE_INTENTS } from './src/payloads.js';
import type { EnvelopeIntent } from './src/records.js';

const POD_INPUT: AffordanceInput = {
  name: 'pod_url', type: 'string', required: false,
  description: "Pod to read/write; defaults to the bridge's configured pod. Must equal the envelope payload podUrl.",
};

/**
 * The envelope input. Its description carries the payload's every field (from src/payloads.ts),
 * so an agent reading only the manifest or MCP tools/list can build the payload it must sign;
 * wrd.envelope_template serves the full JSON Schema and a template filled from the pod.
 */
const envelope = (intent: EnvelopeIntent, name = 'envelope', required = true): AffordanceInput => ({
  name, type: 'object', required,
  description: `{payload, signature}: EIP-191 personal_sign over canonicalJson(payload); payload.intent = "${intent}". Every payload also carries podUrl, issuedAt (ISO-8601, within 15 minutes) and a 16-64 character nonce. ${payloadSummary(intent)}. Full JSON Schema and a filled template: wrd.envelope_template with intent=${intent}.`,
});

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

const RECORDED: AffordanceOutput['properties'] = {
  descriptorUrl: { type: 'string', description: 'The new version of the record on the pod.' },
  recordId: { type: 'string' },
  status: { type: 'string' },
  recorded: { type: 'boolean' },
};

const READS = [{
  store: '<pod>/.well-known/context-graphs',
  label: 'The manifest of wrd records on the pod (only versions signed by a platform key this bridge trusts count)',
  populatedBy: 'urn:iep:action:wrd:capture-workflow',
}] as const;

const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const READ_ENVELOPE: AffordanceInput = {
  name: 'envelope', type: 'object', required: true,
  description: `{payload, signature}: EIP-191 personal_sign over canonicalJson(payload); payload = {intent: "wrd:read-records", podUrl, issuedAt (ISO-8601, within 15 minutes), nonce (16-64 characters)}. Signed by an admin or a key in the pod's registry. A read spends no nonce: the same envelope reads again (records or calibration) until issuedAt leaves the window. Template: wrd.envelope_template with intent=wrd:read-records.`,
};
const LIST_INPUTS: AffordanceInput[] = [
  POD_INPUT,
  { name: 'kind', type: 'string', required: false, description: 'Only one section.', enum: ['registry', 'workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants', 'runs'] },
  { name: 'subject', type: 'string', required: false, description: 'Only records about this entity IRI.' },
  { name: 'workflow', type: 'string', required: false, description: 'Only records of this workflow IRI.' },
];
const LIST_OUTPUTS: AffordanceOutput = {
  description: 'The read model; complete is false when the manifest could not be read in full.',
  properties: { podUrl: { type: 'string' }, complete: { type: 'boolean' }, status: { type: 'string' }, readExposure: { type: 'string' }, vocabulary: { type: 'object' }, registry: { type: 'object' }, workflows: { type: 'array' }, tasks: { type: 'array' }, plans: { type: 'array' }, valuations: { type: 'array' }, decisions: { type: 'array' }, grants: { type: 'array' }, runs: { type: 'array' }, untrusted: { type: 'array' } },
  required: ['podUrl', 'complete', 'status'],
};
const CALIBRATION_INPUTS: AffordanceInput[] = [
  POD_INPUT,
  { name: 'kind', type: 'string', required: false, description: 'Only one section.', enum: ['predictions', 'agents', 'probes'] },
];
const CALIBRATION_OUTPUTS: AffordanceOutput = {
  description: 'Prediction cells, agent cells and probe signals; cells built on demo records are labelled.',
  properties: { podUrl: { type: 'string' }, status: { type: 'string' }, computed: { type: 'boolean' }, predictionCells: { type: 'array' }, agentCells: { type: 'array' }, probeSignals: { type: 'object' }, awaitingAPerson: { type: 'array' } },
  required: ['podUrl', 'status'],
};
const LIST_DESCRIPTION = 'Read model of every trusted wrd record on the pod: the vocabulary and published policy, the registry, workflows, tasks (with ratifications, classifications and their status), plans, valuations, decisions with their chains, grants, runs, and records set aside as untrusted, forked or altered.';
const CALIBRATION_DESCRIPTION = 'How well valued decisions predicted their measured outcomes (band coverage against the nominal 0.8, Brier and ordinal distance, per metric, level and whether there was a comparison group), how well each agent judged its own runs against person reviews, and probe signals reported apart.';


export const wrdAffordances: ReadonlyArray<Affordance> = [
  {
    action: 'urn:iep:action:wrd:update-registry' as IRI,
    toolName: 'wrd.update_registry',
    targetTemplate: '{base}/wrd/update_registry',
    title: 'Update the role registry',
    description: 'Admin-signed change to the pod\'s role registry: who holds which role (approver, operator, worker, agent), the person reference an admin attests is behind each key, each agent\'s accountable principal and declared model, the task kinds work may be filed under, and a pod policy that may only tighten the published policy.',
    method: 'POST',
    annotations: { title: 'Update the role registry', ...WRITE },
    inputs: [envelope('wrd:update-registry'), POD_INPUT],
    outputs: {
      description: 'The registry after the change.',
      properties: { registryIri: { type: 'string' }, members: { type: 'array' }, taskKinds: { type: 'array' }, podPolicy: { type: 'object' }, replacedUntrusted: { type: 'boolean' }, graphDigest: { type: 'string' }, ...RECORDED },
      required: ['registryIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:task-map-packet' as IRI,
    toolName: 'wrd.task_map_packet',
    targetTemplate: '{base}/wrd/task_map_packet',
    title: 'Get instructions for drafting a task map',
    description: 'Client-required packet: instructions your own AI agent follows to draft a task map from an SOP or document, citing verbatim quotes the platform will check. This bridge samples no model and writes nothing.',
    method: 'POST',
    annotations: { title: 'Task map drafting packet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'document_title', type: 'string', required: true, description: 'Title of the SOP or document.' },
      { name: 'document_text', type: 'string', required: true, description: 'The document text (at most 200 000 characters).' },
      { name: 'workflow_title', type: 'string', required: false, description: 'Suggested title for the workflow.' },
      POD_INPUT,
    ],
    outputs: {
      description: 'execution "client-required", sampling_performed false, writes_performed false, the instructions, the quote rule, the document and a draft template.',
      properties: { execution: { type: 'string' }, sampling_performed: { type: 'boolean' }, writes_performed: { type: 'boolean' }, instructions: { type: 'string' }, quoteRule: { type: 'object' }, draftTemplate: { type: 'object' }, next: { type: 'object' } },
      required: ['execution', 'instructions'],
    },
  },
  {
    action: 'urn:iep:action:wrd:record-task-map' as IRI,
    toolName: 'wrd.record_task_map',
    targetTemplate: '{base}/wrd/record_task_map',
    title: 'Record a task map drafted from a document',
    description: 'Record a workflow and its tasks from a reviewed draft. Every task cites quotes the platform checks against the document after the published normalisation; unverifiable quotes are flagged, never repaired. The draft declares who drafted it. Refused (422) when no quote appears in the document.',
    method: 'POST',
    annotations: { title: 'Record a task map', ...WRITE },
    inputs: [
      envelope('wrd:record-task-map'),
      { name: 'document_text', type: 'string', required: true, description: 'The document the quotes come from; its sha256 must equal payload.document.sha256.' },
      POD_INPUT,
    ],
    outputs: {
      description: 'The workflow and each task with its quote status and a link for the people named on it.',
      properties: { workflowIri: { type: 'string' }, taskIris: { type: 'array', items: { type: 'string' } }, tasks: { type: 'array' }, quotes: { type: 'object' }, ...RECORDED },
      required: ['workflowIri', 'tasks'],
    },
  },
  {
    action: 'urn:iep:action:wrd:capture-workflow' as IRI,
    toolName: 'wrd.capture_workflow',
    targetTemplate: '{base}/wrd/capture_workflow',
    title: 'Capture a workflow by hand',
    description: 'Record a workflow and its tasks as an operator describes them: who does each task today (a registered person, a registered agent, or both), at which allocation level, under which registered task kind.',
    method: 'POST',
    annotations: { title: 'Capture a workflow', ...WRITE },
    inputs: [envelope('wrd:capture-workflow'), POD_INPUT],
    outputs: {
      description: 'The workflow and each task with a link for the people named on it.',
      properties: { workflowIri: { type: 'string' }, taskIris: { type: 'array', items: { type: 'string' } }, tasks: { type: 'array' }, ...RECORDED },
      required: ['workflowIri', 'tasks'],
    },
  },
  {
    action: 'urn:iep:action:wrd:revise-task' as IRI,
    toolName: 'wrd.revise_task',
    targetTemplate: '{base}/wrd/revise_task',
    title: 'Revise, add or retire a task',
    description: 'Revise a task description (an operator or anyone named on the task; the revision carries the disputes it answers), add a task to a workflow, or retire one (operator). Every write binds the head the signer read.',
    method: 'POST',
    annotations: { title: 'Revise a task', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputs: [
      envelope('wrd:revise-task'),
      { name: 'document_text', type: 'string', required: false, description: "Only with new sourceQuotes: the workflow's document, whose sha256 must match the one recorded." },
      POD_INPUT,
    ],
    outputs: {
      description: 'The new task version, and the workflow version for add and retire.',
      properties: { op: { type: 'string' }, taskIri: { type: 'string' }, workflowIri: { type: 'string' }, answeredDisputes: { type: 'array' }, graphDigest: { type: 'string' }, workflowDescriptorUrl: { type: 'string' }, ...RECORDED },
      required: ['op', 'taskIri'],
    },
  },
  {
    action: 'urn:iep:action:wrd:ratify-task' as IRI,
    toolName: 'wrd.ratify_task',
    targetTemplate: '{base}/wrd/ratify_task',
    title: 'Ratify or dispute a task, its classification, or an assignment',
    description: "A person or agent named on a task ratifies or disputes its description or its classification (a dispute may carry the party's own answers); a person a plan names to decide, audit or perform acknowledges or objects to that assignment. The signature binds the head read.",
    method: 'POST',
    annotations: { title: 'Ratify or dispute', ...WRITE },
    inputs: [envelope('wrd:ratify-task'), POD_INPUT],
    outputs: {
      description: 'The status after the verdict; changed is false when the party had already given the same verdict.',
      properties: { subject: { type: 'string' }, taskIri: { type: 'string' }, changed: { type: 'boolean' }, graphDigest: { type: 'string' }, ...RECORDED },
      required: ['subject', 'taskIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:classify-task' as IRI,
    toolName: 'wrd.classify_task',
    targetTemplate: '{base}/wrd/classify_task',
    title: 'Classify how knowable a task is',
    description: 'Place a task in a regime (Evident, Knowable, Emergent, Turbulent) by the published decision table over seven signed evidence answers, including whether a reviewer can check the output and how soon feedback arrives. The regime picks the method and limits what changes are allowed. Refused (400) when the answers place nothing; there is no default regime.',
    method: 'POST',
    annotations: { title: 'Classify a task', ...WRITE },
    inputs: [envelope('wrd:classify-task'), POD_INPUT],
    outputs: {
      description: 'The regime, the method it routes to, the published rules that fired, notes, the levels permitted, and who answered.',
      properties: { taskIri: { type: 'string' }, classificationIri: { type: 'string' }, regime: { type: 'string' }, method: { type: 'string' }, regimeSource: { type: 'string' }, rulesFired: { type: 'array', items: { type: 'string' } }, notes: { type: 'array' }, permittedLevels: { type: 'array' }, answeredBy: { type: 'object' }, ...RECORDED },
      required: ['taskIri', 'regime', 'method'],
    },
  },
  {
    action: 'urn:iep:action:wrd:propose-allocation' as IRI,
    toolName: 'wrd.propose_allocation',
    targetTemplate: '{base}/wrd/propose_allocation',
    title: 'Propose who does each task',
    description: 'Propose a person, an agent, or both for tasks of a workflow, at a level the task\'s regime permits. Refused (409) until every task of the workflow is classified; Turbulent work does not change; Emergent work changes only as 1 to 5 safe-to-fail probes in a probe-only plan; an agent acting within a grant needs an active, earned grant.',
    method: 'POST',
    annotations: { title: 'Propose an allocation', ...WRITE },
    inputs: [envelope('wrd:propose-allocation'), POD_INPUT],
    outputs: {
      description: 'The plan: every task with its current and proposed allocation, the plan kind (valued or probe), and the people it names.',
      properties: { planIri: { type: 'string' }, workflowIri: { type: 'string' }, planKind: { type: 'string' }, tasks: { type: 'array' }, changedTasks: { type: 'array' }, assignments: { type: 'array' }, ...RECORDED },
      required: ['planIri', 'planKind'],
    },
  },
  {
    action: 'urn:iep:action:wrd:value-plan' as IRI,
    toolName: 'wrd.value_plan',
    targetTemplate: '{base}/wrd/value_plan',
    title: 'Value a plan with honest ranges',
    description: 'Seeded Monte Carlo over low/likely/high inputs, each stating where it came from: P10/P50/P90 for the weekly cash change (freed hours count only where the work is left unfilled) and for the change if freed hours are redeployed, NPV with ramp and discounting, payback, sensitivity, a cost breakdown, freed person-hours and pilot size. Probe plans are not valued: they are submitted as probe decisions.',
    method: 'POST',
    annotations: { title: 'Value a plan', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [envelope('wrd:value-plan'), POD_INPUT],
    outputs: {
      description: 'The valuation record; the same plan and inputs return the existing record (reused true).',
      properties: { valuationIri: { type: 'string' }, planIri: { type: 'string' }, valuationHash: { type: 'string' }, seed: { type: 'string' }, draws: { type: 'integer' }, result: { type: 'object' }, expertEvidence: { type: 'array' }, unratifiedTasks: { type: 'array' }, reused: { type: 'boolean' }, ...RECORDED },
      required: ['valuationIri', 'valuationHash', 'result'],
    },
  },
  {
    action: 'urn:iep:action:wrd:submit-decision' as IRI,
    toolName: 'wrd.submit_decision',
    targetTemplate: '{base}/wrd/submit_decision',
    title: 'Submit a decision for countersignature',
    description: 'Submit a plan (with its valuation and measurement plan, or as a probe decision) as a Hypothetical decision. Every changed task must be ratified by everyone named on it. Returns exactly what a countersigner signs.',
    method: 'POST',
    annotations: { title: 'Submit a decision', ...WRITE },
    inputs: [envelope('wrd:submit-decision'), POD_INPUT],
    outputs: {
      description: 'The submitted decision, its prediction band (valued) or probes, and the binding a countersigner signs.',
      properties: { decisionIri: { type: 'string' }, decisionKind: { type: 'string' }, graphDigest: { type: 'string' }, prediction: { type: 'object' }, probes: { type: 'array' }, decisionLevel: { type: 'string' }, subjects: { type: 'array' }, assignments: { type: 'array' }, basisLabel: { type: 'string' }, ...RECORDED },
      required: ['decisionIri', 'recordId', 'descriptorUrl', 'graphDigest'],
    },
  },
  {
    action: 'urn:iep:action:wrd:countersign-decision' as IRI,
    toolName: 'wrd.countersign_decision',
    targetTemplate: '{base}/wrd/countersign_decision',
    title: 'Countersign or decline a decision',
    description: 'A registered approver approves or declines. Compared by the person an admin attests is behind each key, the approver did not propose, value or submit the plan, is not a person whose work it changes, and is not the accountable principal of an agent it puts on the work. Approval re-checks that every changed task is still ratified and undisputed, names every objection and every assignment not yet acknowledged that it approves over, and is refused while another approved, unmeasured decision changes the same task. Approved decisions become Asserted with the prediction still unmeasured; declined ones Counterfactual.',
    method: 'POST',
    annotations: { title: 'Countersign a decision', ...WRITE },
    inputs: [envelope('wrd:countersign-decision'), POD_INPUT],
    outputs: {
      description: 'The decision after the verdict.',
      properties: { decisionIri: { type: 'string' }, statusLabel: { type: 'string' }, graphDigest: { type: 'string' }, countersignedBy: { type: 'object' }, assignments: { type: 'array' }, grantChecks: { type: 'array' }, ...RECORDED },
      required: ['decisionIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:record-outcome' as IRI,
    toolName: 'wrd.record_outcome',
    targetTemplate: '{base}/wrd/record_outcome',
    title: 'Record the measured outcome of a decision',
    description: 'After the measurement window has ended, someone who neither prepared (proposed, valued, submitted) nor countersigned the decision records the measured weekly change (optionally with an interval), its comparison basis, and whether the change was kept, reverted or stopped early. A kept change is measured over the whole declared window; a shorter window is recorded only for a change stopped early or reverted, and stays out of calibration. The platform grades it against the predicted band scaled for the declared ramp, and checks the pilot size against the person-reviewed runs logged in the window. Probe decisions record which declared condition fired for each probe.',
    method: 'POST',
    annotations: { title: 'Record an outcome', ...WRITE },
    inputs: [envelope('wrd:record-outcome'), POD_INPUT],
    outputs: {
      description: 'The measured decision with its verdict, or each probe\'s signal.',
      properties: { decisionIri: { type: 'string' }, disposition: { type: 'string' }, valued: { type: 'object' }, probes: { type: 'array' }, next: { type: 'string' }, ...RECORDED },
      required: ['decisionIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:log-agent-run' as IRI,
    toolName: 'wrd.log_agent_run',
    targetTemplate: '{base}/wrd/log_agent_run',
    title: "Log an agent's run, with a person's review",
    description: "A registered agent signs a run (task, model, output digest, its own assessment); a person who is not its accountable principal signs a review. Only person-reviewed runs count toward calibration and grants. A run under an active grant may be logged first and reviewed later with the stored run envelope, but only a run the agent itself calls accepted, on a task that an approved decision put at agent-acts-within-grant for this agent and whose regime, checkability and worst case still allow it; any other run goes to a person.",
    method: 'POST',
    annotations: { title: 'Log an agent run', ...WRITE },
    inputs: [
      envelope('wrd:agent-run', 'run_envelope'),
      envelope('wrd:review-agent-run', 'review_envelope', false),
      POD_INPUT,
    ],
    outputs: {
      description: 'The run record and whether it counts toward calibration.',
      properties: { runIri: { type: 'string' }, verdict: { type: 'string' }, countsTowardCalibration: { type: 'boolean' }, ...RECORDED },
      required: ['runIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:grant-autonomy' as IRI,
    toolName: 'wrd.grant_autonomy',
    targetTemplate: '{base}/wrd/grant_autonomy',
    title: 'Grant an agent autonomy on one kind of task',
    description: 'An approver grants a registered software agent the right to act alone on one registered kind of task, only when earned: at least 20 person-reviewed runs on its currently declared model, of which a person accepted at least 90%; at least 5 distinct registered reviewers the admin attests are different people; and at least 20 runs the agent itself called ready, of which a person accepted at least 90% with no critical failure. People are never given enforced grants.',
    method: 'POST',
    annotations: { title: 'Grant autonomy', ...WRITE },
    inputs: [envelope('wrd:grant-autonomy'), POD_INPUT],
    outputs: {
      description: 'The grant and the evaluation it rests on.',
      properties: { grantIri: { type: 'string' }, agentAddress: { type: 'string' }, principal: { type: 'string' }, model: { type: 'string' }, taskKind: { type: 'string' }, evaluation: { type: 'object' }, ...RECORDED },
      required: ['grantIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:revoke-grant' as IRI,
    toolName: 'wrd.revoke_grant',
    targetTemplate: '{base}/wrd/revoke_grant',
    title: 'Revoke a grant',
    description: 'An approver withdraws a grant: a superseding Retracted record whose validity window ends now, binding the grant head read (recordId, descriptorUrl, graphDigest). Every later use of the grant is refused, and work a decision put under it shows as having no authorised performer.',
    method: 'POST',
    annotations: { title: 'Revoke a grant', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputs: [envelope('wrd:revoke-grant'), POD_INPUT],
    outputs: {
      description: 'The revoked grant.',
      properties: { grantIri: { type: 'string' }, revokedAt: { type: 'string' }, why: { type: 'string' }, ...RECORDED },
      required: ['grantIri', 'status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:holder-copy' as IRI,
    toolName: 'wrd.holder_copy',
    targetTemplate: '{base}/wrd/holder_copy',
    title: 'Take a copy of every record about your work',
    description: 'Anyone named in or signing a record pulls a copy of every record describing their work or carrying their signature: to a pod they name (each copy keeps the original platform proof, so it verifies there), or as a download.',
    method: 'POST',
    annotations: { title: 'Take a copy of my record', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [envelope('wrd:holder-copy'), POD_INPUT],
    outputs: {
      description: 'What was copied (or exported) and the bundle itself.',
      properties: { holder: { type: 'object' }, targetPodUrl: { type: 'string' }, copied: { type: 'array' }, bundle: { type: 'array' }, receiptUrl: { type: 'string' }, ...RECORDED },
      required: ['holder', 'status', 'bundle'],
    },
  },
  {
    action: 'urn:iep:action:wrd:envelope-template' as IRI,
    toolName: 'wrd.envelope_template',
    targetTemplate: '{base}/wrd/envelope_template',
    title: 'Get the payload to sign for a write',
    description: 'For one write intent (or wrd:read-records): the JSON Schema of its payload, and a template — podUrl, a fresh issuedAt and nonce, and, when you name the record, the head binding (descriptorUrl, graphDigest, recordId). Fields left for you to decide are null and listed in fill. Sent with read_envelope (a signed wrd:read-records envelope from an admin or a registered key), or when the operator opened reads, it also fills what the pod knows (for a valuation, one entry per task the plan changes; for a decision, its valuation; for an outcome, the declared window) and the context it read. Otherwise it fills only the intent, the pod, issuedAt, nonce, the IRIs you named and the head binding, and nothing read out of a record. Signs nothing and writes nothing.',
    method: 'GET',
    annotations: { title: 'Payload template', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    reads: READS,
    inputs: [
      { name: 'intent', type: 'string', required: true, description: 'The write intent.', enum: [...ENVELOPE_INTENTS] },
      POD_INPUT,
      { name: 'task_iri', type: 'string', required: false, description: 'The task the payload is about (ratify, classify, revise, agent-run).' },
      { name: 'workflow_iri', type: 'string', required: false, description: 'The workflow (propose, add a task).' },
      { name: 'plan_iri', type: 'string', required: false, description: 'The plan (value, submit, acknowledge an assignment).' },
      { name: 'decision_iri', type: 'string', required: false, description: 'The decision (countersign, record an outcome).' },
      { name: 'grant_iri', type: 'string', required: false, description: 'The grant (revoke).' },
      { name: 'subject', type: 'string', required: false, description: 'For wrd:ratify-task: what is ratified.', enum: ['description', 'classification', 'assignment'] },
      { name: 'read_envelope', type: 'object', required: false, description: 'Optional signed read: the wrd:read-records envelope wrd.read_records takes ({payload, signature}, or its JSON text in a GET query), from an admin or a key in the pod\'s registry. Valid, it fills the whole template and its context; refused (401, 403) like the read itself otherwise.' },
    ],
    outputs: {
      description: 'The schema, the template, the paths still to fill, the tool to send it to, and the context read from the pod.',
      properties: { intent: { type: 'string' }, toolName: { type: 'string' }, schema: { type: 'object' }, template: { type: 'object' }, fill: { type: 'array', items: { type: 'string' } }, context: { type: 'object' }, signing: { type: 'string' }, status: { type: 'string' }, computed: { type: 'boolean' } },
      required: ['intent', 'schema', 'template', 'fill'],
    },
  },
  {
    action: 'urn:iep:action:wrd:list-records' as IRI,
    toolName: 'wrd.list_records',
    targetTemplate: '{base}/wrd/list_records',
    title: 'List the records on a pod (unsigned, when the operator opens reads)',
    description: `${LIST_DESCRIPTION} Answers 401 unless the operator opened reads to anyone (WRD_PUBLIC_READS=1); otherwise read with wrd.read_records.`,
    method: 'GET',
    annotations: { title: 'List records', ...READ_ANNOTATIONS },
    reads: READS,
    inputs: LIST_INPUTS,
    outputs: LIST_OUTPUTS,
  },
  {
    action: 'urn:iep:action:wrd:calibration' as IRI,
    toolName: 'wrd.calibration',
    targetTemplate: '{base}/wrd/calibration',
    title: 'Calibration of predictions and agents (unsigned, when the operator opens reads)',
    description: `${CALIBRATION_DESCRIPTION} Answers 401 unless the operator opened reads to anyone (WRD_PUBLIC_READS=1); otherwise read with wrd.read_calibration.`,
    method: 'GET',
    annotations: { title: 'Calibration', ...READ_ANNOTATIONS },
    reads: READS,
    inputs: CALIBRATION_INPUTS,
    outputs: CALIBRATION_OUTPUTS,
  },
  {
    action: 'urn:iep:action:wrd:read-records' as IRI,
    toolName: 'wrd.read_records',
    targetTemplate: '{base}/wrd/read_records',
    title: 'Read the records on a pod (signed read)',
    description: `${LIST_DESCRIPTION} For an admin or a key in the pod's registry, by a signed read; anyone else is refused (403).`,
    method: 'POST',
    annotations: { title: 'Read records', ...READ_ANNOTATIONS },
    reads: READS,
    inputs: [READ_ENVELOPE, ...LIST_INPUTS],
    outputs: LIST_OUTPUTS,
  },
  {
    action: 'urn:iep:action:wrd:read-calibration' as IRI,
    toolName: 'wrd.read_calibration',
    targetTemplate: '{base}/wrd/read_calibration',
    title: 'Read the calibration of predictions and agents (signed read)',
    description: `${CALIBRATION_DESCRIPTION} For an admin or a key in the pod's registry, by the same signed read as wrd.read_records; anyone else is refused (403).`,
    method: 'POST',
    annotations: { title: 'Read calibration', ...READ_ANNOTATIONS },
    reads: READS,
    inputs: [READ_ENVELOPE, ...CALIBRATION_INPUTS],
    outputs: CALIBRATION_OUTPUTS,
  },
];

/** Demo only: sign a payload with a server-held persona key. Never composed by a production bridge. */
export const wrdDemoAffordances: ReadonlyArray<Affordance> = [
  {
    action: 'urn:iep:action:wrd:demo-envelope' as IRI,
    toolName: 'wrd.demo_envelope',
    targetTemplate: '{base}/wrd/demo_envelope',
    title: 'Sign as a demo persona (demo only)',
    description: 'Offline demo only: signs a payload with a key the demo server generated for a named persona. These are not signatures by real people, and every record written while the demo runs says it is scripted. Without a persona it lists the personas.',
    method: 'POST',
    annotations: { title: 'Demo signing', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputs: [
      { name: 'persona', type: 'string', required: false, description: 'The demo persona id; omit it to list the personas.' },
      { name: 'payload', type: 'object', required: false, description: 'The envelope payload to sign; issuedAt and nonce are filled when absent. Required with persona.' },
    ],
    outputs: {
      description: 'The signed envelope and who it was signed as, or (without a persona) the personas.',
      properties: { envelope: { type: 'object' }, signer: { type: 'string' }, persona: { type: 'string' }, label: { type: 'string' }, personas: { type: 'array' }, demoKey: { type: 'boolean' }, scriptedLabel: { type: 'string' }, status: { type: 'string' } },
      required: ['status'],
    },
  },
  {
    action: 'urn:iep:action:wrd:demo-advance-clock' as IRI,
    toolName: 'wrd.demo_advance_clock',
    targetTemplate: '{base}/wrd/demo_advance_clock',
    title: 'Move the demo clock forward (demo only)',
    description: "Offline demo only: moves the demo server's scripted clock forward, so a measurement window a visitor's own decision declares can end and its outcome be recorded. Production bridges read the real clock and neither advertise nor route this.",
    method: 'POST',
    annotations: { title: 'Advance the demo clock', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputs: [{ name: 'weeks', type: 'integer', required: true, description: 'Whole weeks to move forward, 1 to 104.', minimum: 1, maximum: 104 }],
    outputs: {
      description: 'The demo clock after the move.',
      properties: { now: { type: 'string' }, movedWeeks: { type: 'integer' }, scriptedLabel: { type: 'string' }, status: { type: 'string' }, recorded: { type: 'boolean' } },
      required: ['now'],
    },
  },
];
