#!/usr/bin/env tsx
/**
 * The DID method on the relay's /authorize page asks the person to sign the text the identity
 * server hands out with a `did-sig` challenge.
 *
 * An identity server that names itself in the DID sign-in proof returns that text as a string
 * `message` beside the nonce. The page has to show it, and its UTF-8 bytes as base64url, exactly
 * as received: never rebuilt from its parts, trimmed or re-encoded. With no `message`, which is
 * what every identity server before that change returns, the text is the nonce, as before. The
 * nonce goes back with the signature either way.
 *
 * This runs the page's own inline script in a VM against stand-ins for the DOM (built from the
 * element ids the page actually carries, so a missing field is null as in a browser), for the
 * identity server's /challenges and for the relay's /oauth/verify. It signs what the page shows
 * with an Ed25519 key, as a person would, submits, and checks what reached /oauth/verify.
 */
import vm from 'node:vm';
import { generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import type { Response } from 'express';
import { InteregoOAuthProvider } from '../oauth-provider.js';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const IDENTITY_ORIGIN = 'https://identity.example.invalid';
const provider = new InteregoOAuthProvider({ identityUrl: IDENTITY_ORIGIN, tokenTtlSec: 3600 });

/** The /authorize page exactly as the provider renders it. */
async function renderPage(): Promise<string> {
  let html = '';
  const res = { setHeader: () => res, send: (body: string) => { html = body; return res; } };
  await provider.authorize(
    { client_id: 'did-page-test', client_name: 'did page test', redirect_uris: ['https://client.example.invalid/cb'] },
    { codeChallenge: 'x'.repeat(43), redirectUri: 'https://client.example.invalid/cb', scopes: ['mcp'], state: 's' },
    res as unknown as Response,
  );
  return html;
}

interface Element { id: string; value: string; textContent: string; className: string; style: { display: string } }

interface Challenge { status?: number; body: Record<string, unknown> }

/**
 * Load the page's script in a fresh VM. `challenge` is what the stand-in /challenges answers;
 * the returned `posts` records every JSON body the page sends, by URL.
 */
function loadPage(html: string, challenge: Challenge) {
  const elements = new Map<string, Element>();
  for (const m of html.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements.set(m[1]!, { id: m[1]!, value: '', textContent: '', className: '', style: { display: /display:\s*none/.test(m[0]) ? 'none' : '' } });
  }
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch = async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    posts.push({ url, body });
    if (url === `${IDENTITY_ORIGIN}/challenges`) {
      const status = challenge.status ?? 200;
      return { ok: status < 400, status, json: async () => challenge.body };
    }
    if (url === '/oauth/verify') {
      return { ok: true, status: 200, json: async () => ({ redirect: 'https://client.example.invalid/cb?code=c&state=s' }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not here' }) };
  };
  const window = { location: { href: '', host: 'relay.example.invalid', origin: 'https://relay.example.invalid' } };
  const context = vm.createContext({
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    fetch: fakeFetch, window, TextEncoder, btoa, atob, Uint8Array, JSON, Error, String, Array,
  });
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('the /authorize page carries no inline script');
  vm.runInContext(script, context);
  const call = (fn: string) => vm.runInContext(`${fn}()`, context) as Promise<void>;
  return { elements, posts, window, call };
}

/** A did:key for a fresh Ed25519 key, and a signer over raw bytes. */
function didKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.concat([Buffer.from([0xed, 0x01]), raw]).toString('hex'));
  let enc = '';
  while (n > 0n) { enc = B58[Number(n % 58n)] + enc; n /= 58n; }
  return {
    did: `did:key:z${enc}`,
    sign: (bytes: Buffer) => edSign(null, bytes, privateKey).toString('base64url'),
    verifies: (bytes: Buffer, signature: string) => edVerify(null, bytes, publicKey, Buffer.from(signature, 'base64url')),
  };
}

/** Request a challenge, sign what the page shows as a person would, submit; return what was sent. */
async function signIn(html: string, challenge: Challenge) {
  const page = loadPage(html, challenge);
  const key = didKey();
  page.elements.get('did-did')!.value = key.did;
  await page.call('didChallenge');
  const shownText = page.elements.get('did-text')?.value;
  const shownB64 = page.elements.get('did-text-b64')?.value;
  const wrapShown = page.elements.get('did-nonce-wrap')!.style.display === 'block';
  // The person signs the bytes the page gives them: the base64url field, decoded.
  const signed = shownB64 === undefined ? undefined : Buffer.from(shownB64, 'base64url');
  if (signed) page.elements.get('did-sig')!.value = key.sign(signed);
  await page.call('didSubmit');
  const proof = page.posts.find((p) => p.url === '/oauth/verify')?.body;
  const challengeRequest = page.posts.find((p) => p.url === `${IDENTITY_ORIGIN}/challenges`)?.body;
  return { page, key, shownText, shownB64, signed, wrapShown, proof, challengeRequest };
}

const html = await renderPage();
const NONCE = 'q0Zc3uY8hQk1t9O2xJw4bA7mVf6pLs5rNd0eGiKoUyE';
const V1 = `Interego DID sign-in v1\nHost: identity.interego.xwisee.com\nNonce: ${NONCE}`;

console.log('\nThe /authorize page signs the did-sig challenge text the identity server returns');

try {
  // ── A server that returns a message: the page shows exactly it, and its bytes ───────────────
  {
    const r = await signIn(html, { body: { nonce: NONCE, message: V1 } });
    ok(r.challengeRequest?.['purpose'] === 'did-sig', 'the page asks /challenges for a did-sig challenge', JSON.stringify(r.challengeRequest));
    ok(r.wrapShown, 'the signing fields are shown once the challenge arrives');
    ok(r.shownText === V1, 'the text to sign is the message, exactly as the server sent it', JSON.stringify(r.shownText));
    ok(r.signed !== undefined && r.signed.equals(Buffer.from(V1, 'utf8')),
      '…and the base64url field holds exactly its UTF-8 bytes', JSON.stringify(r.shownB64));
    ok(r.proof?.['nonce'] === NONCE && r.proof?.['did'] === r.key.did,
      'the nonce and the DID go back with the signature', JSON.stringify(r.proof));
    const sig = String(r.proof?.['signature'] ?? '');
    ok(r.key.verifies(Buffer.from(V1, 'utf8'), sig), 'the submitted signature verifies over the message');
    ok(!r.key.verifies(Buffer.from(NONCE, 'utf8'), sig), '…and not over the bare nonce');
    ok(r.page.window.location.href.includes('code=c'), 'the page follows the redirect /oauth/verify returns');
  }

  // ── A message the page could not have rebuilt: CRLF, non-ASCII, combining mark, edges ──────
  {
    const odd = ` Interego DID sign-in v9\r\nHost: idéntity.example\nNote: é \u{1F511}\nNonce: ${NONCE}\n`;
    const r = await signIn(html, { body: { nonce: NONCE, message: odd } });
    ok(r.signed !== undefined && r.signed.equals(Buffer.from(odd, 'utf8')),
      'an unusual message is encoded byte for byte: no trimming, no line-end or Unicode rewriting', JSON.stringify(r.shownB64));
    ok(r.key.verifies(Buffer.from(odd, 'utf8'), String(r.proof?.['signature'] ?? '')), '…and the signature over those bytes is what is submitted');
  }

  // ── A server that returns no message: the nonce is the text, as before ──────────────────────
  {
    const r = await signIn(html, { body: { nonce: NONCE } });
    ok(r.shownText === NONCE, 'with no message, the text to sign is the bare nonce', JSON.stringify(r.shownText));
    ok(r.signed !== undefined && r.signed.equals(Buffer.from(NONCE, 'utf8')), '…and the base64url field holds the nonce\'s bytes');
    ok(r.proof?.['nonce'] === NONCE && r.key.verifies(Buffer.from(NONCE, 'utf8'), String(r.proof?.['signature'] ?? '')),
      '…and the signature over the nonce goes back with it', JSON.stringify(r.proof));
  }

  // ── A `message` that is not a string is not a text to sign ──────────────────────────────────
  for (const notText of [null, 42, { text: V1 }, [V1]]) {
    const r = await signIn(html, { body: { nonce: NONCE, message: notText } });
    ok(r.shownText === NONCE, `a ${JSON.stringify(notText)} message leaves the bare nonce as the text`, JSON.stringify(r.shownText));
  }

  // ── A failed challenge request shows its error and offers nothing to sign ───────────────────
  {
    const page = loadPage(html, { status: 503, body: { error: 'identity unavailable' } });
    page.elements.get('did-did')!.value = 'did:key:z6Mkexample';
    await page.call('didChallenge');
    const status = page.elements.get('did-status')!;
    ok(status.className.includes('err') && status.textContent.includes('identity unavailable'),
      'a failed /challenges request shows its error', `${status.className}: ${status.textContent}`);
    ok(page.elements.get('did-nonce-wrap')!.style.display !== 'block', '…and does not open the signing fields');
  }
} finally {
  console.log(`\n${pass} passed, ${fail} failed\n`);
}
process.exit(fail === 0 ? 0 : 1);
