/**
 * The role-play player published under docs/ is an assignable unit whose statements Practice
 * Evidence takes as an attempt (pev.import_launched_attempt). The player is one page with no build
 * and is not run here. What is checked is the scenario it plays and the page's own text: that what
 * the player is told to write is what the import reads.
 *
 * Not checked here: the page running in a browser. That was done by hand against a loopback
 * stand-in LMS when the player was changed, and is not repeated by this suite.
 *
 * One part of the page is run: the code that sends a reviewed result. It is cut from the page's own
 * script, with the page's clock and comparison, and run against a stand-in learning record.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scenarioVersionRef, VERB_SCORED } from '../src/launched-import.js';

const DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');

interface Level { id: string; value: number }
interface Criterion { id: string; xapiKey?: string; levels: Level[] }
interface Choice { text: string; effects?: Record<string, number> }
interface Stage { lines?: string[]; choices: Choice[]; variant?: { line: string; choices: Choice[] } }
interface Scenario {
  resultAfterReview?: boolean; rubricRef?: string; turnLimit: number; assessmentUse: string;
  practiceEvidenceScenario?: { iri: string; version: number };
  rubric: { criteria: Criterion[] };
  personas: { id: string; firstLine?: string; stages: Stage[] }[];
  xapi: { profile: string; profileVersion: string; verbs: Record<string, string>; extensions: Record<string, string> };
}

const player = JSON.parse(read('player.json')) as { defaultScenario: string };
const scenario = JSON.parse(read(player.defaultScenario)) as Scenario;
const page = read('index.html');

describe('the scenario the published role-play player plays', () => {
  it('leaves its result to a reviewer and names the scenario version its scores are against', () => {
    expect(scenario.resultAfterReview).toBe(true);
    const pe = scenario.practiceEvidenceScenario!;
    expect(pe.iri).toMatch(/^urn:pev:scenario:[0-9a-f]{16}$/);
    // The form the import accepts in the rubric extension: the version, not a hash the author may not be shown.
    expect(scenario.rubricRef).toBe(scenarioVersionRef(pe.iri, pe.version));
  });

  it('names the profile terms the import is set up to read, under one profile version', () => {
    const x = scenario.xapi;
    expect(x.profileVersion).toBe(`${x.profile}/v/3`);
    expect(x.verbs['turn']).toBe(`${x.profile}/verbs/took-turn`);
    expect(x.verbs['scored']).toBe(VERB_SCORED);
    expect(x.extensions['counterpartLine']).toBe(`${x.profile}/extensions/customer-line`);
    expect(x.extensions['criterionKey']).toBe(`${x.profile}/extensions/criterion-key`);
    expect(x.extensions['rubric']).toBe(`${x.profile}/extensions/rubric`);
  });

  it('scores each criterion under its own id, to a whole level value', () => {
    const ids = scenario.rubric.criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of scenario.rubric.criteria) {
      // The key written is `xapiKey || id`. A second spelling would not match the rubric's criterion.
      expect(c.xapiKey).toBeUndefined();
      expect(c.id).toBe(c.id.toLowerCase());
      const values = c.levels.map((l) => l.value);
      expect(values.every((v) => Number.isInteger(v))).toBe(true);
      // The player sums whole effects and clamps to the lowest and highest value, so every score it
      // can reach has to be a level: the values run without a gap.
      const sorted = [...values].sort((a, b) => a - b);
      expect(sorted).toEqual(sorted.map((_, i) => sorted[0]! + i));
    }
    for (const p of scenario.personas) {
      for (const s of p.stages) {
        for (const ch of [...s.choices, ...(s.variant?.choices ?? [])]) {
          for (const [criterion, effect] of Object.entries(ch.effects ?? {})) {
            expect(ids).toContain(criterion);
            expect(Number.isInteger(effect)).toBe(true);
          }
        }
      }
    }
  });

  it('never runs longer than the scenario version allows, and every exchange has a line to answer', () => {
    for (const p of scenario.personas) {
      expect(p.stages.length).toBeGreaterThan(0);
      expect(p.stages.length).toBeLessThanOrEqual(scenario.turnLimit);
      expect((p.firstLine ?? '').length).toBeGreaterThan(0);
      p.stages.forEach((s, i) => {
        if (i > 0) expect((s.lines ?? []).filter((l) => l.length > 0)).toHaveLength(3);
        expect(s.choices.length).toBeGreaterThan(0);
      });
    }
  });
});

describe('the published role-play player page', () => {
  it('writes an exchange with the line on the activity and the answer in result.response', () => {
    expect(page).toContain('extensions:{[X.extensions.counterpartLine]: s.line}');
    expect(page).toContain('const res = {response: said || c.text};');
    expect(page).toContain('send("turn", "took a turn"');
  });

  it('puts the rubric it scored against on every statement', () => {
    expect(page).toContain('if (X.extensions.rubric && S.rubricRef) ext[X.extensions.rubric] = S.rubricRef;');
  });

  it('sends no completed of its own where the result is a reviewer\'s, and asks the LMS for the reviewed one', () => {
    expect(page).toContain('if (!deferred) send("completed", "completed"');
    expect(page).toContain('new URL("/cmi5/reviewed", cfg.lrs)');
    // The cmi5 credential goes to the LMS as a Bearer; the LRS takes the same token as Basic.
    expect(page).toContain('"Bearer " + cfg.authorization.replace(/^Basic\\s+/, "")');
    // It stops at the first reviewed statement the LRS does not take, and ends the session only when all were taken.
    expect(page).toContain('if (o !== "sent" && o !== "already") break;');
    // A practice starts only when the LMS says nothing is under review; not being able to ask is its own state.
    expect(page).toContain('return {state:"unknown", why: "the LMS could not be reached"};');
    expect(page).toContain('if (got.state === "unknown") return reviewUnknown(got);');
    // An id the LRS already holds counts only when what it holds says everything the issued statement says.
    expect(page).toContain('return holds(stored, restIssued) && (ti === undefined || sameInstant(ts, ti));');
    // Nothing reviewed is sent before the LRS has taken this session's initialized.
    expect(page).toContain('sessionOpened = (await send("initialized", "initialized", scenarioAct(), null, true, false, visitStart)) !== null;');
    // Trying again sends the same initialized, id and time included, and an id the LRS already holds counts once.
    expect(page).toContain('const st = (keep && keep.st) || {id: uuid()');
    expect(page).toContain('if (r.status === 409 && keep) {');
    expect(page.indexOf('if (!sessionOpened) {\n    $("rvtitle")')).toBeLessThan(page.indexOf('o = await postReviewed(st)'));
    // It does not claim to know what happened in the visit the result was issued for.
    expect(page).toContain('It may already be in your learning record from that visit.');
    expect(page).not.toContain('that ended before it was recorded');
    // It never writes a verb cmi5 keeps for the LMS.
    for (const verb of ['verbs/launched', 'verbs/abandoned', 'verbs/waived', 'verbs/satisfied']) expect(page).not.toContain(verb);
  });
});

describe('how the player sends a reviewed result', () => {
  const page = read('index.html');
  const cut = (from: string, to: string): string => {
    const a = page.indexOf(from), b = page.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`the player page no longer holds: ${a < 0 ? from : to}`);
    return page.slice(a, b);
  };
  /** The player's own clock, comparison and sending code, run against a stand-in learning record. */
  const player = (lrs: Lrs) => new Function('fetch', 'cfg',
    cut('let lastTs = 0;', '/* `keep`, when given') + cut('function holds(stored, issued){', 'let sessionOpened = false;')
    + '; return { postReviewed, nextTs };')(lrs.fetch, { lrs: 'https://lrs.example/xapi', authorization: 'Basic token' }) as {
      postReviewed(st: Record<string, unknown>): Promise<string>; nextTs(): string;
    };
  /** Stores a statement by id; a second, different one under the same id is a 409, as in xAPI. */
  class Lrs {
    readonly held = new Map<string, Record<string, unknown>>();
    readonly posts: Record<string, unknown>[] = [];
    loseNextAnswer = false;
    readonly fetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
      if (init?.method === 'POST') {
        const st = JSON.parse(String(init.body)) as Record<string, unknown>;
        this.posts.push(st);
        const id = String(st['id']), held = this.held.get(id);
        if (held) return JSON.stringify(held) === JSON.stringify(st) ? new Response(null, { status: 204 }) : new Response('', { status: 409 });
        this.held.set(id, st);
        if (this.loseNextAnswer) { this.loseNextAnswer = false; throw new Error('connection reset'); }
        return new Response('["' + id + '"]', { status: 200 });
      }
      const id = new URL(url).searchParams.get('statementId') ?? '';
      const held = this.held.get(id);
      return held ? new Response(JSON.stringify({ ...held, stored: '2026-11-17T16:05:00.000Z', authority: { objectType: 'Agent' } }), { status: 200 }) : new Response('', { status: 404 });
    };
  }
  const issued = (verb: string): Record<string, unknown> => ({
    id: verb === 'completed' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` }, result: verb === 'completed' ? { completion: true } : { success: verb === 'passed' },
    context: { registration: '33333333-3333-4333-8333-333333333333' },
  });

  it('stamps each statement after the visit\'s initialized, in order, for failed and completed and for passed and completed', async () => {
    for (const outcome of ['failed', 'passed']) {
      const lrs = new Lrs(), p = player(lrs);
      const initialized = p.nextTs();
      const first = issued(outcome), second = issued('completed');
      expect(await p.postReviewed(first)).toBe('sent');
      expect(await p.postReviewed(second)).toBe('sent');
      const terminated = p.nextTs();
      const times = [initialized, lrs.posts[0]!['timestamp'], lrs.posts[1]!['timestamp'], terminated].map((t) => Date.parse(String(t)));
      expect(times.every((t) => Number.isFinite(t))).toBe(true);
      // Strictly after initialized and strictly before terminated, on the one clock that stamps all four.
      expect(times[0]!).toBeLessThan(times[1]!);
      expect(times[1]!).toBeLessThan(times[2]!);
      expect(times[2]!).toBeLessThan(times[3]!);
    }
  });

  it('sends the same document on a retry, and takes one the record already holds as recorded', async () => {
    const lrs = new Lrs(), p = player(lrs);
    const st = issued('failed');
    // The record stored it and the answer was lost.
    lrs.loseNextAnswer = true;
    await expect(p.postReviewed(st)).rejects.toThrow('connection reset');
    const stamp = st['timestamp'];
    expect(typeof stamp).toBe('string');
    // Trying again sends the very same statement, stamp included, and the record has it.
    expect(await p.postReviewed(st)).toBe('sent');
    expect(lrs.posts.map((x) => x['timestamp'])).toEqual([stamp, stamp]);
    expect(lrs.held.size).toBe(1);
  });

  it('takes a statement an earlier visit of the session sent, at its own moment, as this result recorded', async () => {
    const lrs = new Lrs();
    const earlier = player(lrs), fetched = issued('failed');
    expect(await earlier.postReviewed(fetched)).toBe('sent');
    // The page is opened again in the same session and fetches the result again: same id, no timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const again = player(lrs), refetched = issued('failed');
    expect(await again.postReviewed(refetched)).toBe('already');
    expect(refetched['timestamp']).not.toBe(fetched['timestamp']);
    expect(lrs.held.get(String(fetched['id']))!['timestamp']).toBe(fetched['timestamp']);
  });

  it('does not take a different result under the same id as this one', async () => {
    const lrs = new Lrs(), p = player(lrs);
    expect(await p.postReviewed(issued('failed'))).toBe('sent');
    await new Promise((r) => setTimeout(r, 5));
    const other = { ...issued('failed'), result: { success: true } };
    expect(await player(lrs).postReviewed(other)).toBe('differs');
  });

  it('sends a statement that comes with a timestamp as it came, and compares it whole', async () => {
    const lrs = new Lrs(), p = player(lrs);
    const dated = { ...issued('completed'), timestamp: '2026-11-17T15:00:34.854Z' };
    expect(await p.postReviewed(dated)).toBe('sent');
    expect(lrs.posts[0]!['timestamp']).toBe('2026-11-17T15:00:34.854Z');
    // The same id held with another timestamp is then a different statement.
    expect(await player(lrs).postReviewed({ ...issued('completed'), timestamp: '2026-11-17T15:00:35.000Z' })).toBe('differs');
  });
});

describe('how the player opens a visit in a session that may already be open', () => {
  const page = read('index.html');
  const cut = (from: string, to: string): string => {
    const a = page.indexOf(from), b = page.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error(`the player page no longer holds: ${a < 0 ? from : to}`);
    return page.slice(a, b);
  };
  const SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
  const INITIALIZED = 'http://adlnet.gov/expapi/verbs/initialized';
  const REG = '33333333-3333-4333-8333-333333333333', SESSION = '44444444-4444-4444-8444-444444444444';
  type St = Record<string, unknown>;
  const stored = (verb: string, timestamp: string, session = SESSION, more: St = {}): St => ({
    id: `id-${verb}-${timestamp}`, verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` }, timestamp,
    context: { registration: REG, extensions: { [SESSION_EXT]: session } }, ...more,
  });
  /** A learning record holding `held`; `read` decides how a read of the registration is answered. */
  class Lrs {
    readonly posts: St[] = [];
    readonly reads: string[] = [];
    more = '';
    readStatus = 200;
    /** When set, a read of the registration is answered a page at a time, this many statements each. */
    pageSize = 0;
    constructor(readonly held: St[]) {}
    readonly fetch = async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
      if (init?.method === 'POST') {
        const st = JSON.parse(String(init.body)) as St;
        this.posts.push(st);
        const same = this.held.find((h) => h['id'] === st['id']);
        if (same) return new Response('', { status: 409 });
        this.held.push(st);
        return new Response('[]', { status: 200 });
      }
      const u = new URL(url);
      const id = u.searchParams.get('statementId');
      if (id) { const h = this.held.find((x) => x['id'] === id); return h ? new Response(JSON.stringify(h), { status: 200 }) : new Response('', { status: 404 }); }
      if (this.readStatus !== 200) return new Response('', { status: this.readStatus });
      this.reads.push(u.pathname + u.search);
      expect(u.origin).toBe('https://lrs.example');
      if (this.pageSize > 0) {
        const from = Number(u.searchParams.get('from') ?? '0'), to = from + this.pageSize;
        if (from === 0) expect(u.searchParams.get('registration')).toBe(REG);
        return new Response(JSON.stringify({ statements: this.held.slice(from, to), more: to < this.held.length ? `/xapi/statements?from=${to}` : '' }), { status: 200 });
      }
      expect(u.searchParams.get('registration')).toBe(REG);
      return new Response(JSON.stringify({ statements: this.held, more: this.more }), { status: 200 });
    };
  }
  /** The page's own clock, comparison, sending and opening code, with the page's `send` stood in for by one that posts. */
  const visit = (lrs: Lrs) => new Function('fetch', 'cfg', 'registration', 'X', 'scenarioAct', `
    let chain = Promise.resolve(), trackErr = null;
    ${cut('let lastTs = 0;', '/* `keep`, when given')}
    const send = async (verbKey, verbLabel, object, result, cmi5, parent, keep) => {
      const st = (keep && keep.st) || { id: 'id-' + verbKey + '-' + Math.random(), verb: { id: X.verbs[verbKey] }, timestamp: nextTs(), context: { registration, extensions: cfg.contextTemplate.extensions } };
      if (keep) keep.st = st;
      const r = await fetch(cfg.lrs + '/statements', { method: 'POST', body: JSON.stringify(st) });
      return r.ok ? st.id : null;
    };
    ${cut('function holds(stored, issued){', 'async function recordReviewed(got, again){')}
    // What begin touches of the page besides the above: the screens, and the LMS's answer that no review is waiting.
    const shown = [], els = {};
    const $ = (id) => els[id] || (els[id] = { textContent: '', disabled: false, onclick: null, classList: { add() {}, remove() {} } });
    const show = (id) => { shown.push(id); }, setChip = () => {}, P = {}, window = { __rolePlay: {} };
    const askReviewed = async () => ({ state: 'none' }), recordReviewed = async () => {}, reviewUnknown = () => {};
    ${cut('async function begin(){', '// ---------- start ----------')}
    return { openVisit, postReviewed, nextTs, why: () => trackErr, begin, shown, message: () => $('rvmsg').textContent, tryAgain: () => $('rvretry').onclick(),
      failQueue: (why) => { chain = Promise.reject(new Error(why)); chain.catch(() => {}); trackErr = why; }, queueOpen: () => chain.then(() => true, () => false) };
  `)(lrs.fetch, { lrs: 'https://lrs.example/xapi', authorization: 'Basic token', contextTemplate: { extensions: { [SESSION_EXT]: SESSION } } },
    REG, { verbs: { initialized: INITIALIZED } }, () => ({ objectType: 'Activity', id: 'https://lms.example/au' })) as {
      openVisit(): Promise<boolean>; postReviewed(st: St): Promise<string>; nextTs(): string; why(): string | null;
      begin(): Promise<void>; shown: string[]; message(): string; tryAgain(): Promise<void>;
      failQueue(why: string): void; queueOpen(): Promise<boolean>;
    };
  const outcome = (verb: string): St => ({ id: `id-outcome-${verb}`, verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` }, result: { success: verb === 'passed' }, context: { registration: REG } });
  const initializedIn = (lrs: Lrs, session = SESSION): number =>
    lrs.held.filter((s) => (s['verb'] as { id: string }).id === INITIALIZED && ((s['context'] as { extensions: St }).extensions)[SESSION_EXT] === session).length;

  it('sends initialized once in a session the record holds nothing of but the launch', async () => {
    const lrs = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z')]);
    const v = visit(lrs);
    expect(await v.openVisit()).toBe(true);
    expect(await v.openVisit()).toBe(true);
    expect(initializedIn(lrs)).toBe(1);
    // After the launch the LMS recorded, though that was stamped on another clock.
    expect(Date.parse(String(lrs.posts[0]!['timestamp']))).toBeGreaterThan(Date.parse('2026-11-17T16:04:39.000Z'));
  });

  it('opens the same session again without a second initialized, and carries on after what it sent before', async () => {
    // An earlier load of the page sent initialized and the first outcome, then the page was closed.
    // The record's times are ahead of this machine's clock, as another clock's can be.
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString(), later = new Date(Date.now() + 10 * 60_000 + 500).toISOString();
    const lrs = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z'), stored('initialized', ahead), { ...outcome('failed'), timestamp: later, context: { registration: REG, extensions: { [SESSION_EXT]: SESSION } } }]);
    const v = visit(lrs);
    expect(await v.openVisit()).toBe(true);
    // Nothing was sent to open it: the session has its initialized.
    expect(lrs.posts).toEqual([]);
    expect(initializedIn(lrs)).toBe(1);
    // The outcome the earlier load sent is found recorded; the one it did not reach is sent, after it.
    expect(await v.postReviewed(outcome('failed'))).toBe('already');
    const completed: St = { ...outcome('completed'), result: { completion: true } };
    expect(await v.postReviewed(completed)).toBe('sent');
    expect(Date.parse(String(completed['timestamp']))).toBeGreaterThan(Date.parse(later));
    expect(Date.parse(v.nextTs())).toBeGreaterThan(Date.parse(String(completed['timestamp'])));
  });

  it('does not count another session of the registration as this one', async () => {
    const earlier = '55555555-5555-4555-8555-555555555555';
    const lrs = new Lrs([stored('initialized', '2026-11-17T14:56:57.000Z', earlier), stored('terminated', '2026-11-17T14:57:33.000Z', earlier), stored('launched', '2026-11-17T16:04:39.000Z')]);
    expect(await visit(lrs).openVisit()).toBe(true);
    expect([initializedIn(lrs), initializedIn(lrs, earlier)]).toEqual([1, 1]);
  });

  it('sends nothing when the record cannot be read, or cannot be read whole', async () => {
    const refused = new Lrs([stored('initialized', '2026-11-17T16:04:43.000Z')]);
    refused.readStatus = 503;
    const v = visit(refused);
    expect(await v.openVisit()).toBe(false);
    expect(refused.posts).toEqual([]);
    expect(v.why()).toBe('the learning record could not be read');
    // Read again once it answers: the initialized is there, and none is sent.
    refused.readStatus = 200;
    expect(await v.openVisit()).toBe(true);
    expect(refused.posts).toEqual([]);

    // A link to more that leads off the record's own origin is not followed.
    const elsewhere = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z')]);
    elsewhere.more = 'https://elsewhere.example/xapi/statements?cursor=next';
    expect(await visit(elsewhere).openVisit()).toBe(false);
    expect([elsewhere.posts, elsewhere.reads.length]).toEqual([[], 1]);
  });

  it("follows the record's own link through a long registration, and finds an initialized on a later page", async () => {
    // Newest first, as a record answers: this session's launch, then older statements, then its initialized.
    const filler = Array.from({ length: 5 }, (_, i) => stored('answered', `2026-11-17T14:57:0${i}.000Z`, '55555555-5555-4555-8555-555555555555'));
    const lrs = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z'), ...filler, stored('initialized', '2026-11-17T16:04:43.000Z')]);
    lrs.pageSize = 3;
    const v = visit(lrs);
    expect(await v.openVisit()).toBe(true);
    expect(lrs.posts).toEqual([]);
    expect(lrs.reads).toHaveLength(3);
    // The clock is past the initialized that was on the last page.
    expect(Date.parse(v.nextTs())).toBeGreaterThan(Date.parse('2026-11-17T16:04:43.000Z'));
  });

  it('gives up without writing when a registration is longer than it reads, and does so the same way each time', async () => {
    const lrs = new Lrs(Array.from({ length: 12 }, (_, i) => stored('answered', `2026-11-17T14:57:${String(10 + i)}.000Z`)));
    lrs.pageSize = 2;
    const v = visit(lrs);
    expect(await v.openVisit()).toBe(false);
    expect(await v.openVisit()).toBe(false);
    expect(lrs.posts).toEqual([]);
    // Five pages each time, and no more.
    expect(lrs.reads).toHaveLength(10);
    expect(v.why()).toBe('the learning record could not be read');
  });

  it('starts a practice with one initialized, and with none when the session already has one', async () => {
    // A first load: the record holds the LMS's launch and nothing else of this session.
    const first = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z')]);
    const a = visit(first);
    await a.begin();
    expect(initializedIn(first)).toBe(1);
    expect(a.shown).toEqual(['s-welcome']);

    // The course is opened again part way through that practice. The LMS continues the session, and
    // the page loads afresh: the record holds its initialized, a consent and two exchanges.
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    const again = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z'), stored('initialized', '2026-11-17T16:04:43.000Z'),
      stored('consented', '2026-11-17T16:05:00.000Z'), stored('answered', '2026-11-17T16:05:20.000Z'), stored('answered', ahead)]);
    const b = visit(again);
    await b.begin();
    expect(again.posts).toEqual([]);
    expect(initializedIn(again)).toBe(1);
    expect(b.shown).toEqual(['s-welcome']);
    // What this load sends next sorts after what the earlier load sent, though that was ahead of this clock.
    expect(Date.parse(b.nextTs())).toBeGreaterThan(Date.parse(ahead));
  });

  it('starts no practice when the record cannot be read, and starts one on a later try', async () => {
    const lrs = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z'), stored('initialized', '2026-11-17T16:04:43.000Z')]);
    lrs.readStatus = 503;
    const v = visit(lrs);
    await v.begin();
    expect(lrs.posts).toEqual([]);
    expect(v.shown).toEqual(['s-reviewed']);
    expect(v.message()).toContain('so no practice was started');
    lrs.readStatus = 200;
    await v.tryAgain();
    expect(lrs.posts).toEqual([]);
    expect(initializedIn(lrs)).toBe(1);
    expect(v.shown).toEqual(['s-reviewed', 's-welcome']);
    // The earlier failure is not left standing once the visit is open.
    expect(v.why()).toBeNull();
  });

  it('sends again after a try whose initialized was stored and whose answer was lost', async () => {
    // The record took initialized, the answers never arrived, and the send gave up: the queue that
    // every later statement waits on is failed, and the page holds the reason.
    const lrs = new Lrs([stored('launched', '2026-11-17T16:04:39.000Z'), stored('initialized', '2026-11-17T16:04:43.000Z')]);
    const v = visit(lrs);
    v.failQueue('Failed to fetch');
    expect(await v.queueOpen()).toBe(false);
    await v.begin();
    // The session has its initialized, so none is sent, and what follows is not held up behind the failed send.
    expect(lrs.posts).toEqual([]);
    expect(v.shown).toEqual(['s-welcome']);
    expect(await v.queueOpen()).toBe(true);
    expect(v.why()).toBeNull();
  });

  it('has one place that sends initialized', () => {
    expect(page.split('send("initialized"').length - 1).toBe(1);
  });
});
