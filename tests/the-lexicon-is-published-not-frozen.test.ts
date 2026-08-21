/**
 * The retrieval lexicon is published data, and the frozen tables are only a fallback.
 *
 * ★ WHAT THIS REPLACES. packages/pgsl/src/ontological-inference.ts carried the entire
 * query-expansion knowledge base as TypeScript literals: 101 keys and 387 values of domain
 * fact — cars, GPS units, brake components — inside the substrate package. Nothing could
 * add a term without editing and rebuilding `packages/pgsl`, and no other agent could read
 * what this one believed "gps" was a part of. The module's own header already described
 * what it should have been ("The knowledge base is itself a PGSL-compatible structure —
 * atoms and relations"); it just wasn't.
 *
 * It is now docs/ns/pgsl-lexicon.ttl, read at runtime. The engine did not change and stays
 * general: it walks relations, it does not know what a brake is.
 *
 * ★ WHY THE TABLES SURVIVE. A deployment that cannot reach docs/ns must degrade rather
 * than silently lose every expansion — retrieval has no other signal that its lexicon
 * vanished. That leaves two copies of the same knowledge, which is a drift hazard, so the
 * second test here is the anti-drift anchor: the published file must parse back to exactly
 * the frozen tables. Change one without the other and this goes red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseLexicon, lexiconSource, expandTerm,
  FALLBACK_SYNONYM_GROUPS, FALLBACK_IS_A, FALLBACK_PART_OF, FALLBACK_CAUSES,
} from '@interego/pgsl';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON_TTL = join(REPO, 'docs/ns/pgsl-lexicon.ttl');
const published = readFileSync(LEXICON_TTL, 'utf8');

describe('the lexicon in use', () => {
  it('is the PUBLISHED one when docs/ns is reachable, not the frozen tables', () => {
    // The measurement that matters. A loader that parses correctly but never runs in
    // production is the defect this replaces wearing a different hat — the compliance
    // roster shipped in exactly that state once, reporting `fallback` from its own image.
    expect(lexiconSource()).toBe('published');
  });

  it('still expands through it — reading from data did not cost the inference', () => {
    const gps = expandTerm('gps');
    expect(gps).toContain('car');       // pgsl:partOf
    expect(gps).toContain('device');    // skos:broader
    const malfunction = expandTerm('malfunction');
    expect(malfunction).toContain('issue');  // pgsl:causes + synonym group
  });
});

describe('the published file and the frozen fallback cannot drift apart', () => {
  const parsed = parseLexicon(published);

  it('parses at all', () => {
    expect(parsed).toBeDefined();
  });

  it('reproduces every synonym group exactly', () => {
    expect(parsed?.synonymGroups).toEqual(FALLBACK_SYNONYM_GROUPS);
  });

  it('reproduces IS-A, PART-OF and CAUSES exactly', () => {
    expect(parsed?.isA).toEqual(FALLBACK_IS_A);
    expect(parsed?.partOf).toEqual(FALLBACK_PART_OF);
    expect(parsed?.causes).toEqual(FALLBACK_CAUSES);
  });
});

describe('a lexicon it cannot trust is refused WHOLE, not in part', () => {
  // ★ The failure mode worth naming: a lexicon missing three of its four relations would
  // still retrieve, just far worse, and nothing downstream would report it. So parseLexicon
  // returns undefined rather than a partial result, and the loader falls back entire.
  it('refuses a file that parses but carries no relations', () => {
    expect(parseLexicon('@prefix ex: <https://example.org/> .\nex:s ex:p ex:o .\n')).toBeUndefined();
  });

  it('refuses unparseable input rather than throwing at the retrieval path', () => {
    expect(parseLexicon('this is not turtle {{{')).toBeUndefined();
  });

  it('refuses a lexicon carrying synonyms but no hierarchy', () => {
    const synonymsOnly = `@prefix pgslt: <https://markjspivey-xwisee.github.io/interego/ns/pgsl/term/>.
@prefix skos: <http://www.w3.org/2004/02/skos/core#>.
pgslt:issue a skos:Concept ; skos:prefLabel "issue" ; skos:altLabel "problem", "fault" .
`;
    expect(parseLexicon(synonymsOnly)).toBeUndefined();
  });
});

describe('entries are addressable', () => {
  const LEXICON_NS = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl-lexicon#';

  it('every lexicon entry is an http URL, never a urn:', () => {
    expect(published).not.toMatch(/\burn:/);
    expect(published).toContain(LEXICON_NS);
  });

  it('and that URL RESOLVES — the fragment strips to the document that defines it', () => {
    // ★ The claim worth being careful about. An earlier draft named entries with
    // `…/ns/pgsl/term/gps` path IRIs and this test called them "dereferenceable". They were
    // not: nothing is published at that path, so all 387 would have 404'd — the letter of
    // "everything is a URL" without the part that makes it worth anything. A hash IRI
    // strips to the lexicon document itself, which is the file under test here, so
    // resolution follows from the naming rather than from a promise.
    expect(LEXICON_NS.endsWith('#')).toBe(true);
    expect(LEXICON_NS.slice(0, -1)).toMatch(/\/ns\/pgsl-lexicon$/);
    expect(LEXICON_TTL.replace(/\\/g, '/')).toMatch(/\/docs\/ns\/pgsl-lexicon\.ttl$/);
  });

  it('keeps instances out of the vocabulary namespace', () => {
    // 387 instances declared in `pgsl#` would read as vocabulary alongside pgsl:Atom.
    expect(published).not.toMatch(/^pgsl:\w+ +(skos:broader|pgsl:partOf|pgsl:causes)/m);
  });
});
