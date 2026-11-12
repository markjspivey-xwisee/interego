// Declarations for a plain-ESM operator tool, so a test that imports it typechecks.

export interface SetupOptions {
  createAccount: boolean;
  registerAgent: boolean;
  acceptTerms?: string;
  audience?: string;
  identityUrl?: string;
  relayUrl?: string;
}
export interface SetupOutcome {
  /** 0 ready; 1 a request failed or was refused; 2 a flag is needed to go further; 3 terms must be accepted first. */
  exitCode: 0 | 1 | 2 | 3;
  ready: boolean;
  /** What this run changed on the live services. Empty without a flag. */
  changed: string[];
  service?: { userId: string; agentDid: string; podUrl?: string };
}
export type SetupFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `--flag` and `--name=value`; an unknown option throws, so a typo changes nothing. */
export declare function parseSetupArgs(argv: readonly string[]): SetupOptions;
export declare function setupPlayService(input: {
  privateKey: string | undefined; options: SetupOptions; fetch: SetupFetch; log: (line: string) => void; now?: () => number;
}): Promise<SetupOutcome>;
