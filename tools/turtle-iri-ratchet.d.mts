// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** The banked allowance for raw `<${expr}>` sites in production TypeScript. Never rises. */
export declare const MAX_RAW_IRI_INTERPOLATIONS: number;

/**
 * How many raw `<${…}>` sites `text` emits, counted inside template-literal expressions only.
 *
 * `fileName` is used for parse diagnostics and nothing else.
 */
export declare function countSitesIn(text: string, fileName?: string): number;

/** Absolute paths, lower-cased and forward-slashed, of files a workspace's `test` script runs. */
export declare function testRunFiles(root?: string): Set<string>;

/** One file's contribution to the count. */
export interface RatchetFileCount {
  /** Repo-relative path, as printed by the gate. */
  file: string;
  /** Sites found in it. */
  count: number;
}

export declare function countRawIriInterpolations(root?: string): {
  /** Sites in production files — what the budget is compared against. */
  total: number;
  /** Contributing files, heaviest first. */
  perFile: RatchetFileCount[];
  /** Files left out because a workspace test script runs them, heaviest first. */
  excluded: RatchetFileCount[];
  /** How many test-run files the derivation found; a collapse here means it broke. */
  testRunCount: number;
  /**
   * Files the parser could not fully read, with the diagnostic count for each.
   *
   * The parser RECOVERS rather than throwing, so such a file contributes fewer sites than it
   * holds and the total is an undercount — the direction that loosens the gate.
   */
  syntaxErrors: RatchetFileCount[];
  /**
   * Whether `parseDiagnostics` was observable at all. `false` means the guard above is disarmed
   * by a TypeScript change, and the gate refuses rather than reporting a number it cannot trust.
   */
  diagnosticsSeen: boolean;
};
