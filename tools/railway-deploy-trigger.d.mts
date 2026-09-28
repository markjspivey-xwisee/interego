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
}

/**
 * Call `trigger` until it answers without `_transient`, at most `attempts` times, with doubling
 * waits between calls; throw with the last refusal once they are spent.
 */
export declare function triggerWithRetry<T>(
  trigger: () => Promise<T | { _transient: string }>,
  options?: TriggerRetryOptions,
): Promise<T>;
