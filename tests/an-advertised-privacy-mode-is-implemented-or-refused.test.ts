/**
 * A privacy mode a vertical ADVERTISES must be implemented, or refused — never quietly weaker.
 *
 * ── THE FINDING ─────────────────────────────────────────────────────────────
 *
 * `lpc.aggregate_cohort_query` and `owm.aggregate_decisions_query` both offered
 * `privacy_mode: … | zk-distribution (v3 histogram)`, documented `distribution_edges` and
 * `distribution_max_value` as "Required when privacy_mode=zk-distribution", and promised that
 * "the bundle returned in the response advertises which path was taken".
 *
 * Neither handler implemented it. `zk-distribution` matched no branch and fell into the v1 ABAC
 * path — whose own comment reads "walk every supplied pod… No opt-in filtering" — and the
 * result reported `privacyMode: 'abac'`. A caller who asked for the STRONGEST advertised
 * privacy over learner cohort data received an unblinded exact count, with no DP noise, no
 * commitment bundle, and in LPC no consent filtering, and no error was raised. The primitive
 * exists and is wired in foxxi, so this was a wiring gap advertised as a feature.
 *
 * ── WHAT THIS CHECKS ────────────────────────────────────────────────────────
 *
 * Every mode NAMED in a vertical's published affordances must appear in that vertical's handler
 * source as something the code decides about. Degrading to a default is what this forbids; the
 * decision may be to implement it or to refuse it, and refusing is a decision.
 *
 * It cannot prove the implementation is CORRECT — only that no advertised mode is unmentioned
 * by the code that claims to offer it. That is the exact failure that shipped, and it is
 * cheaply decidable, which is why it is what gets checked.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Verticals that advertise a `privacy_mode`, and the module their handler delegates to. */
const SURFACES: ReadonlyArray<readonly [string, string, string]> = [
  ['learner-performer-companion', 'affordances.ts', 'src/institutional-publisher.ts'],
  ['organizational-working-memory', 'affordances.ts', 'src/operator-publisher.ts'],
  ['foxxi-content-intelligence', 'affordances.ts', 'src/publisher.ts'],
];

/**
 * Mode names an affordance file offers.
 *
 * Read from the `privacy_mode` input's description and the surrounding prose, because that is
 * where a caller reads them — the affordances are published as Turtle and this text IS the
 * contract. Hyphenated lowercase tokens that look like a mode, filtered to the known vocabulary
 * so ordinary prose words do not become assertions.
 */
const KNOWN_MODES = [
  'abac', 'merkle-attested-opt-in', 'zk-aggregate', 'zk-distribution',
] as const;

function advertisedModes(text: string): string[] {
  const found = new Set<string>();
  for (const mode of KNOWN_MODES) {
    // `abac` appears in unrelated prose; require it in a mode-listing context.
    const re = mode === 'abac'
      ? /privacy[_ ]mode[^.]{0,400}?\babac\b/is
      : new RegExp(`\\b${mode}\\b`);
    if (re.test(text)) found.add(mode);
  }
  return [...found];
}

/**
 * Every string literal a module's EXECUTABLE code contains.
 *
 * ★★ TWO KINDS OF MENTION HAD TO BE EXCLUDED, EACH AFTER IT DEFEATED THIS GATE'S OWN MUTANT.
 *
 *  1. COMMENTS. The first version asked `code.includes(mode)`, and the fix for this very
 *     finding had written the mode's name into an explanatory comment above the branch — so
 *     deleting the branch left the comment and the gate stayed green. Using the parser fixed it.
 *  2. TYPE POSITIONS. Then `'zk-distribution'` was added to the `privacy_mode` union — correctly,
 *     because the mode IS an accepted input — and the literal reappeared, in a LiteralTypeNode.
 *     A union member DECLARES that a value may arrive. It does not decide anything about it,
 *     which is the whole distinction this gate exists to draw: the mode was in the affordance
 *     and in no branch, and that is what shipped an unblinded count.
 *
 * So: string literals, excluding those whose parent is a type node.
 */
function stringLiteralsIn(text: string): Set<string> {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    const isLiteral = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
    if (isLiteral && !(n.parent && ts.isLiteralTypeNode(n.parent))) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

describe('an advertised privacy mode is implemented or refused, never silently weaker', () => {
  it('finds the surfaces and their modes at all', () => {
    // Guards the guard: if the extraction stops finding modes, every assertion below is vacuous
    // — which is the same shape as the defect (a mode nobody decides about).
    const total = SURFACES.reduce((n, [v, aff]) => {
      const p = join(ROOT, 'applications', v, aff);
      return n + (existsSync(p) ? advertisedModes(readFileSync(p, 'utf8')).length : 0);
    }, 0);
    expect(total, 'no privacy modes found in any affordance file — the scan is broken')
      .toBeGreaterThan(5);
  });

  it.each(SURFACES.map(s => [s[0], s] as const))('%s', (_name, [vertical, aff, impl]) => {
    const affPath = join(ROOT, 'applications', vertical, aff);
    const implPath = join(ROOT, 'applications', vertical, impl);
    expect(existsSync(affPath), `${vertical}/${aff} is missing`).toBe(true);
    expect(existsSync(implPath), `${vertical}/${impl} is missing — this gate is reading a path `
      + 'that moved, and would pass vacuously').toBe(true);

    const modes = advertisedModes(readFileSync(affPath, 'utf8'));
    // ★★ STRING LITERALS, NOT THE FILE TEXT. The first version asked `code.includes(mode)`,
    // and the fix for this very finding had written the mode's name into an explanatory COMMENT
    // above the branch - so deleting the branch left the comment, the gate stayed green, and
    // its own mutant survived. A mode the handler DECIDES about appears as a string literal in
    // a comparison; a mode it merely talks about does not.
    const literals = stringLiteralsIn(readFileSync(implPath, 'utf8'));

    // `abac` is the DEFAULT every handler falls back to, so it needs no branch of its own.
    const unhandled = modes.filter(m => m !== 'abac' && !literals.has(m));
    expect(
      unhandled,
      `${vertical} advertises these privacy modes and its handler mentions none of them, so a `
        + 'caller asking for one gets the default path with a weaker guarantee and no error:\n  '
        + unhandled.join('\n  '),
    ).toEqual([]);
  });
});
