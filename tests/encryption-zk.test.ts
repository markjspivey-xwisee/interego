import { describe, it, expect } from 'vitest';
import {
  // E2E Encryption
  generateKeyPair,
  generateContentKey,
  encryptContent,
  decryptContent,
  wrapKeyForRecipient,
  unwrapKey,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  reEncryptForRecipients,
  envelopeToJson,
  envelopeFromJson,
  // ZK Proofs
  commit,
  verifyCommitment,
  proveConfidenceAboveThreshold,
  verifyConfidenceProof,
  verifyConfidenceProofByReveal,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  proveDelegationMembership,
  verifyDelegationMembership,
  proveTemporalOrdering,
  verifyTemporalProof,
  proveFragmentMembership,
  verifyFragmentMembership,
  createSelectiveDisclosure,
} from '../src/index.js';
import { sha256 } from '../src/crypto/ipfs.js';

// ═════════════════════════════════════════════════════════════
//  E2E Encryption (NaCl / tweetnacl)
// ═════════════════════════════════════════════════════════════

describe('E2E Encryption', () => {
  it('generates real X25519 key pairs', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey.length).toBeGreaterThan(0);
    expect(kp.secretKey.length).toBeGreaterThan(0);
    expect(kp.algorithm).toBe('X25519-XSalsa20-Poly1305');
    // Keys should be different
    expect(kp.publicKey).not.toBe(kp.secretKey);
  });

  it('different key pairs are different (real randomness)', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secretKey).not.toBe(b.secretKey);
  });

  it('encrypts and decrypts content with symmetric key', () => {
    const key = generateContentKey();
    const plaintext = '@prefix cg: <urn:cg:> . cg:secret cg:value "classified" .';

    const encrypted = encryptContent(plaintext, key);
    expect(encrypted.ciphertext).not.toBe(plaintext);
    expect(encrypted.algorithm).toBe('XSalsa20-Poly1305');

    const decrypted = decryptContent(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('wrong key fails to decrypt', () => {
    const key1 = generateContentKey();
    const key2 = generateContentKey();
    const plaintext = 'secret content';

    const encrypted = encryptContent(plaintext, key1);
    const decrypted = decryptContent(encrypted, key2);
    expect(decrypted).toBeNull();
  });

  it('wraps and unwraps key for recipient', () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const contentKey = generateContentKey();

    const wrapped = wrapKeyForRecipient(contentKey, recipient.publicKey, sender);
    expect(wrapped.recipientPublicKey).toBe(recipient.publicKey);
    expect(wrapped.senderPublicKey).toBe(sender.publicKey);

    const unwrapped = unwrapKey(wrapped, recipient.secretKey);
    expect(unwrapped).not.toBeNull();
    expect(unwrapped!.key).toBe(contentKey.key);
  });

  it('wrong recipient cannot unwrap key', () => {
    const sender = generateKeyPair();
    const recipient = generateKeyPair();
    const intruder = generateKeyPair();
    const contentKey = generateContentKey();

    const wrapped = wrapKeyForRecipient(contentKey, recipient.publicKey, sender);
    const unwrapped = unwrapKey(wrapped, intruder.secretKey);
    expect(unwrapped).toBeNull();
  });

  it('creates and opens encrypted envelope for multiple recipients', () => {
    const owner = generateKeyPair();
    const agent1 = generateKeyPair();
    const agent2 = generateKeyPair();
    const turtle = '@prefix cg: <urn:cg:> . cg:data cg:value "encrypted for two agents" .';

    const envelope = createEncryptedEnvelope(
      turtle,
      [agent1.publicKey, agent2.publicKey, owner.publicKey],
      owner,
    );

    expect(envelope.wrappedKeys.length).toBe(3);
    expect(envelope.algorithm).toBe('X25519-XSalsa20-Poly1305');

    // Agent 1 can decrypt
    const result1 = openEncryptedEnvelope(envelope, agent1);
    expect(result1).toBe(turtle);

    // Agent 2 can decrypt
    const result2 = openEncryptedEnvelope(envelope, agent2);
    expect(result2).toBe(turtle);

    // Owner can decrypt
    const result3 = openEncryptedEnvelope(envelope, owner);
    expect(result3).toBe(turtle);

    // Unauthorized agent cannot
    const intruder = generateKeyPair();
    const result4 = openEncryptedEnvelope(envelope, intruder);
    expect(result4).toBeNull();
  });

  it('re-encrypts for new recipient set (revocation)', () => {
    const owner = generateKeyPair();
    const agent1 = generateKeyPair();
    const agent2 = generateKeyPair();
    const turtle = 'secret content';

    // Initial: both agents authorized
    const envelope = createEncryptedEnvelope(
      turtle,
      [agent1.publicKey, agent2.publicKey, owner.publicKey],
      owner,
    );

    // Both can decrypt
    expect(openEncryptedEnvelope(envelope, agent1)).toBe(turtle);
    expect(openEncryptedEnvelope(envelope, agent2)).toBe(turtle);

    // Revoke agent2: re-encrypt for only agent1 + owner
    const newEnvelope = reEncryptForRecipients(
      envelope,
      owner,
      [agent1.publicKey, owner.publicKey],
    );
    expect(newEnvelope).not.toBeNull();

    // Agent1 can still decrypt
    expect(openEncryptedEnvelope(newEnvelope!, agent1)).toBe(turtle);
    // Owner can still decrypt
    expect(openEncryptedEnvelope(newEnvelope!, owner)).toBe(turtle);
    // Agent2 can NO LONGER decrypt (revoked)
    expect(openEncryptedEnvelope(newEnvelope!, agent2)).toBeNull();
  });

  it('serializes and deserializes envelope', () => {
    const owner = generateKeyPair();
    const agent = generateKeyPair();
    const turtle = 'serialize me';

    const envelope = createEncryptedEnvelope(turtle, [agent.publicKey, owner.publicKey], owner);
    const json = envelopeToJson(envelope);
    const restored = envelopeFromJson(json);

    expect(openEncryptedEnvelope(restored, agent)).toBe(turtle);
  });
});

// ═════════════════════════════════════════════════════════════
//  Zero-Knowledge Proofs
// ═════════════════════════════════════════════════════════════

describe('Commitments', () => {
  it('creates and verifies commitment', () => {
    const { commitment, blinding } = commit('secret-value');
    expect(commitment.type).toBe('hash-commitment');
    expect(commitment.commitment.length).toBe(64); // SHA-256 hex

    const valid = verifyCommitment(commitment, 'secret-value', blinding);
    expect(valid).toBe(true);
  });

  it('rejects wrong value', () => {
    const { commitment, blinding } = commit('real-value');
    const valid = verifyCommitment(commitment, 'fake-value', blinding);
    expect(valid).toBe(false);
  });

  it('rejects wrong blinding factor', () => {
    const { commitment } = commit('value');
    const valid = verifyCommitment(commitment, 'value', 'wrong-blinding');
    expect(valid).toBe(false);
  });
});

describe('Range Proofs (confidence threshold)', () => {
  it('proves confidence above threshold', () => {
    const { proof } = proveConfidenceAboveThreshold(0.9, 0.8);
    expect(proof.type).toBe('hash-range');
    expect(proof.threshold).toBe(0.8);
    expect(proof.commitment.length).toBe(64);
    expect(proof.proof.length).toBe(64);
  });

  it('verifies valid range proof', () => {
    const { proof } = proveConfidenceAboveThreshold(0.95, 0.8);
    const valid = verifyConfidenceProof(proof);
    expect(valid).toBe(true);
  });

  it('throws when confidence is below threshold', () => {
    expect(() => proveConfidenceAboveThreshold(0.5, 0.8)).toThrow('Cannot prove');
  });

  it('works at exact threshold', () => {
    const { proof } = proveConfidenceAboveThreshold(0.8, 0.8);
    expect(proof.threshold).toBe(0.8);
    const valid = verifyConfidenceProof(proof);
    expect(valid).toBe(true);
  });

  // ── Tampering detection (the new chain-walk verifier should catch
  //    every mutation that the prior length-only stub ignored) ─────

  it('rejects a proof with no chain field (back-compat: old stub-format proofs are unverifiable)', () => {
    const { proof } = proveConfidenceAboveThreshold(0.9, 0.8);
    const stripped = { ...proof, chain: undefined };
    expect(verifyConfidenceProof(stripped)).toBe(false);
  });

  it('rejects a proof whose anchor was tampered', () => {
    const { proof } = proveConfidenceAboveThreshold(0.9, 0.8);
    const tampered = { ...proof, proof: 'a'.repeat(64) };
    expect(verifyConfidenceProof(tampered)).toBe(false);
  });

  it('rejects a proof whose commitment was tampered', () => {
    const { proof } = proveConfidenceAboveThreshold(0.9, 0.8);
    const tampered = { ...proof, commitment: 'b'.repeat(64) };
    expect(verifyConfidenceProof(tampered)).toBe(false);
  });

  it('rejects a proof with a mutated chain link (mid-chain corruption)', () => {
    const { proof } = proveConfidenceAboveThreshold(0.95, 0.8);
    if (!proof.chain || proof.chain.length < 2) throw new Error('test setup: chain unexpectedly short');
    const tamperedChain = [...proof.chain];
    tamperedChain[1] = 'c'.repeat(64);
    const tampered = { ...proof, chain: tamperedChain };
    expect(verifyConfidenceProof(tampered)).toBe(false);
  });

  it('rejects a proof whose threshold was inflated (claiming higher than what was proved)', () => {
    const { proof } = proveConfidenceAboveThreshold(0.9, 0.8);
    const tampered = { ...proof, threshold: 0.99 };
    expect(verifyConfidenceProof(tampered)).toBe(false);
  });

  it('rejects malformed types', () => {
    const { proof } = proveConfidenceAboveThreshold(0.9, 0.8);
    expect(verifyConfidenceProof({ ...proof, type: 'wrong-type' as unknown as 'hash-range' })).toBe(false);
  });

  // ── Reveal-based verification ─────────────────────────────────────

  it('verifyByReveal: accepts the correct (value, blinding)', () => {
    const { proof, blinding } = proveConfidenceAboveThreshold(0.91, 0.8);
    expect(verifyConfidenceProofByReveal(proof, 0.91, blinding)).toBe(true);
  });

  it('verifyByReveal: rejects a wrong value (right blinding)', () => {
    const { proof, blinding } = proveConfidenceAboveThreshold(0.91, 0.8);
    expect(verifyConfidenceProofByReveal(proof, 0.92, blinding)).toBe(false);
  });

  it('verifyByReveal: rejects a wrong blinding (right value)', () => {
    const { proof } = proveConfidenceAboveThreshold(0.91, 0.8);
    expect(verifyConfidenceProofByReveal(proof, 0.91, 'wrong-blinding')).toBe(false);
  });

  it('verifyByReveal: rejects a value below threshold even if commitment matches', () => {
    // Forge a proof + matching commitment for value 0.5, but claim threshold 0.8.
    // The commitment opens correctly but the range claim is dishonest.
    const { proof, blinding } = proveConfidenceAboveThreshold(0.91, 0.8);
    expect(verifyConfidenceProofByReveal(proof, 0.5, blinding)).toBe(false);
  });

  it('chain length leaks (value − threshold) — documented honest-scoping behavior', () => {
    // discreteValue = 95, discreteThreshold = 80, chain length = 95 − 80 + 1 = 16.
    // This is the documented privacy tradeoff vs Bulletproofs.
    const { proof } = proveConfidenceAboveThreshold(0.95, 0.80);
    expect(proof.chain?.length).toBe(16);
  });

  it('rejects a proof whose anchor field is set to a hash that is not chain[0]', () => {
    // The .proof field is the anchor and MUST equal chain[0]. A
    // dishonest prover that swaps in a different sha256 hash there
    // (without rebuilding the chain) must be caught.
    const { proof } = proveConfidenceAboveThreshold(0.91, 0.8);
    const swappedAnchor = sha256('not-the-real-anchor');
    expect(swappedAnchor.length).toBe(64);
    const tampered = { ...proof, proof: swappedAnchor };
    expect(verifyConfidenceProof(tampered)).toBe(false);
  });

  it('rejects a chain padded beyond the [0,1] domain (length > 101)', () => {
    // A legitimate confidence-proof chain has length ≤ 101 (since
    // value*100 ∈ [0,100] and threshold*100 ∈ [0,100]). Padding
    // the chain to obscure the leaked gap is rejected.
    const { proof } = proveConfidenceAboveThreshold(0.91, 0.8);
    const padded = { ...proof, chain: [...(proof.chain ?? []), ...Array(110).fill(sha256('pad'))] };
    expect(verifyConfidenceProof(padded)).toBe(false);
  });

  it('rejects a proof whose threshold lies outside [0, 1]', () => {
    const { proof } = proveConfidenceAboveThreshold(0.91, 0.8);
    // threshold field directly mutated; chain content is unchanged
    expect(verifyConfidenceProof({ ...proof, threshold: 1.5 })).toBe(false);
    expect(verifyConfidenceProof({ ...proof, threshold: -0.1 })).toBe(false);
  });
});

describe('Merkle Proofs', () => {
  const agents = ['agent:alice', 'agent:bob', 'agent:carol', 'agent:dave'];

  it('builds Merkle tree', () => {
    const tree = buildMerkleTree(agents);
    expect(tree.root.length).toBe(64);
    expect(tree.leaves.length).toBe(4);
    expect(tree.layers.length).toBeGreaterThan(1);
  });

  it('generates and verifies inclusion proof', () => {
    const proof = generateMerkleProof('agent:bob', agents);
    expect(proof).not.toBeNull();
    expect(proof!.type).toBe('merkle-inclusion');

    const valid = verifyMerkleProof(proof!);
    expect(valid).toBe(true);
  });

  it('returns null for non-member', () => {
    const proof = generateMerkleProof('agent:eve', agents);
    expect(proof).toBeNull();
  });

  it('proof for every member verifies against same root', () => {
    const proofs = agents.map(a => generateMerkleProof(a, agents));
    const roots = proofs.map(p => p!.root);
    // All roots should be identical
    expect(new Set(roots).size).toBe(1);
    // All proofs should verify
    for (const proof of proofs) {
      expect(verifyMerkleProof(proof!)).toBe(true);
    }
  });
});

describe('Delegation Membership Proofs', () => {
  const authorizedAgents = [
    'urn:agent:anthropic:claude-code:vscode',
    'urn:agent:anthropic:claude-code:desktop',
    'urn:agent:openai:codex:cli',
  ];

  it('proves membership without revealing which agent', () => {
    const proof = proveDelegationMembership(
      'urn:agent:anthropic:claude-code:vscode',
      authorizedAgents,
    );
    expect(proof).not.toBeNull();

    // Verifier only sees: "someone in this set is proving membership"
    // They see the root (set identity) but not which leaf (which agent)
    const valid = verifyDelegationMembership(proof!);
    expect(valid).toBe(true);
  });

  it('non-member cannot prove membership', () => {
    const proof = proveDelegationMembership(
      'urn:agent:evil:hacker',
      authorizedAgents,
    );
    expect(proof).toBeNull();
  });
});

describe('Temporal Ordering Proofs', () => {
  it('proves timestamp is before deadline', () => {
    const result = proveTemporalOrdering(
      '2026-03-20T10:00:00Z',
      '2026-03-21T00:00:00Z',
    );
    expect(result).not.toBeNull();
    expect(result!.proof.type).toBe('temporal-ordering');
  });

  it('verifies temporal proof with revealed timestamp', () => {
    const result = proveTemporalOrdering(
      '2026-03-20T10:00:00Z',
      '2026-03-21T00:00:00Z',
    );

    const valid = verifyTemporalProof(
      result!.proof,
      '2026-03-20T10:00:00Z',
      result!.blinding,
    );
    expect(valid).toBe(true);
  });

  it('rejects if timestamp is after deadline', () => {
    const result = proveTemporalOrdering(
      '2026-03-22T10:00:00Z',
      '2026-03-21T00:00:00Z',
    );
    expect(result).toBeNull();
  });

  it('rejects tampered timestamp on verification', () => {
    const result = proveTemporalOrdering(
      '2026-03-20T10:00:00Z',
      '2026-03-21T00:00:00Z',
    );

    const valid = verifyTemporalProof(
      result!.proof,
      '2026-03-19T00:00:00Z', // different timestamp
      result!.blinding,
    );
    expect(valid).toBe(false);
  });
});

describe('PGSL Fragment Membership Proofs', () => {
  const atomUris = [
    'urn:pgsl:atom:Context',
    'urn:pgsl:atom:Graphs',
    'urn:pgsl:atom:enables',
    'urn:pgsl:atom:federated',
    'urn:pgsl:atom:knowledge',
  ];

  it('proves fragment membership in lattice', () => {
    const proof = proveFragmentMembership('urn:pgsl:atom:knowledge', atomUris);
    expect(proof).not.toBeNull();
    expect(proof!.type).toBe('fragment-membership');

    const valid = verifyFragmentMembership(proof!);
    expect(valid).toBe(true);
  });

  it('non-member fragment cannot prove membership', () => {
    const proof = proveFragmentMembership('urn:pgsl:atom:missing', atomUris);
    expect(proof).toBeNull();
  });
});

describe('Selective Disclosure', () => {
  it('creates selective disclosure with revealed and committed facets', () => {
    const facets = [
      { type: 'Semiotic', data: { modalStatus: 'Asserted', epistemicConfidence: 0.95 } },
      { type: 'Trust', data: { trustLevel: 'SelfAsserted', issuer: 'did:web:alice' } },
      { type: 'Temporal', data: { validFrom: '2026-01-01T00:00:00Z' } },
    ];

    const disclosure = createSelectiveDisclosure(
      'urn:cg:test:123',
      facets,
      ['Semiotic'], // only reveal Semiotic
      [{ type: 'confidence-threshold', threshold: 0.8 }],
    );

    expect(disclosure.revealedFacetTypes).toContain('Semiotic');
    expect(disclosure.committedFacetTypes).toContain('Trust');
    expect(disclosure.committedFacetTypes).toContain('Temporal');
    expect(disclosure.proofs.length).toBe(1); // confidence proof
  });

  it('does not generate proof when confidence is below threshold', () => {
    const facets = [
      { type: 'Semiotic', data: { modalStatus: 'Hypothetical', epistemicConfidence: 0.3 } },
    ];

    const disclosure = createSelectiveDisclosure(
      'urn:cg:test:low',
      facets,
      [],
      [{ type: 'confidence-threshold', threshold: 0.8 }],
    );

    // Proof should NOT be generated (can't prove 0.3 > 0.8)
    expect(disclosure.proofs.length).toBe(0);
  });
});
