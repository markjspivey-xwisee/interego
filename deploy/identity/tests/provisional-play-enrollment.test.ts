import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { enrollProvisionalCredential } from '../provisional-play-enrollment.js';
import { purgeProvisionalPlayPod } from '../provisional-play-cleanup.js';

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const executable = stripTypeScriptTypes(server);
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
  webAuthnCredentials: Array<{ id: string }>;
  walletAddresses: string[]; didKeys: Array<{ did: string }>;
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
  const read = async () => document ? structuredClone(document) : empty();
  const persist = async (_owner: string, candidate: Methods) => {
    puts++;
    await beforePersist();
    document = structuredClone(candidate);
    cached = document;
  };
  const commit = new Function('enrollProvisionalCredential', 'withIdentityPodMutex', 'fetchPodAuthMethods',
    'hasAnyCredential', 'provisionalPlay', 'putPodAuthMethods', 'readAuthMethods',
    'inlineApplyAuthMethods', 'scheduleDeferredAuthMethodsWrite',
    `${productionFunction('commitCredentialEnrollment')}; return commitCredentialEnrollment;`)(
    enrollProvisionalCredential, withIdentityPodMutex, read, hasAnyCredential,
    { open(anchor: string) {
      openCalls++;
      if (anchor !== 'original-owner-anchor' || now >= 10) throw new Error('Provisional owner unavailable');
      return { userId };
    } }, persist, async () => cached,
    (_owner: string, methods: Methods) => { inline++; cached = methods; },
    () => { scheduled++; },
  ) as (owner: string, context: string, update: (m: Methods) => boolean | void, synchronous?: boolean) => Promise<void>;
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
    commit, cleanup, deletions,
    get document() { return document; }, get cached() { return cached; },
    get checkpoint() { return checkpoint; }, get puts() { return puts; },
    get inline() { return inline; }, get scheduled() { return scheduled; }, get openCalls() { return openCalls; },
    set now(value: number) { now = value; },
    set beforePersist(value: () => Promise<void>) { beforePersist = value; },
    set beforeDelete(value: () => Promise<void>) { beforeDelete = value; },
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
