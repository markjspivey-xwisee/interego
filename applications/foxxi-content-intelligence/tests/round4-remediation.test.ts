import { describe, it, expect } from 'vitest';
import { validateInstanceWith } from '../src/spec/index.js';
import { OB3_MODEL, LER_MODEL } from '../src/spec/ler.model.js';
import { CMI5_MODEL } from '../src/spec/cmi5.model.js';
import { validateAgainstProfileTemplates } from '../src/xapi-profile.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { canonicalizeJcs, verifyDataIntegrityProof } from '../../_shared/vc-jwt/data-integrity-jcs.js';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
const COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';
const FAILED = 'http://adlnet.gov/expapi/verbs/failed';
const COURSE = 'http://adlnet.gov/expapi/activities/course';

// ── BLOCKER: production-performance templates must NOT be universal acceptors ────
describe('round-4 — profile production templates discriminate on contextKind (no vacuous pass)', () => {
  it('a `completed` with a course object type but NO contextKind and NO result.completion is NON-conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: COMPLETED },
      object: { id: 'https://ex.org/a', objectType: 'Activity', definition: { type: COURSE } },
    });
    expect(r.conforms ?? r.violations.length === 0).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it('the entire `failed` verb is rejectable — a bare failed (no contextKind) is NON-conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: FAILED },
      object: { id: 'https://ex.org/a', objectType: 'Activity', definition: { type: 'http://adlnet.gov/expapi/activities/lesson' } },
    });
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it('a genuine production `completed` (contextKind=production, actorKind, result.success=true) STILL conforms', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: COMPLETED },
      object: { id: `${BRIDGE}/task/1`, objectType: 'Activity', definition: { type: 'urn:acme:Deploy' } },
      result: { success: true },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'production', [`${FOXXI_NS}actorKind`]: 'agent' } },
    });
    expect(r.violations).toHaveLength(0);
  });

  it('a plain course `completed` WITH result.completion (no contextKind) still conforms via the course template', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: COMPLETED },
      object: { id: 'https://ex.org/course/1', objectType: 'Activity', definition: { type: COURSE } },
      result: { completion: true },
    });
    expect(r.violations).toHaveLength(0);
  });
});

// ── BLOCKER: verifyDataIntegrityProof must never throw (unauthenticated endpoint) ─
describe('round-4 — verifyDataIntegrityProof fails closed instead of throwing', () => {
  const proofBase = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-07-01T00:00:00Z', proofPurpose: 'assertionMethod', proofValue: 'z' + 'A'.repeat(88) };
  it('a proof missing verificationMethod returns verified:false, does NOT throw', () => {
    let r: ReturnType<typeof verifyDataIntegrityProof> | undefined;
    expect(() => { r = verifyDataIntegrityProof({ '@context': [], type: [], issuer: '', validFrom: '', credentialSubject: {}, proof: proofBase as never }); }).not.toThrow();
    expect(r!.verified).toBe(false);
  });
  it('a non-string verificationMethod returns verified:false, does NOT throw', () => {
    const proof = { ...proofBase, verificationMethod: 12345 };
    expect(() => verifyDataIntegrityProof({ '@context': [], type: [], issuer: '', validFrom: '', credentialSubject: {}, proof: proof as never })).not.toThrow();
  });
});

// ── MAJOR: canonicalizeJcs must omit undefined-valued keys (JSON semantics) ───────
describe('round-4 — canonicalizeJcs omits undefined keys (so CLR signing never crashes)', () => {
  it('does not throw on an undefined-valued key and matches the key-absent form', () => {
    expect(() => canonicalizeJcs({ a: 1, b: undefined })).not.toThrow();
    expect(canonicalizeJcs({ a: 1, b: undefined })).toBe(canonicalizeJcs({ a: 1 }));
    // nested (the CLR credentialEntries case: verifierReason:undefined)
    expect(() => canonicalizeJcs({ entries: [{ verified: true, verifierReason: undefined }] })).not.toThrow();
  });
});

// ── MAJOR: sh:class must be enforced (published shape == validator strength) ───────
describe('round-4 — sh:class is enforced by validateAgainstShape', () => {
  it('a cmi5 CourseStructure whose `course` is a bare string is NON-conformant', () => {
    const r = validateInstanceWith(CMI5_MODEL, { type: 'CourseStructure', course: 'not-a-Course-object', structure: [{ id: 'https://x/au' }] });
    expect(r.conforms).toBe(false);
    expect(r.results.some(x => x.path === 'course')).toBe(true);
  });
  it('a cmi5 CourseStructure whose `course` is an object node does not draw the sh:class violation', () => {
    const r = validateInstanceWith(CMI5_MODEL, { type: 'CourseStructure', course: { id: 'https://x/course', title: [{ lang: 'en', text: 'C' }] }, structure: [{ id: 'https://x/au' }] });
    expect(r.results.some(x => x.path === 'course' && /instance of/.test(x.message))).toBe(false);
  });
});

// ── MINOR: @context ordering (VC-DM 2.0 §4.1 — v2 MUST be first) ──────────────────
describe('round-4 — @context ordering is enforced (firstValue)', () => {
  const ob3 = (ctx: string[]) => ({
    '@context': ctx, type: ['VerifiableCredential', 'OpenBadgeCredential'],
    issuer: 'did:key:z6Mk', validFrom: '2026-07-01T00:00:00Z',
    credentialSubject: { id: 'did:key:z6Mkholder', achievement: { type: ['Achievement'], name: 'X' } },
    proof: { type: 'DataIntegrityProof' },
  });
  it('rejects v2 NOT in first position', () => {
    const r = validateInstanceWith(OB3_MODEL, ob3(['https://example.org/other', 'https://www.w3.org/ns/credentials/v2']));
    expect(r.conforms).toBe(false);
    expect(r.results.some(x => x.path === '@context')).toBe(true);
  });
  it('accepts v2 first', () => {
    const r = validateInstanceWith(OB3_MODEL, ob3(['https://www.w3.org/ns/credentials/v2', 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json']));
    expect(r.results.some(x => x.path === '@context')).toBe(false);
  });
});

// ── MINOR: authority-aware routing (everything-is-a-URL) ──────────────────────────
describe('round-4 — type routing is authority-aware', () => {
  const fields = {
    subject: `${BRIDGE}/agents/x`, aboutCompetency: `${BRIDGE}/comp/1`,
    proficiencyLevel: `${BRIDGE}/ns/adl-tla#Proficient`, confidence: 0.5,
    rolledUpBy: `${BRIDGE}/rules/1`, assertingAgent: `${BRIDGE}/agents/asserter`,
    evidence: `${BRIDGE}/rec/1`, basis: 'performance', modalStatus: 'Asserted',
  };
  it('a foreign-namespace @type sharing the local name "Assertion" does NOT get a clean CompetencyAssertion pass', () => {
    const r = validateInstanceWith(LER_MODEL, { '@type': ['https://evil.example/x#Assertion'], ...fields });
    expect(r.conforms).toBe(false); // routes nowhere by authority → no-vacuous-pass runs all shapes → fails ELR/Evidence
  });
  it('the genuine bridge-authority tla:Assertion IRI still routes to CompetencyAssertionShape and conforms', () => {
    const r = validateInstanceWith(LER_MODEL, { '@type': [`${BRIDGE}/ns/adl-tla#Assertion`], ...fields });
    expect(r.conforms).toBe(true);
  });
});
