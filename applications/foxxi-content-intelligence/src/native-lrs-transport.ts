/** Disposable native ciphertext cache. Heads and commit acknowledgments always
 * cross the authenticated transport; only exact SHA-addressed immutable bodies
 * whose native metadata and body digest agree may be reused. The SDK still
 * decrypts and validates the canonical lattice on every read. */
import { createHash } from 'node:crypto';
import type { NativeCommitScope } from '@interego/pgsl';

const REVISION = /^sha256:[a-f0-9]{64}$/;
const MAX_BYTES = 8 * 1024 * 1024;
interface CachedBody { bytes: Buffer; headers: Array<[string, string]>; statusText: string; size: number; }
export interface NativeLrsTransportOptions {
  scope: NativeCommitScope;
  capability: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
}

export function createNativeLrsTransport({ scope, capability, fetch: transport = globalThis.fetch.bind(globalThis),
  timeoutMs = 15000, cacheMaxEntries = 2048, cacheMaxBytes = 16 * 1024 * 1024 }: NativeLrsTransportOptions): typeof globalThis.fetch {
  if (!capability || capability.length > 16384 || /[\r\n\u0000]/.test(capability)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isSafeInteger(cacheMaxEntries) || cacheMaxEntries < 0 || cacheMaxEntries > 4096
    || !Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes < 0 || cacheMaxBytes > 64 * 1024 * 1024) throw new Error('invalid native LRS transport configuration');
  const pod = new URL(scope.pod), artifacts = new URL(scope.artifactContainer), head = new URL(scope.headUrl);
  const inScope = (url: URL) => url.origin === pod.origin && url.pathname.startsWith(pod.pathname)
    && !url.username && !url.password && !url.hash && !url.search && !/%2e|%2f|%5c/i.test(url.pathname);
  if (!pod.pathname.endsWith('/') || !artifacts.pathname.endsWith('/') || !inScope(artifacts) || !inScope(head)) throw new Error('invalid native LRS transport scope');
  const cache = new Map<string, CachedBody>();
  let cachedBytes = 0, writeEpoch = 0;
  const remove = (key: string) => { const entry = cache.get(key); if (entry) { cache.delete(key); cachedBytes -= entry.size; } };
  const immutableDigest = (url: URL): string | null => {
    if (!cacheMaxEntries || !cacheMaxBytes || url.href === head.href || !url.href.startsWith(artifacts.href)) return null;
    const match = /^(?:artifact|commit)-([a-f0-9]{64})\.json$/.exec(url.href.slice(artifacts.href.length));
    return match ? 'sha256:' + match[1] : null;
  };
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(target);
    if (url.href !== target || !inScope(url)) throw new Error('native LRS transport left its authorized pod scope');
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    if (!['GET', 'OPTIONS', 'PUT'].includes(method)) throw new Error('unsupported native LRS transport method');
    const headers = new Headers(init.headers ?? request?.headers);
    // Authorization is applied before cache access and cannot be supplied by a caller.
    headers.set('Authorization', 'Bearer ' + capability);
    const callerSignal = init.signal ?? request?.signal;
    if (callerSignal?.aborted) throw new Error('native LRS transport was cancelled');
    if (method === 'PUT') { writeEpoch++; remove(url.href); }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = async () => {
        const expectedDigest = method === 'GET' && init.body === undefined && !request?.body
          && !['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].some(key => headers.has(key)) ? immutableDigest(url) : null;
        const cached = expectedDigest ? cache.get(url.href) : undefined;
        if (cached) {
          cache.delete(url.href); cache.set(url.href, cached);
          return new Response(Buffer.from(cached.bytes), { status: 200, statusText: cached.statusText, headers: cached.headers });
        }
        const startedEpoch = writeEpoch;
        const response = await transport(input, { ...init, method, headers, redirect: 'manual',
          signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal });
        // Keep the deadline and response-size bound active through the body.
        const chunks: Uint8Array[] = [], reader = response.body?.getReader();
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read(); if (part.done) break;
              size += part.value.length;
              if (size > MAX_BYTES) { await reader.cancel(); throw new Error('native LRS representation exceeds capacity'); }
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        const bytes = Buffer.concat(chunks), revision = response.headers.get('Interego-Revision');
        const etagRevision = response.headers.get('ETag')?.match(/^"(sha256:[a-f0-9]{64})(?:-[^"\r\n]{1,200})?"$/)?.[1];
        if (!controller.signal.aborted && !callerSignal?.aborted && expectedDigest && response.status === 200 && startedEpoch === writeEpoch
          && response.headers.get('Content-Type')?.split(';')[0]?.trim() === 'application/json'
          && revision && REVISION.test(revision) && etagRevision === revision
          && response.headers.get('Interego-Body-Digest') === expectedDigest
          && 'sha256:' + createHash('sha256').update(bytes).digest('hex') === expectedDigest) {
          const responseHeaders: Array<[string, string]> = [...response.headers];
          const entry = { bytes: Buffer.from(bytes), headers: responseHeaders, statusText: response.statusText,
            size: bytes.length + Buffer.byteLength(JSON.stringify(responseHeaders) + url.href + response.statusText) };
          if (entry.size <= cacheMaxBytes) {
            remove(url.href); cache.set(url.href, entry); cachedBytes += entry.size;
            while (cache.size > cacheMaxEntries || cachedBytes > cacheMaxBytes) remove(cache.keys().next().value!);
          }
        }
        return new Response([204, 205, 304].includes(response.status) ? null : bytes,
          { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('native LRS transport timed out')); }, timeoutMs);
      });
      return await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer);
      // Even a failed/uncertain PUT forces the SDK's first verification GET live.
      if (method === 'PUT') { writeEpoch++; remove(url.href); }
    }
  };
}
