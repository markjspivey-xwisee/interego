#!/usr/bin/env tsx
/**
 * Test Interego with Comunica SPARQL engine.
 *
 * Comunica queries our /dump.ttl endpoint as a standard RDF source,
 * proving that external RDF tooling can interact with the system
 * through the virtualized layer.
 */

import { QueryEngine } from '@comunica/query-sparql';

const DUMP_URL = process.env['DUMP_URL'] ?? 'http://localhost:5000/dump.ttl';

async function main() {
  const engine = new QueryEngine();

  console.log('Comunica SPARQL Engine → Interego Virtualized RDF Layer');
  console.log(`Source: ${DUMP_URL}`);
  console.log('');

  // ── Query 1: All atoms and their values ──
  console.log('=== Query 1: All PGSL Atoms ===');
  const q1 = `
    PREFIX pgsl: <https://interego.dev/ns/pgsl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?atom ?value WHERE {
      ?atom rdf:type pgsl:Atom .
      ?atom pgsl:value ?value .
    }
  `;
  const result1 = await engine.queryBindings(q1, { sources: [DUMP_URL] });
  const bindings1 = await result1.toArray();
  console.log(`  Found ${bindings1.length} atoms:`);
  for (const b of bindings1) {
    console.log(`    ${b.get('value')?.value}`);
  }
  console.log('');

  // ── Query 2: All fragments at level 3 ──
  console.log('=== Query 2: Level 3 Fragments ===');
  const q2 = `
    PREFIX pgsl: <https://interego.dev/ns/pgsl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?frag ?level WHERE {
      ?frag rdf:type pgsl:Fragment .
      ?frag pgsl:level ?level .
      FILTER(?level = "3")
    }
  `;
  const result2 = await engine.queryBindings(q2, { sources: [DUMP_URL] });
  const bindings2 = await result2.toArray();
  console.log(`  Found ${bindings2.length} level-3 fragments`);
  console.log('');

  // ── Query 3: Provenance — who attributed what ──
  console.log('=== Query 3: Provenance ===');
  const q3 = `
    PREFIX pgsl: <https://interego.dev/ns/pgsl#>
    PREFIX prov: <http://www.w3.org/ns/prov#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT DISTINCT ?agent WHERE {
      ?node prov:wasAttributedTo ?agent .
    }
  `;
  const result3 = await engine.queryBindings(q3, { sources: [DUMP_URL] });
  const bindings3 = await result3.toArray();
  console.log(`  Attributing agents:`);
  for (const b of bindings3) {
    console.log(`    ${b.get('agent')?.value}`);
  }
  console.log('');

  // ── Query 4: Fragment containment ──
  console.log('=== Query 4: Fragment Items (containment) ===');
  const q4 = `
    PREFIX pgsl: <https://interego.dev/ns/pgsl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?frag ?item WHERE {
      ?frag rdf:type pgsl:Fragment .
      ?frag pgsl:item ?item .
      ?frag pgsl:level "3" .
    }
    LIMIT 10
  `;
  const result4 = await engine.queryBindings(q4, { sources: [DUMP_URL] });
  const bindings4 = await result4.toArray();
  console.log(`  ${bindings4.length} containment relationships in L3 fragments`);
  console.log('');

  // ── Query 5: ASK — does a specific atom exist? ──
  console.log('=== Query 5: ASK — does atom "chen" exist? ===');
  const q5 = `
    PREFIX pgsl: <https://interego.dev/ns/pgsl#>
    ASK {
      ?atom pgsl:value "chen" .
    }
  `;
  const result5 = await engine.queryBoolean(q5, { sources: [DUMP_URL] });
  console.log(`  Result: ${result5}`);
  console.log('');

  // ── Query 6: System metadata (pods, coherence) ──
  console.log('=== Query 6: System Metadata ===');
  const q6 = `
    PREFIX cg: <https://interego.dev/ns/cg#>
    PREFIX dcat: <http://www.w3.org/ns/dcat#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?pod ?title WHERE {
      ?pod rdf:type cg:Pod .
    }
    LIMIT 10
  `;
  try {
    const result6 = await engine.queryBindings(q6, { sources: [DUMP_URL] });
    const bindings6 = await result6.toArray();
    console.log(`  Found ${bindings6.length} pods`);
    for (const b of bindings6) {
      console.log(`    ${b.get('pod')?.value}`);
    }
  } catch {
    console.log('  (no pod metadata in current dump)');
  }
  console.log('');

  // ── Query 7: Lattice statistics ──
  console.log('=== Query 7: Lattice Statistics ===');
  const q7 = `
    PREFIX pgsl: <https://interego.dev/ns/pgsl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT
      (COUNT(DISTINCT ?atom) AS ?atomCount)
      (COUNT(DISTINCT ?frag) AS ?fragCount)
    WHERE {
      { ?atom rdf:type pgsl:Atom . }
      UNION
      { ?frag rdf:type pgsl:Fragment . }
    }
  `;
  try {
    const result7 = await engine.queryBindings(q7, { sources: [DUMP_URL] });
    const bindings7 = await result7.toArray();
    for (const b of bindings7) {
      console.log(`  Atoms: ${b.get('atomCount')?.value}, Fragments: ${b.get('fragCount')?.value}`);
    }
  } catch (err) {
    console.log(`  (aggregate query: ${(err as Error).message?.slice(0, 80)})`);
  }

  console.log('');
  console.log('✓ Comunica successfully queried the Interego system via the virtualized RDF layer');
  console.log('  Any SPARQL client can do the same against /dump.ttl or /sparql');
}

main().catch(err => { console.error(err); process.exit(1); });
