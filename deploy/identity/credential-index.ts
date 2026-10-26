/**
 * Which accounts hold a credential: a passkey credential id, a wallet address, or a DID.
 *
 * The indexes this replaces mapped each credential to ONE account, and whichever account was
 * loaded last won. A passkey credential id is not secret (POST /challenges lists an account's
 * ids to anyone who names it), and a software authenticator registers any id with its own
 * key. So while a victim's account was not loaded (after a deploy, a pod unreadable at boot,
 * an account on another replica), anyone could register the victim's id on an account of
 * their own; from then on every load order and every refresh re-pointed the id, and the
 * victim's sign-ins failed on and off for good. A did:web, bound with a key the caller
 * chooses, had the same problem.
 *
 * Here a credential maps to every account that lists it. A sign-in tries them in a stable
 * order (the account derived from the credential first, then by id) and the first whose
 * record verifies the proof wins, so another holder can neither take nor block the sign-in.
 *
 * Pure: no server state, so it is unit-tested directly (tests/credential-index.test.ts).
 */

/** More holders than this for one credential is refused rather than tried one by one. */
export const MAX_HOLDERS = 8;

export class AccountIndex {
  private readonly byKey = new Map<string, Set<string>>();
  private readonly byUser = new Map<string, Set<string>>();

  /**
   * Make `keys` the credentials `userId` holds, leaving every other holder alone. Returns the
   * holder count of each key this user did not hold before and now shares with another account
   * (for the multi-holder warning), so re-indexing an unchanged account reports nothing.
   */
  setUser(userId: string, keys: Iterable<string>): number[] {
    const next = new Set(keys);
    const previous = this.byUser.get(userId) ?? new Set<string>();
    for (const key of previous) if (!next.has(key)) this.drop(key, userId);
    const shared: number[] = [];
    for (const key of next) {
      if (previous.has(key)) continue;
      let holders = this.byKey.get(key);
      if (!holders) this.byKey.set(key, holders = new Set());
      holders.add(userId);
      if (holders.size > 1) shared.push(holders.size);
    }
    if (next.size) this.byUser.set(userId, next);
    else this.byUser.delete(userId);
    return shared;
  }

  removeUser(userId: string): void {
    this.setUser(userId, []);
  }

  /** Every account holding `key`: `preferred` first when it is one, then in id order. */
  candidates(key: string, preferred?: string): string[] {
    const holders = [...(this.byKey.get(key) ?? [])].sort();
    const at = preferred === undefined ? -1 : holders.indexOf(preferred);
    if (at > 0) holders.unshift(...holders.splice(at, 1));
    return holders;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** The number of distinct credentials indexed. */
  get size(): number {
    return this.byKey.size;
  }

  private drop(key: string, userId: string): void {
    const holders = this.byKey.get(key);
    if (!holders) return;
    holders.delete(userId);
    if (!holders.size) this.byKey.delete(key);
  }
}
