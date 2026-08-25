/**
 * TURNING A VERDICT INTO A MESSAGE. Nothing here decides anything.
 *
 * ★ AND NOTHING HERE INVENTS A FACT. Every sentence below is either a constant of this bot's
 * own behaviour or a value carried on the outcome it was handed. Where an outcome says a check
 * could not be run, the line says that — `q` is rendered as "not established", never as a
 * negative. The one temptation this file exists to resist is the summary sentence: "recorded and
 * signed by you" is two claims, and the second one is false.
 */

import { describeSpan, isPresent, presenceLine, shortRef, type Check, type EntryAuthorship } from '@interego/workspace-client';
import type { ConfirmOut, LinkChallengeOut, RecordOut, ShowOut, StartOut, UnlinkOut } from './workspace.js';
import type { AskOut, AskTarget, CandidatesOut } from './ask.js';
import { AGENT_ROLE_PREFIX, type MentionSync } from './mentions.js';
import type { WatchNews } from './watch.js';
import { displayName } from './webhook.js';

/** Discord refuses a message body over 2000 characters outright. */
export const DISCORD_LIMIT = 2000;

export interface Message { readonly content: string; readonly ephemeral: boolean }

/**
 * Join lines and clamp, saying so when it clamps.
 *
 * A silently truncated message is a report that ends mid-sentence and reads as if that were all
 * there was — which, in a bot whose entire job is to be trusted about what it did and did not do,
 * is the worst possible failure of a formatter.
 *
 * ★ THIS IS NOW THE ONE-MESSAGE PATH ONLY. Callers that can send several use {@link bodyParts},
 * which does not clip at all. This remains for the surfaces that genuinely get one message.
 */
export function body(lines: readonly string[], ephemeral: boolean): Message {
  const note = '\n… clipped: Discord refuses a message over ' + DISCORD_LIMIT + ' characters.';
  const full = lines.join('\n');
  if (full.length <= DISCORD_LIMIT) return { content: full, ephemeral };
  return { content: full.slice(0, DISCORD_LIMIT - note.length) + note, ephemeral };
}

/** Room kept on every part for the `(k/n)` marker, which is added after packing. */
const MARKER_ROOM = 24;

/**
 * The same lines, packed into as many messages as they need. Nothing is dropped.
 *
 * ★ THE SEAM IS AN ARRAY ELEMENT, NOT A LINE, AND THAT IS THE WHOLE DESIGN.
 *
 * The obvious splitter cuts at the last newline that fits. Measured against real `renderShow`
 * output, that severs an entry's ATTRIBUTION from its TEXT: part 2 ends "…speaking **for itself**
 * here — its own position, which the pod owner is NOT answerable for" and part 3 begins with the
 * body, as a standalone Discord message with no author beside it. A line boundary cannot corrupt
 * a markdown span, which is what makes it look safe — but this file exists to stop "a delegate
 * wrote this, on its own account" turning into "they said this", and an orphaned body in its own
 * message is exactly that. It is strictly worse than the mid-sentence clip it replaces.
 *
 * The callers already hand over the right seams: `renderShow` pushes each entry's header AND body
 * as ONE element. So this packs whole elements and never looks inside one. A heuristic over
 * leading whitespace was tried and is inert here anyway — an entry's header begins with two
 * spaces and its body with four, so both look like continuations.
 *
 * ★ AN ELEMENT LONGER THAN A WHOLE MESSAGE IS THE ONLY INNER CUT, and it is marked. One
 * 2000-character entry body cannot be delivered whole; it is split with "(continued)" so a reader
 * can see the seam rather than infer one.
 */
export function bodyParts(lines: readonly string[], ephemeral: boolean): readonly Message[] {
  const room = DISCORD_LIMIT - MARKER_ROOM;
  /** Elements, with any single over-long one already cut down to deliverable pieces. */
  const units: string[] = [];
  for (const line of lines) {
    if (line.length <= room) { units.push(line); continue; }
    const cont = ' (continued)';
    let rest = line;
    while (rest.length > room) {
      units.push(rest.slice(0, room - cont.length) + cont);
      rest = rest.slice(room - cont.length);
    }
    units.push(rest);
  }
  const parts: string[] = [];
  let cur = '';
  for (const u of units) {
    const next = cur ? cur + '\n' + u : u;
    if (next.length > room && cur) { parts.push(cur); cur = u; continue; }
    cur = next;
  }
  if (cur || !parts.length) parts.push(cur);
  // ★ EVERY PART SAYS WHICH PART IT IS, so a followup that never arrives is visible to the READER
  // and not only to an operator reading the log. A single message gets no marker — a "(1/1)" on
  // every reply would be noise, and there is nothing there for a reader to miss.
  if (parts.length === 1) return [{ content: parts[0] as string, ephemeral }];
  return parts.map((content, i) => ({ content: '`(' + (i + 1) + '/' + parts.length + ')`\n' + content, ephemeral }));
}

const MARK: Record<Check['mark'], string> = { y: '✓', n: '✗', q: '?' };
const checkLines = (checks: readonly Check[]): string[] => checks.map((c) => '  ' + MARK[c.mark] + ' ' + c.text);

/** Discord renders `<https://…>` without an embed card, which is what an IRI wants. */
const iri = (u: string): string => '<' + u + '>';

/**
 * WHO WROTE AN ENTRY, in one bracketed clause.
 *
 * ★ FIVE ANSWERS AND NONE OF THEM IS THE POD. A reader of this channel is being told whose words
 * these are, and the pod only says whose log they are in. `null` here is "this reader did not get
 * as far as asking", which is its own answer and must not read as either of the real ones.
 *
 * ★ AND THE AUTHORISATION IS A THIRD STATE, NOT A BOOLEAN. A delegate whose delegator's pod could
 * not be read is not an unauthorised delegate; saying so would accuse somebody's agent on the
 * strength of a failed HTTP call.
 *
 * ★ AND THE FOOTING IS A SECOND, INDEPENDENT CLAUSE — not a shade of the first. "Is this agent
 * their delegate" is standing and comes off their pod; "was THIS message said on their behalf"
 * comes off the entry and is different for every entry. Reading this channel is the main way a
 * person other than the pod owner encounters these records, so a rendering that ran the two
 * together would be the place the distinction actually gets lost. Bolded when the answer is "for
 * itself", because that is the one a skimming reader would otherwise assume the other way.
 *
 * ★ AND "A DELEGATE WROTE THIS" IS NOW A CONJUNCTION OF TWO DOCUMENTS. The entry names its author;
 * the relay's authorship block names the key it verified over those bytes. Every PROV triple here
 * is written by whoever can publish to that pod — which includes THIS BOT, on the maintainer's —
 * so an entry naming an agent it was not signed by comes through as `disputed` and is never drawn
 * as that agent speaking. What that costs is that `principal` now says which key carried the
 * words, because "the pod owner said this" and "a key they authorised put words attributed to
 * them on their pod" are the same bytes to a reader who is not shown the difference.
 */
export function authorOf(a: EntryAuthorship | null): string {
  if (a === null) return '[author not read]';
  switch (a.kind) {
    // ★ THE CARRIER IS NAMED WHEN IT IS NOT THE PERSON. "The pod owner said this" and "a key they
    // authorised put words attributed to them on their pod" are the same bytes to a reader who is
    // not shown the difference — and this bot is exactly such a key, on every message it relays.
    case 'principal': return a.signer.kind === 'a-conduit'
      ? '[written by the pod owner, relayed onto their pod by `' + a.signer.signedBy + '`'
        + (a.signer.listed === true ? ', a key their own registry lists' + (a.signer.scope ? ' with scope ' + a.signer.scope : '')
          : a.signer.listed === false ? ' — **their registry does not list that key**, so the only thing establishing it may write there is that the relay accepted the write'
            : ', whose standing was not checked here') + ']'
      // ★ AND "NOT ESTABLISHED" IS ITS OWN LINE. Left folded into the plain case, an entry whose
      // signature nothing verified read exactly like one the person's own key signed — and a
      // conduit can publish attributed to its delegator without signing, which is the same words
      // with nothing behind them.
      : a.signer.kind === 'not-established'
        ? '[written by the pod owner **as far as the entry says** — no verified signature reached this reader, so which key carried it is not established]'
        : '[written by the pod owner]';
    case 'unstated': return '[**author not stated** — this entry names nobody, which is not the same as the pod owner having written it]';
    case 'disputed': return '[**authorship disputed** — ' + a.why + ']';
    case 'delegate': return '[written by **' + (a.name ?? 'an unnamed delegate') + '**, whose own key signed these bytes, a delegate of the pod owner, '
      + (a.footing.kind === 'on-behalf-of' ? 'speaking **for them** here — they share responsibility for it'
        : a.footing.kind === 'own-account' ? 'speaking **for itself** here — its own position, which the pod owner is NOT answerable for'
          : '**footing not stated** — this entry does not say whether it was written for them or on its own account, and neither reading is being assumed')
      + (a.authorised === true ? '; separately, that pod\'s own registry authorises it' + (a.scope ? ' with scope ' + a.scope : '')
        : a.authorised === false ? '; and **that pod\'s registry does NOT list this agent**, so it is not a delegate of theirs by any record they have published'
          : '; that pod\'s registry was not read here, so whether it is their delegate at all is not established')
      + ']';
  }
}

/**
 * The same three claims `authorOf` makes about a delegate, as a footer under its own name.
 *
 * ★ NOTHING IS TRADED AWAY FOR THE NICER FRAME. Posting a delegate's words under its own display
 * name reads as presence, and the temptation is to let the name carry the meaning and drop the
 * rest. It cannot: Discord does not verify a webhook name, so the name is the one part of the
 * message that establishes nothing. These three do, and they are exactly the three that can
 * disagree — whose KEY signed the bytes, what FOOTING this message was on, and whether the
 * delegator's pod authorises the agent at all.
 *
 * `-#` is Discord's subtext: small, quiet, and present on every message rather than promoted to a
 * banner nobody reads twice.
 */
/**
 * Detail that belongs in the channel but not in the reader's way.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Every message this bot posts carried its full provenance and a paragraph explaining the model
 * behind it. Each line was true and each was put there for a reason — but a person reading a
 * conversation met four lines of substrate vocabulary for every sentence anybody said, and asked
 * for it to stop. "None of this should be displayed, but it should be available on request."
 *
 * ★ A SPOILER IS EXACTLY THAT, AND IT IS DISCORD'S OWN AFFORDANCE. `||…||` hides the text behind
 * one click. Nothing is dropped, nothing is summarised, nothing has to be fetched again by another
 * command — the claim still travels with the message it is about, which is the property the whole
 * provenance apparatus exists to have. It is out of the way rather than gone.
 *
 * ★ AND THE ALARMING CASE IS NEVER HIDDEN. What made the old output noisy was the GOOD news:
 * "signed, authorised, footing stated" on every single message. An agent its delegator does NOT
 * authorise, or one whose footing is unstated, is a finding — and a finding behind a click is a
 * finding nobody reads. So `quiet` takes only what is reassuring; anything a reader should act on
 * stays in plain text. See `agentFooter`.
 */
export function quiet(parts: readonly string[]): string {
  const text = parts.filter((p) => p.trim() !== '').join(' · ');
  // Discord renders `||` inside the hidden run as a terminator, so a part carrying one would end
  // the spoiler early and spill the rest into the message.
  return text ? '||' + text.replace(/\|\|/g, '|') + '||' : '';
}

export function agentFooter(a: Extract<EntryAuthorship, { kind: 'delegate' }>, pod: string): string {
  const footingOk = a.footing.kind === 'on-behalf-of' || a.footing.kind === 'own-account';
  const footing = a.footing.kind === 'on-behalf-of' ? 'speaking **for** the pod owner — they share responsibility'
    : a.footing.kind === 'own-account' ? 'speaking **for itself** — the pod owner is NOT answerable for it'
      : '**footing not stated** — neither reading is being assumed';
  const standing = a.authorised === true ? 'authorised by `' + pod + '`' + (a.scope ? ' (' + a.scope + ')' : '')
    : a.authorised === false ? '**`' + pod + '`\'s registry does NOT list it**'
      : 'standing not checked here';

  /**
   * ★★ THE GOOD NEWS IS NOT SHOWN AT ALL; A FINDING IS SHOWN IN FULL.
   *
   * Every message used to carry all three claims in plain text, and the reason it read as noise is
   * that they were almost always the SAME three claims: signed, authorised, footing stated. The
   * first attempt at "available on request" put them behind a `||spoiler||` — and REPORTED BY THE
   * PERSON READING THE CHANNEL, twice: a spoiler is still displayed. It renders as three fat grey
   * blocks under every single message, which is arguably louder than the small grey text it
   * replaced. "Hidden behind a click" and "not displayed" are different things, and the ask was
   * the second one.
   *
   * So when there is nothing to act on, the footer is EMPTY. Nothing is lost: the authorship is a
   * property of the entry on the pod, which is where it is authoritative — this line was only ever
   * a rendering of it — and the desktop client shows it per message. A reader who wants to know
   * can ask the agent, which can read its own record.
   *
   * ★ AND A FINDING STILL PRINTS, IN PLAIN TEXT. An agent its delegator does not authorise, or one
   * that stated no footing, is a thing a reader must act on. That is the case this footer exists
   * for, and it was the case being drowned out by the reassurance around it.
   */
  const reassuring = a.authorised === true && footingOk;
  if (reassuring) return '';
  const detail = [footing, standing, 'this display name is chosen by the bot and is not something Discord can verify'];
  return '-# ⎔ its own key signed these bytes · ' + detail.join(' · ');
}

/**
 * One thing to post: either from the bot, or under an agent's own name.
 *
 * ★ THE DISCRIMINANT EXISTS SO THE CHOICE IS MADE ONCE, HERE, where the authorship is in hand —
 * rather than in the sender, which would have to re-derive it and could get it wrong differently.
 */
export type NewsPost =
  | { readonly kind: 'bot'; readonly message: Message }
  | {
      readonly kind: 'agent';
      readonly who: string;
      readonly content: string;
      /**
       * WHICH agent, as its DID — not the display name beside it.
       *
       * ★ CARRIED SO A REPLY CAN REACH IT. `who` is a label from somebody's registry and is not an
       * identifier; two pods may legitimately publish the same one. When the sender learns what
       * Discord message this became, this is what it remembers against that id, so replying to the
       * message addresses the agent that actually wrote it.
       *
       * Available for free at this point and nowhere later: the `delegate` variant of
       * `EntryAuthorship` types its signer as `the-author`, so reaching this branch is already the
       * proof that this agent's own key signed those bytes.
       */
      readonly agentId: string;
    };

export function renderChallenge(out: LinkChallengeOut): Message {
  return body([
    out.existing
      ? '**Re-linking.** You are currently bound to pod `' + out.existing.pod + '`. Finishing this replaces that binding.'
      : '**Linking your pod.**',
    '',
    'Nothing has happened yet and nothing of yours has been touched. To let this bot write your messages onto your own pod, publish a delegation **from your own Interego client** — the desktop app, the published workspace page, or an MCP connector. Call `register_agent` with exactly:',
    '```',
    'agent_id: ' + out.agentId,
    'scope:    PublishOnly',
    'label:    ' + out.label,
    '```',
    'Leave `pod_name` off — the relay only lets you register agents on your **own** pod, which is what makes this proof worth anything.',
    '',
    'Then run `/workspace link-confirm pod:<your pod>` here, within ten minutes.',
    '',
    '**That label is not a password.** Delegation rows are world-readable, so a secret published in one would not stay secret for a second. What the label says is *who the delegation is for* — your Discord id, which is public and useless to anybody else, because this bot computes the label it looks for from the account actually running the confirm. Somebody else publishing it on their pod binds their pod to you, not you to them.',
    '',
    '**What you are granting.** `PublishOnly` is pod-wide: the substrate has no per-graph delegation scope, so this bot could publish any graph to your pod, not only workspace entries. What bounds it is that it is one named agent, every write it makes is content-bound and attributed to it, and you can withdraw it at any moment with `revoke_agent` from your own client — which works whether or not this bot cooperates.',
  ], true);
}

export function renderConfirm(out: ConfirmOut): Message {
  switch (out.kind) {
    case 'no-challenge': return body(['**Not linked.** ' + out.why], true);
    case 'bad-pod': return body(['**Not linked.** ' + out.why], true);
    case 'contested': return body(['**Not linked.** ' + out.why], true);
    case 'error': return body(['**Not linked.** The check did not complete: ' + ((out.error as Error)?.message ?? String(out.error)) + '. Nothing was written and nothing is claimed about your pod.'], true);
    case 'refused': return body([
      '**Not linked.** ' + out.why,
      ...checkLines(out.checks),
      '',
      out.attemptsLeft > 0
        ? 'That code has ' + out.attemptsLeft + ' tr' + (out.attemptsLeft === 1 ? 'y' : 'ies') + ' left. If you have not published the delegation yet, do that and run this again.'
        : 'That code is spent. Run `/workspace link` for a new one.',
    ], true);
    case 'linked': return body([
      '**Linked.** Your messages in a started thread will be appended to a log on pod `' + out.link.pod + '`.',
      ...checkLines(out.checks),
      '',
      'That pod\'s registry names you as `' + out.link.webId + '`.',
      'To stop it: `revoke_agent` from your own client withdraws the delegation at the substrate; `/workspace unlink` only makes this bot forget the binding.',
    ], true);
  }
}

export function renderUnlink(out: UnlinkOut): Message {
  if (out.kind === 'was-not-linked') return body(['You were not linked here, so nothing changed.'], true);
  return body([
    '**Forgotten.** This bot will not write anything more to pod `' + (out.had?.pod ?? '?') + '` for you.',
    '',
    '★ This did **not** revoke anything. The delegation you published is still on your pod, and it still authorises `' + out.agentId + '`. To actually withdraw it, call `revoke_agent` with that `agent_id` from your own client. This bot cannot do that for you and should not be trusted to have done it.',
    '',
    'Everything already recorded stays where it is: it is on your pod, and nothing here can reach it.',
  ], true);
}

export function renderStart(out: StartOut): Message {
  switch (out.kind) {
    case 'not-linked': return body(['**Nothing was created.** Run `/workspace link` first — a workspace is created on the convener\'s own pod, and this bot does not have one to put it on for you.'], true);
    case 'bad-thread': return body(['**Nothing was created.** ' + out.why], true);
    case 'already': return body([
      'This thread is already a workspace, convened on pod `' + out.binding.convenerPod + '` since ' + out.binding.startedAt + '.',
      iri(out.binding.workspace),
    ], false);
    case 'not-delegated': return body(['**Nothing was created.** ' + out.why, ...checkLines(out.checks)], true);
    case 'error': return body(['**Nothing was created.** ' + ((out.error as Error)?.message ?? String(out.error))], true);
    case 'create-failed': return body([
      '**The workspace was not fully created.** ' + out.detail,
      out.done.length ? 'Written before it stopped: ' + out.done.join(', ') + '. Those documents are on your pod and are real; the workspace is not usable until the rest of them are.' : 'Nothing was written.',
    ], false);
    case 'created': return body([
      '**This thread is now a record.** Convened by pod `' + out.binding.convenerPod + '`, titled "' + out.binding.title + '".',
      iri(out.binding.workspace),
      '',
      out.seated
        ? 'Your own seat is published and readable. Your messages here will be appended to ' + iri(out.streamIri) + ' — on your pod, not this bot\'s.'
        : 'Your grant is published; your acceptance was accepted and is not yet reported readable' + (out.why ? ' (' + out.why + ')' : '') + '. Until it reads back you will show as invited rather than seated.',
      '',
      'Anyone else in this thread who wants their messages recorded runs `/workspace link`. Everybody else can talk freely — nothing they say is written anywhere.',
      /**
       * ★★ AND WHAT A PRIVATE WORKSPACE STARTED FROM HERE CAN NEVER BE. `createWorkspace` records
       * the convener's own encryption key in their founding acceptance and this bot has none to
       * record, which withholds the whole key list for the life of the workspace — so the moment
       * this thread is created is the moment that is decided, and the only moment anybody would
       * think to read a notice about it. `startWorkspace` composes the sentence; see `SealingNote`.
       */
      ...(out.sealing ? ['', '⚠ ' + out.sealing.why] : []),
    ], false);
  }
}

/**
 * What the record now holds about the files somebody posted, or null when it holds nothing.
 *
 * ── ★★ "ON THE RECORD" WAS SAID BEFORE ANYTHING CHECKED THAT IT WAS ─────────
 *
 * This lived in `main.ts` behind `res.kind === 'recorded'`, and that is not the test it reads
 * like. `recorded` means `recordMessage` got as far as ATTEMPTING the append — every one of
 * `read-failed`, `forked`, `refused` and `unreachable` arrives under it, and `renderRecord`
 * prints all four as **Not recorded.**
 *
 * So posting a picture into a forked log produced, in that order and in front of the whole
 * thread: "**The attachment is on the record as a file** — plan.png — …" and then "**Not
 * recorded.** Your log has 2 unresolved heads". The false one came first, and it was deliberately
 * NOT ephemeral, so everyone read it.
 *
 * It is here rather than there because this is the file that already knows what an outcome means,
 * and because a claim about the record is exactly the kind of sentence that should be pinned by a
 * test rather than assembled beside a `say`.
 *
 * ★ THE NAMES STILL COME FROM THE MESSAGE, and that is right: `entryTurtle` writes one
 * `wsp:Attachment` per attachment with no cap and no filter, so the list posted IS the list
 * written. What was wrong was never the names — it was the claim that anything was written.
 */
export function renderAttachmentNote(
  out: RecordOut, attachments: readonly { readonly name: string }[],
): Message | null {
  if (!attachments.length) return null;
  if (out.kind !== 'recorded' || out.outcome.kind !== 'accepted') return null;
  const one = attachments.length === 1;
  const names = attachments.slice(0, 5).map((a) => a.name).join(', ')
    + (attachments.length > 5 ? ' and ' + (attachments.length - 5) + ' more' : '');
  return body([
    '**' + (one ? 'The attachment is' : 'The attachments are') + ' on the record as '
    + (one ? 'a file' : 'files') + '** — ' + names + ' — with '
    + (one ? 'its name, type and size' : 'their names, types and sizes')
    + '. **The bytes are not.** They stay in Discord, and Discord\'s links expire, so an agent '
    + 'reading this channel learns what you posted and cannot be promised it can still fetch it.',
    // Not ephemeral: a note about what the record does and does not hold is for everyone reading
    // the thread, not only the person who posted.
  ], false);
}

/** The one-line report the bot posts after recording. Deliberately dull and deliberately exact. */
export function renderRecord(out: RecordOut): Message | null {
  switch (out.kind) {
    // Not this bot's channel and not its business.
    case 'not-a-workspace': case 'empty': return null;
    case 'unlinked': return body([
      '<@' + out.discordUserId + '> — **not recorded.** You are not linked, so this bot has no pod of yours to write to and will not invent one. Run `/workspace link` if you want your messages in the record. Nothing you have said here has been written anywhere.',
    ], false);
    case 'not-delegated': return body([
      '**Not recorded.** ' + out.why,
      ...checkLines(out.checks),
    ], false);
    case 'unseated': return body(['**Not recorded.** ' + out.why, ...checkLines(out.seating)], false);
    case 'error': return body(['**Not recorded.** ' + ((out.error as Error)?.message ?? String(out.error))], false);
    case 'recorded': {
      const o = out.outcome;
      if (o.kind === 'read-failed') return body(['**Not recorded.** Your log could not be read, so no position for a new entry was derived: ' + ((o.error as Error)?.message ?? String(o.error))], false);
      if (o.kind === 'forked') return body(['**Not recorded.** Your log has ' + o.heads + ' unresolved heads' + (o.anyLinks ? '' : ' and none of its entries link to another') + ', so where the next entry goes is not decided. Picking one would be guessing which append survived.'], false);
      if (o.kind === 'refused') return body(['**Not recorded.** The relay refused the append (' + (o.code ?? 'no code') + '): ' + JSON.stringify(o.body).slice(0, 300)], false);
      if (o.kind === 'unreachable') return body([o.relayAnswered
        ? '**The relay reported a failure** on the append: ' + ((o.error as Error)?.message ?? String(o.error))
        : '**The relay did not answer.** Whether this landed is unknown, so it is not being retried — a repeat could write your message twice.'], false);
      const lines = [
        'Recorded · entry #' + o.seq + ' on pod `' + out.pod + '`' + (out.seated === 'just-now' ? ' · seated just now' : ''),
        o.descriptorUrl ? '' : 'The relay named no descriptor URL for it.',
        o.shapeSent ? 'Validated against ' + shortRef(o.shapeSent) : 'Nothing validated this entry: ' + '(the workspace names no wsp:entryShape)',
        o.ifMatch ? 'Appended after ' + shortRef(o.ifMatch) + (o.ifMatchKind ? ' — ' + o.ifMatchKind : '') : 'First entry in this log, so no prior revision was asserted',
        // ★ ATTRIBUTED TO THE PERSON, AND SAID OUT LOUD BECAUSE A BOT WROTE IT. This bot carried
        // words its author typed; it did not compose them, so the entry names THEM. An entry an
        // agent composed names the agent instead — see `delegates.ts`. Stating which of the two
        // this is, on the notice that reports the write, is how a reader learns the difference
        // exists before they ever meet the other case.
        'Attributed to you: the entry carries `prov:wasAttributedTo <your WebID>`. This bot relayed what you typed — it did not write it, and nothing here claims it did.',
      ].filter(Boolean);
      /**
       * ★★ WHO WILL NEVER BE ABLE TO READ THIS, SAID IN THE CHANNEL WHERE IT WAS TYPED.
       *
       * `resolveRecipient` returns an EMPTY key list rather than erroring when a handle does not
       * resolve or a member's pod registers no key — one 502 from the identity server on a cold
       * start is enough. The publish succeeds, `agentCount` is 0 for that member, and the entry is
       * encrypted to fewer people than it named. `postEntry` has reported this since it existed
       * and this renderer read everything on the outcome EXCEPT that: the desktop turned amber and
       * named the member, Discord said "Recorded" with no caveat.
       *
       * It cannot be undone — an envelope's recipients are fixed when it is written — so saying it
       * now, in time for the next message to wait, is the only move left.
       */
      if (o.unreached.length > 0) {
        lines.push('');
        lines.push('⚠ Encrypted, and ' + o.unreached.length + ' member' + (o.unreached.length === 1 ? '' : 's')
          + ' could not be reached with a key: ' + o.unreached.join(', ')
          + '. They will see this entry exists and will not be able to open it, and that cannot be changed '
          + 'afterwards. They need to sign in once with their own key.');
      }
      /**
       * ★★ WHAT SEATING THEM ESTABLISHED, ON THE PATH WHERE IT SUCCEEDED.
       *
       * These were printed for a seating that FAILED and dropped for one that worked, and the
       * finding that only exists on the success path is the one that matters most: the re-seal of
       * the workspace record retired the revision an existing member could read. Empty unless
       * somebody was seated by this very message, so an ordinary line prints nothing extra.
       */
      if (out.seating.length > 0) {
        lines.push('');
        lines.push(...checkLines(out.seating));
      }
      /**
       * ★★ WHETHER THE RELAY CAN READ THIS, SAID IN THE CHANNEL WHERE IT WAS TYPED.
       *
       * A private workspace's whole claim is that the relay is not a recipient, and a Discord user
       * has no other surface on which to learn that here it is one. `recordMessage` decides it —
       * see `SealingNote` — and deliberately NOT from `Sealing.mode`: this bot passes no sealer to
       * `postEntry` and holds no key material to pass, so a private write from Discord takes the
       * relay path even when the module says a sealing client would have sealed end to end.
       *
       * Null for a public workspace, where nothing is encrypted and nothing claims to be.
       */
      if (out.sealing) {
        lines.push('');
        lines.push('⚠ ' + out.sealing.why);
      }
      if (out.authorship) {
        lines.push('');
        for (const p of out.authorship.proves) lines.push('✓ ' + p);
        for (const d of out.authorship.doesNotProve) lines.push('? ' + d);
      }
      return body(lines, false);
    }
  }
}

export function renderShow(out: ShowOut): readonly Message[] {
  switch (out.kind) {
    case 'not-a-workspace': return [body(['This thread is not a workspace. `/workspace start` makes it one.'], true)];
    case 'unreadable': return [body(['The workspace at ' + iri(out.binding.workspace) + ' could not be read: ' + out.why], false)];
    case 'error': return [body(['The workspace could not be read: ' + ((out.error as Error)?.message ?? String(out.error))], false)];
    case 'view': {
      const lines: string[] = [
        '**' + (out.record.title || out.binding.slug) + '**',
        iri(out.binding.workspace) + ' — anyone can follow that, with or without this bot and with or without Discord.',
        '',
        '**Roster** — grants read from pod `' + out.fold.grantPod + '`'
          + (out.fold.grantPodDerivedFrom ? ' (named by ' + out.fold.grantPodDerivedFrom + ')' : ' (the pod in the workspace IRI; the record names no convener)'),
      ];
      if (!out.fold.seats.length) lines.push('  no grants for this workspace were found on that pod');
      for (const s of out.fold.seats) {
        lines.push('  ' + (s.seated ? '✓' : '·') + ' `' + (s.podServed ?? s.pod ?? 'unresolved') + '`'
          + (s.seated ? ' — seated' : ' — not seated: ' + (s.why ?? 'no reason recorded')));
      }
      // The "came back full at 400 descriptors" line is gone with the cap that caused it — this
      // scan asks for the pod's whole index now. What remains is the READ bound, which is real.
      if (out.fold.grantsFound > out.fold.grantsRead) lines.push('  ? ' + out.fold.grantsFound + ' grants found, ' + out.fold.grantsRead + ' read (cap ' + out.fold.grantReadCap + ')');

      for (const st of out.streams) if (st.why) lines.push('  ? `' + st.pod + '`: ' + st.why);

      /**
       * ★ THE EXPLAINER GOES BEFORE THE ENTRIES, WHICH IS THE ONLY REASON IT SURVIVES.
       *
       * It used to close the message. That put the qualifications LAST, so any bound on delivery
       * — the old 2000-character clip, and equally a part that fails to send — dropped the
       * caveats and kept the claims. That is the precise inversion this whole file exists to
       * prevent: "written by X, speaking for them" is only safe to print beside an explanation of
       * what was and was not checked.
       *
       * The entries are the part a reader can recover elsewhere — the workspace IRI printed above
       * dereferences to all of them, with or without this bot. The explanation exists nowhere
       * else. So the recoverable thing is what goes at the end.
       */
      lines.push('',
        'Order inside one pod\'s log is the supersession chain those entries declare, which nothing outside that pod can rewrite. Order **between** pods is each entry\'s own `dct:created` — a clock its author\'s client set. The substrate establishes no happens-before across pods, so the interleaving below is a presentation, not a finding.',
        '',
        '★ The pod is whose LOG an entry is in. **Who wrote it** is the name beside it, read from the entry\'s own `prov:wasAttributedTo` **and held against the key the relay authenticated over those bytes**. An entry naming an agent it was not signed by is reported as disputed and is never drawn as that agent speaking — every PROV triple in an entry is written by whoever can publish to that pod, so the signature is the only part of this a pod owner cannot compose.',
        '★ Where that names a delegate, THREE separate things are reported and they can disagree. (1) Is it that person\'s delegate at all — asked of their own pod\'s delegation registry, a document only they can write, and standing until they revoke it. (2) What footing THIS entry was on — read from the entry itself, as a `prov:Delegation` over the act that produced it or an `iep:actedOnOwnAccount` declaring the opposite. An agent can be a properly authorised delegate and still be speaking entirely for itself in any given message. (3) Neither, when the entry does not say — which is reported as not saying, and is not read as either.');

      lines.push('', '**Entries** — ' + out.totalEntries + ' in ' + out.streams.length + ' log' + (out.streams.length === 1 ? '' : 's')
        + (out.truncated ? ', newest ' + out.entries.length + ' shown' : ''));
      if (!out.entries.length) lines.push('  none read');
      for (const e of out.entries) {
        // ★ ONE ELEMENT PER ENTRY, header and body together. `bodyParts` splits between elements
        // and never inside one, so this is what guarantees an attribution is never delivered in a
        // different message from the words it attributes.
        lines.push(e.why
          ? '  ? `' + e.pod + '` — ' + e.why
          : '  `' + e.pod + '` ' + authorOf(e.author) + ' #' + (e.seq ?? '?') + ' · ' + (e.created ?? 'no declared time') + '\n    ' + (e.body ?? '(this entry names no dct:description)'));
      }
      return bodyParts(lines, false);
    }
  }
}

// ── agents in the channel ────────────────────────────────────────────────────

/**
 * One agent, as its own pod and its delegator's pod describe it between them.
 *
 * ★ TWO PODS' WORTH OF FACTS AND THE LINE KEEPS THEM APART. The NAME and the SCOPE come from the
 * delegator's registry — a document only they can write. The PRESENCE comes from the agent's OWN
 * pod, signed by its own key. Running them together into "scheduler is online" would be one
 * sentence asserting two things read from two places, either of which can be absent on its own.
 */
const agentLine = (t: AskTarget, nowMs: number): string =>
  '  ' + (isPresent(t.presence) ? '●' : '○') + ' **' + (t.name ?? t.agentId) + '** · '
  + (t.isYou ? 'yours' : '`' + t.pod + '`') + ' · ' + presenceLine(t.presence, nowMs)
  + (t.writeEligible ? '' : ' · scope ' + (t.scope ?? 'not reported') + ', **cannot append** — only its delegator can change that');

/**
 * Who could be asked something here.
 *
 * ★ THE EMPTY ANSWERS ARE DIFFERENT FACTS AND EACH GETS ITS OWN SENTENCE. "Nobody has authorised an
 * agent", "that pod did not answer" and "this thread is not a workspace" would otherwise all render
 * as an empty list — and the middle one is a failed HTTP call being drawn as a fact about somebody
 * else's pod.
 */
export function renderWho(out: CandidatesOut, nowMs = Date.now()): readonly Message[] {
  switch (out.kind) {
    case 'not-a-workspace': return [body(['This thread is not a workspace. `/workspace start` makes it one.'], true)];
    case 'unreadable': return [body(['**The roster could not be read**, so who could be asked something here is not established: ' + out.why], true)];
    case 'error': return [body(['**The roster could not be read**, so who could be asked something here is not established: ' + ((out.error as Error)?.message ?? String(out.error))], true)];
    case 'candidates': {
      const lines: string[] = ['**Agents in ' + out.binding.title + '**'];
      if (out.targets.length) for (const t of out.targets) lines.push(agentLine(t, nowMs));
      else lines.push('  Nobody seated here has authorised an agent. A person authorises one from their own client with `register_agent`; this bot cannot do it for them and cannot see one that does not exist.');
      for (const u of out.unread) {
        lines.push('  ? `' + u.pod + '` did not answer, so what it can be asked is **not established** — which is not the same as it having no agents (' + u.why + ')');
      }
      for (const p of out.noneOn) lines.push('  · `' + p + '` answered and its registry lists no agent');
      lines.push('',
        '● means that agent published a short lease saying its host was running, signed with its own key, and the lease is live by **its own signed expiry**. ○ means anything else, and the line says which: a lapsed lease, no lease on a pod that answered, a lease too long to be evidence, a signed expiry that disagrees with the relay\'s own row, a pod that would not answer, or an agent id this client cannot compose an address from — in which case no pod was asked and nothing was established either way.',
        'Presence is read from **the agent\'s own pod**; whether its human authorises it is read from **theirs**. Two documents, and they can disagree.',
        '`/workspace ask` puts the ask on the record either way. A host that is not running answers when it next runs.');
      return bodyParts(lines, true);
    }
  }
}

/** The picker's own words for a target, reused so an acknowledgement cannot contradict the list. */
const targetLine = (t: AskTarget, nowMs: number): string =>
  (t.name ?? t.agentId) + ' on `' + t.pod + '` · ' + presenceLine(t.presence, nowMs);

/**
 * What an ask did, and — the part that matters — what it did not.
 *
 * ★ EVERY BRANCH BELOW SAYS WHETHER ANYTHING WAS WRITTEN. An ask is a permanent record on somebody
 * else's pod and a notice into somebody else's inbox; a reader who cannot tell from the reply which
 * of those happened has to go and look, which is the state this bot exists to remove.
 */
/**
 * What `/workspace mentions` did to the server.
 *
 * ★ IT SAYS WHAT THE ROLE IS NOT. Somebody watching new roles appear in their server is owed the
 * fact that these grant nothing and contain nobody — the reasonable reading of "the bot made some
 * roles" is otherwise that it gave something permissions.
 */
export function renderMentions(out: MentionSync): Message {
  switch (out.kind) {
    case 'no-permission':
      return body(['**No mentionable names were created.** ' + out.why], true);
    case 'error':
      return body(['**No mentionable names were created.** ' + ((out.error as Error)?.message ?? String(out.error))], true);
    case 'synced': {
      if (!out.created.length && !out.already.length) {
        return body(['**Nothing to do.** No agent here has a name to mention.'], true);
      }
      const named = (n: string): string => '`@' + AGENT_ROLE_PREFIX + n + '`';
      return body([
        out.created.length
          ? '**' + out.created.length + ' agent' + (out.created.length === 1 ? ' is' : 's are')
            + ' now @mentionable:** ' + out.created.map(named).join(', ')
          : '**Already set up.**',
        ...(out.already.length ? ['Already had a name: ' + out.already.map(named).join(', ')] : []),
        '',
        'Type `@' + AGENT_ROLE_PREFIX + '` and Discord will offer them. Mentioning one asks it, exactly as `/workspace ask` does.',
        '',
        '★ These roles grant **nothing** and contain **nobody** — pinging one notifies no human. They exist only '
        + 'so Discord has a name to resolve. What an agent may do is what its delegator authorises on their own '
        + 'pod, which no Discord object can add to or take away.',
        '★ A role left behind after a delegation is revoked resolves to no agent and the ask is refused. The name '
        + 'outliving the authority costs nothing, because the name never carried any.',
      ], false);
    }
  }
}

export function renderAsk(out: AskOut, nowMs = Date.now()): Message {
  switch (out.kind) {
    case 'not-a-workspace': return body(['**Nothing was asked.** This thread is not a workspace. `/workspace start` makes it one.'], true);
    case 'not-linked': return body(['**Nothing was asked.** You are not linked, so this bot has no pod of yours to write the ask onto and will not invent one. Run `/workspace link`.'], true);
    case 'empty-task': return body(['**Nothing was asked.** The task was empty. What you type is what goes in the record, in your own words — there is nothing here for this bot to fill in.'], true);
    case 'unreadable': return body(['**Nothing was asked.** ' + out.why], true);
    case 'error': return body(['**Nothing was asked.** ' + ((out.error as Error)?.message ?? String(out.error)), 'Nothing above this is a statement about anybody\'s pod.'], true);
    case 'no-match': return body([
      '**Nothing was asked.** No agent here matches `' + out.spec + '`.',
      ...(out.known.length
        ? ['', 'Seated pods currently name:', ...out.known.map((k) => '  · ' + k)]
        : ['', 'No agent is authorised by anybody seated here. `/workspace who` says which pods answered and which did not.']),
    ], true);
    case 'ambiguous': return body([
      '**Nothing was asked.** `' + out.spec + '` matches ' + out.matches.length + ' agents, and guessing which you meant is how work lands on the wrong pod.',
      ...out.matches.map((t) => '  · ' + targetLine(t, nowMs)),
      '',
      'Pick one from the list — its value is the full agent DID, which is unambiguous by construction.',
    ], true);
    case 'target-cannot-append': return body([
      '**Nothing was asked.** ' + (out.target.name ?? out.target.agentId) + ' has scope `' + (out.target.scope ?? 'not reported') + '` on `' + out.target.pod + '`, so it could read this channel and could **not** append an answer to it.',
      '',
      'The ask would sit on the record forever with no possible reply, and only its delegator can change that — `register_agent` from their own client, with a scope that permits publishing. Saying so now is more use than a permanent unanswerable entry.',
    ], true);
    case 'not-written': return body([
      '**Nothing was asked, and nothing was sent.** The write refused first, so there is no notice pointing at an entry that does not exist.',
      '',
      renderRecord(out.record)?.content ?? 'The write refused and reported no detail.',
    ], false);
    case 'asked': return body([
      /**
       * ★ ONE LINE. THE ESSAY IS GONE RATHER THAN HIDDEN.
       *
       * This was nine lines: a confirmation, three checks, a presence paragraph and two ★
       * paragraphs about inboxes and what asking is not. Putting them behind a spoiler was the
       * first attempt and it was worse — Discord renders a long hidden run as a WALL OF GREY BARS,
       * so the noise stayed and became unreadable as well.
       *
       * The real problem was that most of it was CONSTANT. The same two paragraphs on every ask
       * are documentation, not facts about this message, and documentation belongs in the README
       * and the command descriptions where somebody reads it once. What is left is what actually
       * differs per ask: which agent, whether it is running, and where the entry landed.
       */
      '**Asked ' + (out.target.name ?? out.target.agentId) + '.** '
        + (out.target.presence.state === 'running'
          ? 'Its host is running, so an answer appears here on its own.'
          : 'Its host is not running, so this is answered when it next does — nothing is lost by waiting.'),
      '-# entry #' + out.accepted.seq + ' · addressed to it inside the signed region'
        + (out.checks.some((c) => c.mark === 'n') ? ' · ' + out.checks.filter((c) => c.mark === 'n').map((c) => '✗ ' + c.text).join(' · ') : ''),
    ], false);
  }
}

// ── what the watcher pushes ──────────────────────────────────────────────────

/**
 * News about the record, pushed without anybody asking.
 *
 * ★ ATTRIBUTION GOES THROUGH THE SAME {@link authorOf} AS `/workspace show`. Reading this channel
 * is the main way a person other than the pod owner meets these records, so a second rendering here
 * is exactly where "a delegate wrote this, on its own account" would quietly become "they said
 * this". There is one function and both callers use it.
 *
 * Returns null when there is nothing worth a message: a caller that posted an empty body would be
 * a caller that decided something in a formatter.
 */
export function renderNews(news: WatchNews): readonly NewsPost[] | null {
  switch (news.kind) {
    case 'entries': {
      if (!news.entries.length) return null;
      /**
       * ★ A DELEGATE'S WORDS GO OUT UNDER ITS OWN NAME; EVERYTHING ELSE STAYS THE BOT'S.
       *
       * The split is on `kind === 'delegate'` and that is not a style choice: the type of that
       * variant's `signer` is `the-author` and nothing else, so reaching this branch IS the proof
       * that the agent's own key signed those bytes. A disputed entry, an unstated author, or a
       * person's own words relayed by a conduit all keep the bot's quoted format — those are
       * exactly the cases where a confident display name would be a claim nobody checked.
       */
      const posts: NewsPost[] = [];
      const lines: string[] = [];
      const flush = (): void => { if (lines.length) { posts.push(...bodyParts(lines, false).map((message) => ({ kind: 'bot' as const, message }))); lines.length = 0; } };
      for (const e of news.entries) {
        const who = e.author?.kind === 'delegate' ? displayName(e.author.name) : null;
        if (who && e.author?.kind === 'delegate') {
          // Order matters: the bot's own preceding lines go first, so the channel reads in the
          // order the entries did rather than with every agent's message bunched at the end.
          flush();
          posts.push({
            kind: 'agent',
            who,
            agentId: e.author.agentId,
            content: (e.body ?? '(this entry names no dct:description)')
              + '\n' + agentFooter(e.author, e.pod),
          });
          continue;
        }
        // ★ ONE ELEMENT PER ENTRY — attribution and quote together. These were two consecutive
        // pushes, which `bodyParts` would have been free to separate: the header could land at the
        // end of one message and the words it attributes at the start of the next, which is the
        // exact failure this file's whole authorship apparatus exists to prevent.
        //
        // Quoted, so text that came off somebody else's pod cannot be read as this bot's own
        // sentence — and `rest.post` sends it with mentions disabled, so a body containing
        // `@everyone` is text and not a ping.
        /**
         * ★ THE WORDS IN PLAIN TEXT, THE ATTRIBUTION BEHIND A CLICK. A reader watching a channel
         * wants to see what somebody said; who relayed it onto whose pod with which scope is a
         * question they ask occasionally and this bot answers always. `authorOf` is unchanged and
         * still says every one of the five things it said — it is out of the way, not gone.
         */
        /**
         * ★ THE WORDS, AND ONLY WHAT IS UNUSUAL ABOUT WHO WROTE THEM.
         *
         * `authorOf` says five things and each matters — but on the ordinary message, which is
         * nearly every message, it says the same reassuring one every time: the pod owner wrote
         * this and an authorised key relayed it. Repeating that above every sentence is what made
         * a conversation unreadable. An `unstated` or `disputed` authorship is a FINDING and stays
         * in plain text, because a finding nobody reads is not a finding.
         */
        lines.push('-# `' + e.pod + '` #' + (e.seq ?? '?') + ' · ' + (e.created ?? 'no declared time')
          + (e.author && (e.author.kind === 'unstated' || e.author.kind === 'disputed') ? ' ' + authorOf(e.author) : '')
          + '\n> ' + (e.body ?? '(this entry names no dct:description)').split('\n').join('\n> '));
      }
      flush();
      return posts;
    }
    case 'burst': return [{ kind: 'bot', message: body([
      '**' + news.count + ' new entries** were appended in this workspace just now — more than this bot posts one at a time, so they are not being replayed here. `/workspace show` reads them out of the pods that hold them.',
    ], false) }];
    case 'forked': return [{ kind: 'bot', message: body([
      '? `' + news.pod + '` — ' + news.why,
      'Nothing is being read out of that log in sequence until it has one head. Said once, not every time it is noticed.',
    ], false) }];
    case 'unreadable-entry': return [{ kind: 'bot', message: body(['? An entry in this workspace could not be read: ' + news.why], false) }];
    case 'silence': return [{ kind: 'bot', message: body([
      '**' + news.ask.targetName + ' has not answered yet** — asked ' + describeSpan(news.waitedMs) + ' ago. The ask is on the record and stays answerable.',
      // Constant prose about what silence can mean is documentation, not a fact about this ask —
      // and repeated on every unanswered one it is the same noise in a different place.
      '-# entry #' + news.ask.seq + ' · its host ' + news.ask.presenceAtAsk + ' when you asked',
    ], false) }];
  }
}
