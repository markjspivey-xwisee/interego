/**
 * WHICH IMAGE LEGS SHOULD THIS DISPATCH BUILD? Prints the matrix as JSON.
 *
 * ── ★★ WHY THIS IS A FILE AND NOT A SCRIPT INSIDE THE WORKFLOW ──────────────
 *
 * It was inline in `build-ghcr.yml` for about ten minutes and broke the workflow: a `\n` inside the
 * embedded JavaScript became a real newline in the YAML, which turned a block scalar into an
 * unparseable mapping key. GitHub's report of that is "Workflow does not have 'workflow_dispatch'
 * trigger" — a message that names neither the file nor the line, on a workflow that had one.
 *
 * That was the third time in one session that escaping inside a nested here-document produced
 * broken code. A file has no nesting to escape through.
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
 *
 * The per-leg skip in that workflow used to be a step-level `if:`, and GitHub downloads a job's
 * actions during "Set up job" — before any step runs. So a dispatch for ONE image still started
 * sixteen runners and pulled `docker/setup-buildx-action` sixteen times, then skipped fifteen
 * builds. MEASURED: repeated single-service deploys in one session earned 429 Too Many Requests
 * from codeload and failed five builds that had nothing wrong with them.
 *
 * A job-level `if:` cannot fix it — the `matrix` context is not available there. Computing the
 * matrix is what does: one requested image expands to one leg, so no other runner starts.
 *
 * ★ AND AN UNKNOWN NAME EXITS NON-ZERO. A dispatch that would build nothing must fail rather than
 * go green having built nothing — the whole reason the validating job exists.
 *
 * Usage:  node tools/ci-image-matrix.mjs "$REQUESTED_IMAGE"   ("" means all)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '..', 'deploy', 'images.json');

/** @type {{ images: { image: string, dockerfile: string, build_args?: string, prebuild?: string }[] }} */
let manifest;
try {
  manifest = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  process.stderr.write(`::error::could not read ${file}: ${(e).message}\n`);
  process.exit(1);
}

const all = Array.isArray(manifest.images) ? manifest.images : [];
if (!all.length) {
  process.stderr.write('::error::deploy/images.json lists no images — nothing could be built\n');
  process.exit(1);
}

const requested = (process.argv[2] ?? '').trim();
const legs = requested ? all.filter((i) => i.image === requested) : all;

if (!legs.length) {
  process.stderr.write(`::error::unknown image '${requested}' — nothing would be built. Valid images:\n`);
  for (const i of all) process.stderr.write(`  ${i.image}\n`);
  process.exit(1);
}

// Stdout is the matrix; anything explanatory goes to stderr so it cannot corrupt it.
process.stderr.write(`building ${legs.length} of ${all.length} image(s)\n`);
process.stdout.write(JSON.stringify(legs));
