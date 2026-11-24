/**
 * The practice studio launches the hosted player through cmi5 and reads the
 * registration with Practice Evidence. It does not write the statements.
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Wallet, type HDNodeWallet } from 'ethers';
import { whyNotAProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { phoneRoleplayProfile } from '../src/profile.js';
import { createStudioApp } from '../src/server.js';
import { scenarioProblems, refusesPublicBind, Studio } from '../src/studio.js';

const PLAYER = new URL('../../../docs/applications/practice-evidence/roleplay-player/index.html', import.meta.url);
const SEEDED = new URL('../../../docs/applications/practice-evidence/roleplay-player/scenarios/double-charged-subscription.json', import.meta.url);

async function signed(wallet: Wallet | HDNodeWallet, payload: Record<string, unknown>): Promise<{ _signed_payload: string; _signature: string }> {
  const _signed_payload = JSON.stringify({ ...payload, agent_id: `did:ethr:${wallet.address}`, timestamp: new Date().toISOString() });
  const _signature = await wallet.signMessage(`sha256:${createHash('sha256').update(_signed_payload).digest('hex')}`);
  return { _signed_payload, _signature };
}

async function listen(): Promise<{ base: string; close: () => Promise<void> }> {
  const origin = { current: 'http://127.0.0.1' };
  const app = createStudioApp(new Studio(), 'http://studio.test', () => origin.current);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  origin.current = `http://127.0.0.1:${port}`;
  return {
    base: origin.current,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe('practice studio', () => {
  it('publishes the library, the launch and the progress read', async () => {
    const studio = await listen();
    try {
      const entry = await fetch(studio.base).then((r) => r.json()) as { affordances: Array<{ toolName: string; target: string; expects: { properties?: Record<string, unknown> } }> };
      const names = entry.affordances.map((a) => a.toolName).sort();
      expect(names).toEqual(['studio.create_scenario', 'studio.list_progress', 'studio.list_scenarios', 'studio.start_session']);
      const start = entry.affordances.find((a) => a.toolName === 'studio.start_session');
      expect(start?.target).toBe('http://studio.test/studio/sessions');
      expect(start?.expects.properties).toHaveProperty('_signature');
    } finally {
      await studio.close();
    }
  });

  it('refuses an unsigned launch and reads a played registration through Practice Evidence', async () => {
    const profile = phoneRoleplayProfile() as { templates?: Array<{ id?: string }> };
    expect(whyNotAProfile(profile)).toBeNull();
    expect((profile.templates ?? []).some((template) => String(template.id).includes('turn'))).toBe(true);
    const studio = await listen();
    const learner = Wallet.createRandom();
    const other = Wallet.createRandom();
    try {
      const unsigned = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioKey: 'double-charged-subscription' }),
      });
      expect(unsigned.status).toBe(401);

      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(learner, { scenarioKey: 'double-charged-subscription', personaId: 'dana', learnerPlace: 'person' })),
      }).then((r) => r.json()) as { launch: { launchUrl: string; registration: string; learnerDid: string } };
      const launchUrl = new URL(started.launch.launchUrl);
      expect(launchUrl.origin).toBe(studio.base);
      expect(launchUrl.searchParams.get('endpoint')).toBe(`${studio.base}/xapi`);
      expect(launchUrl.searchParams.get('registration')).toBe(started.launch.registration);
      const actor = JSON.parse(launchUrl.searchParams.get('actor') ?? '{}') as { account: { name: string } };
      expect(actor.account.name).toBe(started.launch.learnerDid);
      expect(started.launch.learnerDid.toLowerCase()).toBe(`did:ethr:${learner.address}`.toLowerCase());

      const stranger = await fetch(`${studio.base}/studio/progress`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(other, { registration: started.launch.registration })),
      });
      expect(stranger.status).toBe(403);

      await play(started.launch.launchUrl, studio.base);
      const read = await fetch(`${studio.base}/studio/progress`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(learner, { registration: started.launch.registration })),
      }).then((r) => r.json()) as { source: string; read: { call?: { scores: Array<{ criterionId: string; raw: number }> }; problems?: string[] } };
      expect(read.source).toBe('pev.readLaunchedCall');
      if (!read.read.call) throw new Error(`Practice Evidence refused the registration: ${(read.read.problems ?? []).join(' | ')}`);
      const seeded = JSON.parse(readFileSync(SEEDED, 'utf8')) as { rubric: { criteria: Array<{ id: string; levels: Array<{ value: number }> }> } };
      expect(read.read.call.scores.map((score) => score.criterionId)).toEqual(seeded.rubric.criteria.map((criterion) => criterion.id));
      expect(read.read.call.scores.map((score) => score.raw)).toEqual(seeded.rubric.criteria.map((criterion) => Math.max(...criterion.levels.map((level) => level.value))));
    } finally {
      await studio.close();
    }
  });

  it('marks an agent launch and Practice Evidence refuses it as a person\'s attempt', async () => {
    const studio = await listen();
    const learner = Wallet.createRandom();
    try {
      const started = await fetch(`${studio.base}/studio/sessions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(learner, { scenarioKey: 'double-charged-subscription', learnerPlace: 'agent' })),
      }).then((r) => r.json()) as { launch: { launchUrl: string; registration: string } };
      const launchUrl = new URL(started.launch.launchUrl);
      const fetched = await fetch(launchUrl.searchParams.get('fetch')!, { method: 'POST' }).then((r) => r.json()) as { 'auth-token': string };
      const auth = { Authorization: `Basic ${fetched['auth-token']}`, 'content-type': 'application/json' };
      const stateUrl = new URL(`${studio.base}/xapi/activities/state`);
      stateUrl.searchParams.set('registration', started.launch.registration);
      const state = await fetch(stateUrl, { headers: auth }).then((r) => r.json()) as { launchParameters: string; contextTemplate: { extensions: Record<string, string> } };
      expect(state.launchParameters).toContain('actorKind=agent');
      expect(state.launchParameters).toContain('contextKind=agent-test');
      const actor = JSON.parse(launchUrl.searchParams.get('actor') ?? '{}') as { account: { homePage: string; name: string } };
      const session = state.contextTemplate.extensions['https://w3id.org/xapi/cmi5/context/extensions/sessionid'];
      const agentTest = 'https://markjspivey-xwisee.github.io/interego/applications/practice-evidence/pev#agentTest';
      const posted = await fetch(`${studio.base}/xapi/statements`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          actor,
          verb: { id: 'http://adlnet.gov/expapi/verbs/initialized' },
          object: { id: launchUrl.searchParams.get('activityId') },
          timestamp: new Date().toISOString(),
          context: { registration: started.launch.registration, extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': session, [agentTest]: true } },
        }),
      });
      expect(posted.status).toBe(200);
      const read = await fetch(`${studio.base}/studio/progress`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(learner, { registration: started.launch.registration })),
      }).then((r) => r.json()) as { read: { problems?: string[] } };
      expect((read.read.problems ?? []).join(' ')).toContain('agent test');
    } finally {
      await studio.close();
    }
  });

  it('refuses a rubric whose levels are not listed from low to high, and another author', async () => {
    const bad = {
      scenarioKey: 'out-of-order', title: 'Out of order',
      rubric: { criteria: [{ id: 'greeting', levels: [{ id: 'good', value: 2 }, { id: 'poor', value: 0 }] }] },
      personas: [{ id: 'dana', stages: [{ choices: [{ text: 'Hello' }] }] }],
    };
    expect(scenarioProblems(bad).join(' ')).toContain('lowest value to the highest');
    const studio = await listen();
    const author = Wallet.createRandom();
    const other = Wallet.createRandom();
    try {
      const saved = await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(author, { scenario: { ...bad, rubric: { criteria: [{ id: 'greeting', levels: [{ id: 'poor', value: 0 }, { id: 'good', value: 2 }] }] } } })),
      });
      expect(saved.status).toBe(200);
      const replaced = await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(other, { scenario: { ...bad, title: 'Taken', rubric: { criteria: [{ id: 'greeting', levels: [{ id: 'poor', value: 0 }, { id: 'good', value: 2 }] }] } } })),
      });
      expect(replaced.status).toBe(403);
      const sample = await fetch(`${studio.base}/studio/scenarios/double-charged-subscription/document`).then((r) => r.json()) as { title: string };
      sample.title = 'Mine';
      const seeded = await fetch(`${studio.base}/studio/scenarios`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(await signed(author, { scenario: sample })),
      });
      expect(seeded.status).toBe(409);
    } finally {
      await studio.close();
    }
  });

  it('follows the hosted player design', () => {
    const page = readFileSync(PLAYER, 'utf8');
    const scenario = JSON.parse(readFileSync(SEEDED, 'utf8')) as { resultAfterReview: boolean; rubricRef: string; xapi: { verbs: { turn: string } } };
    expect(scenario.resultAfterReview).toBe(true);
    expect(scenario.rubricRef).toBe('urn:pev:scenario:2820abbd51e6ac5c#version-1');
    expect(scenario.xapi.verbs.turn).toBe('https://relay.interego.xwisee.com/ns/u-pk-0d4144c0c851/phone-roleplay-xapi/verbs/took-turn');
    expect(page).toContain('new URL("/cmi5/reviewed", cfg.lrs)');
    expect(page).toContain('send("turn"');
    expect(page).not.toContain('source: "interego-roleplay-player"');
    expect(refusesPublicBind('127.0.0.1', undefined)).toBe(false);
    expect(refusesPublicBind('::', undefined)).toBe(true);
    expect(refusesPublicBind('0.0.0.0', '1')).toBe(false);
  });
});

/** Run the hosted player's own scripts against a launch URL, tapping the best reply at each step. */
async function play(launchUrl: string, origin: string): Promise<void> {
  const page = readFileSync(PLAYER, 'utf8');
  const scripts = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const sections = [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]!);
  const scenarioUrl = new URL(launchUrl).searchParams.get('scenario')!;
  const doc = await fetch(scenarioUrl).then((r) => r.json()) as { personas: Array<{ stages: Array<{ choices: Array<{ best?: boolean }> }> }> };
  const best = doc.personas[0]!.stages.map((stage) => stage.choices.findIndex((choice) => choice.best));
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
  const location = { href: launchUrl, search: new URL(launchUrl).search, origin };
  const window = { scrollTo() {}, parent: {}, speechSynthesis: undefined };
  const fetchImpl = async (input: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> => {
    const url = new URL(String(input), origin);
    if (url.origin !== new URL(origin).origin) return new Response('', { status: 404 });
    return fetch(url, init);
  };
  for (const script of scripts) new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', script)(window, document, location, fetchImpl, () => 0, () => {});
  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!until()) throw new Error(`the player did not finish; chip ${el('chip').textContent}; ${el('loadmsg').textContent}`);
  };
  await settle(() => el('chip').textContent === 'Tracked');
  el('go').onclick!(); el('agree').onclick!(); await el('consentyes').onclick!();
  for (const index of best) el('choices').children[index]!.onclick!();
  await settle(() => el('chip').textContent === 'Saved');
}
