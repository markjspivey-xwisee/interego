/**
 * What has to hold before this world is put on a public address, none of which is the game:
 *
 *   - the public URL is an https origin and nothing else, or the process does not start, and
 *     one client gets a fixed number of requests a minute, counted by address. Both are the
 *     shared `applications/_shared/http-guard`, and are tested with it in
 *     `applications/_shared/tests/http-guard.test.ts`. What is this world's own is which
 *     request falls under which limit, and that is here;
 *   - a world that runs for days keeps the newest graphs and statements and drops the rest,
 *     and a territory's descriptor still supersedes the right one after that one was dropped.
 *
 * Nothing here starts the HTTP server; `shared-world.test.ts` does that.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_LESSONS, MAX_AGENT_SCORES, MAX_PUBLISHED_GRAPHS, MAX_RATE_CLIENTS, MAX_STATEMENTS, trim,
} from '../src/bounded.js';
import { StatementLog } from '../src/lrs.js';
import { loadPackFile } from '../src/pack.js';
import { RATE_RULES, rateClassFor } from '../src/rate-limit.js';
import type { XapiStatement } from '../src/statements.js';
import { CoachedWorld } from '../src/world.js';

const here = dirname(fileURLToPath(import.meta.url));
const orchard = loadPackFile(join(here, '../packs/orchard.json'));

/** Signing is not what these tests are about, and thousands of real signatures would be most of their time. */
const signer = { address: '0x00000000000000000000000000000000000000aa', signMessage: async () => '0xmade-up-signature' };

describe('the request classes of this world', () => {
  it('puts each request under one limit, and health under none', () => {
    for (const path of ['/session/challenge', '/play/grant', '/play/provisional', '/session']) expect(rateClassFor('POST', path)).toBe('door');
    for (const path of ['/faction', '/missions', '/missions/intervene', '/market/transfer', '/pacts', '/gate/launch', '/gate/refresh', '/tick']) {
      expect(rateClassFor('POST', path)).toBe('write');
    }
    expect(rateClassFor('DELETE', '/pacts')).toBe('write');
    for (const path of ['/', '/world', '/graphs', '/profile', '/play/guest', '/nothing-here']) expect(rateClassFor('GET', path)).toBe('read');
    expect(rateClassFor('GET', '/health')).toBeUndefined();
    expect(RATE_RULES.door.limit).toBeLessThan(RATE_RULES.write.limit);
    expect(RATE_RULES.write.limit).toBeLessThan(RATE_RULES.read.limit);
  });

  it('gives the shared limiter a ceiling of its own', () => {
    expect(MAX_RATE_CLIENTS).toBeGreaterThan(1_000);
  });
});

describe('what a long-running world keeps', () => {
  const statement = (id: string): XapiStatement => ({
    id, version: '2.0.0', timestamp: '2026-11-14T00:00:00.000Z',
    actor: { objectType: 'Agent', account: { homePage: 'http://world.example/', name: 'did:web:world.example:agents:fictional' } },
    verb: { id: 'https://verbs.example/observed', display: { en: 'observed' } },
    object: { objectType: 'Activity', id: 'https://activities.example/made-up', definition: { type: 'https://activities.example/type' } },
    context: { registration: '00000000-0000-4000-8000-000000000002', contextActivities: { category: [] } },
  });

  it('trim drops from the front and says how many went', () => {
    const list = [1, 2, 3, 4, 5];
    expect(trim(list, 3)).toBe(2);
    expect(list).toEqual([3, 4, 5]);
    expect(trim(list, 3)).toBe(0);
    expect(trim(list, 10)).toBe(0);
  });

  it('the statement log keeps the newest per origin, counts what it dropped, and answers `has` for what it holds', () => {
    const log = new StatementLog(3);
    log.add(['w1', 'w2', 'w3', 'w4', 'w5'].map(statement), 'world');
    log.add([statement('e1')], 'external');
    expect(log.entries.map(entry => entry.statement.id)).toEqual(['w3', 'w4', 'w5', 'e1']);
    expect(log.retained).toBe(4);
    expect(log.dropped).toBe(2);
    expect(log.has('w5')).toBe(true);
    expect(log.has('w1')).toBe(false);
    expect(log.has('e1')).toBe(true);
    // The world's stream never stops. It does not push out what was read from outside.
    for (let i = 0; i < 50; i++) log.add([statement(`more-${i}`)], 'world');
    expect(log.has('e1')).toBe(true);
    expect(log.entries.filter(entry => entry.origin === 'world')).toHaveLength(3);
    // The same id twice is held until both copies have gone.
    const twice = new StatementLog(2);
    twice.add([statement('same'), statement('same')], 'external');
    twice.add([statement('next')], 'external');
    expect(twice.has('same')).toBe(true);
    twice.add([statement('last')], 'external');
    expect(twice.has('same')).toBe(false);
    expect(new StatementLog().retained).toBe(0);
    expect(MAX_STATEMENTS).toBeGreaterThan(100);
  });

  it('after thousands of ticks the graph list and the statement log sit at their ceilings', async () => {
    const world = await CoachedWorld.create({ pack: orchard, base: 'http://world.example/', didHost: 'world.example', seed: 7, wallet: signer });
    const opening = world.graphStats().retained;
    expect(world.graphStats().dropped).toBe(0);
    const ticks = MAX_PUBLISHED_GRAPHS + 400;
    for (let i = 0; i < ticks; i++) await world.tick();
    const stats = world.graphStats();
    expect(stats.retained).toBe(MAX_PUBLISHED_GRAPHS);
    expect(world.graphs()).toHaveLength(MAX_PUBLISHED_GRAPHS);
    // Every tick publishes one territory graph, so nothing was lost uncounted.
    expect(stats.retained + stats.dropped).toBe(opening + ticks);
    expect(world.log.entries.filter(entry => entry.origin === 'world')).toHaveLength(MAX_STATEMENTS);
    expect(world.log.retained).toBe(MAX_STATEMENTS);
    expect(world.log.dropped).toBeGreaterThan(0);
  }, 60_000);

  it('a territory still supersedes its previous descriptor after that one was dropped', async () => {
    const world = await CoachedWorld.create({ pack: orchard, base: 'http://world.example/', didHost: 'world.example', seed: 8, wallet: signer });
    for (let i = 0; i < MAX_PUBLISHED_GRAPHS + 400; i++) await world.tick();
    const rows = world.graphs();
    const retained = new Set(rows.map(row => row.id));
    const territories = rows.filter(row => row.kind === 'territory');
    expect(territories).toHaveLength(rows.length);
    const shape = /^http:\/\/world\.example\/descriptors\/territory\/([^/]+)\/v\/(\d+)$/;
    let pointsAtDropped = 0;
    const lastVersion = new Map<string, number>();
    for (const row of territories) {
      const [, territoryId, version] = shape.exec(row.id) ?? [];
      expect(territoryId, row.id).toBeTruthy();
      expect(row.version).toBe(Number(version));
      expect(row.version).toBeGreaterThan(1);
      // Each version supersedes exactly the one before it, by IRI, whether or not that row is still here.
      expect(row.supersedes).toBe(`http://world.example/descriptors/territory/${territoryId}/v/${row.version - 1}`);
      expect(row.turtle).toContain(`<${row.supersedes}>`);
      expect(() => new URL(row.supersedes ?? '')).not.toThrow();
      if (!retained.has(row.supersedes ?? '')) pointsAtDropped += 1;
      // Within what is retained, a territory's versions run on without a gap.
      const before = lastVersion.get(territoryId ?? '');
      if (before !== undefined) expect(row.version).toBe(before + 1);
      lastVersion.set(territoryId ?? '', row.version);
    }
    // One per territory: the oldest retained version of each names a descriptor that is gone.
    expect(pointsAtDropped).toBe(lastVersion.size);
    expect(lastVersion.size).toBe(orchard.territories.length);
  }, 60_000);

  it('an agent keeps its newest lessons and scores, and still knows every cause it has learned', async () => {
    const pack = { ...orchard, influence: 1_000_000 };
    const world = await CoachedWorld.create({ pack, base: 'http://world.example/', didHost: 'world.example', seed: 9, wallet: signer });
    const consultant = world.admit({ ownerDid: 'did:web:world.example:users:u-try-play-fictional', userId: 'u-try-play-fictional', podUrl: 'http://world.example/pods/f/', agentDid: 'did:web:world.example:agents:mcp-fictional' });
    await world.joinFaction(consultant.id, 'north');
    const runs = MAX_AGENT_SCORES + 30;
    for (let i = 0; i < runs; i++) {
      await world.startMission(consultant.id);
      await world.intervene(consultant.id, 'timing', 'calendar');
    }
    const you = world.view(consultant.id)['you'] as { diagTotal: number; roster: Array<{ hist: number[]; memory: Array<{ text: string }> }> };
    expect(you.diagTotal).toBe(runs);
    const agent = you.roster[0];
    expect(agent?.memory).toHaveLength(MAX_AGENT_LESSONS);
    expect(agent?.hist).toHaveLength(MAX_AGENT_SCORES);
    // The descriptor carries the same newest lessons, not every lesson there ever was.
    const head = world.graphs().filter(row => row.kind === 'agent').at(-1);
    expect(head?.version).toBe(runs + 1);
    expect(head?.supersedes).toMatch(/\/descriptors\/agent\/a\d+\/v\/\d+$/);
    expect(head?.turtle.length).toBeLessThan(200_000);
  }, 60_000);
});
