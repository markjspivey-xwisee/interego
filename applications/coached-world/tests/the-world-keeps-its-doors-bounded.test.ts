/**
 * Three edges of the world's HTTP surface that are not the game:
 * the LRS reader carries a credential and follows the LRS's own `more`, so it must not follow one
 * that names another origin; and the sign-in challenge and session tables are filled by callers
 * nobody has verified yet, so they have a ceiling.
 */
import { describe, expect, it } from 'vitest';
import { HttpLrs, SATISFIED } from '../src/lrs.js';
import { MAX_CHALLENGES, MAX_SESSIONS, bound, start } from '../src/server.js';

const QUERY = { verb: SATISFIED, activity: 'https://courses.example/made-up-course' };
const page = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('the LRS reader', () => {
  it('follows `more` on the LRS\'s own origin, relative or absolute, with its credential', async () => {
    const asked: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      asked.push({ url: href, authorization: (init?.headers as Record<string, string>)['Authorization'] });
      if (asked.length === 1) return page({ statements: [], more: '/xapi/statements?cursor=two' });
      if (asked.length === 2) return page({ statements: [], more: 'https://lrs.example/xapi/statements?cursor=three' });
      return page({ statements: [] });
    }) as typeof fetch;
    const lrs = new HttpLrs('https://lrs.example/xapi/statements', 'Basic made-up', fetchImpl);
    await expect(lrs.fetchActor('did:web:example.org:users:fictional', 'https://home.example', QUERY)).resolves.toEqual([]);
    expect(asked.map(a => new URL(a.url).origin)).toEqual(['https://lrs.example', 'https://lrs.example', 'https://lrs.example']);
    expect(asked.every(a => a.authorization === 'Basic made-up')).toBe(true);
  });

  it('does not follow `more` to another origin, so the credential is never sent there', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return page({ statements: [], more: 'https://elsewhere.example/collect' });
    }) as typeof fetch;
    const lrs = new HttpLrs('https://lrs.example/xapi/statements', 'Basic made-up', fetchImpl);
    await expect(lrs.fetchActor('did:web:example.org:users:fictional', 'https://home.example', QUERY)).rejects.toThrow(/another origin/);
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]!).origin).toBe('https://lrs.example');
  });

  it('asks with a time limit and without following redirects', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => { seen = init; return page({ statements: [] }); }) as typeof fetch;
    await new HttpLrs('https://lrs.example/xapi/statements', undefined, fetchImpl).fetchActor('did:web:example.org:users:fictional', 'https://home.example', QUERY);
    expect(seen?.redirect).toBe('error');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('the sign-in tables', () => {
  it('bound drops the oldest entries first and leaves a map under its ceiling alone', () => {
    const map = new Map<string, number>([['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    bound(map, 2);
    expect([...map.keys()]).toEqual(['c', 'd']);
    bound(map, 5);
    expect([...map.keys()]).toEqual(['c', 'd']);
    expect(MAX_CHALLENGES).toBeGreaterThan(0);
    expect(MAX_SESSIONS).toBeGreaterThan(0);
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
