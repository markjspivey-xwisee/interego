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

// ★ THE FLAGS spec/STABILITY.md ALREADY DOCUMENTS. `process.argv` was never read, so
// `--fixtures <dir> --expected <dir>` — the command that file tells a second implementation
// to run — was accepted and ignored. A second implementation running it validated OUR
// fixtures and read the resulting pass as a verdict on ITS OWN code. A flag whose effect is
// nothing is worse than an unrecognised flag, because it returns a plausible answer.
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const FIXTURES_ARG = argValue('--fixtures');
const FIXTURES_DIR = FIXTURES_ARG ? resolve(FIXTURES_ARG) : resolve(__dirname, 'fixtures');
/** True when validating the built-in tree, i.e. when a ratchet over it is ours to apply. */
const USING_BUILTIN_FIXTURES = FIXTURES_ARG === null;

if (argValue('--expected')) {
  console.error('FATAL: --expected was accepted but there is no expected/ tree in this repo.');
  console.error('       Refusing a flag that does nothing — see spec/conformance/README.md.');
  process.exit(2);
}
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

// ★ EVERY DIRECTORY UNDER fixtures/ MUST BE A DECLARED CATEGORY. The loop below iterates
// CATEGORY_CHECKS, not the filesystem, so a directory that is not a key is never opened —
// and `spec/CONFORMANCE.md` told third parties to "drop the third-party's serialized output
// into a directory under spec/conformance/fixtures/<their-impl-name>/ and re-run". Measured:
// a fixture there violating BOTH L1.1 and L1.2 was never read, and the run reported a clean
// pass and exit 0 over a file it had not opened. Skipping is the failure; refusing is not.
const declaredCategories = new Set(Object.keys(CATEGORY_CHECKS));
let fixtureDirEntries;
try {
  fixtureDirEntries = readdirSync(FIXTURES_DIR, { withFileTypes: true });
} catch (err) {
  console.error(`FATAL: cannot read the fixtures directory ${FIXTURES_DIR}: ${err.message}`);
  console.error('       A runner that cannot find its fixtures must not report a pass.');
  process.exit(2);
}
const undeclared = fixtureDirEntries
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .filter(name => !declaredCategories.has(name));
if (undeclared.length > 0) {
  console.error(`FATAL: fixture directories with no CATEGORY_CHECKS entry: ${undeclared.join(', ')}`);
  console.error('       They would be skipped, and the run would report a pass over files it');
  console.error('       never opened. Add a CATEGORY_CHECKS entry (and its LEVEL_MAPPING), or');
  console.error('       remove the directory.');
  process.exit(2);
}

for (const [category, checks] of Object.entries(CATEGORY_CHECKS)) {
  const mapping = LEVEL_MAPPING[category];
  const levelTag = mapping ? ` [${mapping.level}: ${mapping.rule}]` : '';
  console.log(`Category: ${category}${levelTag}`);
  const r = await runCategory(category, checks);
  // ★ A DECLARED CATEGORY THAT CONTRIBUTED NOTHING IS A COVERAGE HOLE, NOT A PASS.
  // `runCategory` returns `{ total: 0, fail: 0 }` for a missing or empty directory, and the
  // caller only ever tested `fail > 0` — so declaring the nine categories the README
  // enumerates, with no fixtures behind them, would have stayed green. Measured.
  if (r.total === 0) {
    console.error(`  FATAL: category '${category}' is declared but contributed 0 fixtures.`);
    console.error('         A category with nothing behind it reads exactly like one that passed.');
    process.exit(2);
  }
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

// ── L2 live-endpoint testing (opt-in), BEFORE the badge ───────────────────────
//
// ★ THE ORDERING IS THE FIX, NOT AN AESTHETIC. This block used to sit BELOW the badge and
// print "(live HTTP testing not yet implemented — placeholder)". So even a fully implemented
// set of live checks could not have moved `l1Pass`/`l2Pass`/`l3Pass`, nor the exit code,
// which keyed only on `grandFail`. Measured on the old code: pointing
// INTEREGO_CONFORMANCE_ENDPOINT at a hostname that does not resolve printed the
// full-conformance badge and exited 0. "Implement the HTTP calls" was necessary and not
// sufficient; the sequencing was the other half.
const liveEndpoint = process.env.INTEREGO_CONFORMANCE_ENDPOINT;
const liveResults = [];

/** Fetch a URL as text. Never throws — a network failure is a RESULT, not an exception. */
async function fetchText(url) {
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/turtle, application/ld+json;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    return {
      ok: r.ok,
      status: r.status,
      contentType: r.headers.get('content-type') ?? '',
      body: r.ok ? await r.text() : '',
      error: null,
    };
  } catch (err) {
    return { ok: false, status: 0, contentType: '', body: '', error: String(err?.message ?? err) };
  }
}

/**
 * Rebase a manifest entry's IRI onto the endpoint origin, path only.
 *
 * WHY: manifest entries carry the pod's CANONICAL storage IRI, which on this deployment is
 * an internal host — `http://css.railway.internal:3456/...`. Fetched verbatim that is a
 * connection failure; the same PATH under the public endpoint is a 200. The canonical IRI is
 * signed over and MUST NOT be rewritten in the data — only the fetch target is rebased.
 * Following entry IRIs verbatim would report every conforming pod as L2.2-nonconformant,
 * i.e. would turn this check into a different flavour of the lie it replaces.
 */
function rebaseOntoEndpoint(entryIri, endpoint) {
  try {
    const entry = new URL(entryIri);
    const base = new URL(endpoint);
    return new URL(entry.pathname + entry.search, base.origin).toString();
  } catch {
    return entryIri;
  }
}

/** Record one live rule outcome. A failure marks its LEVEL failed. */
function recordLive(rule, level, ok, detail) {
  liveResults.push({ rule, level, ok, detail });
  exercisedLevels.add(level);
  if (!ok) failedLevels.add(level);
  console.log(`   ${ok ? '✓' : '✗'} ${rule} — ${detail}`);
}

/**
 * Resolve an agent identifier per CONFORMANCE.md L2.3, which names a closed set: WebID-TLS,
 * did:web, or did:key. Anything else is reported with its actual value rather than waved
 * through — silence about the identifier scheme is what would let a pod publishing only
 * did:ethr identifiers claim L2 federation conformance.
 */
async function resolveAgentId(id) {
  if (id.startsWith('did:key:')) {
    const wellFormed = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(id);
    return { ok: wellFormed, how: `did:key ${wellFormed ? 'well-formed' : 'MALFORMED'} (${id})` };
  }
  if (id.startsWith('did:web:')) {
    const parts = id.slice('did:web:'.length).split(':').map(decodeURIComponent);
    const host = parts.shift();
    const path = parts.length > 0 ? `/${parts.join('/')}/did.json` : '/.well-known/did.json';
    const r = await fetchText(`https://${host}${path}`);
    return { ok: r.ok, how: `did:web -> https://${host}${path} -> ${r.error ?? r.status}` };
  }
  if (/^https?:\/\//.test(id)) {
    const r = await fetchText(id);
    return { ok: r.ok, how: `WebID ${id} -> ${r.error ?? r.status}` };
  }
  return { ok: false, how: `${id} — scheme is not in the L2.3 set (WebID-TLS | did:web | did:key)` };
}

if (liveEndpoint) {
  const base = liveEndpoint.replace(/\/$/, '');
  console.log(`── L2 live tests against: ${base} ──`);

  // L2.1 — pod manifest discovery. A 200 is not enough: a reverse proxy serving an HTML
  // error page with status 200 would otherwise pass, so the body must look like a manifest.
  const manifestUrl = `${base}/.well-known/context-graphs`;
  const manifest = await fetchText(manifestUrl);
  const manifestOk = manifest.ok && /iep:ManifestEntry|hydra:Collection/.test(manifest.body);
  recordLive(
    'L2.1 pod manifest discovery',
    'L2',
    manifestOk,
    manifestOk
      ? `${manifestUrl} -> ${manifest.status} ${manifest.contentType}`
      : `${manifestUrl} -> ${manifest.error ?? `${manifest.status}; no iep:ManifestEntry / hydra:Collection in body`}`,
  );

  // L2.2 — an entry must dereference to a real descriptor, and that descriptor is then run
  // through the SAME checks the fixtures use. That reuse is what makes this a test rather
  // than a ping: the bytes the implementation SERVED are held to the L1 invariants.
  const entryIri = manifestOk
    ? (manifest.body.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/m)?.[1] ?? null)
    : null;

  if (entryIri === null) {
    recordLive('L2.2 descriptor dereference', 'L2', false, 'no iep:ManifestEntry subject found in the manifest');
  } else {
    const descUrl = rebaseOntoEndpoint(entryIri, base);
    const desc = await fetchText(descUrl);
    const isDescriptor = desc.ok && /a\s+iep:ContextDescriptor/.test(desc.body);
    recordLive(
      'L2.2 descriptor dereference',
      'L2',
      isDescriptor,
      isDescriptor
        ? `${descUrl} -> ${desc.status}`
        : `${descUrl} -> ${desc.error ?? desc.status}; body is not an iep:ContextDescriptor`,
    );

    if (isDescriptor) {
      const liveViolations = [...checkCoreFacets(desc.body), ...checkModalTruthConsistency(desc.body)];
      recordLive(
        'L1.1/L1.2 on the served descriptor',
        'L1',
        liveViolations.length === 0,
        liveViolations.length === 0
          ? `${descUrl} satisfies the core-facet and modal-truth invariants`
          : `${descUrl}: ${liveViolations.join('; ')}`,
      );

      const agentId =
        desc.body.match(/iep:agentIdentity\s+<([^>]+)>/)?.[1]
        ?? desc.body.match(/prov:wasAttributedTo\s+<([^>]+)>/)?.[1]
        ?? manifest.body.match(/iep:issuer\s+<([^>]+)>/)?.[1]
        ?? null;
      if (agentId === null) {
        recordLive('L2.3 agent identifier resolution', 'L2', false, 'no agent identifier found on the served descriptor');
      } else {
        const resolved = await resolveAgentId(agentId);
        recordLive('L2.3 agent identifier resolution', 'L2', resolved.ok, resolved.how);
      }
    }
  }
  console.log('');
}

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

if (!liveEndpoint) {
  console.log('');
  console.log('   L2 live checks did not run. Set INTEREGO_CONFORMANCE_ENDPOINT=<pod-url> to');
  console.log('   exercise L2.1 / L2.2 / L2.3 against a running implementation. No L2 claim');
  console.log('   is made from a run that did not make a request.');
}

// ★ A FAILED LIVE RULE IS A FAILED RUN. Without this the live block would still be
// decorative: `grandFail` counts fixtures only, and nothing the network said could reach the
// exit code. That was the other half of the placeholder defect.
const liveFail = liveResults.some(r => !r.ok);
if (grandFail > 0 || liveFail) {
  process.exit(1);
}

// The ratchet applies to the BUILT-IN tree only; `--fixtures` points at someone else's
// output, whose coverage is not ours to pin.
if (USING_BUILTIN_FIXTURES && grandTotal < 5) {
  console.error(`RATCHET: only ${grandTotal} fixture(s) ran over the built-in tree; the floor is 5.`);
  console.error('  A fixture family was removed. Restore it, or lower the floor and say why.');
  process.exit(1);
}
