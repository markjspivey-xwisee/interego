/**
 * The headless selftest's OWN Hosted Terms setting, kept apart from `selftest.ts` so it can be
 * tested without starting Electron.
 *
 * ★ ITS OWN VARIABLE, NOT ANOTHER TOOL'S. The selftest mints a key when none is stored, and a new
 * key opens a new hosted account, which hosted identity opens only with the agreement to the
 * current Hosted Interego Terms (HTTP 428 otherwise). The operator who runs it gives that
 * agreement here, for this run's account, by naming the exact version they read. Sharing a
 * variable with some other driver would mean an agreement given for that driver's accounts
 * silently became one for this run's too, so it reads only this name. Never defaulted.
 */
import type { WalletSignInOptions } from './auth.js';

/** The environment variable the selftest reads the operator's Hosted Terms agreement from. */
export const SELFTEST_ACCEPT_HOSTED_TERMS_ENV = 'INTEREGO_SELFTEST_ACCEPT_HOSTED_TERMS_VERSION';

/** The sign-in options the selftest passes to `signInWithWallet`: the operator's version, or nothing. */
export function selftestSignInOptions(env: Readonly<Record<string, string | undefined>>): WalletSignInOptions {
  const version = (env[SELFTEST_ACCEPT_HOSTED_TERMS_ENV] ?? '').trim();
  return version ? { acceptHostedTermsVersion: version } : {};
}
