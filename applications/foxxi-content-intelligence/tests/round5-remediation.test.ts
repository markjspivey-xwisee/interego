import { describe, it, expect } from 'vitest';
import { renderShacl, renderOwl } from '../src/spec-ontology.js';
import { SCORM_CAM_MODEL } from '../src/spec/scorm-cam.model.js';
import { OB3_MODEL } from '../src/spec/ler.model.js';
import { CMI5_MODEL } from '../src/spec/cmi5.model.js';
import { validateInstanceWith } from '../src/spec/index.js';
import { validateAgainstProfileTemplates } from '../src/xapi-profile.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { verifyDataIntegrityProof } from '../../_shared/vc-jwt/data-integrity-jcs.js';

const ADL = 'http://adlnet.gov/expapi/verbs';
const ACT = 'http://adlnet.gov/expapi/activities';
const conforms = (r: { violations: unknown[] }) => r.violations.length === 0;

// ── BLOCKER/MAJOR: the profile must cover the bridge's own emitters, still non-vacuous ──
describe("round-5 — profile covers SCORM/cmi5/mesh emitters (complete) yet stays non-vacuous", () => {
  it('SCORM course `failed` (object=course, contextKind=training, success:false) is conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/failed` },
      object: { id: 'https://x/course', objectType: 'Activity', definition: { type: `${ACT}/course` } },
      result: { success: false, completion: true, score: { scaled: 0.3 } },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'training' } },
    });
    expect(conforms(r)).toBe(true);
  });
  it('cmi5 lesson `completed` (object=lesson, no contextKind, result.completion) is conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/completed` },
      object: { id: 'https://x/au', objectType: 'Activity', definition: { type: `${ACT}/lesson` } },
      result: { completion: true },
    });
    expect(conforms(r)).toBe(true);
  });
  it('cmi5 lesson `passed`/`failed` (object=lesson, score) are conformant', () => {
    const passed = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/passed` },
      object: { id: 'https://x/au', objectType: 'Activity', definition: { type: `${ACT}/lesson` } },
      result: { success: true, score: { scaled: 0.9 } },
    });
    const failed = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/failed` },
      object: { id: 'https://x/au', objectType: 'Activity', definition: { type: `${ACT}/lesson` } },
      result: { success: false, score: { scaled: 0.2 } },
    });
    expect(conforms(passed)).toBe(true);
    expect(conforms(failed)).toBe(true);
  });
  it('mesh-projected `completed` (domain object type, contextKind=training, no result) is conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/completed` },
      object: { id: 'https://x/task', objectType: 'Activity', definition: { type: 'https://acme.example/Deploy' } },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'training', [`${FOXXI_NS}actorKind`]: 'agent' } },
    });
    expect(conforms(r)).toBe(true);
  });
  it('STILL non-vacuous: a completed with an unknown object type and NO contextKind is non-conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/completed` },
      object: { id: 'https://x/task', objectType: 'Activity', definition: { type: 'https://acme.example/Deploy' } },
    });
    expect(conforms(r)).toBe(false);
  });
  it('STILL non-vacuous: a failed with an unknown object type and NO contextKind is non-conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/failed` },
      object: { id: 'https://x/task', objectType: 'Activity', definition: { type: 'https://acme.example/Deploy' } },
    });
    expect(conforms(r)).toBe(false);
  });
});

// ── MAJOR: sh:class node-ness only (no over-reject of canonical-IRI-typed course) ──────
describe('round-5 — sh:class is node-ness only (authority/case safe)', () => {
  it('a course typed with the canonical xAPI course activity IRI is NOT over-rejected', () => {
    const r = validateInstanceWith(CMI5_MODEL, { type: 'CourseStructure', course: { type: `${ACT}/course`, id: 'https://x/c', title: [{ lang: 'en', text: 'C' }] }, structure: [{ id: 'https://x/au' }] });
    expect(r.results.some(x => x.path === 'course')).toBe(false);
  });
  it('a bare-string course is still rejected', () => {
    const r = validateInstanceWith(CMI5_MODEL, { type: 'CourseStructure', course: 'bare', structure: [{ id: 'https://x/au' }] });
    expect(r.results.some(x => x.path === 'course')).toBe(true);
  });
});

// ── MAJOR: `type` renders as a plain predicate (published == validator, satisfiable) ──
describe('round-5 — published SHACL treats `type` as a plain predicate, not rdf:type', () => {
  it('OB3 type constraints do NOT attach literals to rdf:type', () => {
    const sh = renderShacl(OB3_MODEL);
    expect(sh).not.toContain('sh:path rdf:type');
    expect(sh).toContain('sh:path ob3:type'); // hasValue "VerifiableCredential" is on ob3:type
  });
  it('SCORM-CAM resource `type` (a string) is not mapped to rdf:type', () => {
    const sh = renderShacl(SCORM_CAM_MODEL);
    expect(sh).not.toContain('sh:path rdf:type ; sh:datatype xsd:string');
  });
});

// ── MAJOR: SCORM-CAM OWL projection is now parseable Turtle ────────────────────────────
describe('round-5 — scorm-cam OWL has no illegal comma/space prefixed names', () => {
  it('TimeLimitAction members are slugged (valid PN_LOCAL); values preserved in labels', () => {
    const owl = renderOwl(SCORM_CAM_MODEL);
    expect(owl).not.toMatch(/scorm-cam:exit,message/);
    expect(owl).not.toMatch(/scorm-cam:continue,no message/);
    // Member IRIs are scheme-scoped (TimeLimitAction-exit-message) + slugged (valid PN_LOCAL).
    expect(owl).toContain('scorm-cam:TimeLimitAction-exit-message');
    expect(owl).toContain('"exit,message"'); // the real value survives as the label
  });
});

// ── MAJOR: verifyDataIntegrityProof never throws on a non-string proofValue ────────────
describe('round-5 — verifyDataIntegrityProof fails closed on a non-string proofValue', () => {
  it('a numeric proofValue returns verified:false and does NOT throw', () => {
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', created: '2026-07-01T00:00:00Z', proofPurpose: 'assertionMethod', verificationMethod: 'did:key:z6Mk#z6Mk', proofValue: 12345 };
    let r: ReturnType<typeof verifyDataIntegrityProof> | undefined;
    expect(() => { r = verifyDataIntegrityProof({ '@context': [], type: [], issuer: '', validFrom: '', credentialSubject: {}, proof: proof as never }); }).not.toThrow();
    expect(r!.verified).toBe(false);
  });
});
