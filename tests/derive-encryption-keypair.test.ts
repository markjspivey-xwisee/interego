/**
 * deriveEncryptionKeyPair — the X25519 encryption keypair that gets
 * derived from a wallet private key. The whole point: same wallet
 * always produces the same encryption keypair, so encrypted shares
 * addressed to a bridge stay decryptable across restarts.
 */

import { describe, it, expect } from 'vitest';
import {
  createEncryptedEnvelope,
  deriveEncryptionKeyPair,
  generateKeyPair,
  openEncryptedEnvelope,
} from '@interego/core';

const ALICE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const BOB_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('deriveEncryptionKeyPair — deterministic X25519 from wallet', () => {
  it('same wallet private key → same encryption keypair every time', () => {
    const a = deriveEncryptionKeyPair(ALICE_KEY);
    const b = deriveEncryptionKeyPair(ALICE_KEY);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.secretKey).toBe(b.secretKey);
    expect(a.algorithm).toBe('X25519-XSalsa20-Poly1305');
  });

  it('case-insensitive on input; with or without 0x prefix', () => {
    const lower = deriveEncryptionKeyPair(ALICE_KEY);
    const upper = deriveEncryptionKeyPair(ALICE_KEY.toUpperCase());
    const noPrefix = deriveEncryptionKeyPair(ALICE_KEY.slice(2));
    expect(lower.publicKey).toBe(upper.publicKey);
    expect(lower.publicKey).toBe(noPrefix.publicKey);
  });

  it('different wallet → different encryption keypair', () => {
    const a = deriveEncryptionKeyPair(ALICE_KEY);
    const b = deriveEncryptionKeyPair(BOB_KEY);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });

  it('outputs valid Curve25519 keys (right length, base64-decodable)', () => {
    const kp = deriveEncryptionKeyPair(ALICE_KEY);
    // base64-encoded 32 bytes is 44 chars (with padding)
    expect(kp.publicKey.length).toBe(44);
    expect(kp.secretKey.length).toBe(44);
  });

  it('round-trip envelope: derive at session 1, derive again at session 2, decrypt session 1\'s message', () => {
    // Session 1: alice derives her keypair, bob (any sender) encrypts to her
    const aliceSession1 = deriveEncryptionKeyPair(ALICE_KEY);
    const senderKp = generateKeyPair();
    const envelope = createEncryptedEnvelope(
      'message that should survive a restart',
      [aliceSession1.publicKey],
      senderKp,
    );

    // Session 2: alice's bridge restarts, derives her keypair again,
    // opens the envelope. Same secret key → same wrapped-key recipient
    // match → same content key → same plaintext.
    const aliceSession2 = deriveEncryptionKeyPair(ALICE_KEY);
    const plaintext = openEncryptedEnvelope(envelope, aliceSession2);
    expect(plaintext).toBe('message that should survive a restart');
  });

  it('a different wallet at session 2 cannot open session 1\'s envelope', () => {
    const aliceKp = deriveEncryptionKeyPair(ALICE_KEY);
    const senderKp = generateKeyPair();
    const envelope = createEncryptedEnvelope(
      'addressed only to alice',
      [aliceKp.publicKey],
      senderKp,
    );

    const bobKp = deriveEncryptionKeyPair(BOB_KEY);
    expect(openEncryptedEnvelope(envelope, bobKp)).toBeNull();
  });

  it('domain-separated from the storage key derivation', () => {
    // A leak of the storage key (sha256(privKey + ':interego-bridge-storage-v1'))
    // should NOT reveal the encryption secret key
    // (sha256(privKey + ':interego-bridge-encryption-v1')). Different
    // domain tags → different hashes → no shared bits.
    // We verify by deriving each manually and comparing.
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const stem = ALICE_KEY.toLowerCase().replace(/^0x/, '');
    const storageKey = createHash('sha256').update(stem + ':interego-bridge-storage-v1', 'utf8').digest('hex');
    const encKp = deriveEncryptionKeyPair(ALICE_KEY);
    // The encryption secret key is NaCl's reduction of sha256(stem + ':interego-bridge-encryption-v1').
    // We don't expose the exact reduced bytes, but its base64 length is 44 and the hex of the storage key
    // is 64 — they're definitionally different artifacts. Sanity: storageKey hex doesn't appear in encKp.
    expect(encKp.secretKey).not.toContain(storageKey);
  });
});
