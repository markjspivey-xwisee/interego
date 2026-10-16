import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NativeCommitScope } from '@interego/pgsl';
import type { IRI } from '@interego/core';
import { createNativeLrsTransport } from '../src/native-lrs-transport.js';

const scope: NativeCommitScope = { pod: 'https://pod.test/service/', headUrl: 'https://pod.test/service/head',
  artifactContainer: 'https://pod.test/service/artifacts/', owner: 'did:web:synthetic-native-lrs.test' as IRI };
const capability = 'synthetic-test-capability';
const digest = (body: string) => 'sha256:' + createHash('sha256').update(body).digest('hex');
const immutable = (body: string, kind = 'artifact') => scope.artifactContainer + kind + '-' + digest(body).slice(7) + '.json';
const representation = (body = '{"ciphertext":"synthetic"}', override: Record<string, string> = {}) => new Response(body, {
  headers: { 'content-type': 'application/json', 'interego-body-digest': digest(body),
    'interego-revision': digest('revision'), etag: '"' + digest('revision') + '-cp"', ...override },
});

describe('bounded native LRS immutable transport cache', () => {
  it.each(['artifact', 'commit'])('reuses validated exact SHA-addressed %s ciphertext while overriding caller authorization', async kind => {
    const body = '{"ciphertext":"synthetic"}', url = immutable(body, kind);
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + capability);
      expect(init?.redirect).toBe('manual');
      return representation(body);
    });
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    const first = await transport(url, { headers: { Authorization: 'Bearer wrong-caller-value' } });
    expect(await first.text()).toBe(body);
    const second = await transport(new URL(url));
    expect(await second.text()).toBe(body);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Returned responses are detached; consuming one never consumes another.
    expect(await (await transport(url)).text()).toBe(body);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps mutable heads, OPTIONS, conditional reads and non-addressed resources live', async () => {
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    const fetch = vi.fn(async () => representation(body));
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    for (let i = 0; i < 2; i++) {
      await transport(scope.headUrl); await transport(scope.headUrl, { method: 'OPTIONS' });
      await transport(scope.artifactContainer + 'unbound.json');
      await transport(url, { headers: { Range: 'bytes=0-9' } });
      await transport(url, { headers: { 'If-None-Match': '"previous"' } });
    }
    expect(fetch).toHaveBeenCalledTimes(10);
  });
  it('forces verification GET across the network after successful or uncertain PUT', async () => {
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    let failWrite = false;
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (init?.method === 'PUT' && failWrite) throw new Error('synthetic lost acknowledgment');
      return representation(body);
    });
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    await transport(url); await transport(url);
    expect(fetch).toHaveBeenCalledTimes(1);
    await transport(url, { method: 'PUT', body: '{}' }); await transport(url); await transport(url);
    expect(fetch).toHaveBeenCalledTimes(3);
    failWrite = true;
    await expect(transport(url, { method: 'PUT', body: '{}' })).rejects.toThrow('lost acknowledgment');
    await transport(url); await transport(url);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('never repopulates the cache with a read that straddled a concurrent write', async () => {
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (first && init?.method === 'GET') { first = false; await gate; }
      return representation(body);
    });
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    const oldRead = transport(url);
    await transport(url, { method: 'PUT', body: '{}' });
    release(); await oldRead;
    await transport(url); await transport(url);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([
    { 'interego-body-digest': digest('other') },
    { 'interego-revision': 'sha256:bad' },
    { etag: '"unbound"' },
    { 'content-type': 'text/plain' },
  ] as Array<Record<string, string>>)('does not cache representations whose native metadata is unbound: %j', async headers => {
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    const fetch = vi.fn(async () => representation(body, headers));
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    await transport(url); await transport(url);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not cache corrupt content or error responses at an otherwise valid digest URL', async () => {
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    const fetch = vi.fn(async () => representation('changed'));
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    await transport(url); await transport(url);
    expect(fetch).toHaveBeenCalledTimes(2);
    const unavailable = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const failed = createNativeLrsTransport({ scope, capability, fetch: unavailable });
    expect((await failed(url)).status).toBe(503); expect((await failed(url)).status).toBe(503);
    expect(unavailable).toHaveBeenCalledTimes(2);
  });
  it('bounds cached entries and bytes with eviction or explicit disable', async () => {
    const bodies = ['{"n":1}', '{"n":2}'];
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => representation(bodies.find(body => immutable(body) === String(input))!));
    const transport = createNativeLrsTransport({ scope, capability, fetch, cacheMaxEntries: 1 });
    await transport(immutable(bodies[0]!)); await transport(immutable(bodies[1]!)); await transport(immutable(bodies[0]!));
    expect(fetch).toHaveBeenCalledTimes(3);
    const tiny = createNativeLrsTransport({ scope, capability, fetch, cacheMaxBytes: 1 });
    await tiny(immutable(bodies[0]!)); await tiny(immutable(bodies[0]!));
    expect(fetch).toHaveBeenCalledTimes(5);
    const off = createNativeLrsTransport({ scope, capability, fetch, cacheMaxEntries: 0 });
    await off(immutable(bodies[0]!)); await off(immutable(bodies[0]!));
    expect(fetch).toHaveBeenCalledTimes(7);
  });
  it('refuses scope escapes and cancelled cached reads before network access', async () => {
    const fetch = vi.fn(async () => representation());
    const transport = createNativeLrsTransport({ scope, capability, fetch });
    for (const url of ['https://other.test/service/head', scope.pod + '../head', scope.pod + '%2fhead', scope.headUrl + '?secret=1']) {
      await expect(transport(url)).rejects.toThrow(/scope/);
    }
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    await transport(url);
    const controller = new AbortController(); controller.abort();
    await expect(transport(url, { signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps its deadline through the response body and cannot cache a late body', async () => {
    let finish!: () => void;
    const body = '{"ciphertext":"synthetic"}', url = immutable(body);
    const fetch = vi.fn(async () => {
      const response = representation(body);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(Buffer.from(body)); controller.close(); }; } }), { headers: response.headers });
    });
    const transport = createNativeLrsTransport({ scope, capability, fetch, timeoutMs: 10 });
    await expect(transport(url)).rejects.toThrow(/timed out/);
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
    const second = transport(url);
    await expect(second).rejects.toThrow(/timed out/);
    finish(); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
