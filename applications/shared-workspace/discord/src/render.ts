/**
 * TURNING A VERDICT INTO A MESSAGE. Nothing here decides anything.
 *
 * ★ AND NOTHING HERE INVENTS A FACT. Every sentence below is either a constant of this bot's
 * own behaviour or a value carried on the outcome it was handed. Where an outcome says a check
 * could not be run, the line says that — `q` is rendered as "not established", never as a
 * negative. The one temptation this file exists to resist is the summary sentence: "recorded and
 * signed by you" is two claims, and the second one is false.
 */

import { shortRef, type Check } from '@interego/workspace-client';
import type { ConfirmOut, LinkChallengeOut, RecordOut, ShowOut, StartOut, UnlinkOut } from './workspace.js';

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
          : '  `' + e.pod + '` #' + (e.seq ?? '?') + ' · ' + (e.created ?? 'no declared time') + '\n    ' + (e.body ?? '(this entry names no dct:description)'));
      }
      lines.push('',
        'Order inside one pod\'s log is the supersession chain those entries declare, which nothing outside that pod can rewrite. Order **between** pods is each entry\'s own `dct:created` — a clock its author\'s client set. The substrate establishes no happens-before across pods, so the interleaving above is a presentation, not a finding.');
      return body(lines, false);
    }
  }
}
