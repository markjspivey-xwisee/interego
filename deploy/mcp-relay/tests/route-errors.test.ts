#!/usr/bin/env tsx
/**
 * A request that makes an async handler throw answers a JSON 500, and the relay keeps serving.
 *
 * Express 4 drops the promise an async handler returns, so a throw inside one was an unhandled
 * rejection, and Node 20+ ends the process for it: every OAuth pending authorization, session
 * and in-memory index the relay holds gone on one bad request. Measured on the identity server,
 * which shares this Express version and had the same gap (see route-errors.ts).
 *
 * §1 drives route-errors.ts on the relay's own copy of express, including a rejection inside an
 * express.Router() sub-router like the OAuth routers. §2 checks that server.ts wires all three
 * pieces, and the error handler last. §3 boots the real relay against stand-in identity and pod
 * servers and checks the terminal handler answers there.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/route-errors.test.ts
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { forwardAsyncRouteErrors, routeErrorHandler } from '../route-errors.js';
import { listenLoopback } from './listen-loopback.js';
import { stripComments } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms);

// ── §1 the helper, on the relay's express ───────────────────────────────────
console.log('\n1. route-errors.ts on the relay\'s express');
{
  check('§1 on express 4 the rejection forwarding is installed, not skipped', forwardAsyncRouteErrors(m => { console.error(m); }) === 'patched');

  const logged: string[] = [];
  const app = express();
  app.use(express.json());
  const sub = express.Router();
  sub.use(async (req, _res, next) => {
    if (req.path === '/middleware-rejects') throw new Error('sub-router middleware failed');
    next();
  });
  sub.post('/', async () => { throw new TypeError('Cannot read properties of undefined'); });
  app.use('/token', sub);
  app.get('/route-rejects', async () => { throw new Error('internal detail'); });
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use(routeErrorHandler(m => logged.push(m)));
  const srv = await listenLoopback(app);
  try {
    for (const [method, path] of [['GET', '/route-rejects'], ['POST', '/token'], ['GET', '/token/middleware-rejects']] as const) {
      let status = 0; let body = ''; let type = '';
      try {
        const r = await fetch(srv.base + path, { method, signal: timeout(5_000) });
        status = r.status; type = r.headers.get('content-type') ?? ''; body = await r.text();
      } catch (err) { body = (err as Error).name; }
      check(`§1 ${method} ${path} answers a JSON 500`, status === 500 && /^application\/json/.test(type), `${status} ${type} ${body}`);
      check(`§1 ${method} ${path} carries no message or stack from inside`,
        body === JSON.stringify({ error: 'Internal Server Error' }), body);
      const h = await fetch(srv.base + '/health', { signal: timeout(5_000) }).then(r => r.status, () => 0);
      check(`§1 …and the next request is served (${path})`, h === 200, String(h));
    }
    check('§1 each 500 is logged under its marker', logged.length === 3 && logged.every(l => l.startsWith('ERROR: route_error ')),
      JSON.stringify(logged.map(l => l.split('\n')[0])));
  } finally {
    await srv.close();
  }
}

// ── §2 server.ts wires all three, the error handler last ────────────────────
console.log('\n2. server.ts wiring');
{
  const code = stripComments(readFileSync(join(here, '..', 'server.ts'), 'utf8'), 'server.ts');
  const appAt = code.indexOf('const app = express();');
  const forwardAt = code.indexOf('forwardAsyncRouteErrors(log);');
  const handlerAt = code.indexOf('app.use(routeErrorHandler(log));');
  const listenAt = code.search(/^app\.listen\(PORT/m); // a regex, so the loopback scan does not read this as a listen
  check('§2 the safety net is installed', /^installProcessSafetyNet\(log\);$/m.test(code));
  check('§2 rejection forwarding is installed with the app', appAt > -1 && forwardAt > appAt, `app@${appAt} forward@${forwardAt}`);
  check('§2 the error handler is registered before listen', handlerAt > forwardAt && listenAt > handlerAt,
    `handler@${handlerAt} listen@${listenAt}`);
  // Express runs layers in registration order: a route added after the error handler is one it never sees.
  const between = code.slice(handlerAt + 'app.use(routeErrorHandler(log));'.length);
  const later = between.match(/\bapp\.(use|get|post|put|patch|delete|all|options)\(/g) ?? [];
  check('§2 ★ nothing is registered on the app after the error handler', later.length === 0, later.join(', '));
}

// ── §3 the real relay ───────────────────────────────────────────────────────
console.log('\n3. driven: the relay itself');
{
  const identityApp = express();
  identityApp.use(express.json());
  identityApp.post('/tokens/verify', (_q, s) => { s.json({ valid: false, reason: 'not part of this fixture' }); });
  identityApp.use((_q, s) => { s.status(404).json({ error: 'not part of this fixture' }); });
  const podApp = express();
  podApp.use(express.text({ type: () => true, limit: '4mb' }));
  podApp.use((q, s) => {
    if (q.method === 'PUT' || q.method === 'POST' || q.method === 'PATCH') { s.status(201).end(); return; }
    if (q.path.endsWith('/')) {
      s.type('text/turtle').status(200).send('@prefix ldp: <http://www.w3.org/ns/ldp#>. <> a ldp:Container, ldp:BasicContainer, ldp:Resource.');
      return;
    }
    s.status(404).end();
  });
  const identity = await listenLoopback(identityApp);
  const pod = await listenLoopback(podApp);

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const relayPort = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${relayPort}`;
  const keyFile = join(tmpdir(), `route-errors-key-${process.pid}-${relayPort}.json`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: join(here, '..'),
    env: {
      ...process.env,
      PORT: String(relayPort),
      CSS_URL: `${pod.base}/`,
      CSS_PUBLIC_URL: 'https://gate.fixture.example/',
      IDENTITY_URL: identity.base,
      PUBLIC_BASE_URL: base,
      RELAY_AGENT_KEY_FILE: keyFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stdout.on('data', () => { /* drained so the child never blocks on a full pipe */ });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { childErr = (childErr + c).slice(-1_500); });
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);
  try {
    let up = false;
    for (let i = 0; i < 240 && !up && child.exitCode === null; i++) {
      await new Promise(r => { setTimeout(r, 250).unref(); });
      up = await fetch(`${base}/health`, { signal: timeout(2_000) }).then(r => r.ok, () => false);
    }
    check('§3 the relay boots against the fixtures and answers /health', up, `child stderr tail: ${childErr || '(none)'}`);

    // A malformed body is the error every route can be sent: express.json() throws before any
    // handler runs, so the answer is the terminal handler's. Express's own default is an HTML
    // page carrying the parser's stack trace, since no image sets NODE_ENV=production.
    const r = await fetch(`${base}/oauth/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json', signal: timeout(10_000),
    }).catch(() => undefined);
    const type = r?.headers.get('content-type') ?? '';
    const body = r ? await r.text() : '';
    check('§3 a malformed body answers a JSON 400', r?.status === 400 && /^application\/json/.test(type), `${r?.status} ${type} ${body.slice(0, 200)}`);
    check('§3 …with no stack trace', !/\bat .*:\d+:\d+/.test(body) && JSON.parse(body || '{}')['error'] === 'Bad Request', body.slice(0, 200));
    check('§3 …and the relay\'s own headers are still on it', r?.headers.get('strict-transport-security') === 'max-age=31536000');
    const h = await fetch(`${base}/health`, { signal: timeout(5_000) }).then(x => x.status, () => 0);
    check('§3 the relay answers the next request', h === 200 && child.exitCode === null, `${h} exit=${child.exitCode}`);
  } finally {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    await pod.close();
    rmSync(keyFile, { force: true });
  }
}

console.log(failures === 0 ? '\nroute-errors: all checks passed' : `\nroute-errors: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
