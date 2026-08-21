#!/usr/bin/env node
/**
 * Run the W3C SHACL 1.2 SPARQL Extension tests — the `sparql/` tree.
 *
 * ── WHY THIS EXISTS BEFORE THE FEATURE DOES ──────────────────────────────────
 *
 * 45 approved entries were vendored into `tests/fixtures/shacl12-w3c/sparql/` and counted by
 * NOTHING. The Core runner scans `core/` and `node-expr/constraints/`; the node-expression
 * runner recognises `sht:EvalNodeExpr`. Neither sees this tree.
 *
 * ★ AN UNCOUNTED FIXTURE TREE IS WORSE THAN NO FIXTURE TREE. It reads, to anyone browsing
 * the repo, as coverage — 45 files of it — while asserting nothing at all. This harness
 * exists so the number is on the record from the start, including when the number is small.
 *
 * ── THE TWO ENTRY KINDS ──────────────────────────────────────────────────────
 *
 *   sht:Validate  26 entries. A SHACL-SPARQL constraint (sh:sparql / sh:select / sh:ask,
 *                 SPARQL-based constraint components, validators). 21 expect a
 *                 sh:ValidationReport; 5 expect `sht:Failure`, meaning validation must
 *                 ABORT — those are the pre-binding rules a conforming implementation is
 *                 required to REFUSE rather than execute.
 *   sht:Infer     19 entries. SPARQL rules (sh:rule / sh:SPARQLRule / sh:construct). The
 *                 comparison is the DELTA — triples inferred, not the whole graph.
 *
 * ── ENTRIES ARE FOUND BY FOLLOWING mf:include, NOT BY GLOBBING ───────────────
 *
 * ★ AND THAT IS NOT PEDANTRY. `rules/rdfs/rdfs1.ttl` is included by no manifest, is a
 * byte-level near-duplicate of `rectangle-condition.ttl`, and declares its entry with the
 * SAME relative IRI as the file that IS included. A glob-based runner picks it up as a 45th
 * entry, and then two different files claim one identity. The manifest is the authority on
 * what the suite contains; the directory listing is not.
 *
 *   node tools/shacl12-w3c/sparql.mjs [--verbose|--json]
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { parseTrig, validateAgainstShape } from '../../packages/core/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, '..', '..', 'tests', 'fixtures', 'shacl12-w3c', 'sparql');

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const SHT = 'http://www.w3.org/ns/shacl-test#';
const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

const key = s => (typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`);
const one = (subj, pred) => (subj?.properties.get(pred) ?? [])[0];
const nodeFor = (doc, t) => {
  if (!t) return undefined;
  const k = t.kind === 'iri' ? t.iri : t.kind === 'bnode' ? `_:${t.id}` : undefined;
  return k === undefined ? undefined : doc.subjects.find(s => key(s) === k);
};
const text = t => (t?.kind === 'iri' ? t.iri : t?.kind === 'literal' ? t.value : undefined);

function listOf(doc, term) {
  if (!term || (term.kind === 'iri' && term.iri === RDF_NIL)) return [];
  const out = [];
  let cur = term;
  for (let i = 0; i < 4096; i++) {
    if (cur.kind === 'iri' && cur.iri === RDF_NIL) return out;
    const cell = nodeFor(doc, cur);
    const first = one(cell, RDF_FIRST);
    const rest = one(cell, RDF_REST);
    if (!first) return out;
    out.push(first);
    if (!rest) return out;
    cur = rest;
  }
  return out;
}

/** Every entry reachable from a manifest, following mf:include depth-first. */
function collect(manifestPath, seen = new Set(), out = []) {
  const abs = resolve(manifestPath);
  if (seen.has(abs) || !existsSync(abs)) return out;
  seen.add(abs);
  let doc;
  try { doc = parseTrig(readFileSync(abs, 'utf8')); }
  catch (e) { out.push({ file: abs, state: 'error', why: `parse: ${e.message}` }); return out; }

  for (const s of doc.subjects) {
    const types = (s.properties.get(RDF_TYPE) ?? []).filter(t => t.kind === 'iri').map(t => t.iri);
    if (!types.includes(`${MF}Manifest`)) continue;
    // ★ mf:include IS A REPEATED PREDICATE, NOT AN rdf:List, and its values are RELATIVE
    // PATHS INTO SUBDIRECTORIES. Reading only the first value found one sub-manifest;
    // stripping the directory off the path found none. Both mistakes report the same thing
    // — "0 entries" — which is exactly the number a runner over an empty tree reports, so
    // neither announces itself.
    for (const inc of s.properties.get(`${MF}include`) ?? []) {
      if (inc.kind === 'iri') collect(join(dirname(abs), inc.iri), seen, out);
    }
    for (const e of listOf(doc, one(s, `${MF}entries`))) {
      const entry = nodeFor(doc, e);
      if (entry) out.push({ file: abs, doc, entry });
    }
  }
  return out;
}

const rows = [];
for (const item of collect(join(SUITE, 'manifest.ttl'))) {
  const rel = relative(SUITE, item.file).replaceAll('\\', '/');
  if (item.state === 'error') { rows.push({ rel, name: rel, state: 'error', why: item.why }); continue; }
  const { doc, entry } = item;
  const types = (entry.properties.get(RDF_TYPE) ?? []).filter(t => t.kind === 'iri').map(t => t.iri);
  const kind = types.includes(`${SHT}Validate`) ? 'Validate'
    : types.includes(`${SHT}Infer`) ? 'Infer' : undefined;
  const name = text(one(entry, 'http://www.w3.org/2000/01/rdf-schema#label')) ?? key(entry);
  if (kind === undefined) { rows.push({ rel, name, state: 'unknown-kind' }); continue; }
  const status = text(one(entry, `${MF}status`));
  if (status !== `${SHT}approved`) { rows.push({ rel, name, kind, state: 'unapproved' }); continue; }

  const action = nodeFor(doc, one(entry, `${MF}action`));
  const resultTerm = one(entry, `${MF}result`);
  const expectsFailure = resultTerm?.kind === 'iri' && resultTerm.iri === `${SHT}Failure`;

  // ── the data and shapes graphs ──
  const sibling = t => {
    if (!t || t.kind !== 'iri' || t.iri === '') return undefined;
    const p = join(dirname(item.file), t.iri);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const self = readFileSync(item.file, 'utf8');
  const dataText = sibling(one(action, `${SHT}dataGraph`));
  const shapesText = sibling(one(action, `${SHT}shapesGraph`));
  if (dataText === null || shapesText === null) {
    rows.push({ rel, name, kind, state: 'notrun', why: 'a named graph file is not vendored' });
    continue;
  }

  if (kind === 'Infer') {
    // Not attempted: the rules engine is a separate project. Recorded as NOT RUN with the
    // reason rather than as a failure, because "we did not try" and "we tried and were
    // wrong" are different facts and a single number hides which one this is.
    rows.push({ rel, name, kind, state: 'notrun', why: 'sh:rule / SPARQL rules not implemented' });
    continue;
  }

  const report = nodeFor(doc, resultTerm);
  const expectConforms = text(one(report, `${SH}conforms`)) === 'true';

  let got;
  try {
    got = validateAgainstShape(dataText ?? self, shapesText ?? self, {});
  } catch (e) {
    // A throw IS the expected outcome for an sht:Failure entry.
    rows.push(expectsFailure
      ? { rel, name, kind, state: 'pass' }
      : { rel, name, kind, state: 'fail', why: `threw: ${String(e.message).slice(0, 90)}` });
    continue;
  }
  if (expectsFailure) {
    rows.push({ rel, name, kind, state: 'fail', why: 'expected the validation to ABORT; it returned a report' });
    continue;
  }
  rows.push(got.conforms === expectConforms
    ? { rel, name, kind, state: 'pass' }
    : { rel, name, kind, state: 'fail', why: `conforms: expected ${expectConforms}, got ${got.conforms}` });
}

const by = st => rows.filter(r => r.state === st);
const kindOf = k => rows.filter(r => r.kind === k);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    total: rows.length,
    validate: kindOf('Validate').length,
    infer: kindOf('Infer').length,
    pass: by('pass').length,
    fail: by('fail').length,
    error: by('error').length,
    notRun: by('notrun').length,
    unapproved: by('unapproved').length,
    failing: [...by('fail'), ...by('error')].map(r => `${r.rel}: ${r.name} — ${r.why ?? ''}`),
    notRunFiles: by('notrun').map(r => `${r.rel}: ${r.why}`),
  }, null, 2));
  process.exit(0);
}

console.log('\nW3C SHACL 1.2 SPARQL Extensions — entries reached by following mf:include\n');
if (process.argv.includes('--verbose')) {
  for (const r of [...by('fail'), ...by('error')]) {
    console.log(`  FAIL     ${r.rel.padEnd(40)} ${String(r.name).slice(0, 40)}`);
    console.log(`           ${r.why}`);
  }
  for (const r of by('notrun')) console.log(`  NOT RUN  ${r.rel.padEnd(40)} ${r.why}`);
  console.log('');
}
console.log(`  entries reached   ${rows.length}   (sht:Validate ${kindOf('Validate').length}, sht:Infer ${kindOf('Infer').length})`);
console.log(`  PASS              ${by('pass').length}`);
console.log(`  FAIL              ${by('fail').length}`);
console.log(`  ERROR             ${by('error').length}`);
console.log(`  not run           ${by('notrun').length}   (each with its reason under --verbose)`);
console.log(`  unapproved        ${by('unapproved').length}\n`);
