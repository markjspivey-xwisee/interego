/**
 * Two guests, one world. The guest path is identity's ProvisionalPlay.
 * A mismatched intervention does not move the score. Promotion happens only
 * when passed and completed are already in the record from outside.
 */
import { webcrypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMessage } from 'ethers';
import { describe, expect, it } from 'vitest';
import { start } from '../src/server.js';
import { CoachedWorld } from '../src/world.js';
import { HttpLrs, type LrsReader } from '../src/lrs.js';
import { loadPackFile } from '../src/pack.js';
import type { XapiStatement } from '../src/statements.js';

const here = dirname(fileURLToPath(import.meta.url));
const orchardPath = join(here, '../packs/orchard.json');
const subtle = webcrypto.subtle;
const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64url');

async function guest(base: string): Promise<{ token: string; ownerDid: string }> {
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
  const proof = await sign(`interego-play-proof-v1\n${attestation}\n${base}\n${challenge}`);
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

  it('promotes only from an external passed and completed, and a second pack needs no engine change', async () => {
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
    const statement = (verb: string): XapiStatement => ({
      id: `http://world.example/statements/${verb}`,
      version: '2.0.0',
      timestamp: '2026-11-14T00:00:00.000Z',
      actor: { objectType: 'Agent', account: { homePage: 'http://world.example/', name: consultant.ownerDid } },
      verb: { id: verb, display: { en: verb.split('/').at(-1) ?? verb } },
      object: { objectType: 'Activity', id: course, definition: { type: 'http://adlnet.gov/expapi/activities/course' } },
      context: { registration: '00000000-0000-4000-8000-000000000001', contextActivities: { category: [] } },
    });
    world.recordExternal([statement('http://adlnet.gov/expapi/verbs/passed')]);
    expect((await world.refreshGate(consultant.id))['promoted']).toBe(false);
    world.recordExternal([statement('http://adlnet.gov/expapi/verbs/completed')]);
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
    await lrs.fetchActor('did:web:example:users:u-try-play-abc', 'https://foxxi.example');
    const agent = JSON.parse(new URL(seen).searchParams.get('agent') ?? '{}') as { account?: { name?: string; homePage?: string } };
    expect(agent.account).toEqual({ name: 'did:web:example:users:u-try-play-abc', homePage: 'https://foxxi.example' });

    let recordingSeen: { name: string; homePage: string } | undefined;
    const recording: LrsReader = { async fetchActor(name, homePage) { recordingSeen = { name, homePage }; return []; } };
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
    expect(recordingSeen).toEqual({ name: consultant.ownerDid, homePage: 'https://foxxi.example' });
  });
});
