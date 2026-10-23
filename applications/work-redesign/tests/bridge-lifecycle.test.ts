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
 * earned and revoked grants, holder copies, pod failure, and every envelope refusal. Reads are
 * signed (the admin signs each read the tests make), as a production bridge requires; the
 * operator pod credential, the served-pods allowlist, sealed records, scoped reads, a pod keyed
 * under another record key or holding a version sealed to one, and figures counted from records
 * that do not open have their own cases at the end.
 */
import { describe, it, expect, afterAll } from 'vitest';
import {
  importWallet, signMessageRaw, canonicalJson, sha256Hex, canonicalGraphDigest, verifySignedAuthorship, makeWalletDelegationVerifier,
  ContextDescriptor, validate, deriveEncryptionKeyPair, type FetchFn, type Wallet, type IRI,
} from '@interego/core';
import {
  publish, fetchAllManifestEntries, predictManifestUrl, parseAuthorshipProofFromDescriptorTurtle, digestedGraphRegion,
  parseDistributionFromDescriptorTurtle,
} from '@interego/solid';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers, type WrdDeps } from '../bridge/handlers.js';
import {
  readRecord, publishRecord, verifyHolderBundle, operatorPodFetch, openPod, KeyedMutex, StaleHeadError, RecordNotSealableError, WRD_CONTAINER, SEALED_NO_KEY, SEALED_OTHER_KEY,
  DESCRIBES_ALTERED, SUBJECT_ALTERED, PROOF_ALTERED, DESCRIPTOR_UNPARSEABLE, PodView, type LoadedRecord,
} from '../bridge/pod-helpers.js';
import { LINKS_MORE_THAN_ONE } from '../bridge/descriptor-rdf.js';
import { memoryPod, demoClock, DEMO_POD, DEMO_HOLDER_POD, type MemoryPod, type DemoClock } from '../demo/run.js';
import { envelopeSha256, entityIri, entityIriKey, iriKeyFingerprint, recordKeyFingerprint, graphIriOf, buildDescriptor, recordIdFor, illFormedTextPath, type WrdRecord } from '../src/records.js';
import { parseEveryQueryPair } from '../bridge/ui.js';
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

async function world(extra: Partial<WrdDeps> | ((pod: MemoryPod) => Partial<WrdDeps>) = {}, affordances = wrdAffordances): Promise<World> {
  const pod = memoryPod();
  const clock = demoClock();
  const handlers = createWrdHandlers({
    fetchFn: pod.fetchFn, defaultPodUrl: POD, now: () => clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' },
    adminAddresses: [ADMIN.address], ...(typeof extra === 'function' ? extra(pod) : extra),
  });
  // Composed as bridge/server.ts composes it: every query parameter reaches the handlers.
  const app = createVerticalBridge({ verticalName: 'work-redesign', affordances, handlers, deploymentUrl: 'http://127.0.0.1', middleware: parseEveryQueryPair });
  const l = await listenLoopback(app);
  listeners.push(l);
  return { pod, clock, base: l.base, nonce: 0 };
}

/**
 * The pod seen through a gate that, while shut, fails every write of a workflow record's
 * resources (record slugs start `workflow-`) with `status`: a pod that fails part-way through a
 * call that writes a task and then its workflow. Reads, and every other record, pass. A 503 is
 * retried by the publish path until its budget runs out (a transient failure that outlasted the
 * retries, ~15 s); a 403 is not retried.
 */
interface WorkflowWriteGate { shut: boolean; status: 403 | 503; refused: number }
type PodFetch = NonNullable<WrdDeps['fetchFn']>;
const gatedWorkflowWrites = (fetchFn: PodFetch, gate: WorkflowWriteGate): PodFetch => async (url, init) => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (gate.shut && method !== 'GET' && method !== 'HEAD' && /\/workflow-[0-9a-f]{16}/.test(String(url))) {
    gate.refused += 1;
    return new Response('the workflow write failed', { status: gate.status, statusText: gate.status === 503 ? 'Service Unavailable' : 'Forbidden' });
  }
  return fetchFn(url, init);
};

/** Another bridge on the same pod and clock (another record key, or none), as the same operator otherwise. */
async function sibling(w: World, extra: Partial<WrdDeps>): Promise<World> {
  const handlers = createWrdHandlers({
    fetchFn: w.pod.fetchFn, defaultPodUrl: POD, now: () => w.clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' }, adminAddresses: [ADMIN.address], ...extra,
  });
  const l = await listenLoopback(createVerticalBridge({ verticalName: 'work-redesign', affordances: wrdAffordances, handlers, deploymentUrl: 'http://127.0.0.1', middleware: parseEveryQueryPair }));
  listeners.push(l);
  return { pod: w.pod, clock: w.clock, base: l.base, nonce: w.nonce + 200_000 };
}

// ── The operator's credential, the record key ────────────────────────────────────────────

const SECRET = 'operator-pod-write-secret-for-tests';
const K1 = deriveEncryptionKeyPair(sha256Hex('wrd-lifecycle:record-key-1'), 'wrd-records');
const K2 = deriveEncryptionKeyPair(sha256Hex('wrd-lifecycle:record-key-2'), 'wrd-records');
interface Seen { readonly url: string; readonly method: string; readonly auth: string | null; readonly redirect?: RequestRedirect }
/**
 * The pod as the gate serves it: reads pass, and a write under the operator's pod path without
 * the operator's credential is refused (401). Every request is recorded with its credential.
 */
const gatePod = (pod: MemoryPod, seen: Seen[]): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const auth = new Headers(init?.headers).get('authorization');
  seen.push({ url, method, auth, ...(init?.redirect ? { redirect: init.redirect } : {}) });
  if (url.startsWith(POD) && method !== 'GET' && method !== 'HEAD' && auth !== `Bearer ${SECRET}`) return new Response('no', { status: 401, statusText: 'Unauthorized' });
  return pod.fetchFn(url, init as Parameters<FetchFn>[1]);
}) as typeof fetch;
/** A record's sealed graph document, by following its descriptor's link. */
const sealedGraphUrl = (w: World, descriptorUrl: string): string => must(parseDistributionFromDescriptorTurtle(must(w.pod.bodies.get(descriptorUrl), 'descriptor')), 'distribution').accessURL;
/** Change one character of a sealed graph's ciphertext on the pod: what a party able to write the pod can do to it. */
function corruptSealed(w: World, url: string): void {
  const ciphertext = String(obj(obj(JSON.parse(must(w.pod.bodies.get(url), 'sealed graph')))['content'])['ciphertext']);
  w.pod.tamper(url, ciphertext, `${ciphertext.slice(0, 8)}${ciphertext.charAt(8) === 'A' ? 'B' : 'A'}${ciphertext.slice(9)}`);
}

/** A second bridge process on the same pod and clock, with its own (empty) in-process nonce ledger: a restart. */
async function restart(w: World): Promise<World> {
  const handlers = createWrdHandlers({
    fetchFn: w.pod.fetchFn, defaultPodUrl: POD, now: () => w.clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' }, adminAddresses: [ADMIN.address],
  });
  const l = await listenLoopback(createVerticalBridge({ verticalName: 'work-redesign', affordances: wrdAffordances, handlers, deploymentUrl: 'http://127.0.0.1', middleware: parseEveryQueryPair }));
  listeners.push(l);
  return { pod: w.pod, clock: w.clock, base: l.base, nonce: w.nonce + 100_000 };
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

/** A signed read (wrd:read-records), by the admin unless someone else is named. A read spends no nonce. */
async function readEnvelope(w: World, who: Wallet = ADMIN, opts: { issuedAt?: string; podUrl?: string } = {}): Promise<{ payload: Obj; signature: string }> {
  return envelope(w, who, 'wrd:read-records', {}, opts);
}
/** The read model through the signed read; `query` is the GET form's query string, kept so call sites read the same. */
const list = async (w: World, query = ''): Promise<Obj> =>
  ok(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w), ...Object.fromEntries(new URLSearchParams(query)) }), 'read_records');
const calibration = async (w: World, query = ''): Promise<Res> =>
  http(w, 'POST', 'read_calibration', { envelope: await readEnvelope(w), ...Object.fromEntries(new URLSearchParams(query)) });
/**
 * A payload template: with the admin's signed read as read_envelope in the POST body of
 * wrd.read_envelope_template (a signed read never goes in a URL), or, when `signed` is false, the
 * unsigned GET wrd.envelope_template. `query` is the GET form's query string either way.
 */
async function template(w: World, query: string, signed = true): Promise<Res> {
  if (!signed) return http(w, 'GET', 'envelope_template', undefined, `?${query}`);
  return http(w, 'POST', 'read_envelope_template', { ...Object.fromEntries(new URLSearchParams(query)), read_envelope: await readEnvelope(w) });
}
const taskRow = async (w: World, taskIri: string): Promise<Obj> => must(arr((await list(w))['tasks']).find((t) => t['taskIri'] === taskIri), `task ${taskIri}`);
/** The head binding a ratify or revise payload carries. */
const bound = (h: { descriptorUrl: string; graphDigest: string }): Obj => ({ descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest });
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

/** The task's textSha256 as the read model shows it (a placeholder when the task has no trusted row, e.g. after tampering). */
async function textOf(w: World, taskIri: string): Promise<string> {
  const row = arr((await list(w))['tasks']).find((t) => t['taskIri'] === taskIri);
  return row ? String(row['textSha256']) : '0'.repeat(64);
}
async function classify(w: World, who: Wallet, taskIri: string, answers: Obj): Promise<Res> {
  return act(w, who, 'classify_task', { taskIri, taskTextSha256: await textOf(w, taskIri), answers });
}
async function ratifyClassification(w: World, who: Wallet, taskIri: string, verdict: 'ratify' | 'dispute' = 'ratify', note?: string): Promise<Res> {
  const h = headOfRow(obj((await taskRow(w, taskIri))['classification'], 'classification'));
  return act(w, who, 'ratify_task', { subject: 'classification', taskIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...(note ? { note } : {}) });
}

/** Registry, the document-captured AP workflow, every task ratified by its people, classified by Ana, and those classifications ratified by the people named. */
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
  for (const [who, t] of [[CY, ap.t1], [DEE, ap.t2], [CY, ap.t3], [DEE, ap.t4]] as const) ok(await ratifyClassification(w, who, t));
  return ap;
}

type Basis = 'measured' | 'document' | 'performer-reported' | 'estimate' | 'not-applicable';
const tri = (low: number, likely: number, high: number, basis: Basis = 'estimate'): Obj => ({ low, likely, high, basis });
const one = (v: number, basis: Basis = 'measured'): Obj => tri(v, v, v, basis);
const STATE_ZERO: Obj = {
  performerHoursPerRun: one(0, 'not-applicable'), oversightHoursPerRun: one(0, 'not-applicable'), agentCostPerRun: one(0, 'not-applicable'),
  minorFailureRate: one(0, 'not-applicable'), minorFailureCost: one(0, 'not-applicable'), criticalFailureRate: one(0, 'not-applicable'), criticalFailureCost: one(0, 'not-applicable'),
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

/** Everyone a plan names acknowledges their assignment, so an approval needs no override. */
async function acknowledgeAll(w: World, planIri: string): Promise<void> {
  const plan = must(arr((await list(w))['plans']).find((p) => p['planIri'] === planIri), 'plan row');
  const who = new Map([[addr(CY), CY], [addr(DEE), DEE], [addr(ANA), ANA], [addr(ELI), ELI]]);
  for (const a of arr(plan['assignments'])) {
    if (a['state'] !== 'not-acknowledged') continue;
    ok(await acknowledge(w, must(who.get(String(a['personAddress'])), 'assignee'), planIri, String(a['taskIri']), 'acknowledge'), 'acknowledge');
  }
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

/**
 * Edits a party able to write the pod (without the record key) can make to a version's descriptor,
 * each with what it must read as: null when the version stays trusted, else why it is altered. Each
 * is applied to the descriptor as the bridge wrote it (`prev` is the version before's). None of them
 * may ever set a version aside: a version a trusted key signed where its proof says reads trusted or
 * altered, never as if it were deleted. The first group changes no triple (RDF-identical
 * respellings) or only a comment; the rest change what the bridge reads, or stop it parsing.
 */
function descriptorEdits(): Array<readonly [string, (d: string, prev: string) => string, string | null]> {
  const SUBJECT = /^<urn:wrd:record:[^>]+>\n {4}a iep:ContextDescriptor ;/m;
  const PROOF = /<> iep:authorshipProof \[[^\]]*\] \./;
  const IEP_IRI = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
  const PROOF_TERMS = /\biep:(authorshipProof|SignedAuthorship|scheme|issuer|verificationMethod|signerAddress|created|ownerWebId|descriptorId|agentDid|contentHash|proofValue)\b/g;
  const UNUSED_PREFIX = '@prefix café: <urn:unused#> .\n';
  const take = (re: RegExp, text: string): string => must(re.exec(text), String(re))[0];
  const commented = (block: string): string => block.split('\n').map((l) => `# ${l}`).join('\n');
  const atSubject = (d: string, f: (subject: string) => string): string => d.replace(take(SUBJECT, d), f(take(SUBJECT, d)));
  const atProof = (d: string, f: (proof: string) => string): string => d.replace(take(PROOF, d), f(take(PROOF, d)));
  const fullIris = (p: string): string => p.replace(PROOF_TERMS, (_, n: string) => `<${IEP_IRI}${n}>`);
  const escaped = (text: string): string => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  return [
    // Respellings and comments: the same RDF, read the same way.
    ['a leading space before the subject line', (d) => atSubject(d, (x) => ` ${x}`), null],
    ['the subject joined to its type line', (d) => atSubject(d, (x) => x.replace('>\n    a ', '> a ')), null],
    ['a comment between the subject and its type', (d) => atSubject(d, (x) => x.replace('>\n    a ', '>\n    # typed below ]\n    a ')), null],
    ['rdf:type for a', (d) => atSubject(d, (x) => x.replace('    a iep:', '    rdf:type iep:')), null],
    ['CRLF line ends', (d) => d.split('\n').join('\r\n'), null],
    ['the proof moved above the subject', (d) => { const p = take(PROOF, d); return atSubject(d.replace(p, ''), (x) => `${p}\n\n${x}`); }, null],
    ['a comment naming iep:authorshipProof [ above it', (d) => atSubject(d, (x) => `# see iep:authorshipProof [ below ]\n${x}`), null],
    ['a comment opening iep:authorshipProof [ with a forged proofValue, never closed, right above the real proof', (d) => atProof(d, (p) => `# iep:authorshipProof [ iep:proofValue "0x${'ab'.repeat(65)}" ;\n${p}`), null],
    ['a ] comment inside the real proof', (d) => atProof(d, (p) => p.replace('a iep:SignedAuthorship ;\n', 'a iep:SignedAuthorship ;\n    # the block ] ends below\n')), null],
    ['the real proof spelled with full IRIs', (d) => atProof(d, fullIris), null],
    ['the version before\'s genuine proof in a comment above the real one', (d, prev) => atProof(d, (p) => `${commented(take(PROOF, prev))}\n${p}`), null],
    ['a \\u escape in the proof\'s record id', (d) => atProof(d, (p) => p.replace('iep:descriptorId <u', 'iep:descriptorId <\\u0075')), null],
    ['a \\u escape in the proof\'s issuer', (d) => atProof(d, (p) => p.replace('iep:issuer <d', 'iep:issuer <\\U00000064')), null],
    ['the proofValue spelled in \\u escapes', (d) => atProof(d, (p) => p.replace(/iep:proofValue "([^"]+)"/, (_, v: string) => `iep:proofValue "${escaped(v)}"`)), null],
    ['the created instant in a long single-quoted literal', (d) => atProof(d, (p) => p.replace(/iep:created "([^"]+)"/, "iep:created '''$1'''")), null],
    ['an unused prefix with a non-ASCII name', (d) => `${UNUSED_PREFIX}${d}`, null],
    ['that prefix, and the proof spelled with full IRIs', (d) => `${UNUSED_PREFIX}${atProof(d, fullIris)}`, null],
    ['that prefix, and the proofValue single-quoted', (d) => `${UNUSED_PREFIX}${atProof(d, (p) => p.replace(/iep:proofValue "([^"]+)"/, "iep:proofValue '$1'"))}`, null],
    ['that prefix, and the proof under another prefix name', (d) => `@prefix prüf: <${IEP_IRI}> .\n${UNUSED_PREFIX}${atProof(d, (p) => p.replace(PROOF_TERMS, (_, n: string) => `prüf:${n}`))}`, null],
    ['the proof as a labelled blank node over separate statements', (d) => atProof(d, (p) => p.replace('<> iep:authorshipProof [', '<> iep:authorshipProof _:proof .\n_:proof').replace(/\n\] \.$/, ' .')), null],
    ['a comment holding a decoy link to another graph above the real link', (d) => d.replace('<> iep:affordance [', '# iep:affordance [ hydra:target <https://elsewhere.example/x> ; dcat:mediaType "text/plain" ]\n<> iep:affordance ['), null],
    ['a comment naming another graph with iep:describes, at the top', (d) => `# iep:describes <urn:wrd:task:elsewhere:graph>\n${d}`, null],
    ['hydra:target and dcat:accessURL written as full IRIs', (d) => d.replace('hydra:target <', '<http://www.w3.org/ns/hydra/core#target> <').replace('dcat:accessURL <', '<http://www.w3.org/ns/dcat#accessURL> <'), null],
    ['iep:describes written as a full IRI', (d) => d.replace('iep:describes <', `<${IEP_IRI}describes> <`), null],
    // An unsigned triple, or a subject, added: what the bridge reads is unchanged.
    ['a literal holding ] inside the real proof', (d) => atProof(d, (p) => p.replace('a iep:SignedAuthorship ;\n', 'a iep:SignedAuthorship ;\n    <http://www.w3.org/2000/01/rdf-schema#comment> "the block ] ends below" ;\n')), null],
    ['another descriptor subject above it', (d) => atSubject(d, (x) => `<urn:wrd:note:above>\n    a iep:ContextDescriptor .\n\n${x}`), null],
    // What the bridge reads, changed: altered (409), never set aside.
    ['the version before\'s genuine proof as RDF above the real one', (d, prev) => atProof(d, (p) => `${take(PROOF, prev)}\n${p}`), PROOF_ALTERED],
    ['the real proof only in a comment', (d) => atProof(d, (p) => commented(p)), PROOF_ALTERED],
    ['the real proof only in a comment, spelled with full IRIs', (d) => atProof(d, (p) => commented(fullIris(p))), PROOF_ALTERED],
    ['the proof\'s signerAddress changed', (d) => atProof(d, (p) => p.replace(/iep:signerAddress "0x[0-9a-fA-F]{40}"/, `iep:signerAddress "0x${'1'.repeat(40)}"`)), PROOF_ALTERED],
    ['the subject changed', (d) => atSubject(d, (x) => x.replace('<urn:wrd:record:', '<urn:wrd:record:changed-')), SUBJECT_ALTERED],
    ['a second link, to a graph elsewhere, stated as RDF', (d) => `${d}\n<> iep:affordance [ hydra:target <https://elsewhere.example/x> ; dcat:mediaType "text/plain" ] .\n`, LINKS_MORE_THAN_ONE],
    ['a stray } above the subject, so it no longer parses', (d) => atSubject(d, (x) => `}\n${x}`), DESCRIPTOR_UNPARSEABLE],
    ['a stray } above, and the proof spelled with full IRIs', (d) => `}\n${atProof(d, fullIris)}`, DESCRIPTOR_UNPARSEABLE],
    ['a stray } above, and the proofValue spelled in \\u escapes', (d) => `}\n${atProof(d, (p) => p.replace(/iep:proofValue "([^"]+)"/, (_, v: string) => `iep:proofValue "${escaped(v)}"`))}`, DESCRIPTOR_UNPARSEABLE],
  ];
}

// ── The tests ────────────────────────────────────────────────────────────────────────────

describe('work-redesign bridge', () => {
  it('mounts a handler for every production affordance; a production composition neither advertises nor routes demo_envelope', async () => {
    const production = createWrdHandlers({ platform: { wallet: PLATFORM, keyKind: 'configured' } });
    for (const a of wrdAffordances) expect(typeof production[a.toolName], a.toolName).toBe('function');
    expect(production['wrd.demo_envelope']).toBeUndefined();
    expect(wrdAffordances.map((a) => a.toolName)).not.toContain('wrd.demo_envelope');
    expect(new Set(wrdAffordances.map((a) => a.toolName)).size).toBe(22);

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
    // The demo clock moves only on a composition that has one to move.
    refused(await http(demo, 'POST', 'demo_advance_clock', { weeks: 2 }), 501, /no scripted clock/);
    const ticking = await world({ demoPersonas: new Map([['ana', { id: 'ana', label: 'Ana (demo)', wallet: ANA }]]), demoClockAdvance: () => undefined }, [...wrdAffordances, ...wrdDemoAffordances]);
    expect(ok(await http(ticking, 'POST', 'demo_advance_clock', { weeks: 2 }))).toMatchObject({ movedWeeks: 2, scriptedLabel: DEMO_LABEL });
    refused(await http(ticking, 'POST', 'demo_advance_clock', { weeks: 0 }), 400);
    expect(production['wrd.demo_advance_clock']).toBeUndefined();
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
    const cal = ok(await calibration(w));
    expect(obj(cal['grantPolicy'])['minSamples']).toBe(25);

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
    ok(await ratifyClassification(w, CY, t5));
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

  it('a retirement whose workflow write failed is finished by retiring again: the retry repairs the workflow, naming the earlier retirement, and decision submission proceeds; a failed add leaves an orphan that blocks nothing', async () => {
    const gate: WorkflowWriteGate = { shut: false, status: 403, refused: 0 };
    const w = await world((pod) => ({ fetchFn: gatedWorkflowWrites(pod.fetchFn, gate) }));
    const ap = await standardAp(w);
    const wfRow = async (): Promise<Obj> => must(arr((await list(w))['workflows']).find((x) => x['workflowIri'] === ap.workflowIri), 'workflow row');
    const add = async (): Promise<Res> => {
      const h = headOfRow(await wfRow());
      return act(w, ANA, 'revise_task', {
        op: 'add', workflowIri: ap.workflowIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest,
        task: { name: 'Reconcile supplier statements', description: 'Monthly.', currentLevel: 'person', personAddress: CY.address, taskKind: 'invoice-matching' },
      });
    };

    // An add whose workflow write fails: the task record lands unlisted, and the answer says so instead of a bare 502.
    gate.shut = true;
    const lostAdd = refused(await add(), 502, /workflow does not list it/, /shows as orphaned.*403/);
    gate.shut = false;
    expect(gate.refused).toBeGreaterThan(0);
    expect(obj(lostAdd['iep:resolvedBy'])).toMatchObject({ toolName: 'wrd.revise_task', op: 'add', workflowIri: ap.workflowIri });
    const orphan = String(must(arr((await list(w))['tasks']).find((t) => t['orphaned'] === true), 'orphaned task')['taskIri']);
    expect(arr((await wfRow())['taskIris'])).toHaveLength(4);
    // Adding again takes the next free index; the orphan is in nobody's way.
    const t5 = String(ok(await add(), 'add again')['taskIri']);
    expect(t5).not.toBe(orphan);
    expect(arr((await wfRow())['taskIris'])).toEqual([ap.t1, ap.t2, ap.t3, ap.t4, t5]);

    // A retirement whose workflow write fails: the task is retired, the workflow still lists it, and the answer names the call that finishes it.
    const t5Captured = headOfRow(await taskRow(w, t5));
    const retire = (who: Wallet, h: { descriptorUrl: string; graphDigest: string }): Promise<Res> =>
      act(w, who, 'revise_task', { op: 'retire', taskIri: t5, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, why: 'Moved to the treasury team' });
    const refusedBefore = gate.refused;
    gate.status = 503;
    gate.shut = true;
    const lost = refused(await retire(ANA, t5Captured), 502, /retired, but its workflow still lists it/, /503/);
    gate.shut = false;
    expect(gate.refused).toBeGreaterThan(refusedBefore);
    const t5Retired = headOfRow(await taskRow(w, t5));
    expect(obj(lost['iep:resolvedBy'])).toEqual({
      action: 'urn:iep:action:wrd:revise-task', toolName: 'wrd.revise_task', op: 'retire', taskIri: t5, descriptorUrl: t5Retired.descriptorUrl, graphDigest: t5Retired.graphDigest,
    });
    expect(await taskRow(w, t5)).toMatchObject({ status: 'retired', retirementUnfinished: true, orphaned: false, head: { modalStatus: 'Retracted' } });
    expect(arr((await wfRow())['taskIris'])).toContain(t5);

    // While the workflow lists a retired task nothing is proposed on it, and the refusal points at the repair, not at
    // classifying the task (which a retired task refuses: the dead end this replaces).
    const blocked = refused(await propose(w, ap, P1_CHANGES(ap), 'P1'), 409, /retired, but its workflow still lists it/, new RegExp(`retired by did:ethr:${addr(ANA)}`));
    expect(obj(blocked['iep:resolvedBy'])).toMatchObject({ toolName: 'wrd.revise_task', op: 'retire', taskIri: t5, descriptorUrl: t5Retired.descriptorUrl });
    refused(await classify(w, ANA, t5, ANSWERS.evident), 409, /retired/);
    refused(await template(w, `intent=wrd:propose-allocation&workflow_iri=${encodeURIComponent(ap.workflowIri)}`), 409, /still lists it/);
    // The template for the repair is the retirement, bound to the retired version.
    const tpl = obj(ok(await template(w, `intent=wrd:revise-task&task_iri=${encodeURIComponent(t5)}`))['template']);
    expect(tpl).toMatchObject({ op: 'retire', taskIri: t5, descriptorUrl: t5Retired.descriptorUrl, graphDigest: t5Retired.graphDigest, why: null });
    // Unsigned, with reads closed, neither branches on the retirement: the proposal template is the plain one, and op is left to fill.
    expect(obj(ok(await template(w, `intent=wrd:propose-allocation&workflow_iri=${encodeURIComponent(ap.workflowIri)}`, false))['template'])).toMatchObject({ workflowIri: ap.workflowIri, title: null });
    expect(obj(ok(await template(w, `intent=wrd:revise-task&task_iri=${encodeURIComponent(t5)}`, false))['template'])).toMatchObject({ op: null, taskIri: t5, descriptorUrl: t5Retired.descriptorUrl });

    // A head that is neither the retired version nor the one it retired is refused, pointing at the retired one.
    const moved = refused(await retire(ELI, { descriptorUrl: t5Retired.descriptorUrl, graphDigest: t5Captured.graphDigest }), 409, /changed since you read it/);
    expect(obj(moved['iep:resolvedBy'])).toMatchObject({ op: 'retire', descriptorUrl: t5Retired.descriptorUrl });
    // Retried by another operator with a fresh envelope over the version the first request bound: only the workflow is
    // written, signed by the retrier, recorded as a repair naming the retirement it finishes.
    const repairs = { taskDescriptorUrl: t5Retired.descriptorUrl, retiredBy: `did:ethr:${addr(ANA)}` };
    const repaired = ok(await retire(ELI, t5Captured), 'repair');
    expect(repaired).toMatchObject({ op: 'retire', taskIri: t5, status: 'retired', repaired: true, recorded: true, descriptorUrl: t5Retired.descriptorUrl, repairs });
    const wf = await wfRow();
    expect(wf['taskIris']).toEqual([ap.t1, ap.t2, ap.t3, ap.t4]);
    expect(wf['retiredTaskIris']).toEqual([t5]);
    expect(wf['revision']).toMatchObject({ op: 'retire', taskIri: t5, by: `did:ethr:${addr(ELI)}`, repairs });
    expect(obj(wf['head'])['descriptorUrl']).toBe(repaired['workflowDescriptorUrl']);
    expect(obj(wf['head'])['signedBy']).toEqual([`did:ethr:${addr(ELI)}`]);
    expect(await taskRow(w, t5)).toMatchObject({ status: 'retired', retirementUnfinished: false, head: { descriptorUrl: t5Retired.descriptorUrl } });
    // Once finished, retiring again is the plain refusal, and the template no longer offers it.
    refused(await retire(ELI, t5Retired), 409, /was retired/, /already retired/);
    expect(obj(ok(await template(w, `intent=wrd:revise-task&task_iri=${encodeURIComponent(t5)}`))['template'])['op']).toBe('revise');

    // The orphan is retired the ordinary way and is then listed as retired, no longer orphaned.
    const o = headOfRow(await taskRow(w, orphan));
    ok(await act(w, ANA, 'revise_task', { op: 'retire', taskIri: orphan, descriptorUrl: o.descriptorUrl, graphDigest: o.graphDigest, why: 'Recorded by an add whose workflow write failed' }));
    expect(await taskRow(w, orphan)).toMatchObject({ status: 'retired', orphaned: false, retirementUnfinished: false });
    expect((await wfRow())['retiredTaskIris']).toEqual([t5, orphan]);

    // And the decision goes through.
    const planIri = String(ok(await propose(w, ap, P1_CHANGES(ap), 'P1'), 'propose after the repair')['planIri']);
    const valuation = ok(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }), 'value');
    await acknowledgeAll(w, planIri);
    expect(await submitValued(w, planIri, valuation)).toMatchObject({ status: 'submitted', recorded: true });
  }, 90_000);

  it('a plan that changes a task whose retirement did not reach the workflow is refused at valuation, submission and approval with the call that finishes it; once finished, propose again', async () => {
    const gate: WorkflowWriteGate = { shut: false, status: 403, refused: 0 };
    const w = await world((pod) => ({ fetchFn: gatedWorkflowWrites(pod.fetchFn, gate) }));
    const { ap, planIri, valuation } = await valuedP1(w);
    await acknowledgeAll(w, planIri);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    const t2Captured = headOfRow(await taskRow(w, ap.t2));
    gate.shut = true;
    refused(await act(w, ANA, 'revise_task', { op: 'retire', taskIri: ap.t2, ...bound(t2Captured), why: 'Coding moves to the shared-services centre' }), 502, /still lists it/);
    gate.shut = false;
    const t2Retired = headOfRow(await taskRow(w, ap.t2));
    const finish = { toolName: 'wrd.revise_task', op: 'retire', taskIri: ap.t2, descriptorUrl: t2Retired.descriptorUrl, graphDigest: t2Retired.graphDigest };
    // Never "must be ratified" (pointing at a ratification a retired task refuses): the refusal names the call that finishes the retirement.
    const v = refused(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }), 409, /still lists it/);
    expect(obj(v['iep:resolvedBy'])).toMatchObject(finish);
    const s = refused(await act(w, ANA, 'submit_decision', {
      planIri, valuationIri: valuation['valuationIri'], valuationHash: valuation['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'before-after', windowWeeks: 8 },
    }), 409, /still lists it/);
    expect(obj(s['iep:resolvedBy'])).toMatchObject(finish);
    const c = refused(await countersign(w, BO, decisionIri, 'approve', { objectionsConsidered: [], unacknowledgedConsidered: [] }), 409, /still lists it/);
    expect(obj(c['iep:resolvedBy'])).toMatchObject(finish);
    expect(arr((await list(w))['plans']).find((p) => p['planIri'] === planIri)?.['stale']).toBe('A task in this plan was retired; propose again.');
    // Finished by retiring again, bound to the retired version this time; the envelope that retired it cannot be replayed to finish it.
    expect(ok(await act(w, ANA, 'revise_task', { op: 'retire', taskIri: ap.t2, ...bound(t2Retired), why: 'Finishing the retirement' }))).toMatchObject({ repaired: true });
    refused(await act(w, ANA, 'submit_decision', {
      planIri, valuationIri: valuation['valuationIri'], valuationHash: valuation['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'before-after', windowWeeks: 8 },
    }), 409, /retired; propose again/);
    const after = refused(await countersign(w, BO, decisionIri, 'approve', { objectionsConsidered: [], unacknowledgedConsidered: [] }), 409, /retired; propose again/);
    expect(obj(after['iep:resolvedBy'])['toolName']).toBe('wrd.propose_allocation');
    expect(ok(await propose(w, ap, [must(P1_CHANGES(ap)[0])], 'P1 without T2'))['changedTasks']).toEqual([ap.t1]);
  }, 90_000);

  it('the envelope that retired a task cannot be replayed after a restart to finish the retirement', async () => {
    const gate: WorkflowWriteGate = { shut: false, status: 403, refused: 0 };
    const w = await world((pod) => ({ fetchFn: gatedWorkflowWrites(pod.fetchFn, gate) }));
    await register(w);
    const captured = ok(await act(w, ANA, 'capture_workflow', {
      workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' },
      tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }],
    }));
    const t = String(arr(captured['tasks'])[0]?.['taskIri']);
    const h = headOfRow(await taskRow(w, t));
    const original = await envelope(w, ANA, 'wrd:revise-task', { op: 'retire', taskIri: t, ...bound(h), why: 'Folded into the close checklist' });
    gate.shut = true;
    refused(await http(w, 'POST', 'revise_task', { envelope: original }), 502, /still lists it/);
    gate.shut = false;
    const fresh = await restart(w);
    refused(await http(fresh, 'POST', 'revise_task', { envelope: original }), 409, /already used/);
    expect(await taskRow(fresh, t)).toMatchObject({ status: 'retired', retirementUnfinished: true });
    expect(ok(await act(fresh, ANA, 'revise_task', { op: 'retire', taskIri: t, ...bound(h), why: 'Folded into the close checklist' }))).toMatchObject({ repaired: true });
    expect(await taskRow(fresh, t)).toMatchObject({ retirementUnfinished: false });
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
    // An agent goes on work only once the people named have ratified how knowable it is.
    refused(await propose(w, ap, [must(P1_CHANGES(ap)[0])]), 409, /ratified how knowable it is/);
    ok(await ratifyClassification(w, CY, ap.t1));
    ok(await ratifyClassification(w, DEE, ap.t2));
    refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT.address }]), 409, /No active grant/);
    refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'agent-drafts-person-decides', agentAddress: CY.address, personAddress: CY.address }]), 400, /registered software agent/);
    const probe = { hypothesis: 'An agent-drafted reply settles disputes sooner', amplifyIf: 'median days to settle falls', dampenIf: 'suppliers escalate more', timeboxWeeks: 4 };
    refused(await propose(w, ap, [{ taskIri: ap.t3, proposedLevel: 'person-with-agent-assist', personAddress: CY.address, probes: [probe] }, P1_CHANGES(ap)[0] as Obj]), 409, /separate plans/);
    refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'person', personAddress: CY.address }]), 409, /changes nothing/);
    refused(await act(w, CY, 'propose_allocation', { workflowIri: ap.workflowIri, title: 'x', changes: P1_CHANGES(ap) }), 403);
    expect(ok(await propose(w, ap, P1_CHANGES(ap)))['planKind']).toBe('valued');
  }, 60_000);

  it('values a Knowable change only with expert evidence: who answered the questions, never an input basis the operator typed', async () => {
    const w = await world();
    const ap = await standardAp(w);
    // Eli, an operator only, re-classifies T2: not expert evidence, and nobody named on it has ratified it.
    expect(ok(await classify(w, ELI, ap.t2, ANSWERS.knowable))).toMatchObject({ answeredBy: { role: 'operator' }, status: 'classified' });
    // A change on T2 that names no agent, so it can be proposed on an unratified classification.
    const t2NoAgent: Obj = { taskIri: ap.t2, proposedLevel: 'person-with-agent-assist', personAddress: DEE.address };
    const planIri = String(ok(await propose(w, ap, [must(P1_CHANGES(ap)[0]), t2NoAgent]))['planIri']);
    // The review's reproduction: labelling every current input "performer-reported" is the operator's own typing, not expert evidence.
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap, 'performer-reported') }), 409, /Knowable work is valued only with expert analysis/);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: { ...p1Inputs(ap), currency: 'usd' } }), 400, /valuation inputs are malformed/, /currency/);
    // Dee, named on T2, ratifies Eli's answers: a classification everyone named has ratified.
    ok(await ratifyClassification(w, DEE, ap.t2));
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }), 409, /re-classified or revised after this plan/);
    const p2 = String(ok(await propose(w, ap, [must(P1_CHANGES(ap)[0]), t2NoAgent], 'P1 again'))['planIri']);
    const v = ok(await act(w, ANA, 'value_plan', { planIri: p2, inputs: p1Inputs(ap) }));
    expect(v['expertEvidence']).toEqual([{ taskIri: ap.t2, satisfiedBy: 'ratified-classification' }]);
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
    const again = ok(await act(w, ANA, 'value_plan', { planIri: p2, inputs: p1Inputs(ap) }));
    expect(again).toMatchObject({ reused: true, valuationHash: v['valuationHash'], valuationIri: v['valuationIri'] });

    ok(await classify(w, DEE, ap.t2, ANSWERS.knowable));
    const p3 = String(ok(await propose(w, ap, [must(P1_CHANGES(ap)[0]), t2NoAgent], 'P1 third'))['planIri']);
    expect(ok(await act(w, ANA, 'value_plan', { planIri: p3, inputs: p1Inputs(ap, 'estimate') }))['expertEvidence']).toEqual([{ taskIri: ap.t2, satisfiedBy: 'performer-answers' }]);
  }, 60_000);

  it('blocks valuation on a disputed task and submission on an unratified one (409)', async () => {
    const w = await world();
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t3));
    ok(await ratify(w, DEE, ap.t4));
    for (const [t, a] of [[ap.t1, ANSWERS.evident], [ap.t2, ANSWERS.knowable], [ap.t3, ANSWERS.emergent], [ap.t4, ANSWERS.turbulent]] as const) ok(await classify(w, ANA, t, a));
    ok(await ratifyClassification(w, CY, ap.t1));
    ok(await ratifyClassification(w, DEE, ap.t2));
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

    await acknowledgeAll(w, planIri);
    const approved = ok(await countersign(w, BO, decisionIri, 'approve'));
    expect(approved).toMatchObject({ status: 'countersigned', statusLabel: 'approved; prediction unmeasured' });
    const csRow = await decisionRow(w, decisionIri);
    const csAt = String(obj(csRow['countersign'])['at']);
    const graph = String(w.pod.bodies.get(String(obj(csRow['head'])['descriptorUrl']).replace('.ttl', '-graph.trig')));
    expect(graph).toContain('wrd:predictionStatus "unmeasured"');

    // Two person-reviewed runs on T1 inside the window: the pilot check counts these, not what the grader types.
    await logReviewedRun(w, 'pilot-1', ap.t1, 'accepted', ELI, 'accepted');
    await logReviewedRun(w, 'pilot-2', ap.t1, 'accepted', FAY, 'accepted');
    w.clock.advance(9 * WEEK);
    const windowEnd = plusWeeks(csAt, 8);
    const factor = meanRampFactor(0, monthsBetween(csAt, windowEnd), Number(prediction['rampMonths']));
    expect(factor).toBeLessThan(1);
    const measured = Number(band['p50']) * factor;
    const fields = (m: Obj): Obj => ({ disposition: 'kept', measured: { weeklyValueDelta: measured, comparisonBasis: 'staggered', windowStart: csAt, windowEnd, method: 'Staggered roll-out across two AP teams', ...m } });
    // One hour, chosen by the grader: a kept change is measured over the whole declared window.
    refused(await recordOutcome(w, ELI, decisionIri, fields({ windowEnd: new Date(Date.parse(csAt) + 3_600_000).toISOString() })), 409, /shorter than the plan declared/, /declared 8/);
    const outcome = ok(await recordOutcome(w, ELI, decisionIri, fields({ runsObserved: 500, criticalFailuresObserved: 0 })));
    expect(outcome).toMatchObject({ status: 'measured', disposition: 'kept' });
    expect(obj(outcome['valued'])).toMatchObject({
      verdict: 'in-band', rampAdjusted: true, comparisonGroup: true, windowShorterThanPlanned: false, countsTowardCalibration: true,
      pilotCheck: { runsNeeded: 300, reviewedRuns: 2, criticalFailures: 0, ceilingSupported: false, declared: { runsObserved: 500, criticalFailuresObserved: 0 } },
    });

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

    const cal = ok(await calibration(w, '?kind=predictions'));
    const cell = must(arr(cal['predictionCells']).find((c) => c['kind'] === 'prediction:weekly-cash-delta:agent-drafts-person-decides:controlled'));
    expect(cell).toMatchObject({ samples: 1, hitRate: 1, status: 'Hypothetical', rampAdjusted: 1, scriptedLabel: null });
    const t1 = await taskRow(w, ap.t1);
    expect(obj(t1['effective'])).toMatchObject({ level: 'agent-drafts-person-decides', source: 'measured-decision', decisionIri });
    const d = await decisionRow(w, decisionIri);
    expect(arr(d['preparedBy']).map((x) => [x['role'], x['personRef']])).toEqual([['proposed', 'p-ana'], ['valued', 'p-ana'], ['submitted', 'p-ana']]);
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
    refused(await recordOutcome(w, BO, decisionIri, { disposition: 'kept', measured }), 403, /approved a decision cannot grade it/);
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
    refused(await countersign(w, BO, decisionIri, 'approve'), 409, /has not acknowledged their assignment/);
    expect(ok(await countersign(w, BO, decisionIri, 'approve', { unacknowledgedConsidered: [ap.t3] }))['statusLabel']).toBe('approved; probes not yet read');
    expect(obj((await decisionRow(w, decisionIri))['countersign'])['unacknowledgedConsidered']).toEqual([ap.t3]);
    const csAt = String(obj((await decisionRow(w, decisionIri))['countersign'])['at']);
    w.clock.advance(5 * WEEK);
    const result = (index: number, signal: string): Obj => ({ taskIri: ap.t3, index, signal, observed: 'Read from the dispute log', windowStart: csAt, windowEnd: plusWeeks(csAt, 4) });
    refused(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', probeResults: [result(1, 'amplify')] }), 400, /one result per declared probe/);
    const measured = ok(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', probeResults: [result(1, 'amplify'), result(2, 'neither')] }));
    expect(measured).toMatchObject({ status: 'measured', next: 'Re-classify this task, then propose a plan.' });
    expect(arr(measured['probes']).map((p) => p['signal'])).toEqual(['amplify', 'neither']);
    const signals = obj(ok(await calibration(w, '?kind=probes'))['probeSignals']);
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

    const cal = ok(await calibration(w, '?kind=agents'));
    const cell = must(arr(cal['agentCells']).find((c) => c['taskKind'] === 'invoice-matching'));
    expect(cell).toMatchObject({ samples: 2, model: 'scripted-fixture', currentModel: true, distinctConfirmers: 2, status: 'Hypothetical', agentAddress: addr(AGENT), principal: addr(ANA) });
    const runs = arr((await list(w, '?kind=runs'))['runs']);
    expect(runs).toEqual([{ agentAddress: addr(AGENT), taskKind: 'invoice-matching', model: 'scripted-fixture', reviewed: 2, actedUnderGrant: 0, reportedCost: { runs: 1, mean: 0.12, currency: 'USD', basis: 'agent-reported on person-reviewed runs' } }]);
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

    // A grant is held on the kind of task; acting alone on T1 needs a decision that puts T1 there.
    const early = await runEnvelope(w, 'g-000', ap.t1, 'accepted', { underGrant: grantIri });
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: early }), 409, /No approved decision puts this task at agent-acts-within-grant/);
    const p3Inputs: Obj = {
      currency: 'USD', unitsPerWeek: { current: tri(180, 200, 220, 'measured') }, valuePerUnit: tri(5, 6, 7), hourlyCost: tri(38, 42, 46, 'document'),
      oneOffCost: tri(1000, 2000, 3000), horizonMonths: 24, rampMonths: 1, annualDiscountRate: 0.08, criticalFailureCeiling: 0.01,
      freedHours: { [ap.t1]: { disposition: 'absorbed' } },
      tasks: { [ap.t1]: { runsPerUnit: one(1), current: state({ performerHoursPerRun: tri(0.15, 0.2, 0.3, 'measured') }), proposed: state({ agentCostPerRun: tri(0.08, 0.12, 0.2) }) } },
    };
    const v3 = ok(await act(w, ANA, 'value_plan', { planIri: plan['planIri'], inputs: p3Inputs }));
    const d3 = String((await submitValued(w, String(plan['planIri']), v3))['decisionIri']);
    refused(await countersign(w, ANA2, d3, 'approve'), 403);
    ok(await countersign(w, BO, d3, 'approve'));
    expect(obj((await taskRow(w, ap.t1))['effective'])).toMatchObject({ level: 'agent-acts-within-grant', source: 'approved-decision', decisionIri: d3, grant: { active: true }, suspended: false });
    // Under the grant the agent acts alone only on what it calls ready.
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'g-rw', ap.t1, 'reworked', { underGrant: grantIri }) }), 409, /Route it to a person/);
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
    refused(await act(w, BO, 'revoke_grant', { grantIri, recordId: gh.recordId, descriptorUrl: gh.descriptorUrl, why: 'no digest bound' }), 400, /malformed/, /graphDigest/);
    const revoked = ok(await act(w, BO, 'revoke_grant', { grantIri, recordId: gh.recordId, descriptorUrl: gh.descriptorUrl, graphDigest: gh.graphDigest, why: 'Supplier master data migrated; re-earn on the new data' }));
    expect(revoked['status']).toBe('revoked');
    const revokedRow = must(arr((await list(w, '?kind=grants'))['grants']).find((g) => g['grantIri'] === grantIri));
    const head = obj(revokedRow['head']);
    expect(head['modalStatus']).toBe('Retracted');
    expect(head['validFrom']).toBe(revokedRow['grantedAt']);
    expect(head['validUntil']).toBe(revoked['revokedAt']);
    expect(revokedRow).toMatchObject({ status: 'revoked', active: false });
    refused(await act(w, BO, 'revoke_grant', { grantIri, recordId: String(head['recordId']), descriptorUrl: String(head['descriptorUrl']), graphDigest: String(head['graphDigest']), why: 'again' }), 409, /already revoked/);
    // Work the decision put under the grant now has no authorised performer, and says so.
    const suspended = obj((await taskRow(w, ap.t1))['effective']);
    expect(suspended).toMatchObject({ level: 'agent-acts-within-grant', source: 'approved-decision', grant: { active: false }, suspended: true });
    expect(String(suspended['suspendedWhy'])).toMatch(/^grant revoked at \S+: this work has no authorised performer until a new decision changes it$/);

    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'g-002', ap.t1, 'accepted', { underGrant: grantIri }) }), 409, /grant is not active: revoked at/);
    refused(await propose(w, ap, [withinGrant], 'P3c'), 409, /No active grant/);
    refused(await act(w, ANA, 'value_plan', { planIri: plan['planIri'], inputs: {} }), 409, /No active grant/);
    refused(await grant(BO), 409, /not earned/, /0 person-reviewed runs on model scripted-fixture since/);
  }, 120_000);

  it('copies every record naming or signed by the holder to the pod they name, idempotently; changed rows only; refuses the platform pod (400) and a signer of nothing (403); a download verifies offline against the expected platform address', async () => {
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

    // The download verifies offline — no pod, no bridge — against the platform address list_records reports.
    const platformAddress = String(obj(obj(obj(await list(w))['bridge'])['platform'])['address']);
    expect(platformAddress).toBe(addr(PLATFORM));
    const downloaded = JSON.parse(JSON.stringify({ holder: exported['holder'], bundle: exported['bundle'] })) as Obj;
    const good = await verifyHolderBundle(downloaded, [platformAddress]);
    expect(good.ok).toBe(true);
    expect(good.records).toHaveLength(arr(exported['bundle']).length);
    expect(good.records.every((r) => r.verified && r.signerAddress === addr(PLATFORM))).toBe(true);
    // The wrong expected key, no expected key, and one altered byte are each caught.
    const wrongKey = await verifyHolderBundle(downloaded, [addr(ANA)]);
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.records.every((r) => !r.verified && /not by an expected platform address/.test(r.why ?? ''))).toBe(true);
    expect(await verifyHolderBundle(downloaded, [])).toMatchObject({ ok: false, why: expect.stringMatching(/proves nothing/) });
    const items = arr(downloaded['bundle']);
    const planAt = items.findIndex((b) => b['recordKind'] === 'Plan');
    const plan = must(items[planAt]);
    expect(String(plan['graphTrig'])).toContain('wrd:status "proposed"');
    const tampered = items.map((b, i) => (i === planAt ? { ...b, graphTrig: String(b['graphTrig']).replace('wrd:status "proposed"', 'wrd:status "submitted"') } : b));
    const caught = await verifyHolderBundle(tampered, [platformAddress]);
    expect(caught.ok).toBe(false);
    expect(caught.records.filter((r) => !r.verified).map((r) => [r.descriptorUrl, r.why])).toEqual([[plan['descriptorUrl'], 'its graph was altered after signing: the bytes no longer match the signed digest']]);
  }, 90_000);

  it('rests a grant on the share of work a person accepted: an agent that labels its runs truthfully but is reworked 19 times in 20 earns nothing; a run under an earned grant is checked against the task as it stands', async () => {
    const w = await world();
    const ap = await standardAp(w);
    // The review's reproduction, end to end: 20 runs on T2 by 5 reviewers, a person accepted 1, the agent said "reworked" of the other 19.
    const reviewers = [ELI, FAY, GUS, HAL, IVY];
    for (let i = 0; i < 20; i += 1) {
      const self = i === 0 ? 'accepted' : 'reworked';
      const run = await runEnvelope(w, `t-${i}`, ap.t2, self, { taskKind: 'gl-coding' });
      ok(await http(w, 'POST', 'log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(w, must(reviewers[i % 5]), run, self) }));
    }
    const notEarned = refused(await act(w, BO, 'grant_autonomy', { agentAddress: AGENT.address, taskKind: 'gl-coding' }), 409, /not earned/, /^a person accepted 1 of 20 reviewed runs \(5%\); the policy needs at least 90%\.$/);
    expect(obj(notEarned['evaluation'])).toMatchObject({ acceptedShare: 0.05, readyClaims: 1, readyClaimPrecision: 1, distinctConfirmers: 5 });
    const cell = must(arr(ok(await calibration(w, '?kind=agents'))['agentCells']).find((c) => c['taskKind'] === 'gl-coding'));
    expect(cell).toMatchObject({ samples: 20, hitRate: 1, acceptedShare: 0.05, readyClaims: 1 });

    // An earned grant on invoice matching, a decision putting T1 under it — then T1 is re-classified Turbulent by the person who does it.
    for (let i = 1; i <= 24; i += 1) await logReviewedRun(w, `m-${i}`, ap.t1, i === 24 ? 'reworked' : 'accepted', must(reviewers[i % 5]), i >= 23 ? 'reworked' : 'accepted');
    const grantIri = String(ok(await act(w, BO, 'grant_autonomy', { agentAddress: AGENT.address, taskKind: 'invoice-matching' }))['grantIri']);
    const plan = ok(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT.address }], 'P3'));
    const v = ok(await act(w, ANA, 'value_plan', { planIri: plan['planIri'], inputs: {
      currency: 'USD', unitsPerWeek: { current: tri(180, 200, 220, 'measured') }, valuePerUnit: tri(5, 6, 7), hourlyCost: tri(38, 42, 46, 'document'),
      oneOffCost: tri(1000, 2000, 3000), horizonMonths: 24, rampMonths: 1, annualDiscountRate: 0.08, criticalFailureCeiling: 0.01, freedHours: { [ap.t1]: { disposition: 'absorbed' } },
      tasks: { [ap.t1]: { runsPerUnit: one(1), current: state({ performerHoursPerRun: tri(0.15, 0.2, 0.3, 'measured') }), proposed: state({ agentCostPerRun: tri(0.08, 0.12, 0.2) }) } },
    } }));
    const d3 = String((await submitValued(w, String(plan['planIri']), v))['decisionIri']);
    ok(await countersign(w, BO, d3, 'approve'));
    ok(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'g-1', ap.t1, 'accepted', { underGrant: grantIri }) }));
    expect(ok(await classify(w, CY, ap.t1, ANSWERS.turbulent))).toMatchObject({ regime: 'Turbulent', status: 'ratified', answeredBy: { role: 'performer' } });
    // The grant is still active on invoice matching, but THIS task is now Turbulent: nobody acts on it alone.
    refused(await http(w, 'POST', 'log_agent_run', { run_envelope: await runEnvelope(w, 'g-2', ap.t1, 'accepted', { underGrant: grantIri }) }), 409, /Turbulent work: act to stabilise first/);
  }, 120_000);

  it('keeps everyone who prepared a prediction, and the principal of an agent it names, from approving it; the approver from grading it; one approved, unmeasured decision per task; a short window only when stopped early', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const plan = async (who: Wallet, title: string, changes: Obj[] = P1_CHANGES(ap)): Promise<string> =>
      String(ok(await act(w, who, 'propose_allocation', { workflowIri: ap.workflowIri, title, changes }), `propose ${title}`)['planIri']);
    const value = async (who: Wallet, planIri: string, inputs: Obj = p1Inputs(ap)): Promise<Obj> => ok(await act(w, who, 'value_plan', { planIri, inputs }), 'value');
    const submit = async (who: Wallet, planIri: string, v: Obj): Promise<Res> => act(w, who, 'submit_decision', {
      planIri, valuationIri: v['valuationIri'], valuationHash: v['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 },
    });
    const pa = await plan(ANA, 'proposed by Ana');
    const da = String(ok(await submit(ELI, pa, await value(ELI, pa)))['decisionIri']);
    const pb = await plan(ELI, 'valued by Ana');
    const db = String(ok(await submit(ELI, pb, await value(ANA, pb)))['decisionIri']);
    const pc = await plan(ELI, 'prepared by Eli');
    const dc = String(ok(await submit(ELI, pc, await value(ELI, pc)))['decisionIri']);
    refused(await countersign(w, ANA2, da, 'approve'), 403, /proposed this plan cannot countersign/);
    refused(await countersign(w, ANA2, db, 'approve'), 403, /requested the valuation cannot countersign/);
    refused(await countersign(w, ANA2, dc, 'approve'), 403, /accountable for an agent this decision puts on the work/);
    await acknowledgeAll(w, pc);
    ok(await countersign(w, BO, dc, 'approve'));
    await acknowledgeAll(w, pa);
    const busy = refused(await countersign(w, BO, da, 'approve'), 409, /Another approved decision on \S+ has not been measured yet/);
    expect(obj(busy['iep:resolvedBy'])['toolName']).toBe('wrd.record_outcome');
    // Nor can another change to T2 be submitted while Dc is being measured.
    const t2Inputs: Obj = {
      ...p1Inputs(ap), freedHours: { [ap.t2]: { disposition: 'undecided' } },
      tasks: { [ap.t2]: { runsPerUnit: one(1), current: state({ performerHoursPerRun: tri(0.07, 0.1, 0.15), agentCostPerRun: tri(0.02, 0.05, 0.1) }), proposed: state({ performerHoursPerRun: tri(0.1, 0.15, 0.2) }) } },
    };
    const pd = await plan(ANA, 'T2 back to Dee alone', [{ taskIri: ap.t2, proposedLevel: 'person', personAddress: DEE.address }]);
    refused(await submit(ANA, pd, await value(ANA, pd, t2Inputs)), 409, /Another approved decision/);

    w.clock.advance(9 * WEEK);
    const csAt = String(obj((await decisionRow(w, dc))['countersign'])['at']);
    const measured = { weeklyValueDelta: 50, comparisonBasis: 'staggered', windowStart: csAt, windowEnd: plusWeeks(csAt, 8), method: 'Staggered roll-out' };
    refused(await recordOutcome(w, BO, dc, { disposition: 'kept', measured }), 403, /approved a decision cannot grade it/);
    refused(await recordOutcome(w, ELI, dc, { disposition: 'kept', measured }), 403, /predicted cannot grade/);
    // Stopped after three weeks: recorded, said so, and kept out of calibration.
    const short = ok(await recordOutcome(w, FAY, dc, { disposition: 'stopped-early', dispositionNote: 'Stopped: the supplier portal changed', measured: { ...measured, windowEnd: plusWeeks(csAt, 3) } }));
    expect(obj(short['valued'])).toMatchObject({ windowShorterThanPlanned: true, countsTowardCalibration: false });
    const cell = must(arr(ok(await calibration(w, '?kind=predictions'))['predictionCells'])[0]);
    expect(cell).toMatchObject({ samples: 0, excludedShortWindow: 1, dispositions: { 'stopped-early': 1 } });
    // A change stopped early puts nothing in force: T1 is again as captured, and Da can now be approved.
    expect(obj((await taskRow(w, ap.t1))['effective'])['source']).toBe('captured');
    ok(await countersign(w, BO, da, 'approve'));
  }, 120_000);

  it('re-checks at approval what submission checked: a dispute raised after submission blocks it', async () => {
    const w = await world();
    const { ap, planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    await acknowledgeAll(w, planIri);
    ok(await ratify(w, DEE, ap.t2, 'dispute', 'This misses the accrual step'));
    const blocked = refused(await countersign(w, BO, decisionIri, 'approve'), 409, /must be ratified by everyone named on it/, /is disputed/);
    expect(obj(blocked['iep:resolvedBy'])['toolName']).toBe('wrd.revise_task');
    ok(await ratify(w, DEE, ap.t2));
    ok(await ratifyClassification(w, CY, ap.t1, 'dispute', 'Mismatches only show up at month end'));
    refused(await countersign(w, BO, decisionIri, 'approve'), 409, /disputes its classification/);
    // Declining stays open: an approver can always say no.
    expect(ok(await countersign(w, BO, decisionIri, 'decline', { note: 'Not while the classification is disputed' }))['status']).toBe('declined');
  }, 60_000);

  it('a revision that removes someone named does not stand until they ratify it, and they can still dispute it', async () => {
    const w = await world();
    const ap = await standardAp(w);
    ok(await ratify(w, DEE, ap.t2, 'dispute', 'Misses the accrual step'));
    const h = headOfRow(await taskRow(w, ap.t2));
    // The review's reproduction: Ana answers Dee's dispute by naming herself and removing Dee.
    const revised = ok(await act(w, ANA, 'revise_task', { op: 'revise', taskIri: ap.t2, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, personAddress: ANA.address, description: 'Ana codes the invoices now.', note: 'Reassigned' }));
    expect(revised).toMatchObject({ status: 'captured', owedRatification: [addr(DEE)] });
    // Naming herself does not let Ana ratify her own description into force.
    expect(ok(await ratify(w, ANA, ap.t2))['status']).toBe('captured');
    const row = await taskRow(w, ap.t2);
    expect(arr(row['owedRatification'])).toEqual([{ address: addr(DEE), label: 'Dee', ratification: null }]);
    // Dee's voice is not removed: she disputes the revision that removed her.
    expect(ok(await ratify(w, DEE, ap.t2, 'dispute', 'I still do this work'))['status']).toBe('disputed');
    refused(await propose(w, ap, [{ taskIri: ap.t2, proposedLevel: 'person-with-agent-assist', personAddress: ANA.address }]), 409, /disputed task description/);
    expect(ok(await ratify(w, DEE, ap.t2))['status']).toBe('ratified');
    // Someone unrelated still cannot.
    refused(await ratify(w, CY, ap.t2), 403, /named on this task/);
  }, 60_000);

  it('refuses a replayed envelope after a restart: the pod holds the signer and nonce that authorised every version', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const zed = (roles: string[]): Obj => ({ entries: [person(ZED, roles, 'p-zed', 'Zed')] });
    // The review's reproduction: add XAV as approver, remove XAV, restart, replay the add.
    const addZed = await envelope(w, ADMIN, 'wrd:update-registry', zed(['approver']));
    ok(await http(w, 'POST', 'update_registry', { envelope: addZed }));
    ok(await act(w, ADMIN, 'update_registry', zed([])));
    // A classification replayed over a newer one, and an acknowledgement replayed over an objection.
    const firstClass = await envelope(w, ANA, 'wrd:classify-task', { taskIri: ap.t4, taskTextSha256: await textOf(w, ap.t4), answers: ANSWERS.turbulent });
    ok(await http(w, 'POST', 'classify_task', { envelope: firstClass }));
    ok(await classify(w, ANA, ap.t4, { ...ANSWERS.turbulent, worstCase: 'recoverable' }));
    const planIri = String(ok(await propose(w, ap, P1_CHANGES(ap)))['planIri']);
    const ph = await planHead(w, planIri);
    const ack = await envelope(w, CY, 'wrd:ratify-task', { subject: 'assignment', planIri, taskIri: ap.t1, ...ph, verdict: 'acknowledge' });
    ok(await http(w, 'POST', 'ratify_task', { envelope: ack }));
    ok(await acknowledge(w, CY, planIri, ap.t1, 'object', 'On reflection, no'));

    const fresh = await restart(w);
    refused(await http(fresh, 'POST', 'update_registry', { envelope: addZed }), 409, /already used/, /on urn:wrd:registry/);
    expect(arr(obj((await list(fresh))['registry'])['members']).some((m) => m['address'] === addr(ZED))).toBe(false);
    refused(await http(fresh, 'POST', 'classify_task', { envelope: firstClass }), 409, /already used/);
    refused(await http(fresh, 'POST', 'ratify_task', { envelope: ack }), 409, /already used/);
    expect(arr((await list(fresh))['plans']).find((p) => p['planIri'] === planIri)?.['assignments']).toEqual([
      expect.objectContaining({ taskIri: ap.t1, state: 'objected' }), expect.objectContaining({ taskIri: ap.t2, state: 'not-acknowledged' }),
    ]);
  }, 60_000);

  it('values only finite numbers and costs the oversight of a person who decides or audits', async () => {
    const w = await world();
    const ap = await standardAp(w);
    const planIri = String(ok(await propose(w, ap, P1_CHANGES(ap)))['planIri']);
    const huge = refused(await act(w, ANA, 'value_plan', { planIri, inputs: { ...p1Inputs(ap), unitsPerWeek: { current: tri(1e200, 1e200, 1e200) }, valuePerUnit: tri(1e200, 1e200, 1e200) } }), 400, /malformed/, /values above 1000000000000 are refused/);
    // A malformed payload is answered with the whole shape it should have had.
    expect(obj(huge['expectedPayload'])['title']).toBe('wrd:value-plan payload');
    expect(obj(huge['iep:resolvedBy'])).toMatchObject({ toolName: 'wrd.envelope_template', intent: 'wrd:value-plan' });
    const inputs = p1Inputs(ap);
    const tasks = obj(inputs['tasks']);
    const t1 = obj(tasks[ap.t1]);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: { ...inputs, tasks: { ...tasks, [ap.t1]: { ...t1, proposed: { ...obj(t1['proposed']), oversightHoursPerRun: one(0, 'estimate') } } } } }), 400, /malformed/, /oversightHoursPerRun is 0: a person decides on or audits/);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: { ...inputs, tasks: { ...tasks, [ap.t1]: { ...t1, proposed: { ...obj(t1['proposed']), agentCostPerRun: tri(0.05, 0.1, 0.2, 'measured') } } } } }), 400, /malformed/, /basis measured needs a source/);
    ok(await act(w, ANA, 'value_plan', { planIri, inputs }));
  }, 60_000);

  it('binds a classification to the text it answers; an agent named on a task classifies as an agent, never as expert evidence; a captured agent level the regime forbids is flagged', async () => {
    const w = await world();
    await register(w);
    const captured = ok(await act(w, ANA, 'capture_workflow', {
      workflow: { title: 'Coding review', unitLabel: 'invoice' },
      tasks: [{ name: 'Code invoices', description: 'The agent codes; Dee audits.', currentLevel: 'agent-acts-person-audits', personAddress: DEE.address, agentAddress: AGENT.address, taskKind: 'gl-coding' }],
    }));
    const t = String(arr(captured['tasks'])[0]?.['taskIri']);
    const missing = refused(await act(w, ANA, 'classify_task', { taskIri: t, answers: ANSWERS.knowable }), 400, /malformed/, /taskTextSha256/);
    expect(obj(missing['expectedPayload'])['required']).toEqual(['intent', 'podUrl', 'issuedAt', 'nonce', 'taskIri', 'taskTextSha256', 'answers']);
    refused(await act(w, ANA, 'classify_task', { taskIri: t, taskTextSha256: '0'.repeat(64), answers: ANSWERS.knowable }), 409, /description changed since you read it/);
    const byAgent = ok(await act(w, AGENT, 'classify_task', { taskIri: t, taskTextSha256: await textOf(w, t), answers: { ...ANSWERS.knowable, checkability: 'not-checkable' } }));
    expect(byAgent).toMatchObject({ answeredBy: { role: 'agent' }, status: 'classified' });
    expect(arr(byAgent['notes']).join(' ')).toMatch(/reported current state, not an approved one/);
    expect(String((await taskRow(w, t))['currentNotPermitted'])).toMatch(/checkability is not-checkable/);
    const planIri = String(ok(await act(w, ANA, 'propose_allocation', { workflowIri: captured['workflowIri'], title: 'Dee codes', changes: [{ taskIri: t, proposedLevel: 'person', personAddress: DEE.address }] }))['planIri']);
    refused(await act(w, ANA, 'value_plan', { planIri, inputs: {
      currency: 'USD', unitsPerWeek: { current: tri(180, 200, 220, 'measured') }, valuePerUnit: tri(5, 6, 7), hourlyCost: tri(38, 42, 46, 'document'),
      oneOffCost: tri(0, 500, 1000), horizonMonths: 12, rampMonths: 0, annualDiscountRate: 0.08, criticalFailureCeiling: 0.01, freedHours: { [t]: { disposition: 'undecided' } },
      tasks: { [t]: { runsPerUnit: one(1), current: state({ oversightHoursPerRun: tri(0.02, 0.04, 0.06), agentCostPerRun: tri(0.05, 0.08, 0.1) }), proposed: state({ performerHoursPerRun: tri(0.1, 0.15, 0.2) }) } },
    } }), 409, /Knowable work is valued only with expert analysis/);
  }, 60_000);

  it('publishes what each write signs: the manifest summarises every payload, and wrd.envelope_template serves the schema and a template filled from the pod', async () => {
    // Reads opened by the operator: the template's context is filled from the pod (closed, it is withheld; see the scoped-reads case).
    const w = await world({ publicReads: true });
    const ap = await standardAp(w);
    const manifestText = await (await fetch(`${w.base}/affordances?format=jsonld`, { headers: { accept: 'application/ld+json' } })).text();
    expect(manifestText).toContain('payload fields beyond intent, podUrl, issuedAt and nonce: {workflow: {title, unitLabel, description?}, tasks: [{name, description, currentLevel:');
    const planIri = String(ok(await propose(w, ap, P1_CHANGES(ap)))['planIri']);
    const valueT = ok(await http(w, 'GET', 'envelope_template', undefined, `?intent=wrd:value-plan&plan_iri=${encodeURIComponent(planIri)}`));
    expect(valueT).toMatchObject({ intent: 'wrd:value-plan', toolName: 'wrd.value_plan', status: 'templated', computed: true });
    expect(Object.keys(obj(obj(obj(valueT['template'])['inputs'])['tasks'])).sort()).toEqual([ap.t1, ap.t2].sort());
    expect(arr(valueT['fill'])).toContain('inputs.currency');
    expect(arr(obj(valueT['context'])['changedTasks']).map((c) => [c['taskIri'], c['oversightRequired']])).toEqual([[ap.t1, true], [ap.t2, false]]);
    // A template for a ratification carries the head the signer must bind; filled and signed, it is accepted as it is.
    const ratifyT = ok(await http(w, 'GET', 'envelope_template', undefined, `?intent=wrd:ratify-task&subject=assignment&task_iri=${encodeURIComponent(ap.t1)}&plan_iri=${encodeURIComponent(planIri)}`));
    const template = obj(ratifyT['template']);
    const ph = await planHead(w, planIri);
    expect(template).toMatchObject({ descriptorUrl: ph.descriptorUrl, graphDigest: ph.graphDigest, planIri, taskIri: ap.t1, subject: 'assignment', verdict: null });
    expect(template).not.toHaveProperty('recordId');
    const payload = { ...template, verdict: 'acknowledge', issuedAt: w.clock.now().toISOString() };
    expect(ok(await http(w, 'POST', 'ratify_task', { envelope: { payload, signature: await signMessageRaw(CY, canonicalJson(payload)) } }))['status']).toBe('acknowledged');
    refused(await http(w, 'GET', 'envelope_template', undefined, '?intent=wrd:anything'), 400, /Unknown intent/);
    refused(await http(w, 'GET', 'envelope_template', undefined, `?intent=wrd:revoke-grant&grant_iri=${encodeURIComponent('urn:wrd:grant:0000000000000000:0000000000000000')}`), 404);
  }, 60_000);

  it('operatorPodFetch adds the credential to reads and writes under the operator pod only; a redirect hop the SSRF guard re-issues carries it again only while it stays under the pod\'s path, and a redirected write is not followed', async () => {
    const seen: Seen[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), ...(init?.redirect ? { redirect: init.redirect } : {}) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const f = operatorPodFetch(POD, SECRET, spy);
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) await f(`${POD}wrd/records/x.ttl`, { method });
    await f(`${POD}wrd/records/x.ttl`, { method: 'GET' });
    await f('https://192.0.2.10/elsewhere/x.ttl', { method: 'PUT' });          // the same host, another path
    await f('https://192.0.2.10:8443/ap-team/x.ttl', { method: 'PUT' });       // another origin: another port
    await f('https://192.0.2.10.evil.test/ap-team/x.ttl', { method: 'PUT' });  // a host that only starts like the pod's
    await f(`${DEMO_HOLDER_POD}wrd/held/x.ttl`, { method: 'PUT' });              // a holder's pod
    await operatorPodFetch(POD, undefined, spy)(`${POD}x.ttl`, { method: 'PUT' });
    expect(seen.slice(0, 5).every((x) => x.auth === `Bearer ${SECRET}` && x.redirect === 'manual')).toBe(true);
    expect(seen.slice(5).map((x) => x.auth)).toEqual([null, null, null, null, null]);

    // Through the SSRF guard, as the bridge reads: the guard re-issues a GET's redirect hop through the same fetch, which
    // decides again for the new URL. A hop that stays under the pod's path carries the credential; the hop off the pod does not.
    const hops: Seen[] = [];
    const redirecting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      hops.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), ...(init?.redirect ? { redirect: init.redirect } : {}) });
      const url = String(input);
      if (url === `${POD}wrd/records/x.ttl`) return new Response(null, { status: 302, headers: { location: `${POD}wrd/records/moved/x.ttl` } });
      if (url.startsWith(POD)) return new Response(null, { status: 302, headers: { location: 'https://198.51.100.7/elsewhere/x.ttl' } });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const guarded = await openPod(POD, operatorPodFetch(POD, SECRET, redirecting) as unknown as FetchFn);
    expect((await guarded(`${POD}wrd/records/x.ttl`, { method: 'GET' })).status).toBe(200);
    expect(hops.map((x) => [x.url, x.auth, x.redirect])).toEqual([
      [`${POD}wrd/records/x.ttl`, `Bearer ${SECRET}`, 'manual'],
      [`${POD}wrd/records/moved/x.ttl`, `Bearer ${SECRET}`, 'manual'],
      ['https://198.51.100.7/elsewhere/x.ttl', null, 'manual'],
    ]);
    // A redirect to the same host outside the pod's path is off the pod too.
    hops.length = 0;
    const sameHost = (async (input: RequestInfo | URL, init?: RequestInit) => {
      hops.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') });
      return String(input).startsWith(POD) ? new Response(null, { status: 307, headers: { location: 'https://192.0.2.10/elsewhere/x.ttl' } }) : new Response('ok', { status: 200 });
    }) as typeof fetch;
    expect((await (await openPod(POD, operatorPodFetch(POD, SECRET, sameHost) as unknown as FetchFn))(`${POD}wrd/records/x.ttl`, { method: 'GET' })).status).toBe(200);
    expect(hops.map((x) => [x.url, x.auth])).toEqual([[`${POD}wrd/records/x.ttl`, `Bearer ${SECRET}`], ['https://192.0.2.10/elsewhere/x.ttl', null]]);
    // A redirected write is not followed at all.
    await expect(guarded(`${POD}wrd/records/y.ttl`, { method: 'PUT', body: 'x' })).rejects.toThrow(/refusing to follow a redirect/);
  });

  it('writes a pod that refuses anonymous writes with the operator credential, and sends holder copies without it, even into the operator pod', async () => {
    const seen: Seen[] = [];
    const w = await world((pod) => ({
      fetchFn: operatorPodFetch(POD, SECRET, gatePod(pod, seen)) as unknown as FetchFn,
      holderFetchFn: gatePod(pod, seen) as unknown as FetchFn,
    }));
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t1));
    const copied = ok(await act(w, CY, 'holder_copy', { targetPodUrl: DEMO_HOLDER_POD }));
    expect(arr(copied['copied']).length).toBeGreaterThan(0);
    const onPod = seen.filter((x) => x.url.startsWith(POD));
    expect(onPod.filter((x) => x.method === 'PUT').length).toBeGreaterThan(10);
    expect(onPod.every((x) => x.auth === `Bearer ${SECRET}` && x.redirect === 'manual')).toBe(true);
    const toHolder = seen.filter((x) => x.url.startsWith(DEMO_HOLDER_POD));
    expect(toHolder.filter((x) => x.method === 'PUT').length).toBeGreaterThan(0);
    expect(seen.filter((x) => !x.url.startsWith(POD)).every((x) => x.auth === null)).toBe(true);
    // A copy aimed inside the operator pod is still sent without the credential, so the pod refuses it.
    refused(await act(w, CY, 'holder_copy', { targetPodUrl: `${POD}held-by-cy/` }), 502, /401/);
    expect(seen.filter((x) => x.url.startsWith(`${POD}held-by-cy/`) && x.method === 'PUT').every((x) => x.auth === null)).toBe(true);
    // Without the credential the bridge's own writes are refused, and nothing is answered as written.
    const anonymous = await world((pod) => ({ fetchFn: gatePod(pod, []) as unknown as FetchFn }));
    refused(await act(anonymous, ADMIN, 'update_registry', { entries: REGISTRY_ENTRIES, taskKinds: TASK_KINDS }), 502, /401/, /did not accept/);
  }, 60_000);

  it('reads and writes only the pods it serves: a call naming another pod is refused (403 pod-not-served)', async () => {
    const w = await world();
    await register(w);
    const OTHER = 'https://192.0.2.99/other/';
    const fields = { workflow: { title: 'Elsewhere', unitLabel: 'item' }, tasks: [{ name: 'Do it', description: 'Elsewhere.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }] };
    refused(await http(w, 'POST', 'capture_workflow', { envelope: await envelope(w, ANA, 'wrd:capture-workflow', fields, { podUrl: OTHER }) }), 403, /only on the pods it serves/, /^pod-not-served: https:\/\/192\.0\.2\.99\/other\/ is not one of them$/);
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, ADMIN, { podUrl: OTHER }), pod_url: OTHER }), 403, /only on the pods it serves/, /pod-not-served/);
    refused(await http(w, 'GET', 'envelope_template', undefined, `?intent=wrd:read-records&pod_url=${encodeURIComponent(OTHER)}`), 403, /only on the pods it serves/, /pod-not-served/);
    // Served pods are compared normalised: an upper-case host, the default port and no trailing slash name the same pod.
    const loose = await world({ servedPods: ['HTTPS://192.0.2.10:443/ap-team'] });
    expect(ok(await http(loose, 'POST', 'read_records', { envelope: await readEnvelope(loose) }))['podUrl']).toBe(POD);
    // None served: every call is refused, naming the setting.
    const none = await world({ servedPods: [] });
    const r = refused(await http(none, 'POST', 'read_records', { envelope: await readEnvelope(none) }), 403, /serves no pod/, /pod-not-served/);
    expect(r['iep:resolvedBy']).toEqual({ env: 'WRD_SERVED_PODS' });
  });

  it('seals every record graph to the record key: the pod stores only envelopes, records verify bound once opened, and a bridge with another key or none refuses to act on them', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t1));
    // At rest: every graph document in wrd/records/ is sealed; descriptors stay public.
    const graphs = [...w.pod.bodies.keys()].filter((u) => u.startsWith(`${POD}${WRD_CONTAINER}`) && !u.endsWith('.ttl'));
    expect(graphs.length).toBeGreaterThan(5);
    expect(graphs.filter((u) => !u.endsWith('-graph.envelope.jose.json'))).toEqual([]);
    expect([...w.pod.bodies.keys()].filter((u) => u.endsWith('-graph.trig'))).toEqual([]);
    for (const u of graphs) expect(must(w.pod.bodies.get(u))).not.toMatch(/payloadJson|Match each invoice|wrd:/);
    const t1 = headOfRow(await taskRow(w, ap.t1));
    const descriptor = must(w.pod.bodies.get(t1.descriptorUrl));
    expect(descriptor).toMatch(/iep:encrypted true/);
    expect(descriptor).toMatch(/iep:modalStatus iep:Asserted/);
    expect(descriptor).not.toMatch(/Match each invoice/);

    // Opened with the key, the record verifies against the platform's proof over the plaintext graph.
    const trusted = new Set([addr(PLATFORM)]);
    const entry = must((await manifest(w)).find((e) => e.descriptorUrl === t1.descriptorUrl)) as Parameters<typeof readRecord>[0];
    const opened = await readRecord(entry, POD, w.pod.fetchFn, trusted, undefined, WRD_CONTAINER, K1);
    expect(opened.authorship).toMatchObject({ signatureValid: true, eligible: true, trusted: true, contentBinding: 'bound', modalMatches: true });
    expect([opened.graphDigest, opened.record?.recordKind, opened.why]).toEqual([t1.graphDigest, 'Task', null]);
    // With another key, or none, it stays eligible (signed, where its proof says) but is never trusted or read as a record.
    for (const [key, why] of [[K2, SEALED_OTHER_KEY], [undefined, SEALED_NO_KEY]] as const) {
      const shut = await readRecord(entry, POD, w.pod.fetchFn, trusted, undefined, WRD_CONTAINER, key);
      expect(shut).toMatchObject({ record: null, graphContent: '', why, authorship: { signatureValid: true, eligible: true, trusted: false, contentBinding: 'declared' } });
    }
    // Bridges on the same pod holding another record key, or none: the pod holds IRIs keyed under K1, so they write nothing, and the registry
    // they would read is sealed to K1, so they read nothing either (409, naming the key fingerprints and WRD_RECORD_KEY, and why the registry is shut).
    const k1 = `k${iriKeyFingerprint(entityIriKey(K1))}`;
    for (const [extra, shut, bridgeKey] of [[{ recordKey: K2 }, SEALED_OTHER_KEY, `holds the one with fingerprint k${iriKeyFingerprint(entityIriKey(K2))}`], [{}, SEALED_NO_KEY, 'holds no record key']] as const) {
      const other = await sibling(w, extra);
      const read = refused(await http(other, 'POST', 'read_records', { envelope: await readEnvelope(other) }), 409, /derived under a record key this bridge does not hold/,
        new RegExp(`fingerprint ${k1}, and this bridge ${bridgeKey} \\(WRD_RECORD_KEY\\).*nor can it use the pod's registry \\(urn:wrd:registry:[0-9a-f:]+graph: its current version \\(.+\\) is not trusted: ${shut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\), so it answers no read, whoever signs it`));
      expect(read['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
      const wrote = refused(await act(other, ADMIN, 'update_registry', { entries: [person(ZED, ['worker'], 'p-zed', 'Zed')] }), 409, /derived under a record key this bridge does not hold/,
        new RegExp(`derived under the record key with fingerprint ${k1}, and this bridge ${bridgeKey} \\(WRD_RECORD_KEY\\)`));
      expect(wrote['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
    }
    // Under the key the lifecycle goes on, and a holder's download carries the opened graphs, which verify offline.
    ok(await ratify(w, DEE, ap.t2));
    const exported = ok(await act(w, CY, 'holder_copy', {}));
    expect(await verifyHolderBundle(exported, [PLATFORM.address])).toMatchObject({ ok: true, why: null });

    // A sealed graph changed on the pod no longer opens: its head is altered (409), and the version it superseded does not become current again.
    corruptSealed(w, sealedGraphUrl(w, t1.descriptorUrl));
    const after = await list(w);
    expect(arr(after['altered'])).toContain(graphIriOf(ap.t1));
    expect(arr(after['tasks']).map((t) => t['taskIri'])).not.toContain(ap.t1);
    refused(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1), verdict: 'ratify' }), 409, /altered after signing/, /sealed to a key this bridge does not hold, or the sealed bytes were changed/);
  }, 60_000);

  it('scopes reads: the GET read model answers 401 unless the operator opens it; a signed read by an admin or a registered key answers, reused, and anyone else is refused', async () => {
    const w = await world();
    for (const tool of ['list_records', 'calibration'] as const) {
      const r = refused(await http(w, 'GET', tool), 401, /needs a signed read/, /WRD_PUBLIC_READS=1/);
      expect(obj(r['iep:resolvedBy'])).toMatchObject({ toolName: tool === 'list_records' ? 'wrd.read_records' : 'wrd.read_calibration', intent: 'wrd:read-records' });
    }
    // The admin reads before any registry exists; once registered, so does any registered key, and no one else.
    expect(ok(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w) }))).toMatchObject({ status: 'listed', records: 0, bridge: { reads: 'signed', recordsSealed: false } });
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) }), 403, /Only an admin or a key in this pod's registry/);
    await register(w);
    const cyRead = await readEnvelope(w, CY);
    const first = ok(await http(w, 'POST', 'read_records', { envelope: cyRead, kind: 'registry' }));
    expect(obj(first['registry'])['members']).toHaveLength(REGISTRY_ENTRIES.length);
    expect(String(first['readExposure'])).toMatch(/signed read/);
    // A read spends no nonce: the same envelope reads again, records or calibration, until it is stale.
    ok(await http(w, 'POST', 'read_records', { envelope: cyRead }));
    ok(await http(w, 'POST', 'read_calibration', { envelope: cyRead, kind: 'agents' }));
    ok(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, AGENT) }));
    for (const tool of ['read_records', 'read_calibration']) refused(await http(w, 'POST', tool, { envelope: await readEnvelope(w, ZED) }), 403, /Only an admin or a key in this pod's registry/, /not in the registry at all/);
    const hourAgo = new Date(w.clock.now().getTime() - 3_600_000).toISOString();
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY, { issuedAt: hourAgo }) }), 401, /stale/);
    refused(await http(w, 'POST', 'read_records', {}), 401, /signed envelope is required/);
    // A read is not a write, and a write is not a read.
    refused(await http(w, 'POST', 'read_records', { envelope: await envelope(w, ADMIN, 'wrd:holder-copy', {}) }), 400, /malformed/, /intent must be wrd:read-records/);
    refused(await http(w, 'POST', 'holder_copy', { envelope: cyRead }), 400, /malformed/, /intent must be wrd:holder-copy/);
    refused(await http(w, 'POST', 'read_records', { envelope: { payload: { ...cyRead.payload, kind: 'tasks' }, signature: cyRead.signature } }), 403, /Only an admin/);
    refused(await http(w, 'POST', 'read_records', { envelope: cyRead, kind: 'everything' }), 400, /Unknown kind/);

    // While reads are closed, wrd.envelope_template gives the shape and the head binding, never what it read out of a graph.
    const ap = await captureAp(w);
    const revise = ok(await template(w, `intent=wrd:revise-task&task_iri=${encodeURIComponent(ap.t1)}`, false));
    const t1 = headOfRow(await taskRow(w, ap.t1));
    expect(revise['template']).toEqual({
      intent: 'wrd:revise-task', podUrl: POD, issuedAt: expect.any(String), nonce: expect.any(String), op: null, taskIri: ap.t1, descriptorUrl: t1.descriptorUrl, graphDigest: t1.graphDigest,
    });
    expect(arr(revise['fill'])).toEqual(['op']);
    expect(revise['context']).toEqual({});
    expect(String(revise['contextWithheld'])).toMatch(/POST the same arguments to wrd\.read_envelope_template with a signed wrd:read-records envelope as read_envelope in the JSON body/);
    expect(JSON.stringify(revise)).not.toMatch(/Three-way match|Match each invoice/);
    // A signed read is never taken from a URL: the GET refuses one (400) before anything is read, valid or not, as an object or as text, and points at the POST form.
    const reviseQuery = `intent=wrd:revise-task&task_iri=${encodeURIComponent(ap.t1)}`;
    // The object spelled into the query the ways clients spell one: qs / jQuery brackets, dots, an array, or split into payload and signature.
    const keyed = (v: unknown, prefix: string, open: string, close: string): string[] => (typeof v === 'object' && v !== null
      ? Object.entries(v).flatMap(([k, x]) => keyed(x, `${prefix}${open}${k}${close}`, open, close))
      : [`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`]);
    const asJson = encodeURIComponent(JSON.stringify(cyRead));
    for (const sent of [
      `read_envelope=${asJson}`, `read_envelope=${encodeURIComponent(JSON.stringify(await readEnvelope(w, ZED)))}`, 'read_envelope=x', 'read_envelope=',
      keyed(cyRead, 'read_envelope', '[', ']').join('&'), keyed(cyRead, 'read_envelope', '.', '').join('&'), `read_envelope%5B%5D=${asJson}`,
      `payload=${encodeURIComponent(JSON.stringify(cyRead.payload))}&signature=${cyRead.signature}`, `note=${cyRead.signature}`, `context=${asJson}`,
      // A key with no value: the whole signed read, a bare signature, a signature inside a bracketed key, a "signature" field.
      asJson, `${asJson}=`, cyRead.signature, `x%5B${cyRead.signature}%5D=1`, encodeURIComponent(JSON.stringify({ signature: cyRead.signature })),
    ]) {
      const inUrl = refused(await http(w, 'GET', 'envelope_template', undefined, `?${reviseQuery}&${sent}`), 400, /A signed read is never sent in a URL/, /POST the same arguments to wrd\.read_envelope_template with read_envelope in the JSON body/);
      expect(obj(inUrl['iep:resolvedBy'])).toMatchObject({ toolName: 'wrd.read_envelope_template', method: 'POST', intent: 'wrd:read-records' });
      expect([inUrl['template'], inUrl['context'], JSON.stringify(inUrl).includes(t1.descriptorUrl)]).toEqual([undefined, undefined, false]);
      // The refusal never repeats the signature it found.
      expect([sent, JSON.stringify(inUrl).includes(cyRead.signature.slice(2, 40))]).toEqual([sent, false]);
    }
    // However many parameters come first: Express's default parser keeps 1000 pairs (empty ones count) and drops the rest,
    // so the bridge parses every pair (parseEveryQueryPair), and a signed read after a thousand others is refused too.
    const empties = '&'.repeat(1000);
    const fillers = Array.from({ length: 1000 }, (_, i) => `f${i}=1`).join('&');
    const late = [`${empties}&read_envelope=${asJson}`, `${fillers}&read_envelope=${asJson}`, `${empties}&${asJson}`, `${empties}&signature=${cyRead.signature}`,
      `${fillers}&x=${cyRead.signature}`, `${fillers}&read_envelope%5Bsignature%5D=${cyRead.signature}`];
    for (const sent of late) {
      const r = refused(await http(w, 'GET', 'envelope_template', undefined, `?${reviseQuery}&${sent}`), 400, /A signed read is never sent in a URL/);
      expect([sent.length, r['template'], JSON.stringify(r).includes(cyRead.signature.slice(2, 40))]).toEqual([sent.length, undefined, false]);
    }
    // Composed without it, the same URL is answered 200 from the template, the signed read unseen: why every composition installs it.
    const bare = await listenLoopback(createVerticalBridge({
      verticalName: 'work-redesign', affordances: wrdAffordances, deploymentUrl: 'http://127.0.0.1',
      handlers: createWrdHandlers({ fetchFn: w.pod.fetchFn, defaultPodUrl: POD, now: () => w.clock.now(), platform: { wallet: PLATFORM, keyKind: 'configured' }, adminAddresses: [ADMIN.address] }),
    }));
    listeners.push(bare);
    expect((await fetch(`${bare.base}/wrd/envelope_template?${reviseQuery}&${empties}&read_envelope=${asJson}`)).status).toBe(200);
    // Only those forms are detected: a signature without its 0x, alone or as a key, is not refused, and the GET still fills only its allowlist.
    for (const sent of [`note=${cyRead.signature.slice(2)}`, cyRead.signature.slice(2)]) {
      const passed = ok(await http(w, 'GET', 'envelope_template', undefined, `?${reviseQuery}&${sent}`));
      expect(passed['template']).toMatchObject({ taskIri: ap.t1, descriptorUrl: t1.descriptorUrl, op: null });
      expect(passed['context']).toEqual({});
    }
    // A key with a step named for a signature is refused whatever array or index steps follow it: sent here with a value that is no
    // signature the text check knows (no 0x), so the key alone is what is found. Nothing is filled, and the value is not repeated.
    const hex = cyRead.signature.slice(2);
    for (const key of ['signature%5B%5D', 'signature%5B0%5D', 'x%5Bsignature%5D%5B%5D', 'x.signature.0']) {
      const r = refused(await http(w, 'GET', 'envelope_template', undefined, `?${reviseQuery}&${key}=${hex}`), 400, /A signed read is never sent in a URL/, /POST the same arguments to wrd\.read_envelope_template/);
      expect([key, r['template'], r['context'], JSON.stringify(r).includes(t1.descriptorUrl), JSON.stringify(r).includes(hex.slice(0, 40))]).toEqual([key, undefined, undefined, false, false]);
    }
    refused(await http(w, 'GET', 'envelope_template', undefined, '?intent=wrd:anything&read_envelope=x'), 400, /never sent in a URL/);
    // The same arguments POSTed with a registered key's signed read in the body are filled from the record, context and all.
    const signedRevise = ok(await http(w, 'POST', 'read_envelope_template', { intent: 'wrd:revise-task', task_iri: ap.t1, read_envelope: cyRead }));
    expect(signedRevise['template']).toMatchObject({ op: 'revise', taskIri: ap.t1, descriptorUrl: t1.descriptorUrl, description: 'Three-way match before approval.' });
    expect(signedRevise).not.toHaveProperty('contextWithheld');
    expect(arr(obj(signedRevise['context'])['taskKinds']).length).toBeGreaterThan(0);
    // A signed read the read model would refuse is refused here too; the POST form takes none but a signed read.
    refused(await http(w, 'POST', 'read_envelope_template', { intent: 'wrd:revise-task', task_iri: ap.t1, read_envelope: await readEnvelope(w, ZED) }), 403, /Only an admin/);
    refused(await http(w, 'POST', 'read_envelope_template', { intent: 'wrd:revise-task', task_iri: ap.t1 }), 401, /signed envelope is required/);
    refused(await http(w, 'POST', 'read_envelope_template', { intent: 'wrd:revise-task', task_iri: ap.t1, read_envelope: '{not json' }), 400, /malformed/);
    const readT = ok(await http(w, 'GET', 'envelope_template', undefined, '?intent=wrd:read-records'));
    expect(readT).toMatchObject({ toolName: 'wrd.read_records', template: { intent: 'wrd:read-records', podUrl: POD } });
    // The template, signed as it is, is a read.
    const p = obj(readT['template']);
    ok(await http(w, 'POST', 'read_calibration', { envelope: { payload: p, signature: await signMessageRaw(DEE, canonicalJson(p)) } }));

    // Opened by the operator, the GET read model answers anyone, and says so.
    const open = await world({ publicReads: true });
    const listed = ok(await http(open, 'GET', 'list_records'));
    expect(listed).toMatchObject({ status: 'listed', bridge: { reads: 'public' } });
    expect(String(listed['readExposure'])).toMatch(/Anyone who can reach this bridge/);
    ok(await http(open, 'GET', 'calibration'));
  }, 60_000);

  it('decides who may read on the whole manifest: with the registry version that removed a key behind a manifest segment that does not answer, a signed read by any key but an admin\'s is refused (502) as a write is, never answered from the older registry', async () => {
    const manifestUrl = predictManifestUrl(POD);
    const archiveUrl = `${manifestUrl}-archive-2`;
    let hide: string | null = null;
    // The pod's manifest with one entry moved to an archive segment that answers 404: a partial view a reader must notice.
    const w = await world((pod) => ({
      fetchFn: (async (url, init) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (hide !== null && method === 'GET' && u === manifestUrl) {
          const body = await (await pod.fetchFn(url, init)).text();
          const blocks = body.split(/\n\n+/);
          const kept = blocks.filter((b) => !b.includes(hide ?? ''));
          if (kept.length === blocks.length) throw new Error('the entry to hide is not in the manifest');
          return new Response(`${kept.join('\n\n')}\n\n<${manifestUrl}> iep:manifestArchive <${archiveUrl}> .\n`, { status: 200, headers: { 'content-type': 'text/turtle' } });
        }
        if (hide !== null && u === archiveUrl) return new Response('unavailable', { status: 404, statusText: 'Not Found' });
        return pod.fetchFn(url, init);
      }) as PodFetch,
    }));
    await register(w);
    ok(await act(w, ADMIN, 'update_registry', { entries: [person(ZED, ['worker'], 'p-zed', 'Zed')] }));
    ok(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, ZED), kind: 'registry' }));
    const removed = ok(await act(w, ADMIN, 'update_registry', { entries: [{ address: ZED.address, roles: [] }] }));
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, ZED) }), 403, /Only an admin/);

    hide = String(removed['descriptorUrl']);
    // The admin still reads, and is told the view is partial.
    expect(ok(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w), kind: 'registry' }))['complete']).toBe(false);
    // Zed, removed by the version that cannot be read, is not let back in by the one before it; nor is anyone else who is not an admin.
    const zed = refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, ZED) }), 502, /manifest could not be read in full/);
    refused(await http(w, 'POST', 'read_calibration', { envelope: await readEnvelope(w, ZED) }), 502, /manifest could not be read in full/);
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) }), 502, /manifest could not be read in full/);
    refused(await http(w, 'POST', 'read_envelope_template', { intent: 'wrd:read-records', read_envelope: await readEnvelope(w, ZED) }), 502, /manifest could not be read in full/);
    // The admin's signed read still fills a template.
    expect(ok(await template(w, 'intent=wrd:update-registry'))['context']).toHaveProperty('members');
    // The same refusal a write gets in the same state.
    const write = refused(await act(w, ADMIN, 'update_registry', { entries: [{ address: CY.address, roles: [] }] }), 502);
    expect(zed['error']).toBe(write['error']);
    hide = null;
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, ZED) }), 403, /Only an admin/);
  }, 60_000);

  it('refuses text that is not well-formed Unicode (a lone surrogate) with 400 before any work, and a record the bridge cannot seal is its own failure, never the pod\'s', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const before = (await manifest(w)).length;
    const task = { name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' };
    const env = await envelope(w, ANA, 'wrd:capture-workflow', { workflow: { title: 'Month-end \ud800 review', unitLabel: 'accrual' }, tasks: [task] });
    refused(await http(w, 'POST', 'capture_workflow', { envelope: env }), 400, /not well-formed Unicode/, /arguments\.envelope\.payload\.workflow\.title holds a lone UTF-16 surrogate/);
    refused(await http(w, 'POST', 'record_task_map', { envelope: env, document_text: 'A\udfffB' }), 400, /not well-formed Unicode/, /lone UTF-16 surrogate/);
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w), kind: 'tasks\udc00' }), 400, /not well-formed Unicode/);
    // However deep it sits: the check has no depth past which it stops looking (and so reads as well-formed).
    const nest = (levels: number, leaf: unknown): unknown => { let v = leaf; for (let i = 0; i < levels; i += 1) v = { n: v }; return v; };
    const deepEnv = await envelope(w, ANA, 'wrd:capture-workflow', { workflow: { title: 'Month-end review', unitLabel: 'accrual' }, tasks: [task], extra: nest(70, 'x\ud800y') });
    refused(await http(w, 'POST', 'capture_workflow', { envelope: deepEnv }), 400, /not well-formed Unicode/, /arguments\.envelope\.payload\.extra(\.n){70} holds a lone UTF-16 surrogate/);
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w), junk: nest(300, '\udc00') }), 400, /not well-formed Unicode/, /arguments\.junk(\.n){300} holds/);
    expect(illFormedTextPath(nest(100_000, 'ok'))).toBeNull();
    expect(illFormedTextPath([nest(100_000, 'ok'), { a: ['fine', 'x\ud800'] }])).toBe('input[1].a[1]');
    expect((await manifest(w)).length).toBe(before);
    // Refused before the envelope was opened, so its nonce was not spent: the same nonce with well-formed text is accepted.
    const fixed = await envelope(w, ANA, 'wrd:capture-workflow', { workflow: { title: 'Month-end review', unitLabel: 'accrual' }, tasks: [task] }, { nonce: String(env.payload['nonce']) });
    ok(await http(w, 'POST', 'capture_workflow', { envelope: fixed }));

    // A graph the bridge built that cannot be sealed is refused in this process, before any write: not a 502 "the pod did not accept".
    const now = w.clock.now().toISOString();
    const entity = entityIri('workflow', POD, 'not-sealable', entityIriKey(K1));
    const record = {
      recordKind: 'Workflow', entityIri: entity, version: 1, status: 'captured',
      payload: { title: 'Lone \ud800 surrogate', unitLabel: 'item', captureMode: 'manual', capturedBy: { did: `did:ethr:${addr(ANA)}`, envelope: fixed }, taskIris: [], retiredTaskIris: [] },
      signers: [], platform: { did: `did:ethr:${addr(PLATFORM)}`, address: addr(PLATFORM), keyKind: 'configured' },
    } as unknown as WrdRecord;
    const at = (await manifest(w)).length;
    await expect(publishRecord({
      descriptor: { recordId: recordIdFor('workflow', graphIriOf(entity), 1, 'not-sealable-0001', recordKeyFingerprint(K1)), graphIri: graphIriOf(entity), recordKind: 'Workflow', now, validFrom: now, modal: 'Hypothetical', platformDid: `did:ethr:${addr(PLATFORM)}`, signers: [], derivedFrom: [] },
      record, expectHead: null,
    }, { podUrl: POD, fetchFn: w.pod.fetchFn, platform: { wallet: PLATFORM, keyKind: 'configured' }, trusted: new Set([addr(PLATFORM)]), mutex: new KeyedMutex(), recordKey: K1 })).rejects.toBeInstanceOf(RecordNotSealableError);
    expect((await manifest(w)).length).toBe(at);

    // A version's record id names the record key its graph is sealed to, or none for a plaintext graph, and never another: publishRecord writes nothing otherwise.
    const fine = { ...record, payload: { ...(record as unknown as { payload: Obj }).payload, title: 'Month-end review' } } as unknown as WrdRecord;
    const g = graphIriOf(entity);
    for (const [recordId, recordKey] of [
      [recordIdFor('workflow', g, 1, 'mark-0001'), K1], [recordIdFor('workflow', g, 1, 'mark-0002', recordKeyFingerprint(K2)), K1], [recordIdFor('workflow', g, 1, 'mark-0003', recordKeyFingerprint(K1)), undefined],
    ] as const) {
      await expect(publishRecord({
        descriptor: { recordId, graphIri: g, recordKind: 'Workflow', now, validFrom: now, modal: 'Hypothetical', platformDid: `did:ethr:${addr(PLATFORM)}`, signers: [], derivedFrom: [] },
        record: fine, expectHead: null,
      }, { podUrl: POD, fetchFn: w.pod.fetchFn, platform: { wallet: PLATFORM, keyKind: 'configured' }, trusted: new Set([addr(PLATFORM)]), mutex: new KeyedMutex(), ...(recordKey ? { recordKey } : {}) }))
        .rejects.toThrow(/must (end -k[0-9a-f]{8}, the fingerprint of the record key its graph is sealed to|name no record key)/);
    }
    expect((await manifest(w)).length).toBe(at);
  }, 60_000);

  it('follows supersedes only to a trusted version of the same graph: a link a pod writer adds from one chain into another entity\'s sealed record never puts that record in the holder\'s copy, the chain or the heads', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t1));
    // Dee's dispute note is in T2's line only (the workflow record carries the captured descriptions, not this).
    const t2Text = 'Dee: the cost centre rule is wrong for capital purchases';
    ok(await ratify(w, DEE, ap.t2, 'dispute', t2Text));
    const t1Head = headOfRow(await taskRow(w, ap.t1));
    const t2Head = headOfRow(await taskRow(w, ap.t2));
    const t1First = must((await manifest(w)).find((e) => e.describes.includes(graphIriOf(ap.t1)) && e.descriptorUrl !== t1Head.descriptorUrl), 't1 v1').descriptorUrl;
    // Cy is not named on T2 and signed nothing in it: her copy holds none of it.
    expect(JSON.stringify(ok(await act(w, CY, 'holder_copy', {}))['bundle'])).not.toContain(t2Text);

    // A writer of the pod, without the record key, edits the manifest: T1's head also "supersedes" T2's head, listed under T1's graph too.
    const manifestUrl = predictManifestUrl(POD);
    const original = must(w.pod.bodies.get(manifestUrl), 'manifest');
    const forge = (withSupersedes: boolean): string => original.split('\n\n').map((b) => {
      if (withSupersedes && b.startsWith(`<${t1Head.descriptorUrl}>`)) return b.replace(/(iep:describes <[^>]+> ;)/, `$1\n    iep:supersedes <${t2Head.descriptorUrl}> ;`);
      if (b.startsWith(`<${t2Head.descriptorUrl}>`)) return b.replace(/(iep:describes <[^>]+> ;)/, `$1\n    iep:describes <${graphIriOf(ap.t1)}> ;`);
      return b;
    }).join('\n\n');
    w.pod.tamper(manifestUrl, original, forge(true));
    const entries = await manifest(w);
    expect(must(entries.find((e) => e.descriptorUrl === t1Head.descriptorUrl)).supersedes?.[0]).toBe(t2Head.descriptorUrl);
    expect(must(entries.find((e) => e.descriptorUrl === t2Head.descriptorUrl)).describes).toContain(graphIriOf(ap.t1));
    // Cy's copy follows T1's line back past the forged link: T2's record, which the bridge could open, is not in it.
    const exported = ok(await act(w, CY, 'holder_copy', {}));
    const bundle = arr(exported['bundle']);
    expect(bundle.map((b) => b['descriptorUrl'])).not.toContain(t2Head.descriptorUrl);
    expect(JSON.stringify(bundle)).not.toContain(t2Text);
    expect(bundle.filter((b) => b['entityIri'] === ap.t1).map((b) => b['descriptorUrl'])).toEqual([t1First, t1Head.descriptorUrl]);
    expect(await verifyHolderBundle(exported, [PLATFORM.address])).toMatchObject({ ok: true });
    // Listed under T1's graph without the link, T2's head would be a second head: it is set aside, and T1 is not forked.
    w.pod.tamper(manifestUrl, forge(true), forge(false));
    const listed = await list(w);
    expect(arr(listed['forked'])).toEqual([]);
    expect(headOfRow(await taskRow(w, ap.t1)).descriptorUrl).toBe(t1Head.descriptorUrl);
    expect(String(must(arr(listed['untrusted']).find((u) => u['descriptorUrl'] === t2Head.descriptorUrl), 'set aside')['why'])).toMatch(/is a version of urn:wrd:task:[0-9a-fk:]+graph, not of urn:wrd:task:/);
    ok(await ratify(w, CY, ap.t1, 'dispute', 'Still being checked'));
  }, 60_000);

  it('never reads a sealed record that does not open as absent or negative: a grant and an acknowledgement answer 409 naming WRD_RECORD_KEY, the holder\'s copy refuses rather than come back short, and the read model marks them', async () => {
    const w = await world({ recordKey: K1 });
    const { ap, planIri, valuation } = await valuedP1(w);
    ok(await acknowledge(w, CY, planIri, ap.t1, 'acknowledge'));
    const planRow = async (): Promise<Obj> => must(arr((await list(w))['plans']).find((p) => p['planIri'] === planIri), 'plan row');
    expect(must(arr((await planRow())['assignments']).find((a) => a['taskIri'] === ap.t1))['state']).toBe('acknowledged');
    // The acknowledgement's sealed bytes are changed on the pod: it no longer opens.
    const ack = must((await manifest(w)).find((e) => e.describes.some((g) => g.startsWith('urn:wrd:acknowledgement:'))), 'acknowledgement');
    corruptSealed(w, sealedGraphUrl(w, ack.descriptorUrl));
    const listed = await list(w);
    const row = must(arr(must(arr(listed['plans']).find((p) => p['planIri'] === planIri))['assignments']).find((a) => a['taskIri'] === ap.t1));
    expect(row['state']).toBe('unreadable');
    expect(String(row['label'])).toMatch(/cannot be read.*WRD_RECORD_KEY/);
    expect(arr(listed['sealed']).map((x) => x['graphIri'])).toEqual(ack.describes);
    expect(String(listed['sealedNote'])).toMatch(/never read as absent/);
    const submitted = refused(await act(w, ANA, 'submit_decision', {
      planIri, valuationIri: valuation['valuationIri'], valuationHash: valuation['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 },
    }), 409, /altered after signing/, /WRD_RECORD_KEY/);
    expect(submitted['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
    const copy = refused(await act(w, CY, 'holder_copy', {}), 409, /cannot tell whether they name you/, /WRD_RECORD_KEY/);
    expect(copy['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });

    // A grant at the grant's (keyed) IRI that does not open, its sealed bytes changed on the pod: not "no grant" and not "inactive".
    // (One sealed to another key would be a key conflict: every write refused; see the record-key cases below.)
    const grant = entityIri('grant', addr(AGENT), `${POD}|invoice-matching`, entityIriKey(K1));
    const now = w.clock.now().toISOString();
    const sealedGrant = await publishRecord({
      descriptor: { recordId: recordIdFor('grant', graphIriOf(grant), 1, 'sealed-grant-0001', recordKeyFingerprint(K1)), graphIri: graphIriOf(grant), recordKind: 'Grant', now, validFrom: now, modal: 'Asserted', platformDid: `did:ethr:${addr(PLATFORM)}`, signers: [], derivedFrom: [] },
      record: {
        recordKind: 'Grant', entityIri: grant, version: 1, status: 'granted', signers: [], platform: { did: `did:ethr:${addr(PLATFORM)}`, address: addr(PLATFORM), keyKind: 'configured' },
        payload: {
          agentAddress: addr(AGENT), agentDid: `did:ethr:${addr(AGENT)}`, principal: addr(ANA), model: 'scripted-fixture', taskKind: 'invoice-matching', taskKindDefinition: 'Match an invoice.',
          policy: { iri: 'https://example.org/wrd/grant-policy' }, evaluation: {}, grantedBy: { did: `did:ethr:${addr(BO)}`, personRef: 'p-bo', envelope: { payload: {}, signature: '0x' } },
          policyRef: { ontologyIri: WRD_NS, ontologySha256: sha256Hex('policy'), podPolicyHead: null },
        },
      } as unknown as WrdRecord,
      expectHead: null,
    }, { podUrl: POD, fetchFn: w.pod.fetchFn, platform: { wallet: PLATFORM, keyKind: 'configured' }, trusted: new Set([addr(PLATFORM)]), mutex: new KeyedMutex(), recordKey: K1 });
    corruptSealed(w, sealedGraphUrl(w, sealedGrant.descriptorUrl));
    const underGrant = refused(await propose(w, ap, [{ taskIri: ap.t1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT.address }], 'P-grant'), 409, /altered after signing/, /sealed to a key this bridge does not hold/);
    expect(underGrant['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
    // In the calibration, the agent's grant is shown as unreadable (active: null), not inactive; the sealed records are named.
    await logReviewedRun(w, 'run-sealed-1', ap.t1, 'accepted', ELI, 'accepted');
    const cal = ok(await calibration(w, '?kind=agents'));
    expect(obj(must(arr(cal['agentCells'])[0], 'agent cell')['grant'])).toMatchObject({ active: null, why: expect.stringMatching(/WRD_RECORD_KEY/) });
    expect(arr(cal['sealed']).map((x) => x['graphIri']).sort()).toEqual([...ack.describes, graphIriOf(grant)].sort());
  }, 90_000);

  it('never answers the read model from the absence of a record that does not open: a sealed workflow leaves its tasks\' orphaned and retirementUnfinished unknown, a sealed task or classification a plan\'s staleness, a sealed plan of an approved decision the allocation in force, and a sealed earlier decision version its chain', async () => {
    const w = await world({ recordKey: K1 });
    const { ap, planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    await acknowledgeAll(w, planIri);
    ok(await countersign(w, BO, decisionIri, 'approve'));
    const planRow = (l: Obj): Obj => must(arr(l['plans']).find((p) => p['planIri'] === planIri), 'plan row');
    const t1Row = (l: Obj): Obj => must(arr(l['tasks']).find((t) => t['taskIri'] === ap.t1), 't1 row');
    const base = await list(w);
    expect(planRow(base)).toMatchObject({ stale: null });
    expect(planRow(base)['unreadable']).toBeUndefined();
    expect(arr(base['tasks']).map((t) => [t['orphaned'], t['retirementUnfinished'], t['workflowUnreadable']])).toEqual(arr(base['tasks']).map(() => [false, false, undefined]));
    expect(obj(t1Row(base)['effective'])).toMatchObject({ source: 'approved-decision', level: 'agent-drafts-person-decides' });
    expect(obj(t1Row(base)['effective'])['unreadable']).toBeUndefined();
    expect(arr(base['sealed'])).toEqual([]);
    /** Seal one version shut (its ciphertext changed on the pod); the returned function restores it. */
    const shut = (descriptorUrl: string): (() => void) => {
      const url = sealedGraphUrl(w, descriptorUrl);
      const original = must(w.pod.bodies.get(url));
      corruptSealed(w, url);
      return () => w.pod.tamper(url, must(w.pod.bodies.get(url)), original);
    };

    // (a) The workflow's head does not open: whether it lists a task is unknown, not "orphaned", and the plan's staleness is unknown.
    const reopenWf = shut(headOfRow(must(arr(base['workflows']).find((x) => x['workflowIri'] === ap.workflowIri), 'workflow row')).descriptorUrl);
    const a = await list(w);
    expect(arr(a['tasks'])).toHaveLength(4);
    for (const t of arr(a['tasks'])) {
      expect(t).toMatchObject({ orphaned: null, retirementUnfinished: null });
      expect(String(t['workflowUnreadable'])).toMatch(/whether the workflow lists this task is unknown: .*WRD_RECORD_KEY/);
    }
    expect(planRow(a)['stale']).toBeNull();
    expect(String(planRow(a)['unreadable'])).toMatch(/whether this plan is stale is unknown.*WRD_RECORD_KEY/);
    expect(arr(a['sealed']).map((s) => s['graphIri'])).toEqual([graphIriOf(ap.workflowIri)]);
    reopenWf();

    // (b) T1's classification head does not open: the plan is not called stale ("re-classified or revised"), its staleness is unknown.
    const reopenCls = shut(headOfRow(obj(t1Row(await list(w))['classification'], 'classification')).descriptorUrl);
    const b = await list(w);
    expect(planRow(b)['stale']).toBeNull();
    expect(String(planRow(b)['unreadable'])).toMatch(/whether this plan is stale is unknown: 1 record\(s\).*urn:wrd:classification:.*WRD_RECORD_KEY/);
    expect(t1Row(b)).toMatchObject({ orphaned: false, classification: { state: 'altered', trusted: false } });
    reopenCls();
    // (b') T1's own head does not open: the same.
    const reopenT1 = shut(headOfRow(t1Row(await list(w))).descriptorUrl);
    const b2 = await list(w);
    expect(planRow(b2)['stale']).toBeNull();
    expect(String(planRow(b2)['unreadable'])).toMatch(new RegExp(`stale is unknown.*${graphIriOf(ap.t1)}: .*WRD_RECORD_KEY`));
    reopenT1();
    expect(planRow(await list(w))).toMatchObject({ stale: null });

    // (c) The plan of the approved decision does not open: the allocation in force is not shown as the captured one, certain.
    const reopenPlan = shut(headOfRow(planRow(await list(w))).descriptorUrl);
    const c = await list(w);
    for (const t of arr(c['tasks'])) {
      expect(String(obj(t['effective'])['unreadable'])).toMatch(new RegExp(`cannot be read \\(${graphIriOf(planIri)}: .*WRD_RECORD_KEY.*\\), so the allocation in force may differ from this one`));
    }
    reopenPlan();
    const restored = await list(w);
    expect(obj(t1Row(restored)['effective'])).toMatchObject({ source: 'approved-decision' });
    expect(obj(t1Row(restored)['effective'])['unreadable']).toBeUndefined();

    // (d) An earlier version of the decision does not open: its chain says it is incomplete, and the graph is named under sealed.
    const chain = arr((await decisionRow(w, decisionIri))['chain']);
    expect(chain.map((v) => v['status'])).toEqual(['submitted', 'countersigned']);
    shut(String(must(chain[0])['descriptorUrl']));
    const d = await list(w);
    const row = must(arr(d['decisions']).find((x) => x['decisionIri'] === decisionIri), 'decision row');
    expect(arr(row['chain']).map((v) => v['status'])).toEqual(['countersigned']);
    expect(String(row['chainUnreadable'])).toMatch(new RegExp(`the chain below is incomplete: .*an earlier version \\(${String(must(chain[0])['descriptorUrl'])}\\) is not trusted: .*WRD_RECORD_KEY`));
    expect(arr(d['sealed']).map((s) => s['graphIri'])).toEqual([graphIriOf(decisionIri)]);
    expect(obj(t1Row(d)['effective'])).toMatchObject({ source: 'approved-decision' });
  }, 120_000);

  it('never answers from part of a line: with an earlier version that does not open, the holder\'s copy refuses (409) rather than come back without it and every version before it, and a write that checks the whole line refuses too', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const ap = await captureAp(w);
    const cyNote = 'Cy: the match also checks the supplier';
    ok(await ratify(w, CY, ap.t1, 'dispute', cyNote));
    const disputed = headOfRow(await taskRow(w, ap.t1));
    ok(await act(w, ANA, 'revise_task', { op: 'revise', taskIri: ap.t1, ...bound(disputed), description: 'Three-way match, supplier included.', note: 'added supplier' }));
    ok(await ratify(w, CY, ap.t1));
    const full = ok(await act(w, CY, 'holder_copy', {}));
    const t1Versions = arr(full['bundle']).filter((b) => b['entityIri'] === ap.t1).map((b) => b['descriptorUrl']);
    expect(t1Versions).toHaveLength(4);
    expect(t1Versions).toContain(disputed.descriptorUrl);

    // The disputed version (Cy's own signed note) no longer opens; the head still does.
    corruptSealed(w, sealedGraphUrl(w, disputed.descriptorUrl));
    expect(await taskRow(w, ap.t1)).toMatchObject({ status: 'ratified' });
    const copy = refused(await act(w, CY, 'holder_copy', {}), 409, /cannot tell whether they name you/,
      new RegExp(`cannot be read in full, for example ${graphIriOf(ap.t1)}: an earlier version \\(${disputed.descriptorUrl}\\) is not trusted: .*WRD_RECORD_KEY`));
    expect(copy['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
    expect(JSON.stringify(copy)).not.toContain(cyNote);
    // The durable replay check reads the whole line: a write to T1 refuses rather than check part of it.
    const before = (await manifest(w)).length;
    const head = headOfRow(await taskRow(w, ap.t1));
    const r = refused(await act(w, ANA, 'revise_task', { op: 'revise', taskIri: ap.t1, ...bound(head), description: 'Three-way match, supplier and tax code.', note: 'added tax code' }),
      409, /altered after signing/, new RegExp(`${graphIriOf(ap.t1)}: an earlier version \\(${disputed.descriptorUrl}\\) is not trusted: .*WRD_RECORD_KEY`));
    expect(r['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
    expect((await manifest(w)).length).toBe(before);
  }, 90_000);

  it('with a record key, keeps extending chains written without one under their unkeyed IRIs, and derives every new entity\'s IRI with the key', async () => {
    const w = await world();
    const { ap, planIri, valuation } = await valuedP1(w);
    ok(await acknowledge(w, CY, planIri, ap.t1, 'acknowledge'));
    const keyed = await sibling(w, { recordKey: K1 });
    const iriKey = entityIriKey(K1);
    const graphsOf = async (prefix: string): Promise<string[]> => [...new Set((await manifest(w)).flatMap((e) => e.describes).filter((g) => g.startsWith(prefix)))].sort();
    const classifications = await graphsOf('urn:wrd:classification:');
    const acks = await graphsOf('urn:wrd:acknowledgement:');
    // The same inputs find the valuation written without the key.
    const again = ok(await act(keyed, ANA, 'value_plan', { planIri, inputs: p1Inputs(ap) }));
    expect([again['reused'], again['valuationIri']]).toEqual([true, valuation['valuationIri']]);
    // A new entity is keyed, here a decision on the workflow written without the key.
    const decision = await submitValued(keyed, planIri, again);
    expect(decision['decisionIri']).toBe(entityIri('decision', ap.workflowIri, `${planIri}|${String(again['valuationHash'])}`, iriKey));
    expect(decision['decisionIri']).not.toBe(entityIri('decision', ap.workflowIri, `${planIri}|${String(again['valuationHash'])}`));
    // A second submission of the same decision finds it under its keyed IRI.
    refused(await act(keyed, ANA, 'submit_decision', { planIri, valuationIri: again['valuationIri'], valuationHash: again['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 } }), 409, /already submitted/);
    // Objecting to the assignment and re-classifying T1 extend the unkeyed chains; neither starts a keyed one.
    ok(await acknowledge(keyed, CY, planIri, ap.t1, 'object', 'Not without training on the matching tool'));
    ok(await classify(keyed, ANA, ap.t1, ANSWERS.evident));
    expect(await graphsOf('urn:wrd:classification:')).toEqual(classifications);
    expect(await graphsOf('urn:wrd:acknowledgement:')).toEqual(acks);
    expect(obj((await taskRow(keyed, ap.t1))['classification'])).toMatchObject({ state: 'ok', head: { versions: 3 } });
    expect(must(arr(must(arr((await list(keyed))['plans']).find((p) => p['planIri'] === planIri))['assignments']).find((a) => a['taskIri'] === ap.t1))['state']).toBe('objected');
    // And a new workflow and its tasks.
    const env = await envelope(keyed, ANA, 'wrd:capture-workflow', { workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' }, tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }] });
    const captured = ok(await http(keyed, 'POST', 'capture_workflow', { envelope: env }));
    const seed = `${addr(ANA)}|${String(env.payload['nonce'])}`;
    expect(captured['workflowIri']).toBe(entityIri('workflow', POD, seed, iriKey));
    expect(captured['workflowIri']).not.toBe(entityIri('workflow', POD, seed));
    expect(arr(captured['taskIris'] as unknown)).toEqual([entityIri('task', String(captured['workflowIri']), '1', iriKey)]);
  }, 90_000);

  it('names its record key in every keyed IRI: on a pod holding IRIs keyed under another key, a bridge with another key or none writes nothing and looks nothing up by tuple (409, naming WRD_RECORD_KEY), and its read model marks what it cannot know; the key\'s own bridge and a keyless pod go on', async () => {
    // History written without a key: registry, workflow, tasks, T1's classification.
    const w = await world();
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t1));
    ok(await ratify(w, DEE, ap.t2));
    ok(await classify(w, ANA, ap.t1, ANSWERS.evident));
    const keyedIri = /^urn:wrd:[a-z-]+:k[0-9a-f]{8}:/;
    // A keyless pod goes on keylessly: no IRI carries a key, nothing is mismatched.
    expect((await manifest(w)).flatMap((e) => e.describes).filter((g) => keyedIri.test(g))).toEqual([]);
    expect((await list(w))['recordKeyMismatch']).toBeUndefined();

    // The operator sets WRD_RECORD_KEY (K1): T2's classification is a new entity, keyed under K1 and naming K1's fingerprint.
    const k1 = await sibling(w, { recordKey: K1 });
    const fp1 = iriKeyFingerprint(entityIriKey(K1));
    const fp2 = iriKeyFingerprint(entityIriKey(K2));
    expect([fp1, fp2].every((f) => /^[0-9a-f]{8}$/.test(f)) && fp1 !== fp2).toBe(true);
    const c2 = ok(await classify(k1, ANA, ap.t2, ANSWERS.knowable));
    const c2Iri = String(c2['classificationIri']);
    expect(c2Iri).toBe(entityIri('classification', ap.workflowIri, ap.t2, entityIriKey(K1)));
    expect(c2Iri).toMatch(new RegExp(`^urn:wrd:classification:k${fp1}:[0-9a-f]{16}:[0-9a-f]{16}$`));
    const k1Read = await list(k1);
    expect(k1Read['recordKeyMismatch']).toBeUndefined();
    // The read model says what keyed IRIs still show: the key's fingerprint, which reveals nothing about it, and the segments one kind shares.
    expect(String(k1Read['readExposure'])).toMatch(/urn:wrd:<kind>:k<fingerprint>:<scope>:<id>\. The fingerprint \(8 hex\) names the record key it was derived under and reveals nothing about the key\./);
    expect(String(k1Read['readExposure'])).toMatch(/segments of different kinds or positions never match.*the scope segment groups records of one kind.*the id segment is equal where the id is/);
    // And what times show whatever the IRIs hide: the records one call writes share their instant, so a task's workflow is public.
    expect(String(k1Read['readExposure'])).toMatch(/Times link what one call writes: its records share generatedAtTime and validFrom.*which workflow a task belongs to, and its place among the tasks captured with it, are public whatever the IRIs hide/);
    expect(obj(must(arr(k1Read['tasks']).find((t) => t['taskIri'] === ap.t2))['classification'])).toMatchObject({ state: 'ok', regime: 'Knowable' });
    const texts = new Map(arr(k1Read['tasks']).map((t) => [String(t['taskIri']), String(t['textSha256'])]));
    const t1Head = headOfRow(must(arr(k1Read['tasks']).find((t) => t['taskIri'] === ap.t1)));

    const before = (await manifest(w)).length;
    for (const [extra, bridgeKey] of [[{ recordKey: K2 }, `holds the one with fingerprint k${fp2}`], [{}, 'holds no record key']] as const) {
      const other = await sibling(w, extra);
      const why = new RegExp(`${graphIriOf(c2Iri)} \\(.*\\) was derived under the record key with fingerprint k${fp1}, and this bridge ${bridgeKey} \\(WRD_RECORD_KEY\\): it derives other IRIs for the same records`);
      const writes: Array<[string, Res]> = [];
      // T2 classified again would start a second chain beside the one this bridge cannot see.
      writes.push(['classify_task', await act(other, ANA, 'classify_task', { taskIri: ap.t2, taskTextSha256: must(texts.get(ap.t2)), answers: ANSWERS.evident })]);
      writes.push(['ratify_task', await act(other, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1Head), verdict: 'dispute', note: 'not this way' })]);
      writes.push(['propose_allocation', await propose(other, ap, P1_CHANGES(ap), 'P-other')]);
      writes.push(['update_registry', await act(other, ADMIN, 'update_registry', { entries: [person(ZED, ['worker'], 'p-zed', 'Zed')] })]);
      writes.push(['capture_workflow', await act(other, ANA, 'capture_workflow', { workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' }, tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }] })]);
      writes.push(['holder_copy', await act(other, CY, 'holder_copy', {})]);
      for (const tool of ['record_task_map', 'revise_task', 'value_plan', 'submit_decision', 'countersign_decision', 'record_outcome', 'grant_autonomy', 'revoke_grant']) {
        writes.push([tool, await act(other, ANA, tool, {})]);
      }
      const run = await runEnvelope(other, `run-other-${bridgeKey.length}`, ap.t1, 'accepted');
      writes.push(['log_agent_run', await http(other, 'POST', 'log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(other, ELI, run, 'accepted') })]);
      for (const [tool, r] of writes) {
        refused(r, 409, /derived under a record key this bridge does not hold/, why);
        expect([tool, r.body['iep:resolvedBy']]).toEqual([tool, { env: 'WRD_RECORD_KEY' }]);
      }
      expect(writes.map(([tool]) => tool).sort()).toEqual([...Object.keys(INTENT), 'log_agent_run'].sort());
      // Nothing reached the pod.
      expect((await manifest(w)).length).toBe(before);
      // A lookup by tuple is refused too: the template for ratifying T2's classification (unsigned or signed).
      refused(await template(other, `intent=wrd:ratify-task&subject=classification&task_iri=${encodeURIComponent(ap.t2)}`, false), 409, /derived under a record key/, why);
      refused(await template(other, `intent=wrd:ratify-task&subject=classification&task_iri=${encodeURIComponent(ap.t2)}`), 409, /derived under a record key/, why);

      // The read model answers what it can read, and marks what rests on a record keyed under K1: T2 is not "not classified".
      const read = await list(other);
      expect(obj(read['recordKeyMismatch'])).toMatchObject({ env: 'WRD_RECORD_KEY', podKey: `k${fp1}`, bridgeKey: extra.recordKey ? `k${fp2}` : null });
      expect(String(obj(read['recordKeyMismatch'])['why'])).toMatch(why);
      const t2Cls = obj(must(arr(read['tasks']).find((t) => t['taskIri'] === ap.t2))['classification'], 'T2 classification');
      expect(t2Cls).toMatchObject({ state: 'unreadable', trusted: false });
      expect(String(t2Cls['unreadable'])).toMatch(new RegExp(`whether this task is classified is unknown: 1 classification record\\(s\\) on this pod were keyed under another record key and cannot be read.*${graphIriOf(c2Iri)}: .*WRD_RECORD_KEY`));
      expect(obj(must(arr(read['tasks']).find((t) => t['taskIri'] === ap.t1))['classification'])).toMatchObject({ state: 'ok', regime: 'Evident' });
      // Whether a task's allocation is one its classification allows is not worked out without the classification: unknown where
      // whether it is classified is (T2, and T3 and T4, which could be classified under K1), answered for T1, whose classification opens.
      const permitted = [ap.t1, ap.t2, ap.t3, ap.t4].map((iri) => must(arr(read['tasks']).find((t) => t['taskIri'] === iri)))
        .map((t) => [t['taskIri'], t['currentNotPermitted'], t['currentNotPermittedUnreadable'] === undefined ? 'answered' : 'unknown']);
      expect(permitted).toEqual([[ap.t1, null, 'answered'], [ap.t2, null, 'unknown'], [ap.t3, null, 'unknown'], [ap.t4, null, 'unknown']]);
      expect(String(must(arr(read['tasks']).find((t) => t['taskIri'] === ap.t2))['currentNotPermittedUnreadable']))
        .toMatch(new RegExp(`classification allows is unknown: 1 classification record\\(s\\) on this pod were keyed under another record key.*${graphIriOf(c2Iri)}: .*WRD_RECORD_KEY`));
      expect(String(obj(read['unreadable'])['currentNotPermitted'])).toMatch(/^3 task\(s\) have currentNotPermitted null because a decision, plan or classification it is read from cannot be read/);
      expect(arr(read['sealed']).map((x) => x['graphIri'])).toEqual([graphIriOf(c2Iri)]);
      expect(obj(ok(await calibration(other))['recordKeyMismatch'])).toMatchObject({ env: 'WRD_RECORD_KEY', podKey: `k${fp1}` });
    }

    // The key's own bridge goes on: Dee ratifies T2's classification, and the write lands.
    ok(await ratifyClassification(k1, DEE, ap.t2));
    expect((await manifest(w)).length).toBe(before + 1);
    // A descriptor a pod writer adds, naming a graph keyed under another key but signed by no trusted platform key, stops nothing.
    const forgedEntity = `urn:wrd:task:k${fp2}:${'0'.repeat(16)}:${'1'.repeat(16)}`;
    const at = w.clock.now().toISOString();
    const rogue = ContextDescriptor.create('urn:wrd:record:task-rogue' as IRI).describes(graphIriOf(forgedEntity) as IRI).conformsTo(`${WRD_NS}Task` as IRI)
      .temporal({ validFrom: at }).agent({ identity: 'did:ethr:0x0000000000000000000000000000000000000bad' as IRI, isSoftwareAgent: false }, 'Author')
      .selfAsserted('did:ethr:0x0000000000000000000000000000000000000bad' as IRI).hypothetical().build();
    await publish(rogue, `@prefix wrd: <${WRD_NS}> .\n<${forgedEntity}> a wrd:Task ; wrd:status "captured" ; wrd:payloadJson "{}" .\n`, POD,
      { fetch: w.pod.fetchFn, containerPath: WRD_CONTAINER, descriptorSlug: 'task-rogue', graphSlug: 'task-rogue-graph' });
    expect((await manifest(w)).some((e) => e.describes.includes(graphIriOf(forgedEntity)))).toBe(true);
    const k1After = await list(k1);
    expect(k1After['recordKeyMismatch']).toBeUndefined();
    expect(arr(k1After['untrusted']).map((u) => u['descriptorUrl'])).toContain(`${POD}${WRD_CONTAINER}task-rogue.ttl`);
    const t3 = headOfRow(must(arr(k1After['tasks']).find((t) => t['taskIri'] === ap.t3)));
    ok(await act(k1, CY, 'ratify_task', { subject: 'description', taskIri: ap.t3, ...bound(t3), verdict: 'ratify' }));
  }, 120_000);

  it('shows a record key from its first sealed write: on a keyless pod where the key\'s bridge has only sealed one new version of an old chain, whose signed record id names the key, a bridge with another key or none writes nothing and looks nothing up by tuple (409, naming WRD_RECORD_KEY and both fingerprints) and marks its read model; the key\'s own bridge goes on and counts the plaintext versions written before the key, no edit of its own envelope or descriptor stops it, a keyless pod stays keyless, and a pod keyed throughout refuses another key', async () => {
    const reEscape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyedIri = /^urn:wrd:[a-z-]+:k[0-9a-f]{8}:/;
    // History written without a key; a second keyless bridge goes on writing it keylessly, and nothing is mismatched.
    const w = await world();
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, DEE, ap.t2));
    ok(await classify(w, ANA, ap.t1, ANSWERS.evident));
    const keyless0 = await sibling(w, {});
    ok(await ratify(keyless0, DEE, ap.t4));
    expect((await list(keyless0))['recordKeyMismatch']).toBeUndefined();
    expect([...w.pod.bodies.keys()].filter((u) => u.endsWith('-graph.envelope.jose.json'))).toEqual([]);

    // The operator sets WRD_RECORD_KEY (K1), and its bridge writes ONE record: Cy ratifies T1, a new version of T1's chain under its unkeyed IRI, sealed to K1.
    const k1 = await sibling(w, { recordKey: K1 });
    const fp1 = recordKeyFingerprint(K1);
    const fp2 = recordKeyFingerprint(K2);
    const start = (await manifest(w)).length;
    // Before it, every version on the pod was written without a key: no record id names one.
    expect((await manifest(w)).filter((e) => /-k[0-9a-f]{8}\.ttl$/.test(e.descriptorUrl))).toEqual([]);
    ok(await ratify(k1, CY, ap.t1));
    const entries = await manifest(w);
    expect(entries.length).toBe(start + 1);
    expect(entries.flatMap((e) => e.describes).filter((g) => keyedIri.test(g))).toEqual([]);
    expect([...w.pod.bodies.keys()].filter((u) => u.endsWith('-graph.envelope.jose.json'))).toHaveLength(1);
    const k1Read = await list(k1);
    expect(k1Read['recordKeyMismatch']).toBeUndefined();
    const t1Head = headOfRow(must(arr(k1Read['tasks']).find((t) => t['taskIri'] === ap.t1)));
    expect(must(w.pod.bodies.get(t1Head.descriptorUrl))).toMatch(/iep:encrypted true/);
    // Its record id, which the platform signs and the descriptor's URL repeats, names K1's fingerprint: the manifest shows the key from this first write.
    expect([t1Head.recordId, t1Head.descriptorUrl]).toEqual([expect.stringMatching(new RegExp(`^urn:wrd:record:task-[0-9a-f]{16}-k${fp1}$`)), expect.stringMatching(new RegExp(`/task-[0-9a-f]{16}-k${fp1}\\.ttl$`))]);
    // The versions written before the key stay plaintext on the pod; the key's bridge counts and lists them, and readExposure says so.
    const plaintext = obj(k1Read['plaintext'], 'plaintext');
    expect(plaintext['versions']).toBe(start);
    expect(arr(plaintext['descriptorUrls']).length).toBe(Math.min(start, 20));
    expect(String(plaintext['why'])).toMatch(/written without a record key.*plaintext on the pod.*until they are removed/);
    for (const u of plaintext['descriptorUrls'] as string[]) expect(sealedGraphUrl(w, u)).not.toMatch(/envelope\.jose\.json$/);
    expect(String(k1Read['readExposure'])).toMatch(new RegExp(`This pod holds ${start} record version\\(s\\) written before the record key, whose graphs are plaintext \\(listed under plaintext\\)\\. Record graphs this bridge writes are sealed`));
    expect(String(k1Read['readExposure'])).toMatch(/Graphs written before the key .* stay plaintext on the pod/);
    const texts = new Map(arr(k1Read['tasks']).map((t) => [String(t['taskIri']), String(t['textSha256'])]));

    // No IRI on the pod is keyed, but the sealed version's signed record id names K1: a bridge holding K2, or no key, writes nothing.
    const before = (await manifest(w)).length;
    for (const [extra, bridgeKey] of [[{ recordKey: K2 }, `holds the one with fingerprint k${fp2}`], [{}, 'holds no record key']] as const) {
      const other = await sibling(w, extra);
      const why = new RegExp(`${reEscape(graphIriOf(ap.t1))} \\(${reEscape(t1Head.descriptorUrl)}\\) is sealed to the record key with fingerprint k${fp1} \\(its record id, which the platform signed, names it\\), and this bridge ${reEscape(bridgeKey)} \\(WRD_RECORD_KEY\\): it cannot open what was written under that key`);
      const writes: Array<[string, Res]> = [];
      writes.push(['classify_task', await act(other, ANA, 'classify_task', { taskIri: ap.t2, taskTextSha256: must(texts.get(ap.t2)), answers: ANSWERS.knowable })]);
      writes.push(['ratify_task', await act(other, DEE, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1Head), verdict: 'dispute', note: 'not this way' })]);
      writes.push(['propose_allocation', await propose(other, ap, P1_CHANGES(ap), 'P-other')]);
      // The registry is still plaintext (written before the key): sealing it to another key, or none, would shut K1's bridge out.
      writes.push(['update_registry', await act(other, ADMIN, 'update_registry', { taskKinds: [{ slug: 'extra-kind', label: 'Extra', definition: 'An extra kind.' }] })]);
      writes.push(['capture_workflow', await act(other, ANA, 'capture_workflow', { workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' }, tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }] })]);
      writes.push(['holder_copy', await act(other, CY, 'holder_copy', {})]);
      for (const tool of ['record_task_map', 'revise_task', 'value_plan', 'submit_decision', 'countersign_decision', 'record_outcome', 'grant_autonomy', 'revoke_grant']) {
        writes.push([tool, await act(other, ANA, tool, {})]);
      }
      const run = await runEnvelope(other, `run-window-${bridgeKey.length}`, ap.t1, 'accepted');
      writes.push(['log_agent_run', await http(other, 'POST', 'log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(other, ELI, run, 'accepted') })]);
      for (const [tool, r] of writes) {
        refused(r, 409, /sealed to a record key this bridge does not hold/, why);
        expect([tool, r.body['iep:resolvedBy']]).toEqual([tool, { env: 'WRD_RECORD_KEY' }]);
      }
      expect(writes.map(([tool]) => tool).sort()).toEqual([...Object.keys(INTENT), 'log_agent_run'].sort());
      // Nothing reached the pod.
      expect((await manifest(w)).length).toBe(before);
      // A lookup by tuple is refused too.
      refused(await template(other, `intent=wrd:ratify-task&subject=classification&task_iri=${encodeURIComponent(ap.t2)}`, false), 409, /sealed to a record key/, why);
      // The read model answers what it can read, says why under recordKeyMismatch, and lists the version it cannot open.
      const read = await list(other);
      expect(obj(read['recordKeyMismatch'])).toEqual({ why: expect.stringMatching(why), env: 'WRD_RECORD_KEY', podKey: `k${fp1}`, bridgeKey: extra.recordKey ? `k${fp2}` : null });
      expect(arr(read['sealed']).map((x) => x['graphIri'])).toEqual([graphIriOf(ap.t1)]);
      expect(obj(ok(await calibration(other))['recordKeyMismatch'])).toEqual({ why: expect.stringMatching(why), env: 'WRD_RECORD_KEY', podKey: `k${fp1}`, bridgeKey: extra.recordKey ? `k${fp2}` : null });
      // A bridge with no key says every record is plaintext; it counts none apart.
      if (!extra.recordKey) expect([read['plaintext'], String(read['readExposure'])]).toEqual([undefined, expect.stringMatching(/Records are written in plaintext/)]);
    }
    // The version that names K1 is read to decide (the URL alone could be a pod writer's): while the pod cannot serve it, a bridge holding no key
    // writes nothing and answers 502, naming it, rather than write past it; then 409 again.
    const failing = await sibling(w, { fetchFn: (async (url, init) => (String(url) === t1Head.descriptorUrl
      ? new Response('pod failure', { status: 500, statusText: 'Internal Server Error' }) : w.pod.fetchFn(url, init))) as PodFetch });
    refused(await act(failing, ADMIN, 'update_registry', { taskKinds: [{ slug: 'extra-kind', label: 'Extra', definition: 'An extra kind.' }] }), 502, undefined, new RegExp(reEscape(t1Head.descriptorUrl)));
    expect((await manifest(w)).length).toBe(before);

    // The key's own bridge goes on: the registry (sealed to K1 from now on), and a classification under a keyed IRI.
    ok(await act(k1, ADMIN, 'update_registry', { taskKinds: [{ slug: 'extra-kind', label: 'Extra', definition: 'An extra kind.' }] }));
    ok(await classify(k1, ANA, ap.t2, ANSWERS.knowable));
    expect((await manifest(w)).length).toBe(before + 2);
    expect((await list(k1))['recordKeyMismatch']).toBeUndefined();
    // Whom a version was sealed to is what the platform signed, never the envelope's own word: a pod writer who changes a K1 version's ciphertext,
    // names K2 as its recipient, or empties its recipients stops nothing but that graph (409), for a fresh K1 bridge and for one that saw the edit,
    // and once the bytes are restored the graph opens again, with no restart.
    const t1Sealed = sealedGraphUrl(w, t1Head.descriptorUrl);
    const sealedBytes = must(w.pod.bodies.get(t1Sealed));
    // Each K1 bridge below writes, so each signs from its own run of nonces.
    let bridges = 0;
    const k1Bridge = async (extra: Partial<WrdDeps> = {}): Promise<World> => {
      const b = await sibling(w, { recordKey: K1, ...extra });
      bridges += 1;
      b.nonce += bridges * 10_000;
      return b;
    };
    const k1Saw = await k1Bridge();
    const edits: Array<[string, (env: Obj) => void]> = [
      ['ciphertext', (env) => { const c = String(obj(env['content'])['ciphertext']); obj(env['content'])['ciphertext'] = `${c.slice(0, 8)}${c.charAt(8) === 'A' ? 'B' : 'A'}${c.slice(9)}`; }],
      ['recipient', (env) => { obj(arr(env['wrappedKeys'])[0])['recipientPublicKey'] = K2.publicKey; }],
      ['no recipients', (env) => { env['wrappedKeys'] = []; }],
    ];
    let kinds = 0;
    for (const [edit, change] of edits) {
      const env = JSON.parse(sealedBytes) as Obj;
      change(env);
      w.pod.tamper(t1Sealed, sealedBytes, JSON.stringify(env));
      for (const bridge of [await k1Bridge(), k1Saw]) {
        const again = await list(bridge);
        expect([edit, again['recordKeyMismatch']]).toEqual([edit, undefined]);
        expect(arr(again['altered'])).toContain(graphIriOf(ap.t1));
        kinds += 1;
        ok(await act(bridge, ADMIN, 'update_registry', { taskKinds: [{ slug: `edit-kind-${kinds}`, label: 'Another', definition: 'Another kind.' }] }), edit);
        refused(await act(bridge, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1Head), verdict: 'ratify' }), 409, /altered after signing/, /sealed to a key this bridge does not hold, or the sealed bytes were changed/);
      }
      w.pod.tamper(t1Sealed, JSON.stringify(env), sealedBytes);
      expect(obj(must(arr((await list(k1Saw))['tasks']).find((t) => t['taskIri'] === ap.t1)))['head']).toMatchObject({ descriptorUrl: t1Head.descriptorUrl, trusted: true });
    }
    // Nor does a descriptor of its own whose iep:describes a pod writer changed, with the manifest, to an IRI keyed under K2 (its sealed bytes changed too, so it does not open).
    const forged = `urn:wrd:task:k${fp2}:${'2'.repeat(16)}:${'3'.repeat(16)}:graph`;
    const manifestUrl = predictManifestUrl(POD);
    const descriptorBytes = must(w.pod.bodies.get(t1Head.descriptorUrl));
    const manifestBytes = must(w.pod.bodies.get(manifestUrl));
    corruptSealed(w, t1Sealed);
    w.pod.tamper(t1Head.descriptorUrl, `iep:describes <${graphIriOf(ap.t1)}>`, `iep:describes <${forged}>`);
    w.pod.tamper(manifestUrl, manifestBytes, manifestBytes.split('\n\n').map((b) => (b.startsWith(`<${t1Head.descriptorUrl}>`) ? b.replace(`<${graphIriOf(ap.t1)}>`, `<${forged}>`) : b)).join('\n\n'));
    expect(must((await manifest(w)).find((e) => e.descriptorUrl === t1Head.descriptorUrl)).describes).toEqual([forged]);
    const k1Forged = await k1Bridge();
    expect((await list(k1Forged))['recordKeyMismatch']).toBeUndefined();
    ok(await act(k1Forged, ADMIN, 'update_registry', { taskKinds: [{ slug: 'forged-kind', label: 'Another', definition: 'Another kind.' }] }));
    w.pod.tamper(t1Head.descriptorUrl, must(w.pod.bodies.get(t1Head.descriptorUrl)), descriptorBytes);
    w.pod.tamper(manifestUrl, must(w.pod.bodies.get(manifestUrl)), must(w.pod.bodies.get(manifestUrl)).replace(`<${forged}>`, `<${graphIriOf(ap.t1)}>`));
    w.pod.tamper(t1Sealed, must(w.pod.bodies.get(t1Sealed)), sealedBytes);
    // A version of another workflow the pod cannot serve stops no unrelated write either: only versions whose URL names another key are read for this.
    const t3Head = headOfRow(must(arr((await list(k1))['tasks']).find((t) => t['taskIri'] === ap.t3)));
    const t4Head = headOfRow(must(arr((await list(k1))['tasks']).find((t) => t['taskIri'] === ap.t4)));
    const t4Down = await k1Bridge({ fetchFn: (async (url, init) => (String(url) === t4Head.descriptorUrl
      ? new Response('pod failure', { status: 500, statusText: 'Internal Server Error' }) : w.pod.fetchFn(url, init))) as PodFetch });
    ok(await act(t4Down, CY, 'ratify_task', { subject: 'description', taskIri: ap.t3, ...bound(t3Head), verdict: 'ratify' }));

    // A pod keyed throughout: another key's bridge cannot read it (its registry is sealed) and writes nothing.
    const pure = await world({ recordKey: K1 });
    await register(pure);
    await captureAp(pure);
    const k2 = await sibling(pure, { recordKey: K2 });
    const pureBefore = (await manifest(pure)).length;
    refused(await http(k2, 'POST', 'read_records', { envelope: await readEnvelope(k2) }), 409, /derived under a record key this bridge does not hold/, new RegExp(`fingerprint k${fp1}, and this bridge holds the one with fingerprint k${fp2} \\(WRD_RECORD_KEY\\).*nor can it use the pod's registry`));
    refused(await act(k2, ADMIN, 'update_registry', { taskKinds: [{ slug: 'extra-kind', label: 'Extra', definition: 'An extra kind.' }] }), 409, /derived under a record key this bridge does not hold/, /\(WRD_RECORD_KEY\)/);
    expect((await manifest(pure)).length).toBe(pureBefore);
  }, 120_000);

  it('never sets aside a version a trusted key signed where its proof says for an edit to its descriptor\'s iep:describes alone: the graph answers 409 (altered), no write proceeds from the version before it, and once the bytes are restored it reads again with no fork; a task head and a registry head alike', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const ap = await captureAp(w);
    const t1First = headOfRow(await taskRow(w, ap.t1));
    ok(await ratify(w, CY, ap.t1));
    const t1Head = headOfRow(await taskRow(w, ap.t1));
    const t1Graph = graphIriOf(ap.t1);
    const fp2 = recordKeyFingerprint(K2);
    const t1Sealed = sealedGraphUrl(w, t1Head.descriptorUrl);
    const sealedBytes = must(w.pod.bodies.get(t1Sealed));
    const descriptorBytes = must(w.pod.bodies.get(t1Head.descriptorUrl));
    const entry = must((await manifest(w)).find((e) => e.descriptorUrl === t1Head.descriptorUrl)) as Parameters<typeof readRecord>[0];
    const trusted = new Set([addr(PLATFORM)]);
    const t1Versions = async (): Promise<number> => (await manifest(w)).filter((e) => e.describes.includes(t1Graph)).length;
    expect(await t1Versions()).toBe(2);
    // iep:describes pointed at another task of the workflow, at an IRI keyed under another key, and at the workflow's own graph; then at
    // another task's graph with the sealed bytes changed too, so the graph cannot be found at all (only the manifest is left as it was).
    const edits: Array<[string, string, boolean]> = [
      ['another task of the workflow', graphIriOf(ap.t2), false],
      ['an IRI keyed under another key', `urn:wrd:task:k${fp2}:${'2'.repeat(16)}:${'3'.repeat(16)}:graph`, false],
      ['the workflow', graphIriOf(ap.workflowIri), false],
      ['another task, with its sealed bytes changed', graphIriOf(ap.t2), true],
    ];
    let kinds = 0;
    for (const [edit, target, ciphertextToo] of edits) {
      w.pod.tamper(t1Head.descriptorUrl, `iep:describes <${t1Graph}>`, `iep:describes <${target}>`);
      if (ciphertextToo) corruptSealed(w, t1Sealed);
      const edited = must(w.pod.bodies.get(t1Head.descriptorUrl));
      // Placed by its signed descriptor first: eligible, never trusted, and a version of T1's graph, by its signed content when the graph opens.
      const loaded = await readRecord(entry, POD, w.pod.fetchFn, trusted, undefined, WRD_CONTAINER, K1);
      expect([edit, loaded.authorship.eligible, loaded.authorship.trusted]).toEqual([edit, true, false]);
      if (ciphertextToo) expect([edit, loaded.record, loaded.why]).toEqual([edit, null, SEALED_OTHER_KEY]);
      else expect([edit, loaded.graphIri, loaded.record?.entityIri, loaded.why, loaded.authorship.contentBinding]).toEqual([edit, t1Graph, ap.t1, DESCRIBES_ALTERED, 'bound']);
      const why = ciphertextToo ? /sealed to a key this bridge does not hold, or the sealed bytes were changed/ : /its descriptor was altered after signing: its iep:describes no longer names the graph its proof covers/;
      // The bridge that wrote it and a fresh one: T1 is altered, never its first version again, and no other key is suspected.
      for (const bridge of [w, await sibling(w, { recordKey: K1 })]) {
        const listed = await list(bridge);
        expect([edit, arr(listed['altered']), arr(listed['forked']), listed['recordKeyMismatch']]).toEqual([edit, expect.arrayContaining([t1Graph]), [], undefined]);
        expect(arr(listed['tasks']).map((t) => t['taskIri'])).not.toContain(ap.t1);
        expect(arr(must(arr(listed['integrity']).find((i) => i['graphIri'] === t1Graph), 'T1 integrity')['heads'])).toEqual([expect.objectContaining({ descriptorUrl: t1Head.descriptorUrl, trusted: false })]);
        // A write bound to the edited head, or to the version before it, is refused: nothing proceeds from the older version.
        for (const binding of [t1Head, t1First]) {
          refused(await act(bridge, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(binding), verdict: 'dispute', note: 'after the edit' }), 409, /altered after signing/, why);
        }
      }
      expect(await t1Versions()).toBe(2);
      // It stops nothing else.
      kinds += 1;
      ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: `describes-kind-${kinds}`, label: 'Another', definition: 'Another kind.' }] }), edit);
      // Restored, T1 reads again from the same head, trusted, with no fork and no restart.
      w.pod.tamper(t1Head.descriptorUrl, edited, descriptorBytes);
      if (ciphertextToo) w.pod.tamper(t1Sealed, must(w.pod.bodies.get(t1Sealed)), sealedBytes);
      const back = await list(w);
      expect([edit, arr(back['forked']), arr(back['altered'])]).toEqual([edit, [], []]);
      expect(obj(must(arr(back['tasks']).find((t) => t['taskIri'] === ap.t1))['head'])).toMatchObject({ descriptorUrl: t1Head.descriptorUrl, trusted: true });
    }
    ok(await ratify(w, CY, ap.t1, 'dispute', 'one more look after the restore'));
    expect(await t1Versions()).toBe(3);
    expect(arr((await list(w))['forked'])).toEqual([]);

    // The registry head alike: Cy is removed, and an edit to only the iep:describes of the version that removed her gives her back no read and no write.
    ok(await act(w, ADMIN, 'update_registry', { entries: [{ address: CY.address, roles: [] }] }));
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) }), 403, /Only an admin or a key in this pod's registry/);
    const regHead = obj(obj((await list(w))['registry'])['head']);
    const regUrl = String(regHead['descriptorUrl']);
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    const regBytes = must(w.pod.bodies.get(regUrl));
    const t1Now = headOfRow(await taskRow(w, ap.t1));
    const before = (await manifest(w)).length;
    w.pod.tamper(regUrl, `iep:describes <${registryGraph}>`, `iep:describes <urn:wrd:registry:k${fp2}:${'1'.repeat(16)}:${'2'.repeat(16)}:graph>`);
    for (const bridge of [w, await sibling(w, { recordKey: K1 })]) {
      for (const who of [CY, ANA, ADMIN]) {
        for (const tool of ['read_records', 'read_calibration']) {
          refused(await http(bridge, 'POST', tool, { envelope: await readEnvelope(bridge, who) }), 409, /altered after signing/, new RegExp(`${registryGraph}: its current version \\(${regUrl}\\) is not trusted: its descriptor was altered after signing: its iep:describes no longer names the graph its proof covers`));
        }
      }
      refused(await act(bridge, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1Now), verdict: 'ratify' }), 409, /altered after signing/, /iep:describes no longer names/);
      refused(await act(bridge, ADMIN, 'update_registry', { taskKinds: [{ slug: 'registry-edit-kind', label: 'Another', definition: 'Another kind.' }] }), 409, /altered after signing/, /iep:describes no longer names/);
    }
    expect((await manifest(w)).length).toBe(before);
    w.pod.tamper(regUrl, must(w.pod.bodies.get(regUrl)), regBytes);
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) }), 403, /Only an admin or a key in this pod's registry/);
    const restored = await list(w);
    expect(obj(obj(restored['registry'])['head'])).toMatchObject({ descriptorUrl: regUrl, trusted: true, versions: regHead['versions'] });
    expect(arr(obj(restored['registry'])['members']).map((m) => m['address'])).not.toContain(addr(CY));
    expect([arr(restored['forked']), arr(restored['altered'])]).toEqual([[], []]);
    ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'after-restore-kind', label: 'Another', definition: 'Another kind.' }] }));
  }, 120_000);

  it('places a version by the signed proof alone: an edit to its descriptor\'s layout, comments or subject, or a decoy proof block, never sets aside a version a trusted key signed where its proof says; it reads trusted or answers 409 (altered), nothing proceeds from the version before it, and once restored it reads with no fork; a task head and a registry head alike', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const ap = await captureAp(w);
    const t1First = headOfRow(await taskRow(w, ap.t1));
    ok(await ratify(w, CY, ap.t1));
    const t1Head = headOfRow(await taskRow(w, ap.t1));
    const t1Graph = graphIriOf(ap.t1);
    const trusted = new Set([addr(PLATFORM)]);
    const edits = descriptorEdits();
    const escape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // A task head: placed (eligible) every time, trusted or altered as the table says, never set aside for the version before it.
    const entry = must((await manifest(w)).find((e) => e.descriptorUrl === t1Head.descriptorUrl)) as Parameters<typeof readRecord>[0];
    const headBytes = must(w.pod.bodies.get(t1Head.descriptorUrl));
    const firstBytes = must(w.pod.bodies.get(t1First.descriptorUrl));
    for (const [edit, apply, why] of edits) {
      const edited = apply(headBytes, firstBytes);
      expect([edit, edited === headBytes]).toEqual([edit, false]);
      w.pod.tamper(t1Head.descriptorUrl, headBytes, edited);
      const loaded = await readRecord(entry, POD, w.pod.fetchFn, trusted, undefined, WRD_CONTAINER, K1);
      expect([edit, loaded.authorship.eligible, loaded.authorship.atPredictedUrl, loaded.recordId, loaded.authorship.trusted, loaded.why])
        .toEqual([edit, true, true, t1Head.recordId, why === null, why]);
      const listed = await list(w);
      expect([edit, arr(listed['untrusted']).map((u) => u['descriptorUrl']), arr(listed['forked'])]).toEqual([edit, [], []]);
      if (why === null) {
        expect([edit, arr(listed['altered'])]).toEqual([edit, []]);
        expect([edit, obj(must(arr(listed['tasks']).find((t) => t['taskIri'] === ap.t1))['head'])]).toEqual([edit, expect.objectContaining({ descriptorUrl: t1Head.descriptorUrl, trusted: true })]);
        refused(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1First), verdict: 'dispute', note: 'from the version before' }), 409, /changed since you read it/);
      } else {
        expect([edit, arr(listed['altered'])]).toEqual([edit, [t1Graph]]);
        expect(arr(listed['tasks']).map((t) => t['taskIri'])).not.toContain(ap.t1);
        for (const binding of [t1Head, t1First]) {
          refused(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(binding), verdict: 'dispute', note: 'after the edit' }), 409, /altered after signing/, new RegExp(escape(why)));
        }
      }
      // Restored: the same head, trusted, with no fork and nothing written in between.
      w.pod.tamper(t1Head.descriptorUrl, edited, headBytes);
      const back = await list(w);
      expect([edit, arr(back['forked']), arr(back['altered'])]).toEqual([edit, [], []]);
      expect(obj(must(arr(back['tasks']).find((t) => t['taskIri'] === ap.t1))['head'])).toMatchObject({ descriptorUrl: t1Head.descriptorUrl, trusted: true });
    }
    expect((await manifest(w)).filter((e) => e.describes.includes(t1Graph)).length).toBe(2);
    ok(await ratify(w, CY, ap.t1, 'dispute', 'one more look after the edits'));
    expect(arr((await list(w))['forked'])).toEqual([]);

    // The registry head alike: Cy is removed by it, and no edit to its descriptor gives her a read back.
    ok(await act(w, ADMIN, 'update_registry', { entries: [{ address: CY.address, roles: [] }] }));
    const regHead = obj(obj((await list(w))['registry'])['head']);
    const regUrl = String(regHead['descriptorUrl']);
    const regBytes = must(w.pod.bodies.get(regUrl));
    const regPrevUrl = must(must((await manifest(w)).find((e) => e.descriptorUrl === regUrl)).supersedes?.[0], 'the registry version before');
    const regPrevBytes = must(w.pod.bodies.get(regPrevUrl));
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    const versions = (await manifest(w)).length;
    for (const [edit, apply, why] of edits) {
      const edited = apply(regBytes, regPrevBytes);
      w.pod.tamper(regUrl, regBytes, edited);
      const cyRead = await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) });
      if (why === null) {
        refused(cyRead, 403, /Only an admin or a key in this pod's registry/);
        const listed = await list(w);
        expect([edit, obj(obj(listed['registry'])['head'])]).toEqual([edit, expect.objectContaining({ descriptorUrl: regUrl, trusted: true })]);
        expect([edit, arr(listed['untrusted']), arr(listed['altered']), arr(listed['forked'])]).toEqual([edit, [], [], []]);
      } else {
        const whyRe = new RegExp(`${escape(registryGraph)}: its current version \\(${escape(regUrl)}\\) is not trusted: ${escape(why)}`);
        for (const who of [CY, ADMIN]) refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, who) }), 409, /altered after signing/, whyRe);
        refused(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'registry-layout-kind', label: 'Another', definition: 'Another kind.' }] }), 409, /altered after signing/, whyRe);
      }
      w.pod.tamper(regUrl, edited, regBytes);
      refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) }), 403, /Only an admin or a key in this pod's registry/);
      const restored = await list(w);
      expect([edit, obj(obj(restored['registry'])['head'])]).toEqual([edit, expect.objectContaining({ descriptorUrl: regUrl, trusted: true })]);
      expect([edit, arr(restored['forked']), arr(restored['altered'])]).toEqual([edit, [], []]);
    }
    expect((await manifest(w)).length).toBe(versions);
    ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'after-layout-kind', label: 'Another', definition: 'Another kind.' }] }));
    expect(arr((await list(w))['forked'])).toEqual([]);
  }, 180_000);

  it('reads every edit in the table the same way on a decision\'s current version and on an earlier version of a task, a decision and the registry: a respelling or a comment leaves the line whole and the head current; an edit to what the bridge reads makes that version altered, a current one answering 409 and an earlier one cutting the line there; none ever makes another version current, and restored, every line reads whole', async () => {
    const w = await world({ recordKey: K1 });
    const { ap, planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    await acknowledgeAll(w, planIri);
    ok(await countersign(w, BO, decisionIri, 'approve'));
    ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'earlier-edits-kind', label: 'Another', definition: 'Another kind.' }] }));
    const view = (): PodView => new PodView(POD, w.pod.fetchFn, new Set([addr(PLATFORM)]), new Map(), true, K1);
    const graphs = { task: graphIriOf(ap.t1), decision: graphIriOf(decisionIri), registry: graphIriOf(entityIri('registry', POD, 'registry')) };
    const lines = new Map<string, LoadedRecord[]>();
    for (const g of Object.values(graphs)) {
      const v = view();
      const l = await v.line(await v.graph(g));
      expect([g, l.cut, l.versions.length >= 2]).toEqual([g, null, true]);
      lines.set(g, l.versions);
    }
    // [what, the graph, which version: 1 the current one, 2 the one before it]
    const targets: ReadonlyArray<readonly [string, string, 1 | 2]> = [
      ['the decision\'s current version', graphs.decision, 1],
      ['the task\'s version before its current one', graphs.task, 2],
      ['the decision\'s version before its current one', graphs.decision, 2],
      ['the registry\'s version before its current one', graphs.registry, 2],
    ];
    for (const [what, g, back] of targets) {
      const versions = must(lines.get(g));
      const head = must(versions[versions.length - 1]);
      const target = must(versions[versions.length - back]);
      const prev = versions[versions.length - back - 1] ?? target;
      const bytes = must(w.pod.bodies.get(target.descriptorUrl));
      const prevBytes = must(w.pod.bodies.get(prev.descriptorUrl));
      for (const [edit, apply, why] of descriptorEdits()) {
        const edited = apply(bytes, prevBytes);
        const label = `${what}: ${edit}`;
        expect([label, edited === bytes]).toEqual([label, false]);
        w.pod.tamper(target.descriptorUrl, bytes, edited);
        const v = view();
        const gh = await v.graph(g);
        const l = await v.line(gh);
        // Never another version current, nothing set aside.
        expect([label, gh.heads.map((h) => h.descriptorUrl), gh.untrusted]).toEqual([label, [head.descriptorUrl], []]);
        if (why === null) {
          expect([label, gh.state, l.cut, l.versions.map((x) => x.descriptorUrl)]).toEqual([label, 'ok', null, versions.map((x) => x.descriptorUrl)]);
        } else if (back === 1) {
          expect([label, gh.state, gh.why]).toEqual([label, 'altered', why]);
        } else {
          expect([label, gh.state, l.cut?.descriptorUrl, l.cut?.why]).toEqual([label, 'ok', target.descriptorUrl, `an earlier version (${target.descriptorUrl}) is not trusted: ${why}`]);
        }
        w.pod.tamper(target.descriptorUrl, edited, bytes);
      }
      const v = view();
      const restored = await v.graph(g);
      expect([what, restored.state, (await v.line(restored)).cut]).toEqual([what, 'ok', null]);
    }
    expect(arr((await list(w))['forked'])).toEqual([]);
  }, 300_000);

  it('a platform address dropped from the trusted list cuts every line holding a version it signed: the read model names each under chainCuts with that address, and a write to such a graph refuses (409) naming WRD_TRUSTED_PLATFORM_ADDRESSES, never a deletion; listed again, the writes go ahead', async () => {
    const OLD = wallet('platform-old', 'agent');
    const w = await world({ platform: { wallet: OLD, keyKind: 'configured' } });
    await register(w);
    const ap = await captureAp(w);
    // The key is rotated: the new key signs, the old one stays trusted, and both graphs gain a version the new key signs.
    const rotated = await sibling(w, { trustedPlatformAddresses: [OLD.address] });
    ok(await act(rotated, ADMIN, 'update_registry', { taskKinds: [{ slug: 'after-rotation', label: 'Another', definition: 'Another kind.' }] }));
    ok(await ratify(rotated, CY, ap.t1));
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    expect(arr((await list(rotated))['chainCuts'])).toEqual([]);
    // The old address dropped: every graph with a version it signed is cut there.
    const alone = await sibling(rotated, {});
    const listed = await list(alone);
    const cuts = arr(listed['chainCuts']);
    expect(cuts.filter((c) => c['graphIri'] === registryGraph || c['graphIri'] === graphIriOf(ap.t1)).map((c) => [c['graphIri'], c['untrustedKey'], c['sealed']]).sort())
      .toEqual([[graphIriOf(ap.t1), addr(OLD), false], [registryGraph, addr(OLD), false]].sort());
    expect(String(must(cuts.find((c) => c['graphIri'] === registryGraph))['why'])).toMatch(/was signed by the platform key 0x[0-9a-f]{40}, which this bridge does not trust: a platform address that signed records on this pod must stay in WRD_TRUSTED_PLATFORM_ADDRESSES/);
    // Every graph the old key alone signed reads absent; those are not cuts. The registry the new key extended is current.
    expect(obj(obj(listed['registry'])['head'])['trusted']).toBe(true);
    const refusal = refused(await act(alone, ADMIN, 'update_registry', { taskKinds: [{ slug: 'while-distrusted', label: 'Another', definition: 'Another kind.' }] }), 409, /an earlier version signed by a platform key this bridge no longer trusts/,
      /which this bridge does not trust: a platform address that signed records on this pod must stay in WRD_TRUSTED_PLATFORM_ADDRESSES/);
    expect(refusal['iep:resolvedBy']).toEqual({ env: 'WRD_TRUSTED_PLATFORM_ADDRESSES', address: addr(OLD) });
    expect(String(refusal['iep:refusalReason'])).not.toMatch(/it was deleted/);
    // Listed again: the line is whole, and the write goes ahead.
    const again = await sibling(alone, { trustedPlatformAddresses: [OLD.address] });
    expect(arr((await list(again))['chainCuts'])).toEqual([]);
    ok(await act(again, ADMIN, 'update_registry', { taskKinds: [{ slug: 'trusted-again', label: 'Another', definition: 'Another kind.' }] }));
  }, 120_000);

  it('bounds holder copies: one from a key neither an admin nor in the registry spends its nonce (a replay is 409) and draws on a budget all such keys share (429 beyond it, before anything is read); someone removed from the registry still takes their copy; a registered key never draws on that budget; and no more copies run at once than the limit (429)', async () => {
    let hold: Promise<void> | null = null;
    const w = await world((pod) => ({
      recordKey: K1, holderCopyLimits: { strangersPerMinute: 2, concurrent: 1 },
      // While `hold` is set, a read of a task's sealed graph waits for it: a copy in progress, held there.
      fetchFn: async (url, init) => {
        if (hold && /\/task-[0-9a-f]{16}[^/]*-graph\.envelope\.jose\.json$/.test(String(url))) await hold;
        return pod.fetchFn(url, init);
      },
    }));
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t1));
    // Cy leaves: removed from the registry, she can no longer read, and still takes her copy.
    ok(await act(w, ADMIN, 'update_registry', { entries: [{ address: CY.address, roles: [] }] }));
    refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w, CY) }), 403, /Only an admin or a key in this pod's registry/);
    const cyCopy = await envelope(w, CY, 'wrd:holder-copy', {});
    const copied = ok(await http(w, 'POST', 'holder_copy', { envelope: cyCopy }), 'Cy\'s copy');
    expect(arr(copied['bundle']).length).toBeGreaterThan(0);
    expect(obj(copied['platform'])['address']).toBe(addr(PLATFORM));
    // Her envelope is spent: a replay is refused before anything is read.
    refused(await http(w, 'POST', 'holder_copy', { envelope: cyCopy }), 409, /already used/);
    // A key nobody registered, named in nothing: 403, and that spends the second of two.
    refused(await act(w, ZED, 'holder_copy', {}), 403, /No record on this pod names this address/);
    const third = await http(w, 'POST', 'holder_copy', { envelope: await envelope(w, ZED, 'wrd:holder-copy', {}) });
    refused(third, 429, /Too many copies/, /at most 2 holder copies a minute from keys that are neither an admin nor in this pod's registry/);
    // A registered key does not draw on that budget.
    ok(await act(w, DEE, 'holder_copy', {}), 'Dee\'s copy');
    // One copy at a time: a second sent while the first is held answers 429, and the first completes.
    let release: () => void = () => undefined;
    hold = new Promise<void>((r) => { release = r; });
    const first = act(w, DEE, 'holder_copy', {});
    await new Promise((r) => setTimeout(r, 300));
    refused(await act(w, ANA, 'holder_copy', {}), 429, /Too many copies/, /at most 1 holder copies at once/);
    release();
    hold = null;
    ok(await first, 'the held copy');
    ok(await act(w, ANA, 'holder_copy', {}), 'Ana\'s copy, after');
  }, 120_000);

  it('never reads a line short for an edit to an earlier version of its own key: with only its iep:describes or its link edited, its proof broken, or its manifest entry removed, a write that checks the whole line refuses (409), a replayed registry change among them, the holder\'s copy refuses, and a decision\'s chain says it is incomplete; restored, the replay is refused as a replay and every line reads whole', async () => {
    const w = await world({ recordKey: K1 });
    const { ap, planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    await acknowledgeAll(w, planIri);
    ok(await countersign(w, BO, decisionIri, 'approve'));
    // The admin adds Zed (the envelope kept) and removes him again: the version that added him is an earlier version of the registry.
    const zed = (roles: string[]): Obj => ({ entries: [person(ZED, roles, 'p-zed', 'Zed')] });
    const addZed = await envelope(w, ADMIN, 'wrd:update-registry', zed(['operator']));
    const added = String(ok(await http(w, 'POST', 'update_registry', { envelope: addZed }))['descriptorUrl']);
    ok(await act(w, ADMIN, 'update_registry', zed([])));
    const zedReads = async (bridge: World): Promise<number> => (await http(bridge, 'POST', 'read_records', { envelope: await readEnvelope(bridge, ZED) })).status;
    expect(await zedReads(w)).toBe(403);
    const t1Graph = graphIriOf(ap.t1);
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    const t1First = must((await manifest(w)).find((e) => e.describes.includes(t1Graph) && (e.supersedes ?? []).length === 0), 'T1 v1').descriptorUrl;
    const t1Head = headOfRow(await taskRow(w, ap.t1));
    const chain = arr((await decisionRow(w, decisionIri))['chain']);
    expect(chain.map((v) => v['status'])).toEqual(['submitted', 'countersigned']);
    const decisionFirst = String(must(chain[0])['descriptorUrl']);
    const t1Copied = async (): Promise<string[]> => arr(ok(await act(w, CY, 'holder_copy', {}))['bundle']).filter((b) => b['entityIri'] === ap.t1).map((b) => String(b['descriptorUrl']));
    expect(await t1Copied()).toEqual([t1First, t1Head.descriptorUrl]);
    const manifestUrl = predictManifestUrl(POD);
    const entryOf = (url: string): string => must(must(w.pod.bodies.get(manifestUrl), 'manifest').split('\n\n').find((b) => b.startsWith(`<${url}> a iep:ManifestEntry`)), `the entry of ${url}`);
    interface Edit { readonly url: string; readonly from: string; readonly to: string }
    const missing = 'an earlier version is missing: .+ is version \\d+, and no trusted version \\d+ of this graph is listed as the one it supersedes';
    const edits: ReadonlyArray<{ readonly name: string; readonly edit: (url: string) => Edit; readonly why: string; readonly registryToo: boolean }> = [
      {
        name: 'its iep:describes', registryToo: true, why: 'an earlier version \\(.+\\) is not trusted: its descriptor was altered after signing: its iep:describes no longer names',
        edit: (url) => ({ url, from: must(/iep:describes <[^>]+>/.exec(must(w.pod.bodies.get(url))))[0], to: `iep:describes <${graphIriOf(ap.t2)}>` }),
      },
      {
        name: 'its link to its graph', registryToo: true, why: 'an earlier version \\(.+\\) is not trusted: its graph is not at the URL its descriptor names \\(404\\)',
        edit: (url) => ({ url, from: `hydra:target <${sealedGraphUrl(w, url)}>`, to: `hydra:target <${POD}${WRD_CONTAINER}nothing-graph.envelope.jose.json>` }),
      },
      {
        name: 'its proof', registryToo: true, why: `${missing} \\(.+ is, and is set aside: its authorship signature does not verify\\)`,
        edit: (url) => {
          const m = must(/iep:proofValue "0x([0-9a-f])/.exec(must(w.pod.bodies.get(url))));
          return { url, from: m[0], to: `iep:proofValue "0x${m[1] === '0' ? '1' : '0'}` };
        },
      },
      // Removing the entry of the registry's earlier version would leave the one before it unsuperseded: a fork, every call 409. Tasks and decisions only.
      { name: 'its manifest entry', registryToo: false, why: `${missing}: it was deleted`, edit: (url) => ({ url: manifestUrl, from: `\n\n${entryOf(url)}`, to: '' }) },
    ];
    for (const { name, edit, why, registryToo } of edits) {
      // Every successful holder's copy writes its receipt, so the count is taken afresh.
      const before = (await manifest(w)).length;
      const originals = new Map<string, string>();
      for (const target of [t1First, decisionFirst, ...(registryToo ? [added] : [])]) {
        const e = edit(target);
        if (!originals.has(e.url)) originals.set(e.url, must(w.pod.bodies.get(e.url)));
        w.pod.tamper(e.url, e.from, e.to);
      }
      const cut = (graphIri: string): RegExp => new RegExp(`${graphIri}: ${why}`);
      // The bridge that wrote it, and a fresh one (another replica, or after a restart, with an empty nonce ledger).
      const fresh = await sibling(w, { recordKey: K1 });
      for (const bridge of [w, fresh]) {
        // The holder's copy refuses rather than come back with T1's line, or the decision's, short; nothing is sealed, so no setting is named.
        const copy = refused(await act(bridge, CY, 'holder_copy', {}), 409, /are missing an earlier version, so it cannot tell whether they name you/, /graph\(s\) cannot be read in full/);
        expect([name, copy['iep:resolvedBy']]).toEqual([name, undefined]);
        // A write to T1 checks its whole line for a replay: refused, rather than checked against part of it.
        refused(await act(bridge, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1Head), verdict: 'dispute', note: `after ${name}` }), 409, /altered after signing/, cut(t1Graph));
        const row = await decisionRow(bridge, decisionIri);
        expect([name, arr(row['chain']).map((v) => v['status'])]).toEqual([name, ['countersigned']]);
        expect(String(row['chainUnreadable'])).toMatch(new RegExp(`the chain below is incomplete: ${cut(graphIriOf(decisionIri)).source}`));
      }
      if (registryToo) {
        // The envelope that added Zed, replayed where no ledger remembers it: the durable check cannot read the registry's whole line, so it refuses.
        refused(await http(fresh, 'POST', 'update_registry', { envelope: addZed }), 409, /altered after signing/, cut(registryGraph));
        expect(await zedReads(fresh)).toBe(403);
      }
      for (const [url, body] of originals) w.pod.tamper(url, must(w.pod.bodies.get(url)), body);
      // Nothing was written while the edit stood.
      expect([name, (await manifest(w)).length]).toEqual([name, before]);
      // Restored: the replay is refused as a replay, the copy holds T1's whole line, and the decision's chain is whole.
      refused(await http(await sibling(w, { recordKey: K1 }), 'POST', 'update_registry', { envelope: addZed }), 409, /already used/, /on urn:wrd:registry/);
      expect([name, await t1Copied()]).toEqual([name, [t1First, t1Head.descriptorUrl]]);
      const back = await decisionRow(w, decisionIri);
      expect([name, arr(back['chain']).length, back['chainUnreadable']]).toEqual([name, 2, undefined]);
    }
    expect(await zedReads(w)).toBe(403);
    ok(await ratify(w, CY, ap.t1, 'dispute', 'after every restore'));
  }, 180_000);

  it('never lets supersedes links in the manifest alone make an older version current or a graph absent: a link from an entry to itself is ignored, a head whose link to the version before it is pointed at itself leaves two current versions, and links that form a cycle leave none; those answer 409, nothing reads as absent and no write proceeds, and once the line is restored the graph reads from the same head with no fork; a task and the registry alike', async () => {
    const w = await world({ recordKey: K1 });
    await register(w);
    const ap = await captureAp(w);
    ok(await ratify(w, CY, ap.t1));
    ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: 'links-kind-0', label: 'Another', definition: 'Another kind.' }] }));
    const t1Graph = graphIriOf(ap.t1);
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    const manifestUrl = predictManifestUrl(POD);
    const entryOf = (url: string): string => must(must(w.pod.bodies.get(manifestUrl), 'manifest').split('\n\n').find((b) => b.startsWith(`<${url}> a iep:ManifestEntry`)), `the entry of ${url}`);
    const supersededBy = (url: string): string => must(/iep:supersedes <([^>]+)>/.exec(entryOf(url))?.[1], `what ${url} supersedes`);
    const withLine = (entry: string, line: string): string => entry.replace(/(iep:describes <[^>]+> ;)/, `$1\n    ${line} ;`);
    const registryHead = async (): Promise<string> => String(obj(obj((await list(w))['registry'])['head'])['descriptorUrl']);
    const cases: ReadonlyArray<{ readonly name: string; readonly edit: (head: string, prev: string) => readonly [string, string, string]; readonly why: RegExp | null }> = [
      { name: 'the head\'s link to the version before it pointed at itself', why: /more than one version claims to be current/,
        edit: (head, prev) => [head, `iep:supersedes <${prev}>`, `iep:supersedes <${head}>`] },
      { name: 'the version before the head also superseding the head', why: /no version claims to be current: the supersedes links the manifest lists for its versions form a cycle/,
        edit: (head, prev) => [prev, entryOf(prev), withLine(entryOf(prev), `iep:supersedes <${head}>`)] },
      { name: 'the head\'s entry also superseding itself', why: null, edit: (head) => [head, entryOf(head), withLine(entryOf(head), `iep:supersedes <${head}>`)] },
    ];
    for (const { name, edit, why } of cases) {
      // A task.
      const t1 = headOfRow(await taskRow(w, ap.t1));
      const [t1Entry, t1From, t1To] = edit(t1.descriptorUrl, supersededBy(t1.descriptorUrl));
      const t1Block = entryOf(t1Entry);
      const t1Edited = t1Block.replace(t1From, t1To);
      w.pod.tamper(manifestUrl, t1Block, t1Edited);
      const before = (await manifest(w)).length;
      const listed = await list(w);
      if (why === null) {
        // Ignored: the head is current and trusted, and a write bound to it goes on from it (nothing older becomes current).
        expect([name, arr(listed['forked']), arr(listed['altered'])]).toEqual([name, [], []]);
        expect(headOfRow(await taskRow(w, ap.t1)).descriptorUrl).toBe(t1.descriptorUrl);
        ok(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1), verdict: 'dispute', note: `with ${name}` }));
        expect((await manifest(w)).length).toBe(before + 1);
      } else {
        // Never absent: T1 is forked and says why, and a write bound to its head is refused.
        expect([name, arr(listed['forked'])]).toEqual([name, [t1Graph]]);
        expect(arr(listed['tasks']).map((t) => t['taskIri'])).not.toContain(ap.t1);
        expect(String(must(arr(listed['integrity']).find((i) => i['graphIri'] === t1Graph), 'T1 integrity')['why'])).toMatch(why);
        refused(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1), verdict: 'dispute', note: `with ${name}` }), 409, /more than one version claims to be current/, new RegExp(`${t1Graph}: ${why.source}`));
        expect((await manifest(w)).length).toBe(before);
      }
      w.pod.tamper(manifestUrl, t1Edited, t1Block);
      const t1Back = await list(w);
      expect([name, arr(t1Back['forked']), arr(t1Back['altered'])]).toEqual([name, [], []]);
      const t1Now = headOfRow(await taskRow(w, ap.t1));
      if (why !== null) expect(t1Now).toEqual(t1);
      else expect(supersededBy(t1Now.descriptorUrl)).toBe(t1.descriptorUrl);

      // The registry.
      const reg = await registryHead();
      const [regEntry, regFrom, regTo] = edit(reg, supersededBy(reg));
      const regBlock = entryOf(regEntry);
      const regEdited = regBlock.replace(regFrom, regTo);
      w.pod.tamper(manifestUrl, regBlock, regEdited);
      const regBefore = (await manifest(w)).length;
      const change = await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: `links-kind-${regBefore}`, label: 'Another', definition: 'Another kind.' }] });
      if (why === null) {
        expect(supersededBy(String(ok(change, name)['descriptorUrl']))).toBe(reg);
      } else {
        // Never a second registry started as if there were none: every change and every read answers 409.
        refused(change, 409, /more than one version claims to be current/, new RegExp(`${registryGraph}: ${why.source}`));
        refused(await http(w, 'POST', 'read_records', { envelope: await readEnvelope(w) }), 409, /more than one version claims to be current/, new RegExp(`${registryGraph}: ${why.source}`));
        expect((await manifest(w)).length).toBe(regBefore);
      }
      w.pod.tamper(manifestUrl, regEdited, regBlock);
      const regBack = await list(w);
      expect([name, arr(regBack['forked']), arr(regBack['altered'])]).toEqual([name, [], []]);
      expect(obj(obj(regBack['registry'])['head'])).toMatchObject({ trusted: true });
      if (why !== null) expect(await registryHead()).toBe(reg);
    }

    // A version of another task that does not open, listed under T1's graph by the manifest, makes T1 answer 409 naming that version, not T1's own.
    const t1 = headOfRow(await taskRow(w, ap.t1));
    ok(await ratify(w, DEE, ap.t2));
    const t2First = must((await manifest(w)).find((e) => e.describes.includes(graphIriOf(ap.t2)) && (e.supersedes ?? []).length === 0), 'T2 v1').descriptorUrl;
    const t2Sealed = sealedGraphUrl(w, t2First);
    const t2Bytes = must(w.pod.bodies.get(t2Sealed));
    corruptSealed(w, t2Sealed);
    const t2Block = entryOf(t2First);
    const t2Listed = withLine(t2Block, `iep:describes <${t1Graph}>`);
    w.pod.tamper(manifestUrl, t2Block, t2Listed);
    const r = refused(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1), verdict: 'ratify' }), 409, /altered after signing/,
      new RegExp(`${t1Graph}: more than one version claims to be current, and one of them \\(${t2First}\\) is not trusted: its graph is sealed to a key this bridge does not hold`));
    expect(r['iep:resolvedBy']).toEqual({ env: 'WRD_RECORD_KEY' });
    w.pod.tamper(manifestUrl, t2Listed, t2Block);
    w.pod.tamper(t2Sealed, must(w.pod.bodies.get(t2Sealed)), t2Bytes);
    ok(await act(w, CY, 'ratify_task', { subject: 'description', taskIri: ap.t1, ...bound(t1), verdict: 'ratify' }));
    expect(arr((await list(w))['forked'])).toEqual([]);
  }, 180_000);

  it('on a pod whose registry was written under another record key (the usual go-live order), refuses every write and every read, by an admin, a registered key or any other, with the key mismatch naming WRD_RECORD_KEY and both fingerprints, never as one sealed record; the key\'s own bridge goes on', async () => {
    const reEscape = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Go live under K1: the admin's registry change is the first write. Then a workflow is captured, the first keyed IRIs.
    const w = await world({ recordKey: K1 });
    await register(w);
    const fp1 = recordKeyFingerprint(K1);
    const fp2 = recordKeyFingerprint(K2);
    const registryGraph = graphIriOf(entityIri('registry', POD, 'registry'));
    const regUrl = must((await manifest(w)).find((e) => e.describes.includes(registryGraph))).descriptorUrl;
    expect(regUrl).toMatch(new RegExp(`/registry-[0-9a-f]{16}-k${fp1}\\.ttl$`));
    for (const phase of ['the registry alone', 'the registry and a workflow'] as const) {
      if (phase === 'the registry and a workflow') await captureAp(w);
      const before = (await manifest(w)).length;
      for (const [extra, bridgeKey, shut] of [[{ recordKey: K2 }, `holds the one with fingerprint k${fp2}`, SEALED_OTHER_KEY], [{}, 'holds no record key', SEALED_NO_KEY]] as const) {
        // Alone, the registry's signed record id names K1; with the workflow, its keyed IRIs are found (and reported) first.
        const [error, mismatch] = phase === 'the registry alone'
          ? [/sealed to a record key this bridge does not hold/, `${reEscape(registryGraph)} \\(${reEscape(regUrl)}\\) is sealed to the record key with fingerprint k${fp1} \\(its record id, which the platform signed, names it\\), and this bridge ${reEscape(bridgeKey)} \\(WRD_RECORD_KEY\\)`]
          : [/derived under a record key this bridge does not hold/, `was derived under the record key with fingerprint k${fp1}, and this bridge ${reEscape(bridgeKey)} \\(WRD_RECORD_KEY\\)`];
        const readWhy = new RegExp(`${mismatch}.*; nor can it use the pod's registry \\(${reEscape(registryGraph)}: its current version \\(${reEscape(POD)}${WRD_CONTAINER}registry-[0-9a-f]{16}-k${fp1}\\.ttl\\) is not trusted: ${reEscape(shut)}\\), so it answers no read, whoever signs it, until it runs with that key`);
        const writeWhy = new RegExp(`${mismatch}.*; it writes nothing and looks nothing up by tuple until it runs with that key`);
        for (const publicReads of [false, true]) {
          const other = await sibling(w, { ...extra, publicReads });
          const answers: Array<[string, Res, RegExp]> = [];
          // An admin, an operator, a worker, and a key the registry does not hold.
          for (const who of [ADMIN, ANA, CY, ZED]) {
            const signedRead = await readEnvelope(other, who);
            answers.push([`read_records by ${who.address}`, await http(other, 'POST', 'read_records', { envelope: signedRead }), readWhy]);
            answers.push([`read_calibration by ${who.address}`, await http(other, 'POST', 'read_calibration', { envelope: signedRead, kind: 'agents' }), readWhy]);
            answers.push([`read_envelope_template by ${who.address}`, await http(other, 'POST', 'read_envelope_template', { intent: 'wrd:capture-workflow', read_envelope: signedRead }), readWhy]);
            answers.push([`update_registry by ${who.address}`, await act(other, who, 'update_registry', { taskKinds: [{ slug: 'other-key-kind', label: 'Another', definition: 'Another kind.' }] }), writeWhy]);
            answers.push([`capture_workflow by ${who.address}`, await act(other, who, 'capture_workflow', { workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' }, tasks: [{ name: 'Review accruals', description: 'Check open accruals.', currentLevel: 'person', personAddress: DEE.address, taskKind: 'gl-coding' }] }), writeWhy]);
            answers.push([`holder_copy by ${who.address}`, await act(other, who, 'holder_copy', {}), writeWhy]);
          }
          const run = await runEnvelope(other, `other-key-run-${phase.length}-${bridgeKey.length}-${String(publicReads)}`, entityIri('task', 'a workflow', 'a task'), 'accepted');
          answers.push(['log_agent_run', await http(other, 'POST', 'log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(other, ELI, run, 'accepted') }), writeWhy]);
          if (publicReads) {
            // Opened reads too: the GET read model, calibration and a filled template.
            for (const [tool, query] of [['list_records', ''], ['calibration', ''], ['envelope_template', '?intent=wrd:capture-workflow']] as const) {
              answers.push([`GET ${tool}`, await http(other, 'GET', tool, undefined, query), readWhy]);
            }
          }
          for (const [what, r, why] of answers) {
            expect([phase, what, r.status]).toEqual([phase, what, 409]);
            refused(r, 409, error, why);
            expect([what, r.body['iep:resolvedBy']]).toEqual([what, { env: 'WRD_RECORD_KEY' }]);
          }
        }
        // Nothing reached the pod.
        expect((await manifest(w)).length).toBe(before);
      }
      // The key's own bridge is unaffected: a fresh one reads as an admin and as a registered key, with no mismatch, and the first goes on writing.
      const k1 = await sibling(w, { recordKey: K1 });
      for (const who of [ADMIN, ANA]) {
        const signedRead = await readEnvelope(k1, who);
        expect(ok(await http(k1, 'POST', 'read_records', { envelope: signedRead }))['recordKeyMismatch']).toBeUndefined();
        expect(ok(await http(k1, 'POST', 'read_calibration', { envelope: signedRead }))['recordKeyMismatch']).toBeUndefined();
        ok(await http(k1, 'POST', 'read_envelope_template', { intent: 'wrd:capture-workflow', read_envelope: signedRead }));
      }
      ok(await act(w, ADMIN, 'update_registry', { taskKinds: [{ slug: `k1-kind-${phase.length}`, label: 'Another', definition: 'Another kind.' }] }));
    }
  }, 120_000);

  it('never counts a run or a decision that does not open as absent: contraryEvidence, runs, awaitingReview and the calibration cells and probe signals they feed say they count only what opens, naming WRD_RECORD_KEY, and whether an allocation in force is permitted is unknown, not worked out from the captured one', async () => {
    const w = await world({ recordKey: K1 });
    const { ap, planIri, valuation } = await valuedP1(w);
    const decisionIri = String((await submitValued(w, planIri, valuation))['decisionIri']);
    await acknowledgeAll(w, planIri);
    ok(await countersign(w, BO, decisionIri, 'approve'));
    const csRow = await decisionRow(w, decisionIri);
    const csAt = String(obj(csRow['countersign'])['at']);
    const prediction = obj(csRow['prediction']);
    const pilot1 = await logReviewedRun(w, 'pilot-1', ap.t1, 'accepted', ELI, 'accepted');
    const pilot2 = await logReviewedRun(w, 'pilot-2', ap.t1, 'accepted', FAY, 'reworked');
    w.clock.advance(9 * WEEK);
    const windowEnd = plusWeeks(csAt, 8);
    const measured = Number(obj(prediction['band'])['p50']) * meanRampFactor(0, monthsBetween(csAt, windowEnd), Number(prediction['rampMonths']));
    ok(await recordOutcome(w, ELI, decisionIri, { disposition: 'kept', measured: { weeklyValueDelta: measured, comparisonBasis: 'staggered', windowStart: csAt, windowEnd, method: 'Staggered roll-out across two AP teams' } }));
    const t1Of = (l: Obj): Obj => must(arr(l['tasks']).find((t) => t['taskIri'] === ap.t1), 'T1 row');
    const contrary = (l: Obj, taskIri: string): Obj => obj(obj(must(arr(l['tasks']).find((t) => t['taskIri'] === taskIri))['classification'])['contraryEvidence'] ?? {});

    // Everything opens: nothing is marked.
    const base = await list(w);
    expect(contrary(base, ap.t1)).toMatchObject({ reviewedRuns: 2, criticalFailures: 0 });
    expect(contrary(base, ap.t1)['unreadable']).toBeUndefined();
    expect(base['unreadable']).toBeUndefined();
    expect(arr(base['runs']).map((r) => [r['reviewed'], r['unreadable']])).toEqual([[2, undefined]]);
    const baseCal = ok(await calibration(w));
    expect(baseCal['unreadable']).toBeUndefined();
    expect(arr(baseCal['predictionCells']).map((c) => [c['samples'], c['unreadable']])).toEqual([[1, undefined]]);
    expect(arr(baseCal['agentCells']).map((c) => [c['samples'], c['unreadable']])).toEqual([[2, undefined]]);

    /** Seal one version shut (its ciphertext changed on the pod); the returned function restores it. */
    const shut = (descriptorUrl: string): (() => void) => {
      const url = sealedGraphUrl(w, descriptorUrl);
      const original = must(w.pod.bodies.get(url));
      corruptSealed(w, url);
      return () => w.pod.tamper(url, must(w.pod.bodies.get(url)), original);
    };

    // (a) The reviewed run Fay reworked no longer opens. Which task, agent and kind of task it is about is not public: every figure counted from runs says so.
    const reopenRun = shut(String(pilot2['descriptorUrl']));
    const runGraph = graphIriOf(String(pilot2['runIri']));
    const runWhy = new RegExp(`counts only the records that can be read: 1 run record\\(s\\) cannot be \\(${runGraph}: .*WRD_RECORD_KEY.*\\)`);
    const a = await list(w);
    for (const t of [ap.t1, ap.t2, ap.t3, ap.t4]) {
      expect(String(contrary(a, t)['unreadable'])).toMatch(runWhy);
    }
    // The counts are of the runs that open; whether to suggest re-classifying is unknown (no critical failure among them settles it).
    expect(contrary(a, ap.t1)).toMatchObject({ reviewedRuns: 1, criticalFailures: 0, suggestReclassify: null });
    expect(contrary(a, ap.t2)).toMatchObject({ reviewedRuns: 0, suggestReclassify: null });
    expect(arr(a['runs']).map((r) => r['reviewed'])).toEqual([1]);
    expect(String(must(arr(a['runs'])[0])['unreadable'])).toMatch(runWhy);
    expect(Object.keys(obj(a['unreadable'])).sort()).toEqual(['awaitingReview', 'contraryEvidence', 'runs']);
    for (const v of Object.values(obj(a['unreadable']))) expect(String(v)).toMatch(runWhy);
    expect(arr(a['sealed']).map((x) => x['graphIri'])).toEqual([runGraph]);
    const aCal = ok(await calibration(w));
    expect(Object.keys(obj(aCal['unreadable'])).sort()).toEqual(['agentCells', 'awaitingAPerson']);
    expect(arr(aCal['agentCells']).map((c) => c['samples'])).toEqual([1]);
    expect(String(must(arr(aCal['agentCells'])[0])['unreadable'])).toMatch(runWhy);
    expect(arr(aCal['predictionCells']).map((c) => [c['samples'], c['unreadable']])).toEqual([[1, undefined]]);
    expect(obj(aCal['probeSignals'])['unreadable']).toBeUndefined();
    reopenRun();
    expect((await list(w))['unreadable']).toBeUndefined();

    // T1 re-classified Turbulent: the allocation the decision put in force is one its classification no longer allows, and the read model says so.
    ok(await classify(w, ANA, ap.t1, ANSWERS.turbulent));
    const open = await list(w);
    expect(obj(t1Of(open)['effective'])).toMatchObject({ level: 'agent-drafts-person-decides', source: 'measured-decision' });
    expect(String(t1Of(open)['currentNotPermitted'])).toMatch(/^As a decision put it in force, this task is done at agent-drafts-person-decides, which Turbulent work does not permit; the task's classification no longer allows what that decision approved\. Propose a change\.$/);
    expect(t1Of(open)['currentNotPermittedUnreadable']).toBeUndefined();
    expect(open['unreadable']).toBeUndefined();

    // (b) The measured decision's head no longer opens: its prediction cell is not shown as never measured, and the allocation in force is not certain.
    const reopenDecision = shut(headOfRow(await decisionRow(w, decisionIri)).descriptorUrl);
    const decisionWhy = new RegExp(`counts only the records that can be read: 1 decision record\\(s\\) cannot be \\(${graphIriOf(decisionIri)}: .*WRD_RECORD_KEY.*\\)`);
    const bCal = ok(await calibration(w));
    expect(arr(bCal['predictionCells'])).toEqual([]);
    expect(Object.keys(obj(bCal['unreadable'])).sort()).toEqual(['predictionCells', 'probeSignals']);
    expect(String(obj(bCal['unreadable'])['predictionCells'])).toMatch(decisionWhy);
    expect(String(obj(bCal['probeSignals'])['unreadable'])).toMatch(decisionWhy);
    expect(arr(bCal['agentCells']).map((c) => [c['samples'], c['unreadable']])).toEqual([[2, undefined]]);
    // Only one section asked for: only its mark.
    expect(Object.keys(obj(ok(await calibration(w, '?kind=agents'))['unreadable'] ?? {}))).toEqual([]);
    expect(Object.keys(obj(ok(await calibration(w, '?kind=predictions'))['unreadable']))).toEqual(['predictionCells']);
    const b = await list(w);
    expect(String(obj(t1Of(b)['effective'])['unreadable'])).toMatch(new RegExp(`${graphIriOf(decisionIri)}: .*WRD_RECORD_KEY.*so the allocation in force may differ from this one`));
    // Nor is whether that allocation is permitted worked out from the captured one as if the decision were absent: every classified task
    // on the decision's workflow (which tasks it changed is in its graph) has currentNotPermitted null and says why, and so does the list.
    expect(obj(t1Of(b)['effective'])['source']).toBe('captured');
    for (const t of arr(b['tasks'])) {
      expect([t['taskIri'], t['currentNotPermitted']]).toEqual([t['taskIri'], null]);
      expect(String(t['currentNotPermittedUnreadable'])).toMatch(new RegExp(`^whether the allocation in force is one this task's classification allows is unknown: 1 decision or plan record\\(s\\) it may come from cannot be read \\(${graphIriOf(decisionIri)}: .*WRD_RECORD_KEY`));
    }
    expect(String(obj(b['unreadable'])['currentNotPermitted'])).toMatch(new RegExp(`^${arr(b['tasks']).length} task\\(s\\) have currentNotPermitted null.*WRD_RECORD_KEY when one is sealed`));
    reopenDecision();
    expect(String(t1Of(await list(w))['currentNotPermitted'])).toMatch(/^As a decision put it in force, this task is done at agent-drafts-person-decides/);
    expect(ok(await calibration(w))['unreadable']).toBeUndefined();
    expect(pilot1['status']).toBe('reviewed');
  }, 120_000);

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
    expect(new Set(fromBridge.map((r) => r.status))).toEqual(new Set([400, 401, 403, 404, 409, 422, 429, 501, 502]));
  });
});
