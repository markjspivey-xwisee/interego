#!/usr/bin/env node
/**
 * The boundary the "work becomes evidence without an integration" claim rests on.
 *
 * ★ WHY A LINT AND NOT A PARAGRAPH. The claim is that a shared-workspace work item becomes a
 * performance-verified competency in the L&D vertical with no code joining the two — the join
 * being carried entirely by published data (a skill scheme, a SHACL work shape, an
 * observation map, a CASE alignment graph) and by general machinery (dereference, the publish
 * gate, the roll-up rule, a namespace-blind BFS). A claim like that decays the first time
 * somebody adds one convenient import, and nobody notices because everything still passes.
 * So it is measured on every run.
 *
 * Three checks:
 *
 *   1. HARD ZERO — the workspace-side demo program may not name the L&D vertical.
 *   2. HARD ZERO — the observer may not name the workspace.
 *   3. RATCHET   — mentions of one vertical inside the other's shipped source may not grow.
 *
 * ★ CHECK 3 IS A RATCHET AND NOT A ZERO BECAUSE THE HONEST NUMBER IS NOT ZERO. Four comment
 * lines in `applications/shared-workspace/src` use "a Foxxi credential" as the illustration
 * for why a cited record is never copied. They pre-date this work, they are prose, and none
 * of them is an import, an IRI or a call. Pinning the real number and refusing growth says
 * something true; asserting zero would have required editing four unrelated comments to make
 * a grep look better, which is the kind of tidying that turns a measurement into a
 * decoration.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** Files whose whole point is that they name only one side. */
const HARD_ZERO = [
  {
    file: 'applications/shared-workspace/tools/run-review-engagement-live.ts',
    pattern: /foxxi|xapi|competenc|\bler\b|adl-tla|proficien|credential/i,
    why: 'the workspace-side program must not know that an L&D vertical exists — it does work, and the work is the same work whether or not anything ever reads it',
  },
  {
    file: 'tools/observe-pod-performance-live.ts',
    pattern: /wsp/i,
    why: 'the observer must not know which application produced the records it reads — its inputs are a pod URL, a map IRI and an affordance, all dereferenced at run time',
  },
  {
    // ★ THIS CHECK WAS MISSING AND THE GATE WAS THEREFORE ONE-DIRECTIONAL.
    //
    // Only the workspace side of the observer was greppd, so the observer could name the
    // L&D vertical freely — which is the direction a bridge would actually be written in.
    // Reproduced by a reviewer: giving the observer's `--affordance-descriptor` and
    // `--action-iri` arguments DEFAULTS pointing at the L&D bridge turns it into a
    // workspace→L&D bridge, and `emergence boundary: intact.` still printed, exit 0.
    file: 'tools/observe-pod-performance-live.ts',
    pattern: /foxxi|xapi|competenc|adl-tla|ieee-ler|\bler\b|proficien/i,
    why: 'the observer must not know which application OWNS THE AFFORDANCE it submits to either — a default target is a hardcoded destination, and a reader with one is an integration',
  },
];

/**
 * Files permitted to name BOTH sides, with the count of cross-namespace constants pinned.
 *
 * ★ WHY AN ALLOW-LIST RATHER THAN AN OMISSION. `publish-review-engagement-graphs-live.ts` is
 * the CONVENER's program, and the convener is also the requirer: "my incident-triage
 * requirement is met by the skill term my workspace publishes" is a statement only a
 * requirer can make, and there is nowhere honest to put it except the requirer's own data.
 * That was true and was written down — but the file was in no check at all, so the
 * declaration was unbounded. A permission with no number attached is not a boundary. The
 * pin counts the CONSTANT DECLARATIONS naming the other side, so adding a mapping function
 * or a second requirer moves it and adding another triple to a published document does not.
 */
const BOUNDED_REQUIRER = [
  {
    file: 'tools/publish-review-engagement-graphs-live.ts',
    pattern: /^const (FOXXI|AGP)[A-Z_]* =/,
    pinned: 4,
    why: 'the convener/requirer naming the L&D vertical and the agentic-performance practice as DATA it cites',
  },
];

/** Cross-vertical mentions in shipped source. Pinned, not asserted zero — see the header. */
const RATCHET = [
  {
    dir: 'applications/shared-workspace/src',
    pattern: /foxxi|xapi|ieee-ler|adl-tla/i,
    pinned: 4,
    why: 'the workspace vertical mentioning the L&D vertical',
  },
  {
    // ★ THIS WAS `/src`, WHICH IS 98 OF THE 242 .ts FILES IN THAT VERTICAL. The 144 unlinted
    // ones included `bridge/server.ts` — the file that implements record-performance,
    // rankTutorsForCompetency and the /agent/<did>/affordances endpoint the crossing runs
    // through — plus `affordances.ts`, `checks/`, `tools/` and `tests/`. A `wsp` reference
    // added to the exact file that performs the join would not have moved the pin. Pointing
    // it at the whole vertical is free: the count is 0 either way, measured.
    dir: 'applications/foxxi-content-intelligence',
    pattern: /\bwsp\b|wsp:|wsp-/i,
    pinned: 0,
    why: 'the L&D vertical mentioning the workspace vertical',
  },
];

function tsFilesUnder(dir) {
  const out = [];
  const walk = d => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

let failed = false;

for (const { file, pattern, why } of HARD_ZERO) {
  const body = readFileSync(join(ROOT, file), 'utf8');
  const hits = body.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => pattern.test(line));
  if (hits.length > 0) {
    failed = true;
    console.error(`\n★ EMERGENCE BOUNDARY BROKEN — ${file}`);
    console.error(`  ${why}`);
    for (const h of hits.slice(0, 10)) console.error(`  ${h.n}: ${h.line.trim().slice(0, 140)}`);
    console.error(`  ${hits.length} line(s) matched ${pattern}. The demo this file belongs to claims exactly that this number is zero.`);
  } else {
    console.log(`ok    ${file} — 0 lines match ${pattern}`);
  }
}

for (const { file, pattern, pinned, why } of BOUNDED_REQUIRER) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const hits = lines.map((line, i) => ({ line: line.trim(), n: i + 1 })).filter(({ line }) => pattern.test(line));
  if (hits.length === pinned) {
    console.log(`ok    ${file} — ${hits.length} cross-namespace constant(s), at the pin`);
    continue;
  }
  failed = true;
  console.error(`\n★ THE REQUIRER'S DECLARATION MOVED — ${why}`);
  console.error(`  pinned ${pinned}, found ${hits.length}`);
  for (const h of hits.slice(0, 10)) console.error(`  ${h.n}: ${h.line.slice(0, 140)}`);
  console.error('  This file is ALLOWED to name both sides, and the number of times it does is the bound.');
}

for (const { dir, pattern, pinned, why } of RATCHET) {
  let count = 0;
  const examples = [];
  for (const f of tsFilesUnder(join(ROOT, dir))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!pattern.test(line)) return;
      count++;
      if (examples.length < 6) examples.push(`${relative(ROOT, f).replace(/\\/g, '/')}:${i + 1}`);
    });
  }
  if (count > pinned) {
    failed = true;
    console.error(`\n★ CROSS-VERTICAL MENTIONS GREW — ${why}`);
    console.error(`  pinned ${pinned}, found ${count}: ${examples.join(', ')}`);
    console.error('  Every one of these is a place the "no integration between them" claim gets weaker.');
  } else if (count < pinned) {
    // ★ AN IMPROVEMENT ALSO FAILS. A pin that only catches growth silently keeps claiming a
    // debt that has been paid, and the next reader budgets for four mentions that are gone.
    failed = true;
    console.error(`\n★ PIN IS STALE — ${why}: pinned ${pinned}, found ${count}. Lower the pin.`);
  } else {
    console.log(`ok    ${dir} — ${count} cross-vertical mention(s), at the pin${count > 0 ? ` (${examples.join(', ')})` : ''}`);
  }
}

if (failed) process.exit(1);
console.log('\nemergence boundary: intact.');
