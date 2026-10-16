#!/usr/bin/env tsx
/** Real signed-VC readback over a conditional, in-memory CSS store. No identities
 * are registered and every registry PUT is forbidden by the fixture. */
import assert from 'node:assert/strict';
import { Wallet, verifyMessage } from 'ethers';
import {
  createOwnerProfile, createDelegationCredential, createSignedDelegationCredential, delegationCredentialToJsonLd,
  ownerProfileToTurtle, type AuthorizedAgentData, type DelegationSigner, type DelegationVerifier, type FetchFn, type IRI,
  type OwnerProfileData,
} from '@interego/core';
import { ensureOwnedPublisherCredential } from '../owned-publisher-credential.js';
import { verifyPrincipalDelegation } from '../principal-delegation.js';

const identityBaseUrl = 'https://identity.example.test';
const podUrl = 'http://css.internal.test:3456/owner/';
const ownerWebId = (identityBaseUrl + '/users/owner/profile#me') as IRI;
const agentId = 'did:web:identity.example.test:agents:hallowmarch-owner' as IRI;
const credentialUrl = podUrl + 'credentials/' + encodeURIComponent(agentId) + '.jsonld';
const wallet = new Wallet('0x' + '22'.repeat(32)); // Public deterministic test key, never a service credential.
const signer: DelegationSigner = async payload => ({ signature: await wallet.signMessage(payload),
  signerAddress: wallet.address, verificationMethod: ('did:ethr:' + wallet.address) as IRI });
const verifier: DelegationVerifier = async (payload, proof) => {
  try { return verifyMessage(payload, proof.proofValue).toLowerCase() === proof.signerAddress.toLowerCase(); }
  catch { return false; }
};
const row: AuthorizedAgentData = { agentId, delegatedBy: ownerWebId, scope: 'ReadWrite', label: 'Existing owner browser',
  isSoftwareAgent: true, validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z',
  encryptionPublicKey: 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDDEEEEEEEEFFF=' };
const original = () => createOwnerProfile(ownerWebId, 'Fixture owner', [row]);
function registry(profile: OwnerProfileData): string {
  let turtle = ownerProfileToTurtle(profile);
  // The native serializer normalizes delegatedBy to the owner. A valid external
  // registry can carry a real subdelegation, which compatibility must preserve.
  for (const agent of profile.authorizedAgents) if (!agent.revoked && agent.delegatedBy !== profile.webId) {
    turtle = turtle.replace('iep:agentIdentity <' + agent.agentId + '> ;\n    iep:delegatedBy <' + profile.webId + '>',
      'iep:agentIdentity <' + agent.agentId + '> ;\n    iep:delegatedBy <' + agent.delegatedBy + '>');
  }
  return turtle;
}
const signed = async (profile = original(), agent = row) => delegationCredentialToJsonLd(
  await createSignedDelegationCredential(profile, agent, podUrl as IRI, signer));

function fixture({ profile = original() as OwnerProfileData | null, credential, getStatus = 0,
  putHook, lostAck = false, loseBeforeCommit = false, putStatus = 201,
}: { profile?: OwnerProfileData | null; credential?: string; getStatus?: number;
  putHook?: (state: ReturnType<typeof fixture>) => Promise<void> | void; lostAck?: boolean; loseBeforeCommit?: boolean; putStatus?: number } = {}) {
  const documents = new Map<string, string>();
  if (profile) documents.set(podUrl + 'agents', registry(profile));
  if (credential !== undefined) documents.set(credentialUrl, credential);
  const puts: { url: string; condition: string | null }[] = [];
  const state = { documents, puts, setProfile(next: OwnerProfileData | null) {
    if (next) documents.set(podUrl + 'agents', registry(next)); else documents.delete(podUrl + 'agents');
  }, fetch: null as unknown as FetchFn, ensure: null as unknown as () => ReturnType<typeof ensureOwnedPublisherCredential> };
  state.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      assert.equal(url, credentialUrl, 'credential ensure must never PUT registry, ACL, profile, graph or other credential');
      const condition = new Headers(init?.headers).get('If-None-Match');
      puts.push({ url, condition }); assert.equal(condition, '*', 'credential creation uses conditional create without an unconditional overwrite');
      await putHook?.(state);
      if (documents.has(url)) return new Response('', { status: 412 });
      if (loseBeforeCommit) throw new Error('fixture transport lost before store');
      documents.set(url, String(init?.body));
      if (lostAck) throw new Error('fixture acknowledgement lost after store');
      return new Response('', { status: putStatus });
    }
    assert.equal(method, 'GET');
    if (url === credentialUrl && getStatus) return new Response('', { status: getStatus });
    const body = documents.get(url);
    return new Response(body ?? '', { status: body === undefined ? 404 : 200 });
  };
  state.ensure = () => ensureOwnedPublisherCredential({ podUrl, agentId, ownerWebId, identityBaseUrl,
    fetch: state.fetch, signer: async () => signer, verifier });
  return state;
}

{
  const state = fixture(), registry = state.documents.get(podUrl + 'agents');
  assert.deepEqual(await state.ensure(), { created: true });
  assert.equal(state.puts.length, 1);
  assert.equal(state.documents.get(podUrl + 'agents') === registry, true, 'scope, key, validity and owner registry bytes stay exact');
  const verdict = await verifyPrincipalDelegation(agentId, podUrl, { identityBaseUrl, fetch: state.fetch, verifier });
  assert.equal(verdict.trustLevel, 'CryptographicallyVerified'); assert.equal(verdict.scope, 'ReadWrite');
  assert.equal(verdict.owner, ownerWebId); assert.equal(verdict.delegationSubject.basis, 'exact');
  await state.ensure(); assert.equal(state.puts.length, 1, 'valid proof is reused without rewriting');
}
{
  const bytes = await signed(), state = fixture({ credential: bytes });
  assert.deepEqual(await state.ensure(), { created: false }); assert.equal(state.puts.length, 0);
  assert.equal(state.documents.get(credentialUrl) === bytes, true);
}
for (const [name, replacement] of [
  ['ReadOnly', { ...row, scope: 'ReadOnly' }], ['DiscoverOnly', { ...row, scope: 'DiscoverOnly' }],
  ['expired', { ...row, validUntil: '2001-01-01T00:00:00.000Z' }],
  ['future', { ...row, validFrom: '2098-01-01T00:00:00.000Z' }],
  ['foreign delegator', { ...row, delegatedBy: 'did:web:other.example:agents:other' }],
  ['alias only', { ...row, agentId: 'hallowmarch-owner' }],
  ['revoked', { ...row, revoked: true }],
] as [string, AuthorizedAgentData][]) {
  const state = fixture({ profile: createOwnerProfile(ownerWebId, 'Fixture', [replacement]) });
  const registry = state.documents.get(podUrl + 'agents');
  assert.deepEqual(await state.ensure(), { created: false }, name + ' retains original publication semantics');
  assert.equal(state.puts.length, 0, name + ' gets no proof or new grant');
  assert.equal(state.documents.get(podUrl + 'agents') === registry, true);
}
for (const profile of [null, createOwnerProfile(ownerWebId, 'Empty'),
  createOwnerProfile('https://other.example/profile#me' as IRI, 'Other', [row])]) {
  const state = fixture({ profile }); assert.deepEqual(await state.ensure(), { created: false });
  assert.equal(state.puts.length, 0);
}
{
  const narrowed = { ...row, scope: 'PublishOnly' } as AuthorizedAgentData;
  const state = fixture({ profile: createOwnerProfile(ownerWebId, 'Publisher', [narrowed]) });
  await state.ensure();
  assert.equal((await verifyPrincipalDelegation(agentId, podUrl, { identityBaseUrl, fetch: state.fetch, verifier })).scope, 'PublishOnly');
}
for (const invalid of [
  '{ malformed', delegationCredentialToJsonLd(createDelegationCredential(original(), row, podUrl as IRI)),
  await signed(original(), { ...row, validUntil: '2001-01-01T00:00:00.000Z' }),
  (await signed()).replace(/"proofValue":\s*"[^"]+"/, '"proofValue":"invalid"'),
]) {
  const state = fixture({ credential: invalid });
  assert.deepEqual(await state.ensure(), { created: false });
  assert.equal(state.puts.length, 0, 'malformed, unsigned, expired or bad signature must never be replaced');
  assert.equal(state.documents.get(credentialUrl) === invalid, true);
}
{
  const alias = { ...row, agentId: 'hallowmarch-owner' as IRI };
  const profile = createOwnerProfile(ownerWebId, 'Legacy owner', [alias]), state = fixture({ profile });
  state.documents.set(podUrl + 'credentials/' + encodeURIComponent(alias.agentId) + '.jsonld', await signed(profile, alias));
  assert.deepEqual(await state.ensure(), { created: false }); assert.equal(state.puts.length, 0);
  const verdict = await verifyPrincipalDelegation(agentId, podUrl, { identityBaseUrl, fetch: state.fetch, verifier });
  assert.equal(verdict.valid, true); assert.equal(verdict.delegationSubject.basis, 'identity-alias');
}
{
  const parent = { ...row, agentId: 'did:web:identity.example.test:agents:parent' as IRI };
  const child = { ...row, delegatedBy: parent.agentId }, profile = createOwnerProfile(ownerWebId, 'Subdelegation', [parent, child]);
  const state = fixture({ profile, credential: await signed(profile, child) });
  state.documents.set(podUrl + 'credentials/' + encodeURIComponent(parent.agentId) + '.jsonld', await signed(profile, parent));
  assert.deepEqual(await state.ensure(), { created: false }); assert.equal(state.puts.length, 0);
  assert.equal((await verifyPrincipalDelegation(agentId, podUrl, { identityBaseUrl, fetch: state.fetch, verifier })).valid, true);
}
{
  const state = fixture(); state.documents.set(podUrl + 'agents', 'not a registry');
  await assert.rejects(state.ensure()); assert.equal(state.puts.length, 0, 'a registry parse failure is never enrollment');
}
for (const getStatus of [401, 403, 500, 503]) {
  const state = fixture({ getStatus }); await assert.rejects(state.ensure(), { code: 'publisher_credential_unavailable' });
  assert.equal(state.puts.length, 0, 'only exact credential404 allows create');
}
for (const next of [null, createOwnerProfile(ownerWebId, 'Revoked', []),
  createOwnerProfile(ownerWebId, 'Narrowed', [{ ...row, scope: 'ReadOnly' }]),
  createOwnerProfile(ownerWebId, 'Changed key', [{ ...row, encryptionPublicKey: 'owner changed recipient key' }])]) {
  const state = fixture({ putHook: store => store.setProfile(next) });
  await assert.rejects(state.ensure(), { code: 'publisher_authority_changed' });
  assert.equal(state.puts.length, 1); const registry = next ? ownerProfileToTurtle(next) : undefined;
  assert.equal(state.documents.get(podUrl + 'agents') === registry, true, 'concurrent deletion, revoke, narrowing or key change is not restored');
  assert.equal((await verifyPrincipalDelegation(agentId, podUrl, { identityBaseUrl, fetch: state.fetch, verifier })).scope,
    next?.authorizedAgents[0]?.scope, 'any resulting authority still comes only from current registry');
}
{
  const winner = await signed(); const state = fixture({ putHook: store => { store.documents.set(credentialUrl, winner); } });
  assert.deepEqual(await state.ensure(), { created: false }); assert.equal(state.puts.length, 1);
  assert.equal(state.documents.get(credentialUrl) === winner, true, '412 preserves concurrent signed proof byte for byte');
}
{
  const state = fixture({ putHook: store => { store.documents.set(credentialUrl, '{other invalid credential'); } });
  await assert.rejects(state.ensure(), { code: 'publisher_credential_invalid' }); assert.equal(state.puts.length, 1);
  assert.equal(state.documents.get(credentialUrl), '{other invalid credential', '412 never overwrites an invalid concurrent proof');
}
for (const winner of [
  await signed(original(), { ...row, agentId: 'did:web:identity.example.test:agents:other' as IRI }),
  delegationCredentialToJsonLd(await createSignedDelegationCredential(original(), row, 'https://other.example/owner/' as IRI, signer)),
  await signed(original(), { ...row, scope: 'ReadOnly' }),
  await signed(original(), { ...row, validUntil: '2090-01-01T00:00:00.000Z' }),
]) {
  const state = fixture({ putHook: store => { store.documents.set(credentialUrl, winner); } });
  await assert.rejects(state.ensure(), { code: 'publisher_credential_invalid' }); assert.equal(state.puts.length, 1);
  assert.equal(state.documents.get(credentialUrl) === winner, true, 'a signed but differently bound race winner is refused without replacement');
}
{
  const state = fixture({ lostAck: true }); assert.deepEqual(await state.ensure(), { created: false });
  assert.equal(state.puts.length, 1, 'unknown acknowledgement is read-verified, never PUT-replayed');
}
{
  const state = fixture({ putStatus: 500 }); assert.deepEqual(await state.ensure(), { created: false });
  assert.equal(state.puts.length, 1, 'an ambiguous servererror afterstore is read-verified without replay');
}
{
  const state = fixture({ loseBeforeCommit: true }); await assert.rejects(state.ensure(), { code: 'publisher_credential_invalid' });
  assert.equal(state.puts.length, 1, 'unknown no-commit also gets no PUT replay');
}
console.log('Owned publisher credential conditional-create, real-signature, authority-preservation and failure tests passed');
