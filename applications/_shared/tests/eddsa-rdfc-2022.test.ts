/**
 * eddsa-rdfc-2022 (applications/_shared/vc-jwt/data-integrity-rdfc.ts) signs the SHA-256 of a
 * credential's RDFC-1.0 canonical N-Quads. Those bytes come out of two libraries the repo does not
 * own — jsonld (expansion and toRDF) and rdf-canonize (canonicalization) — so a release of either
 * that moved a single byte would invalidate every proof already issued, while every test that only
 * signs and then verifies in one process stayed green.
 *
 * The vector below was computed under jsonld 8.3.3 with rdf-canonize 4.0.1 and is checked here under
 * whatever the lockfile resolves now. Ed25519 is deterministic, so an equal proofValue means equal
 * canonical bytes for both the credential and the proof options. The credential is chosen to reach
 * the places the two jsonld majors serialize differently: a tab and other characters N-Quads
 * escapes, a character outside the Basic Multilingual Plane, anonymous nodes that are alike but for
 * where they hang, a language tag and a typed literal.
 *
 * The context is inlined, so the default document loader never goes to the network.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importDidKeyEd25519 } from '../vc-jwt/index.js';
import { issueDataIntegrityRdfcProof, verifyDataIntegrityRdfcProof } from '../vc-jwt/data-integrity-rdfc.js';
import type { VerifiableCredentialJson } from '../vc-jwt/data-integrity-jcs.js';

const credentialsV2 = JSON.parse(readFileSync(
  new URL('../../foxxi-content-intelligence/tests/support/contexts/credentials-v2.jsonld', import.meta.url), 'utf8',
)) as { '@context': Record<string, unknown> };

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const CREATED = '2026-10-01T00:00:00Z';
const PINNED_PROOF_VALUE = 'z5yB6fDJVNWUyFUmTg5nwUpjfeH16j3DLmtaGj32UPhQKoNu1syQkcRJdTMioYyWohHPSQQ5f8P5UWELpU3h5c77V';

function credential(issuer: string): VerifiableCredentialJson {
  return {
    '@context': [credentialsV2['@context'], { '@vocab': 'https://example.org/vocab#' }],
    type: ['VerifiableCredential'],
    issuer,
    validFrom: '2026-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:example:learner',
      note: 'tab\there "quoted" back\\slash\nnewline \u0001 \u007f \u{1F600}',
      greeting: { '@value': 'bonjour', '@language': 'fr' },
      completed: { '@value': '2026-09-30', '@type': 'http://www.w3.org/2001/XMLSchema#date' },
      evidence: [{ name: 'same' }, { name: 'same' }, { name: 'other', about: { name: 'same' } }],
    },
  } as unknown as VerifiableCredentialJson;
}

describe('eddsa-rdfc-2022 signs the same canonical bytes', () => {
  it('issues the proofValue pinned before the JSON-LD stack last moved', async () => {
    const issuer = await importDidKeyEd25519(SECRET);
    const signed = await issueDataIntegrityRdfcProof(credential(issuer.did), issuer, { created: CREATED });
    expect(signed.proof?.cryptosuite).toBe('eddsa-rdfc-2022');
    expect(signed.proof?.proofValue,
      'the canonical N-Quads of this credential changed: every eddsa-rdfc-2022 proof issued before now would stop verifying',
    ).toBe(PINNED_PROOF_VALUE);
  });

  it('verifies that proof, and refuses it once one character of the credential changes', async () => {
    const issuer = await importDidKeyEd25519(SECRET);
    const signed = await issueDataIntegrityRdfcProof(credential(issuer.did), issuer, { created: CREATED });
    expect(await verifyDataIntegrityRdfcProof(signed)).toEqual({ verified: true });
    const subject = signed.credentialSubject as Record<string, unknown>;
    const tampered = { ...signed, credentialSubject: { ...subject, note: String(subject.note).replace('\t', ' ') } };
    expect((await verifyDataIntegrityRdfcProof(tampered)).verified).toBe(false);
  });
});
