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
 * order and the first whose record verifies the proof wins, so another holder can neither take
 * nor block the sign-in. The order is earliest-enrolled first where the binding key is the
 * registrant's choice (a passkey registered with 'none' attestation, a did:web bound with a key
 * the caller sends): such a key can be copied, since a public key is not secret, so a later
 * copy of the owner's key must not win, and the owner's account must be among those tried.
 * Ties, and the credentials bound by proof of possession (wallets, did:key), go to the
 * preferred account (the one derived from the credential), then by id.
 *
 * Pure: no server state, so it is unit-tested directly (tests/credential-index.test.ts).
 */

/** At most this many holders of one credential are tried (and their records read), in order. */
export const MAX_HOLDERS = 8;

/**
 * A credential an account holds, optionally with when it was enrolled there (ms since the
 * epoch, set by the server). A bare key ranks as enrolled at 0.
 */
export type IndexEntry = string | readonly [key: string, enrolledAt: number];

/**
 * The rank of a server-set `createdAt`. A record without one (written before the field
 * existed) ranks first: every record the server writes now carries one, so a later copy cannot
 * be made to look older.
 */
export function enrolledAt(createdAt: unknown): number {
  const t = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export class AccountIndex {
  /** key → (userId → enrolledAt) */
  private readonly byKey = new Map<string, Map<string, number>>();
  private readonly byUser = new Map<string, Set<string>>();

  /**
   * Make `entries` the credentials `userId` holds, leaving every other holder alone. Returns
   * the holder count of each key this user did not hold before and now shares with another
   * account (for the multi-holder warning), so re-indexing an unchanged account reports nothing.
   */
  setUser(userId: string, entries: Iterable<IndexEntry>): number[] {
    const next = new Map<string, number>();
    for (const entry of entries) {
      const [key, rank] = typeof entry === 'string' ? [entry, 0] : entry;
      next.set(key, Math.min(rank, next.get(key) ?? Infinity));
    }
    const previous = this.byUser.get(userId) ?? new Set<string>();
    for (const key of previous) if (!next.has(key)) this.drop(key, userId);
    const shared: number[] = [];
    for (const [key, rank] of next) {
      let holders = this.byKey.get(key);
      if (!holders) this.byKey.set(key, holders = new Map());
      holders.set(userId, rank);
      if (!previous.has(key) && holders.size > 1) shared.push(holders.size);
    }
    if (next.size) this.byUser.set(userId, new Set(next.keys()));
    else this.byUser.delete(userId);
    return shared;
  }

  removeUser(userId: string): void {
    this.setUser(userId, []);
  }

  /** Every account holding `key`: earliest enrolled first, then `preferred`, then by id. */
  candidates(key: string, preferred?: string): string[] {
    return [...(this.byKey.get(key) ?? [])]
      .sort(([a, ra], [b, rb]) => ra - rb
        || Number(b === preferred) - Number(a === preferred)
        || (a < b ? -1 : a > b ? 1 : 0))
      .map(([userId]) => userId);
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
