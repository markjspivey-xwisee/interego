import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IRI } from '@interego/core';
import { LtiPlatform, attachLtiPlatformRoutes, type PlatformSnapshot } from '../src/lti-platform.js';
import { LtiPlatformReadiness, isPlatformSnapshot } from '../src/lti-platform-readiness.js';
import { FOXXI_SNAPSHOT_TYPES, dirty, flushSnapshot, loadLatestSnapshotStrict, registerSnapshot, type StrictSnapshotResult } from '../src/pod-snapshot-publisher.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { AGS_SCOPE } from '../src/lti13.js';

const typeIri = FOXXI_SNAPSHOT_TYPES.LtiPlatformGradebook;
const source = 'did:web:tenant.example' as IRI;
const person = 'https://identity.example/users/test/profile#me';
const course = { id: 'signalkeeper-test', title: 'Synthetic original attempt' };
const originalTime = '2026-10-31T18:00:00.000Z';
const base = 'https://bridge.example';

function original(): PlatformSnapshot {
  const platform = new LtiPlatform({ selfBaseUrl: base });
  const launch = platform.beginLaunch({ sub: person, podUrl: 'https://pod.example/person/' }, course);
  if (!launch.ok) throw new Error('fixture launch failed');
  const id = String(launch.lineItem.id).split('/').at(-1)!;
  expect(platform.acceptScore(platform.context.id, id, { userId: person, scoreGiven: 100, scoreMaximum: 100,
    activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: originalTime }, Date.parse(originalTime))).toEqual({ ok: true });
  return platform.snapshot();
}

function graph(snapshot: unknown, options: { type?: string; digest?: string } = {}): string {
  const json = JSON.stringify(snapshot);
  const digest = options.digest ?? createHash('sha256').update(json).digest('hex');
  return `<urn:foxxi:lti-platform-snapshot:v7> a <${options.type ?? typeIri}> ;
    <http://purl.org/dc/terms/identifier> "sha256:${digest}" ;
    <${FOXXI_NS}snapshotVersion> "7" ;
    <${FOXXI_NS}bundleJson> "${Buffer.from(json).toString('base64')}" .`;
}

const config = (fetch: typeof globalThis.fetch) => ({ podUrl: 'https://pod.example/tenant/', authoritativeSource: source, fetch });
const strict = (fetch: typeof globalThis.fetch, timeoutMs?: number) => loadLatestSnapshotStrict('lti-platform', {
  config: config(fetch), typeIri, validate: isPlatformSnapshot, timeoutMs,
});
const loaded = (snapshot: PlatformSnapshot): StrictSnapshotResult<PlatformSnapshot> => ({ state: 'loaded', snapshot, revision: { sha256: 'a'.repeat(64), version: 7 } });
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

describe('strict opt-in snapshot read', () => {
  it('reads the exact graph, validates type/shape/digest, and reports a bounded content revision', async () => {
    const snap = original();
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(graph(snap), { headers: { etag: '"revision-7"' } }));
    const result = await strict(fetcher);
    expect(result).toMatchObject({ state: 'loaded', snapshot: snap, revision: { etag: '"revision-7"', version: 7 } });
    expect(fetcher).toHaveBeenCalledWith('https://pod.example/tenant/foxxi/snapshots/lti-platform-snapshot-graph.trig', expect.objectContaining({ redirect: 'manual', cache: 'no-store' }));
  });

  it('only a definite 404 is absence; unavailable storage is never an empty gradebook', async () => {
    expect(await strict(async () => new Response('', { status: 404 }))).toEqual({ state: 'absent' });
    for (const status of [302, 401, 403, 500, 503]) expect(await strict(async () => new Response('', { status }))).toEqual({ state: 'unavailable', reason: 'http', status });
    expect(await strict(async () => { throw new Error('private upstream text'); })).toEqual({ state: 'unavailable', reason: 'transport' });
    expect(await loadLatestSnapshotStrict('lti-platform', { config: null, typeIri, validate: isPlatformSnapshot })).toEqual({ state: 'unavailable', reason: 'not-configured' });
  });

  it('rejects malformed, wrong-type, wrong-digest and wrong-shape snapshots before restoration', async () => {
    for (const body of ['not turtle', graph({}), graph(original(), { type: 'urn:wrong' }), graph(original(), { digest: '0'.repeat(64) }), graph({ lineItems: [], members: [], results: [['unknown', []]] })]) {
      expect(await strict(async () => new Response(body))).toEqual({ state: 'unavailable', reason: 'invalid-snapshot' });
    }
    expect(await strict(async () => new Response(graph({ lineItems: [], results: [], members: [] })))).toMatchObject({ state: 'loaded', snapshot: { lineItems: [], results: [], members: [] } });
  });

  it('bounds a hung transport and aborts it without exposing its request', async () => {
    let signal: AbortSignal | null | undefined;
    expect(await strict(async (_url, init) => { signal = init?.signal; return await new Promise<Response>(() => undefined); }, 10)).toEqual({ state: 'unavailable', reason: 'transport' });
    expect(signal?.aborted).toBe(true);
  });

  it('does not let a response arriving after the deadline hydrate the cache', async () => {
    let release!: (r: Response) => void;
    const platform = new LtiPlatform({ selfBaseUrl: base });
    const readiness = new LtiPlatformReadiness({ load: () => strict(async () => await new Promise<Response>((r) => { release = r; }), 10),
      restore: (s) => platform.restore(s), collect: () => platform.snapshot() });
    expect(await readiness.ensureReady()).toBe(false);
    release(new Response(graph(original())));
    await new Promise<void>((r) => setImmediate(r));
    expect(readiness.diagnostics().state).toBe('unavailable');
    expect(readiness.snapshotForPublish()).toBeNull();
    expect(platform.gradebookFor(person)).toEqual([]);
  });
});

describe('one gradebook hydration barrier', () => {
  it('blocks actual stateful HTTP reads while hydration is pending, then recovers the original row without any grade repost', async () => {
    let resolve!: (value: StrictSnapshotResult<PlatformSnapshot>) => void;
    const read = vi.fn(() => new Promise<StrictSnapshotResult<PlatformSnapshot>>((r) => { resolve = r; }));
    const changed = vi.fn();
    const platform: LtiPlatform = new LtiPlatform({ selfBaseUrl: base, onChange: changed, ensureReady: () => readiness.ensureReady(),
      // This fixture isolates hydration; lti-own-lms.test exercises the real JWT/JWKS verifier.
      verifyJwt: async (jwt) => ({ ok: true, payload: JSON.parse(jwt) as Record<string, unknown> }) });
    const readiness: LtiPlatformReadiness = new LtiPlatformReadiness({ load: read, restore: (s) => platform.restore(s), collect: () => platform.snapshot() });
    const app = express();
    attachLtiPlatformRoutes(app, platform);
    const server = createServer(app); servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pending = fetch(`${local}/lti/platform/contexts/foxxi-open`);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let settled = false; void pending.then(() => { settled = true; });
    expect(await (await fetch(`${local}/lti/platform/.well-known/openid-configuration`)).json()).toMatchObject({ issuer: platform.issuer });
    expect(settled).toBe(false);
    expect(readiness.snapshotForPublish()).toBeNull();
    const second = readiness.ensureReady();
    resolve(loaded(original()));
    expect(await second).toBe(true);
    expect((await pending).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(platform.gradebookFor(person)).toEqual([expect.objectContaining({ courseId: course.id,
      result: expect.objectContaining({ timestamp: originalTime, resultScore: 100, gradingProgress: 'FullyGraded' }) })]);
    const now = Math.floor(Date.now() / 1000);
    const token = await platform.token({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: JSON.stringify({ iss: platform.tool.clientId, sub: platform.tool.clientId, aud: platform.tokenUrl, iat: now, exp: now + 60, jti: 'read-original' }), scope: AGS_SCOPE.result });
    if (!token.ok) throw new Error('fixture token failed');
    const originalItem = platform.gradebookFor(person)[0]!.lineItem;
    const results = await fetch(`${local}${new URL(String(originalItem.id)).pathname}/results?user_id=${encodeURIComponent(person)}`,
      { headers: { Authorization: `Bearer ${String(token.body.access_token)}` } });
    expect(results.status).toBe(200);
    expect(await results.json()).toEqual([expect.objectContaining({ userId: person, resultScore: 100, resultMaximum: 100 })]);
    expect(readiness.diagnostics()).toMatchObject({ state: 'loaded', revision: { sha256: 'a'.repeat(64) }, counts: { lineItems: 1, results: 1, members: 1 } });
    expect(JSON.stringify(readiness.diagnostics())).not.toContain(person);
    expect(JSON.stringify(readiness.diagnostics())).not.toContain(originalTime);
  });

  it('returns HTTP503 on a failed load, coalesces retry after backoff and restores the same original row', async () => {
    let clock = 1000;
    const read = vi.fn<() => Promise<StrictSnapshotResult<PlatformSnapshot>>>()
      .mockResolvedValueOnce({ state: 'unavailable', reason: 'http', status: 503 }).mockResolvedValueOnce(loaded(original()));
    const platform: LtiPlatform = new LtiPlatform({ selfBaseUrl: base, ensureReady: () => readiness.ensureReady() });
    const readiness: LtiPlatformReadiness = new LtiPlatformReadiness({ load: read, restore: (s) => platform.restore(s), collect: () => platform.snapshot(), now: () => clock });
    const app = express(); attachLtiPlatformRoutes(app, platform);
    const server = createServer(app); servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/lti/platform/contexts/foxxi-open`;
    const refused = await fetch(url);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'lti_gradebook_unavailable' });
    expect(await readiness.ensureReady()).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(readiness.snapshotForPublish()).toBeNull();
    clock += 1001;
    expect(await Promise.all([readiness.ensureReady(), readiness.ensureReady()])).toEqual([true, true]);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await fetch(url)).status).toBe(200);
    expect(platform.gradebookFor(person)[0]?.result?.timestamp).toBe(originalTime);
  });

  it('does not publish or mark a successful revision from dirty/flush while unavailable, and never dirties a restored snapshot', async () => {
    const targetRequests: string[] = [];
    const network = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url).includes('lti-platform-test-readiness')) targetRequests.push(String(url));
      throw new Error('synthetic publisher transport is disabled');
    });
    const changed = vi.fn();
    const platform = new LtiPlatform({ selfBaseUrl: base, onChange: changed });
    const readiness = new LtiPlatformReadiness({ load: async () => ({ state: 'unavailable', reason: 'transport' }),
      restore: (s) => platform.restore(s), collect: () => platform.snapshot() });
    registerSnapshot({ surface: 'lti-platform-test-readiness', typeIri, collect: () => readiness.snapshotForPublish(), debounceMs: 1,
      config: config(network) });
    dirty('lti-platform-test-readiness');
    await flushSnapshot('lti-platform-test-readiness');
    expect(await readiness.ensureReady()).toBe(false);
    await flushSnapshot('lti-platform-test-readiness');
    expect(targetRequests).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('allows honest initialization after definite absence, but validates even an injected loader before restore', async () => {
    for (const state of ['absent', 'loaded'] as const) {
      const platform = new LtiPlatform({ selfBaseUrl: base });
      const readiness = new LtiPlatformReadiness({ load: async () => state === 'absent' ? { state } : loaded({ lineItems: [], results: [], members: [] }),
        restore: (s) => platform.restore(s), collect: () => platform.snapshot() });
      expect(await readiness.ensureReady()).toBe(true);
      expect(readiness.diagnostics()).toMatchObject({ state, counts: { lineItems: 0, results: 0, members: 0 } });
      expect(readiness.snapshotForPublish()).toEqual({ lineItems: [], results: [], members: [] });
    }
    const restore = vi.fn();
    const readiness = new LtiPlatformReadiness({ load: async () => loaded({} as PlatformSnapshot), restore,
      collect: () => ({ lineItems: [], results: [], members: [] }) });
    expect(await readiness.ensureReady()).toBe(false);
    expect(restore).not.toHaveBeenCalled();
  });

  it('wires the production signed launch/gradebook to the same barrier and guards the snapshot collector', () => {
    const code = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    for (const [route, next] of [['/agent/lti/launch', '/agent/lti/gradebook'], ['/agent/lti/gradebook', '// PUSH path:']]) {
      const section = code.slice(code.indexOf(`app.post('${route}'`), code.indexOf(next!, code.indexOf(`app.post('${route}'`) + route!.length));
      expect(section).toContain('await ltiPlatform.ensureReady()');
      expect(section.indexOf('await ltiPlatform.ensureReady()')).toBeLessThan(section.indexOf(route === '/agent/lti/launch' ? 'ltiPlatform.beginLaunch' : 'ltiPlatform.gradebookFor'));
    }
    expect(code).toContain('collect: () => ltiPlatformReadiness.snapshotForPublish()');
    expect(code).not.toContain("void loadBridgeSnap<PlatformSnapshot>('lti-platform')");
  });
});
