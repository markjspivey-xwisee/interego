/**
 * AN IDENTITY GUARD IS NOT AN ORDERING GUARD — AND NEITHER OF THEM IS A CUSTODY GUARD.
 *
 * `packages/workspace-client/src/epoch.ts` is new and has no callers yet: the desktop renderer,
 * the desktop main process and the published artifact are the named adopters, replacing the
 * guards each of them derived privately, and the Discord watcher carries the same class of site.
 * So this file is the only thing standing between those shells and whatever it gets wrong, and
 * it is written to the real interleavings the census recorded rather than to the API's surface.
 *
 * The three that matter most, and none is hypothetical:
 *
 *  · TWO FOLDS OF ONE WORKSPACE SHARE A SUBJECT. The fold that SEES a revocation is several
 *    round trips shorter than one begun before it, so the older fold routinely lands LAST and
 *    re-seats the revoked member, with watches that go on polling their pod. Measured in the
 *    desktop shell, and measured again in the artifact as an older fold restoring the roster a
 *    newer one had replaced. A subject guard passes this every time, which is why `sameSubject`
 *    is tested here for the defect it lets through as well as for the use it is right for.
 *
 *  · A CLEAR-THEN-AWAIT-THEN-COMMIT THAT THROWS leaves the process cleared with nothing to put
 *    the state back. The desktop's `adopt` does exactly this: a failed mid-switch sign-in
 *    disarms sealing permanently while the session panel still advertises the outgoing account
 *    as live.
 *
 *  · ★ A RUN THAT OVERTOOK THE HANDOVER AND OWNS NOTHING. The first version of this file
 *    suppressed the restore AND the commit whenever a newer ATTEMPT existed — and the desktop's
 *    renewal timer, firing during a slow sign-in, is a newer attempt that cleared nothing. Every
 *    handover test in that version overtook with `bumpSubject()`; not one overtook with a plain
 *    `begin()`, so two mutants that reduced both of its handover guards to the identity guard
 *    passed 30/30. The whole `a plain begin() cannot take custody` block below exists because of
 *    that, and the `between subjects` block exists because the other half of the same hole is a
 *    run that begins DURING a handover and lands after it.
 *
 * ★ IMPORTED THROUGH THE PACKAGE ENTRY, NOT THE SOURCE FILE, so this also pins the index export
 * — the artifact's generated bundle and the desktop's `import` both come through it, and an
 * implementation nobody can reach is not shared. That means the suite runs `dist`: after
 * editing `packages/workspace-client/src/epoch.ts`, `npm run build --workspace
 * @interego/workspace-client` or this file measures the previous build.
 */

import { describe, it, expect } from 'vitest';
import {
  EpochCounter, guarded, handover, Overtaken, isOvertaken, isRestoreFailed, RestoreFailed,
  type Epoch,
} from '@interego/workspace-client';

/** A promise the test resolves by hand, so an interleaving is stated rather than timed. */
function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The account state a desktop sign-in hands over, small enough to assert on whole. */
interface Account { bearer: string; sealKey: string | null }

const CLEARED: Account = { bearer: '', sealKey: null };

describe('the two axes', () => {
  it('a fresh attempt is current on both axes', () => {
    const ep = new EpochCounter();
    const e = ep.begin();
    expect(ep.current(e)).toBe(true);
    expect(ep.sameSubject(e)).toBe(true);
  });

  it('★ a later attempt at the SAME subject supersedes: sameSubject still passes, current does not', () => {
    // This one assertion is the whole finding. `S.wsGen` in the desktop shell and `S.wsGen` in
    // the artifact both answer the first question; only the second one distinguishes the fold
    // that saw a revocation from the one that did not.
    const ep = new EpochCounter();
    const older = ep.begin();
    const newer = ep.begin();
    expect(ep.sameSubject(older)).toBe(true);
    expect(ep.current(older)).toBe(false);
    expect(ep.current(newer)).toBe(true);
  });

  it('bumpSubject invalidates outstanding attempts on both axes', () => {
    const ep = new EpochCounter();
    const e = ep.begin();
    ep.bumpSubject();
    expect(ep.sameSubject(e)).toBe(false);
    expect(ep.current(e)).toBe(false);
  });

  it('between a bumpSubject and the next begin, no epoch is current', () => {
    const ep = new EpochCounter();
    const first = ep.begin();
    const second = ep.begin();
    ep.bumpSubject();
    expect(ep.current(first)).toBe(false);
    expect(ep.current(second)).toBe(false);
    // And the next attempt at the new subject is current, without the old ones coming back.
    const third = ep.begin();
    expect(ep.current(third)).toBe(true);
    expect(ep.current(second)).toBe(false);
  });

  it('attempt numbers are monotonic across a subject change, so none is ever reused', () => {
    const ep = new EpochCounter();
    const a = ep.begin();
    ep.bumpSubject();
    const b = ep.begin();
    expect(b.subject).toBeGreaterThan(a.subject);
    expect(b.attempt).toBeGreaterThan(a.attempt);
  });

  it('an Epoch is frozen, and carries nothing but its two numbers to a reader', () => {
    const ep = new EpochCounter();
    const e = ep.begin();
    expect(Object.isFrozen(e)).toBe(true);
    // The owner tag is symbol-keyed and non-enumerable; the docblock says it is invisible to
    // every consumer and to `JSON.stringify`, so that claim is checked rather than asserted.
    expect(JSON.parse(JSON.stringify(e))).toEqual({ subject: e.subject, attempt: e.attempt });
    expect(Object.keys(e)).toEqual(['subject', 'attempt']);
  });

  it('★ a counter refuses an Epoch minted by a different counter', () => {
    // renderer.ts is about to hold two of these (workspace and account); their numbers agree by
    // coincidence for as long as the two subjects change together, and then stop.
    const workspaces = new EpochCounter();
    const accounts = new EpochCounter();
    const e = workspaces.begin();
    expect(() => accounts.current(e)).toThrow(/different EpochCounter/);
    expect(() => accounts.sameSubject(e)).toThrow(/different EpochCounter/);
    expect(workspaces.current(e)).toBe(true);
  });

  it('a hand-built Epoch carries no owner and is accepted', () => {
    const ep = new EpochCounter();
    const real = ep.begin();
    const copy: Epoch = { subject: real.subject, attempt: real.attempt };
    expect(ep.current(copy)).toBe(true);
  });
});

describe('asOf — a stamp that supersedes nothing', () => {
  /**
   * ★ THE CENSUS HAS SITES THAT CANNOT BE WRITTEN WITHOUT THIS. `substrate:call`'s 401 recovery
   * (main.ts:1053) re-issues the SAME call after `await renew(...)` and has to refuse if a
   * sign-out or a second `adopt` landed in between — but it runs once per IPC call, and a
   * `begin()` there would cancel the account's renewal guard and boot's in-flight loads on
   * every read the renderer makes. `watch.ts:274` is the same shape.
   */
  it('is current now, and cancels nothing that is already running', async () => {
    const ep = new EpochCounter();
    const running = ep.begin();
    const taken = ep.asOf();
    expect(ep.current(taken)).toBe(true);
    // ★ The run that WAS current still is: a stamp is not an attempt.
    expect(ep.current(running)).toBe(true);
    const landed = await guarded(ep, running, async () => 'v', () => undefined);
    expect(landed).toBe(true);
  });

  it('★ the 401 retry refuses when a sign-out landed inside the renewal', async () => {
    const ep = new EpochCounter();
    let clientCalls = '';
    const renewing = defer<void>();

    const call = async (): Promise<string> => {
      const e = ep.asOf();
      await renewing.promise;              // await renew('the relay rejected the session token')
      if (!ep.current(e)) return 'refused';
      clientCalls += 'retry;';
      return 'retried';
    };
    const p = call();
    ep.bumpSubject();                      // auth:signout, mid-renewal
    renewing.resolve();
    expect(await p).toBe('refused');
    expect(clientCalls).toBe('');
  });

  it('a newer attempt supersedes one of these, on the attempt axis as well as the subject', () => {
    const ep = new EpochCounter();
    const taken = ep.asOf();
    ep.begin();
    expect(ep.current(taken)).toBe(false);
    expect(ep.sameSubject(taken)).toBe(true);
  });

  it('is a between-subjects stamp while a handover holds custody', async () => {
    const ep = new EpochCounter();
    let taken: Epoch | null = null;
    await handover<null, string>(ep, {
      snapshot: () => null,
      clear: () => undefined,
      work: async () => { taken = ep.asOf(); return 'v'; },
      commit: () => undefined,
      restore: () => undefined,
    });
    expect(taken).toEqual({ subject: -1, attempt: -1 });
    expect(ep.current(taken as unknown as Epoch)).toBe(false);
  });
});

describe('guarded', () => {
  it('★ the slow fold that saw no revocation does not land on top of the fast one that did', async () => {
    const ep = new EpochCounter();
    // The roster as the window holds it. `bo` has just been revoked on the convener's pod.
    let roster: readonly string[] = ['ann', 'bo'];

    const slow = defer<readonly string[]>();
    const fast = defer<readonly string[]>();

    // Begun BEFORE the revocation landed, and long: it reads every grantee's pod.
    const eSlow = ep.begin();
    const pSlow = guarded(ep, eSlow, () => slow.promise, (v) => { roster = v; });

    // Begun AFTER it, and short: `foldRoster` short-circuits a revoked grant before it reads
    // the grantee's pod at all, so this one is several round trips cheaper.
    const eFast = ep.begin();
    const pFast = guarded(ep, eFast, () => fast.promise, (v) => { roster = v; });

    fast.resolve(['ann']);
    expect(await pFast).toBe(true);
    expect(roster).toEqual(['ann']);

    slow.resolve(['ann', 'bo']);
    expect(await pSlow).toBe(false);
    // ★ `bo` is not re-seated, so nothing re-folds their log or re-registers a watch on their pod.
    expect(roster).toEqual(['ann']);
  });

  it('★ and the same interleaving under a subject-only guard re-seats the revoked member', async () => {
    /**
     * The counterfactual, written out the way a shell writes it — this is what `S.wsGen` alone
     * does, and it is why `sameSubject` is a named method rather than what `current` means.
     * If this test ever passes with `['ann']`, the weaker guard has quietly become the stronger
     * one and the distinction this file exists for has been lost.
     */
    const ep = new EpochCounter();
    let roster: readonly string[] = ['ann', 'bo'];
    const subjectOnly = async (e: Epoch, read: () => Promise<readonly string[]>): Promise<boolean> => {
      const v = await read();
      if (!ep.sameSubject(e)) return false;
      roster = v;
      return true;
    };

    const slow = defer<readonly string[]>();
    const fast = defer<readonly string[]>();
    const pSlow = subjectOnly(ep.begin(), () => slow.promise);
    const pFast = subjectOnly(ep.begin(), () => fast.promise);

    fast.resolve(['ann']);
    expect(await pFast).toBe(true);
    slow.resolve(['ann', 'bo']);
    expect(await pSlow).toBe(true);
    expect(roster).toEqual(['ann', 'bo']);
  });

  it('drops a run whose subject changed mid-read', async () => {
    const ep = new EpochCounter();
    let committed = false;
    const gate = defer<number>();
    const p = guarded(ep, ep.begin(), () => gate.promise, () => { committed = true; });
    ep.bumpSubject();
    gate.resolve(1);
    expect(await p).toBe(false);
    expect(committed).toBe(false);
  });

  it('does not even start the read when the run is already stale', async () => {
    const ep = new EpochCounter();
    const e = ep.begin();
    ep.bumpSubject();
    let started = false;
    const ok = await guarded(
      ep, e,
      async () => { started = true; return 1; },
      () => { throw new Error('a stale run must not commit'); },
    );
    expect(ok).toBe(false);
    expect(started).toBe(false);
  });

  it('the run is still current at the moment commit runs, not merely at the check', async () => {
    const ep = new EpochCounter();
    const e = ep.begin();
    let currentInsideCommit: boolean | null = null;
    const ok = await guarded(ep, e, async () => 'v', () => { currentInsideCommit = ep.current(e); });
    expect(ok).toBe(true);
    expect(currentInsideCommit).toBe(true);
  });

  it('propagates a read error and commits nothing', async () => {
    const ep = new EpochCounter();
    let committed = false;
    await expect(guarded(
      ep, ep.begin(),
      async () => { throw new Error('the convener pod did not answer'); },
      () => { committed = true; },
    )).rejects.toThrow('the convener pod did not answer');
    expect(committed).toBe(false);
  });

  it('★ refuses an async commit BEFORE the read, and never calls it', async () => {
    /**
     * The refusal has to happen before the callback runs, not on the promise it returns: a
     * callback refused after the fact has already run its synchronous prefix and the rest of it
     * is still queued. Here the read must not even be attempted.
     */
    const ep = new EpochCounter();
    let landed = '';
    let read = false;
    await expect(guarded(
      ep, ep.begin(),
      async () => { read = true; return 'v'; },
      // Assignable to `(v: string) => void` with no error: TypeScript's void-return
      // assignability is the hole, and this runtime refusal is what closes it.
      async (v: string) => { landed = v; await Promise.resolve(); },
    )).rejects.toThrow(/must be synchronous/);
    expect(landed).toBe('');
    expect(read).toBe(false);
  });

  it('refuses a commit that merely returns a promise, and says the prefix already ran', async () => {
    // The residue the up-front check cannot see: not declared `async`, so it is caught only on
    // the way out, and the message must not pretend the callback was stopped.
    const ep = new EpochCounter();
    let landed = '';
    await expect(guarded(
      ep, ep.begin(),
      async () => 'v',
      (v: string) => { landed = v; return Promise.resolve() as unknown as void; },
    )).rejects.toThrow(/still runs to completion on its own/);
    expect(landed).toBe('v');
  });

  it('a nested begin() supersedes the run that started it', async () => {
    // Why a helper called from inside an attempt takes the caller's Epoch instead of minting
    // one: `openWorkspace` fires `loadCanvas` without awaiting it.
    const ep = new EpochCounter();
    const outer = ep.begin();
    let committed = false;
    const ok = await guarded(ep, outer, async () => { ep.begin(); return 1; }, () => { committed = true; });
    expect(ok).toBe(false);
    expect(committed).toBe(false);
  });

  it('independent reads at one subject all land, when the caller says sameSubject', async () => {
    /**
     * Pattern 2 in the header: one entry body per descriptor URL. These must not supersede each
     * other, so they share ONE Epoch and ask the weaker question. Calling `begin()` per body
     * would cancel the previous 29 and the fold they run under.
     */
    const ep = new EpochCounter();
    const e = ep.begin();
    const bodies = new Map<string, string>();
    const fetchBody = async (url: string): Promise<void> => {
      const body = await Promise.resolve('body of ' + url);
      if (!ep.sameSubject(e)) return;
      bodies.set(url, body);
    };
    await Promise.all(['a', 'b', 'c'].map(fetchBody));
    expect([...bodies.keys()]).toEqual(['a', 'b', 'c']);

    // And a teardown between the queueing and the landing drops the rest.
    ep.bumpSubject();
    await fetchBody('d');
    expect(bodies.has('d')).toBe(false);
  });

  it('per-key counters do not supersede each other', async () => {
    /**
     * Pattern 3: the Discord watcher refreshes candidates per THREAD, and two refreshes of one
     * thread must supersede while two threads must not. One counter per key, not one counter
     * with cleverness in it.
     */
    const counters = new Map<string, EpochCounter>();
    const forKey = (k: string): EpochCounter => {
      const found = counters.get(k) ?? new EpochCounter();
      counters.set(k, found);
      return found;
    };
    const snapshots = new Map<string, string>();
    const refresh = (k: string, gate: Promise<string>): Promise<boolean> => {
      const ep = forKey(k);
      return guarded(ep, ep.begin(), () => gate, (v) => { snapshots.set(k, v); });
    };

    const t1 = defer<string>();
    const t2 = defer<string>();
    const p1 = refresh('thread-1', t1.promise);
    const p2 = refresh('thread-2', t2.promise);
    t2.resolve('two');
    t1.resolve('one');
    expect(await p2).toBe(true);
    expect(await p1).toBe(true);
    expect(snapshots.get('thread-1')).toBe('one');
    expect(snapshots.get('thread-2')).toBe('two');

    // Two of the SAME thread still supersede.
    const older = defer<string>();
    const newer = defer<string>();
    const pOlder = refresh('thread-1', older.promise);
    const pNewer = refresh('thread-1', newer.promise);
    newer.resolve('fresh');
    expect(await pNewer).toBe(true);
    older.resolve('stale');
    expect(await pOlder).toBe(false);
    expect(snapshots.get('thread-1')).toBe('fresh');
  });
});

describe('handover', () => {
  it('snapshots before it clears, clears before it awaits, and commits at the end', async () => {
    const ep = new EpochCounter();
    let state: Account = { bearer: 'A', sealKey: 'key-A' };
    const order: string[] = [];
    let clearedDuringWork: Account | null = null;

    const out = await handover<Account, Account>(ep, {
      snapshot: () => { order.push('snapshot'); return state; },
      clear: () => { order.push('clear'); state = { ...CLEARED }; },
      work: async () => {
        order.push('work');
        clearedDuringWork = state;
        await Promise.resolve();
        return { bearer: 'B', sealKey: 'key-B' };
      },
      commit: (v) => { order.push('commit'); state = v; },
      restore: () => { order.push('restore'); },
    });

    expect(order).toEqual(['snapshot', 'clear', 'work', 'commit']);
    // ★ The process is between identities for the whole of `work`, which is what stops
    // `substrate:seal` answering with the outgoing account's key on the way through.
    expect(clearedDuringWork).toEqual(CLEARED);
    expect(state).toEqual({ bearer: 'B', sealKey: 'key-B' });
    expect(out).toEqual({ bearer: 'B', sealKey: 'key-B' });
  });

  it('★ restores the cleared state when work throws — the failed mid-switch sign-in', async () => {
    const ep = new EpochCounter();
    let state: Account = { bearer: 'A', sealKey: 'key-A' };
    await expect(handover<Account, Account>(ep, {
      snapshot: () => state,
      clear: () => { state = { ...CLEARED }; },
      work: async () => { throw new Error('get_pod_status answered without a pod URL'); },
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    })).rejects.toThrow('get_pod_status answered without a pod URL');
    // ★ Without this, sealing is disarmed for the life of the process while the session panel
    // still advertises the outgoing account as live. Reproduced twice before this existed.
    expect(state).toEqual({ bearer: 'A', sealKey: 'key-A' });
  });

  it('★ does NOT restore when a newer handover has taken over', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    const restored: string[] = [];
    const gate = defer<void>();

    const outer = handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { await gate.promise; throw new Error('outer sign-in failed'); },
      commit: (v) => { state = v; },
      restore: (s) => { restored.push(s); state = s; },
    });

    // A second sign-in starts and finishes while the first is still awaiting.
    await handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => 'B',
      commit: (v) => { state = v; },
      restore: () => { throw new Error('the inner handover had nothing to restore'); },
    });
    expect(state).toBe('B');

    gate.resolve();
    await expect(outer).rejects.toThrow('outer sign-in failed');
    // ★ Restoring here would hand the live account the departed one's bearer and keys.
    expect(restored).toEqual([]);
    expect(state).toBe('B');
  });

  it('★ an overtaken handover that SUCCEEDS throws Overtaken, and commits and restores nothing', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    const gate = defer<void>();
    let restoreCalled = false;

    const outer = handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { await gate.promise; return 'A2'; },
      commit: (v) => { state = v; },
      restore: () => { restoreCalled = true; },
    });

    ep.bumpSubject();
    gate.resolve();

    let caught: unknown;
    try { await outer; } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Overtaken);
    expect(isOvertaken(caught)).toBe(true);
    expect(isOvertaken(new Error('plain'))).toBe(false);
    // Neither committed nor restored: whoever bumped the subject is writing the state itself.
    expect(state).toBe('');
    expect(restoreCalled).toBe(false);
  });

  it('★ Overtaken carries what work produced, so a live transport can be closed', async () => {
    /**
     * `adopt`'s work builds a CONNECTED WorkspaceClient on a RelayMcpTransport and
     * `delegateSession`'s opens a loopback HTTP receiver. Dropped on the floor, neither is
     * reachable and neither closes itself.
     */
    const ep = new EpochCounter();
    const closed: string[] = [];
    const gate = defer<void>();
    const p = handover<null, { name: string; close: () => void }>(ep, {
      snapshot: () => null,
      clear: () => undefined,
      work: async () => { await gate.promise; return { name: 'transport-B', close: () => closed.push('transport-B') }; },
      commit: () => { throw new Error('an overtaken handover must not commit'); },
      restore: () => undefined,
    });
    ep.bumpSubject();
    gate.resolve();

    let caught: unknown;
    try { await p; } catch (e) { caught = e; }
    expect(isOvertaken(caught)).toBe(true);
    const leaked = (caught as Overtaken).value as { name: string; close: () => void };
    expect(leaked.name).toBe('transport-B');
    leaked.close();
    expect(closed).toEqual(['transport-B']);
  });

  it('bumps the subject itself, so a run begun before it is invalidated', async () => {
    const ep = new EpochCounter();
    const before = ep.begin();
    await handover<null, string>(ep, {
      snapshot: () => null,
      clear: () => undefined,
      work: async () => 'v',
      commit: () => undefined,
      restore: () => undefined,
    });
    expect(ep.sameSubject(before)).toBe(false);
    expect(ep.current(before)).toBe(false);
  });

  it('hands work, commit and restore the same epoch', async () => {
    const ep = new EpochCounter();
    let seenInWork: Epoch | null = null;
    let seenInCommit: Epoch | null = null;
    await handover<null, string>(ep, {
      snapshot: () => null,
      clear: () => undefined,
      work: async (e) => { seenInWork = e; return 'v'; },
      commit: (_v, e) => { seenInCommit = e; },
      restore: () => undefined,
    });
    expect(seenInWork).not.toBeNull();
    expect(seenInCommit).toBe(seenInWork);
  });

  it('★ a closure installed during a handover refuses to write after a later one — the re-authorizer', async () => {
    /**
     * A 401 on a call still travelling through account A's transport, resolving after a switch
     * to B, overwrote B's bearer with A's freshly minted credential — and the process went on
     * making relay calls as A under a session panel that said B. The closure wants the weaker
     * question ("is this still the account I was installed for"), which is why `work` is handed
     * the Epoch: a closure that called `begin()` to get one would supersede its own handover.
     */
    const ep = new EpochCounter();
    let bearer = 'A';
    let reauthorize: () => void = () => { throw new Error('the re-authorizer was never installed'); };

    await handover<string, string>(ep, {
      snapshot: () => bearer,
      clear: () => { bearer = ''; },
      work: async (e) => {
        reauthorize = (): void => { if (ep.sameSubject(e)) bearer = 'A-refreshed'; };
        return 'A2';
      },
      commit: (v) => { bearer = v; },
      restore: (s) => { bearer = s; },
    });
    expect(bearer).toBe('A2');

    // Same account, a later attempt: the re-authorizer is still the right one to answer.
    reauthorize();
    expect(bearer).toBe('A-refreshed');

    await handover<string, string>(ep, {
      snapshot: () => bearer,
      clear: () => { bearer = ''; },
      work: async () => 'B',
      commit: (v) => { bearer = v; },
      restore: (s) => { bearer = s; },
    });
    expect(bearer).toBe('B');

    reauthorize();
    expect(bearer).toBe('B');
  });

  it('a clear that throws puts the state back and propagates', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    await expect(handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; throw new Error('the encryption pair would not drop'); },
      work: async () => 'B',
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    })).rejects.toThrow('the encryption pair would not drop');
    expect(state).toBe('A');
  });

  it('a throw from commit propagates and does not restore over the half-committed state', async () => {
    const ep = new EpochCounter();
    let restoreCalled = false;
    await expect(handover<string, string>(ep, {
      snapshot: () => 'A',
      clear: () => undefined,
      work: async () => 'B',
      commit: () => { throw new Error('setSession refused'); },
      restore: () => { restoreCalled = true; },
    })).rejects.toThrow('setSession refused');
    expect(restoreCalled).toBe(false);
  });
});

describe('a plain begin() cannot take custody', () => {
  /**
   * ★ THE REFUTED CASE, BOTH PATHS. `adopt` is a handover on the account counter; `renew` is
   * pattern 1 on the SAME counter, and the outgoing account's renewal timer is still armed
   * during a slow sign-in because `adopt` never disarms it (census main.ts:741). Under a guard
   * that asks "am I still the newest attempt", the renewal takes the answer away from the
   * sign-in — and it cleared nothing, so nothing puts the account back.
   */
  it('★ the renewal timer firing mid-sign-in does not stop the failed sign-in restoring', async () => {
    const ep = new EpochCounter();
    let state: Account = { bearer: 'A', sealKey: 'key-A' };
    const restored: Account[] = [];
    const signIn = defer<void>();

    const adopt = handover<Account, Account>(ep, {
      snapshot: () => ({ ...state }),
      clear: () => { state = { ...CLEARED }; },
      work: async () => { await signIn.promise; throw new Error('get_pod_status answered without a pod URL'); },
      commit: (v) => { state = v; },
      restore: (s) => { restored.push(s); state = s; },
    });

    // renew(): pattern 1, `begin()` once at the top, on the same counter.
    const eRenew = ep.begin();
    expect(await guarded(ep, eRenew, async () => 'renewed-A', (v) => { state = { ...state, bearer: v }; }))
      .toBe(false);

    signIn.resolve();
    await expect(adopt).rejects.toThrow('get_pod_status answered without a pod URL');

    // ★ Sealing is NOT disarmed for the life of the process, and the renewal did not write into
    // the gap either.
    expect(restored).toEqual([{ bearer: 'A', sealKey: 'key-A' }]);
    expect(state).toEqual({ bearer: 'A', sealKey: 'key-A' });
  });

  it('★ and a successful sign-in still commits after one', async () => {
    const ep = new EpochCounter();
    let state: Account = { bearer: 'A', sealKey: 'key-A' };
    let restoreCalled = false;
    const signIn = defer<void>();

    const adopt = handover<Account, Account>(ep, {
      snapshot: () => ({ ...state }),
      clear: () => { state = { ...CLEARED }; },
      work: async () => { await signIn.promise; return { bearer: 'B', sealKey: 'key-B' }; },
      commit: (v) => { state = v; },
      restore: () => { restoreCalled = true; },
    });

    const eRenew = ep.begin();
    await guarded(ep, eRenew, async () => 'renewed-A', (v) => { state = { ...state, bearer: v }; });

    signIn.resolve();
    await expect(adopt).resolves.toEqual({ bearer: 'B', sealKey: 'key-B' });
    expect(state).toEqual({ bearer: 'B', sealKey: 'key-B' });
    expect(restoreCalled).toBe(false);
  });

  it('★ a nested begin() inside work does not supersede the handover that is running', async () => {
    // The same shape one level in: `work` calling a helper that mints its own attempt.
    const ep = new EpochCounter();
    let state = 'A';
    const committed = await handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { ep.begin(); ep.begin(); return 'B'; },
      commit: (v) => { state = v; },
      restore: () => { throw new Error('nothing failed here'); },
    });
    expect(committed).toBe('B');
    expect(state).toBe('B');
  });

  it('★ the handover epoch is usable for guarded runs once it has committed', async () => {
    /**
     * `adopt` calls `scheduleRenewal()` from inside its commit, and the timer that fires later
     * has to guard its write with something. The only Epoch in scope is the one `commit` was
     * handed, so it has to still work — including after a stray attempt began mid-handover.
     */
    const ep = new EpochCounter();
    let bearer = 'A';
    let armed: Epoch | null = null;
    const gate = defer<void>();

    const adopt = handover<string, string>(ep, {
      snapshot: () => bearer,
      clear: () => { bearer = ''; },
      work: async () => { await gate.promise; return 'B'; },
      commit: (v, e) => { bearer = v; armed = e; },
      restore: () => undefined,
    });
    ep.begin();
    gate.resolve();
    await adopt;

    expect(armed).not.toBeNull();
    expect(ep.current(armed as unknown as Epoch)).toBe(true);
    expect(await guarded(ep, armed as unknown as Epoch, async () => 'B-renewed', (v) => { bearer = v; })).toBe(true);
    expect(bearer).toBe('B-renewed');
  });
});

describe('between subjects', () => {
  /**
   * The other half of the same hole: a run that BEGINS while the state is cleared. It read a
   * cleared world, so it must not land — not during the handover and not after it, whichever
   * way the handover ends.
   */
  it('★ nothing is current while a handover holds custody, the custodian included', async () => {
    const ep = new EpochCounter();
    const beforeAll = ep.begin();
    const gate = defer<void>();
    let insideWork: { current: boolean; sameSubject: boolean; handingOver: boolean } | null = null;
    let stray: Epoch | null = null;

    expect(ep.handingOver()).toBe(false);

    const p = handover<null, string>(ep, {
      snapshot: () => null,
      clear: () => undefined,
      work: async (e) => {
        stray = ep.begin();
        insideWork = { current: ep.current(e), sameSubject: ep.sameSubject(e), handingOver: ep.handingOver() };
        await gate.promise;
        return 'v';
      },
      commit: () => undefined,
      restore: () => undefined,
    });
    await Promise.resolve();

    expect(insideWork).toEqual({ current: false, sameSubject: false, handingOver: true });
    // The run begun before the handover is not current either, and asking says why.
    expect(ep.current(beforeAll)).toBe(false);
    expect(ep.sameSubject(beforeAll)).toBe(false);
    expect(ep.handingOver()).toBe(true);

    gate.resolve();
    await p;
    expect(ep.handingOver()).toBe(false);
    // ★ And the stray stays dead after the handover settles, which is the half a wake-up-later
    // stamp would get wrong.
    expect(ep.current(stray as unknown as Epoch)).toBe(false);
    expect(ep.sameSubject(stray as unknown as Epoch)).toBe(false);
  });

  it('★ a stray stays dead even when the handover FAILS and the old state comes back', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    let stray: Epoch | null = null;
    await expect(handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { stray = ep.begin(); throw new Error('the wallet sign-in was cancelled'); },
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    })).rejects.toThrow('the wallet sign-in was cancelled');
    expect(state).toBe('A');
    expect(ep.handingOver()).toBe(false);
    expect(ep.current(stray as unknown as Epoch)).toBe(false);
    expect(ep.sameSubject(stray as unknown as Epoch)).toBe(false);
    // A stray carries the between-subjects marker rather than a plausible-looking pair.
    expect(stray).toEqual({ subject: -1, attempt: -1 });
  });

  it('a guarded run that begins during a handover is dropped without reading', async () => {
    const ep = new EpochCounter();
    const gate = defer<void>();
    let read = false;
    let ok: boolean | null = null;

    const p = handover<null, string>(ep, {
      snapshot: () => null,
      clear: () => undefined,
      work: async () => {
        ok = await guarded(ep, ep.begin(), async () => { read = true; return 1; }, () => undefined);
        await gate.promise;
        return 'v';
      },
      commit: () => undefined,
      restore: () => undefined,
    });
    gate.resolve();
    await p;
    expect(ok).toBe(false);
    expect(read).toBe(false);
  });

  it('★ a guarded write from inside work is dropped rather than landing in the gap', async () => {
    /**
     * `work` reads the relay and writes `mine` — state no other session can see. A `guarded`
     * commit is by definition a write the rest of the process CAN see, and there is nothing for
     * it to be consistent with while the state is cleared, so the handover's own stamp does not
     * carry the right to make one until the handover has settled.
     */
    const ep = new EpochCounter();
    let panel = 'A';
    let landed: boolean | null = null;
    await handover<string, string>(ep, {
      snapshot: () => panel,
      clear: () => { panel = ''; },
      work: async (e) => {
        landed = await guarded(ep, e, async () => 'a value read mid-switch', (v) => { panel = v; });
        return 'B';
      },
      commit: (v) => { panel = v; },
      restore: (s) => { panel = s; },
    });
    expect(landed).toBe(false);
    expect(panel).toBe('B');
  });

  it('★ a closure installed by THIS handover refuses to write while it is still in flight', async () => {
    /**
     * The re-authorizer is installed on the new transport DURING the sign-in, and a 401 can
     * resolve before the sign-in commits. `main.ts:666` writes the module-global bearer from
     * that closure with no guard at all; guarded with the weaker question, it must still refuse
     * here, because "is this still the account I was installed for" has no true answer while the
     * process is between accounts and the credential has been cleared.
     */
    const ep = new EpochCounter();
    let bearer = 'A';
    const gate = defer<void>();
    let firedDuring: string | null = null;
    let reauthorize: () => void = () => undefined;

    const p = handover<string, string>(ep, {
      snapshot: () => bearer,
      clear: () => { bearer = ''; },
      work: async (e) => {
        reauthorize = (): void => { if (ep.sameSubject(e)) bearer = 'A-refreshed'; };
        reauthorize();
        firedDuring = bearer;
        await gate.promise;
        return 'B';
      },
      commit: (v) => { bearer = v; },
      restore: (s) => { bearer = s; },
    });
    gate.resolve();
    await p;

    expect(firedDuring).toBe('');
    expect(bearer).toBe('B');
    // …and the same closure is right again once the account it named is installed.
    reauthorize();
    expect(bearer).toBe('A-refreshed');
  });

  it('★ restore is handed an epoch that is current, so it can re-arm what clear disarmed', async () => {
    /**
     * `clear` has to disarm the outgoing account's renewal timer — `adopt` not doing so is
     * census main.ts:741, where a failed switch keeps re-publishing a live-looking session for
     * a pod nobody is signed in to. That makes re-arming `restore`'s job, and the subject was
     * bumped when the handover started, so the caller's older stamps are all stale.
     */
    const ep = new EpochCounter();
    const beforeAll = ep.begin();
    let armed: Epoch | null = null;
    let rearmedWrite = '';

    await expect(handover<string, string>(ep, {
      snapshot: () => 'A',
      clear: () => undefined,
      work: async () => { throw new Error('the wallet sign-in was cancelled'); },
      commit: () => undefined,
      restore: (_s, e) => { armed = e; },
    })).rejects.toThrow('the wallet sign-in was cancelled');

    expect(ep.sameSubject(beforeAll)).toBe(false);
    expect(armed).not.toBeNull();
    expect(ep.current(armed as unknown as Epoch)).toBe(true);
    expect(await guarded(ep, armed as unknown as Epoch, async () => 'A-renewed', (v) => { rearmedWrite = v; }))
      .toBe(true);
    expect(rearmedWrite).toBe('A-renewed');
  });
});

describe('two handovers at once', () => {
  it('★ the second restores what the FIRST cleared, not the emptiness it snapshotted', async () => {
    /**
     * A second click on sign-in inside the wallet round trip, or `adopt` racing `delegate:list`'s
     * per-address loop. The second handover's own `snapshot` reads the state the first one has
     * already emptied, so its restore alone puts back nothing; the obligation the first one was
     * carrying is inherited with the custody.
     */
    const ep = new EpochCounter();
    let state: Account = { bearer: 'A', sealKey: 'key-A' };
    const gate1 = defer<void>();
    const gate2 = defer<void>();

    const first = handover<Account, Account>(ep, {
      snapshot: () => ({ ...state }),
      clear: () => { state = { ...CLEARED }; },
      work: async () => { await gate1.promise; return { bearer: 'B', sealKey: 'key-B' }; },
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    });
    const second = handover<Account, Account>(ep, {
      snapshot: () => ({ ...state }),
      clear: () => { state = { ...CLEARED }; },
      work: async () => { await gate2.promise; throw new Error('the wallet sign-in was cancelled'); },
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    });

    gate1.resolve();
    let firstErr: unknown;
    try { await first; } catch (e) { firstErr = e; }
    expect(isOvertaken(firstErr)).toBe(true);

    gate2.resolve();
    await expect(second).rejects.toThrow('the wallet sign-in was cancelled');

    // ★ The account is recoverable. Before the chain existed this ended as `{bearer:'', sealKey:null}`.
    expect(state).toEqual({ bearer: 'A', sealKey: 'key-A' });
    expect(ep.handingOver()).toBe(false);
  });

  it('the chain is dropped when the second handover succeeds', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    const restored: string[] = [];
    const gate = defer<void>();

    const first = handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { await gate.promise; return 'B'; },
      commit: (v) => { state = v; },
      restore: (s) => { restored.push('first:' + s); },
    });
    await handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => 'C',
      commit: (v) => { state = v; },
      restore: (s) => { restored.push('second:' + s); },
    });
    gate.resolve();
    let err: unknown;
    try { await first; } catch (e) { err = e; }
    expect(isOvertaken(err)).toBe(true);
    expect(restored).toEqual([]);
    expect(state).toBe('C');
  });

  it('a bare bumpSubject takes the state over, and the chain is dropped with it', async () => {
    /**
     * `auth:signout` clears the credential, the pair and the hosted delegate sessions itself.
     * Putting the departed account back over that is exactly what must not happen.
     */
    const ep = new EpochCounter();
    let state = 'A';
    let restoreCalled = false;
    const gate = defer<void>();
    const p = handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { await gate.promise; throw new Error('the wallet sign-in was cancelled'); },
      commit: (v) => { state = v; },
      restore: () => { restoreCalled = true; },
    });
    // The sign-out writes its own state and says so.
    state = 'signed-out';
    ep.bumpSubject();
    expect(ep.handingOver()).toBe(false);
    gate.resolve();
    await expect(p).rejects.toThrow('the wallet sign-in was cancelled');
    expect(restoreCalled).toBe(false);
    expect(state).toBe('signed-out');
  });
});

describe('the failure path cannot swallow the failure', () => {
  it('★ a restore that throws is reported WITH the failure that made it run', async () => {
    /**
     * Otherwise the operator reads "setAccountEncryption refused" and never learns the sign-in
     * was cancelled — and, worse, does not learn that the state is still cleared.
     */
    const ep = new EpochCounter();
    const original = new Error('the wallet sign-in was cancelled');
    const broke = new Error('setAccountEncryption refused');
    let caught: unknown;
    try {
      await handover<string, string>(ep, {
        snapshot: () => 'A',
        clear: () => undefined,
        work: async () => { throw original; },
        commit: () => undefined,
        restore: () => { throw broke; },
      });
    } catch (e) { caught = e; }
    expect(isRestoreFailed(caught)).toBe(true);
    expect(caught).toBeInstanceOf(RestoreFailed);
    expect((caught as RestoreFailed).cause).toBe(original);
    expect((caught as RestoreFailed).restoreError).toBe(broke);
    expect((caught as Error).message).toContain('the wallet sign-in was cancelled');
    expect((caught as Error).message).toContain('setAccountEncryption refused');
    expect(isRestoreFailed(original)).toBe(false);
  });

  it('★ every owed restore still runs when an earlier one throws', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    const gate = defer<void>();
    const first = handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { await gate.promise; return 'B'; },
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    });
    const second = handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; },
      work: async () => { throw new Error('the second sign-in failed'); },
      commit: (v) => { state = v; },
      restore: () => { throw new Error('the second handover could not put its own half back'); },
    });

    let caught: unknown;
    try { await second; } catch (e) { caught = e; }
    expect(isRestoreFailed(caught)).toBe(true);
    // ★ The first handover's restore ran anyway, so 'A' is back despite the newer step failing.
    expect(state).toBe('A');

    gate.resolve();
    let firstErr: unknown;
    try { await first; } catch (e) { firstErr = e; }
    expect(isOvertaken(firstErr)).toBe(true);
  });

  it('a restore that merely returns a promise is a restore that has not restored', async () => {
    const ep = new EpochCounter();
    const original = new Error('the wallet sign-in was cancelled');
    let caught: unknown;
    try {
      await handover<string, string>(ep, {
        snapshot: () => 'A',
        clear: () => undefined,
        work: async () => { throw original; },
        commit: () => undefined,
        restore: () => Promise.resolve() as unknown as void,
      });
    } catch (e) { caught = e; }
    expect(isRestoreFailed(caught)).toBe(true);
    expect((caught as RestoreFailed).cause).toBe(original);
    expect(((caught as RestoreFailed).restoreError as Error).message).toMatch(/must be synchronous/);
  });
});

describe('async callbacks are refused before they can run', () => {
  /**
   * ★ THE HOLE THE OLD REFUSAL LEFT. Refusing on the returned promise is too late: the
   * callback's synchronous prefix has already run and the rest of it is queued and WILL run. A
   * realistic `clear: async () => { await drop(); state = null; }` refused that way clears the
   * state after the restore has already put it back. Refused before the call, it never runs.
   */
  it('★ an async clear is not called at all, so there is nothing to put back', async () => {
    const ep = new EpochCounter();
    let state = 'A';
    let cleared = false;
    let snapshotted = false;
    await expect(handover<string, string>(ep, {
      snapshot: () => { snapshotted = true; return state; },
      clear: async () => { await Promise.resolve(); state = ''; cleared = true; },
      work: async () => 'B',
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    })).rejects.toThrow(/has NOT been called/);
    // Give the refused callback's continuation every chance to run, which is the point: under
    // the old after-the-fact refusal it did, and it cleared the state behind the restore.
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toBe(false);
    expect(state).toBe('A');
    // Nothing at all happened, including the snapshot: the subject was not even bumped.
    expect(snapshotted).toBe(false);
    expect(ep.handingOver()).toBe(false);
  });

  it('an async snapshot, commit or restore is refused before anything is cleared', async () => {
    const shape = {
      snapshot: (): string => 'A',
      clear: (): void => { throw new Error('nothing should have been cleared'); },
      work: async (): Promise<string> => 'B',
      commit: (): void => undefined,
      restore: (): void => undefined,
    };
    for (const which of ['snapshot', 'commit', 'restore'] as const) {
      const ep = new EpochCounter();
      await expect(handover<string, string>(ep, {
        ...shape,
        [which]: async () => { await Promise.resolve(); return 'A'; },
      })).rejects.toThrow(new RegExp('`' + which + '` must be synchronous'));
      expect(ep.handingOver()).toBe(false);
    }
  });

  it('a clear that merely returns a promise is caught after the fact, and says so', async () => {
    // The residue: not an `async function`, so it cannot be caught before it runs. The message
    // must not claim the callback was stopped, because it was not.
    const ep = new EpochCounter();
    let state = 'A';
    await expect(handover<string, string>(ep, {
      snapshot: () => state,
      clear: () => { state = ''; return Promise.resolve() as unknown as void; },
      work: async () => 'B',
      commit: (v) => { state = v; },
      restore: (s) => { state = s; },
    })).rejects.toThrow(/still runs to completion on its own/);
    expect(state).toBe('A');
  });
});
