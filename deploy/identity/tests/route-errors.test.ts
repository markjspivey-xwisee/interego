/**
 * A request that makes an async handler throw answers a JSON 500, and the server keeps serving.
 *
 * Express 4 drops the promise an async handler returns, so a throw inside one was an unhandled
 * rejection, and Node ended the identity process for it. Measured: an unauthenticated POST
 * /auth/did whose `did` is an array (with a free challenge nonce) made the server exit, and the
 * restart lost every in-memory index, challenge and session.
 *
 * Part 1 drives route-errors.ts on this service's own copy of express. Part 2 starts server.ts
 * as a child process against a stand-in pod store, sends that same request, and asks the server
 * to answer /health afterwards.
 *
 * Run:
 *   node --test --import tsx tests/route-errors.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { forwardAsyncRouteErrors, routeErrorHandler } from '../route-errors.js';

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// ── Part 1: the helper, on identity's express ──────────────────────────────

/** What the forwarding logs. The patch is process-wide, so the first call's logger is the one used. */
const forwardLog: string[] = [];
const logForward = (m: string): void => { forwardLog.push(m); };

test('on express 4 the rejection forwarding is installed, not skipped', () => {
  assert.equal(forwardAsyncRouteErrors(logForward), 'patched');
  assert.equal(forwardAsyncRouteErrors(logForward), 'patched'); // repeat calls are harmless
});

test('an async route or middleware that throws answers a JSON 500 with no stack, and the next request is served', async () => {
  forwardAsyncRouteErrors(logForward);
  const logged: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    if (req.path === '/middleware-rejects') throw new Error('middleware detail: secret-ish');
    next();
  });
  app.get('/route-rejects', async () => { throw new TypeError('did.startsWith is not a function'); });
  app.get('/rejects-with-nothing', () => Promise.reject(undefined));
  app.get('/sync', (_req, res) => { res.json({ sync: true }); });
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use(routeErrorHandler(m => logged.push(m)));
  const srv = await listen(app);
  try {
    for (const path of ['/route-rejects', '/middleware-rejects', '/rejects-with-nothing']) {
      const r = await fetch(srv.base + path, { signal: AbortSignal.timeout(5_000) });
      const body = await r.text();
      assert.equal(r.status, 500, `${path}: ${body}`);
      assert.match(r.headers.get('content-type') ?? '', /^application\/json/, path);
      assert.deepEqual(JSON.parse(body), { error: 'Internal Server Error' }, path);
      assert.doesNotMatch(body, /detail|startsWith|\bat /, path);
      assert.equal((await fetch(srv.base + '/health')).status, 200, `served after ${path}`);
    }
    assert.equal(logged.length, 3);
    assert.match(logged[0]!, /^ERROR: route_error GET \/route-rejects TypeError: did\.startsWith/);
    assert.deepEqual(await (await fetch(srv.base + '/sync')).json(), { sync: true });
  } finally {
    await srv.close();
  }
});

test('error middleware keeps its four-argument arity, an async one forwards too, and a client error keeps its status', async () => {
  forwardAsyncRouteErrors(logForward);
  const app = express();
  app.use(express.json());
  app.get('/teapot', async () => { throw Object.assign(new Error('short and stout'), { kind: 'teapot' }); });
  app.get('/error-handler-rejects', async () => { throw new Error('first'); });
  app.use((err: Error & { kind?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.kind === 'teapot') { res.status(418).json({ handledBy: 'the app' }); return; }
    next(err);
  });
  app.use(async (err: Error, req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.path === '/error-handler-rejects') throw new Error('the error handler itself failed');
    next(err);
  });
  app.post('/json', (req, res) => { res.json(req.body); });
  app.use(routeErrorHandler(() => {}));
  const srv = await listen(app);
  try {
    const teapot = await fetch(srv.base + '/teapot');
    assert.equal(teapot.status, 418);
    assert.deepEqual(await teapot.json(), { handledBy: 'the app' });
    const twice = await fetch(srv.base + '/error-handler-rejects');
    assert.equal(twice.status, 500);
    assert.deepEqual(await twice.json(), { error: 'Internal Server Error' });
    // body-parser's 400 keeps its status and its client-facing message, as JSON.
    const bad = await fetch(srv.base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' });
    assert.equal(bad.status, 400);
    const badBody = await bad.json() as Record<string, unknown>;
    assert.equal(badBody['error'], 'Bad Request');
    assert.equal(typeof badBody['detail'], 'string');
  } finally {
    await srv.close();
  }
});

test('a handler that already started its response is not answered twice', async () => {
  forwardAsyncRouteErrors(logForward);
  const app = express();
  app.get('/half-sent', async (_req, res) => {
    res.status(200).setHeader('Content-Type', 'text/plain');
    res.write('partial');
    await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('failed mid-response');
  });
  app.get('/passed-on-then-rejects', async (_req, _res, next) => {
    next();
    await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('rejected after next()');
  });
  app.get('/passed-on-then-rejects', (_req, res) => { res.json({ answeredBy: 'the next handler' }); });
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use(routeErrorHandler(() => {}));
  const srv = await listen(app);
  try {
    const r = await fetch(srv.base + '/half-sent');
    assert.equal(r.status, 200);
    // Express's default ends a response it can no longer answer; the body is cut short.
    await r.text().catch(() => '');
    const passed = await fetch(srv.base + '/passed-on-then-rejects');
    assert.deepEqual(await passed.json(), { answeredBy: 'the next handler' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await fetch(srv.base + '/health')).status, 200);
    assert.ok(forwardLog.some(l => l.startsWith('ERROR: route_rejected_after_next Error: rejected after next()')), forwardLog.join('\n'));
  } finally {
    await srv.close();
  }
});

// ── Part 2: the identity server itself ────────────────────────────────────

let podServer: http.Server;
let identity: ChildProcess;
let base = '';
let output = '';

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}

before(async () => {
  // An empty store: the boot-time account rebuild finds no pods.
  podServer = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://pods').pathname;
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/turtle' });
      res.end(req.method === 'HEAD' ? undefined : '@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> a ldp:BasicContainer .\n');
      return;
    }
    res.writeHead(req.method === 'PUT' ? 201 : 404).end();
  });
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  const podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64'), ALLOW_OPEN_INTROSPECTION: '1', JANITOR_INTERVAL_MS: '0',
  });
  identity = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  identity.stdout!.on('data', d => { output += String(d); });
  identity.stderr!.on('data', d => { output += String(d); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (identity.exitCode !== null) throw new Error(`identity server exited ${identity.exitCode}:\n${output}`);
    try {
      const health = await (await fetch(`${base}/health`)).json() as { accountIndex?: { complete: boolean } };
      if (health.accountIndex?.complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

test('POST /auth/did with an array `did` answers JSON and the server answers /health afterwards', async () => {
  const challenge = await fetch(`${base}/challenges`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'did-sig' }),
  });
  assert.equal(challenge.status, 200, output);
  const { nonce } = await challenge.json() as { nonce: string };
  const r = await fetch(`${base}/auth/did`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: ['did:key:z6Mk'], nonce, signature: 'AA' }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await r.text();
  // 500 from the safety net while the route does not check the type of `did`; a 400 once it
  // does (that check is a separate change). Either is an answer; a crash is not.
  assert.ok(r.status === 500 || r.status === 400, `${r.status} ${body}\n${output}`);
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
  assert.doesNotMatch(body, /\bat .*\.ts:\d+/);
  if (r.status === 500) assert.match(output, /ERROR: route_error POST \/auth\/did TypeError/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(identity.exitCode, null, `the identity process exited:\n${output}`);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a malformed JSON body answers a JSON 400, not an HTML page with a stack trace', async () => {
  const r = await fetch(`${base}/auth/did`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json' });
  assert.equal(r.status, 400);
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
  const body = await r.json() as Record<string, unknown>;
  assert.equal(body['error'], 'Bad Request');
});
