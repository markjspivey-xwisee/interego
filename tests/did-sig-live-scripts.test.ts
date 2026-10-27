/**
 * The live scripts under scripts/ that sign in with a did:key sign the text the identity server
 * hands out with a `did-sig` challenge.
 *
 * Each of them walks the relay's OAuth flow with a fresh Ed25519 key: /register, /authorize,
 * the identity server's /challenges, then /oauth/verify with the signature. An identity server
 * that names itself in the DID sign-in proof returns the exact text to sign as a string
 * `message` beside the nonce, and a client must sign that text byte for byte; with no
 * `message`, which is what every identity server before that change returns, the nonce is the
 * text. `test-publish-deref-roundtrip.mjs` runs nightly against the live relay
 * (nightly-emergent.yml); the others are run by hand against it.
 *
 * Each script runs in a child process with `fetch` pointed at a stand-in for the relay and the
 * identity server. The preload refuses any other URL, so nothing reaches the network. The
 * stand-in records the proof at /oauth/verify and answers 400 there, which ends the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, randomBytes, verify as edVerify } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LIVE_RELAY = 'https://relay.interego.xwisee.com';

// Repo-relative literals on purpose: tests/workflow-trigger-covers-the-suite.test.ts reads them
// and requires the root suite's workflow to run when one of these files changes.
const SCRIPTS = [
  'scripts/diag-signed-cas-size.mjs',
  'scripts/test-publish-deref-roundtrip.mjs',
  'scripts/test-relay-end-to-end.mjs',
  'scripts/test-relay-reduce.mjs',
  'scripts/verify-cas-split.mjs',
  'scripts/verify-publish-defer.mjs',
  'scripts/verify-rev2-fixes.mjs',
  'scripts/verify-rev3-fixes.mjs',
  'scripts/verify-shacl-and-traversal.mjs',
  'scripts/verify-signed-cas-fix.mjs',
];

/** Rewrites the live relay's origin to the stand-in and refuses every other origin. */
const PRELOAD = `data:text/javascript,${encodeURIComponent(`
const target = process.env.STANDIN_ORIGIN;
const live = ${JSON.stringify(LIVE_RELAY)};
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(live)) url = target + url.slice(live.length);
  if (!url.startsWith(target + '/')) return Promise.reject(new Error('stand-in: refusing ' + url));
  return realFetch(url, init);
};
`)}`;

let server: Server;
let origin: string;
/** What /challenges returns beside the nonce; undefined sends no `message` at all. */
let messageFor: ((nonce: string) => unknown) | undefined;
const issued = new Map<string, unknown>();
const proofs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const reply = (status: number, body: unknown, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method === 'POST' && path === '/register') { reply(201, { client_id: `client-${randomBytes(4).toString('hex')}` }); return; }
      if (req.method === 'GET' && path === '/authorize') {
        reply(200, `<html><script>\nconst PENDING_ID = "pend-${randomBytes(4).toString('hex')}";\nconst IDENTITY = "${origin}";\n</script></html>`, 'text/html');
        return;
      }
      if (req.method === 'POST' && path === '/challenges') {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        if (body['purpose'] !== 'did-sig') { reply(400, { error: 'purpose' }); return; }
        const nonce = randomBytes(32).toString('base64url');
        if (messageFor) {
          const message = messageFor(nonce);
          issued.set(nonce, message);
          reply(200, { nonce, message });
        } else {
          issued.set(nonce, undefined);
          reply(200, { nonce });
        }
        return;
      }
      if (req.method === 'POST' && path === '/oauth/verify') {
        proofs.push(JSON.parse(raw || '{}') as Record<string, unknown>);
        reply(400, { error: 'the stand-in stops here' });
        return;
      }
      reply(404, { error: 'not on the stand-in' });
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => { server.close(); });

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** The Ed25519 public key a W3C did:key names. */
function didKeyPublicKey(did: string) {
  if (!did.startsWith('did:key:z')) throw new Error(`not a base58btc did:key: ${did}`);
  let n = 0n;
  for (const ch of did.slice('did:key:z'.length)) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = Buffer.from(n.toString(16).padStart(68, '0'), 'hex');
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) throw new Error(`not an Ed25519 did:key: ${did}`);
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes.subarray(2).toString('base64url') }, format: 'jwk' });
}

/** Run one script against the stand-in; return the proof it posted to /oauth/verify. */
async function proofFrom(script: string): Promise<{ nonce: string; valid: (text: string) => boolean }> {
  const before = proofs.length;
  // RELAY_URL would point test-publish-deref-roundtrip.mjs elsewhere and LEGACY_DID_KEY would
  // give test-relay-end-to-end.mjs a pre-W3C did:key; neither is what is under test.
  const env: NodeJS.ProcessEnv = { ...process.env, STANDIN_ORIGIN: origin };
  delete env['RELAY_URL'];
  delete env['LEGACY_DID_KEY'];
  const child = spawn(process.execPath, ['--import', PRELOAD, script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (c: Buffer) => { output += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { output += c.toString(); });
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 20_000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  const proof = proofs[before];
  if (!proof || proofs.length !== before + 1) throw new Error(`${script} posted ${proofs.length - before} proofs; output:\n${output.slice(-2000)}`);
  const key = didKeyPublicKey(String(proof['did']));
  const signature = Buffer.from(String(proof['signature']), 'base64url');
  const nonce = String(proof['nonce']);
  expect(issued.has(nonce)).toBe(true);
  return { nonce, valid: (text: string) => edVerify(null, Buffer.from(text, 'utf8'), key, signature) };
}

describe.each(SCRIPTS)('%s', (script) => {
  it('signs the message /challenges returns, byte for byte, and not the bare nonce', async () => {
    const v1 = (nonce: string) => `Interego DID sign-in v1\nHost: identity.interego.xwisee.com\nNonce: ${nonce}`;
    messageFor = v1;
    try {
      const { nonce, valid } = await proofFrom(script);
      expect(valid(v1(nonce))).toBe(true);
      expect(valid(nonce)).toBe(false);
    } finally {
      messageFor = undefined;
    }
  }, 30_000);

  it('signs the bare nonce when /challenges returns no message', async () => {
    messageFor = undefined;
    const { nonce, valid } = await proofFrom(script);
    expect(valid(nonce)).toBe(true);
  }, 30_000);
});
