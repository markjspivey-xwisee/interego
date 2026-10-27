#!/usr/bin/env tsx
/**
 * The relay's call to identity's POST /tokens/verify carries IDENTITY_INTROSPECTION_SECRET.
 *
 * verifyBearerToken sends `Authorization: Bearer <IDENTITY_INTROSPECTION_SECRET>` when that
 * variable is non-empty, and no Authorization when it is unset. An identity server enforcing a
 * value answers anything else with 401, which the relay reports as the 401 `detail`
 * 'Identity server error: 401' on an auth-required REST tool. GET /health reports whether a
 * bearer is presented (`identityVerifyAuth`) and never the value. A value fetch cannot put in
 * a header (a line break, say) makes fetch throw with a message that quotes the header; that
 * message must not reach the 401 either.
 *
 * Boots the real relay three times (secret set, malformed, unset) against stand-in identity
 * and pod servers, as route-errors.test.ts §3 does.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/identity-introspection-bearer.test.ts
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { listenLoopback } from './listen-loopback.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}
const timeout = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const SECRET = '9a8b7c6d5e4f30211203f4e5d6c7b8a99a8b7c6d5e4f30211203f4e5d6c7b8a9';
const LEFT = 'a'.repeat(24);
const RIGHT = 'b'.repeat(24);

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
const pod = await listenLoopback(podApp);

interface Relay {
  base: string;
  /** The Authorization header of each /tokens/verify the stub identity received. */
  seen: (string | undefined)[];
  /** The bearer the stub identity accepts; null = it runs open and accepts any. */
  expect: (value: string | null) => void;
  stop: () => Promise<void>;
}

async function bootRelay(secret: string | undefined): Promise<Relay> {
  const seen: (string | undefined)[] = [];
  let expected: string | null = secret ?? null;
  const identityApp = express();
  identityApp.use(express.json());
  identityApp.post('/tokens/verify', (q, s) => {
    seen.push(q.headers.authorization);
    if (expected !== null && q.headers.authorization !== `Bearer ${expected}`) {
      s.status(401).json({ error: 'introspection bearer rejected' });
      return;
    }
    s.json({ valid: false, reason: 'Token not found' });
  });
  identityApp.use((_q, s) => { s.status(404).json({ error: 'not part of this fixture' }); });
  const identity = await listenLoopback(identityApp);

  const probe = createServer();
  await new Promise<void>(r => { probe.listen(0, '127.0.0.1', () => r()); });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(r => { probe.close(() => r()); });
  const base = `http://127.0.0.1:${port}`;
  const keyFile = join(tmpdir(), `identity-introspection-key-${process.pid}-${port}.json`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    CSS_URL: `${pod.base}/`,
    CSS_PUBLIC_URL: 'https://gate.fixture.example/',
    IDENTITY_URL: identity.base,
    PUBLIC_BASE_URL: base,
    RELAY_AGENT_KEY_FILE: keyFile,
  };
  delete env['IDENTITY_INTROSPECTION_SECRET'];
  if (secret !== undefined) env['IDENTITY_INTROSPECTION_SECRET'] = secret;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: join(here, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErr = '';
  child.stdout.on('data', () => { /* drained so the child never blocks on a full pipe */ });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => { childErr = (childErr + c).slice(-1_500); });
  const killChild = (): void => { child.kill(); };
  process.once('exit', killChild);
  const stop = async (): Promise<void> => {
    child.kill();
    process.removeListener('exit', killChild);
    await identity.close();
    rmSync(keyFile, { force: true });
  };
  let up = false;
  for (let i = 0; i < 240 && !up && child.exitCode === null; i++) {
    await new Promise(r => { setTimeout(r, 250).unref(); });
    up = await fetch(`${base}/health`, { signal: timeout(2_000) }).then(r => r.ok, () => false);
  }
  if (!up) { await stop(); throw new Error(`relay did not boot (secret ${secret === undefined ? 'unset' : 'set'}): ${childErr || '(no stderr)'}`); }
  return { base, seen, expect: (v) => { expected = v; }, stop };
}

/** An auth-required REST tool with a bearer identity does not know: the 401's `detail`. */
async function toolDetail(relay: Relay): Promise<{ status: number; detail: string; text: string }> {
  const r = await fetch(`${relay.base}/tool/publish_context`, {
    method: 'POST',
    headers: { Authorization: 'Bearer probe', 'Content-Type': 'application/json' },
    body: '{}',
    signal: timeout(15_000),
  });
  const text = await r.text();
  let detail = '';
  try { detail = String((JSON.parse(text) as Record<string, unknown>)['detail'] ?? ''); } catch { /* not JSON */ }
  return { status: r.status, detail, text };
}

async function health(relay: Relay): Promise<{ body: Record<string, unknown>; text: string }> {
  const text = await (await fetch(`${relay.base}/health`, { signal: timeout(5_000) })).text();
  return { body: JSON.parse(text) as Record<string, unknown>, text };
}

const [withSecret, malformed, unset] = await Promise.all([
  bootRelay(SECRET),
  bootRelay(`${LEFT}\n${RIGHT}`),
  bootRelay(undefined),
]);

try {
  console.log('\n1. IDENTITY_INTROSPECTION_SECRET set');
  {
    const r = await toolDetail(withSecret);
    check('§1 identity answers, and its reason is the 401 detail', r.status === 401 && r.detail === 'Token not found', `${r.status} ${r.text.slice(0, 300)}`);
    check('§1 the verify call carried Bearer <secret>', withSecret.seen.length > 0 && withSecret.seen.every(a => a === `Bearer ${SECRET}`),
      JSON.stringify(withSecret.seen.map(a => (a === `Bearer ${SECRET}` ? 'Bearer <secret>' : a))));
    const h = await health(withSecret);
    check('§1 /health says a bearer is presented', h.body['identityVerifyAuth'] === true, h.text.slice(0, 300));
    check('§1 /health shows nothing of the value', !h.text.includes(SECRET) && !h.text.includes(SECRET.slice(0, 12)));
    withSecret.expect('other');
    const refused = await toolDetail(withSecret);
    check('§1 an identity enforcing another value is reported as "Identity server error: 401"',
      refused.status === 401 && refused.detail === 'Identity server error: 401', `${refused.status} ${refused.detail}`);
    check('§1 …and the 401 never quotes the value', !refused.text.includes(SECRET));
  }

  console.log('\n2. A value fetch cannot put in a header');
  {
    const r = await toolDetail(malformed);
    check('§2 the 401 says identity could not be reached', r.status === 401 && r.detail.startsWith('Cannot reach identity server'), `${r.status} ${r.detail}`);
    check('§2 …and does not quote the header', !r.text.includes(LEFT) && !r.text.includes(RIGHT), r.detail);
  }

  console.log('\n3. IDENTITY_INTROSPECTION_SECRET unset');
  {
    const r = await toolDetail(unset);
    check('§3 an open identity answers', r.status === 401 && r.detail === 'Token not found', `${r.status} ${r.text.slice(0, 300)}`);
    check('§3 the verify call carried no Authorization', unset.seen.length > 0 && unset.seen.every(a => a === undefined), JSON.stringify(unset.seen));
    const h = await health(unset);
    check('§3 /health says no bearer is presented', h.body['identityVerifyAuth'] === false, h.text.slice(0, 300));
    unset.expect(SECRET);
    const refused = await toolDetail(unset);
    check('§3 against an enforcing identity the relay gets "Identity server error: 401"',
      refused.status === 401 && refused.detail === 'Identity server error: 401', `${refused.status} ${refused.detail}`);
  }
} finally {
  await Promise.all([withSecret, malformed, unset].map(r => r.stop()));
  await pod.close();
}

console.log(failures === 0 ? '\nidentity-introspection-bearer: all checks passed' : `\nidentity-introspection-bearer: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
