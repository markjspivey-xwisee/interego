/**
 * Two guests, one world. The guest path is identity's ProvisionalPlay.
 * A mismatched intervention does not move the score. Promotion happens only
 * when passed and completed are already in the record from outside.
 *
 * Every test that needs the HTTP server is in this file, the deployed surface included:
 * the public URL, /health, the request limits, and the guest page finding its way back in
 * after the world was restarted.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyMessage } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RATE_RULES } from '../src/rate-limit.js';
import { start } from '../src/server.js';
import { CoachedWorld } from '../src/world.js';
import { FoxxiCourseLauncher } from '../src/course-launch.js';
import { CMI5_CATEGORY, HttpLrs, SATISFIED, type LrsQuery, type LrsReader } from '../src/lrs.js';
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
      lrs: recording, actorHomePage: 'https://foxxi.example',
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
    const satisfied: XapiStatement = {
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
      lrs, actorHomePage: home,
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
      lrs: down, actorHomePage: home,
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
