/**
 * The decision a first-time wallet or DID sign-in takes against the account's pod
 * (first-sign-in.ts): refuse a credential the account does not hold, sign in one it does,
 * say "try again" for a pod it cannot read, and create an account only where the pod holds
 * no credentials — never over a document another writer created first.
 *
 * The route half (server.ts started against a stand-in pod server) is
 * tests/first-sign-in-routes.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/first-sign-in.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { claimFirstSignIn, type FirstSignInInput } from '../first-sign-in.js';

type Methods = {
  userId: string;
  walletAddresses: string[];
  webAuthnCredentials: Array<{ id: string }>;
  didKeys: Array<{ did: string }>;
  sessionEpoch?: number;
};

const ID = 'u-eth-d8da6bf26964';
const WALLET = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

const record = (extra: Partial<Methods> = {}): Methods =>
  ({ userId: ID, walletAddresses: [], webAuthnCredentials: [], didKeys: [], ...extra });

/** One pod document, written the way CSS honours `If-None-Match: *`. */
function pod(initial: Methods | null | 'unreadable') {
  let doc = initial;
  const writes: Array<{ methods: Methods; ifAbsent: boolean }> = [];
  return {
    writes,
    get doc() { return doc; },
    set doc(d: Methods | null | 'unreadable') { doc = d; },
    read: async (): Promise<Methods | null> => {
      if (doc === 'unreadable') throw new Error('could not read auth-methods.jsonld: 502 Bad Gateway');
      return doc === null ? null : structuredClone(doc);
    },
    create: async (methods: Methods, ifAbsent: boolean): Promise<boolean> => {
      if (doc === 'unreadable') throw new Error('PUT failed: 502');
      if (ifAbsent && doc !== null) return false;
      writes.push({ methods: structuredClone(methods), ifAbsent });
      doc = structuredClone(methods);
      return true;
    },
  };
}

function wallet(p: ReturnType<typeof pod>, extra: Partial<FirstSignInInput<Methods>> = {}) {
  return claimFirstSignIn<Methods>({
    read: p.read,
    create: p.create,
    holds: m => m.walletAddresses.includes(WALLET),
    build: existing => {
      const m = existing ?? record();
      m.walletAddresses.push(WALLET);
      return m;
    },
    ...extra,
  });
}

function didKey(p: ReturnType<typeof pod>) {
  return claimFirstSignIn<Methods>({
    read: p.read,
    create: p.create,
    holds: m => m.didKeys.some(k => k.did === DID),
    build: existing => {
      const m = existing ?? record();
      m.didKeys.push({ did: DID });
      return m;
    },
  });
}

test('an account holding a passkey is not replaced by a first-time wallet: refused, nothing written', async () => {
  const p = pod(record({ webAuthnCredentials: [{ id: 'cred-alice' }], didKeys: [{ did: 'did:key:zOther' }] }));
  assert.deepEqual(await wallet(p), { kind: 'refused' });
  assert.equal(p.writes.length, 0);
  assert.deepEqual((p.doc as Methods).webAuthnCredentials, [{ id: 'cred-alice' }]);
});

test('a wallet removed from its account is not given back: refused, nothing written', async () => {
  // u-eth-<addr> is derived from this wallet; the owner removed it and kept a passkey.
  const p = pod(record({ webAuthnCredentials: [{ id: 'cred-owner' }] }));
  assert.equal((await wallet(p)).kind, 'refused');
  assert.equal(p.writes.length, 0);
});

test('a pod that already lists this wallet is a sign-in the index missed: returning, nothing written', async () => {
  const onPod = record({ walletAddresses: [WALLET], webAuthnCredentials: [{ id: 'cred-alice' }] });
  const p = pod(onPod);
  const outcome = await wallet(p);
  assert.equal(outcome.kind, 'returning');
  assert.deepEqual(outcome.kind === 'returning' && outcome.methods, onPod);
  assert.equal(p.writes.length, 0);
});

test('a pod that cannot be read is not an empty account: unreadable, nothing written', async () => {
  const p = pod('unreadable');
  const outcome = await wallet(p);
  assert.equal(outcome.kind, 'unreadable');
  assert.match(outcome.kind === 'unreadable' ? outcome.reason : '', /502/);
  assert.equal(p.writes.length, 0);
});

test('no auth-methods document: the account is created once, by a write that requires absence', async () => {
  const p = pod(null);
  const outcome = await wallet(p);
  assert.equal(outcome.kind, 'created');
  assert.equal(p.writes.length, 1);
  assert.equal(p.writes[0]!.ifAbsent, true);
  assert.deepEqual((p.doc as Methods).walletAddresses, [WALLET]);
});

test('a document without credentials is kept, its session epoch with it, and the credential added', async () => {
  const p = pod(record({ sessionEpoch: 4 }));
  const outcome = await wallet(p);
  assert.equal(outcome.kind, 'created');
  assert.equal(p.writes.length, 1);
  assert.equal(p.writes[0]!.ifAbsent, false);
  assert.equal((p.doc as Methods).sessionEpoch, 4);
  assert.deepEqual((p.doc as Methods).walletAddresses, [WALLET]);
});

test('a concurrent creator is never overwritten: the pod is read again and the decision taken again', async () => {
  // Between this read (404) and this write, another writer creates the account with a passkey.
  const p = pod(null);
  const read = p.read;
  let reads = 0;
  const outcome = await wallet(p, {
    read: async () => {
      const r = await read();
      if (reads++ === 0) p.doc = record({ webAuthnCredentials: [{ id: 'cred-other-writer' }] });
      return r;
    },
  });
  assert.deepEqual(outcome, { kind: 'refused' });
  assert.equal(p.writes.length, 0);
  assert.deepEqual((p.doc as Methods).webAuthnCredentials, [{ id: 'cred-other-writer' }]);
  assert.equal(reads, 2);
});

test('two first sign-ins racing for one account: one creates it, the other signs in to it', async () => {
  // The same wallet signing in twice at once, each past the index before either wrote.
  const p = pod(null);
  const [a, b] = await Promise.all([wallet(p), wallet(p)]);
  assert.deepEqual([a.kind, b.kind].sort(), ['created', 'returning']);
  assert.equal(p.writes.length, 1);
  assert.deepEqual((p.doc as Methods).walletAddresses, [WALLET]);
});

test('a document that keeps appearing under the write is given up on: unconfirmed, nothing written', async () => {
  const p = pod(null);
  const outcome = await wallet(p, { create: async () => false, attempts: 2 });
  assert.equal(outcome.kind, 'unconfirmed');
  assert.equal(p.writes.length, 0);
});

test('a write that fails is reported, not taken for a created account', async () => {
  const p = pod(null);
  const outcome = await wallet(p, { create: async () => { throw new Error('PUT failed: 500'); } });
  assert.equal(outcome.kind, 'unconfirmed');
});

test('the same for a DID: refused beside other credentials, returning when listed, created on an empty pod', async () => {
  const other = pod(record({ walletAddresses: [WALLET] }));
  assert.deepEqual(await didKey(other), { kind: 'refused' });
  assert.equal(other.writes.length, 0);

  const listed = pod(record({ didKeys: [{ did: DID }], webAuthnCredentials: [{ id: 'cred-x' }] }));
  assert.equal((await didKey(listed)).kind, 'returning');
  assert.equal(listed.writes.length, 0);

  const unreadable = pod('unreadable');
  assert.equal((await didKey(unreadable)).kind, 'unreadable');
  assert.equal(unreadable.writes.length, 0);

  const empty = pod(null);
  assert.equal((await didKey(empty)).kind, 'created');
  assert.equal(empty.writes.length, 1);
  assert.equal(empty.writes[0]!.ifAbsent, true);
});
