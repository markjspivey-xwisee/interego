/**
 * Which account a wallet or a DID belongs to, decided by one request at a time.
 *
 * A wallet or DID sign-in decides from this server's sign-in indexes which account holds the
 * credential, and when none does its first-time path opens the account derived from it (under
 * that account's own lock). A request that puts the credential on an account (a bearer adding it
 * through /auth/siwe or /auth/did, /wallet/link, a first sign-in) changes those indexes only once
 * the pod has the write (auth-methods-writer.ts), about 2.5 s on CSS. Two things followed:
 *   - a sign-in decided while such a write was in flight found no holder, and opened the derived
 *     account beside the account the credential was being added to. The derived account is
 *     preferred where several hold a wallet or a did:key, so it kept the credential's sign-ins
 *     for good;
 *   - a write whose outcome stayed unknown (the pod did not confirm it, and could not be read
 *     after it) left the indexes without the credential until something read that account, and
 *     a sign-in with the credential reads only the accounts the indexes name. It opened the
 *     derived account the same way.
 *
 * So, in this process:
 *   - a request that decides which account holds a credential, and writes it onto one, does so
 *     in that credential's turn (`decide`), and holds the turn until its write has been
 *     installed or has failed. Decisions about one credential run one at a time, each after the
 *     writes of the ones before it; other credentials do not wait;
 *   - a write of the credential whose outcome stayed unknown (an add, a link, a claim, a first
 *     sign-in or a removal) is recorded against the account it was for (`unconfirmed`, called
 *     inside the turn, with the condition a write the pod never answered was sent on), and the
 *     credential's next turn reads that account from its pod (`readAccount`, which settles such a
 *     write first, so that it can no longer land after the read, and makes what it read this
 *     server's copy and indexes) before anything is decided. While the account cannot be read or
 *     settled, the turn decides nothing ('unreadable') and the record stays.
 *   - a record is not kept for good: `settleRecorded` gives each recorded credential an empty
 *     turn, one after another, which settles its account as its next request would and drops the
 *     record once that worked. server.ts starts a pass at most once a minute, and not while one
 *     is running, so on pods that do not answer a pass takes about one read timeout per record,
 *     and a record is visited once per pass rather than once a minute. A credential that never
 *     comes back (a throwaway wallet whose first sign-in met a failing pod) is dropped that way.
 *     At most `maxRecorded` are held at once: past that, `unconfirmed` records nothing and says
 *     so (false), and the caller's answer is the same 503 without the guarantee for that
 *     credential.
 * A turn waits at most `waitMs` for the turns before it ('busy'), then decides nothing; the
 * turns after it still wait for the one that holds the turn. A turn is not re-entrant: a request
 * takes one credential's turn once. Process-local, as the account lock is: another instance
 * writing the same pods (a deploy's overlap) is not covered.
 *
 * No server state and no I/O of its own: the read is injected, so the contract is tested without
 * starting server.ts (tests/credential-decisions.test.ts).
 */

export interface CredentialDecisionDeps {
  /**
   * Read the account's record from its pod now, and make it this server's copy and indexes.
   * `pending`: what `unconfirmed` was given with the account (the condition of a write the pod
   * never answered, which the read must settle first). Throws when the pod cannot be read, or
   * that write cannot be settled.
   */
  readAccount(userId: string, pending: unknown): Promise<unknown>;
  /** How long a turn waits for the turns before it. */
  waitMs: number;
  /** At most this many unconfirmed writes are recorded at once (default 10,000). */
  maxRecorded?: number;
}

export type Turn<T> =
  | { readonly kind: 'decided'; readonly value: T }
  /** The turns before it did not finish within waitMs. */
  | { readonly kind: 'busy' }
  /**
   * An earlier write of the credential to `userId` is unconfirmed, and that account could not be
   * read, or the write not settled (`reason`: the error readAccount threw).
   */
  | { readonly kind: 'unreadable'; readonly userId: string; readonly reason: string };

export interface CredentialDecisions {
  /** Run `decide` in the credential's turn, once any unconfirmed write of it has been read. */
  decide<T>(credential: string, decide: () => Promise<T>): Promise<Turn<T>>;
  /**
   * A write of `credential` on `userId` (putting it there, or removing it) failed, and whether the
   * pod took it is not known: the credential's next turn reads `userId` first (passing `pending`
   * to readAccount). Called inside the credential's turn. False when `maxRecorded` writes are
   * recorded already: nothing is recorded then.
   */
  unconfirmed(credential: string, userId: string, pending?: unknown): boolean;
  /** The account an unconfirmed write of the credential was for, if one is recorded. */
  unconfirmedFor(credential: string): string | undefined;
  /**
   * Settle every recorded write now, one credential at a time, each in its own turn (as its next
   * request would): a record whose account was read is dropped; one whose account still cannot
   * be read, or whose turn is busy, stays. Returns how many are left. One at a time, so a pass
   * over records whose pods do not answer takes one read timeout (or a settlement's few) each.
   */
  settleRecorded(): Promise<number>;
  /** How many unconfirmed writes are recorded. */
  recorded(): number;
  /** Credentials whose turn is held or waited for (none once every turn has finished). */
  inFlight(): number;
}

export function createCredentialDecisions(deps: CredentialDecisionDeps): CredentialDecisions {
  const turns = new Map<string, Promise<void>>();
  const unconfirmed = new Map<string, { userId: string; pending: unknown }>();
  const maxRecorded = deps.maxRecorded ?? 10_000;
  const decisions: CredentialDecisions = {
    async decide<T>(credential: string, decide: () => Promise<T>): Promise<Turn<T>> {
      const before = turns.get(credential) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>(resolve => { release = resolve; });
      // The next turn starts once the one before this has finished AND this one has: a turn that
      // gave up waiting (busy) releases at once, and the next still waits for the one before.
      const tail = before.then(() => mine);
      turns.set(credential, tail);
      const forget = () => { if (turns.get(credential) === tail) turns.delete(credential); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      try {
        started = await Promise.race([
          before.then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), deps.waitMs); }),
        ]);
        clearTimeout(timer);
        // A busy turn is forgotten only once the turn before it has finished too.
        if (!started) {
          void tail.then(forget);
          return { kind: 'busy' };
        }
        const recorded = unconfirmed.get(credential);
        if (recorded !== undefined) {
          try {
            await deps.readAccount(recorded.userId, recorded.pending);
          } catch (err) {
            return { kind: 'unreadable', userId: recorded.userId, reason: (err as Error).message };
          }
          unconfirmed.delete(credential);
        }
        return { kind: 'decided', value: await decide() };
      } finally {
        clearTimeout(timer);
        release();
        if (started) forget();
      }
    },
    unconfirmed(credential, userId, pending) {
      // A credential recorded already keeps its place; only a new one can be refused.
      if (!unconfirmed.has(credential) && unconfirmed.size >= maxRecorded) return false;
      unconfirmed.set(credential, { userId, pending });
      return true;
    },
    unconfirmedFor: credential => unconfirmed.get(credential)?.userId,
    async settleRecorded() {
      for (const credential of [...unconfirmed.keys()]) await decisions.decide(credential, async () => undefined);
      return unconfirmed.size;
    },
    recorded: () => unconfirmed.size,
    inFlight: () => turns.size,
  };
  return decisions;
}
