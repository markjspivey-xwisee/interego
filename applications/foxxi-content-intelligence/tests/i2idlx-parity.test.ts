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
  it('fails on malformed RDF instead of claiming parity', async () => {
    await expect(rdfFingerprint(prefixes + 'ex:x ex:p [')).rejects.toThrow();
  });
});
