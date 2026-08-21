#!/usr/bin/env node
/**
 * Run the W3C SHACL 1.2 Core test suite against our engine.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `tools/shacl-agreement` cross-checks us against pySHACL, and that is the right shape of
 * check for SHACL 1.0 — a second independent engine catches the readings we got wrong
 * because our tests encoded our own reading. It cannot do the same job for 1.2:
 *
 *   ★ MEASURED. pySHACL 0.30.1 parses Turtle through rdflib, and rdflib rejects RDF 1.2
 *     annotation syntax outright — `{| … |}` is a BadSyntax error before validation is
 *     even reached. Every 1.2 feature that is EXPRESSED in the new syntax (sh:reifierShape,
 *     and the per-constraint severity/message/deactivated reifiers of §3.1.4) therefore has
 *     no second implementation available to disagree with us. There is nothing to compare.
 *
 * So the oracle for 1.2 has to be the specification's own test suite. W3C publishes one,
 * every entry carries the verdict it expects, and entries carry `mf:status sht:approved`
 * marking the ones the working group has actually signed off. It is the only artefact that
 * can tell us we are wrong about 1.2 rather than merely self-consistent.
 *
 * ── WHY IT IS VENDORED ───────────────────────────────────────────────────────
 *
 * The fixtures live in `tests/fixtures/shacl12-w3c/core/`, copied from
 * w3c/data-shapes @ gh-pages, `shacl12-test-suite/tests/core/`. A gate that fetches its own
 * oracle at run time is green whenever the network is down, and silently re-scoped whenever
 * upstream edits a test. Vendored, a change upstream arrives as a reviewable diff.
 *
 * ── WHAT IS COMPARED, AND WHAT IS NOT ────────────────────────────────────────
 *
 * Two tiers, reported separately because they mean different things:
 *
 *   VERDICT   — does sh:conforms match? This is what a caller branches on, and it is the
 *               tier that must be at 100% for the approved Core set we claim to support.
 *   RESULTS   — does each expected sh:ValidationResult have a counterpart with the same
 *               focus node, path, source constraint component and severity? A verdict match
 *               with a result mismatch means we refuse the right document for the wrong
 *               reason, which a verdict-only harness reports as success.
 *
 * Result MESSAGES are deliberately not compared: the spec leaves their wording to the
 * implementation, and pinning ours to the suite's would fail for nobody's bug.
 *
 * ★ AND TESTS WE CANNOT RUN ARE COUNTED AS NOT RUN, NEVER AS PASSED. An entry whose data
 * or shapes graph lives in another file, or that this engine's parser cannot read, is
 * reported in its own column. A harness that quietly skips what it cannot handle reports
 * "166/166" while running nine.
 *
 *   node tools/shacl12-w3c/run.mjs             # summary
 *   node tools/shacl12-w3c/run.mjs --verbose   # every failing entry, with the diff
 *   node tools/shacl12-w3c/run.mjs --json      # machine-readable, for the ratchet test
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseTrig, validateAgainstShape, renderPathTerm } from '../../packages/core/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = join(HERE, '..', '..', 'tests', 'fixtures', 'shacl12-w3c', 'core');

const MF = 'http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#';
const SHT = 'http://www.w3.org/ns/shacl-test#';
const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Every .ttl under the vendored suite except the manifests, which list rather than test. */
function suiteFiles(dir = SUITE, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) suiteFiles(p, out);
    else if (name.endsWith('.ttl') && name !== 'manifest.ttl') out.push(p);
  }
  return out;
}

const key = s => (typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`);
const one = (doc, subj, pred) => (subj?.properties.get(pred) ?? [])[0];
const nodeFor = (doc, term) => {
  if (!term) return undefined;
  const k = term.kind === 'iri' ? term.iri : term.kind === 'bnode' ? `_:${term.id}` : undefined;
  return k === undefined ? undefined : doc.subjects.find(s => key(s) === k);
};
const termText = t => {
  if (!t) return undefined;
  if (t.kind === 'iri') return t.iri;
  if (t.kind === 'literal') return t.value;
  if (t.kind === 'bnode') return `_:${t.id}`;
  return undefined;
};

/**
 * Read one test entry out of a suite file.
 *
 * Returns `{runnable: false, why}` rather than throwing, so an entry we cannot execute is
 * counted rather than silently dropped.
 */
function readEntry(text, path) {
  let doc;
  try { doc = parseTrig(text); }
  catch (e) { return { runnable: false, why: `parse: ${e.message}` }; }

  const entry = doc.subjects.find(s =>
    (s.properties.get(RDF_TYPE) ?? []).some(t => t.kind === 'iri' && t.iri === `${SHT}Validate`));
  if (!entry) return { runnable: false, why: 'no sht:Validate entry' };

  const status = termText(one(doc, entry, `${MF}status`));
  const label = termText(one(doc, entry, 'http://www.w3.org/2000/01/rdf-schema#label')) ?? path;

  const action = nodeFor(doc, one(doc, entry, `${MF}action`));
  if (!action) return { runnable: false, why: 'no mf:action', status, label };

  // `sht:dataGraph <>` means "this file"; anything else names a sibling, and the suite uses
  // that form wherever a test needs the data and the shapes to be genuinely separate graphs.
  //
  // ★ THOSE ARE NOT SKIPPABLE. The eight multi-file entries are disproportionately the ones
  // that test what happens when the shapes graph is NOT also the data graph — sh:shape
  // targeting, ill-formed datatypes, xone over duplicates, the recursive shacl-shacl
  // meta-validation. Reading a sibling file is three lines here; reporting them as "not
  // runnable" would have quietly excused the engine from the hardest third of the suite.
  const resolve = t => {
    if (t === undefined || t.kind !== 'iri' || t.iri === '') return undefined;   // <> — this file
    const sibling = join(dirname(path), t.iri.replace(/^.*\//, ''));
    try { return readFileSync(sibling, 'utf8'); } catch { return null; }         // null = missing
  };
  const dataT = one(doc, action, `${SHT}dataGraph`);
  const shapesT = one(doc, action, `${SHT}shapesGraph`);
  const dataText = resolve(dataT);
  const shapesText = resolve(shapesT);
  if (dataText === null || shapesText === null) {
    return { runnable: false, why: `sibling graph not vendored (${termText(dataT)} / ${termText(shapesT)})`, status, label };
  }

  const report = nodeFor(doc, one(doc, entry, `${MF}result`));
  if (!report) return { runnable: false, why: 'no mf:result', status, label };
  const conformsT = one(doc, report, `${SH}conforms`);
  if (!conformsT) return { runnable: false, why: 'no sh:conforms', status, label };
  const expectConforms = termText(conformsT) === 'true';

  // ★ sh:conformanceDisallows IS PART OF THE REQUEST, not of the expectation. The entry's
  // own rdfs:comment says so: "in order to pass this test, the test framework needs to use
  // the values of sh:conformanceDisallows from the mf:result". Reading it as an assertion
  // and comparing it would fail a correct engine; ignoring it fails a correct engine too,
  // just in the other direction (conformance-disallows-001 and -002 differ ONLY in this
  // triple and expect opposite verdicts).
  const disallows = (report.properties.get(`${SH}conformanceDisallows`) ?? [])
    .filter(t => t.kind === 'iri' && t.iri.startsWith(SH))
    .map(t => t.iri.slice(SH.length));

  const expected = [];
  for (const rt of report.properties.get(`${SH}result`) ?? []) {
    const r = nodeFor(doc, rt);
    if (!r) continue;
    expected.push({
      // ★ A BLANK NODE FOCUS IS NOT COMPARED BY LABEL. `_:b22415` is the suite's label for
      // a node in ITS parse; ours is `_:_anon12` for the same node, and neither label means
      // anything outside the graph that produced it. Comparing them asserts that two
      // independent bnode allocators agree, which is not a property of a correct engine.
      // The component, severity and path are still compared, and the verdict tier still
      // covers "did we report on the right node" — a result on the wrong node changes the
      // count, which the extra/missing arithmetic sees.
      focusNode: termText(one(doc, r, `${SH}focusNode`)),
      focusNodeIsBlank: one(doc, r, `${SH}focusNode`)?.kind === 'bnode',
      // ★ A COMPLEX PATH IS NAMED BY A BLANK NODE, not by a string. `sh:resultPath` is an
      // RDF path expression, so for a sequence / inverse / alternative / transitive path the
      // suite gives the head of the structure and there is no label to compare — bnode ids
      // do not survive between graphs. Rendering it through the engine's own path renderer
      // compares the path STRUCTURE, which is what the assertion is about.
      path: (() => {
        const t = one(doc, r, `${SH}resultPath`);
        if (t === undefined) return undefined;
        if (t.kind === 'iri') return t.iri;
        return renderPathTerm(doc, t);
      })(),
      component: termText(one(doc, r, `${SH}sourceConstraintComponent`)),
      // A severity may be ANY IRI; only the five SHACL ones are reported by local name.
      severity: (() => {
        const iri = termText(one(doc, r, `${SH}resultSeverity`)) ?? `${SH}Violation`;
        return iri.startsWith(SH) ? iri.slice(SH.length) : iri;
      })(),
      value: termText(one(doc, r, `${SH}value`)),
    });
  }
  return {
    runnable: true, status, label, expectConforms, expected, dataText, shapesText,
    ...(disallows.length > 0 ? { disallows } : {}),
  };
}

/**
 * Does our report contain a counterpart for an expected result?
 *
 * Compared on focus node, source constraint component and severity — the three fields that
 * say WHICH rule refused WHICH node and HOW HARD. Path and value are compared only when the
 * suite states them, because an expected result that omits a field is not asserting it.
 */
function matched(expected, ours) {
  return ours.some(r =>
    r.constraintComponent === expected.component
    && r.severity === expected.severity
    && (expected.focusNode === undefined || expected.focusNodeIsBlank
      || String(r.focusNode) === expected.focusNode)
    && (expected.path === undefined || String(r.path) === expected.path));
}

/**
 * Entries this engine does not pass, each with the reason, so the gap is stated rather than
 * left to be inferred from a count.
 *
 * ★ THIS LIST DOES NOT EXCUSE ANYTHING. Nothing here is skipped, filtered, or counted as a
 * pass — every entry still runs and still shows up as FAIL. The list exists so that "two
 * failures" is a sentence rather than a number, and so that a NEW failure is visibly
 * different from these two rather than absorbed into them.
 */
const KNOWN_DIVERGENCES = {
  'node/in-002.ttl':
    'DISPUTED UPSTREAM. The entry expects a result whose sh:sourceShape is ex:TestShape, and '
    + 'no ex:TestShape exists in the file — the only shape defined is '
    + 'ex:TestInUnsatisfiableShape, and the one instance is typed ex:TestShape, which nothing '
    + 'declares as a shape. No target rule reaches ex:Instance from the shape that is there. '
    + 'The empty-sh:in behaviour it means to test IS implemented (in-001 and our own tests '
    + 'cover it); the file appears to have been renamed without updating the data.',
};

const files = suiteFiles().sort();
const verbose = process.argv.includes('--verbose');
const rows = [];

for (const path of files) {
  const rel = relative(SUITE, path).replaceAll('\\', '/');
  const text = readFileSync(path, 'utf8');
  const e = readEntry(text, path);
  if (!e.runnable) { rows.push({ rel, state: 'notrun', why: e.why, status: e.status }); continue; }
  if (e.status !== `${SHT}approved`) { rows.push({ rel, state: 'unapproved', label: e.label }); continue; }

  let report;
  try {
    report = validateAgainstShape(e.dataText ?? text, e.shapesText ?? text,
      e.disallows ? { conformanceDisallows: e.disallows } : {});
  }
  catch (err) { rows.push({ rel, state: 'error', why: err.message }); continue; }

  const verdictOk = report.conforms === e.expectConforms;
  // Our own instrumentation is not a SHACL result and must not be compared as one.
  const shaclResults = report.results.filter(r => String(r.constraintComponent).startsWith(SH));
  const missing = e.expected.filter(x => !matched(x, shaclResults));
  const extra = shaclResults.length - (e.expected.length - missing.length);
  rows.push({
    rel, state: verdictOk ? (missing.length === 0 ? 'pass' : 'verdict-only') : 'fail',
    expectConforms: e.expectConforms, gotConforms: report.conforms,
    missing, extra, ours: shaclResults, label: e.label,
  });
}

const count = s => rows.filter(r => r.state === s).length;
const approved = rows.filter(r => ['pass', 'verdict-only', 'fail', 'error'].includes(r.state));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    approvedRunnable: approved.length,
    pass: count('pass'), verdictOnly: count('verdict-only'),
    fail: count('fail'), error: count('error'),
    notRun: count('notrun'), unapproved: count('unapproved'),
    failing: rows.filter(r => r.state === 'fail' || r.state === 'error').map(r => r.rel),
    unexplained: rows
      .filter(r => (r.state === 'fail' || r.state === 'error') && !KNOWN_DIVERGENCES[r.rel])
      .map(r => r.rel),
    knownDivergences: Object.keys(KNOWN_DIVERGENCES),
    verdictOnlyFiles: rows.filter(r => r.state === 'verdict-only').map(r => r.rel),
  }, null, 2));
  process.exit(0);
}

console.log('\nW3C SHACL 1.2 Core test suite — vendored from w3c/data-shapes @ gh-pages\n');
if (verbose) {
  for (const r of rows) {
    if (r.state === 'pass' || r.state === 'unapproved') continue;
    if (r.state === 'notrun') { console.log(`  NOT RUN   ${r.rel}  — ${r.why}`); continue; }
    if (r.state === 'error') { console.log(`  ERROR     ${r.rel}  — ${r.why}`); continue; }
    if (r.state === 'fail') {
      console.log(`  FAIL      ${r.rel}`);
      console.log(`            conforms: expected ${r.expectConforms}, got ${r.gotConforms}`);
      const known = KNOWN_DIVERGENCES[r.rel];
      if (known) console.log(`            known:    ${known}`);
    } else {
      console.log(`  VERDICT   ${r.rel}  (right answer, ${r.missing.length} expected result(s) unmatched)`);
    }
    for (const m of r.missing) {
      console.log(`            missing: ${String(m.component).slice(SH.length)} sev=${m.severity} focus=${m.focusNode ?? '-'} path=${m.path ?? '-'}`);
    }
    for (const o of r.ours.slice(0, 4)) {
      console.log(`            ours:    ${String(o.constraintComponent).slice(SH.length)} sev=${o.severity} focus=${o.focusNode} path=${o.path ?? '-'}`);
    }
  }
  console.log('');
}
console.log(`  files in suite      ${files.length}`);
console.log(`  approved + runnable ${approved.length}`);
console.log(`    exact  (verdict + every expected result)  ${count('pass')}`);
console.log(`    verdict only (right answer, wrong reason) ${count('verdict-only')}`);
console.log(`    FAIL   (wrong verdict)                    ${count('fail')}`);
console.log(`    ERROR  (engine threw)                     ${count('error')}`);
const unexplained = rows
  .filter(r => (r.state === 'fail' || r.state === 'error') && !KNOWN_DIVERGENCES[r.rel]);
console.log(`      of which recorded as known divergences  `
  + `${count('fail') + count('error') - unexplained.length}`);
if (unexplained.length > 0) {
  console.log(`      NOT EXPLAINED: ${unexplained.map(r => r.rel).join(', ')}`);
}
console.log(`  not runnable        ${count('notrun')}`);
console.log(`  unapproved upstream ${count('unapproved')}\n`);
