import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { generateKeyPair } from '@interego/core';
import type { FederationConfiguration, FederationIdentity, FederationPacket, FederationProfile, FederationResource } from './types.js';

export const MAX_BODY = 512 * 1024;
export const MAX_RESOURCE = 128 * 1024;
export const INVITE_AGE = 15 * 60_000;
export const PACKET_AGE = 5 * 60_000;
export const MAX_PEERS = 32;
export const MAX_SHARES = 64;
export const ERROR = 'This pod connection could not be verified. Check the invitation and try again.';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ERROR);
  if (keys && Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(ERROR);
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(ERROR);
  return value;
}
export function bytes(value: unknown, length: number): string {
  const result = text(value, length * 3);
  if (Buffer.from(result, 'base64').length !== length || Buffer.from(result, 'base64').toString('base64') !== result) throw new Error(ERROR);
  return result;
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
export function token(): string { return randomBytes(32).toString('base64url'); }
export function endpoint(value: unknown, allowLoopback = false): string {
  const input = text(value); let url: URL;
  try { url = new URL(input); } catch { throw new Error('Use a permanent HTTPS address for this pod.'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.hash || url.search || input !== url.href.replace(/\/$/, '')
    || /%(?:2f|5c|2e)/i.test(url.pathname) || url.pathname.includes('//')
    || !(allowLoopback && loopback && url.protocol === 'http:') && (url.protocol !== 'https:' || url.port
      || !url.hostname.includes('.') || url.hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(url.hostname)
      || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')
      || url.hostname === 'localhost' || url.hostname.endsWith('.trycloudflare.com'))) throw new Error('Use a permanent HTTPS address for this pod.');
  return input;
}
export function canonical(value: unknown, depth = 0): string {
  if (depth > 24) throw new Error(ERROR);
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  const record = object(value);
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key], depth + 1)).join(',') + '}';
}
// Multibase base58btc encoding of the Ed25519 multicodec public key (0xed01).
function base58(value: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = BigInt('0x' + Buffer.from(value).toString('hex')); let result = '';
  while (number > 0n) { result = alphabet[Number(number % 58n)] + result; number /= 58n; }
  for (const byte of value) { if (byte) break; result = '1' + result; }
  return result;
}
export function signingId(publicKey: string): string {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  const der = key.export({ format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519' || der.toString('base64') !== publicKey || der.length !== 44) throw new Error(ERROR);
  return 'did:key:z' + base58(new Uint8Array([0xed, 0x01, ...der.subarray(-32)]));
}
export function createIdentity(): FederationIdentity {
  const pair = generateKeyPairSync('ed25519');
  return { signingPrivateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    signingPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), encryption: generateKeyPair() };
}
export function checkIdentity(value: unknown): FederationIdentity {
  const record = object(value, ['signingPrivateKey', 'signingPublicKey', 'encryption']);
  const privateKey = text(record['signingPrivateKey'], 256); const publicKey = text(record['signingPublicKey'], 256);
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') !== publicKey) throw new Error(ERROR);
  const encryption = object(record['encryption'], ['algorithm', 'publicKey', 'secretKey']);
  if (encryption['algorithm'] !== 'X25519-XSalsa20-Poly1305') throw new Error(ERROR);
  const secret = bytes(encryption['secretKey'], 32); const publicEncryption = bytes(encryption['publicKey'], 32);
  const xkey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(secret, 'base64')]), format: 'der', type: 'pkcs8' });
  if (createPublicKey(xkey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') !== publicEncryption) throw new Error(ERROR);
  signingId(publicKey);
  return { signingPrivateKey: privateKey, signingPublicKey: publicKey, encryption: { algorithm: 'X25519-XSalsa20-Poly1305', publicKey: publicEncryption, secretKey: secret } };
}
export function profileFor(identity: FederationIdentity, configuration: FederationConfiguration, allowLoopback = false): FederationProfile {
  if (configuration.kind !== 'local' && configuration.kind !== 'hosted') throw new Error(ERROR);
  const id = signingId(identity.signingPublicKey);
  return { id, name: text(configuration.name, 80), endpoint: endpoint(configuration.endpoint, allowLoopback), kind: configuration.kind,
    signingKey: identity.signingPublicKey, encryptionKey: identity.encryption.publicKey, fingerprint: hash(id + '\n' + identity.encryption.publicKey).slice(0, 24) };
}
export function profile(value: unknown, allowLoopback = false): FederationProfile {
  const raw = object(value, ['id', 'name', 'endpoint', 'kind', 'signingKey', 'encryptionKey', 'fingerprint']);
  const signingKey = text(raw['signingKey'], 256); const encryptionKey = bytes(raw['encryptionKey'], 32);
  const id = signingId(signingKey); const fingerprint = hash(id + '\n' + encryptionKey).slice(0, 24);
  if (raw['id'] !== id || raw['fingerprint'] !== fingerprint || raw['kind'] !== 'local' && raw['kind'] !== 'hosted') throw new Error(ERROR);
  return { id, name: text(raw['name'], 80), endpoint: endpoint(raw['endpoint'], allowLoopback), kind: raw['kind'], signingKey, encryptionKey, fingerprint };
}
export function resource(value: unknown): FederationResource {
  const record = object(value, ['iri', 'mediaType', 'content']); const iri = text(record['iri']);
  if (!/^(urn:|https:\/\/)/.test(iri) || /[<>"\\\s]/.test(iri)) throw new Error(ERROR);
  const mediaType = text(record['mediaType'], 100);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[ a-zA-Z0-9="._+-]+)?$/.test(mediaType)) throw new Error(ERROR);
  if (typeof record['content'] !== 'string' || Buffer.byteLength(record['content']) > MAX_RESOURCE) throw new Error('Choose a resource of up to 128 KiB.');
  const result = { iri, mediaType, content: record['content'] };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESOURCE) throw new Error('Choose a resource of up to 128 KiB.');
  return result;
}
export function packet(identity: FederationIdentity, issuer: string, audience: string, action: string, payload: unknown, now: number, nonce = token()): FederationPacket {
  const unsigned = { version: 1 as const, issuer, audience, action, nonce, createdAt: now, payload };
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), createPrivateKey({ key: Buffer.from(identity.signingPrivateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64url') };
}
export function verifyPacket(value: unknown, signer: FederationProfile, audience: string, action: string, now: number, maximumAge = PACKET_AGE): FederationPacket {
  const raw = object(value, ['version', 'issuer', 'audience', 'action', 'nonce', 'createdAt', 'payload', 'signature']);
  if (raw['version'] !== 1 || raw['issuer'] !== signer.id || raw['audience'] !== audience || raw['action'] !== action
    || typeof raw['createdAt'] !== 'number' || !Number.isSafeInteger(raw['createdAt']) || raw['createdAt'] > now + 30_000 || raw['createdAt'] < now - maximumAge
    || !/^[A-Za-z0-9_-]{43}$/.test(text(raw['nonce'], 43)) || !/^[A-Za-z0-9_-]{86}$/.test(text(raw['signature'], 86))) throw new Error(ERROR);
  const { signature, ...unsigned } = raw;
  if (!verify(null, Buffer.from(canonical(unsigned)), createPublicKey({ key: Buffer.from(signer.signingKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(String(signature), 'base64url'))) throw new Error(ERROR);
  return raw as unknown as FederationPacket;
}
export function comparison(a: FederationProfile, b: FederationProfile, requestId: string): string {
  const names = [a.fingerprint, b.fingerprint].sort();
  const number = BigInt('0x' + createHash('sha256').update(names.join('\n') + '\n' + requestId).digest('hex')) % 100_000_000n;
  return number.toString().padStart(8, '0').replace(/(\d{4})(\d{4})/, '$1 $2');
}
