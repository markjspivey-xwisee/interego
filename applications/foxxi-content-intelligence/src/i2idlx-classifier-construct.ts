/** Preserve the one request dataset's bound blank identities across classifier passes. */
import { QueryEngine } from '@comunica/query-sparql';
import { deskolemizeTerm } from '@comunica/actor-optimize-query-operation-query-source-skolemize';
import { DataFactory, Store, type Term, type Quad } from '../i2idlx/typescript/rdf.js';

export function createClassifierConstruct(dataset: Store): (query: string) => Promise<Store> {
  const sourceId = 'i2idlx-classifier';
  const sourceIds = new Map([[dataset, sourceId]]);
  return async query => {
    const known = new Set<string>();
    const visit = (term: Term): void => {
      if (term.termType === 'BlankNode') known.add(term.value);
      if (term.termType === 'Quad') {
        visit(term.subject); visit(term.predicate); visit(term.object); visit(term.graph);
      }
    };
    for (const quad of dataset) {
      visit(quad.subject); visit(quad.predicate); visit(quad.object); visit(quad.graph);
    }
    const restore = (term: Term): Term => {
      if (term.termType === 'Quad') return DataFactory.quad(
        restore(term.subject) as Quad['subject'], restore(term.predicate) as Quad['predicate'],
        restore(term.object) as Quad['object'], restore(term.graph) as Quad['graph'],
      );
      // Only the engine's source-scoped blanks are inverse-mapped. Named IRIs
      // (even Comunica-looking ones) and genuinely fresh CONSTRUCT/BNODE terms
      // retain their identity. Never strip labels or skolemize the ontology.
      if (term.termType !== 'BlankNode' || !('skolemized' in term)) return term;
      const original = deskolemizeTerm(DataFactory, term, sourceId);
      if (!original || original.termType !== 'BlankNode' || !known.has(original.value)) {
        throw new Error('Classifier returned a blank node outside its source scope.');
      }
      return original;
    };
    const engine = new QueryEngine();
    const stream = await engine.queryQuads(query, {
      sources: [dataset], '@comunica/bus-query-source-identify:sourceIds': sourceIds,
    });
    const output = await stream.toArray();
    // N3 Store retains RDF term identities but not the engine's scope metadata.
    // Restore before materializing, so the next pass sees the same source nodes.
    return new Store(output.map(quad => DataFactory.quad(
      restore(quad.subject) as Quad['subject'], restore(quad.predicate) as Quad['predicate'],
      restore(quad.object) as Quad['object'], restore(quad.graph) as Quad['graph'],
    )));
  };
}
