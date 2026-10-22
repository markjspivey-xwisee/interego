/**
 * What each signed envelope's payload must hold, published.
 *
 * Every write takes one input, `envelope: {payload, signature}`, and the affordance input types
 * cannot describe what is inside it. Without this an agent walking the manifest could not build
 * a single valid payload: it would learn the fields one signed refusal at a time. So the payload
 * of every intent is declared here once, as JSON Schema, and the same declaration is
 *   - summarised into each affordance's envelope description (so MCP tools/list and the
 *     manifest carry it),
 *   - served whole, with a template filled from the pod, by wrd.envelope_template, and
 *   - attached to every 400 a malformed payload gets, as `expectedPayload`.
 *
 * The handlers remain the authority: a schema states the shape, the handler checks it and
 * everything that depends on the pod. Pure: no environment reads, no network, no clock.
 */
import {
  ALLOCATION_LEVELS, COMPARISON_BASES, FREED_HOURS_DISPOSITIONS, INPUT_BASES, OUTCOME_DISPOSITIONS, OUTCOME_METRICS,
  PROBE_SIGNALS, REGISTRY_ROLES,
} from './ontology.js';
import { CLASSIFICATION_QUESTIONS, LIMITS } from './work.js';
import { MAX_INPUT, RUN_ALTERNATIVES, STATE_FIELDS } from './valuation.js';
import type { EnvelopeIntent } from './records.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

const text = (description: string, maxLength?: number): JsonSchema => ({ type: 'string', description, ...(maxLength ? { maxLength } : {}) });
const oneOf = (values: readonly string[], description: string): JsonSchema => ({ type: 'string', enum: [...values], description });
const obj = (properties: Record<string, JsonSchema>, required: readonly string[], description?: string): JsonSchema =>
  ({ type: 'object', properties, required: [...required], additionalProperties: false, ...(description ? { description } : {}) });
const list = (items: JsonSchema, min: number, max: number, description?: string): JsonSchema =>
  ({ type: 'array', items, minItems: min, maxItems: max, ...(description ? { description } : {}) });
const keyed = (values: JsonSchema, description: string): JsonSchema => ({ type: 'object', additionalProperties: values, description });

const ENTITY_IRI = '^urn:wrd:[a-z-]+:[0-9a-f]{16}:[0-9a-f]{16}$';
const iriOf = (what: string): JsonSchema => ({ type: 'string', pattern: ENTITY_IRI, description: `the ${what} IRI (urn:wrd:…), from wrd.read_records` });
const ADDRESS: JsonSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'a 0x address registered on the pod' };
const HEX64: JsonSchema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const HEAD = {
  descriptorUrl: text('the head you read: its descriptorUrl, from wrd.read_records'),
  graphDigest: { type: 'string', pattern: '^graph-nquads-sha256:[0-9a-f]{64}$', description: 'the head you read: its graphDigest, from wrd.read_records' },
} as const;
const RECORD_ID = text('the head you read: its recordId, from wrd.read_records');
const NOTE = text('free text', LIMITS.note);

const COMMON: Record<string, JsonSchema> = {
  podUrl: text('the pod this call targets (normalised with a trailing slash); the signature binds it'),
  issuedAt: text('ISO-8601 date-time with seconds and a zone; accepted from 15 minutes before to 2 minutes after the bridge clock'),
  nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$', description: 'fresh for every envelope; a reused (signer, nonce) is refused' },
};

const TRI = (rate: boolean): JsonSchema => ({ title: rate ? 'Rate' : 'Tri', ...obj({
  low: { type: 'number', minimum: 0, maximum: rate ? 1 : MAX_INPUT },
  likely: { type: 'number', minimum: 0, maximum: rate ? 1 : MAX_INPUT },
  high: { type: 'number', minimum: 0, maximum: rate ? 1 : MAX_INPUT },
  basis: oneOf(INPUT_BASES, "where the number came from; 'not-applicable' only as 0/0/0 inside a task state; 'measured' on a proposed state needs a source"),
  note: text('', 300),
  source: text('absolute IRI of the runs, outcome, pilot or document it came from'),
}, ['low', 'likely', 'high', 'basis'], rate ? 'a rate in [0, 1]: low <= likely <= high' : 'low <= likely <= high') });
const RATE_FIELDS: ReadonlySet<string> = new Set(['minorFailureRate', 'criticalFailureRate']);
const STATE: JsonSchema = {
  title: 'TaskState',
  ...obj(Object.fromEntries(STATE_FIELDS.map((f) => [f, TRI(RATE_FIELDS.has(f))])), STATE_FIELDS,
    'one way of doing the task, per run: performer hours, oversight hours (a person deciding on or auditing an agent), agent cost, failure rates and costs'),
};

const ANSWERS: JsonSchema = obj(Object.fromEntries(CLASSIFICATION_QUESTIONS.map((q) => [q.id, oneOf(q.options, q.text)])), CLASSIFICATION_QUESTIONS.map((q) => q.id));

const CAPTURE_TASK = (withQuotes: boolean): JsonSchema => obj({
  name: text('verb first', LIMITS.taskName),
  description: text('', LIMITS.taskDescription),
  currentLevel: oneOf(ALLOCATION_LEVELS.filter((l) => l !== 'agent-acts-within-grant'), 'who does it today (within-grant work only comes from a decision)'),
  personAddress: ADDRESS,
  agentAddress: ADDRESS,
  taskKind: text('a task kind slug registered on the pod'),
  externalTaskTerm: text('optional absolute IRI of a published task statement'),
  ...(withQuotes ? { sourceQuotes: list(text('copied exactly from the document, at least 12 characters', LIMITS.quoteChars), 1, LIMITS.quotesPerTask) } : {}),
}, ['name', 'description', 'currentLevel', 'taskKind', ...(withQuotes ? ['sourceQuotes'] : [])]);

const WORKFLOW = obj({ title: text('', LIMITS.workflowTitle), unitLabel: text('what one unit of this work is called, e.g. invoice', LIMITS.unitLabel), description: text('', LIMITS.workflowDescription) }, ['title', 'unitLabel']);

const PROBE = obj({
  hypothesis: text('', 500), amplifyIf: text('', 500), dampenIf: text('', 500), timeboxWeeks: { type: 'integer', minimum: 1, maximum: 26 },
}, ['hypothesis', 'amplifyIf', 'dampenIf', 'timeboxWeeks']);

const VALUATION_INPUTS: JsonSchema = obj({
  currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  unitsPerWeek: obj({ current: TRI(false), proposed: TRI(false) }, ['current']),
  valuePerUnit: TRI(false), hourlyCost: TRI(false), oneOffCost: TRI(false),
  horizonMonths: { type: 'integer', minimum: 1, maximum: 120 },
  rampMonths: { type: 'number', minimum: 0, maximum: 60 },
  annualDiscountRate: { type: 'number', minimum: 0, maximum: 1 },
  criticalFailureCeiling: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
  freedHours: keyed(obj({ disposition: oneOf(FREED_HOURS_DISPOSITIONS, ''), note: text('', 300) }, ['disposition']), 'keyed by the IRI of EVERY changed task'),
  tasks: keyed(obj({ runsPerUnit: TRI(false), hourlyCost: TRI(false), current: STATE, proposed: STATE }, ['runsPerUnit', 'current']),
    'keyed by task IRI: every changed task with current AND proposed (oversight costed where a person decides or audits); unchanged tasks without proposed, required for all when unitsPerWeek.proposed is given'),
}, ['currency', 'unitsPerWeek', 'valuePerUnit', 'hourlyCost', 'oneOffCost', 'horizonMonths', 'rampMonths', 'annualDiscountRate', 'criticalFailureCeiling', 'freedHours', 'tasks']);

const WINDOW = { windowStart: text('ISO-8601; at or after the countersign'), windowEnd: text('ISO-8601; ended, and at least measurementPlan.windowWeeks after windowStart unless stopped early or reverted') };

const FIELDS: Readonly<Record<EnvelopeIntent, { readonly properties: Record<string, JsonSchema>; readonly required: readonly string[]; readonly description: string }>> = {
  'wrd:update-registry': {
    description: 'Admin only. At least one of entries, taskKinds, podPolicy.',
    properties: {
      entries: list(obj({
        address: ADDRESS, roles: list(oneOf(REGISTRY_ROLES, ''), 0, 4, 'empty removes the address'), label: text('', 80), softwareAgent: { type: 'boolean' },
        personRef: text("people only: the admin's stable reference for the person behind this key", 80),
        principal: { ...ADDRESS, description: 'agents only: the registered person accountable for the agent' }, model: text('agents only: the model the agent runs on', 120),
      }, ['address', 'roles']), 0, 50),
      taskKinds: list(obj({ slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' }, label: text('', 80), definition: text('one sentence', 300), retire: { type: 'boolean', enum: [true] } }, ['slug']), 0, 100),
      podPolicy: { type: ['object', 'null'], description: 'tightens the published policy: maxLevel, floor, minSamples, minHumanConfirmations, minDistinctConfirmers; null clears' },
    },
    required: [],
  },
  'wrd:capture-workflow': { description: 'A registered operator or agent.', properties: { workflow: WORKFLOW, tasks: list(CAPTURE_TASK(false), 1, LIMITS.tasks) }, required: ['workflow', 'tasks'] },
  'wrd:record-task-map': {
    description: 'A registered operator or agent; send document_text beside the envelope.',
    properties: {
      workflow: WORKFLOW, tasks: list(CAPTURE_TASK(true), 1, LIMITS.tasks),
      document: obj({ title: text('', LIMITS.documentTitle), sha256: { ...HEX64, description: 'sha256 of document_text' }, storeText: { type: 'boolean' } }, ['title', 'sha256', 'storeText']),
      draftedBy: obj({ kind: oneOf(['person', 'agent', 'not-declared'], ''), agent: text('', 120), model: text('', 120) }, ['kind']),
      draftSha256: HEX64,
    },
    required: ['workflow', 'tasks', 'document', 'draftedBy'],
  },
  'wrd:revise-task': {
    description: "op revise (an operator or someone named on the task; null removes a party, and a removed party must ratify the revision), add (operator; binds the workflow head) or retire (operator). Send document_text only with new sourceQuotes.",
    properties: {
      op: oneOf(['revise', 'add', 'retire'], ''), taskIri: iriOf('task (revise, retire)'), workflowIri: iriOf('workflow (add)'), ...HEAD,
      name: text('', LIMITS.taskName), description: text('', LIMITS.taskDescription), currentLevel: oneOf(ALLOCATION_LEVELS, ''),
      personAddress: { type: ['string', 'null'], description: 'a 0x address, or null to remove' }, agentAddress: { type: ['string', 'null'], description: 'a 0x address, or null to remove' },
      taskKind: text(''), externalTaskTerm: text(''), sourceQuotes: list(text('', LIMITS.quoteChars), 1, LIMITS.quotesPerTask),
      task: CAPTURE_TASK(false), note: NOTE, why: text('retire: why', LIMITS.note),
    },
    required: ['op', 'descriptorUrl', 'graphDigest'],
  },
  'wrd:ratify-task': {
    description: 'description/classification: a party named on the task (or owed ratification); assignment: the person the plan names. The head is the task, the classification or the plan you read.',
    properties: {
      subject: oneOf(['description', 'classification', 'assignment'], ''), taskIri: iriOf('task'), ...HEAD,
      verdict: oneOf(['ratify', 'dispute', 'acknowledge', 'object'], 'ratify|dispute for description and classification; acknowledge|object for assignment'),
      note: { ...NOTE, description: 'required with dispute or object' }, answers: { ...ANSWERS, description: 'classification dispute only: your own answers' }, planIri: iriOf('plan (assignment only)'),
    },
    required: ['subject', 'taskIri', 'descriptorUrl', 'graphDigest', 'verdict'],
  },
  'wrd:classify-task': {
    description: "A registered operator or approver, or someone named on the task. taskTextSha256 binds the description the answers are about (the task row's textSha256).",
    properties: { taskIri: iriOf('task'), taskTextSha256: { ...HEX64, description: "the task's textSha256 from wrd.read_records" }, answers: ANSWERS, notes: NOTE },
    required: ['taskIri', 'taskTextSha256', 'answers'],
  },
  'wrd:propose-allocation': {
    description: 'A registered operator (person). Every task of the workflow must be classified; an agent named on a task needs its classification ratified.',
    properties: {
      workflowIri: iriOf('workflow'), title: text('', LIMITS.workflowTitle),
      changes: list(obj({ taskIri: iriOf('task'), proposedLevel: oneOf(ALLOCATION_LEVELS, ''), personAddress: ADDRESS, agentAddress: ADDRESS, probes: list(PROBE, 1, 5, 'Emergent work only') }, ['taskIri', 'proposedLevel']), 1, LIMITS.tasks),
    },
    required: ['workflowIri', 'title', 'changes'],
  },
  'wrd:value-plan': { description: 'A registered operator (person); valued plans only.', properties: { planIri: iriOf('plan'), inputs: VALUATION_INPUTS }, required: ['planIri', 'inputs'] },
  'wrd:submit-decision': {
    description: 'A registered operator (person). Valued plans carry valuationIri, valuationHash and measurementPlan; probe plans none of them.',
    properties: {
      planIri: iriOf('plan'), valuationIri: iriOf('valuation'), valuationHash: { ...HEX64, description: 'as wrd.value_plan returned it' },
      measurementPlan: obj({ metric: oneOf(OUTCOME_METRICS, ''), comparisonBasis: oneOf(COMPARISON_BASES, "before-after is labelled 'no comparison group'"), windowWeeks: { type: 'integer', minimum: 1, maximum: 104 }, comparisonDescription: NOTE }, ['metric', 'comparisonBasis', 'windowWeeks']),
      note: NOTE,
    },
    required: ['planIri'],
  },
  'wrd:countersign-decision': {
    description: 'A registered approver who neither proposed, valued nor submitted the plan, is not a person it changes, and is not the principal of an agent it names. Approval names every current objection and every assignment not yet acknowledged.',
    properties: {
      decisionIri: iriOf('decision'), recordId: RECORD_ID, ...HEAD, verdict: oneOf(['approve', 'decline'], ''),
      objectionsConsidered: list(iriOf('task'), 0, LIMITS.tasks, 'tasks whose named person objected, approved over'),
      unacknowledgedConsidered: list(iriOf('task'), 0, LIMITS.tasks, 'tasks whose named person has not acknowledged, approved over'),
      note: NOTE,
    },
    required: ['decisionIri', 'recordId', 'descriptorUrl', 'graphDigest', 'verdict'],
  },
  'wrd:record-outcome': {
    description: 'A registered operator or approver who neither prepared nor countersigned the decision. Valued decisions carry measured; probe decisions probeResults (one per declared probe).',
    properties: {
      decisionIri: iriOf('decision'), recordId: RECORD_ID, ...HEAD,
      disposition: oneOf(OUTCOME_DISPOSITIONS, ''), dispositionNote: { ...NOTE, description: 'required unless kept' },
      measured: obj({
        weeklyValueDelta: { type: 'number' }, interval: obj({ low: { type: 'number' }, high: { type: 'number' } }, ['low', 'high']),
        comparisonBasis: oneOf(COMPARISON_BASES, ''), ...WINDOW, method: text('', LIMITS.note),
        runsObserved: { type: 'integer', minimum: 0, description: 'declared only; the pilot check counts reviewed runs on the pod' },
        criticalFailuresObserved: { type: 'integer', minimum: 0, description: 'declared only' },
      }, ['weeklyValueDelta', 'comparisonBasis', 'windowStart', 'windowEnd', 'method']),
      probeResults: list(obj({ taskIri: iriOf('task'), index: { type: 'integer', minimum: 1 }, signal: oneOf(PROBE_SIGNALS, ''), observed: text('', LIMITS.note), ...WINDOW }, ['taskIri', 'index', 'signal', 'observed', 'windowStart', 'windowEnd']), 1, 300),
    },
    required: ['decisionIri', 'recordId', 'descriptorUrl', 'graphDigest', 'disposition'],
  },
  'wrd:agent-run': {
    description: 'Signed by the registered agent. A run under a grant (underGrant) must be one the agent calls accepted, on a task a countersigned decision put at agent-acts-within-grant for it; any other run needs review_envelope.',
    properties: {
      runId: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,80}$' }, taskIri: iriOf('task'), taskKind: text("the task's kind"), model: text('the model the registry declares for the agent', 120),
      outputSha256: { ...HEX64, description: "sha256 of the run's output; the output itself is not stored" },
      selfAssessment: obj({ answer: oneOf(RUN_ALTERNATIVES, ''), probabilities: { type: 'object', description: 'optional weights over accepted, reworked, critical-failure' } }, ['answer']),
      underGrant: iriOf('grant'), costPerRun: obj({ amount: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, ['amount', 'currency']),
      performedAt: text('ISO-8601'),
    },
    required: ['runId', 'taskIri', 'taskKind', 'model', 'outputSha256', 'selfAssessment', 'performedAt'],
  },
  'wrd:review-agent-run': {
    description: "A registered operator or approver who is not the agent's principal. runEnvelopeSha256 = sha256(canonicalJson({payload, signature})) of the run envelope.",
    properties: { runEnvelopeSha256: HEX64, verdict: oneOf(RUN_ALTERNATIVES, ''), note: NOTE },
    required: ['runEnvelopeSha256', 'verdict'],
  },
  'wrd:grant-autonomy': { description: "A registered approver who is not the agent's principal.", properties: { agentAddress: ADDRESS, taskKind: text('a registered task kind slug') }, required: ['agentAddress', 'taskKind'] },
  'wrd:revoke-grant': {
    description: 'A registered approver.',
    properties: { grantIri: iriOf('grant'), recordId: RECORD_ID, ...HEAD, why: text('', LIMITS.note) },
    required: ['grantIri', 'recordId', 'descriptorUrl', 'graphDigest', 'why'],
  },
  'wrd:holder-copy': { description: 'Anyone named in or signing a record. Without targetPodUrl the bundle is returned for download.', properties: { targetPodUrl: text('a pod you hold (not this one)') }, required: [] },
  'wrd:read-records': {
    description: 'A signed read: an admin or a key in the pod\'s registry. Send it to wrd.read_records or wrd.read_calibration; it changes nothing, so its nonce is not spent, and the same envelope reads again until issuedAt leaves the window.',
    properties: {},
    required: [],
  },
};

export const ENVELOPE_INTENTS: readonly EnvelopeIntent[] = Object.keys(FIELDS) as EnvelopeIntent[];
export const isEnvelopeIntent = (v: unknown): v is EnvelopeIntent => typeof v === 'string' && (ENVELOPE_INTENTS as readonly string[]).includes(v);

/** The JSON Schema of one intent's payload. */
export function payloadSchema(intent: EnvelopeIntent): JsonSchema {
  const f = FIELDS[intent];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `${intent} payload`,
    description: `${f.description} Sign EIP-191 personal_sign over canonicalJson(payload) (keys sorted recursively, arrays in order) and send {payload, signature}.`,
    type: 'object',
    properties: { intent: { const: intent }, ...COMMON, ...f.properties },
    required: ['intent', 'podUrl', 'issuedAt', 'nonce', ...f.required],
    additionalProperties: false,
  };
}

/**
 * A compact, one-line rendering of a schema for an affordance description: `{a, b?: x|y, c: [{…}]}`.
 * A titled sub-schema (Tri, Rate, TaskState) is written by its title, and its definition is
 * collected into `named` so it is spelled out once.
 */
function summarise(s: unknown, depth = 0, named?: Map<string, unknown>): string {
  if (typeof s !== 'object' || s === null) return '…';
  const o = s as Record<string, unknown>;
  if (depth > 0 && typeof o['title'] === 'string' && named) {
    if (!named.has(o['title'])) named.set(o['title'], o);
    return o['title'];
  }
  if (Array.isArray(o['enum'])) return (o['enum'] as unknown[]).map(String).join('|');
  if ('const' in o) return JSON.stringify(o['const']);
  if (o['type'] === 'array') return `[${summarise(o['items'], depth + 1, named)}]`;
  const props = o['properties'];
  if (typeof props === 'object' && props !== null) {
    if (depth > 4) return '{…}';
    const required = new Set(Array.isArray(o['required']) ? (o['required'] as unknown[]).map(String) : []);
    const parts = Object.entries(props as Record<string, unknown>).map(([k, v]) => {
      const inner = summarise(v, depth + 1, named);
      const name = `${k}${required.has(k) ? '' : '?'}`;
      return inner === '' ? name : `${name}: ${inner}`;
    });
    return `{${parts.join(', ')}}`;
  }
  if (typeof o['additionalProperties'] === 'object') return `{<taskIri>: ${summarise(o['additionalProperties'], depth + 1, named)}}`;
  if (o['type'] === 'number' || o['type'] === 'integer' || o['type'] === 'boolean') return String(o['type']);
  return '';
}

/** One line per intent, for the envelope input's description: every field, nested, with enums. */
export function payloadSummary(intent: EnvelopeIntent): string {
  const s = payloadSchema(intent);
  const props = { ...(s['properties'] as Record<string, unknown>) };
  delete props['podUrl']; delete props['issuedAt']; delete props['nonce']; delete props['intent'];
  const named = new Map<string, unknown>();
  const top = summarise({ ...s, properties: props }, 0, named) || '{}';
  const defs: string[] = [];
  for (let i = 0; i < named.size; i += 1) {
    const [title, def] = [...named.entries()][i] ?? ['', {}];
    defs.push(`${title} = ${summarise({ ...(def as Record<string, unknown>), title: undefined }, 0, named)}`);
  }
  return `payload fields beyond intent, podUrl, issuedAt and nonce: ${top}${defs.length > 0 ? `; where ${defs.join('; ')}` : ''}`;
}
