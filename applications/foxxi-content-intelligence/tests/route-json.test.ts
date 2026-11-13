import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { routeJson } from '../src/route-json.js';
import { attachCourseSourceService } from '../src/i2idlx-course-source-service.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

/** What the live bridge puts in front of a route: a JSON parser that consumes the request and sets
 * req.body WITHOUT body-parser 1's `_body` mark (it is another Express major's). */
const foreignParser: express.RequestHandler = (req, _res, next) => {
  if (!req.is('application/json')) { next(); return; }
  const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', () => { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; next(); });
};
async function listen(app: express.Express): Promise<string> {
  // The terminal handler the bridge has: a parser's failure becomes a bare 500.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status ?? 500).json({ error: 'internal error', type: (error as { type?: string }).type });
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
const post = (url: string, body: string, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body });

describe('a route\'s own JSON parser behind the bridge\'s', () => {
  it('express.json alone reads the consumed stream again and fails (the production 500)', async () => {
    const app = express(); app.use(foreignParser);
    app.post('/plain', express.json(), (req, res) => { res.json({ got: req.body as unknown }); });
    const response = await post(await listen(app) + '/plain', '{"a":1}');
    assert.equal(response.status, 500); assert.equal(((await response.json()) as { type?: string }).type, 'stream.not.readable');
  });

  it('routeJson leaves a parsed body alone, and still parses and bounds an unparsed one', async () => {
    const behind = express(); behind.use(foreignParser);
    behind.post('/route', routeJson({ limit: '1kb' }), (req, res) => { res.json({ got: req.body as unknown }); });
    const first = await post(await listen(behind) + '/route', '{"a":1}');
    assert.equal(first.status, 200); assert.deepEqual(await first.json(), { got: { a: 1 } });

    const alone = express();
    alone.post('/route', routeJson({ limit: '1kb' }), (req, res) => { res.json({ got: req.body as unknown }); });
    const base = await listen(alone);
    const parsed = await post(base + '/route', '{"b":2}'); assert.deepEqual(await parsed.json(), { got: { b: 2 } });
    assert.equal((await post(base + '/route', JSON.stringify({ big: 'x'.repeat(2048) }))).status, 413);
    assert.equal((await post(base + '/route', '{not json')).status, 400);
  });

  it('the course-source service answers behind the bridge\'s parser', async () => {
    const app = express(); app.use(foreignParser);
    attachCourseSourceService(app, '/source', { providerName: 'Owner source', now: () => 0 } as never);
    const response = await post(await listen(app) + '/source', '{"operation":"none"}');
    assert.notEqual(response.status, 500);
  });
});
