/**
 * Every term the xapi-x namespace file names is declared in xapix/xapix.ttl, and the ontology
 * declares nothing the namespace file does not name.
 *
 * The repository's ontology lint checks the core prefixes against docs/ns and leaves a
 * vertical's own prefix alone, so nothing else would notice an `xapix:` term used in code and
 * never declared. The four `iep:` keys the profile describes are checked against docs/ns/iep.ttl.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import { IEP_DECORATIONS, IEP_NS, XAPIX_NS, XAPIX_NS_ROOT, XAPIX_TERM_NAMES, xapix } from '../src/xapix/namespace.js';
import { I2IDLX_NS_ROOT } from '../src/i2idl-glossary.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const quads = (path: string) => new Parser().parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const ontology = quads('../xapix/xapix.ttl');
const typed = (all: ReturnType<typeof quads>, ns: string): Set<string> =>
  new Set(all.filter(q => q.predicate.value === RDF_TYPE && q.subject.value.startsWith(ns)).map(q => q.subject.value));

describe('the xapix: namespace', () => {
  it('sits beside i2x:, outside every Interego protocol namespace', () => {
    expect(XAPIX_NS_ROOT).toBe(I2IDLX_NS_ROOT);
    expect(XAPIX_NS).toBe(`${I2IDLX_NS_ROOT}/xapix#`);
    expect(XAPIX_NS.startsWith('https://markjspivey-xwisee.github.io/interego/ns/')).toBe(false);
  });

  it('has every named term declared in the ontology, and the ontology declares no other', () => {
    expect([...typed(ontology, XAPIX_NS)].sort()).toEqual(XAPIX_TERM_NAMES.map(xapix).sort());
  });

  it('gives every term a label and a comment', () => {
    for (const term of XAPIX_TERM_NAMES.map(xapix)) {
      for (const property of ['label', 'comment']) {
        expect(ontology.some(q => q.subject.value === term && q.predicate.value === `${RDFS}${property}` && q.object.value.length > 0), `${term} rdfs:${property}`).toBe(true);
      }
    }
  });

  it('declares nothing in iep:', () => {
    expect(ontology.filter(q => q.subject.value.startsWith(IEP_NS))).toEqual([]);
  });
});

describe('the four iep: keys the xapi-x profile describes', () => {
  it('are declared by the protocol vocabulary itself', () => {
    const declared = typed(quads('../../../docs/ns/iep.ttl'), IEP_NS);
    for (const key of Object.values(IEP_DECORATIONS)) expect(declared.has(key), key).toBe(true);
  });
});
