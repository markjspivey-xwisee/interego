/**
 * WHETHER A PERSON'S OWN AGENT SHOULD SAY SOMETHING, AND WHAT IT IS ANSWERING.
 *
 * `applications/shared-workspace/bridge` already runs a seated agent: `respond_as_member` reads a
 * channel and appends to the agent's OWN log, refusing when it is not seated and refusing again
 * when the role ceiling does not permit an append. That agent is a SERVICE — it holds its own key,
 * runs on somebody's server, and is its own member of the workspace.
 *
 * This is the same decision for a DIFFERENT author: the agent a person runs on their own machine,
 * under their own identity, writing to their own pod. It is not a second member. Its entries are
 * the user's entries, on the user's log, and the only thing that differs from the user typing is
 * who composed the words.
 *
 * ★ WHY THE DECISION IS HERE AND THE MODEL CALL IS NOT. Deciding whether there is anything to
 * answer, which entry is being answered, and whether the same thing has been answered already is a
 * statement about the substrate — three clients would otherwise each get it slightly wrong, which
 * is the drift this package exists to prevent. Running a model is a child process on somebody's
 * laptop; it cannot be in a package that also has to run in a browser. So this produces a
 * {@link ChannelBrief} — everything a model needs and nothing about how to reach one — and the
 * shell turns that into a draft.
 *
 * ★ AND THERE IS NO INPUT FOR THE REPLY TEXT, WHICH IS COPIED FROM THE BRIDGE'S AFFORDANCE ON
 * PURPOSE. `affordances.ts` states it: "a caller who could pass text would be the author, and the
 * agent would be a signature on somebody else's sentence." The same holds one layer down. Nothing
 * here accepts a body from its caller; the body comes back from the model and goes through
 * {@link checkDraft} before anybody is allowed to post it.
 */

import { shortRef } from './format.js';
import type { RoleTable } from './membership.js';
import { checkRoleForWorkspace } from './membership.js';
import type { Seat } from './seats.js';

/** One entry, as a reader of somebody's log sees it. */
export interface SeenEntry {
  /** The pod the entry was read from — the author's own, always. */
  readonly pod: string;
  readonly descriptorUrl: string;
  /** Null when the entry carried no readable body. NOT the empty string — those differ. */
  readonly body: string | null;
  /** What this entry was derived from, when it says. Used to tell an answer from a first word. */
  readonly derivedFrom: string | null;
  /** Unix ms, or null when the entry did not carry a readable time. Never a guessed one. */
  readonly at: number | null;
}

/** Everything the decision needs, gathered by whichever client is asking. */
export interface TurnInput {
  readonly workspace: string;
  readonly slug: string;
  /** The pod the agent would write to — the user's own. */
  readonly mePod: string;
  /** The fold of the roster this client already computed. Not re-derived here. */
  readonly seats: readonly Seat[];
  /** The published role table. Null when it could not be read — which is a refusal, not a pass. */
  readonly roles: RoleTable | null;
  /** Every entry the client managed to read, from every member's log, in whatever order. */
  readonly entries: readonly SeenEntry[];
  /**
   * How many entries were found but could NOT be read.
   *
   * ★ REQUIRED, AND A NON-ZERO VALUE IS A REFUSAL. An adversarial review found the path: a
   * transient failure reading the agent's OWN most recent reply removes it from `entries`, the
   * "have I spoken since they did" test then compares against an older entry of mine, and the
   * agent answers the same message a second time — permanently, publicly. A partially-read channel
   * cannot answer "who spoke last", and guessing costs a duplicate record on somebody's log.
   */
  readonly unreadable: number;
  /**
   * Descriptor URLs this client has ALREADY drafted an answer to.
   *
   * ★ THE ONLY PART OF THIS DECISION THAT ANOTHER MEMBER CANNOT INFLUENCE, WHICH IS WHY IT IS THE
   * PRIMARY GUARD. A second adversarial review established that `at` is not a fact: it comes from
   * `validFrom`, which comes from the OPTIONAL `valid_from` argument to `publish_context`, so it is
   * a number the author of the entry chose. One member publishing an entry dated a year in the
   * future makes every reply of mine "older" than theirs forever — the ordering guard never fires
   * and the agent answers the same entry on every poll, permanently. Dating an entry in the past
   * does the mirror and makes the agent mute toward that member.
   *
   * Ordering across pods was already documented as ADVISORY for rendering ("these clocks were never
   * synchronised, and there is no shared sequencer") and promoting it to authoritative for a WRITE
   * was the mistake. So the client's own record of what it has answered comes first, and the
   * timestamps are a secondary signal that can only ever add refusals, never remove one.
   *
   * ★ AND ITS LIMIT IS STATED RATHER THAN HIDDEN: this is per-run. A client restarted between
   * drafting and posting can answer the same entry once more. That is one duplicate, bounded, and
   * visible in the composer before it is posted — as against an unbounded loop.
   */
  readonly answeredHere: readonly string[];
}

/** What a model is given. Text only — no IRIs to fetch, no tools, no credential. */
export interface ChannelBrief {
  readonly workspace: string;
  readonly slug: string;
  /** The entry being answered, rendered for a reader. */
  readonly answering: string;
  /** Oldest-first, most recent last, each line already attributed. Bounded — see BRIEF_ENTRIES. */
  readonly transcript: readonly string[];
  /** How many entries were left out of `transcript` because of the bound. Zero, never omitted. */
  readonly omitted: number;
}

export type TurnDecision =
  | { readonly kind: 'not-seated'; readonly why: string }
  | { readonly kind: 'ceiling'; readonly why: string }
  | { readonly kind: 'roles-unreadable'; readonly why: string }
  /** Part of the channel could not be read, so who spoke last is not established. */
  | { readonly kind: 'channel-incomplete'; readonly why: string }
  | { readonly kind: 'nothing-to-answer'; readonly why: string }
  | { readonly kind: 'already-answered'; readonly why: string; readonly answering: SeenEntry }
  | { readonly kind: 'answer'; readonly answering: SeenEntry; readonly brief: ChannelBrief };

/**
 * How many entries go into a brief.
 *
 * Bounded because a channel is unbounded and a model call is not. Chosen over "everything since my
 * last entry" because a long silence would then send nothing and a busy morning would send a
 * novel; a fixed recent window is the same size whatever the channel did.
 */
export const BRIEF_ENTRIES = 24;

/** The longest draft that may be posted. See {@link checkDraft} for why there is a limit at all. */
export const DRAFT_MAX = 4000;

const line = (e: SeenEntry, mePod: string): string =>
  (e.pod === mePod ? 'you' : e.pod) + ': ' + (e.body ?? '(this entry carried no readable body)');

/**
 * Should this agent say something, and about what?
 *
 * ★ SEATING AND THE CEILING ARE CHECKED EVEN THOUGH NOTHING COULD ENFORCE THEM. The pod is the
 * user's own pod; the relay would accept the write. `respond.ts` says why the bridge refuses
 * anyway and it holds here: an entry written past the ceiling is not prevented, it is INERT — the
 * roster fold would not count it and would say why. Writing one would put a permanent record in
 * somebody's log that no reader of the channel will ever see as part of the channel.
 */
export function decideTurn(input: TurnInput): TurnDecision {
  const seat = input.seats.find((s) => s.pod === input.mePod && s.seated) ?? null;
  if (!seat) {
    const named = input.seats.find((s) => s.pod === input.mePod) ?? null;
    return {
      kind: 'not-seated',
      why: named
        ? 'Your pod is named in this workspace but you are not seated: ' + (named.why || 'the fold gave no reason')
          + '. Nothing has been written.'
        : 'You are not seated in ' + input.workspace + ', so there is no log of yours in this channel to write to.',
    };
  }
  if (!input.roles) {
    // Absence is not evidence. An unreadable role table is not an empty one, and it is certainly
    // not permission — the bridge refuses on exactly this and so does this.
    return {
      kind: 'roles-unreadable',
      why: 'The role table this workspace declares could not be read, so no ceiling can be computed. '
        + 'That is not the same as the ceiling permitting this, so nothing is written.',
    };
  }
  const verdict = checkRoleForWorkspace(input.roles, seat.role ?? '');
  if (!verdict.ok) {
    return {
      kind: 'ceiling',
      why: 'The role ceiling refuses this write. ' + verdict.why
        + ' Nothing could stop this agent writing to your pod — it is your pod — so this is a refusal it '
        + 'imposes on itself. An entry written anyway would exist and be inert: the fold would not count it.',
    };
  }

  if (input.unreadable > 0) {
    return {
      kind: 'channel-incomplete',
      why: input.unreadable + ' entr' + (input.unreadable === 1 ? 'y' : 'ies') + ' in this channel could not be read. '
        + 'Who spoke last is therefore not established, and answering on a partial read is how the same message '
        + 'gets answered twice. Nothing is written.',
    };
  }

  // A body that is present and empty is a deliberate empty entry, not something to answer. A body
  // that is null was not readable, which is different again and equally not something to answer:
  // a model asked to reply to text nobody could read would be inventing the thing it replies to.
  const said = (e: SeenEntry): boolean => typeof e.body === 'string' && e.body.trim() !== '';

  /**
   * ★ AN ENTRY WITH NO READABLE TIME CANNOT BE PLACED, AND MUST NOT BE PLACED LAST.
   *
   * This is the defect an adversarial review found, and it is worth spelling out because the first
   * version looked obviously right. It sorted `a.at ?? Number.MAX_SAFE_INTEGER`, so an entry with
   * no readable timestamp sorted LAST — which in a conversation means NEWEST. The "have I spoken
   * since they did" guard then compared against that undated entry, which is never mine, so the
   * guard never fired: the agent answered the same message on every 45-second poll, forever, each
   * one a permanent public record. Exactly the loop the guard existed to prevent.
   *
   * Undated entries are therefore excluded from the ORDER decision entirely rather than given a
   * position that is a guess in one direction or the other. They still appear in the transcript,
   * because a reader can see them; they just cannot establish that anything new has happened.
   */
  const dated = input.entries.filter((e) => e.at !== null && said(e))
    .sort((a, b) => (a.at as number) - (b.at as number));
  const undated = input.entries.filter((e) => e.at === null);

  const lastMine = [...dated].reverse().find((e) => e.pod === input.mePod) ?? null;
  /**
   * ★ ENTRIES THIS CLIENT HAS ALREADY ANSWERED ARE REMOVED BEFORE ANYTHING ELSE LOOKS AT THEM.
   * First, so that a spoofed `at` cannot get past it — see `answeredHere`. It reads as the newest
   * unanswered thing somebody else said, which is the question that was meant all along.
   */
  const answered = new Set(input.answeredHere);
  const lastTheirs = [...dated].reverse()
    .find((e) => e.pod !== input.mePod && !answered.has(e.descriptorUrl)) ?? null;

  if (!lastTheirs) {
    const anyTheirs = dated.some((e) => e.pod !== input.mePod);
    return {
      kind: anyTheirs ? 'already-answered' : 'nothing-to-answer',
      ...(anyTheirs ? { answering: dated[dated.length - 1] as SeenEntry } : {}),
      why: anyTheirs
        ? 'Everything another member has said in this channel has already been answered by this client in this run. '
          + 'Appending again would put a second permanent record in your log saying the same thing.'
        : undated.length
          ? 'Nothing another member wrote in this channel carries a readable time, so whether any of it is new is not '
            + 'established. Your agent answers what it can place in the conversation, and it can place none of this.'
          : 'Nobody else has written anything readable in this channel yet.',
    } as TurnDecision;
  }

  /**
   * ★ AN UNDATED ENTRY OF MY OWN IS A REFUSAL, NOT A "NEVER SPOKE".
   *
   * The exclusion of undated entries from the ordering is asymmetric, and the review caught which
   * side is unsafe: for THEIR entries "cannot be placed" means "never new", which is safe; for MINE
   * it would mean "never spoke", so the guard below would be skipped and the agent would answer
   * again on every poll. If any entry of my own cannot be placed in time, who spoke last is not
   * established about ME, and that is a refusal.
   */
  if (input.entries.some((e) => e.pod === input.mePod && e.at === null && said(e))) {
    return {
      kind: 'channel-incomplete',
      why: 'One of your own entries carries no readable time, so whether you have already spoken since '
        + lastTheirs.pod + ' did is not established. Answering on that is how the same message gets answered twice.',
    };
  }

  // ★ THE SECOND OF THREE GUARDS, AND DELIBERATELY NOT THE FIRST.
  //
  // "Has somebody else spoken since I last did" is the right question and this is the wrong
  // evidence for it on its own: `at` is caller-supplied (see `answeredHere`), so this test can be
  // defeated by an entry dated in the future. It stays because it costs nothing and catches the
  // ordinary case — including across a restart, which `answeredHere` cannot — and because every
  // guard here can only ADD a refusal. None of them can remove one.
  //
  // `>=` and not `>`: two entries sharing a timestamp is a tie this cannot resolve, and the safe
  // side of a tie is silence.
  if (lastMine && lastMine.at !== null && lastTheirs.at !== null && lastMine.at >= lastTheirs.at) {
    return {
      kind: 'already-answered',
      answering: lastTheirs,
      why: 'You have written in this channel since ' + (lastTheirs.pod) + ' last did ('
        + shortRef(lastMine.descriptorUrl) + '). Your agent answers when somebody else has spoken last; '
        + 'appending now would put a second permanent record in your log with nothing new to answer.',
    };
  }
  // Still honoured when present, because the bridge's own writer DOES emit it and an explicit
  // derivation link is a stronger statement than an ordering.
  const derived = input.entries.find((e) => e.pod === input.mePod && e.derivedFrom === lastTheirs.descriptorUrl);
  if (derived) {
    return {
      kind: 'already-answered',
      answering: lastTheirs,
      why: 'The newest entry from another member is already declared as answered on your log ('
        + shortRef(derived.descriptorUrl) + '). Appending again would put two permanent records in your log '
        + 'saying the same thing.',
    };
  }

  const newest = lastTheirs;
  // The transcript keeps undated entries — a reader sees them, so the agent should too — placed
  // before the dated ones rather than interleaved on a time nobody reported.
  const ordered = [...undated, ...dated];
  const window = ordered.slice(-BRIEF_ENTRIES);
  return {
    kind: 'answer',
    answering: newest,
    brief: {
      workspace: input.workspace,
      slug: input.slug,
      answering: line(newest, input.mePod),
      transcript: window.map((e) => line(e, input.mePod)),
      omitted: Math.max(0, ordered.length - window.length),
    },
  };
}

/**
 * The instruction a local agent is given, alongside a {@link ChannelBrief}.
 *
 * Kept here rather than in a shell so that what the agent was ASKED is one string with one author,
 * reviewable in the same place as the decision that produced it. A shell that composed its own
 * would be able to change what the user's agent is for without changing anything reviewable.
 */
export function briefPrompt(brief: ChannelBrief, args: { readonly displayName: string | null }): string {
  const who = args.displayName ? args.displayName : 'the person whose account you are running under';
  return [
    'You are taking part in a shared workspace conversation as ' + who + '\'s own agent, running on',
    'their machine under their own credential. What you write is appended to THEIR log as THEIR',
    'entry: a permanent, signed, publicly readable record that cannot be edited or deleted.',
    '',
    'Channel: ' + brief.workspace,
    brief.omitted > 0 ? '(' + brief.omitted + ' earlier entries are not shown.)' : '(This is the whole channel so far.)',
    '',
    'Recent entries, oldest first:',
    ...brief.transcript.map((t) => '  ' + t),
    '',
    'Reply to this entry:',
    '  ' + brief.answering,
    '',
    // ★ THIS PARAGRAPH IS TUNED FROM A MEASURED FAILURE, NOT WRITTEN FROM TASTE. An earlier
    // version led with "write only what they would be content to have stand" and put the abstain
    // sentinel last. Driven live against a channel whose single entry was a direct question —
    // "do we re-tile in spring or patch it now?" — the model answered NOTHING TO ADD, because it
    // had no independent knowledge of the roof and the framing made silence the safe move. An
    // agent that abstains from every genuine question is not cautious, it is broken. So the
    // permanence is stated as a constraint on TONE, and the sentinel is scoped to the narrow case
    // it is actually for.
    'Reply as a thoughtful participant. You are not expected to know things the channel has not',
    'said — where a decision is theirs to make, engage with the substance, lay out the trade-off as',
    'you see it from what was written, or ask the one question that would settle it. Do not invent',
    'facts, commitments or history that are not in the entries above.',
    '',
    'Plain prose, a few sentences. No markdown headings, bullet lists or code fences. Do not open',
    'with "Sure" or "Here is", and do not sign your name.',
    '',
    'Reserve this for entries that plainly call for no response at all — an acknowledgement, a',
    'thank-you, or something already fully answered: reply with exactly NOTHING TO ADD.',
  ].join('\n');
}

/** The sentinel a model returns when it judges there is nothing worth appending. */
export const NOTHING_TO_ADD = 'NOTHING TO ADD';

export type DraftVerdict =
  | { readonly ok: false; readonly why: string }
  | { readonly ok: true; readonly body: string };

/**
 * Is what came back from the model something that may be appended to somebody's permanent log?
 *
 * ★ THE MODEL'S OUTPUT IS UNTRUSTED INPUT TO A WRITE. It was produced from text other members
 * wrote, so a member can influence it. That does not make it dangerous to the substrate — an entry
 * body is a Turtle literal and `entryTurtle` escapes it — but it does mean a blank, an enormous
 * wall, or a refusal message must not be appended as if the user had said it. Each of those has a
 * distinct answer here rather than a shared "invalid".
 */
export function checkDraft(raw: string): DraftVerdict {
  const body = raw.trim();
  if (!body) {
    return { ok: false, why: 'The model returned nothing. An empty entry is still a permanent record, so none is written.' };
  }
  if (body === NOTHING_TO_ADD || body.toUpperCase() === NOTHING_TO_ADD) {
    return { ok: false, why: 'Your agent read the channel and judged there was nothing worth adding. Nothing was written.' };
  }
  if (body.length > DRAFT_MAX) {
    // Refused rather than truncated: a truncated entry is a permanent record of half a sentence,
    // and the reader cannot tell it was cut.
    return {
      ok: false,
      why: 'The draft is ' + body.length + ' characters, over the ' + DRAFT_MAX + '-character limit for one entry. '
        + 'It is refused rather than truncated, because half a sentence recorded permanently is worse than none.',
    };
  }
  return { ok: true, body };
}
