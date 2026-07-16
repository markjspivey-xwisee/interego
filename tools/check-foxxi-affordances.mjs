#!/usr/bin/env node
/**
 * CI gate — every Foxxi /agent/* CAPABILITY route must be DISCOVERABLE.
 *
 * The Foxxi bridge hand-codes a number of `/agent/*` routes whose bodies carry
 * bespoke signed-delegation auth (or rate-limited open access). For each such
 * CAPABILITY route there must be a matching `externallyRouted: true` Affordance
 * in applications/foxxi-content-intelligence/affordances.ts (whose targetTemplate
 * preserves the exact path), so the capability appears in the /affordances
 * manifest, /mcp tools/list, and the entry point — without relocating the route.
 *
 * INFRA routes (descriptor endpoints, lattice reads, the landing tour, the mesh
 * push receiver) are NOT capabilities and are explicitly allowlisted below.
 *
 * This script (Node, no deps):
 *   1. regex-extracts every app.(post|get|put)('/agent/...') path from server.ts;
 *   2. extracts every affordance targetTemplate '/agent/...' path from
 *      affordances.ts;
 *   3. FAILS (exit 1) if any /agent/* capability route is neither covered by an
 *      affordance targetTemplate nor in the ALLOWLIST.
 *
 * Matching is robust to the :label param routes (normalized to a wildcard) and
 * the /affordance descriptor suffix.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SERVER = resolve(ROOT, 'applications/foxxi-content-intelligence/bridge/server.ts');
const AFFORDANCES = resolve(ROOT, 'applications/foxxi-content-intelligence/affordances.ts');

/**
 * INFRA allowlist — /agent/* routes that are intentionally NOT capability
 * affordances. Param routes use ':param'; they are normalized the same way the
 * extracted paths are (see normalizePath).
 */
const ALLOWLIST = [
  // Landing tour (GET read + POST operator-pinned write).
  '/agent/landing-tour',
  // Low-latency mesh push receiver (protocol-envelope only; projected on pull).
  '/agent/mesh-event',
  // Shared-lattice read views (foundation-first dereference).
  '/agent/lattice/:label',
  '/agent/lattice/:label/term',
  '/agent/lattice/:label/holon',
  '/agent/lattice/:label/interrogate',
  // Per-route GET /affordance descriptor endpoints (the canonical manifest now
  // lives in affordances.ts; these hand-coded descriptors stay as-is).
  '/agent/review-record/affordance',
  '/agent/issue-credential/affordance',
  '/agent/verify-extension/affordance',
  '/agent/void-credential/affordance',
  '/agent/record-performance/affordance',
  '/agent/publish-encryption-key/affordance',
  '/agent/ingest-course/affordance',
  '/agent/record-course-completion/affordance',
  '/agent/forwarding/targets/affordance',
  '/agent/credentials/affordance',
  // The SCORM affordance bundle descriptor.
  '/agent/scorm/affordances',
  // Course read views (dereference, public + read-only). A course is DESCRIPTIVE
  // content, so listing one or fetching it (as JSON, as the real imsmanifest.xml,
  // or as HyperMarkdown) is not a capability — same category as the lattice read
  // views above. Only launch/submit mutate an attempt and write a learner record,
  // and those remain signed capability affordances; no read route can start or
  // score an attempt.
  '/agent/scorm/courses',
  '/agent/scorm/course/:id',
];

/** Normalize a route path so :param segments compare as a wildcard. */
function normalizePath(p) {
  return p
    .replace(/\/$/, '')                 // drop trailing slash
    .replace(/:[A-Za-z0-9_]+/g, ':p');  // :label / :id → :p
}

const allowSet = new Set(ALLOWLIST.map(normalizePath));

// ── 1. Routes declared in server.ts ──────────────────────────────────────────
const serverSrc = readFileSync(SERVER, 'utf8');
// app.post('/agent/...'   app.get("/agent/..."   app.put('/agent/...')
const routeRe = /\bapp\.(post|get|put)\(\s*['"`](\/agent\/[^'"`]*)['"`]/g;
const routes = new Map(); // normalizedPath → { raw, methods:Set }
for (const m of serverSrc.matchAll(routeRe)) {
  const method = m[1].toUpperCase();
  const raw = m[2];
  const key = normalizePath(raw);
  if (!routes.has(key)) routes.set(key, { raw, methods: new Set() });
  routes.get(key).methods.add(method);
}

// ── 2. Affordance targetTemplate paths in affordances.ts ─────────────────────
const affSrc = readFileSync(AFFORDANCES, 'utf8');
// targetTemplate: '{base}/agent/...'
const targetRe = /targetTemplate:\s*['"`]\{base\}(\/agent\/[^'"`]*)['"`]/g;
const covered = new Set();
for (const m of affSrc.matchAll(targetRe)) covered.add(normalizePath(m[1]));

// ── 3. Reconcile ─────────────────────────────────────────────────────────────
const offenders = [];
for (const [key, info] of routes) {
  if (covered.has(key)) continue;   // discoverable via an affordance
  if (allowSet.has(key)) continue;  // intentional infra
  offenders.push(info.raw + ' [' + [...info.methods].sort().join(',') + ']');
}

if (offenders.length > 0) {
  console.error('✗ Foxxi /agent/* capability routes with NO discoverable affordance and NOT allowlisted:');
  for (const o of offenders.sort()) console.error('    ' + o);
  console.error('');
  console.error('Fix: add an `externallyRouted: true` Affordance (matching targetTemplate) in');
  console.error('     applications/foxxi-content-intelligence/affordances.ts, OR add the route to');
  console.error('     the ALLOWLIST in tools/check-foxxi-affordances.mjs if it is infra.');
  process.exit(1);
}

// Surface unused allowlist entries as a non-fatal warning (keeps it honest).
const liveKeys = new Set(routes.keys());
const staleAllow = [...allowSet].filter(a => !liveKeys.has(a));
if (staleAllow.length > 0) {
  console.warn('note: ALLOWLIST entries no longer present as routes (safe to prune): ' + staleAllow.join(', '));
}

console.log(
  '✓ every Foxxi /agent/* route is a discoverable affordance or allowlisted infra' +
  ` (${routes.size} routes: ${covered.size} affordance-covered, ${allowSet.size} allowlisted)`,
);
process.exit(0);
