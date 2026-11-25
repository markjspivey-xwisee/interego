/**
 * An agent that learns beside the person it works for.
 *
 * ★ WHY. A person brings their agents to Foxxi as delegates. Until 2026-11-25 a delegate that
 * launched a cmi5 course launched it AS that person: the registration, the statements and the
 * `satisfied` were the person's, and the agent appeared only as `via`. That is right when the agent
 * is carrying the person's own learning (opening a launch for them). It is wrong when the agent is
 * the one learning: the person's record then says they did what their agent did, and the agent has
 * no record of its own to be assigned from, enrolled in, or consulted on.
 *
 * Compositions already tell the two apart (`learner_kind`, src/compositions.ts): a wallet signing
 * for itself is a person, a delegated agent is an agent, and either may say otherwise. This module
 * carries the same distinction to the cmi5 LMS, and adds the one thing a delegate has that a
 * stand-alone agent does not: the person it learns beside.
 *
 * ★ NOTHING IS MINTED. Who a statement's actor learns beside is said with what xAPI already has:
 * `context.team`, "the team this statement relates to", an anonymous Group whose members are the
 * learner and the person. The LMS puts it in the cmi5 context template (cmi5 section 10.2.1), which
 * an AU must use for every statement it sends (section 9.6.2), so content written with no idea of
 * agents records it without change. A plain LRS stores it; nothing in xAPI or cmi5 is redefined.
 *
 * ★ WHOSE RECORD. The agent's statements name the agent as actor, so they are the agent's record.
 * They are kept on the pod the delegation is anchored in, the person's, which is where a delegate
 * keeps everything: the person can read what their agent learned, and the agent's record ends up
 * nowhere the person does not hold.
 */

export type LearnerKind = 'human' | 'agent';

/** A delegation as far as this module reads one. */
export interface DelegationRead {
  /** The person the delegation names. */
  person: string;
  /** When it ends, if it says. */
  expiresAt?: string;
}

export interface SignedLearner {
  /** Who the record is about: the xAPI actor. */
  did: string;
  kind: LearnerKind;
  /** The agent carrying a person's own learning. */
  via?: string;
  /** The person an agent learner learns beside. */
  beside?: string;
}

export type LearnerRefusal = { ok: false; status: number; error: string };

/** What a request says of who is learning: `learner_kind`, as compositions take it. */
export function learnerKindFrom(payload: Record<string, unknown>): LearnerKind | undefined | LearnerRefusal {
  const k = payload.learner_kind;
  if (k === undefined) return undefined;
  if (k === 'human' || k === 'agent') return k;
  return { ok: false, status: 400, error: 'learner_kind is "human" or "agent"' };
}

/**
 * Who a signed caller is learning as.
 *
 * - A wallet signing for itself is itself. It cannot learn as an agent beside someone: there is no
 *   delegation to say who.
 * - A delegate with no `learner_kind`, or `human`, carries its person's learning, as before.
 * - A delegate with `learner_kind: "agent"` learns as itself, beside the person its delegation
 *   names. The delegation has to be readable and in force: an agent whose delegation cannot be
 *   read is not quietly made a learner beside nobody, and not quietly made its person either.
 *
 * `delegation` is what was read for the caller: a delegation, `null` when the caller has none, or
 * `'unreadable'` when the read failed.
 */
export function learnerFor(input: {
  callerDid: string;
  /** The caller signed with its own wallet. */
  direct: boolean;
  delegation: DelegationRead | null | 'unreadable';
  kind?: LearnerKind;
  now?: number;
}): ({ ok: true } & SignedLearner) | LearnerRefusal {
  const { callerDid, direct, delegation, kind } = input;
  if (direct) {
    if (kind === 'agent') return { ok: false, status: 400, error: 'learner_kind "agent" is for a delegate, which learns beside the person its delegation names; a wallet signing for itself learns as itself' };
    return { ok: true, did: callerDid, kind: 'human' };
  }
  if (kind !== 'agent') {
    // As before: the person the delegation names, or the caller when none could be read.
    const person = delegation && delegation !== 'unreadable' ? delegation.person : callerDid;
    return { ok: true, did: person, kind: 'human', via: callerDid };
  }
  if (delegation === 'unreadable') return { ok: false, status: 503, error: 'the delegation could not be read just now, so the agent was not launched beside anyone; try again' };
  if (!delegation || !delegation.person || delegation.person === callerDid) return { ok: false, status: 401, error: 'this agent has no delegation naming a person to learn beside' };
  if (delegation.expiresAt && Date.parse(delegation.expiresAt) <= (input.now ?? Date.now())) return { ok: false, status: 401, error: 'this delegation has expired' };
  return { ok: true, did: callerDid, kind: 'agent', beside: delegation.person };
}

export interface XapiAccountAgent {
  objectType: 'Agent';
  account: { homePage: string; name: string };
}

export interface BesideTeam {
  objectType: 'Group';
  member: XapiAccountAgent[];
}

/**
 * The team of a learner and the person it learns beside, as xAPI's `context.team`: an anonymous
 * Group (no identifier of its own), learner first. Both are named the way the LMS names any
 * learner, by account under the same authoritative source.
 */
export function besideTeam(homePage: string, learnerId: string, besideId: string): BesideTeam {
  const agent = (name: string): XapiAccountAgent => ({ objectType: 'Agent', account: { homePage, name } });
  return { objectType: 'Group', member: [agent(learnerId), agent(besideId)] };
}

/** The person a statement's actor learns beside, read back from its `context.team`; undefined when it says none. */
export function besideOf(statement: unknown): string | undefined {
  const s = statement as { actor?: { account?: { name?: unknown } }; context?: { team?: { objectType?: unknown; member?: unknown } } } | null;
  const team = s?.context?.team;
  const self = s?.actor?.account?.name;
  if (!team || team.objectType !== 'Group' || !Array.isArray(team.member) || team.member.length !== 2 || typeof self !== 'string') return undefined;
  const names = team.member.map(m => (m as { account?: { name?: unknown } } | null)?.account?.name);
  if (names[0] !== self || typeof names[1] !== 'string' || names[1] === self) return undefined;
  return names[1];
}

/** One learner's place on a unit, as its companions see it. */
export interface CompanionProgress {
  learner: string;
  kind: LearnerKind;
  registration: string;
  auId: string;
  auTitle?: string;
  satisfied: boolean;
  satisfiedAt?: string;
  sessionClosed?: string;
}

/**
 * A person and the agents learning beside them, on one course: each one's registrations.
 *
 * `launches` are the LMS's records for the course. Kept are the person's own and those of agents
 * whose launch says they learn beside that person. Nobody else's are returned, whoever asks: this
 * is a person and their own delegates, not a class list.
 */
export function companionsOn(launches: readonly { registration: string; auId: string; auTitle?: string; learner: { id: string }; beside?: { id: string }; satisfied: boolean; satisfiedAt?: string; sessionClosed?: string }[], person: string): CompanionProgress[] {
  return launches
    .filter(l => l.learner.id === person ? !l.beside : l.beside?.id === person)
    .map(l => ({
      learner: l.learner.id,
      kind: (l.beside ? 'agent' : 'human') as LearnerKind,
      registration: l.registration,
      auId: l.auId,
      ...(l.auTitle ? { auTitle: l.auTitle } : {}),
      satisfied: l.satisfied,
      ...(l.satisfiedAt ? { satisfiedAt: l.satisfiedAt } : {}),
      ...(l.sessionClosed ? { sessionClosed: l.sessionClosed } : {}),
    }));
}
