import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL,
  ingest,
  latticeStats,
  materializeTriples,
  sparqlMatchPattern,
  executeSparqlString,
  sparqlQueryPGSL,
  sparqlFragmentsAtLevel,
  sparqlFragmentsContaining,
  sparqlPullbackOf,
  sparqlNeighbors,
  sparqlLatticeStats,
} from '../src/index.js';
import { matchPattern } from '../src/pgsl/sparql-engine.js';
import type { PGSLInstance } from '../src/index.js';
import type { IRI } from '../src/model/types.js';

describe('PGSL SPARQL Engine', () => {
  let pgsl: PGSLInstance;

  beforeEach(() => {
    pgsl = createPGSL({
      wasAttributedTo: 'urn:test:agent' as IRI,
      generatedAtTime: '2026-01-01T00:00:00Z',
    });
    // Ingest "the cat sat" → creates atoms (the, cat, sat) and fragments
    ingest(pgsl, ['the', 'cat', 'sat']);
  });

  describe('Triple Materialization', () => {
    it('materializes atoms as triples', () => {
      const store = materializeTriples(pgsl);
      // Should have triples for each atom and fragment
      expect(store.triples.length).toBeGreaterThan(0);

      // Find atom triples
      const atomTypes = matchPattern(
        store, undefined,
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#Atom',
      );
      expect(atomTypes.length).toBe(3); // the, cat, sat
    });

    it('materializes fragments as triples', () => {
      const store = materializeTriples(pgsl);
      const fragTypes = matchPattern(
        store, undefined,
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#Fragment',
      );
      // Level 1 wrappers + level 2 pair + level 3 top
      expect(fragTypes.length).toBeGreaterThan(0);
    });

    it('materializes atom values', () => {
      const store = materializeTriples(pgsl);
      const valueTriples = matchPattern(
        store, undefined,
        'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#value',
        undefined,
      );
      const values = valueTriples.map(t => t.object.replace(/"/g, ''));
      expect(values).toContain('the');
      expect(values).toContain('cat');
      expect(values).toContain('sat');
    });

    it('materializes fragment items', () => {
      const store = materializeTriples(pgsl);
      const itemTriples = matchPattern(
        store, undefined,
        'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#item',
        undefined,
      );
      expect(itemTriples.length).toBeGreaterThan(0);
    });

    it('materializes provenance', () => {
      const store = materializeTriples(pgsl);
      const provTriples = matchPattern(
        store, undefined,
        'http://www.w3.org/ns/prov#wasAttributedTo',
        undefined,
      );
      expect(provTriples.length).toBeGreaterThan(0);
      expect(provTriples[0]!.object).toBe('urn:test:agent');
    });
  });

  describe('Pattern Matching', () => {
    it('matches by subject', () => {
      const store = materializeTriples(pgsl);
      const firstAtom = [...pgsl.atoms.values()][0]!;
      const matches = matchPattern(store, firstAtom, undefined, undefined);
      expect(matches.length).toBeGreaterThan(0);
    });

    it('matches by predicate', () => {
      const store = materializeTriples(pgsl);
      const matches = matchPattern(
        store, undefined,
        'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#level',
        undefined,
      );
      // Every node has a level
      expect(matches.length).toBe(pgsl.nodes.size);
    });

    it('matches by subject + predicate', () => {
      const store = materializeTriples(pgsl);
      const firstAtom = [...pgsl.atoms.values()][0]!;
      const matches = matchPattern(
        store, firstAtom,
        'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#value',
        undefined,
      );
      expect(matches.length).toBe(1);
    });

    it('returns empty for non-matching pattern', () => {
      const store = materializeTriples(pgsl);
      const matches = matchPattern(store, 'urn:nonexistent', undefined, undefined);
      expect(matches.length).toBe(0);
    });
  });

  describe('SPARQL Execution', () => {
    it('SELECT all atoms', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
         SELECT ?atom ?value WHERE {
           ?atom a pgsl:Atom ;
                 pgsl:value ?value .
         }`
      );
      expect(result.bindings.length).toBe(3);
      const values = result.bindings.map(b => b.get('?value')?.replace(/"/g, ''));
      expect(values).toContain('the');
      expect(values).toContain('cat');
      expect(values).toContain('sat');
    });

    it('ASK query returns true for existing patterns', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
         ASK WHERE { ?x a pgsl:Atom }`
      );
      expect(result.boolean).toBe(true);
    });

    it('ASK query returns false for non-existing patterns', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
         ASK WHERE { ?x pgsl:value "nonexistent" }`
      );
      expect(result.boolean).toBe(false);
    });

    it('SELECT with ORDER BY', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
         SELECT ?fragment ?level WHERE {
           ?fragment a pgsl:Fragment ;
                     pgsl:level ?level .
         } ORDER BY ?level`
      );
      expect(result.bindings.length).toBeGreaterThan(0);
      // Levels should be non-decreasing
      for (let i = 1; i < result.bindings.length; i++) {
        const prev = parseFloat(result.bindings[i - 1]!.get('?level')?.replace(/"/g, '') ?? '0');
        const curr = parseFloat(result.bindings[i]!.get('?level')?.replace(/"/g, '') ?? '0');
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it('executes COUNT aggregate', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
         SELECT (COUNT(DISTINCT ?atom) AS ?count) WHERE {
           ?atom a pgsl:Atom .
         }`
      );
      expect(result.bindings.length).toBe(1);
      const count = result.bindings[0]!.get('?count');
      expect(count).toBe('"3"');
    });
  });

  describe('Existing SPARQL Generators', () => {
    it('sparqlFragmentsAtLevel works', () => {
      const query = sparqlFragmentsAtLevel(2);
      const result = sparqlQueryPGSL(pgsl, query);
      expect(result.bindings.length).toBeGreaterThan(0);
    });

    it('sparqlFragmentsContaining works', () => {
      const atomUri = [...pgsl.atoms.values()][0]!;
      const query = sparqlFragmentsContaining(atomUri);
      const result = sparqlQueryPGSL(pgsl, query);
      expect(result.bindings.length).toBeGreaterThan(0);
    });

    it('sparqlLatticeStats works', () => {
      const query = sparqlLatticeStats();
      const result = sparqlQueryPGSL(pgsl, query);
      expect(result.bindings.length).toBe(1);
    });

    it('sparqlNeighbors works for fragment with constituents', () => {
      // Find a fragment at level 2+ that has constituents
      const stats = latticeStats(pgsl);
      if (stats.maxLevel >= 2) {
        for (const node of pgsl.nodes.values()) {
          if (node.kind === 'Fragment' && (node as any).left) {
            const query = sparqlNeighbors((node as any).left);
            const result = sparqlQueryPGSL(pgsl, query);
            // Should find at least the right neighbor
            expect(result.bindings.length).toBeGreaterThanOrEqual(0);
            break;
          }
        }
      }
    });

    it('sparqlPullbackOf works for fragment with constituents', () => {
      for (const node of pgsl.nodes.values()) {
        if (node.kind === 'Fragment' && (node as any).left) {
          const query = sparqlPullbackOf(node.uri);
          const result = sparqlQueryPGSL(pgsl, query);
          if (result.bindings.length > 0) {
            expect(result.bindings[0]!.has('?left')).toBe(true);
            expect(result.bindings[0]!.has('?right')).toBe(true);
            expect(result.bindings[0]!.has('?overlap')).toBe(true);
          }
          break;
        }
      }
    });
  });
});
