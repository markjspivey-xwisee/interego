import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { LocalIdentityContext, LocalIdentityPublic } from './local-identity-types.js';

export const IDENTITY_ERROR = 'This sign-in request could not be verified. Start a new sign-in from the app you want to use.';
export const IDENTITY_STORE_ERROR = 'This computer could not open the saved sign-in identity. Use another account credential, or reset local identity setup. Your notes are unchanged.';
export const IDENTITY_NONCE = /^[A-Za-z0-9_-]{43}$/;
export const IDENTITY_HANDOFF = /^interego-login:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const COMPLETION = /^interego-login-result:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
export interface LocalIdentitySaved {
  readonly version: 1;
  readonly binding: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly createdAt: string;
}
export function identityObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(IDENTITY_ERROR);
  const object = value as Record<string, unknown>;
  if (keys && Object.keys(object).sort().join(',') !== [...keys].sort().join(',')) throw new Error(IDENTITY_ERROR);
  return object;
}
export function identityText(value: unknown, maximum = 2048): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(IDENTITY_ERROR);
  return value;
}
export function identityHash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
export function identitySame(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function identityOrigin(value: unknown, allowLoopback = false): string {
  const input = identityText(value); let url: URL;
  try { url = new URL(input); } catch { throw new Error(IDENTITY_ERROR); }
  const loopback = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (input !== url.origin || url.username || url.password || !loopback && (url.protocol !== 'https:' || url.port || isIP(url.hostname)
    || url.hostname.startsWith('[') || !url.hostname.includes('.') || /(?:^|\.)(localhost|local|internal|home|lan|onion)$/.test(url.hostname)
    || url.hostname.endsWith('.home.arpa'))) throw new Error(IDENTITY_ERROR);
  return url.origin;
}
function base58(value: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt('0x' + Buffer.from(value).toString('hex')); let result = '';
  while (number > 0n) { result = alphabet[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of value) { if (byte) break; result = '1' + result; }
  return result;
}
export function localIdentityPublic(saved: LocalIdentitySaved): LocalIdentityPublic {
  const raw = Buffer.from(saved.publicKey, 'base64').subarray(-32);
  const did = 'did:key:z' + base58(new Uint8Array([0xed, 0x01, ...raw]));
  return { did, fingerprint: identityHash(did), createdAt: saved.createdAt };
}
export function newLocalIdentity(binding: string, now: number): LocalIdentitySaved {
  const pair = generateKeyPairSync('ed25519');
  return { version: 1, binding, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), createdAt: new Date(now).toISOString() };
}
export function savedLocalIdentity(value: unknown): LocalIdentitySaved {
  try {
    const raw = identityObject(value, ['version', 'binding', 'publicKey', 'privateKey', 'createdAt']);
    const binding = identityText(raw['binding'], 256); const publicKey = identityText(raw['publicKey'], 256); const privateKey = identityText(raw['privateKey'], 256);
    const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    const publicObject = createPublicKey(key); const publicDer = publicObject.export({ format: 'der', type: 'spki' });
    if (raw['version'] !== 1 || key.asymmetricKeyType !== 'ed25519' || publicDer.length !== 44 || publicDer.toString('base64') !== publicKey
      || key.export({ format: 'der', type: 'pkcs8' }).toString('base64') !== privateKey) throw new Error(IDENTITY_STORE_ERROR);
    const createdAt = identityText(raw['createdAt'], 64); if (!Number.isFinite(Date.parse(createdAt))) throw new Error(IDENTITY_STORE_ERROR);
    return { version: 1, binding, publicKey, privateKey, createdAt };
  } catch { throw new Error(IDENTITY_STORE_ERROR); }
}
function callback(value: unknown, allowLoopback: boolean): URL {
  const raw = identityText(value); let url: URL;
  try { url = new URL(raw); } catch { throw new Error(IDENTITY_ERROR); }
  const loopback = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.href !== raw || url.username || url.password || url.hash || !loopback && url.protocol !== 'https:'
    || ['code', 'state', 'iss', 'error', 'access_token', 'refresh_token', 'id_token'].some(name => url.searchParams.has(name))) throw new Error(IDENTITY_ERROR);
  return url;
}
export function localIdentityContext(value: unknown, relay: string, provider: string, now: number, allowLoopback = false): LocalIdentityContext {
  const raw = identityObject(value, ['version', 'issuer', 'identityOrigin', 'pendingId', 'clientId', 'clientName', 'redirectUri', 'scopes', 'resource',
    'codeChallenge', 'stateDigest', 'expiresAt', 'nonce', 'message', 'challengeExpiresAt', 'completionCode']);
  if (raw['version'] !== 1 || raw['issuer'] !== relay || raw['identityOrigin'] !== provider) throw new Error(IDENTITY_ERROR);
  const pendingId = identityText(raw['pendingId'], 128); if (!/^[A-Za-z0-9_-]{16,128}$/.test(pendingId)) throw new Error(IDENTITY_ERROR);
  const clientId = identityText(raw['clientId']); const clientName = identityText(raw['clientName'], 160);
  const redirectUri = callback(raw['redirectUri'], allowLoopback).href;
  const scopes = raw['scopes'];
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > 32 || scopes.some(scope => typeof scope !== 'string' || !/^[A-Za-z0-9:._/-]{1,80}$/.test(scope))
    || new Set(scopes).size !== scopes.length) throw new Error(IDENTITY_ERROR);
  let resource: string | null = null;
  if (raw['resource'] !== null) {
    resource = identityText(raw['resource']); const url = new URL(resource);
    if (url.href !== resource || url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
      || url.username || url.password || url.hash) throw new Error(IDENTITY_ERROR);
  }
  const codeChallenge = identityText(raw['codeChallenge'], 43); const stateDigest = identityText(raw['stateDigest'], 43); const nonce = identityText(raw['nonce'], 43);
  if (![codeChallenge, stateDigest, nonce].every(text => IDENTITY_NONCE.test(text))) throw new Error(IDENTITY_ERROR);
  const message = `Interego DID sign-in v1\nHost: ${new URL(provider).host}\nNonce: ${nonce}`;
  if (raw['message'] !== message) throw new Error(IDENTITY_ERROR);
  const expiresAt = identityText(raw['expiresAt'], 64); const challengeExpiresAt = identityText(raw['challengeExpiresAt'], 64);
  const expiry = Date.parse(expiresAt); const challengeExpiry = Date.parse(challengeExpiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= now || expiry > now + 15 * 60_000
    || !Number.isFinite(challengeExpiry) || new Date(challengeExpiry).toISOString() !== challengeExpiresAt || challengeExpiry <= now || challengeExpiry > now + 330_000) throw new Error(IDENTITY_ERROR);
  const completionCode = identityText(raw['completionCode'], 256); if (!COMPLETION.test(completionCode)) throw new Error(IDENTITY_ERROR);
  return { version: 1, issuer: relay, identityOrigin: provider, pendingId, clientId, clientName, redirectUri, scopes: [...scopes] as string[], resource,
    codeChallenge, stateDigest, expiresAt, nonce, message, challengeExpiresAt, completionCode };
}
/** Raw proof is used only inside native completion and never returned through a public API. */
export function signLocalIdentity(saved: LocalIdentitySaved, message: string): string {
  const bytes = Buffer.from(saved.privateKey, 'base64');
  try { return sign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' })).toString('base64url'); }
  finally { bytes.fill(0); }
}
export function localIdentityRedirect(value: unknown, context: LocalIdentityContext, allowLoopback = false): string {
  const raw = identityObject(value, ['redirect']); const text = identityText(raw['redirect'], 8192); let url: URL;
  try { url = new URL(text); } catch { throw new Error(IDENTITY_ERROR); }
  const original = callback(context.redirectUri, allowLoopback);
  if (url.origin !== original.origin || url.pathname !== original.pathname || url.username || url.password || url.hash
    || url.searchParams.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{16,4096}$/.test(url.searchParams.get('code') ?? '')
    || url.searchParams.getAll('state').length !== 1 || identityHash(url.searchParams.get('state')!) !== context.stateDigest
    || url.searchParams.has('iss') && (url.searchParams.getAll('iss').length !== 1 || url.searchParams.get('iss') !== context.issuer)) throw new Error(IDENTITY_ERROR);
  for (const [name, item] of original.searchParams) if (url.searchParams.getAll(name).join('\n') !== original.searchParams.getAll(name).join('\n') || !url.searchParams.getAll(name).includes(item)) throw new Error(IDENTITY_ERROR);
  for (const name of url.searchParams.keys()) if (!['code', 'state', 'iss'].includes(name) && !original.searchParams.has(name)) throw new Error(IDENTITY_ERROR);
  return url.href;
}
