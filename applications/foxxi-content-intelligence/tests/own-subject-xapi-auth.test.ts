import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { deriveEncryptionKeyPair } from '@interego/core';
import { recoverSignedRequest } from '../src/auth.js';
import { makeOwnSubjectXapiVerifier, type OwnSubjectXapiAuthConfig } from '../src/own-subject-xapi-auth.js';
import { OwnSubjectXapiRequestBudget, OwnSubjectXapiWriteBudget } from '../src/own-subject-xapi.js';
import type { DidDocument } from '@interego/solid';

const identity = 'https://identity.example', relay = 'https://relay.example';
const subject = 'did:web:identity.example:users:u-pk-123456789abc', agent = 'did:web:identity.example:agents:hallowmarch-u-pk-123456789abc';
const pod = 'https://store.example/u-pk-123456789abc/', webId = `${identity}/users/u-pk-123456789abc/profile#me`;
const wallet = new Wallet('0x' + '11'.repeat(32));
const ownerKey = deriveEncryptionKeyPair('22'.repeat(32)).publicKey;
const current = () => new Date(Date.now() - 60000).toISOString();
function multibase(key: string) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt('0x' + Buffer.concat([Buffer.from([0xec, 1]), Buffer.from(key, 'base64')]).toString('hex')), result = '';
  while (value) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  return 'z' + result;
}
function fixture() {
  const docs: Record<string, DidDocument> = {
    [agent]: { '@context': [], id: agent, controller: subject, service: [
      { id: agent + '#pod', type: 'SolidStorage', serviceEndpoint: pod },
      { id: agent + '#registry', type: 'ContextGraphsAgentRegistry', serviceEndpoint: pod + 'agents' },
      { id: agent + '#relay', type: 'InteregoRelay', serviceEndpoint: relay },
    ] },
    [subject]: { '@context': [], id: subject, controller: subject,
      service: [{ id: subject + '#pod', type: 'SolidStorage', serviceEndpoint: pod }], keyAgreement: [subject + '#x25519'],
      verificationMethod: [{ id: subject + '#x25519', type: 'X25519KeyAgreementKey2020', controller: subject, publicKeyMultibase: multibase(ownerKey) }] },
  };
  const evidence: Awaited<ReturnType<OwnSubjectXapiAuthConfig['delegation']>> = {
    verification: { valid: true, trustLevel: 'CryptographicallyVerified', owner: webId, agent, chainLength: 1, scope: 'ReadWrite' },
    registry: { webId, authorizedAgents: [{ agentId: agent, delegatedBy: webId, scope: 'ReadWrite', validFrom: current() }] },
    credential: { issuer: webId, issuanceDate: current(), credentialSubject: { id: agent, pod, delegatedBy: webId, scope: ['discover', 'publish', 'subscribe'] }, proof: { signerAddress: wallet.address } },
    relay: { verified: true, valid: true, trustLevel: 'CryptographicallyVerified', owner: webId, agent, subjectPodUrl: pod, subject_pod_url: pod, chainLength: 1,
      delegationChain: { anchored: true, owner: webId, agent, length: 1 }, signing: { relayAnchor: wallet.address, credentialAnchor: wallet.address, canSignDelegatedRequests: true } },
  };
  let reads = 0;
  const verify = makeOwnSubjectXapiVerifier({ identityOrigin: identity, relayOrigin: relay, recover: recoverSignedRequest,
    ownPod: s => { if (s !== subject) throw new Error('foreign subject'); return pod; }, samePod: (a, b) => a?.replace('http://css.railway.internal:3456/', 'https://store.example/') === b.replace('http://css.railway.internal:3456/', 'https://store.example/'),
    document: async did => { reads++; if (!docs[did]) throw new Error('unavailable'); return docs[did]!; }, delegation: async (p, a) => { reads++; expect(p).toBe(pod); expect(a).toBe(agent); return evidence; },
  });
  const envelope = async (extra: Record<string, unknown> = {}) => {
    const _signed_payload = JSON.stringify({ agent_id: agent, subject_did: subject, subject_pod_url: pod, purpose: 'personal-performance', timestamp: new Date().toISOString(), ...extra });
    return { _signed_payload, _signature: await wallet.signMessage('sha256:' + createHash('sha256').update(_signed_payload).digest('hex')) };
  };
  return { docs, evidence, verify, envelope, reads: () => reads };
}

describe('native own-subject xAPI authority', () => {
  it('binds the real session agent to its controlling human, owner pod and encryption key', async () => {
    const h = fixture();
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: true, callerDid: agent, subjectDid: subject, podUrl: pod, ownerPublicKey: ownerKey });
  });
  it('rejects unsigned/changed payloads and foreign identity authorities without network reads', async () => {
    const h = fixture(); expect(await h.verify({}, true)).toMatchObject({ ok: false, status: 401 });
    const signed = await h.envelope(); signed._signed_payload = signed._signed_payload.replace(subject, 'did:web:foreign.example:users:u-pk-123456789abc');
    expect(await h.verify(signed, true)).toMatchObject({ ok: false });
    expect(h.reads()).toBe(0);
  });
  it('never treats signed subject or pod overrides as authority', async () => {
    const h = fixture();
    expect(await h.verify(await h.envelope({ subject_did: 'did:web:identity.example:users:u-pk-abcdefabcdef' }), true)).toMatchObject({ ok: false, status: 403 });
    expect(await h.verify(await h.envelope({ subject_pod_url: 'https://store.example/u-pk-abcdefabcdef/' }), true)).toMatchObject({ ok: false, status: 403 });
    expect(await h.verify(await h.envelope({ purpose: 'other-purpose' }), true)).toMatchObject({ ok: false, status: 403 });
  });
  it('requires native owner storage and the owner-controlled encryption method', async () => {
    const h = fixture(); h.docs[subject]!.verificationMethod![0]!.controller = agent;
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: false, status: 403 });
    h.docs[subject]!.verificationMethod![0]!.controller = subject; h.docs[agent]!.service![0]!.serviceEndpoint = 'https://store.example/foxxi/';
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: false, status: 403 });
  });
  it('accepts only configured internal/public store aliases, preserving the registry resource path', async () => {
    const h = fixture();
    h.docs[agent]!.service![0]!.serviceEndpoint = pod.replace('https://store.example/', 'http://css.railway.internal:3456/');
    h.docs[agent]!.service![1]!.serviceEndpoint = (pod + 'agents').replace('https://store.example/', 'http://css.railway.internal:3456/');
    h.docs[subject]!.service![0]!.serviceEndpoint = pod.replace('https://store.example/', 'http://css.railway.internal:3456/');
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: true, podUrl: pod });
    h.docs[agent]!.service![1]!.serviceEndpoint += '/extra';
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: false, status: 403 });
    h.docs[agent]!.service![1]!.serviceEndpoint = (pod + 'agents').replace('store.example', 'attacker.example');
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: false, status: 403 });
  });
  it('fails closed for revoked, expired, wrong-owner and stale-relay delegates', async () => {
    for (const change of [
      (h: ReturnType<typeof fixture>) => { h.evidence.registry!.authorizedAgents[0]!.revoked = true; },
      (h: ReturnType<typeof fixture>) => { h.evidence.credential!.expirationDate = current(); },
      (h: ReturnType<typeof fixture>) => { h.evidence.credential!.credentialSubject.delegatedBy = 'https://foreign.example/profile#me'; },
      (h: ReturnType<typeof fixture>) => { h.evidence.relay.signing!.relayAnchor = '0x' + '33'.repeat(20); },
      (h: ReturnType<typeof fixture>) => { h.evidence.relay.signing!.canSignDelegatedRequests = false; },
    ]) { const h = fixture(); change(h); expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: false, status: 403 }); }
  });
  it('allows read-only discovery but requires publish for writes', async () => {
    const h = fixture(); h.evidence.verification.scope = 'ReadOnly'; h.evidence.registry!.authorizedAgents[0]!.scope = 'ReadOnly';
    h.evidence.credential!.credentialSubject.scope = ['discover', 'subscribe'];
    expect(await h.verify(await h.envelope(), false)).toMatchObject({ ok: true });
    expect(await h.verify(await h.envelope(), true)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('bounded personal activity runtime intake', () => {
  it('fits a complete 20-statement reconciliation and isolates players behind the same relay', () => {
    const budget = new OwnSubjectXapiRequestBudget();
    for (let n = 0; n < 20; n++) expect(budget.allow('subject:first', 120, 1000)).toBe(true);
    for (let n = 0; n < 120; n++) expect(budget.allow('subject:second', 120, 1000)).toBe(true);
    expect(budget.allow('subject:second', 120, 1000)).toBe(false); expect(budget.allow('subject:first', 120, 1000)).toBe(true);
  });
  it('bounds concurrency and real encrypted PUT bytes before transmission', () => {
    const budget = new OwnSubjectXapiWriteBudget(), a = budget.begin(subject, 10, 1000), b = budget.begin(subject, 10, 1000);
    expect(() => budget.begin(subject, 1, 1000)).toThrow(/budget/);
    a.reserveWrite(4 * 1024 * 1024); expect(() => a.reserveWrite(1)).toThrow(/budget/);
    a.release(); a.release(); b.release();
    expect(() => budget.begin(subject, 4 * 1024 * 1024, 1000)).toThrow(/budget/);
    const next = budget.begin(subject, 10, 3601001); next.release();
  });
});
