/**
 * A DELEGATE IS NOT THE PERSON, AND EVERY CASE HERE IS A SENTENCE THAT WOULD BE A LIE OTHERWISE.
 *
 * ★ WHAT THIS FILE IS FOR. The correction it guards is one wrong default: before it, an agent
 * running on somebody's machine wrote as them — same identity, same WebID, indistinguishable in
 * the record. Each case below was checked against the defect DELIBERATELY RESTORED and observed
 * to fail; a test that passes with the defect back is worth nothing.
 *
 * ★ AND THE LINE THAT MUST NOT MOVE. A conduit relaying words a human TYPED is that human's
 * entry. Only text an agent COMPOSED is the agent's. The `principal` cases below are that side
 * of the line and they are as load-bearing as the `delegate` ones.
 *
 * The suite tests BUILT OUTPUT: run `npm run build --workspace @interego/workspace-client` first.
 */

import { describe, it, expect } from 'vitest';
import {
  DELEGATE_LABEL_PREFIX, DELEGATE_NAME_MAX, DELEGATE_SURFACE,
  authorshipLine, delegateAgentId, delegateCeiling, delegateLabel, delegateNameProblem,
  delegatePlan, entryTurtle, graphRegion, parseDelegateLabel, readDelegates, readEntryAuthorship,
  readIriAll, RelayMcpTransport, shapesTurtle, WorkspaceClient, isDelegateRow,
  type AnyTransport, type DelegateRoster, type DelegateRow, type DelegationScope, type RoleTable,
} from '@interego/workspace-client';
import type { IRI } from '@interego/core';

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-aaaaaaaaaaaa';
const WEBID = 'https://identity.interego.xwisee.com/users/' + POD + '/profile#me';
const OTHER = 'https://identity.interego.xwisee.com/users/u-eth-bbbbbbbbbbbb/profile#me';
/** The shape the live relay actually issues — measured, see `delegates.ts`. */
const D1 = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-111111111111';
const D2 = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-222222222222';
const WS = RELAY + '/ns/' + POD + '/room';
const ROLE = WS + '-roles#Contributor';
const STREAM = RELAY + '/ns/' + POD + '/' + POD + '--room-stream';

const roles = (): RoleTable => ({
  roles: new Map([[ROLE, { label: 'Contributor', comment: 'Reads and writes their own log.', permits: [WS + '-roles#Read', WS + '-roles#Post'] }]]),
  caps: new Map([[WS + '-roles#Post', { label: 'Post to the channel', comment: 'Append to your own log.' }]]),
} as unknown as RoleTable);

/** A transport that answers from a table. Only shapes the live run produced are used. */
function client(answers: Record<string, (input: Record<string, unknown>) => unknown>): WorkspaceClient {
  const tx = {
    accepts: 'relay-oauth-bearer',
    label: 'stub',
    watchDescription: 'not watched in this test',
    connect: async () => ({ granted: [] }),
    callTool: async (name: string, input: Record<string, unknown>) => {
      const fn = answers[name];
      if (!fn) throw new Error('this test scripted no answer for ' + name);
      return fn(input);
    },
  } as unknown as AnyTransport;
  void RelayMcpTransport;
  return new WorkspaceClient(RELAY, tx);
}

const registry = (rows: readonly Record<string, unknown>[]): Record<string, (i: Record<string, unknown>) => unknown> => ({
  get_pod_status: () => ({ pod: 'http://css.railway.internal:3456/' + POD + '/', delegationRegistry: { owner: WEBID, rows } }),
});

const row = (agentId: string, name: string | null, scope: string | null): Record<string, unknown> => ({
  agentId, scope, label: name === null ? 'some other agent' : delegateLabel(name), validFrom: '2026-08-07T00:00:00.000Z',
});

/** The roster the readers take, built without a network round trip where one is not the point. */
const roster = (rows: readonly Record<string, unknown>[]): DelegateRoster => {
  // A row IS the substrate's `AuthorizedAgentData` — `delegatedBy` included, which the vertical's
  // old local row type could not carry, so a fixture could not express "delegated by whom" at all.
  const parsed: DelegateRow[] = rows.map((r) => ({
    agentId: String(r['agentId']) as IRI,
    delegatedBy: WEBID as IRI,
    name: parseDelegateLabel(r['label'] as string),
    scope: ((r['scope'] as string) ?? '') as DelegationScope,
    label: (r['label'] as string) ?? '',
    validFrom: (r['validFrom'] as string) ?? '',
    writeEligible: ['ReadWrite', 'PublishOnly'].includes((r['scope'] as string) ?? ''),
  }));
  return {
    podName: POD, read: true, owner: WEBID as IRI, rows: parsed,
    delegates: parsed.filter(isDelegateRow), others: parsed.filter((p) => !isDelegateRow(p)), why: null,
  };
};

// ── the identity ─────────────────────────────────────────────────────────────

describe('a delegate identity is its key, not its host and not its channel', () => {
  it('★ the agent id is derived from the pod and ONE shared surface, never from an application', () => {
    // Measured live: the relay puts the OAuth client_name inside the DID. If a host used its own
    // name here, the same key would be a different delegate in every client that ran it.
    expect(delegateAgentId('identity.interego.xwisee.com', 'u-eth-111111111111')).toBe(D1);
    expect(DELEGATE_SURFACE).toBe('interego-delegate');
    // The constant carries no application name, no install id, no session id, no channel.
    expect(DELEGATE_SURFACE).not.toMatch(/desktop|discord|artifact|electron|app/i);
  });

  it('★ the same key in two hosts is the same delegate', () => {
    const fromDesktop = delegateAgentId('identity.interego.xwisee.com', 'u-eth-111111111111');
    const fromSomewhereElse = delegateAgentId('identity.interego.xwisee.com', 'u-eth-111111111111');
    expect(fromDesktop).toBe(fromSomewhereElse);
  });

  it('a delegate label round-trips, and a non-delegate row parses to null rather than to a name', () => {
    expect(parseDelegateLabel(delegateLabel('Research assistant'))).toBe('Research assistant');
    expect(parseDelegateLabel('discord-link 4242')).toBeNull();
    expect(parseDelegateLabel(null)).toBeNull();
    expect(parseDelegateLabel(DELEGATE_LABEL_PREFIX)).toBeNull();  // prefix with no name is no name
  });

  it('★ refuses a name it would otherwise have to strip', () => {
    expect(delegateNameProblem('')).toMatch(/Give this delegate a name/);
    expect(delegateNameProblem('x'.repeat(DELEGATE_NAME_MAX + 1))).toMatch(/limit is 48/);
    expect(delegateNameProblem('a\nb')).toMatch(/control character/);
    // Built rather than written as an escape, and the reason is a defect this round produced:
    // a control character typed into source lands as a RAW byte, git then treats the whole file
    // as binary, and `tests/line-endings-are-normalised.test.ts` fails with no reviewable diff.
    // `String.fromCharCode` says exactly which code point is meant and cannot become one.
    expect(delegateNameProblem('a' + String.fromCharCode(0) + 'b')).toMatch(/control character/);
    expect(delegateNameProblem('a' + String.fromCharCode(0x7f) + 'b')).toMatch(/control character/);
    expect(delegateNameProblem(DELEGATE_LABEL_PREFIX + 'Bob')).toMatch(/prefix this client already adds/);
    expect(delegateNameProblem('Research assistant')).toBeNull();
  });
});

describe('the plan is shown before the call is made', () => {
  it('names the exact register_agent arguments and defaults to the narrowest writing scope', () => {
    const p = delegatePlan({ agentId: D1, name: 'Research assistant' });
    expect(p.call).toEqual({ tool: 'register_agent', args: { agent_id: D1, scope: 'PublishOnly', label: delegateLabel('Research assistant') } });
  });

  it('★ states that entries name the delegate as author and the person as who it acted for', () => {
    const p = delegatePlan({ agentId: D1, name: 'Research assistant' });
    expect(p.limits.join(' ')).toMatch(/name IT as the author and YOU as the person it acted for/);
    expect(p.limits.join(' ')).toMatch(/POD-WIDE/);
    expect(p.limits.join(' ')).toMatch(/60 seconds/);
  });

  it('refuses to describe a call it cannot make, and says which field', () => {
    expect(delegatePlan({ agentId: '', name: 'x' }).call).toBeNull();
    expect(delegatePlan({ agentId: 'not an id', name: 'x' }).problems[0]?.why).toMatch(/shape of an agent id/);
    expect(delegatePlan({ agentId: D1, name: '' }).call).toBeNull();
  });
});

// ── the roster is the POD's ──────────────────────────────────────────────────

describe('readDelegates asks the pod, and never turns a failed read into an empty one', () => {
  it('★ several delegates on one pod, kept apart from the agents that are not delegates', async () => {
    const c = client(registry([
      row(D1, 'Claude side', 'PublishOnly'),
      row(D2, 'Codex side', 'PublishOnly'),
      row('did:web:x:agents:bot', null, 'PublishOnly'),
    ]));
    const r = await readDelegates(c, POD);
    expect(r.read).toBe(true);
    expect(r.delegates.map((d) => d.name)).toEqual(['Claude side', 'Codex side']);
    expect(r.others).toHaveLength(1);
    expect(r.delegates.every((d) => d.writeEligible)).toBe(true);
  });

  it('★ a scope that cannot publish is reported as such rather than dropped', async () => {
    const r = await readDelegates(client(registry([row(D1, 'Reader only', 'ReadOnly')])), POD);
    expect(r.delegates[0]?.writeEligible).toBe(false);
    expect(r.delegates[0]?.scope).toBe('ReadOnly');
  });

  it('★ a registry that could not be read is `read: false`, not zero delegates', async () => {
    const r = await readDelegates(client({ get_pod_status: () => { throw new Error('boom'); } }), POD);
    expect(r.read).toBe(false);
    expect(r.delegates).toEqual([]);
    expect(r.why).toMatch(/not established/);
  });

  it('★ a pod reporting no registry at all is different from one delegating nothing', async () => {
    const r = await readDelegates(client({ get_pod_status: () => ({ pod: 'http://css/x/' }) }), POD);
    expect(r.read).toBe(false);
    expect(r.why).toMatch(/different from it delegating nothing/);
  });
});

// ── the ceiling ──────────────────────────────────────────────────────────────

describe('a delegate cannot do what its delegator withheld from it', () => {
  it('both ceilings hold, and the sentence says neither of them granted anything', () => {
    const v = delegateCeiling({ roles: roles(), role: ROLE, scope: 'PublishOnly', delegateName: 'Claude side' });
    expect(v.ok).toBe(true);
    expect(v.why).toMatch(/neither of them granted anything/);
  });

  it('★ a scope that cannot publish refuses, even though the person themself may post', () => {
    const v = delegateCeiling({ roles: roles(), role: ROLE, scope: 'ReadOnly', delegateName: 'Reader only' });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/scope ReadOnly, which cannot publish/);
    // And the delegator CAN post — same role, a sibling delegate with a writing scope passes.
    expect(delegateCeiling({ roles: roles(), role: ROLE, scope: 'PublishOnly', delegateName: 'Claude side' }).ok).toBe(true);
  });

  it('★ a row that reports no scope is a refusal, not a permission', () => {
    const v = delegateCeiling({ roles: roles(), role: ROLE, scope: null, delegateName: null });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/not established/);
    expect(v.why).toMatch(/not the same as it being permitted/);
  });

  it('★ the seat\'s role is inherited unchanged — a role the workspace does not declare refuses', () => {
    const v = delegateCeiling({ roles: roles(), role: WS + '-roles#Invented', scope: 'ReadWrite', delegateName: 'Claude side' });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/cannot exceed it/);
  });
});

// ── the triples ──────────────────────────────────────────────────────────────

describe('the entry says who wrote it, and a human-authored one says so too', () => {
  const args = { streamIri: STREAM, workspace: WS, seq: 3, body: 'hello', prior: null, createdIso: '2026-08-07T00:00:00.000Z' };

  it('★ a person\'s entry carries prov:wasAttributedTo <their WebID> and NO delegation statement', () => {
    const t = entryTurtle({ ...args, author: { kind: 'principal', webId: WEBID } });
    expect(t).toContain('prov:wasAttributedTo <' + WEBID + '>');
    expect(t).not.toContain('prov:actedOnBehalfOf');
  });

  it('★ a delegate\'s entry attributes to the AGENT and states, about the agent, whom it acted for', () => {
    const t = entryTurtle({ ...args, author: { kind: 'delegate', agentId: D1, onBehalfOf: WEBID } });
    expect(t).toContain('prov:wasAttributedTo <' + D1 + '>');
    // PROV relates two AGENTS. Hanging it off the entry would be malformed PROV that read plausibly.
    expect(t).toContain('<' + D1 + '> prov:actedOnBehalfOf <' + WEBID + '> .');
    expect(t).not.toContain('prov:wasAttributedTo <' + WEBID + '>');
  });

  it('★ neither form is silent about its author — absence would have to be read as the person', () => {
    for (const a of [{ kind: 'principal', webId: WEBID } as const, { kind: 'delegate', agentId: D1, onBehalfOf: WEBID } as const]) {
      expect(readIriAll(entryTurtle({ ...args, author: a }), 'prov:wasAttributedTo')).toHaveLength(1);
    }
  });

  it('refuses an unserialisable author rather than closing the IRI reference somewhere else', () => {
    expect(() => entryTurtle({ ...args, author: { kind: 'principal', webId: 'https://x/> . <s> <p> <o' } })).toThrow(/not serializable/);
    expect(() => entryTurtle({ ...args, author: { kind: 'delegate', agentId: D1, onBehalfOf: '' } })).toThrow(/missing/);
  });
});

// ── reading it back ──────────────────────────────────────────────────────────

describe('readEntryAuthorship: the entry claims, and two other documents hold it down', () => {
  const region = (ttl: string): string => graphRegion('<' + STREAM + '> {\n' + ttl + '\n}\n', STREAM) as string;
  const written = (author: Parameters<typeof entryTurtle>[0]['author']): string =>
    region(entryTurtle({ streamIri: STREAM, workspace: WS, seq: 0, body: 'x', prior: null, author, createdIso: '2026-08-07T00:00:00.000Z' }));

  it('a person\'s own entry reads as the person', () => {
    const a = readEntryAuthorship(written({ kind: 'principal', webId: WEBID }), { logOwnerWebId: WEBID, delegates: null });
    expect(a.kind).toBe('principal');
  });

  it('★ a delegate\'s entry reads as the delegate, named from the delegator\'s own registry', () => {
    const a = readEntryAuthorship(written({ kind: 'delegate', agentId: D1, onBehalfOf: WEBID }), {
      logOwnerWebId: WEBID, delegates: roster([row(D1, 'Claude side', 'PublishOnly')]),
    });
    expect(a).toMatchObject({ kind: 'delegate', agentId: D1, onBehalfOf: WEBID, name: 'Claude side', authorised: true, scope: 'PublishOnly' });
  });

  it('★ two delegates of one person are two distinct authors in one log', () => {
    const r = roster([row(D1, 'Claude side', 'PublishOnly'), row(D2, 'Codex side', 'PublishOnly')]);
    const a = readEntryAuthorship(written({ kind: 'delegate', agentId: D1, onBehalfOf: WEBID }), { logOwnerWebId: WEBID, delegates: r });
    const b = readEntryAuthorship(written({ kind: 'delegate', agentId: D2, onBehalfOf: WEBID }), { logOwnerWebId: WEBID, delegates: r });
    expect(a.kind === 'delegate' && a.name).toBe('Claude side');
    expect(b.kind === 'delegate' && b.name).toBe('Codex side');
    expect(a).not.toEqual(b);
  });

  it('★ an entry that names nobody is UNSTATED, never the pod owner', () => {
    const bare = region('<' + STREAM + '/e/0> a <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#Entry> ;\n'
      + '  <http://purl.org/dc/terms/description> "x" .');
    const a = readEntryAuthorship(bare, { logOwnerWebId: WEBID, delegates: null });
    expect(a.kind).toBe('unstated');
    expect(a.kind === 'unstated' && a.why).toMatch(/not the same as the pod owner having written it/);
  });

  it('★ a region that could not be located is unstated, and says that is what happened', () => {
    const a = readEntryAuthorship(null, { logOwnerWebId: WEBID, delegates: null });
    expect(a.kind).toBe('unstated');
    expect(a.kind === 'unstated' && a.why).toMatch(/could not be located/);
  });

  it('★ an unauthorised delegation is a finding; an unread registry is NOT', () => {
    const t = written({ kind: 'delegate', agentId: D1, onBehalfOf: WEBID });
    const notListed = readEntryAuthorship(t, { logOwnerWebId: WEBID, delegates: roster([row(D2, 'Codex side', 'PublishOnly')]) });
    expect(notListed.kind === 'delegate' && notListed.authorised).toBe(false);
    const notRead = readEntryAuthorship(t, { logOwnerWebId: WEBID, delegates: null });
    expect(notRead.kind === 'delegate' && notRead.authorised).toBeNull();
    const failedRead = readEntryAuthorship(t, { logOwnerWebId: WEBID, delegates: { podName: POD, read: false, owner: null, rows: [], delegates: [], others: [], why: 'x' } });
    expect(failedRead.kind === 'delegate' && failedRead.authorised).toBeNull();
  });

  it('★ an agent claiming to act for somebody who is not the log\'s owner is DISPUTED', () => {
    const a = readEntryAuthorship(written({ kind: 'delegate', agentId: D1, onBehalfOf: OTHER }), { logOwnerWebId: WEBID, delegates: null });
    expect(a.kind).toBe('disputed');
    expect(a.kind === 'disputed' && a.why).toMatch(/third party/);
  });

  it('★ an entry attributed to a stranger with no delegation statement is DISPUTED, not a delegate', () => {
    const a = readEntryAuthorship(written({ kind: 'principal', webId: OTHER }), { logOwnerWebId: WEBID, delegates: null });
    expect(a.kind).toBe('disputed');
    expect(a.kind === 'disputed' && a.why).toMatch(/neither the log's owner nor declared to be acting for them/);
  });

  it('★ two attributions, or two delegation statements, are refused rather than resolved by taking the first', () => {
    // The bytes are the log owner's, so a hostile writer can state a predicate twice. `readIri`
    // would silently take whichever came first — a choice this reader is not entitled to make.
    const two = region('<' + STREAM + '/e/0> <http://www.w3.org/ns/prov#wasAttributedTo> <' + WEBID + '> ;\n'
      + '  <http://www.w3.org/ns/prov#wasAttributedTo> <' + D1 + '> .');
    expect(readEntryAuthorship(two, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('disputed');
    const twoBehalf = region('<' + STREAM + '/e/0> <http://www.w3.org/ns/prov#wasAttributedTo> <' + D1 + '> .\n'
      + '<' + D1 + '> <http://www.w3.org/ns/prov#actedOnBehalfOf> <' + WEBID + '> , <' + OTHER + '> .');
    expect(readEntryAuthorship(twoBehalf, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('disputed');
  });

  it('★ a person cannot act on their own behalf through themselves', () => {
    const odd = region('<' + STREAM + '/e/0> <http://www.w3.org/ns/prov#wasAttributedTo> <' + WEBID + '> .\n'
      + '<' + WEBID + '> <http://www.w3.org/ns/prov#actedOnBehalfOf> <' + OTHER + '> .');
    expect(readEntryAuthorship(odd, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('disputed');
  });

  it('★ a comment cannot introduce an author, because the readers mask comments', () => {
    const spoof = region('# <' + STREAM + '/e/0> <http://www.w3.org/ns/prov#wasAttributedTo> <' + D1 + '>\n'
      + '<' + STREAM + '/e/0> <http://www.w3.org/ns/prov#wasAttributedTo> <' + WEBID + '> .');
    expect(readEntryAuthorship(spoof, { logOwnerWebId: WEBID, delegates: null }).kind).toBe('principal');
  });

  it('★ a log this reader cannot attribute to an owner does not guess', () => {
    const a = readEntryAuthorship(written({ kind: 'principal', webId: WEBID }), { logOwnerWebId: null, delegates: null });
    expect(a.kind).toBe('disputed');
  });
});

describe('the workspace\'s own published shape requires an author', () => {
  it('★ exactly one prov:wasAttributedTo, so the relay refuses an entry that names nobody', () => {
    // Not decoration. If only a delegate's entry carried an author, "no author" would have to be
    // read as "the person wrote it" — and absence is not evidence. The shape a workspace
    // publishes is what makes the absence impossible from any client that honours it, so a
    // reader meeting an unauthored entry knows it came from somewhere this shape did not govern.
    const s = shapesTurtle(WS + '-shapes');
    expect(s).toContain('sh:path prov:wasAttributedTo ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI');
    expect(s).toContain('@prefix prov: <http://www.w3.org/ns/prov#>');
    // On the ENTRY shape, not smuggled into the grant or acceptance shapes.
    const entryShape = s.slice(s.indexOf('#EntryShape'), s.indexOf('#GrantShape'));
    expect(entryShape).toContain('prov:wasAttributedTo');
  });
});

describe('authorshipLine says the same thing on every surface', () => {
  it('names the delegate and who it acts for, and never reduces the two odd cases to a name', () => {
    expect(authorshipLine({ kind: 'principal', webId: WEBID }, { displayName: 'Mark' })).toBe('Mark');
    expect(authorshipLine({ kind: 'delegate', agentId: D1, onBehalfOf: WEBID, name: 'Claude side', authorised: true, scope: 'PublishOnly' }, { displayName: 'Mark' }))
      .toBe('Claude side, acting for Mark');
    expect(authorshipLine({ kind: 'unstated', why: 'x' })).toBe('author not stated');
    expect(authorshipLine({ kind: 'disputed', why: 'x' })).toBe('authorship disputed');
  });
});
