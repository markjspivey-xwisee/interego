import { createHash, webcrypto } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { createNativeResourceClient, NativeResourceError,
  type NativeResourceClientOptions } from '../packages/pgsl/dist/browser-native-resource.js';
import { openStore, InMemoryFdb, CodecRegistry, LdpStore } from '../packages/pgsl-store/src/index.js';

const encoder = new TextEncoder();
const resourceUrl = 'https://native.example/alice/checkpoint', podUrl = 'https://native.example/alice/';
const ct = 'application/json';
const bytes = (value: string) => encoder.encode(value);
const sha = (body: Uint8Array) => 'sha256:' + createHash('sha256').update(body).digest('hex');
const crypto = webcrypto as unknown as NonNullable<NativeResourceClientOptions['crypto']>;
function fixture() {
  const store = openStore(new InMemoryFdb()), ldp = new LdpStore(store, new CodecRegistry());
  const requests: { method: string; init: RequestInit }[] = [];
  let changeReceipt = (value: Record<string, unknown>) => value;
  let changeRead = (response: Response) => response;
  const fetcher: typeof fetch = async (url, init = {}) => {
    expect(String(url)).toBe(resourceUrl);
    expect(init.redirect).toBe('manual'); expect(init.cache).toBe('no-store'); expect(init.credentials).toBe('omit');
    requests.push({ method: init.method ?? 'GET', init });
    if (init.method === 'OPTIONS') return new Response(null, { status: 204,
      headers: { 'Interego-Native-Commit': '1', 'Accept-Put': 'application/vnd.interego.native-commit+json' } });
    if (init.method === 'PUT') {
      const command: { expectedRevision: string | null; contentType: string; bodyBase64: string; version: number } = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      expect(headers.get('Content-Type')).toBe('application/vnd.interego.native-commit+json');
      expect(command.version).toBe(1);
      if (command.expectedRevision === null) { expect(headers.get('If-None-Match')).toBe('*'); expect(headers.has('If-Match')).toBe(false); }
      else { expect(headers.get('If-Match')).toBe('"' + command.expectedRevision + '"'); expect(headers.has('If-None-Match')).toBe(false); }
      const result = await ldp.commitResource('css', resourceUrl, new Uint8Array(Buffer.from(command.bodyBase64, 'base64')),
        command.contentType, { expectedRevision: command.expectedRevision });
      if (result.status === 'conflict') return new Response(null, { status: 412 });
      const receipt = changeReceipt({ ...result, version: 1, resource: resourceUrl, expectedRevision: command.expectedRevision });
      return new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json', ETag: '"' + result.revision + '-0123456789abcdef"' } });
    }
    const result = await ldp.readResource('css', resourceUrl);
    if (!result) return new Response(null, { status: 404 });
    return changeRead(new Response(new Uint8Array(result.bytes), { headers: { 'Content-Type': result.contentType,
      ETag: '"' + result.revision + '"', 'Interego-Revision': result.revision, 'Interego-Body-Digest': result.bodyDigest } }));
  };
  return { ldp, requests, fetcher, mutateReceipt(fn: typeof changeReceipt) { changeReceipt = fn; },
    mutateRead(fn: typeof changeRead) { changeRead = fn; },
    client: (overrides: Partial<NativeResourceClientOptions> = {}) => createNativeResourceClient({ resourceUrl, podUrl, fetch: fetcher, maxBytes: 1024, crypto, ...overrides }) };
}

describe('browser native opaque resource CAS', () => {
  it('discovers, creates, reads and replaces through the actual native transactional engine', async () => {
    const f = fixture(), client = f.client(); await client.ready();
    expect(await client.read()).toEqual({ revision: null, body: null, contentType: null });
    const first = await client.write({ expectedRevision: null, body: bytes('{"sealed":"one"}'), contentType: ct });
    expect(first.readback.body).toEqual(bytes('{"sealed":"one"}'));
    expect(first.receipt.bodyDigest).toBe(sha(first.readback.body!));
    expect(first.receipt.topUri).toBe(first.receipt.opaqueUri);
    const second = await client.write({ expectedRevision: first.receipt.revision, body: bytes('{"sealed":"two"}'), contentType: ct });
    expect(second.receipt.revision).not.toBe(first.receipt.revision);
    expect((await client.read()).revision).toBe(second.receipt.revision);
  });

  it('allows exactly one concurrent creator and classifies the native CAS loser as definitely rejected', async () => {
    const f = fixture();
    const results = await Promise.allSettled(['one', 'two'].map(value => f.client().write({ expectedRevision: null, body: bytes(value), contentType: ct })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('expected a native CAS loser');
    expect(rejected.reason).toMatchObject({ code: 'CONFLICT', status: 412, writeMayHaveCommitted: false });
    expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(2);
  });

  it('accepts CSS media type parameters and case while preserving exact revision and raw byte verification', async () => {
    const f = fixture();
    f.mutateRead(response => {
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'Application/JSON; charset=utf-8');
      return new Response(response.body, { status: response.status, headers });
    });
    const client = f.client(); await client.ready();
    const saved = await client.write({ expectedRevision: null, body: bytes('{"sealed":"CSS charset representation"}'), contentType: ct });
    expect(saved.readback.contentType).toBe(ct);
    expect(saved.readback.body).toEqual(bytes('{"sealed":"CSS charset representation"}'));
    const opened = await client.read(); expect(opened.revision).toBe(saved.receipt.revision);
    expect(opened.body).toEqual(saved.readback.body);
    expect(() => client.write({ expectedRevision: saved.receipt.revision, body: bytes('x'),
      contentType: 'application/json; charset=utf-8' as typeof ct })).toThrow(NativeResourceError);
    f.mutateRead(response => {
      const headers = new Headers(response.headers); headers.set('Content-Type', 'application/json; charset=utf-8');
      return new Response('changed bytes', { headers });
    });
    await expect(client.read()).rejects.toMatchObject({ code: 'INTEGRITY', writeMayHaveCommitted: false });
  });

  it('captures byte input before asynchronous hashing, and never caches a stale read revision', async () => {
    const f = fixture(), client = f.client(), original = bytes('original');
    const pending = client.write({ expectedRevision: null, body: original, contentType: ct });
    original.fill(0);
    const first = await pending;
    expect(first.readback.body).toEqual(bytes('original'));
    const captured = await client.read();
    const next = await f.client().write({ expectedRevision: first.receipt.revision, body: bytes('next'), contentType: ct });
    await expect(client.write({ expectedRevision: captured.revision, body: bytes('stale'), contentType: ct }))
      .rejects.toMatchObject({ code: 'CONFLICT', writeMayHaveCommitted: false });
    expect((await client.read()).revision).toBe(next.receipt.revision);
  });

  it('leaves a lost committed PUT acknowledgement uncertain without retrying it', async () => {
    const f = fixture();
    const client = f.client({ fetch: async (url, init) => {
      const response = await f.fetcher(url, init);
      if (init?.method === 'PUT') { await response.body?.cancel(); throw new TypeError('lost acknowledgement'); }
      return response;
    } });
    await expect(client.write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
      .rejects.toMatchObject({ code: 'TRANSPORT', writeMayHaveCommitted: true });
    expect((await client.read()).body).toEqual(bytes('sealed'));
    expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  });

  it('refuses a successful receipt when another writer changes the head before readback', async () => {
    const f = fixture();
    const client = f.client({ fetch: async (url, init) => {
      const response = await f.fetcher(url, init);
      if (init?.method === 'PUT') {
        const receipt: { revision: string } = await response.clone().json();
        await f.ldp.commitResource('css', resourceUrl, bytes('concurrent'), ct, { expectedRevision: receipt.revision });
      }
      return response;
    } });
    await expect(client.write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
      .rejects.toMatchObject({ code: 'INTEGRITY', writeMayHaveCommitted: true });
    expect((await f.client().read()).body).toEqual(bytes('concurrent'));
    expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
  });

  it('rejects every forged native receipt binding even after the engine actually committed', async () => {
    const fields: Record<string, unknown> = { version: 2, status: 'ok', expectedRevision: 'sha256:' + '1'.repeat(64),
      resource: 'https://native.example/bob/checkpoint', path: 'other', pod: 'other', revision: 'sha256:bad', bodyDigest: sha(bytes('other')),
      contentType: 'text/turtle', size: 999, updatedAt: -1, topUri: 'urn:pgsl:atom:' + '1'.repeat(40), opaqueUri: 'urn:pgsl:atom:' + '2'.repeat(40) };
    for (const [key, value] of Object.entries(fields)) {
      const f = fixture(); f.mutateReceipt(receipt => ({ ...receipt, [key]: value }));
      await expect(f.client().write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
        .rejects.toMatchObject({ code: 'INTEGRITY', writeMayHaveCommitted: true });
      expect(f.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    }
  });

  it('treats malformed/oversized successful receipts and mismatched readback as uncertain', async () => {
    const f = fixture(); f.mutateReceipt(receipt => ({ ...receipt, extra: 'x'.repeat(33_000) }));
    await expect(f.client().write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
      .rejects.toMatchObject({ code: 'LIMIT', writeMayHaveCommitted: true });
    const g = fixture(); g.mutateRead(response => { const headers = new Headers(response.headers); headers.set('Interego-Revision', 'sha256:' + '2'.repeat(64)); return new Response('other', { headers }); });
    await expect(g.client().write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
      .rejects.toMatchObject({ code: 'INTEGRITY', writeMayHaveCommitted: true });
  });

  it('rejects bytes and unsafe scope before transport and refuses redirected, anonymous or unavailable reads', async () => {
    const f = fixture();
    for (const target of ['https://native.example/bob/head', 'https://native.example/alice2/head', 'https://other.example/alice/head',
      'https://native.example/alice/../bob/head', 'https://native.example/alice/%2e%2e/head', 'https://native.example/alice/a%2fb',
      'https://native.example/alice/head?x', 'https://native.example/alice/head#x', 'https://u:p@native.example/alice/head']) {
      expect(() => f.client({ resourceUrl: target })).toThrow(NativeResourceError);
    }
    expect(() => f.client().write({ expectedRevision: null, body: new Uint8Array(1025), contentType: ct })).toThrow(NativeResourceError);
    expect(f.requests).toHaveLength(0);
    for (const status of [301, 401, 403, 500]) {
      const client = f.client({ fetch: async () => new Response(null, { status }) });
      await expect(client.read()).rejects.toMatchObject({ writeMayHaveCommitted: false, code: status === 301 ? 'INTEGRITY' : 'HTTP' });
    }
    const unavailable = f.client({ fetch: async () => new Response(null, { status: 204 }) });
    await expect(unavailable.ready()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('enforces stream size and digest/header integrity, distinguishing only 404 as absence', async () => {
    const revision = 'sha256:' + '1'.repeat(64);
    const goodHeaders = { 'Content-Type': ct, ETag: '"' + revision + '"', 'Interego-Revision': revision, 'Interego-Body-Digest': sha(bytes('x')) };
    for (const headers of [{ ...goodHeaders, ETag: 'W/"' + revision + '"' }, { ...goodHeaders, 'Interego-Revision': 'bad' },
      { ...goodHeaders, 'Interego-Body-Digest': sha(bytes('bad')) }]) {
      await expect(fixture().client({ fetch: async () => new Response('x', { headers }) }).read()).rejects.toMatchObject({ code: 'INTEGRITY' });
    }
    const oversize = fixture().client({ maxBytes: 1, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes('xx')); controller.close(); } }), { headers: goodHeaders }) });
    await expect(oversize.read()).rejects.toMatchObject({ code: 'LIMIT' });
    const declared = fixture().client({ fetch: async () => new Response('x', { headers: { ...goodHeaders, 'Content-Length': '999999999' } }) });
    await expect(declared.read()).rejects.toMatchObject({ code: 'LIMIT' });
  });

  it('normalizes read stream resets and preserves uncertainty after a committed PUT', async () => {
    const f = fixture();
    const headers = { 'Content-Type': ct, ETag: '"sha256:' + '1'.repeat(64) + '"',
      'Interego-Revision': 'sha256:' + '1'.repeat(64), 'Interego-Body-Digest': sha(bytes('x')) };
    const reset = () => new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError('connection reset')); } });
    await expect(f.client({ fetch: async () => new Response(reset(), { headers }) }).read())
      .rejects.toMatchObject({ code: 'TRANSPORT', writeMayHaveCommitted: false });
    f.mutateRead(response => new Response(reset(), { headers: response.headers }));
    await expect(f.client().write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
      .rejects.toMatchObject({ code: 'TRANSPORT', writeMayHaveCommitted: true });
  });

  it('bounds a stalled request and stalled reply body, preserving uncertain PUT outcomes', async () => {
    const stalled = fixture().client({ timeoutMs: 25, fetch: async () => new Promise<Response>(() => {}) });
    await expect(stalled.read()).rejects.toMatchObject({ code: 'TIMEOUT', writeMayHaveCommitted: false });
    await expect(stalled.write({ expectedRevision: null, body: bytes('sealed'), contentType: ct }))
      .rejects.toMatchObject({ code: 'TIMEOUT', writeMayHaveCommitted: true });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const revision = 'sha256:' + '1'.repeat(64);
    const client = fixture().client({ timeoutMs: 25, fetch: async () => new Response(body, { headers: { 'Content-Type': ct,
      ETag: '"' + revision + '"', 'Interego-Revision': revision, 'Interego-Body-Digest': sha(bytes('x')) } }) });
    await expect(client.read()).rejects.toMatchObject({ code: 'TIMEOUT' }); expect(cancelled).toBe(true);
  });

  it('bundles this subpath for a browser without Node polyfills or the Node store barrel', async () => {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../packages/pgsl/dist/browser-native-resource.js', import.meta.url))], bundle: true,
      platform: 'browser', write: false, metafile: true, format: 'esm' });
    expect(Object.keys(result.metafile!.inputs)).toHaveLength(1);
    expect(result.outputFiles[0]!.text).not.toMatch(/node:|Buffer|native-commit-store/);
  });

  it('uses the actual CSS gate with verified owner OAuth, native engine CAS and browser CORS headers', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fixtures/browser-native-resource-gate.mjs', import.meta.url))],
      { timeout: 15_000, maxBuffer: 128 * 1024 });
    expect(stdout.trim()).toBe('{"ok":true,"ownerOnly":true,"cors":true,"cas":true}');
  });
});
