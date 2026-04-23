#!/usr/bin/env node
// Derivation-lint — enforce spec/DERIVATION.md rule that every
// L2/L3 ontology class has explicit L1 grounding (or is marked
// primitive).
//
// A class is GROUNDED if ANY of these appears in its definition:
//   (a) owl:equivalentClass <L1-or-W3C-term>
//   (b) rdfs:subClassOf <L1-or-W3C-term-or-same-file-grounded-class>
//   (c) cg:constructedFrom (...)
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
  // L1 core
  'cg', 'cgh', 'pgsl', 'ie', 'align',
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
  // Domain ontologies (L3)
  'code.ttl',
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
      const m = t.match(/^([a-zA-Z]+):([A-Za-z0-9]+)$/);
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

  // (c) cg:constructedFrom (...)
  if (/cg:constructedFrom\s+\(/.test(body)) {
    return { grounded: true, reason: 'cg:constructedFrom' };
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
console.log(`Total: ${totalChecked - totalUngrounded}/${totalChecked} classes grounded`);

if (totalUngrounded > 0) {
  console.error(`\nFAIL: ${totalUngrounded} ungrounded class(es). Add rdfs:subClassOf, owl:equivalentClass, or cg:constructedFrom, or mark primitive.`);
  process.exit(1);
}
console.log('\nPASS: every L2/L3 class is grounded.');
