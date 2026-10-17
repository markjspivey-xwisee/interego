/**
 * Browser-safe opaque bytes over CSS's native resource CAS protocol. This module
 * has no key custody, application schema, credential storage, or retry policy.
 * The injected fetch must authorize the exact owner pod using its current grant.
 */
import type { NativeResourceReceipt } from './native-commit-store.js';
export type { NativeResourceReceipt } from './native-commit-store.js';

const MEDIA_TYPE = 'application/vnd.interego.native-commit+json';
const REVISION = /^sha256:[a-f0-9]{64}$/;
const HARD_MAX_BYTES = 8 * 1024 * 1024;
const RECEIPT_MAX_BYTES = 32 * 1024;
const TYPES = ['application/json', 'application/octet-stream'] as const;
export type NativeOpaqueContentType = typeof TYPES[number];
export type NativeResourceErrorCode = 'INVALID_ARGUMENT' | 'UNSUPPORTED' | 'HTTP' | 'CONFLICT' | 'INTEGRITY' | 'LIMIT' | 'TIMEOUT' | 'TRANSPORT';
export class NativeResourceError extends Error {
  constructor(message: string, readonly code: NativeResourceErrorCode,
    /** True requires caller-owned operation-ID/readback reconciliation before retry. */
    readonly writeMayHaveCommitted = false, readonly status?: number) {
    super(message); this.name = 'NativeResourceError';
  }
}
export interface NativeResourceRepresentation {
  readonly revision: string | null;
  readonly body: Uint8Array | null;
  readonly contentType: NativeOpaqueContentType | null;
}
export interface NativeResourceClientOptions {
  readonly resourceUrl: string;
  /** Already verified owner scope, with a trailing slash. No aliases are inferred. */
  readonly podUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly maxBytes: number;
  /** Whole operation, including body reads and write readback. Default 15 seconds. */
  readonly timeoutMs?: number;
  readonly crypto?: Pick<typeof globalThis.crypto, 'subtle'>;
}
export interface NativeResourceClient {
  ready(): Promise<void>;
  read(): Promise<NativeResourceRepresentation>;
  write(input: { readonly expectedRevision: string | null; readonly body: Uint8Array;
    readonly contentType: NativeOpaqueContentType }): Promise<{
      readonly receipt: NativeResourceReceipt; readonly readback: NativeResourceRepresentation;
    }>;
}
function invalid(message: string): never { throw new NativeResourceError(message, 'INVALID_ARGUMENT'); }
function resourceUrl(value: string): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) invalid('Invalid native resource URL.');
  let url: URL;
  try { url = new URL(value); } catch { return invalid('Invalid native resource URL.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || /%2f|%5c|%2e/i.test(url.pathname)
    || value !== url.href) invalid('Native resource URL must be canonical HTTPS without unsafe components.');
  return url;
}
function revisionFromEtag(value: string | null): string | null {
  return value?.match(/^"(sha256:[a-f0-9]{64})(?:-[a-f0-9]{16})?"$/)?.[1] ?? null;
}
function opaqueType(value: string | null): NativeOpaqueContentType | null {
  return TYPES.find(type => type === value) ?? null;
}
function base64(bytes: Uint8Array): string {
  // A bounded chunk avoids argument-list limits without depending on Node Buffer.
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(parts.join(''));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export function createNativeResourceClient(options: NativeResourceClientOptions): NativeResourceClient {
  const target = resourceUrl(options.resourceUrl), pod = resourceUrl(options.podUrl);
  if (!pod.pathname.endsWith('/') || target.origin !== pod.origin || !target.pathname.startsWith(pod.pathname)
    || target.pathname.endsWith('/') || target.pathname === pod.pathname) invalid('Native resource is outside the explicit owner pod document scope.');
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > HARD_MAX_BYTES) invalid('Native resource byte limit must be between 1 and 8388608.');
  const maxBytes = options.maxBytes, timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) invalid('Native resource timeout must be between 1 and 120000 ms.');
  const fetcher = options.fetch, crypto = options.crypto ?? globalThis.crypto;
  if (typeof fetcher !== 'function' || !crypto?.subtle) invalid('Native resource transport requires fetch and WebCrypto.');
  const url = target.href;
  const digest = async (bytes: Uint8Array): Promise<string> => {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
    return 'sha256:' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  };
  // Each call owns its immutable input, deadline and representation. There is no
  // mutable cached revision that another concurrent call could accidentally use.
  async function operation<T>(run: (context: {
    request(init: RequestInit): Promise<Response>;
    bytes(response: Response, max: number): Promise<Uint8Array>;
    error(message: string, code: NativeResourceErrorCode, status?: number): NativeResourceError;
    dispatched(): void;
  }) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let mayHaveCommitted = false;
    const error = (message: string, code: NativeResourceErrorCode, status?: number) =>
      new NativeResourceError(message, code, mayHaveCommitted, status);
    let rejectDeadline!: (reason: NativeResourceError) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(error('Native resource operation timed out.', 'TIMEOUT')); }, timeoutMs);
    const assertActive = () => { if (controller.signal.aborted) throw error('Native resource operation timed out.', 'TIMEOUT'); };
    const work = run({
      error,
      dispatched() { assertActive(); mayHaveCommitted = true; },
      async request(init) {
        assertActive();
        let response: Response;
        try { response = await fetcher(url, { ...init, redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: controller.signal }); }
        catch { throw error('Native resource transport failed.', controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT'); }
        assertActive();
        if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel(); throw error('Native resource redirect or response URL refused.', 'INTEGRITY');
        }
        return response;
      },
      async bytes(response, limit) {
        assertActive();
        const length = response.headers.get('Content-Length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
          await response.body?.cancel(); throw error('Native resource reply exceeds its byte limit.', 'LIMIT');
        }
        if (!response.body) return new Uint8Array();
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        const abort = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener('abort', abort, { once: true });
        try {
          while (true) {
            const item = await reader.read(); assertActive();
            if (item.done) break;
            size += item.value.length;
            if (size > limit) { await reader.cancel(); throw error('Native resource reply exceeds its byte limit.', 'LIMIT'); }
            chunks.push(item.value);
          }
          const result = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
          return result;
        } finally { controller.signal.removeEventListener('abort', abort); reader.releaseLock(); }
      },
    });
    try { return await Promise.race([work, deadline]); }
    catch (failure) {
      if (failure instanceof NativeResourceError) throw failure;
      throw error('Native resource operation failed.', controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT');
    }
    finally { clearTimeout(timer); }
  }
  type Context = Parameters<Parameters<typeof operation>[0]>[0];
  async function read(context: Context): Promise<NativeResourceRepresentation> {
    const response = await context.request({ method: 'GET', headers: { Accept: TYPES.join(', ') } });
    if (response.status === 404) { await response.body?.cancel(); return { revision: null, body: null, contentType: null }; }
    if (!response.ok) { await response.body?.cancel(); throw context.error('Native resource read was refused.', 'HTTP', response.status); }
    const revision = revisionFromEtag(response.headers.get('ETag'));
    const contentType = opaqueType(response.headers.get('Content-Type'));
    if (!revision || response.headers.get('Interego-Revision') !== revision || !contentType) {
      await response.body?.cancel(); throw context.error('Native resource read headers failed integrity checks.', 'INTEGRITY');
    }
    const body = await context.bytes(response, maxBytes);
    if (response.headers.get('Interego-Body-Digest') !== await digest(body)) throw context.error('Native resource body digest differs.', 'INTEGRITY');
    return { revision, body, contentType };
  }
  return Object.freeze({
    ready: () => operation(async context => {
      const response = await context.request({ method: 'OPTIONS' });
      await response.body?.cancel();
      if (!response.ok || response.headers.get('Interego-Native-Commit') !== '1'
        || !response.headers.get('Accept-Put')?.split(',').map(part => part.trim()).includes(MEDIA_TYPE)) {
        throw context.error('Native resource CAS protocol is unavailable.', 'UNSUPPORTED', response.status);
      }
    }),
    read: () => operation(read),
    write(input: Parameters<NativeResourceClient['write']>[0]) {
      // Snapshot before any asynchronous work, including input revision/type.
      const expectedRevision = input.expectedRevision, contentType = input.contentType;
      if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !REVISION.test(expectedRevision))) invalid('An explicit native expected revision is required.');
      if (!(input.body instanceof Uint8Array) || input.body.length > maxBytes) invalid('Native resource body exceeds its byte limit.');
      if (!opaqueType(contentType)) invalid('Native resource body must use an opaque supported content type.');
      const body = new Uint8Array(input.body);
      return operation(async context => {
        const bodyBase64 = base64(body), bodyDigest = await digest(body);
        const atomHash = (await digest(new TextEncoder().encode('atom:' + bodyBase64))).slice(7, 47);
        const command = JSON.stringify({ version: 1, expectedRevision, contentType, bodyBase64 });
        const headers = { 'Content-Type': MEDIA_TYPE, Accept: 'application/json',
          ...(expectedRevision === null ? { 'If-None-Match': '*' } : { 'If-Match': '"' + expectedRevision + '"' }) };
        context.dispatched();
        const response = await context.request({ method: 'PUT', headers, body: command });
        if (response.status === 412) {
          await response.body?.cancel(); throw new NativeResourceError('Native resource changed; read before choosing a retry.', 'CONFLICT', false, 412);
        }
        if (!response.ok) { await response.body?.cancel(); throw context.error('Native resource write was refused; reconcile before retry.', 'HTTP', response.status); }
        if (response.headers.get('Content-Type')?.split(';', 1)[0]?.trim() !== 'application/json') {
          await response.body?.cancel(); throw context.error('Native resource receipt has an invalid content type.', 'INTEGRITY');
        }
        let receipt: unknown;
        try { receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await context.bytes(response, RECEIPT_MAX_BYTES))); }
        catch (error) { if (error instanceof NativeResourceError) throw error; throw context.error('Native resource receipt is invalid JSON.', 'INTEGRITY'); }
        const opaqueMatches = (value: unknown) => value === 'urn:pgsl:atom:' + atomHash;
        if (!record(receipt) || receipt.version !== 1 || receipt.status !== 'committed' || receipt.expectedRevision !== expectedRevision
          || receipt.resource !== url || receipt.path !== url || receipt.pod !== 'css' || receipt.bodyDigest !== bodyDigest
          || receipt.contentType !== contentType || receipt.size !== body.length || typeof receipt.updatedAt !== 'number'
          || !Number.isFinite(receipt.updatedAt) || receipt.updatedAt < 0 || typeof receipt.revision !== 'string'
          || !REVISION.test(receipt.revision) || receipt.revision === expectedRevision
          || revisionFromEtag(response.headers.get('ETag')) !== receipt.revision
          || !opaqueMatches(receipt.topUri) || !opaqueMatches(receipt.opaqueUri)) {
          throw context.error('Native resource receipt did not bind the exact native commit.', 'INTEGRITY');
        }
        const readback = await read(context);
        if (readback.revision !== receipt.revision || readback.contentType !== contentType || !readback.body || !sameBytes(readback.body, body)) {
          throw context.error('Native resource readback changed or differs; reconcile the operation before retry.', 'INTEGRITY');
        }
        return { receipt: Object.freeze(receipt) as unknown as NativeResourceReceipt, readback };
      });
    },
  });
}
