import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';
import { PodReadError, readPodJsonWithEtag } from '../account-index.js';
import {
  AccountDeletedError, AccountRecordMissingError, AuthMethodsConflictError, AuthMethodsWriteError, NoWrite,
  PlayOwnerUnavailableError, PodLockReentryError, Write, applyUpdate as applyUpdateWith, updateAuthMethods as updateAuthMethodsWith,
  type WritePrecondition,
} from '../auth-methods-writer.js';
import { createCredentialDecisions } from '../credential-decisions.js';

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const strip = (nodeModule as { stripTypeScriptTypes?: (source: string) => string }).stripTypeScriptTypes;
// The base-without-verticals gate also exercises the supported Node 20 runtime.
const executable = strip ? strip(server) : (await import('typescript')).default.transpileModule(server, {
  compilerOptions: { target: 9, module: 99 },
}).outputText;
function sliceFunction(pattern: RegExp, name: string): string {
  const start = executable.search(pattern);
  assert.ok(start >= 0, `Production function ${name} exists`);
  const end = executable.indexOf('\n}', start);
  assert.ok(end > start, `Production function ${name} ends at top-level`);
  return executable.slice(start, end + 2);
}
const productionFunction = (name: string) => sliceFunction(new RegExp(`async function ${name}\\s*\\(`), name);
const productionSyncFunction = (name: string) => sliceFunction(new RegExp(`(?<!async )function ${name}\\s*\\(`), name);
/** A top-level `const <name> = { ... };` object literal (its closing brace at column 0). */
const productionObject = (name: string) => sliceFunction(new RegExp(`const ${name}\\s*=\\s*\\{`), name);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const userId = `u-try-play-${'1'.repeat(32)}`;
type Methods = {
  userId: string; provisionalPlayAnchor?: string;
  webAuthnCredentials: Array<{ id: string; counter?: number; publicKey?: string }>;
  walletAddresses: string[]; didKeys: Array<{ did: string }>;
  sessionEpoch?: number; deletedAt?: string; provisionalPlayPurgePending?: true;
};
const hasAnyCredential = (m: Methods) => m.webAuthnCredentials.length + m.walletAddresses.length + m.didKeys.length > 0;
const empty = (owner = userId): Methods => ({ userId: owner, webAuthnCredentials: [], walletAddresses: [], didKeys: [] });
const isTombstone = (m: Methods) => typeof m.deletedAt === 'string';

/** The lock exactly as server.ts builds it: a promise chain per account, and a context naming the locks held. */
function productionLock() {
  const podLockContext = new AsyncLocalStorage<ReadonlyMap<string, { held: boolean }>>();
  const withIdentityPodMutex = new Function('podLockContext', 'PodLockReentryError', `const identityPodWriteMutexes = new Map();
    ${productionFunction('withIdentityPodMutex')}; return withIdentityPodMutex;`)(podLockContext, PodLockReentryError) as
    <T>(owner: string, work: () => Promise<T>) => Promise<T>;
  const assertLockHeld = new Function('podLockContext',
    `${productionSyncFunction('assertLockHeld')}; return assertLockHeld;`)(podLockContext) as (owner: string) => void;
  return { podLockContext, withIdentityPodMutex, assertLockHeld };
}

/**
 * One account's pod (any id reads and writes the same document) with ETags, and the production
 * functions that write it, rebuilt from server.ts with stand-ins for everything they reach.
 */
function fixture() {
  let document: Methods | null = { ...empty(), provisionalPlayAnchor: 'original-owner-anchor' };
  let version = 1;
  let cached: Methods | null = document;
  let now = 0;
  let checkpoint = true;
  let puts = 0;
  let installs = 0;
  let openCalls = 0;
  const deletions: string[] = [];
  const { withIdentityPodMutex, assertLockHeld } = productionLock();
  let beforePersist: () => Promise<void> = async () => {};
  let beforeDelete: () => Promise<void> = async () => {};
  // DELETEs of the pod's resources by the purge that the pod answers 500 (the next N).
  let failingDeletes = 0;
  let duringVerification: () => Promise<void> = async () => {};
  let duringAccountDelete: () => Promise<void> = async () => {};
  const etag = () => `"${version}-application/ld+json"`;
  const readLive = async () => document
    ? { methods: structuredClone(document), raw: structuredClone(document), etag: etag() }
    : { methods: null, raw: null, etag: null };
  const writeLive = async (_owner: string, doc: Methods, pre: WritePrecondition) => {
    puts++;
    await beforePersist();
    if (pre.kind === 'absent' ? document !== null : pre.kind === 'match' && pre.etag !== etag()) return 'precondition-failed' as const;
    document = structuredClone(doc);
    version++;
    return 'ok' as const;
  };
  const installAuthMethods = (_owner: string, m: Methods) => { installs++; cached = structuredClone(m); return cached; };
  // The guest deadline is at 10: before it the anchor opens; after it, it opens only when expiry is allowed (the janitor's check).
  const provisionalPlay = { open(anchor: string, allowExpired = false) {
    openCalls++;
    if (anchor !== 'original-owner-anchor' || (now >= 10 && !allowExpired)) throw new Error('Provisional owner unavailable');
    return { userId, expiresAt: now >= 10 ? 0 : Number.MAX_SAFE_INTEGER };
  } };
  const deletedUserIds = new Set<string>();
  // The guard on an unclaimed Play owner, and the writer's wiring, exactly as server.ts has them:
  // a guard written here instead would pass whatever server.ts checks (or stops checking).
  const playOwnerWritable = new Function('hasAnyCredential', 'provisionalPlay',
    `${productionSyncFunction('playOwnerWritable')}; return playOwnerWritable;`)(hasAnyCredential, provisionalPlay);
  const authMethodsWriter = new Function('withIdentityPodMutex', 'assertLockHeld', 'readLive', 'writeLive', 'installAuthMethods',
    'expireAuthMethods', 'deletedUserIds', 'isTombstone', 'emptyAuthMethods', 'playOwnerWritable', 'logWriteConflict',
    `${productionObject('authMethodsWriter')}; return authMethodsWriter;`)(
    withIdentityPodMutex, assertLockHeld, readLive, writeLive, installAuthMethods,
    () => {}, deletedUserIds, isTombstone, (owner: string) => empty(owner), playOwnerWritable, () => {},
  );
  const updateAuthMethods = new Function('updateAuthMethodsWith', 'authMethodsWriter',
    `${productionFunction('updateAuthMethods')}; return updateAuthMethods;`)(updateAuthMethodsWith, authMethodsWriter);
  // Every account, a Play owner's included, goes through the one writer.
  const commit = new Function('updateAuthMethods', 'NoWrite', 'Write',
    `${productionFunction('commitCredentialEnrollment')}; return commitCredentialEnrollment;`)(
    updateAuthMethods, NoWrite, Write,
  ) as (owner: string, context: string, update: (m: Methods) => boolean | void, opts?: { absent?: 'refuse' | 'create' }) => Promise<unknown>;
  const authMethodsCache = { get: () => cached ? { value: cached } : undefined, delete: () => { cached = null; } };
  const log = () => {};
  // How a route reads a failed write's settled record, exactly as server.ts has it.
  const changeOnPod = new Function('AuthMethodsWriteError', 'isTombstone',
    `${productionSyncFunction('changeOnPod')}; return changeOnPod;`)(AuthMethodsWriteError, isTombstone);
  const refuseUndeterminedChange = new Function(`${productionSyncFunction('refuseUndeterminedChange')}; return refuseUndeterminedChange;`)();
  const signIn = new Function('authMethodsCache', 'publicKeyIdentity', 'updateAuthMethods', 'NoWrite', 'Write',
    'verifyPasskeyAssertion', 'PodReadError', 'AuthMethodsWriteError', 'AuthMethodsConflictError', 'AccountRecordMissingError',
    'PlayOwnerUnavailableError', 'AccountDeletedError', 'changeOnPod', 'log',
    `${productionFunction('signInWithPasskey')}; return signInWithPasskey;`)(
    authMethodsCache, async (key: string | undefined) => `key:${key ?? 'stand-in'}`, updateAuthMethods, NoWrite, Write,
    async ({ credential }: { credential: { counter?: number } }) => {
      await duringVerification();
      return { ok: true, newCounter: (credential.counter ?? 0) + 1 };
    }, PodReadError, AuthMethodsWriteError, AuthMethodsConflictError, AccountRecordMissingError,
    PlayOwnerUnavailableError, AccountDeletedError, changeOnPod, log,
  ) as (holders: string[], response: { id: string }, challenge: string, rpId: string, origin: string) => Promise<{ kind: string }>;
  const authenticate = async (owner: string, response: { id: string }, challenge: string, rpId: string, origin: string) => {
    const outcome = await signIn([owner], response, challenge, rpId, origin);
    assert.equal(outcome.kind, 'signed-in', JSON.stringify(outcome));
  };
  const sendAccountWriteRefusal = new Function('PodReadError', 'AccountDeletedError', 'AccountRecordMissingError',
    'ACCOUNT_DELETED_MESSAGE', 'log', `${productionSyncFunction('sendAccountWriteRefusal')}; return sendAccountWriteRefusal;`)(
    PodReadError, AccountDeletedError, AccountRecordMissingError, 'account deleted', log);
  const refuseRemoval = new Function(`${productionSyncFunction('refuseRemoval')}; return refuseRemoval;`)();
  // The production deletion (deleteUserCompletely, which takes the account's lock unless its caller
  // holds it), over the same writer: it overwrites the record with its tombstone, and never removes it.
  const applyUpdate = new Function('applyAuthMethodsUpdate', 'authMethodsWriter',
    `${productionFunction('applyUpdate')}; return applyUpdate;`)(applyUpdateWith, authMethodsWriter);
  const deletionTombstone = new Function('emptyAuthMethods',
    `${productionSyncFunction('deletionTombstone')}; return deletionTombstone;`)((owner: string) => empty(owner));
  const podFetch = async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { await beforeDelete(); deletions.push(url); }
    return new Response(null, { status: 205 });
  };
  // Play owners whose deletion was answered 503 (not confirmed), with their guest deadline, and the
  // production functions that read it.
  const unconfirmedPlayDeletions = new Map<string, number>();
  const awaitsGuestRetry = new Function('unconfirmedPlayDeletions',
    `${productionSyncFunction('awaitsGuestRetry')}; return awaitsGuestRetry;`)(unconfirmedPlayDeletions) as (owner: string) => boolean;
  const playGuestDeadline = new Function('provisionalPlay',
    `${productionSyncFunction('playGuestDeadline')}; return playGuestDeadline;`)(provisionalPlay) as (m: Methods | null) => number;
  const deleteUserCompletely = new Function('applyUpdate', 'NoWrite', 'Write', 'isTombstone', 'deletionTombstone', 'emptyAuthMethods',
    'authMethodsCache', 'AuthMethodsWriteError', 'log', 'deletedUserIds', 'removeFromIndexes', 'recordWatchers', 'assertLockHeld',
    'withIdentityPodMutex', 'identities', 'keys', 'surfaceAgentRestores', 'podRegistryCache', 'fetch', 'CSS_URL', 'POD_RECORD_TIMEOUT_MS',
    'unconfirmedPlayDeletions', 'awaitsGuestRetry', 'playGuestDeadline',
    `${productionFunction('deleteUserCompletely')}; return deleteUserCompletely;`)(
    applyUpdate, NoWrite, Write, isTombstone, deletionTombstone, (owner: string) => empty(owner),
    authMethodsCache, AuthMethodsWriteError, () => {}, deletedUserIds, () => {}, { changed: () => {} }, assertLockHeld,
    async <T>(owner: string, work: () => Promise<T>) => withIdentityPodMutex(owner, async () => { await duringAccountDelete(); return work(); }),
    new Map(), new Map(), { forgetUser: () => {} }, new Map(), podFetch, 'https://css.test/', 15_000,
    unconfirmedPlayDeletions, awaitsGuestRetry, playGuestDeadline,
  ) as (owner: string, opts?: { lockHeld?: boolean; stillDeletable?: (m: Methods) => boolean }) => Promise<{ kept?: true }>;
  const playOwnerPurgeable = new Function('isTombstone', 'hasAnyCredential', 'provisionalPlay',
    `${productionSyncFunction('playOwnerPurgeable')}; return playOwnerPurgeable;`)(isTombstone, hasAnyCredential, provisionalPlay);
  // A wallet or DID removal runs in the credential's turn (inRemovalTurn, as server.ts has it, over
  // a decisions instance of its own); the owner's copy lists every credential here.
  const credentialDecisions = createCredentialDecisions({ readAccount: async () => undefined, waitMs: 5_000 });
  const inRemovalTurn = new Function('credentialDecisions', `${productionFunction('inRemovalTurn')}; return inRemovalTurn;`)(credentialDecisions);
  const listsOwner = { candidates: () => [userId] };
  const unexpected = (what: string) => () => { throw new Error(`${what} was not expected here`); };
  const control = (method: string, path: string) => {
    const start = executable.indexOf(`app.${method}('${path}',`);
    assert.ok(start >= 0, path);
    const handler = executable.indexOf('async (req, res) => {', start);
    const end = executable.indexOf('\n});', handler);
    const run = new Function('requireUserFromBearer', 'commitCredentialEnrollment', 'withIdentityPodMutex',
      'deleteUserCompletely', 'log', 'authMethodsCache', 'sendAccountWriteRefusal', 'refuseRemoval', 'AuthMethodsWriteError',
      'changeOnPod', 'refuseUndeterminedChange', 'inRemovalTurn', 'walletCredential', 'didCredential', 'walletIndex', 'didIndex',
      'recordUnconfirmed', 'refuseCredentialTurn', 'logValue', 'REMOVE_AGAIN',
      `return (${executable.slice(handler, end)}\n});`)(
      async () => ({ id: userId }), commit, withIdentityPodMutex, deleteUserCompletely, log,
      authMethodsCache, sendAccountWriteRefusal, refuseRemoval, AuthMethodsWriteError, changeOnPod, refuseUndeterminedChange,
      inRemovalTurn, (a: string) => `wallet:${a.toLowerCase()}`, (d: string) => `did:${d}`, listsOwner, listsOwner,
      unexpected('recordUnconfirmed'), unexpected('refuseCredentialTurn'), (v: unknown) => JSON.stringify(v), 'Send it again.',
    );
    const response = { statusCode: 200, headersSent: false, body: null as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; this.headersSent = true; return this; },
    };
    return { response, run: (params = {}, body = {}) => run({ params, body }, response) as Promise<void> };
  };
  const root = `https://css.test/${userId}/`;
  // Listings of the pod (the purge lists it before it closes anything).
  let listings = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      await beforeDelete();
      if (failingDeletes > 0) { failingDeletes--; return new Response(null, { status: 500 }); }
      deletions.push(url);
      if (url === root + 'checkpoint') checkpoint = false;
      if (url === root + 'auth-methods.jsonld') document = null;
      return new Response(null, { status: 205 });
    }
    listings++;
    return new Response(`<${root}> ldp:contains <${root}checkpoint>, <${root}auth-methods.jsonld>.`);
  }) as typeof fetch;
  // The janitor's purge, exactly as server.ts makes it (purgePlayOwner): the account is closed (its
  // tombstone, marked as a purge not yet finished, written on the ETag of the record checked) before
  // anything is deleted, the mark is cleared once everything else is, and the record stays.
  const janitorLog: string[] = [];
  const unfinishedPlayPurges = new Set<string>();
  const playPurgesInFlight = new Set<string>();
  const finishPlayPurge = new Function('applyUpdate', 'NoWrite', 'Write', 'isTombstone', 'authMethodsCache', 'removeFromIndexes',
    `${productionFunction('finishPlayPurge')}; return finishPlayPurge;`)(
    applyUpdate, NoWrite, Write, isTombstone, authMethodsCache, () => {});
  const purgePlayOwner = new Function('withIdentityPodMutex', 'purgeProvisionalPlayPod', 'CSS_URL', 'deleteUserCompletely',
    'playOwnerPurgeable', 'unfinishedPlayPurges', 'finishPlayPurge', 'log', 'awaitsGuestRetry', 'playPurgesInFlight',
    `${productionFunction('purgePlayOwner')}; return purgePlayOwner;`)(
    withIdentityPodMutex, (o: Parameters<typeof purgeProvisionalPlayPod>[0]) => purgeProvisionalPlayPod({ ...o, fetcher }),
    'https://css.test/', deleteUserCompletely, playOwnerPurgeable, unfinishedPlayPurges, finishPlayPurge,
    (line: string) => { janitorLog.push(line); }, awaitsGuestRetry, playPurgesInFlight,
  ) as (owner: string) => Promise<void>;
  const cleanup = () => purgePlayOwner(userId);
  return {
    commit, authenticate, signIn, cleanup, control, deletions, janitorLog, unfinishedPlayPurges, unconfirmedPlayDeletions,
    get document() { return document; }, get cached() { return cached; },
    get checkpoint() { return checkpoint; }, get puts() { return puts; }, get installs() { return installs; },
    get openCalls() { return openCalls; }, get listings() { return listings; },
    set now(value: number) { now = value; },
    set beforePersist(value: () => Promise<void>) { beforePersist = value; },
    set beforeDelete(value: () => Promise<void>) { beforeDelete = value; },
    set failingDeletes(value: number) { failingDeletes = value; },
    set duringVerification(value: () => Promise<void>) { duringVerification = value; },
    set duringAccountDelete(value: () => Promise<void>) { duringAccountDelete = value; },
    /** An edit by another writer (the other instance, an operator): the ETag moves on. */
    outOfBand(edit: (m: Methods) => void) { edit(document!); version++; },
  };
}
const enroll = (m: Methods) => { m.webAuthnCredentials.push({ id: 'verified-passkey' }); };

test('cleanup waits for an in-flight enrollment and cannot delete an acknowledged character', async () => {
  const f = fixture();
  const started = deferred(), release = deferred();
  f.beforePersist = async () => { started.resolve(); await release.promise; };
  let acknowledged = false;
  const enrollment = f.commit(userId, 'webauthn-register', enroll).then(() => { acknowledged = true; });
  await started.promise;
  f.now = 20;
  const cleanup = f.cleanup();
  await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.deepEqual(f.deletions, []);
  assert.deepEqual(f.cached!.webAuthnCredentials, []);
  release.resolve();
  await enrollment;
  await cleanup;
  assert.equal(acknowledged, true);
  assert.equal(f.checkpoint, true);
  assert.equal(f.document!.webAuthnCredentials[0].id, 'verified-passkey');
  assert.deepEqual(f.deletions, []);
});

test('cleanup that wins the lock cannot be followed by successful enrollment or pod resurrection', async () => {
  const f = fixture();
  f.now = 20;
  const started = deferred(), release = deferred();
  f.beforeDelete = async () => { started.resolve(); await release.promise; };
  const cleanup = f.cleanup();
  await started.promise;
  const enrollment = f.commit(userId, 'webauthn-register', enroll);
  const rejected = assert.rejects(enrollment, AccountDeletedError);
  release.resolve();
  await cleanup;
  await rejected;
  // The record is the tombstone, written once, and stays: it used to be deleted, and a write still
  // pending on its ETag could then re-create the owner (CSS 7.2 applies If-Match to a missing document).
  assert.equal(typeof f.document!.deletedAt, 'string');
  assert.equal(hasAnyCredential(f.document!), false);
  assert.equal(f.document!.provisionalPlayAnchor, undefined);
  assert.equal(f.checkpoint, false);
  // The tombstone marked as a purge not yet finished, then, once the checkpoint is deleted, the same
  // tombstone without the mark: nothing else, and nothing that lists a credential.
  assert.equal(f.puts, 2, 'the tombstone, and the same one once the purge is finished');
  assert.equal(f.document!.provisionalPlayPurgePending, undefined, 'a finished purge leaves no mark');
  assert.equal(f.unfinishedPlayPurges.size, 0);
  assert.equal(f.deletions.includes(`https://css.test/${userId}/auth-methods.jsonld`), false);
});

test('a purge whose deletion fails stays open for the next pass: the account is closed and its tombstone marked, and the next pass deletes the rest and clears the mark', async () => {
  const f = fixture();
  f.now = 20;
  f.failingDeletes = 1;
  await f.cleanup();
  assert.equal(f.checkpoint, true, 'the pod refused the DELETE');
  assert.equal(typeof f.document!.deletedAt, 'string', 'the account is closed');
  assert.equal(f.document!.provisionalPlayPurgePending, true, 'its tombstone says the purge is unfinished, for a restart');
  assert.deepEqual([...f.unfinishedPlayPurges], [userId], 'and the janitor comes back to it at its next pass');
  assert.match(f.janitorLog.join('\n'), /purge of u-try-play-1+ unfinished/);
  assert.doesNotMatch(f.janitorLog.join('\n'), /kept/, 'an owner closed is not logged as kept');
  // It used to forget the owner once it was closed, and the checkpoint stayed for good.
  const puts = f.puts;
  await f.cleanup();
  assert.equal(f.checkpoint, false);
  assert.equal(f.puts, puts + 1, 'the account is not closed again: only the mark is cleared');
  assert.equal(f.document!.provisionalPlayPurgePending, undefined);
  assert.equal(typeof f.document!.deletedAt, 'string');
  assert.equal(f.unfinishedPlayPurges.size, 0);
  // Each pass sends a DELETE only to what it listed (this pod lists no agent registry): a purge
  // used to send the deletion's own registry DELETE first at every pass, on top of its listing's.
  assert.deepEqual(f.deletions, [`https://css.test/${userId}/checkpoint`]);
});

test('a pass that starts while an owner\'s purge hangs queues no purge of its own: the one purge lists the pod and sends its DELETEs, and nothing logs the owner forgotten', async () => {
  // Every janitor pass calls purgePlayOwner for each owner in unfinishedPlayPurges, which a purge
  // enters before its DELETEs. A pass that started while one hung used to queue another purge of
  // the same owner behind it on the owner's lock, one a pass: each listed the pod and sent its
  // DELETEs again, and one that ran after the purge had finished logged that it forgot the owner.
  const f = fixture();
  f.now = 20;
  // The purge's first DELETE is not answered until `answer`, and then fails (a 5xx after a hang).
  const sent = deferred(), answer = deferred();
  let held = false;
  f.beforeDelete = async () => { if (held) return; held = true; sent.resolve(); await answer.promise; };
  f.failingDeletes = 1;
  const purge = f.cleanup();
  await sent.promise;
  assert.deepEqual([...f.unfinishedPlayPurges], [userId], 'every pass from now on walks the owner');
  // Two passes start while the DELETE hangs.
  let waiting = 2;
  const passes = [f.cleanup(), f.cleanup()].map(p => p.then(() => { waiting--; }));
  await new Promise(resolve => setImmediate(resolve));
  const queued = waiting;
  answer.resolve();
  await Promise.all([purge, ...passes]);
  assert.equal(queued, 0, 'a pass queued a purge of the owner behind the one in flight');
  assert.equal(f.listings, 1, 'the pod is listed by the one purge');
  assert.deepEqual(f.deletions, [], 'its DELETE failed, and no other purge sent it again');
  assert.equal(f.document!.provisionalPlayPurgePending, true, 'the purge is unfinished');
  const log = f.janitorLog.join('\n');
  assert.equal(log.match(/not queuing another purge of u-try-play-1+/g)?.length, 2, log);
  assert.match(log, /purge of u-try-play-1+ unfinished/);
  assert.doesNotMatch(log, /forgot/);
  // The purge that failed let go of the owner: the first pass after it takes the owner up again, and finishes it.
  await f.cleanup();
  assert.equal(f.listings, 2);
  assert.deepEqual(f.deletions, [`https://css.test/${userId}/checkpoint`]);
  assert.equal(f.document!.provisionalPlayPurgePending, undefined);
  assert.equal(f.unfinishedPlayPurges.size, 0);
  assert.doesNotMatch(f.janitorLog.join('\n'), /forgot/);
});

test('a deletion\'s tombstone is not purged: its owner may be provisioned again over it until its guest deadline, so the janitor only forgets it', async () => {
  // The guest deleted the owner through the other instance, its anchor still open (now 0 < 10).
  // That instance's provisioning does not wait for this server's lock, so a purge here could
  // delete the resources of the owner provisioned again meanwhile. It used to be purged.
  const f = fixture();
  f.outOfBand(m => { delete m.provisionalPlayAnchor; m.sessionEpoch = 1; m.deletedAt = '2026-10-28'; });
  const puts = f.puts;
  await f.cleanup();
  assert.equal(f.checkpoint, true);
  assert.deepEqual(f.deletions, [], 'nothing of the pod is deleted, its agent registry included');
  assert.equal(f.puts, puts, 'and nothing is written');
  assert.equal(f.unfinishedPlayPurges.size, 0);
  assert.match(f.janitorLog.join('\n'), /forgot u-try-play-1+/);
});

test('a guest\'s deletion answered 503 (not confirmed) is left to the guest\'s retry until its guest deadline, and finished by the janitor after it', async () => {
  // The route answered the guest's deletion 503: the pod holds its tombstone, and nothing settled it.
  // The janitor's purge used to find that tombstone unmarked and only forget the owner, so the retry
  // was refused and the agent registry stayed on the pod.
  const f = fixture();
  f.outOfBand(m => { delete m.provisionalPlayAnchor; m.sessionEpoch = 1; m.deletedAt = '2026-10-28'; });
  f.unconfirmedPlayDeletions.set(userId, Date.now() + 60_000);
  const puts = f.puts;
  await f.cleanup();
  assert.deepEqual(f.deletions, [], 'nothing is deleted before the guest deadline');
  assert.ok(f.cached?.deletedAt, 'and the owner is not forgotten: its retry finishes the deletion');
  assert.match(f.janitorLog.join('\n'), /left u-try-play-1+ to its guest's retry/);
  // The deadline passes without a retry: the janitor finishes the deletion as the retry would have.
  f.unconfirmedPlayDeletions.set(userId, Date.now() - 1);
  await f.cleanup();
  assert.deepEqual(f.deletions, [`https://css.test/${userId}/agents`], 'its agent registry is deleted, and nothing else');
  assert.equal(f.checkpoint, true);
  assert.equal(f.cached, null, 'the owner is forgotten');
  assert.equal(f.puts, puts, 'nothing is written over the tombstone');
  assert.equal(f.unconfirmedPlayDeletions.size, 0);
  assert.match(f.janitorLog.join('\n'), /finished the deletion of u-try-play-1+/);
});

test('a failed durable enrollment never exposes a credential through cache or success', async () => {
  const f = fixture();
  f.beforePersist = async () => { throw new Error('Pod unavailable'); };
  await assert.rejects(f.commit(userId, 'webauthn-register', enroll), /Pod unavailable/);
  assert.deepEqual(f.cached!.webAuthnCredentials, []);
  assert.deepEqual(f.document!.webAuthnCredentials, []);
});

test('an expired unclaimed anchor cannot be promoted even before cleanup runs', async () => {
  const f = fixture();
  f.now = 20;
  await assert.rejects(f.commit(userId, 'webauthn-register', enroll), /Provisional owner unavailable/);
  assert.equal(f.puts, 0);
  assert.equal(f.checkpoint, true);
});

test('a durable permanent owner in the guest namespace can add a credential after guest expiry', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  f.now = 20;
  await f.commit(userId, 'did-add-did', m => { m.didKeys.push({ did: 'did:key:verified' }); });
  assert.equal(f.openCalls, 1);
  assert.equal(f.document!.didKeys[0].did, 'did:key:verified');
  await f.cleanup();
  assert.equal(f.checkpoint, true);
});

test('enrolment is synchronous: a canonical account\'s credential is acknowledged only once the pod has it', async () => {
  const f = fixture();
  const started = deferred(), release = deferred();
  f.beforePersist = async () => { started.resolve(); await release.promise; };
  let acknowledged = false;
  const enrollment = f.commit('u-pk-canonical', 'webauthn-register', enroll).then(() => { acknowledged = true; });
  await started.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(acknowledged, false);
  assert.deepEqual(f.cached!.webAuthnCredentials, [], 'nothing is installed before the write lands');
  release.resolve();
  await enrollment;
  assert.equal(f.puts, 1);
  assert.equal(f.document!.webAuthnCredentials[0].id, 'verified-passkey');
  assert.equal(f.cached!.webAuthnCredentials[0].id, 'verified-passkey');
  f.beforePersist = async () => {};
  await f.commit('u-pk-canonical', 'wallet-link', m => { m.walletAddresses.push('0xverified'); });
  assert.equal(f.puts, 2);
  assert.deepEqual(f.document!.walletAddresses, ['0xverified']);
  // A change nothing needs writes nothing.
  await f.commit('u-pk-canonical', 'wallet-link', m => m.walletAddresses.includes('0xverified') ? false : undefined);
  assert.equal(f.puts, 2);
});

test('a canonical write meeting another writer\'s change re-reads and keeps both', async () => {
  const f = fixture();
  f.beforePersist = async () => {
    f.beforePersist = async () => {};
    f.outOfBand(m => { m.didKeys.push({ did: 'did:key:out-of-band' }); });
  };
  await f.commit('u-pk-canonical', 'wallet-link', m => { m.walletAddresses.push('0xverified'); });
  assert.equal(f.puts, 2);
  assert.deepEqual(f.document!.walletAddresses, ['0xverified']);
  assert.deepEqual(f.document!.didKeys, [{ did: 'did:key:out-of-band' }]);
});

test('a Play owner\'s write meeting another writer\'s change re-reads and keeps both, as a canonical account\'s does', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  const puts = f.puts;
  f.beforePersist = async () => {
    f.beforePersist = async () => {};
    f.outOfBand(m => { m.didKeys.push({ did: 'did:key:out-of-band' }); });
  };
  await f.commit(userId, 'siwe-add-wallet', m => { m.walletAddresses.push('0xverified'); });
  assert.equal(f.puts - puts, 2, 'a stale write refused, then one built on the new record');
  assert.deepEqual(f.document!.walletAddresses, ['0xverified']);
  assert.deepEqual(f.document!.didKeys, [{ did: 'did:key:out-of-band' }]);
  assert.deepEqual(f.cached!.walletAddresses, ['0xverified']);
  // The guard is checked again on the record read after the 412: an unclaimed owner whose anchor
  // expired meanwhile is refused at the second attempt, and nothing is written.
  const g = fixture();
  g.beforePersist = async () => {
    g.beforePersist = async () => {};
    g.now = 20;
    g.outOfBand(m => { m.sessionEpoch = 9; });
  };
  const before = g.puts;
  await assert.rejects(g.commit(userId, 'webauthn-register', enroll), /Provisional owner unavailable/);
  assert.equal(g.puts - before, 1);
  assert.deepEqual(g.document!.webAuthnCredentials, []);
});

test('passkey authentication cannot overwrite a concurrently acknowledged enrollment', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  const started = deferred(), release = deferred();
  f.duringVerification = async () => { started.resolve(); await release.promise; };
  const authentication = f.authenticate(userId, { id: 'verified-passkey' }, 'challenge', 'identity.test', 'https://identity.test');
  await started.promise;
  let acknowledged = false;
  const enrollment = f.commit(userId, 'siwe-add-wallet', m => { m.walletAddresses.push('0xverified'); })
    .then(() => { acknowledged = true; });
  await Promise.resolve();
  assert.equal(acknowledged, false);
  release.resolve();
  await authentication;
  await enrollment;
  assert.equal(acknowledged, true);
  assert.equal(f.document!.webAuthnCredentials[0].counter, 1);
  assert.deepEqual(f.document!.walletAddresses, ['0xverified']);
  // An authentication that starts after enrollment reads its durable addition.
  f.duringVerification = async () => {};
  await f.authenticate(userId, { id: 'verified-passkey' }, 'next-challenge', 'identity.test', 'https://identity.test');
  assert.equal(f.document!.webAuthnCredentials[0].counter, 2);
  assert.deepEqual(f.document!.walletAddresses, ['0xverified']);
});

test('a passkey sign-in that meets another writer\'s change re-runs its check and still signs in', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  let edited = false;
  f.duringVerification = async () => {
    if (edited) return;
    edited = true;
    f.outOfBand(m => { m.walletAddresses.push('0xother-instance'); });
  };
  const outcome = await f.signIn([userId], { id: 'verified-passkey' }, 'challenge', 'identity.test', 'https://identity.test');
  assert.equal(outcome.kind, 'signed-in', JSON.stringify(outcome));
  assert.equal(f.document!.webAuthnCredentials[0].counter, 1);
  assert.deepEqual(f.document!.walletAddresses, ['0xother-instance']);
});

test('credential removal and session revocation retain concurrent enrollment and passkey counters', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  await f.commit(userId, 'wallet-link', m => { m.walletAddresses.push('0xold'); });
  const started = deferred(), release = deferred();
  f.duringVerification = async () => { started.resolve(); await release.promise; };
  const authentication = f.authenticate(userId, { id: 'verified-passkey' }, 'challenge', 'identity.test', 'https://identity.test');
  await started.promise;
  const signOut = f.control('post', '/tokens/me/sign-out-everywhere');
  const remove = f.control('delete', '/auth-methods/me/wallet/:address');
  const revocation = signOut.run();
  const removal = remove.run({ address: '0xold' });
  const enrollment = f.commit(userId, 'did-add-did', m => { m.didKeys.push({ did: 'did:key:new' }); });
  release.resolve();
  await Promise.all([authentication, revocation, removal, enrollment]);
  assert.equal(signOut.response.statusCode, 200);
  assert.equal(remove.response.statusCode, 200);
  assert.equal(f.document!.sessionEpoch, 1);
  assert.equal(f.document!.webAuthnCredentials[0].counter, 1);
  assert.deepEqual(f.document!.walletAddresses, []);
  assert.deepEqual(f.document!.didKeys, [{ did: 'did:key:new' }]);
});

test('sign-out raises the epoch above both the pod\'s and this server\'s copy\'s', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  // This server's copy says 4 (it checked tokens against 4); the pod says 2.
  await f.commit(userId, 'sign-out-everywhere', m => { m.sessionEpoch = 4; });
  f.outOfBand(m => { m.sessionEpoch = 2; });
  const signOut = f.control('post', '/tokens/me/sign-out-everywhere');
  await signOut.run();
  assert.equal(signOut.response.statusCode, 200, JSON.stringify(signOut.response.body));
  assert.equal(f.document!.sessionEpoch, 5);
});

test('concurrent credential removals re-evaluate the last-method guard inside the lock', async () => {
  const f = fixture();
  await f.commit(userId, 'webauthn-register', enroll);
  await f.commit(userId, 'wallet-link', m => { m.walletAddresses.push('0xold'); });
  const passkey = f.control('delete', '/auth-methods/me/webauthn/:credentialId');
  const wallet = f.control('delete', '/auth-methods/me/wallet/:address');
  await Promise.all([passkey.run({ credentialId: 'verified-passkey' }), wallet.run({ address: '0xold' })]);
  assert.deepEqual([passkey.response.statusCode, wallet.response.statusCode].sort(), [200, 409]);
  assert.equal(hasAnyCredential(f.document!), true);
});

test('self-deletion waits for an in-flight enrollment and later mutations cannot recreate it', async () => {
  const f = fixture();
  const started = deferred(), release = deferred();
  f.beforePersist = async () => { started.resolve(); await release.promise; };
  const enrollment = f.commit(userId, 'webauthn-register', enroll);
  await started.promise;
  const deletion = f.control('post', '/users/me/delete');
  const deleted = deletion.run();
  await Promise.resolve();
  assert.equal(deletion.response.headersSent, false);
  release.resolve();
  await enrollment;
  await deleted;
  assert.equal(deletion.response.statusCode, 200);
  // The deletion ran after the enrolment and closed the account over it: the record is its
  // tombstone (no credential, no anchor), which stays on the pod.
  assert.equal(typeof f.document!.deletedAt, 'string');
  assert.equal(hasAnyCredential(f.document!), false);
  const after = structuredClone(f.document);
  const puts = f.puts;
  await assert.rejects(f.commit(userId, 'did-add-did', m => { m.didKeys.push({ did: 'did:key:late' }); }),
    AccountDeletedError);
  // Nor does a sign-out write anything over it.
  const signOut = f.control('post', '/tokens/me/sign-out-everywhere');
  await signOut.run();
  assert.equal(signOut.response.statusCode, 409, JSON.stringify(signOut.response.body));
  assert.deepEqual(f.document, after);
  assert.equal(f.puts, puts);
});

test('a read never creates a document, for any id', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const podFetch = async (url: string, init?: { method?: string }) => {
    requests.push({ url, method: init?.method ?? 'GET' });
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', headers: { get: () => null } };
  };
  const readLive = new Function('readPodJsonWithEtag', 'recordFetch', 'podAuthMethodsUrl', 'normaliseAuthMethods',
    `${productionFunction('readLive')}; return readLive;`)(
    readPodJsonWithEtag, podFetch, (owner: string) => `https://css.test/${owner}/auth-methods.jsonld`, (value: unknown) => value,
  ) as (owner: string) => Promise<{ methods: unknown }>;
  for (const owner of [userId, 'u-pk-canonical', 'u-eth-000000000000', 'markj']) {
    assert.equal((await readLive(owner)).methods, null, owner);
  }
  assert.deepEqual([...new Set(requests.map(r => r.method))], ['GET']);
  assert.equal(requests.length, 4);
  // No route reaches a function that creates a document on a read any more.
  assert.doesNotMatch(server, /createIfMissing/);
});

test('all four credential routes await the shared commit before acknowledging enrollment', () => {
  for (const route of ['/auth/siwe', '/auth/webauthn/register', '/auth/did', '/wallet/link']) {
    const start = server.indexOf(`app.post('${route}',`);
    assert.ok(start >= 0, route);
    const source = server.slice(start, server.indexOf('\n});', start));
    assert.match(source, /await commitCredentialEnrollment\(/, route);
    const commitOffset = source.indexOf('await commitCredentialEnrollment(');
    assert.ok(source.indexOf('res.json(', commitOffset) > commitOffset, `${route} acknowledges after commit`);
    assert.match(source.slice(commitOffset), /catch \(err\)[\s\S]*?res\.status\((503|500)\)[\s\S]*?return;/, route);
  }
});
