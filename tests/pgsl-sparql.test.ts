import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeSparqlString,
  materializeTriples,
  sparqlFragmentsAtLevel,
  sparqlFragmentsContaining,
  sparqlLatticeStats,
  sparqlNeighbors,
  sparqlPullbackOf,
  sparqlQueryPGSL,
} from '@interego/pgsl';
import {
  createPGSL,
  ingest,
  latticeStats,
} from '@interego/pgsl';
import {
  matchPattern,
} from '@interego/pgsl';
import type {
  PGSLInstance,
} from '@interego/pgsl';
import type {
  IRI,
} from '@interego/core';

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
        'https://markjspivey-xwisee.github.io/interego/ns/pgsl#Atom',
      );
      expect(atomTypes.length).toBe(3); // the, cat, sat
    });

    it('materializes fragments as triples', () => {
      const store = materializeTriples(pgsl);
      const fragTypes = matchPattern(
        store, undefined,
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'https://markjspivey-xwisee.github.io/interego/ns/pgsl#Fragment',
      );
      // Level 1 wrappers + level 2 pair + level 3 top
      expect(fragTypes.length).toBeGreaterThan(0);
    });

    it('materializes atom values', () => {
      const store = materializeTriples(pgsl);
      const valueTriples = matchPattern(
        store, undefined,
        'https://markjspivey-xwisee.github.io/interego/ns/pgsl#value',
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
        'https://markjspivey-xwisee.github.io/interego/ns/pgsl#item',
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
        'https://markjspivey-xwisee.github.io/interego/ns/pgsl#level',
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
        'https://markjspivey-xwisee.github.io/interego/ns/pgsl#value',
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
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
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
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
         ASK WHERE { ?x a pgsl:Atom }`
      );
      expect(result.boolean).toBe(true);
    });

    it('ASK query returns false for non-existing patterns', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
         ASK WHERE { ?x pgsl:value "nonexistent" }`
      );
      expect(result.boolean).toBe(false);
    });

    it('SELECT with ORDER BY', () => {
      const store = materializeTriples(pgsl);
      const result = executeSparqlString(store,
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
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
        `PREFIX pgsl: <https://markjspivey-xwisee.github.io/interego/ns/pgsl#>
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

    it('sparqlNeighbors resolves each constituent to its sibling', () => {
      // ★ DOUBLY VACUOUS ORIGINALLY. The whole body sat inside `if (stats.maxLevel >= 2)`, so a
      // lattice that never reached level 2 asserted NOTHING and passed; and the assertion
      // itself read `bindings.length >= 0` directly under a comment saying "should find at
      // least the right neighbor" — the comment said >= 1, the code said >= 0.
      //
      // ★ AND A COUNT WAS STILL NOT ENOUGH. Asserting only `bindings.length > 0` on ONE
      // fragment's `.left` survives deleting the SECOND UNION branch of sparqlNeighbors()
      // outright: a left constituent is still found by the first branch, so the count stays
      // 1 while half the function is gone. Both branches are now exercised (left→right and
      // right→left) and both `?neighbor` and `?parent` are checked BY IDENTITY, so the claim
      // is about content rather than about a count.
      //
      // The fixture is fully determined — ingest(['the','cat','sat']) builds 3 atoms, 3
      // level-1 wrappers, 2 level-2 pullbacks and 1 level-3 join — so the shape is asserted,
      // not guarded on, and `checked` proves the loop body actually ran.
      const stats = latticeStats(pgsl);
      expect(stats.maxLevel).toBe(3);
      let checked = 0;
      for (const node of pgsl.nodes.values()) {
        // Level ≥ 2 fragments are the pullback pairs; level-1 wrappers and atoms have no
        // constituents and no siblings to find. `continue` rather than a filtered array
        // because `Node` is a discriminated union on `kind` and this is what narrows
        // `.left`/`.right` from `IRI | undefined` without a type assertion.
        if (node.kind !== 'Fragment' || !node.left || !node.right) continue;
        const fromLeft = sparqlQueryPGSL(pgsl, sparqlNeighbors(node.left));
        expect(fromLeft.bindings.some(
          b => b.get('?neighbor') === node.right && b.get('?parent') === node.uri,
        )).toBe(true);
        const fromRight = sparqlQueryPGSL(pgsl, sparqlNeighbors(node.right));
        expect(fromRight.bindings.some(
          b => b.get('?neighbor') === node.left && b.get('?parent') === node.uri,
        )).toBe(true);
        checked++;
      }
      expect(checked).toBe(3);
      // ?direction is deliberately NOT asserted: sparqlNeighbors() emits
      // BIND("right" AS ?direction) inside each UNION branch, and parseSparql strips UNION
      // blocks from the WHERE text before scanning for BIND
      // (packages/pgsl/src/sparql-engine.ts:399 then :420), so query.bind is empty and
      // ?direction never appears in a binding. Asserting it here would make this test fail
      // for an engine gap it does not own.
    });

    it('sparqlPullbackOf works for fragment with constituents', () => {
      for (const node of pgsl.nodes.values()) {
        if (node.kind === 'Fragment' && node.left) {
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
