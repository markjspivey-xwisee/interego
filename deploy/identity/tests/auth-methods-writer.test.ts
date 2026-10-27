/**
 * The write of an account's auth-methods.jsonld (auth-methods-writer.ts) and the lock and reads
 * around it in server.ts, without starting the server: the module's dependencies are stand-ins
 * over one in-memory pod document with ETags, and the server's lock, refresh and loader are
 * rebuilt from its source with stand-ins for what they reach (as provisional-play-enrollment
 * does).
 *
 * Run:
 *   node --test --import tsx tests/auth-methods-writer.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import {
  AccountDeletedError, AccountRecordMissingError, AuthMethodsConflictError, AuthMethodsWriteError, NoWrite,
  PlayOwnerUnavailableError, PodLockReentryError, Write, applyUpdate, unknownTopLevelKeys, updateAuthMethods,
  type LiveRecord, type WritePrecondition, type WriterDeps,
} from '../auth-methods-writer.js';

type Record_ = {
  userId: string; name?: string; walletAddresses: string[]; webAuthnCredentials: Array<{ id: string; counter: number }>;
  didKeys: Array<{ did: string }>; sessionEpoch?: number; deletedAt?: string; provisionalPlayAnchor?: string;
};
const empty = (userId: string): Record_ => ({ userId, walletAddresses: [], webAuthnCredentials: [], didKeys: [] });
const hasAnyCredential = (m: Record_) => m.walletAddresses.length + m.webAuthnCredentials.length + m.didKeys.length > 0;

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const strip = (nodeModule as { stripTypeScriptTypes?: (source: string) => string }).stripTypeScriptTypes;
const executable = strip ? strip(server) : (await import('typescript')).default.transpileModule(server, {
  compilerOptions: { target: 9, module: 99 },
}).outputText;
function productionFunction(name: string, isAsync = true): string {
  const start = executable.search(new RegExp(`${isAsync ? 'async ' : '(?<!async )'}function ${name}\\s*\\(`));
  assert.ok(start >= 0, `Production function ${name} exists`);
  const end = executable.indexOf('\n}', start);
  return executable.slice(start, end + 2);
}

/** server.ts's lock: withIdentityPodMutex and assertLockHeld over their own context. */
function serverLock() {
  const podLockContext = new AsyncLocalStorage<ReadonlyMap<string, { held: boolean }>>();
  const lock = new Function('podLockContext', 'PodLockReentryError', `const identityPodWriteMutexes = new Map();
    ${productionFunction('withIdentityPodMutex')}; return withIdentityPodMutex;`)(podLockContext, PodLockReentryError) as
    <T>(userId: string, fn: () => Promise<T>) => Promise<T>;
  const assertLockHeld = new Function('podLockContext',
    `${productionFunction('assertLockHeld', false)}; return assertLockHeld;`)(podLockContext) as (userId: string) => void;
  return { podLockContext, lock, assertLockHeld };
}

/** One account's pod, with an ETag per version, and the module's dependencies over it. */
function pod(initial: (Record_ & Record<string, unknown>) | null, userId = 'u-pk-000000000001') {
  let doc: (Record_ & Record<string, unknown>) | null = initial ? structuredClone(initial) : null;
  let version = 1;
  const log: string[] = [];
  const installed: Record_[] = [];
  let expired = 0;
  let readFailures = 0;
  let writeFailures = 0;
  let applyThenFail = false;
  let beforeWrite: (() => void) | null = null;
  const deleted = new Set<string>();
  let anchorOpens = true;
  const { lock, assertLockHeld } = serverLock();
  const deps: WriterDeps<Record_> = {
    lock, assertLockHeld,
    readLive: async (): Promise<LiveRecord<Record_>> => {
      log.push('GET');
      if (readFailures > 0) { readFailures--; throw new Error('pod unreadable'); }
      if (!doc) return { methods: null, raw: null, etag: null };
      // What server.ts's normaliseAuthMethods keeps: the keys it reads, never the others.
      const { userId: id, walletAddresses, webAuthnCredentials, didKeys, sessionEpoch, deletedAt, provisionalPlayAnchor } = structuredClone(doc);
      const methods: Record_ = { userId: id, walletAddresses, webAuthnCredentials, didKeys,
        ...(sessionEpoch !== undefined ? { sessionEpoch } : {}), ...(deletedAt ? { deletedAt } : {}),
        ...(provisionalPlayAnchor ? { provisionalPlayAnchor } : {}) };
      return { methods, raw: structuredClone(doc), etag: `"${version}-application/ld+json"` };
    },
    writeLive: async (_id, written: Record_, pre: WritePrecondition) => {
      log.push(`PUT ${pre.kind}${pre.kind === 'match' ? ` ${pre.etag}` : ''}`);
      beforeWrite?.();
      if (writeFailures > 0) {
        writeFailures--;
        if (applyThenFail) { doc = structuredClone(written) as typeof doc; version++; }
        throw new AuthMethodsWriteError('PUT failed: 500', true);
      }
      if (pre.kind === 'absent' && doc) return 'precondition-failed';
      if (pre.kind === 'match' && pre.etag !== `"${version}-application/ld+json"`) return 'precondition-failed';
      doc = structuredClone(written) as typeof doc;
      version++;
      return 'ok';
    },
    install: (_id, m) => { installed.push(structuredClone(m)); },
    expire: () => { expired++; },
    isDeleted: id => deleted.has(id),
    isTombstone: m => typeof m.deletedAt === 'string',
    empty,
    playGuard: (_id, m) => hasAnyCredential(m) || anchorOpens,
  };
  return {
    deps, userId, log, installed, deleted,
    get doc() { return doc; },
    get expired() { return expired; },
    /** Another writer's change (the other instance, an operator): the ETag moves on. */
    outOfBand(edit: (m: Record_) => void) { edit(doc!); version++; },
    failReads(n: number) { readFailures = n; },
    failWrites(n: number, applied = false) { writeFailures = n; applyThenFail = applied; },
    set beforeWrite(fn: (() => void) | null) { beforeWrite = fn; },
    set anchorOpens(v: boolean) { anchorOpens = v; },
  };
}
const account = (userId = 'u-pk-000000000001'): Record_ =>
  ({ ...empty(userId), webAuthnCredentials: [{ id: 'p1', counter: 3 }], walletAddresses: ['0xaaa'] });
const addWallet = (w: string) => (draft: Record_) => {
  if (draft.walletAddresses.includes(w)) return NoWrite('listed');
  draft.walletAddresses.push(w);
  return Write;
};

test('a read that fails writes nothing and installs nothing', async () => {
  const p = pod(account());
  p.failReads(1);
  await assert.rejects(updateAuthMethods(p.deps, p.userId, 'test', addWallet('0xbbb')), /pod unreadable/);
  assert.deepEqual(p.log, ['GET']);
  assert.deepEqual(p.installed, []);
  assert.deepEqual(p.doc!.walletAddresses, ['0xaaa']);
});

test('a delta that writes nothing installs the record as read and sends no write', async () => {
  const p = pod(account());
  const r = await updateAuthMethods(p.deps, p.userId, 'test', addWallet('0xaaa'));
  assert.deepEqual(r, { written: false, reason: 'listed' });
  assert.deepEqual(p.log, ['GET']);
  assert.deepEqual(p.installed, [account()]);
});

test('a write is conditional on the ETag read, and installs exactly what was written, once', async () => {
  const p = pod(account());
  let live: Readonly<Record_> | null = null;
  const r = await updateAuthMethods(p.deps, p.userId, 'test', (draft, read) => {
    live = read;
    draft.walletAddresses.push('0xbbb');
    return Write;
  });
  assert.equal(r.written, true);
  assert.deepEqual(p.log, ['GET', 'PUT match "1-application/ld+json"']);
  assert.equal(p.installed.length, 1);
  assert.deepEqual(p.installed[0], p.doc);
  assert.deepEqual(p.doc!.walletAddresses, ['0xaaa', '0xbbb']);
  // The record handed to the delta is the one read, frozen: only the draft changes.
  assert.ok(Object.isFrozen(live) && Object.isFrozen(live!.walletAddresses));
  assert.deepEqual(live!.walletAddresses, ['0xaaa']);
  assert.throws(() => { (live!.walletAddresses as string[]).push('0xccc'); }, TypeError);
});

test('a write that fails is followed by a read, and what the pod holds then is installed', async () => {
  // The store applied the write and answered 500: this server's copy must be the new record.
  const applied = pod(account());
  applied.failWrites(1, true);
  await assert.rejects(updateAuthMethods(applied.deps, applied.userId, 'test', addWallet('0xbbb')), AuthMethodsWriteError);
  assert.deepEqual(applied.log, ['GET', 'PUT match "1-application/ld+json"', 'GET']);
  assert.deepEqual(applied.installed, [applied.doc]);
  assert.deepEqual(applied.installed[0]!.walletAddresses, ['0xaaa', '0xbbb']);
  // It did not apply it: the copy is the old record.
  const refused = pod(account());
  refused.failWrites(1);
  await assert.rejects(updateAuthMethods(refused.deps, refused.userId, 'test', addWallet('0xbbb')), AuthMethodsWriteError);
  assert.deepEqual(refused.installed, [account()]);
  // And when that read fails too, the copy is marked stale rather than trusted.
  const blind = pod(account());
  blind.failWrites(1);
  blind.beforeWrite = () => { blind.failReads(1); };
  await assert.rejects(updateAuthMethods(blind.deps, blind.userId, 'test', addWallet('0xbbb')), AuthMethodsWriteError);
  assert.deepEqual(blind.installed, []);
  assert.equal(blind.expired, 1);
});

test('a precondition failure re-reads and re-runs the delta on the new record, and gives up after three', async () => {
  const p = pod(account());
  let runs = 0;
  let edits = 0;
  p.beforeWrite = () => { if (edits++ === 0) p.outOfBand(m => { m.didKeys.push({ did: 'did:key:other' }); }); };
  await updateAuthMethods(p.deps, p.userId, 'test', draft => { runs++; draft.walletAddresses.push('0xbbb'); return Write; });
  assert.equal(runs, 2);
  assert.deepEqual(p.doc!.didKeys, [{ did: 'did:key:other' }]);
  assert.deepEqual(p.doc!.walletAddresses, ['0xaaa', '0xbbb']);
  assert.deepEqual(p.installed, [p.doc]);

  const busy = pod(account());
  busy.beforeWrite = () => { busy.outOfBand(m => { m.sessionEpoch = (m.sessionEpoch ?? 0) + 1; }); };
  await assert.rejects(updateAuthMethods(busy.deps, busy.userId, 'test', addWallet('0xbbb')), AuthMethodsConflictError);
  assert.equal(busy.log.filter(l => l === 'GET').length, 3);
  assert.deepEqual(busy.installed, []);
  assert.deepEqual(busy.doc!.walletAddresses, ['0xaaa']);
});

test('a delta that runs again after a precondition failure resets what it recorded and answers the same', async () => {
  const p = pod(account());
  let edits = 0;
  p.beforeWrite = () => { if (edits++ === 0) p.outOfBand(m => { m.walletAddresses.push('0xzzz'); }); };
  let previous = -1;
  let next = -1;
  await updateAuthMethods(p.deps, p.userId, 'sign-out', draft => {
    previous = draft.sessionEpoch ?? 0;
    next = previous + 1;
    draft.sessionEpoch = next;
    return Write;
  });
  assert.equal(previous, 0);
  assert.equal(next, 1);
  assert.equal(p.doc!.sessionEpoch, 1);
  assert.deepEqual(p.doc!.walletAddresses, ['0xaaa', '0xzzz']);
});

test('no document: refused (installed as empty), created with If-None-Match, or passed to the delta', async () => {
  const refuse = pod(null);
  await assert.rejects(updateAuthMethods(refuse.deps, refuse.userId, 'test', addWallet('0xbbb')), AccountRecordMissingError);
  assert.deepEqual(refuse.log, ['GET']);
  assert.deepEqual(refuse.installed, [empty(refuse.userId)]);

  const create = pod(null);
  await updateAuthMethods(create.deps, create.userId, 'test', addWallet('0xbbb'), { absent: 'create' });
  assert.deepEqual(create.log, ['GET', 'PUT absent']);
  assert.deepEqual(create.doc!.walletAddresses, ['0xbbb']);

  const pass = pod(null);
  let seen: unknown = 'not called';
  const r = await updateAuthMethods(pass.deps, pass.userId, 'test', (_draft, live) => { seen = live; return NoWrite('not-on-file'); }, { absent: 'pass' });
  assert.equal(seen, null);
  assert.deepEqual(r, { written: false, reason: 'not-on-file' });
  assert.deepEqual(pass.log, ['GET']);
});

test('a tombstone is refused (and installed) unless the write replaces it; a deleted account is refused before any read', async () => {
  const tomb = { ...empty('u-pk-000000000001'), sessionEpoch: 3, deletedAt: '2026-10-27' };
  const p = pod(tomb);
  await assert.rejects(updateAuthMethods(p.deps, p.userId, 'test', addWallet('0xbbb')), AccountDeletedError);
  assert.deepEqual(p.log, ['GET']);
  assert.deepEqual(p.installed, [tomb]);

  const replace = pod(account());
  replace.deleted.add(replace.userId);
  await assert.rejects(updateAuthMethods(replace.deps, replace.userId, 'test', addWallet('0xbbb')), AccountDeletedError);
  assert.deepEqual(replace.log, []);
  await updateAuthMethods(replace.deps, replace.userId, 'delete', draft => {
    for (const k of Object.keys(draft)) delete (draft as Record<string, unknown>)[k];
    Object.assign(draft, { ...empty(replace.userId), sessionEpoch: 1, deletedAt: '2026-10-27' });
    return Write;
  }, { tombstone: 'replace' });
  assert.equal(replace.doc!.deletedAt, '2026-10-27');
});

test('an unclaimed Play owner whose anchor no longer opens is refused, and a missing one is never re-created', async () => {
  const playId = `u-try-play-${'a'.repeat(32)}`;
  const p = pod({ ...empty(playId), provisionalPlayAnchor: 'expired' }, playId);
  p.anchorOpens = false;
  await assert.rejects(updateAuthMethods(p.deps, playId, 'test', addWallet('0xbbb')), PlayOwnerUnavailableError);
  assert.deepEqual(p.log, ['GET']);
  // Claimed (it holds a credential), it no longer depends on the anchor.
  const claimed = pod({ ...account(playId), provisionalPlayAnchor: 'expired' }, playId);
  claimed.anchorOpens = false;
  assert.equal((await updateAuthMethods(claimed.deps, playId, 'test', addWallet('0xbbb'))).written, true);
  // A purged owner: 'create' and 'pass' are refused all the same.
  for (const absent of ['create', 'pass'] as const) {
    const purged = pod(null, playId);
    await assert.rejects(updateAuthMethods(purged.deps, playId, 'test', addWallet('0xbbb'), { absent }), AccountRecordMissingError);
    assert.deepEqual(purged.log, ['GET'], absent);
  }
});

test('keys this server does not read are kept; a tombstone keeps none of them', async () => {
  const p = pod({ ...account(), 'ex:note': 'kept', otherTool: { a: 1 } });
  await updateAuthMethods(p.deps, p.userId, 'test', addWallet('0xbbb'));
  assert.equal(p.doc!['ex:note'], 'kept');
  assert.deepEqual(p.doc!['otherTool'], { a: 1 });
  await updateAuthMethods(p.deps, p.userId, 'delete', draft => {
    for (const k of Object.keys(draft)) delete (draft as Record<string, unknown>)[k];
    Object.assign(draft, { ...empty(p.userId), sessionEpoch: 1, deletedAt: '2026-10-27' });
    return Write;
  }, { tombstone: 'replace' });
  assert.equal(p.doc!['ex:note'], undefined);
  assert.equal(p.doc!['otherTool'], undefined);
  assert.deepEqual(unknownTopLevelKeys({ userId: 'x', walletAddresses: [], extra: 1 }), { extra: 1 });
  assert.deepEqual(unknownTopLevelKeys(null), {});
});

test('the lock-free core refuses to run outside the account\'s lock', async () => {
  const p = pod(account());
  await assert.rejects(applyUpdate(p.deps, p.userId, 'test', addWallet('0xbbb')), /lock is not held/);
  assert.deepEqual(p.log, []);
  await p.deps.lock(p.userId, () => applyUpdate(p.deps, p.userId, 'test', addWallet('0xbbb')));
  assert.deepEqual(p.doc!.walletAddresses, ['0xaaa', '0xbbb']);
  // Another account's lock is not this one's.
  await assert.rejects(p.deps.lock('u-pk-000000000002', () => applyUpdate(p.deps, p.userId, 'test', addWallet('0xccc'))), /lock is not held/);
});

test('asking for a lock this call already holds throws at once instead of waiting for itself', async () => {
  const { lock } = serverLock();
  const started = Date.now();
  await assert.rejects(lock('u-pk-1', () => lock('u-pk-1', async () => 'never')), PodLockReentryError);
  assert.ok(Date.now() - started < 1000);
  // Another account's lock nests; and the account's lock is free again afterwards.
  assert.equal(await lock('u-pk-1', () => lock('u-pk-2', async () => 'nested')), 'nested');
  assert.equal(await lock('u-pk-1', async () => 'free'), 'free');
});

test('work started inside a lock that takes the same lock after its release is not mistaken for re-entry', async () => {
  const { lock } = serverLock();
  let later!: Promise<string>;
  await lock('u-pk-1', async () => {
    later = new Promise<void>(resolve => setTimeout(resolve, 20)).then(() => lock('u-pk-1', async () => 'after release'));
  });
  assert.equal(await later, 'after release');
});

test('the lock serialises one account\'s holders in order, and an error does not stall the next', async () => {
  const { lock } = serverLock();
  const order: string[] = [];
  const a = lock('u-pk-1', async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('a'); throw new Error('a failed'); });
  const b = lock('u-pk-1', async () => { order.push('b'); });
  await assert.rejects(a, /a failed/);
  await b;
  assert.deepEqual(order, ['a', 'b']);
});

/** server.ts's refreshAuthMethods and readAuthMethods over a stand-in pod read. */
function serverReads(read: () => Promise<LiveRecord<Record_>>) {
  const { podLockContext, lock: serverLockFn } = serverLock();
  let lockTurns = 0;
  const lock = <T>(id: string, fn: () => Promise<T>) => { lockTurns++; return serverLockFn(id, fn); };
  const authMethodsCache = new Map<string, { value: Record_; fetchedAt: number }>();
  const recordGeneration = new Map<string, number>();
  const generationOf = (id: string) => recordGeneration.get(id) ?? 0;
  const installAuthMethods = (id: string, m: Record_) => {
    authMethodsCache.set(id, { value: m, fetchedAt: Date.now() });
    recordGeneration.set(id, generationOf(id) + 1);
    return m;
  };
  const refreshing = new Map();
  const deps = { podLockContext, PodLockReentryError, refreshing, generationOf, withIdentityPodMutex: lock,
    authMethodsCache, readLive: read, installAuthMethods, emptyAuthMethods: empty, AUTH_METHODS_TTL_MS: 10_000, log: () => {} };
  const names = Object.keys(deps);
  const build = new Function(...names, `${productionFunction('refreshAuthMethods', false)}
    ${productionFunction('readAuthMethods')}
    return { refreshAuthMethods, readAuthMethods };`);
  const fns = build(...names.map(n => (deps as Record<string, unknown>)[n])) as {
    refreshAuthMethods(id: string): Promise<Record_>;
    readAuthMethods(id: string, allowStale?: boolean): Promise<Record_>;
  };
  return { ...fns, lock, authMethodsCache, installAuthMethods, get lockTurns() { return lockTurns; } };
}

test('readers that find an account\'s copy stale share one pod read', async () => {
  let gets = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const r = serverReads(async () => { gets++; await held; return { methods: account(), raw: null, etag: null }; });
  r.authMethodsCache.set('u-pk-000000000001', { value: empty('u-pk-000000000001'), fetchedAt: 0 });
  const reads = Array.from({ length: 20 }, (_, i) => r.readAuthMethods('u-pk-000000000001', i % 2 === 0));
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await Promise.all(reads);
  assert.equal(gets, 1);
  // And one turn of the account's lock: a writer queues behind one refresh, not twenty.
  assert.equal(r.lockTurns, 1);
  assert.deepEqual((await r.readAuthMethods('u-pk-000000000001')).walletAddresses, ['0xaaa']);
  assert.equal(gets, 1);
});

test('a refresh queued behind a writer reuses what the writer installed instead of reading again', async () => {
  let gets = 0;
  const r = serverReads(async () => { gets++; return { methods: empty('u-pk-000000000001'), raw: null, etag: null }; });
  r.authMethodsCache.set('u-pk-000000000001', { value: empty('u-pk-000000000001'), fetchedAt: 0 });
  let holding!: () => void;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { holding = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const writer = r.lock('u-pk-000000000001', async () => {
    holding();
    await finished;
    r.installAuthMethods('u-pk-000000000001', account());
  });
  await held;
  // A reader outside the lock finds the copy stale and queues behind the writer.
  const refresh = r.readAuthMethods('u-pk-000000000001');
  finish();
  await writer;
  assert.deepEqual((await refresh).walletAddresses, ['0xaaa']);
  assert.equal(gets, 0);
});

test('a read of this server\'s copy inside the account\'s own lock is a bug, refused at once', async () => {
  const r = serverReads(async () => ({ methods: account(), raw: null, etag: null }));
  await assert.rejects(r.lock('u-pk-000000000001', () => r.refreshAuthMethods('u-pk-000000000001')), PodLockReentryError);
});

test('an unlocked load whose read an install overlapped reports the installed record and installs nothing', async () => {
  const recordGeneration = new Map<string, number>([['u-pk-000000000001', 1]]);
  const generationOf = (id: string) => recordGeneration.get(id) ?? 0;
  const authMethodsCache = new Map<string, { value: Record_; fetchedAt: number }>();
  const adopted: Record_[] = [];
  const hydrated: Record_[] = [];
  let releaseRead!: () => void;
  const reading = new Promise<void>(resolve => { releaseRead = resolve; });
  const deps = {
    generationOf, readPodJson: async () => { await reading; return account(); }, podFetch: null,
    podAuthMethodsUrl: (id: string) => id, deletedUserIds: new Set<string>(), authMethodsCache,
    isTombstone: (m: Record_) => typeof m.deletedAt === 'string', holdsAnAccount: (_id: string, m: Record_) => hasAnyCredential(m),
    hydrateFromAuthMethods: (_id: string, m: Record_) => { hydrated.push(m); },
    normaliseAuthMethods: (body: Record_) => body, adoptAccount: (_id: string, m: Record_) => { adopted.push(m); return true; },
  };
  const names = Object.keys(deps);
  const loadAccountFromPod = new Function(...names, `${productionFunction('loadAccountFromPod')}; return loadAccountFromPod;`)(
    ...names.map(n => (deps as Record<string, unknown>)[n])) as (id: string) => Promise<boolean>;
  // The read returns the record as it was before a writer (here: a removal of the wallet) installed.
  const load = loadAccountFromPod('u-pk-000000000001');
  const removed = { ...account(), walletAddresses: [] };
  authMethodsCache.set('u-pk-000000000001', { value: removed, fetchedAt: Date.now() });
  recordGeneration.set('u-pk-000000000001', 2);
  releaseRead();
  assert.equal(await load, true);
  assert.deepEqual(adopted, []);
  assert.deepEqual(hydrated, [removed]);
  // With nothing overlapping, the read is adopted.
  assert.equal(await loadAccountFromPod('u-pk-000000000001'), true);
  assert.equal(adopted.length, 1);
});
