/**
 * Whether this bridge takes a session's token: the one the profile, its learner record and My
 * activity are read with.
 *
 * A roster identity's token is signed by its demo wallet, which is derived from the public demo
 * seed. A bridge that keeps those wallets out of its directory, as the deployed one does since
 * anyone could sign as them, answers each of those pages 401 ("not in tenant directory"). A roster
 * identity signed in there landed on a page of refusals. What it signs is still its own: Learn,
 * Author, Work and My forwarding sign each request. So a session whose token the bridge refuses is
 * treated as one that signs only: it lands on Learn, is not offered the pages it cannot read, and
 * those pages say why.
 *
 * The bridge is asked once per session, of the session's own profile: the one read with the token
 * that every session is entitled to.
 */
import { signsOnly, type FoxxiSession } from './session.js';

/** Asked, then known. `unknown` when the answer says neither: the bridge unreachable, or erring. */
export type TokenStanding = 'asking' | 'taken' | 'refused' | 'unknown';

/** What the bridge's answer to the session's own profile says of its token: refused only on a 401. */
export function tokenStandingOf(status: number): Exclude<TokenStanding, 'asking'> {
  if (status === 401) return 'refused';
  return status >= 200 && status < 300 ? 'taken' : 'unknown';
}

/** Why a session acts through signed requests alone, if it does: no directory knows its key, or this bridge refuses its token. */
export type SignsAloneBecause = 'no-directory' | 'token-refused';

/** Whether a session acts through signed requests alone on this bridge, and why; null when it reads with its token too. */
export function signsAloneBecause(s: Partial<FoxxiSession>, standing: TokenStanding): SignsAloneBecause | null {
  if (signsOnly(s)) return 'no-directory';
  return standing === 'refused' ? 'token-refused' : null;
}

/** Whether where the session lands is known: at once for one that signs only, and for a roster session once the bridge has answered. */
export function standingSettled(s: Partial<FoxxiSession>, standing: TokenStanding): boolean {
  return signsOnly(s) || standing !== 'asking';
}
