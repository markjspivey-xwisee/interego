/**
 * The relay-delegated verifier (src/relay-delegated.ts), on its own: a request the Interego relay
 * signed for a person's session agent, turned into that person. Every check it makes is provoked,
 * in its order: the shape, the signature recovering to a trusted relay, the agent on the identity
 * host, its DID document (read through an injected fetch: no network here) naming that agent and
 * a user on the same host as its controller. The cache in front of the fetch is checked too.
 *
 * The relay is played by a generated wallet signing the way its `sign_request` does: an EIP-191
 * personal_sign over `sha256:` + the hex sha256 of the exact JSON text it posts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importWallet, sha256, sha256Hex, signMessageRaw, type Wallet } from '@interego/core';
import {
  agentDidDocumentUrl, userIdOfAgentSlug, agentSlugOf, cachedDidDocuments, isUserDid, openRelayDelegated, relayEnvelopeOf,
  type RelayDelegationPolicy,
} from '../src/relay-delegated.js';

const HOST = 'identity.example.test';
const wallet = (name: string): Wallet => importWallet(`0x${sha256(`pev-relay-test:${name}`)}`, 'agent', name);
const RELAY = wallet('relay');
const MALLORY = wallet('mallory');
const USER = `did:web:${HOST}:users:u-pk-0123456789ab`;
const AGENT = `did:web:${HOST}:agents:claude-u-pk-0123456789ab`;

/** DID documents by URL, as the identity host would serve them; every read is logged. */
function identityHost(docs: Record<string, unknown>): { fetchDidDocument: (url: string) => Promise<unknown>; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fetchDidDocument: async (url) => {
      reads.push(url);
      if (!(url in docs)) throw new Error(`HTTP 404 for ${url}`);
      return docs[url];
    },
  };
}

const docFor = (agent: string, controller: unknown): Record<string, unknown> => ({ id: agent, controller });
const urlFor = (agent: string): string => agentDidDocumentUrl(HOST, agent.slice(agent.lastIndexOf(':') + 1));

async function relaySigned(body: Record<string, unknown>, by: Wallet = RELAY): Promise<{ sp: string; sig: string }> {
  const sp = JSON.stringify(body);
  return { sp, sig: await signMessageRaw(by, `sha256:${sha256Hex(sp)}`) };
}

function policy(docs: Record<string, unknown>, relays: readonly string[] = [RELAY.address.toLowerCase()]): RelayDelegationPolicy & { reads: string[] } {
  const h = identityHost(docs);
  return { relayAddresses: relays, identityHost: HOST, fetchDidDocument: h.fetchDidDocument, reads: h.reads };
}

const BODY = { v: 1, action: 'urn:iep:action:pev:say', nonce: 'nonce-0123456789abcdef', pod_url: 'https://pod.example.test/practice/', agent_id: AGENT, subject_pod_url: 'https://pods.example.test/u-pk-0123456789ab/', timestamp: '2026-10-23T09:00:00.000Z' };

describe('the copied verifier is the shared one', () => {
  it('carries the shared header and exports, unchanged', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/relay-delegated.ts', import.meta.url)), 'utf8');
    expect(src.startsWith('/**\n * Relay-delegated identity: a person who signs in with their Interego account holds no key.')).toBe(true);
    for (const name of ['agentSlugOf', 'isUserDid', 'agentDidDocumentUrl', 'relayEnvelopeOf', 'openRelayDelegated', 'cachedDidDocuments']) {
      expect(src).toMatch(new RegExp(`export (async )?(function|const) ${name}\\b`));
    }
  });
});

describe('agent and user DIDs on the identity host', () => {
  it('names an agent slug only on the configured host, and only a slug of letters, digits, . _ -', () => {
    expect(agentSlugOf(AGENT, HOST)).toBe('claude-u-pk-0123456789ab');
    expect(agentSlugOf(`did:web:other.example.test:agents:claude-x`, HOST)).toBeNull();
    // The host is matched literally: a dot in it is not "any character".
    expect(agentSlugOf('did:web:identityXexample.test:agents:claude-x', HOST)).toBeNull();
    expect(agentSlugOf(`did:web:${HOST}:agents:has space`, HOST)).toBeNull();
    expect(agentSlugOf(`did:web:${HOST}:users:u-1`, HOST)).toBeNull();
    expect(agentSlugOf(`did:web:${HOST}:agents:${'a'.repeat(129)}`, HOST)).toBeNull();
  });

  it('reads a user DID only on the configured host, never an agent', () => {
    expect(isUserDid(USER, HOST)).toBe(true);
    expect(isUserDid(AGENT, HOST)).toBe(false);
    expect(isUserDid('did:web:other.example.test:users:u-1', HOST)).toBe(false);
    expect(isUserDid(`did:web:${HOST}:users:`, HOST)).toBe(false);
    expect(isUserDid(`did:web:${HOST}:users:a/b`, HOST)).toBe(false);
  });

  it('reads an agent document from https://<host>/agents/<slug>/did.json', () => {
    expect(agentDidDocumentUrl(HOST, 'claude-u-1')).toBe(`https://${HOST}/agents/claude-u-1/did.json`);
  });
});

describe('where a relay-signed request is found', () => {
  it('at the top level (where the relay posts it), or under envelope as an object or JSON text', () => {
    const pair = { _signed_payload: '{"a":1}', _signature: '0x00' };
    expect(relayEnvelopeOf({ ...pair })).toEqual({ signedPayload: '{"a":1}', signature: '0x00' });
    expect(relayEnvelopeOf({ envelope: pair })).toEqual({ signedPayload: '{"a":1}', signature: '0x00' });
    expect(relayEnvelopeOf({ envelope: JSON.stringify(pair) })).toEqual({ signedPayload: '{"a":1}', signature: '0x00' });
    expect(relayEnvelopeOf({ envelope: { payload: {}, signature: '0x00' } })).toBeNull();
    expect(relayEnvelopeOf({})).toBeNull();
  });
});

describe('openRelayDelegated', () => {
  it('names the agent\'s controller as the principal when a trusted relay signed for an agent of a user', async () => {
    const p = policy({ [urlFor(AGENT)]: docFor(AGENT, USER) });
    const { sp, sig } = await relaySigned(BODY);
    const r = await openRelayDelegated(sp, sig, p);
    expect(r).toEqual({ ok: true, principal: USER, agentId: AGENT, relaySigner: RELAY.address.toLowerCase(), payload: BODY, signedPayload: sp, signature: sig });
    expect(p.reads).toEqual([urlFor(AGENT)]);
  });

  const refusal = (r: Awaited<ReturnType<typeof openRelayDelegated>>): string => (r.ok ? 'ok' : `${r.status} ${r.code}`);

  it('refuses in order: the shape, the size, the signature, the relay, the payload, the agent, its document', async () => {
    const docs = { [urlFor(AGENT)]: docFor(AGENT, USER) };
    const { sp, sig } = await relaySigned(BODY);
    expect(refusal(await openRelayDelegated(undefined, sig, policy(docs)))).toBe('401 envelope-missing');
    expect(refusal(await openRelayDelegated(sp, '0x1234', policy(docs)))).toBe('401 envelope-missing');
    expect(refusal(await openRelayDelegated('x'.repeat(64 * 1024 + 1), sig, policy(docs)))).toBe('400 payload-too-large');
    expect(refusal(await openRelayDelegated(sp, `0x${'00'.repeat(65)}`, policy(docs)))).toBe('401 signature-unrecoverable');
    // Another key signing the same shape: not a relay this bridge trusts, and nothing is fetched.
    const forged = await relaySigned(BODY, MALLORY);
    const p = policy(docs);
    const r = await openRelayDelegated(forged.sp, forged.sig, p);
    expect(refusal(r)).toBe('401 relay-not-trusted');
    expect(!r.ok && r.message).toContain(MALLORY.address.toLowerCase());
    expect(p.reads).toEqual([]);
    // An empty list trusts no relay at all.
    expect(refusal(await openRelayDelegated(sp, sig, policy(docs, [])))).toBe('401 relay-not-trusted');
    const noAgent = await relaySigned({});
    expect(refusal(await openRelayDelegated('[1,2]', await signMessageRaw(RELAY, `sha256:${sha256Hex('[1,2]')}`), policy(docs)))).toBe('400 envelope-payload-format');
    expect(refusal(await openRelayDelegated(noAgent.sp, noAgent.sig, policy(docs)))).toBe('401 agent-not-on-identity-host');
  });

  it('refuses an agent that is not on the identity host, without reading anything', async () => {
    const elsewhere = 'did:web:other.example.test:agents:claude-u-1';
    for (const agent of [elsewhere, `did:ethr:${RELAY.address}`, USER, '']) {
      const p = policy({});
      const { sp, sig } = await relaySigned({ ...BODY, agent_id: agent });
      expect(refusal(await openRelayDelegated(sp, sig, p)), agent).toBe('401 agent-not-on-identity-host');
      expect(p.reads).toEqual([]);
    }
  });

  it('refuses when the agent\'s document cannot be read (502), names another id, or has no user as controller', async () => {
    const { sp, sig } = await relaySigned(BODY);
    const unreadable = await openRelayDelegated(sp, sig, policy({}));
    expect(refusal(unreadable)).toBe('502 agent-document-unreadable');
    expect(!unreadable.ok && unreadable.message).toContain('HTTP 404');
    expect(refusal(await openRelayDelegated(sp, sig, policy({ [urlFor(AGENT)]: docFor(`did:web:${HOST}:agents:someone-else`, USER) })))).toBe('401 agent-document-mismatch');
    expect(refusal(await openRelayDelegated(sp, sig, policy({ [urlFor(AGENT)]: 'not an object' })))).toBe('401 agent-document-mismatch');
    for (const controller of [AGENT, `did:web:other.example.test:users:u-1`, [USER], undefined, `did:ethr:${RELAY.address}`]) {
      expect(refusal(await openRelayDelegated(sp, sig, policy({ [urlFor(AGENT)]: docFor(AGENT, controller) }))), JSON.stringify(controller)).toBe('401 agent-has-no-user');
    }
  });

  // The identity host lets any account register an unused agent id, so a forgotten relay agent can be
  // claimed by someone else: an agent whose id names a user must be controlled by that user.
  it('refuses an agent whose id names one user and whose document names another, and never names a person from the id alone', async () => {
    const { sp, sig } = await relaySigned(BODY);
    expect(refusal(await openRelayDelegated(sp, sig, policy({ [urlFor(AGENT)]: docFor(AGENT, `did:web:${HOST}:users:u-pk-ffffffffffff`) })))).toBe('401 agent-has-no-user');
    const forgotten = policy({ [`https://${HOST}/users/u-pk-0123456789ab/did.json`]: { id: USER } });
    expect(refusal(await openRelayDelegated(sp, sig, forgotten))).toBe('502 agent-document-unreadable');
    expect(forgotten.reads).toEqual([urlFor(AGENT)]);
    expect(userIdOfAgentSlug('claude-u-pk-0123456789ab')).toBe('u-pk-0123456789ab');
    expect(userIdOfAgentSlug('claude-markj')).toBeNull();
  });

  it('a payload edited after the relay signed it recovers another address, which is no trusted relay', async () => {
    const { sp, sig } = await relaySigned(BODY);
    const edited = sp.replace('"v":1', '"v":1,"text":"what I did not say"');
    expect(refusal(await openRelayDelegated(edited, sig, policy({ [urlFor(AGENT)]: docFor(AGENT, USER) })))).toBe('401 relay-not-trusted');
  });
});

describe('cachedDidDocuments', () => {
  it('reads a document once within its keep time, again after it, and never keeps a failure', async () => {
    let t = 0;
    let fail = false;
    const reads: string[] = [];
    const get = async (url: string): Promise<unknown> => {
      reads.push(url);
      if (fail) throw new Error('down');
      return { id: url };
    };
    const cached = cachedDidDocuments(get, 1000, 2, () => t);
    expect(await cached('a')).toEqual({ id: 'a' });
    t = 999;
    expect(await cached('a')).toEqual({ id: 'a' });
    expect(reads).toEqual(['a']);
    t = 1000;
    await cached('a');
    expect(reads).toEqual(['a', 'a']);
    fail = true;
    await expect(cached('b')).rejects.toThrow('down');
    await expect(cached('b')).rejects.toThrow('down');
    expect(reads).toEqual(['a', 'a', 'b', 'b']);
    fail = false;
    // At most `max` entries: the oldest is dropped first.
    await cached('b');
    await cached('c');
    reads.length = 0;
    await cached('a');
    expect(reads).toEqual(['a']);
  });
});
