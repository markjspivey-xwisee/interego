/**
 * A PROXY THAT IS RIGHT UNTIL SOMETHING LEGITIMATE GROWS.
 *
 * A source-level assertion of the shape
 *
 *     /someFunction[\s\S]{0,2000}theThingIAmChecking/
 *
 * is measuring a DISTANCE and calling it a STRUCTURE. It holds exactly until somebody adds a
 * paragraph, a field, or a branch between the two anchors — and then it goes red over a line nobody
 * touched, protecting a property that is still perfectly intact.
 *
 * ── ★★ THIS COST TWO PRODUCTION DEPLOYS PAST A RED RUN, IN ONE DAY ──────────────────────────
 *
 *   `tool-args-hygiene.test.mjs` sliced a FIXED 4000 characters from `handleSignRequest` and looked
 *   inside for the fail-closed underscore rule. A comment pushed that rule to offset 4197. The
 *   check failed LOOKING EXACTLY LIKE A REGRESSION IN THE SIGNER — the most security-critical
 *   function in the relay — over a rule that was still enforced.
 *
 *   `delegation-surface-honesty.test.ts` did the same with 2000 characters from
 *   `handleVerifyAgent`, and went red the day a third stated answer was added to that handler.
 *
 * Both were correct assertions about the wrong thing. And the second-order cost is worse than the
 * first: a gate that reddens over unrelated additions teaches you to read red as noise, and that is
 * precisely how a deploy goes out past a failing run. The instrument caused the harm it exists to
 * prevent.
 *
 * ★ IT IS THE SAME ERROR AS EVERY OTHER PROXY WE PAID FOR THIS WEEK, with the identifier replaced
 * by a position: a ROW COUNT standing in for a byte bound (a 93-row document reached 32.7 MB); a
 * MANIFEST probe standing in for "does this pod exist" (which retires every agent that has not
 * written yet); a RESTATED RULE standing in for the shipped one (a test that passed against the
 * vulnerable code). Measuring the thing next to the thing you mean, because the thing you mean is
 * harder to ask for.
 *
 * ── WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────────────
 *
 * It does NOT convert the existing ones. There are 40, each needs its own correct anchor, and a
 * sweeping rewrite of forty security assertions at once is a worse risk than the thing it fixes.
 *
 * It RATCHETS: the current population is written down per file, and the count may fall but never
 * rise. New assertions must anchor on structure — slice the function body (signature to the first
 * line-start `}`) and search inside it, the way `tool-args-hygiene` and `delegation-surface-honesty`
 * now do. Same discipline as `lint-gate.mjs`'s baseline and `MIN_TEST_MODULES`: a pin that only
 * tightens when somebody remembers is a pin that never tightens.
 *
 * When you fix one, lower its number here. The failure message says which file moved and by how
 * much, so the edit is one line either way.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `[\s\S]{0,NNN}` with a three-or-more-digit bound. Smaller bounds (`{0,80}`) are usually a genuine
 * "these two tokens are adjacent" claim rather than a stand-in for a structure, so they are left
 * alone — the failure mode this guards against needs room to grow into.
 */
const FIXED_WINDOW = /\[\\s\\S\]\{0,(\d{3,})\}/g;

/**
 * The population as of 2026-08-20, per file. MAY FALL, MUST NOT RISE.
 *
 * `identity-attribution-gates.test.ts` holds 23 of the 40 and is the relay's largest security
 * suite — 68 pinned invariants. It is the highest-value file to convert and the highest-risk one to
 * convert carelessly, which is exactly why it is recorded rather than rewritten at the end of a
 * long session.
 */
const BASELINE: Readonly<Record<string, number>> = {
  'deploy/mcp-relay/tests/identity-attribution-gates.test.ts': 22,
  'deploy/mcp-relay/tests/delegation-surface-honesty.test.ts': 8,
  'deploy/mcp-relay/tests/authorship-content-binding.test.ts': 3,
  'deploy/mcp-relay/tool-args-hygiene.test.mjs': 2,
  'tests/encrypted-graph-envelope-field.test.ts': 1,
  'deploy/mcp-relay/tests/required-args.test.ts': 1,
  'applications/foxxi-content-intelligence/checks/evidence-pointers-resolve.check.ts': 1,
};

function census(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        walk(p);
        continue;
      }
      if (!/\.(test|check)\.(ts|mjs)$/.test(e.name)) continue;
      /**
       * ★ CODE LINES ONLY. The first version counted the whole file and immediately flagged THIS
       * one, because the header quotes the pattern in order to explain it. Counting prose as
       * evidence of the thing the prose describes is the same error one level up — and it would
       * have punished exactly the files that document the hazard best.
       *
       * Same line filter every other source assertion in this repo uses.
       */
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      const m = code.match(FIXED_WINDOW);
      if (m) out[p.slice(ROOT.length + 1).split('\\').join('/')] = m.length;
    }
  };
  for (const r of ['tests', 'deploy', 'applications', 'packages', 'mcp-server']) {
    const d = join(ROOT, r);
    if (existsSync(d)) walk(d);
  }
  return out;
}

describe('fixed-window source assertions are pinned, and may only shrink', () => {
  const now = census();

  it('no file has MORE than its recorded baseline', () => {
    const grew = Object.entries(now)
      .filter(([f, n]) => n > (BASELINE[f] ?? 0))
      .map(([f, n]) => `${f}: ${BASELINE[f] ?? 0} -> ${n}`);
    expect(grew, grew.length
      ? `New fixed-window assertion(s). Anchor on STRUCTURE instead: slice the function body — `
        + `indexOf(name) to indexOf('\\n}\\n') — and search inside it. See this file's header for `
        + `the two production deploys this shape cost.\n  ${grew.join('\n  ')}`
      : '').toEqual([]);
  });

  it('★ and no NEW file joins the list', () => {
    const fresh = Object.keys(now).filter((f) => !(f in BASELINE));
    expect(fresh, fresh.length
      ? `These files newly use a fixed-window source assertion:\n  ${fresh.join('\n  ')}`
      : '').toEqual([]);
  });

  it('the baseline is honest — every pinned file still exists and still has some', () => {
    // A baseline naming a file that no longer matches is a number nobody can lower, and it hides
    // the fact that the debt was already paid. Report it so the entry gets deleted.
    const stale = Object.keys(BASELINE).filter((f) => !(f in now));
    expect(stale, stale.length
      ? `Fixed. Delete these entries from BASELINE:\n  ${stale.join('\n  ')}`
      : '').toEqual([]);
  });

  it('and the total is going down, not sideways', () => {
    const total = Object.values(now).reduce((a, b) => a + b, 0);
    const pinned = Object.values(BASELINE).reduce((a, b) => a + b, 0);
    expect(total, `total fixed-window assertions ${total}, baseline ${pinned}`).toBeLessThanOrEqual(pinned);
  });
});
