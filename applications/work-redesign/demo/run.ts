/**
 * The offline demo's pod and clock: an in-memory Solid-style store that honours the
 * preconditions publish() relies on, and a clock that only moves when it is told to.
 *
 * Both are test doubles for the NETWORK and for TIME only. Everything the bridge does on top of
 * them — signing, publishing, reading back, verifying — is the real code path; nothing here
 * answers on the bridge's behalf.
 *
 * Pod URLs are TEST-NET literals (RFC 5737). The SSRF guard does not class them as private
 * (packages/core/src/net/guarded-fetch.ts), and an IP literal skips the DNS lookup the guard
 * makes for every named host — about 31 ms per request for a `.test` name, measured.
 *
 * No environment reads: tests import this module.
 */
import type { FetchFn } from '@interego/core';

/** The operator's pod in the demo and in the bridge tests (TEST-NET-1). */
export const DEMO_POD = 'https://192.0.2.10/ap-team/';
/** A worker's own pod, the target of holder copies (TEST-NET-2). */
export const DEMO_HOLDER_POD = 'https://198.51.100.7/cy/';

export interface MemoryPod {
  readonly fetchFn: FetchFn;
  /** Every stored resource, by URL. */
  readonly bodies: ReadonlyMap<string, string>;
  /** Replace `from` with `to` in a stored body, in place — what a party with write access to the pod could do. */
  tamper(url: string, from: string, to: string): void;
  /** While on, every write answers 403 Forbidden (non-transient, so publish() does not retry it). */
  failWrites(on: boolean): void;
}

function headerOf(headers: unknown, name: string): string | null {
  if (headers === null || typeof headers !== 'object') return null;
  const h = headers as { get?: unknown };
  if (typeof h.get === 'function') {
    const v = (h.get as (n: string) => unknown).call(headers, name);
    return typeof v === 'string' ? v : null;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return null;
}

/**
 * One store for every host. GET/HEAD → 200 with an etag `"v<n>"`, or 404. PUT/POST/PATCH
 * honour `If-None-Match: *` (412 when the resource exists) and `If-Match` (412 on a different
 * etag), store the body, bump the etag and answer 201. DELETE → 204.
 */
export function memoryPod(): MemoryPod {
  const bodies = new Map<string, string>();
  const versions = new Map<string, number>();
  let refuseWrites = false;
  const etag = (url: string): string => `"v${versions.get(url) ?? 0}"`;
  const contentType = (url: string): string => (url.endsWith('.trig') ? 'application/trig' : 'text/turtle');

  const fetchFn: FetchFn = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const body = bodies.get(url);
      if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
      return new Response(method === 'HEAD' ? null : body, { status: 200, headers: { etag: etag(url), 'content-type': contentType(url) } });
    }
    if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
      if (refuseWrites) return new Response('writes are refused', { status: 403, statusText: 'Forbidden' });
      const ifNoneMatch = headerOf(init?.headers, 'if-none-match');
      const ifMatch = headerOf(init?.headers, 'if-match');
      if (ifNoneMatch === '*' && bodies.has(url)) return new Response(null, { status: 412, statusText: 'Precondition Failed' });
      if (ifMatch !== null && ifMatch !== etag(url)) return new Response(null, { status: 412, statusText: 'Precondition Failed' });
      bodies.set(url, typeof init?.body === 'string' ? init.body : '');
      versions.set(url, (versions.get(url) ?? 0) + 1);
      return new Response(null, { status: 201, statusText: 'Created', headers: { etag: etag(url), location: url } });
    }
    if (method === 'DELETE') {
      if (refuseWrites) return new Response('writes are refused', { status: 403, statusText: 'Forbidden' });
      bodies.delete(url);
      return new Response(null, { status: 204, statusText: 'No Content' });
    }
    return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
  };

  return {
    fetchFn,
    bodies,
    tamper(url: string, from: string, to: string): void {
      const body = bodies.get(url);
      if (body === undefined) throw new Error(`memoryPod.tamper: nothing stored at ${url}`);
      if (!body.includes(from)) throw new Error(`memoryPod.tamper: ${JSON.stringify(from)} does not occur in ${url}`);
      bodies.set(url, body.replace(from, to));
      versions.set(url, (versions.get(url) ?? 0) + 1);
    },
    failWrites(on: boolean): void { refuseWrites = on; },
  };
}

export interface DemoClock { now(): Date; advance(ms: number): void }

/** Starts at `startIso`; each now() returns the current instant and then moves one second on; advance() jumps. */
export function demoClock(startIso = '2026-10-22T09:00:00.000Z'): DemoClock {
  let t = Date.parse(startIso);
  if (!Number.isFinite(t)) throw new RangeError(`demoClock: not an ISO instant: ${startIso}`);
  return {
    now(): Date { const d = new Date(t); t += 1000; return d; },
    advance(ms: number): void { t += ms; },
  };
}
