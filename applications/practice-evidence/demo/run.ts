/**
 * Offline fixtures for practice-evidence: an in-memory pod that behaves like a Solid pod where it
 * matters (ETags, conditional writes, DELETE), public fixture keys, the two demo scenarios, and a
 * scripted model for the other person, the judge and the drafter.
 *
 * Nothing here is presented as real inference. The scripted model is disclosed on every turn and
 * judgment as provider `scripted`, key source `none`, route `scripted`, and its judge includes one
 * deliberately fabricated quote so the platform's quote check is seen to catch it.
 *
 * No environment reads: this module sits in a test closure.
 */
import { createHash } from 'node:crypto';
import { sha256 } from '@interego/core';
import { scriptedTextModel, type TextModel, type TextModelRequest } from '../src/model.js';
import type { DemoRoleName } from '../bridge/handlers.js';

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
  if (anaAt >= 0) return DEMO_LINES.sam[anaAt] ?? 'Go on.';
  const benAt = DEMO_LINES.ben.findIndex((l) => l === said);
  if (benAt >= 0) return DEMO_LINES.priya[benAt] ?? 'Go on.';
  return 'Go on.';
}

interface Crit { readonly criterionId: string; readonly level: string; readonly quotes: readonly { text: string; turnIndex?: number }[]; readonly rationale: string; readonly probabilities?: Record<string, number> }

function judgeAnswer(user: string, nth: number): string {
  const ids = [...user.matchAll(/"criterionId":\s*"([a-z0-9-]+)"/g)].map((m) => m[1] ?? '');
  const criteria: Crit[] = [];
  for (const id of ids) {
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
      criteria.push({ criterionId: id, level: '', quotes: [], rationale: 'This scripted fixture has no judgment for this criterion.' });
    }
  }
  return JSON.stringify({ criteria });
}

/**
 * The scripted model used by the offline demo and the tests. It answers as the other person from
 * the demo script, judges the demo rubrics (the first judgment of a transcript includes the
 * fabricated quote; later ones mark asks-their-view one level lower), and drafts renegotiate-scope.
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
