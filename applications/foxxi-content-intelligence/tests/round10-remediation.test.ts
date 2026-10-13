import { describe, it, expect } from 'vitest';
import { buildFoxxiProfileDoc } from '../src/xapi-profile.js';
import { renderSemOntologyTurtle, renderSemOntologyJsonLd, LER_NS } from '../src/ler-tla-vocab.js';
import { renderJsonLd, ontologyIri } from '../src/spec-ontology.js';
import { jsonLdQuads, turtleQuads, iriObjectsOf, RDFS, SKOS } from './support/ns-graph.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';

// ── MAJOR: published profile satisfies Profile spec §5 (type + inScheme everywhere) ──────
describe('round-10 — profile Concepts/Templates/Patterns carry type + inScheme (spec §5)', () => {
  const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-01T00:00:00Z' }) as {
    id: string;
    concepts: Array<Record<string, unknown>>;
    templates: Array<Record<string, unknown>>;
    patterns: Array<Record<string, unknown>>;
  };
  const versionId = `${doc.id}/v/1`;
  it('every template has type=StatementTemplate + inScheme', () => {
    for (const t of doc.templates) {
      expect(t.type).toBe('StatementTemplate');
      expect(t.inScheme).toBe(versionId);
    }
  });
  it('every pattern has type=Pattern + inScheme', () => {
    for (const p of doc.patterns) {
      expect(p.type).toBe('Pattern');
      expect(p.inScheme).toBe(versionId);
    }
  });
  it('every concept has a type + inScheme', () => {
    for (const c of doc.concepts) {
      expect(c.type).toBeTruthy();
      expect(c.inScheme).toBe(versionId);
    }
  });
});

// ── MINOR: IEEE-LER exactMatch→closeMatch to the IMS credential types (no false identity) ─
describe('round-10 — IEEE-LER uses closeMatch (not exactMatch) to IMS credential types', () => {
  it('the Transcript/Credential alignments to OB3/CLR are skos:closeMatch', () => {
    // ★ REVISED: read as triples. 1EdTech's vocabularies now have prefixes (ob:, clr:), so the
    // Turtle prints these IRIs compactly and the old text match saw nothing.
    const q = turtleQuads(renderSemOntologyTurtle('ler'));
    // Round-11 corrected the targets to the CANONICAL, dereferenceable vocab.html class IRIs
    // (the /spec/{ob/v3p0,clr/v2p0}/… paths 404). closeMatch (not exactMatch) still holds.
    const closeTargets = q.filter(t => t.predicate.value === `${SKOS}closeMatch`).map(t => t.object.value);
    expect(closeTargets).toContain('https://purl.imsglobal.org/spec/vc/clr/vocab.html#ClrCredential');
    expect(closeTargets).toContain('https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential');
    // No exactMatch (strict identity) to the IMS credential types.
    const exactTargets = q.filter(t => t.predicate.value === `${SKOS}exactMatch`).map(t => t.object.value);
    expect(exactTargets.filter(o => /^https:\/\/purl\.imsglobal\.org\/spec\/(vc\/)?(ob|clr)/.test(o))).toEqual([]);
  });
});

// ── MAJOR: ler/tla JSON-LD is faithful to the Turtle (domain/range/closeMatch carried) ───
describe('round-10 — ler/tla JSON-LD carries domain/range/closeMatch (faithful to Turtle)', () => {
  it('ieee-ler @graph has property nodes with rdfs:domain/range', async () => {
    const q = await jsonLdQuads(renderSemOntologyJsonLd('ler'));
    expect(q.some(x => x.predicate.value === `${RDFS}domain`)).toBe(true);
    expect(q.some(x => x.predicate.value === `${RDFS}range`)).toBe(true);
    // The Credential class carries a closeMatch to OB3 (not exactMatch).
    expect(iriObjectsOf(q, `${LER_NS}Credential`, `${SKOS}closeMatch`)).toContain('https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential');
    expect(iriObjectsOf(q, `${LER_NS}Credential`, `${SKOS}exactMatch`)).toEqual([]);
  });
  it('the JSON-LD @context maps domain/range/closeMatch/inScheme to @id', () => {
    const j = renderSemOntologyJsonLd('tla') as { '@context': Record<string, any> };
    expect(j['@context'].domain['@type']).toBe('@id');
    expect(j['@context'].range['@type']).toBe('@id');
    expect(j['@context'].closeMatch['@type']).toBe('@id');
  });
});

// ── MINOR: spec-ontology JSON-LD carries rdfs:isDefinedBy on every node ──────────────────
describe('round-10 — spec-ontology JSON-LD carries rdfs:isDefinedBy (faithful)', () => {
  // ★ REVISED SCOPE. "Every @graph node" now includes the ontology header node, the blank nodes
  // of union class expressions, and the declarations of EXTERNAL terms the document uses (MIREOT)
  // — none of which this ontology defines, so none may claim rdfs:isDefinedBy it. The intent is
  // that every term the ontology MINTS points back at it; that is checked on the triples.
  it('every @graph node has rdfs:isDefinedBy pointing at the ontology', async () => {
    const q = await jsonLdQuads(renderJsonLd(XAPI_MODEL));
    const onto = ontologyIri(XAPI_MODEL);
    const own = [...new Set(q.filter(x => x.subject.termType === 'NamedNode' && x.subject.value.startsWith(`${onto}#`)).map(x => x.subject.value))];
    expect(own.length).toBeGreaterThan(20);
    for (const s of own) expect(iriObjectsOf(q, s, `${RDFS}isDefinedBy`), s).toEqual([onto]);
  });
});
