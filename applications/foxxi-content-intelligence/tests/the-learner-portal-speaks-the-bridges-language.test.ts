/**
 * The learner portal speaks the bridge's language: what it signs, the bridge verifies; what it
 * sends as answers, the engine grades as the learner meant them; what it is handed, it reads.
 *
 * Each of these is checked against the bridge's own code, not a copy of it: a wallet extension's
 * signature goes through recoverSignedRequest and verifySessionToken, and a step's replies through
 * advancePlay, from a fragment authored with every kind of question and served as a step serves it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { deriveUserWallet as bridgeDemoWallet, recoverSignedRequest, verifySessionToken } from '../src/auth.js';
import { fragmentFrom } from '../src/content-fragments.js';
import { compositionFrom, resolveComposition } from '../src/compositions.js';
import { advancePlay, currentView, startPlay } from '../src/composition-play.js';
import { extensionAccount, extensionSigner, signerAsks, signerFor } from '../dashboard-app/src/auth/signer.js';
import { signAgentRequestAs } from '../dashboard-app/src/auth/signed-request.js';
import { mintSessionTokenWithSigner } from '../dashboard-app/src/auth/session-token.js';
import { connectFromExtension, loadSession, saveSession, signsOnly, type FoxxiSession } from '../dashboard-app/src/auth/session.js';
import { draftFor, matchTo, move, pick, problemWith, repliesFor, replyOf, type Draft, type LearnerQuestion } from '../dashboard-app/src/learn/answers.js';
import { compositionIriOn, compositionRefFrom, hashOfComposition } from '../dashboard-app/src/learn/composition-ref.js';
import { RECENTS_MAX, readRecents, recentsKey, remember } from '../dashboard-app/src/learn/recents.js';
import { competencyLabel, nothingToPlayBecause, scoreLine, wayInLabel } from '../dashboard-app/src/learn/play.js';
import { bridgeBaseOf } from '../dashboard-app/src/learn/bridge.js';

/** A wallet extension, as a page sees one: an EIP-1193 provider whose key it never gets. */
function fakeExtension(wallet: ethers.HDNodeWallet) {
  let offered = [wallet.address];
  return {
    offer(accounts: string[]) { offered = accounts; },
    async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': return offered.map(a => a.toLowerCase());
        case 'eth_chainId': return '0x1';
        case 'personal_sign': {
          const [data, address] = params as [string, string];
          if (!offered.some(a => a.toLowerCase() === address.toLowerCase()) || address.toLowerCase() !== wallet.address.toLowerCase()) {
            throw Object.assign(new Error('The requested account has not been authorized.'), { code: 4100 });
          }
          return wallet.signMessage(ethers.getBytes(data));
        }
        default: throw Object.assign(new Error(`${method} is not supported`), { code: 4200 });
      }
    },
  };
}

describe('a wallet extension signs as its account, and the bridge verifies it', () => {
  it('signs a request the bridge recovers as that account, on the DIRECT branch', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ext = fakeExtension(wallet);
    const address = await extensionAccount(ext);
    expect(address).toBe(wallet.address);
    const envelope = await signAgentRequestAs(extensionSigner(address, ext), { composition: 'urn:x', limit: 5 });
    const rec = recoverSignedRequest(envelope);
    expect(rec.ok && rec.signer).toBe(wallet.address);
    expect(rec.ok && rec.agentId).toBe(`did:ethr:${wallet.address}`);
    expect(rec.ok && rec.payload).toMatchObject({ composition: 'urn:x', limit: 5 });
  });

  it('mints a session token the bridge verifies for the account', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ext = fakeExtension(wallet);
    const did = `did:ethr:${wallet.address}`;
    const token = await mintSessionTokenWithSigner(extensionSigner(wallet.address, ext), did);
    const known = new Map([[wallet.address.toLowerCase(), { webId: did, userId: wallet.address }]]);
    expect(verifySessionToken(token, known)).toMatchObject({ ok: true, callerDid: did });
  });

  it('says so when the extension no longer offers the account, and when it shares none', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ext = fakeExtension(wallet);
    ext.offer([ethers.Wallet.createRandom().address]);
    await expect(extensionSigner(wallet.address, ext).signMessage('hello')).rejects.toThrow(/did not offer/);
    ext.offer([]);
    await expect(extensionAccount(ext)).rejects.toThrow(/shared no account/);
    await expect(extensionSigner(wallet.address, undefined).signMessage('hello')).rejects.toThrow(/No wallet extension/);
  });

  it('signs in with a session that keeps no key, and survives a reload where a pasted key does not', async () => {
    const kept = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); },
    };
    try {
      const wallet = ethers.Wallet.createRandom();
      const session = await connectFromExtension('https://pods.example/tenant/', fakeExtension(wallet));
      expect(session).toMatchObject({ webId: `did:ethr:${wallet.address}`, signingMode: 'extension', extensionAddress: wallet.address });
      expect(session).not.toHaveProperty('connectedPrivateKey');
      saveSession(session);
      expect(loadSession()).toMatchObject({ extensionAddress: wallet.address });
      const pasted: FoxxiSession = { ...session, signingMode: undefined, extensionAddress: undefined, connectedPrivateKey: wallet.privateKey };
      saveSession(pasted);
      expect(loadSession()).toBeNull();
      await expect(connectFromExtension('https://pods.example/tenant/', undefined)).rejects.toThrow(/No wallet extension/);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('a session that acts through signed requests alone', () => {
  it('is a wallet extension or a pasted key, never a roster identity', () => {
    const account = ethers.Wallet.createRandom().address;
    expect(signsOnly({ webId: `did:ethr:${account}`, audienceTags: ['connected-wallet'], signingMode: 'extension', extensionAddress: account })).toBe(true);
    expect(signsOnly({ webId: `did:ethr:${account}`, audienceTags: ['connected-wallet'] })).toBe(true);
    expect(signsOnly({ webId: 'https://id.acme-training.example/jliu/profile#me', audienceTags: ['engineering'] })).toBe(false);
  });

  it('lands on Learn, is not offered the pages read with the session token, and is told why on them', () => {
    const app = readFileSync(new URL('../dashboard-app/src/App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/navigate\(signsOnly\(s\) \? '\/learn' : `\/profiles\/\$\{userIdToUuid\(s\.userId\)\}`/);
    expect(app).toMatch(/const home = signsOnly\(session\) \? '\/learn' : ownProfileUrl;/);
    expect(app).toMatch(/<Route path="\/" element=\{<Navigate to=\{home\} replace \/>\} \/>/);
    expect(app).toMatch(/\{!signsOnly\(session\) && <NavLink to=\{ownProfileUrl\} label="My profile" \/>\}/);
    expect(app).toMatch(/\{!signsOnly\(session\) && <NavLink to="\/my-activity" label="My activity" \/>\}/);
    expect(app).toMatch(/if \(signsOnly\(session\)\) return <SignsOnlyNotice what="Your profile and learner record" \/>;/);
    expect(app).toMatch(/if \(signsOnly\(session\)\) return <SignsOnlyNotice what="Your activity and its statements" \/>;/);
  });

  it('is moved to the pages it has without a reload, which would sign a pasted key out', () => {
    const app = readFileSync(new URL('../dashboard-app/src/App.tsx', import.meta.url), 'utf8');
    const notice = app.slice(app.indexOf('function SignsOnlyNotice'), app.indexOf('\n}\n', app.indexOf('function SignsOnlyNotice')));
    const links = [...notice.matchAll(/<a href="([^"]+)"([^>]*)>/g)];
    expect(links.map(l => l[1])).toEqual(['/learn', '/author', '/my-forwarding']);
    for (const [, to, rest] of links) expect(rest).toContain(`onClick={go('${to}')}`);
    expect(notice).toMatch(/const go = \(to: string\) => \(e: React\.MouseEvent\) => \{ e\.preventDefault\(\); navigate\(to\); \};/);
  });

  it('keeps the way to read its forwarding until both lists are read', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/MyForwardingPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/\{\(!targets \|\| !creds\) && asks && \(/);
  });

  it('reads its forwarding only when asked, one signature at a time, and a change answers for itself', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/MyForwardingPanel.tsx', import.meta.url), 'utf8');
    expect(panel).not.toMatch(/Promise\.all/);
    expect(panel).toMatch(/useEffect\(\(\) => \{ if \(!asks\) void load\(\); \}, \[load, asks\]\);/);
    expect(panel).not.toMatch(/await load\(\)/);
    expect(panel).toMatch(/showTargets\(await callSignedAffordanceAs\(origin, 'forwarding\/targets', signer, \{ delete: \[t\.id\] \}\)\)/);
    expect(panel).toMatch(/showCreds\(await callSignedAffordanceAs\(origin, 'credentials', signer, \{ revoke: \[c\.id\] \}\)\)/);
  });
});

describe('each session signs as itself', () => {
  it('a roster identity as its demo wallet, a pasted key as that key, a wallet extension as its account', () => {
    expect(signerFor({ userId: 'u-joshua' }).address).toBe(bridgeDemoWallet('u-joshua').address);
    const key = ethers.Wallet.createRandom();
    expect(signerFor({ userId: key.address, connectedPrivateKey: key.privateKey }).address).toBe(key.address);
    // Never the demo wallet derived from the account's address, which signs as someone else entirely.
    const account = ethers.Wallet.createRandom().address;
    expect(signerFor({ userId: account, signingMode: 'extension', extensionAddress: account }).address).toBe(account);
    expect(signerAsks({ userId: account, signingMode: 'extension', extensionAddress: account })).toBe(true);
    expect(signerAsks({ userId: key.address, connectedPrivateKey: key.privateKey })).toBe(false);
    expect(signerAsks({ userId: 'u-joshua' })).toBe(false);
  });
});

describe("a step's answers, put in the portal, are graded as the learner meant them", () => {
  const c = 'refund-authority';
  const fragment = fragmentFrom({
    kind: 'assessment-item', level: 'working', competencies: [c], title: 'Every kind of question', body: 'Answer these.',
    questions: [
      { type: 'choice', question: 'Who approves a $600 refund?', options: ['Agent', 'Team lead', 'Director'], answer: 'B', explanation: 'Above $250 goes to the team lead.' },
      { type: 'choice', question: 'Which return money?', options: ['Chargeback', 'Store credit', 'Cash back', 'Discount'], answer: ['A', 'C'] },
      { type: 'true-false', question: 'An agent may refund $200.', answer: true },
      { type: 'sequencing', question: 'Put the steps in order.', items: ['Verify', 'Approve', 'Refund', 'Notify'] },
      { type: 'matching', question: 'Who approves each amount?', pairs: [['$100', 'Agent'], ['$600', 'Team lead'], ['$5000', 'Director']], distractors: ['Customer'] },
      { type: 'fill-in', question: 'What do you do above your limit?', answer: 'escalate', accept: ['escalation'] },
      { type: 'numeric', question: "An agent's limit, in dollars?", answer: 250 },
      { type: 'likert', question: 'How sure are you?' },
      { type: 'long-fill-in', question: 'Describe a hard refund.' },
    ],
  });
  const composition = compositionFrom({ title: 'Refunds', competency: c, positions: [{ competency: c, paradigm: [fragment['@id']] }] });
  const store = new Map<string, unknown>([[fragment['@id'], fragment], [composition['@id'], composition]]);
  const now = '2026-09-27T12:00:00Z';
  const launch = () => startPlay(resolveComposition({ composition, learner: { id: 'did:ethr:0x0000000000000000000000000000000000000001', kind: 'human' }, lookup: i => store.get(i) as never }),
    composition.title, { id: 'did:ethr:0x0000000000000000000000000000000000000001', kind: 'human' }, { session: 's', registration: 'r' }, now)!;
  const ctx = { actor: { objectType: 'Agent' }, now, newId: () => crypto.randomUUID() };
  // The questions exactly as the bridge serves the step (currentView), never as they are stored.
  const served = (currentView(launch())!.fragment as { questions: LearnerQuestion[] }).questions;
  const q = (i: number): LearnerQuestion => served[i]!;
  const as = <K extends Draft['kind']>(d: Draft, kind: K): Extract<Draft, { kind: K }> => {
    if (d.kind !== kind) throw new Error(`a ${kind} draft was expected, not ${d.kind}`);
    return d as Extract<Draft, { kind: K }>;
  };
  const picking = (i: number, ...labels: string[]): Draft =>
    labels.reduce((d, label) => pick(as(d, 'pick'), q(i).input!.options!.indexOf(label)), draftFor(q(i)));
  const ordering = (i: number, inOrder: string[]): Draft => {
    let d = as(draftFor(q(i)), 'order');
    inOrder.forEach((label, place) => {
      const from = d.order.findIndex(item => q(i).input!.items![item] === label);
      d = as(move(d, from, place), 'order');
    });
    return d;
  };
  const matching = (i: number, answers: Record<string, string>): Draft =>
    q(i).input!.items!.reduce<Draft>((d, prompt, p) => matchTo(as(d, 'match'), p, q(i).input!.targets!.indexOf(answers[prompt]!)), draftFor(q(i)));
  const text = (i: number, words: string): Draft => ({ ...as(draftFor(q(i)), 'text'), text: words });

  const rightDrafts = (): Draft[] => [
    picking(0, 'Team lead'),
    picking(1, 'Cash back', 'Chargeback'),
    { ...as(draftFor(q(2)), 'truth'), value: true },
    ordering(3, ['Verify', 'Approve', 'Refund', 'Notify']),
    matching(4, { $100: 'Agent', $600: 'Team lead', $5000: 'Director' }),
    text(5, 'Escalation'),
    text(6, '250'),
    picking(7, q(7).input!.options![3]!),
    text(8, 'A customer wanted cash for a gift card.'),
  ];

  it('grades every answer put the right way as right, and records the ungraded ones', () => {
    const drafts = rightDrafts();
    drafts.forEach((d, i) => expect(problemWith(q(i), d), `question ${i + 1}`).toBeNull());
    const r = advancePlay(launch(), repliesFor(served, drafts), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graded).toMatchObject({ correct: 7, total: 7 });
    expect(r.graded!.detail.map(d => d.correct)).toEqual([true, true, true, true, true, true, true, null, null]);
    expect(r.graded!.detail[0]!.explanation).toBe('Above $250 goes to the team lead.');
  });

  it('grades each answer put the wrong way as not right', () => {
    const drafts = rightDrafts();
    drafts[0] = picking(0, 'Agent');
    drafts[1] = picking(1, 'Cash back');                      // one of the two
    drafts[2] = { ...as(draftFor(q(2)), 'truth'), value: false };
    drafts[3] = draftFor(q(3));                               // the order shown, which is never the right one
    drafts[4] = matching(4, { $100: 'Agent', $600: 'Director', $5000: 'Team lead' });
    drafts[5] = text(5, 'refund it');
    drafts[6] = text(6, '251');
    const r = advancePlay(launch(), repliesFor(served, drafts), ctx);
    expect(r.ok && r.graded).toMatchObject({ correct: 0, total: 7 });
  });

  it('unpicks a picked option, and picks only one where only one may be', () => {
    const many = as(picking(1, 'Chargeback', 'Cash back'), 'pick');
    expect(replyOf(pick(many, 0))).toBe('C');
    const one = as(picking(0, 'Agent', 'Director'), 'pick');
    expect(replyOf(one)).toBe('C');
    expect(as(picking(7, q(7).input!.options![0]!, q(7).input!.options![4]!), 'pick').picked).toEqual([4]);   // a scale is one point on it
  });

  it("stops what the engine would refuse, in the engine's words, before it is sent", () => {
    expect(problemWith(q(0), draftFor(q(0)))).toMatch(/Enter an answer/);
    const half = matchTo(as(draftFor(q(4)), 'match'), 0, 0);
    expect(problemWith(q(4), half)).toMatch(/Enter an answer/);
    expect(problemWith(q(6), text(6, 'two hundred'))).toMatch(/number/);
    expect(problemWith(q(8), text(8, 'x'.repeat(4001)))).toMatch(/4000/);
  });

  it('keeps a move inside the list, and a match inside the prompts', () => {
    const d = as(draftFor(q(3)), 'order');
    expect(move(d, 0, 9)).toBe(d);
    expect(move(d, -1, 0)).toBe(d);
    const m = as(draftFor(q(4)), 'match');
    expect(matchTo(m, 7, 0)).toBe(m);
  });
});

describe('a composition, named however it was handed over', () => {
  const hash = 'a'.repeat(64);
  it('is found in a hash, an IRI on any bridge, a link under that IRI, or a link to this portal', () => {
    expect(compositionRefFrom(`  ${hash.toUpperCase()} `)).toEqual({ hash });
    expect(compositionRefFrom(`https://elsewhere.example/ns/foxxi/composition/${hash}`)).toEqual({ hash });
    expect(compositionRefFrom(`https://elsewhere.example/ns/foxxi/composition/${hash}/efficacy`)).toEqual({ hash });
    expect(compositionRefFrom(`https://elsewhere.example/ns/foxxi/composition/${hash}/scorm.zip`)).toEqual({ hash });
    expect(compositionRefFrom(`https://portal.example/learn/${hash}`)).toEqual({ hash });
  });
  it('and not in a fragment, a stranger link, or nothing, each saying why', () => {
    expect(compositionRefFrom(`https://b.example/ns/foxxi/fragment/${hash}`)).toMatchObject({ why: expect.stringMatching(/fragment, not a composition/) });
    expect(compositionRefFrom('https://b.example/somewhere')).toMatchObject({ why: expect.stringMatching(/names no composition/) });
    expect(compositionRefFrom('not a link')).toMatchObject({ why: expect.stringMatching(/not a composition/) });
    expect(compositionRefFrom('   ')).toMatchObject({ why: expect.stringMatching(/Paste/) });
    expect(compositionRefFrom(`https://b.example/ns/foxxi/composition/${hash}/a/b`)).toHaveProperty('why');
  });
  it("is named on this portal's bridge by its hash", () => {
    expect(compositionIriOn('https://bridge.example/', hash)).toBe(`https://bridge.example/ns/foxxi/composition/${hash}`);
    expect(hashOfComposition(`https://any.example/ns/foxxi/composition/${hash}`)).toBe(hash);
    expect(hashOfComposition(`https://any.example/ns/foxxi/fragment/${hash}`)).toBeUndefined();
    expect(bridgeBaseOf({ '@id': 'https://bridge.example/api/foxxi/v1' })).toBe('https://bridge.example');
    expect(bridgeBaseOf({ '@id': 'https://host.example/foxxi/api/foxxi/v1' })).toBe('https://host.example/foxxi');
    expect(bridgeBaseOf(null)).toBe('');
    expect(bridgeBaseOf({ '@id': 'nonsense' })).toBe('');
  });
});

describe('the compositions opened lately in this browser', () => {
  const h = (n: number) => String(n).padStart(64, '0');
  it('lists the newest first, each once, keeping a title an opening does not bring, and at most a few', () => {
    let list = remember([], { hash: h(1), title: 'Refunds', at: '2026-09-27T10:00:00Z' });
    list = remember(list, { hash: h(2), at: '2026-09-27T11:00:00Z' });
    list = remember(list, { hash: h(1), at: '2026-09-27T12:00:00Z' });
    expect(list).toEqual([{ hash: h(1), title: 'Refunds', at: '2026-09-27T12:00:00Z' }, { hash: h(2), at: '2026-09-27T11:00:00Z' }]);
    for (let n = 3; n < 30; n++) list = remember(list, { hash: h(n), at: '2026-09-27T13:00:00Z' });
    expect(list).toHaveLength(RECENTS_MAX);
  });
  it('reads back only what is one, and a list per identity', () => {
    const stored = JSON.stringify([{ hash: h(1), at: 'x' }, { hash: h(1), at: 'y' }, { hash: 'nope', at: 'x' }, { hash: h(2) }, { hash: h(3), at: 'x', title: 7 }, null]);
    expect(readRecents(stored)).toEqual([{ hash: h(1), at: 'x' }]);
    expect(readRecents('{"not":"a list"}')).toEqual([]);
    expect(readRecents('{')).toEqual([]);
    expect(readRecents(null)).toEqual([]);
    expect(recentsKey('did:ethr:0xA')).not.toBe(recentsKey('did:ethr:0xB'));
  });
});

describe('what the player says about a play', () => {
  it('names a step a missed check brought in, a competency, a score, and why nothing was played', () => {
    expect(wayInLabel('teaching')).toBe('Another way in');
    expect(wayInLabel('check')).toBe('Another check');
    expect(wayInLabel(undefined)).toBeUndefined();
    expect(competencyLabel('https://foxxi.example/ns/foxxi/competency/refund%20authority')).toBe('refund authority');
    expect(competencyLabel('urn:foxxi:competency:refunds')).toBe('refunds');
    expect(competencyLabel('https://terms.example/skills#negotiation')).toBe('negotiation');
    expect(scoreLine({ correct: 2, total: 3 })).toBe('2 of 3 right');
    expect(scoreLine({ correct: 0, total: 0 })).toBe('Nothing here was graded');
    const note = { competency: 'https://foxxi.example/ns/foxxi/competency/refunds', path: [], position: 0, because: 'no fragment suits a human learner' };
    expect(nothingToPlayBecause({ skipped: [note, note] })).toEqual(['2 positions were skipped: your record already shows what they teach.']);
    expect(nothingToPlayBecause({ skipped: [note] })[0]).toMatch(/^One position was skipped/);
    expect(nothingToPlayBecause({ unmet: [note], missing: ['x'], refused: ['y'] })).toEqual([
      'Nothing it offers for refunds could be given to you: no fragment suits a human learner',
      '1 of its pieces could not be reached on this bridge.',
      '1 of its pieces did not match what their names promise, and were refused.',
    ]);
    expect(nothingToPlayBecause({})).toEqual(['It resolved to no steps for you.']);
  });
});

describe('the pages keep to what this file checks', () => {
  const read = (path: string) => readFileSync(new URL(`../dashboard-app/src/${path}`, import.meta.url), 'utf8');
  it("renders a fragment from its Markdown with the engine's renderer, never from HTML it was sent", () => {
    const player = read('components/CompositionPlayer.tsx');
    expect(player).toMatch(/dangerouslySetInnerHTML=\{\{ __html: courseMarkdownHtml\(f\.body\) \}\}/);
    expect(player).not.toMatch(/bodyHtml/);
  });
  it('signs every forwarding call as the session itself', () => {
    const panel = read('components/MyForwardingPanel.tsx');
    expect(panel).toMatch(/const signer = signerFor\(session\);/);
    expect(panel).not.toMatch(/callSignedAffordance\(/);
  });
});
