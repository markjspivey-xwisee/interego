import { describe, it, expect } from 'vitest';
import { buildFoxxiProfileDoc } from '../src/xapi-profile.js';
import { renderSemOntologyTurtle, renderSemOntologyJsonLd } from '../src/ler-tla-vocab.js';
import { renderJsonLd } from '../src/spec-ontology.js';
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
    const ttl = renderSemOntologyTurtle('ler');
    // Round-11 corrected the targets to the CANONICAL, dereferenceable vocab.html class IRIs
    // (the /spec/{ob/v3p0,clr/v2p0}/… paths 404). closeMatch (not exactMatch) still holds.
    expect(ttl).toMatch(/skos:closeMatch <https:\/\/purl\.imsglobal\.org\/spec\/vc\/clr\/vocab\.html#ClrCredential>/);
    expect(ttl).toMatch(/skos:closeMatch <https:\/\/purl\.imsglobal\.org\/spec\/vc\/ob\/vocab\.html#OpenBadgeCredential>/);
    // No exactMatch (strict identity) to the IMS credential types.
    expect(ttl).not.toMatch(/skos:exactMatch <https:\/\/purl\.imsglobal\.org\/spec\/(vc\/)?(ob|clr)/);
  });
});

// ── MAJOR: ler/tla JSON-LD is faithful to the Turtle (domain/range/closeMatch carried) ───
describe('round-10 — ler/tla JSON-LD carries domain/range/closeMatch (faithful to Turtle)', () => {
  it('ieee-ler @graph has property nodes with rdfs:domain/range', () => {
    const j = renderSemOntologyJsonLd('ler') as { '@graph': Array<Record<string, unknown>> };
    const withDomain = j['@graph'].filter(n => 'domain' in n);
    expect(withDomain.length).toBeGreaterThan(0);
    const withRange = j['@graph'].filter(n => 'range' in n);
    expect(withRange.length).toBeGreaterThan(0);
    // The Credential class carries a closeMatch to OB3 (not exactMatch).
    const cred = j['@graph'].find(n => String(n['@id']).endsWith('#Credential'));
    expect(cred && (cred as any).closeMatch).toBeTruthy();
    expect(cred && (cred as any).exactMatch).toBeFalsy();
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
  it('every @graph node has rdfs:isDefinedBy pointing at the ontology', () => {
    const j = renderJsonLd(XAPI_MODEL) as { '@graph': Array<Record<string, unknown>> };
    for (const n of j['@graph']) {
      expect(n['rdfs:isDefinedBy']).toBeTruthy();
    }
  });
});
