/**
 * "You" signed in with a wallet instead of a passkey, with no browser: the demo's headless
 * `DEMO_YOU_WALLET` sign-in.
 *
 * ★ ITS OWN MODULE, AND IT READS NO ENVIRONMENT. `lib/relay.ts` reads `INTEREGO_RELAY` when it
 * loads, so a test that imported this from there would become a second reader of that variable
 * (see `applications/_shared/tests/shared-live-externals.test.ts`). The relay and identity
 * addresses are the caller's: `server.ts` passes its own.
 */
import type { Signer, mintBearer } from '../../../applications/shared-workspace/tools/live-identity.js';

/**
 * Sign "you" in with a wallet instead of a passkey, with no browser: `DEMO_YOU_WALLET`, for testing
 * this demo headlessly. Returns the relay bearer `mintBearer` mints.
 *
 * ★ A KEY THIS DEMO IS HANDED, SO IT NEVER GIVES THE HOSTED TERMS AGREEMENT FOR IT. Hosted identity
 * creates an account only for a wallet that signed the Hosted Terms agreement. The browser path
 * shows those terms on the relay's own page and asks the person signing in; this path cannot ask
 * anyone. The live drivers' `INTEREGO_ACCEPT_HOSTED_TERMS_VERSION` is their operator agreeing for
 * the disposable accounts a driver run creates, not for a key somebody points this demo at, so this
 * is plain `mintBearer`, the route `live-identity.ts` gives every key a driver is handed: no version
 * asked for and the ordinary statement signed, whatever the environment says. A wallet that already
 * holds an account signs in as it always did. One that holds none is refused with HTTP 428, and the
 * error says how to enrol it where the terms are shown. Any other refusal is passed on as it came.
 */
export async function walletSignIn(relay: string, identity: string, wallet: Signer, fetchImpl?: typeof fetch): ReturnType<typeof mintBearer> {
  // Loaded only when a headless sign-in is asked for, as it was before this was a function.
  const { mintBearer: mint } = await import('../../../applications/shared-workspace/tools/live-identity.js');
  try {
    return await mint(relay, identity, wallet, 'Interego Live Demo', fetchImpl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith('SIWE verify answered HTTP 428:')) throw e;
    throw new Error(`${msg} (the DEMO_YOU_WALLET key has no account yet, and this headless sign-in never gives the Hosted Terms agreement for it. `
      + `To enrol it, run the demo once without DEMO_YOU_WALLET; on the relay's sign-in page it opens, which shows the terms, sign in `
      + `with this key in a browser wallet and tick the agreement, only if you agree to the terms for its account)`, { cause: e });
  }
}
