import { describe, it, expect } from 'vitest';
import {
  CodecRegistry,
  rdfCodec,
  rdfOpaqueUri,
  publicAtomAddress,
  InMemoryFdb,
  openStore,
} from '../packages/pgsl-store/src/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('pgsl-store: RDF codec on the format-agnostic seam', () => {
  it('registers + dispatches by format', () => {
    const reg = new CodecRegistry().register(rdfCodec);
    expect(reg.get('text/turtle')).toBe(rdfCodec);
    expect(reg.formats()).toContain('text/turtle');
    expect(reg.get('application/yaml')).toBeUndefined(); // 2nd codec slots in later
  });

  it('BYTE-FAITHFUL round-trip via the opaque atom (signatures survive)', () => {
    // A signed-looking body with exact whitespace/order that re-serialization would mangle.
    const turtle =
      '@prefix ex: <http://ex/> .\n' +
      'ex:s ex:p "value with   spaces" ;\n' +
      '     ex:sig "0xDEADBEEF" .\n';
    const bytes = enc.encode(turtle);

    const ing = rdfCodec.ingest(bytes);
    const opaque = ing.nodes.find((n) => n.uri === ing.opaqueUri)!;
    const out = rdfCodec.projectBytes(opaque);

    expect(dec.decode(out)).toBe(turtle); // byte-identical, not a re-serialization
    expect(ing.opaqueUri).toBe(rdfOpaqueUri(bytes)); // content-addressed
    expect(ing.topUri).toMatch(/^urn:pgsl:fragment:[0-9a-f]{40}$/);
    // one ;-joined statement (two predicates, single '.'); the @prefix is dropped.
    expect(ing.structuralUris.length).toBe(1);
  });

  it('identical bytes dedup to the same opaque atom', () => {
    const a = enc.encode('ex:s ex:p ex:o .\n');
    const b = enc.encode('ex:s ex:p ex:o .\n');
    expect(rdfCodec.ingest(a).opaqueUri).toBe(rdfCodec.ingest(b).opaqueUri);
  });

  it('CROSS-HOLON STRUCTURAL OVERLAP: two different graphs sharing a statement share its atom', async () => {
    const shared = '<http://ex/shared> <http://ex/p> <http://ex/o>';
    const sharedAtomUri = publicAtomAddress(shared);

    const graphA = enc.encode('<http://ex/a> <http://ex/p> <http://ex/o1> .\n' + shared + ' .\n');
    const graphB = enc.encode('<http://ex/b> <http://ex/p> <http://ex/o2> .\n' + shared + ' .\n');

    const ingA = rdfCodec.ingest(graphA);
    const ingB = rdfCodec.ingest(graphB);

    // Both projections contain the shared statement atom; opaque atoms differ.
    expect(ingA.structuralUris).toContain(sharedAtomUri);
    expect(ingB.structuralUris).toContain(sharedAtomUri);
    expect(ingA.opaqueUri).not.toBe(ingB.opaqueUri);

    // Persist both graphs, then detect the overlap from the store's CB index —
    // WITHOUT reading any statement value (privacy-preserving overlap).
    const store = openStore(new InMemoryFdb());
    await store.compose(ingA.nodes, { pod: 'https://pod/x/', resource: 'g/A' });
    await store.compose(ingB.nodes, { pod: 'https://pod/x/', resource: 'g/B' });

    const holonsWithShared = await store.fragmentsContaining(sharedAtomUri);
    expect(new Set(holonsWithShared)).toEqual(new Set([ingA.topUri, ingB.topUri]));
  });

  it('end-to-end via the store: compose ingest, resolve opaque, project original bytes', async () => {
    const turtle = '@prefix ex: <http://ex/> .\nex:s ex:p ex:o .\n';
    const bytes = enc.encode(turtle);
    const ing = rdfCodec.ingest(bytes);

    const store = openStore(new InMemoryFdb());
    await store.compose(ing.nodes, { pod: 'https://pod/x/', resource: 'g/roundtrip' });

    const opaque = await store.resolve(ing.opaqueUri);
    expect(opaque).not.toBeNull();
    expect(dec.decode(rdfCodec.projectBytes(opaque!))).toBe(turtle);
  });
});
