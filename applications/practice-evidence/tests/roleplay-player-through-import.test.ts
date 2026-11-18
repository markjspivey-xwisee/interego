/**
 * A practice in the role-play player, closed part way and opened again, read by Practice
 * Evidence's import as one conversation.
 *
 * The player's two scripts are run whole, as the page runs them, from the launch URL to the last
 * statement. What stands in for the browser is a document that keeps elements by id, and a `fetch`
 * that is the LMS, the learning record and the files beside the page. Nothing of the player is
 * stubbed: its start-up, its session check, `pick`, `finish` and `send` are the page's own. What
 * the learning record then holds is given to `readLaunchedCall`, the function the bridge's import
 * runs on a registration.
 *
 * Not checked here: a real browser, speech, the bridge's signed route around the import, or the
 * LMS's own rules for continuing a session. The session id is fixed by the stand-in LMS.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readLaunchedCall, VERB_INITIALIZED, VERB_LAUNCHED, VERB_SCORED, VERB_TERMINATED, type LaunchVocabulary, type ReadLaunchedInput } from '../src/launched-import.js';
import type { ScenarioSpec } from '../src/practice.js';

const DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');
const PAGE = read('index.html');
const SCRIPTS = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const SECTIONS = [...PAGE.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]!);

interface Scenario {
  turnLimit: number; assessmentUse: string; rubricRef: string;
  rubric: { criteria: { id: string; levels: { id: string; value: number }[] }[] };
  personas: { id: string; stages: { id: string; choices: { id: string; text: string; best?: boolean }[] }[] }[];
  xapi: { verbs: Record<string, string>; extensions: Record<string, string> };
}
const SCENARIO_FILE = 'scenarios/double-charged-subscription.json';
const scenario = JSON.parse(read(SCENARIO_FILE)) as Scenario;
const BEST = scenario.personas[0]!.stages.map((s) => s.choices.findIndex((c) => c.best));

type St = Record<string, unknown> & { id: string; verb: { id: string }; timestamp: string; object: { id: string; definition?: { extensions?: Record<string, unknown> } }; result?: { response?: string; extensions?: Record<string, unknown> } };
const LMS = 'https://lms.example', LRS = `${LMS}/xapi`, PLAYER = 'https://player.example/roleplay-player/index.html';
const AU = `${LMS}/courses/refund-call/au/1`;
const REG = '6f1c2f6e-3b1a-4c53-9d2e-0a4b7c9d1e2f', SESSION = 'b7e1a9c4-52d3-4f60-8a17-3c5d9e0f1a2b';
const SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
const ACTOR = { objectType: 'Agent', account: { homePage: 'https://id.example', name: 'https://id.example/users/learner-1/profile#me' } };

/** The LMS and its learning record, the page's own files, and nothing else. */
class Lms {
  readonly held: St[] = [];
  readonly asked: string[] = [];
  constructor() {
    // What an LMS records when it launches the unit: the import reads the launch mode from it.
    this.held.push({
      id: '00000000-0000-4000-8000-000000000001', version: '2.0.0', timestamp: new Date(Date.now() - 5000).toISOString(), actor: ACTOR,
      verb: { id: VERB_LAUNCHED }, object: { id: AU },
      context: { registration: REG, extensions: { [SESSION_EXT]: SESSION, 'https://w3id.org/xapi/cmi5/context/extensions/launchmode': 'Normal' } },
    });
  }
  readonly fetch = async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
    const u = new URL(String(input)), json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    this.asked.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}`);
    if (u.href.startsWith('https://player.example/roleplay-player/')) {
      const name = u.pathname.replace('/roleplay-player/', '');
      return new Response(read(name), { status: 200 });
    }
    if (u.origin !== LMS) return new Response('', { status: 404 });
    if (u.pathname === '/cmi5/fetch/once') return json({ 'auth-token': 'ZmljdGlvbmFsOmNyZWRlbnRpYWw' });
    if (u.pathname === '/xapi/activities/state') return json({ contextTemplate: { extensions: { [SESSION_EXT]: SESSION }, contextActivities: { grouping: [{ objectType: 'Activity', id: `${LMS}/courses/refund-call` }] } }, launchMode: 'Normal', launchParameters: '' });
    // This LMS asks no review service of its own; the player then has no reviewed result to wait for.
    if (u.pathname === '/cmi5/reviewed') return json({ error: 'registration_not_under_review' }, 409);
    if (u.pathname === '/xapi/statements' && init?.method === 'POST') {
      const st = JSON.parse(String(init.body)) as St, same = this.held.find((h) => h.id === st.id);
      if (same) return new Response('', { status: JSON.stringify(same) === JSON.stringify(st) ? 204 : 409 });
      this.held.push(st);
      return json([st.id]);
    }
    if (u.pathname === '/xapi/statements') {
      const id = u.searchParams.get('statementId');
      if (id) { const h = this.held.find((x) => x.id === id); return h ? json(h) : new Response('', { status: 404 }); }
      return json({ statements: this.held.slice().reverse(), more: '' });
    }
    return new Response('', { status: 404 });
  };
  verbs(): string[] { return this.held.map((s) => s.verb.id.split('/').pop()!); }
}

/** An element as far as the page uses one. */
class El {
  children: El[] = []; onclick: (() => unknown) | null = null; className = ''; style: Record<string, string> = {}; href = ''; target = ''; rel = ''; disabled = false;
  readonly offsetWidth = 0;
  private text = '';
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string): void => { this.classes.add(c); }, remove: (c: string): void => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean): void => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
    contains: (c: string): boolean => this.classes.has(c),
  };
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = String(v); this.children = []; }
  get innerHTML(): string { return ''; }
  set innerHTML(_v: string) { this.text = ''; this.children = []; }
  appendChild(e: El): El { this.children.push(e); return e; }
  setAttribute(): void { /* drawing only */ }
  /** Parts of an element's own markup: the page writes text into them and reads nothing back. */
  querySelector(): El { return new El(); }
  querySelectorAll(): El[] { return [new El(), new El()]; }
  get hidden(): boolean { return this.classes.has('hide'); }
}

/** One load of the page at a launch URL. */
function open(lms: Lms): { el(id: string): El; showing(): string[]; choices(): El[]; settle(until: () => boolean): Promise<void> } {
  const els = new Map<string, El>();
  const el = (id: string): El => { let e = els.get(id); if (!e) { e = new El(); els.set(id, e); } return e; };
  // As in the page's markup: every screen but the first is hidden until shown.
  for (const id of SECTIONS) if (id !== 's-loading') el(id).classList.add('hide');
  const document = {
    title: '', getElementById: el, createElement: (): El => new El(),
    querySelectorAll: (q: string): El[] => (q === 'section' ? SECTIONS.map(el) : q === '.choice' ? el('choices').children : []),
  };
  const href = `${PLAYER}?${new URLSearchParams({ endpoint: LRS, fetch: `${LMS}/cmi5/fetch/once`, actor: JSON.stringify(ACTOR), activityId: AU, registration: REG }).toString()}`;
  const location = { href, search: new URL(href).search };
  const window: Record<string, unknown> = { scrollTo: () => {}, localStorage: undefined, sessionStorage: undefined };
  for (const script of SCRIPTS) {
    // The drawing timers do nothing here; a timer the page waits on runs as it would.
    new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(window, document, location, lms.fetch, () => 0, () => {});
  }
  return {
    el, showing: () => SECTIONS.filter((id) => !el(id).hidden), choices: () => el('choices').children,
    settle: async (until) => { for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5)); if (!until()) throw new Error(`the page did not get there; showing ${SECTIONS.filter((id) => !el(id).hidden).join(',')}; chip "${el('chip').textContent}"; ${el('loadmsg').textContent}`); },
  };
}

const VOCAB: LaunchVocabulary = {
  turnVerb: scenario.xapi.verbs['turn']!, counterpartLineExt: scenario.xapi.extensions['counterpartLine']!,
  criterionKeyExt: scenario.xapi.extensions['criterionKey']!, rubricExt: scenario.xapi.extensions['rubric']!,
};
/** What the import is given for the sample scenario: its turn limit, its use, and its rubric's criteria and levels. */
const INPUT: ReadLaunchedInput = {
  registration: REG, endpoint: LRS, vocabulary: VOCAB, rubricHash: 'not-named-by-this-unit', scenarioVersionRef: scenario.rubricRef,
  spec: { turnLimit: scenario.turnLimit, assessmentUse: scenario.assessmentUse, rubric: { criteria: scenario.rubric.criteria.map((c) => ({ id: c.id, levels: c.levels.map((l) => ({ id: l.id, value: l.value })) })), passRule: null } } as unknown as ScenarioSpec,
};
const count = (lms: Lms, verb: string): number => lms.held.filter((s) => s.verb.id === verb).length;

describe('a practice closed part way, opened again, and read by the import', () => {
  it('is one conversation of the replies that were taken, in order', async () => {
    expect(SCRIPTS).toHaveLength(2);
    expect(BEST).toEqual([1, 1, 2, 0, 1]);
    const lms = new Lms();

    // The first visit: the learner agrees, takes two replies, and closes the page.
    const first = open(lms);
    await first.settle(() => first.showing().includes('s-welcome') && first.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
    first.el('go').onclick!(); first.el('agree').onclick!(); await first.el('consentyes').onclick!();
    expect(first.showing()).toEqual(['s-call']);
    first.choices()[BEST[0]!]!.onclick!();
    first.choices()[BEST[1]!]!.onclick!();
    await first.settle(() => count(lms, VOCAB.turnVerb) === 2);
    expect(first.el('stepword').textContent).toBe('Step 3 of 5');
    expect(lms.verbs()).toEqual(['launched', 'initialized', 'consented', 'took-turn', 'took-turn']);

    // Left like that, it is not a conversation the import takes: the session is still open.
    const open1 = readLaunchedCall(lms.held, INPUT);
    expect(open1).toHaveProperty('problems');
    expect((open1 as { problems: string[] }).problems.join(' | ')).toContain('it is still open');

    // The course is opened again. The LMS continues the session; the page loads afresh.
    const before = lms.held.length;
    const again = open(lms);
    await again.settle(() => again.showing().includes('s-call'));
    expect(again.el('stepword').textContent).toBe('Step 3 of 5');
    expect(again.el('heard').textContent).toContain('Carrying on from step 3');
    // Nothing was sent to get there: no second initialized, no second consent.
    expect(lms.held).toHaveLength(before);

    for (const i of BEST.slice(2)) again.choices()[i]!.onclick!();
    await again.settle(() => count(lms, VERB_TERMINATED) === 1);
    expect(again.showing()).toEqual(['s-results']);
    expect(lms.verbs()).toEqual(['launched', 'initialized', 'consented', 'took-turn', 'took-turn', 'took-turn', 'took-turn', 'took-turn', 'scored', 'scored', 'scored', 'scored', 'scored', 'terminated']);

    // What the learning record holds, read as the bridge's import reads it.
    const read = readLaunchedCall(lms.held, INPUT);
    if (!('call' in read)) throw new Error(`the import refused it: ${read.problems.join(' | ')}`);
    const { call } = read;
    const stages = scenario.personas[0]!.stages;
    // Five exchanges, each the reply that was taken at its step, in the order they were taken.
    expect(call.turns.filter((t) => t.speaker === 'learner').map((t) => t.text)).toEqual(BEST.map((i, n) => stages[n]!.choices[i]!.text));
    expect(call.turns.map((t) => t.speaker)).toEqual(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'counterpart' : 'learner')));
    // Every criterion scored once, at the top level: this was the best reply at every step.
    expect(call.scores.map((s) => s.criterionId)).toEqual(scenario.rubric.criteria.map((c) => c.id));
    expect(call.scores.map((s) => s.raw)).toEqual(scenario.rubric.criteria.map((c) => Math.max(...c.levels.map((l) => l.value))));
    expect(call.launchModeFrom).toBe('launched-statement');
    expect(call.unitSent).toEqual([]);
    expect(call.statementIds).toHaveLength(14);
    expect(Date.parse(call.startedAt)).toBeLessThan(Date.parse(call.endedAt));

    // Each exchange names its step and its reply by id, across both visits.
    const turns = lms.held.filter((s) => s.verb.id === VOCAB.turnVerb);
    expect(turns.map((s) => s.result!.extensions![scenario.xapi.extensions['replyId']!])).toEqual(BEST.map((i, n) => stages[n]!.choices[i]!.id));
    expect(turns.map((s) => s.object.definition!.extensions![scenario.xapi.extensions['stepId']!])).toEqual(stages.map((s) => s.id));
    // And every statement is in time order as it was stored, on the one clock both visits kept.
    expect(lms.held.every((s, i) => i === 0 || Date.parse(s.timestamp) >= Date.parse(lms.held[i - 1]!.timestamp))).toBe(true);
  });

  it('is refused when a second conversation is put in the session, which is what carrying on prevents', async () => {
    // What a reopening did before the player carried a practice on: the conversation began again.
    const lms = new Lms();
    const one = open(lms);
    await one.settle(() => one.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
    one.el('go').onclick!(); one.el('agree').onclick!(); await one.el('consentyes').onclick!();
    for (const i of BEST) one.choices()[i]!.onclick!();
    await one.settle(() => count(lms, VERB_TERMINATED) === 1);
    const whole = lms.held.slice();
    expect(readLaunchedCall(whole, INPUT)).toHaveProperty('call');
    // The same session with two more exchanges in it, numbered again from 1, as a restart wrote them.
    const restarted = whole.filter((s) => s.verb.id === VOCAB.turnVerb).slice(0, 2).map((s, i) => ({ ...s, id: `00000000-0000-4000-8000-00000000010${i}` }));
    const mixed = readLaunchedCall([...whole, ...restarted], INPUT);
    expect(mixed).toHaveProperty('problems');
    expect((mixed as { problems: string[] }).problems.join(' | ')).toContain(`over the scenario's limit of ${scenario.turnLimit}`);
    expect(count(lms, VERB_SCORED)).toBe(scenario.rubric.criteria.length);
  });
});
