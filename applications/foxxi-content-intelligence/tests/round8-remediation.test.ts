import { describe, it, expect } from 'vitest';
import { renderVocabJsonLd, renderVocabHtml } from '../src/foxxi-vocab.js';
import { renderSemOntologyJsonLd, renderSemOntologyHtml } from '../src/ler-tla-vocab.js';
import { renderTermJsonLd } from '../src/spec-ontology.js';
import { CMI5_MODEL } from '../src/spec/cmi5.model.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { verbIsDeclared, verbRequiresObjectType, FOXXI_NS } from '../src/xapi-profile.js';
import { validateXapiStatement } from '../src/spec/index.js';

// ── MAJOR: hand-rolled JSON-LD now uses @graph (real triples on expansion) ─────────────
describe('round-8 — foxxi/ieee-ler/adl-tla JSON-LD carries a @graph', () => {
  it('renderVocabJsonLd (foxxi) has @graph with term nodes, not a bare terms array', () => {
    const j = renderVocabJsonLd() as any;
    expect(Array.isArray(j['@graph'])).toBe(true);
    expect(j.terms).toBeUndefined();
    expect(j['@graph'].length).toBeGreaterThan(1);
    expect(j['@graph'].some((n: any) => String(n['@type']).includes('Verb'))).toBe(true);
  });
  it('renderSemOntologyJsonLd (ler + tla) has @graph, not a bare terms array', () => {
    for (const fam of ['ler', 'tla'] as const) {
      const j = renderSemOntologyJsonLd(fam) as any;
      expect(Array.isArray(j['@graph'])).toBe(true);
      expect(j.terms).toBeUndefined();
      expect(j['@graph'].length).toBeGreaterThan(1);
    }
  });
});

// ── MINOR: HTML content negotiation ────────────────────────────────────────────────────
describe('round-8 — text/html renderers exist', () => {
  it('foxxi + ler/tla HTML renderers produce an HTML doc', () => {
    expect(renderVocabHtml()).toMatch(/<!doctype html>/i);
    expect(renderSemOntologyHtml('ler')).toMatch(/<!doctype html>/i);
    expect(renderSemOntologyHtml('tla')).toMatch(/<table/);
  });
});

// ── MAJOR: per-term dereference resolves vocab members + returns null for unknown ───────
describe('round-8 — renderTermJsonLd resolves vocab members and 404s the unknown', () => {
  it('a class resolves to owl:Class', () => {
    const t = renderTermJsonLd(XAPI_MODEL, 'Statement') as any;
    expect(t['@type']).toBe('owl:Class');
  });
  it('a scheme-scoped SKOS member resolves to a real skos:Concept (not rdfs:Resource)', () => {
    // cmi5 InteractionType-choice style: find a real member name from the model.
    const v = CMI5_MODEL.vocabularies?.[0];
    expect(v).toBeTruthy();
    const memberLocal = `${v!.name.replace(/[^A-Za-z0-9_.-]+/g, '-')}-${v!.members[0]!.name.replace(/[^A-Za-z0-9_.-]+/g, '-')}`;
    const t = renderTermJsonLd(CMI5_MODEL, memberLocal) as any;
    expect(t).not.toBeNull();
    expect(t['@type']).toBe('skos:Concept');
    expect(t['skos:prefLabel']).toBeTruthy();
    expect(t['skos:inScheme']).toBeTruthy();
  });
  it('an unknown term returns null (→ HTTP 404), not a fabricated stub', () => {
    expect(renderTermJsonLd(XAPI_MODEL, 'NoSuchTermAtAll')).toBeNull();
  });
});

// ── MAJOR: mesh verb-coining — only declared verbs may be coined/stored ─────────────────
describe('round-8 — verbIsDeclared gates mesh verb coining', () => {
  it('declared ADL + foxxi verbs are recognized; an arbitrary coined verb is not', () => {
    expect(verbIsDeclared('http://adlnet.gov/expapi/verbs/completed')).toBe(true);
    expect(verbIsDeclared(`${FOXXI_NS}performed`)).toBe(true);
    expect(verbIsDeclared(`${FOXXI_NS}verbs/totally-made-up-verb`)).toBe(false);
    // The mesh guard relays only when declared AND not object-type-pinned.
    const relayable = (id: string) => verbIsDeclared(id) && !verbRequiresObjectType(id);
    expect(relayable('http://adlnet.gov/expapi/verbs/completed')).toBe(true);
    expect(relayable(`${FOXXI_NS}verbs/totally-made-up-verb`)).toBe(false);
  });
});

// ── MINOR: xAPI UUID pattern accepts uppercase hex (RFC 9562), matching the LRS ingest ──
describe('round-8 — SHACL UUID pattern is case-insensitive (no false-reject of uppercase)', () => {
  it('an uppercase-hex UUID id validates as conformant', () => {
    const stmt = {
      id: '12345678-ABCD-1234-1234-123456789012',
      actor: { objectType: 'Agent', mbox: 'mailto:a@example.org' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
      object: { id: 'http://example.org/c', objectType: 'Activity' },
      timestamp: '2026-07-01T00:00:00Z', version: '2.0.0',
    };
    const r = validateXapiStatement(stmt);
    expect(r.results.some(x => x.path === 'id')).toBe(false);
  });
});
