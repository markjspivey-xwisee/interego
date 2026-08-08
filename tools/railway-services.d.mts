// Hand-written declarations for railway-services.mjs, so tests/*.ts may import it.
//
// ★ MEASURED CONSTRAINT, not a style choice. `tsconfig.base.json` sets no `allowJs`, so a
// `.ts` test importing a `.mjs` fails the typecheck gate with TS7016 — and that gate runs
// in vitest's `globalSetup`, so it takes the WHOLE suite down before a single test is
// collected rather than failing one file. A cast on a dynamic import does NOT suppress it.
// `moduleResolution: "bundler"` resolves a `./x.mjs` specifier to a sibling `x.d.mts`, so
// this is the TS-native fix and needs no edit to the shared gate config.
//
// Rejected alternative, recorded so it is not retried: `"allowJs": true` in
// tsconfig.check.json also compiles, in one line instead of two files — rejected because
// it edits the config every test in the repo runs through, and with `checkJs` off the tool
// surface degrades to `any`, so a misspelled import name would compile clean.
//
// Drift is self-catching in one direction only: an export declared here but ABSENT from
// the .mjs arrives as `undefined` and the test that calls it throws. A wrong TYPE on a
// present export would not be caught, so keep these thin.

export interface ServiceEntry {
  repo: string | null;
  upstream?: string;
  health?: string | null;
  /** The last line a PORTLESS service prints on a successful boot. See bootProofFor. */
  bootProof?: string;
  singleton?: boolean;
  maxOverlapSeconds?: number;
  drainingMustBeUnset?: boolean;
}
export declare const IMAGE_PREFIX: string;
export declare const SERVICES: Record<string, ServiceEntry>;
export declare function serviceNames(): string[];
export declare function resolveImageRepo(
  service: string,
): { ok: true; repo: string } | { ok: false; reason: string };

export interface LimitFloor { cpu: number; memoryBytes: number }
export declare const LIMIT_FLOORS: Record<string, LimitFloor>;
export type LimitVerdictName = 'none' | 'ok' | 'BELOW-FLOOR' | 'UNKNOWN-FLOOR' | 'UNPARSED';
export interface LimitVerdict {
  verdict: LimitVerdictName;
  reason: string;
  cpu?: number;
  memoryBytes?: number;
}
export declare function classifyLimit(service: string, override: unknown): LimitVerdict;

export interface LiveRow {
  service: string;
  numReplicas?: number | null;
  overlapSeconds?: number | null;
  drainingSeconds?: number | null;
  missingFromRailway?: boolean;
  error?: string;
}
export interface SingletonViolation {
  service: string;
  setting: 'numReplicas' | 'overlapSeconds' | 'drainingSeconds';
  live: number | null;
  want: number | null;
  why: string;
}
export declare function singletonViolations(rows: LiveRow[]): SingletonViolation[];

export declare function healthPathFor(
  service: string,
): { ok: true; path: string } | { ok: false; reason: string };
export declare function bootProofFor(
  service: string,
): { ok: true; needle: string } | { ok: false; reason: string };
export declare function verifyUrlFor(
  service: string,
  domains: readonly string[] | null | undefined,
  override?: string | undefined,
): { ok: true; url: string } | { ok: false; reason: string };
