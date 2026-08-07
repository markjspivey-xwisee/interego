/**
 * THE DELEGATE AFFORDANCE IS THE SUBSTRATE'S, AND THESE TESTS ARE WHERE THAT IS ENFORCED.
 *
 * ★ WHY A TEST FILE AND NOT A COMMENT. "An agent a person authorises to act for them" was built
 * inside `@interego/workspace-client` and had to come down to `@interego/core`, beside the
 * `AuthorizedAgentData` / signed-VC / `verifyDelegation` model that has always carried
 * `delegatedBy`. A relocation is only worth anything if the vertical now COMPOSES the substrate
 * rather than shipping a second copy that agrees today — so the first block below asserts
 * function IDENTITY across the two import paths, which a copy cannot satisfy however carefully
 * it is written.
 *
 * The rest drives the guards that moved. `tests/workspace-client-delegates.test.ts` covers the
 * ones the vertical already exercised; what is here is the read-back pair (`publishDelegation` /
 * `revokeDelegation`), which had NO coverage before the move, and the label check that the move
 * added.
 */

import { describe, it, expect } from 'vitest';
import {
  DELEGATE_LABEL_PREFIX, DELEGATE_SURFACE, WRITE_ELIGIBLE_SCOPES, DELEGATION_SCOPES,
  delegateAgentId, delegateLabel, delegateNameProblem, delegatePlan, isDelegateRow,
  judgeAuthorship, authorshipLine, parseDelegateLabel, publishDelegation, readDelegates,
  relayRefusal, revokeDelegation, scopeCeiling, scopeWriteEligible,
  type DelegateRegistryPort,
} from '@interego/core/delegate';
import * as vertical from '@interego/workspace-client';

const POD = 'u-eth-aaaaaaaaaaaa';
const WEBID = 'https://identity.interego.xwisee.com/users/' + POD + '/profile#me';
const D1 = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-111111111111';

/** A port that answers from a table, and records what it was asked. */
function port(
  answers: Record<string, (i: Record<string, unknown>) => unknown>,
): DelegateRegistryPort & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    tool: async (name, args) => {
      calls.push({ name, args });
      const fn = answers[name];
      if (!fn) throw new Error('this test scripted no answer for ' + name);
      return fn(args);
    },
    describeError: (e) => String((e as Error).message),
  };
}

const row = (agentId: string, label: string, scope: string): Record<string, unknown> =>
  ({ agentId, scope, label, validFrom: '2026-08-07T00:00:00.000Z' });

const status = (rows: readonly Record<string, unknown>[]): Record<string, unknown> =>
  ({ pod: 'http://css/' + POD + '/', delegationRegistry: { owner: WEBID, rows } });

// ── the layering itself ──────────────────────────────────────────────────────

describe('the delegate is an Interego concept and the vertical composes it', () => {
  it('★ the vertical re-exports the SUBSTRATE function, it does not define its own', () => {
    // A copy can be made to agree on every input and still be a copy. Identity cannot be faked:
    // if `workspace-client` ever reintroduces a local definition, these fail immediately.
    expect(vertical.judgeAuthorship).toBe(judgeAuthorship);
    expect(vertical.authorshipLine).toBe(authorshipLine);
    expect(vertical.readDelegates).toBe(readDelegates);
    expect(vertical.publishDelegation).toBe(publishDelegation);
    expect(vertical.revokeDelegation).toBe(revokeDelegation);
    expect(vertical.scopeCeiling).toBe(scopeCeiling);
    expect(vertical.delegatePlan).toBe(delegatePlan);
    expect(vertical.delegateAgentId).toBe(delegateAgentId);
    expect(vertical.DELEGATE_SURFACE).toBe(DELEGATE_SURFACE);
  });

  it('★ the scope vocabulary is the substrate\'s ONE union, not a vertical\'s second spelling', () => {
    // `agentlink.ts` used to declare these four strings itself, beside the four `@interego/core`
    // has always exported. Two spellings of the enum the relay's scope gate tests against could
    // only ever agree by luck.
    expect(vertical.DELEGATION_SCOPES).toBe(DELEGATION_SCOPES);
    expect(vertical.WRITE_ELIGIBLE_SCOPES).toBe(WRITE_ELIGIBLE_SCOPES);
    expect([...DELEGATION_SCOPES]).toEqual(['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly']);
    // `Read` is NOT one of them: the relay's schema offers it and silently stores DiscoverOnly.
    expect(DELEGATION_SCOPES).not.toContain('Read');
  });

  it('★ the relay refusal envelope has ONE reader', () => {
    expect(vertical.refusal).toBe(relayRefusal);
    expect(relayRefusal({ error: 'scope_violation' })).not.toBeNull();
    expect(relayRefusal({ ok: true })).toBeNull();
  });

  it('★ the delegate label names no vertical', () => {
    // It was `workspace-delegate `, which stamped every delegate anybody ever authorised — a
    // Foxxi one, a research one — with the name of one vertical, on a world-readable pod row.
    expect(DELEGATE_LABEL_PREFIX).toBe('delegate ');
    expect(DELEGATE_LABEL_PREFIX).not.toMatch(/workspace|discord|desktop|foxxi/i);
    expect(parseDelegateLabel(delegateLabel('Research assistant'))).toBe('Research assistant');
    expect(parseDelegateLabel('some other agent')).toBeNull();
  });
});

// ── the registry read ────────────────────────────────────────────────────────

describe('reading a pod\'s delegates', () => {
  it('a row IS the substrate registry row, carrying who delegated it', () => {
    const p = port({ get_pod_status: () => status([row(D1, delegateLabel('Claude side'), 'PublishOnly')]) });
    return readDelegates(p, POD).then((r) => {
      expect(r.read).toBe(true);
      expect(r.owner).toBe(WEBID);
      const d = r.delegates[0];
      // `delegatedBy` is the field the vertical's own row type could not express at all.
      expect(d?.delegatedBy).toBe(WEBID);
      expect(d?.name).toBe('Claude side');
      expect(d?.writeEligible).toBe(true);
      expect(isDelegateRow(d!)).toBe(true);
    });
  });

  it('★ a read that FAILED is not an empty roster', async () => {
    const thrown = await readDelegates(port({ get_pod_status: () => { throw new Error('boom'); } }), POD);
    expect(thrown.read).toBe(false);
    expect(thrown.why).toMatch(/not established/);
    // The distinction that matters: `read: false` with zero rows must never be rendered as
    // "this person has authorised nobody".
    const empty = await readDelegates(port({ get_pod_status: () => status([]) }), POD);
    expect(empty.read).toBe(true);
    expect(empty.rows).toEqual([]);
  });

  it('a pod with no registry at all is distinguished from one delegating nothing', async () => {
    const r = await readDelegates(port({ get_pod_status: () => ({ pod: 'http://css/x/' }) }), POD);
    expect(r.read).toBe(false);
    expect(r.why).toMatch(/different from it delegating nothing/);
  });
});

// ── the write, and the read-back that is the only thing establishing it ──────

describe('publishing a delegation is established by reading the pod back', () => {
  const plan = delegatePlan({ agentId: D1, name: 'Claude side' });

  it('★ `published` requires the ROW, not the relay\'s acknowledgement', async () => {
    // The relay says yes and the registry does not list it. Reporting that as published is
    // exactly the failure the read-back exists to catch.
    const p = port({
      register_agent: () => ({ registered: true }),
      get_pod_status: () => status([]),
    });
    const out = await publishDelegation(p, { plan, verifyOnPod: POD });
    expect(out.kind).toBe('unconfirmed');
    expect(out.listed).toBeNull();
    // Not `refused`: the write may well have landed, and saying it failed would invent a fact.
    expect(out.kind).not.toBe('refused');
    expect(out.why).toMatch(/may still be there/);
  });

  it('a row that IS listed reports published, with the scope the pod actually holds', async () => {
    const p = port({
      register_agent: () => ({ registered: true }),
      get_pod_status: () => status([row(D1, delegateLabel('Claude side'), 'PublishOnly')]),
    });
    const out = await publishDelegation(p, { plan, verifyOnPod: POD });
    expect(out.kind).toBe('published');
    expect(out.listed?.scope).toBe('PublishOnly');
    // `pod_name` is deliberately absent: register_agent is own-pod gated at the relay.
    expect(p.calls[0]?.args).not.toHaveProperty('pod_name');
  });

  it('★ a row under a DIFFERENT LABEL is not the row that was planned', async () => {
    // The label carries the CLAIM in a conduit link ("this delegation is for account U"). A row
    // that exists under another label would confirm a binding nobody wrote.
    const p = port({
      register_agent: () => ({ registered: true }),
      get_pod_status: () => status([row(D1, 'discord-link 999', 'PublishOnly')]),
    });
    const out = await publishDelegation(p, { plan, verifyOnPod: POD });
    expect(out.kind).toBe('unconfirmed');
    expect(out.why).toMatch(/not the row that is there/);
  });

  it('a relay refusal is reported as refused, and nothing is read back', async () => {
    const p = port({ register_agent: () => ({ error: 'scope_violation', message: 'no' }) });
    const out = await publishDelegation(p, { plan, verifyOnPod: POD });
    expect(out.kind).toBe('refused');
    expect(out.roster).toBeNull();
    expect(p.calls.some((c) => c.name === 'get_pod_status')).toBe(false);
  });

  it('a plan with problems never reaches the relay', async () => {
    const bad = delegatePlan({ agentId: '', name: '' });
    const p = port({});
    const out = await publishDelegation(p, { plan: bad, verifyOnPod: POD });
    expect(out.kind).toBe('invalid');
    expect(p.calls).toEqual([]);
    // The name problem lands on the NAME field — the vertical's union had no such field and had
    // to file it against `agentId`, lighting up the wrong input.
    expect(bad.problems.some((x) => x.field === 'name')).toBe(true);
  });
});

describe('revoking inverts the read-back', () => {
  it('★ success is the row being ABSENT', async () => {
    const p = port({ revoke_agent: () => ({ revoked: true }), get_pod_status: () => status([]) });
    const out = await revokeDelegation(p, { agentId: D1, podName: POD });
    expect(out.kind).toBe('revoked');
    // The 60s relay permission cache is stated at the moment it matters.
    expect(out.why).toMatch(/60 seconds/);
  });

  it('★ a relay that says revoked while the row stands is NOT a revocation', async () => {
    const p = port({
      revoke_agent: () => ({ revoked: true }),
      get_pod_status: () => status([row(D1, delegateLabel('Claude side'), 'PublishOnly')]),
    });
    const out = await revokeDelegation(p, { agentId: D1, podName: POD });
    expect(out.kind).toBe('still-listed');
  });

  it('a pod that cannot be read back does not report a revocation', async () => {
    const p = port({ revoke_agent: () => ({ revoked: true }), get_pod_status: () => { throw new Error('down'); } });
    expect((await revokeDelegation(p, { agentId: D1, podName: POD })).kind).toBe('still-listed');
  });
});

// ── the substrate half of the ceiling ────────────────────────────────────────

describe('the scope ceiling is the substrate\'s and has no opinion about roles', () => {
  it('a non-publishing scope refuses before the relay would', () => {
    expect(scopeCeiling({ scope: 'ReadOnly', delegateName: 'Reader' }).ok).toBe(false);
    expect(scopeCeiling({ scope: 'PublishOnly', delegateName: 'Writer' }).ok).toBe(true);
    expect(scopeCeiling({ scope: 'ReadWrite', delegateName: 'Writer' }).ok).toBe(true);
  });

  it('★ an unread scope is a QUESTION, and a question is not permission', () => {
    const v = scopeCeiling({ scope: null, delegateName: null });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/not established/);
  });

  it('scopeWriteEligible agrees with the published list, for any string', () => {
    for (const s of DELEGATION_SCOPES) {
      expect(scopeWriteEligible(s)).toBe((WRITE_ELIGIBLE_SCOPES as readonly string[]).includes(s));
    }
    expect(scopeWriteEligible(null)).toBe(false);
    expect(scopeWriteEligible('Read')).toBe(false);
  });
});

// ── attribution, over IRIs rather than a serialization ───────────────────────

describe('judging authorship is portable across serializations', () => {
  const roster = (rows: readonly Record<string, unknown>[]) => ({
    podName: POD, read: true, owner: WEBID as never, why: null,
    rows: rows.map((r) => ({
      agentId: String(r['agentId']) as never, delegatedBy: WEBID as never,
      label: r['label'] as string, scope: r['scope'] as never,
      validFrom: '2026-08-07T00:00:00.000Z',
      name: parseDelegateLabel(r['label'] as string), writeEligible: true,
    })),
  });
  const r = roster([row(D1, delegateLabel('Claude side'), 'PublishOnly')]);
  const full = { ...r, delegates: r.rows, others: [] };

  it('the same eight answers come from IRI lists, with no parser involved', () => {
    expect(judgeAuthorship({ attributedTo: [WEBID], actedOnBehalfOf: [] }, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('principal');
    const d = judgeAuthorship({ attributedTo: [D1], actedOnBehalfOf: [WEBID] }, { logOwnerWebId: WEBID, delegates: full });
    expect(d.kind).toBe('delegate');
    expect(d.kind === 'delegate' && d.authorised).toBe(true);
    expect(d.kind === 'delegate' && d.name).toBe('Claude side');
  });

  it('★ an unread registry is `null`, never `false`', () => {
    const d = judgeAuthorship({ attributedTo: [D1], actedOnBehalfOf: [WEBID] }, { logOwnerWebId: WEBID, delegates: null });
    expect(d.kind === 'delegate' && d.authorised).toBeNull();
  });

  it('★ every disagreement is reported, never resolved', () => {
    const cases: [string, { attributedTo: string[]; actedOnBehalfOf: string[] }][] = [
      ['two authors', { attributedTo: [D1, WEBID], actedOnBehalfOf: [] }],
      ['owner acting for themselves', { attributedTo: [WEBID], actedOnBehalfOf: [WEBID] }],
      ['a stranger with no principal', { attributedTo: [D1], actedOnBehalfOf: [] }],
      ['two principals', { attributedTo: [D1], actedOnBehalfOf: [WEBID, 'https://other/#me'] }],
      ['a principal who is not the log owner', { attributedTo: [D1], actedOnBehalfOf: ['https://other/#me'] }],
    ];
    for (const [why, s] of cases) {
      expect(judgeAuthorship(s, { logOwnerWebId: WEBID, delegates: null }).kind, why).toBe('disputed');
    }
    // And the two that are absence rather than conflict.
    expect(judgeAuthorship(null, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('unstated');
    expect(judgeAuthorship({ attributedTo: [], actedOnBehalfOf: [] }, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('unstated');
  });

  it('the line a surface shows never turns absence into a name', () => {
    expect(authorshipLine({ kind: 'unstated', why: 'x' }, { displayName: 'Mark' })).toBe('author not stated');
    expect(authorshipLine({ kind: 'disputed', why: 'x' }, { displayName: 'Mark' })).toBe('authorship disputed');
    expect(authorshipLine({ kind: 'principal', webId: WEBID }, { displayName: 'Mark' })).toBe('Mark');
  });
});

// ── naming ───────────────────────────────────────────────────────────────────

describe('a delegate name is refused rather than repaired', () => {
  it('a control character is refused, not stripped', () => {
    expect(delegateNameProblem('ab')).toMatch(/control character/);
    expect(delegateNameProblem('ok name')).toBeNull();
  });
  it('empty and over-long are refused', () => {
    expect(delegateNameProblem('   ')).toBeTruthy();
    expect(delegateNameProblem('x'.repeat(49))).toMatch(/49 characters/);
    expect(delegateNameProblem('x'.repeat(48))).toBeNull();
  });
  it('the id is a function of the key and one shared surface, never an application', () => {
    expect(delegateAgentId('identity.interego.xwisee.com', 'u-eth-111111111111')).toBe(D1);
    expect(DELEGATE_SURFACE).not.toMatch(/desktop|discord|artifact|electron|workspace/i);
  });
});
