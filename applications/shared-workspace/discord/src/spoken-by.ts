/**
 * WHICH DISCORD MESSAGE WAS WHICH AGENT SPEAKING — SO A REPLY CAN REACH IT.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Discord's own gesture for "I am talking to you" is the reply, and it was the one form of
 * addressing this bot could not honour. A person watched their delegate answer in the channel,
 * hit Reply, typed a follow-up — and it was recorded as an ordinary entry addressed to nobody,
 * because a reply carries a message ID and the bot had never written down what its own posts were.
 *
 * The other two forms already worked: `/workspace ask` picks an agent from a list, and a message
 * that opens by naming one is routed by {@link addressedText}. Both make the person supply the
 * name. This supplies it from context, which is the whole point of a reply.
 *
 * ── WHAT IT DELIBERATELY IS NOT ──────────────────────────────────────────────
 *
 * ★ NOT A RECORD OF ANYTHING. This is a display-layer convenience that maps a Discord ID to an
 * agent DID, and it is not consulted for authorship, authority or provenance — all of which live
 * on the pods and are re-derived on every read. Losing this map costs a person the reply gesture
 * for older messages and costs the record nothing, which is why it is in memory and why a restart
 * is allowed to empty it.
 *
 * ★ NOT AUTHORITATIVE ABOUT WHAT MAY BE ASKED EITHER. What it yields is a candidate name, handed
 * to the same `ask()` every other path uses — which re-resolves the agent against its delegator's
 * own pod, re-checks that it may append, and refuses if not. A stale or wrong entry here produces
 * a refusal, never a write to the wrong place.
 *
 * ── WHY BOUNDED ──────────────────────────────────────────────────────────────
 *
 * ★ THE BOT RUNS FOR WEEKS AND EVERY AGENT MESSAGE ADDS AN ENTRY. Unbounded, this is a slow leak
 * whose size is set by how much the agents talk. The cap is a plain insertion-ordered eviction:
 * `Map` preserves insertion order, so the oldest key is the first one iteration yields.
 *
 * The consequence of eviction is stated rather than hidden: replying to an agent message older
 * than the last {@link SPOKEN_BY_LIMIT} falls through to being recorded as an ordinary message,
 * exactly as it did before this existed. That is the same fallback an unrecognised name gets, and
 * it is why the cap can be modest without being a trap.
 */

/**
 * How many recent agent messages stay repliable.
 *
 * Sized for a conversation rather than for history: a channel doing a hundred agent messages a day
 * keeps a fortnight of them, and the memory is a few hundred kilobytes of short strings.
 */
export const SPOKEN_BY_LIMIT = 2000;

export class SpokenBy {
  private readonly byMessage = new Map<string, string>();

  constructor(private readonly limit = SPOKEN_BY_LIMIT) {}

  /** Record that a Discord message is an agent's words. Re-recording an id updates it. */
  remember(messageId: string, agentId: string): void {
    if (!messageId || !agentId) return;
    // Delete first so a re-remembered id moves to the END of the insertion order rather than
    // keeping its original position and being evicted while it is still the newest thing said.
    this.byMessage.delete(messageId);
    this.byMessage.set(messageId, agentId);
    while (this.byMessage.size > this.limit) {
      const oldest = this.byMessage.keys().next();
      if (oldest.done) break;
      this.byMessage.delete(oldest.value);
    }
  }

  /** The agent whose words that message was, or null — including for every message it never saw. */
  agentFor(messageId: string | null): string | null {
    if (!messageId) return null;
    return this.byMessage.get(messageId) ?? null;
  }

  /** How many messages are currently repliable. For the operator line at boot and for tests. */
  get size(): number { return this.byMessage.size; }
}
