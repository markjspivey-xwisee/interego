/** Per-owner federation authority is encrypted even when its Solid store permits public GET. */
import { decryptFacetValue, encryptFacetValue, isEncryptedFacetValue, type EncryptionKeyPair, type FetchFn } from '@interego/core';
import type { FederationStore } from '@interego/pod-federation';

const MAX_BYTES = 64 * 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;
const unavailable = () => new Error('Saved pod connections could not be opened. Your existing notes are unchanged.');

interface StoreBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<unknown>;
    releaseLock(): void;
  };
  cancel(reason?: unknown): Promise<unknown>;
}
type StoreResponse = Awaited<ReturnType<FetchFn>> & { readonly body?: StoreBody | null };
const cancelBody = (response: StoreResponse) => {
  try { void response.body?.cancel(unavailable()).catch(() => undefined); } catch { /* already locked or closed */ }
};

/** Do not call text() on a transport that cannot enforce the ceiling while reading. */
async function boundedRecordRead(fetcher: FetchFn, url: string,
  observe: (response: StoreResponse) => boolean): Promise<string | null> {
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), READ_TIMEOUT_MS);
  let response: StoreResponse | undefined;
  let reader: ReturnType<StoreBody['getReader']> | undefined;
  let finished = false;
  const abortable = <T>(pending: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable());
    if (cancel.signal.aborted) { void pending.catch(() => undefined); reject(unavailable()); return; }
    cancel.signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { cancel.signal.removeEventListener('abort', abort); resolve(value); },
      error => { cancel.signal.removeEventListener('abort', abort); reject(error); });
  });
  const cancelRead = () => {
    if (reader) { try { void reader.cancel(unavailable()).catch(() => undefined); } catch { /* already closed */ } }
    else if (response) cancelBody(response);
  };
  cancel.signal.addEventListener('abort', cancelRead, { once: true });
  try {
    // The host transport may have its own header timeout. Our deadline also
    // bounds the owner request and cancels a body that arrives after expiry.
    const init = { headers: { Accept: 'application/json', 'Cache-Control': 'no-store' }, signal: cancel.signal };
    const pending = fetcher(url, init) as Promise<StoreResponse>;
    void pending.then(value => { if (cancel.signal.aborted) cancelBody(value); }, () => undefined);
    response = await abortable(pending);
    if (!observe(response)) return null;
    if (!response.body || typeof response.body.getReader !== 'function') throw unavailable();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await abortable(reader.read());
      if (chunk.done) { finished = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw unavailable();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw unavailable();
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    clearTimeout(timer);
    cancel.signal.removeEventListener('abort', cancelRead);
    if (!finished) cancelRead();
    try { reader?.releaseLock(); } catch { /* a refused transport may retain its pending read */ }
  }
}

/** The host supplies a proven own-pod URL, never a request-selected write target. */
export function encryptedFederationStore(config: {
  readonly podUrl: string;
  readonly fetch: FetchFn;
  readonly encryptionKey: EncryptionKeyPair;
}): FederationStore {
  const pod = new URL(config.podUrl);
  if (!/^https?:$/.test(pod.protocol) || pod.username || pod.password || pod.search || pod.hash
    || !/^\/[^/]+\/$/.test(pod.pathname) || /%2f|%5c|\\/i.test(pod.pathname)) throw unavailable();
  const ownerBinding = pod.href;
  const url = ownerBinding + 'private-pod-federation/state.json';
  let revision: string | undefined;
  let loaded = false;
  return {
    async load() {
      loaded = false; revision = undefined;
      let text: string | null;
      try {
        text = await boundedRecordRead(config.fetch, url, response => {
          if (response.status === 404) { loaded = true; revision = undefined; return false; }
          if (!response.ok || Number(response.headers?.get('content-length') ?? 0) > MAX_BYTES) throw unavailable();
          const etag = response.headers?.get('etag');
          if (!etag) throw unavailable();
          revision = etag;
          return true;
        });
      } catch { throw unavailable(); }
      if (text === null) return null;
      let record: { version?: unknown; ownerBinding?: unknown; state?: unknown };
      try {
        const envelope: unknown = JSON.parse(text);
        if (!isEncryptedFacetValue(envelope)) throw unavailable();
        const plain = decryptFacetValue(envelope, config.encryptionKey);
        if (!plain || Buffer.byteLength(plain) > MAX_BYTES) throw unavailable();
        record = JSON.parse(plain) as typeof record;
      } catch { throw unavailable(); }
      if (record.version !== 1 || record.ownerBinding !== ownerBinding || !Object.hasOwn(record, 'state')) throw unavailable();
      loaded = true;
      return record.state;
    },
    async save(state) {
      // No blind overwrite: initialization is a conditional create; updates retain the read ETag.
      if (!loaded) {
        try { await this.load(); }
        catch (error) {
          // Explicit owner Forget can tombstone a damaged private record, but only
          // conditionally against a freshly observed store revision.
          if (state !== null || !revision) throw error;
        }
      }
      const plain = JSON.stringify({ version: 1, ownerBinding, state });
      if (Buffer.byteLength(plain) > 32 * 1024 * 1024) throw new Error('Pod connection storage limit reached. Your saved connections are unchanged.');
      const sealed = encryptFacetValue(plain, [config.encryptionKey.publicKey], config.encryptionKey);
      const response = await config.fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json',
        ...(revision ? { 'If-Match': revision } : { 'If-None-Match': '*' }) }, body: JSON.stringify(sealed) });
      if (!response.ok) {
        throw new Error(response.status === 412 ? 'Pod connections changed in another session. Reload before trying again.'
          : 'Pod connections could not be saved. Try again when storage is available.');
      }
      const etag = response.headers?.get('etag');
      if (etag) { revision = etag; return; }
      // Some Solid servers omit an ETag on PUT. Re-read before the next mutation.
      loaded = false; revision = undefined;
      if (JSON.stringify(await this.load()) !== JSON.stringify(state)) {
        throw new Error('Pod connections changed in another session. Reload before trying again.');
      }
    },
  };
}
