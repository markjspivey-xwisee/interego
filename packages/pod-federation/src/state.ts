import type { EncryptedEnvelope } from '@interego/core';
import type { FederationPeer, FederationPending, FederationSavedState } from './types.js';
import { bytes, checkIdentity, ERROR, MAX_PEERS, MAX_SHARES, object, profile, text, UUID } from './protocol.js';

export function iso(value: unknown): string {
  const result = text(value, 40); const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) throw new Error(ERROR);
  return result;
}
export function uuid(value: unknown): string { const result = text(value, 36); if (!UUID.test(result)) throw new Error(ERROR); return result; }
export function array(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new Error(ERROR); return value; }
function unique<T>(values: T[], key: (value: T) => string): T[] { if (new Set(values.map(key)).size !== values.length) throw new Error(ERROR); return values; }
export function envelope(value: unknown): EncryptedEnvelope {
  const raw = object(value, ['version', 'algorithm', 'content', 'wrappedKeys']);
  const content = object(raw['content'], ['algorithm', 'ciphertext', 'nonce', 'encryptedAt']);
  const ciphertext = text(content['ciphertext'], 180_000);
  if (raw['version'] !== 1 || raw['algorithm'] !== 'X25519-XSalsa20-Poly1305' || content['algorithm'] !== 'XSalsa20-Poly1305'
    || Buffer.from(ciphertext, 'base64').toString('base64') !== ciphertext || Buffer.from(ciphertext, 'base64').length < 16) throw new Error(ERROR);
  const wrappedKeys = array(raw['wrappedKeys'], 2).map(value => {
    const wrapped = object(value, ['recipientPublicKey', 'wrappedKey', 'nonce', 'senderPublicKey']);
    return { recipientPublicKey: bytes(wrapped['recipientPublicKey'], 32), wrappedKey: bytes(wrapped['wrappedKey'], 48), nonce: bytes(wrapped['nonce'], 24), senderPublicKey: bytes(wrapped['senderPublicKey'], 32) };
  });
  if (!wrappedKeys.length) throw new Error(ERROR);
  unique(wrappedKeys, value => value.recipientPublicKey);
  return { version: 1, algorithm: 'X25519-XSalsa20-Poly1305', content: { algorithm: 'XSalsa20-Poly1305', ciphertext, nonce: bytes(content['nonce'], 24), encryptedAt: iso(content['encryptedAt']) }, wrappedKeys };
}
export function pending(value: unknown, allowLoopback: boolean): FederationPending {
  const raw = object(value, ['id', 'peer', 'verificationCode', 'expiresAt']);
  const verificationCode = text(raw['verificationCode'], 9);
  if (!/^\d{4} \d{4}$/.test(verificationCode)) throw new Error(ERROR);
  return { id: uuid(raw['id']), peer: profile(raw['peer'], allowLoopback), verificationCode, expiresAt: iso(raw['expiresAt']) };
}
export function peer(value: unknown, allowLoopback: boolean): FederationPeer {
  const raw = object(value);
  const { connectedAt, revokedAt, ...rest } = raw;
  return { ...profile(rest, allowLoopback), connectedAt: iso(connectedAt), ...(revokedAt === undefined ? {} : { revokedAt: iso(revokedAt) }) };
}
export function validateFederationState(value: unknown, allowLoopback = false): FederationSavedState {
  const raw = object(value, ['version', 'binding', 'identity', 'profile', 'invites', 'pending', 'joining', 'peers', 'received', 'sent', 'replay']);
  if (raw['version'] !== 1) throw new Error(ERROR);
  const identity = checkIdentity(raw['identity']); const own = profile(raw['profile'], allowLoopback);
  if (own.signingKey !== identity.signingPublicKey || own.encryptionKey !== identity.encryption.publicKey) throw new Error(ERROR);
  const invites = unique(array(raw['invites'], 8).map(value => {
    const invite = object(value, ['id', 'secretHash', 'expiresAt']); const secretHash = text(invite['secretHash'], 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secretHash)) throw new Error(ERROR);
    return { id: uuid(invite['id']), secretHash, expiresAt: iso(invite['expiresAt']) };
  }), value => value.id);
  const pendingRows = unique(array(raw['pending'], 8).map(value => pending(value, allowLoopback)), value => value.id);
  const joining = unique(array(raw['joining'], 8).map(value => pending(value, allowLoopback)), value => value.id);
  const peers = unique(array(raw['peers'], MAX_PEERS).map(value => peer(value, allowLoopback)), value => value.id);
  const received = unique(array(raw['received'], MAX_SHARES).map(value => {
    const row = object(value, ['id', 'from', 'resourceIri', 'receivedAt', 'envelope']);
    const from = text(row['from'], 256); if (!peers.some(peer => peer.id === from)) throw new Error(ERROR);
    return { id: uuid(row['id']), from, resourceIri: text(row['resourceIri']), receivedAt: iso(row['receivedAt']), envelope: envelope(row['envelope']) };
  }), value => value.id);
  const sent = unique(array(raw['sent'], MAX_SHARES).map(value => {
    const row = object(value, ['id', 'to', 'resourceIri', 'createdAt']); const to = text(row['to'], 256);
    if (!peers.some(peer => peer.id === to)) throw new Error(ERROR);
    return { id: uuid(row['id']), to, resourceIri: text(row['resourceIri']), createdAt: iso(row['createdAt']) };
  }), value => value.id);
  const replay = unique(array(raw['replay'], 2048).map(value => {
    const row = object(value, ['key', 'expiresAt']); const key = text(row['key'], 400);
    if (typeof row['expiresAt'] !== 'number' || !Number.isSafeInteger(row['expiresAt'])) throw new Error(ERROR);
    return { key, expiresAt: row['expiresAt'] };
  }), value => value.key);
  return { version: 1, binding: text(raw['binding'], 2048), identity, profile: own, invites, pending: pendingRows, joining, peers, received, sent, replay };
}
