import { describe, expect, it } from 'vitest';
import { rdfFingerprint } from '../i2idlx/typescript/parity.js';

const prefixes = '@prefix ex: <https://example.org/> .\n';

describe('I2IDL-X independent RDF parity checks', () => {
  it('ignores blank-node names, triple order and duplicate triples', async () => {
    const a = prefixes + 'ex:x ex:p [ ex:q "value"@en ] .';
    const b = prefixes + '_:different ex:q "value"@en . ex:x ex:p _:different . ex:x ex:p _:different .';
    expect(await rdfFingerprint(a)).toBe(await rdfFingerprint(b));
  });
  it('compares JSON-LD and Turtle as the same RDF graph', async () => {
    const json = JSON.stringify({ '@context': { ex: 'https://example.org/' }, '@id': 'ex:x', 'ex:p': { '@id': 'ex:y' } });
    expect(await rdfFingerprint(prefixes + 'ex:x ex:p ex:y .')).toBe(await rdfFingerprint(json, 'jsonld'));
  });
  it('detects changes in a literal value, language and datatype', async () => {
    const base = await rdfFingerprint(prefixes + 'ex:x ex:p "value"@en .');
    for (const object of ['"changed"@en', '"value"@fr', '"value"']) {
      expect(await rdfFingerprint(prefixes + 'ex:x ex:p ' + object + ' .')).not.toBe(base);
    }
  });
  it('detects a changed relationship even when the triple count is unchanged', async () => {
    expect(await rdfFingerprint(prefixes + 'ex:x ex:p ex:y .')).not.toBe(await rdfFingerprint(prefixes + 'ex:y ex:p ex:x .'));
  });
  it('fingerprints blank nodes that only their neighbours tell apart, to the same value as before', async () => {
    // Two disjoint two-cycles: no blank node here differs from another by its own triples, so
    // RDFC-1.0 has to search, and a canonicalizer's complexity bound decides whether it answers
    // at all. Shapes and ontologies are full of this (the same `sh:or` list on several
    // properties). The value was computed under jsonld 8, whose canonicalizer had no bound.
    const twins = prefixes + '_:a ex:p _:b . _:b ex:p _:a . _:c ex:p _:d . _:d ex:p _:c .';
    const renamed = prefixes + '_:w ex:p _:x . _:y ex:p _:z . _:x ex:p _:w . _:z ex:p _:y .';
    expect(await rdfFingerprint(twins)).toBe('4918befac87f5338c98ab6ec6c29cc57094d19c90ec297269f7afe6280ad7eb7');
    expect(await rdfFingerprint(renamed)).toBe(await rdfFingerprint(twins));
  });
  it('reads a character outside the Basic Multilingual Plane in Turtle as JSON-LD reads it', async () => {
    // n3 writes such a character as a \U escape, which the canonicalizer jsonld 8 bundled could not
    // parse, so docs/ns/hela.ttl and any graph with an emoji in it had no fingerprint at all.
    const json = JSON.stringify({ '@context': { ex: 'https://example.org/' }, '@id': 'ex:x', 'ex:p': '\u{1F600}' });
    expect(await rdfFingerprint(prefixes + 'ex:x ex:p "\u{1F600}" .')).toBe(await rdfFingerprint(json, 'jsonld'));
  });
  it('fails on malformed RDF instead of claiming parity', async () => {
    await expect(rdfFingerprint(prefixes + 'ex:x ex:p [')).rejects.toThrow();
  });
});
