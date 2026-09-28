import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import { DELETED, PLAN_FILE, ROOT } from './tools/base-without-verticals.mjs';

/**
 * The base's own suite, for `tools/base-without-verticals.mjs --run` and nothing else (#366).
 *
 * It runs exactly the test modules the plan names: those whose closure stays inside the base,
 * classified by `--plan` while the trees were present, and run here with `applications/`,
 * `integrations/`, `examples/` and the vertical-owned packages deleted.
 * - The full typecheck gate is not its globalSetup, because that program includes the trees this
 *   run deleted; the tool typechecks the same modules first, with the same compiler options.
 * - The run-integrity reporter's module floor is for the whole suite, not this part of it; the
 *   tool's pins hold this set's size instead.
 * So this is not a way round either gate: it refuses to load in a checkout that still has the
 * trees, where the full config and both gates apply.
 */
const present = DELETED.filter(t => existsSync(join(ROOT, t)));
if (present.length > 0) {
  throw new Error(`vitest.base.config.ts runs only with ${DELETED.join(', ')} removed (found ${present.join(', ')}); use vitest.config.ts`);
}
if (!existsSync(PLAN_FILE)) throw new Error(`no ${PLAN_FILE}: run tools/base-without-verticals.mjs --plan while the trees are present`);
const plan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as { vitest: string[] };

export default defineConfig({
  ...base,
  test: { ...base.test, include: plan.vitest, globalSetup: [], reporters: ['default'] },
});
