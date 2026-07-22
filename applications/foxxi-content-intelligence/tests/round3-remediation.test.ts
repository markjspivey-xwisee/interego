import { describe, it, expect } from 'vitest';
import { renderShacl } from '../src/spec-ontology.js';
import { LER_MODEL, OB3_MODEL, CLR_MODEL, validateLerInstance } from '../src/spec/ler.model.js';
import { validateInstanceWith } from '../src/spec/index.js';
import { exportClr } from '../src/clr.js';
import { validateStatement } from '../src/xapi-validate.js';
import { validateAgainstProfileTemplates } from '../src/xapi-profile.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
const COMPLETED = 'http://adlnet.gov/expapi/verbs/completed';

describe('round-3 remediation — LER/credential shapes', () => {
  it('renderShacl emits NO phantom sh:path for @context / dotted paths', () => {
    const sh = renderShacl(OB3_MODEL);
    // Phantom dotted/keyword predicates must NOT be published.
    expect(sh).not.toContain('sh:path ob3:@context');
    expect(sh).not.toContain('sh:path ob3:credentialSubject.id');
    // @context (a JSON-LD keyword, consumed before the RDF graph) is documented.
    expect(sh).toContain('JSON-LD-keyword requirements');
    // Nested paths are now MACHINE-CHECKABLE SHACL (as strong as the validator), not comments:
    expect(sh).toContain('sh:path ob3:credentialSubject'); // credentialSubject.id → parent path + nodeKind IRI
    expect(sh).toContain('sh:path ( ob3:proof ob3:type )'); // proof.type → sh:sequence path (type is a plain predicate, not rdf:type — matches the JSON validator)
  });

  it('OB3 rejects a credential missing the VC-DM 2.0 @context (hasValue)', () => {
    const bad = {
      '@context': ['https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json'],
      type: ['VerifiableCredential', 'OpenBadgeCredential'],
      issuer: 'did:key:z6Mk', validFrom: '2026-07-01T00:00:00Z',
      credentialSubject: { id: 'did:key:z6Mkholder', achievement: { type: ['Achievement'], name: 'X' } },
      proof: { type: 'DataIntegrityProof' },
    };
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
