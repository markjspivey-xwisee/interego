// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.
import type { RunSnapshot } from './ci-green-for-sha.mjs';

/** The workflow that runs the whole root suite on a pull request. */
export declare const SUITE_WORKFLOW: string;

/** What a whole listing says about the suite run on a head: success, absent, untrusted, pending, or the run's conclusion. */
export declare function suiteState(
  runs: readonly RunSnapshot[],
  opts: { suite?: string; self: string },
): { state: string; detail: string; url?: string };

/** Whether the loop asks again: pending or untrusted, while time remains. */
export declare function keepWaiting(state: string, expired: boolean): boolean;
