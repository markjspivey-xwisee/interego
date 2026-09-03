#!/usr/bin/env node
// Derivation-lint — enforce spec/DERIVATION.md rule that every
// L2/L3 ontology class has explicit L1 grounding (or is marked
// primitive).
//
// A class is GROUNDED if ANY of these appears in its definition:
//   (a) owl:equivalentClass <L1-or-W3C-term>
//   (b) rdfs:subClassOf <L1-or-W3C-term-or-same-file-grounded-class>
//   (c) iep:constructedFrom (...)
//   (d) explicit primitive marker (rdfs:comment contains "primitive")
//
// Ungrounded classes fail the lint with a non-zero exit code so CI
// blocks on them. Companion to the namespace-coverage check in
// tools/ontology-lint.mjs.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NS_DIR = join(__dirname, '..', 'docs', 'ns');

// Prefixes that count as L1-or-W3C grounding anchors.
const GROUNDING_PREFIXES = new Set([
  // L1 core.
  // ★ `iep` / `ieh` are the CURRENT L1 prefixes; `cg` / `cgh` are their pre-rename
  // aliases, retained for read compatibility. Omitting the current pair meant every
  // class grounded through L1 — i.e. almost all of them — read as ungrounded, and this
  // lint reported 45/97 and failed. It runs in no workflow, so nothing surfaced it.
  'iep', 'ieh', 'cg', 'cgh', 'pgsl', 'ie', 'align',
  // W3C standard
  'prov', 'dct', 'dcat', 'hydra', 'foaf', 'sh', 'skos',
  'owl', 'rdfs', 'rdf', 'vc', 'dprod', 'time', 'ldp', 'xsd',
  // `dcterms` and `dct` are the SAME namespace (http://purl.org/dc/terms/) under two
  // conventional prefixes, and docs/ns/ uses both — vault-ld.ttl declares `dcterms:`,
  // everything else declares `dct:`. Listing only one meant a class grounded in
  // `dcterms:Standard` read as ungrounded while the identical `dct:Standard` passed.
  'dcterms',
]);

// ── ★ THE FILE LIST IS GONE. IT WAS A HAND-MAINTAINED LIST OF 14 OVER A DIRECTORY OF 30. ──
//
// What sat here was `const L2_L3_FILES = ['sat.ttl', 'hela.ttl', …]` — fourteen names typed
// out by hand. `docs/ns/` holds thirty `.ttl` files. So `a2a.ttl`, `hmd.ttl`, `vault-ld.ttl`,
// `wks.ttl` and every shapes file had never been looked at by any derivation check, and
// nothing anywhere said so: the gate printed a confident "97/97 classes grounded" over a
// directory it was reading less than half of. A list that has to be extended by hand when a
// file lands is a list that stops being extended.
//
// ★★ AND ENUMERATING ALONE WOULD HAVE MADE IT WORSE, WHICH IS WHY THIS ALSO REWROTE THE
//    PARSER. `parseOntology(ttl, prefix)` took the prefix from the FILENAME. That is wrong
//    for six of the thirty files, and wrong SILENTLY — the regex simply matches nothing and
//    the file reports 0/0 grounded, which looks exactly like a clean file:
//
//      harness.ttl    declares 41 owl:Class under `ieh:`   → filename prefix `harness:` → 0
//      interego.ttl   declares  7 under `ie:`              → filename prefix `interego:` → 0
//      alignment.ttl  declares  5 under `align:`           → filename prefix `alignment:` → 0
//      vault-ld.ttl   declares  1 under `vldp:`            → filename prefix `vault-ld:` → 0
//
//    Adding those four names to the old list would have added four files that check nothing
//    and a bigger number in the report. So the prefix is no longer derived at all: the
//    scanner reads whatever prefix each declaration actually carries, and {@link
//    blindSpotFailure} refuses any file whose `a owl:Class` count and parsed-class count
//    disagree. That check is the reason enumeration is safe — it is what would have caught
//    the old parser, and it is what will catch the next declaration shape this regex misses.
//
// Which files are EXEMPT is now a question about the LAYER, not about a list: L1 is what
// grounding grounds IN, so an L1 class has nothing above it to ground in. See
// {@link l1Prefixes}.

/**
 * Every class declaration in a Turtle file, with the prefix it actually carries.
 *
 * The body runs to the first line-terminating `.`, which is crude and is why
 * {@link blindSpotFailure} cross-checks the count: a body that over-runs swallows the next
 * declaration, and a swallowed class would inherit its neighbour's grounding and read as
 * grounded. Measured across all thirty files today: parsed count equals raw `a owl:Class`
 * count in every one, so nothing is currently being merged or missed.
 */
function parseOntology(ttl) {
  const classes = [];
  const re = /^([a-zA-Z][a-zA-Z0-9-]*):([A-Z][a-zA-Z0-9]*)\s+a\s+owl:Class\s*(?:;|,)([\s\S]*?)\.\s*$/gm;
  let m;
  while ((m = re.exec(ttl)) !== null) {
    classes.push({ prefix: m[1], name: m[2], body: m[3] });
  }
  return classes;
}

/**
 * ★ THE CHECK THAT MAKES ENUMERATING SAFE.
 *
 * `a owl:Class` is countable without any parsing at all. If that count and the number of
 * declarations the scanner actually understood disagree, the scanner is blind to something
 * in that file — a declaration shape it does not match, or a body that ran past its
 * terminator and ate the next one. Either way the file's report is fiction, and a fiction
 * that reads as "0 ungrounded" is exactly how four ontologies sat unchecked behind a
 * filename-derived prefix.
 *
 * Exported so `tests/derivation-lint.test.ts` can hand it a file the scanner cannot read.
 *
 * @param {string} file  basename, for the message
 * @param {string} ttl   file contents
 * @param {number} parsed  how many declarations {@link parseOntology} understood
 * @returns {string|null} a failure line, or null
 */
export function blindSpotFailure(file, ttl, parsed) {
  const raw = (ttl.match(/\ba\s+owl:Class\b/g) ?? []).length;
  if (raw === parsed) return null;
  return `${file}: ${raw} \`a owl:Class\` declaration(s) in the file, ${parsed} understood by `
    + 'this scanner. The difference is invisible in the grounded/ungrounded numbers — a class '
    + 'the scanner cannot see is a class it reports nothing about, and a class whose body '
    + 'over-ran its terminator inherits the next one\'s grounding. Fix the regex in '
    + 'parseOntology, or the declaration, before trusting any count from this file.';
}

/**
 * The L1 prefixes, read out of `spec/LAYERS.md` §3 rather than restated here.
 *
 * L1 is the layer everything else grounds IN, so an L1 class has nothing above it to ground
 * in and is exempt — but "which prefixes are L1" is a governance fact that LAYERS.md already
 * states in one sentence ("**Core protocol namespaces** (currently `iep:`, `ieh:`, `pgsl:`,
 * `ie:`, `align:`)"). Two copies of that list would drift, and the copy in a lint tool is the
 * one nobody would think to update — the same failure this file's DOC_CLAIMS block exists to
 * stop in the other direction.
 *
 * A wording change that hides the sentence is a hard failure, not a silent empty set: an
 * empty L1 set would make every L1 class "ungrounded" and red the gate anyway, but for a
 * reason nobody could act on.
 *
 * Exported for the self-test.
 *
 * @param {string} layersText  contents of spec/LAYERS.md
 * @returns {{ prefixes: Set<string> } | { error: string }}
 */
export function l1Prefixes(layersText) {
  const sentence = layersText.match(/\*\*Core protocol namespaces\*\*\s*\(currently([^)]*)\)/);
  if (!sentence) {
    return {
      error: 'spec/LAYERS.md no longer states which namespaces are L1 where this gate looks '
        + 'for it ("**Core protocol namespaces** (currently `iep:`, …)"). That sentence is the '
        + 'authority for which classes are exempt from grounding; restore it, or update '
        + 'l1Prefixes() in tools/derivation-lint.mjs to match the new wording.',
    };
  }
  const prefixes = new Set([...sentence[1].matchAll(/`([a-zA-Z][a-zA-Z0-9-]*):`/g)].map(m => m[1]));
  if (prefixes.size === 0) {
    return { error: 'spec/LAYERS.md\'s "Core protocol namespaces" sentence names no `prefix:` at all.' };
  }
  // The pre-rename aliases. `cg:`/`cgh:` were renamed to `iep:`/`ieh:`; both alias ontologies
  // are still published (and marked owl:deprecated) so a legacy consumer's IRIs still
  // dereference. They are the same layer as what they alias, and LAYERS.md's present-tense
  // sentence correctly does not list them.
  for (const legacy of ['cg', 'cgh']) prefixes.add(legacy);
  return { prefixes };
}

function isGrounded(body, otherGroundedClasses, prefix) {
  // (a) owl:equivalentClass <L1-or-W3C-term>
  const equivMatch = body.match(/owl:equivalentClass\s+([a-zA-Z]+):/g);
  if (equivMatch && equivMatch.some(e => {
    const p = e.match(/([a-zA-Z]+):/)[1];
    return GROUNDING_PREFIXES.has(p);
  })) return { grounded: true, reason: 'owl:equivalentClass' };

  // (b) rdfs:subClassOf <L1-or-W3C-term-or-same-file-grounded-class>
  const subClassMatches = body.match(/rdfs:subClassOf\s+([^,;.\s]+(?:\s*,\s*[^,;.\s]+)*)/);
  if (subClassMatches) {
    const targets = subClassMatches[1].split(/\s*,\s*/);
    for (const t of targets) {
      const m = t.match(/^([a-zA-Z][a-zA-Z0-9-]*):([A-Za-z0-9]+)$/);
      if (!m) continue;
      const [, targetPrefix, targetClass] = m;
      if (GROUNDING_PREFIXES.has(targetPrefix)) {
        return { grounded: true, reason: `rdfs:subClassOf ${targetPrefix}:${targetClass}` };
      }
      // Same-file transitive grounding
      if (targetPrefix === prefix && otherGroundedClasses.has(targetClass)) {
        return { grounded: true, reason: `rdfs:subClassOf ${targetPrefix}:${targetClass} (transitive)` };
      }
    }
  }

  // (c) iep:constructedFrom (...)
  if (/iep:constructedFrom\s+\(/.test(body)) {
    return { grounded: true, reason: 'iep:constructedFrom' };
  }

  // (d) primitive marker in rdfs:comment
  if (/rdfs:comment\s+"[^"]*[Pp]rimitive[^"]*"/.test(body)) {
    return { grounded: true, reason: 'primitive (declared)' };
  }

  return { grounded: false };
}

// ── ★ THE GATE RUNS ONLY WHEN IT IS THE PROGRAM, NOT WHEN IT IS IMPORTED. ────────────────
//
// Everything below used to execute at module scope, including `process.exit(1)`. Importing
// this file to reach `blindSpotFailure` / `l1Prefixes` from a test therefore RAN the whole
// gate inside the vitest worker and, on any real failure, killed the process from inside a
// test — and `vitest.config.ts` pins singleFork, so that takes every test not yet reached
// with it and reports the death against whichever file ran last. That is the exact shape
// `tools/vitest-run-integrity.mjs` exists to refuse, so this file must not be able to cause
// it. Same guard, and for the same reason, as `tools/lint-gate.mjs`.
//
// The body below is deliberately left at its original indentation. Re-indenting 130 lines
// would turn a wrapper into a whole-file diff and bury the two substantive changes in this
// gate (enumeration, and the blind-spot check) in whitespace nobody would review.
function main() {
const layersText = readFileSync(join(__dirname, '..', 'spec', 'LAYERS.md'), 'utf8');
const l1 = l1Prefixes(layersText);
if (l1.error) {
  console.error(`\nFAIL: ${l1.error}`);
  process.exit(1);
}
const L1_PREFIXES = l1.prefixes;

let totalChecked = 0;
let totalUngrounded = 0;
let totalExempt = 0;
const report = [];
const blindSpots = [];

// ★ THE DIRECTORY, NOT A LIST. Sorted so the report is stable across platforms; readdirSync
// order is filesystem-dependent and a report that reorders itself is a diff nobody reads.
const files = readdirSync(NS_DIR).filter(f => f.endsWith('.ttl')).sort();
if (files.length === 0) {
  console.error(`\nFAIL: no .ttl files found under ${NS_DIR}. A gate that examines nothing exits`
    + ' 0 and reads exactly like a clean run; that is what this refuses.');
  process.exit(1);
}

for (const file of files) {
  const ttl = readFileSync(join(NS_DIR, file), 'utf8');
  const classes = parseOntology(ttl);

  const blind = blindSpotFailure(file, ttl, classes.length);
  if (blind) blindSpots.push(blind);

  // L1 declares the vocabulary everything else grounds IN, so it has nothing above it to
  // ground in. Counted and reported, never required.
  const exempt = classes.filter(c => L1_PREFIXES.has(c.prefix));
  const mustGround = classes.filter(c => !L1_PREFIXES.has(c.prefix));

  // Two-pass for transitive grounding: first pass finds direct groundings; then iterate to
  // a fixed point so `A subClassOf B subClassOf iep:X` resolves. Same-file grounding is
  // scoped per prefix, because "same file" was only ever a proxy for "same namespace".
  const grounded = new Set();
  const key = c => `${c.prefix}:${c.name}`;
  let changed = true;
  let first = true;
  while (changed) {
    changed = false;
    for (const c of mustGround) {
      if (grounded.has(key(c))) continue;
      const sameNs = new Set(
        [...grounded].filter(k => k.startsWith(`${c.prefix}:`)).map(k => k.slice(c.prefix.length + 1)),
      );
      if (isGrounded(c.body, first ? new Set() : sameNs, c.prefix).grounded) {
        grounded.add(key(c));
        changed = true;
      }
    }
    first = false;
  }

  const ungrounded = mustGround.filter(c => !grounded.has(key(c))).map(key);
  totalChecked += mustGround.length;
  totalUngrounded += ungrounded.length;
  totalExempt += exempt.length;
  report.push({
    file,
    checked: mustGround.length,
    grounded: mustGround.length - ungrounded.length,
    exempt: exempt.length,
    ungrounded,
  });
}

console.log('Derivation-lint (spec/DERIVATION.md) — L2/L3 ontology grounding check');
console.log(`Enumerated ${files.length} file(s) under docs/ns/. L1 prefixes (from spec/LAYERS.md §3):`
  + ` ${[...L1_PREFIXES].sort().join(', ')}\n`);
for (const r of report) {
  const ok = r.ungrounded.length === 0;
  const exempt = r.exempt > 0 ? `  (+${r.exempt} L1, exempt)` : '';
  console.log(`  ${ok ? '✓' : '✗'} ${r.file.padEnd(20)} ${r.grounded}/${r.checked} grounded${exempt}`);
  for (const u of r.ungrounded) {
    console.log(`      ! ungrounded: ${u}`);
  }
}
console.log('');
const totalGrounded = totalChecked - totalUngrounded;
console.log(`Total: ${totalGrounded}/${totalChecked} L2/L3 classes grounded `
  + `(${totalExempt} L1 classes exempt).`);

// ── The prose count is a claim ABOUT this gate, and nothing ever checked it. ──
//
// Measured: this gate printed 97/97 while `spec/LAYERS.md` said 41/41. That 41/41 was TRUE
// the day derivation discipline landed and was never touched again, so it sat three months
// stale while the real number walked to 97. `README.md` carried a second, independently
// drifting transcription of the same number (91/91 — already wrong on the commit that
// shipped it) until it was rewritten to point readers at `npm run lint:derivation` instead
// of restating a figure. That rewrite is the right shape and is why README is not on the
// list below: there is no number there to drift.
//
// Neither stale number was ever produced by running anything. Both were typed by hand, so
// both went stale the moment a class was added under docs/ns/, and they went stale at
// different rates because there were two copies and no authority. The gate that PRODUCES
// the count is the only thing that can honestly assert it, so it asserts it here.
//
// Deliberately strict about the sentence shape: if someone rewords the claim out of
// existence, that is reported too. A claim this gate cannot find is a claim nobody checks,
// which is the state that produced the drift in the first place. If the wording must
// change, change DOC_CLAIMS in the same commit — or delete the number the way README did.
//
// CHANGELOG.md is deliberately NOT on this list. Its 41/41, 86/86 and 91/91 entries are
// history and were correct when written; "fixing" them would falsify the record.
// ★★ NOW EMPTY, AND THAT RESOLVES A CONTRADICTION BETWEEN TWO GATES.
//
// This required spec/LAYERS.md to state the count and keep it current. `docs-drift-lint.mjs`
// BANS that shape — "derivation-lint computes this; state the invariant instead" — reasoning
// that a hand-maintained number can only ever be wrong. The two rules could never collide
// because docs-drift scanned exactly README.md and STATUS.md, and LAYERS.md was in neither.
// Widening that scan to every tracked markdown put them in the same room, and docs-drift's rule
// is the stronger one: the comment above already offers it — "or delete the number the way
// README did."
//
// Nothing is lost. The gate FAILS on the first ungrounded class, so "every L2/L3 class is
// grounded" is enforced by the run itself; the prose states that invariant, and the count is
// printed by the tool that measures it.
const DOC_CLAIMS = [];

let docDrift = 0;
for (const { file, re } of DOC_CLAIMS) {
  const claim = readFileSync(join(__dirname, '..', file), 'utf8').match(re);
  if (!claim) {
    console.error(`\nFAIL: ${file} no longer states the grounding count where this gate looks for it (${re}). Restore the sentence, or update DOC_CLAIMS to match the new wording.`);
    docDrift++;
  } else if (Number(claim[1]) !== totalGrounded || Number(claim[2]) !== totalChecked) {
    console.error(`\nFAIL: ${file} says ${claim[1]}/${claim[2]} grounded; this run measured ${totalGrounded}/${totalChecked}. Update the prose to the measured number.`);
    docDrift++;
  }
}

if (totalUngrounded > 0) {
  console.error(`\nFAIL: ${totalUngrounded} ungrounded class(es). Add rdfs:subClassOf, owl:equivalentClass, or iep:constructedFrom, or mark primitive.`);
}
for (const b of blindSpots) {
  console.error(`\nFAIL: ${b}`);
}
// ALL THREE failures are reported before exiting, and all three exit non-zero. A gate that
// prints FAIL and returns 0 is the dead signal this repo has already been bitten by (see the
// header of tools/lint-gate.mjs). The blind-spot failure is in this list rather than beside
// the ungrounded count because a file the scanner cannot read produces a LOW ungrounded
// count, so the two failures point in opposite directions and only one of them is honest.
if (totalUngrounded > 0 || docDrift > 0 || blindSpots.length > 0) process.exit(1);
console.log(`\nPASS: all ${files.length} ontologies under docs/ns/ were enumerated and read, every`
  // The "and spec/LAYERS.md states the same count" that ended this sentence became false the
  // moment DOC_CLAIMS was emptied — a success message is a claim like any other.
  + ' L2/L3 class is grounded. spec/LAYERS.md states the invariant rather than a count, and'
  + ' this line is where the count is published.');
}

// Direct invocation — `node tools/derivation-lint.mjs`. Importing this module for its
// exported checks must not run the gate; see the comment on main().
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
