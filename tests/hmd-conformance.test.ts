/**
 * HyperMarkdown conformance gate — the standards half of the projection tests.
 *
 * The renderer in @interego/core is zero-dep and emits a closed subset; THIS
 * file is where that subset is held against genuine processors:
 *
 *  - rung 2: the frontmatter parses under the real `js-yaml` parser;
 *  - rung 3: parsed-as-YAML, the frontmatter is valid JSON-LD 1.1 that expands
 *    OFFLINE (documentLoader throws — the inline @context must be total) with
 *    ZERO silently-dropped keys. This is the regression test for the defect
 *    the rewrite exists to end (actionIri/whenToUse/descriptorUrl vanishing
 *    under expansion);
 *  - the `target` context override: even a hand-authored `target:` key can
 *    NEVER expand to hydra:target under the document's own declared context;
 *  - the zero-dep lift agrees with the real JSON-LD processor on the
 *    frontmatter triples it claims.
 */
import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import * as jsonld from 'jsonld';
import {
  renderHypermediaMarkdown,
  liftHypermediaMarkdown,
  controlBlockIds,
  HMD_PROFILE_IRI,
  type HypermediaMarkdownDoc,
} from '@interego/core';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const AMEP = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1#';

const offlineLoader = (url: string): never => {
  throw new Error(`network fetch attempted for ${url} — the inline @context must be total`);
};

/** The frontmatter object exactly as an analyst's YAML parser sees it. */
function frontmatterObject(md: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  if (!m) throw new Error('no frontmatter');
  return yaml.load(m[1]!) as Record<string, unknown>;
}

async function expand(obj: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await jsonld.expand(obj as never, { documentLoader: offlineLoader as never } as never);
  return (out as unknown[])[0] as Record<string, unknown>;
}

// Fixtures shaped like the three real composers: an /ns ontology page, an
// exchange document, a PGSL holon page.
const nsDoc: HypermediaMarkdownDoc = {
  id: 'https://relay.example/ns/acme/soc2',
  type: ['owl:Ontology'],
  descriptorUrl: 'https://relay.example/ns/acme/soc2',
  title: 'soc2',
  state: 'published',
  fields: { 'dct:publisher': 'acme' },
  links: [
    { label: 'Turtle', href: 'https://relay.example/ns/acme/soc2?format=turtle', rel: 'alternate', type: 'text/turtle' },
  ],
  controls: [
    { action: `${IEP}canAppend`, method: 'POST', whenToUse: 'Append a fact.', requires: ['proof-of-possession'], condition: { state: 'published' } },
  ],
  body: '# soc2\n\nA published ontology.',
};

const exchangeDoc: HypermediaMarkdownDoc = {
  id: 'https://relay.example/amep/exchanges/demo',
  type: ['amep:Exchange'],
  descriptorUrl: 'https://relay.example/amep/exchanges/demo',
  state: 'amep:Candidate',
  extraContext: { amep: AMEP },
  controls: [{ action: 'amep:Accept', method: 'POST', whenToUse: 'Commit the candidate.' }],
  body: '# AMEP exchange\n\n- **Act:** `Assert`',
};

describe('rung 2 — real-YAML validity', () => {
  it.each([['ns', nsDoc], ['exchange', exchangeDoc]] as const)('%s frontmatter parses under js-yaml', (_n, d) => {
    const fm = frontmatterObject(renderHypermediaMarkdown(d));
    expect(fm['@id']).toBe(d.id);
    expect(fm['descriptorUrl']).toBe(d.descriptorUrl);
    // the profile claim rides on the document node, not the resource
    expect((fm['document'] as Record<string, unknown>)['profile']).toBe(HMD_PROFILE_IRI);
    expect((fm['document'] as Record<string, unknown>)['@id']).toBe(`${d.id}?format=markdown`);
  });

  it('every :::control block body parses under js-yaml', () => {
    const md = renderHypermediaMarkdown(nsDoc);
    const blocks = [...md.matchAll(/^:::control [\w-]+\n([\s\S]*?)\n:::$/gm)];
    expect(blocks.length).toBe(1);
    const obj = yaml.load(blocks[0]![1]!) as Record<string, unknown>;
    expect(obj['rel']).toBe(`${IEP}canAppend`);
    expect(obj['condition']).toEqual({ state: 'published' });
  });
});

describe('rung 3 — JSON-LD 1.1 expansion, offline, zero silent drops', () => {
  it('the ns document expands to real triples for EVERY frontmatter key', async () => {
    const fm = frontmatterObject(renderHypermediaMarkdown(nsDoc));
    const ex = await expand(fm);
    expect(ex['@id']).toBe(nsDoc.id);
    // rdf:type expands to ABSOLUTE IRIs (owl: is declared — the old context lost it)
    expect(ex['@type']).toContain('http://www.w3.org/2002/07/owl#Ontology');
    // the authority pointer survives expansion as an IRI (was: silently dropped)
    const describedby = ex['http://www.w3.org/2007/05/powder-s#describedby'] as Array<Record<string, string>>;
    expect(describedby?.[0]?.['@id']).toBe(nsDoc.descriptorUrl);
    // the profile claim expands on the DOCUMENT NODE (schema:subjectOf), never
    // the resource — <resource> dct:conformsTo <hmd> would be a false triple
    expect(ex['http://purl.org/dc/terms/conformsTo']).toBeUndefined();
    const docNode = (ex['https://schema.org/subjectOf'] as Array<Record<string, unknown>>)?.[0];
    expect(docNode?.['@id']).toBe(`${nsDoc.id}?format=markdown`);
    expect(docNode?.['@type']).toContain('https://relay.interego.xwisee.com/ns/maintainer/hmd#Document');
    const docConforms = docNode?.['http://purl.org/dc/terms/conformsTo'] as Array<Record<string, string>>;
    expect(docConforms?.[0]?.['@id']).toBe(HMD_PROFILE_IRI);
    expect(ex['http://purl.org/dc/terms/title']).toBeDefined();
    expect(ex['https://schema.org/creativeWorkStatus']).toBeDefined();
    expect(ex['http://purl.org/dc/terms/publisher']).toBeDefined();
    // NO-SILENT-DROP: every non-@ frontmatter key yields at least one predicate
    const nonAt = Object.keys(fm).filter(k => !k.startsWith('@'));
    const predicateCount = Object.keys(ex).filter(k => !k.startsWith('@')).length;
    expect(predicateCount).toBeGreaterThanOrEqual(nonAt.length);
  });

  it('the exchange document expands amep:Exchange to an absolute IRI (extraContext works)', async () => {
    const fm = frontmatterObject(renderHypermediaMarkdown(exchangeDoc));
    const ex = await expand(fm);
    expect(ex['@type']).toContain(`${AMEP}Exchange`);
  });

  it('a control block, expanded under the document context, yields hmd:target — NEVER hydra:target', async () => {
    const md = renderHypermediaMarkdown(nsDoc);
    const fm = frontmatterObject(md);
    const block = /^:::control ([\w-]+)\n([\s\S]*?)\n:::$/m.exec(md)!;
    const blockObj = yaml.load(block[2]!) as Record<string, unknown>;
    const node = await expand({
      '@context': fm['@context'],
      '@id': `${nsDoc.id}#${block[1]}`,
      ...blockObj,
    } as Record<string, unknown>);
    expect(node['https://relay.interego.xwisee.com/ns/maintainer/hmd#target']).toBeDefined();
    expect(node['http://www.w3.org/ns/hydra/core#target']).toBeUndefined();
    // `type:` (aliased to @type in the projection context) expands absolutely
    expect(node['@type']).toContain('https://relay.interego.xwisee.com/ns/maintainer/hmd#Control');
    expect(node['@type']).toContain('http://www.w3.org/ns/hydra/core#Operation');
    // whenToUse/requires resolve (were: silently dropped)
    expect(node['http://www.w3.org/2004/02/skos/core#scopeNote']).toBeDefined();
    expect(node['http://purl.org/dc/terms/requires']).toBeDefined();
  });

  it('the zero-dep lift agrees with the real processor on frontmatter triples', async () => {
    const md = renderHypermediaMarkdown(nsDoc);
    const fm = frontmatterObject(md);
    const ex = await expand(fm);
    const lifted = liftHypermediaMarkdown(md);
    // every predicate the real processor produces on the doc subject is
    // present in the lift (the lift additionally covers links + controls)
    for (const [p, vals] of Object.entries(ex)) {
      if (p.startsWith('@')) continue;
      for (const v of vals as Array<Record<string, unknown>>) {
        const o = (v['@id'] ?? v['@value']) as string;
        expect(
          lifted.some(t => t.s === nsDoc.id && t.p === p && t.o === String(o)),
          `lift is missing <${nsDoc.id}> <${p}> ${o}`,
        ).toBe(true);
      }
    }
  });
});

describe('rung 4 — the control surface is complete and closed', () => {
  it('every control block carries type+rel+method+target, target inside the closure', () => {
    const md = renderHypermediaMarkdown(nsDoc);
    const ids = controlBlockIds(nsDoc.controls);
    const blocks = [...md.matchAll(/^:::control ([\w-]+)\n([\s\S]*?)\n:::$/gm)];
    expect(blocks.map(b => b[1])).toEqual(ids);
    for (const b of blocks) {
      const obj = yaml.load(b[2]!) as Record<string, unknown>;
      expect(obj['type']).toEqual(['hmd:Control', 'hydra:Operation']);
      expect(obj['rel']).toBeTruthy();
      expect(obj['method']).toBeTruthy();
      expect(obj['target']).toBe(`${nsDoc.id}#${b[1]}`);
    }
  });
});

describe('rung 4 — inline SHACL field schema (lift-only convenience)', () => {
  const SH = 'http://www.w3.org/ns/shacl#';
  const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
  const withFields = {
    ...nsDoc,
    controls: [{
      action: `${IEP}ask`, method: 'POST' as const, expects: 'urn:g:mem#AskShape',
      fields: [
        { path: `${IEP}question`, name: 'Question', description: 'What to ask', datatype: XSD_STRING, minCount: 1, maxCount: 1 },
        { path: `${IEP}ctx`, datatype: XSD_STRING, minCount: 0 },
      ],
    }],
  };

  it('a fields-bearing control still parses under real js-yaml (rung 2 intact)', () => {
    const md = renderHypermediaMarkdown(withFields);
    const block = /^:::control ([\w-]+)\n([\s\S]*?)\n:::$/m.exec(md)!;
    const obj = yaml.load(block[2]!) as Record<string, unknown>;
    expect(Array.isArray(obj['fields'])).toBe(true);
    expect((obj['fields'] as Array<Record<string, unknown>>)[0]!['path']).toBe(`${IEP}question`);
  });

  it('the LIFT is the RDF authority for control fields — emits sh:property/path/name/min/maxCount', () => {
    const md = renderHypermediaMarkdown(withFields);
    const lifted = liftHypermediaMarkdown(md);
    const props = lifted.filter(t => t.p === `${SH}property`);
    expect(props.length).toBe(2);
    const F0 = props[0]!.o;
    expect(lifted.some(t => t.s === F0 && t.p === `${SH}path` && t.o === `${IEP}question`)).toBe(true);
    expect(lifted.some(t => t.s === F0 && t.p === `${SH}name` && t.o === 'Question')).toBe(true);
    expect(lifted.some(t => t.s === F0 && t.p === `${SH}minCount` && t.o === '1')).toBe(true);
    expect(lifted.some(t => t.s === F0 && t.p === `${SH}maxCount` && t.o === '1')).toBe(true);
  });

  it('malformed store-and-forward fields never throw and emit NO sh:property (guarded parse+lift)', () => {
    const base = renderHypermediaMarkdown(withFields);
    for (const bad of ['[null]', '[{}]', '[1]', '["x"]', '[{"path":123}]', '[{"name":"no path"}]']) {
      const md = base.replace(/fields: \[.*\]/, `fields: ${bad}`);
      expect(() => liftHypermediaMarkdown(md), bad).not.toThrow();
      expect(liftHypermediaMarkdown(md).some(t => t.p === `${SH}property`), bad).toBe(false);
    }
  });
});
