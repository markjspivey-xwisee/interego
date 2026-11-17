/**
 * The rule that decides who is calling a signed /agent/* route (src/caller-principal.ts).
 *
 * Three copies of this rule lived in bridge/server.ts. They are one now, and where the copies
 * differed the difference is an option. These tests pin the rule, every refusal's status and
 * wording, and each option, so the shims over it cannot change what a handler answers.
 */
import { describe, it, expect } from 'vitest';
import {
  decideCallerPrincipal, directSubject, isDirectClaim, AGENT_ID_MAX_LENGTH,
  type CallerPrincipalOptions, type DelegationChecks,
} from '../src/caller-principal.js';
import type { RecoveredSignedRequest } from '../src/auth.js';

const SIGNER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const OTHER = '0x1111111111111111111111111111111111111111';
const AGENT = 'https://relay.example/agents/claude-code-vscode-u-eth-1234';
const POD = 'https://pods.example/claude-code-vscode-u-eth-1234/';

/** What verifyDelegatedCaller and /agent/issue-credential asked for. */
const PLAIN: CallerPrincipalOptions = { agentIdBounds: false, anchorRefusalExplains: false };
/** What bindSignedCaller asked for. */
const BOUND: CallerPrincipalOptions = { agentIdBounds: true, anchorRefusalExplains: true };

const signed = (agentId: string, payload: Record<string, unknown> = { agent_id: agentId, n: 1 }): RecoveredSignedRequest =>
  ({ ok: true, signer: SIGNER, agentId, payload });

interface Calls { podFor: string[]; verify: Array<[string, string]>; anchorOf: Array<[string, string]> }
function checks(over: Partial<DelegationChecks> = {}): { c: DelegationChecks; calls: Calls } {
  const calls: Calls = { podFor: [], verify: [], anchorOf: [] };
  const base: DelegationChecks = {
    podFor: () => POD,
    verify: async () => ({ valid: true, trustLevel: 'CryptographicallyVerified' }),
    anchorOf: async () => SIGNER.toLowerCase(),
    ...over,
  };
  return {
    calls,
    c: {
      podFor: (a) => { calls.podFor.push(a); return base.podFor(a); },
      verify: (a, p) => { calls.verify.push([a, p]); return base.verify(a, p); },
      anchorOf: (a, p) => { calls.anchorOf.push([a, p]); return base.anchorOf(a, p); },
    },
  };
}

describe('direct: the signed agent_id embeds the recovered signer', () => {
  it('is the wallet itself, a person, and no pod is read', async () => {
    const { c, calls } = checks();
    const rec = signed(`did:ethr:${SIGNER.toLowerCase()}`);
    const r = await decideCallerPrincipal(rec, c, PLAIN);
    expect(r).toEqual({
      ok: true,
      principal: { subject: `did:ethr:${SIGNER}`, key: SIGNER, authMode: 'direct', kind: 'human', payload: rec.ok ? rec.payload : {} },
    });
    expect(calls).toEqual({ podFor: [], verify: [], anchorOf: [] });
  });

  it('the subject is built from the recovered signer, not from the spelling the caller signed', async () => {
    const { c } = checks();
    const r = await decideCallerPrincipal(signed(`did:pkh:eip155:1:${SIGNER.toUpperCase().replace('0X', '0x')}`), c, PLAIN);
    expect(r.ok && r.principal.subject).toBe(`did:ethr:${SIGNER}`);
    expect(r.ok && r.principal.authMode).toBe('direct');
  });

  it('only the FIRST address in agent_id counts', async () => {
    expect(isDirectClaim(`did:ethr:${OTHER}#${SIGNER}`, SIGNER)).toBe(false);
    expect(isDirectClaim(`did:ethr:${SIGNER}#${OTHER}`, SIGNER)).toBe(true);
    expect(isDirectClaim('did:web:example.com', SIGNER)).toBe(false);
  });

  it('the payload is handed back by reference, untouched', async () => {
    const payload = { agent_id: `did:ethr:${SIGNER}`, deep: { a: 1 } };
    const r = await decideCallerPrincipal(signed(`did:ethr:${SIGNER}`, payload), checks().c, BOUND);
    expect(r.ok && r.principal.payload).toBe(payload);
  });
});

describe('delegated: someone else signed for the agent', () => {
  it('is the agent when its delegation is verified and the signer anchors it', async () => {
    const { c, calls } = checks();
    const rec = signed(AGENT);
    const r = await decideCallerPrincipal(rec, c, PLAIN);
    expect(r).toEqual({
      ok: true,
      principal: { subject: AGENT, key: SIGNER, authMode: 'delegated', kind: 'agent', payload: rec.ok ? rec.payload : {} },
    });
    // The pod is derived from the agent id, and both reads go to that pod.
    expect(calls).toEqual({ podFor: [AGENT], verify: [[AGENT, POD]], anchorOf: [[AGENT, POD]] });
  });

  it('a did:ethr of ANOTHER wallet is delegated, not direct', async () => {
    const r = await decideCallerPrincipal(signed(`did:ethr:${OTHER}`), checks().c, PLAIN);
    expect(r.ok && r.principal).toMatchObject({ subject: `did:ethr:${OTHER}`, key: SIGNER, authMode: 'delegated', kind: 'agent' });
  });

  it('refuses (401) when the delegation check throws, and reads no anchor', async () => {
    const { c, calls } = checks({ verify: async () => { throw new Error('unsafe fetch target'); } });
    expect(await decideCallerPrincipal(signed(AGENT), c, PLAIN)).toEqual({
      ok: false, reason: 'delegation-check-failed', status: 401,
      error: `delegation verification failed for ${AGENT} on ${POD}: unsafe fetch target`,
    });
    expect(calls.anchorOf).toEqual([]);
  });

  it('refuses (401) an invalid delegation, saying its reason', async () => {
    const { c, calls } = checks({ verify: async () => ({ valid: false, trustLevel: 'SelfAsserted', reason: 'agent not in registry' }) });
    expect(await decideCallerPrincipal(signed(AGENT), c, PLAIN)).toEqual({
      ok: false, reason: 'delegation-unverified', status: 401,
      error: `agent ${AGENT} has no cryptographically-verified delegation on ${POD}: agent not in registry`,
    });
    expect(calls.anchorOf).toEqual([]);
  });

  it('refuses (401) a valid delegation that is not CryptographicallyVerified, saying its tier', async () => {
    const { c } = checks({ verify: async () => ({ valid: true, trustLevel: 'SelfAsserted' }) });
    const r = await decideCallerPrincipal(signed(AGENT), c, PLAIN);
    expect(r).toMatchObject({ ok: false, status: 401, error: `agent ${AGENT} has no cryptographically-verified delegation on ${POD}: SelfAsserted` });
  });

  it('says "unverified" when the check gives neither a reason nor a tier', async () => {
    const { c } = checks({ verify: async () => ({ valid: false }) });
    const r = await decideCallerPrincipal(signed(AGENT), c, PLAIN);
    expect(r).toMatchObject({ ok: false, error: `agent ${AGENT} has no cryptographically-verified delegation on ${POD}: unverified` });
  });

  it('refuses (401) a signer that is not the anchor key, naming the anchor', async () => {
    const { c } = checks({ anchorOf: async () => OTHER });
    expect(await decideCallerPrincipal(signed(AGENT), c, PLAIN)).toEqual({
      ok: false, reason: 'signer-not-anchor', status: 401,
      error: `request signer ${SIGNER} is not the delegation anchor key (${OTHER})`,
    });
  });

  it('refuses (401) when the credential cannot be read at all, naming no anchor', async () => {
    for (const none of [undefined, null, '']) {
      const { c } = checks({ anchorOf: async () => none });
      const r = await decideCallerPrincipal(signed(AGENT), c, PLAIN);
      expect(r).toMatchObject({ ok: false, status: 401, error: `request signer ${SIGNER} is not the delegation anchor key` });
    }
  });

  it('compares the anchor with the signer case-insensitively', async () => {
    const { c } = checks({ anchorOf: async () => SIGNER.toUpperCase().replace('0X', '0x') });
    expect((await decideCallerPrincipal(signed(AGENT), c, PLAIN)).ok).toBe(true);
  });

  it('a throw from the pod derivation is not swallowed', async () => {
    const { c } = checks({ podFor: () => { throw new Error('no pod for that'); } });
    await expect(decideCallerPrincipal(signed(AGENT), c, PLAIN)).rejects.toThrow('no pod for that');
  });
});

describe('unsigned', () => {
  const rec: RecoveredSignedRequest = { ok: false, reason: 'missing _signature or _signed_payload' };

  it('refuses (401) with the recovery reason, and reads no pod', async () => {
    const { c, calls } = checks();
    expect(await decideCallerPrincipal(rec, c, PLAIN)).toEqual({
      ok: false, reason: 'unsigned', status: 401, error: 'agent signature required: missing _signature or _signed_payload',
    });
    expect(calls).toEqual({ podFor: [], verify: [], anchorOf: [] });
  });
});

describe('where the three former copies differed, each keeps its own', () => {
  it('unsignedHint: sent only when the call site gives one, and only on the unsigned refusal', async () => {
    const unsigned: RecoveredSignedRequest = { ok: false, reason: 'body is not an object' };
    const none = await decideCallerPrincipal(unsigned, checks().c, PLAIN);
    expect(none).not.toHaveProperty('hint');
    const empty = await decideCallerPrincipal(unsigned, checks().c, { ...PLAIN, unsignedHint: '' });
    expect(empty).not.toHaveProperty('hint');
    const hinted = await decideCallerPrincipal(unsigned, checks().c, { ...PLAIN, unsignedHint: 'sign_request first' });
    expect(hinted).toMatchObject({ ok: false, status: 401, hint: 'sign_request first' });
    // No other refusal carries it.
    const notAnchor = await decideCallerPrincipal(signed(AGENT), checks({ anchorOf: async () => OTHER }).c, { ...PLAIN, unsignedHint: 'sign_request first' });
    expect(notAnchor.ok).toBe(false);
    expect(notAnchor).not.toHaveProperty('hint');
  });

  it('anchorRefusalExplains: bindSignedCaller ended the refusal with the rule; the other two did not', async () => {
    const bad = (): DelegationChecks => checks({ anchorOf: async () => OTHER }).c;
    const plain = await decideCallerPrincipal(signed(AGENT), bad(), PLAIN);
    const bound = await decideCallerPrincipal(signed(AGENT), bad(), BOUND);
    expect(!plain.ok && plain.error).toBe(`request signer ${SIGNER} is not the delegation anchor key (${OTHER})`);
    expect(!bound.ok && bound.error).toBe(`request signer ${SIGNER} is not the delegation anchor key (${OTHER}) — only the key that anchors the agent's delegation may sign for them`);
    const unread = await decideCallerPrincipal(signed(AGENT), checks({ anchorOf: async () => null }).c, BOUND);
    expect(!unread.ok && unread.error).toBe(`request signer ${SIGNER} is not the delegation anchor key — only the key that anchors the agent's delegation may sign for them`);
  });

  describe('agentIdBounds: bindSignedCaller refused a malformed agent_id (400); the other two did not look', () => {
    const withNewline = `${AGENT}\n<urn:x> <urn:y> <urn:z> .`;
    const long = `https://relay.example/agents/${'a'.repeat(AGENT_ID_MAX_LENGTH)}`;

    it('a control character: refused with it on, before any pod is read', async () => {
      const { c, calls } = checks();
      expect(await decideCallerPrincipal(signed(withNewline), c, BOUND)).toEqual({
        ok: false, reason: 'agent-id-control-character', status: 400,
        error: 'agent_id contains a control character — an identity must be a single line of printable text',
      });
      expect(calls.podFor).toEqual([]);
    });

    it('a control character: goes on to the delegation check with it off', async () => {
      const { c, calls } = checks();
      const r = await decideCallerPrincipal(signed(withNewline), c, PLAIN);
      expect(r.ok && r.principal).toMatchObject({ subject: withNewline, authMode: 'delegated' });
      expect(calls.podFor).toEqual([withNewline]);
    });

    it('over 512 characters: refused with it on, saying the length', async () => {
      expect(await decideCallerPrincipal(signed(long), checks().c, BOUND)).toEqual({
        ok: false, reason: 'agent-id-too-long', status: 400,
        error: `agent_id is ${long.length} characters — the limit is 512`,
      });
    });

    it('exactly 512 characters is allowed; over 512 with it off is too', async () => {
      const at = 'x'.repeat(512);
      expect((await decideCallerPrincipal(signed(at), checks().c, BOUND)).ok).toBe(true);
      expect((await decideCallerPrincipal(signed(long), checks().c, PLAIN)).ok).toBe(true);
    });

    it('the check comes BEFORE direct: a direct agent_id with a control character is refused with it on, accepted with it off', async () => {
      const direct = `did:ethr:${SIGNER} `;
      expect(await decideCallerPrincipal(signed(direct), checks().c, BOUND)).toMatchObject({ ok: false, status: 400, reason: 'agent-id-control-character' });
      const r = await decideCallerPrincipal(signed(direct), checks().c, PLAIN);
      expect(r.ok && r.principal).toMatchObject({ subject: `did:ethr:${SIGNER}`, authMode: 'direct' });
    });

    it('the control-character refusal wins over the length refusal', async () => {
      const r = await decideCallerPrincipal(signed(`${long}\t`), checks().c, BOUND);
      expect(r).toMatchObject({ ok: false, reason: 'agent-id-control-character' });
    });
  });
});

/**
 * resolveForCaller in server.ts used to decide learner kind with
 *     callerDid === `did:ethr:${signer}` ? 'human' : 'agent'
 * and now reads `principal.authMode === 'direct'`. They are the same test whenever the signer is
 * an address, which recoverSignedRequest guarantees (ethers.verifyMessage returns one; a session
 * key's signer is ethers.getAddress of the granting wallet): if agent_id is exactly
 * `did:ethr:<signer>` its first (only) address IS the signer, so the caller is direct; and a
 * direct caller's subject is `did:ethr:<signer>` by construction.
 */
describe('authMode is direct exactly when the subject is did:ethr:<signer>', () => {
  const ids = [
    `did:ethr:${SIGNER}`, `did:ethr:${SIGNER.toLowerCase()}`, `DID:ETHR:${SIGNER}`, `did:ethr:0x1:${SIGNER}`,
    `did:pkh:eip155:1:${SIGNER}`, SIGNER, `did:ethr:${OTHER}`, `did:ethr:${OTHER}#${SIGNER}`, `did:ethr:${SIGNER}#${OTHER}`,
    `did:ethr:${SIGNER.slice(0, -1)}`, `did:ethr:${SIGNER}0`, ` did:ethr:${SIGNER}`, AGENT, 'did:web:example.com', 'did:ethr:', '',
  ];
  for (const opts of [PLAIN, BOUND]) {
    for (const id of ids) {
      it(`${JSON.stringify(id)} (${opts.agentIdBounds ? 'bound' : 'plain'})`, async () => {
        const r = await decideCallerPrincipal(signed(id), checks().c, opts);
        if (!r.ok) throw new Error(r.error);
        const old = r.principal.subject === directSubject(r.principal.key) ? 'human' : 'agent';
        const now = r.principal.authMode === 'direct' ? 'human' : 'agent';
        expect(now).toBe(old);
        expect(r.principal.kind).toBe(now);
        expect(r.principal.key).toBe(SIGNER);
      });
    }
  }
});
