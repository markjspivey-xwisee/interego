/**
 * The work-redesign bridge, driven the way a Path-A agent drives it: real HTTP to a bridge
 * composed from createVerticalBridge + createWrdHandlers, every write a signed envelope from a
 * generated wallet, an in-memory pod behind the real publish/read/verify path, and a clock that
 * moves only when the test moves it. Only the network and time are doubled.
 *
 * Covered: the role registry, capture by hand and from a document, ratify / dispute / revise /
 * add / retire, classification and its disputes, allocation rules, valuation with expert
 * evidence, the decision lifecycle (submit → countersign → measure, and decline), probe
 * decisions, read-back of the platform's content-bound proofs and tamper detection, agent runs,
 * earned and revoked grants, holder copies, pod failure, and every envelope refusal.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  importWallet, signMessageRaw, canonicalJson, sha256Hex, canonicalGraphDigest, verifySignedAuthorship, makeWalletDelegationVerifier,
  ContextDescriptor, validate, type Wallet, type IRI,
} from '@interego/core';
import {
  publish, fetchAllManifestEntries, predictManifestUrl, parseAuthorshipProofFromDescriptorTurtle, digestedGraphRegion,
  parseDistributionFromDescriptorTurtle,
} from '@interego/solid';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers, type WrdDeps } from '../bridge/handlers.js';
import { readRecord, publishRecord, KeyedMutex, StaleHeadError, WRD_CONTAINER } from '../bridge/pod-helpers.js';
import { memoryPod, demoClock, DEMO_POD, DEMO_HOLDER_POD, type MemoryPod, type DemoClock } from '../demo/run.js';
import { envelopeSha256, entityIri, graphIriOf, buildDescriptor } from '../src/records.js';
import { normaliseForQuote } from '../src/work.js';
import { meanRampFactor, monthsBetween, DEMO_LABEL } from '../src/valuation.js';
import { WRD_NS } from '../src/ontology.js';

type Obj = Record<string, unknown>;
const must = <T>(v: T | undefined | null, what = 'value'): T => {
  if (v === undefined || v === null) throw new Error(`expected ${what}`);
  return v;
};
const obj = (v: unknown, what = 'object'): Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`expected ${what}, got ${JSON.stringify(v)?.slice(0, 200)}`);
  return v as Obj;
};
const arr = (v: unknown, what = 'array'): Obj[] => {
  if (!Array.isArray(v)) throw new Error(`expected ${what}, got ${JSON.stringify(v)?.slice(0, 200)}`);
  return v as Obj[];
};

// ── People, keys and the pod ─────────────────────────────────────────────────────────────

const POD = DEMO_POD;
const wallet = (id: string, type: 'human' | 'agent' = 'human'): Wallet => importWallet(`0x${sha256Hex(`wrd-lifecycle:${id}`)}`, type, id);
const PLATFORM = wallet('platform', 'agent');
const ADMIN = wallet('admin');
const ANA = wallet('ana');
const ANA2 = wallet('ana-2');
const BO = wallet('bo');
const DEE = wallet('dee');
const CY = wallet('cy');
const ELI = wallet('eli');
const FAY = wallet('fay');
const GUS = wallet('gus');
const HAL = wallet('hal');
const IVY = wallet('ivy');
const AGENT = wallet('agent', 'agent');
const ZED = wallet('zed');
const addr = (w: Wallet): string => w.address.toLowerCase();

const person = (w: Wallet, roles: string[], personRef: string, label: string): Obj => ({ address: w.address, roles, label, softwareAgent: false, personRef });
const REGISTRY_ENTRIES: Obj[] = [
  person(ANA, ['operator', 'approver'], 'p-ana', 'Ana'),
  person(ANA2, ['approver'], 'p-ana', "Ana's second key"),
  person(BO, ['approver'], 'p-bo', 'Bo'),
  person(DEE, ['approver', 'worker'], 'p-dee', 'Dee'),
  person(CY, ['worker'], 'p-cy', 'Cy'),
  person(ELI, ['operator'], 'p-eli', 'Eli'),
  person(FAY, ['operator'], 'p-fay', 'Fay'),
  person(GUS, ['operator'], 'p-gus', 'Gus'),
  person(HAL, ['operator'], 'p-hal', 'Hal'),
  person(IVY, ['operator'], 'p-ivy', 'Ivy'),
  { address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, principal: ANA.address, model: 'scripted-fixture' },
];
const TASK_KINDS: Obj[] = [
  { slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order and goods receipt.' },
  { slug: 'gl-coding', label: 'General ledger coding', definition: 'Code an invoice to a general ledger account and cost centre.' },
  { slug: 'supplier-dispute', label: 'Supplier dispute', definition: 'Resolve a disputed invoice with the supplier.' },
  { slug: 'fraud-alert', label: 'Fraud alert', definition: 'Escalate a suspected duplicate payment to the fraud desk.' },
];

const SOP = [
  'Supplier invoice processing: accounts payable standard operating procedure.',
  '1. Match each invoice to its purchase order and goods receipt before it is approved for payment. The three-way match checks quantity, unit price and supplier.',
  '2. Code the invoice to the general ledger account and cost centre named on the purchase order; where the order names none, the specialist chooses the account from the chart of accounts.',
  "3. When a supplier disputes an invoice, contact the supplier, agree the corrected amount, and record the outcome in the dispute log.",
  '4. Escalate any suspected duplicate payment to the fraud desk immediately; do not release the payment until the fraud desk clears it.',
  'Payments are released twice a week.',
].join('\n');
const FABRICATED = 'Invoices under $500 are auto-approved without matching';

const ANSWERS: Record<'evident' | 'knowable' | 'emergent' | 'turbulent', Obj> = {
  evident: { sameStepsSameResult: 'always', methodKnown: 'documented', outcomeDependsOnOthers: 'no', situationStable: 'stable', checkability: 'before-effect', feedbackLatency: 'minutes', worstCase: 'recoverable' },
  knowable: { sameStepsSameResult: 'usually', methodKnown: 'expert-analysis', outcomeDependsOnOthers: 'no', situationStable: 'stable', checkability: 'after-effect', feedbackLatency: 'days', worstCase: 'recoverable' },
  emergent: { sameStepsSameResult: 'rarely', methodKnown: 'documented', outcomeDependsOnOthers: 'yes', situationStable: 'shifting', checkability: 'after-effect', feedbackLatency: 'weeks', worstCase: 'recoverable' },
  turbulent: { sameStepsSameResult: 'unknown', methodKnown: 'unknown', outcomeDependsOnOthers: 'partly', situationStable: 'unstable', checkability: 'not-checkable', feedbackLatency: 'unknown', worstCase: 'critical' },
};
const UNKNOWN_ANSWERS: Obj = Object.fromEntries(Object.keys(ANSWERS.evident).map((k) => [k, 'unknown']));

const INTENT: Readonly<Record<string, string>> = {
  update_registry: 'wrd:update-registry', record_task_map: 'wrd:record-task-map', capture_workflow: 'wrd:capture-workflow',
  revise_task: 'wrd:revise-task', ratify_task: 'wrd:ratify-task', classify_task: 'wrd:classify-task', propose_allocation: 'wrd:propose-allocation',
  value_plan: 'wrd:value-plan', submit_decision: 'wrd:submit-decision', countersign_decision: 'wrd:countersign-decision',
  record_outcome: 'wrd:record-outcome', grant_autonomy: 'wrd:grant-autonomy', revoke_grant: 'wrd:revoke-grant', holder_copy: 'wrd:holder-copy',
};

// ── A bridge per test, torn down at the end ──────────────────────────────────────────────

interface World { readonly pod: MemoryPod; readonly clock: DemoClock; readonly base: string; nonce: number }
interface Res { readonly status: number; readonly body: Obj }
const listeners: TestListener[] = [];
const refusalsSeen: Array<{ readonly tool: string; readonly status: number; readonly body: Obj }> = [];
afterAll(async () => { for (const l of listeners) await l.close(); });

async function world(extra: Partial<WrdDeps> = {}, affordances = wrdAffordances): Promise<World> {
  const pod = memoryPod();
  const clock = demoClock();
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: POD, now: () => clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' },
    adminAddresses: [ADMIN.address], ...extra,
  });
  const app = createVerticalBridge({ verticalName: 'work-redesign', affordances, handlers, deploymentUrl: 'http://127.0.0.1' });
  const l = await listenLoopback(app);
  listeners.push(l);
  return { pod, clock, base: l.base, nonce: 0 };
}

async function http(w: World, method: 'GET' | 'POST', tool: string, body?: Obj, query = ''): Promise<Res> {
  const r = await fetch(`${w.base}/wrd/${tool}${query}`, {
    method, headers: { 'content-type': 'application/json', accept: 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  const res = { status: r.status, body: obj(parsed, `${tool} response`) };
  if (res.status >= 400) refusalsSeen.push({ tool, ...res });
  return res;
}

async function envelope(w: World, who: Wallet, intent: string, fields: Obj, opts: { issuedAt?: string; nonce?: string; podUrl?: string } = {}): Promise<{ payload: Obj; signature: string }> {
  w.nonce += 1;
  const payload: Obj = {
    intent, podUrl: opts.podUrl ?? POD, issuedAt: opts.issuedAt ?? w.clock.now().toISOString(),
    nonce: opts.nonce ?? `lifecycle-${String(w.nonce).padStart(8, '0')}`, ...fields,
  };
  return { payload, signature: await signMessageRaw(who, canonicalJson(payload)) };
}

async function act(w: World, who: Wallet, tool: string, fields: Obj, extra: Obj = {}): Promise<Res> {
  return http(w, 'POST', tool, { envelope: await envelope(w, who, must(INTENT[tool], `intent for ${tool}`), fields), ...extra });
}

function ok(r: Res, what = 'call'): Obj {
  expect(r.status, `${what}: ${JSON.stringify(r.body).slice(0, 600)}`).toBe(200);
  expect(r.body['kind']).not.toBe('refusal');
  return r.body;
}
function refused(r: Res, status: number, error?: RegExp, reason?: RegExp): Obj {
  expect(r.status, JSON.stringify(r.body).slice(0, 600)).toBe(status);
  expect(r.body['kind']).toBe('refusal');
  if (error) expect(String(r.body['error'])).toMatch(error);
  if (reason) expect(String(r.body['iep:refusalReason'])).toMatch(reason);
  return r.body;
}

const list = async (w: World, query = ''): Promise<Obj> => ok(await http(w, 'GET', 'list_records', undefined, query), 'list_records');
const taskRow = async (w: World, taskIri: string): Promise<Obj> => must(arr((await list(w))['tasks']).find((t) => t['taskIri'] === taskIri), `task ${taskIri}`);
const headOfRow = (row: Obj): { descriptorUrl: string; graphDigest: string; recordId: string } => {
  const h = obj(row['head'], 'head');
  return { descriptorUrl: String(h['descriptorUrl']), graphDigest: String(h['graphDigest']), recordId: String(h['recordId']) };
};

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

async function register(w: World): Promise<void> {
  ok(await act(w, ADMIN, 'update_registry', { entries: REGISTRY_ENTRIES, taskKinds: TASK_KINDS }), 'registry');
}

const draftTask = (name: string, description: string, personAddress: string, taskKind: string, sourceQuotes: string[]): Obj =>
  ({ name, description, currentLevel: 'person', personAddress, taskKind, sourceQuotes });

const AP_TASKS = (): Obj[] => [
  draftTask('Match each invoice to its purchase order and goods receipt', 'Three-way match before approval.', CY.address, 'invoice-matching',
    ['Match each invoice to its purchase order and goods receipt', 'The three-way match checks quantity, unit price and supplier']),
  draftTask('Code the invoice to the general ledger', 'Account and cost centre from the purchase order.', DEE.address, 'gl-coding',
    ['Code the invoice to the general ledger account', FABRICATED]),
  draftTask('Resolve a disputed invoice with the supplier', 'Agree the corrected amount and log it.', CY.address, 'supplier-dispute',
    ['When a supplier disputes an invoice, contact the supplier']),
  draftTask('Escalate a suspected duplicate-payment fraud alert', 'Hold the payment until the fraud desk clears it.', DEE.address, 'fraud-alert',
    ['Escalate any suspected duplicate payment to the fraud desk']),
];

interface Ap { readonly workflowIri: string; readonly t1: string; readonly t2: string; readonly t3: string; readonly t4: string; readonly capture: Obj }

async function captureAp(w: World, tasks = AP_TASKS()): Promise<Ap> {
  const capture = ok(await act(w, ANA, 'record_task_map', {
    workflow: { title: 'Supplier invoice processing', unitLabel: 'invoice' }, tasks,
    document: { title: 'AP SOP', sha256: sha256Hex(SOP), storeText: true },
    draftedBy: { kind: 'agent', agent: 'test fixture standing in for the client agent' },
  }, { document_text: SOP }), 'record_task_map');
  const iris = arr(capture['tasks']).map((t) => String(t['taskIri']));
  return { workflowIri: String(capture['workflowIri']), t1: must(iris[0]), t2: must(iris[1]), t3: must(iris[2]), t4: must(iris[3]), capture };
}

async function ratify(w: World, who: Wallet, taskIri: string, verdict: 'ratify' | 'dispute' = 'ratify', note?: string): Promise<Res> {
  const h = headOfRow(await taskRow(w, taskIri));
  return act(w, who, 'ratify_task', { subject: 'description', taskIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...(note ? { note } : {}) });
}

async function classify(w: World, who: Wallet, taskIri: string, answers: Obj): Promise<Res> {
  return act(w, who, 'classify_task', { taskIri, answers });
}

/** Registry, the document-captured AP workflow, every task ratified by its people, and classified by Ana. */
async function standardAp(w: World): Promise<Ap> {
  await register(w);
  const ap = await captureAp(w);
  ok(await ratify(w, CY, ap.t1));
  ok(await ratify(w, DEE, ap.t2));
  ok(await ratify(w, CY, ap.t3));
  ok(await ratify(w, DEE, ap.t4));
  ok(await classify(w, ANA, ap.t1, ANSWERS.evident));
  ok(await classify(w, ANA, ap.t2, ANSWERS.knowable));
  ok(await classify(w, ANA, ap.t3, ANSWERS.emergent));
  ok(await classify(w, ANA, ap.t4, ANSWERS.turbulent));
  return ap;
}

type Basis = 'measured' | 'document' | 'performer-reported' | 'estimate';
const tri = (low: number, likely: number, high: number, basis: Basis = 'estimate'): Obj => ({ low, likely, high, basis });
const one = (v: number, basis: Basis = 'measured'): Obj => tri(v, v, v, basis);
const STATE_ZERO: Obj = {
  performerHoursPerRun: one(0), oversightHoursPerRun: one(0), agentCostPerRun: one(0), minorFailureRate: one(0), minorFailureCost: one(0),
  criticalFailureRate: one(0), criticalFailureCost: one(0),
};
const state = (o: Obj): Obj => ({ ...STATE_ZERO, ...o });

/** Valuation inputs for the plan that moves T1 to agent drafting (Cy decides) and T2 to agent assistance (Dee). */
function p1Inputs(ap: Ap, t2Basis: Basis = 'performer-reported'): Obj {
  return {
    currency: 'USD', unitsPerWeek: { current: tri(180, 200, 220, 'measured') }, valuePerUnit: tri(5, 6, 7), hourlyCost: tri(38, 42, 46, 'document'),
    oneOffCost: tri(3000, 5000, 8000), horizonMonths: 24, rampMonths: 2, annualDiscountRate: 0.08, criticalFailureCeiling: 0.01,
    freedHours: { [ap.t1]: { disposition: 'absorbed', note: 'Cy takes on supplier-statement reconciliation' }, [ap.t2]: { disposition: 'undecided' } },
    tasks: {
      [ap.t1]: {
        runsPerUnit: one(1),
        current: state({ performerHoursPerRun: tri(0.15, 0.2, 0.3, 'measured'), minorFailureRate: tri(0.01, 0.02, 0.04, 'measured'), minorFailureCost: tri(20, 30, 50) }),
        proposed: state({ oversightHoursPerRun: tri(0.03, 0.05, 0.08), agentCostPerRun: tri(0.05, 0.1, 0.2), minorFailureRate: tri(0.01, 0.03, 0.05), minorFailureCost: tri(20, 30, 50) }),
      },
      [ap.t2]: {
        runsPerUnit: one(1),
        current: Object.fromEntries(Object.entries(state({ performerHoursPerRun: tri(0.1, 0.15, 0.2) })).map(([k, v]) => [k, { ...obj(v), basis: t2Basis }])),
        proposed: state({ performerHoursPerRun: tri(0.07, 0.1, 0.15), agentCostPerRun: tri(0.02, 0.05, 0.1) }),
      },
    },
  };
}

const P1_CHANGES = (ap: Ap): Obj[] => [
  { taskIri: ap.t1, proposedLevel: 'agent-drafts-person-decides', agentAddress: AGENT.address, personAddress: CY.address },
  { taskIri: ap.t2, proposedLevel: 'person-with-agent-assist', personAddress: DEE.address, agentAddress: AGENT.address },
];

async function propose(w: World, ap: Ap, changes: Obj[], title = 'Plan'): Promise<Res> {
  return act(w, ANA, 'propose_allocation', { workflowIri: ap.workflowIri, title, changes });
}

/** Standard AP, plan P1 proposed and valued, Cy acknowledges her assignment. */
async function valuedP1(w: World): Promise<{ ap: Ap; planIri: string; valuation: Obj }> {
  const ap = await standardAp(w);
  const plan = ok(await propose(w, ap, P1_CHANGES(ap), 'P1'), 'propose P1');
  const planIri = String(plan['planIri']);
  const valuation = ok(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }), 'value P1');
  return { ap, planIri, valuation };
}

async function planHead(w: World, planIri: string): Promise<{ descriptorUrl: string; graphDigest: string }> {
  return headOfRow(must(arr((await list(w))['plans']).find((p) => p['planIri'] === planIri), 'plan row'));
}

async function acknowledge(w: World, who: Wallet, planIri: string, taskIri: string, verdict: 'acknowledge' | 'object', note?: string): Promise<Res> {
  const h = await planHead(w, planIri);
  return act(w, who, 'ratify_task', { subject: 'assignment', planIri, taskIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...(note ? { note } : {}) });
}

async function submitValued(w: World, planIri: string, valuation: Obj, basis = 'staggered'): Promise<Obj> {
  return ok(await act(w, ANA, 'submit_decision', {
    planIri, valuationIri: valuation['valuationIri'], valuationHash: valuation['valuationHash'],
    measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: basis, windowWeeks: 8 },
  }), 'submit');
}

async function decisionRow(w: World, decisionIri: string): Promise<Obj> {
  return must(arr((await list(w))['decisions']).find((d) => d['decisionIri'] === decisionIri), 'decision row');
}

async function countersign(w: World, who: Wallet, decisionIri: string, verdict: 'approve' | 'decline', extra: Obj = {}): Promise<Res> {
  const h = headOfRow(await decisionRow(w, decisionIri));
  return act(w, who, 'countersign_decision', { decisionIri, recordId: h.recordId, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...extra });
}

async function recordOutcome(w: World, who: Wallet, decisionIri: string, fields: Obj): Promise<Res> {
  const h = headOfRow(await decisionRow(w, decisionIri));
  return act(w, who, 'record_outcome', { decisionIri, recordId: h.recordId, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, ...fields });
}

const WEEK = 7 * 86_400_000;
const plusWeeks = (iso: string, weeks: number): string => new Date(Date.parse(iso) + weeks * WEEK).toISOString();

async function runEnvelope(w: World, runId: string, taskIri: string, self: 'accepted' | 'reworked' | 'critical-failure', extra: Obj = {}): Promise<{ payload: Obj; signature: string }> {
  return envelope(w, AGENT, 'wrd:agent-run', {
    runId, taskIri, taskKind: 'invoice-matching', model: 'scripted-fixture', outputSha256: sha256Hex(`output of ${runId}`),
    selfAssessment: { answer: self }, performedAt: w.clock.now().toISOString(), ...extra,
  });
}
async function reviewEnvelope(w: World, who: Wallet, run: { payload: Obj; signature: string }, verdict: 'accepted' | 'reworked' | 'critical-failure'): Promise<{ payload: Obj; signature: string }> {
  return envelope(w, who, 'wrd:review-agent-run', { runEnvelopeSha256: envelopeSha256(run), verdict });
}
async function logReviewedRun(w: World, runId: string, taskIri: string, self: 'accepted' | 'reworked', reviewer: Wallet, verdict: 'accepted' | 'reworked'): Promise<Obj> {
  const run = await runEnvelope(w, runId, taskIri, self, { costPerRun: { amount: 0.12, currency: 'USD' } });
  return ok(await http(w, 'POST', 'log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(w, reviewer, run, verdict) }), `run ${runId}`);
}

async function manifest(w: World, podUrl = POD): Promise<Array<{ descriptorUrl: string; describes: readonly string[]; supersedes?: readonly string[]; modalStatus?: string }>> {
  return (await fetchAllManifestEntries(predictManifestUrl(podUrl), w.pod.fetchFn)).entries;
}

// ── The tests ────────────────────────────────────────────────────────────────────────────

describe('work-redesign bridge', () => {
  it('mounts a handler for every production affordance; a production composition neither advertises nor routes demo_envelope', async () => {
    const production = createWrdHandlers({ platform: { wallet: PLATFORM, keyKind: 'configured' } });
    for (const a of wrdAffordances) expect(typeof production[a.toolName], a.toolName).toBe('function');
    expect(production['wrd.demo_envelope']).toBeUndefined();
    expect(wrdAffordances.map((a) => a.toolName)).not.toContain('wrd.demo_envelope');
    expect(new Set(wrdAffordances.map((a) => a.toolName)).size).toBe(18);

    const w = await world();
    const manifestRes = await fetch(`${w.base}/affordances?format=jsonld`, { headers: { accept: 'application/ld+json' } });
    expect(manifestRes.status).toBe(200);
    const text = await manifestRes.text();
    for (const a of wrdAffordances) expect(text).toContain(a.toolName);
    expect(text).not.toContain('wrd.demo_envelope');
    const demoRoute = await fetch(`${w.base}/wrd/demo_envelope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ persona: 'ana', payload: {} }) });
    expect(demoRoute.status).toBe(404);
    const noSuchRoute = await fetch(`${w.base}/wrd/approve_everything`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noSuchRoute.status).toBe(404);

    const demo = await world({ demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ANA }]]) }, [...wrdAffordances, ...wrdDemoAffordances]);
    const signed = ok(await http(demo, 'POST', 'demo_envelope', { persona: 'ana', payload: { intent: 'wrd:classify-task', podUrl: POD } }), 'demo_envelope');
    expect(signed['signer']).toBe(addr(ANA));
    expect(signed['demoKey']).toBe(true);
    refused(await http(demo, 'POST', 'demo_envelope', { persona: 'mallory', payload: {} }), 404);
    // Every record a demo-composed bridge writes says it is scripted, in the payload and as a triple.
    ok(await act(demo, ADMIN, 'update_registry', { entries: REGISTRY_ENTRIES, taskKinds: TASK_KINDS }));
    expect(await list(demo)).toMatchObject({ records: 1, demoRecords: 1, demoLabel: DEMO_LABEL });
    const graphs = [...demo.pod.bodies.entries()].filter(([u]) => u.endsWith('-graph.trig')).map(([, b]) => b);
    expect(graphs).toHaveLength(1);
    expect(graphs[0]).toContain('wrd:demoRecord "true"^^xsd:boolean');
    expect(graphs[0]).toContain('\\"demo\\":true');
    const productionGraphs = [...w.pod.bodies.keys()].filter((u) => u.endsWith('-graph.trig'));
    expect(productionGraphs).toHaveLength(0);
  });

  it('opens every envelope before anything else: 401 missing, stale or from the future; 400 malformed, wrong intent or another pod; 403 when an altered payload recovers an unregistered key; 409 on a replayed nonce', async () => {
    const w = await world();
    await register(w);
    refused(await http(w, 'POST', 'capture_workflow', {}), 401, /signed envelope is required/);
    refused(await http(w, 'POST', 'capture_workflow', { envelope: { payload: 'x', signature: 1 } }), 400, /malformed/);
    const fields = { workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' }, tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }] };
    refused(await http(w, 'POST', 'capture_workflow', { envelope: await envelope(w, ANA, 'wrd:classify-task', fields) }), 400, /malformed/, /intent/);
    refused(await http(w, 'POST', 'capture_workflow', { envelope: await envelope(w, ANA, 'wrd:capture-workflow', fields, { podUrl: 'https://192.0.2.99/other/' }), pod_url: POD }), 400, /malformed/, /pod/);
    const hourAgo = new Date(Date.parse(w.clock.now().toISOString()) - 3_600_000).toISOString();
    refused(await http(w, 'POST', 'capture_workflow', { envelope: await envelope(w, ANA, 'wrd:capture-workflow', fields, { issuedAt: hourAgo }) }), 401, /stale/);
    const ahead = new Date(Date.parse(w.clock.now().toISOString()) + 600_000).toISOString();
    refused(await http(w, 'POST', 'capture_workflow', { envelope: await envelope(w, ANA, 'wrd:capture-workflow', fields, { issuedAt: ahead }) }), 401, /stale or from the future/);
    refused(await http(w, 'POST', 'capture_workflow', { envelope: { payload: (await envelope(w, ANA, 'wrd:capture-workflow', fields)).payload, signature: '0x1234' } }), 401, /does not verify/);

    // An altered payload does not fail the signature check: it recovers someone else, who holds no role here.
    const genuine = await envelope(w, ANA, 'wrd:capture-workflow', fields);
    const altered = { payload: { ...genuine.payload, workflow: { title: 'Something else entirely', unitLabel: 'accrual' } }, signature: genuine.signature };
    refused(await http(w, 'POST', 'capture_workflow', { envelope: altered }), 403, /registered operator or agent/);

    const once = await envelope(w, ANA, 'wrd:capture-workflow', fields);
    ok(await http(w, 'POST', 'capture_workflow', { envelope: once }));
    refused(await http(w, 'POST', 'capture_workflow', { envelope: once }), 409, /already used/);

    refused(await http(w, 'POST', 'capture_workflow', { envelope: await envelope(w, ANA, 'wrd:capture-workflow', fields, { podUrl: 'http://127.0.0.1:9/pod/' }), pod_url: 'http://127.0.0.1:9/pod/' }), 400, /not a safe target/);
  });

  it('changes the registry only with an admin envelope (401 without, 403 non-admin) and requires personRef for people and principal and model for agents', async () => {
    const w = await world();
    refused(await http(w, 'POST', 'update_registry', {}), 401);
    refused(await act(w, ANA, 'update_registry', { entries: [person(ANA, ['operator'], 'p-ana', 'Ana')] }), 403, /Only an admin/);
    refused(await act(w, ADMIN, 'update_registry', { entries: [{ address: ANA.address, roles: ['operator'], label: 'Ana', softwareAgent: false }] }), 400, /malformed/, /personRef is required/);
    refused(await act(w, ADMIN, 'update_registry', { entries: [person(ANA, ['operator'], 'p-ana', 'Ana'), { address: AGENT.address, roles: ['agent'], label: 'Agent', softwareAgent: true }] }), 400, /malformed/, /principal is required/);
    refused(await act(w, ADMIN, 'update_registry', { entries: [person(ANA, ['operator'], 'p-ana', 'Ana'), { address: AGENT.address, roles: ['agent'], label: 'Agent', softwareAgent: true, principal: ANA.address }] }), 400, /malformed/, /model is required/);
    refused(await act(w, ADMIN, 'update_registry', { entries: [{ address: AGENT.address, roles: ['agent'], label: 'Agent', softwareAgent: true, principal: ZED.address, model: 'm' }] }), 400, /malformed/, /must be a registered person/);
    refused(await act(w, ADMIN, 'update_registry', { entries: [{ address: CY.address, roles: ['worker', 'agent'], label: 'Cy', softwareAgent: true, principal: ANA.address, model: 'm' }] }), 400, /malformed/);
    refused(await act(w, ADMIN, 'update_registry', { podPolicy: { floor: 0.5 } }), 400, /only tighten the published policy: floor/);
    const first = ok(await act(w, ADMIN, 'update_registry', { entries: REGISTRY_ENTRIES, taskKinds: TASK_KINDS, podPolicy: { minSamples: 25 } }));
    expect(first['status']).toBe('registered');
    expect(arr(first['members']).find((m) => m['address'] === addr(AGENT))).toMatchObject({ softwareAgent: true, principal: addr(ANA), model: 'scripted-fixture', personRef: null });
    refused(await act(w, ADMIN, 'update_registry', { entries: [{ address: ANA.address, roles: [] }] }), 400, /malformed/, /principal of agent/);
    const calibration = ok(await http(w, 'GET', 'calibration'));
    expect(obj(calibration['grantPolicy'])['minSamples']).toBe(25);

    const noAdmins = await world({ adminAddresses: [] });
    refused(await act(noAdmins, ADMIN, 'update_registry', { entries: REGISTRY_ENTRIES }), 403, /no admin addresses configured/);
  });

  it('a rogue unsigned descriptor describing the registry graph is ignored and update_registry still works; so is a genuine descriptor replayed to another URL; a write based on a superseded head is refused', async () => {
    const w = await world();
    await register(w);
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    const head = obj(obj((await list(w))['registry'])['head']);
    const at = w.clock.now().toISOString();
    const rogue = ContextDescriptor.create('urn:wrd:record:registry-rogue' as IRI).describes(registryGraph as IRI).conformsTo(`${WRD_NS}RoleRegistry` as IRI)
      .temporal({ validFrom: at }).agent({ identity: 'did:ethr:0x0000000000000000000000000000000000000bad' as IRI, isSoftwareAgent: false }, 'Author')
      .selfAsserted('did:ethr:0x0000000000000000000000000000000000000bad' as IRI).asserted().supersedes(String(head['descriptorUrl']) as IRI).build();
    expect(validate(rogue).conforms).toBe(true);
    const rogueGraph = `@prefix wrd: <${WRD_NS}> .\n<${entityIri('registry', POD, 'registry')}> a wrd:RoleRegistry ; wrd:status "registered" ; wrd:payloadJson "{}" .\n`;
    await publish(rogue, rogueGraph, POD, { fetch: w.pod.fetchFn, containerPath: WRD_CONTAINER, descriptorSlug: 'registry-rogue', graphSlug: 'registry-rogue-graph' });

    const after = await list(w);
    expect(arr(after['untrusted']).map((u) => u['descriptorUrl'])).toContain(`${POD}${WRD_CONTAINER}registry-rogue.ttl`);
    expect(String(arr(after['untrusted'])[0]?.['why'])).toMatch(/no authorship proof/);
    expect(obj(obj(after['registry'])['head'])['descriptorUrl']).toBe(head['descriptorUrl']);
    const changed = ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'accrual-review', label: 'Accrual review', definition: 'Review open accruals at month end.' }] }));
    expect(arr(changed['taskKinds']).map((k) => k['slug'])).toContain('accrual-review');
    expect(changed['replacedUntrusted']).toBe(false);

    // A genuine, platform-signed descriptor copied to another URL in the container is not current: its proof names another URL.
    const trusted = new Set([addr(PLATFORM)]);
    const entries = await manifest(w);
    const current = must(entries.find((e) => e.descriptorUrl === changed['descriptorUrl']));
    const genuine = await readRecord(current as Parameters<typeof readRecord>[0], POD, w.pod.fetchFn, trusted);
    expect(genuine.authorship.trusted).toBe(true);
    const replay = buildDescriptor({
      recordId: genuine.recordId, graphIri: registryGraph, recordKind: 'RoleRegistry', now: w.clock.now().toISOString(), validFrom: w.clock.now().toISOString(),
      modal: 'Asserted', supersedes: genuine.descriptorUrl, platformDid: `did:ethr:${addr(PLATFORM)}`, signers: [], derivedFrom: [],
    });
    await publish(replay, genuine.graphTurtle, POD, {
      fetch: w.pod.fetchFn, containerPath: WRD_CONTAINER, descriptorSlug: 'registry-replayed', graphSlug: 'registry-replayed-graph', authorshipProof: must(genuine.authorship.proof),
    });
    const afterReplay = await list(w);
    const replayed = must(arr(afterReplay['untrusted']).find((u) => u['descriptorUrl'] === `${POD}${WRD_CONTAINER}registry-replayed.ttl`));
    expect(String(replayed['why'])).toMatch(/not at the URL its own proof names/);
    expect(obj(obj(afterReplay['registry'])['head'])['descriptorUrl']).toBe(changed['descriptorUrl']);

    // publishRecord re-reads the head under the graph's lock: a write based on the superseded first version is refused, and nothing is written.
    const first = await readRecord(must(entries.find((e) => e.descriptorUrl === head['descriptorUrl'])) as Parameters<typeof readRecord>[0], POD, w.pod.fetchFn, trusted);
    const before = (await manifest(w)).length;
    const now = w.clock.now().toISOString();
    await expect(publishRecord({
      descriptor: { recordId: 'urn:wrd:record:registry-stalewrite', graphIri: registryGraph, recordKind: 'RoleRegistry', now, validFrom: now, modal: 'Asserted', supersedes: first.descriptorUrl, platformDid: `did:ethr:${addr(PLATFORM)}`, signers: [], derivedFrom: [] },
      record: must(first.record), expectHead: first.descriptorUrl,
    }, { podUrl: POD, fetchFn: w.pod.fetchFn, platform: { wallet: PLATFORM, keyKind: 'configured' }, trusted, mutex: new KeyedMutex() })).rejects.toBeInstanceOf(StaleHeadError);
    expect((await manifest(w)).length).toBe(before);
    ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'fraud-alert', retire: true }] }));
  });

  it('captures by hand and from a document; 422 when no quote verifies; 400 when the document hash differs, a task kind is unregistered, or the parties are inconsistent', async () => {
    const w = await world();
    await register(w);
    const ap = await captureAp(w);
    const tasks = arr(ap.capture['tasks']);
    expect(tasks.map((t) => t['quoteStatus'])).toEqual(['verified', 'partly-verified', 'verified', 'verified']);
    const quotes = obj(ap.capture['quotes']);
    expect(quotes['unverified']).toBe(1);
    const normalised = normaliseForQuote(SOP);
    for (const verdict of arr(quotes['perTask']).flatMap((t) => arr(t))) {
      if (verdict['status'] === 'verified') expect(normalised.slice(Number(verdict['start']), Number(verdict['end']))).toBe(normaliseForQuote(String(verdict['quote'])));
      else expect(verdict['quote']).toBe(FABRICATED);
    }
    const row = await taskRow(w, ap.t2);
    expect(row['link']).toBe(`/ui#task=${encodeURIComponent(ap.t2)}`);
    const wfRow = must(arr((await list(w))['workflows']).find((x) => x['workflowIri'] === ap.workflowIri));
    expect(wfRow['documentText']).toBe(SOP);
    expect(obj(wfRow['draftedBy'])['kind']).toBe('agent');

    const doc = (sha: string, tasksIn: Obj[]): Obj => ({
      workflow: { title: 'Another', unitLabel: 'invoice' }, tasks: tasksIn, document: { title: 'AP SOP', sha256: sha, storeText: false }, draftedBy: { kind: 'not-declared' },
    });
    refused(await act(w, ANA, 'record_task_map', doc(sha256Hex(SOP), [draftTask('Approve invoices', 'All of them.', CY.address, 'invoice-matching', [FABRICATED])]), { document_text: SOP }), 422, /None of the quoted spans/);
    refused(await act(w, ANA, 'record_task_map', doc(sha256Hex('another text'), AP_TASKS()), { document_text: SOP }), 400, /not the one the signer bound/);
    refused(await act(w, ANA, 'record_task_map', doc(sha256Hex(SOP), [draftTask('Pay suppliers', 'Release payments.', CY.address, 'payments', ['Payments are released twice a week'])]), { document_text: SOP }), 400, /task kind is not registered/);
    const manual = (t: Obj): Obj => ({ workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' }, tasks: [t] });
    refused(await act(w, ANA, 'capture_workflow', manual({ name: 'Review accruals', description: 'x', currentLevel: 'person', personAddress: DEE.address, agentAddress: AGENT.address, taskKind: 'gl-coding' })), 400, /no agent is named/);
    refused(await act(w, ANA, 'capture_workflow', manual({ name: 'Review accruals', description: 'x', currentLevel: 'person', personAddress: ZED.address, taskKind: 'gl-coding' })), 400, /registered person/);
    refused(await act(w, ANA, 'capture_workflow', manual({ name: 'Review accruals', description: 'x', currentLevel: 'agent-acts-within-grant', agentAddress: AGENT.address, taskKind: 'gl-coding' })), 400, /only come from a decision/);
    refused(await act(w, CY, 'capture_workflow', manual({ name: 'Review accruals', description: 'x', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' })), 403);
    const byHand = ok(await act(w, ANA, 'capture_workflow', manual({ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' })));
    expect(arr(byHand['tasks'])[0]?.['quoteStatus']).toBe('none');
    expect(byHand['quotes']).toBeUndefined();
  });

  it('revises a disputed description, which the worker then ratifies; adds and retires tasks through workflow versions; a plan on a retired task is stale (409)', async () => {
    const w = await world();
    const ap = await standardAp(w);
    refused(await ratify(w, CY, ap.t2), 403, /named on this task/);
    refused(await ratify(w, DEE, ap.t2, 'dispute'), 400, /needs a note/);
    expect(ok(await ratify(w, DEE, ap.t2, 'dispute', 'Misses the accrual step for uninvoiced receipts'))['status']).toBe('disputed');
    const blocked = refused(await propose(w, ap, [P1_CHANGES(ap)[1] as Obj]), 409, /disputed task description blocks any change/);
    expect(obj(blocked['iep:resolvedBy'])['toolName']).toBe('wrd.revise_task');
    const disputed = headOfRow(await taskRow(w, ap.t2));
    const revised = ok(await act(w, ANA, 'revise_task', {
      op: 'revise', taskIri: ap.t2, descriptorUrl: disputed.descriptorUrl, graphDigest: disputed.graphDigest,
      description: 'Account and cost centre from the purchase order; accrue receipts not yet invoiced.', note: 'Adds the accrual step',
    }));
    expect(revised['status']).toBe('captured');
    expect(arr(revised['answeredDisputes'])[0]).toMatchObject({ party: addr(DEE), note: 'Misses the accrual step for uninvoiced receipts' });
    refused(await act(w, ANA, 'revise_task', { op: 'revise', taskIri: ap.t2, descriptorUrl: disputed.descriptorUrl, graphDigest: disputed.graphDigest, name: 'Stale' }), 409, /changed since you read it/);
    expect(ok(await ratify(w, DEE, ap.t2))['status']).toBe('ratified');
    refused(await propose(w, ap, [P1_CHANGES(ap)[1] as Obj]), 409, /revised after it was classified; classify it again/);
    const t2 = await taskRow(w, ap.t2);
    expect(obj(t2['classification'])['current']).toBe(false);
    expect(obj(t2['revision'])['quotesCleared']).toBe(true);
    expect(t2['quoteStatus']).toBe('none');

    const wfHead = headOfRow(must(arr((await list(w))['workflows']).find((x) => x['workflowIri'] === ap.workflowIri)));
    const added = ok(await act(w, ANA, 'revise_task', {
      op: 'add', workflowIri: ap.workflowIri, descriptorUrl: wfHead.descriptorUrl, graphDigest: wfHead.graphDigest,
      task: { name: 'Reconcile supplier statements', description: 'Monthly.', currentLevel: 'person', personAddress: CY.address, taskKind: 'invoice-matching' },
    }));
    const t5 = String(added['taskIri']);
    expect(added['workflowDescriptorUrl']).toBeTruthy();
    refused(await act(w, CY, 'revise_task', { op: 'add', workflowIri: ap.workflowIri, descriptorUrl: wfHead.descriptorUrl, graphDigest: wfHead.graphDigest, task: { name: 'x', description: 'y', currentLevel: 'person', personAddress: CY.address, taskKind: 'invoice-matching' } }), 403);
    ok(await ratify(w, CY, t5));
    ok(await classify(w, ANA, t5, ANSWERS.evident));
    ok(await classify(w, DEE, ap.t2, ANSWERS.knowable));
    const plan = ok(await propose(w, ap, [{ taskIri: t5, proposedLevel: 'person-with-agent-assist', personAddress: CY.address, agentAddress: AGENT.address }], 'P5'));
    const t5Head = headOfRow(await taskRow(w, t5));
    const retired = ok(await act(w, ANA, 'revise_task', { op: 'retire', taskIri: t5, descriptorUrl: t5Head.descriptorUrl, graphDigest: t5Head.graphDigest, why: 'Moved to the treasury team' }));
    expect(retired['status']).toBe('retired');
    const after = await list(w);
    const wf = must(arr(after['workflows']).find((x) => x['workflowIri'] === ap.workflowIri));
    expect(arr(wf['taskIris'])).toHaveLength(4);
    expect(wf['retiredTaskIris']).toEqual([t5]);
    const t5Row = must(arr(after['tasks']).find((t) => t['taskIri'] === t5));
    expect(obj(t5Row['head'])).toMatchObject({ modalStatus: 'Retracted' });
    expect(Date.parse(String(obj(t5Row['head'])['validUntil']))).toBeGreaterThan(Date.parse(String(obj(t5Row['head'])['validFrom'])));
    refused(await act(w, ANA, 'value_plan', { planIri: plan['planIri'], inputs: {} }), 409, /retired; propose again/);
    refused(await ratify(w, CY, t5), 409, /retired/);
  }, 60_000);

  it('a disputed classification blocks changes to that task and returns both sets of answers', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const cls = obj((await taskRow(w, ap.t1))['classification']);
    const h = headOfRow(cls);
    const cyAnswers = { ...ANSWERS.evident, checkability: 'after-effect', feedbackLatency: 'weeks' };
    const disputed = ok(await act(w, CY, 'ratify_task', {
      subject: 'classification', taskIri: ap.t1, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict: 'dispute',
      note: 'Mismatches only show up at month end', answers: cyAnswers,
    }));
    expect(disputed['status']).toBe('disputed');
    const row = obj((await taskRow(w, ap.t1))['classification']);
    expect(row['status']).toBe('disputed');
    expect(row['answers']).toEqual(ANSWERS.evident);
    expect(arr(row['disagreement'])[0]).toEqual({ party: addr(CY), answers: cyAnswers });
    refused(await propose(w, ap, [P1_CHANGES(ap)[0] as Obj]), 409, /disputes its classification/);
    const t2Only = ok(await propose(w, ap, [P1_CHANGES(ap)[1] as Obj]));
    expect(t2Only['changedTasks']).toEqual([ap.t2]);
  });

  it('refuses allocation (409) until every task in the workflow is classified', async () => {
    const w = await world();
    await register(w);
    const ap = await captureAp(w);
    for (const [who, t] of [[CY, ap.t1], [DEE, ap.t2], [CY, ap.t3], [DEE, ap.t4]] as const) ok(await ratify(w, who, t));
    const before = refused(await propose(w, ap, P1_CHANGES(ap)), 409, /Classify every task/, /0 of 4/);
    expect(obj(before['iep:resolvedBy'])['toolName']).toBe('wrd.classify_task');
    refused(await classify(w, ANA, ap.t1, UNKNOWN_ANSWERS), 400, /No evidence places this task/);
    refused(await classify(w, CY, ap.t2, ANSWERS.knowable), 403);
    ok(await classify(w, ANA, ap.t1, ANSWERS.evident));
    ok(await classify(w, ANA, ap.t2, ANSWERS.knowable));
    const cyOwn = ok(await classify(w, CY, ap.t3, ANSWERS.emergent));
    expect(cyOwn).toMatchObject({ regime: 'Emergent', method: 'probe-portfolio', status: 'ratified', answeredBy: { role: 'performer' }, regimeSource: 'rule-on-signed-answers' });
    refused(await propose(w, ap, P1_CHANGES(ap)), 409, /Classify every task/, /3 of 4/);
    const t4 = ok(await classify(w, ANA, ap.t4, ANSWERS.turbulent));
    expect(t4['regime']).toBe('Turbulent');
    expect(arr(t4['rulesFired'])[0]).toBe(`${WRD_NS}RuleR1`);
    refused(await propose(w, ap, [{ taskIri: ap.t4, proposedLevel: 'person-with-agent-assist', personAddress: DEE.address }]), 409, /stabilise first/);
    refused(await propose(w, ap, [{ taskIri: ap.t3, proposedLevel: 'person-with-agent-assist', personAddress: CY.address }]), 400, /safe-to-fail probes/);
    refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT.address }]), 409, /No active grant/);
    refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'agent-drafts-person-decides', agentAddress: CY.address, personAddress: CY.address }]), 400, /registered software agent/);
    const probe = { hypothesis: 'An agent-drafted reply settles disputes sooner', amplifyIf: 'median days to settle falls', dampenIf: 'suppliers escalate more', timeboxWeeks: 4 };
    refused(await propose(w, ap, [{ taskIri: ap.t3, proposedLevel: 'person-with-agent-assist', personAddress: CY.address, probes: [probe] }, P1_CHANGES(ap)[0] as Obj]), 409, /separate plans/);
    refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'person', personAddress: CY.address }]), 409, /changes nothing/);
    refused(await act(w, CY, 'propose_allocation', { workflowIri: ap.workflowIri, title: 'x', changes: P1_CHANGES(ap) }), 403);
    expect(ok(await propose(w, ap, P1_CHANGES(ap)))['planKind']).toBe('valued');
  }, 60_000);

  it('values a Knowable change only with expert evidence', async () => {
    const w = await world();
    const ap = await standardAp(w);
    // Ana holds approver as well as operator, so her answers ARE expert evidence; Eli is an operator only.
    expect(ok(await classify(w, ELI, ap.t2, ANSWERS.knowable))).toMatchObject({ answeredBy: { role: 'operator' }, status: 'classified' });
    const planIri = String(ok(await propose(w, ap, P1_CHANGES(ap)))['planIri']);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap, 'estimate') }), 409, /Knowable work is valued only with expert analysis/);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: { ...p1Inputs(ap), currency: 'usd' } }), 400, /valuation inputs are malformed/, /currency/);
    const v = ok(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }));
    expect(v['expertEvidence']).toEqual([{ taskIri: ap.t2, satisfiedBy: 'performer-inputs' }]);
    const result = obj(v['result']);
    const cash = obj(obj(obj(result['scenarios'])['cash'])['weeklyDelta']);
    const redeployed = obj(obj(obj(result['scenarios'])['redeployed'])['weeklyDelta']);
    expect(Number(cash['p10'])).toBeLessThanOrEqual(Number(cash['p50']));
    expect(Number(cash['p50'])).toBeLessThanOrEqual(Number(cash['p90']));
    expect(Number(cash['p50'])).toBeLessThan(Number(redeployed['p50']));
    // Only levels where the agent performs (requiresAgent in wrd.ttl) are agent-level: T1 is, T2 (person-with-agent-assist) is not.
    expect(arr(obj(result['inputs'])['unconfirmed']).map((u) => u['path'])).toEqual([`tasks[${ap.t1}].proposed.agentCostPerRun`]);
    expect(arr(result['pilot']).map((x) => [x['taskIri'], x['runsNeeded']])).toEqual([[ap.t1, 300]]);
    expect(v['reused']).toBe(false);
    const again = ok(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }));
    expect(again).toMatchObject({ reused: true, valuationHash: v['valuationHash'], valuationIri: v['valuationIri'] });

    ok(await classify(w, DEE, ap.t2, ANSWERS.knowable));
    const p2 = String(ok(await propose(w, ap, P1_CHANGES(ap), 'P1 again'))['planIri']);
    expect(ok(await act(w, ANA, 'value_plan', { planIri: p2, inputs: p1Inputs(ap, 'estimate') }))['expertEvidence']).toEqual([{ taskIri: ap.t2, satisfiedBy: 'performer-answers' }]);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }), 409, /re-classified or revised after this plan/);
  }, 60_000);

  it('blocks valuation on a disputed task and submission on an unratified one (409)', async () => {
    const w = await world();
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t3));
    ok(await ratify(w, DEE, ap.t4));
    for (const [t, a] of [[ap.t1, ANSWERS.evident], [ap.t2, ANSWERS.knowable], [ap.t3, ANSWERS.emergent], [ap.t4, ANSWERS.turbulent]] as const) ok(await classify(w, ANA, t, a));
    const planIri = String(ok(await propose(w, ap, P1_CHANGES(ap)))['planIri']);
    ok(await ratify(w, DEE, ap.t2, 'dispute', 'The proposal leaves out accruals'));
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }), 409, /disputed task description blocks valuation/);
    ok(await ratify(w, DEE, ap.t2));
    const v = ok(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }));
    expect(v['unratifiedTasks']).toEqual([ap.t1]);
    const submit = await act(w, ANA, 'submit_decision', {
      planIri, valuationIri: v['valuationIri'], valuationHash: v['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 },
    });
    refused(submit, 409, /must be ratified by everyone named on it/);
  }, 60_000);

  it('runs submit -> countersign -> measure on one graph IRI, each version superseding the head by descriptorUrl; the outcome is recorded nine weeks after countersign', async () => {
    const w = await world();
    const { ap, planIri, valuation } = await valuedP1(w);
    refused(await act(w, ANA, 'submit_decision', { planIri, valuationIri: valuation['valuationIri'], valuationHash: '0'.repeat(64), measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 } }), 409, /hash does not match/);
    refused(await act(w, ANA, 'submit_decision', { planIri, valuationIri: valuation['valuationIri'], valuationHash: valuation['valuationHash'] }), 400, /measurement plan/);
    const submitted = await submitValued(w, planIri, valuation);
    expect(submitted).toMatchObject({ status: 'submitted', decisionKind: 'valued', decisionLevel: 'agent-drafts-person-decides' });
    expect(arr(submitted['assignments']).map((a) => a['state'])).toEqual(['not-acknowledged', 'not-acknowledged']);
    refused(await act(w, ANA, 'submit_decision', { planIri, valuationIri: valuation['valuationIri'], valuationHash: valuation['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 } }), 409, /already submitted/);
    const decisionIri = String(submitted['decisionIri']);
    const prediction = obj(submitted['prediction']);
    const band = obj(prediction['band']);

    const approved = ok(await countersign(w, BO, decisionIri, 'approve'));
    expect(approved).toMatchObject({ status: 'countersigned', statusLabel: 'approved; prediction unmeasured' });
    const csRow = await decisionRow(w, decisionIri);
    const csAt = String(obj(csRow['countersign'])['at']);
    const graph = String(w.pod.bodies.get(String(obj(csRow['head'])['descriptorUrl']).replace('.ttl', '-graph.trig')));
    expect(graph).toContain('wrd:predictionStatus "unmeasured"');

    w.clock.advance(9 * WEEK);
    const windowEnd = plusWeeks(csAt, 8);
    const factor = meanRampFactor(0, monthsBetween(csAt, windowEnd), Number(prediction['rampMonths']));
    expect(factor).toBeLessThan(1);
    const measured = Number(band['p50']) * factor;
    const outcome = ok(await recordOutcome(w, ELI, decisionIri, {
      disposition: 'kept', measured: { weeklyValueDelta: measured, comparisonBasis: 'staggered', windowStart: csAt, windowEnd, method: 'Staggered roll-out across two AP teams' },
    }));
    expect(outcome).toMatchObject({ status: 'measured', disposition: 'kept' });
    expect(obj(outcome['valued'])).toMatchObject({ verdict: 'in-band', rampAdjusted: true, comparisonGroup: true });

    const decisionGraph = graphIriOf(decisionIri);
    const entries = (await manifest(w)).filter((e) => e.describes.includes(decisionGraph));
    expect(entries).toHaveLength(3);
    const root = must(entries.find((e) => (e.supersedes ?? []).length === 0));
    const second = must(entries.find((e) => e.supersedes?.[0] === root.descriptorUrl));
    const third = must(entries.find((e) => e.supersedes?.[0] === second.descriptorUrl));
    expect([root.modalStatus, second.modalStatus, third.modalStatus]).toEqual(['Hypothetical', 'Asserted', 'Asserted']);
    const chain = arr((await decisionRow(w, decisionIri))['chain']);
    expect(chain.map((c) => c['status'])).toEqual(['submitted', 'countersigned', 'measured']);
    expect(chain.map((c) => c['descriptorUrl'])).toEqual([root.descriptorUrl, second.descriptorUrl, third.descriptorUrl]);

    const calibration = ok(await http(w, 'GET', 'calibration', undefined, '?kind=predictions'));
    const cell = must(arr(calibration['predictionCells']).find((c) => c['kind'] === 'prediction:weekly-cash-delta:agent-drafts-person-decides:controlled'));
    expect(cell).toMatchObject({ samples: 1, hitRate: 1, status: 'Hypothetical', rampAdjusted: 1, scriptedLabel: null });
    const t1 = await taskRow(w, ap.t1);
    expect(obj(t1['effective'])).toMatchObject({ level: 'agent-drafts-person-decides', source: 'measured-decision', decisionIri });
  }, 90_000);

  it('refuses countersign by the submitter from either key, a subject, or a non-approver (403), on a stale digest, a replay or an unnamed objection (409), and an outcome before countersign or before the window ends (409)', async () => {
    const w = await world();
    const { ap, planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured: {} }), 409, /only for a countersigned decision/);
    refused(await countersign(w, ANA, decisionIri, 'approve'), 403, /submitted a decision cannot countersign/);
    refused(await countersign(w, ANA2, decisionIri, 'approve'), 403, /from any of their registered keys/);
    refused(await countersign(w, DEE, decisionIri, 'approve'), 403, /whose work this decision changes/);
    refused(await countersign(w, ELI, decisionIri, 'approve'), 403, /registered approver/);
    const h = headOfRow(await decisionRow(w, decisionIri));
    refused(await act(w, BO, 'countersign_decision', { decisionIri, recordId: h.recordId, descriptorUrl: h.descriptorUrl, graphDigest: `graph-nquads-sha256:${'0'.repeat(64)}`, verdict: 'approve' }), 409, /changed since you read it/);
    ok(await acknowledge(w, CY, planIri, ap.t1, 'acknowledge'));
    refused(await acknowledge(w, CY, planIri, ap.t2, 'acknowledge'), 403, /Only the person this plan names/);
    ok(await acknowledge(w, DEE, planIri, ap.t2, 'object', 'I cannot audit 200 codings a week'));
    refused(await countersign(w, BO, decisionIri, 'approve'), 409, /objects to their assignment/);
    const fields = { decisionIri, recordId: h.recordId, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict: 'approve', objectionsConsidered: [ap.t2] };
    const env = await envelope(w, BO, 'wrd:countersign-decision', fields);
    const approved = ok(await http(w, 'POST', 'countersign_decision', { envelope: env }));
    expect(arr(approved['assignments']).map((a) => [a['taskIri'], a['state']])).toEqual([[ap.t1, 'acknowledged'], [ap.t2, 'objected']]);
    refused(await http(w, 'POST', 'countersign_decision', { envelope: env }), 409, /already used/);
    refused(await countersign(w, ANA2, decisionIri, 'decline'), 403);
    refused(await countersign(w, BO, decisionIri, 'decline'), 409, /Only a submitted decision/);
    const csAt = String(obj((await decisionRow(w, decisionIri))['countersign'])['at']);
    const measured = { weeklyValueDelta: 100, comparisonBasis: 'staggered', windowStart: csAt, windowEnd: plusWeeks(csAt, 8), method: 'Staggered' };
    refused(await recordOutcome(w, ANA, decisionIri, { disposition: 'kept', measured }), 403, /predicted cannot grade/);
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured }), 409, /has not ended yet/, /^the window ends \S+; it is now \S+$/);
    w.clock.advance(9 * WEEK);
    // The countersign is re-verified against the CURRENT registry, not trusted from the modal status.
    ok(await act(w, ADMIN, 'update_registry', { entries: [person(BO, ['worker'], 'p-bo', 'Bo')] }));
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured }), 409, /no longer verifies/);
    ok(await act(w, ADMIN, 'update_registry', { entries: [person(BO, ['approver'], 'p-bo', 'Bo')] }));
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured: { ...measured, windowStart: plusWeeks(csAt, -1) } }), 409, /starts before the decision was countersigned/, /^the window starts \S+; the decision was countersigned \S+$/);
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'reverted', measured }), 400, /needs a note/);
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured: { ...measured, interval: { low: 200, high: 300 } } }), 400, /malformed/, /must contain/);
    const straddle = ok(await recordOutcome(w, ELI, decisionIri, { disposition: 'stopped-early', dispositionNote: 'Stopped after the audit backlog grew', measured: { ...measured, interval: { low: -1e6, high: 1e6 } } }));
    expect(obj(straddle['valued'])['verdict']).toBe('inconclusive');
  }, 90_000);

  it('declines into a Counterfactual head on which no outcome can be recorded', async () => {
    const w = await world();
    const { planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation, 'before-after'))['decisionIri']);
    expect((await decisionRow(w, decisionIri))['basisLabel']).toBe('before-after — no comparison group');
    const declined = ok(await countersign(w, BO, decisionIri, 'decline', { note: 'Not this quarter' }));
    expect(declined['status']).toBe('declined');
    const row = await decisionRow(w, decisionIri);
    expect(obj(row['head'])['modalStatus']).toBe('Counterfactual');
    expect(obj(row['prediction'])['status']).toBe('not-to-be-measured');
    w.clock.advance(9 * WEEK);
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured: {} }), 409, /only for a countersigned decision/);
  }, 60_000);

  it('submits, countersigns and measures a probe decision without a valuation', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const probes = [
      { hypothesis: 'An agent-drafted first reply settles disputes sooner', amplifyIf: 'median days to settle falls by a quarter', dampenIf: 'suppliers escalate more often', timeboxWeeks: 4 },
      { hypothesis: 'Suppliers accept a templated correction note', amplifyIf: 'fewer than one in ten reopen', dampenIf: 'more than one in four reopen', timeboxWeeks: 4 },
    ];
    const plan = ok(await propose(w, ap, [{ taskIri: ap.t3, proposedLevel: 'person-with-agent-assist', personAddress: CY.address, agentAddress: AGENT.address, probes }], 'P4'));
    expect(plan['planKind']).toBe('probe');
    const planIri = String(plan['planIri']);
    const valued = refused(await act(w, ANA, 'value_plan', { planIri, inputs: {} }), 409, /probe plan/);
    expect(obj(valued['iep:resolvedBy'])['toolName']).toBe('wrd.submit_decision');
    refused(await act(w, ANA, 'submit_decision', { planIri, valuationHash: 'x' }), 400, /probe decision carries no valuation/);
    const submitted = ok(await act(w, ANA, 'submit_decision', { planIri }));
    expect(submitted['prediction']).toBeUndefined();
    expect(arr(submitted['probes'])).toHaveLength(2);
    const decisionIri = String(submitted['decisionIri']);
    expect(ok(await countersign(w, BO, decisionIri, 'approve'))['statusLabel']).toBe('approved; probes not yet read');
    const csAt = String(obj((await decisionRow(w, decisionIri))['countersign'])['at']);
    w.clock.advance(5 * WEEK);
    const result = (index: number, signal: string): Obj => ({ taskIri: ap.t3, index, signal, observed: 'Read from the dispute log', windowStart: csAt, windowEnd: plusWeeks(csAt, 4) });
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', probeResults: [result(1, 'amplify')] }), 400, /one result per declared probe/);
    const measured = ok(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', probeResults: [result(1, 'amplify'), result(2, 'neither')] }));
    expect(measured).toMatchObject({ status: 'measured', next: 'Re-classify this task, then propose a plan.' });
    expect(arr(measured['probes']).map((p) => p['signal'])).toEqual(['amplify', 'neither']);
    const signals = obj(ok(await http(w, 'GET', 'calibration', undefined, '?kind=probes'))['probeSignals']);
    expect(signals).toMatchObject({ probes: 2, amplify: 1, neither: 1, conditionFired: 1 });
  }, 60_000);

  it('reads back a content-bound platform authorship proof on every record; a tampered graph is altered and lifecycle answers 409', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const trusted = new Set([addr(PLATFORM)]);
    const entries = (await fetchAllManifestEntries(predictManifestUrl(POD), w.pod.fetchFn)).entries.filter((e) => e.descriptorUrl.startsWith(`${POD}${WRD_CONTAINER}`));
    expect(entries.length).toBeGreaterThan(10);
    for (const e of entries) {
      const r = await readRecord(e, POD, w.pod.fetchFn, trusted);
      expect(r.authorship, e.descriptorUrl).toMatchObject({ signatureValid: true, signerAddress: addr(PLATFORM), contentBinding: 'bound', trusted: true });
      expect(r.record?.platform).toEqual({ did: `did:ethr:${addr(PLATFORM)}`, address: addr(PLATFORM), keyKind: 'configured' });
    }
    const otherKey = await readRecord(must(entries[0]), POD, w.pod.fetchFn, new Set(['0x0000000000000000000000000000000000000001']));
    expect(otherKey.authorship).toMatchObject({ signatureValid: true, signedByTrustedKey: false, eligible: false });

    const clsRow = obj((await taskRow(w, ap.t1))['classification']);
    const graphUrl = String(obj(clsRow['head'])['descriptorUrl']).replace('.ttl', '-graph.trig');
    w.pod.tamper(graphUrl, 'wrd#Evident>', 'wrd#Knowable>');
    const after = await list(w);
    const classificationGraph = graphIriOf(entityIri('classification', ap.workflowIri, ap.t1));
    expect(after['altered']).toContain(classificationGraph);
    expect(obj(must(arr(after['tasks']).find((t) => t['taskIri'] === ap.t1))['classification'])).toMatchObject({ trusted: false, state: 'altered' });
    refused(await propose(w, ap, P1_CHANGES(ap)), 409, /altered after signing/, /altered after signing/);

    // The proof does not cover the descriptor's facets, so the modal status is checked against the signed payload's status.
    const t3Head = obj((await taskRow(w, ap.t3))['head']);
    expect(t3Head['modalStatus']).toBe('Asserted');
    w.pod.tamper(String(t3Head['descriptorUrl']), 'iep:modalStatus iep:Asserted', 'iep:modalStatus iep:Hypothetical');
    const t3Altered = must(arr((await list(w))['integrity']).find((a) => a['graphIri'] === graphIriOf(ap.t3)));
    expect(t3Altered['state']).toBe('altered');
    expect(String(arr(t3Altered['heads'])[0]?.['why'])).toMatch(/modal status no longer matches/);
    expect(ok(await ratify(w, CY, ap.t1))['subject']).toBe('description');   // T1's description reads neither T3 nor T1's classification
    refused(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t3, descriptorUrl: String(t3Head['descriptorUrl']), graphDigest: String(t3Head['graphDigest']), verdict: 'ratify' }), 409, /altered after signing/);
    refused(await classify(w, ANA, ap.t3, ANSWERS.emergent), 409, /altered after signing/);
  }, 60_000);

  it('counts only person-reviewed agent runs; a run outside a grant without review is 400; the principal cannot review; an altered run recovers an unregistered key (403)', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const reviewed = await logReviewedRun(w, 'run-001', ap.t1, 'accepted', ELI, 'accepted');
    expect(reviewed).toMatchObject({ status: 'reviewed', verdict: 'accepted', countsTowardCalibration: true });
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'run-002', ap.t1, 'accepted') }), 400, /needs a person's review/);
    const run3 = await runEnvelope(w, 'run-003', ap.t1, 'accepted');
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: run3, review_envelope: await reviewEnvelope(w, ANA, run3, 'accepted') }), 403, /accountable for this agent/);
    const run4 = await runEnvelope(w, 'run-004', ap.t1, 'accepted');
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: run4, review_envelope: await reviewEnvelope(w, CY, run4, 'accepted') }), 403, /operator or approver/);
    const run5 = await runEnvelope(w, 'run-005', ap.t1, 'accepted', { model: 'another-model' });
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: run5, review_envelope: await reviewEnvelope(w, ELI, run5, 'accepted') }), 409, /declared model is scripted-fixture/);
    const run6 = await runEnvelope(w, 'run-006', ap.t1, 'accepted');
    const tampered = { payload: { ...run6.payload, outputSha256: sha256Hex('a different output') }, signature: run6.signature };
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: tampered, review_envelope: await reviewEnvelope(w, ELI, tampered, 'accepted') }), 403, /registered software agent/, /recovered/);
    const run7 = await runEnvelope(w, 'run-007', ap.t2, 'accepted');
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: run7, review_envelope: await reviewEnvelope(w, ELI, run7, 'accepted') }), 400, /different kind of task/);
    const run8 = await runEnvelope(w, 'run-008', ap.t1, 'accepted');
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: run8, review_envelope: await reviewEnvelope(w, ELI, run6, 'accepted') }), 400, /different run envelope/);
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'run-001', ap.t1, 'accepted'), review_envelope: await reviewEnvelope(w, FAY, run8, 'accepted') }), 409, /already reviewed/);
    const run10 = await runEnvelope(w, 'run-010', ap.t1, 'accepted');
    const pair = { run_envelope: run10, review_envelope: await reviewEnvelope(w, GUS, run10, 'accepted') };
    ok(await http(w, 'POST', 'log_agent_run', pair));
    refused(await http(w, 'POST', 'log_agent_run', pair), 409, /already used/);
    const hourAgo = new Date(Date.parse(w.clock.now().toISOString()) - 3_600_000).toISOString();
    const staleRun = await envelope(w, AGENT, 'wrd:agent-run', {
      runId: 'run-009', taskIri: ap.t1, taskKind: 'invoice-matching', model: 'scripted-fixture', outputSha256: sha256Hex('run-009'), selfAssessment: { answer: 'accepted' }, performedAt: hourAgo,
    }, { issuedAt: hourAgo });
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: staleRun, review_envelope: await reviewEnvelope(w, ELI, staleRun, 'accepted') }), 401, /stale/);

    const calibration = ok(await http(w, 'GET', 'calibration', undefined, '?kind=agents'));
    const cell = must(arr(calibration['agentCells']).find((c) => c['taskKind'] === 'invoice-matching'));
    expect(cell).toMatchObject({ samples: 2, model: 'scripted-fixture', currentModel: true, distinctConfirmers: 2, status: 'Hypothetical', agentAddress: addr(AGENT), principal: addr(ANA) });
    const runs = arr((await list(w, '?kind=runs'))['runs']);
    expect(runs).toEqual([{ agentAddress: addr(AGENT), taskKind: 'invoice-matching', model: 'scripted-fixture', reviewed: 2, actedUnderGrant: 0, measuredCost: { runs: 1, mean: 0.12, currency: 'USD' } }]);
  }, 60_000);

  it('refuses grants to people (403) and before they are earned (409); grants, uses, revokes (Retracted with the grant window), then every use is 409; a model change makes the grant inactive; a run under the grant is reviewed an hour after it was logged', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const grant = (who: Wallet, agentAddress = AGENT.address): Promise<Res> => act(w, who, 'grant_autonomy', { agentAddress, taskKind: 'invoice-matching' });
    refused(await grant(BO, CY.address), 403, /registered software agents only/);
    refused(await grant(ELI), 403, /registered approver/);
    const reviewers = [ELI, FAY, GUS];
    for (let i = 1; i <= 10; i += 1) await logReviewedRun(w, `r-${String(i).padStart(3, '0')}`, ap.t1, 'accepted', must(reviewers[i % 3]), 'accepted');
    refused(await grant(BO), 409, /not earned/, /10 person-reviewed runs on model scripted-fixture; the policy needs 20/);
    refused(await grant(ANA), 403, /accountable for this agent cannot grant/);
    for (let i = 11; i <= 20; i += 1) await logReviewedRun(w, `r-${String(i).padStart(3, '0')}`, ap.t1, 'accepted', must(reviewers[i % 3]), 'accepted');
    refused(await grant(BO), 409, /not earned/, /reviewed by 3 distinct registered reviewers the admin attests are different people; the policy needs 5/);
    await logReviewedRun(w, 'r-021', ap.t1, 'accepted', HAL, 'accepted');
    await logReviewedRun(w, 'r-022', ap.t1, 'accepted', IVY, 'accepted');
    await logReviewedRun(w, 'r-023', ap.t1, 'accepted', HAL, 'reworked');
    await logReviewedRun(w, 'r-024', ap.t1, 'reworked', IVY, 'reworked');
    const granted = ok(await grant(BO));
    expect(granted).toMatchObject({ status: 'granted', principal: addr(ANA), model: 'scripted-fixture', taskKind: 'invoice-matching' });
    expect(obj(granted['evaluation'])).toMatchObject({ earned: true, samples: 24, distinctConfirmers: 5, readyClaimPrecision: 0.9565 });
    refused(await grant(BO), 409, /already holds a grant/);
    const grantIri = String(granted['grantIri']);

    const withinGrant = { taskIri: ap.t1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT.address };
    const plan = ok(await propose(w, ap, [withinGrant], 'P3'));
    expect(arr(plan['tasks']).find((r) => r['taskIri'] === ap.t1)?.['grant']).toMatchObject({ grantIri, evidenceFromThisTask: true, runsCounted: 24 });

    // The registry's declared model changes: the grant lapses without a new record, and comes back when the model does.
    ok(await act(w, ADMIN, 'update_registry', { entries: [{ address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, principal: ANA.address, model: 'scripted-fixture-2' }] }));
    refused(await propose(w, ap, [withinGrant], 'P3b'), 409, /No active grant/, /declared model changed since the grant \(was scripted-fixture, now scripted-fixture-2\)/);
    ok(await act(w, ADMIN, 'update_registry', { entries: [{ address: AGENT.address, roles: ['agent'], label: 'Matching agent', softwareAgent: true, principal: ANA.address, model: 'scripted-fixture' }] }));

    const underGrant = await runEnvelope(w, 'g-001', ap.t1, 'accepted', { underGrant: grantIri });
    expect(ok(await http(w, 'POST', 'log_agent_run', { run_envelope: underGrant }))).toMatchObject({ status: 'acted-under-grant', countsTowardCalibration: false });
    const awaiting = arr((await list(w, '?kind=runs'))['awaitingReview']);
    expect(awaiting.map((a) => a['runEnvelope'])).toEqual([underGrant]);
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: underGrant }), 409, /already logged under its grant/);
    w.clock.advance(3_600_000);
    const later = ok(await http(w, 'POST', 'log_agent_run', { run_envelope: underGrant, review_envelope: await reviewEnvelope(w, FAY, underGrant, 'accepted') }));
    expect(later).toMatchObject({ status: 'reviewed', countsTowardCalibration: true });

    const grantRow = must(arr((await list(w, '?kind=grants'))['grants']).find((g) => g['grantIri'] === grantIri));
    const gh = headOfRow(grantRow);
    const revoked = ok(await act(w, BO, 'revoke_grant', { grantIri, recordId: gh.recordId, descriptorUrl: gh.descriptorUrl, why: 'Supplier master data migrated; re-earn on the new data' }));
    expect(revoked['status']).toBe('revoked');
    const revokedRow = must(arr((await list(w, '?kind=grants'))['grants']).find((g) => g['grantIri'] === grantIri));
    const head = obj(revokedRow['head']);
    expect(head['modalStatus']).toBe('Retracted');
    expect(head['validFrom']).toBe(revokedRow['grantedAt']);
    expect(head['validUntil']).toBe(revoked['revokedAt']);
    expect(revokedRow).toMatchObject({ status: 'revoked', active: false });
    refused(await act(w, BO, 'revoke_grant', { grantIri, recordId: String(head['recordId']), descriptorUrl: String(head['descriptorUrl']), why: 'again' }), 409, /already revoked/);

    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'g-002', ap.t1, 'accepted', { underGrant: grantIri }) }), 409, /grant is not active: revoked at/);
    refused(await propose(w, ap, [withinGrant], 'P3c'), 409, /No active grant/);
    refused(await act(w, ANA, 'value_plan', { planIri: plan['planIri'], inputs: {} }), 409, /No active grant/);
    refused(await grant(BO), 409, /not earned/, /0 person-reviewed runs on model scripted-fixture since/);
  }, 120_000);

  it('copies every record naming or signed by the holder to the pod they name, idempotently; changed rows only; refuses the platform pod (400) and a signer of nothing (403)', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const p1 = String(ok(await propose(w, ap, [P1_CHANGES(ap)[0] as Obj], 'P1'))['planIri']);
    const p2 = String(ok(await propose(w, ap, [P1_CHANGES(ap)[1] as Obj], 'P2'))['planIri']);
    ok(await acknowledge(w, CY, p1, ap.t1, 'acknowledge'));
    refused(await act(w, ZED, 'holder_copy', { targetPodUrl: DEMO_HOLDER_POD }), 403, /names this address or carries its signature/);
    refused(await act(w, CY, 'holder_copy', { targetPodUrl: POD }), 400, /pod you hold/);
    refused(await act(w, CY, 'holder_copy', { targetPodUrl: 'ftp://198.51.100.7/cy/' }), 400, /http\(s\)/);

    const copied = ok(await act(w, CY, 'holder_copy', { targetPodUrl: DEMO_HOLDER_POD }));
    expect(copied['status']).toBe('copied');
    const copies = arr(copied['copied']);
    expect(copies.length).toBeGreaterThan(5);
    expect(copies.every((c) => c['skipped'] === false)).toBe(true);
    const kinds = new Set(arr(copied['bundle']).map((b) => `${String(b['recordKind'])}:${String(b['entityIri'])}`));
    expect(kinds.has(`Task:${ap.t1}`)).toBe(true);
    expect(kinds.has(`Task:${ap.t3}`)).toBe(true);
    expect(kinds.has(`Task:${ap.t2}`)).toBe(false);
    expect(kinds.has(`Workflow:${ap.workflowIri}`)).toBe(true);
    expect(kinds.has(`Classification:${entityIri('classification', ap.workflowIri, ap.t1)}`)).toBe(true);
    expect(kinds.has(`Plan:${p1}`)).toBe(true);
    expect(kinds.has(`Plan:${p2}`)).toBe(false);
    expect([...kinds].some((k) => k.startsWith('Acknowledgement:'))).toBe(true);
    expect([...kinds].some((k) => k.startsWith('HolderCopy:'))).toBe(false);

    const held = (await manifest(w, DEMO_HOLDER_POD)).filter((e) => e.descriptorUrl.startsWith(`${DEMO_HOLDER_POD}wrd/held/`));
    expect(held).toHaveLength(copies.length);
    const taskCopies = held.filter((e) => e.describes.includes(graphIriOf(ap.t1)));
    expect(taskCopies.length).toBeGreaterThanOrEqual(2);
    expect(taskCopies.filter((e) => (e.supersedes ?? []).length === 0)).toHaveLength(1);
    for (const e of held.slice(0, 6)) {
      const descTtl = String(w.pod.bodies.get(e.descriptorUrl));
      const graphUrl = must(parseDistributionFromDescriptorTurtle(descTtl)).accessURL;
      const region = digestedGraphRegion({ descriptorTurtle: descTtl, graphContent: w.pod.bodies.get(graphUrl) });
      expect(region.ok).toBe(true);
      const proof = must(parseAuthorshipProofFromDescriptorTurtle(descTtl));
      const v = await verifySignedAuthorship(proof, makeWalletDelegationVerifier(), { contentHash: region.ok ? must(canonicalGraphDigest(region.turtle)) : '' });
      expect([v.valid, v.contentBinding, proof.signerAddress.toLowerCase()]).toEqual([true, 'bound', addr(PLATFORM)]);
    }
    const again = ok(await act(w, CY, 'holder_copy', { targetPodUrl: DEMO_HOLDER_POD }));
    expect(arr(again['copied']).every((c) => c['skipped'] === true)).toBe(true);
    expect((await manifest(w, DEMO_HOLDER_POD)).filter((e) => e.descriptorUrl.startsWith(`${DEMO_HOLDER_POD}wrd/held/`))).toHaveLength(copies.length);

    const exported = ok(await act(w, ANA, 'holder_copy', {}));
    expect(exported).toMatchObject({ status: 'exported', targetPodUrl: null, copied: [] });
    expect(arr(exported['bundle']).some((b) => b['recordKind'] === 'Plan')).toBe(true);
    expect(arr((await list(w))['untrusted']).every((u) => !String(u['descriptorUrl']).startsWith(DEMO_HOLDER_POD))).toBe(true);
  }, 90_000);

  it('answers 502, not 200, when the pod refuses a write with 403', async () => {
    const w = await world();
    await register(w);
    w.pod.failWrites(true);
    const r = refused(await act(w, ANA, 'capture_workflow', {
      workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' },
      tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }],
    }), 502, /403/);
    expect(String(r['iep:refusalReason'])).toMatch(/did not accept/);
    w.pod.failWrites(false);
  });

  it('every refusal in this file answered >= 400 with kind refusal and an iep:refusalReason', () => {
    const fromBridge = refusalsSeen.filter((r) => r.status !== 404 || r.body['kind'] === 'refusal');
    expect(fromBridge.length).toBeGreaterThan(80);
    for (const r of fromBridge) {
      expect(r.status, `${r.tool} ${JSON.stringify(r.body).slice(0, 300)}`).toBeGreaterThanOrEqual(400);
      expect(r.body['kind'], r.tool).toBe('refusal');
      expect(typeof r.body['iep:refusalReason'], r.tool).toBe('string');
      expect(typeof r.body['error'], r.tool).toBe('string');
    }
    expect(new Set(fromBridge.map((r) => r.status))).toEqual(new Set([400, 401, 403, 404, 409, 422, 502]));
  });
});
