/**
 * The practice studio: discover the affordances and file declared-choice scores.
 * It does not emit xAPI. The hosted player is what records a real attempt.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { whyNotAProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { phoneRoleplayProfile } from '../src/profile.js';
import { assess, bestChoices, replay } from '../src/score.js';
import { createStudioApp } from '../src/server.js';
import { refusesPublicBind, Studio } from '../src/studio.js';

const PLAYER = new URL('../../../docs/applications/practice-evidence/roleplay-player/index.html', import.meta.url);

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createStudioApp(new Studio(), 'http://studio.test');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe('practice studio', () => {
  it('publishes the five product affordances', async () => {
    const studio = await listen();
    try {
      const entry = await fetch(studio.base).then((r) => r.json()) as { affordances: Array<{ toolName: string; target: string; expects: { properties?: Record<string, unknown> } }> };
      const names = entry.affordances.map((a) => a.toolName).sort();
      expect(names).toEqual([
        'studio.create_scenario',
        'studio.list_progress',
        'studio.list_scenarios',
        'studio.score_attempt',
        'studio.start_session',
      ]);
      const start = entry.affordances.find((a) => a.toolName === 'studio.start_session');
      expect(start?.target).toBe('http://studio.test/studio/sessions');
      expect(start?.expects.properties).toHaveProperty('scenarioKey');
    } finally {
      await studio.close();
    }
  });

  it('keeps the v3 profile snapshot and files a declared score, not xAPI', async () => {
    const profile = phoneRoleplayProfile();
    expect(whyNotAProfile(profile)).toBeNull();
    const templates = profile['templates'] as Array<{ id: string }>;
    expect(templates.map((t) => t.id)).toContain('https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/templates/turn');

    const held = new Studio();
    const doc = held.scenario('double-charged-subscription')!;
    expect(doc.rubricRef).toBe('urn:pev:scenario:2820abbd51e6ac5c#version-1');
    const choices = bestChoices(doc, 'dana');
    const studio = await listen();
    try {
      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioKey: 'double-charged-subscription', learner: 'Learner 12', personaId: 'dana' }),
      }).then((r) => r.json()) as { session: { sessionId: string; learnerId: string }; playerUrl: string };
      expect(started.session.learnerId).toBe('Learner 12');
      expect(started.playerUrl).toContain('/player/index.html');
      expect(started.playerUrl).toContain(encodeURIComponent(`/studio/sessions/${started.session.sessionId}/scenario`));
      expect(started.playerUrl).toContain('persona=dana');

      const scored = await fetch(`${studio.base}/studio/attempts/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.session.sessionId, choices }),
      });
      const body = await scored.json() as {
        kind?: string; error?: string; statements?: unknown; profileCheck?: unknown;
        score: { pass: boolean; provisional: boolean; percent: number; observed: boolean; source: string; actorKind: string; learnerId: string; criteria: Array<{ id: string; raw: number; max: number }> };
        coaching: { notes: unknown[] };
        review: string;
      };
      expect(scored.status, JSON.stringify(body).slice(0, 800)).toBe(200);
      expect(body.statements).toBeUndefined();
      expect(body.profileCheck).toBeUndefined();
      expect(body.score.observed).toBe(false);
      expect(body.score.source).toBe('declared-choices');
      expect(body.score.actorKind).toBe('agent');
      expect(body.score.learnerId).toBe('Learner 12');
      expect(body.score.provisional).toBe(true);
      expect(body.score.pass).toBe(true);
      expect(body.coaching.notes).toEqual([]);
      expect(body.review).toContain('not a played session');
      expect(body.review).not.toContain('import_launched_attempt');

      const progress = await fetch(`${studio.base}/studio/progress?learner=${encodeURIComponent('Learner 12')}`).then((r) => r.json()) as {
        attempts: number; passRate: number; averagePercent: number; learnerId: string; criteria: Array<{ id: string }>;
      };
      expect(progress.attempts).toBe(1);
      expect(progress.passRate).toBe(100);
      expect(progress.averagePercent).toBe(body.score.percent);
      expect(progress.learnerId).toBe('Learner 12');
      expect(progress.criteria.map((c) => c.id).sort()).toEqual(doc.rubric.criteria.map((c) => c.id).sort());
    } finally {
      await studio.close();
    }
  });

  it('files a declared feedback-only score and refuses levels listed highest first', async () => {
    const studio = await listen();
    try {
      const created = await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenarioKey: 'short-hello',
          title: 'Hello',
          learnerGoal: 'Greet the customer',
          situation: 'A customer says hello.',
          assessmentUse: 'feedback-only',
          resultAfterReview: false,
          language: 'en-US',
          rubric: {
            criteria: [{
              id: 'greeting', title: 'Greeting', description: 'Says hello', weight: 1,
              levels: [{ id: '0', value: 0 }, { id: '1', value: 1 }],
            }],
            passRule: { minPercent: 50 },
          },
          personas: [{
            id: 'pat', name: 'Pat', firstLine: 'Hello?',
            stages: [{
              id: 'open',
              choices: [
                { id: 'a', text: 'Hi, how can I help?', effects: { greeting: 1 }, best: true },
                { id: 'b', text: 'What.', effects: { greeting: 0 }, note: 'Start with a greeting.' },
              ],
            }],
          }],
        }),
      });
      expect(created.status).toBe(200);
      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioKey: 'short-hello', learner: 'Ada', personaId: 'pat' }),
      }).then((r) => r.json()) as { session: { sessionId: string } };
      const scored = await fetch(`${studio.base}/studio/attempts/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.session.sessionId, actorKind: 'person', choices: [{ index: 1, said: 'what do you want' }] }),
      }).then((r) => r.json()) as { score: { pass: boolean; provisional: boolean; actorKind: string; observed: boolean }; coaching: { notes: Array<{ note: string }> }; statements?: unknown };
      expect(scored.statements).toBeUndefined();
      expect(scored.score.observed).toBe(false);
      expect(scored.score.actorKind).toBe('person');
      expect(scored.score.provisional).toBe(false);
      expect(scored.score.pass).toBe(false);
      expect(scored.coaching.notes[0]?.note).toContain('greeting');
    } finally {
      await studio.close();
    }
  });

  it('refuses a rubric whose levels are not listed from low to high', () => {
    const refused = new Studio().createScenario({
      scenarioKey: 'upside-down',
      title: 'Upside down',
      rubric: { criteria: [{ id: 'greeting', title: 'Greeting', description: 'Says hello', levels: [{ id: 'good', value: 2 }, { id: 'poor', value: 0 }] }] },
      personas: [{ id: 'pat', name: 'Pat', firstLine: 'Hi', stages: [{ id: 's', choices: [{ id: 'a', text: 'Hello', effects: { greeting: 0 } }] }] }],
    });
    expect(refused['kind']).toBe('refusal');
    expect(String(refused['error'])).toContain('lowest value');
  });

  it('scores the revision and persona the session opened with', async () => {
    const studio = await listen();
    try {
      const scenario = {
        scenarioKey: 'two-people',
        title: 'Two people',
        assessmentUse: 'feedback-only',
        resultAfterReview: false,
        language: 'en-US',
        rubric: {
          criteria: [{ id: 'greeting', title: 'Greeting', description: 'Says hello', weight: 1, levels: [{ id: '0', value: 0 }, { id: '1', value: 1 }] }],
          passRule: { minPercent: 50 },
        },
        personas: [
          { id: 'dana', name: 'Dana', firstLine: 'Hi from Dana', stages: [{ id: 'd1', choices: [
            { id: 'a', text: 'Hello Dana', effects: { greeting: 1 }, best: true },
            { id: 'b', text: 'What', effects: { greeting: 0 }, note: 'Greet them.' },
          ] }] },
          { id: 'sam', name: 'Sam', firstLine: 'Hi from Sam', stages: [{ id: 's1', choices: [
            { id: 'c', text: 'Hello Sam', effects: { greeting: 1 }, best: true },
          ] }] },
        ],
      };
      expect((await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scenario),
      })).status).toBe(200);
      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioKey: 'two-people', learner: 'Ada', personaId: 'dana' }),
      }).then((r) => r.json()) as { session: { sessionId: string } };
      const mismatch = await fetch(`${studio.base}/studio/attempts/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.session.sessionId, personaId: 'sam', choices: [{ index: 0 }] }),
      }).then((r) => r.json()) as { kind: string; error: string };
      expect(mismatch.kind).toBe('refusal');
      expect(mismatch.error).toContain('dana');

      scenario.personas[0]!.firstLine = 'Rewritten after the session opened';
      scenario.personas[0]!.stages[0]!.choices[0]!.effects = { greeting: 0 };
      expect((await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scenario),
      })).status).toBe(200);
      const frozen = await fetch(`${studio.base}/studio/sessions/${started.session.sessionId}/scenario`).then((r) => r.json()) as { personas: Array<{ firstLine: string }> };
      expect(frozen.personas[0]!.firstLine).toBe('Hi from Dana');
      const scored = await fetch(`${studio.base}/studio/attempts/score`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: started.session.sessionId, personaId: 'dana', choices: [{ index: 0 }] }),
      }).then((r) => r.json()) as { score: { pass: boolean; percent: number } };
      expect(scored.score.pass).toBe(true);
      expect(scored.score.percent).toBe(100);
    } finally {
      await studio.close();
    }
  });

  it('follows the hosted player design and refuses an unfinished session', () => {
    const page = readFileSync(PLAYER, 'utf8');
    const scenario = JSON.parse(readFileSync(new URL('../../../docs/applications/practice-evidence/roleplay-player/scenarios/double-charged-subscription.json', import.meta.url), 'utf8')) as {
      resultAfterReview: boolean; rubricRef: string; xapi: { verbs: { turn: string } };
    };
    expect(scenario.resultAfterReview).toBe(true);
    expect(scenario.rubricRef).toBe('urn:pev:scenario:2820abbd51e6ac5c#version-1');
    expect(scenario.xapi.verbs.turn).toBe('https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/verbs/took-turn');
    expect(page).toContain('new URL("/cmi5/reviewed", cfg.lrs)');
    expect(page).toContain('send("turn"');
    expect(page).not.toContain('source: "interego-roleplay-player"');
    const held = new Studio();
    expect(held.scoreAttempt({ sessionId: 'missing', choices: [] })['kind']).toBe('refusal');
    const started = held.startSession({ scenarioKey: 'double-charged-subscription', learner: 'Pat', personaId: 'dana' });
    const sessionId = (started['session'] as { sessionId: string }).sessionId;
    const short = held.scoreAttempt({ sessionId, choices: [{ index: 0 }] });
    expect(short['kind']).toBe('refusal');
    expect(String(short['error'])).toContain('one reply per step');
    expect(refusesPublicBind('127.0.0.1', undefined)).toBe(false);
    expect(refusesPublicBind('::1', undefined)).toBe(false);
    expect(refusesPublicBind('localhost', undefined)).toBe(false);
    expect(refusesPublicBind('::', undefined)).toBe(true);
    expect(refusesPublicBind('0.0.0.0', '1')).toBe(false);
  });

  it('agrees with the hosted player on the same replies', async () => {
    const page = readFileSync(PLAYER, 'utf8');
    const scripts = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const sections = [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]!);
    const doc = new Studio().scenario('double-charged-subscription')!;
    const best = doc.personas[0]!.stages.map((stage) => stage.choices.findIndex((choice) => choice.best));
    const held: Array<{ verb: { id: string }; result?: { score?: { raw?: number } }; object: { definition?: { extensions?: Record<string, string> } } }> = [];
    const lms = 'https://lms.example';
    const actor = { objectType: 'Agent', account: { homePage: 'https://id.example', name: 'learner-1' } };
    const fetchImpl = async (input: unknown, init?: { method?: string; body?: string }): Promise<Response> => {
      const url = new URL(String(input));
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname.endsWith('/cmi5/fetch/once')) return json({ 'auth-token': 'dG9rZW4' });
      if (url.pathname.endsWith('/activities/state')) return json({ contextTemplate: { extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': 'session-1' } }, launchParameters: '' });
      if (url.pathname.endsWith('/cmi5/reviewed')) return json({ error: 'registration_not_under_review' }, 409);
      if (url.pathname.endsWith('/statements') && init?.method === 'POST') {
        held.push(JSON.parse(String(init.body)));
        return json(['id']);
      }
      if (url.pathname.endsWith('/statements')) return json({ statements: [] });
      if (url.pathname.includes('roleplay-player')) {
        const name = url.pathname.split('/roleplay-player/')[1] ?? 'index.html';
        return new Response(readFileSync(new URL(`../../../docs/applications/practice-evidence/roleplay-player/${name}`, import.meta.url), 'utf8'));
      }
      return new Response('', { status: 404 });
    };
    type Node = {
      classList: { add: (c: string) => void; remove: (c: string) => void; toggle: (c: string, on?: boolean) => void; contains: (c: string) => boolean };
      textContent: string; children: Node[]; onclick: (() => void) | null; hidden: boolean; style: Record<string, string>;
      className: string; innerHTML: string; appendChild: (child: Node) => Node; querySelector: () => Node; querySelectorAll: () => Node[];
      setAttribute: () => void; offsetWidth: number;
    };
    const els = new Map<string, Node>();
    const el = (id: string): Node => {
      let found = els.get(id);
      if (!found) {
        const classes = new Set<string>();
        found = {
          className: '', style: {}, onclick: null, textContent: '', children: [], offsetWidth: 0,
          classList: {
            add: (c) => { classes.add(c); }, remove: (c) => { classes.delete(c); },
            toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
            contains: (c) => classes.has(c),
          },
          get hidden() { return classes.has('hide'); },
          set innerHTML(_v: string) { this.textContent = ''; this.children = []; },
          appendChild(child: Node) { this.children.push(child); return child; },
          querySelector: () => el('unused'),
          querySelectorAll: () => [el('a'), el('b')],
          setAttribute() { /* drawing */ },
        } as Node;
        els.set(id, found);
      }
      return found;
    };
    for (const id of sections) if (id !== 's-loading') el(id).classList.add('hide');
    const document = {
      title: '', getElementById: el, createElement: () => el(`made-${els.size}`),
      querySelectorAll: (q: string) => q === 'section' ? sections.map(el) : q === '.choice' ? el('choices').children : [],
    };
    const href = `${lms}/roleplay-player/index.html?${new URLSearchParams({ endpoint: `${lms}/xapi`, fetch: `${lms}/cmi5/fetch/once`, actor: JSON.stringify(actor), activityId: `${lms}/au`, registration: '6f1c2f6e-3b1a-4c53-9d2e-0a4b7c9d1e2f' })}`;
    const location = { href, search: new URL(href).search, origin: lms };
    const window = { scrollTo() {}, parent: {}, speechSynthesis: undefined };
    for (const script of scripts) new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(window, document, location, fetchImpl, () => 0, () => {});
    const settle = async (until: () => boolean) => {
      for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
      if (!until()) throw new Error(`the player did not finish; chip ${el('chip').textContent}; ${el('loadmsg').textContent}; held ${held.length}`);
    };
    await settle(() => el('chip').textContent === 'Tracked');
    el('go').onclick!(); el('agree').onclick!(); await el('consentyes').onclick!();
    for (const index of best) el('choices').children[index]!.onclick!();
    await settle(() => held.some((statement) => statement.verb.id.endsWith('/terminated')));
    const key = doc.xapi!.extensions['criterionKey']!;
    const fromPlayer = held.filter((statement) => statement.verb.id.endsWith('/scored')).map((statement) => ({
      id: statement.object.definition?.extensions?.[key],
      raw: statement.result?.score?.raw,
    }));
    const fromStudio = assess(doc, replay(doc, 'dana', best.map((index) => ({ index }))));
    expect(fromPlayer.map((row) => row.id)).toEqual(fromStudio.criteria.map((criterion) => criterion.id));
    expect(fromPlayer.map((row) => row.raw)).toEqual(fromStudio.criteria.map((criterion) => criterion.raw));
    expect(el('passpill').textContent).toContain(fromStudio.pass ? 'over the bar' : 'under the bar');
  });
});
