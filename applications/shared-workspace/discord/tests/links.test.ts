/**
 * THE INDEX, AND THE SECRET IT DELIBERATELY DOES NOT HAVE.
 *
 * Three properties are load-bearing and none is obvious from reading the class:
 *   · the link LABEL is not a credential. It names the Discord account a delegation is for, and
 *     it is checked against the account actually asking — because a delegation row is
 *     world-readable, so a nonce published in one is a nonce published to everybody;
 *   · the store is an INDEX, so everything it holds is reconstructible — the slug is derived
 *     from the Discord thread id, which means the workspace IRI survives losing this file;
 *   · what `load` would drop, `bind` refuses, so memory and disk can never disagree about who
 *     is linked.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHALLENGE_MAX_ATTEMPTS, CHALLENGE_TTL_MS, LinkStore, challengeLabel, slugFor,
  type Link, type ThreadBinding,
} from '../src/links.js';

const U1 = '1100000000000000001';

const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'interego-links-')), 'state.json');

const link = (user: string, pod: string): Link => ({
  discordUserId: user, pod, webId: 'https://identity.interego.xwisee.com/users/' + pod + '/profile#me',
  boundAt: '2026-08-07T00:00:00.000Z', scopeAtBinding: 'PublishOnly', basisAtBinding: 'signed-chain',
});
const thread = (id: string, pod: string): ThreadBinding => ({
  threadId: id, convenerPod: pod, workspace: 'https://relay.interego.xwisee.com/ns/' + pod + '/d-' + id,
  slug: 'd-' + id, title: 't', startedAt: '2026-08-07T00:00:00.000Z', startedBy: '1100000000000000001',
});

describe('slugFor', () => {
  it('derives a legal slug from a snowflake, so the IRI survives losing this store', () => {
    expect(slugFor('1394001122334455667')).toBe('d-1394001122334455667');
  });
  it('refuses anything that is not a snowflake rather than composing an IRI out of it', () => {
    for (const bad of ['', 'abc', '../../etc', '12345678901234567890123', 'a1']) {
      expect(slugFor(bad), bad).toBeNull();
    }
  });
});

describe('the link label', () => {
  it('is the Discord account the delegation is FOR, and is not a secret', () => {
    // ★ THE DEFECT THIS SHAPE REPLACED. The first design put a minted nonce here. Delegation
    // rows are world-readable (`get_pod_status { pod_name: <anyone's> }` returns them, measured
    // live), so publishing the nonce published it — and the first party to read that pod could
    // present it and bind THEIR account to somebody else's pod. A Discord id is public already
    // and is worthless to anybody who is not that account.
    expect(challengeLabel('1100000000000000001')).toBe('discord-link 1100000000000000001');
  });

  it('is formatted by ONE function, so the string told and the string compared are the same', () => {
    // Two format sites is how a link flow comes to reject every honest user.
    const id = '1100000000000000002';
    expect(challengeLabel(id)).toBe(challengeLabel(id));
    expect(challengeLabel(id)).not.toBe(challengeLabel('1100000000000000003'));
  });
});

describe('the confirm window', () => {
  it('expires', () => {
    let now = 1_000_000;
    const s = new LinkStore(tmp(), () => now);
    s.issue(U1);
    expect(s.challengeOf(U1)).not.toBeNull();
    now += CHALLENGE_TTL_MS + 1;
    expect(s.challengeOf(U1)).toBeNull();
  });

  it('is spent after a bounded number of tries', () => {
    const s = new LinkStore(tmp());
    s.issue(U1);
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) expect(s.spendAttempt(U1)).toBe(true);
    expect(s.spendAttempt(U1)).toBe(false);
    expect(s.challengeOf(U1)).toBeNull();
  });

  it('replaces rather than accumulates: one window per person', () => {
    const s = new LinkStore(tmp());
    s.issue(U1);
    s.spendAttempt(U1);
    s.issue(U1);
    expect(s.challengeOf(U1)?.attempts).toBe(0);
  });

  it('is NEVER written to disk, because worthless state is still state to lose', () => {
    const path = tmp();
    const s = new LinkStore(path);
    s.issue(U1);
    s.bind(link(U1, 'u-eth-0123456789ab'));           // forces a save
    expect(readFileSync(path, 'utf8')).not.toContain('attempts');
    expect(new LinkStore(path).challengeOf(U1)).toBeNull();
  });
});

describe('the store', () => {
  it('round-trips links and threads', () => {
    const path = tmp();
    const a = new LinkStore(path);
    a.bind(link(U1, 'u-eth-0123456789ab'));
    a.bindThread(thread('1394001122334455667', 'u-eth-0123456789ab'));
    const b = new LinkStore(path);
    expect(b.linkOf(U1)?.pod).toBe('u-eth-0123456789ab');
    expect(b.threadOf('1394001122334455667')?.workspace).toContain('/d-1394001122334455667');
  });

  it('names every Discord account claiming one pod, so a second claimant can be refused', () => {
    const s = new LinkStore(tmp());
    s.bind(link(U1, 'u-eth-0123456789ab'));
    expect(s.claimantsOf('u-eth-0123456789ab')).toEqual([U1]);
    expect(s.claimantsOf('u-eth-ffffffffffff')).toEqual([]);
  });

  it('drops rows whose pod or user id is not the shape it writes', () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({
      version: 1,
      links: [{ discordUserId: 'u1', pod: 'not-a-pod' }, { discordUserId: '../x', pod: 'u-eth-0123456789ab' }],
      threads: [{ threadId: 'nope', convenerPod: 'u-eth-0123456789ab' }],
    }));
    const s = new LinkStore(path);
    expect(s.linkOf('u1')).toBeNull();
    expect(s.linkOf('../x')).toBeNull();
    expect(s.threadOf('nope')).toBeNull();
  });

  it('refuses to HOLD what it would drop, so memory and disk cannot diverge', () => {
    // ★ The read path filtered and the write path did not, so a malformed id answered `linkOf`
    // all afternoon and vanished on the next start — the bot recording somebody's messages and
    // then not knowing whose they were.
    const s = new LinkStore(tmp());
    expect(() => s.bind(link('u1', 'u-eth-0123456789ab'))).toThrow(/Discord user id/);
    expect(() => s.bind(link(U1, 'not-a-pod'))).toThrow(/pod identifier/);
    expect(() => s.bindThread(thread('nope', 'u-eth-0123456789ab'))).toThrow(/channel id/);
  });

  it('throws on a corrupt store rather than starting empty', () => {
    const path = tmp();
    writeFileSync(path, '{ this is not json');
    // ★ Starting empty would tell every linked participant they are not linked and re-seat them
    // on a pod that already holds their documents — a workspace that quietly forgot who was in it.
    expect(() => new LinkStore(path)).toThrow();
  });

  it('treats a store that does not exist yet as empty, which is not the same thing', () => {
    expect(() => new LinkStore(join(mkdtempSync(join(tmpdir(), 'interego-links-')), 'never-written.json'))).not.toThrow();
  });

  it('refuses a version it does not know rather than reading it as version 1', () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ version: 2, links: [], threads: [] }));
    expect(() => new LinkStore(path)).toThrow(/version 2/);
  });

  it('unbind reports what it removed, and reports nothing when there was nothing', () => {
    const s = new LinkStore(tmp());
    expect(s.unbind(U1)).toBeNull();
    s.bind(link(U1, 'u-eth-0123456789ab'));
    expect(s.unbind(U1)?.pod).toBe('u-eth-0123456789ab');
    expect(s.linkOf(U1)).toBeNull();
  });
});
