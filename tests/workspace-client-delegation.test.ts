/**
 * ACTING FOR SOMEBODY ELSE: the two questions, and the ways each of them is answered wrongly.
 *
 * ★ THE LIVE COUNTERPART, AND WHAT THESE FIXTURES ARE. Nothing here talks to a relay, and a
 * harness that stands in for a dependency cannot verify that dependency. What it CAN pin is the
 * reasoning on top of it, and only if the shapes it reasons over are real. Every response body
 * below is the live relay's own, recorded on 2026-08-07 by
 * `applications/shared-workspace/discord/tools/probe-delegation-live.ts` against three freshly
 * minted disposable identities. The composition is verified by
 * `applications/shared-workspace/discord/tools/drive-bot-live.ts`, which runs the whole flow —
 * delegate, link, convene, seat, append, fold, revoke — against the real fleet.
 */

import { describe, it, expect } from 'vitest';
import {
  WorkspaceClient, checkDelegation, readAuthorship, readMember,
  type AnyTransport,
} from '@interego/workspace-client';

const RELAY = 'https://relay.interego.xwisee.com';
const CSS = 'http://css.railway.internal:3456/';
const MEMBER = 'u-eth-a541721a4f01';
const BOT = 'did:web:identity.interego.xwisee.com:agents:interego-workspace-live-driver-u-eth-96db0515b808';
const OWNER = 'https://identity.interego.xwisee.com/users/' + MEMBER + '/profile#me';
/** The relay's single delegation key, as measured. One key, every pod, every agent. */
const RELAY_KEY = 'did:ethr:0xd144353a7A2Fa81E126e072AD3b16cD245c83331';

function client(answers: Record<string, (input: Record<string, unknown>) => unknown>): WorkspaceClient {
  return new WorkspaceClient(RELAY, {
    accepts: 'relay-oauth-bearer',
    label: 'stub',
    watchDescription: 'not watched in this test',
    connect: async () => ({ granted: [] }),
    callTool: async (name: string, input: Record<string, unknown>) => {
      const fn = answers[name];
      if (!fn) throw new Error('this test scripted no answer for ' + name);
      return fn(input);
    },
  } as AnyTransport);
}

/** `get_pod_status`, in the shape the live relay returned it. */
const status = (rows: readonly Record<string, unknown>[], pod = MEMBER): Record<string, unknown> => ({
  pod: CSS + pod + '/',
  css: CSS,
  registry: { owner: 'https://identity.interego.xwisee.com/users/' + pod + '/profile#me', agents: rows.length },
  delegationRegistry: { url: CSS + pod + '/agents', owner: 'https://identity.interego.xwisee.com/users/' + pod + '/profile#me', count: rows.length, rows },
});

/** `verify_agent`, in the shape the live relay returned it. */
const verified = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subject_pod_url: CSS + MEMBER + '/',
  verified: true, trustLevel: 'CryptographicallyVerified',
  subject_pod_name: MEMBER, subject_pod_selected_by: 'pod_name',
  enforcement: { enforced: true, scope: 'PublishOnly', writeEligible: true, basis: 'signed-chain', note: 'The signed delegation chain anchors to the pod owner; the relay enforces the scope above.' },
  ...over,
});

/** The party the delegation is FOR. Public by construction — see the note on `checkDelegation`. */
const FOR = 'discord-link 1100000000000000001';
const ROW = { agentId: BOT, scope: 'PublishOnly', label: FOR, validFrom: '2026-08-07T05:27:54.656Z' };

describe('checkDelegation', () => {
  it('passes when the pod lists the agent, the label matches and the relay will enforce it', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([ROW]),
      verify_agent: () => verified(),
    }), { agentId: BOT, podName: MEMBER, expectLabel: FOR });
    expect(v.ok).toBe(true);
    expect(v.scope).toBe('PublishOnly');
    expect(v.basis).toBe('signed-chain');
    expect(v.row?.label).toBe(FOR);
    expect(v.checks.every((c) => c.mark === 'y')).toBe(true);
  });

  it('refuses a label that is close but not exact', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([{ ...ROW, label: FOR + ' ' }]),
      verify_agent: () => verified(),
    }), { agentId: BOT, podName: MEMBER, expectLabel: FOR });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('with nothing before or after it');
  });

  it('refuses a row that delegates for SOMEBODY ELSE, which is the whole binding', async () => {
    // ★ THE ATTACK THIS CLOSES, AND WHY THE LABEL IS NOT A NONCE. Delegation rows are
    // world-readable — `get_pod_status { pod_name: <anyone's> }` returns them with their labels,
    // measured live. So a scheme where the delegate mints a secret and asks the claimant to
    // publish it PUBLISHES the secret, and whoever reads that pod first can present it and bind
    // their own account to somebody else's pod. The label instead names the party it is for, and
    // the caller derives `expectLabel` from whoever is actually asking. Reading it buys nothing.
    const v = await checkDelegation(client({
      get_pod_status: () => status([ROW]),
      verify_agent: () => verified(),
    }), { agentId: BOT, podName: MEMBER, expectLabel: 'discord-link 1100000000000000009' });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('the party asking');
  });

  it('refuses a row with no label at all, and does not call that evidence against anybody', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([{ agentId: BOT, scope: 'PublishOnly' }]),
      verify_agent: () => verified(),
    }), { agentId: BOT, podName: MEMBER, expectLabel: FOR });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('no evidence either way');
  });

  it('refuses when the pod does not list the agent at all', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([]),
      verify_agent: () => { throw new Error('verify_agent must not be reached when the registry has already answered'); },
    }), { agentId: BOT, podName: MEMBER });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('is not among them');
  });

  it('separates "no registry reported" from "the registry delegates nothing"', async () => {
    const none = await checkDelegation(client({
      get_pod_status: () => ({ pod: CSS + MEMBER + '/', delegationRegistry: null }),
    }), { agentId: BOT, podName: MEMBER });
    expect(none.ok).toBe(false);
    // Absence is not evidence: a pod with no registry block has not said it delegates nothing.
    expect(none.why).toContain('is not established');
    const empty = await checkDelegation(client({
      get_pod_status: () => status([]),
    }), { agentId: BOT, podName: MEMBER });
    expect(empty.why).toContain('is not among them');
    expect(empty.why).not.toContain('is not established');
  });

  it('refuses when verify_agent says it examined a different pod', async () => {
    // The relay once answered this question about the CALLER's pod, and the wrong answer was
    // shaped exactly like the right one. `subject_pod_name` is what makes it checkable.
    const v = await checkDelegation(client({
      get_pod_status: () => status([ROW]),
      verify_agent: () => verified({ subject_pod_name: 'u-eth-somebodyelse' }),
    }), { agentId: BOT, podName: MEMBER });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('u-eth-somebodyelse');
  });

  it('refuses when get_pod_status answers for a different pod', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([ROW], 'u-eth-000000000000'),
    }), { agentId: BOT, podName: MEMBER });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('answered for pod u-eth-000000000000');
  });

  it('refuses when the relay reports the agent not write-eligible', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([{ ...ROW, scope: 'DiscoverOnly' }]),
      verify_agent: () => verified({ enforcement: { enforced: true, scope: 'DiscoverOnly', writeEligible: false, basis: 'registry-only', note: 'x' } }),
    }), { agentId: BOT, podName: MEMBER });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('not write-eligible');
  });

  it('passes on registry-only enforcement but marks it as the weaker basis', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => status([ROW]),
      verify_agent: () => verified({ verified: false, enforcement: { enforced: true, scope: 'PublishOnly', writeEligible: true, basis: 'registry-only', note: 'x' } }),
    }), { agentId: BOT, podName: MEMBER });
    expect(v.ok).toBe(true);
    expect(v.checks.some((c) => c.mark === 'q' && c.text.includes('did not anchor'))).toBe(true);
  });

  it('never claims a verdict when the read did not complete', async () => {
    const v = await checkDelegation(client({
      get_pod_status: () => { throw Object.assign(new Error('down'), { code: 'server_unavailable' }); },
    }), { agentId: BOT, podName: MEMBER });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('is not established');
  });

  it('reads the registry and the verdict without a cache, both times', async () => {
    const seen: (unknown)[] = [];
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: '',
      connect: async () => ({ granted: [] }),
      callTool: async (name: string, _i: Record<string, unknown>, opts?: unknown) => {
        seen.push(opts);
        return name === 'get_pod_status' ? status([ROW]) : verified();
      },
    } as unknown as AnyTransport;
    await checkDelegation(new WorkspaceClient(RELAY, tx), { agentId: BOT, podName: MEMBER });
    // A stale authorisation verdict is how a withdrawn delegation keeps looking live.
    expect(seen).toEqual([{ cache: false }, { cache: false }]);
  });
});

describe('readMember', () => {
  it('never carries a session agent across from a cross-pod read', async () => {
    // MEASURED TRAP: `get_pod_status { pod_name: <not mine> }` still reports `sessionAgent`, and
    // it is the CALLER's. A Viewer that copied it would name the delegate as the member's agent.
    const v = await readMember(client({
      get_pod_status: () => ({ ...status([ROW]), sessionAgent: { id: 'did:web:the-callers-own-agent', did: 'did:web:the-callers-own-agent' } }),
    }), MEMBER);
    expect(v.podName).toBe(MEMBER);
    expect(v.webId).toBe(OWNER);
    expect(v.agentDid).toBeNull();
    expect(v.agentScope).toBeNull();
  });

  it('refuses a status that answered for another pod', async () => {
    await expect(readMember(client({ get_pod_status: () => status([], 'u-eth-000000000000') }), MEMBER))
      .rejects.toThrow(/answered for/);
  });

  it('refuses a pod that reports no owner rather than writing documents about nobody', async () => {
    await expect(readMember(client({ get_pod_status: () => ({ pod: CSS + MEMBER + '/' }) }), MEMBER))
      .rejects.toThrow(/no registry owner/);
  });
});

describe('readAuthorship', () => {
  /** The live relay's own block, from a delegated write onto another party's pod. */
  const live = {
    signed: true,
    signer: BOT,
    verificationMethod: RELAY_KEY,
    signerAddress: '0xd144353a7A2Fa81E126e072AD3b16cD245c83331',
    created: '2026-08-07T05:27:57.000Z',
    scheme: 'EcdsaSecp256k1Signature2019',
    contentBinding: 'bound-at-signing',
  };

  it('names the agent the relay authenticated, and says the key is the relay\'s', () => {
    const r = readAuthorship(live);
    expect(r.present).toBe(true);
    expect(r.signerAgent).toBe(BOT);
    expect(r.proves.some((p) => p.includes(BOT))).toBe(true);
    // ★ THE WHOLE POINT. A reader must not come away thinking a human key signed this.
    expect(r.doesNotProve.some((d) => d.includes(RELAY_KEY) && /NOT the author's wallet/.test(d))).toBe(true);
    expect(r.doesNotProve.some((d) => d.includes('delegation registry'))).toBe(true);
  });

  it('treats content binding as three different answers', () => {
    expect(readAuthorship(live).proves.some((p) => p.includes('canonical triples'))).toBe(true);
    const unbound = readAuthorship({ ...live, contentBinding: 'unbound' });
    expect(unbound.proves.some((p) => p.includes('canonical triples'))).toBe(false);
    expect(unbound.doesNotProve.some((d) => d.includes('could be replaced'))).toBe(true);
    const declared = readAuthorship({ ...live, contentBinding: 'declared' });
    expect(declared.doesNotProve.some((d) => d.includes('neither a check that passed nor one that failed'))).toBe(true);
  });

  it('reports an absent block as absent, not as unsigned', () => {
    const r = readAuthorship(null);
    expect(r.present).toBe(false);
    expect(r.proves).toEqual([]);
    expect(r.doesNotProve[0]).toContain('not the same as it being unsigned');
  });

  it('reports a failed signature without inventing a signer', () => {
    const r = readAuthorship({ signed: false, reason: 'no private key' });
    expect(r.present).toBe(true);
    expect(r.proves).toEqual([]);
    expect(r.doesNotProve.some((d) => d.includes('no successful signature'))).toBe(true);
    expect(r.doesNotProve.some((d) => d.includes('names no verification method'))).toBe(true);
  });
});
