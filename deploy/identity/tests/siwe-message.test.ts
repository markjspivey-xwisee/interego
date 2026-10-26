/**
 * parseSiweMessage accepts only what a wallet reads as Sign-In with Ethereum.
 *
 * The identity server's tie between a wallet signature and an Interego sign-in is the wallet's
 * own domain check: it shows the message's first line and warns when that is not the page
 * asking. MetaMask runs the check only on a message @spruceid/siwe-parser parses; any other text
 * is a plain signature request with no domain check. The server used to read the domain line
 * after String.prototype.trim (which also strips U+FEFF and U+00A0), split on \r?\n, take a
 * `Nonce:` line anywhere and require none of URI / Version / Chain ID / Issued At or an EIP-55
 * address, so an attacker could hand a victim a message the server took as a sign-in and the
 * wallet did not.
 *
 * Checked against siwe-parser itself (a root dependency, through `siwe`): every message the
 * project's clients build is accepted by both; every form the old reading let through is
 * refused by both; and over a few thousand random edits of valid messages, nothing this reader
 * accepts (with the server's EIP-55 check) is refused by siwe-parser.
 *
 * Run:
 *   node --test --import tsx tests/siwe-message.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { getAddress, Wallet } from 'ethers';
import { parseSiweMessage } from '../siwe-message.js';

const require = createRequire(import.meta.url);
const { ParsedMessage } = require('@spruceid/siwe-parser') as { ParsedMessage: new (m: string) => { domain: string; address: string; nonce: string; uri: string; statement?: string } };

const wallet = new Wallet('0x' + '11'.repeat(32));
const ADDR = wallet.address; // EIP-55
const NONCE = 'a3f09c'.repeat(8); // hex, as /challenges issues for 'siwe'
const ISSUED = '2026-10-26T10:00:00.000Z';

function message(o: { domain?: string; address?: string; statement?: string | null; uri?: string; nonce?: string; extra?: string[] } = {}): string {
  const statement = o.statement === undefined ? 'Sign in to Interego' : o.statement;
  return [
    `${o.domain ?? 'identity.interego.xwisee.com'} wants you to sign in with your Ethereum account:`,
    o.address ?? ADDR, '',
    ...(statement === null ? [''] : [statement, '']),
    `URI: ${o.uri ?? 'https://identity.interego.xwisee.com'}`, 'Version: 1', 'Chain ID: 1', `Nonce: ${o.nonce ?? NONCE}`, `Issued At: ${ISSUED}`,
    ...(o.extra ?? []),
  ].join('\n');
}

function wallets(text: string): boolean {
  try { new ParsedMessage(text); return true; } catch { return false; }
}
/** What the server accepts on grammar and address form (the rest is about this deployment). */
function server(text: string): boolean {
  const p = parseSiweMessage(text);
  if (!p.ok) return false;
  try { return getAddress(p.fields.address.toLowerCase()) === p.fields.address; } catch { return false; }
}

test('every message the project\'s clients build is read by this server and by a wallet, with the same fields', () => {
  const ours = [
    message(), // /connect, relay /authorize, client-sign.html, the canary: domain, URI = origin
    message({ domain: 'relay.interego.xwisee.com', uri: 'https://relay.interego.xwisee.com' }), // desktop app
    message({ domain: 'localhost:8090', uri: 'http://localhost:8090', statement: 'Link wallet to Interego identity: u-pk-0123456789ab' }), // stdio link_wallet
    message({ statement: null }),
    message({ extra: ['Expiration Time: 2026-10-26T10:05:00Z', 'Not Before: 2026-10-26T10:00:00Z', 'Request ID: req-1', 'Resources:', '- https://relay.interego.xwisee.com/mcp'] }),
  ];
  for (const m of ours) {
    const p = parseSiweMessage(m);
    assert.ok(p.ok, `${m}\n${'reason' in p ? p.reason : ''}`);
    const w = new ParsedMessage(m);
    assert.equal(p.fields.domain, w.domain);
    assert.equal(p.fields.address, w.address);
    assert.equal(p.fields.nonce, w.nonce);
    assert.equal(p.fields.uri, w.uri);
    assert.equal(p.fields.statement, w.statement ?? undefined);
  }
});

test('the forms the old reading let through are refused, and a wallet does not read them as a sign-in either', () => {
  const full = message();
  const minimal = `identity.interego.xwisee.com wants you to sign in with your Ethereum account:\n${ADDR}\n\nSign in.\n\nNonce: ${NONCE}`;
  const cases: Record<string, string> = {
    'a leading byte-order mark': '﻿' + full,
    'a leading no-break space': ' ' + full,
    'a leading space': ' ' + full,
    'the minimal message with no URI, Version, Chain ID or Issued At': minimal,
    'the issued nonce on a line of its own, another value in the Nonce field': message({ statement: `Nonce: ${NONCE}`, nonce: 'zzzzzzzz9' }),
    'a lowercase address': message({ address: ADDR.toLowerCase() }),
    'CRLF line ends': full.replace(/\n/g, '\r\n'),
    'a trailing newline': full + '\n',
    'a base64url nonce': message({ nonce: 'ab-cd_EFGH1234' }),
    'a trailing space on the domain line': full.replace(':\n', ': \n'),
  };
  for (const [name, text] of Object.entries(cases)) {
    // The nonce case is grammatical: the server refuses it for its Nonce field (below), and
    // a wallet reads its nonce as zzzzzzzz9, not the issued one.
    if (name.startsWith('the issued nonce')) {
      const p = parseSiweMessage(text);
      assert.ok(p.ok);
      assert.notEqual(p.fields.nonce, NONCE, name);
      assert.equal(new ParsedMessage(text).nonce, 'zzzzzzzz9');
      continue;
    }
    assert.equal(server(text), false, `server accepted ${name}`);
    assert.equal(wallets(text), false, `siwe-parser accepted ${name}, so this case shows nothing`);
  }
});

test('nothing this server accepts is text a wallet would not read as a sign-in (random edits of valid messages)', () => {
  // A small deterministic PRNG, so a failure reproduces.
  let seed = 0x5eed;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const alphabet = [' ', '\t', '\r', '\n', '﻿', ' ', ':', '-', '_', '.', '/', 'A', 'a', '0', '"', '%', 'é', '#', '['];
  const seeds = [message(), message({ statement: null }), message({ extra: ['Request ID: r1', 'Resources:', '- https://x.example/a'] })];
  let accepted = 0;
  for (let k = 0; k < 4000; k++) {
    let text = seeds[rand(seeds.length)]!;
    for (let e = 1 + rand(3); e > 0; e--) {
      const at = rand(text.length + 1);
      const op = rand(4);
      if (op === 0) text = text.slice(0, at) + alphabet[rand(alphabet.length)] + text.slice(at);
      else if (op === 1) text = text.slice(0, at) + text.slice(at + 1);
      else if (op === 2) { const lines = text.split('\n'); const i = rand(lines.length); lines.splice(i, 0, lines[i]!); text = lines.join('\n'); }
      else { const lines = text.split('\n'); lines.splice(rand(lines.length), 1); text = lines.join('\n'); }
    }
    if (server(text)) {
      accepted++;
      assert.ok(wallets(text), `server accepted text siwe-parser refuses:\n${JSON.stringify(text)}`);
      const p = parseSiweMessage(text);
      const w = new ParsedMessage(text);
      assert.ok(p.ok && p.fields.domain === w.domain && p.fields.nonce === w.nonce && p.fields.address === w.address, JSON.stringify(text));
    }
  }
  assert.ok(accepted > 50, `only ${accepted} edits were accepted: the corpus is not exercising the reader`);
});
