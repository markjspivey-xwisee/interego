#!/usr/bin/env node
/**
 * Run the W3C RDF 1.2 Turtle test suite against our parser.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * The SHACL suite (tools/shacl12-w3c) found sixty-five divergences in an engine whose own
 * tests were green, because our tests encoded our own reading of the spec. The parser
 * underneath it had never been measured that way at all, and the first thing found by
 * accident — chasing a SHACL result — was this:
 *
 *   ★ MEASURED. `\\uXXXX` was not decoded. `"\\u0041"` parsed to the six characters
 *     `u0041`, not to `A`. `\\f` became the letter f and `\\b` became the letter b.
 *
 * That is not a missing feature, it is silent data corruption, and it is worst exactly
 * where this repo cares most: UCHAR is how a conservatively-written Turtle document carries
 * any non-ASCII character, and a document round-tripped through this parser had its text
 * CHANGED rather than rejected. In the signing path the canonical bytes then differ from
 * the author's bytes, and the signature covers something the author never wrote.
 *
 * A parser is exactly the kind of component whose bugs are invisible from inside: it decides
 * what the tests themselves are allowed to say. So it gets the same treatment — the
 * specification's own suite, vendored, ratcheted.
 *
 * ── THE TWO TIERS ────────────────────────────────────────────────────────────
 *
 *   SYNTAX  — rdft:TestTurtlePositiveSyntax must parse; rdft:TestTurtleNegativeSyntax must
 *             THROW. The negative half is the one that matters more here: a permissive
 *             parser accepts malformed input and invents an interpretation for it, and
 *             every downstream check then runs against something the author did not write.
 *   EVAL    — rdft:TestTurtleEval parses a .ttl and compares the triples against a .nt.
 *             This is where `\\u0041` -> `A` is caught: the syntax tier is happy either way.
 *
 * Vendored from w3c/rdf-tests @ main, `rdf/rdf12/rdf-turtle/`, for the reason the SHACL
 * fixtures are: a gate that fetches its own oracle is green whenever the network is down.
 *
 *   node tools/rdf12-w3c/run.mjs             # summary
 *   node tools/rdf12-w3c/run.mjs --verbose   # every failing entry
 *   node tools/rdf12-w3c/run.mjs --json      # for the ratchet test
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrig } from '../../packages/core/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, '..', '..', 'tests', 'fixtures', 'rdf12-w3c');

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const RDFT = 'http://www.w3.org/ns/rdftest#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const key = s => (typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`);

/**
 * The entries of one manifest, in file order.
 *
 * ★ Read with our OWN parser, which is the thing under test. That is a real circularity and
 * it is bounded: a parser broken enough to misread the manifest produces a wrong ENTRY COUNT,
 * and the ratchet test asserts the count independently. A subtler parser bug cannot hide
 * here, because the manifest uses only the plainest Turtle in the suite.
 */
function entries(dir) {
  const path = join(SUITE, dir, 'manifest.ttl');
  const doc = parseTrig(readFileSync(path, 'utf8'));
  const out = [];
  for (const s of doc.subjects) {
    const types = (s.properties.get(RDF_TYPE) ?? []).filter(t => t.kind === 'iri').map(t => t.iri);
    const kind = types.find(t => t.startsWith(RDFT));
    if (!kind) continue;
    const action = (s.properties.get(`${MF}action`) ?? [])[0];
    const result = (s.properties.get(`${MF}result`) ?? [])[0];
    const name = (s.properties.get(`${MF}name`) ?? [])[0];
    if (action?.kind !== 'iri') continue;
    out.push({
      id: key(s),
      kind: kind.slice(RDFT.length),
      name: name?.kind === 'literal' ? name.value : key(s),
      action: join(SUITE, dir, action.iri.replace(/^.*\//, '')),
      result: result?.kind === 'iri' ? join(SUITE, dir, result.iri.replace(/^.*\//, '')) : undefined,
    });
  }
  return out;
}

/**
 * Canonical form of a parsed document, for comparing a .ttl against its .nt.
 *
 * ★ BLANK NODE LABELS ARE DELIBERATELY NOT COMPARED. Two parses of the same graph allocate
 * different labels, so comparing them asserts that two allocators agree rather than that two
 * graphs match. Every blank node collapses to the same token, which makes this a comparison
 * up to blank-node identity: it can miss a graph that differs ONLY in how blank nodes are
 * shared. Full isomorphism checking is the correct answer and is a canonicalisation
 * algorithm in its own right; this is the honest approximation, and it is stated here rather
 * than left for a reader to discover from a passing test.
 */
function canonical(text) {
  const doc = parseTrig(text);
  const term = t => {
    if (t.kind === 'iri') return `<${t.iri}>`;
    if (t.kind === 'bnode') return '_:b';
    if (t.kind === 'triple') {
      return `<<( ${term(t.subject)} <${t.predicate}> ${term(t.object)} )>>`;
    }
    const lang = t.language ? `@${t.language.toLowerCase()}` : '';
    const dt = t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string'
      ? `^^<${t.datatype}>` : '';
    return `${JSON.stringify(t.value)}${lang}${dt}`;
  };
  // ★ DEDUPLICATED, because an RDF graph is a SET. `:s :p :o {| … |} .` written twice
  // asserts the base triple ONCE and creates two distinct reifiers; a parser that keeps a
  // per-subject ARRAY of objects reports the base triple twice, and comparing multisets
  // would call that a mismatch. The duplication is in the representation, not in the graph.
  const lines = new Set();
  for (const s of doc.subjects) {
    const subj = typeof s.subject === 'string' ? `<${s.subject}>` : '_:b';
    for (const [p, terms] of s.properties) {
      for (const t of terms) lines.add(`${subj} <${p}> ${term(t)} .`);
    }
  }
  return [...lines].sort().join('\n');
}

const rows = [];
for (const dir of ['syntax', 'eval']) {
  for (const e of entries(dir)) {
    if (!existsSync(e.action)) { rows.push({ ...e, state: 'missing' }); continue; }
    const text = readFileSync(e.action, 'utf8');
    if (e.kind === 'TestTurtlePositiveSyntax') {
      try { parseTrig(text); rows.push({ ...e, state: 'pass' }); }
      catch (err) { rows.push({ ...e, state: 'fail', why: `should parse, threw: ${err.message}` }); }
    } else if (e.kind === 'TestTurtleNegativeSyntax' || e.kind === 'TestTurtleNegativeEval') {
      try {
        parseTrig(text);
        rows.push({ ...e, state: 'fail', why: 'should have been REJECTED, parsed cleanly' });
      } catch { rows.push({ ...e, state: 'pass' }); }
    } else if (e.kind === 'TestTurtleEval') {
      if (!e.result || !existsSync(e.result)) { rows.push({ ...e, state: 'missing' }); continue; }
      try {
        const got = canonical(text);
        const want = canonical(readFileSync(e.result, 'utf8'));
        rows.push(got === want
          ? { ...e, state: 'pass' }
          : { ...e, state: 'fail', why: 'triples differ', got, want });
      } catch (err) { rows.push({ ...e, state: 'fail', why: `threw: ${err.message}` }); }
    } else {
      rows.push({ ...e, state: 'skipped', why: `unhandled entry type ${e.kind}` });
    }
  }
}

const by = s => rows.filter(r => r.state === s);
const kindOf = k => rows.filter(r => r.kind === k);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    total: rows.length,
    pass: by('pass').length,
    fail: by('fail').length,
    missing: by('missing').length,
    skipped: by('skipped').length,
    positive: kindOf('TestTurtlePositiveSyntax').length,
    negative: kindOf('TestTurtleNegativeSyntax').length,
    evaluated: kindOf('TestTurtleEval').length,
    failing: by('fail').map(r => `${r.name} (${r.action.replace(/^.*[/\\]/, '')})`),
  }, null, 2));
  process.exit(0);
}

console.log('\nW3C RDF 1.2 Turtle test suite — vendored from w3c/rdf-tests @ main\n');
if (process.argv.includes('--verbose')) {
  for (const r of by('fail')) {
    console.log(`  FAIL  ${r.action.replace(/^.*[/\\]/, '').padEnd(34)} ${r.name}`);
    console.log(`        ${r.why}`);
    if (r.got !== undefined) {
      console.log(`        got : ${r.got.split('\n').join('\n              ') || '(nothing)'}`);
      console.log(`        want: ${r.want.split('\n').join('\n              ') || '(nothing)'}`);
    }
  }
  for (const r of by('skipped')) console.log(`  SKIP  ${r.name} — ${r.why}`);
  console.log('');
}
console.log(`  entries              ${rows.length}`);
console.log(`    positive syntax    ${kindOf('TestTurtlePositiveSyntax').length}`);
console.log(`    negative syntax    ${kindOf('TestTurtleNegativeSyntax').length}`);
console.log(`    eval (ttl vs nt)   ${kindOf('TestTurtleEval').length}`);
console.log(`  PASS                 ${by('pass').length}`);
console.log(`  FAIL                 ${by('fail').length}`);
console.log(`  fixture missing      ${by('missing').length}`);
console.log(`  unhandled entry type ${by('skipped').length}\n`);
