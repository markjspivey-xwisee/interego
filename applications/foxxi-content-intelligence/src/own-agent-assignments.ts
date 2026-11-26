/**
 * A course a person assigns to one of their own agents.
 *
 * ★ WHY. An agent learning beside a person is assigned what that person is, through them, from the
 * tenant directory (src/learning-beside.ts). That left two people out: someone in no directory,
 * who had nothing to hand their agent, and someone who wants their agent to take a course they are
 * not themselves assigned. A directory admin can assign to an agent's id like any learner's; a
 * person could not assign to their own agent at all.
 *
 * ★ WHOSE AGENT. The person may assign only to an agent whose delegation names them, checked by
 * the caller when the assignment is made (bridge/server.ts reads the agent's delegation
 * credential). Nothing here trusts a claim of ownership: `assign` is handed a pair that was
 * already checked. An assignment is the person's standing instruction to their own delegate. It
 * is not an enrolment in anyone's directory and gives the agent no access it lacked: the agent
 * could already launch any course published on the bridge.
 *
 * ★ WHERE IT IS KEPT. The registry is written to the pod beside the other durable registries, so
 * an assignment survives a restart; this module is the record and its rules, and does no I/O.
 */

export interface OwnAgentAssignment {
  person: string;
  agent: string;
  courseId: string;
  courseTitle?: string;
  assignedAt: string;
  dueAt?: string;
  /** The agent that carried the person's request, when one did. */
  via?: string;
}

const key = (a: { person: string; agent: string; courseId: string }): string => JSON.stringify([a.person, a.agent, a.courseId]);

function validAssignment(v: unknown): v is OwnAgentAssignment {
  const a = v as Partial<OwnAgentAssignment> | null;
  const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 2048;
  return !!a && str(a.person) && str(a.agent) && str(a.courseId) && a.person !== a.agent
    && str(a.assignedAt) && Number.isFinite(Date.parse(a.assignedAt))
    && (a.courseTitle === undefined || typeof a.courseTitle === 'string')
    && (a.dueAt === undefined || (typeof a.dueAt === 'string' && Number.isFinite(Date.parse(a.dueAt))))
    && (a.via === undefined || str(a.via));
}

/** `due_at` as a request gives it: absent, or an instant. */
export function dueAtFrom(raw: unknown): { ok: true; dueAt?: string } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return { ok: false, error: 'due_at is an ISO 8601 instant' };
  return { ok: true, dueAt: new Date(raw).toISOString() };
}

export class OwnAgentAssignments {
  private readonly byKey = new Map<string, OwnAgentAssignment>();
  /**
   * Withdrawals this process made that the durable copy may still hold. Without them a withdrawal
   * would be undone by the next merge of that copy, which is how `load` works.
   */
  private readonly withdrawn = new Set<string>();
  /** Set when something changed that the durable copy does not hold yet. */
  dirty = false;
  constructor(private readonly max = 50_000, private readonly perPerson = 200) {}

  /**
   * Assign, or change the due date of, a course for a person's own agent. Assigning again keeps
   * when it was first assigned.
   */
  assign(input: { person: string; agent: string; courseId: string; courseTitle?: string; dueAt?: string; via?: string }, now: number): { assignment: OwnAgentAssignment; created: boolean } | { refused: string } {
    if (input.person === input.agent) return { refused: 'an assignment is to an agent of yours, not to yourself' };
    const k = key(input);
    const held = this.byKey.get(k);
    if (!held) {
      if (this.byKey.size >= this.max) return { refused: 'this bridge holds as many assignments as it can' };
      if (this.forPerson(input.person).length >= this.perPerson) return { refused: `a person may hold ${this.perPerson} assignments to their agents; withdraw one that is done` };
    }
    const assignment: OwnAgentAssignment = {
      person: input.person, agent: input.agent, courseId: input.courseId,
      ...(input.courseTitle ? { courseTitle: input.courseTitle } : {}),
      assignedAt: held?.assignedAt ?? new Date(now).toISOString(),
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      ...(input.via ? { via: input.via } : {}),
    };
    this.byKey.set(k, assignment);
    this.withdrawn.delete(k);
    this.dirty = true;
    return { assignment, created: !held };
  }

  /** Withdraw one. True when there was one to withdraw. */
  withdraw(a: { person: string; agent: string; courseId: string }): boolean {
    const k = key(a);
    if (!this.byKey.delete(k)) return false;
    this.withdrawn.add(k);
    this.dirty = true;
    return true;
  }

  forPerson(person: string): OwnAgentAssignment[] { return [...this.byKey.values()].filter(a => a.person === person); }
  /** What a person assigned to this agent. Another person's assignment to the same id is not returned. */
  forPair(person: string, agent: string): OwnAgentAssignment[] { return this.forPerson(person).filter(a => a.agent === agent); }
  get size(): number { return this.byKey.size; }

  toJSON(): Record<string, OwnAgentAssignment> { return Object.fromEntries(this.byKey); }

  /**
   * Take in a durable copy, merging with what this process holds. What this process holds wins for
   * a key both have (it is the later write), and one withdrawn here stays withdrawn. Malformed
   * entries are skipped, and an entry is filed under the key its own fields make, whatever key the
   * copy filed it under.
   */
  load(json: unknown): number {
    if (!json || typeof json !== 'object') return 0;
    let n = 0;
    for (const v of Object.values(json as Record<string, unknown>)) {
      if (!validAssignment(v)) continue;
      const k = key(v);
      if (this.withdrawn.has(k) || this.byKey.has(k)) continue;
      if (this.byKey.size >= this.max) break;
      this.byKey.set(k, { ...v });
      n++;
    }
    return n;
  }
  /** The withdrawals not yet known to be on the durable copy, as a snapshot to hand back to `committed`. */
  pendingWithdrawals(): string[] { return [...this.withdrawn]; }
  /**
   * The durable copy now holds a body made when `covered` was taken: those withdrawals need not be
   * remembered. Only those. One made while that write was in flight is not in the body that was
   * written, so forgetting it would let the next merge of the copy bring its assignment back
   * (found by Codex in review of #1005, where this cleared them all).
   */
  committed(covered: readonly string[]): void {
    for (const k of covered) if (!this.byKey.has(k)) this.withdrawn.delete(k);
  }
}
