import { describe, it, expect } from 'vitest';
import { buildFoxxiProfileDoc } from '../src/xapi-profile.js';
import { renderSemOntologyTurtle, renderSemOntologyJsonLd } from '../src/ler-tla-vocab.js';
import { renderVocabTurtle, renderVocabJsonLd, FOXXI_VOCAB_COMMENT } from '../src/foxxi-vocab.js';
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
    expect(ttl).toMatch(/skos:closeMatch <https:\/\/purl\.imsglobal\.org\/spec\/vc\/ob\/vocab\.html#OpenBadgeCredential>/);
    expect(ttl).toMatch(/skos:closeMatch <https:\/\/purl\.imsglobal\.org\/spec\/vc\/clr\/vocab\.html#ClrCredential>/);
  });
  it('the old 404-ing /spec/ob/v3p0 + /spec/clr/v2p0 class IRIs are gone', () => {
    expect(ttl).not.toMatch(/spec\/ob\/v3p0\/OpenBadgeCredential/);
    expect(ttl).not.toMatch(/spec\/clr\/v2p0\/ClrCredential/);
  });
});

// ── C3: adl-tla / ieee-ler JSON-LD is faithful to the Turtle (no phantom tla:inLevel; owl:imports; construction) ──
describe('round-11 — adl-tla/ieee-ler JSON-LD is faithful to the Turtle projection', () => {
  it('adl-tla JSON-LD asserts NO tla:inLevel (undefined predicate absent from the Turtle)', () => {
    const j = renderSemOntologyJsonLd('tla') as { '@graph': Array<Record<string, unknown>> };
    const withInLevel = j['@graph'].filter(n => 'tla:inLevel' in n);
    expect(withInLevel).toEqual([]);
    // Level membership is still carried, via the level Collection's skos:member.
    const anyLevel = j['@graph'].find(n => String(n['@id']).endsWith('MOMLevel1'));
    expect(anyLevel && anyLevel['skos:member']).toBeTruthy();
  });
  it('the adl-tla ontology node carries owl:imports (matching the Turtle)', () => {
    const j = renderSemOntologyJsonLd('tla') as { '@graph': Array<Record<string, unknown>> };
    const onto = j['@graph'].find(n => n['@type'] === 'owl:Ontology');
    expect(onto && (onto as any).imports).toBeTruthy();
  });
  it('the ieee-ler JSON-LD declares the ler:construction annotation property (matching the Turtle)', () => {
    const j = renderSemOntologyJsonLd('ler') as { '@graph': Array<Record<string, unknown>> };
    const constr = j['@graph'].find(n => String(n['@id']).endsWith('#construction') && n['@type'] === 'owl:AnnotationProperty');
    expect(constr).toBeTruthy();
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
  it('the vocab node comment matches the shared constant + carries isDefinedBy', () => {
    const j = renderVocabJsonLd() as { '@graph': Array<Record<string, unknown>> };
    const vocab = j['@graph'].find(n => n['@type'] === 'foxxi:Vocabulary') as Record<string, unknown>;
    expect(vocab.comment).toBe(FOXXI_VOCAB_COMMENT);
    expect(vocab.isDefinedBy).toBeTruthy();
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
