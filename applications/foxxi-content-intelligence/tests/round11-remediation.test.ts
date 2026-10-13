import { describe, it, expect } from 'vitest';
import { buildFoxxiProfileDoc } from '../src/xapi-profile.js';
import { renderSemOntologyTurtle, renderSemOntologyJsonLd, LER_NS, TLA_NS } from '../src/ler-tla-vocab.js';
import { renderVocabTurtle, renderVocabJsonLd, FOXXI_VOCAB_COMMENT, FOXXI_VOCAB_DOC, FOXXI_NS, FOXXI_TERMS } from '../src/foxxi-vocab.js';
import { jsonLdQuads, turtleQuads, canonical, objectsOf, iriObjectsOf, subjectsOfType, OWL, RDFS, SKOS, DCT } from './support/ns-graph.js';
import { renderInForm } from '../src/content-forms.js';
import type { ContentUnit } from '../src/content-channels.js';

// ── C1: every published Statement Template carries the required `definition` (xAPI-Profile §8) ──
describe('round-11 — every xAPI Profile Statement Template has a definition (spec §8)', () => {
  const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-22T00:00:00Z' }) as {
    templates: Array<Record<string, unknown>>;
  };
  it('no template is missing definition', () => {
    const missing = doc.templates.filter(t => !t.definition).map(t => t.id);
    expect(missing).toEqual([]);
  });
  it('the 8 previously-bare templates now carry a definition', () => {
    const ids = ['initialized', 'scene-completed', 'completed', 'passed', 'terminated', 'retrieved', 'enrolled', 'credentialed'];
    for (const short of ids) {
      const t = doc.templates.find(x => String(x.id).endsWith(`/templates/${short}`));
      expect(t, short).toBeTruthy();
      expect(t!.definition, short).toBeTruthy();
    }
  });
});

// ── C2: IEEE-LER closeMatch to the CANONICAL, dereferenceable 1EdTech vocab IRIs (not the 404s) ──
describe('round-11 — IEEE-LER OB3/CLR closeMatch targets are the canonical vocab.html IRIs', () => {
  const ttl = renderSemOntologyTurtle('ler');
  it('closeMatch points at vc/ob and vc/clr vocab.html (which resolve 200)', () => {
    // ★ REVISED: read as triples (the Turtle now writes these IRIs with 1EdTech's ob:/clr: prefixes).
    // ★ REVISED (2026.10.0): ler:Credential narrowMatches the two credentials (each is a kind of
    // it); the targets of either relation are the canonical vocab.html IRIs.
    const targets = turtleQuads(ttl).filter(t => [`${SKOS}closeMatch`, `${SKOS}narrowMatch`].includes(t.predicate.value)).map(t => t.object.value);
    expect(targets).toContain('https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential');
    expect(targets).toContain('https://purl.imsglobal.org/spec/vc/clr/vocab.html#ClrCredential');
  });
  it('the old 404-ing /spec/ob/v3p0 + /spec/clr/v2p0 class IRIs are gone', () => {
    expect(ttl).not.toMatch(/spec\/ob\/v3p0\/OpenBadgeCredential/);
    expect(ttl).not.toMatch(/spec\/clr\/v2p0\/ClrCredential/);
  });
});

// ── C3: adl-tla / ieee-ler JSON-LD is faithful to the Turtle (no phantom tla:inLevel; owl:imports; construction) ──
describe('round-11 — adl-tla/ieee-ler JSON-LD is faithful to the Turtle projection', () => {
  it('adl-tla JSON-LD asserts NO tla:inLevel (undefined predicate absent from the Turtle)', async () => {
    const q = await jsonLdQuads(renderSemOntologyJsonLd('tla'));
    expect(q.filter(x => x.predicate.value === `${TLA_NS}inLevel`)).toEqual([]);
    // Level membership is still carried, via the level Collection's skos:member.
    expect(iriObjectsOf(q, `${TLA_NS}MOMLevel1`, `${SKOS}member`).length).toBeGreaterThan(0);
  });
  // ★ REVISED. This pinned `owl:imports` on the ontology node. The import named the Interego core
  // ontology, whose IRI serves HTML (GitHub Pages), so no OWL tool could load the closure and the
  // document was not OWL 2 DL. External terms are now DECLARED in the document (MIREOT) and the
  // substrate is linked with rdfs:seeAlso. The intent — the JSON-LD says exactly what the Turtle
  // says — is checked directly: the two are the same graph.
  it('the adl-tla JSON-LD and Turtle are one graph — and neither imports an unloadable ontology', async () => {
    const fromJson = await jsonLdQuads(renderSemOntologyJsonLd('tla'));
    const fromTtl = turtleQuads(renderSemOntologyTurtle('tla'));
    expect(await canonical(fromJson)).toBe(await canonical(fromTtl));
    expect(fromTtl.filter(x => x.predicate.value === `${OWL}imports`)).toEqual([]);
    expect(iriObjectsOf(fromTtl, TLA_NS.replace(/#$/, ''), `${RDFS}seeAlso`))
      .toContain('https://markjspivey-xwisee.github.io/interego/ns/iep#');
  });
  it('the ieee-ler JSON-LD declares the ler:construction annotation property (matching the Turtle)', async () => {
    const q = await jsonLdQuads(renderSemOntologyJsonLd('ler'));
    expect(subjectsOfType(q, `${OWL}AnnotationProperty`)).toContain(`${LER_NS}construction`);
  });
  it('the ieee-ler JSON-LD ontology comment equals the Turtle blurb (same string both projections)', () => {
    const j = renderSemOntologyJsonLd('ler') as { '@graph': Array<Record<string, unknown>> };
    const onto = j['@graph'].find(n => n['@type'] === 'owl:Ontology') as Record<string, unknown>;
    const ttl = renderSemOntologyTurtle('ler');
    // The comment string in the JSON-LD must appear verbatim in the Turtle.
    expect(ttl).toContain(String(onto.comment).slice(0, 60));
  });
});

// ── C4 + D2: foxxi vocab JSON-LD is faithful + the dead Azure owl:sameAs is gone ──
describe('round-11 — foxxi vocab JSON-LD faithful; dead Azure owl:sameAs dropped', () => {
  // ★ REVISED. The vocabulary node was typed `foxxi:Vocabulary` — a class nothing declared — and
  // carried rdfs:isDefinedBy pointing at itself. It is now an owl:Ontology whose description is
  // the shared constant, and it is each TERM that is isDefinedBy the vocabulary. Same intent: one
  // string, identical in every projection, and every term traceable to its defining document.
  it('the vocab node comment matches the shared constant + carries isDefinedBy', async () => {
    const q = await jsonLdQuads(renderVocabJsonLd());
    expect(subjectsOfType(q, `${OWL}Ontology`)).toEqual([FOXXI_VOCAB_DOC]);
    expect(objectsOf(q, FOXXI_VOCAB_DOC, `${DCT}description`)).toEqual([FOXXI_VOCAB_COMMENT]);
    expect(objectsOf(turtleQuads(renderVocabTurtle()), FOXXI_VOCAB_DOC, `${DCT}description`)).toEqual([FOXXI_VOCAB_COMMENT]);
    for (const t of FOXXI_TERMS) expect(iriObjectsOf(q, FOXXI_NS + t.name, `${RDFS}isDefinedBy`), t.name).toEqual([FOXXI_VOCAB_DOC]);
  });
  it('no owl:sameAs to the decommissioned Azure host in the Turtle', () => {
    const ttl = renderVocabTurtle();
    expect(ttl).not.toMatch(/owl:sameAs/);
    expect(ttl).not.toMatch(/azurecontainerapps\.io/);
  });
});

// ── S4: the content renderer escapes quotes + neutralizes javascript: hrefs (XSS) ──
describe('round-11 — content-forms neutralizes attribute-break + javascript: href (XSS)', () => {
  const malicious: ContentUnit = {
    title: 't', kind: 'lesson',
    blocks: [{ text: 'What is 2+2? ::: 4" onfocus=alert(document.domain) autofocus zz="' }],
    link: 'javascript:alert(1)',
  };
  const body = renderInForm(malicious, 'interactive').body;
  it('the injected quote is escaped (no attribute break, no injected onfocus handler)', () => {
    // The exploit needs a RAW closing quote to break out of data-a="…". After escaping,
    // the value reads data-a="4&quot; onfocus…&quot;" — the onfocus text is inert (inside
    // the attribute), and there is no `"4" onfocus=` attribute break.
    expect(body).not.toContain('data-a="4" onfocus');
    expect(body).toContain('data-a="4&quot;');
  });
  it('the javascript: href is neutralized to #', () => {
    expect(body).not.toContain('href="javascript:');
    expect(body).toContain('href="#"');
  });
  it('a legitimate https link is preserved', () => {
    const ok: ContentUnit = { title: 't', kind: 'lesson', blocks: [{ text: 'x' }], link: 'https://example.org/a' };
    expect(renderInForm(ok, 'html').body).toContain('href="https://example.org/a"');
  });
});
