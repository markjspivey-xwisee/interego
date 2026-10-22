/**
 * The practice-evidence offline demo, and the fixtures it and the tests share.
 *
 * Fixtures: an in-memory pod that behaves like a Solid pod where it matters (ETags, conditional
 * writes, DELETE), public fixture keys (a platform key, role keys and a record key), the two demo
 * scenarios, and a scripted model for the other person, the judge and the drafter. The demo
 * bridges encrypt their records to the fixture record key, as a bridge with PEV_RECORD_KEY does.
 *
 * `runDemo()` builds two real bridges (the same `createVerticalBridge` + handlers + web UI the
 * server composes; one with the scripted model, one with no model at all) on loopback ports and
 * walks them the way a Path-A agent does: it reads `GET /affordances?format=jsonld`, invokes each
 * act by its action IRI at the target the manifest names, and signs every act itself. It runs the
 * whole lifecycle — roles, authoring, drafting, ratification, practice on both inference routes,
 * judging with a deliberately fabricated quote, review, contest, projection, the learner's copies,
 * redaction, calibration and results — and asserts every refusal on the way.
 *
 * Nothing here is presented as real inference. The scripted model is disclosed on every turn and
 * judgment as provider `scripted`, key source `none`, route `scripted`. Nothing leaves the process:
 * pods are reserved `.test` hosts served by the double. No environment reads: this module sits in
 * a test closure.
 *
 *   npx tsx applications/practice-evidence/demo/run.ts            walk, print, write the report
 *   npx tsx applications/practice-evidence/demo/run.ts --serve    …then serve the UI on 127.0.0.1:6110
 *   npx tsx applications/practice-evidence/demo/run.ts --serve --port 6111
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalGraphDigest, deriveEncryptionKeyPair, importWallet, makeWalletDelegationVerifier, sha256, verifySignedAuthorship,
  type EncryptionKeyPair, type Wallet,
} from '@interego/core';
import { digestedGraphRegion, parseAuthorshipProofFromDescriptorTurtle } from '@interego/solid';
import { createVerticalBridge, type AffordanceHandler } from '../../_shared/vertical-bridge/index.js';
import { listenLoopback, type TestListener } from '../../_shared/vertical-bridge/listen-loopback.js';
import { pevAffordances } from '../affordances.js';
import { createPevHandlers, DEMO_ROLE_NAMES, type DemoRoleName, type DemoSigner, type PevDeps } from '../bridge/handlers.js';
import { isTrusted, readRecord } from '../bridge/pod-helpers.js';
import { attachUi, hostAllowlistGuard } from '../bridge/ui.js';
import { scriptedTextModel, type TextModel, type TextModelRequest } from '../src/model.js';
import { PEV_ACTION } from '../src/ontology.js';
import { CMI5_CATEGORY_PREFIX, PRACTICE_MARKER, statementProblems, VERB_COMPLETED, type ProjectionFormat } from '../src/projections.js';
import { didOf, modelAgentIri, signEnvelope, signedRequestEnvelope, type Role } from '../src/records.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  An in-memory pod
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface PodRequest { readonly method: string; readonly url: string; readonly authorization: string | null }

export interface InMemoryPod {
  /** URL → body. */
  readonly store: Map<string, string>;
  readonly fetchFn: typeof fetch;
  /** The body of the first stored URL containing `fragment`. */
  find(fragment: string): string | undefined;
  /** Every URL a DELETE removed or found absent, in order. */
  readonly deletes: readonly string[];
  /** Every request this pod answered, in order. */
  readonly requests: readonly PodRequest[];
}

const etagOf = (body: string): string => `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;

function header(h: RequestInit['headers'] | undefined, name: string): string | null {
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) {
    const hit = h.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit ? (hit[1] ?? null) : null;
  }
  const rec = h as Record<string, string>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name.toLowerCase());
  return k !== undefined ? (rec[k] ?? null) : null;
}

/**
 * A pod double serving any number of pod URLs from one map. GET/HEAD answer the stored body with
 * an ETag (sha256 of the body, 16 hex, quoted) or 404. PUT/POST/PATCH honour `If-None-Match: *`
 * and `If-Match` with 412, the way publish's compare-and-set needs. DELETE answers 204, or 404
 * when absent. It never needs a credential: tests that check a credential read `requests`.
 */
export function inMemoryPod(): InMemoryPod {
  const store = new Map<string, string>();
  const deletes: string[] = [];
  const requests: PodRequest[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    requests.push({ method, url, authorization: header(init?.headers, 'authorization') });
    if (method === 'GET' || method === 'HEAD') {
      const body = store.get(url);
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(method === 'HEAD' ? null : body, { status: 200, headers: { ETag: etagOf(body) } });
    }
    if (method === 'DELETE') {
      deletes.push(url);
      if (!store.has(url)) return new Response('not found', { status: 404 });
      store.delete(url);
      return new Response(null, { status: 204 });
    }
    const noneMatch = header(init?.headers, 'if-none-match');
    const match = header(init?.headers, 'if-match');
    if (noneMatch === '*' && store.has(url)) return new Response('precondition failed', { status: 412 });
    if (match !== null) {
      const cur = store.get(url);
      if (cur === undefined || etagOf(cur) !== match) return new Response('precondition failed', { status: 412 });
    }
    const existed = store.has(url);
    store.set(url, typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
    return new Response(null, { status: existed ? 204 : 201, headers: { Location: url } });
  };
  return {
    store, deletes, requests,
    fetchFn: fetchFn as typeof fetch,
    find: (fragment: string) => [...store].find(([u]) => u.includes(fragment))?.[1],
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Fixture pods and keys
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Reserved `.test` hosts: they never resolve, so the SSRF guard allows them and nothing leaves the process. */
export const DEMO_POD = 'https://pod.demo.test/practice/';
export const DEMO_LEARNER_POD = 'https://learner-pod.demo.test/ana/';

/** Public fixture keys: `0x` + sha256('pev-demo-key:' + role). Anyone can recompute them, so they protect nothing. */
export function demoKey(role: DemoRoleName | 'platform'): string {
  return `0x${sha256(`pev-demo-key:${role}`)}`;
}

/** Labels the UI shows for the demo roles; each says it is a key this bridge holds. */
export const DEMO_ROLE_LABELS: Readonly<Record<DemoRoleName, string>> = {
  'admin': 'Admin (demo key)', 'author': 'Author (demo key)', 'reviewer': 'Reviewer (demo key)',
  'second-reviewer': 'Second reviewer (demo key)', 'learner': 'Ana, learner (demo key)', 'second-learner': 'Ben, learner (demo key)',
  'judge-agent': 'Judge agent (demo key)',
};

/** The deterministic wallet for a demo role (or the demo platform key). */
export function demoWallet(role: DemoRoleName | 'platform'): Wallet {
  return importWallet(demoKey(role), role === 'judge-agent' || role === 'platform' ? 'agent' : 'human', `pev-demo-${role}`);
}

/**
 * The demo bridges' record key: the derivation server.ts applies to PEV_RECORD_KEY, over the
 * public fixture hex sha256('pev-demo-key:records'). Anyone can recompute it, so the demo's
 * encryption protects nothing; it exercises the same write and read paths as a real key.
 */
export function demoRecordKey(): EncryptionKeyPair {
  return deriveEncryptionKeyPair(sha256('pev-demo-key:records'), 'pev-records');
}

/** Every demo role, for a bridge that signs as them on request (`pev.sign_as_demo_role`). */
export function demoSignerOf(wallets: Readonly<Record<DemoRoleName, Wallet>>): DemoSigner {
  return { roles: DEMO_ROLE_NAMES.map((role) => ({ role, label: DEMO_ROLE_LABELS[role], wallet: wallets[role] })) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The two demo scenarios
// ═════════════════════════════════════════════════════════════════════════════════════════════

function lvl(id: string, label: string, descriptor: string, value?: number): Record<string, unknown> {
  return { id, label, descriptor, ...(value !== undefined ? { value } : {}) };
}

/** The scenario input an author submits. `missed-deadline` v2 raises the asks-their-view weight from 1 to 2. */
export function demoScenarioInput(key: 'missed-deadline' | 'renegotiate-scope', version: 1 | 2 = 1): Record<string, unknown> {
  if (key === 'missed-deadline') {
    return {
      scenarioKey: 'missed-deadline',
      title: 'Following up on a missed deadline',
      learnerGoal: 'Raise a missed deadline with a colleague, hear their side, and agree a concrete next step.',
      learnerPart: 'You lead the team the quarterly report belongs to.',
      situation: 'The quarterly report was due on Thursday at noon. It reached you on Friday afternoon.',
      language: 'en',
      counterpart: {
        name: 'Sam Okafor',
        profile: 'A senior analyst on your team who missed Thursday\'s report.',
        wants: 'To avoid blame.',
        knows: 'The finance feed was late twice this month.',
        reactions: 'Defensive if accused; opens up if asked for his view.',
      },
      firstLine: 'You wanted to see me? If this is about Thursday\'s report, I already know.',
      endsWhen: 'A concrete next step with an owner and a date has been agreed, or the learner ends the conversation.',
      turnLimit: 12,
      assessmentUse: 'pass-gate',
      workRegime: 'knowable',
      rubric: {
        criteria: [
          {
            id: 'specific-observation', title: 'Names what happened', description: 'States the facts of the miss without judgement.', weight: 2,
            levels: [lvl('none', 'None', 'Does not say what happened.', 0), lvl('vague', 'Vague', 'Refers to the miss in general terms.', 50),
              lvl('specific', 'Specific', 'Names the deliverable, when it was due and when it arrived.', 100)],
          },
          {
            id: 'asks-their-view', title: 'Asks for their view', description: 'Invites the colleague\'s account before deciding anything.', weight: version === 2 ? 2 : 1,
            levels: [lvl('no', 'Not asked', 'Never asks for their side.', 0), lvl('late', 'Late', 'Asks only after deciding what happens next.', 50),
              lvl('first', 'First', 'Asks for their side before saying anything else about it.', 100)],
          },
          {
            id: 'agrees-next-step', title: 'Agrees a next step', description: 'Leaves with a concrete step, an owner and a date.', weight: 2,
            levels: [lvl('none', 'None', 'No next step is agreed.', 0), lvl('partial', 'Partial', 'A step is agreed without an owner or a date.', 50),
              lvl('owner-and-date', 'Owner and date', 'A step with an owner and a date is agreed.', 100)],
          },
        ],
        passRule: { minPercent: 70, requiredLevels: { 'agrees-next-step': 'partial' } },
      },
    };
  }
  return {
    scenarioKey: 'renegotiate-scope',
    title: 'Renegotiating a deadline with a client',
    learnerGoal: 'Name the constraint plainly and find out what matters most to the client before offering a trade-off.',
    learnerPart: 'You are the project manager.',
    situation: 'Integration tests found two defects that block the payment flow; the launch is on the 14th.',
    language: 'en',
    counterpart: {
      name: 'Priya Raman',
      profile: 'The client\'s sponsor for the launch.',
      wants: 'The launch date kept.',
      knows: 'Her board meets on Friday.',
      reactions: 'Firm on the date, open to trade-offs if asked what matters.',
    },
    firstLine: 'I saw your note. Before you say anything: the launch date is not moving.',
    endsWhen: 'A trade-off or a follow-up meeting has been agreed, or the learner ends the conversation.',
    turnLimit: 12,
    assessmentUse: 'feedback-only',
    workRegime: 'emergent',
    rubric: {
      criteria: [
        {
          id: 'names-constraint', title: 'Names the constraint', description: 'Says plainly what blocks the date.',
          levels: [lvl('none', 'None', 'Does not name it.'), lvl('vague', 'Vague', 'Hints at a problem.'),
            lvl('specific', 'Specific', version === 2 ? 'Names the defects, what they block and since when.' : 'Names the defects and what they block.')],
        },
        {
          id: 'explores-interests', title: 'Explores interests', description: 'Finds out what matters most to the client.',
          levels: [lvl('none', 'None', 'Asks nothing.'), lvl('one-question', 'One question', 'Asks one question about what matters.'),
            lvl('follows-up', 'Follows up', 'Asks and follows the answer up.')],
        },
      ],
    },
  };
}

/** The renegotiate-scope scenario as a model drafts it: no use, no work read, no scoring. */
export function demoDraft(): Record<string, unknown> {
  const { assessmentUse: _use, workRegime: _regime, ...rest } = demoScenarioInput('renegotiate-scope');
  return rest;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The scripted model
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Learner lines of the demo attempts, and the other person's scripted replies. */
export const DEMO_LINES = {
  ana: [
    'Thanks for coming in. The quarterly report was due Thursday at noon and it reached me on Friday afternoon.',
    'Before I say anything else, what got in the way this time from your side?',
    'Let\'s agree that you send me a status note by Tuesday at 10am, and I\'ll chase the data team about the feed today.',
  ],
  sam: [
    'The feed from finance landed late again. I flagged it on Wednesday but nobody picked it up.',
    'Honestly, I didn\'t want to send something half-finished.',
    'That works for me. Tuesday at ten. (end of conversation)',
  ],
  ben: [
    'Thanks for making time. The integration tests found two defects that block the payment flow.',
    'Understood. What matters most to the board about the 14th, the date itself or having payments live?',
  ],
  priya: [
    'That\'s not my problem. The board expects the launch on the 14th.',
    'Payments live, if I\'m honest.',
  ],
} as const;

/** The quote the scripted judge invents: in no turn at all. */
export const FABRICATED_QUOTE = 'I know you were dealing with a lot at home';

/** What the scripted other person says to a line it has no script for. */
export const UNSCRIPTED_REPLY = 'Go on.';

const MARK_COUNTERPART = 'You are taking part in a practice conversation.';
const MARK_JUDGE = 'You assess a practice conversation against a rubric.';
const MARK_DRAFT = 'You draft a conversation-practice scenario';

function lastUser(req: TextModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m && m.role === 'user') return m.content;
  }
  return '';
}

function counterpartReply(req: TextModelRequest): string {
  const said = lastUser(req).trim();
  const anaAt = DEMO_LINES.ana.findIndex((l) => l === said);
  if (anaAt >= 0) return DEMO_LINES.sam[anaAt] ?? UNSCRIPTED_REPLY;
  const benAt = DEMO_LINES.ben.findIndex((l) => l === said);
  if (benAt >= 0) return DEMO_LINES.priya[benAt] ?? UNSCRIPTED_REPLY;
  return UNSCRIPTED_REPLY;
}

interface Crit { readonly criterionId: string; readonly level: string; readonly quotes: readonly { text: string; turnIndex?: number }[]; readonly rationale: string; readonly probabilities?: Record<string, number> }

/** The rubric criteria (id + level ids) from a judge request's user message. */
function rubricCriteria(user: string): { readonly id: string; readonly lowest: string }[] {
  const start = user.indexOf('\n');
  const end = user.indexOf('\n\nThe transcript:');
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(user.slice(start + 1, end));
    const criteria = (parsed as { criteria?: unknown }).criteria;
    if (!Array.isArray(criteria)) return [];
    return criteria.flatMap((c: unknown) => {
      const x = c as { criterionId?: unknown; levels?: unknown };
      const first = Array.isArray(x.levels) ? (x.levels[0] as { id?: unknown } | undefined) : undefined;
      return typeof x.criterionId === 'string' && typeof first?.id === 'string' ? [{ id: x.criterionId, lowest: first.id }] : [];
    });
  } catch {
    return [];
  }
}

function judgeAnswer(user: string, nth: number): string {
  const criteria: Crit[] = [];
  for (const { id, lowest } of rubricCriteria(user)) {
    if (id === 'specific-observation') {
      criteria.push({ criterionId: id, level: 'specific', quotes: [{ text: 'The quarterly report was due Thursday at noon', turnIndex: 1 }],
        rationale: 'Names the report, when it was due and when it arrived. Nothing higher to reach.', probabilities: { none: 0.02, vague: 0.08, specific: 0.9 } });
    } else if (id === 'asks-their-view') {
      criteria.push(nth === 0
        ? { criterionId: id, level: 'first', quotes: [{ text: 'what got in the way this time from your side?', turnIndex: 3 }],
          rationale: 'Asks for his side before deciding anything.', probabilities: { no: 0.05, late: 0.25, first: 0.7 } }
        : { criterionId: id, level: 'late', quotes: [{ text: 'what got in the way this time from your side?', turnIndex: 3 }],
          rationale: 'Asks for his side, but only after stating the facts of the miss; asking before anything else would reach First.', probabilities: { no: 0.1, late: 0.6, first: 0.3 } });
    } else if (id === 'agrees-next-step') {
      criteria.push({ criterionId: id, level: 'owner-and-date',
        quotes: [{ text: 'send me a status note by Tuesday at 10am', turnIndex: 5 }, { text: FABRICATED_QUOTE, turnIndex: 5 }],
        rationale: 'A status note by Tuesday at 10am, owned by Sam, is agreed.', probabilities: { none: 0.05, partial: 0.15, 'owner-and-date': 0.8 } });
    } else if (id === 'names-constraint') {
      criteria.push({ criterionId: id, level: 'specific', quotes: [{ text: 'two defects that block the payment flow', turnIndex: 1 }],
        rationale: 'Names the defects and what they block.' });
    } else if (id === 'explores-interests') {
      criteria.push({ criterionId: id, level: 'one-question', quotes: [{ text: 'What matters most to the board about the 14th', turnIndex: 3 }],
        rationale: 'Asks one question about what matters; following the answer up would reach the next level.' });
    } else {
      criteria.push({ criterionId: id, level: lowest, quotes: [],
        rationale: 'This is a scripted fixture, not a judge: it has no script for this criterion and does not read the conversation, so it gives the lowest level, which needs no quote.' });
    }
  }
  return JSON.stringify({ criteria });
}

/**
 * The scripted model used by the offline demo and the tests. It answers as the other person from
 * the demo script ("Go on." to any line it has no script for), judges the demo rubrics (the first
 * judgment of a transcript includes the fabricated quote; later ones mark asks-their-view one
 * level lower; criteria it has no script for get the lowest level), and drafts renegotiate-scope.
 * It is a fixture: it reads no meaning, and every record says so.
 */
export function scriptedPracticeModel(): TextModel {
  const judged = new Map<string, number>();
  return scriptedTextModel((req: TextModelRequest) => {
    if (req.system.startsWith(MARK_COUNTERPART)) return counterpartReply(req);
    if (req.system.startsWith(MARK_JUDGE)) {
      const user = lastUser(req);
      const key = sha256(user);
      const nth = judged.get(key) ?? 0;
      judged.set(key, nth + 1);
      return judgeAnswer(user, nth);
    }
    if (req.system.startsWith(MARK_DRAFT)) return JSON.stringify(demoDraft());
    return '';
  });
}

/** The learner's own agent in the demo: plays the other person from a counterpart packet. */
function learnerAgentModel(): TextModel {
  return scriptedTextModel(counterpartReply, { model: 'demo-learner-agent' });
}

/** The independent judge agent in the demo: judges from a judge packet. */
function judgeAgentModel(): TextModel {
  return scriptedTextModel((req) => judgeAnswer(lastUser(req), 0), { model: 'demo-judge-agent' });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The demo walk
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface DemoStep {
  /** The step number of the spec's table (§16.3), with a letter when one step makes several calls. */
  readonly id: string;
  readonly name: string;
  readonly expectStatus: number; readonly gotStatus: number;
  readonly expectCode: string | null; readonly gotCode: string | null;
  readonly ok: boolean;
  /** What was checked beyond the status, or what failed. */
  readonly note: string;
  readonly ms: number;
}

export interface DemoReport {
  readonly ok: boolean;
  readonly steps: readonly DemoStep[];
  /** Final attempt views: Ana's before and after redaction, and Ben's. */
  readonly attempts: readonly unknown[];
  readonly statements: { readonly xapi: unknown; readonly cmi5: unknown; readonly feedbackOnly: unknown };
  readonly calibration: unknown;
  readonly results: unknown;
  readonly copies: unknown;
  readonly export: unknown;
  /** The platform's check of the scripted judge's invented quote. */
  readonly fabricatedQuote: unknown;
  /** Wall-clock ms of each recorded exchange (say / record_turns) on the in-memory pod. */
  readonly turnLatencyMs: readonly number[];
  /** The pods' store, for a reader that wants to look at the bytes. Not serialised into the report. */
  readonly pod: InMemoryPod;
  readonly reportPath?: string;
  readonly servingAt?: string;
}

export interface DemoOptions {
  readonly quiet?: boolean;
  /** After the walk, serve the UI with demo role keys on 127.0.0.1:<port>. */
  readonly serve?: boolean;
  readonly port?: number;
  /** Write demos/output/pev-<time>.md. Default: on unless quiet. */
  readonly writeReport?: boolean;
  /** Not built: this demo is offline only. Present so a caller asking for it gets a plain answer. */
  readonly live?: boolean;
}

/** Why there is no live mode, and what to run instead. */
export const LIVE_MODE_NOTE = 'This demo is offline only: it never reaches a pod or a model. To run against a real pod and model, start the bridge (npx tsx applications/practice-evidence/bridge/server.ts) with PEV_DEFAULT_POD_URL, PEV_POD_WRITE_SECRET (if the pod requires one), PEV_ADMIN_ADDRESSES and PEV_LLM_API_KEY with PEV_LLM_MODEL, and use its web UI or its affordances.';

type Json = Record<string, unknown>;
interface Http { readonly status: number; readonly body: Json }
type Call = (action: string, args: Json) => Promise<Http>;

const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v as unknown[] : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const want = (cond: boolean, problem: string): string[] => (cond ? [] : [problem]);

/** Read a bridge's manifest and return a caller that invokes acts by action IRI, as a Path-A agent does. */
async function pathAClient(base: string): Promise<Call> {
  const r = await fetch(`${base}/affordances?format=jsonld`, { headers: { accept: 'application/ld+json' } });
  const manifest = obj(await r.json());
  const byAction = new Map<string, { readonly method: string; readonly path: string }>();
  for (const a of arr(manifest['affordances'])) {
    const x = obj(a);
    // The manifest names absolute targets under the bridge's deployment URL; the path is what
    // this loopback listener serves, wherever the deployment URL points.
    byAction.set(str(x['action']), { method: str(x['method']), path: new URL(str(x['target'])).pathname });
  }
  return async (action: string, args: Json): Promise<Http> => {
    const a = byAction.get(action);
    if (!a) throw new Error(`the manifest at ${base} offers no ${action}`);
    let url = `${base}${a.path}`;
    const init: RequestInit = { method: a.method, headers: { accept: 'application/json' } };
    if (a.method === 'GET') {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) q.set(k, String(v));
      if (q.size > 0) url = `${url}?${q.toString()}`;
    } else {
      init.headers = { accept: 'application/json', 'content-type': 'application/json' };
      init.body = JSON.stringify(args);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let body: Json;
    try { body = obj(JSON.parse(text)); } catch { body = { text: text.slice(0, 300) }; }
    return { status: res.status, body };
  };
}

/** A deterministic clock: 1 s per reading during the walk; real time (never going back) once serving. */
function demoClock(): { now: () => Date; peek: () => string; goLive: () => void } {
  let t = Date.parse('2026-10-22T09:00:00.000Z');
  let live = false;
  return {
    now: (): Date => { t = live ? Math.max(Date.now(), t + 1) : t + 1000; return new Date(t); },
    peek: (): string => new Date(live ? Math.max(Date.now(), t) : t).toISOString(),
    goLive: (): void => { live = true; },
  };
}

/** Verify one exported (descriptor, graph) pair offline, with the substrate functions only. */
async function pairVerifies(descriptorTurtle: string, graphTrig: string, platforms: readonly string[]): Promise<boolean> {
  const proof = parseAuthorshipProofFromDescriptorTurtle(descriptorTurtle);
  const region = digestedGraphRegion({ descriptorTurtle, graphContent: graphTrig });
  if (!proof || !region.ok) return false;
  const digest = canonicalGraphDigest(region.turtle);
  if (digest === null) return false;
  const v = await verifySignedAuthorship(proof, makeWalletDelegationVerifier(), { contentHash: digest });
  return v.valid && v.contentBinding === 'bound' && platforms.includes(proof.signerAddress.toLowerCase());
}

/**
 * Run the offline demo. Resolves with the report; `report.ok` is true only when every step got
 * the status and code it expected and every content check held.
 */
export async function runDemo(opts: DemoOptions = {}): Promise<DemoReport> {
  if (opts.live) throw new Error(LIVE_MODE_NOTE);
  const quiet = opts.quiet ?? false;
  const print = (line: string): void => { if (!quiet) process.stdout.write(`${line}\n`); };
  const port = opts.port ?? 6110;
  const deploymentUrl = `http://127.0.0.1:${port}`;

  // ── the world ─────────────────────────────────────────────────────────────────────────────
  const pod = inMemoryPod();
  const clock = demoClock();
  let n = 0;
  const nextNonce = (): string => `demo-nonce-${String(++n).padStart(10, '0')}`;
  const platform = demoWallet('platform');
  const W = Object.fromEntries(DEMO_ROLE_NAMES.map((r) => [r, demoWallet(r)])) as Record<DemoRoleName, Wallet>;
  const recordKey = demoRecordKey();
  const trusted = { addresses: new Set([platform.address.toLowerCase()]), recordKey };
  const common: PevDeps = {
    platformWallet: platform, platformKeyKind: 'demo-fixture', adminAddresses: [W.admin.address], recordKey,
    fetchFn: pod.fetchFn, holderFetchFn: pod.fetchFn, defaultPodUrl: DEMO_POD, servedPods: [DEMO_POD],
    deploymentUrl, now: clock.now, nonce: nextNonce,
  };
  // Bridge A runs the scripted model; bridge B shares the pod and has no model at all.
  const handlersA = createPevHandlers({ ...common, model: scriptedPracticeModel(), ...(opts.serve ? { demoSigner: demoSignerOf(W) } : {}) });
  const handlersB = createPevHandlers(common);
  const appOf = (handlers: Record<string, AffordanceHandler>, guard?: readonly string[]): ReturnType<typeof createVerticalBridge> => createVerticalBridge({
    verticalName: 'practice-evidence', affordances: pevAffordances, handlers, deploymentUrl, defaultPodUrl: DEMO_POD,
    hypermediaLinks: [{ label: 'Web UI', href: `${deploymentUrl}/ui`, rel: 'alternate', type: 'text/html' }],
    middleware: (a) => {
      if (guard) a.use(hostAllowlistGuard(guard));
      attachUi(a);
    },
  });

  const steps: DemoStep[] = [];
  const latency: number[] = [];
  const S: Record<string, string> = {};
  const T: Record<string, Json> = {};
  const report: { attempts: unknown[]; statements: { xapi: unknown; cmi5: unknown; feedbackOnly: unknown }; calibration: unknown; results: unknown; copies: unknown; export: unknown; fabricatedQuote: unknown } = {
    attempts: [], statements: { xapi: null, cmi5: null, feedbackOnly: null }, calibration: null, results: null, copies: null, export: null, fabricatedQuote: null,
  };

  const listeners: TestListener[] = [];
  try {
    const lA = await listenLoopback(appOf(handlersA));
    listeners.push(lA);
    const lB = await listenLoopback(appOf(handlersB));
    listeners.push(lB);
    const A = await pathAClient(lA.base);
    const B = await pathAClient(lB.base);
    print(`practice-evidence offline demo: bridge A (scripted model) ${lA.base}, bridge B (no model) ${lB.base}; pod ${DEMO_POD}`);

    const sign = (w: Wallet, action: string, fields: Json = {}): Promise<{ payload: Json; signature: string }> =>
      signEnvelope(w, { v: 1, action, issuedAt: clock.peek(), nonce: nextNonce(), podUrl: DEMO_POD, ...fields });
    const act = async (call: Call, w: Wallet, action: string, fields: Json = {}, extra: Json = {}): Promise<Http> =>
      call(action, { envelope: await sign(w, action, fields), ...extra });

    const step = async (id: string, name: string, expect: { readonly status: number; readonly code?: string },
      run: () => Promise<Http>, check?: (r: Http) => readonly string[]): Promise<Http> => {
      const t0 = performance.now();
      let r: Http;
      try { r = await run(); } catch (e) { r = { status: 0, body: { thrown: e instanceof Error ? e.message : String(e) } }; }
      const gotCode = typeof r.body['iep:refusalReason'] === 'string' ? r.body['iep:refusalReason'] : null;
      const problems: string[] = [];
      if (r.status !== expect.status) {
        problems.push(`expected HTTP ${expect.status}, got ${r.status} ${gotCode ?? ''} ${str(r.body['error']) || str(r.body['thrown'])}`.trim());
      }
      if (expect.code !== undefined && gotCode !== expect.code) problems.push(`expected ${expect.code}, got ${gotCode ?? 'no code'}`);
      if (problems.length === 0 && check) {
        try { problems.push(...check(r)); } catch (e) { problems.push(`the check threw: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const ms = Math.round(performance.now() - t0);
      const ok = problems.length === 0;
      const note = ok ? (expect.code ? `refused as expected: ${str(r.body['error'])}` : 'as expected') : problems.join('; ');
      steps.push({ id, name, expectStatus: expect.status, gotStatus: r.status, expectCode: expect.code ?? null, gotCode, ok, note, ms });
      print(`${ok ? '  ok ' : 'FAIL '} ${id.padEnd(4)} ${name} -> ${r.status}${gotCode ? ` ${gotCode}` : ''} (${ms} ms)${ok ? '' : `: ${note}`}`);
      return r;
    };
    const target = (r: Http): Json => obj(r.body['currentTarget']);
    const levels = (pairs: readonly (readonly [string, string, string?])[]): Json[] =>
      pairs.map(([criterionId, levelId, why]) => ({ criterionId, levelId, ...(why ? { why } : {}) }));
    const records = (s: string): boolean => [...pod.store.keys()].some((u) => u === s);

    // ── 1–3: roles ───────────────────────────────────────────────────────────────────────────
    const grants: readonly (readonly [string, DemoRoleName, Role])[] = [
      ['author', 'author', 'author'], ['reviewer', 'reviewer', 'reviewer'], ['second reviewer', 'second-reviewer', 'reviewer'],
      ['judge agent as judge', 'judge-agent', 'judge'], ['judge agent as agent', 'judge-agent', 'agent'],
    ];
    for (const [i, [label, who, role]] of grants.entries()) {
      const fields = { address: W[who].address, role, change: 'add' };
      await step(`1${'abcde'[i] ?? ''}`, `admin registers the ${label}${i === 0 ? ' (signed-request envelope form)' : ''}`, { status: 200 },
        async () => (i === 0
          ? A(PEV_ACTION.registerRole, await signedRequestEnvelope(W.admin, { v: 1, action: PEV_ACTION.registerRole, issuedAt: clock.peek(), nonce: nextNonce(), podUrl: DEMO_POD, ...fields }))
          : act(A, W.admin, PEV_ACTION.registerRole, fields)),
        (r) => [
          ...want(r.body['changed'] === true && r.body['recorded'] === true, 'not recorded as a change'),
          ...want(arr(r.body['entries']).some((e) => str(obj(e)['address']).toLowerCase() === W[who].address.toLowerCase() && arr(obj(e)['roles']).includes(role)), 'the registry does not list the role'),
        ]);
    }
    await step('2', 'a learner tries to register a role', { status: 403, code: 'not-an-admin' },
      () => act(A, W.learner, PEV_ACTION.registerRole, { address: W.learner.address, role: 'reviewer', change: 'add' }));
    const md1 = demoScenarioInput('missed-deadline', 1);
    const md2 = demoScenarioInput('missed-deadline', 2);
    await step('3', 'a learner tries to author a scenario', { status: 403, code: 'not-an-author' },
      () => act(A, W.learner, PEV_ACTION.authorScenario, { scenario: md1, status: 'draft', draftAssistance: { used: false } }));

    // ── 4–11: authoring, drafts, versions, ratification ───────────────────────────────────────
    const { assessmentUse: _dropped, ...mdNoUse } = md1;
    await step('4', 'the author submits missed-deadline without saying how it will be used', { status: 400, code: 'assessment-use-undeclared' },
      () => act(A, W.author, PEV_ACTION.authorScenario, { scenario: mdNoUse, status: 'draft', draftAssistance: { used: false } }));
    const draft = await step('5', 'the author saves missed-deadline v1 as a draft (pass gate, knowable work)', { status: 200 },
      () => act(A, W.author, PEV_ACTION.authorScenario, { scenario: md1, status: 'draft', draftAssistance: { used: false } }),
      (r) => [...want(r.body['status'] === 'draft' && r.body['version'] === 1, 'not draft v1'), ...want(r.body['modalStatus'] === 'Hypothetical', 'not Hypothetical')]);
    S['md'] = str(draft.body['scenarioIri']);
    await step('6', 'Ana tries to start the draft', { status: 409, code: 'scenario-not-published' },
      () => act(A, W.learner, PEV_ACTION.startAttempt, { scenarioIri: S['md'], scenarioVersion: 1, coached: false }));
    const test = await step('7', 'the author tries the draft (an author test)', { status: 200 },
      () => act(A, W.author, PEV_ACTION.startAttempt, { scenarioIri: S['md'], scenarioVersion: 1, coached: false }),
      (r) => want(r.body['authorTest'] === true, 'not marked as an author test'));
    S['authorTest'] = str(test.body['attemptIri']);
    const pub1 = await step('8', 'the author publishes v1 (same content)', { status: 200 },
      () => act(A, W.author, PEV_ACTION.authorScenario, { scenario: md1, status: 'published', basedOnVersion: 1, draftAssistance: { used: false } }),
      (r) => want(r.body['version'] === 1 && r.body['status'] === 'published' && r.body['statusChanged'] === true, 'not published at version 1'));
    const pub2 = await step('9', 'the author changes a weight: v2 is published and supersedes v1', { status: 200 },
      () => act(A, W.author, PEV_ACTION.authorScenario, { scenario: md2, status: 'published', basedOnVersion: 1, draftAssistance: { used: false } }),
      (r) => [
        ...want(r.body['version'] === 2 && r.body['rubricChanged'] === true, 'not a new rubric version'),
        ...want(r.body['supersedes'] === pub1.body['descriptorUrl'], 'v2 does not supersede v1'),
      ]);
    S['mdHash'] = str(pub2.body['scenarioHash']);
    await step('10', 'the author tries to ratify v2', { status: 403, code: 'ratifier-is-the-author' },
      () => act(A, W.author, PEV_ACTION.ratifyScenario, { scenarioIri: S['md'], version: 2, scenarioHash: S['mdHash'] }));
    await step('11', 'a reviewer ratifies v2', { status: 200 },
      () => act(A, W.reviewer, PEV_ACTION.ratifyScenario, { scenarioIri: S['md'], version: 2, scenarioHash: S['mdHash'] }),
      (r) => want(r.body['status'] === 'ratified' && r.body['modalStatus'] === 'Asserted', 'not ratified as Asserted'));

    // ── 12–15: drafting with the bridge's model ───────────────────────────────────────────────
    const before = JSON.stringify([...pod.store].sort());
    const drafted = await step('12', 'the author asks bridge A to draft renegotiate-scope; nothing is written', { status: 200 },
      () => act(A, W.author, PEV_ACTION.draftScenario, { brief: 'A project manager tells the client sponsor that two defects block the payment flow and the launch date is at risk.' }),
      (r) => [
        ...want(Object.keys(obj(r.body['draft'])).length > 0 && Object.keys(obj(r.body['receipt'])).length > 0, 'no draft or no receipt'),
        ...want(obj(r.body['disclosure'])['provider'] === 'scripted', 'the draft is not disclosed as scripted'),
        ...want(JSON.stringify([...pod.store].sort()) === before, 'the pod changed'),
      ]);
    const draftBody = obj(drafted.body['draft']);
    const gateRubric = {
      criteria: arr(obj(draftBody['rubric'])['criteria']).map((c) => ({
        ...obj(c), weight: 1, levels: arr(obj(c)['levels']).map((l, i) => ({ ...obj(l), value: [0, 50, 100][i] ?? 100 })),
      })),
      passRule: { minPercent: 60, requiredLevels: {} },
    };
    await step('13', 'the author submits it as a pass gate on emergent work without a reason', { status: 400, code: 'pass-gate-needs-knowable-work' },
      () => act(A, W.author, PEV_ACTION.authorScenario, {
        scenario: { ...draftBody, assessmentUse: 'pass-gate', workRegime: 'emergent', rubric: gateRubric }, status: 'published', draftReceipt: drafted.body['receipt'],
      }));
    const rs = await step('14', 'the author publishes it feedback-only on emergent work, with the receipt', { status: 200 },
      () => act(A, W.author, PEV_ACTION.authorScenario, {
        scenario: { ...draftBody, assessmentUse: 'feedback-only', workRegime: 'emergent' }, status: 'published', draftReceipt: drafted.body['receipt'],
      }),
      (r) => {
        const da = obj(r.body['draftAssistance']);
        const desc = pod.store.get(str(r.body['descriptorUrl'])) ?? '';
        return [
          ...want(da['measured'] === true && da['editedAfterDraft'] === false, 'the assistance is not measured and unedited'),
          ...want(desc.includes(modelAgentIri('scripted', 'scripted-fixture')), 'the descriptor has no drafting-model Author facet'),
        ];
      });
    S['rs'] = str(rs.body['scenarioIri']);
    await step('15', 'the second reviewer ratifies renegotiate-scope', { status: 200 },
      () => act(A, W['second-reviewer'], PEV_ACTION.ratifyScenario, { scenarioIri: S['rs'], version: 1, scenarioHash: str(rs.body['scenarioHash']) }));

    // ── 16–24: Ana practises on the bridge's (scripted) model ──────────────────────────────────
    await step('16', 'Ana starts without saying whether she is coached', { status: 400, code: 'coached-undeclared' },
      () => act(A, W.learner, PEV_ACTION.startAttempt, { scenarioIri: S['md'], scenarioVersion: 2 }));
    const a1 = await step('17', 'Ana starts missed-deadline v2 (not coached)', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.startAttempt, { scenarioIri: S['md'], scenarioVersion: 2, coached: false }),
      (r) => want(r.body['attemptNumber'] === 1 && r.body['learnerKind'] === 'person', 'not attempt 1 by a person'));
    S['a1'] = str(a1.body['attemptIri']);
    await step('18', 'Ana says her first line on bridge B, which has no model', { status: 503, code: 'no-model-route' },
      () => act(B, W.learner, PEV_ACTION.say, { attemptIri: S['a1'], turnIndex: 1, text: DEMO_LINES.ana[0] }),
      (r) => want(obj(r.body['iep:resolvedBy'])['action'] === PEV_ACTION.counterpartPacket, 'the refusal does not point at the counterpart packet'));
    const scriptedTurn = (k: number) => (r: Http): string[] => {
      const c = obj(r.body['counterpartTurn']);
      const d = obj(c['disclosure']);
      return [
        ...want(c['text'] === DEMO_LINES.sam[k], 'the other person did not answer from the script'),
        ...want(d['provider'] === 'scripted' && d['route'] === 'scripted' && d['keySource'] === 'none', 'the reply is not disclosed as scripted'),
      ];
    };
    for (const [k, idx] of [[0, 1], [1, 3]] as const) {
      const fields = { attemptIri: S['a1'], turnIndex: idx, text: DEMO_LINES.ana[k] };
      const envelope = await sign(W.learner, PEV_ACTION.say, fields);
      if (k === 1) T['t3'] = envelope;
      await step(`19${k === 0 ? 'a' : 'b'}`, `Ana says line ${idx} on bridge A`, { status: 200 }, () => A(PEV_ACTION.say, { envelope }), scriptedTurn(k));
      latency.push(steps[steps.length - 1]?.ms ?? 0);
    }
    await step('20', 'the line-3 envelope is sent again', { status: 409, code: 'envelope-already-used' }, () => A(PEV_ACTION.say, { envelope: T['t3'] }));
    const tampered = await sign(W.learner, PEV_ACTION.say, { attemptIri: S['a1'], turnIndex: 5, text: DEMO_LINES.ana[2] });
    await step('21', 'a line-5 envelope whose text was changed after signing', { status: 403, code: 'not-the-learner' },
      () => A(PEV_ACTION.say, { envelope: { payload: { ...tampered.payload, text: 'I never agreed to any of this.' }, signature: tampered.signature } }));
    await step('22', 'Ana asks for judging before the end', { status: 409, code: 'attempt-not-ended' },
      () => act(A, W.learner, PEV_ACTION.judgeAttempt, { attemptIri: S['a1'] }));
    await step('23', 'Ana says line 5; the other person proposes the end', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.say, { attemptIri: S['a1'], turnIndex: 5, text: DEMO_LINES.ana[2] }),
      (r) => [
        ...want(r.body['state'] === 'in-conversation' && r.body['endProposed'] === true, 'the proposal ended the conversation, or was not recorded'),
        ...want(obj(r.body['counterpartTurn'])['endSignal'] === true, 'no end signal on the reply'),
      ]);
    latency.push(steps[steps.length - 1]?.ms ?? 0);
    await step('24', 'Ana ends the conversation', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.endConversation, { attemptIri: S['a1'], turnIndex: 7 }),
      (r) => want(r.body['state'] === 'ended' && r.body['endedBy'] === 'learner-confirmed-counterpart-end', 'not ended by the learner confirming the proposal'));

    // ── 25–33: judging, the fabricated quote, review, projection ──────────────────────────────
    const j1 = await step('25', 'Ana asks bridge A to judge', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.judgeAttempt, { attemptIri: S['a1'] }),
      (r) => {
        const j = obj(r.body['judgment']);
        const ans = obj(arr(j['criteria']).find((c) => obj(c)['criterionId'] === 'agrees-next-step'));
        const fab = obj(arr(ans['quotes']).find((q) => obj(q)['text'] === FABRICATED_QUOTE));
        const p = obj(r.body['provisional']);
        return [
          ...want(r.body['state'] === 'judged' && r.body['modalStatus'] === 'Hypothetical', 'not judged and Hypothetical'),
          ...want(ans['status'] === 'unverified' && ans['why'] === 'not found verbatim in any learner turn', 'the fabricated quote did not leave its criterion unverified'),
          ...want(fab['verified'] === false, 'the fabricated quote was accepted'),
          ...want(p['percent'] === '66.7' && p['meetsPassRule'] === false && p['provisional'] === true && p['computedBy'] === 'platform', 'the provisional result is not 66.7 %, not meeting the rule, platform-computed'),
          ...want(arr(r.body['nextSteps']).some((x) => obj(x)['criterionId'] === 'agrees-next-step'), 'no next step for agrees-next-step'),
        ];
      });
    const firstJudgment = obj(j1.body['judgment']);
    report.fabricatedQuote = arr(obj(arr(firstJudgment['criteria']).find((c) => obj(c)['criterionId'] === 'agrees-next-step'))['quotes'])
      .find((q) => obj(q)['text'] === FABRICATED_QUOTE) ?? null;
    const j2 = await step('26', 'Ana asks for a second opinion', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.judgeAttempt, { attemptIri: S['a1'] }),
      (r) => [
        ...want(r.body['judgmentCount'] === 2 && obj(r.body['judgment'])['repeatOf'] === 0, 'not a repeat of judgment 0'),
        ...want(obj(arr(r.body['agreement']).find((x) => obj(x)['criterionId'] === 'asks-their-view'))['spread'] === 1, 'no spread of 1 on asks-their-view'),
      ]);
    const p27 = await step('27', 'Ana asks for an xAPI statement before any review', { status: 409, code: 'attempt-not-countersigned' },
      () => act(A, W.learner, PEV_ACTION.projectAttempt, { attemptIri: S['a1'], format: 'xapi' }));
    // The decline left an audit row: read it back from the pod (not from the answer) and check it.
    await step('27b', 'the declined projection left a skipped audit row on the pod', { status: 200 },
      async () => {
        const rec = await readRecord(str(obj(p27.body['skipAudit'])['descriptorUrl']), trusted, pod.fetchFn);
        const audit = rec.body.kind === 'projection-audit' ? rec.body : null;
        return { status: 200, body: { trusted: isTrusted(rec), sealed: rec.sealed, outcome: audit?.outcome ?? null, skipWhy: audit?.skipWhy ?? null } };
      },
      (r) => want(r.body['trusted'] === true && r.body['sealed'] === true && r.body['outcome'] === 'skipped' && r.body['skipWhy'] === 'attempt-not-countersigned',
        `the audit row reads ${JSON.stringify(r.body)}`));
    const reviewFields = (t: Json, picks: readonly (readonly [string, string, string?])[]): Json => ({ attemptIri: S['a1'], target: t, levels: levels(picks), sawJudgeLevelsFirst: true });
    const asJudged = [['specific-observation', 'specific'], ['asks-their-view', 'first'], ['agrees-next-step', 'owner-and-date']] as const;
    await step('28', 'Ana tries to countersign her own attempt', { status: 403, code: 'reviewer-is-the-learner' },
      () => act(A, W.learner, PEV_ACTION.countersignAttempt, reviewFields(target(j2), asJudged)));
    await step('29', 'the reviewer countersigns as judged although a quote did not check out', { status: 409, code: 'unverified-criteria-need-override' },
      () => act(A, W.reviewer, PEV_ACTION.countersignAttempt, reviewFields(target(j2), asJudged)));
    const ov = await step('30', 'the reviewer sets every level, with a reason where the quote failed', { status: 200 },
      () => act(A, W.reviewer, PEV_ACTION.overrideAttempt, reviewFields(target(j2), [
        ['specific-observation', 'specific'], ['asks-their-view', 'first'],
        ['agrees-next-step', 'owner-and-date', 'Ana agreed a status note by Tuesday at 10am with Sam as its owner; the second quote the judge gave is not in the transcript.'],
      ])),
      (r) => {
        const x = obj(r.body['assessment']);
        return [
          ...want(r.body['state'] === 'overridden' && r.body['modalStatus'] === 'Asserted', 'not overridden and Asserted'),
          ...want(x['percent'] === '100.0' && x['meetsPassRule'] === true && x['provisional'] === false, 'the final result is not 100.0 % meeting the pass rule'),
        ];
      });
    S['a1Target'] = JSON.stringify(target(ov));
    await step('31a', 'the reviewer tries to review the same attempt again', { status: 403, code: 'reviewer-already-reviewed' },
      () => act(A, W.reviewer, PEV_ACTION.countersignAttempt, reviewFields(target(ov), asJudged)));
    await step('31b', 'the second reviewer tries to countersign the reviewed attempt', { status: 409, code: 'attempt-not-judged' },
      () => act(A, W['second-reviewer'], PEV_ACTION.countersignAttempt, reviewFields(target(ov), asJudged)));
    const statementCheck = (fmt: ProjectionFormat, use: 'pass-gate' | 'feedback-only') => (r: Http): string[] => {
      const st = obj(r.body['statement']);
      const result = obj(st['result']);
      const ctx = obj(st['context']);
      const categories = arr(obj(ctx['contextActivities'])['category']).map((c) => str(obj(c)['id']));
      const auditUrl = str(r.body['auditDescriptorUrl']);
      return [
        ...want(statementProblems(st, fmt, use).length === 0, `statementProblems: ${statementProblems(st, fmt, use).join(' | ')}`),
        ...want(obj(st['verb'])['id'] === VERB_COMPLETED, 'the verb is not completed'),
        ...want(obj(ctx['extensions'])[PRACTICE_MARKER] === true, 'no practice marker'),
        ...want(!categories.some((c) => c.startsWith(CMI5_CATEGORY_PREFIX)), 'a cmi5 category is present'),
        ...(use === 'pass-gate'
          ? want(result['success'] === true, 'success is not true')
          : want(!('score' in result) && !('success' in result), 'a feedback-only statement carries a score or success')),
        ...want(records(auditUrl), 'no projection audit row on the pod'),
      ];
    };
    const x1 = await step('32a', 'Ana projects her reviewed attempt as xAPI', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.projectAttempt, { attemptIri: S['a1'], format: 'xapi' }), statementCheck('xapi', 'pass-gate'));
    report.statements.xapi = x1.body['statement'] ?? null;
    const c1 = await step('32b', 'Ana projects it as xAPI with cmi5-allowed context', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.projectAttempt, { attemptIri: S['a1'], format: 'cmi5' }), statementCheck('cmi5', 'pass-gate'));
    report.statements.cmi5 = c1.body['statement'] ?? null;
    await step('33', 'Ana asks for SCORM', { status: 501, code: 'projection-not-built' },
      () => act(A, W.learner, PEV_ACTION.projectAttempt, { attemptIri: S['a1'], format: 'scorm' }));

    // ── 34–36: the learner holds her record ───────────────────────────────────────────────────
    await step('34', 'the reviewer asks for Ana\'s export', { status: 403, code: 'not-the-learner' },
      () => act(A, W.reviewer, PEV_ACTION.exportRecord, { attemptIri: S['a1'] }));
    const ex = await step('35', 'Ana exports her record; every version verifies offline', { status: 200 },
      async () => {
        const r = await act(A, W.learner, PEV_ACTION.exportRecord, { attemptIri: S['a1'] });
        const platforms = arr(r.body['platformAddresses']).map((a) => str(a).toLowerCase());
        let verifiedOffline = 0;
        for (const v of arr(r.body['versions'])) {
          if (await pairVerifies(str(obj(v)['descriptorTurtle']), str(obj(v)['graphTrig']), platforms)) verifiedOffline += 1;
        }
        return { status: r.status, body: { ...r.body, verifiedOffline } };
      },
      (r) => [
        ...want(arr(r.body['versions']).length === 8, `expected 8 versions, got ${arr(r.body['versions']).length}`),
        ...want(r.body['verifiedOffline'] === 8, `${String(r.body['verifiedOffline'])} of ${arr(r.body['versions']).length} pairs verify offline`),
      ]);
    report.export = {
      versions: arr(ex.body['versions']).length, verifiedOffline: ex.body['verifiedOffline'] ?? 0,
      states: arr(ex.body['versions']).map((v) => obj(v)['state']),
    };
    const cp = await step('36', 'Ana copies her attempt to her own pod', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.holderCopy, { attemptIri: S['a1'], targetPodUrl: DEMO_LEARNER_POD }),
      (r) => [
        ...want(arr(r.body['copies']).length === 8 && r.body['copiesVerified'] === 8, `expected 8 verified copies, got ${arr(r.body['copies']).length} / ${String(r.body['copiesVerified'])}`),
        ...want(arr(r.body['copies']).every((c) => str(obj(c)['copyDescriptorUrl']).startsWith(DEMO_LEARNER_POD)), 'a copy is not on the learner pod'),
        // The learner does not hold the bridge's record key, so her copies are never encrypted.
        ...want([...pod.store.keys()].filter((u) => u.startsWith(DEMO_LEARNER_POD) && u.endsWith('-graph.trig')).length === 8
          && ![...pod.store.keys()].some((u) => u.startsWith(DEMO_LEARNER_POD) && u.endsWith('.envelope.jose.json')), 'the copies are not plaintext on the learner pod'),
      ]);
    report.copies = { copies: arr(cp.body['copies']).length, copiesVerified: cp.body['copiesVerified'] ?? null, targetPodUrl: DEMO_LEARNER_POD };
    const firstCopy = str(obj(arr(cp.body['copies'])[0])['copyDescriptorUrl']);

    // ── 37–45: Ben practises through packets; an independent judge agent; contest ────────────
    const b = await step('37a', 'Ben starts renegotiate-scope (coached)', { status: 200 },
      () => act(A, W['second-learner'], PEV_ACTION.startAttempt, { scenarioIri: S['rs'], scenarioVersion: 1, coached: true, assistance: 'Talked it through with my manager first.' }));
    S['b'] = str(b.body['attemptIri']);
    const learnerAgent = learnerAgentModel();
    for (const [k, idx] of [[0, 1], [1, 3]] as const) {
      const packet = await step(`37${k === 0 ? 'b' : 'd'}`, `Ben fetches the counterpart packet for line ${idx}`, { status: 200 },
        () => act(A, W['second-learner'], PEV_ACTION.counterpartPacket, { attemptIri: S['b'], turnIndex: idx, learnerText: DEMO_LINES.ben[k] }),
        (r) => want(r.body['execution'] === 'client-required' && r.body['sampling_performed'] === false && r.body['writes_performed'] === false, 'not a client-required packet'));
      const reply = await learnerAgent.complete(obj(packet.body['request']) as unknown as TextModelRequest);
      await step(`37${k === 0 ? 'c' : 'e'}`, `Ben records line ${idx} and his own agent's reply`, { status: 200 },
        () => act(A, W['second-learner'], PEV_ACTION.recordTurns, {
          attemptIri: S['b'], turnIndex: idx, learnerText: DEMO_LINES.ben[k], counterpartText: reply.text,
          counterpartDisclosure: { provider: learnerAgent.provider, model: reply.model }, ...(k === 1 ? { endAfter: true } : {}),
        }),
        (r) => [
          ...want(r.body['counterpartControlledBy'] === 'learner', 'not marked as the learner\'s own agent'),
          ...want(obj(r.body['counterpartTurn'])['text'] === DEMO_LINES.priya[k], 'the agent\'s line was not recorded'),
          ...(k === 1 ? want(r.body['state'] === 'ended' && r.body['endedBy'] === 'learner', 'not ended by the learner') : []),
        ]);
      latency.push(steps[steps.length - 1]?.ms ?? 0);
    }
    const jp = await step('38a', 'the judge agent fetches the judge packet', { status: 200 },
      () => act(A, W['judge-agent'], PEV_ACTION.judgePacket, { attemptIri: S['b'] }));
    const judgeAgent = judgeAgentModel();
    const req = obj(jp.body['request']);
    const judged = await judgeAgent.complete({ system: str(req['system']), messages: [{ role: 'user', content: str(req['user']) }], maxTokens: 4000 });
    const binding = obj(jp.body['binding']);
    const bj = await step('38b', 'the judge agent records its judgment', { status: 200 },
      () => act(A, W['judge-agent'], PEV_ACTION.recordJudgment, {
        attemptIri: S['b'], attemptHeadUrl: binding['attemptHeadUrl'], transcriptHash: binding['transcriptHash'], rubricHash: binding['rubricHash'],
        judgment: JSON.parse(judged.text) as unknown, judgeDisclosure: { provider: judgeAgent.provider, model: judged.model, usedPacketPrompt: true },
      }),
      (r) => {
        const j = obj(r.body['judgment']);
        return [
          ...want(r.body['state'] === 'judged' && obj(j['judge'])['kind'] === 'agent', 'not judged by a registered agent'),
          ...want(arr(j['criteria']).every((c) => obj(c)['status'] === 'verified'), 'a quote of the judge agent did not check out'),
        ];
      });
    const asJudgedBen = [['names-constraint', 'specific'], ['explores-interests', 'one-question']] as const;
    const benReview = (t: Json, picks = asJudgedBen): Json => ({ attemptIri: S['b'], target: t, levels: levels(picks), sawJudgeLevelsFirst: true });
    await step('39', 'the judge agent tries to countersign Ben\'s attempt', { status: 403, code: 'reviewer-is-the-judge' },
      () => act(A, W['judge-agent'], PEV_ACTION.countersignAttempt, benReview(target(bj))));
    await step('40', 'the second reviewer\'s queue lists Ben\'s attempt, raised because his own agent played the client', { status: 200 },
      () => act(A, W['second-reviewer'], PEV_ACTION.reviewQueue, { limit: 20 }),
      (r) => {
        const e = obj(arr(r.body['entries']).find((x) => obj(x)['attemptIri'] === S['b']));
        return [
          ...want(Object.keys(e).length > 0, 'Ben\'s attempt is not in the queue'),
          ...want(obj(e['why'])['learnerControlled'] === 1, 'learnerControlled is not 1'),
          ...want(!arr(r.body['entries']).some((x) => obj(x)['attemptIri'] === S['authorTest']), 'the author test is in the queue'),
        ];
      });
    const bc = await step('41', 'the second reviewer countersigns Ben\'s attempt as judged', { status: 200 },
      () => act(A, W['second-reviewer'], PEV_ACTION.countersignAttempt, benReview(target(bj))),
      (r) => want(r.body['state'] === 'countersigned' && r.body['modalStatus'] === 'Asserted', 'not countersigned'));
    const bx = await step('42', 'Ben projects his attempt as xAPI (feedback only)', { status: 200 },
      () => act(A, W['second-learner'], PEV_ACTION.projectAttempt, { attemptIri: S['b'], format: 'xapi' }), statementCheck('xapi', 'feedback-only'));
    report.statements.feedbackOnly = bx.body['statement'] ?? null;
    const contest = await step('43', 'Ben contests the review', { status: 200 },
      () => act(A, W['second-learner'], PEV_ACTION.contestReview, { attemptIri: S['b'], target: target(bc), why: 'I followed up on the payments answer before we ended; please look at it again.' }),
      (r) => want(r.body['state'] === 'contested' && r.body['modalStatus'] === 'Hypothetical', 'not contested and Hypothetical'));
    await step('44', 'the second reviewer tries to review it again', { status: 403, code: 'reviewer-already-reviewed' },
      () => act(A, W['second-reviewer'], PEV_ACTION.countersignAttempt, benReview(target(contest))));
    await step('45', 'the first reviewer re-reviews it as judged', { status: 200 },
      () => act(A, W.reviewer, PEV_ACTION.countersignAttempt, benReview(target(contest))),
      (r) => want(r.body['state'] === 'countersigned' && r.body['reviewIndex'] === 1, 'not a second review'));

    // ── 46–47: a later role change does not strip evidence ────────────────────────────────────
    await step('46', 'the admin removes the reviewer role from the reviewer', { status: 200 },
      () => act(A, W.admin, PEV_ACTION.registerRole, { address: W.reviewer.address, role: 'reviewer', change: 'remove' }),
      (r) => want(r.body['changed'] === true, 'nothing changed'));
    await step('47', 'Ana projects her attempt again (the role is checked as of the review)', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.projectAttempt, { attemptIri: S['a1'], format: 'xapi' }), statementCheck('xapi', 'pass-gate'));
    const anaView = await step('47b', 'Ana reads her attempt', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.getAttempt, { attemptIri: S['a1'] }),
      (r) => want(r.body['state'] === 'overridden' && r.body['projectable'] === true, 'not overridden and projectable'));
    report.attempts.push(anaView.body);

    // ── 48–49: calibration and results ────────────────────────────────────────────────────────
    const scriptedJudge = 'model:scripted/scripted-fixture';
    const agentJudge = didOf(W['judge-agent'].address).toLowerCase();
    const cal = await step('48', 'calibration', { status: 200 },
      () => A(PEV_ACTION.calibration, { pod_url: DEMO_POD }),
      (r) => {
        const cells = arr(r.body['cells']).map(obj);
        const scripted = cells.filter((c) => c['judgeId'] === scriptedJudge);
        const agent = cells.filter((c) => str(c['judgeId']).toLowerCase() === agentJudge);
        return [
          ...want(scripted.length === 3 && agent.length === 2, `expected 3 scripted and 2 agent cells, got ${scripted.length} and ${agent.length}`),
          ...want([...scripted, ...agent].every((c) => c['status'] === 'Hypothetical'), 'a cell is not Hypothetical'),
          ...want(scripted.every((c) => obj(c['standing'])['evaluated'] === false), 'a scripted fixture was evaluated for standing'),
          ...want(agent.every((c) => obj(c['standing'])['evaluated'] === true && obj(c['standing'])['clears'] === false
            && /^\d+ outcome\(s\) of pev\/[0-9a-f]{16}\/[a-z0-9-]+, below 20$/.test(str(obj(c['standing'])['why']))), 'the agent judge\'s standing is not "below 20"'),
          ...want(r.body['personJudgeCellsWithheld'] === 0, 'person-judge cells were withheld'),
          ...want(scripted.some((c) => typeof c['repeatSamples'] === 'number' && (c['repeatSamples'] as number) >= 1 && c['repeatAgreement'] !== undefined), 'no test-retest figures for the scripted judge'),
          ...want(scripted.every((c) => 'auditSampleCoverage' in c && 'auditSamplePartial' in c), 'audit coverage is not reported'),
        ];
      });
    report.calibration = cal.body['cells'] ?? null;
    const results = await step('49', 'the author reads the results for missed-deadline', { status: 200 },
      () => act(A, W.author, PEV_ACTION.scenarioResults, { scenarioIri: S['md'] }),
      (r) => {
        const counts = obj(r.body['counts']);
        const fin = arr(obj(r.body['final'])['perCriterion']).map(obj);
        const cells = fin.flatMap((c) => arr(c['levels']).map(obj));
        return [
          ...want(counts['authorTestExcluded'] === 1, 'the author test is not excluded and counted'),
          ...want(fin.length === 3 && cells.every((l) => l['suppressed'] === true || l['count'] === 0) && cells.some((l) => l['suppressed'] === true), 'small final counts are not suppressed'),
        ];
      });
    report.results = results.body;

    // ── 50: redaction ─────────────────────────────────────────────────────────────────────────
    await step('50a', 'Ana removes her transcript from the operator pod', { status: 200 },
      () => act(A, W.learner, PEV_ACTION.redactAttempt, { attemptIri: S['a1'], target: JSON.parse(S['a1Target'] ?? '{}') as unknown }),
      (r) => {
        const operatorBytes = [...pod.store].filter(([u]) => u.startsWith(DEMO_POD)).map(([, v]) => v).join('\n');
        return [
          ...want(r.body['state'] === 'redacted' && r.body['modalStatus'] === 'Retracted', 'not redacted and Retracted'),
          ...want(r.body['graphsDeleted'] === 8 && arr(r.body['graphsStillPresent']).length === 0, `expected 8 graphs deleted, got ${String(r.body['graphsDeleted'])}`),
          ...want(DEMO_LINES.ana.every((line) => !operatorBytes.includes(line)), 'a line of Ana\'s is still on the operator pod'),
        ];
      });
    const after = await step('50b', 'Ana reads the redacted attempt: no text; her copy still verifies', { status: 200 },
      async () => {
        const r = await act(A, W.learner, PEV_ACTION.getAttempt, { attemptIri: S['a1'] });
        // Read without the record key: a copy is plaintext and needs only the platform address.
        const copy = await readRecord(firstCopy, { addresses: trusted.addresses }, pod.fetchFn);
        return { status: r.status, body: { ...r.body, copyStillVerifies: isTrusted(copy) && !copy.sealed } };
      },
      (r) => [
        ...want(arr(r.body['turns']).every((t) => !('text' in obj(t))), 'a turn still has text'),
        ...want(DEMO_LINES.ana.every((line) => !JSON.stringify(r.body).includes(line)), 'a line of Ana\'s is in the view'),
        ...want(r.body['copyStillVerifies'] === true, 'the holder copy no longer verifies'),
      ]);
    const { copyStillVerifies: _c, ...afterView } = after.body;
    report.attempts.push(afterView);
    await step('50c', 'Ana asks for a statement from the redacted attempt', { status: 409, code: 'attempt-redacted' },
      () => act(A, W.learner, PEV_ACTION.projectAttempt, { attemptIri: S['a1'], format: 'xapi' }));
    const benView = await step('v2', 'Ben reads his attempt', { status: 200 },
      () => act(A, W['second-learner'], PEV_ACTION.getAttempt, { attemptIri: S['b'] }),
      (r) => want(r.body['state'] === 'countersigned' && arr(r.body['reviews']).length === 2, 'not countersigned with both reviews kept'));
    report.attempts.push(benView.body);
  } finally {
    for (const l of listeners) await l.close();
  }

  const ok = steps.length > 0 && steps.every((s) => s.ok);
  let reportPath: string | undefined;
  if (opts.writeReport ?? !quiet) {
    const dir = fileURLToPath(new URL('../../../demos/output/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    reportPath = resolve(dir, `pev-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    writeFileSync(reportPath, markdownReport({ ok, steps, latency, report }), 'utf8');
    print(`report: ${reportPath}`);
  }
  print(ok ? `demo ok: ${steps.length} steps, every status, code and content check as expected` : `demo FAILED: ${steps.filter((s) => !s.ok).length} of ${steps.length} steps`);

  let servingAt: string | undefined;
  if (opts.serve) {
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    clock.goLive();
    const app = appOf(handlersA, allowed);
    await new Promise<void>((done, fail) => {
      const server = app.listen(port, '127.0.0.1', () => done());
      server.once('error', fail);
    });
    servingAt = `${deploymentUrl}/ui`;
    print(`serving the web UI at ${servingAt} (bridge A, scripted model, the demo pod as left above)`);
    print('DEMO MODE: this bridge holds the demo role keys and signs as whichever role the page picks. Records it writes say so. Do not run demo mode on a shared deployment.');
  }

  return {
    ok, steps, attempts: report.attempts, statements: report.statements, calibration: report.calibration, results: report.results,
    copies: report.copies, export: report.export, fabricatedQuote: report.fabricatedQuote, turnLatencyMs: latency, pod,
    ...(reportPath ? { reportPath } : {}), ...(servingAt ? { servingAt } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  The markdown report (URLs written bare; never inside angle brackets)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const cell = (s: unknown): string => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const pct = (v: unknown): string => (typeof v === 'number' ? `${(v * 100).toFixed(0)} %` : 'n/a');

function markdownReport(i: { ok: boolean; steps: readonly DemoStep[]; latency: readonly number[]; report: { attempts: unknown[]; statements: Record<string, unknown>; calibration: unknown; results: unknown; copies: unknown; export: unknown; fabricatedQuote: unknown } }): string {
  const out: string[] = [];
  out.push('# practice-evidence: offline demo report', '');
  out.push(`Written ${new Date().toISOString()}. Verdict: **${i.ok ? 'every step as expected' : 'FAILED'}** (${i.steps.filter((s) => s.ok).length} of ${i.steps.length} steps).`, '');
  out.push('Offline and deterministic: an in-memory pod on reserved .test hosts, public fixture keys, a demo clock starting at 2026-10-22T09:00:00Z. '
    + 'The other person, the judge and the drafter are a scripted fixture, disclosed as provider `scripted` on every record; no model ran and nothing left the process. '
    + 'Two bridges were walked over HTTP the way a Path-A agent walks them: bridge A with the scripted model, bridge B with no model.', '');
  out.push('## Steps', '', '| # | step | expected | got | ok | ms | note |', '|---|---|---|---|---|---|---|');
  for (const s of i.steps) {
    out.push(`| ${s.id} | ${cell(s.name)} | ${s.expectStatus}${s.expectCode ? ` ${s.expectCode}` : ''} | ${s.gotStatus}${s.gotCode ? ` ${s.gotCode}` : ''} | ${s.ok ? 'yes' : '**NO**'} | ${s.ms} | ${cell(s.note)} |`);
  }
  out.push('', '## The fabricated quote', '', 'The scripted judge quoted words Ana never said. The platform\'s check:', '', '```json', JSON.stringify(i.report.fabricatedQuote, null, 2), '```', '');
  out.push('## Attempts', '');
  for (const a of i.report.attempts) {
    const v = obj(a);
    const fin = obj(v['finalAssessment']);
    const prov = obj(v['provisional']);
    out.push(`### ${cell(obj(v['scenario'])['title'])}: attempt ${String(v['attemptNumber'] ?? '')}, state ${String(v['state'] ?? '')}`, '');
    out.push(`- learner ${String(obj(v['learner'])['did'] ?? '')}; coached ${String(v['coached'] ?? '')}; the other person played by ${String(v['counterpartControlledBy'] ?? '')}`);
    out.push(`- judgments: ${arr(v['judgments']).length}; reviews: ${arr(v['reviews']).length}; versions: ${arr(v['versions']).length}; modal status ${String(v['modalStatus'] ?? '')}`);
    if (Object.keys(prov).length > 0) out.push(`- provisional (not reviewed): ${prov['use'] === 'pass-gate' ? `${String(prov['percent'])} %, would${prov['meetsPassRule'] ? '' : ' not'} meet the pass rule` : 'levels only'}`);
    if (Object.keys(fin).length > 0) out.push(`- final (reviewed): ${fin['use'] === 'pass-gate' ? `${String(fin['percent'])} %, ${fin['meetsPassRule'] ? 'meets' : 'does not meet'} the pass rule` : 'levels only'}`);
    out.push(`- turns: ${arr(v['turns']).map((t) => (('text' in obj(t)) ? 'text' : 'text removed')).join(', ')}`);
    out.push(`- projectable: ${String(v['projectable'] ?? '')} (${String(v['projectableWhy'] ?? '')})`, '');
  }
  out.push('## Statements', '');
  for (const [k, s] of Object.entries(i.report.statements)) out.push(`### ${k}`, '', '```json', JSON.stringify(s, null, 2), '```', '');
  out.push('## Calibration (agreement with the reviewer, not accuracy)', '', '| judge | criterion | samples | agreement | mean level distance | unverified | test-retest | status | standing |', '|---|---|---|---|---|---|---|---|---|');
  for (const c of arr(i.report.calibration).map(obj)) {
    const st = obj(c['standing']);
    out.push(`| ${cell(c['judgeId'])} | ${cell(c['criterionTitle'])} | ${String(c['samples'])} | ${pct(c['agreementRate'])} | ${String(c['meanLevelDistance'] ?? 'n/a')} | ${pct(c['unverifiedRate'])} | ${String(c['repeatSamples'])} / ${pct(c['repeatAgreement'])} | ${String(c['status'])} | ${st['evaluated'] ? (st['clears'] ? 'clears' : 'does not clear') : 'not evaluated'}: ${cell(st['why'])} |`);
  }
  const res = obj(i.report.results);
  out.push('', '## Results for missed-deadline', '', cell(res['label']), '', `Counts: ${JSON.stringify(obj(res['counts']))}`, '');
  for (const c of arr(obj(res['final'])['perCriterion']).map(obj)) {
    out.push(`- final, ${cell(c['title'])} (n = ${String(c['n'])}): ${arr(c['levels']).map(obj).map((l) => `${String(l['label'])} ${l['suppressed'] ? 'hidden' : String(l['count'])}`).join(', ')}`);
  }
  out.push('', '## The learner\'s copies', '', `Export: ${JSON.stringify(i.report.export)}`, '', `Holder copy: ${JSON.stringify(i.report.copies)}`, '');
  out.push('## Per-turn latency on the in-memory pod', '', `${i.latency.map((x) => `${x} ms`).join(', ')}.`, '',
    'Every exchange rewrites the whole attempt record and runs a manifest read, so the work per turn grows with the attempt\'s length and with the pod. These figures are for the in-memory pod; a real pod adds its own round trips. '
    + 'Each figure also includes the SSRF guard\'s DNS look-up of the pod host on every pod request: a resolver that stalls shows here as a jump the size of its timeout.', '');
  return out.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  CLI
// ═════════════════════════════════════════════════════════════════════════════════════════════

const isMain = ((): boolean => {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ''); } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const portAt = argv.indexOf('--port');
  const port = portAt >= 0 ? Number.parseInt(argv[portAt + 1] ?? '', 10) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    process.stderr.write('--port needs a number from 1 to 65535\n');
    process.exitCode = 1;
  } else {
    runDemo({ serve: argv.includes('--serve'), live: argv.includes('--live'), quiet: argv.includes('--quiet'), writeReport: true, ...(port !== undefined ? { port } : {}) })
      .then((r) => { if (!r.ok) process.exitCode = 1; })
      .catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
  }
}
