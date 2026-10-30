import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';

export const MAX_IDENTITY_RESPONSE = 64 * 1024;
const unavailable = () => new Error('The sign-in service could not be reached safely. Start a new sign-in and try again.');
export function identityPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 100 && b >= 64 && b <= 127 || a === 192 && (b === 168 || b === 0 || b === 2)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0*:|db8:)/i.test(address) && !/^2002:/i.test(address);
}
export function identityAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Only fixed authentication paths on a native-configured relay reach this transport. */
export async function localIdentityNetwork(url: URL, body: string, signal: AbortSignal, allowLoopback = false): Promise<Response> {
  if (signal.aborted) throw unavailable();
  const loopback = allowLoopback && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  const records = loopback ? [{ address: url.hostname === '[::1]' ? '::1' : '127.0.0.1', family: url.hostname === '[::1]' ? 6 : 4 }]
    : await identityAbortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
  if (!records.length || records.length > 16 || !loopback && records.some(record => !identityPublicAddress(record.address))) throw unavailable();
  const selected = records[0]!;
  if (signal.aborted) throw unavailable();
  return new Promise<Response>((resolve, reject) => {
    const transport = loopback ? httpRequest : httpsRequest;
    const request = transport(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body) },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [{ address: selected.address, family: selected.family }]);
        else callback(null, selected.address, selected.family);
      } }, response => {
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IDENTITY_RESPONSE) { response.destroy(unavailable()); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', reject);
      response.once('end', () => {
        if (response.statusCode !== 200 || !(response.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { reject(unavailable()); return; }
        resolve(new Response(Buffer.concat(chunks), { status: 200, headers: { 'content-type': 'application/json' } }));
      });
    });
    request.setTimeout(12_000, () => request.destroy(unavailable())); request.once('error', reject); request.end(body);
  });
}

export async function localIdentityJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status !== 200 || response.redirected || !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
    || Number(response.headers.get('content-length') ?? 0) > MAX_IDENTITY_RESPONSE) {
    void response.body?.cancel().catch(() => {}); throw unavailable();
  }
  const reader = response.body?.getReader(); if (!reader) throw unavailable();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await identityAbortable(reader.read(), signal); if (item.done) break;
      size += item.value.length; if (size > MAX_IDENTITY_RESPONSE) throw unavailable(); chunks.push(item.value);
    }
    signal.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* An aborted read is still closing. */ } }
}
