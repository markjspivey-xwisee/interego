// css-gate's startup line warns about an IDENTITY_INTROSPECTION_SECRET it cannot send intact,
// exactly for those values, and never shows the value.
//
// The gate presents the value as `Authorization: Bearer <value>` through fetch. A trailing space
// or tab is dropped on the way; an ASCII control character other than TAB (U+0000-U+001F or
// U+007F), or a character above U+00FF, makes fetch throw. Leading and interior whitespace and
// other Latin-1 characters, the C1 controls U+0080-U+009F among them, arrive intact. So the
// warning must fire for the first group and for nothing that works: a false "every identity
// verify fails" can send an operator to rotate a working value. Identity's
// token-introspection-routes.test.ts runs the same table against identity's own warning.
//
// The startup line is printed only when the gate listens, so each value runs a gate as a child
// process, against a stand-in identity that accepts `Bearer <value>` exactly as identity reads it
// (Node's parser, then the text after `Bearer `) and a stand-in upstream that answers 201.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { listenLoopback } from './loopback.mjs';

const HEX = '5b0c9e3a71d84f26a3e5c7091b2d4f6e8a0c1e3f5b7d9a2c4e6f8b0d1a3c5e7f';
const TABLE = [
  ['a leading space', ` ${HEX}`, 'accepted'],
  ['an interior space', `${HEX.slice(0, 32)} ${HEX.slice(32)}`, 'accepted'],
  ['an interior tab', `${HEX.slice(0, 32)}\t${HEX.slice(32)}`, 'accepted'],
  ['a Latin-1 character', `${HEX}é`, 'accepted'],
  ['a C1 control character', `${HEX.slice(0, 32)}\u0085${HEX.slice(32)}`, 'accepted'],
  ['a trailing space', `${HEX} `, 'refused'],
  ['a trailing tab', `${HEX}\t`, 'refused'],
  ['a control character', `${HEX.slice(0, 32)}\u0001${HEX.slice(32)}`, 'refused'],
  ['a character above U+00FF', `${HEX}Ā`, 'refused'],
];

// Which value each gate (told apart by the token it sends) is configured with.
const expectedFor = new Map();
const identity = await listenLoopback(createHttpServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const { token } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const ok = expectedFor.has(token) && presented === expectedFor.get(token);
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { valid: true, userId: 'alice' } : { error: 'introspection bearer rejected' }));
  });
}));
const upstream = await listenLoopback(createHttpServer((req, res) => {
  req.resume();
  req.on('end', () => { res.writeHead(201).end(); });
}));

const children = [];
after(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map((child) => (child.exitCode !== null ? null : new Promise((resolve) => child.once('exit', resolve)))));
  await identity.close();
  await upstream.close();
});

async function freePort() {
  const s = createNetServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** A gate holding `value`, started as the image starts it; resolves once its startup lines are out. */
async function startGate(value) {
  const port = await freePort();
  const env = {
    PATH: process.env.PATH, PORT: String(port), WRITE_SECRET: 'test-write-secret',
    CSS_INTERNAL_URL: upstream.base, PUBLIC_BASE_URL: 'http://gate.invalid.test', CSS_HOST_HEADER: 'css.public.example',
    IDENTITY_URL: identity.base, IDENTITY_INTROSPECTION_SECRET: value,
  };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const deadline = Date.now() + 30_000;
  while (!/per-user-bearer cache TTL/.test(out)) {
    if (child.exitCode !== null) throw new Error(`css-gate exited ${child.exitCode}:\n${out}`);
    if (Date.now() > deadline) throw new Error(`css-gate did not start:\n${out}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { base: `http://127.0.0.1:${port}`, output: () => out };
}

test('the warning fires exactly for the values the gate cannot present, and never shows the value', async () => {
  const gates = await Promise.all(TABLE.map(([, value]) => startGate(value)));
  for (const [i, [why, value, expected]] of TABLE.entries()) {
    const token = `token-${i}`;
    expectedFor.set(token, value);
    const r = await fetch(`${gates[i].base}/alice/a`, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle', authorization: `Bearer ${token}` },
      body: '<a> <b> <c> .',
    });
    const text = await r.text();
    const outcome = r.status === 201 ? 'accepted' : r.status === 401 ? 'refused' : `status ${r.status}`;
    const out = gates[i].output();
    const line = out.split('\n').find((l) => l.includes('identity verify :')) ?? '';
    const warned = /cannot be sent intact in a header, so every identity verify fails while identity holds the same value/.test(line);
    assert.equal(outcome, expected, `${why}: ${text}`);
    assert.equal(warned, expected === 'refused', `${why}: ${line}`);
    if (!warned) assert.match(line, /with introspection bearer/, why);
    assert.equal(out.includes(HEX.slice(0, 12)), false, `${why}: the startup output shows part of the value`);
    assert.equal(text.includes(HEX.slice(0, 12)), false, `${why}: the 401 shows part of the value`);
  }
});
