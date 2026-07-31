/**
 * An authorship proof must attest the CONTENT, not just name the resource.
 *
 * ★ THE DEFECT. `canonicalAuthorshipPayload` signed
 * `{@context, agentId, created, descriptorId, ownerWebId, type, agentDid?}` — every field
 * naming WHO signed and WHICH resource, and not one naming WHAT IT SAYS. So
 * `sign_authorship: true` produced a proof that stayed valid however the graph content
 * changed afterwards. It read exactly like an attestation of the document while being an
 * attestation of the filename, and that resemblance is what made it dangerous rather than
 * merely incomplete.
 *
 * ★ THE MIGRATION CONSTRAINT. Proofs already exist and cannot be re-signed, so
 * `contentHash` is included in the canonical payload ONLY when present. An
 * always-present field — even an empty string — would change the signed bytes of every
 * historical proof and invalidate all of them. Absence is the migration.
 *
 * ★ THE TRAP THIS FILE EXISTS TO CATCH. The proof is serialised into descriptor Turtle
 * and the verifier rebuilds the canonical payload from that Turtle alone. A field that is
 * signed but NOT serialised makes every new proof fail to verify — a total break that
 * presents as a bad signature rather than as a missing field, which is the hardest kind to
 * diagnose. So the round-trip is asserted directly.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalAuthorshipPayload,
  createSignedAuthorship,
  verifySignedAuthorship,
  type AuthorshipProofInputs,
  type IRI,
} from '@interego/core';
import {
  buildAuthorshipProofBlock,
  parseAuthorshipProofFromDescriptorTurtle,
} from '@interego/solid';

const sha = (s: string): string => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

const BASE: AuthorshipProofInputs = {
  agentId: 'https://ex.org/agent' as IRI,
  ownerWebId: 'https://ex.org/owner#me' as IRI,
  descriptorId: 'https://ex.org/desc/1' as IRI,
  created: '2026-07-31T00:00:00.000Z',
};

/** A deterministic stand-in for the wallet signer: signature = digest of the payload. */
const signer = async (payload: string) => ({
  signature: sha(payload),
  signerAddress: '0xabc',
  verificationMethod: 'did:ethr:0xabc' as IRI,
});
/** Verifies iff the signature still equals the digest of the payload handed to it. */
const verifier = async (payload: string, proof: { proofValue: string }) =>
  proof.proofValue === sha(payload);

describe('the canonical payload covers content when a digest is supplied', () => {
  it('a content digest changes the signed bytes', () => {
    const without = canonicalAuthorshipPayload(BASE);
    const with1 = canonicalAuthorshipPayload({ ...BASE, contentHash: sha('one') });
    const with2 = canonicalAuthorshipPayload({ ...BASE, contentHash: sha('two') });
    expect(with1).not.toBe(without);
    expect(with1).not.toBe(with2);
  });

  it('omitting it reproduces the LEGACY bytes exactly, so old proofs still verify', () => {
    // The migration constraint: absence must be byte-identical to the pre-change payload.
    const legacy = canonicalAuthorshipPayload(BASE);
    expect(legacy).not.toMatch(/contentHash/);
    expect(canonicalAuthorshipPayload({ ...BASE, contentHash: undefined })).toBe(legacy);
  });
});

describe('signing and verification', () => {
  it('a proof over content verifies, and reports that it covers content', async () => {
    const proof = await createSignedAuthorship({ ...BASE, contentHash: sha('the graph') }, signer);
    const r = await verifySignedAuthorship(proof, verifier);
    expect(r.valid).toBe(true);
    expect(r.coversContent).toBe(true);
  });

  it('a LEGACY proof still verifies, but is reported as NOT covering content', async () => {
    const proof = await createSignedAuthorship(BASE, signer);
    const r = await verifySignedAuthorship(proof, verifier);
    expect(r.valid).toBe(true);
    // The whole point: valid and content-covering are different questions, and a consumer
    // that needs integrity must be able to tell them apart.
    expect(r.coversContent).toBe(false);
  });

  it('detects a content swap — authentic signature, different content', async () => {
    const proof = await createSignedAuthorship({ ...BASE, contentHash: sha('original') }, signer);
    const r = await verifySignedAuthorship(proof, verifier, { contentHash: sha('tampered') });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/covers content/);
  });

  it('accepts when the observed content matches', async () => {
    const h = sha('original');
    const proof = await createSignedAuthorship({ ...BASE, contentHash: h }, signer);
    const r = await verifySignedAuthorship(proof, verifier, { contentHash: h });
    expect(r.valid).toBe(true);
    expect(r.coversContent).toBe(true);
  });
});

describe('contentHash survives the Turtle round-trip', () => {
  it('is serialised and parsed back — otherwise every new proof fails to verify', async () => {
    const h = sha('the graph');
    const proof = await createSignedAuthorship({ ...BASE, contentHash: h }, signer);

    const turtle = buildAuthorshipProofBlock(proof);
    expect(turtle, 'contentHash must appear in the emitted Turtle').toMatch(/iep:contentHash/);

    const parsed = parseAuthorshipProofFromDescriptorTurtle(turtle);
    expect(parsed).not.toBeNull();
    expect(parsed!.contentHash).toBe(h);

    // ★ The decisive assertion: verification off the PARSED proof, exactly as a reader
    // does from pod Turtle alone.
    const r = await verifySignedAuthorship(parsed!, verifier);
    expect(r.valid, 'a signed-but-unserialised field breaks verification silently').toBe(true);
    expect(r.coversContent).toBe(true);
  });

  it('a legacy proof round-trips without acquiring one', async () => {
    const proof = await createSignedAuthorship(BASE, signer);
    const parsed = parseAuthorshipProofFromDescriptorTurtle(buildAuthorshipProofBlock(proof));
    expect(parsed!.contentHash).toBeUndefined();
    const r = await verifySignedAuthorship(parsed!, verifier);
    expect(r.valid).toBe(true);
    expect(r.coversContent).toBe(false);
  });
});
