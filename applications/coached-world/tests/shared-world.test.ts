/**
 * Two guests, one world. The guest path is identity's ProvisionalPlay.
 * A mismatched intervention does not move the score. Promotion happens only
 * when passed and completed are already in the record from outside.
 *
 * Every test that needs the HTTP server is in this file, the deployed surface included:
 * the public URL, /health, the request limits, and the guest page finding its way back in
 * after the world was restarted.
 */
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Wallet, verifyMessage } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RATE_RULES } from '../src/rate-limit.js';
import { start, GENERAL_GUEST_RETURN_PATH } from '../src/server.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../../../deploy/identity/provisional-play.js';
import { RETURN_PATH, WORLD, agent, cookieOf, identity, newKey } from './general-guest-identity.js';
import { CoachedWorld } from '../src/world.js';
import { FoxxiCourseLauncher } from '../src/course-launch.js';
import { CMI5_CATEGORY, HttpLrs, parseLmsAuthority, SATISFIED, type LrsQuery, type LrsReader } from '../src/lrs.js';
import { loadPackFile } from '../src/pack.js';
import type { XapiStatement } from '../src/statements.js';

const here = dirname(fileURLToPath(import.meta.url));
const orchardPath = join(here, '../packs/orchard.json');
const subtle = webcrypto.subtle;
const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

async function guest(base: string, audience = base): Promise<{ token: string; ownerDid: string }> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  const publicKeyJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x, y: jwk.y };
  const thumbprint = b64(await subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv: publicKeyJwk.crv, kty: publicKeyJwk.kty, x: publicKeyJwk.x, y: publicKeyJwk.y }))));
  const sign = async (payload: string) => b64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(payload)));
  const grantChallenge = b64(webcrypto.getRandomValues(new Uint8Array(32)));
  const granted = await post(base, '/play/grant', { publicKeyThumbprint: thumbprint, challenge: grantChallenge });
  const playGrant = granted['playGrant'] as { _signed_payload: string; _signature: string };
  const bootstrapProof = await sign(`interego-play-provisional-v1\n${playGrant._signed_payload}\n${playGrant._signature}`);
  const admitted = await post(base, '/play/provisional', { playGrant, publicKeyJwk, proof: bootstrapProof });
  const attestation = admitted['attestation'] as string;
  expect(String(admitted['userId'])).toMatch(/^u-try-play-/);
  const challenged = await post(base, '/session/challenge', {});
  const challenge = challenged['challenge'] as string;
  const proof = await sign(`interego-play-proof-v1\n${attestation}\n${audience}\n${challenge}`);
  const session = await post(base, '/session', { attestation, challenge, proof });
  return { token: session['token'] as string, ownerDid: session['ownerDid'] as string };
}

async function post(base: string, path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const parsed = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} ${response.status} ${parsed['error']}`);
  return parsed;
}

async function get(base: string, path: string, token?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

describe('a shared coached world', () => {
  it('lets two guests join, coach, and see one feed', async () => {
    const running = await start({ packPath: orchardPath, bots: false, tick: true, forceLocal: true, port: 0 });
    try {
      const north = await guest(running.url);
      const south = await guest(running.url);
      expect(north.ownerDid).not.toBe(south.ownerDid);
      await post(running.url, '/faction', { factionId: 'north' }, north.token);
      await post(running.url, '/faction', { factionId: 'south' }, south.token);
      const northView = await get(running.url, '/world', north.token);
      const southView = await get(running.url, '/world', south.token);
      const northName = (northView['you'] as { name: string }).name;
      const southName = (southView['you'] as { name: string }).name;
      const boardOf = (body: Record<string, unknown>) => body['leaderboard'] as Array<{ name: string; you: boolean }>;
      expect(boardOf(northView).some(row => row.name === southName && !row.you)).toBe(true);
      expect(boardOf(southView).some(row => row.name === northName && !row.you)).toBe(true);
      const anon = boardOf(await get(running.url, '/world'));
      expect(anon.some(row => row.name === northName)).toBe(true);
      expect(anon.some(row => row.name === southName)).toBe(true);
      expect(anon.every(row => !row.you)).toBe(true);
      const market = northView['market'] as Array<{ id: string; factionId: string | null; price: number }>;
      expect(market.length).toBeGreaterThan(0);
      const offer = market.find(agent => agent.factionId === null) ?? market.slice().sort((a, b) => a.price - b.price)[0];
      if (!offer) throw new Error('market empty');
      const hired = await post(running.url, '/market/transfer', { agentId: offer.id }, north.token);
      expect(typeof hired['agent']).toBe('string');
      const opened = await post(running.url, '/missions', {}, north.token);
      const statements = opened['statements'] as Array<{ verb: { id: string } }>;
      expect(statements.length).toBeGreaterThan(1);
      expect(statements.every(s => !/\/(passed|completed)$/.test(s.verb.id))).toBe(true);
      expect(JSON.stringify(opened)).not.toContain('/ext/cause');
      const settled = await post(running.url, '/missions/intervene', { diagnosis: 'timing', interventionId: 'calendar' }, north.token);
      if (settled['matched'] === true) expect(Number(settled['delta'])).toBeGreaterThan(0);
      else expect(settled['delta']).toBe(0);
      const seen = await get(running.url, '/world', south.token);
      const feed = seen['feed'] as Array<{ text: string }>;
      expect(feed.some(item => item.text.includes('North Crew') || item.text.includes('deployed'))).toBe(true);
      const board = seen['leaderboard'] as Array<{ you?: boolean; name: string }>;
      expect(board.some(row => row.you)).toBe(true);
      const graphs = await get(running.url, '/graphs');
      const rows = graphs['graphs'] as Array<{ turtle: string; graph: string; kind: string; signature: string; canonical: string }>;
      expect(rows.some(row => row.kind === 'pact' || row.kind === 'faction')).toBe(true);
      const intervention = rows.find(row => row.kind === 'intervention');
      expect(intervention?.turtle).toContain('iep:CausalFacet');
      expect(intervention?.turtle).toContain('iep:causalRole "Intervention"');
      expect(verifyMessage(intervention!.canonical, intervention!.signature)).toMatch(/^0x[0-9a-fA-F]{40}$/);
      const territory = rows.find(row => row.kind === 'territory');
      expect(territory?.graph).toContain('cpw:Territory');
      expect(territory?.turtle).toContain('iep:FederationFacet');
    } finally {
      await running.close();
    }
  }, 30_000);

  it('promotes only from a cmi5 satisfied statement for the course and this consultant', async () => {
    const pack = { ...loadPackFile(orchardPath), influence: 400 };
    const world = await CoachedWorld.create({ pack, base: 'http://world.example/', didHost: 'world.example', seed: 1 });
    const consultant = world.admit({ ownerDid: 'did:web:world.example:users:u-try-play-abc', userId: 'u-try-play-abc', podUrl: 'http://world.example/pods/u/', agentDid: 'did:web:world.example:agents:mcp-client-u-try-play-abc' });
    await world.joinFaction(consultant.id, 'north');
    let gate = 'none';
    for (let i = 0; i < 12 && gate !== 'eligible'; i++) {
      await world.startMission(consultant.id);
      const settled = await world.intervene(consultant.id, 'timing', 'calendar') as { matched: boolean; gate: string };
      gate = settled.gate;
      if (settled.matched) expect(settled.gate === 'eligible' || i < 11).toBe(true);
    }
    expect(gate).toBe('eligible');
    const refused = await world.refreshGate(consultant.id);
    expect(refused['promoted']).toBe(false);
    const course = 'https://example.org/courses/orchard-crew';
    const au = 'https://example.org/courses/orchard-crew/au/1';
    const statement = (verb: string, objectId: string, homePage = 'http://world.example/', category = CMI5_CATEGORY): XapiStatement => ({
      id: `http://world.example/statements/${encodeURIComponent(verb)}-${encodeURIComponent(objectId)}-${encodeURIComponent(homePage)}`,
      version: '2.0.0',
      timestamp: '2026-11-14T00:00:00.000Z',
      actor: { objectType: 'Agent', account: { homePage, name: consultant.ownerDid } },
      verb: { id: verb, display: { en: verb.split('/').at(-1) ?? verb } },
      object: { objectType: 'Activity', id: objectId, definition: { type: 'http://adlnet.gov/expapi/activities/course' } },
      context: { registration: '00000000-0000-4000-8000-000000000001', contextActivities: { category: [{ id: category }] } },
    });
    world.recordExternal([
      statement('http://adlnet.gov/expapi/verbs/passed', au),
      statement('http://adlnet.gov/expapi/verbs/completed', au),
      statement(SATISFIED, au),
      statement(SATISFIED, course, 'https://other.example/'),
      statement(SATISFIED, course, 'http://world.example/', 'https://example.org/not-cmi5'),
    ]);
    expect((await world.refreshGate(consultant.id))['promoted']).toBe(false);
    world.recordExternal([statement(SATISFIED, course)]);
    const promoted = await world.refreshGate(consultant.id);
    expect(promoted['promoted']).toBe(true);
    expect(promoted['tier']).toBe(1);
    const seated = world.view(consultant.id)['you'] as { roster: unknown[]; rosterCap: number };
    expect(seated.roster.length).toBeLessThan(seated.rosterCap);
    const territoriesBefore = world.graphs().filter(row => row.kind === 'territory').length;
    await world.tick();
    const territoriesAfter = world.graphs().filter(row => row.kind === 'territory');
    expect(territoriesAfter.length).toBe(territoriesBefore + 1);
    const latest = territoriesAfter.at(-1);
    expect(latest?.graph).toContain('cpw:Territory');
    expect(latest?.version).toBeGreaterThan(1);
    const verbs = world.log.entries.filter(entry => entry.origin === 'world').map(entry => entry.statement.verb.id);
    expect(verbs.some(id => id.endsWith('/passed') || id.endsWith('/completed'))).toBe(false);
    expect(pack.profileId).toContain('orchard');
  });

  it('asks an LRS for the actor name and home page together', async () => {
    let seen = '';
    const fetchImpl = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(JSON.stringify({ statements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const lrs = new HttpLrs('https://lrs.example/xapi/statements', undefined, fetchImpl);
    await lrs.fetchActor('did:web:example:users:u-try-play-abc', 'https://foxxi.example', { verb: SATISFIED, activity: 'https://example.org/courses/orchard-crew' });
    const queried = new URL(seen);
    const agent = JSON.parse(queried.searchParams.get('agent') ?? '{}') as { account?: { name?: string; homePage?: string } };
    expect(agent.account).toEqual({ name: 'did:web:example:users:u-try-play-abc', homePage: 'https://foxxi.example' });
    expect(queried.searchParams.get('verb')).toBe(SATISFIED);
    expect(queried.searchParams.get('activity')).toBe('https://example.org/courses/orchard-crew');

    let recordingSeen: { name: string; homePage: string; query: LrsQuery } | undefined;
    const recording: LrsReader = { async fetchActor(name, homePage, query) { recordingSeen = { name, homePage, query }; return []; } };
    const world = await CoachedWorld.create({
      pack: { ...loadPackFile(orchardPath), influence: 400 }, base: 'http://world.example/', didHost: 'world.example', seed: 2,
      lrs: recording, actorHomePage: 'https://foxxi.example', lmsAuthority: { homePage: 'https://foxxi.example', name: 'the-lms' },
    });
    const consultant = world.admit({ ownerDid: 'did:web:example:users:u-try-play-abc', userId: 'u-try-play-abc', podUrl: 'http://world.example/pods/u/', agentDid: 'did:web:example:agents:mcp' });
    await world.joinFaction(consultant.id, 'north');
    for (let i = 0; i < 12 && (world.view(consultant.id)['you'] as { gate: string }).gate !== 'eligible'; i++) {
      await world.startMission(consultant.id);
      await world.intervene(consultant.id, 'timing', 'calendar');
    }
    const gate = await world.refreshGate(consultant.id);
    expect(gate['lrs']).toBe('ok');
    expect(recordingSeen).toEqual({
      name: consultant.ownerDid, homePage: 'https://foxxi.example',
      query: { verb: SATISFIED, activity: 'https://example.org/courses/orchard-crew' },
    });
  });

  it('follows the LRS more link and keeps unreachable when the LRS is down', async () => {
    const course = 'https://example.org/courses/orchard-crew';
    const home = 'https://foxxi.example';
    const actor = 'did:web:example:users:u-try-play-page';
    const LMS = { homePage: 'https://lrs.example', name: 'the-lms' };
    const satisfied: XapiStatement = {
      authority: { objectType: 'Agent', account: LMS },
      id: 'http://lrs.example/statements/satisfied',
      version: '2.0.0', timestamp: '2026-11-14T00:00:00.000Z',
      actor: { objectType: 'Agent', account: { homePage: home, name: actor } },
      verb: { id: SATISFIED, display: { en: 'satisfied' } },
      object: { objectType: 'Activity', id: course, definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/course' } },
      context: { registration: '00000000-0000-4000-8000-000000000009', contextActivities: { category: [{ id: CMI5_CATEGORY }] } },
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      const page = href.includes('continuationToken=next')
        ? { statements: [satisfied] }
        : { statements: [], more: '/xapi/statements?continuationToken=next' };
      return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const lrs = new HttpLrs('https://lrs.example/xapi/statements', undefined, fetchImpl);
    const world = await CoachedWorld.create({
      pack: { ...loadPackFile(orchardPath), influence: 400 }, base: 'http://world.example/', didHost: 'world.example', seed: 4,
      lrs, actorHomePage: home, lmsAuthority: LMS,
    });
    const consultant = world.admit({ ownerDid: actor, userId: 'u-try-play-page', podUrl: 'http://world.example/pods/p/', agentDid: 'did:web:example:agents:mcp-page' });
    await world.joinFaction(consultant.id, 'north');
    for (let i = 0; i < 12 && (world.view(consultant.id)['you'] as { gate: string }).gate !== 'eligible'; i++) {
      await world.startMission(consultant.id);
      await world.intervene(consultant.id, 'timing', 'calendar');
    }
    const promoted = await world.refreshGate(consultant.id);
    expect(promoted['lrs']).toBe('ok');
    expect(promoted['promoted']).toBe(true);

    const down = new HttpLrs('https://lrs.example/xapi/statements', undefined, (async () => new Response('down', { status: 503 })) as typeof fetch);
    const stuck = await CoachedWorld.create({
      pack: { ...loadPackFile(orchardPath), influence: 400 }, base: 'http://world.example/', didHost: 'world.example', seed: 5,
      lrs: down, actorHomePage: home, lmsAuthority: LMS,
    });
    const other = stuck.admit({ ownerDid: actor, userId: 'u-try-play-page', podUrl: 'http://world.example/pods/p/', agentDid: 'did:web:example:agents:mcp-page' });
    await stuck.joinFaction(other.id, 'north');
    for (let i = 0; i < 12 && (stuck.view(other.id)['you'] as { gate: string }).gate !== 'eligible'; i++) {
      await stuck.startMission(other.id);
      await stuck.intervene(other.id, 'timing', 'calendar');
    }
    stuck.recordExternal([satisfied]);
    const refused = await stuck.refreshGate(other.id);
    expect(refused['lrs']).toBe('unreachable');
    expect(refused['promoted']).toBe(false);
  });

  it('promotes on what an LRS holds only where the LMS itself stored the satisfied', async () => {
    const course = 'https://example.org/courses/orchard-crew';
    const home = 'https://foxxi.example';
    const actor = 'did:web:example:users:u-try-play-stamp';
    const LMS = { homePage: 'https://lrs.example', name: 'the-lms' };
    const satisfied = (authority?: { homePage: string; name: string }): XapiStatement => ({
      ...(authority ? { authority: { objectType: 'Agent', account: authority } } : {}),
      id: `http://lrs.example/statements/satisfied-${authority ? `${authority.name}-${encodeURIComponent(authority.homePage)}` : 'unmarked'}`,
      version: '2.0.0', timestamp: '2026-11-14T00:00:00.000Z',
      actor: { objectType: 'Agent', account: { homePage: home, name: actor } },
      verb: { id: SATISFIED, display: { en: 'satisfied' } },
      object: { objectType: 'Activity', id: course, definition: { type: 'https://w3id.org/xapi/cmi5/activitytype/course' } },
      context: { registration: '00000000-0000-4000-8000-00000000000a', contextActivities: { category: [{ id: CMI5_CATEGORY }] } },
    });
    let asked = 0;
    const eligible = async (held: XapiStatement[], lmsAuthority: { homePage: string; name: string } | undefined, seed: number) => {
      const reader: LrsReader = { async fetchActor() { asked++; return held; } };
      const world = await CoachedWorld.create({
        pack: { ...loadPackFile(orchardPath), influence: 400 }, base: 'http://world.example/', didHost: 'world.example', seed,
        lrs: reader, actorHomePage: home, ...(lmsAuthority ? { lmsAuthority } : {}),
      });
      const consultant = world.admit({ ownerDid: actor, userId: 'u-try-play-stamp', podUrl: 'http://world.example/pods/s/', agentDid: 'did:web:example:agents:mcp-stamp' });
      await world.joinFaction(consultant.id, 'north');
      for (let i = 0; i < 12 && (world.view(consultant.id)['you'] as { gate: string }).gate !== 'eligible'; i++) {
        await world.startMission(consultant.id);
        await world.intervene(consultant.id, 'timing', 'calendar');
      }
      return world.refreshGate(consultant.id);
    };
    // Everything a learner writing about themselves can produce: the verb, the course, their own
    // actor and the cmi5 category. Stored by anyone but the LMS, it promotes nobody.
    for (const held of [[satisfied()], [satisfied({ homePage: 'https://lrs.example', name: 'the-lrs' })], [satisfied({ homePage: 'https://elsewhere.example', name: 'the-lms' })]]) {
      const r = await eligible(held, LMS, 6);
      expect([r['lrs'], r['satisfied'], r['promoted']]).toEqual(['ok', false, false]);
    }
    // The LMS's own does.
    expect((await eligible([satisfied(LMS)], LMS, 6))['promoted']).toBe(true);
    // A world reading an LRS without being told the LMS's authority promotes nobody, and does not ask.
    const before = asked;
    const untold = await eligible([satisfied(LMS)], undefined, 6);
    expect([untold['lrs'], untold['promoted']]).toEqual(['lms-authority-unset', false]);
    expect(asked).toBe(before);

    expect(parseLmsAuthority('{"homePage":"https://lrs.example","name":"the-lms"}')).toEqual(LMS);
    for (const raw of [undefined, '', 'the-lms', '[]', '{"homePage":"https://lrs.example"}', '{"homePage":"","name":"the-lms"}']) expect(parseLmsAuthority(raw)).toBeUndefined();
  });

  it('launches the tier course through Foxxi for this consultant and not a second guest', async () => {
    let posted: { url: string; body: { _signed_payload?: string } } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      posted = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as { _signed_payload?: string } };
      const payload = JSON.parse(posted.body._signed_payload ?? '{}') as { agent_id?: string; course_id?: string };
      return new Response(JSON.stringify({
        kind: 'cmi5-launch', launchUrl: 'https://foxxi.example/au?fetch=1', registration: 'reg-1', learner: payload.agent_id,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const launcher = new FoxxiCourseLauncher('https://foxxi.example/agent/cmi5/launch', async () => '0x' + 'ab'.repeat(65), fetchImpl);
    const world = await CoachedWorld.create({
      pack: loadPackFile(orchardPath), base: 'http://world.example/', didHost: 'world.example', seed: 6, launcher,
    });
    const consultant = world.admit({ ownerDid: 'did:web:world.example:users:u-try-play-abc', userId: 'u-try-play-abc', podUrl: 'http://world.example/pods/u/', agentDid: 'did:web:world.example:agents:mcp' });
    await world.joinFaction(consultant.id, 'north');
    const launched = await world.launchGate(consultant.id);
    const payload = JSON.parse(posted?.body._signed_payload ?? '{}') as { agent_id?: string; course_id?: string };
    expect(posted?.url).toBe('https://foxxi.example/agent/cmi5/launch');
    expect(payload.agent_id).toBe(consultant.ownerDid);
    expect(payload.course_id).toBe('https://example.org/courses/orchard-crew');
    expect(launched['learner']).toBe(consultant.ownerDid);
    expect(launched['launchUrl']).toBe('https://foxxi.example/au?fetch=1');
  });

  it('a challenge that was never issued, or was already used, opens no session', async () => {
    const running = await start({ bots: false, forceLocal: true });
    try {
      const post = (path: string, body: unknown) => fetch(running.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const { challenge } = await (await post('/session/challenge', {})).json() as { challenge: string };
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await post('/session', { challenge: 'never-issued' })).status).toBe(401);
      // A real challenge with no proof is refused, and is spent by the attempt.
      const first = await post('/session', { challenge });
      expect(first.status).toBeGreaterThanOrEqual(400);
      expect((await post('/session', { challenge })).status).toBe(401);
      // Writes need a session.
      expect((await post('/missions', {})).status).toBe(401);
    } finally { await running.close(); }
  });
});

describe('the world behind a proxy, on a public address', () => {
  const PUBLIC = 'https://world.example';
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('names itself by the public URL everywhere, and by the listen address when none is given', async () => {
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, publicUrl: `${PUBLIC}/` });
    try {
      expect(running.origin).toBe(PUBLIC);
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await get(running.url, '/play/guest')).toEqual({
        enabled: true, audience: PUBLIC, identityUrl: PUBLIC, bootstrapUrl: `${PUBLIC}/play/provisional`, local: true,
      });
      const page = await fetch(`${running.url}/`);
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("connect-src 'self';");
      expect(csp).not.toContain('127.0.0.1');
      const listed = await get(running.url, '/graphs') as { retained: number; dropped: number; graphs: Array<{ id: string; turtle: string; graph: string }> };
      expect(listed.graphs.length).toBeGreaterThan(0);
      expect(listed.retained).toBe(listed.graphs.length);
      expect(listed.dropped).toBe(0);
      expect(listed.graphs.every(row => row.id.startsWith(`${PUBLIC}/descriptors/`))).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(running.url);
      expect(JSON.stringify(listed)).toContain('did:web:world.example:agents:');
      const turtle = await (await fetch(`${running.url}/affordances`, { headers: { Accept: 'text/turtle' } })).text();
      expect(turtle).toContain(`${PUBLIC}/`);
      expect(turtle).not.toContain('127.0.0.1');
      // A guest's proofs name the public origin, and the owner it yields is on that host.
      const someone = await guest(running.url, PUBLIC);
      expect(someone.ownerDid).toMatch(/^did:web:world\.example:users:u-try-play-/);
    } finally { await running.close(); }

    const plain = await start({ packPath: orchardPath, bots: false, forceLocal: true });
    try {
      expect(plain.origin).toBe(plain.url);
      expect((await get(plain.url, '/play/guest'))['audience']).toBe(plain.url);
    } finally { await plain.close(); }
  }, 30_000);

  it('does not start on a public URL that is not an https origin', async () => {
    await expect(start({ forceLocal: true, publicUrl: 'http://world.example' })).rejects.toThrow(/https/);
    await expect(start({ forceLocal: true, publicUrl: 'https://world.example/world' })).rejects.toThrow(/origin/);
    await expect(start({ forceLocal: true, publicUrl: 'not a url' })).rejects.toThrow(/not a URL/);
  });

  it('answers /health with the build the deploy verifier compares, and facts about the world, to anyone', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    vi.stubEnv('INTEREGO_BUILD_SHA', sha);
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true });
    try {
      const first = await get(running.url, '/health');
      expect(first).toEqual({
        status: 'ok', build: sha, service: 'coached-world-bridge', startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
        pack: { id: loadPackFile(orchardPath).id, title: 'Orchard' }, consultants: 0, door: 'local',
      });
      // The verifier reads exactly this field and compares it with the commit it deployed.
      const verifier = readFileSync(join(here, '../../../tools/railway-redeploy.mjs'), 'utf8');
      expect(verifier).toContain('seen = j.build ??');
      expect(verifier).toContain('if (seen === tag)');
      await guest(running.url);
      expect((await get(running.url, '/health'))['consultants']).toBe(1);
      // No session, and no limit: a deploy that polls it, and a platform health check, are never refused.
      for (let i = 0; i < RATE_RULES.read.limit + 20; i++) {
        const response = await fetch(`${running.url}/health`);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      const answered = await fetch(`${running.url}/health`);
      expect(answered.headers.get('strict-transport-security')).toBe('max-age=31536000');
    } finally { await running.close(); }
    vi.unstubAllEnvs();
    const unbuilt = await start({ packPath: orchardPath, bots: false, forceLocal: true });
    try { expect((await get(unbuilt.url, '/health'))['build']).toBe('unset'); } finally { await unbuilt.close(); }
  }, 30_000);

  it('refuses a client past its limit with 429 and Retry-After, and lets it back when the window ends', async () => {
    let at = 5_000_000;
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, publicUrl: PUBLIC, now: () => at });
    try {
      const ask = (forwarded: string) => fetch(`${running.url}/session/challenge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded }, body: '{}',
      });
      for (let i = 0; i < RATE_RULES.door.limit; i++) expect((await ask('198.51.100.9')).status).toBe(200);
      at += 20_000;
      const refused = await ask('198.51.100.9');
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('40');
      expect(refused.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(await refused.json()).toEqual({ error: 'rate-limited', retryAfterSeconds: 40 });
      // The proxy's own entry is the last one. Putting another address in front changes nothing.
      expect((await ask('192.0.2.50, 198.51.100.9')).status).toBe(429);
      // Someone else is not refused, and neither is a different kind of request from the same client.
      expect((await ask('198.51.100.10')).status).toBe(200);
      expect((await fetch(`${running.url}/world`, { headers: { 'X-Forwarded-For': '198.51.100.9' } })).status).toBe(200);
      at += 40_000;
      expect((await ask('198.51.100.9')).status).toBe(200);
    } finally { await running.close(); }
  }, 30_000);

  it('with no proxy counts the socket, so a caller cannot dodge the limit with a header', async () => {
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, now: () => 1 });
    try {
      const ask = (i: number) => fetch(`${running.url}/session/challenge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` }, body: '{}',
      });
      for (let i = 0; i < RATE_RULES.door.limit; i++) expect((await ask(i)).status).toBe(200);
      expect((await ask(200)).status).toBe(429);
    } finally { await running.close(); }
  }, 30_000);

  it('the guest page signs in again after the world was restarted and its attestation means nothing', async () => {
    // The page itself, run here: its key store and its fetch are the only stand-ins. A redeploy
    // starts a new world on the same public address, with a new door key, so the attestation the
    // browser kept is refused. The page has to notice and bootstrap again, as the same owner.
    const kept = new Map<string, unknown>();
    const idb = {
      open() {
        const request: Record<string, unknown> & { result?: unknown } = {};
        const db = {
          createObjectStore() { /* one store, made on first open */ },
          close() { /* nothing held */ },
          transaction() {
            const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
              objectStore: () => ({
                get(key: string) { queueMicrotask(() => tx.oncomplete?.()); return { result: kept.get(key) }; },
                put(value: unknown, key: string) { kept.set(key, value); queueMicrotask(() => tx.oncomplete?.()); return { result: key }; },
              }),
            };
            return tx;
          },
        };
        queueMicrotask(() => {
          request.result = db;
          (request['onupgradeneeded'] as (() => void) | undefined)?.();
          (request['onsuccess'] as (() => void) | undefined)?.();
        });
        return request;
      },
    };
    vi.stubGlobal('indexedDB', idb);
    const realFetch = globalThis.fetch;
    const asked: Array<{ path: string; status: number }> = [];
    let listening = '';
    // The page asks its own origin. Here that origin is wherever the current world listens.
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(input), PUBLIC);
      expect(target.origin).toBe(PUBLIC);
      const response = await realFetch(`${listening}${target.pathname}`, init);
      asked.push({ path: target.pathname, status: response.status });
      return response;
    });
    const page = await import(/* @vite-ignore */ pathToFileURL(join(here, '../public/guest.js')).href) as {
      signIn(): Promise<{ token: string; ownerDid: string; name: string }>;
    };

    const before = await start({ packPath: orchardPath, bots: false, forceLocal: true, publicUrl: PUBLIC });
    listening = before.url;
    let first: { token: string; ownerDid: string; name: string };
    try {
      first = await page.signIn();
      expect(first.ownerDid).toMatch(/^did:web:world\.example:users:u-try-play-/);
      expect(asked.filter(a => a.path === '/play/provisional').map(a => a.status)).toEqual([200]);
      // Coming back to the same world uses the kept attestation: no new grant, no new bootstrap.
      asked.length = 0;
      expect((await page.signIn()).ownerDid).toBe(first.ownerDid);
      expect(asked.map(a => a.path)).toEqual(['/play/guest', '/session/challenge', '/session']);
    } finally { await before.close(); }

    const after = await start({ packPath: orchardPath, bots: false, forceLocal: true, publicUrl: PUBLIC });
    listening = after.url;
    try {
      asked.length = 0;
      const again = await page.signIn();
      // The kept attestation was tried and refused, then the page went through the door again.
      expect(asked).toEqual([
        { path: '/play/guest', status: 200 },
        { path: '/session/challenge', status: 200 },
        { path: '/session', status: 401 },
        { path: '/play/grant', status: 200 },
        { path: '/play/provisional', status: 200 },
        { path: '/session/challenge', status: 200 },
        { path: '/session', status: 200 },
      ]);
      // Same browser key, same public address: the same owner, in a world that has never seen them.
      expect(again.ownerDid).toBe(first.ownerDid);
      expect(again.token).not.toBe(first.token);
      const view = await (await realFetch(`${after.url}/world`, { headers: { Authorization: `Bearer ${again.token}` } })).json() as { you?: { ownerDid: string; factionId: string | null } };
      expect(view.you).toMatchObject({ ownerDid: first.ownerDid, factionId: null });
      // The session the old world gave out is not one here.
      const stale = await (await realFetch(`${after.url}/world`, { headers: { Authorization: `Bearer ${first.token}` } })).json() as { you?: unknown };
      expect(stale.you).toBeUndefined();
    } finally { await after.close(); }
  }, 30_000);
});

describe('a coached world that offers the general guest door', () => {
  it('registers the return path the fixture names', () => { expect(GENERAL_GUEST_RETURN_PATH).toBe(RETURN_PATH); });

  it('without it, the world is as it was: no offer, and the door\'s paths are not routes', async () => {
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true });
    try {
      const offer = await (await fetch(`${running.url}/play/guest`)).json() as Record<string, unknown>;
      expect(Object.keys(offer)).toEqual(['enabled', 'audience', 'identityUrl', 'bootstrapUrl', 'local']);
      const unknown = await fetch(`${running.url}/play/nothing-here`, { redirect: 'manual' });
      for (const [method, path] of [['GET', '/play/general/start'], ['GET', `${GENERAL_GUEST_RETURN_PATH}?code=a&state=b`], ['POST', '/play/general/session']] as const) {
        const answered = await fetch(`${running.url}${path}`, { method, redirect: 'manual' });
        const same = method === 'GET' ? unknown : await fetch(`${running.url}/play/nothing-here`, { method });
        expect([answered.status, await answered.text()], path).toEqual([same.status, await same.clone().text()]);
        expect(answered.headers.get('set-cookie')).toBeNull();
      }
    } finally { await running.close(); }
  });

  it('takes a browser through identity\'s door and back into a world session, with no bearer in any address', async () => {
    const id = identity();
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, publicUrl: `${WORLD}/`, trustProxy: false, generalDoor: id.doorFor(WORLD, agent) });
    try {
      const offer = await (await fetch(`${running.url}/play/guest`)).json() as { general?: { startUrl: string; sessionUrl: string } };
      expect(offer.general).toEqual({ startUrl: '/play/general/start', sessionUrl: '/play/general/session' });
      const key = newKey();
      const enter = async () => {
        const started = await fetch(`${running.url}/play/general/start`, { redirect: 'manual' });
        expect(started.status).toBe(302);
        const setCookie = started.headers.get('set-cookie')!;
        expect(setCookie).toMatch(/^cpw-guest-door=[A-Za-z0-9_-]{43}; Path=\/play\/general; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
        const back = await id.page(key, started.headers.get('location')!);
        return { cookie: cookieOf(started), back };
      };
      const first = await enter();
      const returnPath = first.back.pathname + first.back.search;
      // Without the cookie of the browser that started the visit, or with another visit's, the return finishes nothing.
      const stranger = await enter();
      expect((await fetch(`${running.url}${first.back.pathname}${first.back.search}`, { redirect: 'manual' })).status).toBe(401);
      expect((await fetch(`${running.url}${first.back.pathname}${first.back.search}`, { redirect: 'manual', headers: { Cookie: stranger.cookie } })).status).toBe(401);
      // A return address planted on this browser (another visit's code and state) signs it in to nothing.
      expect((await fetch(`${running.url}${stranger.back.pathname}${stranger.back.search}`, { redirect: 'manual', headers: { Cookie: first.cookie } })).status).toBe(401);
      const arrived = await fetch(`${running.url}${returnPath}`, { redirect: 'manual', headers: { Cookie: first.cookie } });
      expect(arrived.status).toBe(302);
      expect(arrived.headers.get('location')).toBe('/?arrived=general');
      // The session is collected once, by the browser holding the cookie.
      expect((await fetch(`${running.url}/play/general/session`, { method: 'POST' })).status).toBe(401);
      expect((await fetch(`${running.url}/play/general/session`, { method: 'POST', headers: { Cookie: 'cpw-guest-door=someone-else' } })).status).toBe(401);
      const collected = await fetch(`${running.url}/play/general/session`, { method: 'POST', headers: { Cookie: first.cookie } });
      expect(collected.status).toBe(200);
      expect(collected.headers.get('set-cookie')).toMatch(/^cpw-guest-door=; Path=\/play\/general; Max-Age=0;/);
      const session = await collected.json() as { token: string; ownerDid: string; name: string };
      const userId = generalGuestUserId(playKeyThumbprint(publicPlayKey(key.publicKey.export({ format: 'jwk' }))));
      expect(session.ownerDid).toBe(`did:web:identity.example:users:${userId}`);
      expect((await fetch(`${running.url}/play/general/session`, { method: 'POST', headers: { Cookie: first.cookie } })).status).toBe(401);
      const view = await (await fetch(`${running.url}/world`, { headers: { Authorization: `Bearer ${session.token}` } })).json() as { you?: { name: string } };
      expect(view.you?.name).toBe(session.name);
      // The return address is spent with its code.
      expect((await fetch(`${running.url}${returnPath}`, { redirect: 'manual', headers: { Cookie: first.cookie } })).status).toBe(401);
      // The same browser key coming back is the same consultant.
      const again = await enter();
      await fetch(`${running.url}${again.back.pathname}${again.back.search}`, { redirect: 'manual', headers: { Cookie: again.cookie } });
      const second = await (await fetch(`${running.url}/play/general/session`, { method: 'POST', headers: { Cookie: again.cookie } })).json() as { name: string; token: string };
      expect(second.name).toBe(session.name);
      expect(second.token).not.toBe(session.token);
    } finally { await running.close(); }
  });
});

/**
 * Connect an agent. A consultant pairs their own AI chat session and it becomes the agent they
 * coach. Here a scripted driver plays that session against the HTTP protocol. The verifier is
 * a stand-in passed through the start option that exists for tests; the production verifier
 * is exercised too, by a request it must refuse.
 */
describe('a consultant connects their own agent', () => {
  const DRIVER = 'did:web:agents.example:fictional-chat-session';
  /** Believes what it is told. Signatures are the verifier's business, tested where it lives. */
  const stub = async (body: unknown) => {
    const b = body as { actor?: unknown; payload?: unknown };
    return typeof b.actor === 'string' && b.payload && typeof b.payload === 'object'
      ? { ok: true as const, callerDid: b.actor, payload: b.payload as Record<string, unknown> }
      : { ok: false as const, status: 401, error: 'unsigned' };
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  const send = async (base: string, path: string, body: unknown, token?: string, method = 'POST') => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  type Mission = { title: string; statements: Array<{ actor: { account: { name: string } }; verb: { id: string }; result?: { response?: string } }>; work?: { state: string; text?: string; by?: string; note?: string } };
  const missionOf = async (base: string, token: string) => ((await get(base, '/world', token))['you'] as { mission?: Mission }).mission;
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 400; i++) { const value = await read(); if (done(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
    throw new Error('never happened');
  };
  /** Open a connection as this consultant and have the scripted driver claim it. */
  async function pair(base: string, token: string) {
    const created = await send(base, '/agent-sessions/create', {}, token);
    expect(created.status).toBe(200);
    const signed = { connection_operation: 'agent-session', bridge_audience: base, session_id: created.body['session_id'] };
    const drive = (payload: Record<string, unknown>, actor = DRIVER) => send(base, '/agent-sessions/driver', { actor, payload: { ...signed, ...payload } });
    const claimed = await drive({ operation: 'claim', invite_token: created.body['invite_token'] });
    expect(claimed.status).toBe(200);
    const driverToken = claimed.body['driver_token'];
    return { created: created.body, drive: (payload: Record<string, unknown>) => drive({ driver_token: driverToken, ...payload }) };
  }

  it('the mission goes to the paired session, and what it writes is the agent\'s work, recorded as that agent\'s statement', async () => {
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, agentVerifier: stub, agentAnswerMs: 20_000, agentPollMs: 10 });
    try {
      const page = await fetch(`${running.url}/`);
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      const client = await fetch(`${running.url}/agent-connection.js`);
      expect(client.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(await client.text()).toBe(readFileSync(join(here, '../../_shared/agent-connection/browser-client.js'), 'utf8'));
      expect(readFileSync(join(here, '../public/app.js'), 'utf8')).toContain("from './agent-connection.js'");

      const me = await guest(running.url);
      await post(running.url, '/faction', { factionId: 'north' }, me.token);
      expect(await get(running.url, '/agent-sessions')).toEqual({ enabled: true, root: '/agent-sessions' });
      expect((await get(running.url, '/agent-sessions', me.token))['connection']).toEqual({ state: 'none' });
      // Only a signed-in consultant opens a connection.
      expect((await send(running.url, '/agent-sessions/create', {})).status).toBe(401);

      const { created, drive } = await pair(running.url, me.token);
      expect(String(created['driver_url'])).toBe(`${running.url}/agent-sessions/driver`);
      expect((await get(running.url, '/agent-sessions', me.token))['connection']).toMatchObject({ state: 'connected', actor: DRIVER });
      // The page may look and leave. Only the world queues a mission.
      const fromPage = await send(running.url, '/agent-sessions/browser', { session_id: created['session_id'], operation: 'request', messages: [{ role: 'user', content: 'x' }] }, String(created['browser_token']));
      expect(fromPage.status).toBe(400);
      expect((await send(running.url, '/agent-sessions/browser', { session_id: created['session_id'], operation: 'status' }, String(created['browser_token']))).body['state']).toBe('connected');

      const opened = await post(running.url, '/missions', {}, me.token) as unknown as Mission;
      expect(opened.work).toEqual({ state: 'waiting' });
      const leased = await drive({ operation: 'next' });
      const task = leased.body['task'] as { messages: Array<{ role: string; content: string }> };
      const brief = task.messages.map(m => m.content).join('\n');
      expect(brief).toContain(opened.title);
      expect(brief).toContain('Conditions you are working under:');
      expect(brief).toContain('- nothing yet');
      // The brief says what the agent ran into, never which cause the pack drew.
      const orchard = loadPackFile(orchardPath);
      for (const cause of orchard.causes) expect(brief).not.toContain(cause.label);
      const wrote = 'I walked the made-up rows twice and counted the fictional crates before noon.';
      const finished = await drive({ operation: 'finish', turn_id: leased.body['turn_id'], lease_id: leased.body['lease_id'], revision: leased.body['revision'], text: wrote });
      expect(finished.status).toBe(200);

      const mission = await until(() => missionOf(running.url, me.token), m => m?.work?.state === 'answered');
      expect(mission?.work).toEqual({ state: 'answered', text: wrote, by: DRIVER });
      const work = mission?.statements.filter(s => s.result?.response === wrote) ?? [];
      expect(work).toHaveLength(1);
      // Recorded by the agent, with a verb the pack names, and never a course result verb.
      expect(work[0]?.actor.account.name).toBe(mission?.statements[0]?.actor.account.name);
      expect(work[0]?.verb.id).toBe(`${orchard.profileId}/verbs/${orchard.verbs.progressed}`);
      expect(running.world.log.entries.some(entry => entry.statement.result?.response === wrote && entry.origin === 'world')).toBe(true);
      const feed = (await get(running.url, '/world'))['feed'] as Array<{ text: string; kind: string }>;
      expect(feed.some(item => item.kind === 'agent' && item.text.includes('connected agent'))).toBe(true);

      // The pack's rules still settle it; the work product rides along.
      const settled = await post(running.url, '/missions/intervene', { diagnosis: 'timing', interventionId: 'calendar' }, me.token);
      expect((settled['work'] as { state: string }).state).toBe('answered');
      if (settled['matched'] === true) expect(Number(settled['delta'])).toBeGreaterThan(0); else expect(settled['delta']).toBe(0);

      // The next brief carries what the agent now remembers and what was deployed for it.
      await post(running.url, '/missions', {}, me.token);
      const next = await drive({ operation: 'next' });
      const second = (next.body['task'] as { messages: Array<{ content: string }> }).messages.map(m => m.content).join('\n');
      expect(second).toContain(String(settled['lesson']));
      expect(second).toContain(`- ${orchard.interventions.find(i => i.id === 'calendar')?.label}`);

      // One connection per consultant: opening another closes this one, for the page and the driver.
      const again = await send(running.url, '/agent-sessions/create', {}, me.token);
      expect(again.status).toBe(200);
      expect((await drive({ operation: 'next' })).status).toBe(410);
      expect((await get(running.url, '/agent-sessions', me.token))['connection']).toMatchObject({ state: 'waiting_for_agent' });
      expect((await send(running.url, '/agent-sessions', {}, me.token, 'DELETE')).body).toEqual({ disconnected: true });
      expect((await get(running.url, '/agent-sessions', me.token))['connection']).toEqual({ state: 'none' });
    } finally { await running.close(); }
  }, 60_000);

  it('a paired session that does not answer in time is withdrawn, and the mission runs simulated and says so', async () => {
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, agentVerifier: stub, agentAnswerMs: 200, agentPollMs: 10 });
    try {
      const me = await guest(running.url);
      await post(running.url, '/faction', { factionId: 'north' }, me.token);
      const { drive } = await pair(running.url, me.token);
      const opened = await post(running.url, '/missions', {}, me.token) as unknown as Mission;
      expect(opened.work).toEqual({ state: 'waiting' });
      // The driver picks the turn up and then says nothing.
      const leased = await drive({ operation: 'next' });
      const mission = await until(() => missionOf(running.url, me.token), m => m?.work?.state === 'simulated');
      expect(mission?.work).toEqual({ state: 'simulated', note: 'no answer in time' });
      expect(mission?.statements.length).toBe(opened.statements.length);
      const feed = (await get(running.url, '/world'))['feed'] as Array<{ text: string }>;
      expect(feed.some(item => item.text.includes('did not answer (no answer in time)') && item.text.includes('ran this mission simulated'))).toBe(true);
      // The late answer is refused, so it can not land on this mission or a later one.
      const late = await drive({ operation: 'finish', turn_id: leased.body['turn_id'], lease_id: leased.body['lease_id'], revision: leased.body['revision'], text: 'too late' });
      expect(late.status).toBe(409);
      expect((await missionOf(running.url, me.token))?.work?.state).toBe('simulated');
      const settled = await post(running.url, '/missions/intervene', { diagnosis: 'timing', interventionId: 'calendar' }, me.token);
      expect(typeof settled['delta']).toBe('number');
      // An agent that says it can not do the work falls back the same way, at once.
      await post(running.url, '/missions', {}, me.token);
      const refusedTurn = await drive({ operation: 'next' });
      await drive({ operation: 'finish', turn_id: refusedTurn.body['turn_id'], lease_id: refusedTurn.body['lease_id'], revision: refusedTurn.body['revision'], error: 'made-up failure' });
      const failed = await until(() => missionOf(running.url, me.token), m => m?.work?.state === 'simulated');
      expect(failed?.work?.note).toBe('it reported that it could not do the work');
    } finally { await running.close(); }
  }, 60_000);

  it('settling a mission while the agent is still writing frees the agent for the next mission', async () => {
    // A long answer window: nothing here may be explained by the wait running out.
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true, agentVerifier: stub, agentAnswerMs: 60_000, agentPollMs: 10 });
    try {
      const me = await guest(running.url);
      await post(running.url, '/faction', { factionId: 'north' }, me.token);
      const { drive } = await pair(running.url, me.token);
      const first = await post(running.url, '/missions', {}, me.token) as unknown as Mission;
      expect(first.work).toEqual({ state: 'waiting' });
      const stale = await drive({ operation: 'next' });
      // The consultant does not wait for the agent: they diagnose and deploy.
      await post(running.url, '/missions/intervene', { diagnosis: 'timing', interventionId: 'calendar' }, me.token);
      // The answer to the mission that is over is refused.
      const late = await drive({ operation: 'finish', turn_id: stale.body['turn_id'], lease_id: stale.body['lease_id'], revision: stale.body['revision'], text: 'an answer to a mission that has ended' });
      expect(late.status).toBe(409);
      // The next mission goes to the agent, not to the simulation.
      const second = await post(running.url, '/missions', {}, me.token) as unknown as Mission;
      expect(second.work).toEqual({ state: 'waiting' });
      const fresh = await drive({ operation: 'next' });
      expect(fresh.body['turn_id']).not.toBe(stale.body['turn_id']);
      const done = await drive({ operation: 'finish', turn_id: fresh.body['turn_id'], lease_id: fresh.body['lease_id'], revision: fresh.body['revision'], text: 'Counted the made-up crates twice and wrote the tally down.' });
      expect(done.status).toBe(200);
      const answered = await until(() => missionOf(running.url, me.token), m => m?.work?.state === 'answered');
      expect(answered?.work?.text).toBe('Counted the made-up crates twice and wrote the tally down.');
    } finally { await running.close(); }
  }, 60_000);

  it('with no way to verify an agent the door answers 503, the page is told, and missions are as they were', async () => {
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true });
    try {
      const me = await guest(running.url);
      await post(running.url, '/faction', { factionId: 'north' }, me.token);
      expect(await get(running.url, '/agent-sessions', me.token)).toEqual({ enabled: false, root: '/agent-sessions' });
      for (const path of ['/agent-sessions/create', '/agent-sessions/browser', '/agent-sessions/driver']) {
        const refused = await send(running.url, path, {}, me.token);
        expect(refused.status, path).toBe(503);
        expect(refused.body['error']).toBe('agent-connect-unconfigured');
      }
      const opened = await post(running.url, '/missions', {}, me.token) as unknown as Mission;
      expect(opened.work).toBeUndefined();
      expect(opened.statements.length).toBeGreaterThan(1);
    } finally { await running.close(); }
  }, 30_000);

  it('in production the door opens on a pod origin, and a claim nobody signed is refused by the real verifier', async () => {
    vi.stubEnv('CPW_POD_ORIGIN', 'http://pods.example');
    await expect(start({ packPath: orchardPath, bots: false, forceLocal: true })).rejects.toThrow(/https/);
    vi.stubEnv('CPW_POD_ORIGIN', 'https://pods.example');
    const running = await start({ packPath: orchardPath, bots: false, forceLocal: true });
    try {
      const me = await guest(running.url);
      expect((await get(running.url, '/agent-sessions'))['enabled']).toBe(true);
      const created = await send(running.url, '/agent-sessions/create', {}, me.token);
      const payload = { connection_operation: 'agent-session', bridge_audience: running.url, session_id: created.body['session_id'], operation: 'claim', invite_token: created.body['invite_token'] };
      // The stand-in's shape means nothing here, and neither does a bare payload.
      for (const body of [{ actor: DRIVER, payload }, payload, { _signature: '0xmade-up', _signed_payload: JSON.stringify({ ...payload, agent_id: DRIVER, timestamp: new Date().toISOString() }) }]) {
        const refused = await send(running.url, '/agent-sessions/driver', body);
        expect(refused.status).toBe(401);
        expect(refused.body['error']).toBe('A verified, delegated Interego agent is required.');
      }
      expect((await get(running.url, '/agent-sessions', me.token))['connection']).toMatchObject({ state: 'waiting_for_agent' });
      // A key that signs the real envelope as itself is believed, with no pod read: the same
      // envelope the workbench accepts (sha256 of the payload, signed as a personal message).
      const wallet = Wallet.createRandom();
      const envelope = async (signer: { signMessage(message: string): Promise<string> }) => {
        const signedPayload = JSON.stringify({ ...payload, agent_id: `did:ethr:${wallet.address}`, timestamp: new Date().toISOString() });
        return { _signed_payload: signedPayload, _signature: await signer.signMessage(`sha256:${createHash('sha256').update(signedPayload).digest('hex')}`) };
      };
      // Signed by someone else while naming that key: not direct, and no delegation to read.
      expect((await send(running.url, '/agent-sessions/driver', await envelope(Wallet.createRandom()))).status).toBe(401);
      const claimed = await send(running.url, '/agent-sessions/driver', await envelope(wallet));
      expect(claimed.status).toBe(200);
      expect((await get(running.url, '/agent-sessions', me.token))['connection']).toMatchObject({ state: 'connected', actor: `did:ethr:${wallet.address}` });
    } finally { await running.close(); }
  }, 30_000);
});
