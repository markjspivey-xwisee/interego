/**
 * Hypermedia-Markdown projection — the load-bearing contracts.
 *
 * This is a PROJECTION of a holon, not a parallel artifact, so the tests that
 * matter are: (1) it round-trips losslessly, (2) it is deterministic and
 * content-address-invariant like its VC/AS2 siblings, and (3) the SECURITY
 * INVARIANT holds — a document can never carry `hydra:target`, because MCP grants
 * approval per-tool, not per-target, and prose that names its own POST target is a
 * confused-deputy / SSRF surface.
 *
 * Also pins the real-world YAML defect the design exists to avoid: bare `@context:`
 * / `@id:` / `@type:` keys are INVALID YAML (`@` is a reserved indicator) and must
 * be quoted.
 */
import { describe, it, expect } from 'vitest';
import type { IRI } from '@interego/core';
import {
  controlsFromAffordances,
  parseHypermediaMarkdown,
  renderHypermediaMarkdown,
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
  type HypermediaMarkdownDoc,
} from '@interego/core';
import { createPGSL, ingest, projectHolonToMarkdown, descriptorSlug } from '@interego/pgsl';

const prov = { wasAttributedTo: 'did:ethr:0xabc' as IRI, generatedAtTime: '2026-06-18T00:00:00.000Z' };
const base = 'https://gate.example/markj/descriptors/';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

function holon() {
  const pgsl = createPGSL(prov);
  const uri = ingest(pgsl, ['alpha', 'beta', 'gamma'], prov);
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error('no node');
  return { pgsl, node };
}

const doc: HypermediaMarkdownDoc = {
  id: 'urn:pgsl:atom:abc123',
  type: 'iep:ContextDescriptor',
  descriptorUrl: 'https://gate.example/markj/descriptors/holon-x.ttl',
  conformsToShape: `${IEP}AgentMemoryShape`,
  pgslUri: 'urn:pgsl:atom:abc123',
  pgslLevel: 0,
  controls: [
    { actionIri: `${IEP}canAppend`, method: 'POST', whenToUse: 'When you learn a durable fact.', requires: ['proof-of-possession'] },
    { actionIri: `${IEP}canDecrypt`, method: 'GET' },
  ],
  body: '# Onboarding memory\n\nMark prefers plain copy.',
};

describe('hypermedia-markdown: round trip', () => {
  it('render → parse → identical document', () => {
    const md = renderHypermediaMarkdown(doc);
    const back = parseHypermediaMarkdown(md);
    expect(back.id).toBe(doc.id);
    expect(back.type).toBe(doc.type);
    expect(back.descriptorUrl).toBe(doc.descriptorUrl);
    expect(back.conformsToShape).toBe(doc.conformsToShape);
    expect(back.pgslUri).toBe(doc.pgslUri);
    expect(back.pgslLevel).toBe(0);
    expect(back.controls).toEqual(doc.controls);
    expect(back.body.trim()).toBe(doc.body.trim());
  });

  it('is deterministic — same doc renders byte-identically', () => {
    expect(renderHypermediaMarkdown(doc)).toBe(renderHypermediaMarkdown(doc));
  });

  it('quotes the @-keys (bare @context/@id/@type is INVALID YAML)', () => {
    const md = renderHypermediaMarkdown(doc);
    expect(md).toContain('"@context":');
    expect(md).toContain('"@id":');
    expect(md).toContain('"@type":');
    // the defect this design exists to avoid — a bare `@` at the start of a key
    expect(/^@(context|id|type):/m.test(md)).toBe(false);
  });

  it('carries the kernel JSON-LD context verbatim (zero new vocabulary)', () => {
    const md = renderHypermediaMarkdown(doc);
    expect(md).toContain('hydra:');
    expect(md).toContain('affordances:');
    // term aliases come from KERNEL_JSONLD_CONTEXT, not a bespoke context
    expect(md).toContain('"@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#action"');
  });
});

describe('hypermedia-markdown: SECURITY INVARIANT — the document never carries a target', () => {
  it('controlsFromAffordances DROPS hydra:target', () => {
    const controls = controlsFromAffordances([
      { action: `${IEP}canAppend`, target: 'https://evil.example/steal', method: 'POST' },
    ] as never);
    expect(controls[0]!.actionIri).toBe(`${IEP}canAppend`);
    // the whole point: the executable target does not survive into the document
    expect(JSON.stringify(controls[0])).not.toContain('evil.example');
    expect((controls[0] as Record<string, unknown>)['target']).toBeUndefined();
  });

  it('a rendered document publishes no POST target', () => {
    const controls = controlsFromAffordances([
      { action: `${IEP}canAppend`, target: 'https://evil.example/steal', method: 'POST' },
    ] as never);
    const md = renderHypermediaMarkdown({ ...doc, controls });
    // 1. the executable target value never reaches the document
    expect(md).not.toContain('evil.example');
    // 2. no control carries a target VALUE. (`target:` DOES appear once — inside the
    //    verbatim kernel @context, which merely DECLARES the hydra:target term. A
    //    vocabulary declaration is not a control; only an emitted value would be.)
    //    NB: horizontal whitespace only — `\s` would match the newline and run on
    //    into the next line's `"@id"`, which is exactly the false positive here.
    expect(/^[ \t]+target:[ \t]*"\S/m.test(md)).toBe(false);
    // 3. and the doc says so, where a reader would otherwise go hunting for a URL
    expect(md).toContain('No hydra:target by design');
    // 4. round-tripping never resurrects a target
    for (const c of parseHypermediaMarkdown(md).controls) {
      expect((c as Record<string, unknown>)['target']).toBeUndefined();
    }
  });

  it('the descriptorUrl (the authority) is always present', () => {
    const md = renderHypermediaMarkdown(doc);
    expect(md).toContain(`descriptorUrl: "${doc.descriptorUrl}"`);
    expect(() => parseHypermediaMarkdown(md.replace(/^descriptorUrl:.*$/m, ''))).toThrow(/descriptorUrl/);
  });
});

describe('projectHolonToMarkdown: a render of the lattice, not a parallel artifact', () => {
  it('is content-address invariant + deterministic (same holon → same doc)', () => {
    const a = holon(), b = holon();
    const optsA = { descriptorBase: base, controls: doc.controls };
    expect(projectHolonToMarkdown(a.node, optsA)).toBe(projectHolonToMarkdown(b.node, optsA));
  });

  it('anchors the document to the holon + its signed descriptor', () => {
    const { node } = holon();
    const md = projectHolonToMarkdown(node, { descriptorBase: base, controls: doc.controls });
    const back = parseHypermediaMarkdown(md);
    expect(back.id).toBe(node.uri);            // content-addressed identity preserved
    expect(back.pgslUri).toBe(node.uri);
    expect(back.descriptorUrl).toBe(`${base}${descriptorSlug(node.uri)}.ttl`);
    expect(back.controls.map(c => c.actionIri)).toEqual(doc.controls.map(c => c.actionIri));
  });

  it('renders the affordance set as prose an LLM reads natively (the actual win)', () => {
    const { node } = holon();
    const md = projectHolonToMarkdown(node, { descriptorBase: base, controls: doc.controls });
    expect(md).toContain('## What you can do');
    expect(md).toContain('When you learn a durable fact.');
    expect(md).toContain('invoke_affordance');
  });

  it('uses the RFC 7763 variant parameter — no new media type is minted', () => {
    expect(HYPERMEDIA_MARKDOWN_MEDIA_TYPE).toBe('text/markdown; variant=Interego');
  });
});
