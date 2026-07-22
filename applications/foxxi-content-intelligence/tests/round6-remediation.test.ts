import { describe, it, expect } from 'vitest';
import { validateAgainstProfileTemplates, verbRequiresObjectType, FOXXI_NS } from '../src/xapi-profile.js';
import { renderOwl } from '../src/spec-ontology.js';
import { SCORM_RTE_MODEL } from '../src/spec/scorm-rte.model.js';
import { verifyDataIntegrityProof, issuerId } from '../../_shared/vc-jwt/data-integrity-jcs.js';

const ADL = 'http://adlnet.gov/expapi/verbs';
const ACT = 'http://adlnet.gov/expapi/activities';
const ADLW3 = 'https://w3id.org/xapi/adl/verbs';
const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const conforms = (r: { violations: unknown[] }) => r.violations.length === 0;

// ── BLOCKER: cmi5 lifecycle statements are lesson-typed → templates must accept lesson ──
describe('round-6 — cmi5 lifecycle lesson-typed statements are conformant', () => {
  const lessonObj = { id: 'https://x/au', objectType: 'Activity', definition: { type: `${ACT}/lesson` } };
  const cmi5ctx = { registration: 'reg-1', contextActivities: { category: [{ id: CMI5_CAT }] } };
  it('launched (lesson, cmi5 category, registration) conforms', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/launched` }, object: lessonObj, context: cmi5ctx }))).toBe(true);
  });
  it('initialized/terminated (lesson) conform', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/initialized` }, object: lessonObj }))).toBe(true);
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/terminated` }, object: lessonObj }))).toBe(true);
  });
  it('satisfied (lesson) conforms', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADLW3}/satisfied` }, object: lessonObj }))).toBe(true);
  });
  it('launched WITHOUT the cmi5 category is now non-conformant (§5 determining property enforced)', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/launched` }, object: { id: 'https://x/c', objectType: 'Activity', definition: { type: `${ACT}/course` } }, context: { registration: 'r' } }))).toBe(false);
  });
});

// ── BLOCKER: performed with no substrate descriptor (external run) is conformant ────────
describe('round-6 — external-run performed (no substrateDescriptorIri) is conformant', () => {
  it('performed + ProductionTask + contextKind=production + actorKind=agent conforms', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${FOXXI_NS}performed` },
      object: { id: 'https://x/task', objectType: 'Activity', definition: { type: `${FOXXI_NS}ProductionTask` } },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'production', [`${FOXXI_NS}actorKind`]: 'agent' } },
    });
    expect(conforms(r)).toBe(true);
  });
});

// ── MAJOR: experienced+course / voided plain / mesh-failed all conformant ──────────────
describe('round-6 — experienced/voided/failed coverage', () => {
  it('experienced + course (generic instrumentation) conforms', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/experienced` }, object: { id: 'https://x/cat', objectType: 'Activity', definition: { type: `${ACT}/course` } } }))).toBe(true);
  });
  it('plain voided (StatementRef, no substrate cross-link) conforms', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/voided` }, object: { objectType: 'StatementRef', id: 'stmt-uuid' } }))).toBe(true);
  });
  it('a mesh-style failed (domain object, contextKind, success:false) conforms', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${ADL}/failed` }, object: { id: 'https://x/t', objectType: 'Activity', definition: { type: 'https://acme.example/Deploy' } }, result: { success: false }, context: { extensions: { [`${FOXXI_NS}contextKind`]: 'production' } } }))).toBe(true);
  });
});

// ── MINOR: previously-vacuous templates now enforce a discriminator ────────────────────
describe('round-6 — authored / policy-decided are no longer vacuous acceptors', () => {
  it('authored with NO object is non-conformant', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${FOXXI_NS}verbs/authored` }, object: {} }))).toBe(false);
  });
  it('policy-decided with NO policyId is non-conformant', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${FOXXI_NS}verbs/policy-decided` }, object: { id: 'x' }, context: { extensions: {} } }))).toBe(false);
  });
});

// ── verbRequiresObjectType (mesh verb-relay guard) ─────────────────────────────────────
describe('round-6 — verbRequiresObjectType data-driven guard', () => {
  it('a verb whose every template pins an object type returns true; performed (has unpinned) false', () => {
    expect(verbRequiresObjectType(`${FOXXI_NS}verbs/scene-completed`)).toBe(true);
    expect(verbRequiresObjectType(`${FOXXI_NS}performed`)).toBe(false); // performed-descriptor has no objectActivityType
  });
});

// ── BLOCKER: scorm-rte OWL is parseable Turtle (no illegal comma/space/leading-dash locals) ─
describe('round-6 — scorm-rte OWL has only Turtle-safe prefixed names', () => {
  it('no vocab member IRI contains a space, comma, or leading dash', () => {
    const owl = renderOwl(SCORM_RTE_MODEL);
    // Every `scorm-rte:<local>` prefixed name must be a valid PN_LOCAL.
    const bad = [...owl.matchAll(/scorm-rte:([^\s;,]*[^\sA-Za-z0-9_.:-][^\s;,]*)/g)].map(m => m[1]);
    expect(bad).toEqual([]);
    expect(owl).not.toMatch(/scorm-rte:-/); // no leading-dash local like `-1`
  });
});

// ── MAJOR/MINOR: crypto — object-form issuer + proofPurpose ─────────────────────────────
describe('round-6 — Data Integrity: issuerId + proofPurpose', () => {
  it('issuerId extracts the DID from a string OR an object issuer', () => {
    expect(issuerId('did:key:z6Mk')).toBe('did:key:z6Mk');
    expect(issuerId({ id: 'did:key:z6Mk', type: 'Profile', name: 'X' })).toBe('did:key:z6Mk');
    expect(issuerId(undefined)).toBe('');
  });
  it('a proof with proofPurpose != assertionMethod is rejected (VC-DI §4.3)', () => {
    const proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', proofPurpose: 'authentication', verificationMethod: 'did:key:z6Mk#z6Mk', proofValue: 'z' + 'A'.repeat(88) };
    const r = verifyDataIntegrityProof({ '@context': [], type: [], issuer: 'did:key:z6Mk', validFrom: '', credentialSubject: {}, proof: proof as never });
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(/proofPurpose/);
  });
});
