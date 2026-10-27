import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { enrollProvisionalCredential } from '../provisional-play-enrollment.js';
import { purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const strip = (nodeModule as { stripTypeScriptTypes?: (source: string) => string }).stripTypeScriptTypes;
// The base-without-verticals gate also exercises the supported Node 20 runtime.
const executable = strip ? strip(server) : (await import('typescript')).default.transpileModule(server, {
  compilerOptions: { target: 9, module: 99 },
}).outputText;
function productionFunction(name: string): string {
  const start = executable.search(new RegExp(`async function ${name}\\s*\\(`));
  assert.ok(start >= 0, `Production function ${name} exists`);
  const end = executable.indexOf('\n}', start);
  assert.ok(end > start, `Production function ${name} ends at top-level`);
  return executable.slice(start, end + 2);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const userId = `u-try-play-${'1'.repeat(32)}`;
type Methods = {
  userId: string; provisionalPlayAnchor?: string;
  webAuthnCredentials: Array<{ id: string; counter?: number }>;
  walletAddresses: string[]; didKeys: Array<{ did: string }>;
  sessionEpoch?: number;
};
const hasAnyCredential = (m: Methods) => m.webAuthnCredentials.length + m.walletAddresses.length + m.didKeys.length > 0;
const empty = (): Methods => ({ userId, webAuthnCredentials: [], walletAddresses: [], didKeys: [] });

function fixture() {
  let document: Methods | null = { ...empty(), provisionalPlayAnchor: 'original-owner-anchor' };
  let cached = document;
  let now = 0;
  let checkpoint = true;
  let puts = 0;
  let inline = 0;
  let scheduled = 0;
  let openCalls = 0;
  const deletions: string[] = [];
  const withIdentityPodMutex = new Function(`const identityPodWriteMutexes = new Map();
    ${productionFunction('withIdentityPodMutex')}; return withIdentityPodMutex;`)() as
    <T>(owner: string, work: () => Promise<T>) => Promise<T>;
  let beforePersist: () => Promise<void> = async () => {};
  let beforeDelete: () => Promise<void> = async () => {};
  let duringVerification: () => Promise<void> = async () => {};
  let duringAccountDelete: () => Promise<void> = async () => {};
  const read = async () => document ? structuredClone(document) : empty();
  const persist = async (_owner: string, candidate: Methods) => {
    puts++;
    await beforePersist();
    document = structuredClone(candidate);
    cached = document;
  };
  const persistExistingAuthMethods = new Function('withIdentityPodMutex', 'putPodAuthMethods',
    `${productionFunction('persistExistingAuthMethods')}; return persistExistingAuthMethods;`)(withIdentityPodMutex, persist);
  const commit = new Function('enrollProvisionalCredential', 'withIdentityPodMutex', 'fetchPodAuthMethods',
    'hasAnyCredential', 'provisionalPlay', 'putPodAuthMethods', 'readAuthMethods',
    'inlineApplyAuthMethods', 'scheduleDeferredAuthMethodsWrite', 'isTombstone', 'AccountDeletedError', 'ACCOUNT_DELETED_MESSAGE',
    'deletedUserIds', 'persistExistingAuthMethods',
    `${productionFunction('commitCredentialEnrollment')}; return commitCredentialEnrollment;`)(
    enrollProvisionalCredential, withIdentityPodMutex, read, hasAnyCredential,
    { open(anchor: string) {
      openCalls++;
      if (anchor !== 'original-owner-anchor' || now >= 10) throw new Error('Provisional owner unavailable');
      return { userId };
    } }, persist, async () => cached,
    (_owner: string, methods: Methods) => { inline++; cached = methods; },
    () => { scheduled++; },
    (m: Methods & { deletedAt?: string }) => typeof m.deletedAt === 'string', Error, 'account deleted',
    new Set<string>(), persistExistingAuthMethods,
  ) as (owner: string, context: string, update: (m: Methods) => boolean | void, synchronous?: boolean) => Promise<void>;
  const authenticateHolder = new Function('withIdentityPodMutex', 'fetchPodAuthMethods', 'authenticatePasskey', 'putPodAuthMethods',
    'identityPendingPodWrites', 'authMethodsCache', 'deletedUserIds', 'rebuildIndexesForUser', 'publicKeyIdentity',
    `${productionFunction('authenticateHolderPasskey')}; return authenticateHolderPasskey;`)(
    withIdentityPodMutex, read,
    async ({ credential, persist }: { credential: { counter?: number }; persist: () => Promise<void> }) => {
      await duringVerification();
      credential.counter = (credential.counter ?? 0) + 1;
      await persist();
    }, persist, new Set<string>(), new Map(), new Set<string>(), () => {}, async (key: unknown) => String(key),
  ) as (owner: string, read: Methods, response: { id: string }, challenge: string, rpId: string, origin: string,
    triedKeys: Set<string>) => Promise<string>;
  // A Play owner's passkey sign-in, as the route runs it: the record is read under the lock.
  const authenticate = (owner: string, response: { id: string }, challenge: string, rpId: string, origin: string) =>
    authenticateHolder(owner, empty(), response, challenge, rpId, origin, new Set<string>());
  const control = (method: string, path: string) => {
    const start = executable.indexOf(`app.${method}('${path}',`);
    assert.ok(start >= 0, path);
    const handler = executable.indexOf('async (req, res) => {', start);
    const end = executable.indexOf('\n});', handler);
    const run = new Function('requireUserFromBearer', 'commitCredentialEnrollment', 'withIdentityPodMutex',
      'deleteUserCompletely', 'log',
      `return (${executable.slice(handler, end)}\n});`)(
      async () => ({ id: userId }), commit, withIdentityPodMutex,
      async () => { await duringAccountDelete(); document = null; cached = null; return { agents: [] }; },
      () => {},
    );
    const response = { statusCode: 200, headersSent: false, body: null as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; this.headersSent = true; return this; },
    };
    return { response, run: (params = {}, body = {}) => run({ params, body }, response) as Promise<void> };
  };
  const root = `https://css.test/${userId}/`;
  const cleanup = () => withIdentityPodMutex(userId, () => purgeProvisionalPlayPod({
    userId, cssUrl: 'https://css.test/',
    stillUnclaimed: async () => now >= 10 && !hasAnyCredential(await read()),
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') {
        await beforeDelete();
        deletions.push(url);
        if (url === root + 'checkpoint') checkpoint = false;
        if (url === root + 'auth-methods.jsonld') document = null;
        return new Response(null, { status: 205 });
      }
      return new Response(`<${root}> ldp:contains <${root}checkpoint>, <${root}auth-methods.jsonld>.`);
    }) as typeof fetch,
  }));
  return {
    commit, authenticate, cleanup, control, deletions,
    get document() { return document; }, get cached() { return cached; },
    get checkpoint() { return checkpoint; }, get puts() { return puts; },
    get inline() { return inline; }, get scheduled() { return scheduled; }, get openCalls() { return openCalls; },
    set now(value: number) { now = value; },
    set beforePersist(value: () => Promise<void>) { beforePersist = value; },
    set beforeDelete(value: () => Promise<void>) { beforeDelete = value; },
    set duringVerification(value: () => Promise<void>) { duringVerification = value; },
    set duringAccountDelete(value: () => Promise<void>) { duringAccountDelete = value; },
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
  const rejected = assert.rejects(enrollment, /Provisional owner unavailable/);
  release.resolve();
  await cleanup;
  await rejected;
  assert.equal(f.document, null);
  assert.equal(f.checkpoint, false);
  assert.equal(f.puts, 0);
});

test('a failed durable enrollment never exposes a credential through cache or success', async () => {
  const f = fixture();
  f.beforePersist = async () => { throw new Error('Pod unavailable'); };
  await assert.rejects(f.commit(userId, 'webauthn-register', enroll), /Pod unavailable/);
  assert.deepEqual(f.cached!.webAuthnCredentials, []);
  assert.deepEqual(f.document!.webAuthnCredentials, []);
  assert.equal(f.inline, 0);
  assert.equal(f.scheduled, 0);
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

test('ordinary canonical enrollment retains deferred writes and explicit wallet linking remains synchronous', async () => {
  const f = fixture();
  await f.commit('u-pk-canonical', 'webauthn-register', enroll);
  assert.equal(f.inline, 1);
  assert.equal(f.scheduled, 1);
  assert.equal(f.puts, 0);
  await f.commit('u-pk-canonical', 'wallet-link', m => { m.walletAddresses.push('0xverified'); }, true);
  assert.equal(f.puts, 1);
  assert.equal(f.inline, 1);
  assert.equal(f.scheduled, 1);
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
  await f.authenticate(userId, { id: 'verified-passkey' }, 'next-challenge', 'identity.test', 'https://identity.test');
  assert.equal(f.document!.webAuthnCredentials[0].counter, 2);
  assert.deepEqual(f.document!.walletAddresses, ['0xverified']);
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
  assert.equal(f.document, null);
  const puts = f.puts;
  await assert.rejects(f.commit(userId, 'did-add-did', m => { m.didKeys.push({ did: 'did:key:late' }); }),
    /Provisional owner unavailable/);
  assert.equal(f.document, null);
  assert.equal(f.puts, puts);
});

test('a passive read cannot recreate a deleted provisional owner', async () => {
  let puts = 0;
  const read = new Function('podAuthMethodsUrl', 'readPodJson', 'podFetch', 'emptyAuthMethods',
    'putPodAuthMethods', 'normaliseAuthMethods',
    `${productionFunction('fetchPodAuthMethods')}; return fetchPodAuthMethods;`)(
    (owner: string) => `https://css.test/${owner}/auth-methods.jsonld`, async () => null, () => {},
    (owner: string) => ({ ...empty(), userId: owner }), async () => { puts++; }, (value: unknown) => value,
  );
  await read(userId);
  assert.equal(puts, 0);
  await read('u-pk-canonical');
  assert.equal(puts, 1);
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
