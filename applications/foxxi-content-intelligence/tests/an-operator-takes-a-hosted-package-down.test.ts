/**
 * Taking a hosted package down asks for the tenant's admin, by signature. The operator of the
 * bridge holds no such key in a session that does not read the service's secrets, and still has
 * to be able to remove what the bridge serves: FOXXI_HOSTED_PACKAGES_TAKEN_DOWN lists packages by
 * sha-256, and the bridge removes them at start and does not keep or serve them while listed.
 */
import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HostedPackages, takenDownPackages } from '../src/scorm-hosting.js';

/** A made-up package: one page, nothing real in it. */
function madeUpPackage(word: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from(`<html><body>${word}</body></html>`));
  return zip.toBuffer();
}
const shaOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A pod that keeps what is PUT, lists its container, and forgets what is DELETEd. */
function pod(opts: { refuseDelete?: boolean } = {}) {
  const kept = new Map<string, Buffer>();
  const deleted: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (method === 'PUT') {
      if (!url.endsWith('/')) kept.set(url, Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer()));
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      if (opts.refuseDelete) return new Response(null, { status: 500 });
      deleted.push(url);
      return new Response(null, { status: kept.delete(url) ? 205 : 404 });
    }
    if (url.endsWith('/')) return new Response([...kept.keys()].filter(k => k.startsWith(url)).map(k => `<${k}> a <http://www.w3.org/ns/ldp#Resource> .`).join('\n'), { status: 200 });
    const body = kept.get(url);
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { kept, deleted, fetchFn };
}
const POD = 'https://pod.example/tenant/';

describe('the operator\'s take-down list', () => {
  it('is read from one setting, and an entry that is no sha-256 takes nothing down', () => {
    const a = 'a'.repeat(64), b = 'B'.repeat(64);
    const read = takenDownPackages(` ${a},${b}\n not-a-sha  ${a.slice(0, 63)} `);
    expect([...read.shas]).toEqual([a, b.toLowerCase()]);
    expect(read.ignored).toEqual(['not-a-sha', a.slice(0, 63)]);
    expect(takenDownPackages(undefined)).toEqual({ shas: new Set(), ignored: [] });
    expect(takenDownPackages('')).toEqual({ shas: new Set(), ignored: [] });
  });

  it('removes a listed package that was already kept, and leaves the others', async () => {
    const p = pod(), going = madeUpPackage('going'), staying = madeUpPackage('staying');
    const before = new HostedPackages({ podUrl: POD, fetch: p.fetchFn });
    await before.keep(going, { title: 'Going', launchable: ['index.html'] });
    await before.keep(staying, { title: 'Staying', launchable: ['index.html'] });
    expect((await before.list()).sort()).toEqual([shaOf(going), shaOf(staying)].sort());

    // The bridge after a restart with the setting made.
    const after = new HostedPackages({ podUrl: POD, fetch: p.fetchFn, takenDown: new Set([shaOf(going)]) });
    expect(await after.removeTakenDown()).toEqual([{ sha256: shaOf(going), removed: true }]);
    expect(await after.list()).toEqual([shaOf(staying)]);
    expect(await after.open(shaOf(going))).toBeNull();
    expect(await after.about(shaOf(going))).toBeNull();
    expect((await after.open(shaOf(staying)))?.getEntry('index.html')).toBeTruthy();
    expect((await after.about(shaOf(staying)))?.title).toBe('Staying');
    // Its bytes and what described it are both gone from the pod; the other package's are not.
    expect([...p.kept.keys()].some(k => k.includes(shaOf(going)))).toBe(false);
    expect([...p.kept.keys()].filter(k => k.includes(shaOf(staying))).length).toBe(2);
    // Run again, as every later start does: already gone is still removed.
    expect(await after.removeTakenDown()).toEqual([{ sha256: shaOf(going), removed: true }]);
  });

  it('does not keep a listed package again', async () => {
    const p = pod(), bytes = madeUpPackage('once');
    const store = new HostedPackages({ podUrl: POD, fetch: p.fetchFn, takenDown: new Set([shaOf(bytes)]) });
    await expect(store.keep(bytes, { title: 'Once', launchable: ['index.html'] })).rejects.toThrow(/taken down by the operator/);
    expect(p.kept.size).toBe(0);
  });

  it('does not serve or list a listed package the pod refused to remove, and says it was not removed', async () => {
    const p = pod({ refuseDelete: true }), bytes = madeUpPackage('stuck');
    await new HostedPackages({ podUrl: POD, fetch: p.fetchFn }).keep(bytes, { title: 'Stuck', launchable: ['index.html'] });
    const store = new HostedPackages({ podUrl: POD, fetch: p.fetchFn, takenDown: new Set([shaOf(bytes)]) });
    const [taken] = await store.removeTakenDown();
    expect(taken).toMatchObject({ sha256: shaOf(bytes), removed: false });
    expect(taken!.why).toMatch(/HTTP 500/);
    expect(await store.open(shaOf(bytes))).toBeNull();
    expect(await store.aboutNow(shaOf(bytes))).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('with no list, nothing is removed', async () => {
    const p = pod(), bytes = madeUpPackage('kept');
    const store = new HostedPackages({ podUrl: POD, fetch: p.fetchFn });
    await store.keep(bytes, { title: 'Kept', launchable: ['index.html'] });
    expect(await store.removeTakenDown()).toEqual([]);
    expect(p.deleted).toEqual([]);
    expect(await store.list()).toEqual([shaOf(bytes)]);
  });

  it('the bridge reads the setting, applies it once it is listening, and forgets each course', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(server).toContain('takenDownPackages(process.env.FOXXI_HOSTED_PACKAGES_TAKEN_DOWN)');
    expect(server).toContain('takenDown: hostedPackagesTakenDown.shas');
    const apply = server.slice(server.indexOf('async function takeDownListedPackages'), server.indexOf('function describeHostedPackage'));
    expect(apply).toContain('await hostedPackages.removeTakenDown()');
    expect(apply).toContain('unregisterCmi5Course(DEFAULT_TENANT, `${bridgeBaseUrl}/scorm/packages/${taken.sha256}`)');
    expect(server.slice(server.indexOf('app.listen(PORT'))).toContain('void takeDownListedPackages()');
  });
});
