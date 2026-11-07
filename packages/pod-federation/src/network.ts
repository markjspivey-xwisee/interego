import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { MAX_BODY } from './protocol.js';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number); const a = parts[0]!; const b = parts[1]!; const c = parts[2]!;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
      || a === 100 && b >= 64 && b <= 127 || a === 192 && (b === 168 || b === 0 || b === 2)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !/^2001:(?:0*:|db8:)/i.test(address) && !/^2002:/i.test(address);
}
/** DNS results are checked and pinned into the socket lookup, avoiding a second resolution. */
export async function federationNetwork(url: URL, body: string, signal: AbortSignal, allowLoopback = false): Promise<Response> {
  if (signal.aborted) throw new Error('Pod sharing was paused.');
  const loopback = allowLoopback && url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  const records = loopback ? [{ address: url.hostname === '[::1]' ? '::1' : '127.0.0.1', family: url.hostname === '[::1]' ? 6 : 4 }]
    : await abortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
  if (!records.length || records.length > 16 || !loopback && records.some(record => !publicAddress(record.address))) throw new Error('This pod address does not resolve to a public service.');
  if (signal.aborted) throw new Error('Pod sharing was paused.');
  const selected = records[0]!;
  return new Promise<Response>((resolve, reject) => {
    const transport = loopback ? httpRequest : httpsRequest;
    const request = transport(url, { method: 'POST', signal, headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(body) },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [{ address: selected.address, family: selected.family }]);
        else callback(null, selected.address, selected.family);
      } }, response => {
      let count = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        count += chunk.length;
        if (count > MAX_BODY) { response.destroy(new Error('The other pod sent too much data.')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on('error', reject);
      response.on('end', () => {
        const contentType = response.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('application/json')) { reject(new Error('The other pod did not return a supported response.')); return; }
        resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode ?? 502, headers: { 'content-type': contentType } }));
      });
    });
    request.setTimeout(12_000, () => request.destroy(new Error('The other pod did not respond in time.')));
    request.on('error', reject); request.end(body);
  });
}
/** Pending host transports/DNS must not keep shutdown waiting after cancellation. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Pod sharing was paused.'));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error('Pod sharing was paused.'));
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(value => { signal.removeEventListener('abort', cancel); if (signal.aborted) cancel(); else resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
