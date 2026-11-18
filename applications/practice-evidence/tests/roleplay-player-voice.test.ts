/**
 * How the role-play player hears a spoken reply and decides which written reply it is.
 *
 * The page is not run in a browser here. Two parts of its script are cut from the page as text and
 * run: the matching (`toks`, `bestMatch`) against the sample scenario's own replies, and `listen`
 * against a stand-in speech recogniser whose results this file decides. What a real recogniser
 * returns for real speech is not checked here; `tools/voice-check.mjs` does that by hand.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);
const source = readFileSync(new URL('index.html', DIR), 'utf8');
const cut = (from: string, to: string): string => {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`the player page no longer holds: ${a < 0 ? from : to}`);
  return source.slice(a, b);
};
interface Choice { text: string }
interface Stage { choices: Choice[]; variant?: { choices: Choice[] } }
const scenario = JSON.parse(readFileSync(new URL('scenarios/double-charged-subscription.json', DIR), 'utf8')) as { personas: { stages: Stage[] }[] };
const MATCHING = cut('const STOP = new Set(', 'const LISTEN_QUIET_MS');
const bestMatch = new Function(`${MATCHING}; return bestMatch;`)() as (said: string, choices: Choice[]) => number;

/** The first customer's five steps: the replies the checks below speak to. */
const steps = scenario.personas[0]!.stages.map((s) => s.choices);
const [opening, confirming, refunding, goodwill, closing] = steps as [Choice[], Choice[], Choice[], Choice[], Choice[]];

describe('which reply a learner\'s spoken words are', () => {
  it('matches every reply in the scenario to itself when it is said whole', () => {
    const sets = scenario.personas.flatMap((p) => p.stages.flatMap((s) => (s.variant ? [s.choices, s.variant.choices] : [s.choices])));
    expect(sets.length).toBeGreaterThan(20);
    for (const choices of sets) choices.forEach((c, i) => expect(bestMatch(c.text, choices), c.text).toBe(i));
  });

  it('does not take the first words of a reply for the reply', () => {
    // What Chrome's recogniser returned on 2026-11-18 when it stopped at a pause.
    expect(bestMatch('to recap', closing)).toBe(-1);
    expect(bestMatch('I can see both', confirming)).toBe(-1);
    expect(bestMatch('refund', refunding)).toBe(-1);
    // Said through, as recognised, they are the reply.
    expect(bestMatch('the duplicate 19.00 from order bien 4472 is refunded today and posts in 5 to 7 business days', closing)).toBe(1);
    expect(bestMatch('yes I see two charges of $19 on November 3rd orders bn4471 and bn4472 is that right', confirming)).toBe(1);
  });

  it('does not take the opposite of a reply for the reply', () => {
    expect(bestMatch("I'm refunding the duplicate $19 today", refunding)).toBe(2);
    expect(bestMatch('I cannot refund the duplicate today', refunding)).toBe(-1);
    expect(bestMatch("I can't refund that today it will post to your card in 5 to 7 business days", refunding)).toBe(-1);
    expect(bestMatch('I am not refunding the duplicate $19 today', refunding)).toBe(-1);
  });

  it('still matches a reply that has a negative in passing, said with it or without', () => {
    expect(goodwill[0]!.text).toContain("shouldn't");
    expect(bestMatch("you shouldn't have had to deal with this", goodwill)).toBe(0);
    expect(bestMatch("I've added a free month to your account to say sorry", goodwill)).toBe(0);
  });

  it('matches a reply said in other words when enough of its words are there, and nothing when they are not', () => {
    expect(bestMatch('I put the second $19 charge back on your card today and you should see it within a week', refunding)).toBe(2);
    expect(bestMatch("I'm so sorry you were charged twice let's fix that right now", opening)).toBe(1);
    expect(bestMatch('the weather has been lovely this week', opening)).toBe(-1);
    // Other words entirely: not matched. The learner taps a reply.
    expect(bestMatch('your money is coming back this afternoon', refunding)).toBe(-1);
  });

  it('offers neither of two replies the words fit equally', () => {
    const twins = [{ text: 'I will refund the duplicate charge today' }, { text: 'I will refund the duplicate charge today' }, { text: 'Please hold for a manager' }];
    expect(bestMatch('I will refund the duplicate charge today', twins)).toBe(-1);
    expect(bestMatch('please hold for a manager', twins)).toBe(2);
  });

  it('still takes the first third of a reply for the reply: words in order are not checked', () => {
    // Written down so the limit is not mistaken for something this matching settles.
    expect(bestMatch("I'm refunding the duplicate", refunding)).toBe(2);
  });
});

describe('how the player listens to a spoken reply', () => {
  interface Result { isFinal: boolean; 0: { transcript: string } }
  /** A recogniser that hears what the test says it hears. */
  class Recogniser {
    static last: Recogniser | null = null;
    continuous = false; interimResults = false; lang = ''; maxAlternatives = 0; stopped = false; ended = false;
    onresult: ((e: { resultIndex: number; results: Result[] }) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    private readonly results: Result[] = [];
    constructor() { Recogniser.last = this; }
    start(): void { /* listening */ }
    /** As a browser does: a stop settles nothing new here, and ends the recognition. */
    stop(): void { this.stopped = true; this.end(); }
    aborted = false;
    /** An abort whose error and end are still to come: the test delivers them when it chooses. */
    abort(): void { this.aborted = true; }
    hear(transcript: string, isFinal: boolean): void {
      // A settled result takes the place of the unsettled one before it, as in the browser.
      if (this.results.length > 0 && !this.results[this.results.length - 1]!.isFinal) this.results.pop();
      this.results.push({ isFinal, 0: { transcript } });
      this.onresult?.({ resultIndex: this.results.length - 1, results: this.results });
    }
    fail(error: string): void { this.onerror?.({ error }); this.end(); }
    end(): void { if (!this.ended) { this.ended = true; this.onend?.(); } }
  }
  interface El { textContent: string; innerHTML: string; className: string; style: Record<string, string>; onclick: (() => void) | null; children: El[]; classes: Set<string>; classList: { add(c: string): void; remove(c: string): void }; appendChild(e: El): void }
  const el = (): El => {
    const classes = new Set<string>(), children: El[] = [];
    let text = '';
    const e: El = { get textContent() { return text; }, set textContent(v: string) { text = v; children.length = 0; }, get innerHTML() { return ''; }, set innerHTML(_v: string) { text = ''; children.length = 0; },
      className: '', style: {}, onclick: null, children, classes, classList: { add: (c) => { classes.add(c); }, remove: (c) => { classes.delete(c); } }, appendChild: (c) => { children.push(c); } };
    return e;
  };
  /** The page's `listen`, with the page around it stood in for: the screen, the step's replies, and `pick`. */
  const player = (choices: Choice[]) => {
    const els: Record<string, El> = {}, choiceEls = choices.map(() => el()), picked: { i: number; said: string }[] = [];
    const $ = (id: string): El => (els[id] ??= el());
    const document = { querySelectorAll: (q: string): El[] => (q === '.choice' ? choiceEls : []), createElement: (): El => el() };
    const page = new Function('SR', '$', 'document', 'window', 'stageObj', 'pick', 'S', 'setTimeout', 'clearTimeout', `
      let rec = null, listening = false, pending = null;
      ${MATCHING}
      ${cut('const LISTEN_QUIET_MS', '// ---------- play ----------')}
      return { listen, hangUp };
    `)(Recogniser, $, document, {}, () => ({ choices }), (i: number, said: string) => { picked.push({ i, said }); }, { language: 'en-US' }, setTimeout, clearTimeout) as { listen(): void; hangUp(): void };
    const { listen, hangUp } = page;
    return {
      listen, hangUp, picked,
      heard: (): string => $('heard').textContent || ($('heard').children[0]?.textContent ?? ''),
      micLive: (): boolean => $('mic').classes.has('live'),
      offered: (): El | undefined => $('heard').children.find((c) => c.textContent === 'Use the highlighted reply'),
      highlighted: (): number => choiceEls.findIndex((c) => c.classes.has('match')),
    };
  };
  beforeEach(() => { vi.useFakeTimers(); Recogniser.last = null; });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps listening through a pause, and joins what was said before it and after', () => {
    const p = player(closing);
    p.listen();
    const r = Recogniser.last!;
    expect(r.continuous).toBe(true);
    r.hear('to recap', false); r.hear('to recap', true);
    // A pause longer than the one that ended the recogniser on 2026-11-18 (550 ms), and a long one.
    vi.advanceTimersByTime(1100);
    expect(r.stopped).toBe(false);
    r.hear('the duplicate', false);
    r.hear('the duplicate $19 from order BN-4472 is refunded today and posts in 5 to 7 business days', true);
    vi.advanceTimersByTime(1900);
    expect(r.stopped).toBe(false);
    // Nothing more for two seconds: the reply is over.
    vi.advanceTimersByTime(200);
    expect(r.stopped).toBe(true);
    expect(p.heard()).toBe('“to recap the duplicate $19 from order BN-4472 is refunded today and posts in 5 to 7 business days”');
    expect(p.highlighted()).toBe(1);
    // Offered, not taken: the learner presses it.
    expect(p.picked).toEqual([]);
    p.offered()!.onclick!();
    expect(p.picked).toEqual([{ i: 1, said: 'to recap the duplicate $19 from order BN-4472 is refunded today and posts in 5 to 7 business days' }]);
  });

  it('offers nothing for words the recogniser never settled on', () => {
    const p = player(closing);
    p.listen();
    const r = Recogniser.last!;
    r.hear('to recap the duplicate $19 from order BN-4472 is refunded today and posts in 5 to 7 business days plus a free month', false);
    r.end();
    expect(p.offered()).toBeUndefined();
    expect(p.highlighted()).toBe(-1);
    expect(p.heard()).toBe("Didn't catch all of that. Try again, or tap a reply.");
  });

  it('offers nothing for a settled start whose continuation never settled', () => {
    const p = player(refunding);
    p.listen();
    const r = Recogniser.last!;
    r.hear("I'm refunding the duplicate $19 today", true);
    r.hear('actually no I cannot refund it', false);
    r.end();
    // The settled half alone is the refund reply; the whole of what was said is its opposite.
    expect(p.offered()).toBeUndefined();
    expect(p.highlighted()).toBe(-1);
    expect(p.heard()).toBe("Didn't catch all of that. Try again, or tap a reply.");

    // Settled in full, the same words are matched as a whole, and are no reply.
    const q = player(refunding);
    q.listen();
    const s = Recogniser.last!;
    s.hear("I'm refunding the duplicate $19 today", true);
    s.hear('actually no I cannot refund it', false);
    s.hear('actually no I cannot refund it', true);
    vi.advanceTimersByTime(2000);
    expect(q.offered()).toBeUndefined();
    expect(q.heard()).toContain("That didn't match a reply");
  });

  it('offers nothing after an error, whatever was heard before it', () => {
    for (const settled of [false, true]) {
      const p = player(closing);
      p.listen();
      const r = Recogniser.last!;
      r.hear('to recap the duplicate $19 from order BN-4472 is refunded today and posts in 5 to 7 business days plus a free month', settled);
      r.fail('network');
      expect(p.offered()).toBeUndefined();
      expect(p.highlighted()).toBe(-1);
      expect(p.heard()).toBe("Didn't catch that. Try again, or tap a reply.");
      // The timer that would have ended the reply does nothing more.
      vi.advanceTimersByTime(10_000);
      expect(p.offered()).toBeUndefined();
    }
  });

  it('gives up on a learner who says nothing, and says so', () => {
    const p = player(opening);
    p.listen();
    const r = Recogniser.last!;
    vi.advanceTimersByTime(7900);
    expect(r.stopped).toBe(false);
    vi.advanceTimersByTime(200);
    expect(r.stopped).toBe(true);
    expect(p.heard()).toBe("Didn't catch that. Try again, or tap a reply.");
    expect(p.offered()).toBeUndefined();
  });

  it('says so when what was said is no reply, and offers nothing', () => {
    const p = player(refunding);
    p.listen();
    Recogniser.last!.hear('I cannot refund the duplicate today', true);
    vi.advanceTimersByTime(2000);
    expect(p.heard()).toBe("“I cannot refund the duplicate today” · That didn't match a reply. Try again, or tap one.");
    expect(p.offered()).toBeUndefined();
    expect(p.highlighted()).toBe(-1);
  });

  it('takes nothing from a recogniser the learner has replaced with a later one', () => {
    const p = player(refunding);
    p.listen();
    const old = Recogniser.last!;
    // The first fails, and its end is slow to arrive. The learner taps the microphone again.
    old.onerror?.({ error: 'network' });
    expect(p.micLive()).toBe(false);
    p.listen();
    const now = Recogniser.last!;
    expect(now).not.toBe(old);
    expect(p.micLive()).toBe(true);
    // Now the first one's leftovers arrive: a result, and its end.
    old.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "I'm refunding the duplicate $19 today" } }] });
    old.onend?.();
    expect(p.micLive()).toBe(true);
    expect(p.offered()).toBeUndefined();
    expect(p.heard()).toBe('Listening…');
    // The one that is listening still works.
    now.hear("I'm refunding the duplicate $19 today it will post to your card in 5 to 7 business days", true);
    vi.advanceTimersByTime(2000);
    expect(p.highlighted()).toBe(2);
    expect(p.micLive()).toBe(false);
  });

  it('takes no result that arrives behind an error', () => {
    const p = player(refunding);
    p.listen();
    const r = Recogniser.last!;
    r.onerror?.({ error: 'network' });
    expect(p.heard()).toBe("Didn't catch that. Try again, or tap a reply.");
    r.hear("I'm refunding the duplicate $19 today it will post to your card in 5 to 7 business days", true);
    // The message stands, and no timer was started to end a reply that is not being heard.
    expect(p.heard()).toBe("Didn't catch that. Try again, or tap a reply.");
    vi.advanceTimersByTime(10_000);
    expect(r.stopped).toBe(false);
    r.end();
    expect(p.offered()).toBeUndefined();
  });

  it('lets go of the recogniser when a reply is tapped, so what it had queued touches nothing', () => {
    // The learner speaks, the words settle, and before the recogniser ends they tap a written reply.
    const p = player(refunding);
    p.listen();
    const old = Recogniser.last!;
    old.hear("I'm refunding the duplicate $19 today it will post to your card in 5 to 7 business days", true);
    p.hangUp();
    expect(old.aborted).toBe(true);
    expect(p.micLive()).toBe(false);
    const shown = p.heard();
    // The page is on its next step now. The old recogniser's queue arrives: a result, the abort's error, its end.
    old.hear('and a free month', true);
    old.onerror?.({ error: 'aborted' });
    old.onend?.();
    vi.advanceTimersByTime(10_000);
    expect(p.offered()).toBeUndefined();
    expect(p.highlighted()).toBe(-1);
    expect(p.heard()).toBe(shown);
    // And the microphone can be used at once, without waiting for the old one's end.
    p.listen();
    expect(Recogniser.last).not.toBe(old);
    expect(p.micLive()).toBe(true);
  });

  it('lets go of the recogniser in the one place a reply is taken', () => {
    expect(source.includes('function pick(i, said){\n  if (finished) return;\n  hangUp();')).toBe(true);
    expect(source.includes('rec.abort()')).toBe(false);
  });
});
