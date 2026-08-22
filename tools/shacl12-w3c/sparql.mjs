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
 *   sht:Infer     18 entries. SPARQL rules — sh:SPARQLRule with a CONSTRUCT, sh:TripleRule
 *                 with three node expressions, shape-bound and global, layered and iterated
 *                 to a fixpoint. The comparison is the DELTA: the triples the rules ADDED,
 *                 not the resulting graph — and it is an ISOMORPHISM, because five expected
 *                 reifiers labelled _:b1.._:b5 are five correct blank nodes by any name.
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
import {
  parseTrig, validateAgainstShape, inferShaclTriples,
} from '../../packages/core/dist/index.js';

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

function termKey(t) {
  switch (t.kind) {
    case 'iri': return `<${t.iri}>`;
    case 'bnode': return `_:${t.id}`;
    case 'triple': return `<<${termKey(t.subject)} <${t.predicate}> ${termKey(t.object)}>>`;
    default:
      return JSON.stringify([t.value, t.datatype ?? '', t.language ?? '']);
  }
}

const hasBnode = t => t.kind === 'bnode'
  || (t.kind === 'triple' && (hasBnode(t.subject) || hasBnode(t.object)));

const showTriple = t => `${termKey(t.s)} <${t.p.replace(/^.*[#/]/, '')}> ${termKey(t.o)}`;

/**
 * Do two sets of triples say the same thing, allowing for DIFFERENT BLANK-NODE LABELS?
 *
 * ★ A BLANK NODE IS NOT A NAME, AND COMPARING ITS LABEL COMPARES THE WRONG THING. The
 * run-once entry expects five reifiers, `_:b1` through `_:b5`, each carrying `rdf:reifies` at
 * a particular triple. An engine that produces exactly those five, labelled anything at all,
 * is CORRECT — and string equality calls it wrong. The inverse matters more: an engine that
 * produces five reifiers all pointing at the SAME triple must be caught, and that one slips
 * past any comparison that merely counts them.
 *
 * So the comparison is an isomorphism — a bijection between their blank nodes and ours under
 * which every triple matches, found by backtracking, because a greedy pairing can commit to an
 * assignment that makes a later triple unmatchable.
 */
function graphsMatch(expected, got) {
  if (expected.length !== got.length) return false;
  const forward = new Map();
  const backward = new Map();
  const usedGot = new Set();

  const unify = (e, g) => {
    if (e.kind === 'bnode') {
      if (g.kind !== 'bnode') return false;
      const f = forward.get(e.id);
      const b = backward.get(g.id);
      if (f !== undefined || b !== undefined) return f === g.id && b === e.id;
      forward.set(e.id, g.id);
      backward.set(g.id, e.id);
      return true;
    }
    if (e.kind === 'triple') {
      return g.kind === 'triple' && e.predicate === g.predicate
        && unify(e.subject, g.subject) && unify(e.object, g.object);
    }
    return termKey(e) === termKey(g);
  };

  // Ground triples first: they pin the most and branch the least.
  const ordered = [...expected].sort((a, b) =>
    (hasBnode(a.s) || hasBnode(a.o) ? 1 : 0) - (hasBnode(b.s) || hasBnode(b.o) ? 1 : 0));

  const rec = i => {
    if (i === ordered.length) return true;
    const e = ordered[i];
    for (let j = 0; j < got.length; j++) {
      if (usedGot.has(j)) continue;
      const g = got[j];
      if (e.p !== g.p) continue;
      const savedF = [...forward];
      const savedB = [...backward];
      if (unify(e.s, g.s) && unify(e.o, g.o)) {
        usedGot.add(j);
        if (rec(i + 1)) return true;
        usedGot.delete(j);
      }
      forward.clear();
      backward.clear();
      for (const [k, v] of savedF) forward.set(k, v);
      for (const [k, v] of savedB) backward.set(k, v);
    }
    return false;
  };
  return rec(0);
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

/**
 * What is still unimplemented, by name and with the reason.
 *
 * ★ IT IS EMPTY, AND THAT IS THE POINT OF HAVING KEPT IT. It held three features and each
 * left by being built, not by being reclassified: SPARQL-based constraint components,
 * user-defined `sh:function`, and SPARQL-based targets. A ledger entries cannot leave is a
 * list of excuses; one they can is a work plan.
 *
 * A failure appearing here now is a REGRESSION, and the gate says so by name.
 */
const KNOWN_UNIMPLEMENTED = {};

/** file -> the feature that explains it. */
const UNIMPLEMENTED_BY_FILE = new Map(
  Object.entries(KNOWN_UNIMPLEMENTED).flatMap(([feature, v]) =>
    v.entries.map(e => [e, feature])));

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
    // ★ THE EXPECTED RESULT IS THE DELTA, IN ONE OF TWO SPELLINGS. Most entries write an
    // rdf:List of `( s p o )` lists; layers-example names a Turtle FILE instead. Both mean
    // the same thing — the triples the rules added — and reading the file form as "the whole
    // resulting graph" would demand the shapes back as well.
    // ★ `mf:result ( )` IS AN EMPTY LIST, AND IT IS ALSO AN IRI — rdf:nil. The deactivated-rule
    // entry expects exactly nothing to be inferred, and reading its rdf:nil as a filename
    // turned the one entry whose expectation is "no output" into "could not run", which is the
    // same word a missing fixture gets.
    let expected;
    if (resultTerm?.kind === 'iri' && resultTerm.iri !== '' && resultTerm.iri !== RDF_NIL) {
      const p = join(dirname(item.file), resultTerm.iri);
      if (!existsSync(p)) {
        rows.push({ rel, name, kind, state: 'notrun', why: 'the result graph file is not vendored' });
        continue;
      }
      const rdoc = parseTrig(readFileSync(p, 'utf8'));
      expected = rdoc.subjects.flatMap(s => [...s.properties].flatMap(([pred, objs]) =>
        objs.map(o => ({
          s: typeof s.subject === 'string'
            ? { kind: 'iri', iri: s.subject } : { kind: 'bnode', id: s.subject.bnode },
          p: pred,
          o,
        }))));
    } else {
      expected = [];
      for (const tl of listOf(doc, resultTerm)) {
        const parts = listOf(doc, tl);
        if (parts.length !== 3 || parts[1].kind !== 'iri') continue;
        expected.push({ s: parts[0], p: parts[1].iri, o: parts[2] });
      }
    }

    let inferred;
    try {
      inferred = inferShaclTriples(dataText ?? self, shapesText ?? self);
    } catch (e) {
      rows.push({ rel, name, kind, state: 'fail', why: `rules engine threw: ${String(e.message).slice(0, 140)}` });
      continue;
    }
    const got = inferred.triples.map(t => ({ s: t.subject, p: t.predicate, o: t.object }));
    rows.push(graphsMatch(expected, got)
      ? { rel, name, kind, state: 'pass' }
      : {
        rel, name, kind, state: 'fail',
        why: `inferred ${got.length}, expected ${expected.length}`
          + `\n           expected: ${expected.map(showTriple).join('\n                     ')}`
          + `\n           got:      ${got.map(showTriple).join('\n                     ')}`,
      });
    continue;
  }

  const report = nodeFor(doc, resultTerm);
  const expectConforms = text(one(report, `${SH}conforms`)) === 'true';

  // ★ THE EXPECTED RESULTS, NOT JUST THE VERDICT — and this harness was verdict-only until a
  // MUTATION PROVED IT TOO WEAK. Defaulting a missing sh:function argument to "" instead of
  // leaving it unbound is a real semantic change: `COALESCE($arg1, 'en')` stops reaching its
  // default. It changes what the function COMPUTES and not whether the graph conforms, so
  // 26 of 26 stayed green with the bug installed.
  //
  // langLabelCount-example is the entry that cares: its expected sh:value is "2 2 1 false",
  // the four call results concatenated. A verdict tells you the constraint fired; the value
  // tells you it fired for the right reason.
  const expected = [];
  for (const rt of report?.properties.get(`${SH}result`) ?? []) {
    const r = nodeFor(doc, rt);
    if (!r) continue;
    expected.push({
      component: text(one(r, `${SH}sourceConstraintComponent`)),
      severity: (text(one(r, `${SH}resultSeverity`)) ?? `${SH}Violation`).replace(SH, ''),
      value: text(one(r, `${SH}value`)),
      path: text(one(r, `${SH}resultPath`)),
      message: text(one(r, `${SH}resultMessage`)),
      focusNode: text(one(r, `${SH}focusNode`)),
      focusIsBlank: one(r, `${SH}focusNode`)?.kind === 'bnode',
      // ★ A BLANK-NODE SOURCE SHAPE IS STILL WORTH COMPARING — as a bnode. Two of the
      // component entries expect results from DIFFERENT sh:property blank nodes of one node
      // shape, and reporting the containing node shape for both matches neither. The label
      // does not survive between graphs, so what is checked is that ours is a blank node too
      // and that distinct expectations map to distinct shapes.
      sourceShape: text(one(r, `${SH}sourceShape`)),
      sourceIsBlank: one(r, `${SH}sourceShape`)?.kind === 'bnode',
    });
  }

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
  // ★ AN ABORT IS NOT A VERDICT, AND MUST NOT BE SCORED AS ONE. The engine reports a
  // constraint it could not evaluate with its own component rather than with
  // sh:SPARQLConstraintComponent, precisely so this harness can tell the two apart. Without
  // that, "we refused because we could not run the rule" scores as a PASS on every entry
  // whose expected verdict is false — measured, three entries flipped to green for exactly
  // that reason the moment the engine started reporting instead of throwing.
  const aborted = got.results.some(r => r.constraintComponent === 'urn:iep:shacl:SparqlRefused');
  if (expectsFailure) {
    rows.push(aborted
      ? { rel, name, kind, state: 'pass' }
      : { rel, name, kind, state: 'fail', why: 'expected the validation to ABORT; it produced a verdict' });
    continue;
  }
  if (aborted) {
    const why = got.results.find(r => r.constraintComponent === 'urn:iep:shacl:SparqlRefused')?.message;
    rows.push({ rel, name, kind, state: 'fail', why: `validation ABORTED: ${String(why).slice(0, 110)}` });
    continue;
  }
  if (got.conforms !== expectConforms) {
    rows.push({ rel, name, kind, state: 'fail',
      why: `conforms: expected ${expectConforms}, got ${got.conforms}` });
    continue;
  }
  // ★ ONE-TO-ONE, IN BOTH DIRECTIONS. "Every expected result has SOME counterpart" is the
  // comparison that lets an over-reporting engine pass: report the right violation twice, or
  // report it correctly and then invent a second one, and a one-directional check is still
  // satisfied. Measured: `sh:sparql` on a property shape was reported TWICE — once by the
  // property shape and once by the node shape wrapping it — and once with `$PATH` left
  // free, matching every predicate of the focus node. The expected report has exactly one
  // result, and the entry was passing.
  //
  // Each expectation therefore CONSUMES a result, and anything left over is a failure.
  const shaclResults = got.results.filter(r => String(r.constraintComponent).startsWith(SH)
    || !String(r.constraintComponent).startsWith('urn:'));
  const pool = [...shaclResults];
  const unmatched = [];
  for (const e of expected) {
    const i = pool.findIndex(r =>
      (e.component === undefined || r.constraintComponent === e.component)
      && r.severity === e.severity
      && (e.value === undefined || String(r.value) === e.value)
      && (e.path === undefined || String(r.path) === e.path)
      // The message is compared only where the entry states one; where it does not, the
      // wording is the implementation's own and is not the spec's business.
      && (e.message === undefined || String(r.message) === e.message)
      && (e.focusNode === undefined || e.focusIsBlank || String(r.focusNode) === e.focusNode)
      && (e.sourceShape === undefined
        || (e.sourceIsBlank ? String(r.sourceShape).startsWith('_:') : r.sourceShape === e.sourceShape)));
    if (i < 0) unmatched.push(e);
    else pool.splice(i, 1);
  }
  const show = r => `${String(r.constraintComponent ?? r.component).replace(SH, 'sh:')}`
    + ` sev=${r.severity}${r.value === undefined ? '' : ` value=${JSON.stringify(String(r.value))}`}`
    + `${r.path === undefined ? '' : ` path=${String(r.path)}`}`
    + `${r.message === undefined ? '' : ` msg=${JSON.stringify(String(r.message).slice(0, 60))}`}`;
  rows.push(unmatched.length === 0 && pool.length === 0
    ? { rel, name, kind, state: 'pass' }
    : { rel, name, kind, state: 'fail',
      why: 'right verdict, wrong result(s):'
        + (unmatched.length > 0 ? ` MISSING ${unmatched.map(show).join('; ')}` : '')
        + (pool.length > 0 ? ` UNEXPECTED ${pool.map(show).join('; ')}` : '')
        + ` | all got: ${shaclResults.map(show).join(' ; ')}` });
}

const by = st => rows.filter(r => r.state === st);
const kindOf = k => rows.filter(r => r.kind === k);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    total: rows.length,
    validate: kindOf('Validate').length,
    infer: kindOf('Infer').length,
    pass: by('pass').length,
    // ★ COUNTED SEPARATELY BECAUSE THEY RATCHET SEPARATELY. One `pass` covering both kinds
    // lets a validation regression hide behind an inference gain, and vice versa — the two
    // numbers move for unrelated reasons and a gate over their sum can only say "something
    // changed".
    passValidate: by('pass').filter(r => r.kind === 'Validate').length,
    passInfer: by('pass').filter(r => r.kind === 'Infer').length,
    fail: by('fail').length,
    error: by('error').length,
    notRun: by('notrun').length,
    unapproved: by('unapproved').length,
    failing: [...by('fail'), ...by('error')].map(r => `${r.rel}: ${r.name} — ${r.why ?? ''}`),
    unexplained: [...by('fail'), ...by('error')]
      .filter(r => !UNIMPLEMENTED_BY_FILE.has(r.rel)).map(r => r.rel),
    features: Object.keys(KNOWN_UNIMPLEMENTED),
    notRunFiles: by('notrun').map(r => `${r.rel}: ${r.why}`),
  }, null, 2));
  process.exit(0);
}

console.log('\nW3C SHACL 1.2 SPARQL Extensions — entries reached by following mf:include\n');
if (process.argv.includes('--verbose')) {
  for (const r of [...by('fail'), ...by('error')]) {
    console.log(`  FAIL     ${r.rel.padEnd(40)} ${String(r.name).slice(0, 40)}`);
    console.log(`           ${r.why}`);
    const feature = UNIMPLEMENTED_BY_FILE.get(r.rel);
    if (feature) console.log(`           feature: ${feature}`);
  }
  for (const r of by('notrun')) console.log(`  NOT RUN  ${r.rel.padEnd(40)} ${r.why}`);
  console.log('');
}
console.log(`  entries reached   ${rows.length}   (sht:Validate ${kindOf('Validate').length}, sht:Infer ${kindOf('Infer').length})`);
console.log(`  PASS              ${by('pass').length}`
  + `   (Validate ${by('pass').filter(r => r.kind === 'Validate').length}`
  + `, Infer ${by('pass').filter(r => r.kind === 'Infer').length})`);
console.log(`  FAIL              ${by('fail').length}`);
{
  const unexplained = [...by('fail'), ...by('error')].filter(r => !UNIMPLEMENTED_BY_FILE.has(r.rel));
  const byFeature = new Map();
  for (const r of [...by('fail'), ...by('error')]) {
    const f = UNIMPLEMENTED_BY_FILE.get(r.rel);
    if (f) byFeature.set(f, (byFeature.get(f) ?? 0) + 1);
  }
  for (const [f, n] of byFeature) console.log(`      ${String(n).padStart(2)} awaiting: ${f}`);
  if (unexplained.length > 0) console.log(`      NOT EXPLAINED: ${unexplained.map(r => r.rel).join(', ')}`);
}
console.log(`  ERROR             ${by('error').length}`);
console.log(`  not run           ${by('notrun').length}   (each with its reason under --verbose)`);
console.log(`  unapproved        ${by('unapproved').length}\n`);
