/**
 * The edge in front of the bridge compresses JSON and HTML but not JSON-LD or Turtle, which are
 * the bridge's largest answers. The bridge compresses those itself, and nothing else.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { chosenEncoding, compressible, compressLinkedData } from '../src/compress-linked-data.js';

const TURTLE = '@prefix ex: <https://x.example/> .\n' + Array.from({ length: 400 }, (_, i) => `ex:s${i} a ex:Thing ; ex:label "subject ${i}" .`).join('\n');

async function withApp<T>(run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(compressLinkedData());
  app.get('/turtle', (_req, res) => { res.type('text/turtle').send(TURTLE); });
  app.get('/jsonld', (_req, res) => { res.type('application/ld+json').json({ '@id': 'https://x.example/', items: TURTLE.split('\n') }); });
  app.get('/small', (_req, res) => { res.type('text/turtle').send('<a> <b> <c> .'); });
  app.get('/json', (_req, res) => { res.json({ items: TURTLE.split('\n') }); });
  app.get('/fixed', (_req, res) => { res.setHeader('Cache-Control', 'no-transform'); res.type('text/turtle').send(TURTLE); });
  const server = app.listen(0, '127.0.0.1');
  // With an address named, the port is known only once the server is listening.
  await new Promise<void>(ready => server.once('listening', () => ready()));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise(done => server.close(done)); }
}

/** fetch decodes for us; ask the raw bytes instead so the encoding is what is tested. */
async function raw(url: string, acceptEncoding?: string, extra: Record<string, string> = {}) {
  const { request } = await import('node:http');
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request(url, { headers: { ...(acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {}), ...extra } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

describe('linked-data answers are compressed', () => {
  it('chooses brotli, then gzip, and honours a refusal', () => {
    expect(chosenEncoding('gzip, deflate, br')).toBe('br');
    expect(chosenEncoding('gzip')).toBe('gzip');
    expect(chosenEncoding('br;q=0, gzip')).toBe('gzip');
    expect(chosenEncoding('identity')).toBeNull();
    expect(chosenEncoding(undefined)).toBeNull();
    expect(chosenEncoding('*')).toBe('br');
  });

  it('takes RDF media types of some size, and leaves JSON and HTML to the edge', () => {
    expect(compressible('text/turtle; charset=utf-8', 5000)).toBe(true);
    expect(compressible('application/ld+json; charset=utf-8', 5000)).toBe(true);
    expect(compressible('application/json; charset=utf-8', 5000)).toBe(false);
    expect(compressible('text/html', 5000)).toBe(false);
    expect(compressible('text/turtle', 200)).toBe(false);
  });

  it('sends Turtle and JSON-LD compressed, and the bytes decode to the same answer', async () => {
    await withApp(async base => {
      const br = await raw(`${base}/turtle`, 'gzip, br');
      expect(br.headers['content-encoding']).toBe('br');
      expect(brotliDecompressSync(br.body).toString()).toBe(TURTLE);
      expect(br.body.length).toBeLessThan(TURTLE.length / 3);
      expect(String(br.headers.vary)).toContain('Accept-Encoding');

      const gz = await raw(`${base}/jsonld`, 'gzip');
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(JSON.parse(gunzipSync(gz.body).toString())['@id']).toBe('https://x.example/');
    });
  });

  it('sends the answer as it is to a client that asks for no encoding, still varying on it', async () => {
    await withApp(async base => {
      const plain = await raw(`${base}/turtle`);
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.body.toString()).toBe(TURTLE);
      expect(String(plain.headers.vary)).toContain('Accept-Encoding');
    });
  });

  it('leaves alone a small answer, plain JSON and a no-transform answer', async () => {
    await withApp(async base => {
      for (const path of ['/small', '/json', '/fixed']) {
        expect((await raw(`${base}${path}`, 'gzip, br')).headers['content-encoding'], path).toBeUndefined();
      }
    });
  });

  it('gives each encoding a validator of its own, and answers 304 to it', async () => {
    await withApp(async base => {
      const br = await raw(`${base}/turtle`, 'br');
      const gz = await raw(`${base}/turtle`, 'gzip');
      expect(br.headers.etag).toBeDefined();
      expect(br.headers.etag).not.toBe(gz.headers.etag);
      const again = await raw(`${base}/turtle`, 'br', { 'If-None-Match': String(br.headers.etag) });
      expect(again.status).toBe(304);
    });
  });
});
