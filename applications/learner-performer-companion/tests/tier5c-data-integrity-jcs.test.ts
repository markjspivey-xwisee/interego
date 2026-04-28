/**
 * Tier 5c — REAL W3C Data Integrity Proofs (eddsa-jcs-2022 cryptosuite).
 *
 * Closes the residual gap from Tier 5b. vc-jwt covered the JWT-encoded
 * VC path; this test covers the SECOND W3C-recognized format: JSON-LD
 * documents with embedded `proof` blocks signed using EdDSA over a
 * JCS-canonicalized payload.
 *
 * Why DI Proofs alongside vc-jwt:
 *   - Some VC verifiers in the W3C ecosystem ONLY accept the
 *     JSON-LD-with-embedded-proof shape (academic credentialing,
 *     government ID systems often). They don't accept JWTs.
 *   - eddsa-jcs-2022 is the JCS-canonicalization variant of the cryptosuite
 *     (sibling of eddsa-rdfc-2022 which uses RDF Dataset Canonicalization);
 *     skips URDNA2015 graph isomorphism while staying W3C-conformant.
 *
 * What this proves:
 *   - JCS canonicalization (RFC 8785) produces deterministic byte output
 *   - Issued credentials carry a valid `proof` block per W3C VC §5.1
 *   - eddsa-jcs-2022 cryptosuite properly chains proofHash || credentialHash
 *   - Verification rejects: tampered VC, tampered proof, wrong-issuer kid
 *   - Open Badges 3.0 + IMS CLR shapes round-trip through DI Proof
 */

import { describe, it, expect } from 'vitest';
import {
  generateDidKeyEd25519,
} from '../../_shared/vc-jwt/index.js';
import {
  canonicalizeJcs,
  issueDataIntegrityProof,
  verifyDataIntegrityProof,
  type VerifiableCredentialJson,
} from '../../_shared/vc-jwt/data-integrity-jcs.js';

// ── Sample VC payloads ───────────────────────────────────────────────

function buildOB3Credential(issuerDid: string, holderDid: string): VerifiableCredentialJson {
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context.json',
    ],
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    id: 'urn:uuid:cs101-mod3-cred',
    issuer: issuerDid,
    validFrom: '2025-09-15T11:00:00Z',
    credentialSubject: {
      id: holderDid,
      type: ['AchievementSubject'],
      achievement: {
        id: 'urn:uuid:cs101-mod3-ach',
        type: ['Achievement'],
        name: 'CS-101 Module 3 — Handling Frustration',
        description: 'Successfully completed module 3 of Customer Service 101.',
      },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Tests
// ═════════════════════════════════════════════════════════════════════

describe('Tier 5c — W3C Data Integrity Proofs (eddsa-jcs-2022)', () => {
  describe('JCS canonicalization (RFC 8785)', () => {
    it('object key sorting: { b: 1, a: 2 } → {"a":2,"b":1}', () => {
      expect(canonicalizeJcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it('preserves array order (no sort)', () => {
      expect(canonicalizeJcs(['z', 'a', 'm'])).toBe('["z","a","m"]');
    });

    it('null + booleans + numbers', () => {
      expect(canonicalizeJcs(null)).toBe('null');
      expect(canonicalizeJcs(true)).toBe('true');
      expect(canonicalizeJcs(false)).toBe('false');
      expect(canonicalizeJcs(42)).toBe('42');
      expect(canonicalizeJcs(3.14)).toBe('3.14');
    });

    it('strings: escapes \" \\\\ control chars; passes through unicode > U+007F verbatim', () => {
      expect(canonicalizeJcs('hello')).toBe('"hello"');
      expect(canonicalizeJcs('with "quotes"')).toBe('"with \\"quotes\\""');
      expect(canonicalizeJcs('back\\slash')).toBe('"back\\\\slash"');
      expect(canonicalizeJcs('tab\there')).toBe('"tab\\there"');
      // Unicode > U+007F passes through verbatim per RFC 8785
      expect(canonicalizeJcs('café')).toBe('"café"');
    });

    it('nested objects: keys sorted at every level', () => {
      const input = { z: { y: 2, x: 1 }, a: { c: 3, b: 4 } };
      const expected = '{"a":{"b":4,"c":3},"z":{"x":1,"y":2}}';
      expect(canonicalizeJcs(input)).toBe(expected);
    });

    it('determinism: same input → byte-identical output across calls', () => {
      const input = { foo: 'bar', baz: [1, 2, 3], nested: { a: 1, b: 2 } };
      expect(canonicalizeJcs(input)).toBe(canonicalizeJcs(input));
    });

    it('rejects NaN / Infinity', () => {
      expect(() => canonicalizeJcs(NaN)).toThrow();
      expect(() => canonicalizeJcs(Infinity)).toThrow();
      expect(() => canonicalizeJcs(-Infinity)).toThrow();
    });
  });

  describe('issuance + verification', () => {
    it('issue + verify a complete OB 3.0 VC with embedded eddsa-jcs-2022 proof', async () => {
      const acme = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();

      const unsigned = buildOB3Credential(acme.did, mark.did);
      const signed = issueDataIntegrityProof(unsigned, acme);

      // Proof block shape per W3C VC §5.1 + DI cryptosuite spec
      expect(signed.proof?.type).toBe('DataIntegrityProof');
      expect(signed.proof?.cryptosuite).toBe('eddsa-jcs-2022');
      expect(signed.proof?.verificationMethod).toBe(acme.kid);
      expect(signed.proof?.proofPurpose).toBe('assertionMethod');
      expect(signed.proof?.proofValue).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);

      // Verify
      const result = verifyDataIntegrityProof(signed);
      expect(result.verified).toBe(true);
      expect(result.issuerDid).toBe(acme.did);
      expect(result.verificationMethod).toBe(acme.kid);
    });

    it('tamper detection: changing credentialSubject after signing → REJECTED', async () => {
      const acme = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();
      const eve = await generateDidKeyEd25519();

      const signed = issueDataIntegrityProof(buildOB3Credential(acme.did, mark.did), acme);

      // Tamper: swap subject from Mark to Eve
      const tampered: VerifiableCredentialJson = {
        ...signed,
        credentialSubject: { ...signed.credentialSubject, id: eve.did },
      };

      const result = verifyDataIntegrityProof(tampered);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('signature');
    });

    it('proof tamper detection: changing proof.created after signing → REJECTED', async () => {
      const acme = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();
      const signed = issueDataIntegrityProof(buildOB3Credential(acme.did, mark.did), acme);

      const tampered: VerifiableCredentialJson = {
        ...signed,
        proof: {
          ...signed.proof!,
          created: '2099-12-31T00:00:00Z',  // changed proof option
        },
      };

      const result = verifyDataIntegrityProof(tampered);
      expect(result.verified).toBe(false);
    });

    it('issuer-mismatch detection: VC issuer != verificationMethod DID → REJECTED', async () => {
      const acme = await generateDidKeyEd25519();
      const eve = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();

      // Sign with eve's keys but claim issuer = acme
      const unsigned = buildOB3Credential(acme.did, mark.did);
      // Manually construct signed with verificationMethod pointing at eve
      const signedWithEve = issueDataIntegrityProof({ ...unsigned, issuer: eve.did }, eve);

      // Now mutate to claim issuer = acme but verificationMethod still eve's
      const swapped: VerifiableCredentialJson = {
        ...signedWithEve,
        issuer: acme.did,
      };

      const result = verifyDataIntegrityProof(swapped);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('issuer mismatch');
    });

    it('forgery: Bob signs claiming verificationMethod=Alice → REJECTED', async () => {
      const alice = await generateDidKeyEd25519();
      const bob = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();

      // Bob signs the credential as if Alice did
      const credAsAlice = buildOB3Credential(alice.did, mark.did);
      const signedByAlice = issueDataIntegrityProof(credAsAlice, alice);

      // Forgery: replace the proof's verificationMethod with Alice's,
      // but signed with Bob's key
      const credAsBob = buildOB3Credential(bob.did, mark.did);
      const signedByBob = issueDataIntegrityProof(credAsBob, bob);

      const forged: VerifiableCredentialJson = {
        ...credAsAlice,
        proof: {
          ...signedByBob.proof!,
          verificationMethod: alice.kid,                  // claims Alice
        },
      };

      const result = verifyDataIntegrityProof(forged);
      expect(result.verified).toBe(false);
    });

    it('cannot double-sign (issuance refuses input that already has a proof)', async () => {
      const acme = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();
      const signed = issueDataIntegrityProof(buildOB3Credential(acme.did, mark.did), acme);

      expect(() => issueDataIntegrityProof(signed, acme)).toThrow(/proof/);
    });

    it('issuer.did mismatch with payload.issuer: refuses to issue', async () => {
      const acme = await generateDidKeyEd25519();
      const eve = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();

      // payload says issuer = acme, but caller passes eve as the issuer keypair
      const unsigned = buildOB3Credential(acme.did, mark.did);
      expect(() => issueDataIntegrityProof(unsigned, eve)).toThrow(/issuer/);
    });

    it('determinism: signing + verifying with the SAME proof.created produces SAME proofValue (JCS is deterministic)', async () => {
      const acme = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();

      const unsigned = buildOB3Credential(acme.did, mark.did);
      const signed1 = issueDataIntegrityProof(unsigned, acme, { created: '2026-04-28T00:00:00Z' });
      const signed2 = issueDataIntegrityProof(unsigned, acme, { created: '2026-04-28T00:00:00Z' });

      expect(signed1.proof?.proofValue).toBe(signed2.proof?.proofValue);
      expect(verifyDataIntegrityProof(signed1).verified).toBe(true);
      expect(verifyDataIntegrityProof(signed2).verified).toBe(true);
    });
  });

  describe('ecosystem coverage', () => {
    it('Open Badges 3.0 shape: type includes both VerifiableCredential AND OpenBadgeCredential', async () => {
      const acme = await generateDidKeyEd25519();
      const mark = await generateDidKeyEd25519();
      const signed = issueDataIntegrityProof(buildOB3Credential(acme.did, mark.did), acme);

      expect(signed.type).toEqual(['VerifiableCredential', 'OpenBadgeCredential']);
      expect(signed['@context']).toContain('https://www.w3.org/ns/credentials/v2');
      expect(signed['@context']).toContain('https://purl.imsglobal.org/spec/ob/v3p0/context.json');
      expect(verifyDataIntegrityProof(signed).verified).toBe(true);
    });

    it('IMS CLR 2.0 shape: assertion → ClrCredential type roundtrips through DI Proof', async () => {
      const issuer = await generateDidKeyEd25519();
      const learner = await generateDidKeyEd25519();

      const clr: VerifiableCredentialJson = {
        '@context': [
          'https://www.w3.org/ns/credentials/v2',
          'https://purl.imsglobal.org/spec/clr/v2p0/context.json',
        ],
        type: ['VerifiableCredential', 'ClrCredential'],
        id: 'urn:uuid:transcript-2025-2026',
        issuer: issuer.did,
        validFrom: '2026-05-15T00:00:00Z',
        credentialSubject: {
          id: learner.did,
          type: ['ClrSubject'],
          assertions: [
            {
              type: ['Assertion'],
              achievement: { name: 'CS-101 Mod 3' },
            },
          ],
        },
      };

      const signed = issueDataIntegrityProof(clr, issuer);
      const result = verifyDataIntegrityProof(signed);
      expect(result.verified).toBe(true);
      expect((signed.credentialSubject as { type: string[] }).type).toContain('ClrSubject');
    });
  });
});
