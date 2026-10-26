/**
 * Which accounts hold a credential: a passkey credential id, a wallet address, or a DID.
 *
 * The indexes this replaces mapped each credential to ONE account, and whichever account was
 * loaded last won. A passkey credential id is not secret (POST /challenges lists an account's
 * ids to anyone who names it), and a software authenticator registers any id with its own
 * key. So while a victim's account was not loaded (after a deploy, a pod unreadable at boot),
 * anyone could register the victim's id on an account of their own; from then on every load
 * order and every refresh re-pointed the id, and the victim's sign-ins failed on and off for
 * good. A did:web that another account bound with a key of its own did the same.
 *
 * Here a credential maps to every account that lists it. A sign-in tries them in a stable
 * order and the first whose record verifies the proof wins, so a holder with a key of its own
 * can neither take nor block another's sign-in. Passkeys and DIDs that are not did:keys rank
 * earliest-enrolled first:
 *   - A passkey is registered with 'none' attestation, so its public key is whatever the
 *     registrant sends, and a public key is not secret: someone can register a copy of the
 *     owner's key under the owner's id, and the owner's signature then verifies on both
 *     accounts. The owner's account enrolled first, so it is tried first.
 *   - A DID that is not a did:key is bound only with a key that signed the server's nonce, so
 *     only the key's holder can bind it with that key, and another account lists it with a key
 *     of its own, which never verifies the owner's signature. Ranking by enrolment keeps the
 *     owner among the first MAX_HOLDERS tried however many such bindings pile up; accounts
 *     listing it with the same key were all bound by that key's holder, and are tried in the
 *     same order every time.
 * Ties, wallets and did:keys go to the preferred account (the one derived from the
 * credential), then by id. What a sign-in does with several wallet holders is the server's
 * choice (walletAccount in server.ts): this module only orders them.
 *
 * The order ranks the accounts the server has loaded, and only those. A copy enrolled while
 * the owner's account was not loaded is the only holder a sign-in finds until that account
 * loads, so the server opens no account and registers no passkey for a credential no loaded
 * account holds while any account is still unloaded (refuseWhileLoading in server.ts). That
 * stops new second holders only. Two kinds remain (AUTH-ARCHITECTURE.md, While accounts are
 * loading). Those that already exist: a passkey copy registered before that check, a wallet
 * linked before /wallet/link needed the server's nonce, and the account derived from a wallet
 * or did:key that its first sign-in opened before that check while the account listing it was
 * not loaded. A passkey, wallet or did:key sign-in loads the account derived from the
 * credential before it picks another holder, but finds the others without their owner during
 * every startup scan and while the owner's pod is unreadable; and a derived account opened
 * beside the owner's keeps the wallet's or did:key's sign-ins even once both are loaded, since
 * the server prefers it. And what the other instance writes while a deploy overlaps the two
 * after this one has read the pods (an account it opens, a credential it adds to an account
 * this one loaded), unseen here until something reads that account again or the next restart.
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
