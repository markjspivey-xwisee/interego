#!/usr/bin/env node
/**
 * deploy-scope — which deployed services bundle a changed package?
 *
 * ★ WHY THIS IS A TOOL AND NOT A JUDGEMENT CALL. Deploy scope was decided last round by
 * grepping each service's OWN source for the changed symbol, and the conclusion — "the
 * bridges call neither `reduce` nor `validateAgainstShape`, so only the relay needs
 * redeploying" — was wrong on its face: foxxi-bridge depends on `@interego/solid`, whose
 * `client.ts` calls `validateAgainstShape` on the publish path. It happened to be harmless
 * because `conforms` semantics did not change that round; had the round gone with its
 * original plan of promoting unsupported-construct notes to Violation, it would have
 * shipped a split-brain — one service refusing publishes another accepted.
 *
 * A symbol can reach a service through any number of intermediate packages. Grep sees one
 * hop. The dependency graph is the thing that actually decides, so ask it.
 *
 * Usage:
 *   node tools/deploy-scope.mjs @interego/core [@interego/solid ...]
 *
 * Prints every deployable workspace whose transitive dependency closure contains any named
 * package. Exits 0 always — this informs a decision, it does not gate one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Workspaces that become a running service. Keyed by the Railway service name so the output
 * can be pasted straight into a `deploy-railway.yml` dispatch.
 *
 * Static SPA images are listed too: they bundle packages/ through Vite, so a package change
 * reaches them exactly as it reaches a server — they are just harder to notice.
 */
const DEPLOYABLES = [
  { service: 'relay', dir: 'deploy/mcp-relay' },
  { service: 'identity', dir: 'deploy/identity' },
  { service: 'css-gate', dir: 'deploy/css-gate' },
  { service: 'foxxi-bridge', dir: 'applications/foxxi-content-intelligence/bridge' },
  { service: 'bridge', dir: 'applications/agentic-performance-practice/bridge' },
  { service: 'foxxi-dashboard', dir: 'applications/foxxi-content-intelligence/dashboard-app' },
  { service: 'foxxi-microsite', dir: 'applications/foxxi-content-intelligence/microsite-app' },
];

// ★ THIS TOOL ANSWERS ONE QUESTION AND NOT THE OTHER. It reports which services bundle a
// changed PACKAGE. It cannot tell you a service is running a stale IMAGE — measured this
// round: css-gate depends on no @interego/* package at all, yet the deployed gate was
// serving a build that predated its own HSTS fix by an entire release, observable as a
// missing Strict-Transport-Security on the one surface that carries a bearer credential.
// Compare each service's /health build sha against master as well as running this.

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node tools/deploy-scope.mjs <package> [package ...]');
  console.error('example: node tools/deploy-scope.mjs @interego/core');
  process.exit(1);
}

/** Read a workspace package.json, or null when the directory is not one. */
function manifest(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** Map every @interego/* package name to its directory, so the walk can follow edges. */
const packageDirs = new Map();
for (const dir of ['packages']) {
  const root = manifest('.');
  void root;
  // packages/* are the only intra-repo libraries; discover them by reading each manifest.
  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(dir)) {
    const m = manifest(join(dir, name));
    if (m?.name) packageDirs.set(m.name, join(dir, name));
  }
}

/** Transitive @interego/* closure of one workspace. */
function closureOf(dir) {
  const seen = new Set();
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    const m = manifest(d);
    if (!m) continue;
    for (const dep of Object.keys({ ...m.dependencies, ...m.optionalDependencies })) {
      if (!dep.startsWith('@interego/')) continue;
      if (seen.has(dep)) continue;
      seen.add(dep);
      const nested = packageDirs.get(dep);
      if (nested) stack.push(nested);
    }
  }
  return seen;
}

console.log(`Deploy scope for: ${targets.join(', ')}\n`);
const affected = [];
for (const { service, dir } of DEPLOYABLES) {
  if (!existsSync(join(dir, 'package.json'))) {
    console.log(`  ?  ${service.padEnd(18)} (${dir} has no package.json — check DEPLOYABLES)`);
    continue;
  }
  const closure = closureOf(dir);
  const hits = targets.filter(t => closure.has(t));
  if (hits.length > 0) {
    affected.push(service);
    console.log(`  ✓  ${service.padEnd(18)} bundles ${hits.join(', ')}`);
  } else {
    console.log(`  ·  ${service.padEnd(18)} does not depend on any of them`);
  }
}

console.log('');
if (affected.length === 0) {
  console.log('No deployable service bundles the named packages.');
} else {
  console.log(`Redeploy: ${affected.join(', ')}`);
  console.log('(Bundling a changed package is necessary, not sufficient — a service whose');
  console.log(' behaviour genuinely cannot change may be skipped, but say WHY explicitly.)');
}
