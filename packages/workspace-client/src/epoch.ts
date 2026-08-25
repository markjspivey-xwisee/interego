/**
 * ★★ ORDERING FOR EVERY VALUE THAT CROSSES AN `await` — AND THE ONE COPY OF IT.
 *
 * Four shells run this vertical: the desktop renderer, the desktop main process, the Discord
 * watcher, and the published artifact (whose script is generated from this package). Each of
 * them re-derived this guard privately, and each got a DIFFERENT subset of it right. The
 * clearest symptom found in the census: `channel.html` carries an identity guard and no
 * ordering guard, and the comment above its counter cites `renderer.ts`'s `S.wsGen` as the
 * precedent ("The desktop shell carries the same counter for the same reason") — while the
 * docblock immediately below `S.wsGen` in that same file says, in capitals, that TWO FOLDS OF
 * THE SAME WORKSPACE SHARE A GENERATION, which is exactly why `S.wsGen` cannot answer the
 * question the artifact is using it to answer. Two shells re-deriving one guard is how that
 * happened, so the guard lives here, in the one package all four already import from.
 *
 * ── ★ THE THREE QUESTIONS, because a guard that answers two of them reads as complete ─────
 *
 * SUBJECT — WHICH workspace, or WHICH account, this run is about. It catches a continuation
 * landing in the wrong one: a roster fold begun for workspace A assigning its seats after the
 * user opened B, which then decides who B's private writes are encrypted to.
 *
 * ATTEMPT — WHICH run at that same subject. The subject axis says nothing here, because two
 * folds of one workspace share a subject. They do not take the same time: `foldRoster`
 * short-circuits a revoked grant before it reads the grantee's pod at all, so the fold that
 * SEES a revocation is several round trips shorter than one begun before it, and is routinely
 * the first to land. The older, slower fold then lands LAST and re-seats the revoked member,
 * re-folds their log and re-registers the watches on their pod — with nothing left to correct
 * it, because the grant-index change that would have triggered a re-fold has already been
 * consumed. That was reproduced twice: in the desktop shell (14 → 19 → 35 reads of a revoked
 * member's log, the row still not revoked four seconds later) and again in the artifact, where
 * an older fold landing last restored the roster a newer one had already replaced.
 *
 * CUSTODY — WHO OWNS SHARED STATE THAT HAS BEEN CLEARED AND NOT YET REPLACED. This one is new,
 * and it is here because the first version of this file did not have it and was refuted on
 * exactly that. {@link handover} suppressed BOTH its commit and its restore whenever it was no
 * longer the newest ATTEMPT, on the stated reasoning that "the newer attempt owns the state".
 * A plain {@link EpochCounter.begin} is a newer attempt and owns nothing: the desktop's
 * renewal timer fires during a slow sign-in (`adopt` never disarms the outgoing account's
 * timer), begins its own attempt, clears nothing and restores nothing — and the sign-in it
 * overtook then abandoned the encryption pair it had cleared. That is verbatim the censused
 * `main.ts:649` defect this function exists to close, re-armed by the closing of it. Custody
 * is therefore tracked by the counter rather than left to a convention that every future
 * caller has to keep, and it is not expressible through an {@link Epoch}: there is no public
 * predicate that answers it, so no caller can reach for the wrong one.
 *
 * ── ★ WHILE A HANDOVER HOLDS CUSTODY, NOTHING IS CURRENT ──────────────────────────────────
 *
 * Between a handover's `clear` and its outcome the process is BETWEEN SUBJECTS: the outgoing
 * state is gone and the incoming state does not exist. {@link EpochCounter.current} and
 * {@link EpochCounter.sameSubject} therefore answer false for every stamp — the custodian's
 * own included — because there is nothing to be current WITH, and both ways of minting a stamp
 * ({@link EpochCounter.begin}, {@link EpochCounter.asOf}) hand back one that is never current,
 * then or later. The two consequences worth knowing before adopting this:
 *
 *  · A run that starts during a handover is dropped by its own guard rather than queued. It
 *    also READ a cleared world, so landing it would have been wrong anyway. Ask
 *    {@link EpochCounter.handingOver} before starting one, and re-issue it from the handover's
 *    `commit` or `restore` if it must happen.
 *  · A handover bumps the subject when it STARTS, so after a FAILED one the outgoing state is
 *    back but every stamp taken for it is stale. Whatever `clear` disarmed — a renewal timer,
 *    a watch — `restore` must re-arm, and it is handed an Epoch it can guard that with.
 *
 * ── ★ THE FOUR PATTERNS, so a shell does not have to invent a fifth ──────────────────────
 *
 *  1. A run that SUPERSEDES its predecessors — a roster fold, opening a workspace, loading the
 *     canvas, a token renewal. `const e = ep.begin()` once at the top, then {@link guarded}
 *     around every read whose result is written back, or a bare `if (!ep.current(e)) return;`
 *     before a write this module cannot see.
 *
 *  2. Reads at one subject that are INDEPENDENT of each other and must all land — one entry
 *     body per descriptor URL, one delegate roster per pod. These must NOT call `begin()`:
 *     every `begin()` supersedes, so N of them would cancel each other and the fold they run
 *     under. Take the Epoch of the attempt you are inside (or the one that opened the subject),
 *     pass it down, and check `ep.sameSubject(e)` — "is this still the same workspace" is the
 *     whole question a body fetch has.
 *
 *  3. Runs keyed by something the counter does not know about — one thread's candidate refresh
 *     in the Discord watcher, one delegate address's sign-in. Two runs for the SAME key must
 *     supersede and two runs for DIFFERENT keys must not, which is one counter per key
 *     (`Map<string, EpochCounter>`), not one counter with cleverness in it.
 *
 *  4. A run that is neither a new attempt nor part of one — a 401 retry re-issuing the SAME
 *     call, a pass that already serialises itself. `const e = ep.asOf()`, which stamps the
 *     counter as it stands and cancels nothing. It is the one of the four that does not
 *     supersede, so two of them can both land; see {@link EpochCounter.asOf}.
 *
 * A helper started from inside an attempt takes the caller's Epoch as an argument rather than
 * beginning its own — that is why {@link guarded} takes `e` explicitly instead of minting it.
 * `openWorkspace` fires `loadCanvas` without awaiting it; if `loadCanvas` began its own attempt
 * it would supersede the caller that started it, and the caller's remaining writes would be
 * dropped as stale by their own guard.
 *
 * Nothing here touches a DOM, a clock or a transport. It is two integers, one custody record,
 * and the discipline for reading them.
 */

/**
 * A stamp taken at the start of a run, carried across its awaits, and asked about before its
 * writes. Both fields matter and there is no valid way to compare just one of them by hand —
 * ask the counter, which is the only thing that knows what "now" is.
 *
 * A stamp minted while a handover held custody carries {@link BETWEEN_SUBJECTS} in both
 * fields; see {@link EpochCounter.begin} and {@link EpochCounter.asOf}.
 */
export interface Epoch {
  readonly subject: number;
  readonly attempt: number;
}

/**
 * The subject and attempt of a stamp minted while the process was between subjects.
 *
 * ★ IT IS NEGATIVE SO IT CAN NEVER COME BACK. Both counters only ever count up from zero, so a
 * stamp holding this matches no state that has existed or will exist, and it stays that way
 * after the handover settles — whichever way it settles. A run that began while the shared
 * state was cleared read a cleared world; the alternative (a stamp that goes live again the
 * moment the handover commits) is a run landing a value it derived from nothing over the
 * state the handover just installed, which is `main.ts:666` — the re-authorizer overwriting
 * the incoming account's bearer with the departed account's — with a fresh coat of paint.
 */
const BETWEEN_SUBJECTS = -1;

/**
 * Which counter minted an Epoch, carried on the object under a symbol so it is invisible to
 * every consumer and to `JSON.stringify`.
 *
 * ★ WHY IT EXISTS: `renderer.ts` is about to hold TWO of these — one for the workspace and one
 * for the account it has never had — and `channel.html` a third. An `Epoch` is two plain
 * numbers, so one counter's stamp is structurally indistinguishable from another's, and both
 * start at zero and advance in step for as long as the two subjects change together. Handing
 * the account counter a workspace Epoch would then answer `true` for a while and start
 * answering `false` at whatever moment the two fell out of step, which is the hardest possible
 * shape of this bug. No shipped code has made that mistake — this file is new — but nothing in
 * the types can stop it, so the check is here.
 */
const OWNER = Symbol('interego.workspace.epoch.owner');
type Owned = { readonly [OWNER]?: number };

/** Distinguishes counters from one another; see {@link OWNER}. Never exposed. */
let countersMade = 0;

/**
 * What one handover has cleared and not yet replaced, and who is entitled to put it back.
 *
 * ★ HELD BESIDE THE COUNTER, NOT ON IT, so the class stays two integers a reader can follow
 * and so nothing outside this module can reach it: custody is decided here or nowhere. A
 * counter with no entry is not handing over.
 */
interface Handing {
  /** The custodian's own stamp. Identity, not equality: only this object holds custody. */
  readonly epoch: Epoch;
  /**
   * Every `restore` owed, newest first — one per handover that has cleared since the state was
   * last whole. A second sign-in started during the first one's wallet round trip snapshots the
   * state the FIRST one already cleared, so its own restore puts back emptiness; running the
   * chain puts back what was actually there. Oldest runs LAST so the oldest state wins on any
   * field two of them both touched.
   */
  readonly steps: readonly (() => void)[];
}

const handings = new WeakMap<EpochCounter, Handing>();

/** Is `r` a thenable — i.e. did a callback declared to return `void` actually return one? */
const thenable = (r: unknown): boolean =>
  !!r && (typeof r === 'object' || typeof r === 'function') && typeof (r as { then?: unknown }).then === 'function';

/**
 * Is `f` a native `async function`?
 *
 * ★ THIS IS CHECKED BEFORE THE CALLBACK IS CALLED, WHICH IS THE ONLY PLACE THE HOLE CAN BE
 * CLOSED. Refusing afterwards, on the returned promise, is too late by construction: the
 * callback's synchronous prefix has run and the REST OF IT IS STILL QUEUED and will run to
 * completion on its own. A realistic `clear: async () => { await drop(); state = null; }`
 * refused that way clears the state AFTER this function has already put it back, with the
 * subject bumped and no restore left to run — the orphaned state the refusal exists to
 * prevent. Refused up front, it never runs at all.
 *
 * Every toolchain that emits a callback into this primitive keeps `async` native, and each was
 * read rather than assumed: this package is `tsc` at `target: ES2022` (`tsconfig.base.json`);
 * the desktop's `tsc` is `--noEmit` and esbuild emits main, preload and the renderer at
 * `--target=es2020` (its `package.json` build script); the artifact is esbuild at
 * `target: 'es2020'` (`tools/build-workspace-artifact.mjs`). esbuild downlevels `async` only
 * below es2017. A hand-rolled function that merely RETURNS a promise is not caught here and is
 * caught after the fact instead, which is why both checks exist and why the after-the-fact
 * message says what it says.
 */
const asyncFunction = (f: unknown): boolean =>
  typeof f === 'function' && Object.prototype.toString.call(f) === '[object AsyncFunction]';

const MUST_BE_SYNC = (which: string): string =>
  'This `' + which + '` must be synchronous. The whole value of this primitive is that nothing '
  + 'can run between the currency check and the last write; an `async` ' + which + ' puts an '
  + 'await exactly there, which is the defect being guarded against. TypeScript cannot refuse '
  + 'it — a function returning `Promise<void>` is assignable to one declared `=> void` — so it '
  + 'is refused here.';

/**
 * Refuse an `async` callback BEFORE it runs. Nothing has happened yet when this throws, which
 * is the whole point; see {@link asyncFunction}.
 */
function refuseAsyncCallback(which: string, f: unknown): void {
  if (asyncFunction(f)) {
    throw new Error(MUST_BE_SYNC(which) + ' It was declared `async` and has NOT been called.');
  }
}

/**
 * Refuse a callback that was not declared `async` but returned a promise anyway. This one is
 * after the fact and cannot be anything else, so it says so precisely rather than implying the
 * callback has been stopped.
 */
function refuseAsyncResult(which: string, r: unknown): void {
  if (thenable(r)) {
    throw new Error(MUST_BE_SYNC(which) + ' It returned a thenable: its synchronous prefix has '
      + 'ALREADY RUN, and the rest is not awaited here but still runs to completion on its own, '
      + 'so anything it does after its first await happens after this failure has been handled. '
      + 'Make the callback synchronous rather than catching this.');
  }
}

/** What an error said, for a message, without assuming it is an Error. */
const said = (x: unknown): string =>
  x instanceof Error && x.message ? x.message : 'a thrown value that is not an Error';

/**
 * Raised by {@link handover} when it lost custody before it could commit — the subject was torn
 * down, switched or signed out, or another handover took the state over.
 *
 * ★ AN OVERTAKEN HANDOVER FAILS RATHER THAN PARTLY SUCCEEDING. Returning quietly would let the
 * caller go on to record the outcome — a sign-in writing itself to disk as the active account,
 * a watcher marking a thread bound — for a run that never became live. The person asked for two
 * things and got the later one; saying so is the only answer that leaves the process and its
 * durable state agreeing.
 */
export class Overtaken extends Error {
  /**
   * ★ Marked with a field, and tested with {@link isOvertaken} rather than `instanceof`. The
   * artifact bundles this module into its page while the desktop imports the built one, so two
   * copies of this class can exist in one system; a field survives that and a prototype
   * identity does not.
   */
  readonly overtaken = true;

  /**
   * What `work` returned before this run lost custody, so a caller can close it.
   *
   * ★ CARRIED BECAUSE IT IS OFTEN A LIVE RESOURCE. The two named adopters both produce one: the
   * desktop's `adopt` builds a CONNECTED `WorkspaceClient` on a `RelayMcpTransport`, and its
   * `delegateSession` opens a loopback HTTP receiver. As the `work` of a handover, neither would
   * be reachable from a caller handed only an error, and neither closes itself. Nothing here can
   * close it either — this module knows nothing about transports — so it is handed back. Cast it
   * to the `T` you passed in.
   */
  readonly value: unknown;

  constructor(value: unknown, message?: string) {
    super(message ?? 'This handover was overtaken — its subject was torn down, switched or signed out, or '
      + 'another handover took over the state it cleared, before it finished. Nothing it read was committed. '
      + 'Whatever `work` produced is on this error as `value`, and closing it is the caller\'s: nothing else '
      + 'holds a reference to it.');
    this.name = 'Overtaken';
    this.value = value;
  }
}

/** Whether `e` is an {@link Overtaken}, across module copies. See the note on the class. */
export const isOvertaken = (e: unknown): e is Overtaken =>
  !!e && typeof e === 'object' && (e as { overtaken?: unknown }).overtaken === true;

/**
 * Raised by {@link handover} when the failure path could not put the cleared state back.
 *
 * ★ THE CALLER HAS TO BE ABLE TO TELL THESE APART. A handover that failed and restored leaves
 * the outgoing identity live; one that failed and could NOT restore leaves the process with its
 * shared state cleared and nothing holding it — in the desktop that is sealing disarmed for the
 * life of the process, and the only honest answer is to sign out rather than to carry on. The
 * failure that made us restore is this error's `cause`; what `restore` itself threw is
 * {@link RestoreFailed.restoreError}. Neither is discarded, because a message that says the
 * restore failed and never says the sign-in was cancelled sends the operator after the wrong
 * one of the two.
 */
export class RestoreFailed extends Error {
  readonly restoreFailed = true;

  /** What `restore` threw. `cause` is the failure that made it run. */
  readonly restoreError: unknown;

  constructor(restoreError: unknown, cause: unknown) {
    super('This handover failed, and putting back the state it had cleared failed as well, so that state is '
      + 'still cleared and nothing owns it. What `restore` threw: ' + said(restoreError) + '. What made it '
      + 'restore is this error\'s `cause`: ' + said(cause) + '.', { cause });
    this.name = 'RestoreFailed';
    this.restoreError = restoreError;
  }
}

/** Whether `e` is a {@link RestoreFailed}, across module copies. */
export const isRestoreFailed = (e: unknown): e is RestoreFailed =>
  !!e && typeof e === 'object' && (e as { restoreFailed?: unknown }).restoreFailed === true;

/**
 * The two counters for one thing that can be worked on — a window's workspace, a process's
 * account, one Discord thread. One instance per subject-space, never one shared instance for
 * two unrelated spaces (see {@link OWNER}).
 */
export class EpochCounter {
  /**
   * ★ TypeScript `private`, not `#`. This package is bundled into `channel.html` by esbuild at
   * `target: es2020`, where a `#` field is lowered to `WeakMap` plus `__privateGet`/
   * `__privateAdd`/`__privateWrapper` helpers at every use site. That block is published as a
   * file whose entire argument is that you can read what it does before trusting it with your
   * pod, and this is a counter: `this.subject += 1` is the readable form and
   * `__privateWrapper(this, _subject)._++` is not. Measured against the real build settings,
   * not assumed. (The one {@link handings} WeakMap is a different thing: it is named, it is
   * read in four places, and what it holds is not a number.)
   */
  private subject = 0;

  private attempt = 0;

  /** See {@link OWNER}. Assigned once, never compared for order — only for identity. */
  private readonly id = ++countersMade;

  /**
   * The subject changed: the workspace was torn down or switched, an account was adopted, the
   * session signed out.
   *
   * ★ THIS INVALIDATES OUTSTANDING ATTEMPTS TOO, and it does so without touching the attempt
   * counter: every Epoch already minted names the OLD subject, so {@link current} answers false
   * for all of them, and goes on answering false until somebody stamps the NEW subject with
   * {@link begin} or {@link asOf}. Until one of those, there is no current Epoch at all, which
   * is the honest state
   * for a process that is between identities — `adopt` in the desktop main process spends that
   * whole window refusing to seal, for exactly this reason.
   *
   * ★ AND IT ENDS ANY HANDOVER IN FLIGHT. Whoever bumps is taking the subject over and is
   * writing its state as it does so — `auth:signout` clears the credential, the pair and the
   * hosted delegate sessions itself. Putting the departed account back over that is exactly
   * what must not happen, so the custodian loses custody here and its restore is dropped along
   * with it. The custodian still learns its handover failed; it just does not act on it.
   *
   * Bumping on TEARDOWN as well as on switch is what makes re-opening the SAME workspace
   * invalidate a fold that is still in flight for it.
   */
  bumpSubject(): void {
    this.subject += 1;
    handings.delete(this);
  }

  /**
   * Start a new attempt at the CURRENT subject, and stamp it.
   *
   * ★ EVERY CALL SUPERSEDES. The attempt returned is the only one {@link current} will accept
   * until the next call, including one begun by a helper running inside another attempt — a
   * nested `begin()` cancels the run that started it. That is the correct default (only one run
   * may commit) but it is not always what a caller wants, so see patterns 2 and 4 in the file
   * header: a run that must not supersede either takes its caller's Epoch or takes
   * {@link asOf}, and calls this not at all.
   *
   * ★ EXCEPT WHILE A HANDOVER HOLDS CUSTODY, when it supersedes nothing and returns a stamp
   * that is never current — see {@link BETWEEN_SUBJECTS}. Superseding would be the defect: the
   * renewal timer firing during a sign-in would take the newest attempt away from the sign-in
   * that cleared the account state, and the sign-in would then abandon it. So the attempt
   * counter does not move here, the custodian stays the custodian, and this run is told no in
   * the only way this API has to say it. Ask {@link handingOver} first if the difference
   * between "dropped because something newer is running" and "dropped because the process is
   * between identities" matters to the caller — for a self-rescheduling timer it does.
   *
   * The attempt number is monotonic for the life of the counter and is never reset by
   * {@link bumpSubject}, so a number is never reused and there is no A-B-A to lose a race to.
   */
  begin(): Epoch {
    if (handings.has(this)) return this.stamp(BETWEEN_SUBJECTS, BETWEEN_SUBJECTS);
    this.attempt += 1;
    return this.stamp(this.subject, this.attempt);
  }

  /**
   * The counter AS IT STANDS, stamped — superseding nothing.
   *
   * ★ FOR A RUN THAT HAS NO ATTEMPT TO INHERIT AND MUST NOT CANCEL ONE. Two censused sites
   * cannot be written without it, and both are the same shape: something that is not a fresh
   * attempt at anything, running where no Epoch is in scope. `substrate:call`'s 401 recovery
   * (`main.ts:1053`) re-issues the SAME call after `await renew(...)`, and must refuse if a
   * sign-out or a second `adopt` landed in between — but it fires once per IPC call, so a
   * `begin()` there would cancel the account's renewal guard and boot's in-flight loads on every
   * read the renderer makes. The Discord watcher's `pass` (`watch.ts:274`) is the same: it
   * serialises itself already and only wants "is this thread still bound to the workspace I
   * started on", while the `refreshCandidates` it fires unawaited DOES need to supersede — one
   * `begin()` in `pass` would cancel the other.
   *
   * ★ IT SUPERSEDES NOTHING, WHICH MEANS TWO RUNS HOLDING ONE CAN BOTH COMMIT and the later
   * write wins. That is right only when the two runs are not alternatives. A run that must be
   * the only one to land calls {@link begin}, and a helper running inside somebody's attempt
   * takes THAT attempt's Epoch as an argument (pattern 2) rather than taking one of these —
   * this stamp is current relative to whatever is newest, not to the fold the helper belongs to.
   *
   * While a handover holds custody this hands back the same between-subjects stamp
   * {@link begin} does: a retry has no more business landing in the gap than a new attempt has.
   */
  asOf(): Epoch {
    if (handings.has(this)) return this.stamp(BETWEEN_SUBJECTS, BETWEEN_SUBJECTS);
    return this.stamp(this.subject, this.attempt);
  }

  /**
   * BOTH AXES: is this still the newest attempt, at the subject it was begun for?
   *
   * This is the question a run must ask before it writes anything the rest of the process can
   * see. There is deliberately no single-axis accessor beside it; see the file header.
   *
   * ★ FALSE FOR EVERYTHING WHILE A HANDOVER HOLDS CUSTODY, the custodian's own stamp included.
   * There is no state to be current with: the outgoing state has been cleared and the incoming
   * state does not exist yet. A run that committed in that window would be writing into the
   * gap — the renewal timer setting a refreshed bearer for the departed account onto the
   * cleared credential, which is `main.ts:759`. The custodian does not use this method:
   * custody is tracked separately, because "may I write" and "do I still own what I cleared"
   * stop being the same question the moment the state is gone.
   */
  current(e: Epoch): boolean {
    this.assertMine(e);
    if (handings.has(this)) return false;
    return e.subject === this.subject && e.attempt === this.attempt;
  }

  /**
   * ONE AXIS, and weaker: is the subject unchanged, whatever has happened since at that subject?
   *
   * ★ NAMED SO A CALLER MUST SAY SO. This answers true for an attempt a newer one has already
   * superseded, so a run that assigns shared state on the strength of it is committing the
   * defect this file exists to close. It is right for exactly one shape: an independent read at
   * a subject, one of many, where all of them must land and none supersedes another — pattern 2
   * in the file header.
   *
   * ★ AND IT IS FALSE WHILE A HANDOVER HOLDS CUSTODY, for the same reason {@link current} is:
   * "is this still the same account" has no true answer while the process is between accounts.
   * A 401 arriving mid-sign-in must not let the departed account's re-authorizer write the
   * bearer the sign-in has just cleared.
   */
  sameSubject(e: Epoch): boolean {
    this.assertMine(e);
    if (handings.has(this)) return false;
    return e.subject === this.subject;
  }

  /**
   * Is a {@link handover} in flight at this counter — state cleared, nothing installed yet?
   *
   * The one thing worth doing with the answer is NOT STARTING: a timer that would rather
   * re-arm itself than be dropped, an action a panel should refuse while an account is being
   * switched. It does not say WHOSE handover, because custody is not a caller's question.
   */
  handingOver(): boolean {
    return handings.has(this);
  }

  /** Mint a frozen, owner-tagged stamp. The only place an {@link Epoch} is created. */
  private stamp(subject: number, attempt: number): Epoch {
    const e: Epoch & Owned = { subject, attempt };
    Object.defineProperty(e, OWNER, { value: this.id, enumerable: false, writable: false, configurable: false });
    return Object.freeze(e);
  }

  /**
   * Refuse an Epoch minted by a DIFFERENT counter. An Epoch built by hand — a test fixture, or
   * a shell reconstructing one it stored — carries no owner and is accepted, because refusing
   * it would be refusing something that was never the mistake this catches.
   */
  private assertMine(e: Epoch): void {
    const owner = (e as Epoch & Owned)[OWNER];
    if (owner !== undefined && owner !== this.id) {
      throw new Error('This Epoch was minted by a different EpochCounter, so the answer would be meaningless: '
        + 'the two counters advance independently and their numbers agree only by coincidence. Ask the counter '
        + 'that begins the run for the subject you are guarding.');
    }
  }
}

/**
 * Read, then write ONLY IF this run is still the one whose answer is wanted.
 *
 * Returns whether the commit happened: `true` committed, `false` dropped.
 *
 * ★ A DROP IS NOT ALWAYS SOMEBODY ELSE'S PROBLEM, and the first version of this file said it
 * was ("whatever superseded this run started its own read"). Exactly one of the things that
 * drop a run carries its own replacement — a newer {@link EpochCounter.begin} of the same run,
 * which is about to read again. None of the others do: {@link EpochCounter.bumpSubject} is a
 * teardown or a sign-out and reads nothing, {@link handover} re-issues none of the runs its
 * window drops, and a stamp minted between subjects was never going to land at all. On the
 * account counter an `adopt` silently drops boot's in-flight `loadInvites` / `loadSpaces` /
 * `loadDelegates`, and those panels then stay empty with no error and nothing left to reload
 * them. So: a caller that owns a panel or a timer decides whether `false` needs re-issuing, and
 * {@link EpochCounter.handingOver} is how it tells a supersession from the gap.
 *
 * ★ `commit` IS SYNCHRONOUS, which is what makes check-and-write atomic. It is not a comment
 * asserting the property: `loadRoster` in the desktop renderer says "No await between the guard
 * above and here, so the reconcile runs against the roster that was just assigned", which is
 * true today and is checked by nothing, so it stays true only for as long as nobody adds an
 * await to the block underneath it. Here the guard, the call and the write are one statement
 * apart, and an `async` commit is refused before the read is even started, because the type
 * alone cannot refuse it (see {@link refuseAsyncCallback}).
 *
 * ★ THE CURRENCY IS CHECKED BEFORE THE READ AS WELL. A run that is already stale should not
 * spend the round trips, and `read` is not invoked at all in that case.
 *
 * ★ AN ERROR FROM `read` PROPAGATES, and this function writes nothing on that path — it clears
 * nothing, so there is nothing to restore (that is {@link handover}'s job). But the caller's
 * `catch` is the caller's: a catch that paints an error box, retries, or clears a spinner is a
 * write to shared state and must ask `ep.current(e)` itself first. An error box about a
 * workspace somebody has already left is drawn over whatever they are looking at now.
 */
export async function guarded<T>(
  ep: EpochCounter,
  e: Epoch,
  read: () => Promise<T>,
  commit: (v: T) => void,
): Promise<boolean> {
  refuseAsyncCallback('commit', commit);
  if (!ep.current(e)) return false;
  const value = await read();
  if (!ep.current(e)) return false;
  refuseAsyncResult('commit', commit(value));
  return true;
}

/**
 * The shape {@link handover} drives. Every callback except `work` is synchronous, and that is
 * enforced rather than requested: they are declared `void` (or, for `snapshot`, a value), and
 * TypeScript's void-return assignability would otherwise accept an `async` one silently.
 */
export interface Handover<S, T> {
  /**
   * Read the shared state about to be cleared, so a failure has something to put back.
   *
   * Refused if it is an `async function`, which could only return a promise of the state rather
   * than the state. A plain function that happens to return a promise IS a legitimate snapshot
   * — some state is a promise — so that is not refused.
   */
  snapshot: () => S;
  /**
   * Drop the shared state NOW, before the first await. The process is between subjects from
   * here until the outcome and must act as neither: in the desktop main process this is where
   * the account encryption pair goes, because leaving it standing across the new account's
   * `register_agent` had `substrate:seal` answering — for the length of a round trip, stamped
   * with the PREVIOUS account's key — on an entry the new account was about to write.
   *
   * ★ CLEAR EVERYTHING THE OUTGOING SUBJECT OWNS, INCLUDING WHAT IS NOT A VALUE. `adopt` today
   * leaves the outgoing account's renewal timer armed (`main.ts:741`), so a failed switch keeps
   * re-publishing a live-looking session for a pod nobody is signed in to. A timer, a watch and
   * a subscription are state; if `clear` does not disarm them, `restore` cannot be their
   * inverse and the pair does not describe the handover.
   */
  clear: () => void;
  /** The awaited part. Receives this handover's Epoch; see the note on {@link handover}. */
  work: (e: Epoch) => Promise<T>;
  /**
   * Install the new state. Synchronous, so nothing runs between the currency check and it.
   * Receives the same Epoch `work` did, which is current again by the time this runs.
   */
  commit: (v: T, e: Epoch) => void;
  /**
   * Put back exactly what `snapshot` returned, and re-arm whatever `clear` disarmed. Called on
   * the failure path only, and only while this handover still holds custody.
   *
   * Receives the Epoch, which is current again by the time this runs, because custody is
   * released before the restore: the subject was bumped when the handover STARTED, so the
   * outgoing state is coming back while every stamp taken for it is stale, and anything re-armed
   * here has to be guarded with this one rather than with whatever the caller had before.
   *
   * ★ WITH ONE EXCEPTION, AND IT IS NOT HYPOTHETICAL: if this handover was overtaken, a LATER
   * one runs this restore as part of the chain it inherited, and by then the subject has moved
   * again — so the Epoch handed here is stale and `ep.current(e)` says so. Ask, rather than
   * assume, before re-arming anything that would outlive the call.
   */
  restore: (s: S, e: Epoch) => void;
}

/**
 * Run every `restore` owed, newest first, and report the first that failed.
 *
 * ★ ALL OF THEM RUN EVEN IF ONE THROWS. They are separate handovers' separate states; the older
 * one's claim to be put back does not go away because the newer one's step failed, and the
 * older one is the more complete of the two.
 */
function putEverythingBack(steps: readonly (() => void)[]): { readonly error: unknown } | null {
  let first: { readonly error: unknown } | null = null;
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      first ??= { error };
    }
  }
  return first;
}

/**
 * CLEAR, THEN AWAIT, THEN COMMIT — with the failure path actually written.
 *
 * ★ THIS IS THE HALF THAT WAS MISSING, AND IT IS A SEPARATE DEFECT FROM ORDERING. A function
 * that clears shared state before its first await and then throws leaves the process cleared
 * with nothing to put it back. The desktop's `adopt` does this: any throw between building the
 * new client and the commit — a failed connect, a pod status without a pod URL, a key that
 * would not derive — exits with the account encryption pair permanently null while the session
 * panel still advertises the OUTGOING account as live, with `sealedReads: true` and its
 * encryption public key. Sealing is then disarmed for the life of the process. Reproduced
 * twice. The Discord bot has the same shape: a throw between replacing `this.bearer` and
 * committing `this.identity` leaves the new, never-validated token in place, so `expiring()`
 * answers false, the pre-emptive re-mint stops firing, and the hourly 401 that was fixed once
 * is back — re-armed by a failure path.
 *
 * The order is: refuse anything `async` that must not be → snapshot (before anything changes) →
 * bump the subject → begin this attempt → take custody → clear → await `work` → check custody →
 * release it → commit.
 *
 * ★ THE SUBJECT IS BUMPED HERE, NOT BY THE CALLER. A handover IS a subject change, and the
 * shipped defects are all a caller forgetting to stamp one — the Discord bot's `openOnce` has
 * no generation of any kind. A caller that bumps just before calling is harmless: the counter
 * only counts up, and the extra bump invalidates runs that were already being abandoned. A bump
 * from INSIDE one of these callbacks is a different thing — it ends this handover's custody, so
 * the handover goes on to fail with {@link Overtaken} and puts nothing back.
 *
 * ★ THE DECISION AT THE END IS CUSTODY, NOT CURRENCY, AND THE DIFFERENCE IS THE WHOLE REPAIR.
 * "Am I still the newest attempt" answers false for a handover that a renewal timer's plain
 * `begin()` has overtaken, and that timer cleared nothing and can restore nothing — so the
 * previous version of this file abandoned the cleared account state to a run that did not want
 * it. Custody moves only when another handover takes the state over or when somebody bumps the
 * subject and writes it themselves, which is exactly when abandoning it is right. Nothing a
 * caller can do with an {@link Epoch} moves it, so no adopter has to know this rule to be
 * covered by it.
 *
 *  · On a throw from `clear` or `work`: restore IF STILL THE CUSTODIAN, then rethrow. If custody
 *    has moved, do NOT restore — putting back a snapshot taken before the newer handover began
 *    would hand the live subject the departed one's bearer, transport and keys, and the newer
 *    custodian has inherited the obligation anyway (it holds this handover's restore in its own
 *    chain, so a state cleared twice is still put back once, in full).
 *  · On success after custody has moved: throw {@link Overtaken}, carrying what `work` produced
 *    so the caller can close it. Commit nothing and restore nothing, same reason.
 *  · A throw from `commit` propagates and does NOT restore. The snapshot predates the clear and
 *    half the commit has landed on top of it, so putting the old state back would invent a third
 *    state that never existed. `commit` must be total.
 *
 * `work` receives this handover's Epoch because the long-lived closures a handover installs
 * need it. The desktop's re-authorizer is installed on THIS sign-in's transport and writes the
 * module-global bearer after its own await, capturing neither a generation nor a transport
 * identity: a 401 on a call still travelling through account A's transport, resolving after a
 * switch to B, overwrites B's bearer with A's fresh credential — and `renew` then reads that
 * global, refreshes A's token and sets it on B's transport, so the process makes relay calls as
 * A under a session panel that says B. That closure wants `ep.sameSubject(e)` — is this still
 * the account I was installed for — so it has to be able to see `e`. Passing it in is the only
 * way it can; a closure that called `begin()` to get one would supersede the handover that
 * installed it.
 */
export async function handover<S, T>(ep: EpochCounter, h: Handover<S, T>): Promise<T> {
  // Before anything is read, cleared or bumped. Once one of these has been called an `async`
  // one cannot be stopped: its continuation runs after this function has finished handling the
  // failure it caused, which is how a refused `clear` still empties state the restore put back.
  refuseAsyncCallback('snapshot', h.snapshot);
  refuseAsyncCallback('clear', h.clear);
  refuseAsyncCallback('commit', h.commit);
  refuseAsyncCallback('restore', h.restore);

  // Read before the bump below ends it. If another handover is mid-flight, this is the chain of
  // restores it has accumulated, and taking its custody means taking that obligation too.
  const inherited = handings.get(ep);
  // Before anything this function does, so the snapshot is unambiguously the state as found.
  const before = h.snapshot();
  ep.bumpSubject();
  // No custody is held at this instant — the bump above just ended any — so this stamp is a
  // live one rather than the between-subjects stamp `begin` hands out during a handover.
  const e = ep.begin();
  const steps: readonly (() => void)[] = [
    () => { refuseAsyncResult('restore', h.restore(before, e)); },
    ...(inherited ? inherited.steps : []),
  ];
  handings.set(ep, { epoch: e, steps });

  /** Custody is identity: another handover replaces the record, a bump deletes it. */
  const stillOurs = (): boolean => handings.get(ep)?.epoch === e;

  /**
   * The failure path, written once so the two throws below cannot drift. It releases custody
   * BEFORE restoring, so `restore` runs with the counter live again and can begin an attempt to
   * guard whatever it re-arms.
   */
  const failure = (err: unknown): unknown => {
    if (!stillOurs()) return err;
    handings.delete(ep);
    const broke = putEverythingBack(steps);
    return broke === null ? err : new RestoreFailed(broke.error, err);
  };

  let value: T;
  try {
    refuseAsyncResult('clear', h.clear());
    value = await h.work(e);
  } catch (err) {
    throw failure(err);
  }
  if (!stillOurs()) throw new Overtaken(value);
  handings.delete(ep);
  refuseAsyncResult('commit', h.commit(value, e));
  return value;
}
