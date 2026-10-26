/**
 * The stdio server's link_wallet tool speaks the identity server's nonce-bound /wallet/link.
 *
 * The identity server links a wallet only for a bearer-authenticated account and only with a
 * single-use nonce from POST /challenges (purpose 'siwe') signed inside the message. The tool
 * used to invent a nonce of its own for the message it showed, then submit a DIFFERENT message
 * (`Nonce: manual`, a new timestamp) with no nonce field and no bearer, so it could not work.
 *
 * BEHAVIOURAL: the real binary over stdio with the SDK client, against a stand-in identity
 * server that records what reaches it. A wallet signs exactly the message the first call
 * showed; the second call must submit that same message (the signature recovers to the
 * wallet), the nonce the first call fetched, and the configured bearer. Without a bearer
 * configured, the tool says so and sends nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { Wallet, getAddress, verifyMessage } from 'ethers';
import { ParsedMessage } from '@spruceid/siwe-parser';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'server.ts');
const require_ = createRequire(import.meta.url);
const tsxCli = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const ISSUED_NONCE = '0123456789abcdef0123456789abcdef'; // hex, as the identity server issues for 'siwe'
const TOKEN = 'test-identity-bearer';
const seen: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
let stub: http.Server;
let identityUrl = '';

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += String(d); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/challenges') {
        const address = typeof body['address'] === 'string' ? { address: getAddress(String(body['address']).toLowerCase()) } : {};
        res.end(JSON.stringify({ nonce: ISSUED_NONCE, expiresAt: new Date(Date.now() + 300_000).toISOString(), ...address }));
        return;
      }
      if (req.url === '/wallet/link') { res.end(JSON.stringify({ linked: true, userId: 'u-eth-linked', walletAddress: String(body['walletAddress']).toLowerCase() })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>(r => stub.listen(0, '127.0.0.1', r));
  identityUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>(r => stub.close(() => r())); });

async function connect(extraEnv: Record<string, string>) {
  const env = { ...process.env, CG_POD_DIRECTORY: '', DIRECTORY_URL: '', CG_IDENTITY_URL: identityUrl, ...extraEnv } as Record<string, string>;
  if (!extraEnv['CG_IDENTITY_TOKEN']) delete env['CG_IDENTITY_TOKEN'];
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsxCli, serverPath], env, stderr: 'ignore' });
  const client = new Client({ name: 'link-wallet-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => ((r as { content: Array<{ type: string; text?: string }> }).content
  .filter(c => c.type === 'text').map(c => c.text ?? '').join('\n'));

describe('link_wallet', () => {
  it('signs the identity server\'s own nonce and submits that same message with the bearer', async () => {
    seen.length = 0;
    const wallet = Wallet.createRandom();
    const client = await connect({ CG_IDENTITY_TOKEN: TOKEN });
    try {
      // A lowercase address, as a wallet's eth_requestAccounts hands it out.
      const shown = text(await client.callTool({ name: 'link_wallet', arguments: { wallet_address: wallet.address.toLowerCase() } }));
      expect(seen.map(s => s.path)).toEqual(['/challenges']);
      expect(seen[0]!.body).toEqual({ purpose: 'siwe', address: wallet.address.toLowerCase() });
      const message = /─+\n([\s\S]*?)\n─+/.exec(shown)?.[1];
      expect(message, shown).toBeTruthy();
      expect(message!.split('\n')[0]).toBe(`${new URL(identityUrl).host} wants you to sign in with your Ethereum account:`);
      expect(message).toContain(`Nonce: ${ISSUED_NONCE}`);
      // ERC-4361 with the EIP-55 address the server returned: a wallet reads it as a sign-in
      // (and checks its domain line); with a lowercase address it would not.
      expect(message!.split('\n')[1]).toBe(wallet.address);
      expect(new ParsedMessage(message!).nonce).toBe(ISSUED_NONCE);
      const nonce = /nonce: (\S+)/.exec(shown)?.[1];
      const issuedAt = /issued_at: (\S+)/.exec(shown)?.[1];
      expect(nonce).toBe(ISSUED_NONCE);
      expect(issuedAt).toBeTruthy();

      const signature = await wallet.signMessage(message!);
      const done = text(await client.callTool({ name: 'link_wallet', arguments: { wallet_address: wallet.address.toLowerCase(), signature, nonce, issued_at: issuedAt } }));
      expect(done).toMatch(/Wallet linked successfully/);
      const linkReq = seen.find(s => s.path === '/wallet/link');
      expect(linkReq, JSON.stringify(seen)).toBeTruthy();
      expect(linkReq!.authorization).toBe(`Bearer ${TOKEN}`);
      expect(linkReq!.body['nonce']).toBe(ISSUED_NONCE);
      expect(linkReq!.body['siweMessage']).toBe(message);
      expect(verifyMessage(String(linkReq!.body['siweMessage']), String(linkReq!.body['signature']))).toBe(wallet.address);
    } finally {
      await client.close();
    }
  }, 120_000);

  it('prints a cast command whose message argument the shell turns into exactly the bytes submitted', async () => {
    seen.length = 0;
    const wallet = Wallet.createRandom();
    const client = await connect({ CG_IDENTITY_TOKEN: TOKEN });
    try {
      const shown = text(await client.callTool({ name: 'link_wallet', arguments: { wallet_address: wallet.address } }));
      const message = /─+\n([\s\S]*?)\n─+/.exec(shown)?.[1];
      const castLine = shown.split('\n').find(l => l.includes('cast wallet sign'));
      expect(castLine, shown).toBeTruthy();
      const arg = castLine!.slice(castLine!.indexOf('<key> ') + '<key> '.length);
      // What `cast wallet sign --private-key <key> <arg>` receives as its message: bash's word
      // for <arg>. A double-quoted "...\n..." kept backslash-n, so cast signed one line.
      const word = execFileSync('bash', ['-c', `printf '%s' ${arg}`], { encoding: 'utf8' });
      expect(word).toBe(message);
      const nonce = /nonce: (\S+)/.exec(shown)?.[1];
      const issuedAt = /issued_at: (\S+)/.exec(shown)?.[1];
      const signature = await wallet.signMessage(word);
      await client.callTool({ name: 'link_wallet', arguments: { wallet_address: wallet.address, signature, nonce, issued_at: issuedAt } });
      const linkReq = seen.find(s => s.path === '/wallet/link');
      expect(verifyMessage(String(linkReq!.body['siweMessage']), String(linkReq!.body['signature']))).toBe(wallet.address);
    } finally {
      await client.close();
    }
  }, 120_000);

  it('without a configured bearer says so and sends nothing', async () => {
    seen.length = 0;
    const wallet = Wallet.createRandom();
    const client = await connect({});
    try {
      const first = text(await client.callTool({ name: 'link_wallet', arguments: { wallet_address: wallet.address } }));
      expect(first).toMatch(/no identity-server bearer token is configured/);
      const second = text(await client.callTool({ name: 'link_wallet', arguments: { wallet_address: wallet.address, signature: '0x00', nonce: 'n', issued_at: 't' } }));
      expect(second).toMatch(/no identity-server bearer token is configured/);
      expect(second).not.toMatch(/linked successfully/);
      expect(seen).toEqual([]);
    } finally {
      await client.close();
    }
  }, 120_000);
});
