/**
 * THE DECISION A PERSON'S OWN AGENT MAKES, TESTED WHERE IT IS MADE.
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
  type RoleTable, type Seat, type SeenEntry, type TurnInput,
} from '@interego/workspace-client';

const ME = 'u-eth-aaaaaaaaaaaa';
const THEM = 'u-eth-bbbbbbbbbbbb';
const WS = 'https://relay.interego.xwisee.com/ns/' + ME + '/room';
const ROLE = WS + '-roles#Contributor';

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
const said = (pod: string, url: string, body: string | null, when: number | null, derivedFrom: string | null = null): SeenEntry =>
  ({ pod, descriptorUrl: url, body, derivedFrom, at: when });

const input = (over: Partial<TurnInput> = {}): TurnInput => ({
  workspace: WS, slug: 'room', mePod: ME,
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
    if (d.kind === 'channel-incomplete') expect(d.why).toContain('your own entries carries no readable time');
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

  it('★ refuses a role the published table does not permit posting under', () => {
    const d = decideTurn(input({
      seats: [seat(ME, true, WS + '-roles#Observer'), seat(THEM)],
      entries: [said(THEM, 'u1', 'hi', at('2026-08-07T10:00:00Z'))],
    }));
    expect(d.kind).toBe('ceiling');
    if (d.kind === 'ceiling') expect(d.why).toContain('imposes on itself');
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

describe('briefPrompt: what the agent is asked, and what it is never handed', () => {
  const brief = { workspace: WS, slug: 'room', answering: THEM + ': the question', transcript: [THEM + ': the question'], omitted: 0 };

  it('names the channel and states that the record is permanent', () => {
    const p = briefPrompt(brief, { displayName: null });
    expect(p).toContain(WS);
    expect(p).toContain('permanent');
    expect(p).toContain('the question');
  });

  it('★ tells it not to invent facts the channel has not stated', () => {
    // Tuned from a measured live failure in the other direction: the first version made the model
    // abstain from a direct question. The instruction has to license engagement WITHOUT licensing
    // invention, and both halves are load-bearing.
    const p = briefPrompt(brief, { displayName: 'Sam' });
    expect(p).toContain('Do not invent');
    expect(p).toContain('Sam');
    expect(p).toContain(NOTHING_TO_ADD);
  });

  it('says how much of the channel is missing rather than implying it is whole', () => {
    expect(briefPrompt({ ...brief, omitted: 12 }, { displayName: null })).toContain('12 earlier entries are not shown');
    expect(briefPrompt(brief, { displayName: null })).toContain('whole channel so far');
  });
});

describe('checkDraft: what may be appended to a permanent public log', () => {
  it('accepts ordinary prose and trims it', () => {
    const v = checkDraft('  A considered reply.  ');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.body).toBe('A considered reply.');
  });

  it('★ refuses the abstain sentinel, an empty answer, and whitespace', () => {
    for (const bad of ['', '   \n  ', NOTHING_TO_ADD, 'nothing to add']) {
      expect(checkDraft(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('★ refuses an over-long draft rather than truncating it', () => {
    const v = checkDraft('x'.repeat(DRAFT_MAX + 1));
    expect(v.ok).toBe(false);
    // Half a sentence recorded permanently is worse than none, and a reader cannot tell it was cut.
    if (!v.ok) expect(v.why).toContain('refused rather than truncated');
    expect(checkDraft('x'.repeat(DRAFT_MAX)).ok).toBe(true);
  });
});
