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
import type { WatchNews } from './watch.js';

/** Discord refuses a message body over 2000 characters outright. */
export const DISCORD_LIMIT = 2000;

export interface Message { readonly content: string; readonly ephemeral: boolean }

/**
 * Join lines and clamp, saying so when it clamps.
 *
 * A silently truncated message is a report that ends mid-sentence and reads as if that were all
 * there was — which, in a bot whose entire job is to be trusted about what it did and did not do,
 * is the worst possible failure of a formatter.
 */
export function body(lines: readonly string[], ephemeral: boolean): Message {
  const note = '\n… clipped: Discord refuses a message over ' + DISCORD_LIMIT + ' characters.';
  const full = lines.join('\n');
  if (full.length <= DISCORD_LIMIT) return { content: full, ephemeral };
  return { content: full.slice(0, DISCORD_LIMIT - note.length) + note, ephemeral };
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
 */
export function authorOf(a: EntryAuthorship | null): string {
  if (a === null) return '[author not read]';
  switch (a.kind) {
    case 'principal': return '[written by the pod owner]';
    case 'unstated': return '[**author not stated** — this entry names nobody, which is not the same as the pod owner having written it]';
    case 'disputed': return '[**authorship disputed** — ' + a.why + ']';
    case 'delegate': return '[written by **' + (a.name ?? 'an unnamed delegate') + '**, a delegate of the pod owner, '
      + (a.footing.kind === 'on-behalf-of' ? 'speaking **for them** here — they share responsibility for it'
        : a.footing.kind === 'own-account' ? 'speaking **for itself** here — its own position, which the pod owner is NOT answerable for'
          : '**footing not stated** — this entry does not say whether it was written for them or on its own account, and neither reading is being assumed')
      + (a.authorised === true ? '; separately, that pod\'s own registry authorises it' + (a.scope ? ' with scope ' + a.scope : '')
        : a.authorised === false ? '; and **that pod\'s registry does NOT list this agent**, so it is not a delegate of theirs by any record they have published'
          : '; that pod\'s registry was not read here, so whether it is their delegate at all is not established')
      + ']';
  }
}

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
    ], false);
  }
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
      if (out.authorship) {
        lines.push('');
        for (const p of out.authorship.proves) lines.push('✓ ' + p);
        for (const d of out.authorship.doesNotProve) lines.push('? ' + d);
      }
      return body(lines, false);
    }
  }
}

export function renderShow(out: ShowOut): Message {
  switch (out.kind) {
    case 'not-a-workspace': return body(['This thread is not a workspace. `/workspace start` makes it one.'], true);
    case 'unreadable': return body(['The workspace at ' + iri(out.binding.workspace) + ' could not be read: ' + out.why], false);
    case 'error': return body(['The workspace could not be read: ' + ((out.error as Error)?.message ?? String(out.error))], false);
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
      if (out.fold.grantScanSaturated) lines.push('  ? that scan of ' + out.fold.grantPod + ' came back full at ' + out.fold.grantLimit + ' descriptors, so an older grant may lie past the end of it');
      if (out.fold.grantsFound > out.fold.grantsRead) lines.push('  ? ' + out.fold.grantsFound + ' grants found, ' + out.fold.grantsRead + ' read (cap ' + out.fold.grantReadCap + ')');

      for (const st of out.streams) if (st.why) lines.push('  ? `' + st.pod + '`: ' + st.why);

      lines.push('', '**Entries** — ' + out.totalEntries + ' in ' + out.streams.length + ' log' + (out.streams.length === 1 ? '' : 's')
        + (out.truncated ? ', newest ' + out.entries.length + ' shown' : ''));
      if (!out.entries.length) lines.push('  none read');
      for (const e of out.entries) {
        lines.push(e.why
          ? '  ? `' + e.pod + '` — ' + e.why
          : '  `' + e.pod + '` ' + authorOf(e.author) + ' #' + (e.seq ?? '?') + ' · ' + (e.created ?? 'no declared time') + '\n    ' + (e.body ?? '(this entry names no dct:description)'));
      }
      lines.push('',
        'Order inside one pod\'s log is the supersession chain those entries declare, which nothing outside that pod can rewrite. Order **between** pods is each entry\'s own `dct:created` — a clock its author\'s client set. The substrate establishes no happens-before across pods, so the interleaving above is a presentation, not a finding.',
        '',
        '★ The pod is whose LOG an entry is in. **Who wrote it** is the name beside it, read from the entry\'s own `prov:wasAttributedTo`.',
        '★ Where that names a delegate, THREE separate things are reported and they can disagree. (1) Is it that person\'s delegate at all — asked of their own pod\'s delegation registry, a document only they can write, and standing until they revoke it. (2) What footing THIS entry was on — read from the entry itself, as a `prov:Delegation` over the act that produced it or an `iep:actedOnOwnAccount` declaring the opposite. An agent can be a properly authorised delegate and still be speaking entirely for itself in any given message. (3) Neither, when the entry does not say — which is reported as not saying, and is not read as either.');
      return body(lines, false);
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
export function renderWho(out: CandidatesOut, nowMs = Date.now()): Message {
  switch (out.kind) {
    case 'not-a-workspace': return body(['This thread is not a workspace. `/workspace start` makes it one.'], true);
    case 'unreadable': return body(['**The roster could not be read**, so who could be asked something here is not established: ' + out.why], true);
    case 'error': return body(['**The roster could not be read**, so who could be asked something here is not established: ' + ((out.error as Error)?.message ?? String(out.error))], true);
    case 'candidates': {
      const lines: string[] = ['**Agents in ' + out.binding.title + '**'];
      if (out.targets.length) for (const t of out.targets) lines.push(agentLine(t, nowMs));
      else lines.push('  Nobody seated here has authorised an agent. A person authorises one from their own client with `register_agent`; this bot cannot do it for them and cannot see one that does not exist.');
      for (const u of out.unread) {
        lines.push('  ? `' + u.pod + '` did not answer, so what it can be asked is **not established** — which is not the same as it having no agents (' + u.why + ')');
      }
      for (const p of out.noneOn) lines.push('  · `' + p + '` answered and its registry lists no agent');
      lines.push('',
        '● means that agent published a short lease saying its host was running, signed with its own key, and the lease is live now. ○ means it did not — a lapsed lease, none at all, or a pod that would not answer, and the line says which.',
        'Presence is read from **the agent\'s own pod**; whether its human authorises it is read from **theirs**. Two documents, and they can disagree.',
        '`/workspace ask` puts the ask on the record either way. A host that is not running answers when it next runs.');
      return body(lines, true);
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
      '**Asked ' + (out.target.name ?? out.target.agentId) + '.**',
      ...checkLines(out.checks),
      '',
      out.target.presence.state === 'running'
        ? 'Its host said it was running ' + describeSpan(nowMs - out.target.presence.saidAtMs) + ' ago, and a running host reads this channel directly. If it judges there is something to add, its answer appears here on its own.'
        : 'Its host is **not** saying it is running (' + presenceLine(out.target.presence, nowMs) + '), so this is answered when it next runs. Nothing is lost by waiting — the ask is on the record, and the record is what it reads.',
      '',
      '★ The ask is entry #' + out.accepted.seq + ' in this channel, not a message in an inbox. An inbox on this relay is world-writable, so what travelled by inbox is only a **pointer** to that entry and carries none of your text. The agent dereferences it and refuses it unless whoever delivered it is whoever signed it.',
      '★ Asking is not instructing. The agent decides whether there is anything to add, and one that decides there is not **writes nothing** — which from here looks exactly like one that never read it. If nothing is written, this channel says so rather than leaving you to guess.',
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
export function renderNews(news: WatchNews): Message | null {
  switch (news.kind) {
    case 'entries': {
      if (!news.entries.length) return null;
      const lines: string[] = [];
      for (const e of news.entries) {
        lines.push('`' + e.pod + '` ' + authorOf(e.author) + ' #' + (e.seq ?? '?') + ' · ' + (e.created ?? 'no declared time'));
        // Quoted, so text that came off somebody else's pod cannot be read as this bot's own
        // sentence — and `rest.post` sends it with mentions disabled, so a body containing
        // `@everyone` is text and not a ping.
        lines.push('> ' + (e.body ?? '(this entry names no dct:description)').split('\n').join('\n> '));
      }
      return body(lines, false);
    }
    case 'burst': return body([
      '**' + news.count + ' new entries** were appended in this workspace just now — more than this bot posts one at a time, so they are not being replayed here. `/workspace show` reads them out of the pods that hold them.',
    ], false);
    case 'forked': return body([
      '? `' + news.pod + '` — ' + news.why,
      'Nothing is being read out of that log in sequence until it has one head. Said once, not every time it is noticed.',
    ], false);
    case 'unreadable-entry': return body(['? An entry in this workspace could not be read: ' + news.why], false);
    case 'silence': return body([
      '**Nothing has been written in answer yet.** You asked ' + news.ask.targetName + ' ' + describeSpan(news.waitedMs) + ' ago (entry #' + news.ask.seq + ').',
      'Its host ' + news.ask.presenceAtAsk + ' when you asked.',
      '',
      'An agent that read this and judged there was nothing to add writes nothing, and so does one that refused — from here those look the same, and this bot will not guess which. The ask is still on the record and is still answerable whenever its host next runs.',
    ], false);
  }
}
