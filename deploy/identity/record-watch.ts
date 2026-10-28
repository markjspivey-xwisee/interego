/**
 * Whether this server's copy of an account changed while a read of it was in flight.
 *
 * Two readers of an account's record do not hold its lock for the whole read: the startup scan
 * and an on-demand load (server.ts loadAccountFromPod, which must not queue behind a slow writer),
 * and a refresh waiting for the lock (refreshAuthMethods, which reuses what a writer installed
 * meanwhile instead of reading again). Each must know whether anything installed a record for the
 * account, or marked its copy stale (a write that failed and could not be settled, so may have
 * landed), between the start of its read and its end: a load whose read was overlapped installs
 * nothing, as what was installed is newer than what it read.
 *
 * That used to be a counter per account, bumped by every install and expire and compared before
 * and after. The counter outlived the read, one entry for every account ever installed or
 * expired, including ids that never became accounts (an expire of an id with no copy at all,
 * after a first sign-in whose write nothing could settle). Here a reader watches the account only
 * while it reads (`watch`, then `done`), every change marks the account's current watchers
 * (`changed`), and nothing is kept for an account nobody is reading.
 *
 * No server state and no I/O: tested without starting server.ts (tests/record-watch.test.ts).
 */

export interface RecordWatch {
  /** Something installed or expired the account's copy since `watch` was called. */
  readonly changed: boolean;
  /** The read is over: forget this watch. */
  done(): void;
}

export interface RecordWatchers {
  /** Start watching the account, before the read begins. */
  watch(userId: string): RecordWatch;
  /** The account's copy was installed or expired: every current watcher of it sees `changed`. */
  changed(userId: string): void;
  /** Accounts with a read in flight (none once every read is done). */
  watched(): number;
}

export function createRecordWatchers(): RecordWatchers {
  const watchers = new Map<string, Set<{ changed: boolean }>>();
  return {
    watch(userId) {
      const mark = { changed: false };
      let set = watchers.get(userId);
      if (!set) watchers.set(userId, set = new Set());
      set.add(mark);
      const own = set;
      return {
        get changed() { return mark.changed; },
        done() {
          own.delete(mark);
          if (own.size === 0 && watchers.get(userId) === own) watchers.delete(userId);
        },
      };
    },
    changed(userId) {
      for (const mark of watchers.get(userId) ?? []) mark.changed = true;
    },
    watched: () => watchers.size,
  };
}
