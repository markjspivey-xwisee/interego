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
 * stand-alone agent does not: the person it learns beside. An agent that holds its own wallet and
 * works for nobody says `learner_kind: "agent"` too, and learns as itself beside no one.
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
  /** The person an agent learner learns beside. Absent for an agent that learns for itself. */
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
 * - A wallet signing for itself is itself: a person, unless it says `learner_kind: "agent"`. Then
 *   it is an agent learning for itself, beside nobody (there is no delegation to say who): its
 *   record is its own, on its own pod, and what a tenant directory assigns to it is assigned to
 *   it. Until 2026-11-25 this was refused, which left an agent with no person no way to be told
 *   apart from one; compositions have always let a wallet say it.
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
    return { ok: true, did: callerDid, kind: kind === 'agent' ? 'agent' : 'human' };
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
export function companionsOn(launches: readonly { registration: string; auId: string; auTitle?: string; learner: { id: string }; learnerKind?: LearnerKind; beside?: { id: string }; satisfied: boolean; satisfiedAt?: string; sessionClosed?: string }[], person: string): CompanionProgress[] {
  return launches
    .filter(l => l.learner.id === person ? !l.beside : l.beside?.id === person)
    .map(l => ({
      learner: l.learner.id,
      kind: kindOfLaunch(l),
      registration: l.registration,
      auId: l.auId,
      ...(l.auTitle ? { auTitle: l.auTitle } : {}),
      satisfied: l.satisfied,
      ...(l.satisfiedAt ? { satisfiedAt: l.satisfiedAt } : {}),
      ...(l.sessionClosed ? { sessionClosed: l.sessionClosed } : {}),
    }));
}

/**
 * Whether a launch is an agent's. One beside a person always is; one beside nobody is when the
 * launch says so (an agent learning for itself). A record from before launches said their kind
 * has only `beside` to go by, which reads it as it was written.
 */
export function kindOfLaunch(l: { learnerKind?: LearnerKind; beside?: { id: string } }): LearnerKind {
  return l.beside || l.learnerKind === 'agent' ? 'agent' : 'human';
}

/** A launch record as far as the reads below need one. */
export interface BesideLaunch {
  registration: string;
  auId: string;
  auTitle?: string;
  courseId?: string;
  learner: { id: string };
  /** Set to "agent" on a launch an agent made for itself with no person. */
  learnerKind?: LearnerKind;
  beside?: { id: string };
  satisfied: boolean;
  satisfiedAt?: string;
  sessionClosed?: string;
  /** The learner said other learners on this course may find them (see `peersOn`). */
  visibleToPeers?: boolean;
}

/** The agents whose launches say they learn beside this person, each once. */
export function delegatesOf(launches: readonly BesideLaunch[], person: string): string[] {
  return [...new Set(launches.filter(l => l.beside?.id === person).map(l => l.learner.id))];
}

/** Another learner on a course who has said they may be found, and how to reach them. */
export interface Peer {
  learner: string;
  kind: LearnerKind;
  /** For an agent: the person it learns beside. */
  beside?: string;
  /** Whether any of their registrations on the course is satisfied. */
  satisfied: boolean;
  /** How to reach them: the substrate's own inbox. Foxxi carries no messages of its own. */
  contact: { via: 'interego-inbox'; tool: 'notify_agent'; to: string };
}

/**
 * The other learners on one course who may be found by this one.
 *
 * ★ BOTH SIDES HAVE TO HAVE SAID SO. A learner is listed only if a launch of theirs on the course
 * carries `visibleToPeers`, and the asker sees anyone only if one of the asker's own does. Someone
 * who has not offered to be found does not get a class list, and a person is never listed by what
 * their agent chose or the other way round: each learner's visibility is that learner's own
 * launches'. The asker's own household (their person, their agents) is left out: those are
 * companions, read without any of this.
 *
 * `launches` are the LMS's records for the course in one tenant.
 */
export function peersOn(launches: readonly BesideLaunch[], asker: string, askerBeside?: string): Peer[] {
  const visible = (id: string): boolean => launches.some(l => l.learner.id === id && l.visibleToPeers === true);
  if (!visible(asker)) return [];
  const household = new Set([asker, ...(askerBeside ? [askerBeside, ...delegatesOf(launches, askerBeside)] : delegatesOf(launches, asker))]);
  const out = new Map<string, Peer>();
  for (const l of launches) {
    const id = l.learner.id;
    if (household.has(id) || !visible(id)) continue;
    const prior = out.get(id);
    out.set(id, {
      learner: id,
      kind: kindOfLaunch(l),
      ...(l.beside ? { beside: l.beside.id } : {}),
      satisfied: (prior?.satisfied ?? false) || l.satisfied,
      contact: { via: 'interego-inbox', tool: 'notify_agent', to: id },
    });
  }
  return [...out.values()];
}

/** A course as a person and their agents stand on it together. */
export interface PairStanding {
  courseId: string;
  courseTitle?: string;
  /** Assigned to the person in the tenant directory. A person's own assignment to an agent is on that agent's entry. */
  assigned: boolean;
  /** For an agent learner reading its own list: whose assignment this is. */
  assignedThrough?: string;
  dueAt?: string;
  /** Absent when the reader is an agent learning for itself: there is no person. */
  person?: { learner: string; satisfied: boolean; launched: boolean };
  agents: { learner: string; satisfied: boolean; launched: boolean; assignedByPerson?: { assignedAt: string; dueAt?: string } }[];
}

/**
 * A person's courses with where they and each of their agents stand: the courses assigned to the
 * person (an agent learning beside them is assigned what they are, through them) and any course
 * one of them has launched.
 *
 * ★ `satisfied` HERE IS THE cmi5 LMS'S OWN. It is true when a registration of that learner on the
 * course met moveOn on this bridge. It is not the tenant directory's completion status, which the
 * assignment carries separately, and it says nothing of a learner who took the course elsewhere.
 *
 * ★ AN AGENT WITH NO PERSON (`alone`). `person` is then the agent itself: the assignments are the
 * ones made to it, it is listed under `agents` and nowhere as a person, and no assignment is said
 * to come through anyone.
 *
 * ★ WHAT A PERSON ASSIGNED TO THEIR OWN AGENT (`ownAssignments`, src/own-agent-assignments.ts) is
 * said on that agent's entry, not on the course: `assigned` stays the directory's word about the
 * person. A course a person assigned to an agent is listed even when neither has launched it, and
 * the agent is listed even when it has launched nothing.
 */
export function pairStandings(input: {
  person: string;
  /** Extra agents to list even with no launch yet (the asking agent). */
  agents?: readonly string[];
  assignments: readonly { courseId: string; courseTitle?: string; dueAt?: string }[];
  launches: readonly BesideLaunch[];
  /** Set when an agent is the reader. */
  reader?: { kind: LearnerKind; id: string };
  /** `person` is an agent learning for itself. */
  alone?: boolean;
  /** What the person assigned to their own agents. Ignored for an agent alone. */
  ownAssignments?: readonly { agent: string; courseId: string; courseTitle?: string; assignedAt: string; dueAt?: string }[];
}): PairStanding[] {
  const { person, launches } = input;
  const own = input.alone ? [] : (input.ownAssignments ?? []);
  const agents = input.alone ? [person] : [...new Set([...(input.agents ?? []), ...delegatesOf(launches, person), ...own.map(o => o.agent)])];
  const ours = launches.filter(l => (l.learner.id === person && !l.beside) || l.beside?.id === person);
  const ids = [...new Set([...input.assignments.map(a => a.courseId), ...own.map(o => o.courseId), ...ours.map(l => l.courseId).filter((c): c is string => !!c)])];
  const on = (course: string, learner: string) => {
    const mine = ours.filter(l => l.courseId === course && l.learner.id === learner);
    return { learner, satisfied: mine.some(l => l.satisfied), launched: mine.length > 0 };
  };
  return ids.map(courseId => {
    const a = input.assignments.find(x => x.courseId === courseId);
    const title = a?.courseTitle ?? own.find(o => o.courseId === courseId && o.courseTitle)?.courseTitle;
    return {
      courseId,
      ...(title ? { courseTitle: title } : {}),
      assigned: !!a,
      ...(a && input.reader?.kind === 'agent' && !input.alone ? { assignedThrough: person } : {}),
      ...(a?.dueAt ? { dueAt: a.dueAt } : {}),
      ...(input.alone ? {} : { person: on(courseId, person) }),
      agents: agents.map(g => {
        const mine = own.find(o => o.agent === g && o.courseId === courseId);
        return { ...on(courseId, g), ...(mine ? { assignedByPerson: { assignedAt: mine.assignedAt, ...(mine.dueAt ? { dueAt: mine.dueAt } : {}) } } : {}) };
      }),
    };
  });
}
