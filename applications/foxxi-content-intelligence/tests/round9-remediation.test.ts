import { describe, it, expect } from 'vitest';
import { verifyDataIntegrityProof, issueDataIntegrityProof } from '../../_shared/vc-jwt/data-integrity-jcs.js';
import { deriveTenantIssuer } from '../src/credentials.js';
import { validateStatement } from '../src/xapi-validate.js';
import { buildFoxxiProfileDoc, validateAgainstProfileTemplates, FOXXI_NS } from '../src/xapi-profile.js';
import { renderTermJsonLd } from '../src/foxxi-vocab.js';
import { renderSemTermJsonLd, renderSemOntologyTurtle, renderSemOntologyJsonLd } from '../src/ler-tla-vocab.js';
import { issueBbsCompletionCredential } from '../src/bbs-credentials.js';

const ADL = 'http://adlnet.gov/expapi/verbs';
const ACT = 'http://adlnet.gov/expapi/activities';
const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const conforms = (r: { violations: unknown[] }) => r.violations.length === 0;

// ── BLOCKER: proofValue length cap before O(n^2) base58Decode ───────────────────────────
describe('round-9 — verifyDataIntegrityProof caps proofValue length (DoS)', () => {
  it('an oversized proofValue is rejected without decoding (fast, no throw)', () => {
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', proofPurpose: 'assertionMethod', verificationMethod: 'did:key:z6Mk#z6Mk', proofValue: 'z' + 'z'.repeat(500000) };
    const t0 = Date.now();
    const r = verifyDataIntegrityProof({ '@context': [], type: [], issuer: 'did:key:z6Mk', validFrom: '', credentialSubject: {}, proof: proof as never });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/too long/);
    expect(Date.now() - t0).toBeLessThan(200); // no quadratic decode
  });
});

// ── MAJOR: eddsa-jcs-2022 proof config binds the document @context ───────────────────────
describe('round-9 — eddsa-jcs-2022 binds @context in the proof config (round-trips)', () => {
  it('a VC signed with @context binding verifies, and tampering @context breaks it', async () => {
    const issuer = await deriveTenantIssuer('round9-test-seed');
    const vc = { '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: issuer.did, validFrom: '2026-07-01T00:00:00Z', credentialSubject: { id: 'did:key:z6Mkholder', name: 'x' } };
    const signed = issueDataIntegrityProof(vc as never, issuer);
    expect(verifyDataIntegrityProof(signed).verified).toBe(true);
    // Tampering the @context invalidates the signature (it is bound into the proof config hash).
    const tampered = { ...signed, '@context': ['https://example.org/other'] };
    expect(verifyDataIntegrityProof(tampered as never).verified).toBe(false);
  });
});

// ── MAJOR: findNulls recursion is depth-bounded (no stack-overflow DoS) ──────────────────
describe('round-9 — validateStatement does not throw on deeply-nested JSON', () => {
  it('a 5000-deep nested object is handled without a RangeError', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5000; i++) deep = { a: deep };
    expect(() => validateStatement({ id: '12345678-1234-1234-1234-123456789012', actor: { objectType: 'Agent', mbox: 'mailto:a@x.org' }, verb: { id: `${ADL}/completed` }, object: { id: 'http://x/1', objectType: 'Activity', definition: { extensions: deep } }, timestamp: '2026-07-01T00:00:00Z', version: '2.0.0' })).not.toThrow();
  });
});

// ── MAJOR: published profile emits objectActivityType as a SINGLE IRI (spec) ─────────────
describe('round-9 — no Statement Template serves objectActivityType as an array', () => {
  it('every template objectActivityType is a string (or absent)', () => {
    const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-01T00:00:00Z' }) as { templates: Array<Record<string, unknown>> };
    for (const t of doc.templates) {
      if (t.objectActivityType !== undefined) expect(Array.isArray(t.objectActivityType)).toBe(false);
    }
  });
  it('cmi5 lesson launched + SCORM course launched both still conform (rule-based)', () => {
    const ctx = { registration: 'r', contextActivities: { category: [{ id: CMI5_CAT }] } };
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/launched` }, object: { id: 'https://x/au', objectType: 'Activity', definition: { type: `${ACT}/lesson` } }, context: ctx }))).toBe(true);
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/launched` }, object: { id: 'https://x/c', objectType: 'Activity', definition: { type: `${ACT}/course` } }, context: ctx }))).toBe(true);
    // A launched with a DOMAIN object type (neither course nor lesson) is non-conformant.
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/launched` }, object: { id: 'https://x/d', objectType: 'Activity', definition: { type: 'https://acme.example/Thing' } }, context: ctx }))).toBe(false);
  });
});

// ── MAJOR: MOM closeMatch only to REGISTERED verb IRIs (no fabricated adlnet.gov) ────────
describe('round-9 — MOM verbs closeMatch only registered counterparts', () => {
  it('a real ADL verb has an adlnet.gov closeMatch; a coined MOM verb has none', () => {
    const ttl = renderSemOntologyTurtle('tla');
    expect(ttl).toMatch(/tla:completed[\s\S]*?skos:closeMatch <http:\/\/adlnet\.gov\/expapi\/verbs\/completed>/);
    // 'asserted' is a coined MOM verb — no fabricated adlnet.gov closeMatch.
    expect(ttl).not.toMatch(/adlnet\.gov\/expapi\/verbs\/asserted/);
    expect(ttl).not.toMatch(/adlnet\.gov\/expapi\/verbs\/inferred/);
  });
});

// ── MAJOR: unknown term IRIs return null (→ 404) in the hand-rolled renderers ────────────
describe('round-9 — hand-rolled term renderers 404 the unknown', () => {
  it('foxxi + ler/tla renderTermJsonLd return null for an unknown fragment', () => {
    expect(renderTermJsonLd('ZZ_no_such_term')).toBeNull();
    expect(renderSemTermJsonLd('tla', 'ZZ_no_such_term')).toBeNull();
    expect(renderSemTermJsonLd('ler', 'ZZ_no_such_term')).toBeNull();
    // A real term still resolves.
    expect(renderSemTermJsonLd('tla', 'Competency')).not.toBeNull();
  });
});

// ── MAJOR: adl-tla JSON-LD is faithful to the Turtle (scheme + closeMatch present) ───────
describe('round-9 — adl-tla JSON-LD carries the MOM scheme + verb alignments', () => {
  it('@graph includes MOMVerbScheme and the completed→adlnet closeMatch', () => {
    const j = renderSemOntologyJsonLd('tla') as { '@graph': Array<Record<string, unknown>> };
    const ids = j['@graph'].map(n => String(n['@id']));
    expect(ids.some(id => id.endsWith('#MOMVerbScheme'))).toBe(true);
    const completed = j['@graph'].find(n => String(n['@id']).endsWith('#completed'));
    expect(completed).toBeTruthy();
    expect((completed as any)['skos:closeMatch']['@id']).toBe('http://adlnet.gov/expapi/verbs/completed');
  });
});

// ── MAJOR: bbs proof is not mislabeled as the standard vc-di-bbs 'bbs-2023' ──────────────
describe('round-9 — BBS proof carries an honest (non-standard) cryptosuite id', () => {
  it('issued BBS credential proof.cryptosuite is not the standard bbs-2023', async () => {
    const out = await issueBbsCompletionCredential({
      subject: { learnerDid: 'did:key:z6Mkholder', learnerName: 'L', courseId: 'c1', courseTitle: 'Course 1', scoreScaled: 0.9, proficiencyLevel: 'Advanced', alignedSkills: [{ targetCode: 'S1', targetName: 'Skill 1' }] },
      tenantProfileName: 'Test Tenant', issuerSeed: 'round9-bbs-seed',
    });
    const proof = (out.credential as { proof?: { cryptosuite?: string } }).proof;
    expect(proof?.cryptosuite).toBeTruthy();
    expect(proof?.cryptosuite).not.toBe('bbs-2023');
  });
});
