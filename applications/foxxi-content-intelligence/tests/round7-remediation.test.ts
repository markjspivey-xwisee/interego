import { describe, it, expect } from 'vitest';
import { renderVocabTurtle } from '../src/foxxi-vocab.js';
import { renderSemOntologyTurtle } from '../src/ler-tla-vocab.js';
import { renderOwl, renderJsonLd } from '../src/spec-ontology.js';
import { CMI5_MODEL } from '../src/spec/cmi5.model.js';
import { SCORM_SN_MODEL } from '../src/spec/scorm-sn.model.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { validateAgainstProfileTemplates, FOXXI_NS } from '../src/xapi-profile.js';

const ADL = 'http://adlnet.gov/expapi/verbs';
const ACT = 'http://adlnet.gov/expapi/activities';
const conforms = (r: { violations: unknown[] }) => r.violations.length === 0;

// A CURIE local part must not contain '/', spaces, or a leading '-' — those made the doc
// unparseable. Path-structured / illegal names must be emitted as full <...> IRIs instead.
const illegalCuries = (ttl: string, prefix: string): string[] =>
  [...ttl.matchAll(new RegExp(`(?:^|[\\s;,\\[])${prefix}:([^\\s;,\\]<>"]+)`, 'g'))]
    .map(m => m[1]).filter(local => /[/\s]/.test(local) || /^[-.]/.test(local));

describe('round-7 — hand-rolled Turtle renderers emit only valid prefixed names', () => {
  it('/ns/foxxi (renderVocabTurtle): path-structured verb/activity terms are NOT illegal CURIEs', () => {
    const ttl = renderVocabTurtle();
    expect(illegalCuries(ttl, 'foxxi')).toEqual([]);
    // The path-structured term is emitted as a full IRI, preserving its identity.
    expect(ttl).toContain(`<${FOXXI_NS}verbs/scene-completed>`);
  });
  it('/ns/adl-tla (renderMomTurtle/renderTermTurtle): activity-type/extension concepts are NOT illegal CURIEs', () => {
    const ttl = renderSemOntologyTurtle('tla');
    expect(illegalCuries(ttl, 'tla')).toEqual([]);
  });
  it('MOM skos:member is on the level Collection (Collection→member), not inverted on the verb', () => {
    const ttl = renderSemOntologyTurtle('tla');
    // The MOMLevel1 collection lists its member verbs.
    expect(ttl).toMatch(/tla:MOMLevel1 a skos:Collection[\s\S]*?skos:member/);
    // The verb concept no longer asserts the level as ITS member.
    expect(ttl).not.toMatch(/skos:member tla:MOMLevel\d/);
  });
});

describe('round-7 — SKOS member IRIs are scheme-scoped (no cross-scheme collisions)', () => {
  it('cmi5 moveon category and moveon extension get DISTINCT IRIs', () => {
    const owl = renderOwl(CMI5_MODEL);
    // No bare cmi5:moveon subject shared by two schemes; each is scheme-scoped.
    const bareMoveon = [...owl.matchAll(/^cmi5:moveon a skos:Concept/gm)];
    expect(bareMoveon.length).toBeLessThanOrEqual(1);
  });
  it('scorm-sn RollupAction ConceptScheme IRI does not collide with the RollupAction owl:Class', () => {
    const owl = renderOwl(SCORM_SN_MODEL);
    expect(owl).toContain('scorm-sn:RollupAction a owl:Class');
    expect(owl).toContain('scorm-sn:RollupActionValues a skos:ConceptScheme');
    expect(owl).not.toContain('scorm-sn:RollupAction a skos:ConceptScheme');
  });
});

describe('round-7 — JSON-LD projection carries real triples (@graph)', () => {
  it('renderJsonLd puts the ontology + classes + properties in a flat @graph', () => {
    const j = renderJsonLd(XAPI_MODEL) as any;
    expect(Array.isArray(j['@graph'])).toBe(true);
    expect(j['@graph'].some((n: any) => n['@type'] === 'owl:Class')).toBe(true);
    expect(j['@graph'].some((n: any) => n['@type'] === 'owl:ObjectProperty' || n['@type'] === 'owl:DatatypeProperty')).toBe(true);
  });
});

describe('round-7 — profile covers the `interacted` verb + stronger discriminators', () => {
  it('interacted + interaction (Context Companion) conforms', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/interacted` },
      object: { id: 'https://x/q', objectType: 'Activity', definition: { type: `${ACT}/interaction` } },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'performance-support' } },
    });
    expect(conforms(r)).toBe(true);
  });
  it('authored requires object.definition.type (not just object.id)', () => {
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${FOXXI_NS}verbs/authored` }, object: { id: 'https://x/a' } }))).toBe(false);
    expect(conforms(validateAgainstProfileTemplates({ verb: { id: `${FOXXI_NS}verbs/authored` }, object: { id: 'https://x/a', definition: { type: `${FOXXI_NS}activities/credential` } } }))).toBe(true);
  });
  it('production completed with an OFF-vocabulary contextKind (banana) is now non-conformant', () => {
    const r = validateAgainstProfileTemplates({
      verb: { id: `${ADL}/completed` },
      object: { id: 'https://x/t', objectType: 'Activity', definition: { type: `${FOXXI_NS}activities/credential` } },
      context: { extensions: { [`${FOXXI_NS}contextKind`]: 'banana' } },
    });
    expect(conforms(r)).toBe(false);
  });
});
