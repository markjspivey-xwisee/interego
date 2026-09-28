// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

export interface TriggerRetryOptions {
  /** Most calls to the trigger, the first included. Default 4. */
  attempts?: number;
  /** The first wait between calls; each later wait doubles. Default 5000. */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** A deployment that exists since the repoint, which is followed instead of triggering again. */
  reconcile?: () => Promise<string | undefined>;
}

/**
 * Call `trigger`, retrying only an answered refusal (`GraphQL: …`), at most `attempts` times with
 * doubling waits; an ambiguous failure is rethrown at once, and a deployment `reconcile` reports is
 * followed, never triggered over.
 */
export declare function triggerWithRetry<T>(
  trigger: () => Promise<T>,
  options?: TriggerRetryOptions,
): Promise<T | { serviceInstanceDeployV2: string }>;
