/**
 * THE HALF OF END-TO-END ENCRYPTION THAT LIVES ON THE CLIENT.
 *
 * These use the REAL primitives against REAL envelopes — two derived identities, a genuine seal,
 * a genuine open. Nothing is stubbed, because what is being checked is whether the cryptography
 * actually excludes the people it should and admits the people it should, and a stub would only
 * confirm the shape of the code around it.
 *
 * ── ★ WHY DERIVED RATHER THAN GENERATED ─────────────────────────────────────
 *
 * A generated key would be a SECOND secret. Lose it and every message ever encrypted to it is
 * unreadable forever, with the pod intact and useless — a failure mode with no recovery and no
 * warning. Derived from the account's own private key, it is recoverable from the same seed
 * phrase, identical on every machine that signs in, and scoped so a delegate does not silently
 * share its principal's reach.
 */

import { describe, it, expect } from 'vitest';
import { createEncryptedEnvelope, type EncryptedEnvelope } from '@interego/core';
import { encryptionKeyFor, openGraph } from '../packages/workspace-client/src/opener.js';

// Two ordinary secp256k1 private keys. Fixed, so these tests are deterministic.
const ALICE = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const BOB = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';

/**
 * Seal some text to a set of public keys, exactly as the relay does when publishing.
 *
 * The sender key is the author's own — an envelope records who sealed it as well as who may open
 * it, and passing a throwaway here would test a shape the substrate never produces.
 */
function seal(plaintext: string, recipients: readonly string[], sender = encryptionKeyFor(ALICE)): EncryptedEnvelope {
  return createEncryptedEnvelope(plaintext, recipients, sender);
}

describe('a key derived from the account', () => {
  it('★ is deterministic — the same account derives the same key on every machine', () => {
    // This is what lets a second device join a private workspace by signing in, rather than by a
    // key-transfer ceremony nobody would perform.
    expect(encryptionKeyFor(ALICE).publicKey).toBe(encryptionKeyFor(ALICE).publicKey);
  });

  it('★ different accounts derive different keys', () => {
    expect(encryptionKeyFor(ALICE).publicKey).not.toBe(encryptionKeyFor(BOB).publicKey);
  });

  it('★★ and a DELEGATE derives a different key from the same wallet than its principal', () => {
    // Otherwise an agent's reach silently becomes its human's: anything sealed to the person would
    // open for every delegate they ever authorised.
    const principal = encryptionKeyFor(ALICE);
    const delegate = encryptionKeyFor(ALICE, 'did:ethr:0xdelegate');
    expect(delegate.publicKey).not.toBe(principal.publicKey);
  });
});

describe('★★ opening what the relay hands back', () => {
  it('opens an envelope this identity is a recipient of', () => {
    const alice = encryptionKeyFor(ALICE);
    const env = seal('the roof decision is deferred to spring', [alice.publicKey]);
    const out = openGraph({ encrypted: true, envelope: JSON.stringify(env) }, alice);
    expect(out.kind).toBe('opened');
    if (out.kind === 'opened') expect(out.content).toContain('deferred to spring');
  });

  it('★★ and REFUSES one it is not — which is the whole access control', () => {
    /**
     * The relay serves this envelope to anybody who asks, deliberately: ciphertext is not a
     * disclosure. What stops a non-recipient reading it is that it does not open, here, with a key
     * they do not have. If this ever passes, the substrate's privacy story is gone.
     */
    const alice = encryptionKeyFor(ALICE);
    const bob = encryptionKeyFor(BOB);
    const env = seal('the roof decision is deferred to spring', [alice.publicKey]);
    const out = openGraph({ encrypted: true, envelope: JSON.stringify(env) }, bob);
    expect(out.kind).toBe('not-for-you');
    if (out.kind === 'not-for-you') expect(out.why).toContain('not yours to read');
    // ★ And the plaintext is nowhere in what it reports back.
    expect(JSON.stringify(out)).not.toContain('deferred to spring');
  });

  it('opens for BOTH members when sealed to both — a shared workspace, not a diary', () => {
    const alice = encryptionKeyFor(ALICE);
    const bob = encryptionKeyFor(BOB);
    const env = seal('we re-tile in spring', [alice.publicKey, bob.publicKey]);
    for (const who of [alice, bob]) {
      const out = openGraph({ encrypted: true, envelope: JSON.stringify(env) }, who);
      expect(out.kind).toBe('opened');
    }
  });

  it('★ "not for you" is distinct from "damaged" — a permission is not a fault', () => {
    // The same distinction the workspace client had to learn when it was calling withheld records
    // malformed. A reader that collapsed these would tell somebody their workspace was corrupt
    // because they had not been invited to it.
    const alice = encryptionKeyFor(ALICE);
    const broken = openGraph({ encrypted: true, envelope: 'not json at all' }, alice);
    expect(broken.kind).toBe('unreadable');
    if (broken.kind === 'unreadable') expect(broken.why).toContain('did not parse');
  });

  it('passes through plaintext the relay already had no reason to seal', () => {
    const out = openGraph({ encrypted: false, content: '<urn:x> a <urn:y> .' }, encryptionKeyFor(ALICE));
    expect(out.kind).toBe('plaintext');
  });

  it('★ and reports a relay error as an error rather than as a permission', () => {
    const out = openGraph({ error: 'envelope_fetch_failed', message: '502 Bad Gateway' }, encryptionKeyFor(ALICE));
    expect(out.kind).toBe('unreadable');
    if (out.kind === 'unreadable') expect(out.why).toContain('502');
  });
});
