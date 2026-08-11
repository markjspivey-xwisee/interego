/**
 * THE DECISION A PERSON'S DELEGATE MAKES, TESTED WHERE IT IS MADE.
 *
 * ★ WHY THIS FILE EXISTS, AND IT IS NOT "FOR COVERAGE". The renderer test drives this logic
 * through a DOM and a scripted relay, which is the right way to test what the shell DRAWS and the
 * wrong way to test an ORDERING. Proof: the first regression case for the undated-entry defect was
 * written there, and it passed with the defect deliberately restored — the scripted store could not
 * even get an undated entry as far as `decideTurn`, so the case asserted nothing. A test that
 * cannot fail is worse than no test, because it is counted.
 *
 * Every case below was checked against a deliberately reverted fix and observed to FAIL. They are
 * the smallest inputs that separate the two behaviours.
 */

import { describe, it, expect } from 'vitest';
import {
  BRIEF_ENTRIES, DRAFT_MAX, NOTHING_TO_ADD, briefPrompt, checkDraft, decideTurn,
  type EntryAuthorship, type RoleTable, type Seat, type SeenEntry, type SpeakingDelegate,
  type TurnInput,
} from '@interego/workspace-client';

const ME = 'u-eth-aaaaaaaaaaaa';
const THEM = 'u-eth-bbbbbbbbbbbb';
const MY_WEBID = 'https://identity.interego.xwisee.com/users/' + ME + '/profile#me';
const THEIR_WEBID = 'https://identity.interego.xwisee.com/users/' + THEM + '/profile#me';
const WS = 'https://relay.interego.xwisee.com/ns/' + ME + '/room';
const ROLE = WS + '-roles#Contributor';
/** Two delegates of ONE person, which the substrate allows and this decision must handle. */
const D1 = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-111111111111';
const D2 = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-222222222222';
const CLAUDE_SIDE: SpeakingDelegate = { agentId: D1, name: 'Claude side', scope: 'PublishOnly' };
const CODEX_SIDE: SpeakingDelegate = { agentId: D2, name: 'Codex side', scope: 'PublishOnly' };

/** The published role table, in the shape `parseRoleProfile` produces: Maps, not objects. */
const roles = (): RoleTable => ({
  roles: new Map([[ROLE, { label: 'Contributor', comment: 'Reads and writes their own log.', permits: [WS + '-roles#Read', WS + '-roles#Post'] }]]),
  caps: new Map([
    [WS + '-roles#Read', { label: 'Read the channel', comment: 'Fold every log.' }],
    [WS + '-roles#Post', { label: 'Post to the channel', comment: 'Append to your own log.' }],
  ]),
} as unknown as RoleTable);

const seat = (pod: string, seated = true, role: string | null = ROLE): Seat =>
  ({ pod, seated, role, why: seated ? '' : 'no acceptance published on their pod yet', stream: WS + '-stream' } as unknown as Seat);

const at = (iso: string): number => Date.parse(iso);

/** An entry written by the person whose log it is in. */
const person = (pod: string): EntryAuthorship =>
  ({ kind: 'principal', webId: pod === ME ? MY_WEBID : THEIR_WEBID, signer: { kind: 'the-author', signedBy: pod === ME ? MY_WEBID : THEIR_WEBID } });
/** An entry written by one of that person's delegates, speaking FOR them unless told otherwise. */
const byDelegate = (pod: string, d: SpeakingDelegate, footing?: EntryAuthorship extends never ? never : { kind: 'own-account' }): EntryAuthorship =>
  ({
    kind: 'delegate', agentId: d.agentId, signer: { kind: 'the-author', signedBy: d.agentId },
    name: d.name, authorised: true, scope: d.scope,
    footing: footing ?? { kind: 'on-behalf-of', principal: pod === ME ? MY_WEBID : THEIR_WEBID },
  });

const said = (
  pod: string, url: string, body: string | null, when: number | null,
  derivedFrom: string | null = null, author?: EntryAuthorship, addressedTo: readonly string[] = [],
): SeenEntry =>
  ({ pod, descriptorUrl: url, body, derivedFrom, at: when, author: author ?? person(pod), addressedTo });

/** The same entry, addressed to one agent by name — what `/workspace ask` writes. */
const askedOf = (agentId: string, pod: string, url: string, body: string, when: number | null): SeenEntry =>
  said(pod, url, body, when, null, undefined, [agentId]);

const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  workspace: WS, slug: 'room', mePod: ME, delegate: CLAUDE_SIDE,
  seats: [seat(ME), seat(THEM)], roles: roles(), entries: [], unreadable: 0, answeredHere: [],
  ...over,
});

describe('decideTurn: who spoke last, and whether it can be established at all', () => {
  it('answers the other member when they spoke last', () => {
    const d = decideTurn(input({ entries: [said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z'))] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') {
      expect(d.answering.pod).toBe(THEM);
      expect(d.brief.transcript.join('\n')).toContain('What about the roof?');
    }
  });

  it('refuses when it has already spoken since they did', () => {
    const d = decideTurn(input({ entries: [
      said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
      said(ME, 'u2', 'Re-tile in spring.', at('2026-08-07T10:01:00Z')),
    ] }));
    expect(d.kind).toBe('already-answered');
  });

  it('★ an entry with no readable time never reads as the newest thing in the channel', () => {
    // THE LOOP-FOREVER DEFECT, at the altitude that can see it. The ordering used
    // `at ?? Number.MAX_SAFE_INTEGER`, so an undated entry sorted LAST — newest, in a conversation
    // — and the "have I spoken since they did" guard compared against it. It is never the agent's
    // own, so the guard never fired: one model call and one permanent public entry every 45
    // seconds, forever. Verified to FAIL against the reverted sort.
    const d = decideTurn(input({ entries: [
      said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
      said(ME, 'u2', 'Re-tile in spring.', at('2026-08-07T10:01:00Z')),
      said(THEM, 'u3', 'an entry whose validFrom this reader could not parse', null),
    ] }));
    expect(d.kind).toBe('already-answered');
  });

  it('★ says nothing when NOTHING another member wrote can be placed in time', () => {
    // The other half of the same rule: undated entries are excluded from the ordering, so a
    // channel made only of them establishes nothing, and the honest answer is silence with a
    // reason rather than an answer to whichever one happened to be last in the array.
    const d = decideTurn(input({ entries: [said(THEM, 'u1', 'hello', null)] }));
    expect(d.kind).toBe('nothing-to-answer');
    if (d.kind === 'nothing-to-answer') expect(d.why).toContain('readable time');
  });

  it('★ a tie on the timestamp resolves to silence, not to a second entry', () => {
    const t = at('2026-08-07T10:00:00Z');
    const d = decideTurn(input({ entries: [said(THEM, 'u1', 'hi', t), said(ME, 'u2', 'hello', t)] }));
    expect(d.kind).toBe('already-answered');
  });

  it('★ refuses outright when part of the channel could not be read', () => {
    // Losing the read of the agent's OWN latest reply made it answer the same message twice.
    const d = decideTurn(input({
      entries: [said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z'))],
      unreadable: 1,
    }));
    expect(d.kind).toBe('channel-incomplete');
    if (d.kind === 'channel-incomplete') expect(d.why).toContain('answered twice');
  });

  it('★ a timestamp another member chose cannot make it answer the same entry forever', () => {
    // THE DEEPEST OF THE DEFECTS, and it survived the first fix. `at` is not a fact about when
    // something happened: it comes from `validFrom`, which comes from the OPTIONAL `valid_from`
    // argument to `publish_context` — a number the entry's own author picked. One entry dated a
    // year ahead makes every reply of mine "older" than theirs forever, the ordering guard never
    // fires, and the agent answers it on every poll, permanently and publicly. `answeredHere` is
    // the primary guard precisely because it is the one input another member cannot touch.
    const future = at('2027-08-07T10:00:00Z');
    const entries = [
      said(THEM, 'spoofed', 'dated a year ahead', future),
      said(ME, 'mine', 'I already answered that.', at('2026-08-07T10:01:00Z')),
    ];
    // Without the record, the ordering alone would say "answer" — that is the loop.
    expect(decideTurn(input({ entries })).kind).toBe('answer');
    // With it, the entry is already answered and stays answered however it is dated.
    expect(decideTurn(input({ entries, answeredHere: ['spoofed'] })).kind).toBe('already-answered');
  });

  it('★ an undated entry of MY OWN is a refusal, not evidence that I never spoke', () => {
    // The asymmetry a reviewer caught in the first fix: excluding undated entries means "never
    // new" for theirs (safe) and "never spoke" for mine (unsafe) — the guard is skipped entirely
    // and the agent answers again on every poll.
    const d = decideTurn(input({ entries: [
      said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
      said(ME, 'u2', 'My answer.', null),
    ] }));
    expect(d.kind).toBe('channel-incomplete');
    if (d.kind === 'channel-incomplete') expect(d.why).toContain('own log carries no readable time');
  });

  it('reports everything-already-answered distinctly from nobody-has-spoken', () => {
    const entries = [said(THEM, 'u1', 'hi', at('2026-08-07T10:00:00Z'))];
    expect(decideTurn(input({ entries, answeredHere: ['u1'] })).kind).toBe('already-answered');
    expect(decideTurn(input({ entries: [] })).kind).toBe('nothing-to-answer');
  });

  it('answers a NEWER entry from the same member after an older one was answered', () => {
    // The record must not mute the member permanently — only the entry it names.
    const d = decideTurn(input({
      entries: [
        said(THEM, 'u1', 'first', at('2026-08-07T10:00:00Z')),
        said(THEM, 'u2', 'and another thing', at('2026-08-07T10:05:00Z')),
      ],
      answeredHere: ['u1'],
    }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.answering.descriptorUrl).toBe('u2');
  });

  it('honours an explicit derivation link even when the ordering would allow an answer', () => {
    // The bridge's own writer emits `prov:wasDerivedFrom`; an explicit statement beats an ordering.
    const d = decideTurn(input({ entries: [
      said(ME, 'u0', 'my earlier answer', at('2026-08-07T09:00:00Z'), 'u1'),
      said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
    ] }));
    expect(d.kind).toBe('already-answered');
  });

  it('treats a deliberately empty entry as nothing to answer, not as something to answer', () => {
    expect(decideTurn(input({ entries: [said(THEM, 'u1', '', at('2026-08-07T10:00:00Z'))] })).kind).toBe('nothing-to-answer');
    // And an unreadable body is not an empty one — equally not something to reply to.
    expect(decideTurn(input({ entries: [said(THEM, 'u1', null, at('2026-08-07T10:00:00Z'))] })).kind).toBe('nothing-to-answer');
  });

  it('★ refuses when not seated, and when the role table could not be read', () => {
    expect(decideTurn(input({ seats: [seat(THEM)] })).kind).toBe('not-seated');
    expect(decideTurn(input({ seats: [seat(ME, false)] })).kind).toBe('not-seated');
    // An unreadable ceiling is NOT an absent ceiling. Absence is not permission.
    const d = decideTurn(input({ roles: null, entries: [said(THEM, 'u1', 'hi', at('2026-08-07T10:00:00Z'))] }));
    expect(d.kind).toBe('roles-unreadable');
    if (d.kind === 'roles-unreadable') expect(d.why).toContain('not the same as the ceiling permitting');
  });

  it('★ refuses a role the published table does not declare', () => {
    const d = decideTurn(input({
      seats: [seat(ME, true, WS + '-roles#Observer'), seat(THEM)],
      entries: [said(THEM, 'u1', 'hi', at('2026-08-07T10:00:00Z'))],
    }));
    expect(d.kind).toBe('ceiling');
    if (d.kind === 'ceiling') expect(d.why).toContain('cannot exceed it');
  });

  it('bounds the brief and reports what it left out rather than omitting the count', () => {
    const many: SeenEntry[] = [];
    for (let i = 0; i < BRIEF_ENTRIES + 6; i++) many.push(said(THEM, 'u' + i, 'line ' + i, at('2026-08-07T10:00:00Z') + i * 1000));
    const d = decideTurn(input({ entries: many }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') {
      expect(d.brief.transcript).toHaveLength(BRIEF_ENTRIES);
      expect(d.brief.omitted).toBe(6);
      // The newest is kept; the oldest is what falls off.
      expect(d.brief.transcript.join('\n')).toContain('line ' + (BRIEF_ENTRIES + 5));
      expect(d.brief.transcript.join('\n')).not.toContain('line 0:');
    }
  });
});

/**
 * ★ THE DELEGATE HALF. Each of these was checked with the correction reverted — with `delegate`
 * defaulted away, with the ceiling reduced to the role alone, and with the transcript calling
 * every entry on the delegator's pod "you" — and each failed.
 */
describe('decideTurn: the agent is a delegate, and is not the person it acts for', () => {
  const q = (): SeenEntry[] => [said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z'))];

  it('★ no delegate selected is a REFUSAL, never a quiet fall back to writing as the person', () => {
    const d = decideTurn(input({ delegate: null, entries: q() }));
    expect(d.kind).toBe('no-delegate');
    if (d.kind === 'no-delegate') {
      expect(d.why).toContain('nobody for this entry to be attributed to');
      expect(d.why).toContain('An agent is not the person it acts for');
    }
  });

  it('★ a scope that cannot publish refuses, though the same seat lets the person post', () => {
    const readOnly = decideTurn(input({ delegate: { agentId: D1, name: 'Reader only', scope: 'ReadOnly' }, entries: q() }));
    expect(readOnly.kind).toBe('ceiling');
    if (readOnly.kind === 'ceiling') expect(readOnly.why).toContain('scope ReadOnly, which cannot publish');
    // The seat is unchanged; a sibling delegate with a writing scope answers.
    expect(decideTurn(input({ entries: q() })).kind).toBe('answer');
  });

  it('★ a row reporting no scope refuses rather than treating silence as permission', () => {
    const d = decideTurn(input({ delegate: { agentId: D1, name: 'Claude side', scope: null }, entries: q() }));
    expect(d.kind).toBe('ceiling');
    if (d.kind === 'ceiling') expect(d.why).toContain('not the same as it being permitted');
  });

  it('★ the transcript names three parties on ONE pod: the person, this delegate, and a sibling', () => {
    const d = decideTurn(input({
      entries: [
        said(ME, 'm1', 'I think we patch it.', at('2026-08-07T09:00:00Z'), null, person(ME)),
        said(ME, 'm2', 'Consider the flashing.', at('2026-08-07T09:10:00Z'), null, byDelegate(ME, CLAUDE_SIDE)),
        said(ME, 'm3', 'And the gutters.', at('2026-08-07T09:20:00Z'), null, byDelegate(ME, CODEX_SIDE)),
        said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
      ],
    }));
    expect(d.kind).toBe('answer');
    if (d.kind !== 'answer') return;
    const t = d.brief.transcript.join('\n');
    expect(t).toContain('the person you act for: I think we patch it.');
    expect(t).toContain('you (Claude side, speaking for them): Consider the flashing.');
    expect(t).toContain('Codex side, another delegate of the person you act for (speaking for them): And the gutters.');
    // The three must not collapse into one speaker, which is what "you" for the whole pod did.
    expect(t.match(/you \(Claude side/g) ?? []).toHaveLength(1);
    expect(t).not.toContain('you: I think we patch it.');
  });

  /**
   * ★ THE FOOTING IS IN THE TRANSCRIPT, so the agent can see what it has been doing.
   *
   * A delegate deciding which footing to answer on needs to know which footing its own previous
   * turns were on. Without it a model has no way to notice it has been offering opinions all
   * morning under its delegator's name — and the decision it is being asked to make is exactly
   * that one.
   */
  it('★ the transcript distinguishes an own-account turn from a for-them turn', () => {
    const d = decideTurn(input({
      entries: [
        said(ME, 'm1', 'Their view.', at('2026-08-07T09:00:00Z'), null, byDelegate(ME, CLAUDE_SIDE)),
        said(ME, 'm2', 'My own view.', at('2026-08-07T09:10:00Z'), null, byDelegate(ME, CLAUDE_SIDE, { kind: 'own-account' })),
        said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
      ],
    }));
    expect(d.kind).toBe('answer');
    if (d.kind !== 'answer') return;
    const t = d.brief.transcript.join('\n');
    expect(t).toContain('you (Claude side, speaking for them): Their view.');
    expect(t).toContain('you (Claude side, speaking for itself): My own view.');
  });

  it('★ an entry with no stated author is named as that, never as the person', () => {
    const d = decideTurn(input({
      entries: [
        said(ME, 'm1', 'Something.', at('2026-08-07T09:00:00Z'), null, { kind: 'unstated', why: 'names no prov:wasAttributedTo' }),
        said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
      ],
    }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.brief.transcript.join('\n')).toContain('author is not stated');
  });

  it('★ a SIBLING delegate having spoken last silences this one — two agents, one duplicate reply', () => {
    // The dedupe is per POD deliberately: narrowing it to this delegate's own entries would let
    // two delegates of one person both answer the same question, permanently, in one log.
    const d = decideTurn(input({
      entries: [
        said(THEM, 'u1', 'What about the roof?', at('2026-08-07T10:00:00Z')),
        said(ME, 'm1', 'Already answered by the other one.', at('2026-08-07T10:05:00Z'), null, byDelegate(ME, CODEX_SIDE)),
      ],
    }));
    expect(d.kind).toBe('already-answered');
    if (d.kind === 'already-answered') expect(d.why).toContain('another of their delegates');
  });

  it('the other member\'s own delegate is still "somebody else has spoken" and is answered', () => {
    const d = decideTurn(input({
      entries: [said(THEM, 'u1', 'Their agent asks about the roof.', at('2026-08-07T10:00:00Z'), null,
        byDelegate(THEM, { agentId: 'did:web:x:agents:interego-delegate-u-eth-333333333333', name: 'Their assistant', scope: 'PublishOnly' }))],
    }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.brief.answering).toContain('Their assistant, speaking for');
  });
});

describe('briefPrompt: what the agent is asked, and what it is never handed', () => {
  const brief = { workspace: WS, slug: 'room', answering: THEM + ': the question', transcript: [THEM + ': the question'], omitted: 0, addressed: false };

  it('names the channel and states that the record is permanent', () => {
    const p = briefPrompt(brief, { displayName: null, delegateName: 'Claude side' });
    expect(p).toContain(WS);
    expect(p).toContain('permanent');
    expect(p).toContain('the question');
  });

  it('★ tells it not to invent facts the channel has not stated', () => {
    // Tuned from a measured live failure in the other direction: the first version made the model
    // abstain from a direct question. The instruction has to license engagement WITHOUT licensing
    // invention, and both halves are load-bearing.
    const p = briefPrompt(brief, { displayName: 'Sam', delegateName: 'Claude side' });
    expect(p).toContain('Do not invent');
    expect(p).toContain('Sam');
    expect(p).toContain(NOTHING_TO_ADD);
  });

  it('says how much of the channel is missing rather than implying it is whole', () => {
    expect(briefPrompt({ ...brief, omitted: 12 }, { displayName: null, delegateName: null })).toContain('12 earlier entries are not shown');
    expect(briefPrompt(brief, { displayName: null, delegateName: null })).toContain('whole channel so far');
  });

  /**
   * ★ THE PROMPT USED TO TELL THE MODEL IT WAS THE PERSON.
   *
   * "as <name>'s own agent … appended to THEIR log as THEIR entry" is an instruction to write in
   * somebody's voice, and it was followed. Reverting these three lines and re-running this case
   * fails it, which is the point: what the record says and what the model was told to be have to
   * agree, or the honest triples sit under text written as an impersonation.
   */
  it('★ tells the model it is the delegate and explicitly NOT the person', () => {
    const p = briefPrompt(brief, { displayName: 'Sam', delegateName: 'Claude side' });
    expect(p).toContain('You are Claude side, a delegate of Sam');
    expect(p).toContain('You are NOT Sam');
    expect(p).toContain('Do not impersonate them');
    expect(p).toContain('recorded as authored by');
    // The sentence that was there before must be gone, not merely outweighed.
    expect(p).not.toContain('as THEIR entry');
    expect(p).not.toMatch(/appended to THEIR log/);
  });

  /**
   * ★ THE MODEL IS ASKED WHICH FOOTING IT IS ON, AND TOLD WHICH WAY TO LEAN.
   *
   * The prompt used to assert the answer — "recorded as authored by YOU, acting on their behalf" —
   * so the model never had a decision to make and every entry it wrote claimed its delegator's
   * backing. Deleting either sentinel from `briefPrompt` fails this, which is the point: the
   * writer's contract and the reader's vocabulary have to be the same two words.
   */
  it('★ asks the model to declare its footing, and says which way an opinion falls', () => {
    const p = briefPrompt(brief, { displayName: 'Sam', delegateName: 'Claude side' });
    expect(p).toContain('FOOTING: ON THEIR BEHALF');
    expect(p).toContain('FOOTING: MY OWN ACCOUNT');
    expect(p).toContain('YOU are answerable for it and Sam is not');
    expect(p).toContain('Do not claim their backing for a view they have not expressed');
    // The old unconditional assertion must be GONE, not merely outweighed by the new paragraph.
    expect(p).not.toContain('acting on their behalf —');
  });

  it('an unnamed delegate is described as one rather than given the person\'s name', () => {
    const p = briefPrompt(brief, { displayName: 'Sam', delegateName: null });
    expect(p).toContain('You are an unnamed delegate, a delegate of Sam');
    expect(p).toContain('You are NOT Sam');
  });
});

describe('checkDraft: what may be appended to a permanent public log', () => {
  const PRINCIPAL = { principal: MY_WEBID };
  const BEHALF = 'FOOTING: ON THEIR BEHALF\n';
  const OWN = 'FOOTING: MY OWN ACCOUNT\n';

  it('accepts ordinary prose, trims it, and strips the declaration off the body', () => {
    const v = checkDraft(BEHALF + '  A considered reply.  ', PRINCIPAL);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.body).toBe('A considered reply.');
      // The declaration is metadata about the entry, not part of what was said.
      expect(v.body).not.toContain('FOOTING');
      expect(v.footing).toEqual({ kind: 'on-behalf-of', principal: MY_WEBID });
    }
  });

  it('★ the model chooses WHICH footing; the caller supplies WHO', () => {
    const own = checkDraft(OWN + 'That is my own read of it.', PRINCIPAL);
    expect(own.ok && own.footing).toEqual({ kind: 'own-account' });
    // ★ AND THE MODEL IS NEVER GIVEN A WAY TO NAME THE PARTY. A model that could write the
    // principal into a delegation could write one for somebody who never granted it.
    const forThem = checkDraft(BEHALF + 'They have decided to patch it.', { principal: 'https://other.example/#me' });
    expect(forThem.ok && forThem.footing).toEqual({ kind: 'on-behalf-of', principal: 'https://other.example/#me' });
  });

  /**
   * ★ REFUSED, NOT DEFAULTED — the one place in the system where "not stated" is not allowed.
   *
   * A reader of somebody else's record must be able to say "it does not say". A WRITER that shipped
   * an unfooted entry would be manufacturing that ambiguity on purpose, permanently, on its
   * delegator's pod. Defaulting to "on their behalf" is the original defect; defaulting to "own
   * account" would let a delegate disown anything by omitting a line.
   */
  it('★ a draft with no footing declaration is refused rather than defaulted either way', () => {
    const v = checkDraft('A considered reply with no declaration.', PRINCIPAL);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.why).toContain('did not declare which footing');
      expect(v.why).toContain('defaulting to either one is exactly what this refuses to do');
    }
  });

  /**
   * ★ ANOTHER MEMBER MUST NOT BE ABLE TO CHOOSE A DELEGATE'S FOOTING.
   *
   * The transcript goes into the prompt, so a member can put any string in front of the model. If
   * the declaration were matched loosely — "does the reply contain 'MY OWN ACCOUNT' anywhere" — a
   * member could type the phrase, the model could echo it mid-sentence, and the entry would land
   * claiming a footing the agent never chose. It has to be the whole of the first line.
   */
  it('★ a footing phrase anywhere but the first line is not a declaration', () => {
    for (const bad of [
      'I think, FOOTING: MY OWN ACCOUNT, that we should patch it.',
      'Reply text\nFOOTING: MY OWN ACCOUNT',
      'FOOTING: ON THEIR BEHALF and also some text on the same line\nbody',
      'FOOTING: SOMETHING ELSE\nbody',
      'FOOTING:\nbody',
    ]) {
      expect(checkDraft(bad, PRINCIPAL).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts the declaration case-insensitively but not loosely', () => {
    expect(checkDraft('footing: my own account\nbody', PRINCIPAL).ok).toBe(true);
    expect(checkDraft('  FOOTING:   MY OWN ACCOUNT  \nbody', PRINCIPAL).ok).toBe(true);
  });

  it('★ refuses the abstain sentinel, an empty answer, and whitespace', () => {
    for (const bad of ['', '   \n  ', NOTHING_TO_ADD, 'nothing to add', OWN, OWN + '   ']) {
      expect(checkDraft(bad, PRINCIPAL).ok, JSON.stringify(bad)).toBe(false);
    }
    // An abstention needs no footing — there is nothing being said to be answerable for — and it
    // must still read as an abstention rather than as a missing declaration.
    const a = checkDraft(NOTHING_TO_ADD, PRINCIPAL);
    expect(a.ok === false && a.why).toContain('nothing worth adding');
    const b = checkDraft(OWN + NOTHING_TO_ADD, PRINCIPAL);
    expect(b.ok === false && b.why).toContain('nothing worth adding');
  });

  it('★ refuses an over-long draft rather than truncating it', () => {
    const v = checkDraft(OWN + 'x'.repeat(DRAFT_MAX + 1), PRINCIPAL);
    expect(v.ok).toBe(false);
    // Half a sentence recorded permanently is worse than none, and a reader cannot tell it was cut.
    if (!v.ok) expect(v.why).toContain('refused rather than truncated');
    expect(checkDraft(OWN + 'x'.repeat(DRAFT_MAX), PRINCIPAL).ok).toBe(true);
  });
});

/**
 * WHO AN ENTRY IS FOR, WHICH THIS DECISION IGNORED ENTIRELY UNTIL NOW.
 *
 * ★ THE DEFECT THESE PIN, STATED PLAINLY. `iep:addressedTo` has been written into the signed
 * region of an ask since the Discord conduit shipped, and the substrate's own `verifyRequest` has
 * refused an inbox notice that does not name a key the machine holds since the same day. This
 * function never read it. The consequence was not subtle and was not theoretical: with two people
 * in a channel each running a delegate, asking ONE of them a question by name produced an answer
 * from BOTH — and the ask-and-wake path, for the identical ask to a SLEEPING host, refused it
 * correctly. The same request meant two different things depending on whether the addressee
 * happened to be awake.
 *
 * ★ MEASURED, AND THE COUNT IS STATED RATHER THAN IMPLIED. With the addressing read reverted —
 * both predicates forced to `false`, rebuilt, since this suite executes `dist` and not `src` — SIX
 * of the eleven cases below fail. The other five pass either way ON PURPOSE: they pin behaviour
 * that must NOT change (an unaddressed entry stays open to any agent; an ask naming several agents
 * including me is mine; an answered ask stays answered) and are regression guards, not evidence
 * for the fix. Saying which is which is the point — a file that claimed all eleven discriminated
 * would be counting five tests that cannot fail.
 */
describe('decideTurn: an entry addressed to one agent by name', () => {
  const OTHER = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-999999999999';

  it('★ is NOT answered by a delegate it does not name', () => {
    const d = decideTurn(input({ entries: [askedOf(OTHER, THEM, 'u1', 'Scribe, summarise the thread', at('2026-08-07T10:00:00Z'))] }));
    expect(d.kind).toBe('nothing-to-answer');
    if (d.kind === 'nothing-to-answer') expect(d.why).toContain('addressed to another agent by name');
  });

  it('is answered by the delegate it DOES name', () => {
    const d = decideTurn(input({ entries: [askedOf(D1, THEM, 'u1', 'Claude side, summarise the thread', at('2026-08-07T10:00:00Z'))] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.answering.descriptorUrl).toBe('u1');
  });

  it('leaves an entry addressed to NOBODY open to any delegate, which is the unchanged default', () => {
    const d = decideTurn(input({ entries: [said(THEM, 'u1', 'anyone know the roof warranty?', at('2026-08-07T10:00:00Z'))] }));
    expect(d.kind).toBe('answer');
  });

  it('★ the same channel gives two delegates two different answers, which is the whole point', () => {
    const entries = [askedOf(D1, THEM, 'u1', 'Claude side, do this', at('2026-08-07T10:00:00Z'))];
    expect(decideTurn(input({ entries, delegate: CLAUDE_SIDE })).kind).toBe('answer');
    expect(decideTurn(input({ entries, delegate: CODEX_SIDE })).kind).toBe('nothing-to-answer');
  });

  it('★ a direct ask is NOT silenced by its asker carrying on talking', () => {
    // The ordering guard asks "has anybody on my pod spoken since they did" at POD granularity.
    // Applied to an ask addressed to this delegate it says the delegator's own next sentence
    // withdraws the ask — and since every further message renews that, permanently.
    const d = decideTurn(input({ entries: [
      askedOf(D1, THEM, 'u1', 'Claude side, summarise the thread', at('2026-08-07T10:00:00Z')),
      said(ME, 'u2', 'and take your time', at('2026-08-07T10:05:00Z')),
    ] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.answering.descriptorUrl).toBe('u1');
  });

  it('★ but IS discharged by an answer to it that survives a restart', () => {
    // `answeredHere` dies with the process; `prov:wasDerivedFrom` on my own pod does not. This is
    // the guard that makes the exemption above safe rather than a loop.
    const d = decideTurn(input({ entries: [
      askedOf(D1, THEM, 'u1', 'Claude side, summarise the thread', at('2026-08-07T10:00:00Z')),
      said(ME, 'u2', 'here is the summary', at('2026-08-07T10:05:00Z'), 'u1'),
    ], answeredHere: [] }));
    expect(d.kind).not.toBe('answer');
  });

  it('takes the OLDEST outstanding ask, so a second one cannot bury the first', () => {
    const d = decideTurn(input({ entries: [
      askedOf(D1, THEM, 'u1', 'first thing', at('2026-08-07T10:00:00Z')),
      askedOf(D1, THEM, 'u2', 'second thing', at('2026-08-07T10:01:00Z')),
    ] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.answering.descriptorUrl).toBe('u1');
  });

  it('prefers a direct ask over newer chatter rather than letting the room starve it', () => {
    const d = decideTurn(input({ entries: [
      askedOf(D1, THEM, 'u1', 'Claude side, do this', at('2026-08-07T10:00:00Z')),
      said(THEM, 'u2', 'anyway, nice weather', at('2026-08-07T10:09:00Z')),
    ] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.answering.descriptorUrl).toBe('u1');
  });

  it('still answers open talk when the only addressed entry belongs to somebody else', () => {
    const d = decideTurn(input({ entries: [
      askedOf(OTHER, THEM, 'u1', 'Scribe, do this', at('2026-08-07T10:00:00Z')),
      said(THEM, 'u2', 'and separately — anyone know the warranty?', at('2026-08-07T10:01:00Z')),
    ] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') expect(d.answering.descriptorUrl).toBe('u2');
  });

  it('★ tells the model when it was addressed, and does not claim it when it was not', () => {
    const asked = decideTurn(input({ entries: [askedOf(D1, THEM, 'u1', 'do this', at('2026-08-07T10:00:00Z'))] }));
    const open = decideTurn(input({ entries: [said(THEM, 'u1', 'do this', at('2026-08-07T10:00:00Z'))] }));
    expect(asked.kind === 'answer' && asked.brief.addressed).toBe(true);
    expect(open.kind === 'answer' && open.brief.addressed).toBe(false);
    if (asked.kind === 'answer') {
      expect(briefPrompt(asked.brief, { displayName: null, delegateName: 'Claude side' })).toContain('ADDRESSED TO YOU BY NAME');
    }
    if (open.kind === 'answer') {
      // A delegate told to "do what is asked" on every turn treats a remark it overheard as a job.
      expect(briefPrompt(open.brief, { displayName: null, delegateName: 'Claude side' })).not.toContain('ADDRESSED TO YOU BY NAME');
    }
  });

  it('★ an entry addressed to several agents including me is mine to answer', () => {
    const d = decideTurn(input({ entries: [
      said(THEM, 'u1', 'both of you, please look', at('2026-08-07T10:00:00Z'), null, undefined, [OTHER, D1]),
    ] }));
    expect(d.kind).toBe('answer');
  });
});
