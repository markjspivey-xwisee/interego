/**
 * Tier 5b — REAL W3C Verifiable Credential vc-jwt with Ed25519.
 *
 * Closes the cryptosuite-interop gap from Tier 5: previously the test
 * used Interego's native ECDSA/keccak256 signing, which is not directly
 * compatible with the W3C VC ecosystem. This test uses vc-jwt — a W3C
 * VC Data Model 2.0 §6.3 encoding using JWS — which is recognized by
 * Open Badges 3.0, IMS CLR 2.0, and the broader VC verifier ecosystem.
 *
 * What this proves:
 *   - lpc:Credential descriptors can be backed by REAL W3C VC proof
 *     blocks consumable by any vc-jwt verifier (jose, did-jwt, etc.)
 *   - Ed25519 signing using did:key produces a JWT that:
 *       * Has correct multibase-encoded did:key for issuer
 *       * Has alg=EdDSA + kid=did:key:...#z... in header
 *       * Carries vc claim with @context, type, issuer, validFrom,
 *         credentialSubject per W3C VC 2.0
 *       * Verifies via jose's standard jwtVerify (third-party verifier)
 *   - Tamper detection works (JWS signature gates byte-level changes)
 *   - Wrong-issuer detection: a JWT signed by Bob claiming to be from
 *     Alice fails verification (kid is bound to the signing key)
 *   - Open Badges 3.0 shape: credentialSubject with achievement claim
 */

import { describe, it, expect } from 'vitest';
import { jwtVerify, importJWK, decodeProtectedHeader, decodeJwt } from 'jose';
import {
  generateDidKeyEd25519,
  importDidKeyEd25519,
  issueVcJwt,
  verifyVcJwt,
  decodeDidKeyEd25519,
} from '../../_shared/vc-jwt/index.js';
import type { VcPayload } from '../../_shared/vc-jwt/index.js';

// ── OB 3.0-shaped credential payload ─────────────────────────────────

function buildOB3VcPayload(issuerDid: string, holderDid: string, achievementName: string): VcPayload {
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://purl.imsglobal.org/spec/ob/v3p0/context.json',
    ],
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: issuerDid,
    validFrom: '2025-09-15T11:00:00Z',
    credentialSubject: {
      id: holderDid,
      type: ['AchievementSubject'],
      achievement: {
        id: 'urn:uuid:cs101-mod3-achievement',
        type: ['Achievement'],
        name: achievementName,
        description: 'Successfully completed Customer Service 101 — Module 3.',
      },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Tests
// ═════════════════════════════════════════════════════════════════════

describe('Tier 5b — W3C Verifiable Credential vc-jwt with Ed25519 + did:key', () => {
  it('did:key encoding round-trip: encode → decode preserves Ed25519 pubkey', async () => {
    const acme = await generateDidKeyEd25519();
    expect(acme.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);

    const recovered = decodeDidKeyEd25519(acme.did);
    expect(recovered).toEqual(acme.publicKey);
  });

  it('issue + verify a real OB 3.0 vc-jwt: JWT structure conforms to W3C VC 2.0 §6.3', async () => {
    const acme = await generateDidKeyEd25519();
    const mark = await generateDidKeyEd25519();

    const vc = buildOB3VcPayload(acme.did, mark.did, 'CS-101 Mod 3 — Handling Frustration');
    const jwt = await issueVcJwt(vc, acme);

    // Three parts (header.payload.signature)
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    // Header: alg=EdDSA, typ=JWT, kid=did:key:...#z...
    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe(acme.kid);

    // Payload: standard JWT claims + vc claim per VC-Data-Model 2.0 §6.3
    const payload = decodeJwt(jwt) as { iss: string; sub?: string; vc?: VcPayload };
    expect(payload.iss).toBe(acme.did);
    expect(payload.sub).toBe(mark.did);
    expect(payload.vc).toBeDefined();
    expect(payload.vc!['@context']).toContain('https://www.w3.org/ns/credentials/v2');
    expect(payload.vc!.type).toContain('VerifiableCredential');
    expect(payload.vc!.type).toContain('OpenBadgeCredential');

    // Verify via our verifier
    const result = await verifyVcJwt(jwt);
    expect(result.issuerDid).toBe(acme.did);
    expect(result.payload.credentialSubject.id).toBe(mark.did);
  });

  it('verifies via standard jose library (third-party verifier interop)', async () => {
    const acme = await generateDidKeyEd25519();
    const mark = await generateDidKeyEd25519();
    const vc = buildOB3VcPayload(acme.did, mark.did, 'CS-101');
    const jwt = await issueVcJwt(vc, acme);

    // Independent verifier path: jose with the resolved Ed25519 pubkey
    const publicKey = await importJWK(acme.publicJwk, 'EdDSA');
    const { payload: verifiedPayload, protectedHeader } = await jwtVerify(jwt, publicKey);

    expect(protectedHeader.alg).toBe('EdDSA');
    expect(verifiedPayload.iss).toBe(acme.did);
    expect((verifiedPayload['vc'] as { type: string[] }).type).toContain('OpenBadgeCredential');
  });

  it('tamper detection: any byte change in the JWT breaks signature verification', async () => {
    const acme = await generateDidKeyEd25519();
    const mark = await generateDidKeyEd25519();
    const vc = buildOB3VcPayload(acme.did, mark.did, 'CS-101');
    const jwt = await issueVcJwt(vc, acme);

    // Tamper: flip one character in the payload portion
    const parts = jwt.split('.');
    const tamperedPayload = parts[1]!.slice(0, -3) + (parts[1]!.endsWith('A') ? 'BBB' : 'AAA');
    const tamperedJwt = [parts[0], tamperedPayload, parts[2]].join('.');

    await expect(verifyVcJwt(tamperedJwt)).rejects.toThrow();
  });

  it('forgery detection: JWT signed by Bob with kid claiming Alice fails verification', async () => {
    const alice = await generateDidKeyEd25519();
    const bob = await generateDidKeyEd25519();
    const mark = await generateDidKeyEd25519();

    // Build a VC payload SAYING Alice is the issuer
    const vc = buildOB3VcPayload(alice.did, mark.did, 'CS-101');

    // But sign with Bob's keys — manually constructing the JWT with
    // Alice's kid so the verifier resolves Alice's pubkey, while the
    // signature is from Bob.
    const { SignJWT } = await import('jose');
    const bobPrivateKey = await importJWK(bob.privateJwk, 'EdDSA');
    const forged = await new SignJWT({ vc })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: alice.kid })   // claims Alice
      .setIssuer(alice.did)
      .setSubject(mark.did)
      .setIssuedAt()
      .sign(bobPrivateKey);                                                // but signed by Bob

    // verifyVcJwt resolves Alice's pubkey from the kid; signature
    // verification fails because Bob's signature won't verify against
    // Alice's pubkey.
    await expect(verifyVcJwt(forged)).rejects.toThrow();
  });

  it('issuer-mismatch detection: kid says one DID but iss claims another → REJECTED', async () => {
    const alice = await generateDidKeyEd25519();
    const eve = await generateDidKeyEd25519();
    const mark = await generateDidKeyEd25519();

    // Construct a VC with Eve as issuer (in the payload)
    const vc = buildOB3VcPayload(eve.did, mark.did, 'CS-101');

    // But sign as Alice. Alice's signature WILL verify against Alice's
    // pubkey, but iss != kid → verifier rejects.
    const { SignJWT } = await import('jose');
    const alicePrivateKey = await importJWK(alice.privateJwk, 'EdDSA');
    const mismatched = await new SignJWT({ vc })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: alice.kid })   // kid = Alice
      .setIssuer(eve.did)                                                  // iss = Eve
      .setSubject(mark.did)
      .setIssuedAt()
      .sign(alicePrivateKey);

    await expect(verifyVcJwt(mismatched)).rejects.toThrow(/Issuer mismatch/);
  });

  it('issued credential is portable: import key elsewhere, re-issue same credential, signature verifies the same', async () => {
    const acme1 = await generateDidKeyEd25519();
    const acme2 = await importDidKeyEd25519(acme1.privateKey);

    // Same key material → same DID + same kid
    expect(acme2.did).toBe(acme1.did);
    expect(acme2.kid).toBe(acme1.kid);
    expect(acme2.publicKey).toEqual(acme1.publicKey);

    const mark = await generateDidKeyEd25519();
    const vc = buildOB3VcPayload(acme1.did, mark.did, 'Portable Credential');

    // Sign with imported key; verify with original
    const jwt = await issueVcJwt(vc, acme2);
    const verified = await verifyVcJwt(jwt);
    expect(verified.issuerDid).toBe(acme1.did);
  });

  it('OB 3.0 specific: credentialSubject has achievement object with type Achievement', async () => {
    const acme = await generateDidKeyEd25519();
    const mark = await generateDidKeyEd25519();

    const vc = buildOB3VcPayload(acme.did, mark.did, 'CS-101 Mod 3 — Handling Frustration');
    const jwt = await issueVcJwt(vc, acme);
    const verified = await verifyVcJwt(jwt);

    const subject = verified.payload.credentialSubject as {
      id: string;
      type: string[];
      achievement: { type: string[]; name: string };
    };
    expect(subject.id).toBe(mark.did);
    expect(subject.type).toContain('AchievementSubject');
    expect(subject.achievement.type).toContain('Achievement');
    expect(subject.achievement.name).toContain('CS-101');
  });
});
