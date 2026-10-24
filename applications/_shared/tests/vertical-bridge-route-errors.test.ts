/**
 * A vertical bridge answers a failing request with JSON and keeps serving.
 *
 * Every bridge is built on createVerticalBridge and adds its own routes to the app it returns,
 * so a route added AFTER the factory returns is the case that matters. The bridges run Express 5,
 * which already passes an async handler's rejection to next(err), but answered it with Express's
 * default: an HTML page carrying the stack trace. The factory now appends route-errors.ts's JSON
 * error handler when the bridge starts listening.
 *
 * The factory's route-errors.ts is a copy of the one in each deploy service; this checks it is
 * the same bytes as identity's. tests/route-errors-every-service.test.ts keeps the base copies
 * identical to each other.
 */
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createVerticalBridge } from '../vertical-bridge/index.js';

const read = (p: string): string => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('the vertical-bridge factory', () => {
  it('carries the same route-errors.ts as the deploy services', () => {
    expect(read('applications/_shared/vertical-bridge/route-errors.ts')).toBe(read('deploy/identity/route-errors.ts'));
  });

  it('installs no process-level handler (tests import it)', () => {
    expect(read('applications/_shared/vertical-bridge/index.ts')).not.toMatch(/installProcessSafetyNet|process\.on\(/);
  });
});

describe('a vertical bridge answers a failing request with JSON', () => {
  it('a route added after createVerticalBridge that rejects answers a JSON 500, and the bridge serves the next request', async () => {
    const logged: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { logged.push(String(chunk)); return true; }) as typeof process.stderr.write;
    const app = createVerticalBridge({ verticalName: 'route-errors-fixture', affordances: [], handlers: {} });
    app.get('/vertical-route', async () => { throw new Error('vertical internal detail'); });
    app.use(async (req, _res, next) => {
      if (req.path === '/vertical-middleware') throw new TypeError('middleware internal detail');
      next();
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ['/vertical-route', '/vertical-middleware']) {
        const r = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
        const body = await r.text();
        expect(r.status, `${path}: ${body.slice(0, 200)}`).toBe(500);
        expect(r.headers.get('content-type') ?? '', path).toMatch(/^application\/json/);
        expect(JSON.parse(body), path).toEqual({ error: 'Internal Server Error' });
        expect((await fetch(`${base}/health`)).status).toBe(200);
      }
      const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' });
      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-type') ?? '').toMatch(/^application\/json/);
      expect(bad.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect((await bad.json() as Record<string, unknown>)['error']).toBe('Bad Request');
      expect(logged.filter(l => l.includes('ERROR: route_error'))).toHaveLength(2);
      expect(logged.every(l => l.startsWith('[route-errors-fixture-bridge] '))).toBe(true);
    } finally {
      process.stderr.write = original;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
