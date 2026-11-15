/**
 * Compress the linked-data responses the edge in front of this bridge sends as they are.
 *
 * ★ WHY. The platform edge compresses JSON and HTML but not JSON-LD, Turtle or the other RDF
 * media types, and those are this bridge's largest answers: the entry point is 272 KB of JSON-LD
 * and an ontology is 122 KB of Turtle, sent whole on every request. They are text and compress
 * to about a tenth.
 *
 * Only bodies handed to `res.send` (so `res.json` too) are touched: a stream, a file, a response
 * that already has an encoding, a no-transform response and anything small are left alone. The
 * body is compressed before Express computes its ETag, so each encoding has a validator of its
 * own, and `Vary: Accept-Encoding` is added so a cache keeps them apart.
 */
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';

/** Media types the edge leaves uncompressed. JSON and HTML are its own business. */
const LINKED_DATA = /^(application\/(ld\+json|n-triples|n-quads|trig|rdf\+xml|schema\+json|sparql-results\+json)|text\/(turtle|n3))\b/i;
/** Under this a compressed body saves less than a packet. */
const MIN_BYTES = 1024;

/** The encoding to use for an Accept-Encoding header: br, else gzip, else none. A q of 0 refuses. */
export function chosenEncoding(header: string | undefined): 'br' | 'gzip' | null {
  if (!header) return null;
  const accepted = new Map<string, number>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    accepted.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const ok = (name: string): boolean => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}

/** Whether a response of this type and size is one this middleware compresses. */
export function compressible(contentType: string | undefined, bytes: number): boolean {
  return typeof contentType === 'string' && LINKED_DATA.test(contentType.trim()) && bytes >= MIN_BYTES;
}

export function compressBody(body: Buffer, encoding: 'br' | 'gzip'): Buffer {
  return encoding === 'br'
    // Quality 5: most of brotli's gain at a few milliseconds for a few hundred kilobytes.
    ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : gzipSync(body, { level: 6 });
}

function appendVary(res: Response, field: string): void {
  const current = String(res.getHeader('Vary') ?? '');
  const fields = current.split(',').map(f => f.trim()).filter(Boolean);
  if (fields.includes('*') || fields.some(f => f.toLowerCase() === field.toLowerCase())) return;
  res.setHeader('Vary', [...fields, field].join(', '));
}

export function compressLinkedData() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const send = res.send.bind(res);
    res.send = ((body?: unknown): Response => {
      // res.json sets the type and then calls send with a string, so both arrive here typed.
      if (typeof body !== 'string' && !Buffer.isBuffer(body)) return send(body);
      const type = res.getHeader('Content-Type');
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      if (!compressible(typeof type === 'string' ? type : undefined, raw.length)) return send(body);
      // The answer depends on the request's encoding whether or not this one is compressed.
      appendVary(res, 'Accept-Encoding');
      if (res.getHeader('Content-Encoding') || /no-transform/i.test(String(res.getHeader('Cache-Control') ?? ''))) return send(body);
      if (res.statusCode === 204 || res.statusCode === 304 || req.headers.range) return send(body);
      const encoding = chosenEncoding(typeof req.headers['accept-encoding'] === 'string' ? req.headers['accept-encoding'] : undefined);
      if (!encoding) return send(body);
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');
      return send(compressBody(raw, encoding));
    }) as Response['send'];
    next();
  };
}
