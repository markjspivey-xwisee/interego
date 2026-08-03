/**
 * Railway service name → GHCR image repository. The single tracked copy of a mapping
 * that was previously not written down anywhere and was instead re-derived, wrongly,
 * at each call site.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * `tools/railway-redeploy.mjs` used to compute `interego-${service}` inline. That holds
 * for thirteen of the sixteen services and is wrong for three, so the assumption was
 * invisible until the day it wasn't — and the day it wasn't, it blocked a legitimate
 * deploy for a naming reason dressed up as a safety one: `css` runs
 * `interego-css-pgsl`, so pinning it was refused even though a sha-tagged image of it
 * exists. The guard was right and its reason was wrong, which is the worst combination
 * because the reason is what the next person reads.
 *
 * A branch (`if (service === 'css') …`) would have unblocked that one service and left
 * the derivation in place for the next one. The derivation is the defect, so it is gone:
 * every service name is enumerated here, and a name that is not in this table cannot be
 * resolved to an image at all.
 *
 * ── WHY A TABLE AND NOT A DERIVATION FROM SOMETHING ELSE ─────────────────────
 *
 * There is nothing to derive it from. build-ghcr.yml's matrix is the tracked source of
 * IMAGE names, but it does not know Railway SERVICE names, and `css` ↔ `interego-css-pgsl`
 * is exactly the pair that cannot be recovered from either side alone.
 *
 * ── WHY THIS TABLE DOES NOT GO STALE THE WAY services.json DID ───────────────
 *
 * Because it holds no claim about production. It says which image repository a service
 * runs, never which TAG — the tag is the live pin, it is held only by Railway, and
 * writing it into a file is what made deploy/railway/services.json misleading twice.
 * And `node tools/railway-pins.mjs` checks this table against the live API on every run,
 * so a service renamed or added in Railway is reported as a disagreement rather than
 * discovered by a failed deploy.
 *
 * ── VERIFICATION ─────────────────────────────────────────────────────────────
 * Every row below was read off the live Railway API on 2026-08-03 (project
 * `robust-integrity`, 16 services), not copied from services.json — which is wrong about
 * most of them.
 *
 * Run: node tools/railway-services.mjs image <service>
 *      node tools/railway-services.mjs list
 */

import { pathToFileURL } from 'node:url';

export const IMAGE_PREFIX = 'ghcr.io/markjspivey-xwisee';

/**
 * `repo: null` marks a service this repository does not build. Pointing one of those at
 * an interego image replaces a datastore with an application — and for `postgres` that
 * is a data-loss event, not an outage, because the volume stays mounted while something
 * that is not Postgres owns it. They are listed rather than omitted so that asking about
 * them gets a specific refusal instead of "unknown service", which reads like a typo.
 */
export const SERVICES = {
  // Thirteen services whose image really is `interego-<service>`. Spelled out rather
  // than generated: a loop that fills these in is the derivation this file replaced.
  relay: { repo: 'interego-relay' },
  identity: { repo: 'interego-identity' },
  'css-gate': { repo: 'interego-css-gate' },
  'foxxi-bridge': { repo: 'interego-foxxi-bridge' },
  bridge: { repo: 'interego-bridge' },
  dashboard: { repo: 'interego-dashboard' },
  'pgsl-browser': { repo: 'interego-pgsl-browser' },
  microsite: { repo: 'interego-microsite' },
  main: { repo: 'interego-main' },
  'acme-id': { repo: 'interego-acme-id' },
  'foxxi-dashboard': { repo: 'interego-foxxi-dashboard' },
  'foxxi-microsite': { repo: 'interego-foxxi-microsite' },
  'foxxi-scorm-player': { repo: 'interego-foxxi-scorm-player' },

  // The one that is not. `interego-css` has never existed at any tag; build-ghcr.yml
  // builds this service under `interego-css-pgsl` (matrix leg with a `prebuild` step for
  // packages/pgsl-store/dist).
  css: { repo: 'interego-css-pgsl' },

  postgres: { repo: null, upstream: 'postgres:16' },
  redis: { repo: null, upstream: 'redis:7-alpine' },
};

/** Service names in table order, for error messages that tell the caller what IS valid. */
export function serviceNames() {
  return Object.keys(SERVICES);
}

/**
 * Resolve a service name to the full GHCR repository that service runs.
 *
 * Returns a result rather than throwing so each caller keeps its own refusal format and
 * exit code — railway-redeploy.mjs exits 2 with a usage-shaped message, railway-pins.mjs
 * prints the disagreement in a column and keeps going.
 *
 * ★ `Object.hasOwn`, NOT `SERVICES[service]`. Service names reach here from a CLI
 * argument and from a workflow_dispatch input, and `css-gate` and `constructor` are
 * equally plausible-looking to the `/^[a-z0-9-]+$/` check upstream. A plain property read
 * answers `constructor` with a function inherited from Object.prototype, which is truthy,
 * whose `.repo` is `undefined` — so the caller would sail past the "unknown service"
 * refusal and pin production at `ghcr.io/markjspivey-xwisee/undefined`. Railway accepts
 * that pin, cannot pull it, and leaves the old container serving, so nothing looks wrong
 * until the next restart.
 */
export function resolveImageRepo(service) {
  if (!Object.hasOwn(SERVICES, service)) {
    return {
      ok: false,
      reason: `unknown Railway service "${service}". Valid: ${serviceNames().join(', ')}`,
    };
  }
  const entry = SERVICES[service];
  if (entry.repo === null) {
    return {
      ok: false,
      reason: `"${service}" is a datastore running the upstream image ${entry.upstream}. ` +
        'This repository does not build it, and repointing it at an interego image would ' +
        'replace the datastore with an application on top of its live volume.',
    };
  }
  return { ok: true, repo: `${IMAGE_PREFIX}/${entry.repo}` };
}

/**
 * CLI, so a shell step can ask the same question the scripts do instead of re-deriving it.
 * `.github/workflows/deploy-railway.yml` still spells `interego-${{ inputs.service }}` in
 * its GHCR existence pre-check; that file is outside this change's scope, but this is what
 * it needs to call.
 */
async function main(argv) {
  const [verb, service] = argv;
  if (verb === 'list') {
    for (const name of serviceNames()) {
      const r = resolveImageRepo(name);
      console.log(`${name.padEnd(20)} ${r.ok ? r.repo : `(${SERVICES[name].upstream} — not built here)`}`);
    }
    return 0;
  }
  if (verb === 'image' && service !== undefined) {
    const r = resolveImageRepo(service);
    if (!r.ok) { console.error(`error: ${r.reason}`); return 2; }
    console.log(r.repo);
    return 0;
  }
  console.error('usage: railway-services.mjs image <service>\n       railway-services.mjs list');
  return 2;
}

// Guarded so importing this table never runs the CLI. `pathToFileURL` because argv[1] is a
// backslash path on Windows and would never string-compare equal to an `import.meta.url`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
