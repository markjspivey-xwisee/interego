import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredSelfXapiTimeout, createSelfXapiRequest } from '../src/self-xapi-request.js';
import { writeSelfXapi } from '../src/self-xapi.js';

afterEach(() => { vi.useRealTimers(); });

describe('signed xAPI loopback deadline', () => {
  it('defaults to 120 seconds and accepts only the bounded integer configuration', () => {
    expect(configuredSelfXapiTimeout({})).toBe(120_000);
    for (const value of ['30000', '90000', '180000']) {
      expect(configuredSelfXapiTimeout({ FOXXI_SIGNED_XAPI_TIMEOUT_MS: value })).toBe(Number(value));
    }
    for (const value of ['', '29999', '180001', '-1', 'Infinity', 'NaN', '30e3', '30000.5', ' 30000']) {
      expect(() => configuredSelfXapiTimeout({ FOXXI_SIGNED_XAPI_TIMEOUT_MS: value })).toThrow('30000 to 180000');
    }
    expect(() => createSelfXapiRequest({ port: 6080, principal: 'principal', secret: 'secret', timeoutMs: 1 })).toThrow();
    expect(() => createSelfXapiRequest({ port: 0, principal: 'principal', secret: 'secret' })).toThrow();
  });

  it('preserves the exact loopback resource, temporary Basic credential, protocol headers and redirect refusal', async () => {
    let called = false;
    const request = createSelfXapiRequest({ port: 6080, principal: 'temporary-principal', secret: 'temporary-secret',
      transport: async (input, init) => {
        called = true;
        expect(String(input)).toBe('http://127.0.0.1:6080/xapi/statements?statementId=abc');
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('error');
        expect(init?.body).toBeUndefined();
        const headers = new Headers(init?.headers);
        expect(headers.get('Authorization')).toBe('Basic ' + Buffer.from('temporary-principal:temporary-secret').toString('base64'));
        expect(headers.get('X-Experience-API-Version')).toBe('2.0.0');
        expect(headers.get('Content-Type')).toBe('application/json');
        return Response.json({ id: 'abc' });
      } });
    expect(await request('GET', new URLSearchParams({ statementId: 'abc' }))).toEqual({ status: 200, body: { id: 'abc' } });
    expect(called).toBe(true);
  });

  it('awaits a response taking longer than the previous 30-second deadline', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = createSelfXapiRequest({ port: 6080, principal: 'principal', secret: 'secret',
      transport: async (_input, init) => {
        signal = init?.signal ?? undefined;
        await new Promise(resolve => setTimeout(resolve, 31_000));
        return Response.json(['accepted']);
      } });
    const pending = request('POST', new URLSearchParams(), [{ id: 'accepted' }]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await pending).toEqual({ status: 200, body: ['accepted'] });
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline through response-body consumption and clears its timer', async () => {
    vi.useFakeTimers();
    const request = createSelfXapiRequest({ port: 6080, principal: 'principal', secret: 'secret', timeoutMs: 30_000,
      transport: async (_input, init) => {
        const signal = init?.signal;
        return { status: 200,
          json: () => new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        } as Response;
      } });
    const pending = request('POST', new URLSearchParams(), []);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconciles an LRS write that commits after the adapter timed out using the same UUID and canonical envelope', async () => {
    vi.useFakeTimers();
    const did = 'did:web:test.example:monitor';
    const id = 'bcc16121-a7f4-4f91-b9fd-bb7fa45a50f7';
    const statement = { id, timestamp: '2026-10-16T04:00:00Z',
      actor: { objectType: 'Agent', account: { homePage: 'https://test.example', name: did } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' },
      object: { objectType: 'Activity', id: 'urn:test:late-native-commit' },
    };
    const canonical = { ...statement, stored: '2026-10-16T04:00:35Z',
      authority: { account: { homePage: 'https://lrs.example', name: 'lrs' } } };
    const committed = new Map<string, typeof canonical>();
    const submitted: unknown[] = [];
    const persisted: unknown[] = [];
    let nativeCommits = 0;
    const request = createSelfXapiRequest({ port: 6080, principal: 'principal', secret: 'secret', timeoutMs: 30_000,
      transport: async (input, init) => {
        if (init?.method === 'GET') return Response.json(committed.get(new URL(String(input)).searchParams.get('statementId')!));
        submitted.push(JSON.parse(String(init?.body)));
        if (committed.has(id)) return Response.json([id]);
        // Losing the HTTP waiter does not cancel the already-running native work.
        setTimeout(() => { committed.set(id, canonical); nativeCommits++; }, 35_000);
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      } });
    const deps = { request, persist: async (value: Record<string, unknown>) => { persisted.push(value); return { persisted: true }; } };
    const first = writeSelfXapi(did, [statement], deps);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toMatchObject({ status: 503, body: {
      ok: false, lrsAccepted: null, durable: false, retryable: true, statementIds: [id],
    } });
    expect(committed.size).toBe(0);
    expect(persisted).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(committed.size).toBe(1);
    const retried = await writeSelfXapi(did, [statement], deps);
    expect(retried).toMatchObject({ status: 200, body: { ok: true, lrsAccepted: true, durable: true, statementIds: [id] } });
    expect(submitted).toEqual([[statement], [statement]]);
    expect(nativeCommits).toBe(1);
    expect(persisted).toEqual([canonical]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
