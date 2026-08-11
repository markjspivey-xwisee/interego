/**
 * ASKING SOMEBODY ELSE'S AGENT TO DO SOMETHING. Nothing in this file knows what Discord is.
 *
 * ── WHAT IS ADDRESSABLE, AND WHAT IS DELIBERATELY NOT ────────────────────────
 *
 * ★ "MARK'S AGENT" IS AMBIGUOUS BY CONSTRUCTION AND THIS NEVER ACCEPTS IT. A person may have
 * several delegates authorised at once — that is the whole shape `renderAgent`'s picker is built
 * around — so a Discord `@mention` resolves to a Discord user id, which the bot's own index maps to
 * ONE POD, which that pod's own registry maps to N delegates. The mention is half an address. The
 * addressable unit is the delegate's agent DID, and the disambiguation happens in the picker, at
 * type time, against the delegator's own registry.
 *
 * ★ AND THE BOT'S INDEX IS NOT AUTHORITATIVE FOR ANY OF IT. `LinkStore` answers exactly one
 * question — which pod a Discord account proved control of — and every fact about WHICH AGENTS THAT
 * POD HAS comes from the pod, live, on every invocation. A delegate revoked thirty seconds ago
 * disappears from the picker without this bot being told, because nothing here caches a roster.
 *
 * ── WHERE THE ASK GOES ───────────────────────────────────────────────────────
 *
 * ★ THE ASK IS A CHANNEL ENTRY. THE INBOX IS ONLY A POINTER. Mark said it in the channel, so it is
 * an entry on Mark's own pod like every other thing he says here: signed, content-bound, chained,
 * readable by every member — with one triple added INSIDE the signed region naming who it is for.
 * `notify_agent` then points at that entry and carries no task text, because an inbox on this relay
 * is world-writable and text that travelled by inbox would be text a forger could write.
 *
 * ★ SO A HOST THAT IS RUNNING NEEDS NO NOTIFICATION AT ALL. It is already watching the channel on a
 * 45-second poll and the ask is in it. The notification is an ACCELERANT for the absent case and a
 * wake record afterwards — never the source of truth. That is also why there is no third path where
 * somebody else's credential answers: there is no path that carries a task anywhere except onto a
 * pod.
 *
 * ── COMPOSED, NOT REBUILT ────────────────────────────────────────────────────
 *
 * The write goes through `recordMessage`, which is the same function every ordinary Discord message
 * goes through — the delegation gate, the frame read, the seating of an unseated member, the
 * per-pod CAS append. An ask written by a second path would be an ask that skipped one of those the
 * first time somebody changed one of them.
 */

import {
  type AskNotice, type Check, type Presence,
  agentPodOf, agentPort, delegatePort, errorCopy, foldRoster, isPresent, notifyAsk, podOfNsIri, presenceLine,
  readDelegates, readPresence, scopeWriteEligible,
  type DelegateRoster, type PostOutcome, type RosterFold, type Seat,
} from '@interego/workspace-client';
import type { Deps } from './workspace.js';
import { recordMessage, type RecordOut } from './workspace.js';
import type { ThreadBinding } from './links.js';

/** How many choices Discord will render in one autocomplete response. Its own hard limit. */
export const AUTOCOMPLETE_MAX = 25;

/** One delegate somebody in this workspace could be asked something. */
export interface AskTarget {
  readonly agentId: string;
  /**
   * The DELEGATOR's pod: whose seat this agent would write under, and whose registry authorises it.
   *
   * ★ NOT WHERE ANYTHING OF THE AGENT'S OWN LIVES, AND THE DOCSTRING USED TO SAY IT WAS. Its lease
   * and its capability document are on the AGENT's own pod, derived from its DID — the very next
   * comment in this file says so about the same value — and so is the inbox it polls. Sending an
   * ask's notification here is what made the ask-and-wake path deliver into a mailbox nobody read.
   */
  readonly pod: string;
  /**
   * The agent's OWN pod, out of its DID. Where its lease, its capabilities and its inbox are.
   *
   * Null when this client cannot take a pod out of that id — a cross-issuer or `did:key` delegate.
   * Carried rather than recomputed per surface so a renderer cannot quietly substitute `pod`.
   */
  readonly agentPod: string | null;
  /** The label that pod's own registry gives it. Null when the row carries no delegate label. */
  readonly name: string | null;
  readonly scope: string | null;
  readonly writeEligible: boolean;
  readonly presence: Presence;
  /** True when this delegate belongs to the person doing the asking. */
  readonly isYou: boolean;
}

/** A pod that is seated and whose registry did not answer. Reported, never skipped silently. */
export interface UnreadPod { readonly pod: string; readonly why: string }

export type CandidatesOut =
  | { readonly kind: 'not-a-workspace' }
  | { readonly kind: 'unreadable'; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'candidates';
      readonly binding: ThreadBinding;
      readonly targets: readonly AskTarget[];
      readonly unread: readonly UnreadPod[];
      /** Seated pods whose registry answered and listed no delegate. Its own answer, not silence. */
      readonly noneOn: readonly string[];
    };

/**
 * Every delegate that could be addressed in this thread, with what its pod says about it.
 *
 * ★ ONE READ PER SEATED POD, because authorisation is per pod. Applying one member's registry to
 * another would invent an authorization record for somebody else — the trap `showWorkspace` already
 * records. A pod that does not answer contributes no candidates AND is reported as unread, which is
 * a different answer from "that person has no agents".
 */
export async function askCandidates(
  deps: Deps,
  args: { readonly threadId: string; readonly discordUserId: string; readonly nowMs?: number },
): Promise<CandidatesOut> {
  const binding = deps.store.threadOf(args.threadId);
  if (!binding) return { kind: 'not-a-workspace' };
  const mine = deps.store.linkOf(args.discordUserId)?.pod ?? null;
  let fold: RosterFold;
  try {
    const iriOwner = podOfNsIri(binding.workspace) ?? binding.convenerPod;
    fold = await foldRoster(deps.client, {
      workspace: binding.workspace, iriOwner, slug: binding.slug,
      convener: null, convenerPod: binding.convenerPod,
    });
  } catch (e) { return { kind: 'error', error: e }; }

  const targets: AskTarget[] = [];
  const unread: UnreadPod[] = [];
  const noneOn: string[] = [];
  const seen = new Set<string>();
  for (const s of fold.seats as readonly Seat[]) {
    if (!s.seated || !s.pod) continue;
    const pod = s.podServed ?? s.pod;
    if (seen.has(pod)) continue;
    seen.add(pod);
    let roster: DelegateRoster;
    try { roster = await readDelegates(delegatePort(deps.client), pod); }
    catch (e) { unread.push({ pod, why: errorCopy(e).t }); continue; }
    if (!roster.read) { unread.push({ pod, why: roster.why ?? 'that pod\'s delegation registry did not answer' }); continue; }
    if (!roster.delegates.length) { noneOn.push(pod); continue; }
    for (const d of roster.delegates) {
      // ★ PRESENCE IS READ FROM THE DELEGATE'S OWN POD, NOT FROM `pod`. Two facts, two documents,
      // two pods: whether this person authorises that agent comes from THEIR registry (the row
      // above), and whether that agent's host is up comes from ITS pod, signed by its own key.
      // `readPresence` derives the address from the agent id, so nothing here can point it at the
      // wrong one — which matters, because a lease on the wrong pod cannot be verified at all.
      const presence = await readPresence(agentPort(deps.client), {
        relay: deps.relay, agentId: d.agentId,
        ...(args.nowMs === undefined ? {} : { nowMs: args.nowMs }),
      });
      targets.push({
        agentId: d.agentId, pod, agentPod: agentPodOf(d.agentId), name: d.name, scope: d.scope,
        writeEligible: d.writeEligible, presence, isYou: pod === mine,
      });
    }
  }
  // Present first, then named, so the useful choices are the ones Discord shows before its cap.
  targets.sort((a, b) => (isPresent(b.presence) ? 1 : 0) - (isPresent(a.presence) ? 1 : 0)
    || String(a.name ?? a.agentId).localeCompare(String(b.name ?? b.agentId)));
  return { kind: 'candidates', binding, targets, unread, noneOn };
}

/**
 * One autocomplete choice: what a person reads, and the full agent DID it stands for.
 *
 * ★ THE VALUE IS THE DID AND THE LABEL IS THAT POD'S OWN WORD FOR IT. A nickname namespace invented
 * by this bot would be a second name for a thing its owner already named, in a document only they
 * can write, and the two would disagree the first time somebody renamed a delegate.
 */
export interface AskChoice { readonly name: string; readonly value: string }

/** Discord refuses a choice name over 100 characters. */
const CHOICE_MAX = 100;

export function askChoices(out: CandidatesOut, query: string, nowMs = Date.now()): readonly AskChoice[] {
  if (out.kind !== 'candidates') return [];
  const q = query.trim().toLowerCase();
  const rows: AskChoice[] = [];
  for (const t of out.targets) {
    const label = t.name ?? t.agentId;
    if (q && label.toLowerCase().indexOf(q) < 0 && t.agentId.toLowerCase().indexOf(q) < 0 && t.pod.toLowerCase().indexOf(q) < 0) continue;
    const who = t.isYou ? 'you' : t.pod;
    const line = label + ' · ' + who + ' · ' + presenceLine(t.presence, nowMs)
      + (t.writeEligible ? '' : ' · scope ' + (t.scope ?? 'not reported') + ', cannot append');
    rows.push({ name: line.length > CHOICE_MAX ? line.slice(0, CHOICE_MAX - 1) + '…' : line, value: t.agentId });
    if (rows.length >= AUTOCOMPLETE_MAX) break;
  }
  // ★ AN EMPTY LIST IS A STATEMENT AND IT SAYS WHICH ONE. Discord renders a choice list and nothing
  // else, so "no delegates here" and "nobody's pod answered" would look identical — and the second
  // is a failed read being drawn as a fact about other people's pods. Each gets its own row, with a
  // value nothing can act on.
  if (!rows.length && !q) {
    for (const u of out.unread.slice(0, 3)) {
      rows.push({ name: ('· ' + u.pod + ' did not answer, so what it can be asked is not established').slice(0, CHOICE_MAX), value: '?unread:' + u.pod });
    }
    for (const p of out.noneOn.slice(0, 3)) {
      rows.push({ name: ('· no delegate on ' + p + ' — that pod\'s registry lists none').slice(0, CHOICE_MAX), value: '?none:' + p });
    }
    if (!rows.length) rows.push({ name: '· nobody seated here has authorised a delegate', value: '?empty' });
  }
  return rows;
}

// ── resolving a target ───────────────────────────────────────────────────────

export type ResolveOut =
  | { readonly kind: 'resolved'; readonly target: AskTarget; readonly candidates: Extract<CandidatesOut, { kind: 'candidates' }> }
  | { readonly kind: 'no-match'; readonly spec: string; readonly known: readonly string[] }
  | { readonly kind: 'ambiguous'; readonly spec: string; readonly matches: readonly AskTarget[] }
  | { readonly kind: 'not-a-workspace' }
  | { readonly kind: 'unreadable'; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * Turn what somebody typed into exactly one delegate, or refuse.
 *
 * A DID matches exactly. A bare label is a convenience and is resolved by the SAME two reads the
 * picker uses; when it matches zero or two rows this refuses and lists them, because guessing which
 * of somebody's agents was meant is how work lands on the wrong pod.
 */
export async function resolveTarget(
  deps: Deps,
  args: { readonly threadId: string; readonly discordUserId: string; readonly spec: string; readonly nowMs?: number },
): Promise<ResolveOut> {
  const out = await askCandidates(deps, args);
  if (out.kind !== 'candidates') return out;
  const spec = args.spec.trim();
  const exact = out.targets.filter((t) => t.agentId === spec);
  if (exact.length === 1) return { kind: 'resolved', target: exact[0] as AskTarget, candidates: out };
  const lower = spec.toLowerCase();
  const byName = out.targets.filter((t) => (t.name ?? '').toLowerCase() === lower);
  if (byName.length === 1) return { kind: 'resolved', target: byName[0] as AskTarget, candidates: out };
  if (byName.length > 1) return { kind: 'ambiguous', spec, matches: byName };
  const loose = out.targets.filter((t) => (t.name ?? '').toLowerCase().indexOf(lower) >= 0);
  if (lower && loose.length === 1) return { kind: 'resolved', target: loose[0] as AskTarget, candidates: out };
  if (lower && loose.length > 1) return { kind: 'ambiguous', spec, matches: loose };
  return { kind: 'no-match', spec, known: out.targets.map((t) => (t.name ?? t.agentId) + ' on ' + t.pod) };
}

// ── the ask ──────────────────────────────────────────────────────────────────

/** What `notify_agent` reported, kept as reported rather than summarised into a boolean. */
/**
 * ★ NOW ONE DEFINITION, IN THE SHARED PACKAGE, BECAUSE A SECOND SURFACE NEEDED THE SAME DECISION.
 *
 * This used to be an interface here and a `notifyAbout` beside it, which was correct while Discord
 * was the only thing that could ask. The desktop shell can now ask too, and the three branches
 * (running host → send nothing; underivable pod → send nothing and say so; otherwise send a
 * pointer carrying no task text) are exactly the rules that go wrong when they are written twice.
 * The name is kept as an alias so this file's own union reads the same as it did.
 */
export type NoticeReport = AskNotice;

export type AskOut =
  | { readonly kind: 'not-a-workspace' }
  | { readonly kind: 'not-linked' }
  | { readonly kind: 'empty-task' }
  | { readonly kind: 'no-match'; readonly spec: string; readonly known: readonly string[] }
  | { readonly kind: 'ambiguous'; readonly spec: string; readonly matches: readonly AskTarget[] }
  | { readonly kind: 'target-cannot-append'; readonly target: AskTarget }
  | { readonly kind: 'unreadable'; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown }
  /** The write refused, from the same union every ordinary message uses. Nothing was sent. */
  | { readonly kind: 'not-written'; readonly target: AskTarget; readonly record: RecordOut }
  | {
      readonly kind: 'asked';
      readonly target: AskTarget;
      readonly record: Extract<RecordOut, { kind: 'recorded' }>;
      /**
       * The accepted append, narrowed.
       *
       * ★ CARRIED SEPARATELY BECAUSE `RecordOut`'s `outcome` IS THE WHOLE `PostOutcome` UNION, and
       * a renderer reaching for `.seq` on it would be reading a field four of the five variants do
       * not have. Narrowing here, once, at the only place that has already established the append
       * was accepted, is what stops every surface re-establishing it with a cast.
       */
      readonly accepted: Extract<PostOutcome, { kind: 'accepted' }>;
      readonly descriptorUrl: string | null;
      readonly notice: NoticeReport;
      readonly checks: readonly Check[];
    };

/**
 * Put the ask on the record and, when the addressee's host is not up, point its inbox at it.
 *
 * ★ THE ORDER IS THE WHOLE SAFETY PROPERTY. The entry is written FIRST and the notification second,
 * so every outcome past the write is "the ask is on the record and the notice did/did not land" —
 * never "a notice exists pointing at nothing". If the write refuses, nothing is sent at all and the
 * copy says so.
 */
export async function ask(
  deps: Deps,
  args: {
    readonly threadId: string;
    readonly discordUserId: string;
    /** A full agent DID (from the picker) or a label (typed by hand). */
    readonly spec: string;
    readonly task: string;
    readonly nowMs?: number;
  },
): Promise<AskOut> {
  if (!deps.store.threadOf(args.threadId)) return { kind: 'not-a-workspace' };
  if (!deps.store.linkOf(args.discordUserId)) return { kind: 'not-linked' };
  const task = args.task.trim();
  if (!task) return { kind: 'empty-task' };

  // ★ RESOLVED AGAIN HERE EVEN THOUGH THE PICKER JUST DID IT. An autocomplete answer can be minutes
  // old — a person opens the box, gets called away, comes back and presses enter — and in that gap
  // a delegation can be revoked and a host can stop. Both facts are re-read against the pods that
  // own them, so what the acknowledgement says is what was true at the moment of writing.
  const found = await resolveTarget(deps, args);
  if (found.kind !== 'resolved') {
    return found.kind === 'no-match' ? { kind: 'no-match', spec: found.spec, known: found.known }
      : found.kind === 'ambiguous' ? { kind: 'ambiguous', spec: found.spec, matches: found.matches }
        : found.kind === 'unreadable' ? { kind: 'unreadable', why: found.why }
          : found.kind === 'error' ? { kind: 'error', error: found.error }
            : { kind: 'not-a-workspace' };
  }
  const target = found.target;

  // ★ A DELEGATE THE POD WILL NOT LET PUBLISH IS REFUSED BEFORE ANYTHING IS WRITTEN. It could still
  // read the channel and think about it; it could not append the answer, so the ask would sit on
  // the record forever with no possible reply. Only its delegator can change that, and saying so is
  // more use than a permanent unanswerable entry.
  if (!target.writeEligible) return { kind: 'target-cannot-append', target };

  // The write. Same path as every ordinary message in this thread — see the header.
  const record = await recordMessage(deps, {
    threadId: args.threadId, discordUserId: args.discordUserId, text: task,
    addressedTo: [target.agentId],
  });
  if (record.kind !== 'recorded' || record.outcome.kind !== 'accepted') {
    return { kind: 'not-written', target, record };
  }
  const accepted = record.outcome;
  const descriptorUrl = accepted.descriptorUrl;
  const checks: Check[] = [
    { mark: 'y', text: 'Your ask is entry #' + accepted.seq + ' on pod ' + record.pod + ', signed and chained into this channel' },
    { mark: 'y', text: 'It carries iep:addressedTo ' + target.agentId + ' inside the signed region, so who it is for cannot be changed by whoever relays it' },
  ];

  // ★ WHETHER A NOTICE GOES AT ALL IS `notifyAsk`'s CALL, NOT THIS FILE'S. All three branches — a
  // running host is sent nothing, an underivable pod is sent nothing and says so, otherwise a
  // pointer with no task text goes to the ADDRESSEE's own pod — now live in the shared package, so
  // the desktop shell and this bot cannot come to differ about them. What stays here is the
  // rendering: Discord's checklist is Discord's business.
  const notice: NoticeReport = descriptorUrl
    ? await notifyAsk(deps.client, {
      agentId: target.agentId, agentPod: target.agentPod, presence: target.presence,
      about: descriptorUrl,
      summary: 'A request addressed to ' + (target.name ?? target.agentId) + ' was published in ' + found.candidates.binding.title,
    })
    : {
      attempted: false, delivered: false, canonicalInbox: null, inbox: null, warning: null,
      why: 'the append was accepted but the relay named no descriptor for it, so there is no record for a notice to '
        + 'point AT. Nothing was sent rather than a pointer to nowhere.',
    };
  if (notice.attempted) {
    checks.push(notice.delivered
      ? { mark: notice.canonicalInbox === false ? 'q' : 'y', text: 'A notice pointing at that entry is in the inbox on that AGENT\'s own pod, `' + target.agentPod + '` — the one its own session polls' + (notice.canonicalInbox === false ? ', though the relay did not report it as that pod\'s canonical inbox' : '') }
      : { mark: 'n', text: 'The notice was not delivered: ' + (notice.why ?? 'no reason reported') + '. The ask is still on the record.' });
  } else if (!isPresent(target.presence)) {
    // Not sent, and the host is NOT up — so the reason is worth printing. When the host IS up,
    // "no notice was sent" is the expected path and saying so would read as a failure.
    checks.push({ mark: 'q', text: 'No notice was sent: ' + (notice.why ?? 'no reason reported')
      + ' The ask is on the record and a host that reads this channel will find it.' });
  }
  return { kind: 'asked', target, record, accepted, descriptorUrl, notice, checks };
}

/** True when this scope string would let a delegate append. Re-exported so renderers agree. */
export const canAppend = (scope: string | null): boolean => scopeWriteEligible(scope ?? '');
