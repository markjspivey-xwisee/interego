/**
 * Foxxi (L1) may not deepen its dependency on agp (L2).
 *
 * ── THE ARCHITECTURE THIS PINS ───────────────────────────────────────────────
 *
 * L1 `foxxi-content-intelligence` is a STANDARDS vertical: xAPI 2.0, IEEE-LER, ADL-TLA,
 * cmi5, SCORM, LTI, OneRoster. L2 `agentic-performance-practice` is a theory of performance
 * that COMPOSES those standards. The arrow runs agp -> foxxi. A standards vertical that
 * imports a theory of performance has the dependency upside down: it makes the conformant
 * layer un-shippable without the opinionated one.
 *
 * ── WHY A RATCHET AND NOT A ZERO ─────────────────────────────────────────────
 *
 * The honest number is not zero, and asserting zero would be a lie that had to be bypassed
 * on the first run. The Stage-2 extraction moved the engine into agp/src and left Foxxi
 * importing it, first through seven single-line re-export shims at the old paths and now —
 * since those were deleted — directly at every call site. Nothing about the coupling changed
 * when the shims went; it stopped being disguised as `./agent-disposition.js`.
 *
 * Most of the count is one file: `performance-routes.ts` is the L2 spine still living in the
 * L1 vertical, and it is not cleanly separable today because it also serves
 * /content/compose-course and /content/personalize, which ARE Foxxi's. Splitting it means
 * choosing a boundary the extraction survey explicitly left open, and repointing four
 * microsite files that call /performance live. That is the migration this number is waiting
 * for; until then the debt is real and this refuses to let it grow.
 *
 * ── WHY IT COUNTS MENTIONS AND NOT `import` LINES ────────────────────────────
 *
 * Measured while writing this: anchoring on `^\s*import` reported NINE sites where there are
 * SIXTEEN, because a multi-line import puts its `from '…'` clause on a line that does not
 * start with `import`. A ratchet that undercounts is worse than none — it leaves room to add
 * coupling without moving the number.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGP = 'agentic-performance-practice';
const FOXXI_SHIPPED = [
  'applications/foxxi-content-intelligence/src',
  'applications/foxxi-content-intelligence/bridge',
];

/**
 * Measured 2026-08-30, after the seven transitional shims were deleted from BOTH `src/` and
 * `bridge/`. `performance-routes.ts` holds 7 of the 20 and `bridge/server.ts` 5.
 *
 * ★ THE FIRST BASELINE WAS 16 AND WAS TAKEN MID-CHANGE. The shim rewrite had run over
 * `src/` only, so `bridge/server.ts` was still importing four deleted modules through
 * `../src/<name>.js` — invisible locally, because tsconfig.check.json excludes every bridge,
 * and red in CI. Completing the rewrite turned those four into explicit agp paths and this
 * ratchet caught its own author: 16 -> 20 with no new coupling whatsoever, only the last four
 * indirections spelled out. Re-baselined at the number that is true once the change is whole.
 *
 * That is the ratchet behaving correctly and the baseline having been wrong, which is worth
 * distinguishing: a number pinned before a change is finished pins a fiction.
 *
 * LOWER IT when the routes migrate; never raise it.
 */
const MAX_UPWARD_MENTIONS = 20;
const MAX_UPWARD_FILES = 9;

function upwardMentions(): { total: number; byFile: Record<string, number> } {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-oF', '--', AGP, '--', ...FOXXI_SHIPPED],
      { cwd: ROOT, encoding: 'utf8' });
  } catch {
    return { total: 0, byFile: {} };   // git grep exits 1 on no match
  }
  const byFile: Record<string, number> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const file = line.split(':')[0] ?? '';
    if (!/\.ts$/.test(file)) continue;
    byFile[file] = (byFile[file] ?? 0) + 1;
  }
  return { total: Object.values(byFile).reduce((a, b) => a + b, 0), byFile };
}

describe('the standards vertical does not deepen its dependency on the theory vertical', () => {
  it('does not grow the number of upward references', () => {
    const { total, byFile } = upwardMentions();
    const detail = Object.entries(byFile)
      .sort((a, b) => b[1] - a[1])
      .map(([f, n]) => `${f.replace('applications/foxxi-content-intelligence/', '')}=${n}`)
      .join(', ');
    expect(
      total,
      `foxxi now names ${AGP} ${total} times (was ${MAX_UPWARD_MENTIONS}). L1 must not import `
        + `L2 more than it already does — migrate the routes instead of adding a call. ${detail}`,
    ).toBeLessThanOrEqual(MAX_UPWARD_MENTIONS);
    expect(Object.keys(byFile).length).toBeLessThanOrEqual(MAX_UPWARD_FILES);
  });

  it('★ is measuring something — a ratchet over an empty set passes forever', () => {
    // The failure mode this whole file exists to avoid: the paths stop matching, the count
    // reads 0, and the gate reports success while checking nothing.
    const { total } = upwardMentions();
    expect(total, 'found no upward references at all — has the path or the layout moved?')
      .toBeGreaterThan(0);
  });

  it('the CORRECT direction is not restricted', () => {
    // agp composing foxxi is the architecture working. Asserted so a future reader does not
    // "fix" the ratchet by making it symmetric, which would forbid the intended arrow.
    //
    // ★★ THIS ASSERTED `length >= 0` AND COULD NOT FAIL. `Array.prototype.length` is never
    // negative, so it held for every possible value — including the `''` its own catch left
    // behind when git was absent. `upwardMentions()` was never called and symmetry was never
    // exercised, so the edit the comment above says this guards against would have passed with
    // a green tick. Its sibling two tests up is titled "is measuring something — a ratchet over
    // an empty set passes forever", so the class was named in this very file and this leg
    // shipped anyway.
    //
    // What makes it falsifiable: the correct direction must be BOTH real (agp does reference
    // foxxi) and UNCOUNTED by the ratchet (making the ratchet symmetric would sweep these in).
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-lF', '--', 'foxxi-content-intelligence', '--',
        `applications/${AGP}/src`], { cwd: ROOT, encoding: 'utf8' });
    } catch { /* none is also fine */ }
    const downward = out.split('\n').filter(Boolean);
    expect(
      downward.length,
      'agp no longer references foxxi anywhere in src/, so this leg is asserting nothing about '
        + 'the permitted direction — re-point it at whatever the intended arrow is now.',
    ).toBeGreaterThan(0);

    // And the ratchet must not be counting them. `upwardMentions` scans FOXXI_SHIPPED for
    // mentions of agp; a symmetric version would also report these agp→foxxi files, so their
    // absence from byFile is the property "the correct direction is not restricted".
    const { byFile } = upwardMentions();
    const wronglyCounted = downward.filter(f => Object.keys(byFile).includes(f));
    expect(
      wronglyCounted,
      'the ratchet has become symmetric: it is now counting the PERMITTED agp → foxxi arrow as '
        + 'upward drift, which forbids the architecture instead of protecting it:\n  '
        + wronglyCounted.join('\n  '),
    ).toEqual([]);
  });
});
