/**
 * Both Solid server trees resolve a uuid that GHSA-w5hq-g745-h8pq does not reach.
 *
 * ★ WHAT THE ADVISORY IS. GHSA-w5hq-g745-h8pq ("Missing buffer bounds check in v3/v5/v6 when
 * buf is provided") covers uuid below 11.1.1. Every Community Solid Server 7 release pulls it in
 * through Comunica 2: @comunica/expression-evaluator 2.10.0 asks for uuid ^9.0.0, and even its
 * latest 3.x still does. npm audit therefore flagged the root lock (local-node's CSS 7.3.0) and
 * integrations/pgsl-css-accessor's lock (the css image's CSS 7.2.0) through that one package.
 *
 * ★ WHY IT WAS NEVER REACHABLE HERE. expression-evaluator 2.10.0 calls uuid in three places,
 * UUID() and STRUUID() in RegularFunctions.js and BNODE() in SpecialFunctions.js, and each is a
 * bare uuid.v4() with no buffer argument. The advisory needs a caller-supplied buffer. So this
 * is hygiene: it keeps the audit clean enough that a reachable advisory is not lost in noise.
 *
 * ★ WHY 11.1.1 AND NOT LATER. Comunica 2 is CommonJS and require()s uuid. 11.1.1 is the last
 * fixed release that still ships a CommonJS build; 12 and later are ESM-only, which would make
 * every SPARQL UUID() depend on Node's require(esm). The pin is a scoped range key,
 * `uuid@<11.1.1` under @comunica/expression-evaluator, so it rewrites only the vulnerable
 * resolution and matches nothing once that package asks for ^11.1.1 itself.
 *
 * ★ WHY THIS FILE IS THE CHECK. npm's lockfile-only pass does not walk past a workspace link,
 * and the root's CSS sits under the packages/local-node workspace, so the root lock's nested
 * uuid 9.0.1 entry under expression-evaluator was deleted by hand (expression-evaluator now
 * resolves the hoisted uuid 11.1.1). `npm ci` accepts that lock with or without the override,
 * so neither CI install would notice the two drifting apart; `npm ls` would, and nothing runs
 * it. These assertions read the manifests and locks directly, the way the nodemailer test next
 * to this one does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const json = (p: string) => JSON.parse(readFileSync(join(REPO, p), 'utf8')) as Record<string, unknown>;

/** The first uuid release the advisory does not cover. */
const FIRST_FIXED = [11, 1, 1] as const;
const EVALUATOR = '@comunica/expression-evaluator';

const parse = (v: string): number[] => v.split('-', 1)[0]!.split('.').map((n) => Number.parseInt(n, 10));
const atLeast = (v: string, floor: readonly number[]): boolean => {
  const got = parse(v);
  for (const [i, want] of floor.entries()) {
    const have = got[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
};

type Lock = { packages: Record<string, { version?: string }> };

/** The lock entry Node would load for `name` when required from the package at `key`. */
function resolveFrom(lock: Lock, key: string, name: string): { at: string; version?: string } | undefined {
  let dir = key;
  for (;;) {
    const at = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    const hit = lock.packages[at];
    if (hit) return { at, version: hit.version };
    if (!dir) return undefined;
    const i = dir.lastIndexOf('/node_modules/');
    // Up one node_modules level; a workspace directory (packages/local-node) falls through to the root.
    dir = i >= 0 ? dir.slice(0, i) : '';
  }
}

const TREES = [
  { name: 'root workspace (local-node CSS)', dir: '' },
  { name: 'integrations/pgsl-css-accessor (css image)', dir: 'integrations/pgsl-css-accessor' },
];

for (const tree of TREES) {
  const at = (p: string) => (tree.dir ? `${tree.dir}/${p}` : p);
  describe(`${tree.name} carries a patched uuid under Comunica`, () => {
    const pkg = json(at('package.json')) as { overrides?: Record<string, unknown> };
    const lock = json(at('package-lock.json')) as Lock;

    it('overrides uuid under expression-evaluator to the last fixed CommonJS release', () => {
      expect(pkg.overrides?.[EVALUATOR]).toEqual({ 'uuid@<11.1.1': '11.1.1' });
    });

    it('locks no uuid below the fixed release anywhere in the tree', () => {
      const uuids = Object.entries(lock.packages).filter(([k]) => k.split('node_modules/').pop() === 'uuid');
      expect(uuids.length, 'the lock should hold a uuid at all').toBeGreaterThan(0);
      for (const [k, v] of uuids) {
        expect(atLeast(v.version ?? '0', FIRST_FIXED), `${k} locks uuid ${v.version}`).toBe(true);
      }
    });

    it('every expression-evaluator resolves a CommonJS uuid 11 at or above the fixed release', () => {
      const evaluators = Object.keys(lock.packages).filter((k) => k.endsWith(`node_modules/${EVALUATOR}`));
      // When this fails, Comunica 2 has left the tree (CSS moved to Comunica 5, which asks for
      // uuid 11 itself): retire the override and this file together.
      expect(evaluators.length, `${EVALUATOR} should still be in the tree`).toBeGreaterThan(0);
      for (const key of evaluators) {
        const hit = resolveFrom(lock, key, 'uuid');
        expect(hit, `${key} resolves no uuid`).toBeDefined();
        // Major 11 exactly: Comunica require()s uuid, and 12 onwards has no CommonJS build.
        expect(parse(hit!.version ?? '0')[0], `${key} resolves ${hit!.at}@${hit!.version}`).toBe(11);
        expect(atLeast(hit!.version!, FIRST_FIXED), `${key} resolves ${hit!.at}@${hit!.version}`).toBe(true);
      }
    });
  });
}
