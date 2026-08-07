/**
 * A DELEGATE: AN IDENTITY A PERSON AUTHORISES TO ACT FOR THEM, WHICH IS NOT THE PERSON.
 *
 * ★ THE CORRECTION THIS FILE IS. Before it, the desktop shell's local agent wrote as the user:
 * same session, same pod, same WebID, and an entry it composed was indistinguishable in the
 * record from one the user typed. That is wrong at the level of the whole proposition — if a
 * reader cannot tell "Mark said" from "Mark's agent said", the provenance this substrate exists
 * to preserve is gone.
 *
 * ★ AND THE DISTINCTION THAT MUST NOT BE OVER-APPLIED. A conduit is not a delegate. The Discord
 * bot relays a message a human TYPED; they wrote the words and the entry is theirs, correctly
 * attributed to them, and nothing here changes that. A delegate GENERATES text the human did not
 * write. Only the second is attributed to the agent.
 *
 * ── WHAT A DELEGATE IS, EXACTLY ──────────────────────────────────────────────────────────────
 *
 * A keypair, and a row on the delegator's own pod naming the DID that key resolves to. That is
 * the whole of it. In particular:
 *
 *  · IT IS NOT A CHANNEL. Discord, the desktop app and the published artifact are surfaces a
 *    delegate SPEAKS THROUGH. The same delegate in two surfaces is one identity, and nothing
 *    about the surface appears in what establishes who authored an entry. How an entry ARRIVED
 *    is a different question from who wrote it, and this file answers only the second.
 *  · IT IS NOT THE HOST. An app holds a delegate's key; it does not own the delegate. The
 *    authoritative roster of a person's delegates is their POD's delegation registry — see
 *    {@link readDelegates} — and a delegate whose key lives on another machine appears in it
 *    exactly like one this app can drive.
 *  · IT IS NOT THE MODEL PROVIDER. Two delegates may both run on Claude and still be two
 *    delegates. Nothing here keys identity on a provider, and a UI that called one "the Claude
 *    agent" would be making provider and identity the same thing.
 *  · THERE MAY BE SEVERAL. `register_agent` writes one row per agent and a pod carries many, so
 *    one person can authorise an Anthropic-backed delegate and an OpenAI-backed one, each with
 *    its own DID, its own scope and its own revocation. Everything below is plural.
 *
 * ★ AND THE MEASUREMENT THAT DECIDES {@link DELEGATE_SURFACE}, WHICH IS THE WHOLE REASON IT
 * EXISTS. Measured against the live relay, 2026-08-07, one secp256k1 key signed in three times:
 *
 *   client_name "interego-delegate"          -> did:web:identity…:agents:interego-delegate-u-eth-37a1a26c1551
 *   client_name "interego-delegate" (again)     the SAME did
 *   client_name "interego-workspace-desktop" -> did:web:identity…:agents:interego-workspace-desktop-u-eth-37a1a26c1551
 *
 * So the relay derives the agent DID from the pod (which is the key) AND the OAuth `client_name`
 * the host registered. A host that signed its delegates in under its OWN client name would mint
 * a DIFFERENT delegate per app: reinstall under another name, or speak through another surface,
 * and the same key becomes somebody else. The constant below is the fix, and it belongs in this
 * package precisely because every host has to use the same one for the sentence "one delegate,
 * several surfaces" to be true.
 */

import { WRITE_ELIGIBLE_SCOPES, AGENT_ID_RX, type DelegationPlan, type DelegationScope } from './agentlink.js';
import { delegateLabel, delegateNameProblem, parseDelegateLabel } from './delegates-name.js';
import { checkRoleForWorkspace, type RoleTable } from './membership.js';
import { readIriAll } from './turtle.js';
import { errorCopy, type WorkspaceClient } from './substrate.js';
import { refusal } from './transport.js';

/**
 * The OAuth `client_name` under which a delegate's key signs in, on every host.
 *
 * See the file header: the relay puts this string inside the agent DID. It is deliberately not
 * the name of any application — an app is where a delegate is running, not who it is.
 */
export const DELEGATE_SURFACE = 'interego-delegate';

/** One agent a pod delegates, as that pod's own registry reports it. */
export interface Delegate {
  readonly agentId: string;
  /** The name its delegator gave it, or null when the row is not a delegate row. */
  readonly name: string | null;
  readonly scope: string | null;
  readonly label: string | null;
  readonly validFrom: string | null;
  /** True when this row's label marks it as a workspace delegate rather than some other agent. */
  readonly isDelegate: boolean;
  /** Whether the relay would let it publish at all, from the scope alone. */
  readonly writeEligible: boolean;
}

/**
 * Every agent a pod delegates, split into the ones that are workspace delegates and the rest.
 *
 * ★ `read: false` IS NOT AN EMPTY ROSTER. A registry that could not be read says nothing about
 * how many delegates somebody has, and a UI that drew "no delegates" from a failed read would be
 * making a statement about their pod from a call that did not happen.
 */
export interface DelegateRoster {
  readonly podName: string;
  readonly read: boolean;
  readonly rows: readonly Delegate[];
  readonly delegates: readonly Delegate[];
  /** Rows that are agents but not delegates — a Discord conduit, another client's session. */
  readonly others: readonly Delegate[];
  readonly why: string | null;
}

const rowOf = (r: Record<string, unknown>): Delegate => {
  const label = typeof r['label'] === 'string' ? r['label'] : null;
  const scope = typeof r['scope'] === 'string' ? r['scope'] : null;
  const name = parseDelegateLabel(label);
  return {
    agentId: String(r['agentId'] ?? ''),
    name, label, scope,
    validFrom: typeof r['validFrom'] === 'string' ? r['validFrom'] : null,
    isDelegate: name !== null,
    writeEligible: (WRITE_ELIGIBLE_SCOPES as readonly string[]).includes(scope ?? ''),
  };
};

/**
 * Read a pod's delegates from the pod itself.
 *
 * ★ THE POD IS THE ROSTER, AND AN APP'S KEYCHAIN IS NOT. `register_agent` is own-pod gated, so
 * these rows are a document only the pod owner can write — which makes them the authority on who
 * that person has authorised. An app that listed the delegates it happened to hold keys for would
 * be answering a different question ("which of these can I drive from here") and drawing it as if
 * it were this one.
 *
 * `cache: false`, like every other authorization read in this package: a delegation revoked
 * ninety seconds ago must not still be listed.
 */
export async function readDelegates(client: WorkspaceClient, podName: string): Promise<DelegateRoster> {
  const none = (why: string): DelegateRoster => ({ podName, read: false, rows: [], delegates: [], others: [], why });
  let status: Record<string, unknown> | null;
  try { status = await client.tool('get_pod_status', { pod_name: podName }, { cache: false }) as Record<string, unknown> | null; }
  catch (e) { return none('pod ' + podName + '\'s delegation registry could not be read (' + errorCopy(e).t.toLowerCase() + '), so how many delegates it lists is not established'); }
  const bad = refusal(status);
  if (bad) return none('the read of pod ' + podName + ' was refused: ' + String(bad['message'] ?? bad['error']));
  const reg = status?.['delegationRegistry'] as { rows?: readonly Record<string, unknown>[] } | null | undefined;
  if (!reg) return none('pod ' + podName + ' reports no delegation registry at all, which is different from it delegating nothing');
  const rows = (Array.isArray(reg.rows) ? reg.rows : []).map(rowOf).filter((r) => r.agentId !== '');
  return {
    podName, read: true, rows,
    delegates: rows.filter((r) => r.isDelegate),
    others: rows.filter((r) => !r.isDelegate),
    why: null,
  };
}

/**
 * The exact `register_agent` call that seats a delegate, described before it is made.
 *
 * Shaped as a {@link DelegationPlan} so `publishDelegation` runs it — the same
 * publish-then-read-the-pod-back path the Discord link uses, rather than a second one that
 * reports success from the relay's own acknowledgement.
 *
 * ★ THE SCOPE IS THE DELEGATOR'S CHOICE AND IS NOT DEFAULTED TO THE WIDEST. `ReadWrite` would
 * let this delegate do everything the person can, which is precisely what a delegate is not for.
 * `PublishOnly` is the narrowest scope that can still write an entry.
 */
export function delegatePlan(args: {
  readonly agentId: string;
  readonly name: string;
  readonly scope?: DelegationScope;
}): DelegationPlan {
  const problems: { field: 'agentId' | 'discordUserId' | 'scope'; why: string }[] = [];
  const agentId = args.agentId.trim();
  const name = args.name.trim();
  if (!agentId) problems.push({ field: 'agentId', why: 'This delegate has no agent id yet. Mint or import a delegate key first — the id is derived from that key and cannot be typed in.' });
  else if (!AGENT_ID_RX.test(agentId)) problems.push({ field: 'agentId', why: 'That is not the shape of an agent id. A delegate\'s looks like `did:web:…:agents:' + DELEGATE_SURFACE + '-u-eth-…`.' });
  const nameProblem = delegateNameProblem(name);
  // `agentId` rather than a new field: `LinkProblem` names the three fields a delegation form
  // has, and a fourth would make the plan type mean two different things depending on who built
  // it. The name IS part of this agent's row, and a UI shows the sentence, not the field name.
  if (nameProblem) problems.push({ field: 'agentId', why: nameProblem });
  const scope: DelegationScope = args.scope ?? 'PublishOnly';
  const label = delegateLabel(name);
  return {
    problems,
    call: problems.length ? null : { tool: 'register_agent', args: { agent_id: agentId, scope, label } },
    limits: [
      'This publishes one row on YOUR pod naming one agent. It is a delegate acting for you — not you, and not any of your other delegates.',
      'Entries it writes land on your pod and in your log, and they name IT as the author and YOU as the person it acted for. A reader can tell them apart from something you typed, and so can you.',
      scope === 'PublishOnly'
        ? 'PublishOnly is POD-WIDE. The substrate has no per-graph delegation scope, so this delegate could publish any graph to your pod, not only workspace entries. What bounds it is that it is one named agent, every write is attributed to it, and you can withdraw it alone.'
        : 'Scope ' + scope + ' is POD-WIDE and wider than PublishOnly. Whatever it permits, this delegate may do on your whole pod.',
      'The label "' + label + '" is public, and is meant to be. Delegation rows are world-readable; the name is how you and everybody reading the channel tell this delegate from your others. There is nothing in it to steal.',
      'Revoking it is your unilateral act from your own client, and it does not need the delegate to cooperate or even to be running.',
      // Measured, in delegation.ts's header. Repeating it at the moment of consent rather than
      // in a document nobody opens is the point of showing a plan at all.
      'For up to 60 seconds after a revoke the relay may still accept a write it had already cached permission for. This client re-asks before every write and stops itself, but the relay alone is not the boundary.',
    ],
  };
}

/**
 * The agent id a delegate key resolves to, computed rather than waited for.
 *
 * The pod segment is a function of the key and {@link DELEGATE_SURFACE} is fixed, so a host that
 * holds a key can say which row on the pod is about it — and can show a person the id they are
 * being asked to authorise before anything signs in.
 */
export const delegateAgentId = (identityHost: string, podName: string): string =>
  'did:web:' + identityHost + ':agents:' + DELEGATE_SURFACE + '-' + podName;

/** The two ceilings a delegate's write has to clear, and which one refused. */
export interface DelegateCeiling {
  readonly ok: boolean;
  readonly why: string;
}

/**
 * May this delegate append to its delegator's log in this workspace?
 *
 * ★ TWO CEILINGS, BOTH NARROWING, NEITHER GRANTING.
 *
 *   1. THE WORKSPACE'S, on the person. A role is a ceiling the workspace publishes and the
 *      delegate inherits it UNCHANGED — a delegate of a member cannot be more of a member than
 *      the member. This is the same test the person's own post passes, on the same seat.
 *   2. THE DELEGATOR'S, on this delegate. The scope on this delegate's own registry row is the
 *      only thing a person controls PER DELEGATE, and it is what "withheld from it" means here:
 *      a delegate given `ReadOnly` cannot post even though its delegator can, and its sibling
 *      delegate given `PublishOnly` still can.
 *
 * ★ AND WHAT IS DELIBERATELY NOT CLAIMED. The role table permits capability IRIs, and nothing
 * published maps a delegation scope onto them — `applications/shared-workspace/src/can.ts` maps
 * scopes onto the DEFAULT profile's capability IRIs, which a workspace publishing its own profile
 * does not use. So the two ceilings are applied SEQUENTIALLY, exactly as `canAct` does, and this
 * does not pretend to intersect two capability sets that are not in the same vocabulary.
 */
export function delegateCeiling(args: {
  readonly roles: RoleTable;
  /** The role on the DELEGATOR's seat. */
  readonly role: string | null;
  /** The scope on this delegate's row, or null when the registry did not report one. */
  readonly scope: string | null;
  readonly delegateName: string | null;
}): DelegateCeiling {
  const who = args.delegateName ? '"' + args.delegateName + '"' : 'this delegate';
  const role = checkRoleForWorkspace(args.roles, args.role ?? '');
  if (!role.ok) {
    return {
      ok: false,
      why: 'The role ceiling on the seat ' + who + ' would write under refuses this. ' + role.why
        + ' A delegate inherits its delegator\'s role and cannot exceed it, so nothing is written.',
    };
  }
  if (args.scope === null) {
    // Absence is not evidence. A row whose scope this reader could not see is not a row that
    // grants nothing AND not a row that grants everything — it is a question, and a question is
    // not permission.
    return {
      ok: false,
      why: 'Your pod\'s registry row for ' + who + ' reports no scope, so what you delegated to it is not established. '
        + 'That is not the same as it being permitted, so nothing is written.',
    };
  }
  if (!(WRITE_ELIGIBLE_SCOPES as readonly string[]).includes(args.scope)) {
    return {
      ok: false,
      why: 'You delegated ' + who + ' with scope ' + args.scope + ', which cannot publish. The relay would refuse the '
        + 'write, and this refuses it first. Widen the delegation on your own pod if you meant it to be able to write.',
    };
  }
  return {
    ok: true,
    why: 'The seat\'s role permits this, and you delegated ' + who + ' scope ' + args.scope + ', which may publish. '
      + 'Both ceilings hold; neither of them granted anything on its own.',
  };
}

/**
 * WHO WROTE AN ENTRY, read out of its signed region.
 *
 * `unstated` is a real answer and a UI must render it as one: an entry that names no author is
 * not an entry the pod owner wrote, it is an entry that does not say. Absence is not evidence.
 */
export type EntryAuthorship =
  | { readonly kind: 'unstated'; readonly why: string }
  | { readonly kind: 'principal'; readonly webId: string }
  | {
      readonly kind: 'delegate';
      readonly agentId: string;
      readonly onBehalfOf: string;
      /** The name their pod's registry gives it, when the registry was read and lists it. */
      readonly name: string | null;
      /**
       * Does the delegator's own pod list this agent?
       *
       * THREE VALUES. `null` is "the registry was not read", which is not "no" — an entry whose
       * authorisation could not be checked must not render as an unauthorised one.
       */
      readonly authorised: boolean | null;
      readonly scope: string | null;
    }
  | { readonly kind: 'disputed'; readonly why: string };

/**
 * Read the authorship of one entry.
 *
 * ★ THE ONE CHECK THAT MAKES THIS WORTH ANYTHING. The entry sits in a log on its author's own
 * pod and its bytes are theirs — so `prov:wasAttributedTo` is a CLAIM, and a member could name
 * anybody in it. What holds it down is the pair of documents around it: the entry must say the
 * agent acted for the pod's own OWNER, and that owner's own delegation registry — a document
 * only they can write — must list the agent. Neither can be manufactured by a third party, and
 * where they disagree the disagreement is reported rather than resolved.
 *
 * `delegates` may be null: this is then answered as far as the entry alone establishes it, with
 * `authorised: null`, rather than not answered at all.
 */
export function readEntryAuthorship(
  region: string | null,
  args: { readonly logOwnerWebId: string | null; readonly delegates: DelegateRoster | null },
): EntryAuthorship {
  if (region === null) {
    return { kind: 'unstated', why: 'the signed region of this entry could not be located, so nothing about its author was read from bytes anybody signed' };
  }
  const attributed = readIriAll(region, 'prov:wasAttributedTo');
  if (attributed.length === 0) {
    return { kind: 'unstated', why: 'this entry names no prov:wasAttributedTo, so who composed it is not stated in the record — which is not the same as the pod owner having written it' };
  }
  if (attributed.length > 1) {
    return { kind: 'disputed', why: 'this entry names ' + attributed.length + ' different prov:wasAttributedTo authors (' + attributed.join(', ') + '), so who wrote it is not decided and this reader will not pick one' };
  }
  const author = attributed[0] as string;
  const behalf = readIriAll(region, 'prov:actedOnBehalfOf');

  if (!args.logOwnerWebId) {
    return { kind: 'disputed', why: 'this entry is attributed to ' + author + ' and this reader could not establish whose log it is in, so whether that is the owner or somebody acting for them is not decided' };
  }
  if (author === args.logOwnerWebId) {
    if (behalf.length) {
      return { kind: 'disputed', why: 'this entry is attributed to the pod owner and ALSO carries a prov:actedOnBehalfOf statement naming ' + behalf.join(', ') + '. A person does not act on their own behalf through themselves, so what this record is saying is not established.' };
    }
    return { kind: 'principal', webId: author };
  }
  if (behalf.length === 0) {
    return { kind: 'disputed', why: 'this entry is attributed to ' + author + ', which is not the owner of the pod it is on (' + args.logOwnerWebId + '), and it states no prov:actedOnBehalfOf. So it claims an author who is neither the log\'s owner nor declared to be acting for them.' };
  }
  if (behalf.length > 1) {
    return { kind: 'disputed', why: 'this entry carries ' + behalf.length + ' prov:actedOnBehalfOf statements (' + behalf.join(', ') + '), so who ' + author + ' was acting for is not decided' };
  }
  const principal = behalf[0] as string;
  if (principal !== args.logOwnerWebId) {
    return { kind: 'disputed', why: 'this entry says ' + author + ' acted on behalf of ' + principal + ', and the pod this log is on belongs to ' + args.logOwnerWebId + '. An entry in somebody\'s log declaring it was written for a third party is not something this reader will render as either of them speaking.' };
  }
  const row = args.delegates?.read ? args.delegates.rows.find((r) => r.agentId === author) ?? null : null;
  return {
    kind: 'delegate',
    agentId: author,
    onBehalfOf: principal,
    name: row?.name ?? null,
    authorised: args.delegates?.read ? row !== null : null,
    scope: row?.scope ?? null,
  };
}

/**
 * The short label a surface puts beside an entry, so every surface says the same thing.
 *
 * ★ THE INTERESTING CASES ARE THE ONES A NAME CANNOT CARRY. "Unstated" and "disputed" both have
 * to read as what they are; a shell that reduced them to a person's name would be inventing one.
 * The long sentence for those two is on the authorship value itself, in `why`.
 */
export function authorshipLine(a: EntryAuthorship, args: { readonly displayName?: string | null } = {}): string {
  const who = args.displayName ? args.displayName : 'the person whose pod this is';
  switch (a.kind) {
    case 'principal': return who;
    case 'delegate': return (a.name ? a.name : 'an unnamed delegate') + ', acting for ' + who;
    case 'unstated': return 'author not stated';
    case 'disputed': return 'authorship disputed';
  }
}

export { DELEGATE_LABEL_PREFIX, DELEGATE_NAME_MAX, delegateLabel, delegateNameProblem, parseDelegateLabel } from './delegates-name.js';
