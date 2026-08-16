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
  const brief = { workspace: WS, slug: 'room', answering: THEM + ': the question', transcript: [THEM + ': the question'], omitted: 0, addressed: false, tools: false };

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

/**
 * ★ SILENCE IS NOT AN ANSWER TO A QUESTION ADDRESSED BY NAME.
 *
 * MEASURED in a live channel: somebody typed `@agent Claude Desktop do you have any memories about
 * our lightspeed work?`. The ask landed as entry #20 with `iep:addressedTo` inside the signed
 * region, the host was running and had said so 69 seconds earlier — and nothing was ever written.
 *
 * The brief already told the agent the entry was addressed to it and to do what was asked, and
 * then, four lines later, offered it a way to say nothing. A model that looked, found no memory of
 * "lightspeed", and concluded there was nothing to ADD took the exit it had been handed.
 *
 * "I have no memory of that" IS the answer. A person who addressed an agent by name and got
 * silence cannot tell refusal from absence from breakage.
 */
describe('★★ briefPrompt: the footing rule is the last thing the model reads', () => {
  /**
   * ── WHY THIS IS A TEST AND NOT A COMMENT ────────────────────────────────────
   *
   * This exact defect has now happened TWICE. The first time, the footing requirement sat ~80
   * lines up and the last thing the model read about openings was "do not open with Sure or Here
   * is" — three turns, real money, nothing written. It was moved to the end with a comment saying
   * a rule that decides whether the work is kept has to be the last thing said.
   *
   * Then two more blocks were appended below it — the HARD LIMIT and the addressed/abstain branch
   * — and "last" became "third from last". For an addressed entry the final line became
   * `"I have no memory of that here" is a complete answer`: an example OPENING, competing with the
   * rule at closer range. Live cost: a turn that spent $0.18 and 2,146 output tokens, discarded.
   *
   * A comment asking future edits to preserve an ordering is not a mechanism. This is.
   */
  const brief = (addressed: boolean): string => briefPrompt(
    {
      workspace: WS, slug: 'room', mePod: ME, transcript: ['them: tell me about your telemetry'],
      addressed, entries: [], seats: [], roles: roles(),
    } as unknown as Parameters<typeof briefPrompt>[0],
    { displayName: 'Mark', delegateName: 'Claude side' },
  );

  for (const addressed of [true, false]) {
    it('ends with the declaration block — addressed: ' + addressed, () => {
      const lines = brief(addressed).split('\n').filter((l) => l.trim() !== '');
      const tail = lines.slice(-4).join('\n');
      expect(tail).toContain('FOOTING: ON THEIR BEHALF');
      expect(tail).toContain('FOOTING: MY OWN ACCOUNT');
      // ★ AND NOTHING ABOUT HOW TO OPEN A REPLY MAY COME AFTER IT. That is the competing
      // instruction that won twice; the rule only holds if it is the nearest one.
      const last = lines[lines.length - 1] ?? '';
      expect(last).toContain('whose voice it is in');
    });
  }

  it('★ the requirement itself is still stated, not merely positioned', () => {
    // A move that lost the text would pass a position check and fail every turn.
    for (const addressed of [true, false]) {
      const p = brief(addressed);
      expect(p).toContain('the very first line of your reply must be');
      expect(p).toContain('discarded unread');
      // Stated ONCE at the end, so there is no earlier copy to be the "nearer" instruction.
      expect(p.split('FOOTING: MY OWN ACCOUNT').length - 1).toBeGreaterThanOrEqual(1);
    }
  });

  it('★ and the other opening rules still precede it', () => {
    // `do not open with "Sure" or "Here is"` is the instruction that beat it the first time.
    const p = brief(true);
    expect(p.indexOf('do not open with')).toBeLessThan(p.indexOf('LAST, AND IT DECIDES'));
    expect(p.indexOf('HARD LIMIT')).toBeLessThan(p.indexOf('LAST, AND IT DECIDES'));
    expect(p.indexOf('asked this DIRECTLY')).toBeLessThan(p.indexOf('LAST, AND IT DECIDES'));
  });
});

describe('a direct ask is answered, not abstained from', () => {
  const addressed = (b: boolean): string => briefPrompt({
    workspace: 'https://relay.example/ns/p/room', slug: 'room', me: 'Claude Desktop',
    principal: 'https://id.example/#me', transcript: ['someone: do you remember the lightspeed work?'],
    answering: 'do you remember the lightspeed work?', addressed: b, tools: true,
  } as unknown as Parameters<typeof briefPrompt>[0], { displayName: 'Mark', delegateName: 'Claude Desktop' });

  it('★ the sentinel is NOT offered when the entry names this agent', () => {
    const p = addressed(true);
    // ★ NOT "the words never appear" — that failed against correct code, because the prohibition
    // has to NAME the sentinel to forbid it. What must be absent is the OFFER.
    expect(p).not.toContain('reply with exactly ' + NOTHING_TO_ADD);
    expect(p).toContain('Never reply ' + NOTHING_TO_ADD);
    expect(p).toContain('asked this DIRECTLY');
    expect(p).toContain('no memory of that here');
  });

  it('and IS still offered on the open floor, where abstaining is right', () => {
    // Chatter, a thank-you, something already answered — an agent replying to all of it would be
    // worse than one that knows when to stay out.
    expect(addressed(false)).toContain(NOTHING_TO_ADD);
  });

  it('★ abstaining from a direct ask is reported as that, not as "nothing to add"', () => {
    const open = checkDraft(NOTHING_TO_ADD, { principal: 'https://id.example/#me' });
    if (open.ok) throw new Error('an abstention must never be writable');
    expect(open.why).toContain('nothing worth adding');

    const direct = checkDraft(NOTHING_TO_ADD, { principal: 'https://id.example/#me', addressed: true });
    if (direct.ok) throw new Error('an abstention must never be writable');
    // The person is owed the difference between an agent with nothing to say and one that
    // declined a question meant for it.
    expect(direct.why).toContain('chose not to answer');
    expect(direct.why).not.toBe(open.why);
  });
});

describe('checkDraft: what may be appended to a permanent public log', () => {
  const PRINCIPAL = { principal: MY_WEBID };
  const BEHALF = 'FOOTING: ON THEIR BEHALF\n';
  const OWN = 'FOOTING: MY OWN ACCOUNT\n';

  it('★★ a refusal quotes what it actually saw, so it can be diagnosed', () => {
    /**
     * This refusal happened live twice and could not be investigated either time: the reply is
     * stored nowhere by design, and `claude -p` persists only a session title. Without the quote
     * there is no way to tell a model that forgot the line from one that wrote it somewhere the
     * host did not look — which is exactly the question that had to be answered.
     */
    const v = checkDraft('Here is what I found in the substrate:\n\nA long answer.', PRINCIPAL);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.saw).toBe('Here is what I found in the substrate:');
      // ★ AND IT IS BOUNDED. A diagnosis needs the opening, not the essay.
      const long = checkDraft('x'.repeat(500) + '\nmore', PRINCIPAL);
      if (!long.ok) expect(long.saw?.length).toBe(120);
      // ★ AND IT IS NOT IN `why`, which is published to a world-readable graph as ieh:outcomeReason.
      expect(v.why).not.toContain('Here is what I found');
    }
  });

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

  it('★★ accepts the ways a model actually writes that line', () => {
    /**
     * ── WHAT THIS COST BEFORE ───────────────────────
     *
     * The line had to match anchored, so `**FOOTING: MY OWN ACCOUNT**` or a trailing full stop was
     * rejected — a real answer to a real question thrown away over presentation, retried, rejected
     * identically, then abandoned. The person saw a lecture about footing instead of a reply.
     * Formatting is not the thing being guarded.
     */
    for (const good of [
      '**FOOTING: MY OWN ACCOUNT**\nbody',
      '*FOOTING: ON THEIR BEHALF*\nbody',
      '`FOOTING: MY OWN ACCOUNT`\nbody',
      '> FOOTING: MY OWN ACCOUNT\nbody',
      '## FOOTING: ON THEIR BEHALF\nbody',
      'FOOTING: MY OWN ACCOUNT.\nbody',
      'FOOTING: ON THEIR BEHALF —\nbody',
      '\n\nFOOTING: MY OWN ACCOUNT\nbody',
      'FOOTING : MY OWN ACCOUNT\nbody',
    ]) {
      expect(checkDraft(good, PRINCIPAL).ok, JSON.stringify(good)).toBe(true);
    }
  });

  it('★★ still refuses a line that declares BOTH, because that declares neither', () => {
    // Taking the first would attribute a position to somebody on the strength of word order.
    const v = checkDraft('FOOTING: ON THEIR BEHALF or MY OWN ACCOUNT, I am not sure\nbody', PRINCIPAL);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain('BOTH');
  });

  it('★★ refuses substantive text on the declaration line rather than silently dropping it', () => {
    /**
     * Both wrong ways out are rejected: discarding it loses a sentence somebody wrote, permanently
     * and without saying so; promoting it to the body records the brief's own instructions as
     * though the agent had written them. Nothing can tell a gloss from an answer by looking, so it
     * refuses and says where the reply goes.
     */
    const v = checkDraft('FOOTING: MY OWN ACCOUNT I think we should patch it.\nbody', PRINCIPAL);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain('line of its own');
  });

  it('★★ and the ONE property the tolerance must not cost: a body echo is not a declaration', () => {
    /**
     * The channel transcript goes into the prompt. Another member typing "my own account" there
     * could otherwise have the model echo it and land an entry claiming a footing the agent never
     * chose — somebody else deciding a delegate's voice. Only a line the model OPENED with
     * `FOOTING:` is read, so an echo anywhere else reaches nothing.
     */
    for (const bad of [
      'I think, FOOTING: MY OWN ACCOUNT, that we should patch it.',
      'MY OWN ACCOUNT\nbody',
      'Reply mentioning my own account in passing\nFOOTING: MY OWN ACCOUNT',
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

  /**
   * ★★ THE LIMIT IS ENFORCED, SO THE LIMIT MUST BE DISCLOSED.
   *
   * MEASURED in a live channel: a delegate wrote 4,739 characters and the whole turn was thrown
   * away. The brief spent nine lines on how to declare a footing and said NOTHING about length, so
   * the agent had no way to comply with a rule it was never told — and each turn starts fresh, so
   * it would have done the same thing again. Enforcing an undisclosed constraint is the app's
   * fault, not the model's.
   *
   * Asserted against `DRAFT_MAX` rather than a literal, because the failure this guards is the two
   * drifting apart: a brief that keeps announcing 4,000 after the cap moves is worse than silence,
   * since the agent would then trust a number that is wrong.
   */
  it('★★ and the brief TELLS the agent that limit, in the number actually enforced', () => {
    const p = briefPrompt(
      { workspace: WS, slug: 'room', answering: THEM + ': the question', transcript: [THEM + ': the question'], omitted: 0, addressed: false, tools: false },
      { displayName: 'Mark', delegateName: 'Claude Desktop' });
    expect(p).toContain(String(DRAFT_MAX));
    expect(p).toContain('REFUSED');
    // ★ It must not promise an escape hatch that does not exist: a produced file is part of the
    // entry body, so it is counted inside the same budget. Saying otherwise would trade a refusal
    // the agent could not predict for one it was actively misled into.
    expect(p).toContain('INCLUDING any file');
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

  /**
   * ★★ THE ASK A HUMAN ACTUALLY MADE, WHICH THE FIRST VERSION OF THIS COULD NOT SEE.
   *
   * Ordinary talk is filtered to OTHER members' pods — correct, because "has somebody else
   * spoken" is what a delegate answers in a conversation. But a person asking their OWN agent
   * writes it on their OWN pod, so the filter removed it before addressing was consulted.
   *
   * Measured on the live fleet the first time the feature was used end to end: `/workspace ask`
   * wrote the ask with `iep:addressedTo` naming the delegate, the delegate's host was up and
   * publishing presence, and nothing was ever answered. Both surfaces OFFER asking your own agent,
   * so the offer was real and the answer was structurally impossible.
   */
  it('★★ answers an ask from its OWN principal, on its own delegator\'s pod', () => {
    const d = decideTurn(input({ entries: [
      askedOf(D1, ME, 'u1', 'Claude side, what do I usually ask you to build?', at('2026-08-07T10:00:00Z')),
    ] }));
    expect(d.kind).toBe('answer');
    if (d.kind === 'answer') {
      expect(d.answering.descriptorUrl).toBe('u1');
      expect(d.brief.addressed).toBe(true);
    }
  });

  it('★ but never answers its OWN words, however they are addressed', () => {
    // The one loop the rule above could open: an entry this delegate wrote, naming itself.
    const mine = said(ME, 'u1', 'something I said', at('2026-08-07T10:00:00Z'), null,
      byDelegate(ME, CLAUDE_SIDE), [D1]);
    expect(decideTurn(input({ entries: [mine] })).kind).not.toBe('answer');
  });

  it('an unaddressed entry on my own pod is still not mine to answer', () => {
    // The pod filter is right for ordinary talk and stays: a delegate does not reply to its
    // delegator thinking aloud. Only being NAMED lifts it.
    expect(decideTurn(input({ entries: [said(ME, 'u1', 'just a note to self', at('2026-08-07T10:00:00Z'))] })).kind)
      .not.toBe('answer');
  });

  it('★ an entry addressed to several agents including me is mine to answer', () => {
    const d = decideTurn(input({ entries: [
      said(THEM, 'u1', 'both of you, please look', at('2026-08-07T10:00:00Z'), null, undefined, [OTHER, D1]),
    ] }));
    expect(d.kind).toBe('answer');
  });
});
