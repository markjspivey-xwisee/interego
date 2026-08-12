/**
 * ADDRESSING AN AGENT BY TYPING ITS NAME, IN AN ORDINARY MESSAGE.
 *
 * ── WHY THIS IS NOT A DISCORD @MENTION ───────────────────────────────────────
 *
 * ★ A DISCORD MENTION IS HALF AN ADDRESS AND `ask.ts` REFUSES IT FOR A GOOD REASON. A `<@id>`
 * resolves to a Discord ACCOUNT, which this bot's index maps to ONE POD, which that pod's registry
 * maps to N delegates. There is no mention that names an agent, because an agent has no Discord
 * account. That is unchanged and this does not weaken it.
 *
 * What this adds is the thing a person actually types. "Claude Desktop, what do you think?" names
 * an agent unambiguously WHEN exactly one delegate in the channel answers to that name — and the
 * decision about whether it does is the SAME `resolveTarget` the slash command uses: exact agent
 * DID, then exact label, then a single substring match, and a refusal when two match. No second
 * matcher, because two matchers disagree the day somebody fixes one.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
 *
 * ★ IT NEVER GUESSES, AND SILENCE IS THE DEFAULT. A message whose opening does not look like a
 * name is an ordinary message and is recorded as one — unaddressed. Addressing is a permanent
 * triple in a signed record saying who a request is for; inferring one from prose that merely
 * mentions somebody would put words in a record that the person did not mean as a request.
 *
 * ★ AND THE PARSER ONLY PROPOSES. What it returns is a CANDIDATE NAME; whether any delegate in
 * the channel answers to it is decided by `resolveTarget`, against the pods that own the answer.
 * A candidate matching nobody is not an error shown to anybody — the message is simply recorded
 * unaddressed, exactly as if this had never looked. That fallback is what lets the form below be
 * usable without being dangerous: the cost of a false candidate is zero, and the cost of a missed
 * one is only that somebody uses the slash command.
 *
 * ★ SO THE FORM IS DELIBERATELY NARROW. The name must be at the START, and be followed by a comma
 * or a colon — "Claude Desktop, do X" and "Claude Desktop: do X". A name occurring anywhere else
 * is prose: "I asked Claude Desktop yesterday" is a sentence about an agent, not a request to one.
 * A leading `@` is accepted and stripped, because people type it out of habit.
 *
 * ★ AND THE BOUND IS ON THE NAME, NOT THE MESSAGE. Only the first 64 characters before the
 * separator are considered a candidate name, so a long sentence containing a comma cannot be
 * mistaken for an address to somebody with a very long name.
 */

/** The longest thing this will consider a delegate's name. Registry labels are capped near this. */
export const NAME_MAX = 64;

export interface AddressedText {
  /** The name as typed, with any leading `@` removed. Null when the message opens with no name. */
  readonly spec: string | null;
  /**
   * What remains after the name and its separator — the actual request.
   *
   * ★ THE NAME IS NOT STRIPPED FROM THE RECORD. This is what gets checked for emptiness, and the
   * FULL original text is what is written: "Claude Desktop, do X" is what the person said, and an
   * entry that recorded only "do X" would be this bot editing somebody's words on their own pod.
   */
  readonly rest: string;
}

/**
 * Does this message open by naming somebody?
 *
 * Returns the candidate name only. Whether any agent answers to it is `resolveTarget`'s question,
 * asked against the pods that own the answer — never decided here.
 */
export function addressedText(text: string): AddressedText {
  const trimmed = text.trimStart();
  // The separator must appear inside the name bound, or there is no candidate at all.
  const window = trimmed.slice(0, NAME_MAX + 1);
  const at = /[,:]/.exec(window);
  if (!at || at.index === undefined) return { spec: null, rest: text };

  let spec = trimmed.slice(0, at.index).trim();
  if (spec.startsWith('@')) spec = spec.slice(1).trim();
  const rest = trimmed.slice(at.index + 1).trim();

  // ★ EVERY REFUSAL BELOW IS A WAY FOR PROSE TO LOOK LIKE AN ADDRESS.
  if (!spec) return { spec: null, rest: text };
  // A name with no request after it is a greeting, not an ask. "Claude Desktop," on its own asks
  // for nothing, and an empty ask is refused further down the chain anyway.
  if (!rest) return { spec: null, rest: text };
  // Sentences. "Actually, I think…" and "Yes, do that" open with a word and a comma and are not
  // addresses; a real delegate label is not a single common word. Requiring either two words or a
  // capital keeps "Claude Desktop," and "Scribe:" while dropping "anyway," and "so:".
  const words = spec.split(/\s+/).filter(Boolean);
  // ★ THREE WORDS, MEASURED AGAINST WHAT A LABEL ACTUALLY IS. "Claude Desktop", "Scribe",
  // "Research assistant" — the app's own placeholder — are one to two. Six was the first bound
  // here and this file's own test caught what it let through: "I asked Claude Desktop yesterday,
  // and it said no" parsed as a request to an agent called "I asked Claude Desktop yesterday".
  // A clause long enough to be prose is prose.
  if (words.length > 3) return { spec: null, rest: text };
  const looksLikeName = words.length > 1 || /^[A-Z]/.test(spec);
  if (!looksLikeName) return { spec: null, rest: text };

  return { spec, rest };
}
