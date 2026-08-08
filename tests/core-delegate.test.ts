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
  judgeAuthorship, authorshipLine, footingLine, footingActivityIri, footingTurtle,
  parseDelegateLabel, publishDelegation, readDelegates,
  relayRefusal, revokeDelegation, scopeCeiling, scopeWriteEligible,
  type AuthorshipStatements, type DelegateRegistryPort, type EntryFooting,
} from '@interego/core/delegate';
import * as relay from '@interego/core/relay';
// The builder the relay calls on every publish, and the serializer that turns it into the bytes a
// reader actually meets. Both are needed to pin a convention that lives in the output, not the API.
import { ContextDescriptor } from '@interego/core/model';
import { toTurtle } from '@interego/core/rdf';
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
    // The footing pair moved down with the rest of the delegate affordance, for the same reason:
    // which triples say "on this person's behalf" must be ONE answer across every vertical.
    expect(vertical.footingTurtle).toBe(footingTurtle);
    expect(vertical.footingLine).toBe(footingLine);
  });

  /**
   * ★ THE RELAY TRANSPORT IS THE SUBSTRATE'S NOW, AND IDENTITY IS WHAT PROVES IT MOVED.
   *
   * `RelayMcpTransport`, `ConnectorTransport`, `pollingWatch` and the two refusal readers lived in
   * `@interego/workspace-client` — a vertical — and every client in every vertical needs them, so
   * a peer had to reach sideways into shared-workspace to call a relay. They are
   * `@interego/core/relay`; the vertical re-exports them so the generated artifact bundle keeps
   * pulling one implementation into itself. A re-export satisfies these; a copy cannot.
   */
  it('★ the relay transport and client are the SUBSTRATE\'s, re-exported', () => {
    expect(vertical.RelayMcpTransport).toBe(relay.RelayMcpTransport);
    expect(vertical.ConnectorTransport).toBe(relay.ConnectorTransport);
    expect(vertical.pollingWatch).toBe(relay.pollingWatch);
    expect(vertical.asRefusal).toBe(relay.asRefusal);
    expect(vertical.ToolCallError).toBe(relay.ToolCallError);
    expect(vertical.errorCopy).toBe(relay.errorCopy);
    expect(vertical.assertPod).toBe(relay.assertPod);
    // And the workspace client IS the substrate's client, plus the two methods that read
    // workspace documents — composition, so there is no second client to keep in agreement.
    expect(Object.getPrototypeOf(vertical.WorkspaceClient)).toBe(relay.RelayClient);
    expect(new vertical.WorkspaceClient('https://r', null as never)).toBeInstanceOf(relay.RelayClient);
  });

  /**
   * ★ AND THE SHARED CLIENT NO LONGER KNOWS DISCORD EXISTS.
   *
   * A snowflake regex and a Discord link-plan builder were exported from the package that the
   * published artifact, the desktop shell and the bot all bundle — including an artifact with no
   * Discord feature at all. Every other conduit would have arrived the same way, one regex at a
   * time. The names are gone from this surface; they live in the conduit that owns them, and the
   * one definition of `challengeLabel` is still one.
   */
  it('★ no Discord vocabulary is exported by the shared workspace client', () => {
    const exported = Object.keys(vertical as Record<string, unknown>);
    expect(exported).not.toContain('SNOWFLAKE_RX');
    expect(exported).not.toContain('challengeLabel');
    expect(exported).not.toContain('discordLinkPlan');
    // Nothing else Discord-shaped slipped in under another name either.
    expect(exported.filter((k) => /discord|snowflake/i.test(k))).toEqual([]);
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

  /** One entry's statements. Every field defaults empty, so each case says only what it means. */
  const ACT = 'https://relay.example/ns/p/s/e/0#act';
  const DEL = 'https://relay.example/ns/p/s/e/0#delegation';
  const st = (o: Partial<AuthorshipStatements>): AuthorshipStatements => ({
    attributedTo: [], generatedBy: [], qualifiedDelegation: [],
    delegationAgent: [], delegationActivity: [], actedOnOwnAccount: [], ...o,
  });
  /** A delegate speaking FOR the log's owner, in the PROV shape `footingTurtle` writes. */
  const forOwner = st({
    attributedTo: [D1], generatedBy: [ACT], qualifiedDelegation: [DEL],
    delegationAgent: [WEBID], delegationActivity: [ACT],
  });
  /** The same delegate, the same act, the other footing. */
  const ownAccount = st({ attributedTo: [D1], generatedBy: [ACT], actedOnOwnAccount: [ACT] });

  it('the answers come from IRI lists, with no parser involved', () => {
    expect(judgeAuthorship(st({ attributedTo: [WEBID] }), { logOwnerWebId: WEBID, delegates: null }).kind).toBe('principal');
    const d = judgeAuthorship(forOwner, { logOwnerWebId: WEBID, delegates: full });
    expect(d.kind).toBe('delegate');
    expect(d.kind === 'delegate' && d.authorised).toBe(true);
    expect(d.kind === 'delegate' && d.name).toBe('Claude side');
  });

  /**
   * ★ THE CORRECTION ITSELF. Standing delegation and the footing of one utterance are two facts,
   * and the pair below differs in nothing except the second. If a change ever collapses them again,
   * these are the assertions that go red: same roster, same agent, same `authorised: true`, and two
   * different answers to "was this said for the human".
   */
  it('★ the SAME delegate, the SAME standing, two different footings', () => {
    const a = judgeAuthorship(forOwner, { logOwnerWebId: WEBID, delegates: full });
    const b = judgeAuthorship(ownAccount, { logOwnerWebId: WEBID, delegates: full });
    expect(a.kind === 'delegate' && a.footing.kind).toBe('on-behalf-of');
    expect(a.kind === 'delegate' && a.footing.kind === 'on-behalf-of' && a.footing.principal).toBe(WEBID);
    expect(b.kind === 'delegate' && b.footing.kind).toBe('own-account');
    // The standing fact is identical across the two, which is exactly the point.
    expect(a.kind === 'delegate' && a.authorised).toBe(true);
    expect(b.kind === 'delegate' && b.authorised).toBe(true);
    expect(a.kind === 'delegate' && a.agentId).toBe(b.kind === 'delegate' ? b.agentId : 'different');
  });

  it('★ an entry that states NEITHER footing is `not-stated` — not either of the two', () => {
    const d = judgeAuthorship(st({ attributedTo: [D1], generatedBy: [ACT] }), { logOwnerWebId: WEBID, delegates: full });
    expect(d.kind).toBe('delegate');
    expect(d.kind === 'delegate' && d.footing.kind).toBe('not-stated');
    // Under the old model this exact record was `disputed` — absence read as a contradiction. It
    // is a record that does not say, and the check that actually matters is the registry's.
    expect(d.kind === 'delegate' && d.authorised).toBe(true);
  });

  it('★ an unread registry is `null`, never `false`', () => {
    const d = judgeAuthorship(forOwner, { logOwnerWebId: WEBID, delegates: null });
    expect(d.kind === 'delegate' && d.authorised).toBeNull();
  });

  it('★ every disagreement is reported, never resolved', () => {
    const cases: [string, AuthorshipStatements][] = [
      ['two authors', st({ attributedTo: [D1, WEBID] })],
      ['owner delegating to themselves', st({ attributedTo: [WEBID], generatedBy: [ACT], actedOnOwnAccount: [ACT] })],
      ['owner carrying a Delegation', st({ attributedTo: [WEBID], generatedBy: [ACT], qualifiedDelegation: [DEL], delegationAgent: [WEBID], delegationActivity: [ACT] })],
      ['a principal who is not the log owner', st({ attributedTo: [D1], generatedBy: [ACT], qualifiedDelegation: [DEL], delegationAgent: ['https://other/#me'], delegationActivity: [ACT] })],
      ['both footings at once', st({ attributedTo: [D1], generatedBy: [ACT], actedOnOwnAccount: [ACT], qualifiedDelegation: [DEL], delegationAgent: [WEBID], delegationActivity: [ACT] })],
      ['two activities', st({ attributedTo: [D1], generatedBy: [ACT, ACT + '2'] })],
      ['two Delegations', st({ attributedTo: [D1], generatedBy: [ACT], qualifiedDelegation: [DEL, DEL + '2'], delegationAgent: [WEBID], delegationActivity: [ACT] })],
      ['two principals in one Delegation', st({ attributedTo: [D1], generatedBy: [ACT], qualifiedDelegation: [DEL], delegationAgent: [WEBID, 'https://other/#me'], delegationActivity: [ACT] })],
      ['a Delegation over a DIFFERENT act', st({ attributedTo: [D1], generatedBy: [ACT], qualifiedDelegation: [DEL], delegationAgent: [WEBID], delegationActivity: ['https://elsewhere/#act'] })],
      ['own-account over a DIFFERENT act', st({ attributedTo: [D1], generatedBy: [ACT], actedOnOwnAccount: ['https://elsewhere/#act'] })],
      ['footing statements with no act to scope them', st({ attributedTo: [D1], qualifiedDelegation: [DEL], delegationAgent: [WEBID] })],
      ['a Delegation naming no act at all', st({ attributedTo: [D1], generatedBy: [ACT], qualifiedDelegation: [DEL], delegationAgent: [WEBID] })],
    ];
    for (const [why, s] of cases) {
      expect(judgeAuthorship(s, { logOwnerWebId: WEBID, delegates: null }).kind, why).toBe('disputed');
    }
    // And the two that are absence rather than conflict.
    expect(judgeAuthorship(null, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('unstated');
    expect(judgeAuthorship(st({}), { logOwnerWebId: WEBID, delegates: null }).kind).toBe('unstated');
  });

  it('the line a surface shows never turns absence into a name', () => {
    expect(authorshipLine({ kind: 'unstated', why: 'x' }, { displayName: 'Mark' })).toBe('author not stated');
    expect(authorshipLine({ kind: 'disputed', why: 'x' }, { displayName: 'Mark' })).toBe('authorship disputed');
    expect(authorshipLine({ kind: 'principal', webId: WEBID }, { displayName: 'Mark' })).toBe('Mark');
  });

  it('★ the three delegate lines are three different sentences', () => {
    const of = (f: EntryFooting): string => authorshipLine(
      { kind: 'delegate', agentId: D1, footing: f, name: 'Claude side', authorised: true, scope: 'PublishOnly' },
      { displayName: 'Mark' });
    const behalf = of({ kind: 'on-behalf-of', principal: WEBID });
    const own = of({ kind: 'own-account' });
    const none = of({ kind: 'not-stated', why: 'x' });
    expect(behalf).toBe('Claude side, speaking for Mark');
    expect(own).toBe('Claude side, a delegate of Mark, speaking for itself');
    expect(new Set([behalf, own, none]).size).toBe(3);
    // The one a skimming reader would otherwise get backwards has to say so in words.
    expect(own).toContain('for itself');
    expect(none).toContain('not stated');
  });

  it('★ footingLine says who is answerable, differently, for each of the three', () => {
    const behalf = footingLine({ kind: 'on-behalf-of', principal: WEBID }, { who: 'Mark', agentName: 'Claude side' });
    const own = footingLine({ kind: 'own-account' }, { who: 'Mark', agentName: 'Claude side' });
    const none = footingLine({ kind: 'not-stated', why: 'it says nothing' }, { who: 'Mark' });
    expect(behalf).toContain('retains responsibility');
    expect(own).toContain('is not answerable');
    // ★ AND THE OWN-ACCOUNT SENTENCE STILL SAYS THE DELEGATION STANDS. A reader told "speaking for
    // itself" must not conclude the agent went rogue or was never authorised.
    expect(own).toContain('standing fact');
    expect(none).toContain('does not say');
    expect(none).toContain('it says nothing');
  });
});

// ── writing the footing ──────────────────────────────────────────────────────

describe('the footing triples are the substrate\'s, and are PROV\'s own shape', () => {
  const E = 'https://relay.example/ns/p/s/e/3';
  const iri = (u: string, what: string): string => {
    if (!u) throw new Error(what + ' is missing');
    if (/[\s<>"{}|\\^`]/.test(u)) throw new Error(what + ' is not serializable: ' + u);
    return '<' + u + '>';
  };
  const T = '2026-08-07T10:00:00.000Z';

  it('on-behalf-of is a prov:Delegation tied to THIS act by prov:hadActivity', () => {
    const f = footingTurtle({ entryIri: E, agentId: D1, footing: { kind: 'on-behalf-of', principal: WEBID }, iri, endedIso: T });
    expect(f.generatedBy).toContain('prov:wasGeneratedBy <' + E + '#act>');
    expect(f.blocks).toContain('<' + D1 + '> prov:qualifiedDelegation <' + E + '#delegation>');
    expect(f.blocks).toContain('a prov:Delegation');
    expect(f.blocks).toContain('prov:agent <' + WEBID + '>');
    expect(f.blocks).toContain('prov:hadActivity <' + E + '#act>');
    // The negative must NOT appear: two positive statements about one act is the disputed case.
    expect(f.blocks).not.toContain('actedOnOwnAccount');
  });

  it('own-account states iep:actedOnOwnAccount and NO delegation', () => {
    const f = footingTurtle({ entryIri: E, agentId: D1, footing: { kind: 'own-account' }, iri, endedIso: T });
    expect(f.blocks).toContain('<' + D1 + '> iep:actedOnOwnAccount <' + E + '#act>');
    expect(f.blocks).not.toContain('prov:Delegation');
    expect(f.blocks).not.toContain('prov:qualifiedDelegation');
  });

  it('★ both shapes name the act, and it is the same act the entry was generated by', () => {
    for (const footing of [{ kind: 'on-behalf-of' as const, principal: WEBID }, { kind: 'own-account' as const }]) {
      const f = footingTurtle({ entryIri: E, agentId: D1, footing, iri, endedIso: T });
      expect(f.generatedBy).toContain(footingActivityIri(E));
      expect(f.blocks).toContain('<' + footingActivityIri(E) + '>\n  a prov:Activity');
      expect(f.blocks).toContain('prov:wasAssociatedWith <' + D1 + '>');
    }
  });

  it('★ an unserialisable IRI is refused, in every position', () => {
    const bad = 'https://evil/x> ; <urn:s> <urn:p> <urn:o';
    expect(() => footingTurtle({ entryIri: bad, agentId: D1, footing: { kind: 'own-account' }, iri, endedIso: T })).toThrow(/record IRI/);
    expect(() => footingTurtle({ entryIri: E, agentId: bad, footing: { kind: 'own-account' }, iri, endedIso: T })).toThrow(/agent id/);
    expect(() => footingTurtle({ entryIri: E, agentId: D1, footing: { kind: 'on-behalf-of', principal: bad }, iri, endedIso: T })).toThrow(/spoke for/);
  });
});

// ── the descriptor convention the relay writes on every publish ──────────────

/**
 * ★ ONE PREDICATE, ONE MEANING, ACROSS THE TWO PLACES THAT WRITE IT.
 *
 * `ContextDescriptor.delegatedBy` is called by the relay on EVERY publish, and it pointed
 * `prov:wasAttributedTo` at the pod OWNER while the shared-workspace vertical's own entries pointed
 * it at the AGENT. A reader crossing the two got different answers to "who wrote this", and the
 * builder was the one that was wrong: it said the human asserted descriptors they had never seen.
 * Nothing pinned the value before this, which is how the two conventions coexisted for as long as
 * they did.
 */
describe('a descriptor is attributed to whoever asserted it', () => {
  const OWNER = 'https://identity.example/users/mark/profile#me' as never;
  const AGENT = 'did:web:identity.example:agents:interego-delegate-u-eth-1' as never;
  const facets = (d: ReturnType<ContextDescriptor['build']>): Record<string, Record<string, unknown>> =>
    Object.fromEntries((d.facets as unknown as Record<string, unknown>[]).map((f) => [String(f['type']), f]));

  it('★ delegatedBy attributes to the AGENT, and records the owner as the standing principal', () => {
    const f = facets(new ContextDescriptor('urn:x' as never).describes('urn:g' as never).delegatedBy(OWNER, AGENT).build());
    expect(f['Provenance']?.['wasAttributedTo']).toBe(AGENT);
    expect(f['Provenance']?.['wasAttributedTo']).not.toBe(OWNER);
    // The owner is not dropped — it is the separate fact, on the facet that means it.
    expect(f['Agent']?.['onBehalfOf']).toBe(OWNER);
    expect((f['Provenance']?.['wasGeneratedBy'] as { agent?: string })?.agent).toBe(AGENT);
  });

  it('★ generatedBy agrees with it, so the two builders cannot say different things', () => {
    const f = facets(new ContextDescriptor('urn:x' as never).describes('urn:g' as never).generatedBy(AGENT, { onBehalfOf: OWNER }).build());
    expect(f['Provenance']?.['wasAttributedTo']).toBe(AGENT);
    expect(f['Agent']?.['onBehalfOf']).toBe(OWNER);
  });

  /**
   * ★ AND IT DOES NOT EMIT `prov:actedOnBehalfOf`, which would look like the obvious companion fix
   * and is the same defect one layer up. PROV scopes that relation to "an actual activity" with the
   * principal retaining responsibility for the outcome; asserting it on every publish would say of
   * every act what is only true of some — exactly what the entry layer has just stopped doing.
   */
  it('★ the descriptor states standing delegation, never a per-act one', () => {
    const ttl = toTurtle(new ContextDescriptor('urn:x' as never).describes('urn:g' as never).delegatedBy(OWNER, AGENT).build());
    expect(ttl).toContain('iep:onBehalfOf <' + OWNER + '>');
    expect(ttl).not.toContain('actedOnBehalfOf');
    expect(ttl).not.toContain('qualifiedDelegation');
    expect(ttl).toContain('prov:wasAttributedTo <' + AGENT + '>');
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
