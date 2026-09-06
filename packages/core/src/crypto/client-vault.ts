/**
 * Client-owned keys for browser hosts. No transport, DOM, relay credential or
 * application vocabulary belongs here. The host supplies durable local storage.
 *
 * The NaCl secret is encrypted at rest by a non-extractable WebCrypto AES key.
 * Both live in the client's storage; the NaCl secret is available to this client
 * while opening/sealing. This is not hardware isolation or protection from
 * malicious code running in the same origin. No method exports an unencrypted key.
 */
import type { webcrypto } from 'node:crypto';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import {
  createEncryptedEnvelope, generateKeyPair, openEncryptedEnvelope,
  type EncryptedEnvelope, type EncryptionKeyPair,
} from './encryption.js';

export interface ClientKeyRecord {
  readonly version: 1;
  readonly publicKey: string;
  readonly wrappingKey: webcrypto.CryptoKey;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

export interface ClientKeyStorage {
  load(scope: string): Promise<ClientKeyRecord | null>;
  /** Atomically insert only if absent; return the stored winner of a race. */
  create(scope: string, record: ClientKeyRecord): Promise<ClientKeyRecord>;
}

export interface ClientKeyRecovery {
  readonly format: 'interego-client-key';
  readonly version: 1;
  readonly scope: string;
  readonly publicKey: string;
  readonly kdf: 'PBKDF2-SHA256';
  readonly iterations: 600000;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

type CryptoHost = Pick<webcrypto.Crypto, 'subtle' | 'getRandomValues'>;
const bytes = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(util.decodeUTF8(value));
const unbase64 = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(util.decodeBase64(value));
const b64 = (value: ArrayBuffer | Uint8Array): string => util.encodeBase64(new Uint8Array(value));
const aad = (scope: string, publicKey: string) => bytes(`interego-client-key:v1:${scope}:${publicKey}`);

export function validEncryptionPublicKey(value: string): boolean {
  try { const decoded = unbase64(value); return decoded.length === 32 && b64(decoded) === value; }
  catch { return false; }
}

export class ClientKeyVault {
  constructor(
    private readonly scope: string,
    private readonly storage: ClientKeyStorage,
    private readonly crypto: CryptoHost = globalThis.crypto,
  ) {
    if (!scope) throw new Error('An authenticated client identity is required.');
    if (!crypto?.subtle) throw new Error('Browser encryption requires a secure HTTPS page. No key was created and nothing was sent.');
  }

  /** Does not silently generate a replacement for a missing key. */
  async publicKey(): Promise<string | null> {
    return (await this.storage.load(this.scope))?.publicKey ?? null;
  }

  async create(): Promise<string> {
    const existing = await this.storage.load(this.scope);
    if (existing) return existing.publicKey;
    const key = generateKeyPair();
    return (await this.storage.create(this.scope, await this.protect(key))).publicKey;
  }

  private async protect(key: EncryptionKeyPair): Promise<ClientKeyRecord> {
    const wrappingKey = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const secret = unbase64(key.secretKey);
    try {
      const ciphertext = await this.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(this.scope, key.publicKey) }, wrappingKey, secret,
      );
      return { version: 1, publicKey: key.publicKey, wrappingKey, iv, ciphertext };
    } finally { secret.fill(0); }
  }

  private async withKey<T>(run: (key: EncryptionKeyPair) => T | Promise<T>): Promise<T> {
    const record = await this.storage.load(this.scope);
    if (!record) throw new Error('This browser has no key for this identity. Create one or restore an encrypted recovery file.');
    if (record.version !== 1 || record.wrappingKey.extractable) throw new Error('Unsupported or unsafe local key record.');
    const secret = new Uint8Array(await this.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: aad(this.scope, record.publicKey) },
      record.wrappingKey, record.ciphertext,
    ));
    try {
      const derived = nacl.box.keyPair.fromSecretKey(secret);
      if (b64(derived.publicKey) !== record.publicKey) throw new Error('Local key does not match its public key.');
      return await run({ publicKey: record.publicKey, secretKey: b64(secret), algorithm: 'X25519-XSalsa20-Poly1305' });
    } finally { secret.fill(0); }
  }

  async seal(content: string, recipients: readonly string[] = []): Promise<EncryptedEnvelope> {
    if (recipients.some(key => !validEncryptionPublicKey(key))) throw new Error('A recipient key must be a canonical base64 X25519 public key.');
    return this.withKey(key => createEncryptedEnvelope(content, [...new Set([key.publicKey, ...recipients])], key));
  }

  async open(envelope: EncryptedEnvelope): Promise<string> {
    if (envelope.version !== 1 || envelope.algorithm !== 'X25519-XSalsa20-Poly1305' || !Array.isArray(envelope.wrappedKeys)) {
      throw new Error('Unsupported encrypted envelope.');
    }
    return this.withKey(key => {
      if (!envelope.wrappedKeys.some(w => w.recipientPublicKey === key.publicKey)) throw new Error('This browser key is not a recipient. No server decryption fallback was used.');
      const content = openEncryptedEnvelope(envelope, key);
      if (content === null) throw new Error('Encrypted content failed authentication.');
      return content;
    });
  }

  private async recoveryKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<webcrypto.CryptoKey> {
    if (passphrase.length < 12) throw new Error('Use a recovery passphrase of at least 12 characters.');
    const material = await this.crypto.subtle.importKey('raw', bytes(passphrase), 'PBKDF2', false, ['deriveKey']);
    return this.crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  async backup(passphrase: string): Promise<ClientKeyRecovery> {
    return this.withKey(async key => {
      const salt = this.crypto.getRandomValues(new Uint8Array(16));
      const iv = this.crypto.getRandomValues(new Uint8Array(12));
      const recoveryKey = await this.recoveryKey(passphrase, salt);
      const secret = unbase64(key.secretKey);
      try {
        const ciphertext = await this.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad(this.scope, key.publicKey) }, recoveryKey, secret,
        );
        return {
          format: 'interego-client-key', version: 1, scope: this.scope, publicKey: key.publicKey,
          kdf: 'PBKDF2-SHA256', iterations: 600000, salt: b64(salt), iv: b64(iv), ciphertext: b64(ciphertext),
        };
      } finally { secret.fill(0); }
    });
  }

  async restore(recovery: ClientKeyRecovery, passphrase: string): Promise<string> {
    if (recovery.format !== 'interego-client-key' || recovery.version !== 1 || recovery.scope !== this.scope
      || recovery.kdf !== 'PBKDF2-SHA256' || recovery.iterations !== 600000 || !validEncryptionPublicKey(recovery.publicKey)) {
      throw new Error('This is not a supported recovery file for the current identity.');
    }
    const salt = unbase64(recovery.salt), iv = unbase64(recovery.iv), ciphertext = unbase64(recovery.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length !== 48) throw new Error('Malformed recovery file.');
    const existing = await this.publicKey();
    if (existing && existing !== recovery.publicKey) throw new Error('This browser already holds a different key. Restore in another browser profile to preserve both keys.');
    const recoveryKey = await this.recoveryKey(passphrase, salt);
    const secret = new Uint8Array(await this.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(this.scope, recovery.publicKey) }, recoveryKey, ciphertext,
    ));
    try {
      const derived = nacl.box.keyPair.fromSecretKey(secret);
      if (b64(derived.publicKey) !== recovery.publicKey) throw new Error('Recovery key does not match its public key.');
      const stored = await this.storage.create(this.scope, await this.protect({
        publicKey: recovery.publicKey, secretKey: b64(secret), algorithm: 'X25519-XSalsa20-Poly1305',
      }));
      if (stored.publicKey !== recovery.publicKey) throw new Error('Another tab created a different key. The existing key was preserved.');
      return stored.publicKey;
    } finally { secret.fill(0); }
  }
}
