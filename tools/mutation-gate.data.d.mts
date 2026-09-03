// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** One known defect, paired with the gate(s) that must go red for it. */
export interface Mutant {
  /** Stable identifier; `--only=<substring>` selects on it. */
  name: string;
  /** Repo-relative path of the file the defect is applied to. */
  file: string;
  /** Verbatim source to replace. A stale anchor is a FAILURE, never a skip. */
  find: string;
  /** What it becomes. Must still compile, or the run is INCONCLUSIVE. */
  replace: string;
  /** The gate file(s) required to fail. `deploy/` and `tools/` entries run as scripts. */
  mustFail: readonly string[];
  /** Why this defect matters — a mutant nobody can evaluate is not a check. */
  why: string;
}

export declare const MUTANTS: readonly Mutant[];
