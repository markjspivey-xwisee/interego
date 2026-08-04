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

import { readFileSync } from 'node:fs';
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
]);

// L2 / L3 ontologies — these MUST ground their classes.
const L2_L3_FILES = [
  'sat.ttl', 'hela.ttl', 'cts.ttl', 'olke.ttl', 'amta.ttl',
  'hyprcat.ttl', 'hypragent.ttl',
  // L2 pattern ontologies
  'abac.ttl',
  'registry.ttl',
  'passport.ttl',
  // Domain ontologies (L3)
  'code.ttl',
  // Compliance / regulatory mapping ontologies (L3)
  'eu-ai-act.ttl',
  'nist-rmf.ttl',
  'soc2.ttl',
];

function parseOntology(ttl, prefix) {
  // Crude but sufficient: find every class definition and the
  // block of triples until the terminating period.
  const classes = [];
  const re = new RegExp(`^${prefix}:([A-Z][a-zA-Z0-9]*)\\s+a\\s+owl:Class\\s*(?:;|,)([\\s\\S]*?)\\.\\s*$`, 'gm');
  let m;
  while ((m = re.exec(ttl)) !== null) {
    const className = m[1];
    const body = m[2];
    classes.push({ name: className, body });
  }
  return classes;
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

let totalChecked = 0;
let totalUngrounded = 0;
const report = [];

for (const file of L2_L3_FILES) {
  const path = join(NS_DIR, file);
  let ttl;
  try { ttl = readFileSync(path, 'utf8'); } catch { continue; }
  const prefix = file.replace('.ttl', '');
  const classes = parseOntology(ttl, prefix);

  // Two-pass for transitive grounding: first pass finds direct
  // groundings; second pass resolves transitive.
  const directlyGrounded = new Set();
  for (const c of classes) {
    const r = isGrounded(c.body, new Set(), prefix);
    if (r.grounded) directlyGrounded.add(c.name);
  }
  // Iterate until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of classes) {
      if (directlyGrounded.has(c.name)) continue;
      const r = isGrounded(c.body, directlyGrounded, prefix);
      if (r.grounded) { directlyGrounded.add(c.name); changed = true; }
    }
  }

  const fileReport = { file, checked: classes.length, grounded: 0, ungrounded: [] };
  for (const c of classes) {
    totalChecked++;
    if (directlyGrounded.has(c.name)) {
      fileReport.grounded++;
    } else {
      fileReport.ungrounded.push(c.name);
      totalUngrounded++;
    }
  }
  report.push(fileReport);
}

console.log('Derivation-lint (spec/DERIVATION.md) — L2/L3 ontology grounding check\n');
for (const r of report) {
  const ok = r.ungrounded.length === 0;
  console.log(`  ${ok ? '✓' : '✗'} ${r.file.padEnd(16)} ${r.grounded}/${r.checked} grounded`);
  for (const u of r.ungrounded) {
    console.log(`      ! ungrounded: ${u}`);
  }
}
console.log('');
const totalGrounded = totalChecked - totalUngrounded;
console.log(`Total: ${totalGrounded}/${totalChecked} classes grounded`);

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
const DOC_CLAIMS = [
  // `\s+` and not a literal space: LAYERS.md wraps the sentence mid-claim, and this repo
  // checks out CRLF on Windows, so the separator is "\r\n" there and "\n" in CI. A
  // literal-space pattern silently never matches and turns this check into a no-op.
  { file: 'spec/LAYERS.md', re: /Current status: \*\*(\d+)\/(\d+)\s+classes grounded\*\*/ },
];

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
// BOTH failures are reported before exiting, and BOTH exit non-zero. A gate that prints
// FAIL and returns 0 is the dead signal this repo has already been bitten by (see the
// header of tools/lint-gate.mjs).
if (totalUngrounded > 0 || docDrift > 0) process.exit(1);
console.log('\nPASS: every L2/L3 class is grounded, and spec/LAYERS.md states the same count.');
