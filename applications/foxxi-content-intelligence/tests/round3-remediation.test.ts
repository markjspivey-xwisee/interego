import { describe, it, expect } from 'vitest';
import { renderShacl } from '../src/spec-ontology.js';
import { LER_MODEL, OB3_MODEL, CLR_MODEL, validateLerInstance } from '../src/spec/ler.model.js';
import { validateInstanceWith } from '../src/spec/index.js';
import { exportClr } from '../src/clr.js';
import { validateStatement } from '../src/xapi-validate.js';
import { validateAgainstProfileTemplates } from '../src/xapi-profile.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { turtleQuads, iriObjectsOf } from './support/ns-graph.js';

const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
/** A complete Open Badges 3.0 credential (OB 3.0 Appendix B), with an embedded proof. */
const GOOD_OB3 = {
  '@context': ['https://www.w3.org/ns/credentials/v2', 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json'],
  id: 'urn:uuid:3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  issuer: 'did:key:z6Mk', validFrom: '2026-07-01T00:00:00Z',
  credentialSubject: {
    id: 'did:key:z6Mkholder', type: ['AchievementSubject'],
    achievement: { id: 'https://issuer.example/a/1', type: ['Achievement'], name: 'X', description: 'An achievement.', criteria: { narrative: 'Do X.' } },
  },
  proof: { type: 'DataIntegrityProof' },
};
const COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';

describe('round-3 remediation — LER/credential shapes', () => {
  it('renderShacl emits NO phantom sh:path for @context / dotted paths', () => {
    // ★ REVISED: checked over the parsed shapes graph rather than the Turtle text. The paths are
    // now 1EdTech's and W3C's own predicates (ob:, vc:, schema:), not this document's invented
    // ob3: terms, and VC 2.0 puts a credential's proof in a graph of its own, so proof.type has
    // no path from the credential and is listed with the other JSON-document requirements.
    const sh = renderShacl(OB3_MODEL);
    const q = turtleQuads(sh);
    const SH = 'http://www.w3.org/ns/shacl#';
    const shape = 'https://foxxi-bridge.interego.xwisee.com/ns/ob3/shapes#OpenBadgeCredentialShape';
    const propertyShapes = q.filter(t => t.subject.value === shape && t.predicate.value === `${SH}property`).map(t => t.object.value);
    const pathOf = (ps: string) => q.find(t => t.subject.value === ps && t.predicate.value === `${SH}path`)!.object;
    // Every IRI used anywhere as a path step: none is a JSON keyword or a dotted JSON path.
    const iriSteps = q.filter(t => t.object.termType === 'NamedNode' && (t.predicate.value === `${SH}path` || t.predicate.value === RDF_FIRST)).map(t => t.object.value);
    const localName = (iri: string) => iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
    expect(iriSteps.length).toBeGreaterThan(0);
    expect(iriSteps.filter(iri => /[.@]/.test(localName(iri)))).toEqual([]);
    // @context (a JSON-LD keyword, consumed before the RDF graph) is documented.
    expect(sh).toContain('JSON-LD-keyword requirements');
    // ★ REVISED AGAIN: OB 3.0 makes a proof optional (proof [0..*]) — a credential secured by an
    // enveloping proof carries none — so no proof requirement is published, in either reading; and
    // a subject is identified by its id OR an identifier, which the subject's own shape states as
    // sh:or (credentials-the-specs-allow-conform-in-both-readings.test.ts checks both readings).
    expect(sh).not.toContain('proof.type');
    const subjectShape = 'https://foxxi-bridge.interego.xwisee.com/ns/ob3/shapes#AchievementSubjectShape';
    const or = q.find(t => t.subject.value === subjectShape && t.predicate.value === `${SH}or`)!.object.value;
    const listItems = (head: string): string[] => {
      const out: string[] = [];
      for (let node = head; node !== RDF_NIL;) {
        out.push(q.find(t => t.subject.value === node && t.predicate.value === RDF_FIRST)!.object.value);
        node = q.find(t => t.subject.value === node && t.predicate.value === RDF_REST)!.object.value;
      }
      return out;
    };
    const [byIri, byIdentifier] = listItems(or);
    expect(iriObjectsOf(q, byIri!, `${SH}nodeKind`)).toEqual([`${SH}IRI`]);
    expect(iriObjectsOf(q, byIdentifier!, `${SH}path`)).toEqual(['https://purl.imsglobal.org/spec/vc/ob/vocab.html#identifier']);
    // Nested paths are MACHINE-CHECKABLE SHACL (as strong as the validator), not comments:
    // credentialSubject.type → an sh:sequence path (vc:credentialSubject rdf:type).
    const sequences = propertyShapes.map(pathOf).filter(p => p.termType === 'BlankNode');
    const listOf = (head: string): string[] => {
      const out: string[] = [];
      for (let node = head; node !== RDF_NIL;) {
        out.push(q.find(t => t.subject.value === node && t.predicate.value === RDF_FIRST)!.object.value);
        node = q.find(t => t.subject.value === node && t.predicate.value === RDF_REST)!.object.value;
      }
      return out;
    };
    expect(sequences.map(p => listOf(p.value))).toContainEqual([
      'https://www.w3.org/2018/credentials#credentialSubject',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    ]);
  });

  it('a proof is optional, as OB 3.0 has it — and a credential is checked without one', () => {
    // ★ REVISED: this asserted that the validator required a typed proof. OB 3.0 makes a proof
    // optional (proof [0..*]): a credential secured by an enveloping proof (VC-JOSE-COSE, VC-JWT)
    // carries none, and an embedded proof is a graph of its own, which Data Integrity verification
    // checks. So a complete credential conforms with a typed proof and without one.
    expect(validateInstanceWith(OB3_MODEL, GOOD_OB3).conforms).toBe(true);
    const { proof: _proof, ...enveloped } = GOOD_OB3;
    expect(validateInstanceWith(OB3_MODEL, enveloped).conforms).toBe(true);
  });

  it('OB3 rejects a credential missing the VC-DM 2.0 @context (hasValue)', () => {
    const bad = { ...GOOD_OB3, '@context': ['https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json'] };
    const r = validateInstanceWith(OB3_MODEL, bad);
    expect(r.conforms).toBe(false);
    expect(r.results.some(x => x.path === '@context')).toBe(true);
  });

  it('confidence is checked as a numeric [0,1] (xsd:double)', () => {
    const assertion = {
      '@type': [`${BRIDGE}/ns/ieee-ler#CompetencyAssertion`],
      subject: `${BRIDGE}/agents/x`, aboutCompetency: `${BRIDGE}/comp/1`,
      proficiencyLevel: `${BRIDGE}/ns/adl-tla#Proficient`, confidence: 1.4,
      rolledUpBy: `${BRIDGE}/rules/1`, assertingAgent: `${BRIDGE}/agents/asserter`,
      evidence: `${BRIDGE}/rec/1`, basis: 'performance', modalStatus: 'Asserted',
    };
    const r = validateLerInstance(assertion);
    expect(r.results.some(x => x.path === 'confidence')).toBe(true); // 1.4 > maxInclusive 1
  });

  it('deref IRIs must be https (a did: proficiencyLevel is rejected)', () => {
    const assertion = {
      '@type': [`${BRIDGE}/ns/ieee-ler#CompetencyAssertion`],
      subject: `${BRIDGE}/agents/x`, aboutCompetency: `${BRIDGE}/comp/1`,
      proficiencyLevel: 'did:example:not-a-url', confidence: 0.5,
      rolledUpBy: `${BRIDGE}/rules/1`, assertingAgent: `${BRIDGE}/agents/asserter`,
      evidence: `${BRIDGE}/rec/1`, basis: 'performance', modalStatus: 'Asserted',
    };
    const r = validateLerInstance(assertion);
    expect(r.results.some(x => x.path === 'proficiencyLevel')).toBe(true);
  });
});

describe('round-3 remediation — equivalentClass routing', () => {
  it('a tla:Assertion routes to CompetencyAssertionShape only (no spurious Evidence/ELR violations)', () => {
    const tlaAssertion = {
      '@type': [`${BRIDGE}/ns/adl-tla#Assertion`],
      subject: `${BRIDGE}/agents/x`, aboutCompetency: `${BRIDGE}/comp/1`,
      proficiencyLevel: `${BRIDGE}/ns/adl-tla#Proficient`, confidence: 0.5,
      rolledUpBy: `${BRIDGE}/rules/1`, assertingAgent: `${BRIDGE}/agents/asserter`,
      evidence: `${BRIDGE}/rec/1`, basis: 'performance', modalStatus: 'Asserted',
    };
    const r = validateInstanceWith(LER_MODEL, tlaAssertion);
    // A fully-formed assertion typed as tla:Assertion must CONFORM (routed to the
    // equivalent CompetencyAssertionShape), not draw ELR/Evidence-shape violations.
    expect(r.conforms).toBe(true);
  });
});

describe('round-3 remediation — mbox IFI regex (§4.1.2.1)', () => {
  const base = {
    id: '12345678-1234-1234-1234-1234567890ab',
    verb: { id: COMPLETED }, object: { id: 'http://x/1', objectType: 'Activity' },
    timestamp: '2026-07-01T00:00:00Z', version: '2.0.0',
  };
  it('accepts a clean mailto mbox', () => {
    const errs = validateStatement({ ...base, actor: { objectType: 'Agent', mbox: 'mailto:a@example.org' } });
    expect(errs.some(e => /mbox/i.test(e))).toBe(false);
  });
  it('rejects an mbox carrying whitespace / a newline (old unanchored regex let it pass)', () => {
    const errs = validateStatement({ ...base, actor: { objectType: 'Agent', mbox: 'mailto:a@example.org\n' } });
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('round-3 remediation — profile production template is a catch-all for MOM completed', () => {
  it('a DOMAIN-typed production completed (not foxxi:ProductionTask) fully satisfies a template', () => {
    const stmt = {
      verb: { id: COMPLETED },
      // A creator-declared DOMAIN activity type — the old template pinned
      // objectActivityType=foxxi:ProductionTask and REJECTED this real emitter output.
      object: { id: `${BRIDGE}/task/1`, objectType: 'Activity', definition: { type: 'urn:acme:Deploy' } },
      result: { success: true },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'production', [`${FOXXI_NS}actorKind`]: 'agent' } },
    };
    const r = validateAgainstProfileTemplates(stmt);
    expect(r.verbDeclared).toBe(true);
    expect(r.applicable).toBe(true);
    expect(r.violations).toHaveLength(0); // at least one matched template is fully satisfied
  });
});

describe('round-3 remediation — CLR fail-closed VC typing', () => {
  it('an unsigned CLR is NOT typed VerifiableCredential (and fails ClrCredentialShape)', async () => {
    // No pod fetch: discover() over a bogus URL yields no entries; the aggregate is empty
    // + unsigned (no issuerSeed), so it must carry the foxxi aggregation type, not VC.
    const env = await exportClr({
      learnerPodUrl: 'https://example.invalid/pod/',
      learnerDid: 'did:key:z6Mkholder',
      fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });
    expect(env.type).not.toContain('VerifiableCredential');
    expect(env.type).not.toContain('ClrCredential');
    expect((env as { proof?: unknown }).proof).toBeUndefined();
    // And the published CLR shape rejects it (it is not a verifiable credential).
    const r = validateInstanceWith(CLR_MODEL, env as unknown as Record<string, unknown>);
    expect(r.conforms).toBe(false);
  });
});
