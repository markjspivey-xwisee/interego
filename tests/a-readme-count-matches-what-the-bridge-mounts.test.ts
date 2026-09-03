/**
 * A count a README states about its own vertical must match what the vertical declares.
 *
 * ── THE FINDING ─────────────────────────────────────────────────────────────
 *
 * `applications/learner-performer-companion/bridge/README.md` said the bridge "exposes the LPC
 * vertical's 6 affordances as named MCP tools". `affordances.ts` exports TWO arrays —
 * `lpcAffordances` (7) and `lpcEnterpriseAffordances` (4) — and `bridge/server.ts` concatenates
 * them per `LPC_AUDIENCE`, defaulting to `both`. So the bridge mounts 11, and even the narrowest
 * audience is 7. Never 6.
 *
 * The three sibling bridge READMEs all checked out (agent-collective 5=5,
 * agent-development-practice 8=8, lrs-adapter 4=4), so this was one row going stale rather than
 * a convention nobody follows — which is exactly the case a gate is for, and exactly the case
 * that is invisible without one.
 *
 * ── WHY IT COUNTS DECLARATIONS AND NOT MOUNTS ───────────────────────────────
 *
 * What a bridge mounts depends on env (`LPC_AUDIENCE`), and importing a bridge to ask starts a
 * listener. What the vertical DECLARES is in `affordances.ts` and is countable by parsing it.
 * A README claiming a number smaller than the declared total is the failure that shipped; a
 * README that states no number is fine and is not asked to.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = join(ROOT, 'applications');

/** How many affordances a vertical declares — every `action:` property in affordances.ts. */
function declaredAffordances(vertical: string): number | null {
  const file = join(APPS, vertical, 'affordances.ts');
  if (!existsSync(file)) return null;
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'action') n += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return n;
}

/** `N affordances` / `N tools` claimed anywhere in a bridge README. */
function claimedCounts(text: string): number[] {
  return [...text.matchAll(/\b(\d+)\s+(?:affordances|tools)\b/g)].map(m => Number(m[1]));
}

describe('a bridge README does not understate what its vertical declares', () => {
  const verticals = readdirSync(APPS)
    .filter(v => v !== '_shared')
    .filter(v => existsSync(join(APPS, v, 'bridge', 'README.md')));

  it('finds the bridge READMEs at all', () => {
    // Guards the guard: an empty list would report every README correct.
    expect(verticals.length, 'no bridge READMEs found — the scan is broken').toBeGreaterThan(2);
  });

  it('★ every count a bridge README states is at least what the vertical declares', () => {
    const wrong: string[] = [];
    for (const v of verticals) {
      const declared = declaredAffordances(v);
      if (declared === null) continue;
      const readme = readFileSync(join(APPS, v, 'bridge', 'README.md'), 'utf8');
      for (const claimed of claimedCounts(readme)) {
        // Only an UNDERSTATEMENT is a defect: a README may legitimately mention a subset
        // ("the 3 learner-side tools"), but claiming fewer than exist as the whole surface is
        // how LPC came to advertise 6 of 11.
        if (claimed < declared && claimed >= declared - 0) continue;
        if (claimed > declared) {
          wrong.push(`${v}/bridge/README.md claims ${claimed}, but affordances.ts declares ${declared}`);
        }
      }
      // The headline claim — the first count in the file — must be the real total.
      const first = claimedCounts(readme)[0];
      if (first !== undefined && first !== declared) {
        wrong.push(`${v}/bridge/README.md opens with "${first}" where affordances.ts declares ${declared}`);
      }
    }
    expect(
      wrong,
      'a README stating a smaller surface than the vertical declares is how a reader concludes '
        + 'a capability does not exist:\n  ' + wrong.join('\n  '),
    ).toEqual([]);
  });
});
