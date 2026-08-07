/**
 * WHAT THE BOT IS ALLOWED TO SAY.
 *
 * ★ EVERY CASE HERE IS A SENTENCE THAT WOULD BE A LIE. This bot's only product is a claim about
 * what was and was not written, so its formatter is a place a false statement can be introduced
 * with no code change anywhere near a decision. These pin the four that matter: that a signature
 * is never presented as the author's own, that "unlink" is never presented as a revocation, that
 * a check which could not run is never rendered as a finding, and that a clipped message says it
 * was clipped rather than ending mid-sentence.
 */

import { describe, it, expect } from 'vitest';
import type { Check } from '@interego/workspace-client';
import { DISCORD_LIMIT, body, renderChallenge, renderConfirm, renderRecord, renderShow, renderStart, renderUnlink } from '../src/render.js';
import type { Seat } from '@interego/workspace-client';
import type { RecordOut, ShowOut } from '../src/workspace.js';

const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-workspace-discord-u-eth-0123456789ab';
const RELAY_KEY = 'did:ethr:0xd144353a7A2Fa81E126e072AD3b16cD245c83331';
const POD = 'u-eth-0123456789ab';
const WEBID = 'https://identity.interego.xwisee.com/users/' + POD + '/profile#me';
/** A delegate DID in the shape the relay actually issues — surface constant, then the pod. */
const DELEGATE = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0001';

describe('body', () => {
  it('says when it clipped', () => {
    const m = body([`${'x'.repeat(DISCORD_LIMIT * 2)}`], false);
    expect(m.content.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(m.content).toContain('clipped');
  });
  it('leaves a short message alone', () => {
    expect(body(['a', 'b'], true)).toEqual({ content: 'a\nb', ephemeral: true });
  });
});

describe('the link instruction', () => {
  const out = renderChallenge({ kind: 'challenge', agentId: AGENT, label: 'discord-link 1100000000000000001', existing: null });

  it('is private, names the real agent, and gives the exact label', () => {
    expect(out.ephemeral).toBe(true);
    expect(out.content).toContain(AGENT);
    expect(out.content).toContain('discord-link 1100000000000000001');
    expect(out.content).toContain('PublishOnly');
  });

  it('says the label is not a password, because a delegation row is world-readable', () => {
    // A user who believed the label were a secret would treat leaking it as harmless, or treat
    // publishing it as dangerous. Both readings are wrong and both are the bot's fault if it
    // does not say which.
    expect(out.content).toContain('not a password');
    expect(out.content).toContain('world-readable');
  });

  it('tells the truth about what PublishOnly grants, rather than implying it is scoped', () => {
    // The substrate has no per-graph delegation scope. A bot that let a participant believe
    // otherwise would be describing a boundary that does not exist.
    expect(out.content).toContain('pod-wide');
    expect(out.content).toContain('not only workspace entries');
    expect(out.content).toContain('revoke_agent');
  });

  it('says nothing has happened yet', () => {
    expect(out.content).toContain('Nothing has happened yet');
  });
});

describe('unlink', () => {
  it('refuses to present itself as a revocation, and names what the user must do instead', () => {
    const m = renderUnlink({ kind: 'unlinked', had: { discordUserId: 'u', pod: POD, webId: 'w', boundAt: '', scopeAtBinding: null, basisAtBinding: null }, agentId: AGENT });
    expect(m.content).toContain('did **not** revoke');
    expect(m.content).toContain('revoke_agent');
    expect(m.content).toContain(AGENT);
    // ★ AND IT MUST NOT VOUCH FOR ITSELF. "this bot will no longer be able to" would be the bot
    // asserting its own restraint, which is the one thing the delegation model exists to replace.
    expect(m.content).not.toMatch(/no longer able|can no longer write/i);
  });
});

describe('the record notice', () => {
  const accepted = (over: Partial<Extract<RecordOut, { kind: 'recorded' }>> = {}): RecordOut => ({
    kind: 'recorded', pod: POD, streamIri: 'https://relay.interego.xwisee.com/ns/' + POD + '/x-stream', seated: 'already',
    outcome: {
      kind: 'accepted', descriptorUrl: 'http://css.railway.internal:3456/' + POD + '/context-graphs/1.ttl',
      committed: true, seq: 3, shapeSent: 'https://relay.interego.xwisee.com/ns/' + POD + '/x-shapes',
      ifMatch: 'bafkreiabc', ifMatchKind: "the prior entry's content CID", response: {},
    },
    authorship: {
      present: true, signerAgent: AGENT, verificationMethod: RELAY_KEY, contentBinding: 'bound-at-signing',
      proves: ['The relay signed a statement that the caller it had authenticated as ' + AGENT + ' published this descriptor.'],
      doesNotProve: ['The signature verifies against ' + RELAY_KEY + " — the relay's own delegation key. It is NOT the author's wallet."],
    },
    ...over,
  });

  it('never says the author signed it', () => {
    const m = renderRecord(accepted());
    expect(m?.content).toContain('entry #3');
    expect(m?.content).toContain(RELAY_KEY);
    expect(m?.content).toMatch(/NOT the author's wallet/);
    // The sentence this whole file exists to keep out.
    expect(m?.content).not.toMatch(/signed by you|your signature/i);
  });

  it('says nothing validated an entry when the workspace names no shape', () => {
    const m = renderRecord(accepted({ outcome: { kind: 'accepted', descriptorUrl: null, committed: true, seq: 0, shapeSent: null, ifMatch: null, ifMatchKind: null, response: {} } }));
    expect(m?.content).toContain('Nothing validated this entry');
    expect(m?.content).toContain('First entry in this log');
  });

  it('distinguishes "the relay refused" from "the relay did not answer"', () => {
    const refused = renderRecord({ ...accepted(), outcome: { kind: 'refused', code: 422, body: { error: 'shape_violation' } } } as RecordOut);
    expect(refused?.content).toContain('The relay refused');
    const silent = renderRecord({ ...accepted(), outcome: { kind: 'unreachable', error: new Error('x'), relayAnswered: false } } as RecordOut);
    expect(silent?.content).toContain('did not answer');
    expect(silent?.content).toContain('not being retried');
    const answered = renderRecord({ ...accepted(), outcome: { kind: 'unreachable', error: new Error('x'), relayAnswered: true } } as RecordOut);
    expect(answered?.content).toContain('reported a failure');
  });

  it('tells an unlinked person they were not recorded, rather than ignoring them silently', () => {
    const m = renderRecord({ kind: 'unlinked', discordUserId: '1100000000000000003' });
    expect(m?.content).toContain('<@1100000000000000003>');
    expect(m?.content).toContain('not recorded');
    expect(m?.content).toContain('has been written anywhere');
  });

  it('says nothing at all in a channel that is not a workspace', () => {
    expect(renderRecord({ kind: 'not-a-workspace' })).toBeNull();
    expect(renderRecord({ kind: 'empty' })).toBeNull();
  });
});

describe('the composed view', () => {
  const seat = (pod: string, seated: boolean, why: string | null): Seat => ({
    graph: 'g', grantUrl: null, grantCid: null, role: null, grantedTo: null, pod, seated, why, podServed: pod, stream: 'https://x/' + pod,
  });
  const view = (over: Record<string, unknown> = {}): ShowOut => ({
    kind: 'view',
    binding: { threadId: '1', convenerPod: POD, workspace: 'https://relay.interego.xwisee.com/ns/' + POD + '/d-1', slug: 'd-1', title: 'T', startedAt: '', startedBy: '' },
    record: { head: { forked: false, url: 'u', cid: null, headError: null, message: null }, regionFound: true, convener: 'w', roleProfile: null, entryShape: null, grantCapability: null, title: 'design review', authorship: null, convenerPod: POD, servedFrom: POD },
    fold: { seats: [seat(POD, true, null), seat('u-eth-ffffffffffff', false, 'granted, but no acceptance published on their pod yet')], grantPod: POD, grantPodDerivedFrom: 'wsp:convener in the record', grantScanSaturated: false, grantLimit: 400, grantsFound: 2, grantsRead: 2, grantReadCap: 25 },
    streams: [{ pod: POD, stream: 's', total: 1, forked: false, partial: false, why: null }],
    entries: [{ pod: POD, seq: 0, created: '2026-08-07T00:00:00.000Z', body: 'hello', descriptorUrl: 'u', author: { kind: 'principal', webId: WEBID }, why: null }],
    truncated: false, totalEntries: 1,
    ...over,
  } as ShowOut);

  it('publishes the IRI as the thing that outlives the bot', () => {
    const m = renderShow(view());
    expect(m.content).toContain('<https://relay.interego.xwisee.com/ns/' + POD + '/d-1>');
    expect(m.content).toContain('with or without this bot');
  });

  it('carries a non-seat\'s own reason rather than dropping the row', () => {
    const m = renderShow(view());
    expect(m.content).toContain('granted, but no acceptance published on their pod yet');
  });

  it('says the cross-pod interleaving is a clock and not a finding', () => {
    const m = renderShow(view());
    expect(m.content).toContain('is a presentation, not a finding');
    expect(m.content).toContain('supersession chain');
  });

  it('renders an entry whose region could not be located as a question, not as an empty message', () => {
    const m = renderShow(view({ entries: [{ pod: POD, seq: null, created: null, body: null, descriptorUrl: 'u', author: null, why: 'the signed region of this entry could not be located, so nothing was read from bytes anybody signed' }] }));
    expect(m.content).toContain('? `' + POD + '` — the signed region');
  });

  it('reports a truncated scan rather than presenting a short roster as the whole one', () => {
    const m = renderShow(view({ fold: { ...(view() as { fold: unknown }).fold as Record<string, unknown>, grantScanSaturated: true } }));
    expect(m.content).toContain('came back full at 400');
  });

  // ── who wrote it, which the pod does not answer ────────────────────────────

  const entry = (author: unknown, body = 'hello'): unknown =>
    ({ pod: POD, seq: 0, created: '2026-08-07T00:00:00.000Z', body, descriptorUrl: 'u', author, why: null });

  it('★ names a delegate as the author, and says whose pod authorises it', () => {
    const m = renderShow(view({ entries: [entry({ kind: 'delegate', agentId: DELEGATE, onBehalfOf: WEBID, name: 'Research assistant', authorised: true, scope: 'PublishOnly' })] }));
    expect(m.content).toContain('written by **Research assistant**');
    expect(m.content).toContain('a delegate acting for the pod owner');
    expect(m.content).toContain('own registry authorises it with scope PublishOnly');
  });

  it('★ two delegates of one person are two authors in one log, not one', () => {
    const m = renderShow(view({
      entries: [
        entry({ kind: 'principal', webId: WEBID }, 'the human speaking'),
        entry({ kind: 'delegate', agentId: DELEGATE, onBehalfOf: WEBID, name: 'Claude side', authorised: true, scope: 'PublishOnly' }, 'first delegate'),
        entry({ kind: 'delegate', agentId: DELEGATE + '-2', onBehalfOf: WEBID, name: 'Codex side', authorised: true, scope: 'PublishOnly' }, 'second delegate'),
      ],
    }));
    expect(m.content).toContain('written by the pod owner');
    expect(m.content).toContain('written by **Claude side**');
    expect(m.content).toContain('written by **Codex side**');
  });

  it('★ an unstated author never renders as the pod owner', () => {
    const m = renderShow(view({ entries: [entry({ kind: 'unstated', why: 'this entry names no prov:wasAttributedTo' })] }));
    expect(m.content).toContain('**author not stated**');
    expect(m.content).toContain('not the same as the pod owner having written it');
    expect(m.content).not.toContain('written by the pod owner');
  });

  it('★ a delegation the pod does not record is a finding; one that was not checked is not', () => {
    const notListed = renderShow(view({ entries: [entry({ kind: 'delegate', agentId: DELEGATE, onBehalfOf: WEBID, name: null, authorised: false, scope: null })] }));
    expect(notListed.content).toContain('does NOT list this agent');
    const notRead = renderShow(view({ entries: [entry({ kind: 'delegate', agentId: DELEGATE, onBehalfOf: WEBID, name: null, authorised: null, scope: null })] }));
    expect(notRead.content).toContain('was not read here');
    expect(notRead.content).not.toContain('does NOT list this agent');
  });

  it('★ a disputed attribution carries its own reason rather than a shrug', () => {
    const m = renderShow(view({ entries: [entry({ kind: 'disputed', why: 'this entry says X acted on behalf of Y, and the pod belongs to Z' })] }));
    expect(m.content).toContain('**authorship disputed**');
    expect(m.content).toContain('acted on behalf of Y');
  });

  it('★ says the pod is the log and the name beside it is the author', () => {
    const m = renderShow(view());
    expect(m.content).toContain('The pod is whose LOG an entry is in');
    expect(m.content).toContain('prov:wasAttributedTo');
  });
});

describe('marks', () => {
  it('renders a check that could not run as "?", never as a failure', () => {
    const checks: readonly Check[] = [{ mark: 'q', text: 'the signed chain did not anchor' }];
    const m = renderStart({ kind: 'not-delegated', pod: POD, checks, why: 'nope' });
    expect(m.content).toContain('? the signed chain did not anchor');
    expect(m.content).not.toContain('✗ the signed chain did not anchor');
  });

  it('never claims a pod was written to when the check itself failed to complete', () => {
    const m = renderConfirm({ kind: 'error', error: new Error('the relay did not answer') });
    expect(m.content).toContain('Nothing was written');
    expect(m.content).toContain('nothing is claimed about your pod');
  });
});
