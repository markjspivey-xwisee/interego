/**
 * How every switch in the test tree reads a boolean out of the environment — one answer, in one
 * place, because the previous answer was `=== '1'` written out four times.
 *
 * ★ THE DEFECT, AND IT IS WORSE THAN A BAD ERROR MESSAGE. `SKIP_POD_TESTS`, `SKIP_AZURE_TESTS`
 * and `SKIP_LRSQL_TESTS` are advertised by NAME everywhere they appear: "declare the skip with
 * SKIP_POD_TESTS", "set SKIP_LRSQL_TESTS to say so explicitly". Not one of those messages
 * mentions a value, and every reader compared against the exact string `'1'`. So
 * `SKIP_POD_TESTS=true` did not skip: it fell straight through to `probePod()`.
 *
 * DRIVEN, on the `=== '1'` code, with a write credential set and `SKIP_POD_TESTS=true`:
 * `tier2-azure-css.test.ts` did not skip and did not throw — it DIALLED THE LIVE POD and ran
 * all five round-trip bodies against it, failing 5/6 on the wire. The throw everyone would
 * predict ("Refusing to skip") is what happens on the OTHER branch, when the pod is
 * unreachable. So the reachable case is the bad one: an operator who wrote `=true` to keep
 * these away from live infrastructure got them pointed at it.
 *
 * ★ AND AN UNRECOGNISED VALUE THROWS RATHER THAN READING AS FALSE. Silent-false is the shape
 * that produced the defect: a control nobody reads, which the person who set it believes is
 * working. `SKIP_POD_TESTS=ture` has to be loud, and it is loud only on the machine of the
 * person who typed it — nothing in this repo sets any of these names. RE-MEASURED on 843fc4fa
 * over all 2,698 files git lists (tracked plus untracked-and-not-ignored, so `.github` is
 * included — ripgrep without `--hidden` would have skipped all 24 of its files): zero
 * assignments to any of the three, anywhere.
 *
 * ★ WHAT IS NOT COVERED, STATED RATHER THAN IMPLIED. `PGSL_PG_IT` and `PGSL_FDB_IT` in
 * `tests/pgsl-store-*-integration.test.ts` are the same `=== '1'` shape and are NOT routed
 * through here. They are set only by their own workflows, which write a literal `'1'`, so the
 * hazard is smaller — but the inconsistency is real and is named here rather than left for
 * someone to discover as a surprise.
 *
 * Not collected by vitest (its include is `*.test.ts`); compiled by the typecheck gate, whose
 * tsconfig.check.json includes `applications/**\/tests/**\/*.ts`.
 */

/** Values that mean "yes". Lower-cased and trimmed before comparison. */
export const TRUTHY: readonly string[] = ['1', 'true', 'yes', 'on'];

/**
 * Values that mean "no". `''` is here because an empty string is what a workflow writes for
 * `SKIP_POD_TESTS: ${{ secrets.NOT_SET }}` — an absent value, not a request.
 */
export const FALSY: readonly string[] = ['', '0', 'false', 'no', 'off'];

/**
 * The raw value is passed in rather than read from `name`, so every call site keeps a literal
 * `process.env['…']` in its own file. That is not style: the registry's census asks whether a
 * name a switch ADVERTISES is a name some module actually READS, and a helper doing
 * `process.env[name]` would erase the only evidence that question can be answered from.
 */
export function envFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (TRUTHY.includes(v)) return true;
  if (FALSY.includes(v)) return false;
  throw new Error(
    `${name}=${JSON.stringify(raw)} is not a value this gate understands. Set it to one of `
    + `${TRUTHY.join('/')} to declare it, or ${FALSY.slice(1).join('/')} to decline. `
    + 'Refusing to guess: a switch that quietly reads an unknown value as OFF is how a suite '
    + 'runs against infrastructure somebody meant to keep it away from.',
  );
}
