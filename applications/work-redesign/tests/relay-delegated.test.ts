/**
 * src/relay-delegated.ts, the verifier both verticals carry for "Sign in with your Interego
 * account": a request the Interego relay signed (its delegation key, EIP-191 over
 * `sha256:<hex sha256 of _signed_payload>`), for the agent of a signed-in session, names the
 * person who controls that agent on the identity host. The relay's form is built here as
 * deploy/mcp-relay/server.ts handleSignRequest builds it; the DID documents are a map, so nothing
 * here touches the network.
 */
import { describe, it, expect } from 'vitest';
import { importWallet, signMessageRaw, sha256Hex, type Wallet } from '@interego/core';
import {
  openRelayDelegated, relayEnvelopeOf, agentSlugOf, isUserDid, agentDidDocumentUrl, userIdOfAgentSlug, cachedDidDocuments, type RelayDelegationPolicy,
} from '../src/relay-delegated.js';

const HOST = 'identity.interego.xwisee.com';
const wallet = (seed: string): Wallet => importWallet(`0x${sha256Hex(`wrd-relay-delegated:${seed}`)}`, 'agent', seed);
const RELAY = wallet('relay');
const OTHER = wallet('not-the-relay');
const USER = `did:web:${HOST}:users:u-pk-f2a9c751075a`;
const AGENT = `did:web:${HOST}:agents:claude-u-pk-f2a9c751075a`;
const AGENT_URL = `https://${HOST}/agents/claude-u-pk-f2a9c751075a/did.json`;

/** The identity host's documents, and every URL asked for. */
function documents(entries: ReadonlyArray<readonly [string, unknown]>): { readonly fetched: string[]; readonly get: (url: string) => Promise<unknown> } {
  const docs = new Map(entries);
  const fetched: string[] = [];
  return {
    fetched,
    get: async (url) => {
      fetched.push(url);
      if (!docs.has(url)) throw new Error('the identity host answered 404');
      return docs.get(url);
    },
  };
}
const policyOf = (get: (url: string) => Promise<unknown>, relayAddresses: readonly string[] = [RELAY.address.toLowerCase()]): RelayDelegationPolicy =>
  ({ relayAddresses, identityHost: HOST, fetchDidDocument: get });
/** The relay's {_signed_payload, _signature}: caller fields, then agent_id, subject_pod_url, timestamp. */
async function relayForm(fields: Record<string, unknown>, signer: Wallet = RELAY): Promise<{ _signed_payload: string; _signature: string }> {
  const text = JSON.stringify({ ...fields, agent_id: AGENT, subject_pod_url: 'https://pod.example/u-pk-f2a9c751075a/', timestamp: '2026-10-23T09:00:00.000Z', ...('agent_id' in fields ? { agent_id: fields['agent_id'] } : {}) });
  return { _signed_payload: text, _signature: await signMessageRaw(signer, `sha256:${sha256Hex(text)}`) };
}

describe('relay-delegated identity: the verifier', () => {
  it('names the person: a trusted relay signed it, for an agent on the identity host whose document has that id and a user on that host as its controller', async () => {
    const host = documents([[AGENT_URL, { id: AGENT, controller: USER }]]);
    const f = await relayForm({ intent: 'wrd:read-records', pod_url: 'https://pod.example/team/', nonce: 'nonce-000000000001' });
    const r = await openRelayDelegated(f._signed_payload, f._signature, policyOf(host.get));
    expect(r).toMatchObject({ ok: true, principal: USER, agentId: AGENT, relaySigner: RELAY.address.toLowerCase(), signedPayload: f._signed_payload, signature: f._signature });
    if (r.ok) expect(r.payload).toEqual(JSON.parse(f._signed_payload));
    // The document is read from where did:web puts it, and only that one.
    expect(host.fetched).toEqual([AGENT_URL]);
    expect(agentDidDocumentUrl(HOST, 'claude-u-pk-f2a9c751075a')).toBe(AGENT_URL);
  });

  it('refuses a signer it does not trust before reading anything, and a payload, an agent, a document or a controller it cannot vouch for', async () => {
    const host = documents([
      [AGENT_URL, { id: AGENT, controller: USER }],
      [`https://${HOST}/agents/claude-mismatch/did.json`, { id: `did:web:${HOST}:agents:claude-someone-else`, controller: USER }],
      [`https://${HOST}/agents/claude-agent-controlled/did.json`, { id: `did:web:${HOST}:agents:claude-agent-controlled`, controller: AGENT }],
      [`https://${HOST}/agents/claude-elsewhere/did.json`, { id: `did:web:${HOST}:agents:claude-elsewhere`, controller: 'did:web:identity.example.org:users:u-pk-f2a9c751075a' }],
      [`https://${HOST}/agents/claude-no-controller/did.json`, { id: `did:web:${HOST}:agents:claude-no-controller` }],
      [`https://${HOST}/agents/claude-many/did.json`, { id: `did:web:${HOST}:agents:claude-many`, controller: [USER] }],
      [`https://${HOST}/agents/claude-not-an-object/did.json`, ['not', 'a', 'document']],
    ]);
    const policy = policyOf(host.get);
    const at = async (fields: Record<string, unknown>, signer?: Wallet): Promise<Awaited<ReturnType<typeof openRelayDelegated>>> => {
      const f = await relayForm(fields, signer);
      return openRelayDelegated(f._signed_payload, f._signature, policy);
    };
    // Another key: refused as not a trusted relay, with nothing read.
    expect(await at({ intent: 'wrd:read-records' }, OTHER)).toMatchObject({ ok: false, status: 401, code: 'relay-not-trusted' });
    expect(host.fetched).toEqual([]);
    // No relay trusted at all: the same.
    const f = await relayForm({ intent: 'wrd:read-records' });
    expect(await openRelayDelegated(f._signed_payload, f._signature, policyOf(host.get, []))).toMatchObject({ ok: false, code: 'relay-not-trusted' });
    // Altered after signing: the signature recovers someone else.
    expect(await openRelayDelegated(f._signed_payload.replace('read-records', 'update-registry'), f._signature, policy)).toMatchObject({ ok: false, code: 'relay-not-trusted' });
    // Not the relay's shape at all.
    expect(await openRelayDelegated(undefined, f._signature, policy)).toMatchObject({ ok: false, status: 401, code: 'envelope-missing' });
    expect(await openRelayDelegated(f._signed_payload, '0x1234', policy)).toMatchObject({ ok: false, status: 401, code: 'envelope-missing' });
    expect(await openRelayDelegated('', f._signature, policy)).toMatchObject({ ok: false, code: 'envelope-missing' });
    expect(await openRelayDelegated(f._signed_payload, `0x${'00'.repeat(65)}`, policy)).toMatchObject({ ok: false, status: 401, code: 'signature-unrecoverable' });
    const big = 'x'.repeat(64 * 1024 + 1);
    expect(await openRelayDelegated(big, await signMessageRaw(RELAY, `sha256:${sha256Hex(big)}`), policy)).toMatchObject({ ok: false, status: 400, code: 'payload-too-large' });
    for (const text of ['not json', '[1,2]', 'null', '"text"']) {
      expect(await openRelayDelegated(text, await signMessageRaw(RELAY, `sha256:${sha256Hex(text)}`), policy)).toMatchObject({ ok: false, status: 400, code: 'envelope-payload-format' });
    }
    // An agent not on the identity host, not an agent, or with no agent_id.
    expect(await at({ agent_id: 'did:web:identity.example.org:agents:claude-u-pk-f2a9c751075a' })).toMatchObject({ ok: false, status: 401, code: 'agent-not-on-identity-host' });
    expect(await at({ agent_id: USER })).toMatchObject({ ok: false, code: 'agent-not-on-identity-host' });
    expect(await at({ agent_id: `did:web:${HOST}:agents:bad/slug` })).toMatchObject({ ok: false, code: 'agent-not-on-identity-host' });
    expect(await at({ agent_id: 42 })).toMatchObject({ ok: false, code: 'agent-not-on-identity-host' });
    expect(host.fetched).toEqual([]);
    // A document that cannot be read, that names another agent, or whose controller is not one user on this host.
    expect(await at({ agent_id: `did:web:${HOST}:agents:claude-nobody` })).toMatchObject({ ok: false, status: 502, code: 'agent-document-unreadable', message: expect.stringMatching(/404/) });
    expect(await at({ agent_id: `did:web:${HOST}:agents:claude-mismatch` })).toMatchObject({ ok: false, status: 401, code: 'agent-document-mismatch' });
    for (const slug of ['claude-agent-controlled', 'claude-elsewhere', 'claude-no-controller', 'claude-many']) {
      expect(await at({ agent_id: `did:web:${HOST}:agents:${slug}` }), slug).toMatchObject({ ok: false, status: 401, code: 'agent-has-no-user' });
    }
    expect(await at({ agent_id: `did:web:${HOST}:agents:claude-not-an-object` })).toMatchObject({ ok: false, code: 'agent-document-mismatch' });
  });

  // The identity host lets any account register an unused agent id, so a forgotten relay agent can be
  // claimed by someone else: an agent whose id names a user must be controlled by that user.
  it('refuses an agent whose id names one user and whose document names another as controller, and never names a person from the id alone', async () => {
    const f = await relayForm({ intent: 'wrd:read-records', pod_url: 'https://pod.example/team/', nonce: 'nonce-000000000003' });
    const squatted = documents([[AGENT_URL, { id: AGENT, controller: `did:web:${HOST}:users:u-pk-ffffffffffff` }]]);
    expect(await openRelayDelegated(f._signed_payload, f._signature, policyOf(squatted.get))).toMatchObject({ ok: false, status: 401, code: 'agent-has-no-user' });
    // The agent's own document is required: the user's existing names no one.
    const forgotten = documents([[`https://${HOST}/users/u-pk-f2a9c751075a/did.json`, { id: USER }]]);
    expect(await openRelayDelegated(f._signed_payload, f._signature, policyOf(forgotten.get))).toMatchObject({ ok: false, status: 502, code: 'agent-document-unreadable' });
    expect(forgotten.fetched).toEqual([AGENT_URL]);
    expect([userIdOfAgentSlug('claude-u-pk-f2a9c751075a'), userIdOfAgentSlug('work-redesign-u-did-0123456789ab'), userIdOfAgentSlug('claude-markj')])
      .toEqual(['u-pk-f2a9c751075a', 'u-did-0123456789ab', null]);
  });

  it('reads the slug and the user only on the configured host, and finds the relay form at the top level of a body or under envelope (an object or its JSON text)', () => {
    expect(agentSlugOf(AGENT, HOST)).toBe('claude-u-pk-f2a9c751075a');
    expect(agentSlugOf(AGENT, 'identity.example.org')).toBeNull();
    expect(agentSlugOf(`did:web:identityXinterego.xwisee.com:agents:claude-u-pk-1`, HOST)).toBeNull();
    expect(agentSlugOf(`did:web:${HOST}:agents:`, HOST)).toBeNull();
    expect(isUserDid(USER, HOST)).toBe(true);
    expect(isUserDid(USER, 'identity.example.org')).toBe(false);
    expect(isUserDid(AGENT, HOST)).toBe(false);
    expect(isUserDid(`${USER}:more`, HOST)).toBe(false);
    const form = { _signed_payload: '{}', _signature: '0x00' };
    expect(relayEnvelopeOf({ ...form, pod_url: 'x' })).toEqual({ signedPayload: '{}', signature: '0x00' });
    expect(relayEnvelopeOf({ envelope: form })).toEqual({ signedPayload: '{}', signature: '0x00' });
    expect(relayEnvelopeOf({ envelope: JSON.stringify(form) })).toEqual({ signedPayload: '{}', signature: '0x00' });
    expect(relayEnvelopeOf({ envelope: { payload: {}, signature: '0x00' } })).toBeNull();
    expect(relayEnvelopeOf({ envelope: 'not json' })).toBeNull();
    expect(relayEnvelopeOf({})).toBeNull();
    // Half a form is still that form (and fails as envelope-missing), never silently a key-held envelope.
    expect(relayEnvelopeOf({ _signature: '0x00' })).toEqual({ signedPayload: undefined, signature: '0x00' });
  });

  it('keeps DID documents for ten minutes, never keeps a failure, and holds at most the number it is given', async () => {
    let t = 0;
    let calls = 0;
    let fail = false;
    const get = async (url: string): Promise<unknown> => { calls += 1; if (fail) throw new Error('down'); return { url, calls }; };
    const cached = cachedDidDocuments(get, 10 * 60_000, 2, () => t);
    expect(await cached('a')).toEqual({ url: 'a', calls: 1 });
    t = 10 * 60_000 - 1;
    expect(await cached('a')).toEqual({ url: 'a', calls: 1 });
    t = 10 * 60_000;
    expect(await cached('a')).toEqual({ url: 'a', calls: 2 });
    fail = true;
    await expect(cached('b')).rejects.toThrow('down');
    fail = false;
    expect(await cached('b')).toEqual({ url: 'b', calls: 4 });
    expect(await cached('c')).toEqual({ url: 'c', calls: 5 });
    // 'a' was the oldest of three: dropped, read again.
    expect(await cached('a')).toEqual({ url: 'a', calls: 6 });
  });
});
