/**
 * A practice opened again part way through, in the session the LMS kept open, is carried on from
 * where it stopped. It is not started again: the session would then hold two conversations, and
 * the review reads a session's exchanges as one.
 *
 * The page is not run in a browser here. Its play code (`take`, `pick`, `exchangesHeld`, `takeUp`)
 * and `carryOn` are cut from the page as text and run with the sample scenario. The first load's
 * statements are made by the page's own `pick`, so what the second load reads is what the first
 * would have written. The learning record, the screen and `finish` are stood in for.
 *
 * Not checked here: the page in a browser, and Practice Evidence's import of the finished session.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);
const page = readFileSync(new URL('index.html', DIR), 'utf8');
const cut = (from: string, to: string): string => {
  const a = page.indexOf(from), b = page.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`the player page no longer holds: ${a < 0 ? from : to}`);
  return page.slice(a, b);
};
type St = { verb: { id: string }; object: { id: string; definition?: { extensions?: Record<string, unknown> } }; result?: { response?: string; extensions?: Record<string, unknown> } };
interface Scenario {
  personas: { id: string; firstLine: string; stages: { choices: { text: string; best?: boolean }[] }[] }[];
  rubric: { criteria: { id: string }[] };
  xapi: { verbs: Record<string, string>; extensions: Record<string, string> };
  resultAfterReview?: boolean;
}
const scenario = JSON.parse(readFileSync(new URL('scenarios/double-charged-subscription.json', DIR), 'utf8')) as Scenario;
const V = scenario.xapi.verbs;
const AU = 'https://lms.example/au';

interface Load {
  /** Starts a practice as the consent button does, as the customer at `who`. */
  start(who: number): void;
  pick(i: number, said: string | null): void;
  carryOn(): Promise<boolean>;
  state(): { persona: string | null; stage: number; mood: number; picks: { i: number; said: string; stage: number }[] };
  sent: St[]; shown: string[]; finishes: number;
  title(): string; message(): string; note(): string;
}
/** One load of the page, opened on a session that holds `held`. `S` is the scenario it plays. */
const load = (held: St[], S: Scenario = scenario): Load => new Function('S', 'held', 'AU', `
  const X = S.xapi, CRITS = S.rubric.criteria, activityId = AU, t0 = Date.now();
  let persona = null, rec = null, listening = false, pending = null, trackErr = null, callStart = 0, sessionHeld = held;
  const sent = [], shown = [], els = {}, out = { finishes: 0 };
  const $ = (id) => els[id] || (els[id] = { textContent: '', classList: { add() {}, remove() {} } });
  const show = (id) => { shown.push(id); }, setChip = () => {}, iso = () => 'PT1S', L = (t) => ({ 'en-US': t }), SR = null;
  const lowVal = (c) => Math.min(...c.levels.map((l) => l.value)), topVal = (c) => Math.max(...c.levels.map((l) => l.value));
  const scenarioAct = () => ({ objectType: 'Activity', id: AU });
  const assess = (sc) => ({ points: sc.reduce((n, x) => n + x, 0), max: CRITS.reduce((n, c) => n + topVal(c), 0), pass: true, minTotal: 0, required: [] });
  const send = (verbKey, _label, object, result) => { const st = { verb: { id: X.verbs[verbKey] }, object, result }; sent.push(st); return Promise.resolve('id'); };
  ${cut('const STOP = new Set(', 'function listen(){')}
  ${cut('let sel = null, stage = 0', 'function evidence(ci){')}
  ${cut('function sendCompleted(){', '/* A practice already under way')}
  ${cut('async function carryOn(){', '// ---------- start ----------')}
  // The screen and the end of a practice are not what is checked here.
  renderStage = () => { $('heard').textContent = 'Tap the mic and say your reply, or tap one below.'; };
  const finish = async () => { out.finishes++; };
  return {
    start: (who) => { persona = S.personas[who]; sel = persona.id; mood = persona.startMood ?? 50; stage = 0; picks = []; variantAt = -1; },
    pick, carryOn, sent, shown,
    get finishes() { return out.finishes; },
    state: () => ({ persona: persona && persona.id, stage, mood, picks: picks.map((p) => ({ i: p.i, said: p.said, stage: p.stage })) }),
    title: () => $('rvtitle').textContent, message: () => $('rvmsg').textContent, note: () => $('heard').textContent,
  };
`)(S, held, AU) as Load;

const verb = (key: string): St => ({ verb: { id: V[key]! }, object: { id: AU } });
const turns = (sts: St[]): St[] => sts.filter((s) => s.verb.id === V['turn']);
const numbers = (sts: St[]): number[] => turns(sts).map((s) => Number(/\/turn\/(\d+)$/.exec(s.object.id)![1]));
/** The best reply at each step of the first customer, by position. */
const BEST = scenario.personas[0]!.stages.map((s) => s.choices.findIndex((c) => c.best));

describe('a practice opened again part way through', () => {
  it('has a best reply at every step of the sample, so the path below is the one the checks mean', () => {
    expect(BEST).toEqual([1, 1, 2, 0, 1]);
  });

  it('carries on at the next step, sends nothing to get there, and ends as one conversation', async () => {
    // The first load: two exchanges, the second one spoken. Then the page is closed.
    const first = load([]);
    first.start(0);
    first.pick(BEST[0]!, null);
    first.pick(BEST[1]!, 'I can see both two $19 charges on November 3rd orders bn4471 and bn4472 is that what you are seeing');
    expect(numbers(first.sent)).toEqual([1, 2]);
    const left = first.state();

    // The course is opened again. The LMS continues the session, which holds what the first load sent.
    const again = load([verb('initialized'), verb('consented'), ...first.sent]);
    expect(await again.carryOn()).toBe(true);
    expect(again.sent).toEqual([]);
    expect(again.shown).toEqual(['s-call']);
    expect(again.state()).toEqual(left);
    expect(again.note()).toBe('Carrying on from step 3, where you left off. Tap the mic and say your reply, or tap one below.');

    // The learner finishes it in this load.
    for (const i of BEST.slice(2)) again.pick(i, null);
    expect(again.finishes).toBe(1);
    // Across both loads the session holds exchanges 1 to 5, each once, and no second consent.
    expect(numbers([...first.sent, ...again.sent])).toEqual([1, 2, 3, 4, 5]);
    expect(again.sent.every((s) => s.verb.id === V['turn'])).toBe(true);
  });

  it('takes a spoken exchange up by the reply recorded beside it, not by matching its words again', async () => {
    const MATCHED = scenario.xapi.extensions['matchedReply']!;
    expect(MATCHED).toBe('https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/extensions/matched-or-tapped-reply');
    // Heard as two words only, and accepted by the learner as the best reply: the words alone name no reply.
    const first = load([]);
    first.start(0);
    first.pick(BEST[0]!, 'being charged');
    const [spoken] = turns(first.sent) as [St];
    expect(spoken.result).toEqual({ response: 'being charged', extensions: { [MATCHED]: scenario.personas[0]!.stages[0]!.choices[BEST[0]!]!.text } });
    const again = load([verb('initialized'), spoken]);
    expect(await again.carryOn()).toBe(true);
    expect(again.state().picks).toEqual([{ i: BEST[0], said: 'being charged', stage: 0 }]);
    expect(again.shown).toEqual(['s-call']);

    // An exchange from a scenario that records no reply beside the words: they are matched again. Words
    // that name no reply by any matching stop it there. (Which words those are depends on the matching.)
    const bare: Scenario = { ...scenario, xapi: { ...scenario.xapi, extensions: Object.fromEntries(Object.entries(scenario.xapi.extensions).filter(([k]) => k !== 'matchedReply')) } };
    const old = load([], bare);
    old.start(0);
    old.pick(BEST[0]!, 'the weather has been lovely');
    expect(turns(old.sent)[0]!.result).toEqual({ response: 'the weather has been lovely' });
    const stuck = load([verb('initialized'), ...turns(old.sent)], bare);
    expect(await stuck.carryOn()).toBe(true);
    expect(stuck.title()).toBe("This practice can't be carried on here");
    expect(stuck.sent).toEqual([]);

    // A recorded reply that is not one of the step's replies is not guessed at.
    const wrong = load([verb('initialized'), { ...spoken, result: { response: 'being charged', extensions: { [MATCHED]: 'Some other reply.' } } }]);
    expect(await wrong.carryOn()).toBe(true);
    expect(wrong.title()).toBe("This practice can't be carried on here");
  });

  it('carries on as the customer the earlier load was talking to, whoever that was', async () => {
    for (let who = 0; who < scenario.personas.length; who++) {
      const first = load([]);
      first.start(who);
      first.pick(0, null); first.pick(1, null);
      const again = load(first.sent);
      expect(await again.carryOn(), scenario.personas[who]!.id).toBe(true);
      expect(again.state()).toEqual(first.state());
      expect(again.state().persona).toBe(scenario.personas[who]!.id);
    }
  });

  it('goes on to the scores when every exchange was recorded and no score was', async () => {
    const first = load([]);
    first.start(0);
    for (const i of BEST) first.pick(i, null);
    expect(first.finishes).toBe(1);
    const again = load([verb('initialized'), ...turns(first.sent)]);
    expect(await again.carryOn()).toBe(true);
    expect(again.finishes).toBe(1);
    expect(again.sent).toEqual([]);
    expect(again.shown).toEqual([]);
  });

  it('starts nothing new when the practice was already finished, and ends a session left open', async () => {
    const first = load([]);
    first.start(0);
    for (const i of BEST) first.pick(i, null);
    const scored = scenario.rubric.criteria.map(() => verb('scored'));
    const open = load([verb('initialized'), ...turns(first.sent), ...scored]);
    expect(await open.carryOn()).toBe(true);
    expect(open.title()).toBe('Your practice is saved');
    expect(open.sent.map((s) => s.verb.id)).toEqual([V['terminated']]);
    expect(open.finishes).toBe(0);

    const ended = load([verb('initialized'), ...turns(first.sent), ...scored, verb('terminated')]);
    expect(await ended.carryOn()).toBe(true);
    expect(ended.sent).toEqual([]);
  });

  it('sends a result the earlier load scored and did not get to send, where the player decides it', async () => {
    // A scenario whose result is the player's own: completed follows the scores, and the page was closed between them.
    const own: Scenario = { ...scenario, resultAfterReview: false };
    const first = load([], own);
    first.start(0);
    for (const i of BEST) first.pick(i, null);
    const scored = scenario.rubric.criteria.map(() => verb('scored'));
    const again = load([verb('initialized'), ...turns(first.sent), ...scored], own);
    expect(await again.carryOn()).toBe(true);
    expect(again.sent.map((s) => s.verb.id)).toEqual([V['completed'], V['terminated']]);
    const completed = again.sent[0]!.result as { completion: boolean; score: { raw: number; max: number } };
    // Worked out from the recorded exchanges: the best path scores the top of every criterion.
    expect(completed.completion).toBe(true);
    expect(completed.score.raw).toBe(completed.score.max);
    expect(again.title()).toBe('Your practice is saved');

    // Its completed is there already: only the end of the session is sent. And never a second one.
    const had = load([verb('initialized'), ...turns(first.sent), ...scored, verb('completed')], own);
    expect(await had.carryOn()).toBe(true);
    expect(had.sent.map((s) => s.verb.id)).toEqual([V['terminated']]);

    // The scores are there and the exchanges that would give the result are not all there: nothing is sent.
    const short = load([verb('initialized'), ...turns(first.sent).slice(0, 3), ...scored], own);
    expect(await short.carryOn()).toBe(true);
    expect(short.title()).toBe("This practice can't be carried on here");
    expect(short.sent).toEqual([]);

    // Where a reviewer decides the result, no completed is ever sent from here.
    const reviewed = load([verb('initialized'), ...turns(first.sent), ...scored]);
    expect(scenario.resultAfterReview).toBe(true);
    expect(await reviewed.carryOn()).toBe(true);
    expect(reviewed.sent.map((s) => s.verb.id)).toEqual([V['terminated']]);
  });

  it('sends nothing and starts nothing when what the session holds cannot be carried on', async () => {
    const first = load([]);
    first.start(0);
    first.pick(BEST[0]!, null); first.pick(BEST[1]!, null); first.pick(BEST[2]!, null);
    const [one, two, three] = turns(first.sent) as [St, St, St];
    const cases: [string, St[], string][] = [
      ['only some of the scores', [one, two, verb('scored')], 'only some of its scores were saved'],
      ['an exchange missing from the middle', [one, three], 'its exchanges could not be read in order'],
      ['the same exchange twice', [one, one, two], 'its exchanges could not be read in order'],
      ['a line this scenario does not have', [{ ...one, object: { id: one.object.id, definition: { extensions: { [scenario.xapi.extensions['counterpartLine']!]: 'Hello, is this the bakery?' } } } }], 'its exchanges are not ones this scenario has'],
      ['a reply this scenario does not have', [{ ...one, result: { response: 'The weather has been lovely this week.' } }], 'its exchanges are not ones this scenario has'],
      ['more exchanges than the scenario has steps', [...turns((() => { const l = load([]); l.start(0); for (const i of BEST) l.pick(i, null); return l.sent; })()), { ...one, object: { ...one.object, id: `${AU}/turn/6` } }], 'its exchanges are not ones this scenario has'],
    ];
    for (const [name, held, why] of cases) {
      const again = load([verb('initialized'), ...held]);
      expect(await again.carryOn(), name).toBe(true);
      expect(again.title(), name).toBe("This practice can't be carried on here");
      expect(again.message(), name).toContain(why);
      expect(again.sent, name).toEqual([]);
      expect(again.finishes, name).toBe(0);
      expect(again.state().picks, name).toEqual([]);
    }
  });

  it('leaves a session with no exchange in it to start a practice as before', async () => {
    for (const held of [[], [verb('initialized')], [verb('initialized'), verb('consented')]]) {
      const l = load(held);
      expect(await l.carryOn()).toBe(false);
      expect(l.shown).toEqual([]);
      expect(l.sent).toEqual([]);
    }
  });
});
