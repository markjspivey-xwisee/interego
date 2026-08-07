/**
 * MEASURE WHETHER A BEARER CAN BE REFRESHED WITHOUT THE USER, before building on it.
 *
 * Bearers last ~1 h (`tokenTtlSec ?? 3600`). Two ways to survive that, and they are not
 * equivalent: re-run the whole sign-in, or exchange a refresh token. The first needs a browser
 * and a gesture on the passkey path, so a desktop shell that only had that would drop a
 * passkey user out of their workspace once an hour with no silent recovery. The second is a
 * plain POST — IF the relay issues one to a PUBLIC client (`token_endpoint_auth_method: none`)
 * and accepts it back.
 *
 * This asks. It prints whether `/token` returned a `refresh_token`, whether exchanging it
 * yields a working bearer, whether the OLD bearer is invalidated by the exchange (rotation),
 * and whether a second refresh works — because a refresh token that is single-use and not
 * rotated forward would give exactly one extra hour and then fail in the same way.
 *
 *   npx tsx applications/shared-workspace/tools/probe-refresh-live.ts
 */

import { readFileSync } from 'node:fs';
import { Wallet } from 'ethers';
import { mintBearer } from './live-identity.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';
const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

/** One `tools/call` with a bearer, reduced to "did this token work". */
async function podWith(token: string): Promise<string> {
  const res = await fetch(RELAY + '/mcp', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_pod_status', arguments: {} } }),
  });
  if (res.status === 401) return 'HTTP 401';
  const raw = await res.text();
  const j = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; } })()
    ?? (() => { try { return JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')) as Record<string, unknown>; } catch { return null; } })();
  if (!j) return 'HTTP ' + res.status + ' unparseable';
  const result = j['result'] as { structuredContent?: { pod?: string }; content?: { text?: string }[] } | undefined;
  const pod = result?.structuredContent?.pod
    ?? (() => { try { return (JSON.parse(result?.content?.[0]?.text ?? '{}') as { pod?: string }).pod; } catch { return undefined; } })();
  return pod ?? ('HTTP ' + res.status + ' ' + raw.slice(0, 120));
}

async function run(): Promise<void> {
  const seed = (JSON.parse(readFileSync(process.env['INTEREGO_WALLET_A'] ?? '.interego/maintainer.json', 'utf8')) as { privateKey: string }).privateKey;
  const wallet = new Wallet(seed);

  // `mintBearer` discards the refresh token, so the raw grant is re-fetched here by repeating
  // its last step with the same client. Simpler: mint, then read the grant body directly.
  const grant = await mintRaw(wallet);
  log('access_token           :', grant.access_token ? 'present · ' + String(grant.access_token).length + ' chars' : 'ABSENT');
  log('expires_in             :', grant.expires_in ?? 'not reported by the grant');
  log('refresh_token          :', grant.refresh_token ? 'present · ' + String(grant.refresh_token).length + ' chars' : 'ABSENT');
  log('token_type             :', grant.token_type ?? 'not reported');
  log('scope                  :', grant.scope ?? 'not reported');
  if (!grant.refresh_token) { log('\nNO REFRESH TOKEN — silent renewal is not available on this relay for a public client.'); return; }

  log('\noriginal bearer works  :', await podWith(String(grant.access_token)));

  const r1 = await refresh(String(grant.refresh_token), grant.client_id);
  log('\nrefresh #1 status      :', r1.status);
  log('  access_token         :', r1.body.access_token ? 'present' : 'ABSENT · ' + JSON.stringify(r1.body).slice(0, 220));
  log('  refresh_token        :', r1.body.refresh_token ? (r1.body.refresh_token === grant.refresh_token ? 'SAME as before (not rotated)' : 'ROTATED — a new one came back') : 'ABSENT — the exchange returned no successor');
  log('  expires_in           :', r1.body.expires_in ?? 'not reported');
  if (r1.body.access_token) log('  new bearer works     :', await podWith(String(r1.body.access_token)));
  log('  OLD bearer after it  :', await podWith(String(grant.access_token)));

  const next = r1.body.refresh_token ?? grant.refresh_token;
  const r2 = await refresh(String(next), grant.client_id);
  log('\nrefresh #2 status      :', r2.status, r2.body.access_token ? '· access_token present' : '· ' + JSON.stringify(r2.body).slice(0, 220));
  if (r2.body.access_token) log('  second new bearer works:', await podWith(String(r2.body.access_token)));

  // The one that decides the shape of the desktop's timer: is the FIRST refresh token still
  // usable after it has been exchanged once? If not, the shell must carry the successor
  // forward, and dropping it means the next renewal fails an hour later with no user present.
  const reuse = await refresh(String(grant.refresh_token), grant.client_id);
  log('\nre-using the FIRST refresh token after it was exchanged:', reuse.status,
    reuse.body.access_token ? '· ACCEPTED (not single-use)' : '· refused · ' + JSON.stringify(reuse.body).slice(0, 160));
}

interface Grant { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string; client_id: string }

async function refresh(refreshToken: string, clientId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(RELAY + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: RELAY + '/' }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The same ceremony `mintBearer` runs, returning the WHOLE grant instead of a bearer. */
async function mintRaw(wallet: Wallet): Promise<Grant> {
  const { createHash, randomBytes } = await import('node:crypto');
  const b64u = (b: Buffer): string => b.toString('base64url');
  const json = { 'Content-Type': 'application/json' };
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const redirectUri = 'http://127.0.0.1:1/callback';
  const reg = await (await fetch(RELAY + '/register', {
    method: 'POST', headers: json,
    body: JSON.stringify({ client_name: 'interego-workspace-refresh-probe', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  })).json() as { client_id: string };
  const authorizeUrl = RELAY + '/authorize?response_type=code&client_id=' + encodeURIComponent(reg.client_id)
    + '&redirect_uri=' + encodeURIComponent(redirectUri) + '&code_challenge=' + challenge
    + '&code_challenge_method=S256&scope=mcp&state=' + b64u(randomBytes(9)) + '&resource=' + encodeURIComponent(RELAY + '/');
  const pendingId = /const PENDING_ID\s*=\s*['"]([^'"]+)/.exec(await (await fetch(authorizeUrl)).text())?.[1];
  const { nonce } = await (await fetch(IDENTITY + '/challenges', { method: 'POST', headers: json, body: JSON.stringify({ purpose: 'siwe' }) })).json() as { nonce: string };
  const message = 'relay.interego.xwisee.com wants you to sign in with your Ethereum account:\n'
    + wallet.address + '\n\nSign in to Interego\n\nURI: ' + RELAY + '\nVersion: 1\nChain ID: 1\nNonce: ' + nonce
    + '\nIssued At: ' + new Date().toISOString();
  const vj = await (await fetch(RELAY + '/oauth/verify', {
    method: 'POST', headers: json,
    body: JSON.stringify({ pending_id: pendingId, method: 'siwe', message, signature: await wallet.signMessage(message), nonce }),
  })).json() as { redirect?: string };
  const code = /[?&]code=([^&]+)/.exec(vj.redirect ?? '')?.[1] ?? '';
  const tj = await (await fetch(RELAY + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: RELAY + '/' }),
  })).json() as Record<string, unknown>;
  return { ...tj, client_id: reg.client_id } as Grant;
}

void run().catch((e: unknown) => { log('THREW:', (e as Error)?.stack ?? String(e)); process.exit(1); });
