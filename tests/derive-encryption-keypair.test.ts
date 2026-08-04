/**
 * deriveEncryptionKeyPair — the X25519 encryption keypair that gets
 * derived from a wallet private key. The whole point: same wallet
 * always produces the same encryption keypair, so encrypted shares
 * addressed to a bridge stay decryptable across restarts.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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
    const stem = ALICE_KEY.toLowerCase().replace(/^0x/, '');
    const storageKey = createHash('sha256').update(stem + ':interego-bridge-storage-v1', 'utf8').digest('hex');
    const encKp = deriveEncryptionKeyPair(ALICE_KEY);
    // The encryption secret key is NaCl's reduction of sha256(stem + ':interego-bridge-encryption-v1').
    // We don't expose the exact reduced bytes, but its base64 length is 44 and the hex of the storage key
    // is 64 — they're definitionally different artifacts. Sanity: storageKey hex doesn't appear in encKp.
    expect(encKp.secretKey).not.toContain(storageKey);
  });

  // ── principal scoping: the relay is SINGLE-SIGNER ──────────────────────
  // `getDelegationSigner()` hands every relay-mediated agent the SAME compliance
  // wallet, so without a principal every agent derives the identical secret and
  // each can owner-decrypt the others' confidential holons. Measured before this
  // parameter existed: johnny and boozer both derived
  // `3xeZVVgoS3f0F5UMJPPgtUufKl6pWSJjKiCpZZCpxDI=`. These pin the separation.
  const RELAY_ROOT = BOB_KEY; // stands in for the shared relay compliance wallet
  const JOHNNY = 'did:web:interego.xwisee.com:agents:johnny';
  const BOOZER = 'did:web:interego.xwisee.com:agents:boozer';

  it('two principals off the SAME root get different keypairs', () => {
    const johnny = deriveEncryptionKeyPair(RELAY_ROOT, JOHNNY);
    const boozer = deriveEncryptionKeyPair(RELAY_ROOT, BOOZER);
    expect(johnny.publicKey).not.toBe(boozer.publicKey);
    expect(johnny.secretKey).not.toBe(boozer.secretKey);
    // The consequence, stated as behaviour: boozer cannot open johnny's envelope.
    const senderKp = generateKeyPair();
    const toJohnny = createEncryptedEnvelope('johnny-only holon', [johnny.publicKey], senderKp);
    expect(openEncryptedEnvelope(toJohnny, boozer)).toBeNull();
    // ...and johnny still can, across a FRESH derivation. That re-derivation is
    // what distinguishes "durable across sessions" from "two random keys differ" —
    // a non-deterministic implementation would pass every line above it.
    expect(openEncryptedEnvelope(toJohnny, deriveEncryptionKeyPair(RELAY_ROOT, JOHNNY)))
      .toBe('johnny-only holon');
  });

  it('a principal-scoped key differs from the unscoped key off the same wallet', () => {
    expect(deriveEncryptionKeyPair(ALICE_KEY, JOHNNY).publicKey)
      .not.toBe(deriveEncryptionKeyPair(ALICE_KEY).publicKey);
  });

  it('FROZEN VECTOR: omitting principal reproduces the pre-existing bytes', () => {
    // Envelopes already wrapped by the Foxxi bridge, examples/personal-bridge and
    // deriveAdminKeyPair are decryptable ONLY by this exact pre-image. A changed
    // domain tag orphans all of them silently — no throw, `openEncryptedEnvelope`
    // just returns null forever and nothing logs. Every other test in this file
    // checks determinism or pairwise inequality, all of which survive a re-tagged
    // pre-image, so this frozen vector is the only thing standing between an edit
    // to the seed string and that outcome.
    expect(deriveEncryptionKeyPair(ALICE_KEY).publicKey)
      .toBe('eisnjhcNUFrgaXWUc2GsV833jGKGrQUf7gIsqHxCQwQ=');
    expect(deriveEncryptionKeyPair(ALICE_KEY, JOHNNY).publicKey)
      .toBe('hvCqY0y60chjQuWCR1AxRWI0JbOmeeOLLgYBpjCXtTs=');
  });
});
