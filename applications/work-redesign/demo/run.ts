/**
 * The work-redesign offline demo: a deterministic walk of the whole lifecycle, driven the way a
 * Path-A agent drives the bridge, plus the pod and clock it runs on.
 *
 *   npx tsx applications/work-redesign/demo/run.ts            walk, print the steps, write a report
 *   npx tsx applications/work-redesign/demo/run.ts --serve    walk, then keep the bridge and its
 *                                                             web UI listening on 127.0.0.1:6100/ui
 *   --port=<n>                                                another port for --serve
 *
 * What is real: the bridge (createVerticalBridge + createWrdHandlers), every signature and its
 * verification, the published policy read from wrd.ttl, the classification rules, the Monte
 * Carlo valuation, outcome grading, calibration and grants from the judgment kit, the platform's
 * content-bound proofs and their read-back, record graphs sealed to a record key on the pod and
 * opened on read, signed reads, holder copies to a second pod, and the web UI.
 *
 * What is doubled: the NETWORK (an in-memory Solid-style pod that honours the preconditions
 * publish() relies on), TIME (a clock that moves only when told to, so a nine-week measurement
 * window can pass), the PEOPLE (persona keys derived from published seeds and held by this
 * process; so is the record key), and what those people report: a scripted draft stands in for the client's own agent
 * (the platform verifies it, it does not produce it); the agents' runs are scripted (their
 * outputs are the digests of fixed strings and their self-assessments are chosen by the walk);
 * and the one measured outcome is computed FROM the prediction (its P50 times the ramp factor),
 * so it lands in band by construction. Every record this demo writes says, in its payload and
 * as a wrd:demoRecord triple, that it is scripted by the offline demo and is not evidence.
 *
 * Pod URLs are TEST-NET literals (RFC 5737). The SSRF guard does not class them as private
 * (packages/core/src/net/guarded-fetch.ts), and an IP literal skips the DNS lookup the guard
 * makes for every named host — about 31 ms per request for a `.test` name, measured.
 *
 * No environment reads: tests import this module. The report goes to demos/output/ (gitignored).
 */
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  importWallet, signMessageRaw, recoverMessageSigner, canonicalJson, sha256Hex, deriveEncryptionKeyPair,
  type EncryptionKeyPair, type FetchFn, type ManifestEntry, type Wallet,
} from '@interego/core';
import { fetchAllManifestEntries, predictManifestUrl, parseDistributionFromDescriptorTurtle } from '@interego/solid';
import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback } from '../../_shared/vertical-bridge/listen-loopback.js';
import { wrdAffordances, wrdDemoAffordances } from '../affordances.js';
import { createWrdHandlers, type DemoPersona } from '../bridge/handlers.js';
import { readRecord, openSealedGraph, HOLDER_CONTAINER, WRD_CONTAINER } from '../bridge/pod-helpers.js';
import { attachUi, hostAllowlistGuard, parseEveryQueryPair, servedHostNames } from '../bridge/ui.js';
import { envelopeSha256, entityIri, entityIriKey, graphIriOf } from '../src/records.js';
import { normaliseForQuote } from '../src/work.js';
import { meanRampFactor, monthsBetween, DEMO_LABEL } from '../src/valuation.js';
import { WRD_NS } from '../src/ontology.js';

/** The operator's pod in the demo and in the bridge tests (TEST-NET-1). */
export const DEMO_POD = 'https://192.0.2.10/ap-team/';
/** A worker's own pod, the target of holder copies (TEST-NET-2). */
export const DEMO_HOLDER_POD = 'https://198.51.100.7/cy/';
/** The demo's record key, derived from a published seed like the personas' keys: every graph the demo writes is sealed to it. */
export const DEMO_RECORD_KEY: EncryptionKeyPair = deriveEncryptionKeyPair(sha256Hex('wrd-demo:record-key'), 'wrd-records');

export interface MemoryPod {
  readonly fetchFn: FetchFn;
  /** Every stored resource, by URL. */
  readonly bodies: ReadonlyMap<string, string>;
  /** Replace `from` with `to` in a stored body, in place — what a party with write access to the pod could do. */
  tamper(url: string, from: string, to: string): void;
  /** While on, every write answers 403 Forbidden (non-transient, so publish() does not retry it). */
  failWrites(on: boolean): void;
}

function headerOf(headers: unknown, name: string): string | null {
  if (headers === null || typeof headers !== 'object') return null;
  const h = headers as { get?: unknown };
  if (typeof h.get === 'function') {
    const v = (h.get as (n: string) => unknown).call(headers, name);
    return typeof v === 'string' ? v : null;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return null;
}

/**
 * One store for every host. GET/HEAD → 200 with an etag `"v<n>"`, or 404. PUT/POST/PATCH
 * honour `If-None-Match: *` (412 when the resource exists) and `If-Match` (412 on a different
 * etag), store the body, bump the etag and answer 201. DELETE → 204.
 */
export function memoryPod(): MemoryPod {
  const bodies = new Map<string, string>();
  const versions = new Map<string, number>();
  let refuseWrites = false;
  const etag = (url: string): string => `"v${versions.get(url) ?? 0}"`;
  const contentType = (url: string): string => (url.endsWith('.trig') ? 'application/trig' : 'text/turtle');

  const fetchFn: FetchFn = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const body = bodies.get(url);
      if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
      return new Response(method === 'HEAD' ? null : body, { status: 200, headers: { etag: etag(url), 'content-type': contentType(url) } });
    }
    if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
      if (refuseWrites) return new Response('writes are refused', { status: 403, statusText: 'Forbidden' });
      const ifNoneMatch = headerOf(init?.headers, 'if-none-match');
      const ifMatch = headerOf(init?.headers, 'if-match');
      if (ifNoneMatch === '*' && bodies.has(url)) return new Response(null, { status: 412, statusText: 'Precondition Failed' });
      if (ifMatch !== null && ifMatch !== etag(url)) return new Response(null, { status: 412, statusText: 'Precondition Failed' });
      bodies.set(url, typeof init?.body === 'string' ? init.body : '');
      versions.set(url, (versions.get(url) ?? 0) + 1);
      return new Response(null, { status: 201, statusText: 'Created', headers: { etag: etag(url), location: url } });
    }
    if (method === 'DELETE') {
      if (refuseWrites) return new Response('writes are refused', { status: 403, statusText: 'Forbidden' });
      bodies.delete(url);
      return new Response(null, { status: 204, statusText: 'No Content' });
    }
    return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
  };

  return {
    fetchFn,
    bodies,
    tamper(url: string, from: string, to: string): void {
      const body = bodies.get(url);
      if (body === undefined) throw new Error(`memoryPod.tamper: nothing stored at ${url}`);
      if (!body.includes(from)) throw new Error(`memoryPod.tamper: ${JSON.stringify(from)} does not occur in ${url}`);
      bodies.set(url, body.replace(from, to));
      versions.set(url, (versions.get(url) ?? 0) + 1);
    },
    failWrites(on: boolean): void { refuseWrites = on; },
  };
}

export interface DemoClock { now(): Date; advance(ms: number): void }

/** Starts at `startIso`; each now() returns the current instant and then moves one second on; advance() jumps. */
export function demoClock(startIso = '2026-10-22T09:00:00.000Z'): DemoClock {
  let t = Date.parse(startIso);
  if (!Number.isFinite(t)) throw new RangeError(`demoClock: not an ISO instant: ${startIso}`);
  return {
    now(): Date { const d = new Date(t); t += 1000; return d; },
    advance(ms: number): void { t += ms; },
  };
}

// ── The walk ────────────────────────────────────────────────────────────────────────────

export interface DemoStep { readonly step: string; readonly tool: string; readonly expect: number; readonly got: number; readonly ok: boolean; readonly note: string }
export interface DemoReport {
  readonly ok: boolean;
  readonly steps: readonly DemoStep[];
  /** Refusal ids (R-A … R-AV) that answered as the walk expected, each with the status the bridge actually returned, as "R-A 403". */
  readonly refusalsObserved: readonly string[];
  readonly records: number;
  readonly base: string | null;
  readonly reportPath: string | null;
  /** Read back from the final wrd.list_records / wrd.calibration responses and one fetched graph, not from the demo's own bookkeeping. */
  readonly demoMarking: {
    readonly records: number; readonly demoRecords: number; readonly unlabelledRows: number;
    readonly unlabelledCells: number; readonly sampledGraphHasDemoTriple: boolean;
  };
}

/** Every refusal the walk asserts, in the order it meets them. */
export const DEMO_REFUSALS: readonly string[] = [
  'R-AU', 'R-AV', 'R-A', 'R-B', 'R-C', 'R-D', 'R-E', 'R-F', 'R-AN', 'R-G', 'R-H', 'R-I', 'R-J', 'R-K', 'R-L', 'R-M', 'R-N', 'R-O', 'R-P', 'R-Q', 'R-R', 'R-S', 'R-T',
  'R-AO', 'R-U', 'R-V', 'R-AP', 'R-W', 'R-X', 'R-Y', 'R-Z', 'R-AQ', 'R-AA', 'R-AB', 'R-AC', 'R-AD', 'R-AR', 'R-AS', 'R-AT', 'R-AE', 'R-AF', 'R-AG', 'R-AH',
  'R-AI', 'R-AJ', 'R-AK', 'R-AL', 'R-AM',
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const WEEK = 7 * 86_400_000;
const plusWeeks = (iso: string, weeks: number): string => new Date(Date.parse(iso) + weeks * WEEK).toISOString();

/**
 * One request to the demo server on 127.0.0.1:`port` carrying the Host header `host` — what a
 * page on another site sends once it has rebound its own DNS name to 127.0.0.1. fetch() cannot
 * set Host, so this goes through node:http, without a pooled connection.
 */
function hostProbe(port: number, method: 'GET' | 'POST', path: string, host: string): Promise<{ readonly status: number; readonly body: Obj }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
    const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = { text }; }
        resolve({ status: res.statusCode ?? 0, body: obj(parsed) });
      });
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────

/** An accounts-payable SOP. It literally contains every quoted span below except the fabricated one. */
const SOP = [
  'Supplier invoice processing — accounts payable standard operating procedure (AP-SOP-014, revision 7)',
  '',
  'Scope: every supplier invoice received by the accounts payable team, on paper or through the supplier portal.',
  '',
  '1. Match each invoice to its purchase order and goods receipt before it is approved for payment. The three-way match checks quantity, unit price and supplier. A mismatch above the tolerance in the purchasing policy goes back to the buyer.',
  '',
  '2. Code the invoice to the general ledger account and cost centre named on the purchase order. Where the order names none, the AP specialist chooses the account from the chart of accounts and notes the reason on the invoice.',
  '',
  '3. When a supplier disputes an invoice, contact the supplier, agree the corrected amount with the supplier’s accounts team, and record the outcome in the dispute log. Disputes open for more than thirty days are reported to the AP lead.',
  '',
  '4. Escalate any suspected duplicate payment to the fraud desk immediately. Do not release the payment until the fraud desk clears it, and do not tell the supplier that a fraud review is under way.',
  '',
  '5. Payments are released twice a week, on Tuesday and Thursday, after the AP lead approves the payment run.',
  '',
  'Month-end: accrue goods received but not yet invoiced, using the goods receipt value, and reverse the accrual when the invoice arrives.',
].join('\n');

/** The one quote in the scripted draft that the SOP does not contain. */
const FABRICATED = 'Invoices under $500 are auto-approved without matching';

/**
 * Stands in for the draft the user's OWN agent would return from wrd.task_map_packet. The
 * platform drafts nothing: it checks every quote in this draft against the document.
 */
const SCRIPTED_CLIENT_DRAFT = {
  workflow: { title: 'Supplier invoice processing', unitLabel: 'invoice' },
  tasks: [
    { name: 'Match each invoice to its purchase order and goods receipt', description: 'Three-way match of quantity, unit price and supplier before the invoice is approved for payment.',
      sourceQuotes: ['Match each invoice to its purchase order and goods receipt', 'The three-way match checks quantity, unit price and supplier'] },
    { name: 'Code the invoice to the general ledger', description: 'Choose the general ledger account and cost centre, from the purchase order or else from the chart of accounts.',
      sourceQuotes: ['Code the invoice to the general ledger account', FABRICATED] },
    { name: 'Resolve a disputed invoice with the supplier', description: 'Contact the supplier, agree the corrected amount and record it in the dispute log.',
      sourceQuotes: ['When a supplier disputes an invoice, contact the supplier', "agree the corrected amount with the supplier's accounts team"] },
    { name: 'Escalate a suspected duplicate-payment fraud alert', description: 'Send it to the fraud desk and hold the payment until the desk clears it.',
      sourceQuotes: ['Escalate any suspected duplicate payment to the fraud desk'] },
  ],
  draftedBy: { kind: 'agent', agent: 'SCRIPTED_CLIENT_DRAFT (offline demo fixture)' },
} as const;
/** What the person reviewing the draft chooses in the capture table for each task: its registered kind (the packet tells the agent not to invent kinds). */
const TABLE_KINDS = ['invoice-matching', 'gl-coding', 'supplier-dispute', 'fraud-alert'] as const;

const TASK_KINDS: readonly Obj[] = [
  { slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its purchase order and goods receipt before payment.' },
  { slug: 'gl-coding', label: 'General ledger coding', definition: 'Code an invoice to a general ledger account and cost centre.' },
  { slug: 'supplier-dispute', label: 'Supplier dispute', definition: 'Resolve a disputed invoice with the supplier and log the outcome.' },
  { slug: 'fraud-alert', label: 'Fraud alert', definition: 'Escalate a suspected duplicate payment to the fraud desk.' },
  { slug: 'accrual-review', label: 'Accrual review', definition: 'Review open accruals for goods received but not yet invoiced at month end.' },
];

const ANSWERS: Readonly<Record<'evident' | 'knowable' | 'emergent' | 'turbulent' | 'reclassified' | 'unknown', Obj>> = {
  evident: { sameStepsSameResult: 'always', methodKnown: 'documented', outcomeDependsOnOthers: 'no', situationStable: 'stable', checkability: 'before-effect', feedbackLatency: 'minutes', worstCase: 'recoverable' },
  knowable: { sameStepsSameResult: 'usually', methodKnown: 'expert-analysis', outcomeDependsOnOthers: 'no', situationStable: 'stable', checkability: 'after-effect', feedbackLatency: 'days', worstCase: 'recoverable' },
  emergent: { sameStepsSameResult: 'rarely', methodKnown: 'documented', outcomeDependsOnOthers: 'yes', situationStable: 'shifting', checkability: 'after-effect', feedbackLatency: 'weeks', worstCase: 'recoverable' },
  turbulent: { sameStepsSameResult: 'unknown', methodKnown: 'unknown', outcomeDependsOnOthers: 'partly', situationStable: 'unstable', checkability: 'not-checkable', feedbackLatency: 'unknown', worstCase: 'critical' },
  reclassified: { sameStepsSameResult: 'usually', methodKnown: 'documented', outcomeDependsOnOthers: 'partly', situationStable: 'shifting', checkability: 'after-effect', feedbackLatency: 'weeks', worstCase: 'recoverable' },
  unknown: { sameStepsSameResult: 'unknown', methodKnown: 'unknown', outcomeDependsOnOthers: 'unknown', situationStable: 'unknown', checkability: 'unknown', feedbackLatency: 'unknown', worstCase: 'unknown' },
};

type Basis = 'measured' | 'document' | 'performer-reported' | 'estimate' | 'not-applicable';
const tri = (low: number, likely: number, high: number, basis: Basis, note?: string): Obj => ({ low, likely, high, basis, ...(note ? { note } : {}) });
const one = (v: number, basis: Basis): Obj => tri(v, v, v, basis);
/** A state whose every field is a zero that does not apply (no performer, no agent…); the walk overrides the fields that do. */
const naState = (): Obj => ({
  performerHoursPerRun: one(0, 'not-applicable'), oversightHoursPerRun: one(0, 'not-applicable'), agentCostPerRun: one(0, 'not-applicable'), minorFailureRate: one(0, 'not-applicable'),
  minorFailureCost: one(0, 'not-applicable'), criticalFailureRate: one(0, 'not-applicable'), criticalFailureCost: one(0, 'not-applicable'),
});
const TOP_INPUTS: Obj = {
  currency: 'USD', unitsPerWeek: { current: tri(180, 200, 220, 'measured', 'invoices a week, last quarter') }, valuePerUnit: tri(5, 6, 7, 'estimate'),
  hourlyCost: tri(38, 42, 46, 'document', 'loaded cost from the finance rate card'), oneOffCost: tri(3000, 5000, 8000, 'estimate'),
  horizonMonths: 24, rampMonths: 2, annualDiscountRate: 0.08, criticalFailureCeiling: 0.01,
};

// ── Personas: deterministic keys from published seeds, labelled as the demo's ───────────

interface Persona { readonly id: string; readonly label: string; readonly wallet: Wallet }
function persona(id: string, label: string, type: 'human' | 'agent' = 'human'): Persona {
  return { id, label: `${label} (demo)`, wallet: importWallet(`0x${sha256Hex(`wrd-demo:${id}`)}`, type, `${label} (demo)`) };
}

// ── The walk ────────────────────────────────────────────────────────────────────────────

/**
 * Run the offline demo: build the bridge with its web UI on an in-memory pod, walk the
 * manifest like an agent through the whole lifecycle, and assert every refusal on the way.
 * Never throws for a failed expectation: each lands in `steps` with ok false, and `ok` is false.
 */
export async function runDemo(opts: {
  readonly quiet?: boolean; readonly serve?: boolean; readonly port?: number; readonly writeReport?: boolean;
  /** The in-memory pod to walk on; a test passes its own to inspect what the walk left on it. */
  readonly pod?: MemoryPod;
} = {}): Promise<DemoReport> {
  const quiet = opts.quiet ?? false;
  const say = (s: string): void => { if (!quiet) process.stdout.write(s); };
  const pod = opts.pod ?? memoryPod();
  const clock = demoClock();
  const P = {
    platform: persona('platform', 'Platform key', 'agent'), admin: persona('admin', 'Admin'),
    ana: persona('ana', 'Ana, AP operations lead'), ana2: persona('ana-2', "Ana's second key"), bo: persona('bo', 'Bo, finance controller'),
    dee: persona('dee', 'Dee, GL specialist'), cy: persona('cy', 'Cy, AP clerk'), agent: persona('agent', 'Matching agent', 'agent'),
    eli: persona('eli', 'Eli, AP analyst'), fay: persona('fay', 'Fay, AP analyst'), gus: persona('gus', 'Gus, AP analyst'),
    hal: persona('hal', 'Hal, AP analyst'), ivy: persona('ivy', 'Ivy, AP analyst'), zed: persona('zed', 'Zed, never registered'),
    coder: persona('coder', 'Coding agent', 'agent'),
  };
  const addr = (p: Persona): string => p.wallet.address.toLowerCase();
  const demoPersonas = new Map<string, DemoPersona>(Object.values(P).filter((p) => p.id !== 'platform').map((p) => [p.id, { id: p.id, label: p.label, wallet: p.wallet }]));

  // One server; the app is built once its port is known, so the manifest's targets are exact.
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const serve = (req: IncomingMessage, res: ServerResponse): void => {
    if (handler) { handler(req, res); return; }
    res.statusCode = 503;
    res.end();
  };
  let port: number;
  let base: string;
  let close: () => Promise<void>;
  if (opts.serve) {
    port = opts.port ?? 6100;
    const server = await new Promise<Server>((resolve, reject) => {
      const s = createServer(serve);
      s.once('error', reject);
      s.listen(port, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${port}`;
    close = async (): Promise<void> => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); };
  } else {
    const l = await listenLoopback({ listen: (p, host, cb) => createServer(serve).listen(p, host, cb) });
    port = l.port;
    base = l.base;
    close = l.close;
  }
  const app = createVerticalBridge({
    verticalName: 'work-redesign', affordances: [...wrdAffordances, ...wrdDemoAffordances], deploymentUrl: base, defaultPodUrl: DEMO_POD,
    handlers: createWrdHandlers({
      fetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, now: () => clock.now(), platform: { wallet: P.platform.wallet, keyKind: 'demo' },
      adminAddresses: [P.admin.wallet.address], demoPersonas, demoClockAdvance: (ms) => clock.advance(ms), recordKey: DEMO_RECORD_KEY,
    }),
    hypermediaLinks: [{ label: 'Web UI', href: `${base}/ui`, rel: 'alternate', type: 'text/html' }],
    middleware: (a) => {
      // Always bound to 127.0.0.1, and its endpoints hold the personas' keys and sign for them:
      // refuse every Host but its own before any route (DNS rebinding), as bridge/server.ts does.
      a.use(hostAllowlistGuard(servedHostNames(port, base)));
      // Reads are signed (the personas sign them), and every graph is sealed to DEMO_RECORD_KEY.
      attachUi(a, { base, reads: 'signed', landing: { recordsSealed: true } });
      // Every query parameter reaches the handlers, as in bridge/server.ts.
      parseEveryQueryPair(a);
    },
  });
  handler = app as unknown as (req: IncomingMessage, res: ServerResponse) => void;

  const steps: DemoStep[] = [];
  const refusalsObserved: string[] = [];
  const record = (step: string, tool: string, expect: number, got: number, ok: boolean, note: string): void => {
    steps.push({ step, tool, expect, got, ok, note });
    say(`${ok ? 'ok  ' : 'FAIL'} ${step.padEnd(70).slice(0, 70)} ${tool.padEnd(26)} ${String(expect)}/${String(got)}  ${note}\n`);
  };

  // A Path-A agent: every call goes to the target and method the manifest declares.
  const tools = new Map<string, { readonly url: string; readonly method: string }>();
  interface Res { readonly status: number; readonly body: Obj }
  const call = async (tool: string, body: Obj = {}): Promise<Res> => {
    const t = tools.get(tool);
    if (!t) return { status: 0, body: { error: `the manifest does not declare ${tool}` } };
    let url = t.url;
    const init: RequestInit = { method: t.method, headers: { accept: 'application/json' } };
    if (t.method === 'GET') {
      const q = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
      if (q.toString()) url += `?${q.toString()}`;
    } else {
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const text = await r.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = { text }; }
    return { status: r.status, body: obj(parsed) };
  };
  let n = 0;
  const nonce = (): string => { n += 1; return `demo-nonce-${String(n).padStart(6, '0')}`; };
  const envelope = async (who: Persona, intent: string, fields: Obj, o: { issuedAt?: string } = {}): Promise<{ payload: Obj; signature: string }> => {
    const payload: Obj = { intent, podUrl: DEMO_POD, issuedAt: o.issuedAt ?? clock.now().toISOString(), nonce: nonce(), ...fields };
    return { payload, signature: await signMessageRaw(who.wallet, canonicalJson(payload)) };
  };
  const INTENT: Readonly<Record<string, string>> = {
    'wrd.update_registry': 'wrd:update-registry', 'wrd.record_task_map': 'wrd:record-task-map', 'wrd.capture_workflow': 'wrd:capture-workflow',
    'wrd.revise_task': 'wrd:revise-task', 'wrd.ratify_task': 'wrd:ratify-task', 'wrd.classify_task': 'wrd:classify-task',
    'wrd.propose_allocation': 'wrd:propose-allocation', 'wrd.value_plan': 'wrd:value-plan', 'wrd.submit_decision': 'wrd:submit-decision',
    'wrd.countersign_decision': 'wrd:countersign-decision', 'wrd.record_outcome': 'wrd:record-outcome', 'wrd.grant_autonomy': 'wrd:grant-autonomy',
    'wrd.revoke_grant': 'wrd:revoke-grant', 'wrd.holder_copy': 'wrd:holder-copy',
  };
  const act = async (who: Persona, tool: string, fields: Obj, extra: Obj = {}): Promise<Res> =>
    call(tool, { envelope: await envelope(who, INTENT[tool] ?? '', fields), ...extra });

  /** A step that must succeed; `check` adds the step's own assertions. */
  const okStep = (step: string, tool: string, r: Res, check: () => string | null = () => null, describe?: () => string): Obj => {
    const fine = r.status === 200 && r.body['kind'] !== 'refusal';
    const problem = fine ? check() : `${str(r.body['error'])} ${str(r.body['iep:refusalReason'])}`.trim();
    record(step, tool, 200, r.status, fine && problem === null, problem ?? (describe ? describe() : str(r.body['status'])));
    return r.body;
  };
  /** A refusal the walk expects: the status, a typed refusal, and (when given) words from its error or reason. */
  const refusal = (id: string, what: string, tool: string, r: Res, status: number, words?: RegExp, extra?: () => string | null): void => {
    const text = `${str(r.body['error'])} — ${str(r.body['iep:refusalReason'])}`;
    let problem: string | null = null;
    if (r.status !== status) problem = `answered ${r.status}: ${text}`;
    else if (r.body['kind'] !== 'refusal') problem = 'not a typed refusal';
    else if (words && !words.test(text)) problem = `unexpected words: ${text}`;
    else if (extra) problem = extra();
    if (problem === null) refusalsObserved.push(`${id} ${r.status}`);
    record(`${id} ${what}`, tool, status, r.status, problem === null, problem ?? text);
  };
  const expect = (step: string, tool: string, cond: boolean, note: string): void => record(step, tool, 200, cond ? 200 : 0, cond, note);

  // Reads are signed: the admin signs a wrd:read-records envelope for each read (the clock is scripted, so one is not reused).
  let reads = 0;
  const readEnvelope = async (who: Persona = P.admin): Promise<{ payload: Obj; signature: string }> => {
    reads += 1;
    const payload: Obj = { intent: 'wrd:read-records', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: `demo-read-${String(reads).padStart(6, '0')}` };
    return { payload, signature: await signMessageRaw(who.wallet, canonicalJson(payload)) };
  };
  const list = async (query: Obj = {}): Promise<Obj> => (await call('wrd.read_records', { envelope: await readEnvelope(), ...query })).body;
  /** A record's graph as the pod holds it, following its descriptor's link and opening it with the record key when sealed. */
  const podGraph = async (descriptorUrl: string): Promise<{ readonly sealed: boolean; readonly text: string }> => {
    const dist = parseDistributionFromDescriptorTurtle(await (await pod.fetchFn(descriptorUrl)).text());
    if (!dist) return { sealed: false, text: '' };
    const body = await (await pod.fetchFn(dist.accessURL)).text();
    return dist.encrypted ? { sealed: true, text: openSealedGraph(body, DEMO_RECORD_KEY) ?? '' } : { sealed: false, text: body };
  };
  const taskRow = async (taskIri: string): Promise<Obj> => arr((await list({ kind: 'tasks' }))['tasks']).find((t) => t['taskIri'] === taskIri) ?? {};
  const headOf = (row: Obj): { descriptorUrl: string; graphDigest: string; recordId: string } => {
    const h = obj(row['head']);
    return { descriptorUrl: str(h['descriptorUrl']), graphDigest: str(h['graphDigest']), recordId: str(h['recordId']) };
  };
  const ratify = async (who: Persona, taskIri: string, verdict: 'ratify' | 'dispute', note?: string): Promise<Res> => {
    const h = headOf(await taskRow(taskIri));
    return act(who, 'wrd.ratify_task', { subject: 'description', taskIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...(note ? { note } : {}) });
  };
  const classify = async (who: Persona, taskIri: string, answers: Obj): Promise<Res> =>
    act(who, 'wrd.classify_task', { taskIri, taskTextSha256: str((await taskRow(taskIri))['textSha256']), answers });
  const ratifyClassification = async (who: Persona, taskIri: string): Promise<Res> => {
    const h = headOf(obj((await taskRow(taskIri))['classification']));
    return act(who, 'wrd.ratify_task', { subject: 'classification', taskIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict: 'ratify' });
  };
  /**
   * Ask the bridge for the payload a write needs, filled from the pod (what a Path-A agent does
   * before it signs). Reads are closed, so the walk sends its signed read along, in the POST body
   * of wrd.read_envelope_template (never in a URL): without one the GET wrd.envelope_template
   * carries only the shape and the head binding.
   */
  const template = async (intent: string, query: Obj): Promise<Res> =>
    call('wrd.read_envelope_template', { intent, ...query, read_envelope: await readEnvelope() });
  const planRow = async (planIri: string): Promise<Obj> => arr((await list({ kind: 'plans' }))['plans']).find((p) => p['planIri'] === planIri) ?? {};
  const decisionRow = async (decisionIri: string): Promise<Obj> => arr((await list({ kind: 'decisions' }))['decisions']).find((d) => d['decisionIri'] === decisionIri) ?? {};
  const countersign = async (who: Persona, decisionIri: string, verdict: 'approve' | 'decline', extra: Obj = {}): Promise<Res> => {
    const h = headOf(await decisionRow(decisionIri));
    return act(who, 'wrd.countersign_decision', { decisionIri, recordId: h.recordId, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...extra });
  };
  const recordOutcome = async (who: Persona, decisionIri: string, fields: Obj): Promise<Res> => {
    const h = headOf(await decisionRow(decisionIri));
    return act(who, 'wrd.record_outcome', { decisionIri, recordId: h.recordId, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, ...fields });
  };
  const acknowledge = async (who: Persona, planIri: string, taskIri: string, verdict: 'acknowledge' | 'object', note?: string): Promise<Res> => {
    const h = headOf(await planRow(planIri));
    return act(who, 'wrd.ratify_task', { subject: 'assignment', planIri, taskIri, descriptorUrl: h.descriptorUrl, graphDigest: h.graphDigest, verdict, ...(note ? { note } : {}) });
  };
  const runEnvelope = (runId: string, taskIri: string, self: 'accepted' | 'reworked', extra: Obj = {}, who: Persona = P.agent, taskKind = 'invoice-matching'): Promise<{ payload: Obj; signature: string }> =>
    envelope(who, 'wrd:agent-run', {
      runId, taskIri, taskKind, model: 'scripted-fixture', outputSha256: sha256Hex(`scripted output of ${runId}`),
      selfAssessment: { answer: self }, performedAt: clock.now().toISOString(), ...extra,
    });
  const reviewEnvelope = (who: Persona, run: { payload: Obj; signature: string }, verdict: 'accepted' | 'reworked'): Promise<{ payload: Obj; signature: string }> =>
    envelope(who, 'wrd:review-agent-run', { runEnvelopeSha256: envelopeSha256(run), verdict });
  const reviewedRun = async (runId: string, taskIri: string, self: 'accepted' | 'reworked', reviewer: Persona, verdict: 'accepted' | 'reworked'): Promise<Res> => {
    const run = await runEnvelope(runId, taskIri, self, { costPerRun: { amount: 0.12, currency: 'USD' } });
    return call('wrd.log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(reviewer, run, verdict) });
  };

  let reportPath: string | null = null;
  let records = 0;
  const marking = { records: 0, demoRecords: 0, unlabelledRows: -1, unlabelledCells: -1, sampledGraphHasDemoTriple: false };
  const started = Date.now();
  say(`work-redesign offline demo — bridge ${base}, pod ${DEMO_POD} (in memory), scripted personas: ${DEMO_LABEL}\n\n`);
  try {
    // 1. The manifest, read like any agent reads it.
    const manifest = obj(JSON.parse(await (await fetch(`${base}/affordances?format=jsonld`, { headers: { accept: 'application/ld+json' } })).text()));
    for (const a of arr(manifest['affordances'])) tools.set(str(a['toolName']), { url: str(a['target']), method: str(a['method']) });
    const production = wrdAffordances.map((a) => a.toolName);
    expect('1. the manifest lists the 22 production affordances and the two demo-only ones (signer, clock)', 'GET /affordances',
      production.length === 22 && production.every((t) => tools.has(t)) && tools.has('wrd.demo_envelope') && tools.has('wrd.demo_advance_clock') && tools.size === 24
        && [...tools.values()].every((t) => t.url.startsWith(`${base}/wrd/`)),
      `${tools.size} declared; every target is on ${base}`);
    // Only this server's own names are answered: a page that rebinds its DNS name to 127.0.0.1 is refused before any route.
    const rebound = await Promise.all([
      hostProbe(port, 'GET', '/affordances?format=jsonld', `rebind.attacker.example:${port}`),
      hostProbe(port, 'GET', '/wrd/list_records', `rebind.attacker.example:${port}`),
      hostProbe(port, 'POST', '/wrd/demo_envelope', `rebind.attacker.example:${port}`),
      hostProbe(port, 'GET', '/ui', 'rebind.attacker.example'),
    ]);
    expect('1. a Host naming another site (DNS rebinding) is refused 421 before any route: manifest, records, demo signer, UI', 'Host guard',
      rebound.every((r) => r.status === 421 && r.body['kind'] === 'refusal' && str(r.body['iep:refusalReason']) !== '' && str(r.body['error']) !== ''),
      rebound.map((r) => `${r.status} ${str(r.body['kind'])}`).join(', '));
    const own = await Promise.all([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].map(async (h) => ({ h, r: await hostProbe(port, 'GET', '/affordances?format=jsonld', h) })));
    expect('1. the server answers its own names: 127.0.0.1, localhost and [::1] on its port', 'Host guard',
      own.every(({ r }) => r.status === 200 && r.body['kind'] !== 'refusal'),
      own.map(({ h, r }) => `${h} ${r.status}`).join(', '));
    const signedForAna = await call('wrd.demo_envelope', { persona: 'ana', payload: { intent: 'wrd:holder-copy', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: nonce() } });
    const env1 = obj(signedForAna.body['envelope']);
    okStep('1. wrd.demo_envelope signs for ana with a key the demo server holds', 'wrd.demo_envelope', signedForAna, () =>
      signedForAna.body['signer'] === addr(P.ana) && recoverMessageSigner(canonicalJson(obj(env1['payload'])), str(env1['signature'])).toLowerCase() === addr(P.ana)
        ? null : 'the recovered signer is not ana');
    // Reads are scoped: unsigned, nothing; signed by a key neither admin nor registered, nothing.
    refusal('R-AU', 'an unsigned read of the records', 'wrd.list_records', await call('wrd.list_records'), 401, /needs a signed read/);
    refusal('R-AV', 'zed, neither an admin nor in the registry, signs a read', 'wrd.read_records',
      await call('wrd.read_records', { envelope: await readEnvelope(P.zed) }), 403, /Only an admin or a key in this pod's registry/);
    const adminRead = await call('wrd.read_records', { envelope: await readEnvelope() });
    okStep('1. the admin signs a read: the empty pod, reads signed, records sealed', 'wrd.read_records', adminRead, () =>
      obj(obj(adminRead.body)['bridge'])['reads'] === 'signed' && obj(obj(adminRead.body)['bridge'])['recordsSealed'] === true ? null : 'reads are not signed, or records are not sealed');

    // 2. The registry.
    const person = (p: Persona, roles: string[], personRef: string): Obj => ({ address: p.wallet.address, roles, label: p.label, softwareAgent: false, personRef });
    const entries: Obj[] = [
      person(P.ana, ['operator', 'approver'], 'p-ana'), person(P.ana2, ['approver'], 'p-ana'), person(P.bo, ['approver'], 'p-bo'),
      person(P.dee, ['approver', 'worker'], 'p-dee'), person(P.cy, ['worker'], 'p-cy'),
      ...[P.eli, P.fay, P.gus, P.hal, P.ivy].map((p) => person(p, ['operator'], `p-${p.id}`)),
      { address: P.agent.wallet.address, roles: ['agent'], label: P.agent.label, softwareAgent: true, principal: P.ana.wallet.address, model: 'scripted-fixture' },
      { address: P.coder.wallet.address, roles: ['agent'], label: P.coder.label, softwareAgent: true, principal: P.dee.wallet.address, model: 'scripted-fixture' },
    ];
    refusal('R-A', 'a registry change signed by ana, who is not an admin', 'wrd.update_registry', await act(P.ana, 'wrd.update_registry', { entries }), 403, /Only an admin/);
    okStep('2. the admin registers the people, two agents (principals ana and dee, model scripted-fixture) and five task kinds', 'wrd.update_registry',
      await act(P.admin, 'wrd.update_registry', { entries, taskKinds: TASK_KINDS }));

    // 3. The client-required packet.
    const packet = await call('wrd.task_map_packet', { document_title: 'AP-SOP-014', document_text: SOP, workflow_title: 'Supplier invoice processing' });
    okStep('3. task_map_packet: instructions only — nothing sampled, nothing written', 'wrd.task_map_packet', packet, () =>
      packet.body['execution'] === 'client-required' && packet.body['sampling_performed'] === false && packet.body['writes_performed'] === false
        && obj(packet.body['request'])['documentSha256'] === sha256Hex(SOP) ? null : 'the packet is not a client-required, instructions-only packet');

    // 4–6. Capture from the document.
    const completeTask = (t: typeof SCRIPTED_CLIENT_DRAFT.tasks[number], who: Persona, taskKind: string): Obj => ({
      name: t.name, description: t.description, currentLevel: 'person', personAddress: who.wallet.address, taskKind, sourceQuotes: [...t.sourceQuotes],
    });
    const people = [P.cy, P.dee, P.cy, P.dee];
    const tableTasks = SCRIPTED_CLIENT_DRAFT.tasks.map((t, i) => completeTask(t, people[i] ?? P.cy, TABLE_KINDS[i] ?? 'invoice-matching'));
    const draftText = JSON.stringify(SCRIPTED_CLIENT_DRAFT, null, 2);
    const doc = (sha: string, tasks: Obj[], storeText: boolean): Obj => ({
      workflow: SCRIPTED_CLIENT_DRAFT.workflow, tasks, document: { title: 'AP-SOP-014', sha256: sha, storeText }, draftedBy: SCRIPTED_CLIENT_DRAFT.draftedBy, draftSha256: sha256Hex(draftText),
    });
    refusal('R-B', 'a task map in which every quote is fabricated', 'wrd.record_task_map',
      await act(P.ana, 'wrd.record_task_map', doc(sha256Hex(SOP), [{ ...tableTasks[0], sourceQuotes: [FABRICATED] }], false), { document_text: SOP }), 422, /None of the quoted spans/);
    refusal('R-C', 'a task map bound to a different document', 'wrd.record_task_map',
      await act(P.ana, 'wrd.record_task_map', doc(sha256Hex(`${SOP}\nAn edited copy.`), tableTasks, false), { document_text: SOP }), 400, /not the one the signer bound/);
    const captured = await act(P.ana, 'wrd.record_task_map', doc(sha256Hex(SOP), tableTasks, true), { document_text: SOP });
    const normalised = normaliseForQuote(SOP);
    const perTask = obj(captured.body['quotes'])['perTask'];
    const verdicts = Array.isArray(perTask) ? perTask.flatMap((t) => arr(t)) : [];
    okStep('6. ana signs the scripted draft from the table: one quote unverified, every other quote verified at offsets into the normalised SOP', 'wrd.record_task_map', captured, () => {
      const unverified = verdicts.filter((v) => v['status'] === 'unverified');
      if (unverified.length !== 1 || unverified[0]?.['quote'] !== FABRICATED) return `unverified: ${JSON.stringify(unverified.map((v) => v['quote']))}`;
      const bad = verdicts.filter((v) => v['status'] === 'verified' && normalised.slice(Number(v['start']), Number(v['end'])) !== normaliseForQuote(str(v['quote'])));
      return bad.length === 0 ? null : `${bad.length} offsets do not slice back to their quote`;
    });
    const wfIri = str(captured.body['workflowIri']);
    const taskIris = arr(captured.body['tasks']).map((t) => str(t['taskIri']));
    const [t1 = '', t2 = '', t3 = '', t4 = ''] = taskIris;
    const taskName = (iri: string): string => (iri === t1 ? 'T1' : iri === t2 ? 'T2' : iri === t3 ? 'T3' : iri === t4 ? 'T4' : iri);

    // 7. Capture by hand — signed through the same path the web UI uses (wrd.demo_envelope).
    const viaUi = await call('wrd.demo_envelope', { persona: 'ana', payload: {
      intent: 'wrd:capture-workflow', podUrl: DEMO_POD, issuedAt: clock.now().toISOString(), nonce: nonce(),
      workflow: { title: 'Month-end accrual review', unitLabel: 'accrual' },
      tasks: [{ name: 'Review open accruals for uninvoiced receipts', description: 'Accrue goods received but not invoiced, and reverse when the invoice arrives.', currentLevel: 'person', personAddress: P.dee.wallet.address, taskKind: 'accrual-review' }],
    } });
    const manual = await call('wrd.capture_workflow', { envelope: viaUi.body['envelope'] });
    okStep('7. capture by hand, signed through wrd.demo_envelope as the UI does: quote status none', 'wrd.capture_workflow', manual, () =>
      arr(manual.body['tasks'])[0]?.['quoteStatus'] === 'none' ? null : 'expected quoteStatus none');

    // 8–10. Ratify before anything moves.
    const P1_CHANGES: Obj[] = [
      { taskIri: t1, proposedLevel: 'agent-drafts-person-decides', agentAddress: P.agent.wallet.address, personAddress: P.cy.wallet.address },
      { taskIri: t2, proposedLevel: 'person-with-agent-assist', personAddress: P.dee.wallet.address, agentAddress: P.agent.wallet.address },
    ];
    const propose = (title: string, changes: Obj[]): Promise<Res> => act(P.ana, 'wrd.propose_allocation', { workflowIri: wfIri, title, changes });
    refusal('R-D', 'propose an allocation before any task is classified', 'wrd.propose_allocation', await propose('P1', P1_CHANGES), 409, /Classify every task/);
    refusal('R-E', 'dee ratifies T1, which does not name her', 'wrd.ratify_task', await ratify(P.dee, t1, 'ratify'), 403, /named on this task/);
    okStep('10. cy ratifies T1', 'wrd.ratify_task', await ratify(P.cy, t1, 'ratify'));
    okStep('10. cy ratifies T3', 'wrd.ratify_task', await ratify(P.cy, t3, 'ratify'));
    okStep('10. dee ratifies T4', 'wrd.ratify_task', await ratify(P.dee, t4, 'ratify'));
    const disputed = await ratify(P.dee, t2, 'dispute', 'Misses the accrual step for uninvoiced receipts');
    okStep('10. dee disputes T2: "Misses the accrual step for uninvoiced receipts"', 'wrd.ratify_task', disputed, () => (disputed.body['status'] === 'disputed' ? null : 'not disputed'));

    // 11. Classify from signed evidence answers.
    refusal('R-F', 'classify T1 with every answer unknown', 'wrd.classify_task', await classify(P.ana, t1, ANSWERS.unknown), 400, /No evidence places this task/);
    for (const [t, a, want] of [[t1, ANSWERS.evident, 'Evident'], [t2, ANSWERS.knowable, 'Knowable'], [t3, ANSWERS.emergent, 'Emergent'], [t4, ANSWERS.turbulent, 'Turbulent']] as const) {
      const c = await classify(P.ana, t, a);
      // Ana holds the approver role as well as operator, so the record names her answers as an approver's (spec §5.3).
      okStep(`11. ana classifies ${taskName(t)} → ${want}`, 'wrd.classify_task', c, () =>
        c.body['regime'] === want && c.body['status'] === 'classified' && obj(c.body['answeredBy'])['role'] === 'approver' && c.body['regimeSource'] === 'rule-on-signed-answers'
          && strings(c.body['rulesFired']).length > 0 && strings(c.body['rulesFired']).every((r) => r.startsWith(WRD_NS))
          ? null : `got ${JSON.stringify({ regime: c.body['regime'], status: c.body['status'], answeredBy: c.body['answeredBy'] })}`);
    }

    // 11b. An agent goes on work only once the people named on it agree how knowable it is.
    refusal('R-AN', 'propose an agent drafting T1 before cy has ratified its classification', 'wrd.propose_allocation',
      await propose('too early', [{ taskIri: t1, proposedLevel: 'agent-drafts-person-decides', agentAddress: P.agent.wallet.address, personAddress: P.cy.wallet.address }]), 409, /ratified how knowable it is/);
    okStep('11. cy ratifies the classification of T1 (Evident)', 'wrd.ratify_task', await ratifyClassification(P.cy, t1));
    okStep('11. cy ratifies the classification of T3 (Emergent)', 'wrd.ratify_task', await ratifyClassification(P.cy, t3));

    // 12. What the regime allows.
    refusal('R-G', 'change Turbulent T4', 'wrd.propose_allocation', await propose('T4', [{ taskIri: t4, proposedLevel: 'person-with-agent-assist', personAddress: P.dee.wallet.address }]), 409, /stabilise first/);
    refusal('R-H', 'change Emergent T3 without probes', 'wrd.propose_allocation', await propose('T3', [{ taskIri: t3, proposedLevel: 'person-with-agent-assist', personAddress: P.cy.wallet.address }]), 400, /safe-to-fail probes/);
    refusal('R-I', 'put T1 under an agent acting within a grant it does not hold', 'wrd.propose_allocation', await propose('T1', [{ taskIri: t1, proposedLevel: 'agent-acts-within-grant', agentAddress: P.agent.wallet.address }]), 409, /No active grant/);
    refusal('R-J', 'name cy, a person, as the agent on T1', 'wrd.propose_allocation', await propose('T1', [{ taskIri: t1, proposedLevel: 'agent-drafts-person-decides', agentAddress: P.cy.wallet.address, personAddress: P.cy.wallet.address }]), 400, /registered software agent/);
    const probes = [
      { hypothesis: 'An agent-drafted first reply settles disputes sooner', amplifyIf: 'median days to settle falls by a quarter', dampenIf: 'suppliers escalate more often', timeboxWeeks: 4 },
      { hypothesis: 'Suppliers accept a templated correction note', amplifyIf: 'fewer than one in ten disputes reopen', dampenIf: 'more than one in four reopen', timeboxWeeks: 4 },
    ];
    const T3_PROBE: Obj = { taskIri: t3, proposedLevel: 'person-with-agent-assist', personAddress: P.cy.wallet.address, agentAddress: P.agent.wallet.address, probes };
    refusal('R-K', 'one plan mixing a T3 probe with a valued T1 change', 'wrd.propose_allocation', await propose('mixed', [T3_PROBE, P1_CHANGES[0] ?? {}]), 409, /separate plans/);

    // 13. A dispute is answered by a revision, then everything named re-signs.
    const blocked = await propose('P1', P1_CHANGES);
    refusal('R-L', 'propose changing T2 while dee disputes its description', 'wrd.propose_allocation', blocked, 409, /disputed task description/,
      () => (obj(blocked.body['iep:resolvedBy'])['toolName'] === 'wrd.revise_task' ? null : 'not resolved by wrd.revise_task'));
    const t2Head = headOf(await taskRow(t2));
    const revised = await act(P.ana, 'wrd.revise_task', {
      op: 'revise', taskIri: t2, descriptorUrl: t2Head.descriptorUrl, graphDigest: t2Head.graphDigest,
      description: 'Choose the general ledger account and cost centre, from the purchase order or else from the chart of accounts; at month end, accrue goods received but not yet invoiced.',
      note: 'Adds the accrual step dee pointed out',
    });
    okStep('13. ana revises T2 to add the accrual step; the revision carries the dispute it answers', 'wrd.revise_task', revised, () =>
      revised.body['status'] === 'captured' && arr(revised.body['answeredDisputes'])[0]?.['note'] === 'Misses the accrual step for uninvoiced receipts' ? null : 'the revision does not carry dee\'s note');
    refusal('R-M', 'propose the same plan: T2 was classified against its earlier description', 'wrd.propose_allocation', await propose('P1', P1_CHANGES), 409, /revised after it was classified/);
    const deeClass = await classify(P.dee, t2, ANSWERS.knowable);
    okStep('13. dee classifies T2 herself → Knowable, ratified, answered as the performer', 'wrd.classify_task', deeClass, () =>
      deeClass.body['regime'] === 'Knowable' && deeClass.body['status'] === 'ratified' && obj(deeClass.body['answeredBy'])['role'] === 'performer' ? null : JSON.stringify(deeClass.body['answeredBy']));
    const deeRatifies = await ratify(P.dee, t2, 'ratify');
    okStep('13. dee ratifies the revised T2 description', 'wrd.ratify_task', deeRatifies, () => (deeRatifies.body['status'] === 'ratified' ? null : 'not ratified'));

    // 14. Plan P1.
    const p1 = await propose('P1: agent drafts T1 matching, agent assists T2 coding', P1_CHANGES);
    const p1Iri = str(p1.body['planIri']);
    okStep('14. ana proposes P1 (valued)', 'wrd.propose_allocation', p1, () => (p1.body['planKind'] === 'valued' ? null : `planKind ${str(p1.body['planKind'])}`));
    const p1Row = await planRow(p1Iri);
    expect('14. P1 shows cy as "named by the operator, not acknowledged"', 'wrd.read_records',
      arr(p1Row['assignments']).some((a) => a['personAddress'] === addr(P.cy) && a['label'] === 'named by the operator, not acknowledged'), 'until she signs');
    const ack = await acknowledge(P.cy, p1Iri, t1, 'acknowledge');
    okStep('14. cy acknowledges deciding on the agent\'s T1 drafts', 'wrd.ratify_task', ack, () => (ack.body['status'] === 'acknowledged' ? null : 'not acknowledged'));

    // 15. Value P1 with ranges.
    const p1Inputs: Obj = {
      ...TOP_INPUTS,
      freedHours: { [t1]: { disposition: 'absorbed', note: 'cy takes on supplier-statement reconciliation' }, [t2]: { disposition: 'undecided' } },
      tasks: {
        [t1]: {
          runsPerUnit: one(1, 'measured'),
          current: { ...naState(), performerHoursPerRun: tri(0.15, 0.2, 0.3, 'measured'), minorFailureRate: tri(0.01, 0.02, 0.04, 'measured'),
            minorFailureCost: tri(20, 30, 50, 'performer-reported'), criticalFailureRate: tri(0, 0.001, 0.003, 'estimate'), criticalFailureCost: tri(500, 2000, 10000, 'estimate') },
          proposed: { ...naState(), oversightHoursPerRun: tri(0.03, 0.05, 0.08, 'estimate'), agentCostPerRun: tri(0.05, 0.1, 0.2, 'estimate'),
            minorFailureRate: tri(0.01, 0.03, 0.05, 'estimate'), minorFailureCost: tri(20, 30, 50, 'performer-reported'),
            criticalFailureRate: tri(0, 0.001, 0.003, 'estimate'), criticalFailureCost: tri(500, 2000, 10000, 'estimate') },
        },
        [t2]: {
          runsPerUnit: one(1, 'measured'),
          current: { ...naState(), performerHoursPerRun: tri(0.1, 0.15, 0.2, 'performer-reported') },
          proposed: { ...naState(), performerHoursPerRun: tri(0.07, 0.1, 0.15, 'estimate'), agentCostPerRun: tri(0.02, 0.05, 0.1, 'estimate') },
        },
      },
    };
    const v1 = await act(P.ana, 'wrd.value_plan', { planIri: p1Iri, inputs: p1Inputs });
    const r1 = obj(v1.body['result']);
    const sc = obj(r1['scenarios']);
    const cashBand = obj(obj(sc['cash'])['weeklyDelta']);
    const redBand = obj(obj(sc['redeployed'])['weeklyDelta']);
    const ins = obj(r1['inputs']);
    okStep('15. value P1: two figures, inputs by basis, unconfirmed agent cost, expert evidence from dee\'s own answers', 'wrd.value_plan', v1, () => {
      const ordered = (b: Obj): boolean => Number(b['p10']) <= Number(b['p50']) && Number(b['p50']) <= Number(b['p90']);
      if (!ordered(cashBand) || !ordered(redBand)) return 'P10 <= P50 <= P90 does not hold';
      if (!(Number(cashBand['p50']) < Number(redBand['p50']))) return 'cash P50 is not below the if-redeployed P50';
      if (JSON.stringify(v1.body['expertEvidence']) !== JSON.stringify([{ taskIri: t2, satisfiedBy: 'performer-answers' }])) return `expertEvidence ${JSON.stringify(v1.body['expertEvidence'])}`;
      if (JSON.stringify(arr(ins['unconfirmed']).map((u) => u['path'])) !== JSON.stringify([`tasks[${t1}].proposed.agentCostPerRun`])) return 'unconfirmed should name T1\'s proposed agent cost';
      const noRange = Array.isArray(ins['noRange']) ? (ins['noRange'] as unknown[]).map(String) : [];
      if (!noRange.includes(`tasks[${t1}].runsPerUnit`) || !noRange.includes(`tasks[${t2}].runsPerUnit`)) return 'the two single-number inputs are not listed as "no range given"';
      if (!Array.isArray(ins['topSensitivityEstimates'])) return 'no topSensitivityEstimates';
      return null;
    }, () => `weekly cash change P50 ${Number(cashBand['p50']).toFixed(2)} vs ${Number(redBand['p50']).toFixed(2)} if freed hours are redeployed (USD); `
      + `${strings(ins['noRange']).length} inputs with no range; ${strings(ins['topSensitivityEstimates']).length} unmeasured estimate(s) among the top three`);
    const v1Again = await act(P.ana, 'wrd.value_plan', { planIri: p1Iri, inputs: p1Inputs });
    okStep('15. the same plan and inputs again → the same record, reused', 'wrd.value_plan', v1Again, () =>
      v1Again.body['reused'] === true && v1Again.body['valuationHash'] === v1.body['valuationHash'] ? null : 'not reused');

    // 16. Submit D1.
    const submitFields = (planIri: string, v: Obj, basis: string): Obj => ({ planIri, valuationIri: v['valuationIri'], valuationHash: v['valuationHash'], measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: basis, windowWeeks: 8 } });
    refusal('R-N', 'submit with a valuation hash that is not the record\'s', 'wrd.submit_decision', await act(P.ana, 'wrd.submit_decision', { ...submitFields(p1Iri, v1.body, 'staggered'), valuationHash: '0'.repeat(64) }), 409, /hash does not match/);
    const d1 = await act(P.ana, 'wrd.submit_decision', submitFields(p1Iri, v1.body, 'staggered'));
    const d1Iri = str(d1.body['decisionIri']);
    const prediction = obj(d1.body['prediction']);
    okStep('16. ana submits D1 (weekly cash change, staggered roll-out, 8 weeks): Hypothetical', 'wrd.submit_decision', d1, () => (d1.body['status'] === 'submitted' && prediction['band'] ? null : 'no prediction'));

    // 17–18. Countersign: separation of duties by attested person.
    refusal('R-O', 'record an outcome before anyone countersigns', 'wrd.record_outcome', await recordOutcome(P.eli, d1Iri, { disposition: 'kept', measured: {} }), 409, /only for a countersigned decision/);
    refusal('R-P', 'ana countersigns her own submission', 'wrd.countersign_decision', await countersign(P.ana, d1Iri, 'approve'), 403, /submitted a decision cannot countersign/);
    refusal('R-Q', 'ana countersigns from her second key', 'wrd.countersign_decision', await countersign(P.ana2, d1Iri, 'approve'), 403, /from any of their registered keys/);
    refusal('R-R', 'dee, whose coding work D1 changes, countersigns', 'wrd.countersign_decision', await countersign(P.dee, d1Iri, 'approve'), 403, /whose work this decision changes/);
    refusal('R-S', 'eli, not an approver, countersigns', 'wrd.countersign_decision', await countersign(P.eli, d1Iri, 'approve'), 403, /registered approver/);
    const d1Head = headOf(await decisionRow(d1Iri));
    refusal('R-T', 'bo countersigns a digest that is not the head\'s', 'wrd.countersign_decision',
      await act(P.bo, 'wrd.countersign_decision', { decisionIri: d1Iri, recordId: d1Head.recordId, descriptorUrl: d1Head.descriptorUrl, graphDigest: `graph-nquads-sha256:${'0'.repeat(64)}`, verdict: 'approve' }), 409, /changed since you read it/);
    refusal('R-AO', 'bo approves D1 while dee has not acknowledged her T2 assignment, without naming it', 'wrd.countersign_decision', await countersign(P.bo, d1Iri, 'approve'), 409, /has not acknowledged their assignment/);
    okStep('18. dee acknowledges working with the agent\'s assistance on T2', 'wrd.ratify_task', await acknowledge(P.dee, p1Iri, t2, 'acknowledge'));
    const boEnv = await envelope(P.bo, 'wrd:countersign-decision', { decisionIri: d1Iri, recordId: d1Head.recordId, descriptorUrl: d1Head.descriptorUrl, graphDigest: d1Head.graphDigest, verdict: 'approve', objectionsConsidered: [] });
    const approved = await call('wrd.countersign_decision', { envelope: boEnv });
    okStep('18. bo countersigns D1: Asserted, "approved; prediction unmeasured"', 'wrd.countersign_decision', approved, () =>
      approved.body['statusLabel'] === 'approved; prediction unmeasured' ? null : str(approved.body['statusLabel']));
    const d1Row = await decisionRow(d1Iri);
    const d1Graph = await podGraph(headOf(d1Row).descriptorUrl);
    expect('18. the countersigned graph (sealed on the pod, opened with the record key) states its prediction is unmeasured', 'pod read',
      obj(d1Row['head'])['modalStatus'] === 'Asserted' && d1Graph.sealed && d1Graph.text.includes('wrd:predictionStatus "unmeasured"'), 'wrd:Prediction node in the graph');
    refusal('R-U', 'replay bo\'s exact countersign envelope', 'wrd.countersign_decision', await call('wrd.countersign_decision', { envelope: boEnv }), 409, /already used/);

    // 19. The world answers, after the window has actually ended.
    const csAt = str(obj(d1Row['countersign'])['at']);
    const windowEnd = plusWeeks(csAt, 8);
    const measuredFields = (value: number): Obj => ({ disposition: 'kept', measured: { weeklyValueDelta: value, comparisonBasis: 'staggered', windowStart: csAt, windowEnd, method: 'Staggered roll-out across the two AP teams; weekly cash change from the cost ledger' } });
    refusal('R-V', 'ana grades her own prediction', 'wrd.record_outcome', await recordOutcome(P.ana, d1Iri, measuredFields(100)), 403, /predicted cannot grade/);
    refusal('R-AP', 'bo, who approved D1, grades it', 'wrd.record_outcome', await recordOutcome(P.bo, d1Iri, measuredFields(100)), 403, /approved a decision cannot grade it/);
    refusal('R-W', 'eli records an outcome whose window has not ended', 'wrd.record_outcome', await recordOutcome(P.eli, d1Iri, measuredFields(100)), 409, /has not ended yet/);
    const moved = await call('wrd.demo_advance_clock', { weeks: 9 });
    okStep('19. the demo clock is moved nine weeks through its own (demo-only) affordance', 'wrd.demo_advance_clock', moved, () =>
      moved.body['movedWeeks'] === 9 && Date.parse(str(moved.body['now'])) >= Date.parse(windowEnd) ? null : JSON.stringify(moved.body));
    const factor = meanRampFactor(0, monthsBetween(csAt, windowEnd), Number(prediction['rampMonths']));
    const measuredValue = Math.round(Number(obj(prediction['band'])['p50']) * factor * 100) / 100;
    const outcome = await recordOutcome(P.eli, d1Iri, measuredFields(measuredValue));
    const graded = obj(outcome.body['valued']);
    okStep(`19. nine weeks later eli records ${measuredValue} a week — scripted as the prediction's P50 × ramp factor ${factor.toFixed(3)}, so in band by construction`, 'wrd.record_outcome', outcome, () =>
      graded['verdict'] === 'in-band' && graded['rampAdjusted'] === true && Number(graded['rampFactor']) < 1 ? null : JSON.stringify(graded),
    () => `${str(graded['verdict'])} against the ramp-adjusted band P10 ${Number(obj(graded['adjustedBand'])['p10']).toFixed(2)} … P90 ${Number(obj(graded['adjustedBand'])['p90']).toFixed(2)}`);
    const chain = arr((await decisionRow(d1Iri))['chain']);
    expect('19. D1 is one graph: submitted → countersigned → measured, each superseding the last', 'wrd.read_records',
      JSON.stringify(chain.map((c) => c['status'])) === JSON.stringify(['submitted', 'countersigned', 'measured']), chain.map((c) => `${str(c['status'])}/${str(c['modalStatus'])}`).join(' → '));

    // 20. A declined decision, and an objection that must be named.
    const p2 = await propose('P2: agent codes T2, dee audits', [{ taskIri: t2, proposedLevel: 'agent-acts-person-audits', agentAddress: P.agent.wallet.address, personAddress: P.dee.wallet.address }]);
    const p2Iri = str(p2.body['planIri']);
    okStep('20. ana proposes P2', 'wrd.propose_allocation', p2);
    const v2 = await act(P.ana, 'wrd.value_plan', { planIri: p2Iri, inputs: {
      ...TOP_INPUTS, freedHours: { [t2]: { disposition: 'redeployed', note: 'dee moves to supplier master-data quality' } },
      tasks: { [t2]: {
        runsPerUnit: one(1, 'measured'),
        current: { ...naState(), performerHoursPerRun: tri(0.07, 0.1, 0.15, 'measured'), agentCostPerRun: tri(0.02, 0.05, 0.1, 'measured') },
        proposed: { ...naState(), oversightHoursPerRun: tri(0.02, 0.04, 0.06, 'estimate'), agentCostPerRun: tri(0.05, 0.08, 0.12, 'estimate'),
          minorFailureRate: tri(0.02, 0.04, 0.08, 'estimate'), minorFailureCost: tri(30, 60, 120, 'estimate') },
      } },
    } });
    okStep('20. value P2', 'wrd.value_plan', v2);
    const d2 = await act(P.ana, 'wrd.submit_decision', submitFields(p2Iri, v2.body, 'before-after'));
    const d2Iri = str(d2.body['decisionIri']);
    okStep('20. submit D2 on a before-after basis', 'wrd.submit_decision', d2, () => (d2.body['basisLabel'] === 'before-after — no comparison group' ? null : str(d2.body['basisLabel'])));
    okStep('20. dee objects to auditing the agent', 'wrd.ratify_task', await acknowledge(P.dee, p2Iri, t2, 'object', 'I cannot audit 200 codings a week'));
    refusal('R-X', 'bo approves D2 without naming dee\'s objection', 'wrd.countersign_decision', await countersign(P.bo, d2Iri, 'approve'), 409, /objects to their assignment/);
    const declined = await countersign(P.bo, d2Iri, 'decline', { note: 'Not while the audit load is unresolved' });
    okStep('20. bo declines D2', 'wrd.countersign_decision', declined, () => (declined.body['status'] === 'declined' ? null : 'not declined'));
    const d2Row = await decisionRow(d2Iri);
    expect('20. D2\'s head is Counterfactual and its prediction will not be measured', 'wrd.read_records',
      obj(d2Row['head'])['modalStatus'] === 'Counterfactual' && obj(d2Row['prediction'])['status'] === 'not-to-be-measured', str(d2Row['statusLabel']));
    refusal('R-Y', 'eli records an outcome on the declined D2', 'wrd.record_outcome', await recordOutcome(P.eli, d2Iri, { disposition: 'kept', measured: {} }), 409, /only for a countersigned decision/);

    // 21. Emergent work: probes, never priced.
    const p4 = await propose('P4: probe agent help on supplier disputes', [T3_PROBE]);
    const p4Iri = str(p4.body['planIri']);
    okStep('21. ana proposes P4 with two probes on T3', 'wrd.propose_allocation', p4, () => (p4.body['planKind'] === 'probe' ? null : `planKind ${str(p4.body['planKind'])}`));
    const zp = await act(P.ana, 'wrd.value_plan', { planIri: p4Iri, inputs: {} });
    refusal('R-Z', 'value the probe plan', 'wrd.value_plan', zp, 409, /probe plan/, () => (obj(zp.body['iep:resolvedBy'])['toolName'] === 'wrd.submit_decision' ? null : 'not resolved by submit_decision'));
    const d4 = await act(P.eli, 'wrd.submit_decision', { planIri: p4Iri });
    const d4Iri = str(d4.body['decisionIri']);
    okStep('21. eli submits D4: no valuation, no prediction', 'wrd.submit_decision', d4, () => (d4.body['prediction'] === undefined ? null : 'a probe decision carries a prediction'));
    refusal('R-AQ', 'ana countersigns D4 from her second key: she proposed P4', 'wrd.countersign_decision', await countersign(P.ana2, d4Iri, 'approve'), 403, /proposed this plan cannot countersign/);
    const d4Approved = await countersign(P.bo, d4Iri, 'approve', { unacknowledgedConsidered: [t3] });
    okStep('21. bo countersigns D4, naming cy\'s unacknowledged probe assignment to approve over her silence', 'wrd.countersign_decision', d4Approved, () =>
      arr(d4Approved.body['assignments'])[0]?.['state'] === 'not-acknowledged' ? null : JSON.stringify(d4Approved.body['assignments']));
    const d4At = str(obj((await decisionRow(d4Iri))['countersign'])['at']);
    clock.advance(5 * WEEK);
    const probeResult = (index: number, signal: string, observed: string): Obj => ({ taskIri: t3, index, signal, observed, windowStart: d4At, windowEnd: plusWeeks(d4At, 4) });
    const read = await recordOutcome(P.fay, d4Iri, { disposition: 'kept', probeResults: [probeResult(1, 'amplify', 'Median days to settle fell from 11 to 7'), probeResult(2, 'neither', 'Reopen rate unchanged at about one in six')] });
    okStep('21. fay reads the probes: amplify, neither → "Re-classify this task, then propose a plan."', 'wrd.record_outcome', read, () => (read.body['next'] === 'Re-classify this task, then propose a plan.' ? null : str(read.body['next'])));
    const reclass = await classify(P.cy, t3, ANSWERS.reclassified);
    okStep('21. cy re-classifies T3 from what the probes showed → Knowable (rule R4), ratified', 'wrd.classify_task', reclass, () =>
      reclass.body['regime'] === 'Knowable' && reclass.body['status'] === 'ratified' && strings(reclass.body['rulesFired']).includes(`${WRD_NS}RuleR4`)
        ? null : JSON.stringify(reclass.body['rulesFired']));

    // 22–24. An agent earns a grant from person-reviewed runs.
    const reviewers = [P.eli, P.fay, P.gus];
    const runIris: string[] = [];
    const eliRuns: string[] = [];
    const logRuns = async (from: number, to: number): Promise<boolean> => {
      let all = true;
      for (let i = from; i <= to; i += 1) {
        const who = reviewers[i % 3] ?? P.eli;
        const r = await reviewedRun(`r-${String(i).padStart(3, '0')}`, t1, 'accepted', who, 'accepted');
        all &&= r.status === 200;
        runIris.push(str(r.body['runIri']));
        if (who === P.eli) eliRuns.push(str(r.body['runIri']));
      }
      return all;
    };
    expect('22. ten T1 runs by the agent, each reviewed by eli, fay or gus', 'wrd.log_agent_run', await logRuns(1, 10), '10 reviewed');
    const grant = (who: Persona, agentAddress = P.agent.wallet.address): Promise<Res> => act(who, 'wrd.grant_autonomy', { agentAddress, taskKind: 'invoice-matching' });
    refusal('R-AA', 'grant on 10 reviewed runs', 'wrd.grant_autonomy', await grant(P.bo), 409, /10 person-reviewed runs on model scripted-fixture; the policy needs 20/);
    refusal('R-AB', 'grant autonomy to cy, a person', 'wrd.grant_autonomy', await grant(P.bo, P.cy.wallet.address), 403, /registered software agents only/);
    const r3 = await runEnvelope('r-principal', t1, 'accepted');
    refusal('R-AC', 'ana, the agent\'s principal, reviews its run', 'wrd.log_agent_run', await call('wrd.log_agent_run', { run_envelope: r3, review_envelope: await reviewEnvelope(P.ana, r3, 'accepted') }), 403, /accountable for this agent/);
    expect('23. ten more runs: 20 reviewed, by three people', 'wrd.log_agent_run', await logRuns(11, 20), '20 reviewed');
    refusal('R-AD', 'grant on 20 runs reviewed by 3 distinct people', 'wrd.grant_autonomy', await grant(P.bo), 409, /reviewed by 3 distinct registered reviewers the admin attests are different people; the policy needs 5/);
    let four = true;
    for (const [id, self, who, verdict] of [['r-021', 'accepted', P.hal, 'accepted'], ['r-022', 'accepted', P.ivy, 'accepted'], ['r-023', 'accepted', P.hal, 'reworked'], ['r-024', 'reworked', P.ivy, 'reworked']] as const) {
      const r = await reviewedRun(id, t1, self, who, verdict);
      four &&= r.status === 200;
      runIris.push(str(r.body['runIri']));
    }
    expect('24. four more, reviewed by hal and ivy: the agent called 23 ready and a person accepted 22 of them', 'wrd.log_agent_run', four, '24 reviewed by 5 people');
    const granted = await grant(P.bo);
    const grantIri = str(granted.body['grantIri']);
    okStep('24. bo grants the agent autonomy on invoice matching', 'wrd.grant_autonomy', granted, () =>
      granted.body['status'] === 'granted' && granted.body['principal'] === addr(P.ana) && granted.body['model'] === 'scripted-fixture'
        && JSON.stringify(obj(granted.body['evaluation'])['taskIris']) === JSON.stringify([t1]) ? null : JSON.stringify(granted.body['evaluation']));

    // 24b. An agent whose work is mostly reworked does not earn a grant, however truthfully it labels its runs.
    let coderRuns = true;
    const coderReviewers = [P.eli, P.fay, P.gus, P.hal, P.ivy];
    for (let i = 1; i <= 20; i += 1) {
      const self = i === 1 ? 'accepted' : 'reworked';
      const run = await runEnvelope(`c-${String(i).padStart(3, '0')}`, t2, self, {}, P.coder, 'gl-coding');
      const r = await call('wrd.log_agent_run', { run_envelope: run, review_envelope: await reviewEnvelope(coderReviewers[i % 5] ?? P.eli, run, self) });
      coderRuns &&= r.status === 200;
    }
    expect('24. twenty coding-agent runs on T2, reviewed by five people: a person accepted 1; the agent called the other 19 "reworked" itself, truthfully', 'wrd.log_agent_run', coderRuns, '20 reviewed');
    refusal('R-AR', 'bo grants the coding agent autonomy: its self-assessment agreed every time, but its work was accepted once', 'wrd.grant_autonomy',
      await act(P.bo, 'wrd.grant_autonomy', { agentAddress: P.coder.wallet.address, taskKind: 'gl-coding' }), 409, /a person accepted 1 of 20 reviewed runs \(5%\); the policy needs at least 90%/);

    // 25. The grant in use: a decision puts T1 under it, then a run under the grant, reviewed an hour later.
    const p3 = await act(P.eli, 'wrd.propose_allocation', { workflowIri: wfIri, title: 'P3: the agent matches invoices within its grant', changes: [{ taskIri: t1, proposedLevel: 'agent-acts-within-grant', agentAddress: P.agent.wallet.address }] });
    const p3Iri = str(p3.body['planIri']);
    okStep('25. eli proposes P3 with the agent acting within its grant', 'wrd.propose_allocation', p3, () =>
      obj(arr(p3.body['tasks']).find((r) => r['taskIri'] === t1)?.['grant'])['evidenceFromThisTask'] === true ? null : 'no grant evidence from this task');
    const p3Template = await template('wrd:value-plan', { plan_iri: p3Iri });
    const p3Draft = obj(p3Template.body['template']);
    okStep('25. eli asks for the valuation payload P3 needs: a template keyed by its changed task, with what is left to fill', 'wrd.read_envelope_template', p3Template, () =>
      p3Draft['planIri'] === p3Iri && Object.keys(obj(obj(p3Draft['inputs'])['tasks'])).join() === t1 && strings(p3Template.body['fill']).includes('inputs.currency')
        && obj(p3Template.body['schema'])['title'] === 'wrd:value-plan payload' ? null : JSON.stringify(p3Template.body).slice(0, 300));
    const p3Inputs: Obj = {
      ...obj(p3Draft['inputs']), ...TOP_INPUTS, freedHours: { [t1]: { disposition: 'absorbed', note: 'cy reviews supplier statements instead' } },
      tasks: { [t1]: {
        runsPerUnit: one(1, 'measured'),
        current: { ...naState(), oversightHoursPerRun: tri(0.03, 0.05, 0.08, 'estimate'), agentCostPerRun: tri(0.08, 0.12, 0.2, 'estimate'),
          minorFailureRate: tri(0.01, 0.03, 0.05, 'estimate'), minorFailureCost: tri(20, 30, 50, 'performer-reported') },
        proposed: { ...naState(), agentCostPerRun: tri(0.08, 0.12, 0.2, 'estimate'), minorFailureRate: tri(0.01, 0.04, 0.07, 'estimate'), minorFailureCost: tri(20, 30, 50, 'performer-reported') },
      } },
    };
    const v3 = await act(P.eli, 'wrd.value_plan', { planIri: p3Iri, inputs: p3Inputs });
    okStep('25. eli values P3 from the template: the reported run cost is shown as agent-reported', 'wrd.value_plan', v3, () =>
      JSON.stringify(arr(obj(obj(v3.body['result'])['inputs'])['reportedAgentCost']).map((c) => c['basis'])) === '["agent-reported on person-reviewed runs"]' ? null : JSON.stringify(obj(obj(v3.body['result'])['inputs'])['reportedAgentCost']));
    const d3 = await act(P.eli, 'wrd.submit_decision', { ...submitFields(p3Iri, v3.body, 'holdout') });
    const d3Iri = str(d3.body['decisionIri']);
    okStep('25. eli submits D3', 'wrd.submit_decision', d3);
    refusal('R-AS', 'ana, the agent\'s accountable principal, countersigns D3 from her approver key', 'wrd.countersign_decision', await countersign(P.ana2, d3Iri, 'approve'), 403, /accountable for an agent this decision puts on the work/);
    okStep('25. bo countersigns D3: T1 is now in force at agent-acts-within-grant', 'wrd.countersign_decision', await countersign(P.bo, d3Iri, 'approve'));
    const underGrant = await runEnvelope('g-001', t1, 'accepted', { underGrant: grantIri });
    const acted = await call('wrd.log_agent_run', { run_envelope: underGrant });
    okStep('25. the agent logs a run under its grant, without review: acted-under-grant, counts toward nothing yet', 'wrd.log_agent_run', acted, () =>
      acted.body['status'] === 'acted-under-grant' && acted.body['countsTowardCalibration'] === false ? null : str(acted.body['status']));
    refusal('R-AT', 'the agent logs a run under its grant that it calls "reworked" itself', 'wrd.log_agent_run',
      await call('wrd.log_agent_run', { run_envelope: await runEnvelope('g-reworked', t1, 'reworked', { underGrant: grantIri }) }), 409, /route it to a person/i);
    clock.advance(3_600_000);
    const later = await call('wrd.log_agent_run', { run_envelope: underGrant, review_envelope: await reviewEnvelope(P.fay, underGrant, 'accepted') });
    okStep('25. an hour later fay reviews it from the stored run envelope', 'wrd.log_agent_run', later, () => (later.body['status'] === 'reviewed' ? null : str(later.body['status'])));
    runIris.push(str(later.body['runIri']));

    // 26–27. Revocation, checked on every use.
    const grantRow = arr((await list({ kind: 'grants' }))['grants']).find((g) => g['grantIri'] === grantIri) ?? {};
    const gh = headOf(grantRow);
    const revoked = await act(P.bo, 'wrd.revoke_grant', { grantIri, recordId: gh.recordId, descriptorUrl: gh.descriptorUrl, graphDigest: gh.graphDigest, why: 'Supplier master data migrated; re-earn on the new data' });
    okStep('26. bo revokes the grant', 'wrd.revoke_grant', revoked, () => (revoked.body['status'] === 'revoked' ? null : 'not revoked'));
    const revokedRow = arr((await list({ kind: 'grants' }))['grants']).find((g) => g['grantIri'] === grantIri) ?? {};
    const rh = obj(revokedRow['head']);
    expect('26. the grant\'s head is Retracted, valid from the grant to the revocation', 'wrd.read_records',
      rh['modalStatus'] === 'Retracted' && rh['validFrom'] === revokedRow['grantedAt'] && rh['validUntil'] === revoked.body['revokedAt'], `${str(rh['validFrom'])} → ${str(rh['validUntil'])}`);
    const t1Suspended = obj((await taskRow(t1))['effective']);
    expect('26. T1, which D3 put under the grant, now shows no authorised performer', 'wrd.read_records',
      t1Suspended['level'] === 'agent-acts-within-grant' && t1Suspended['suspended'] === true && /revoked at/.test(str(t1Suspended['suspendedWhy'])), str(t1Suspended['suspendedWhy']));
    refusal('R-AE', 'the agent logs a run under the revoked grant', 'wrd.log_agent_run', await call('wrd.log_agent_run', { run_envelope: await runEnvelope('g-002', t1, 'accepted', { underGrant: grantIri }) }), 409, /grant is not active: revoked at/);
    refusal('R-AF', 'propose T1 within the revoked grant', 'wrd.propose_allocation', await propose('P3 again', [{ taskIri: t1, proposedLevel: 'agent-acts-within-grant', agentAddress: P.agent.wallet.address }]), 409, /No active grant/);
    refusal('R-AG', 'value P3, which rests on the revoked grant', 'wrd.value_plan', await act(P.ana, 'wrd.value_plan', { planIri: p3Iri, inputs: {} }), 409, /No active grant/);
    refusal('R-AH', 'grant again with no run reviewed since the revocation', 'wrd.grant_autonomy', await grant(P.bo), 409, /0 person-reviewed runs on model scripted-fixture since/);

    // 28. Signatures are identity.
    const genuine = await runEnvelope('r-altered', t1, 'accepted');
    const altered = { payload: { ...genuine.payload, outputSha256: sha256Hex('a different output') }, signature: genuine.signature };
    const recovered = recoverMessageSigner(canonicalJson(altered.payload), altered.signature).toLowerCase();
    const registered = arr(obj((await list({ kind: 'registry' }))['registry'])['members']).map((m) => str(m['address']));
    refusal('R-AI', 'a run envelope altered after the agent signed it', 'wrd.log_agent_run',
      await call('wrd.log_agent_run', { run_envelope: altered, review_envelope: await reviewEnvelope(P.eli, altered, 'accepted') }), 403, /registered software agent/,
      () => (recovered !== addr(P.agent) && !registered.includes(recovered) ? null : 'the altered payload recovered a registered key'));
    const hourAgo = new Date(clock.now().getTime() - 3_600_000).toISOString();
    refusal('R-AJ', 'an envelope issued an hour ago', 'wrd.classify_task',
      await call('wrd.classify_task', { envelope: await envelope(P.ana, 'wrd:classify-task', { taskIri: t1, answers: ANSWERS.evident }, { issuedAt: hourAgo }) }), 401, /stale/);

    // 29. The people described hold their record.
    refusal('R-AK', 'zed, named in nothing and signer of nothing, asks for a copy', 'wrd.holder_copy', await act(P.zed, 'wrd.holder_copy', { targetPodUrl: DEMO_HOLDER_POD }), 403, /names this address or carries its signature/);
    refusal('R-AL', 'cy asks for her copy on the platform pod itself', 'wrd.holder_copy', await act(P.cy, 'wrd.holder_copy', { targetPodUrl: DEMO_POD }), 400, /pod you hold/);
    const copied = await act(P.cy, 'wrd.holder_copy', { targetPodUrl: DEMO_HOLDER_POD });
    const bundle = new Set(arr(copied.body['bundle']).map((b) => `${str(b['recordKind'])}:${str(b['entityIri'])}`));
    // The demo seals its records, so the IRIs it derives are keyed with the record key.
    const classificationIri = (t: string): string => entityIri('classification', wfIri, t, entityIriKey(DEMO_RECORD_KEY));
    const v1Iri = str(v1.body['valuationIri']);
    const want = [
      `Task:${t1}`, `Task:${t3}`, `Workflow:${wfIri}`, `Classification:${classificationIri(t1)}`, `Classification:${classificationIri(t3)}`,
      `Plan:${p1Iri}`, `Plan:${p3Iri}`, `Plan:${p4Iri}`, `Valuation:${v1Iri}`, `Decision:${d1Iri}`, `Decision:${d4Iri}`, ...runIris.map((r) => `AgentRun:${r}`),
    ];
    const notWanted = [`Plan:${p2Iri}`, `Decision:${d2Iri}`, `Task:${t2}`, `Task:${t4}`];
    okStep('29. cy copies every record about her work to her own pod', 'wrd.holder_copy', copied, () => {
      const missing = want.filter((k) => !bundle.has(k));
      const extra = notWanted.filter((k) => bundle.has(k));
      if (missing.length > 0) return `missing ${missing.length}: ${missing.slice(0, 3).join(', ')}`;
      if (extra.length > 0) return `includes ${extra.join(', ')}`;
      return [...bundle].some((k) => k.startsWith('Acknowledgement:')) ? null : 'cy\'s acknowledgement is missing';
    }, () => `${arr(copied.body['copied']).length} versions of ${bundle.size} records; not P2 or D2, which do not change her work`);
    const heldEntries: ManifestEntry[] = (await fetchAllManifestEntries(predictManifestUrl(DEMO_HOLDER_POD), pod.fetchFn)).entries.filter((e) => e.descriptorUrl.startsWith(`${DEMO_HOLDER_POD}${HOLDER_CONTAINER}`));
    const trusted = new Set([addr(P.platform)]);
    let bound = 0;
    for (const e of heldEntries) {
      const rr = await readRecord(e, DEMO_HOLDER_POD, pod.fetchFn, trusted, undefined, HOLDER_CONTAINER);
      if (rr.authorship.signatureValid && rr.authorship.contentBinding === 'bound' && rr.authorship.signerAddress?.toLowerCase() === addr(P.platform)) bound += 1;
    }
    const copiedCount = arr(copied.body['copied']).length;
    expect(`29. all ${heldEntries.length} copies on cy's pod verify, bound, against the platform's original proof`, 'pod read',
      heldEntries.length === copiedCount && copiedCount > 0 && bound === heldEntries.length, `${bound} of ${heldEntries.length} bound; ${copiedCount} copied`);
    const exported = await act(P.eli, 'wrd.holder_copy', {});
    const eliBundle = new Set(arr(exported.body['bundle']).map((b) => `${str(b['recordKind'])}:${str(b['entityIri'])}`));
    okStep('29. eli downloads his record: the decisions he measured and the runs he reviewed', 'wrd.holder_copy', exported, () =>
      exported.body['status'] === 'exported' && eliBundle.has(`Decision:${d1Iri}`) && eliBundle.has(`Decision:${d4Iri}`) && !eliBundle.has(`Decision:${d2Iri}`)
        && eliRuns.every((r) => eliBundle.has(`AgentRun:${r}`)) ? null : 'the export is missing eli\'s records');
    const again = await act(P.cy, 'wrd.holder_copy', { targetPodUrl: DEMO_HOLDER_POD });
    okStep('29. cy asks again: every version is already there', 'wrd.holder_copy', again, () =>
      arr(again.body['copied']).length === copiedCount && arr(again.body['copied']).every((c) => c['skipped'] === true) ? null : 'not idempotent');

    // 30. Tamper with a signed record on the pod. Its graph is sealed, so what someone with write
    // access can change is the ciphertext: it no longer opens, and the head is altered, not skipped.
    const t1Class = obj((await taskRow(t1))['classification']);
    const t1Dist = parseDistributionFromDescriptorTurtle(await (await pod.fetchFn(headOf(t1Class).descriptorUrl)).text());
    const sealedUrl = t1Dist?.accessURL ?? '';
    const ciphertext = str(obj(obj(JSON.parse(pod.bodies.get(sealedUrl) ?? '{}'))['content'])['ciphertext']);
    const flipped = `${ciphertext.slice(0, 8)}${ciphertext.charAt(8) === 'A' ? 'B' : 'A'}${ciphertext.slice(9)}`;
    pod.tamper(sealedUrl, ciphertext, flipped);
    const afterTamper = await list();
    const t1After = arr(afterTamper['tasks']).find((t) => t['taskIri'] === t1) ?? {};
    expect('30. someone with write access edits T1\'s sealed classification on the pod: listed as altered, not trusted', 'wrd.read_records',
      t1Dist?.encrypted === true && strings(afterTamper['altered']).includes(graphIriOf(classificationIri(t1)))
        && obj(t1After['classification'])['trusted'] === false, 'the sealed graph no longer opens');
    refusal('R-AM', 'propose on the workflow whose T1 classification was altered', 'wrd.propose_allocation',
      await propose('after tampering', [{ taskIri: t1, proposedLevel: 'person-with-agent-assist', personAddress: P.cy.wallet.address }]), 409, /altered after signing/);

    // 31. Calibration, every cell labelled scripted.
    const cal = (await call('wrd.read_calibration', { envelope: await readEnvelope() })).body;
    const cells = arr(cal['predictionCells']);
    const agentCells = arr(cal['agentCells']);
    const signals = obj(cal['probeSignals']);
    const pc = cells.find((c) => c['kind'] === 'prediction:weekly-cash-delta:agent-drafts-person-decides:controlled') ?? {};
    const ac = agentCells.find((c) => c['kind'] === 'agent-run:invoice-matching') ?? {};
    const cc = agentCells.find((c) => c['kind'] === 'agent-run:gl-coding') ?? {};
    expect('31. the coding agent\'s cell: its self-assessment agreed with every review, and a person accepted 5% of its work', 'wrd.read_calibration',
      cc['samples'] === 20 && cc['hitRate'] === 1 && cc['acceptedShare'] === 0.05 && obj(cc['grant'])['active'] === false, `agreement ${String(cc['hitRate'])}, accepted ${String(cc['acceptedShare'])}`);
    expect('31. calibration: one prediction (in band, ramp-adjusted), 25 reviewed runs at 0.96, probes kept apart', 'wrd.read_calibration',
      pc['samples'] === 1 && pc['status'] === 'Hypothetical' && pc['rampAdjusted'] === 1 && ac['samples'] === 25 && ac['status'] === 'Asserted' && ac['hitRate'] === 0.96
        && ac['model'] === 'scripted-fixture' && signals['probes'] === 2 && signals['amplify'] === 1 && signals['neither'] === 1,
      `prediction ${String(pc['samples'])} ${String(pc['status'])}; agent ${String(ac['samples'])} at ${String(ac['hitRate'])}; probes ${String(signals['probes'])}`);
    const unlabelledCells = [...cells, ...agentCells].filter((c) => c['scriptedLabel'] !== DEMO_LABEL).length + (Number(signals['probes']) > 0 && signals['scriptedLabel'] !== DEMO_LABEL ? 1 : 0);

    // 32. Every record and row says it is scripted.
    const all = await list();
    records = Number(all['records']);
    const rows = ['workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants'].flatMap((k) => arr(all[k]));
    const registryDescriptor = [...pod.bodies.keys()].find((u) => u.startsWith(`${DEMO_POD}${WRD_CONTAINER}registry-`) && u.endsWith('.ttl')) ?? '';
    const sample = (await podGraph(registryDescriptor)).text;
    // At rest, the pod holds every record graph sealed: no plaintext graph in wrd/records/, and no wrd triple in what it stores there.
    const stored = [...pod.bodies.entries()].filter(([u]) => u.startsWith(`${DEMO_POD}${WRD_CONTAINER}`) && !u.endsWith('.ttl'));
    expect(`32. the pod holds all ${stored.length} graph documents of every record version sealed (*-graph.envelope.jose.json), none in plaintext`, 'pod read',
      stored.length > 0 && stored.every(([u, b]) => u.endsWith('-graph.envelope.jose.json') && !b.includes('wrd:') && !b.includes('payloadJson')),
      `${stored.filter(([u]) => u.endsWith('-graph.envelope.jose.json')).length} sealed of ${stored.length}`);
    marking.records = records;
    marking.demoRecords = Number(all['demoRecords']);
    marking.unlabelledRows = rows.filter((r) => r['demo'] !== true).length;
    marking.unlabelledCells = unlabelledCells;
    marking.sampledGraphHasDemoTriple = sample.includes('wrd:demoRecord "true"^^xsd:boolean');
    expect(`32. ${records} records, all scripted; every row and cell is labelled; a fetched graph carries wrd:demoRecord true`, 'wrd.read_records',
      records > 0 && marking.demoRecords === records && marking.unlabelledRows === 0 && marking.unlabelledCells === 0 && marking.sampledGraphHasDemoTriple,
      ['workflows', 'tasks', 'plans', 'valuations', 'decisions', 'grants'].map((k) => `${arr(all[k]).length} ${k}`).join(', '));
    const missingRefusals = DEMO_REFUSALS.filter((id) => !refusalsObserved.some((r) => r.startsWith(`${id} `)));
    expect('32. every refusal R-A … R-AV was observed with its status', '—', missingRefusals.length === 0, missingRefusals.length === 0 ? `${refusalsObserved.length} refusals` : `missing ${missingRefusals.join(', ')}`);
  } catch (e) {
    record('the walk stopped', '—', 0, 0, false, e instanceof Error ? e.message : String(e));
  }

  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  if (opts.writeReport) {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const dir = `${root}demos/output`;
    mkdirSync(dir, { recursive: true });
    reportPath = `${dir}/wrd-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    writeFileSync(reportPath, renderReport({ ok, steps, refusalsObserved, records, base, marking, took }), 'utf8');
  }
  say(`\n${ok ? 'OK' : 'FAILED'}: ${steps.filter((s) => s.ok).length} of ${steps.length} steps, ${refusalsObserved.length} refusals observed, ${records} records, ${took}s${reportPath ? `\nreport: ${reportPath}` : ''}\n`);
  if (opts.serve) {
    say(`\nThe bridge and its web UI stay up: ${base}/ui (the personas' keys are held by this process; every record says it is scripted). Ctrl-C to stop.\n`);
  } else {
    await close();
  }
  return { ok, steps, refusalsObserved, records, base: opts.serve ? base : null, reportPath, demoMarking: marking };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
function renderReport(r: { ok: boolean; steps: readonly DemoStep[]; refusalsObserved: readonly string[]; records: number; base: string; marking: DemoReport['demoMarking']; took: string }): string {
  return [
    '# work-redesign offline demo',
    '',
    `Result: **${r.ok ? 'every step passed' : 'FAILED'}** — ${r.steps.filter((s) => s.ok).length} of ${r.steps.length} steps; ${r.refusalsObserved.length} refusals observed; ${r.records} records on the in-memory pod; ${r.took}s.`,
    '',
    `Everything below was ${DEMO_LABEL}: persona keys derived from published seeds and held by the demo process, a scripted draft standing in for the client's agent, scripted agent runs (outputs are digests of fixed strings; self-assessments chosen by the walk), one measured outcome computed from the prediction itself (P50 × ramp factor, so in band by construction), and a clock moved by the walk. The bridge, signatures, policy, engines and pod read-back are the real code.`,
    '',
    '| # | Step | Tool | Expected | Got | Note |',
    '|---|---|---|---|---|---|',
    ...r.steps.map((s, i) => `| ${i + 1} | ${s.ok ? '' : '**FAIL** '}${cell(s.step)} | \`${s.tool}\` | ${s.expect} | ${s.got} | ${cell(s.note)} |`),
    '',
    '## Refusals observed',
    '',
    r.refusalsObserved.join(', '),
    '',
    '## Demo marking (read back from the bridge)',
    '',
    `records ${r.marking.records}, demo records ${r.marking.demoRecords}, unlabelled rows ${r.marking.unlabelledRows}, unlabelled calibration cells ${r.marking.unlabelledCells}, sampled graph carries wrd:demoRecord true: ${String(r.marking.sampledGraphHasDemoTriple)}`,
    '',
  ].join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.slice('--port='.length)) : undefined;
  runDemo({ serve: args.includes('--serve'), writeReport: true, quiet: args.includes('--quiet'), ...(port !== undefined && Number.isInteger(port) ? { port } : {}) })
    .then((r) => { if (!r.ok) process.exitCode = 1; })
    .catch((e: unknown) => { process.stderr.write(`work-redesign demo: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
}
