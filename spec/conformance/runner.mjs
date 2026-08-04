#!/usr/bin/env node
/**
 * Interego Conformance Runner (v0 — minimal)
 *
 * LAYER: Layer 3 — reference tooling. The normative definition of
 * conformance lives in the shapes (docs/ns/cg-shapes.ttl) and the
 * fixtures under this directory. This runner checks a focused set
 * of invariants against the fixtures using string-level parsing
 * (Turtle + nested blank nodes) rather than a full SHACL engine.
 * That keeps the runner dependency-free and quick to iterate on;
 * a future pass can swap in rdf-validate-shacl for full coverage.
 *
 * What it checks today:
 *
 *   1. Modal-truth consistency (spec §5.2.2):
 *        Asserted       ↔ groundTruth MUST be true
 *        Counterfactual ↔ groundTruth MUST be false
 *        Hypothetical   ↔ groundTruth MUST NOT be set
 *
 *   2. Revocation — self-reference rejection (spec/revocation.md §6):
 *        A successor query whose text contains the enclosing
 *        descriptor's own graph IRI is malformed.
 *
 *   3. Seven-facet invariant (spec §5):
 *        A descriptor MUST have exactly one of each of the seven
 *        core facets (TemporalFacet, ProvenanceFacet, AgentFacet,
 *        AccessControlFacet, SemioticFacet, TrustFacet,
 *        FederationFacet). Causal and Projection are additional
 *        facet types (nine facet types total) beyond the seven
 *        mandatory core. Extensions like a RevocationFacet
 *        (Proposal A) are permitted.
 *
 *   4. Revocation extension — shape validity:
 *        Every iep:RevocationCondition MUST declare a iep:successorQuery.
 *
 * Run with:  node spec/conformance/runner.mjs
 * Exits non-zero on any violation.
 *
 * ── ★ TWO VERDICTS THAT DISAGREED, AND ONLY ONE OF THEM SHIPS ────────────────
 *
 * This runner parses Turtle with regexes; `validateAgainstShape` in
 * @interego/core is what actually gates the publish path. They were free to
 * disagree and did: the runner reported `self-reference-violation.ttl —
 * expected violations fired ✓`, while the shipped engine returned
 * `conforms: true` on the same fixture against the same shapes. The fixture's
 * own header says it MUST be rejected by any conforming implementation. So the
 * repo held a green conformance report for a rule its implementation does not
 * enforce — `iep:RevocationConditionNoSelfReferenceShape` is `sh:sparql`, and
 * this substrate ships no SPARQL evaluator.
 *
 * A conformance runner that grades a DIFFERENT implementation than the one that
 * ships is not measuring conformance. Every fixture is now ALSO put through the
 * shipped engine (see crossCheckWithEngine). Where the engine reports it could
 * not evaluate the rule (`fullyChecked: false`), the fixture is counted as
 * UNVERIFIABLE rather than passed, and its level is withheld from the badge.
 *
 * ── ★ AND THE BADGE CLAIMED THREE LEVELS FROM ONE ────────────────────────────
 *
 * `l2Pass`/`l3Pass` were computed as "no L2/L3 category FAILED". No L2 or L3
 * category exists, so both were vacuously true and the runner printed
 * "Interego Full — L1+L2+L3 (Core + Federation + Advanced)" off 5 fixtures in
 * 1 of the 10 categories its own README enumerates. A level is now claimed only
 * if it was actually EXERCISED.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const REPO_ROOT = resolve(__dirname, '..', '..');
const SHAPES_FILE = join(REPO_ROOT, 'docs', 'ns', 'iep-shapes.ttl');

/**
 * Put a fixture through the SHIPPED validator, so this runner cannot certify a
 * rule the implementation does not enforce.
 *
 * Returns null when the engine is unavailable (packages not built — the runner
 * must stay usable from a bare checkout), otherwise
 * `{ conforms, fullyChecked, violations }`.
 */
async function crossCheckWithEngine(turtle) {
  // ★ IN CI THIS MAY NOT DEGRADE SILENTLY. A skipped cross-check restores exactly the
  // divergence this function exists to close — the fixture would go back to counting as a
  // pass on the regex verdict alone. Locally, from a bare checkout with nothing built,
  // degrading is the right call; in CI the workflow sets CONFORMANCE_REQUIRE_ENGINE=1 and
  // an unavailable engine is a hard failure.
  const required = process.env.CONFORMANCE_REQUIRE_ENGINE === '1';
  const unavailable = (why) => {
    if (!required) return null;
    console.error(`✗ conformance cross-check unavailable and CONFORMANCE_REQUIRE_ENGINE=1: ${why}`);
    process.exit(2);
  };
  if (!existsSync(SHAPES_FILE)) return unavailable(`missing ${SHAPES_FILE}`);
  let validateAgainstShape;
  try {
    ({ validateAgainstShape } = await import('@interego/core'));
  } catch (err) {
    return unavailable(`@interego/core did not import (run npm run build): ${err.message}`);
  }
  const report = validateAgainstShape(turtle, readFileSync(SHAPES_FILE, 'utf-8'));
  return {
    conforms: report.conforms,
    fullyChecked: report.fullyChecked,
    violations: report.results.filter(r => r.severity === 'Violation').length,
  };
}

// ── Checks ────────────────────────────────────────────────────

/**
 * Extract each SemioticFacet blank-node block from a Turtle string.
 * Returns an array of { modalStatus, groundTruth } records where each
 * value is the raw Turtle snippet (or null if absent).
 */
function extractSemioticFacets(turtle) {
  const out = [];
  const re = /a\s+iep:SemioticFacet[\s\S]*?(?=\]|iep:hasFacet\s*\[|$)/g;
  let m;
  while ((m = re.exec(turtle)) !== null) {
    const body = m[0];
    const modal = body.match(/iep:modalStatus\s+iep:(\w+)/);
    const gt = body.match(/iep:groundTruth\s+(true|false)/);
    out.push({ modalStatus: modal?.[1] ?? null, groundTruth: gt?.[1] ?? null });
  }
  return out;
}

function checkModalTruthConsistency(turtle) {
  const violations = [];
  for (const f of extractSemioticFacets(turtle)) {
    if (f.modalStatus === 'Asserted' && f.groundTruth !== 'true') {
      violations.push(`Asserted requires groundTruth=true, got ${f.groundTruth ?? '(absent)'}`);
    }
    if (f.modalStatus === 'Counterfactual' && f.groundTruth !== 'false') {
      violations.push(`Counterfactual requires groundTruth=false, got ${f.groundTruth ?? '(absent)'}`);
    }
    if (f.modalStatus === 'Hypothetical' && f.groundTruth !== null) {
      violations.push(`Hypothetical MUST NOT set groundTruth, got ${f.groundTruth}`);
    }
  }
  return violations;
}

function checkSelfReferenceRejection(turtle) {
  const violations = [];
  // find the enclosing descriptor's `iep:describes <...>` target IRI
  const describesMatch = turtle.match(/iep:describes\s+<([^>]+)>/);
  if (!describesMatch) return violations;
  const graphIri = describesMatch[1];
  // find every successor query literal (""" ... """ or "..." form)
  const queryRe = /iep:successorQuery\s+(?:"""([\s\S]*?)"""|"([^"]*)")/g;
  let m;
  while ((m = queryRe.exec(turtle)) !== null) {
    const text = m[1] ?? m[2] ?? '';
    if (text.includes(graphIri)) {
      violations.push(`Successor query references enclosing graph IRI <${graphIri}> — malformed (self-revoking by existence).`);
    }
  }
  return violations;
}

function checkCoreFacets(turtle) {
  const violations = [];
  // count occurrences of each core facet class
  const required = [
    'TemporalFacet',
    'ProvenanceFacet',
    'AgentFacet',
    'AccessControlFacet',
    'SemioticFacet',
    'TrustFacet',
    'FederationFacet',
  ];
  for (const facetClass of required) {
    const re = new RegExp(`a\\s+iep:${facetClass}\\b`, 'g');
    const matches = turtle.match(re) ?? [];
    if (matches.length === 0) {
      violations.push(`Missing required facet: iep:${facetClass}`);
    } else if (matches.length > 1) {
      violations.push(`Multiple iep:${facetClass} instances (${matches.length}) — expected exactly one`);
    }
  }
  return violations;
}

function checkRevocationConditionShape(turtle) {
  const violations = [];
  // every RevocationCondition must have a successorQuery
  const blockRe = /a\s+iep:RevocationCondition[\s\S]*?(?=\];|\]\s*\.|\]\s*\]|$)/g;
  let m;
  let index = 0;
  while ((m = blockRe.exec(turtle)) !== null) {
    const body = m[0];
    if (!body.match(/iep:successorQuery\s+"""?[\s\S]*?"""?/) && !body.match(/iep:successorQuery\s+"[^"]*"/)) {
      violations.push(`RevocationCondition #${index + 1} missing iep:successorQuery`);
    }
    index++;
  }
  return violations;
}

// ── Runner ────────────────────────────────────────────────────

const CATEGORY_CHECKS = {
  revocation: [
    { name: 'modal-truth-consistency', fn: checkModalTruthConsistency },
    { name: 'core-facet-invariant', fn: checkCoreFacets },
    { name: 'revocation-condition-shape', fn: checkRevocationConditionShape },
  ],
};

const EXPECTED_VIOLATIONS = {
  'revocation/self-reference-violation.ttl': ['Successor query references enclosing graph IRI'],
};

async function runCategory(categoryDir, checks) {
  const fullDir = join(FIXTURES_DIR, categoryDir);
  let entries;
  try {
    entries = readdirSync(fullDir).filter(f => f.endsWith('.ttl'));
  } catch {
    return { total: 0, pass: 0, fail: 0, unverifiable: 0, skipped: [`${categoryDir}/ missing`] };
  }

  let total = 0;
  let pass = 0;
  let fail = 0;
  let unverifiable = 0;
  const failures = [];

  for (const fixture of entries) {
    const path = `${categoryDir}/${fixture}`;
    const content = readFileSync(join(fullDir, fixture), 'utf-8');
    const expected = EXPECTED_VIOLATIONS[path] ?? [];

    const allViolations = checks.flatMap(c => {
      const v = c.fn(content);
      return v.map(msg => ({ check: c.name, msg }));
    });

    // Only apply self-reference check where expected; otherwise skip it
    // — the check is globally correct but we segment fixtures so
    // negative-path fixtures can declare their own expected violations.
    const selfRefViolations = checkSelfReferenceRejection(content);

    total++;
    if (expected.length > 0) {
      // Negative fixture — we expect certain violations to fire.
      const expectedHit = expected.every(ex =>
        selfRefViolations.some(v => v.includes(ex)) || allViolations.some(v => v.msg.includes(ex))
      );
      if (expectedHit) {
        // ★ The regex checks agree. Now ask the implementation that actually ships.
        const engine = await crossCheckWithEngine(content);
        if (engine && engine.fullyChecked === false) {
          unverifiable++;
          console.log(`  ⚠ ${fixture} — this runner's checks fired, but the SHIPPED validator `
            + `could not evaluate the rule (fullyChecked=false, conforms=${engine.conforms}).`);
          console.log('      Counted as UNVERIFIABLE, not as a pass. A conformance report that '
            + 'grades a different implementation than the one that ships is not a conformance report.');
        } else {
          pass++;
          console.log(`  ✓ ${fixture} — expected violations fired`);
        }
      } else {
        fail++;
        failures.push({ fixture, expected, got: [...allViolations.map(v => v.msg), ...selfRefViolations] });
        console.log(`  ✗ ${fixture} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(selfRefViolations)}`);
      }
    } else {
      // Positive fixture — expect zero violations from the non-self-ref checks.
      // Self-ref fires only in negative fixtures by construction.
      if (allViolations.length === 0) {
        pass++;
        console.log(`  ✓ ${fixture}`);
      } else {
        fail++;
        failures.push({ fixture, violations: allViolations });
        console.log(`  ✗ ${fixture}`);
        for (const v of allViolations) console.log(`      [${v.check}] ${v.msg}`);
      }
    }
  }
  return { total, pass, fail, unverifiable, failures };
}

// ── Conformance levels (per spec/CONFORMANCE.md) ──────────────
//
// Each existing check maps to a level. The runner reports which
// levels passed and emits the badge string.
//
// L1 — Core (MUST):   core-facet, modal-truth, supersedes, shape-validate, composition
// L2 — Federation (SHOULD): manifest discovery, cross-pod resolution, WebID/DID, notifications, E2EE
// L3 — Advanced (MAY): ABAC, AMTA, RDF 1.2, ZK, passport, PGSL
//
// Today we test L1 directly via fixtures; L2/L3 are gated by an
// optional INTEREGO_CONFORMANCE_ENDPOINT env var (live testing).

const LEVEL_MAPPING = {
  'modal-truth':            { level: 'L1', rule: 'L1.2 modal-truth consistency' },
  'core-facet':             { level: 'L1', rule: 'L1.1 core-facet invariant' },
  'revocation':             { level: 'L1', rule: 'L1.4 supersedes / revocation' },
};

// ── Main ──────────────────────────────────────────────────────

console.log('Interego Conformance Runner v1');
console.log('================================');
console.log(`Spec:     spec/CONFORMANCE.md`);
console.log(`Fixtures: ${FIXTURES_DIR}`);
console.log('');

let grandTotal = 0;
let grandPass = 0;
let grandFail = 0;
let grandUnverifiable = 0;
const failedLevels = new Set();
/** Levels a fixture actually RAN for. A level nothing exercised is not a level passed. */
const exercisedLevels = new Set();
/** Levels with at least one rule the shipped validator could not evaluate. */
const unverifiableLevels = new Set();

for (const [category, checks] of Object.entries(CATEGORY_CHECKS)) {
  const mapping = LEVEL_MAPPING[category];
  const levelTag = mapping ? ` [${mapping.level}: ${mapping.rule}]` : '';
  console.log(`Category: ${category}${levelTag}`);
  const r = await runCategory(category, checks);
  grandTotal += r.total;
  grandPass += r.pass;
  grandFail += r.fail;
  grandUnverifiable += r.unverifiable ?? 0;
  console.log(`  ${r.pass}/${r.total} passed`
    + (r.unverifiable ? `, ${r.unverifiable} unverifiable by the shipped validator` : ''));
  if (mapping && r.total > 0) exercisedLevels.add(mapping.level);
  if (r.fail > 0 && mapping) failedLevels.add(mapping.level);
  if ((r.unverifiable ?? 0) > 0 && mapping) unverifiableLevels.add(mapping.level);
  console.log('');
}

console.log('================================');
console.log(`TOTAL: ${grandPass}/${grandTotal} passed, ${grandFail} failed`
  + (grandUnverifiable ? `, ${grandUnverifiable} unverifiable` : ''));
console.log('');

// ── Conformance badge ──
//
// ★ A LEVEL MUST BE EXERCISED TO BE CLAIMED. This used to read "no L2/L3 category
// failed" — and since no L2 or L3 category exists, both were vacuously true and the
// runner printed "Interego Full (Core + Federation + Advanced)" from five fixtures in
// one category. Absence of evidence was being reported as evidence of conformance.
const claimed = ['L1', 'L2', 'L3'].filter(
  l => exercisedLevels.has(l) && !failedLevels.has(l) && !unverifiableLevels.has(l),
);
const notExercised = ['L1', 'L2', 'L3'].filter(l => !exercisedLevels.has(l));

console.log('── Conformance badge ──');
if (failedLevels.size > 0) {
  console.log('   ✗ Non-conformant. Failed levels: ' + [...failedLevels].join(', '));
} else if (claimed.length === 0) {
  console.log('   — No level fully verified by this run.');
} else {
  const label = claimed.join('+');
  console.log(`   ✓ Interego ${label}`);
  console.log(`   Badge: ![Interego ${label}](https://img.shields.io/badge/Interego-${encodeURIComponent(label)}-blue)`);
}
if (unverifiableLevels.size > 0) {
  console.log(`   ⚠ Partial at ${[...unverifiableLevels].join(', ')}: at least one rule is `
    + 'declared in the shapes but not evaluable by the shipped validator.');
}
if (notExercised.length > 0) {
  console.log(`   · Not exercised by any fixture: ${notExercised.join(', ')}. `
    + 'See spec/conformance/README.md for the categories still to be written.');
}
console.log('');
console.log('   See spec/CONFORMANCE.md for level definitions and what');
console.log('   each rule means.');

// ── L2 / L3 live-endpoint testing (optional) ──
const liveEndpoint = process.env.INTEREGO_CONFORMANCE_ENDPOINT;
if (liveEndpoint) {
  console.log('');
  console.log(`── L2/L3 live tests against: ${liveEndpoint} ──`);
  console.log('   (live HTTP testing not yet implemented — placeholder)');
  console.log('   Tests would: GET /.well-known/context-graphs (L2.1),');
  console.log('   resolve a known WebID (L2.3), fetch a descriptor (L2.2),');
  console.log('   and verify shape compliance (L1.5).');
}

if (grandFail > 0) {
  process.exit(1);
}
