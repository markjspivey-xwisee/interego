// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** The longest the apt install of Chromium's system packages may take before it is given up. */
export declare const DEPS_TIMEOUT_MS: number;
/** How many times the browser download is tried. */
export declare const DOWNLOAD_ATTEMPTS: number;

export interface ChromiumInstallSteps {
  /** `npx playwright <args>`: true when it exited 0 within `timeout` ms. */
  run(args: string[], timeout: number): boolean;
  /** Resolves once a headless Chromium has rendered a page; rejects otherwise. */
  launch(): Promise<void>;
  pause(ms: number): Promise<void>;
  warn(message: string): void;
}
export type ChromiumInstallOutcome = { ok: true; deps: boolean } | { ok: false; deps: boolean; reason: string };
export declare function installChromium(steps: ChromiumInstallSteps): Promise<ChromiumInstallOutcome>;
