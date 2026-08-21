#!/usr/bin/env node
/**
 * Run the W3C SHACL 1.2 NODE EXPRESSION tests against our evaluator.
 *
 * ── WHAT THIS AREA IS ────────────────────────────────────────────────────────
 *
 * SHACL 1.2 adds a small functional language for computing a SEQUENCE of RDF terms from a
 * focus node — `shnex:pathValues`, `shnex:count`, `shnex:if`, `shnex:orderBy`, and about
 * twenty more. It is what `sh:nodeByExpression` and `sh:values` evaluate, and it is the one
 * part of 1.2 this engine had nothing for at all.
 *
 * ── WHY ONLY PART OF IT IS VENDORED, SAID PLAINLY ────────────────────────────
 *
 * The upstream area has 106 entries. SEVENTY-SIX of them live under `shnex-sparql/` and
 * evaluate a SPARQL expression; SHACL-SPARQL is a separate specification and implementing a
 * SPARQL engine is a different project from implementing SHACL. Those are NOT vendored, and
 * this harness does not pretend they are: the count below is out of the 29 SPARQL-free
 * entries, and the number 106 appears nowhere in it.
 *
 * Recording that here rather than in a commit message, because a harness that reports
 * "29/29" without saying what the 29 is out of is exactly the kind of true-but-misleading
 * number this repo keeps finding in its own history.
 *
 * ── THE COMPARISON ───────────────────────────────────────────────────────────
 *
 * `sht:EvalNodeExpr` evaluates `sht:nodeExpr` against an optional `sht:focusNode` and any
 * `sht:scope-<name>` bindings, and compares the result to `mf:result` — an rdf:List, so the
 * comparison is ORDERED. That matters: `shnex:orderBy` and `shnex:limit` are only meaningful
 * against a sequence, and comparing sets would pass an implementation that ignored both.
 *
 *   node tools/shacl12-w3c/node-expr.mjs [--verbose|--json]
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseTrig, evaluateExpression } from '../../packages/core/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, '..', '..', 'tests', 'fixtures', 'shacl12-w3c', 'node-expr');

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const SHT = 'http://www.w3.org/ns/shacl-test#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

const key = s => (typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`);
const one = (subj, pred) => (subj?.properties.get(pred) ?? [])[0];

function files(dir = SUITE, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (name.endsWith('.ttl') && name !== 'manifest.ttl') out.push(p);
  }
  return out;
}

/** Render a term so two sequences can be compared as strings. */
function show(t) {
  if (t === undefined) return '(undefined)';
  if (t.kind === 'iri') return `<${t.iri}>`;
  if (t.kind === 'bnode') return '_:b';
  if (t.kind === 'triple') return `<<( ${show(t.subject)} <${t.predicate}> ${show(t.object)} )>>`;
  const dt = t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string'
    ? `^^<${t.datatype}>` : '';
  return `${JSON.stringify(t.value)}${t.language ? `@${t.language}` : ''}${dt}`;
}

/**
 * ★ NUMERIC RESULTS COMPARE BY VALUE, NOT BY LEXICAL FORM. `mf:result ( 0 )` is
 * "0"^^xsd:integer, and an implementation that computes a count as "0"^^xsd:integer matches
 * — but a SUM over decimals may legitimately come back "7.0"^^xsd:decimal where the
 * expectation says 7.0, or an aggregate over integers may be typed differently by a
 * conformant engine. Comparing the lexical form would fail for arithmetic nobody disputes.
 * Non-numeric terms still compare exactly.
 */
const NUMERIC = /#(integer|decimal|double|float|long|int|short|byte|nonNegativeInteger|positiveInteger|nonPositiveInteger|negativeInteger|unsignedLong|unsignedInt|unsignedShort|unsignedByte)$/;
function sameTerm(a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'literal' && b.kind === 'literal'
    && NUMERIC.test(a.datatype ?? '') && NUMERIC.test(b.datatype ?? '')) {
    return Number(a.value) === Number(b.value);
  }
  return show(a) === show(b);
}

function listOf(doc, term) {
  if (term === undefined) return [];
  if (term.kind === 'iri' && term.iri === RDF_NIL) return [];
  const out = [];
  let cursor = term;
  for (let i = 0; i < 4096; i++) {
    if (cursor.kind === 'iri' && cursor.iri === RDF_NIL) return out;
    const k = cursor.kind === 'iri' ? cursor.iri : cursor.kind === 'bnode' ? `_:${cursor.id}` : undefined;
    if (k === undefined) return out;
    const cell = doc.subjects.find(s => key(s) === k);
    if (!cell) return out;
    const first = one(cell, RDF_FIRST);
    const rest = one(cell, RDF_REST);
    if (!first) return out;
    out.push(first);
    if (!rest) return out;
    cursor = rest;
  }
  return out;
}

const rows = [];
for (const path of files().sort()) {
  const rel = relative(SUITE, path).replaceAll('\\', '/');
  const text = readFileSync(path, 'utf8');
  let doc;
  try { doc = parseTrig(text); }
  catch (e) { rows.push({ rel, name: rel, state: 'error', why: `parse: ${e.message}` }); continue; }

  for (const s of doc.subjects) {
    const types = (s.properties.get(RDF_TYPE) ?? []).filter(t => t.kind === 'iri').map(t => t.iri);
    if (!types.includes(`${SHT}EvalNodeExpr`)) continue;
    const nameT = one(s, 'http://www.w3.org/2000/01/rdf-schema#label');
    const name = nameT?.kind === 'literal' ? nameT.value : key(s);
    const status = one(s, `${MF}status`);
    if (!(status?.kind === 'iri' && status.iri === `${SHT}approved`)) {
      rows.push({ rel, name, state: 'unapproved' });
      continue;
    }
    const actionT = one(s, `${MF}action`);
    const action = doc.subjects.find(x => key(x) === (actionT?.kind === 'iri' ? actionT.iri : `_:${actionT?.id}`));
    if (!action) { rows.push({ rel, name, state: 'error', why: 'no mf:action' }); continue; }

    const expr = one(action, `${SHT}nodeExpr`);
    const focusNode = one(action, `${SHT}focusNode`);
    const bindings = new Map();
    for (const [pred, terms] of action.properties) {
      if (pred.startsWith(`${SHT}scope-`) && terms[0] !== undefined) {
        bindings.set(pred.slice(`${SHT}scope-`.length), [terms[0]]);
      }
    }
    const want = listOf(doc, one(s, `${MF}result`));

    let got;
    try {
      // ★ evaluateExpression, not evaluateNodeExpression — the wrapper wires shape
      // conformance in. The bare evaluator's five shape-valued operators return nothing
      // without it, and a harness calling it directly would report them as engine failures
      // when they are harness failures.
      got = evaluateExpression(doc, expr, { focusNode, bindings });
    } catch (e) {
      rows.push({ rel, name, state: 'fail', why: `threw: ${e.message}`, want });
      continue;
    }
    // `sht:ignoreOrder true` says the entry is about membership, not sequence — the suite
    // marks it on the queries whose result order is genuinely unspecified. Everything else
    // is compared IN ORDER, which is the only way shnex:orderBy and shnex:limit mean
    // anything.
    const ignoreOrder = one(action, `${SHT}ignoreOrder`)?.value === 'true';
    const cmp = (xs) => (ignoreOrder ? [...xs].map(show).sort() : xs.map(show));
    const gotK = cmp(got);
    const wantK = cmp(want);
    const same = got.length === want.length
      && (ignoreOrder
        ? gotK.every((k, i) => k === wantK[i])
        : got.every((t, i) => sameTerm(t, want[i])));
    rows.push(same
      ? { rel, name, state: 'pass' }
      : { rel, name, state: 'fail', why: 'sequence differs', got, want });
  }
}

const by = st => rows.filter(r => r.state === st);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    total: rows.length,
    pass: by('pass').length,
    fail: by('fail').length,
    error: by('error').length,
    unapproved: by('unapproved').length,
    failing: [...by('fail'), ...by('error')].map(r => `${r.rel}: ${r.name}`),
  }, null, 2));
  process.exit(0);
}

console.log('\nW3C SHACL 1.2 node expressions — the 29 SPARQL-free entries of 106\n');
if (process.argv.includes('--verbose')) {
  for (const r of [...by('fail'), ...by('error')]) {
    console.log(`  FAIL  ${r.rel.padEnd(30)} ${r.name}`);
    console.log(`        ${r.why}`);
    if (r.got) console.log(`        got : ( ${r.got.map(show).join(' ')} )`);
    if (r.want) console.log(`        want: ( ${r.want.map(show).join(' ')} )`);
  }
  console.log('');
}
console.log(`  approved entries  ${rows.length - by('unapproved').length}`);
console.log(`  PASS              ${by('pass').length}`);
console.log(`  FAIL              ${by('fail').length}`);
console.log(`  ERROR             ${by('error').length}`);
console.log(`  unapproved        ${by('unapproved').length}\n`);
