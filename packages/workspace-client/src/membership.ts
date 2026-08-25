/**
 * MEMBERSHIP: create, invite, verify, accept, revoke, and "which workspaces am I in".
 *
 * Four flows, no new relay verb between them. Everything here is `publish_context`,
 * `notify_agent`, `read_inbox`, `resolve_webfinger`, `discover_context`, `get_current_head` and
 * `get_descriptor` — the same tools the channel already reads with.
 *
 * ★ A SEAT IS TWO DOCUMENTS ON TWO PODS WITH TWO DIFFERENT OWNERS, and the substrate refuses
 * either party the other's pod, so neither half can be manufactured by the party that benefits
 * from it. Measured backstop: publishing with `pod_name` set to somebody else's pod is refused
 * 403 scope_violation, "agent is not registered on this pod" — which stops a convener writing
 * an invitee's acceptance for them exactly as it stops the reverse.
 *
 * ★ AND AN INBOX ITEM IS AN UNVERIFIED CLAIM. The inbox is world-writable — measured: a fresh
 * wallet with no prior relationship delivered into another account's inbox. The ONLY thing ever
 * taken out of it is a URL; everything rendered comes from the `/ns/<owner>/` document at the
 * end of that URL, whose owner segment the relay's own route makes authority-closed.
 *
 * Nothing here draws. Every function returns a verdict with the checks that produced it, and a
 * shell renders them — which is why the artifact and the desktop cannot disagree about who is
 * a member.
 */

import { visibilityFor, type WorkspaceDoc } from './visibility.js';
import { acceptanceTurtle, grantTurtle, rolesTurtle, shapesTurtle, workspaceTurtle } from './documents.js';
import type { Check } from '@interego/core/delegate';
import {
  nsIri, parseAcceptanceIri, podOfDescriptorUrl, podOfNsIri, podOfWebid, POD_RX, qualifiedName,
  slugProblem, type Naming,
} from './naming.js';
import { graphRegion, hasTrue, isRetracted, MODAL_RETRACTED, readIri, readModalStatus } from './turtle.js';
import { fail, refusal } from './transport.js';
import { recipientReach, type RecipientReach } from './recipients.js';
import { assertPod, errorCopy, type HeadResult, type WorkspaceClient } from './substrate.js';

/**
 * One line of evidence behind a verdict — THE SUBSTRATE'S, re-exported, not declared here.
 *
 * It was declared in this file, which meant `@interego/core`'s own `DelegationVerdict` had to type
 * its findings with a workspace module's interface — the layer below depending on the layer above
 * to describe its own answers. The definition, and the reason `q` is a third value rather than a
 * failure, are in `@interego/core/delegate`.
 */
export type { Check };

/** Everything a client knows about the viewer, read from `get_pod_status`. */
export interface Viewer {
  readonly podName: string;
  readonly podUrl: string;
  readonly displayName: string | null;
  readonly css: string;
  readonly webId: string;
  readonly agentDid: string | null;
  readonly agentScope: string | null;
}

/**
 * Read the viewer out of `get_pod_status`.
 *
 * ★ THE POD SEGMENT, TAKEN FROM THE POD URL — never `displayName`, which is a label the account
 * chose. Using a display name as a pod name addresses a pod that does not exist, and that reads
 * back as an EMPTY LOG rather than as an error, which is the confident falsehood this whole
 * client exists not to make. An empty segment is refused here rather than used.
 */
export async function readViewer(client: WorkspaceClient): Promise<Viewer> {
  const status = await client.podStatus();
  const registry = status['registry'] as { owner?: string } | undefined;
  const delegation = status['delegationRegistry'] as { owner?: string } | undefined;
  const agent = status['sessionAgent'] as { did?: string; scope?: string } | undefined;
  const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
  const podName = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
  if (!podName) {
    throw fail('tool_error', 'get_pod_status answered without a pod URL this reader could turn into a pod name, so there is no address to write to.');
  }
  return {
    podName,
    podUrl,
    displayName: (status['displayName'] as string) ?? null,
    css: String(status['css'] ?? ''),
    webId: registry?.owner ?? delegation?.owner ?? '',
    agentDid: agent?.did ?? null,
    agentScope: agent?.scope ?? null,
  };
}

/** The handle a second person needs, composed from the two things a client already holds. */
export const composedHandle = (relay: string, podName: string): string =>
  'acct:' + podName + '@' + new URL(relay).host;

/**
 * The viewer's own handle, COMPOSED and then actually RESOLVED.
 *
 * This identifier is the one step of joining that happens outside the fabric, and a wrong one
 * costs the OTHER person: their end fails with a 404 and this end says nothing. One read, about
 * the viewer's own name, so it costs nothing anybody else can see.
 */
export async function checkOwnHandle(
  client: WorkspaceClient, relay: string, podName: string,
): Promise<{ readonly handle: string; readonly ok: boolean; readonly why: string; readonly subject?: string; readonly errored?: boolean }> {
  const handle = composedHandle(relay, podName);
  let wf: Record<string, unknown> | null;
  try { wf = await client.tool('resolve_webfinger', { resource: handle }) as Record<string, unknown> | null; }
  catch (e) {
    return { handle, ok: false, errored: true, why: 'the resolve_webfinger check on it did not complete (' + errorCopy(e).t + '), so whether it resolves to you is not established here' };
  }
  const bad = refusal(wf);
  if (bad) return { handle, ok: false, why: 'the relay refused the lookup: ' + String(bad['message'] ?? bad['error']) };
  const subject = (wf?.['subject'] as string) ?? null;
  const links = (wf?.['links'] as readonly { rel?: string; href?: string }[]) ?? [];
  const profile = links.find((l) => /profile-page/.test(l.rel ?? ''));
  // The pod the PROFILE names. The `webId` WebFinger returns is deliberately not used: it is
  // the relay's agent URL, which `podOfWebid` does not resolve — see `resolveInvitee`.
  const pod = profile?.href ? (podOfDescriptorUrl(profile.href) ?? profile.href.replace(/\/$/, '').split('/').pop() ?? null) : null;
  if (!subject) return { handle, ok: false, why: 'the response echoed no subject, so what it answered about is not established.' };
  if (!pod) return { handle, ok: false, why: 'the response carried no profile-page link, so which pod it names is not established.' };
  if (pod !== podName) return { handle, ok: false, why: 'it resolves to pod ' + pod + ', and the pod you write to is ' + podName + '.' };
  return {
    handle, ok: true, subject,
    why: 'the relay echoed subject ' + subject + ' and its profile-page link names pod ' + pod
      + ', which is the pod you write to. So this is a composed name that was then read back, not a guess.',
  };
}

/**
 * Whether the relay will let this viewer write to their own pod at all.
 *
 * A relay VERDICT, not a guess: nothing here maps a scope name onto a permission, it reads the
 * boolean the relay returned and says which boolean it read. When it is `false`, every write
 * control is withdrawn — a write would be refused, so it is not offered.
 */
export interface WriteVerdict {
  readonly tried: true;
  readonly enforcement: Record<string, unknown> | null;
  readonly verified: boolean | null;
  /** Non-null when writing must not be offered. The sentence a shell shows. */
  readonly blocked: string | null;
  /** Why nothing was established, when nothing was. */
  readonly why: string | null;
}

export async function checkWriteEligibility(client: WorkspaceClient, viewer: Viewer): Promise<WriteVerdict> {
  if (!viewer.agentDid) {
    return { tried: true, enforcement: null, verified: null, blocked: null, why: 'get_pod_status reported no session agent DID, so there is no agent to ask verify_agent about' };
  }
  let p: Record<string, unknown> | null;
  // No cache: this is an authorization verdict, and serving a stale one for two minutes is
  // exactly how a withdrawn delegation keeps looking live.
  try { p = await client.tool('verify_agent', { agent_id: viewer.agentDid, pod_url: viewer.podUrl }, { cache: false }) as Record<string, unknown> | null; }
  catch (e) {
    return { tried: true, enforcement: null, verified: null, blocked: null, why: 'verify_agent did not answer (' + errorCopy(e).t.toLowerCase() + '), so nothing is claimed about your delegation' };
  }
  const bad = refusal(p);
  if (bad) return { tried: true, enforcement: null, verified: null, blocked: null, why: 'verify_agent was refused: ' + String(bad['message'] ?? bad['error']) };
  const enf = (p?.['enforcement'] as Record<string, unknown>) ?? null;
  const verified = p && 'verified' in p ? (p['verified'] as boolean) : null;
  if (!enf) {
    return { tried: true, enforcement: null, verified, blocked: null, why: 'the relay answered without an enforcement block, so what it grants your session agent is not established here' };
  }
  const blocked = enf['writeEligible'] === false
    ? 'The relay reports your session agent is not write-eligible on this pod (basis ' + String(enf['basis'])
      + ', scope ' + String(enf['scope'] ?? 'not reported') + '). ' + String(enf['note'] ?? '')
      + ' A write would be refused, so it is not offered.'
    : null;
  return { tried: true, enforcement: enf, verified, blocked, why: null };
}

// ── Flow A: create a workspace ───────────────────────────────────────────────

/** Which of the five documents a create is on, and how that one ended. */
export interface CreateStep {
  readonly label: string;
  readonly iri: string;
  readonly state: 'sending' | 'accepted' | 'readable' | 'pending' | 'refused' | 'failed';
  readonly detail: string;
}

export type CreateOutcome =
  | { readonly kind: 'created'; readonly workspace: string; readonly shapeIri: string; readonly rolesIri: string; readonly grantIri: string; readonly acceptanceIri: string; readonly streamIri: string; readonly grantCid: string | null; readonly seated: boolean; readonly why: string | null }
  | { readonly kind: 'invalid'; readonly why: string }
  | { readonly kind: 'error'; readonly at: string; readonly error: unknown; readonly done: readonly string[] }
  | { readonly kind: 'refused'; readonly at: string; readonly refusal: Record<string, unknown>; readonly done: readonly string[] }
  /** A document the relay took and did not report readable. Everything after it names it. */
  | { readonly kind: 'stalled'; readonly at: string; readonly why: string; readonly done: readonly string[] };

/**
 * FIVE DOCUMENTS, ON THE CREATOR'S OWN POD, IN ORDER — each waiting for the last to be READABLE
 * because each names the one before it.
 *
 * Nothing is created anywhere else and no other party is touched. The order is not cosmetic: a
 * write whose `conforms_to_shapes` names a document that does not resolve yet is REFUSED by the
 * relay rather than published unvalidated, so "not readable yet" has to stop the sequence.
 */
export async function createWorkspace(
  client: WorkspaceClient,
  args: {
    readonly relay: string;
    readonly viewer: Viewer;
    readonly title: string;
    readonly slug: string;
    /**
     * Public (the default) or encrypted to this workspace's seated members.
     *
     * ★ DEFAULTS TO PUBLIC AND IS NOT INFERRED. A caller that omits this gets the behaviour every
     * existing workspace has, which is the only safe reading — see `wsp:visibility`, where the
     * same decision is made on the reading side.
     */
    readonly visibility?: 'public' | 'private';
    /**
     * The convener's own X25519 public key, published in their founding acceptance.
     *
     * ★ WITHOUT IT THE CONVENER IS PERMANENTLY `keysMissing`, and because a missing key withholds
     * the WHOLE key list, nobody in the workspace could ever seal anything. The founder is the one
     * member who cannot be invited later, so this is the only chance to record theirs.
     */
    readonly encryptionKey?: string;
    readonly onStep?: (s: CreateStep) => void;
  },
): Promise<CreateOutcome> {
  const problem = slugProblem(args.slug);
  if (problem) return { kind: 'invalid', why: problem };
  if (!args.title.trim()) return { kind: 'invalid', why: 'Type a title.' };
  const pod = args.viewer.podName;
  const me = args.viewer.webId;
  if (!me) {
    return { kind: 'invalid', why: 'get_pod_status returned no registry owner for your pod, so there is no WebID to name as convener. Nothing was written.' };
  }

  const workspace = nsIri(args.relay, pod, args.slug);
  const shapeIri = nsIri(args.relay, pod, args.slug + '-shapes');
  const rolesIri = nsIri(args.relay, pod, args.slug + '-roles');
  const grantIri = workspace + '-grant-' + pod;
  const acceptanceIri = nsIri(args.relay, pod, qualifiedName(pod, args.slug, 'acceptance'));
  const streamIri = nsIri(args.relay, pod, qualifiedName(pod, args.slug, 'stream'));

  const done: string[] = [];
  const publish = async (
    label: string, iri: string, content: string, shapes?: readonly string[], docClass: WorkspaceDoc = 'record',
  ): Promise<{ readonly ok: true; readonly readable: boolean; readonly why: string | null; readonly head: HeadResult | undefined } | { readonly ok: false; readonly out: CreateOutcome }> => {
    const publishArgs: Record<string, unknown> = {
      graph_iri: iri, graph_content: content, visibility: visibilityFor(docClass, args.visibility ?? 'public'),
      auto_supersede_prior: true, sign_authorship: true,
    };
    if (shapes) publishArgs['conforms_to_shapes'] = shapes.slice();
    const res = await client.publishAndConfirm(publishArgs, pod, iri, (state, detail) => {
      args.onStep?.({ label, iri, state: state as CreateStep['state'], detail });
    });
    if (res.error) return { ok: false, out: { kind: 'error', at: label, error: res.error, done: done.slice() } };
    if (res.refusal) return { ok: false, out: { kind: 'refused', at: label, refusal: res.refusal as Record<string, unknown>, done: done.slice() } };
    done.push(label);
    return { ok: true, readable: !!res.readable, why: res.why ?? null, head: res.head };
  };

  let step = await publish('shape contract', shapeIri, shapesTurtle(shapeIri), undefined, 'shape');
  if (!step.ok) return step.out;
  if (!step.readable) {
    return { kind: 'stalled', at: 'shape contract', done: done.slice(),
      why: (step.why ?? '') + ' Everything after this names it, and a name that does not resolve makes the relay refuse the write rather than publish it unvalidated.' };
  }

  step = await publish('role table', rolesIri, rolesTurtle(rolesIri), undefined, 'roles');
  if (!step.ok) return step.out;
  if (!step.readable) return { kind: 'stalled', at: 'role table', why: step.why ?? '', done: done.slice() };

  step = await publish('workspace record', workspace,
    workspaceTurtle({ workspace, title: args.title, convenerWebId: me, rolesIri, shapeIri,
      ...(args.visibility === 'private' ? { visibility: 'private' as const } : {}) }), [shapeIri], 'record');
  if (!step.ok) return step.out;
  if (!step.readable) return { kind: 'stalled', at: 'workspace record', why: step.why ?? '', done: done.slice() };

  /**
   * ★★ `'grant'`, NOT THE DEFAULT `'record'`. These two call sites took the default docClass, so in
   * a private workspace they published as `'shared'` — sealed to the convener alone — and every
   * other member's fold then reported the convener as NOT SEATED, with "the signed region of this
   * grant could not be located". Measured live: B's roster showed one seat, its pod `null`.
   * `visibilityFor` maps grants and acceptances to public for exactly this reason; it only gets to
   * apply if it is told what kind of document this is.
   */
  step = await publish('your own grant', grantIri,
    grantTurtle({ grant: grantIri, workspace, granteeWebId: me, role: rolesIri + '#Convener' }), [shapeIri], 'grant');
  if (!step.ok) return step.out;
  if (!step.readable) return { kind: 'stalled', at: 'your own grant', why: step.why ?? '', done: done.slice() };
  const head = step.head;
  const grantCid = head && !head.forked ? head.cid : null;

  step = await publish('your acceptance', acceptanceIri,
    acceptanceTurtle({
      acceptance: acceptanceIri, workspace, memberWebId: me, grant: grantIri, grantCid, stream: streamIri,
      ...(args.encryptionKey ? { encryptionKey: args.encryptionKey } : {}),
    }), [shapeIri], 'acceptance');
  if (!step.ok) return step.out;

  return {
    kind: 'created', workspace, shapeIri, rolesIri, grantIri, acceptanceIri, streamIri, grantCid,
    seated: step.readable, why: step.readable ? null : step.why,
  };
}

// ── Flow B: invite ───────────────────────────────────────────────────────────

/** What resolving an invitee's handle established, and what it did not. */
export interface InviteeResolution {
  readonly handle: string;
  readonly checks: readonly Check[];
  readonly pod: string;
  readonly podUrl: string;
  readonly webId: string;
  readonly inbox: string | null;
  readonly agents: number;
  /** Non-null when a grant naming this WebID would seat nobody, so nothing should be written. */
  readonly blocked: string | null;
}

/**
 * The invitee's REAL WebID, and the trap that makes this two calls instead of one.
 *
 * ★ MEASURED: `resolve_webfinger` returns `webId: https://relay…/agents/<pod>`, while the pod's
 * own registry returns `https://identity…/users/<pod>/profile#me`. `podOfWebid` resolves the
 * second and not the first, so a grant written with the WebFinger identifier is dropped from
 * every roster as "an identifier this reader cannot resolve to a pod". WebFinger is used here
 * for what it IS good for — does this handle exist, which pod is it, can it receive — and its
 * `webId` is discarded.
 */
export async function resolveInvitee(client: WorkspaceClient, handle: string): Promise<InviteeResolution> {
  const checks: Check[] = [];
  const wf = await client.tool('resolve_webfinger', { resource: handle }) as Record<string, unknown> | null;
  const bad = refusal(wf);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  const links = (wf?.['links'] as readonly { rel?: string; href?: string }[]) ?? [];
  const profile = links.find((l) => /profile-page/.test(l.rel ?? ''));
  const inbox = links.find((l) => /ldp#inbox/.test(l.rel ?? ''));
  if (!profile?.href) {
    throw fail('tool_error', 'WebFinger answered for ' + handle + ' without a profile-page link, so this reader cannot find their pod.');
  }
  const podUrl = profile.href;
  const pod = podOfDescriptorUrl(podUrl) ?? podUrl.replace(/\/$/, '').split('/').pop() ?? '';
  checks.push({ mark: 'y', text: 'WebFinger resolves ' + handle + ' to pod ' + pod });
  // ★ THE FACT THE CHECK SUPPORTS, NOT AN ADDRESS TO EYEBALL. MEASURED: the inbox href
  // WebFinger returns is the cluster-internal storage host (css.railway.internal). That is
  // correct as canonical signed bytes and it is not something a person reading this can fetch —
  // and this is the one place a human is asked to look at an identifier belonging to SOMEBODY
  // ELSE before granting them a seat. So what is stated is what was established: that they
  // advertise one.
  checks.push(inbox?.href
    ? { mark: 'y', text: 'They advertise an LDN inbox, so a notification has somewhere to go',
        detail: 'The address WebFinger returned is ' + inbox.href + ' — the relay\'s own internal storage host. It is what the relay routes on and it is not reachable from outside the fleet, so it is not offered here as something to check.' }
    : { mark: 'q', text: 'WebFinger reported no ldp#inbox link, so whether a notification can be delivered is not established' });
  const webfingerWebId = (wf?.['webId'] as string) ?? null;

  const st = await client.tool('get_pod_status', { pod_url: podUrl }) as Record<string, unknown> | null;
  const sbad = refusal(st);
  if (sbad) throw fail('tool_error', String(sbad['message'] ?? sbad['error']));
  /**
   * ★★ THE ECHO IS CHECKED, like every other cross-pod read in this package — `readMember`
   * (delegation.ts) states the rule in the same words, `foldRoster` calls `assertPod` on its one
   * cross-pod scan, and this call had none.
   *
   * The whole value of this function is one sentence: "pod P's own registry says P is owned by
   * WebID W". A relay that answered about a DIFFERENT pod makes that sentence false while every
   * field in it still looks well formed, and the WebID it hands back belongs to somebody else.
   * DRIVEN on the repair path below: asked about `u-ghost`, answered about the convener, and the
   * invite came back `invited` with `share_with` naming the convener twice and `u-ghost` nowhere
   * — under `auto_supersede_prior`, which retires the revision `u-ghost` needs in order to
   * accept. Success reported, membership gone.
   *
   * ★ NOT REPORTED IS NOT A MISMATCH — that is `assertPod`'s own rule and it is kept, because
   * the relay may legitimately omit the field and refusing on its absence would refuse every
   * invite. The ownership check below is the half that does not depend on the relay volunteering
   * anything: `podOfWebid(webId) === pod` is read out of the WebID itself.
   */
  assertPod(pod, st?.['pod'], 'get_pod_status');
  // ★ MEASURED TRAP: `sessionAgent` on a cross-pod status call is still the CALLER'S agent, not
  // theirs. It is not read.
  const registry = st?.['registry'] as { owner?: string } | undefined;
  const delegation = st?.['delegationRegistry'] as { owner?: string; rows?: readonly unknown[] } | undefined;
  const webId = registry?.owner ?? delegation?.owner ?? null;
  if (!webId) throw fail('tool_error', 'That pod\'s registry did not report an owner, so there is no WebID to grant to.');
  checks.push({ mark: 'y', text: 'Their pod\'s own registry names owner ' + webId });
  if (webfingerWebId && webfingerWebId !== webId) {
    checks.push({ mark: 'q', text: 'WebFinger names a different identifier for them (' + webfingerWebId
      + '). The grant uses the registry\'s, because that is the one a reader can resolve back to a pod.' });
  }
  const rows = delegation?.rows ?? [];
  checks.push(rows.length
    ? { mark: 'y', text: rows.length + ' agent' + (rows.length === 1 ? '' : 's') + ' delegated on their pod, so something there can act for them' }
    : { mark: 'q', text: 'Their delegation registry lists no agents, so nothing is currently able to write on their behalf' });

  let blocked: string | null = null;
  if (podOfWebid(webId) !== pod) {
    blocked = 'the WebID their pod reports does not resolve back to that pod';
    checks.push({ mark: 'n', text: 'Their registry owner does not resolve back to pod ' + pod + ', so a grant naming it would not seat them. Nothing was published.' });
  }
  return { handle, checks, pod, podUrl, webId, inbox: inbox?.href ?? null, agents: rows.length, blocked };
}

/** What a notification attempt reported. Never collapsed into "sent". */
export interface NotifyReport {
  readonly attempted: boolean;
  readonly delivered: boolean;
  readonly line: string;
}

export type InviteOutcome =
  | { readonly kind: 'blocked'; readonly resolution: InviteeResolution }
  | { readonly kind: 'resolve-failed'; readonly error: unknown }
  | { readonly kind: 'error'; readonly error: unknown; readonly resolution: InviteeResolution }
  | { readonly kind: 'refused'; readonly refusal: Record<string, unknown>; readonly resolution: InviteeResolution }
  | {
      readonly kind: 'invited';
      readonly resolution: InviteeResolution;
      readonly grantIri: string;
      readonly readable: boolean;
      readonly why: string | null;
      readonly notify: NotifyReport;
      /**
       * Named recipients the re-seal of the RECORD did not reach, from the publish response.
       *
       * ── ★★ THE EVICTION CLASS, ONE LAYER BELOW THE RECIPIENT LIST ───────────
       *
       * `recipientsFromRoster` decides WHO the record should be sealed to. Whether the relay then
       * resolved a key for each of them is a separate answer, and until now nothing asked for it
       * here: `resolveRecipient` returns an entry with an EMPTY key list rather than an error, so
       * the re-seal succeeds, `auto_supersede_prior` retires the revision the unreached member
       * could read, and the only evidence is `sharedWith[].agentCount` — which `postEntry` and
       * `saveCanvas` have both read for a while and this write did not.
       *
       * Empty for a public workspace, which re-seals nothing, and empty when the response carried
       * no `sharedWith` at all — that is "nothing reported", not "nobody was reached". Read
       * {@link recordReach} to tell those two apart; this list is the STATED half of it, kept
       * because it is what the existing surfaces render.
       */
      readonly recordUnreached: readonly string[];
      /**
       * The whole answer the re-seal's publish response gave about who it reached.
       *
       * ── ★★ THE ONE SURFACE THIS HARM HAS NEVER HAD ──────────────────────────
       *
       * Three shells render `unreached` for entries and canvas saves — the two harms a retry
       * fixes — and none of them renders anything for the reseal, which is the harm that is
       * permanent: a named member the relay resolved no key for is dropped from the record by the
       * same `auto_supersede_prior` that published it, and `verifyGrantIri` reads that record
       * before anybody can accept. The INVITEE's own case is refused before the grant is written
       * (see the gate in `sendInvite`); every OTHER named recipient is reported here and must be
       * shown, because nothing else in the system will mention it again.
       *
       * `established: false` means the relay answered in a shape this client could not read, which
       * is not the same as everyone being reached and must not be rendered as it.
       */
      readonly recordReach: RecipientReach;
    };

/**
 * Publish a grant naming somebody, then tell them where it is.
 *
 * ★ THE NOTIFICATION CARRIES THE GRANT'S IRI, NEVER THE WORKSPACE'S. The recipient takes
 * exactly one thing out of a world-writable inbox — a URL — and everything they then render
 * comes from the `/ns/<owner>/` document at the end of it. The grant is the membership; the
 * notice is only a pointer to it, and this reports the two separately because a failed notice
 * does not un-publish a grant.
 */
/**
 * What one re-seal established.
 *
 * ★ "PUBLISHED" AND "READABLE BY EVERYONE NAMED" ARE DIFFERENT ANSWERS, and collapsing them is the
 * same class of defect the recipient list itself exists for: `resolveRecipient` hands back an entry
 * with an EMPTY key list rather than an error, so naming somebody in `share_with` and reaching them
 * are independent facts and only the response says which happened.
 */
type ResealResult =
  | { readonly kind: 'failed'; readonly outcome: InviteOutcome }
  | {
      readonly kind: 'sealed';
      /** Recipients the relay STATED it resolved no agent for. */
      readonly unreached: readonly string[];
      /**
       * The whole answer, including whether there WAS one.
       *
       * ★★ `unreached` ALONE CANNOT TELL "NOBODY WAS MISSED" FROM "NOTHING WAS REPORTED", and
       * the invitee gate below reads it before writing a grant. See `recipientReach`.
       */
      readonly reach: RecipientReach;
    };

/**
 * Re-publish a private workspace's record so a named set of members can read it.
 *
 * ★ THE CONTENT IS REBUILT FROM WHAT THE RECORD SAYS, NOT COPIED. `workspaceTurtle` is the only
 * thing that has ever written this document, so rebuilding it from the fields just read reproduces
 * it — and rebuilding is what lets this run at all, since the point is to write the same statements
 * to a different audience. If the record could not be READ here, nothing is written: re-sealing a
 * record this client cannot see would replace it with a reconstruction of a document it never
 * examined.
 *
 * Returns the failure that stops the invite, or — when the record was published — WHO IT ACTUALLY
 * REACHED. Those are two answers and this used to give only the first: `null` meant "published",
 * and "published" was read by the caller as "everyone named can read it now". See
 * {@link ResealResult}.
 */
async function resealRecord(
  client: WorkspaceClient,
  args: {
    readonly workspace: string;
    readonly viewer: Viewer;
    readonly entryShape: string | null;
    readonly shareWith: readonly string[];
    /**
     * The invitee, carried only so a failure here reports the same shape every other invite
     * failure does. ★ NOT a `null` cast: a caller reading `out.resolution.checks` off an error
     * would throw, and an invite that fails is exactly when a caller wants those checks.
     */
    readonly resolution: InviteeResolution;
    readonly onState?: (state: string, detail: string) => void;
  },
): Promise<ResealResult> {
  const stop = (outcome: InviteOutcome): ResealResult => ({ kind: 'failed', outcome });
  if (args.shareWith.length === 0) {
    return stop({ kind: 'error', resolution: args.resolution,
      error: new Error('this workspace is private and no members were named to re-seal its record to, so '
        + 'the invitee would not be able to read it and could not accept. Nothing was written.') });
  }
  const owner = podOfNsIri(args.workspace);
  if (!owner) {
    return stop({ kind: 'error', resolution: args.resolution,
      error: new Error('the workspace IRI names no pod this client can read a record from, so its record cannot be re-sealed. Nothing was written.') });
  }
  const rec = await client.readWorkspaceRecord(args.workspace, owner);
  if (rec.kind !== 'record' || !rec.record.regionFound || !rec.record.convener) {
    /**
     * ★ AND THE RELAY'S OWN REASON IS CARRIED OUT, because the caller above this has none of its
     * own. `readWorkspaceRecord` now returns its `{kind:'missing', unreadable:true, message}` arm
     * for a head whose body could not be fetched, where it used to let `descriptor` throw — and a
     * throw out of here reaches `sendInvite`, then `invite()` in the desktop renderer, which
     * awaits it with no `try`: the Invite button never re-enabled and the panel sat on
     * "Resolving <handle>" with nothing said. A typed refusal with the pod's own sentence in it is
     * the difference between that and a person knowing what to do.
     */
    const said = rec.kind === 'missing' || rec.kind === 'forked' ? ' — ' + rec.message : '';
    return stop({ kind: 'error', resolution: args.resolution,
      error: new Error('this workspace is private and its record could not be read here'
        + (rec.kind === 'record' && rec.record.withheld ? ' — it is encrypted and this identity is not among its recipients' : '')
        + said
        + ', so it cannot be re-sealed to include the invitee. Nothing was written.') });
  }
  const rolesIri = rec.record.roleProfile;
  const shapeIri = rec.record.entryShape ?? args.entryShape;
  if (!rolesIri || !shapeIri) {
    return stop({ kind: 'error', resolution: args.resolution,
      error: new Error('the workspace record names no ' + (rolesIri ? 'entry shape' : 'role profile')
        + ', so re-publishing it would drop a term the workspace depends on. Nothing was written.') });
  }
  const publishArgs: Record<string, unknown> = {
    graph_iri: args.workspace,
    graph_content: workspaceTurtle({
      workspace: args.workspace, title: rec.record.title, convenerWebId: rec.record.convener,
      rolesIri, shapeIri, visibility: 'private',
    }),
    visibility: visibilityFor('record', 'private'),
    share_with: args.shareWith.slice(),
    conforms_to_shapes: [shapeIri],
    auto_supersede_prior: true, sign_authorship: true,
  };
  const out = await client.publishAndConfirm(publishArgs, args.viewer.podName, args.workspace,
    (state, detail) => args.onState?.('re-sealing the record · ' + state, detail));
  if (out.error) return stop({ kind: 'error', error: out.error, resolution: args.resolution });
  if (out.refusal) return stop({ kind: 'refused', refusal: out.refusal as Record<string, unknown>, resolution: args.resolution });
  // ★ WHO THE WRITE REACHED, ASKED FOR HERE RATHER THAN LEFT TO THE CALLER. `out.res` is the
  // publish response and has always been returned; nothing read `sharedWith[].agentCount` off it
  // on this path, so a named member the relay resolved no key for was dropped from the record by
  // the very `auto_supersede_prior` above, silently. `postEntry` and `saveCanvas` already read it.
  const reach = recipientReach(out.res);
  return { kind: 'sealed', unreached: reach.unreached, reach };
}

export async function sendInvite(
  client: WorkspaceClient,
  args: {
    readonly viewer: Viewer;
    readonly workspace: string;
    readonly workspaceTitle: string;
    readonly handle: string;
    readonly role: string;
    readonly entryShape: string | null;
    /** The workspace's own policy, from the record this caller already read. */
    readonly visibility?: 'public' | 'private';
    /**
     * Every seated member's WebID, for a PRIVATE workspace. The invitee is added here — the
     * caller does not need to.
     *
     * ★★ WITHOUT THIS A PRIVATE WORKSPACE CAN ADMIT NOBODY, and the measurement is in
     * `drive-private-workspace-live.ts`. See {@link sendInvite}'s note on re-sealing.
     */
    readonly shareWith?: readonly string[];
    /**
     * People who hold a grant but have not accepted yet, from `recipientsFor().pendingWebIds`.
     *
     * ── ★★ OMIT THEM AND A SECOND INVITE EVICTS THE FIRST ─────────────────────
     *
     * A reseal REPLACES the record's recipient set. Invite B, then invite C before B has opened
     * their client, and a recipient list built only from SEATED members re-seals to {A, C} — B is
     * dropped from a record they must read in order to verify the grant written for them. Nothing
     * warns: the roster still shows B as "granted, not accepted", every named recipient resolved,
     * and B's client then refuses B's own invitation with "this identity is not among them".
     *
     * With N outstanding invitations only the most recent could ever be accepted, one at a time.
     */
    readonly pendingWebIds?: readonly string[];
    /**
     * Everybody a standing grant names, from `recipientsFor().grantedWebIds`.
     *
     * ── ★★ A SUPERSET OF `pendingWebIds`, AND THE ONE A RESEAL NEEDS ──────────
     *
     * `pendingWebIds` covers members whose acceptance is genuinely absent. It deliberately does
     * NOT cover members whose acceptance could not be READ — a pod that answered 502, an
     * acceptance pinned to a grant revision since superseded, a forked chain. Those are seated:
     * false and pending: false, and a reseal built from the two lists above dropped every one of
     * them from a record they need in order to accept or re-accept. See `RecipientPlan`.
     *
     * Optional so no caller silently narrows the set by forgetting it; when it is absent the two
     * older lists are used exactly as before.
     */
    readonly grantedWebIds?: readonly string[];
    /**
     * Pods whose GRANT could not be read at all, from `recipientsFor('reseal', …).repairBy`.
     *
     * ── ★★ THE HALF NO WebID EXISTS FOR, AND THE REASON THIS INVITE CAN RUN ───
     *
     * The three lists above are all built from `wsp:grantedTo`, so a grant whose chain is forked,
     * whose head is absent, or whose signed region will not locate contributes to NONE of them —
     * there is nothing readable in it to contribute. Each such row is `seated: false`,
     * `pending: false`, WebID-less, and therefore dropped by the reseal below, from the very
     * document `verifyGrantIri` reads. That is a one-way door: they cannot accept without the
     * record, so they can never become seated again.
     *
     * For a round the answer to that was to REFUSE every write in the workspace whenever any grant
     * went unread — which also refused this call, the only act in the package that republishes a
     * grant and so the only act that collapses a fork, creates a missing head or re-files a lost
     * region. The workspace was read-only for everybody, permanently.
     *
     * ★ SO THE MEMBER IS INCLUDED INSTEAD. A grant's IRI is `<workspace>-grant-<pod>`, so its NAME
     * says whose it is even when its bytes will not read (`podOfGrantGraph`). Each pod here is
     * resolved to a WebID by the same WebFinger + registry lookup this function already performs
     * for the invitee, and unioned into the reseal's audience.
     *
     * Optional, and an absent list is not a claim that there are none — a caller that does not
     * pass it re-seals exactly as it did before.
     */
    readonly repairBy?: readonly { readonly pod: string; readonly why: string }[];
    readonly onState?: (state: string, detail: string) => void;
  },
): Promise<InviteOutcome> {
  let who: InviteeResolution;
  try { who = await resolveInvitee(client, args.handle); }
  catch (e) { return { kind: 'resolve-failed', error: e }; }
  if (who.blocked) return { kind: 'blocked', resolution: who };

  // Empty for a public workspace, which re-seals nothing. See `InviteOutcome`'s field.
  let recordUnreached: readonly string[] = [];
  /**
   * What the re-seal established about who can read the record.
   *
   * ★ `established: true` FOR A PUBLIC WORKSPACE, because there is nothing to establish: no
   * record is re-sealed, no handles are named, and the invitee needs no envelope. Starting it
   * `false` would make the gate below refuse every public invite over a read nobody made.
   */
  let recordReach: RecipientReach = { established: true, unreached: [], unstated: [], named: [], why: null };

  /**
   * ── ★★ A PRIVATE WORKSPACE MUST BE RE-SEALED BEFORE ANYBODY CAN JOIN IT ────
   *
   * An envelope's recipients are fixed when it is written. The workspace RECORD was written at
   * creation, when the only member was its convener — so it is encrypted to the convener alone,
   * and an invitee cannot read it. That is not a cosmetic problem: `verifyGrantIri` reads the
   * record to establish that the grant is on the convener's own pod and names a role the
   * workspace declares. An invitee who cannot read it cannot verify their own grant, cannot
   * accept, and therefore cannot join. Measured live: B's inbox showed the offer and refused it
   * with "this workspace is private and this identity is not among them" — about a grant written
   * FOR B, seconds earlier.
   *
   * So the record is re-published, superseding itself, with the invitee among its recipients.
   *
   * ★ AND IT HAPPENS BEFORE THE GRANT, so the worse failure cannot occur. Re-seal then grant: if
   * the grant fails, one extra person can read a record that seats them in nothing. Grant then
   * re-seal: if the re-seal fails, somebody holds a grant they cannot use and nothing says so.
   */
  if (args.visibility === 'private') {
    /**
     * ── ★★ THE MEMBERS WHOSE GRANT WOULD NOT READ, PUT BACK BY POD ────────────
     *
     * See the `repairBy` parameter. Two calls per pod, bounded by the number of unreadable grants
     * — `resolveInvitee` is reused rather than reimplemented so the pod→WebID step is the same one
     * the invitee goes through, including its measured trap that WebFinger's own `webId` is the
     * wrong identifier and the pod registry's is the right one.
     *
     * ★★ `blocked` IS CONSULTED, AND THE COMMENT SAYING IT NEED NOT BE WAS WRONG ON ALL THREE OF
     * ITS CLAIMS. It read: `blocked` answers "would a grant naming this WebID seat them", a
     * question about a grant nobody is writing here; the answer for a pod is whatever that pod's
     * own registry says owns it; and the exposure is narrow by construction because it needs a
     * registry read that FAILS in the same moment.
     *
     *   · `blocked`'s only assignment is `podOfWebid(webId) !== pod`. It answers "does this WebID
     *     belong to the pod that was asked about" — precisely the question this loop asks, and
     *     the only check that holds the answer against the question.
     *   · "whatever that pod's own registry says" asserted a provenance nothing on this path had
     *     established. The read is `get_pod_status` and, until the echo check now in
     *     `resolveInvitee`, nothing compared the pod that ANSWERED with the pod asked about.
     *   · a registry answering about the WRONG pod does not fail and is not narrow. DRIVEN: asked
     *     about `u-ghost`, answered about the convener — the convener's WebID was unioned into
     *     `share_with`, deduplicated away to nothing, `auto_supersede_prior` retired the revision
     *     `u-ghost` can read, and the invite reported `invited`. Eviction reported as success, on
     *     the one write that costs somebody their membership.
     *
     * So a repair lookup that comes back `blocked` stops the write exactly as one that threw does,
     * and for the same reason: nothing may write a membership document on a read that established
     * nothing about the party it is about.
     */
    const repaired: string[] = [];
    for (const r of args.repairBy ?? []) {
      args.onState?.('re-sealing the record · recovering ' + r.pod, r.why);
      /** One sentence for both failure arms, so a caller cannot be handed two shapes for one act. */
      const cannotRecover = (said: string): InviteOutcome => ({ kind: 'error', resolution: who,
        error: new Error('the grant for pod ' + r.pod + ' in this workspace could not be read (' + r.why
          + '), so that member has to be kept in the record\'s recipients by pod — and this pod could not be '
          + 'resolved to a WebID either: ' + said + '. Re-sealing the record without them would '
          + 'retire the revision they can read, and the record is what a grant is verified against, so they '
          + 'could never accept again. Try the invitation again; if that pod is genuinely gone, republish or '
          + 'revoke its grant first. Nothing was written and nobody was notified.') });
      try {
        const back = await resolveInvitee(client, 'acct:' + r.pod + '@' + new URL(client.relay).host);
        if (back.blocked) return cannotRecover(back.blocked);
        repaired.push(back.webId);
      } catch (e) {
        /**
         * ★★ AND A LOOKUP THAT DID NOT COMPLETE STOPS THE WRITE, because the alternative is the
         * one-way door. This is the rule stated beside `Seat.basis` and quoted at every consumer:
         * nothing may WRITE a membership document on a read that established nothing. Proceeding
         * would re-seal the record without this member and retire the revision they can read, and
         * `verifyGrantIri` reads that record before anybody can accept — so they could never get
         * back in. Refusing costs an invitation that can be sent again.
         *
         * ★ AND IT IS NOT AS NARROW AS THIS USED TO CLAIM. The old sentence said it needs a grant
         * that is permanently unreadable AND a pod whose WebFinger or registry read FAILS in the
         * same moment — which leaves out the case that produced the eviction: a read that does not
         * fail at all and simply answers about a different pod. That one arrives as `back.blocked`
         * above rather than as a throw here, and both stop the write. What remains true of the
         * throw: `recipientsFor` has already refused anything whose grant read could still clear
         * on its own, so nothing reaching here is waiting on a retry of the GRANT.
         */
        return cannotRecover(errorCopy(e).t);
      }
    }
    const resealed = await resealRecord(client, {
      workspace: args.workspace, viewer: args.viewer, entryShape: args.entryShape,
      // Seated members, everyone a standing grant names, everyone whose grant would not read at
      // all, and the person being invited now. Dropping any of the four locks somebody out of a
      // record they need in order to join — and `grantedWebIds` is a SUPERSET of "outstanding
      // invitations" for the reason its own parameter gives: a member whose acceptance merely
      // could not be read is still a member.
      shareWith: [...new Set([
        ...(args.shareWith ?? []), ...(args.pendingWebIds ?? []), ...(args.grantedWebIds ?? []),
        ...repaired, who.webId,
      ])].filter(Boolean),
      resolution: who,
      onState: args.onState,
    });
    if (resealed.kind === 'failed') return resealed.outcome;
    recordUnreached = resealed.unreached;
    recordReach = resealed.reach;
    /**
     * ── ★★ AND THE INVITEE HAS TO BE ONE OF THE PEOPLE IT REACHED ─────────────
     *
     * The whole reason the re-seal runs FIRST is that the invitee must be able to read the record:
     * `verifyGrantIri` reads it to check the grant against the workspace, so an invitee who cannot
     * open it cannot accept. Naming them in `share_with` does not establish that — the relay
     * resolves each handle to a pod and its registered encryption key, and `resolveRecipient`
     * answers with an EMPTY key list rather than an error when either step comes up short. The
     * publish then succeeds having encrypted to everyone but them.
     *
     * Writing the grant anyway produces exactly the state the ordering above exists to prevent:
     * somebody holding a grant they cannot use, with nothing saying so. So it stops here, before
     * the grant, and names them.
     *
     * ★ MATCHED ON THE HANDLE THE RELAY ECHOES BACK for the recipient this client named, which is
     * the WebID that went into `share_with`. If a relay ever echoes some other spelling this
     * comparison misses and the invite proceeds as it did before — the unreached list is still
     * carried out on the outcome either way, so the failure degrades to being reported rather
     * than to being hidden.
     */
    /**
     * ★★ AND "THE RELAY DID NOT SAY" IS ITS OWN ANSWER, WHICH THIS GATE USED TO PASS SILENTLY.
     *
     * The test was `recordUnreached.indexOf(who.webId) >= 0`, over a list `unreachedRecipients`
     * returned EMPTY for a response carrying no per-handle resolution at all. So the one gate
     * standing between a person and a grant they cannot use opened whenever the relay answered in
     * a shape this client could not read — the absence of a finding read as a finding, on the
     * write this whole ordering exists to protect.
     *
     * ★ WHAT IS REFUSED IS A GAP IN AN ANSWER THAT CAME BACK, AND NOT THE ABSENCE OF AN ANSWER.
     * The line is drawn there deliberately. `resolveRecipients` returns one entry per handle —
     * failures included, with an empty key list — so a response that carries a resolution and
     * does not name the invitee, or names them with no count, is that response contradicting
     * itself about the one document the invitee must be able to read. A response carrying NO
     * resolution is a different thing: the relay emits the field only when it resolved handles
     * itself, and a client cannot tell "this deployment does not report it" from "this one does
     * and something went wrong". Refusing there would refuse every invite against a relay that
     * does not report the field, which is a worse failure than the one being closed, so it is
     * REPORTED instead — `recordReach.established` is false on the outcome and a shell must say
     * so rather than render silence as success.
     *
     * Two states refuse, and each sentence says which was established:
     *   · the relay STATED it resolved no agent for them;
     *   · it answered about the recipients and did not state one for them — either with no count
     *     (`agentCount` is optional in its published output schema, so reading a missing one as
     *     zero would assert a failure the relay never reported) or by not naming them at all.
     */
    const said = !recordReach.established ? null
      : recordReach.unreached.indexOf(who.webId) >= 0
        ? 'the relay reported that it resolved no agent for them'
        : recordReach.unstated.indexOf(who.webId) >= 0
          ? 'the relay echoed them without an agent count, so whether it resolved a key for them is not established'
          : recordReach.named.indexOf(who.webId) >= 0 ? null
            : 'the relay did not name them among the recipients it resolved, so whether it reached them is not established';
    if (said !== null) {
      return { kind: 'error', resolution: who,
        error: new Error('the workspace record was re-published naming ' + who.webId + ' as a recipient, and '
          + said + ' — so whether the record is readable by the person being invited is not established, and '
          + 'they could not verify a grant against it or accept one. Either that handle does not resolve to a '
          + 'pod on this relay, or that pod registers no encryption key, or the relay answered in a shape this '
          + 'client cannot read. No grant was written and nobody was notified; the record now names them and '
          + 'will reach them once their pod registers a key.') };
    }
  }

  const grantIri = args.workspace + '-grant-' + who.pod;
  const publishArgs: Record<string, unknown> = {
    graph_iri: grantIri,
    graph_content: grantTurtle({ grant: grantIri, workspace: args.workspace, granteeWebId: who.webId, role: args.role }),
    visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
  };
  if (args.entryShape) publishArgs['conforms_to_shapes'] = [args.entryShape];
  const out = await client.publishAndConfirm(publishArgs, args.viewer.podName, grantIri, args.onState);
  if (out.error) return { kind: 'error', error: out.error, resolution: who };
  if (out.refusal) return { kind: 'refused', refusal: out.refusal as Record<string, unknown>, resolution: who };

  let note: Record<string, unknown> | null = null;
  let nerr: unknown = null;
  try {
    note = await client.tool('notify_agent', {
      to: args.handle, type: 'Offer', about: grantIri,
      summary: 'Invitation to ' + args.workspaceTitle,
      content: 'A membership grant naming you has been published at ' + grantIri
        + '. Open your own workspace client and it will read that grant off this pod and offer you Accept.',
    }) as Record<string, unknown>;
  } catch (e) { nerr = e; }
  const nbad = note ? refusal(note) : null;
  const chans = (note?.['channels'] as readonly { type?: string; status?: string }[]) ?? [];
  const delivered = !!(note?.['delivered'] === true && chans.some((c) => c?.status === 'delivered'));
  const line = nerr ? 'the call failed: ' + errorCopy(nerr).t
    : nbad ? 'refused: ' + String(nbad['message'] ?? nbad['error'])
    : note ? 'delivered:' + String(note['delivered']) + ' · channels ' + (chans.map((c) => (c.type ?? '?') + ':' + (c.status ?? '?')).join(', ') || 'none reported')
    : 'not attempted';

  return {
    kind: 'invited', resolution: who, grantIri, readable: !!out.readable, why: out.why ?? null,
    notify: { attempted: !nerr, delivered, line },
    // Members the re-seal named and the relay reached no key for. The invitee is not among them —
    // that case returned above, before the grant — so these are people who were already in this
    // workspace and have just lost the revision of the record they could read.
    recordUnreached,
    recordReach,
  };
}

// ── Flow C: verify and accept ────────────────────────────────────────────────

/** A grant IRI on this relay: `<relay>/ns/<owner>/<slug>-grant-<target>`. */
export const GRANT_IRI_RX = /^https:\/\/[^/]+\/ns\/([^/]+)\/(.+)-grant-([^/]+)$/;

/** What dereferencing a grant established. `ok` only when EVERY test below passed. */
export interface GrantVerdict {
  readonly grantIri: string;
  readonly checks: readonly Check[];
  readonly ok: boolean;
  readonly why?: string;
  /**
   * Whether this verdict is a CONCLUSION or the absence of one — the same word, and the same
   * question, as {@link Seat.basis}, asked about the GRANT half instead of the roster row.
   *
   * ── ★★ THE DISTINCTION EXISTED ONLY IN THE PROSE, ON THE HALF THAT WRITES ───
   *
   * `verifyGrantIri` draws it carefully in its own sentences — "the read of that IRI did not
   * resolve, so whether a grant is published there is not established" versus "no grant is
   * published at that IRI" — and then discarded it at the type boundary: both arrived as
   * `{ok: false, why}` with nothing to match on but the prose. The ACCEPTANCE half was given this
   * discriminant a round ago (`OwnHalf.repairable` in the Discord shell, whose own docblock
   * enumerates what re-seating on a failed read costs); the GRANT half, one line above the call
   * site it protects, was left exactly as it was.
   *
   * `'unestablished'` means a read did not complete — the head, the descriptor, the signed region,
   * the workspace record, the pod scan. ★ THE RULE FROM `Seat.basis` APPLIES UNCHANGED: nothing
   * may WRITE a membership document on it. `seat()` republishes the grant with a fresh
   * `dct:created`, so it is never a no-op — it mints a new cid that every existing acceptance is
   * instantly stale against.
   */
  readonly basis: 'answered' | 'unestablished';
  /**
   * Whether PUBLISHING is an answer to what this verdict found. Meaningful only when `ok` is false.
   *
   * The same field, with the same meaning, as `OwnHalf.repairable`: is this a state a write can
   * fix, or one a write can only make worse? `false` arrives for three unlike reasons, and `basis`
   * is what tells the first from the other two:
   *
   *   · `basis: 'unestablished'` — a read failed. Writing edits somebody's record because the
   *     network blinked.
   *   · A WITHDRAWAL that was read: `wsp:revoked`, or `iep:modalStatus "Retracted"` on the grant.
   *     Republishing the grant is precisely the revoked-member-re-seats-by-typing bypass, and the
   *     convener is the only party who may undo either.
   *   · A state that was read in full and that publishing a grant does not change — the workspace
   *     record naming a convener on another pod, or an IRI this reader will not dereference at all
   *     because it is outside the relay's namespace or addressed to somebody else's pod.
   *
   * ★ AND `true` INCLUDES A STATED ABSENCE, which is what keeps the ordinary join flow alive: "no
   * grant is published at that IRI" is an answer, and the answer to it is to publish one. This
   * mirrors `ownHalf`, which returns `repairable: true` for an acceptance that is genuinely not
   * there and `false` for one it could not read.
   *
   * ★★ A CALLER GATING ON THIS IN A PRIVATE WORKSPACE MUST READ THE RECORD EXITS FIRST. Once a
   * grant IS read, this function goes on to read the workspace RECORD, and a client holding no
   * key cannot open a private one — so those exits are `unestablished`, and a shell that answers
   * every `!repairable` by refusing will refuse a keyless client in a private workspace on every
   * message. That is a real judgement to make in the shell, in the open, rather than a case for
   * softening the field here.
   */
  readonly repairable: boolean;
  readonly owner?: string;
  readonly grantCid?: string | null;
  readonly grantedTo?: string | null;
  readonly role?: string | null;
  readonly revoked?: boolean;
  /** What the grant's own signed region states about its status, or null when it states none. */
  readonly modalStatus?: string | null;
  readonly workspace?: string;
  readonly title?: string;
  readonly convener?: string | null;
  readonly roleProfile?: string | null;
  readonly entryShape?: string | null;
  /**
   * Whether the workspace this grant seats you into is public or encrypted to its members.
   *
   * ★ CARRIED FROM THE RECORD RATHER THAN DECIDED BY THE WRITER. Every document a member later
   * publishes into this workspace has to match the workspace's own policy, and the only honest
   * source for that is the workspace record itself — read once here, on the same read that
   * establishes the seat, rather than re-fetched by each writer and possibly answered differently.
   * This is exactly how `entryShape` already travels.
   */
  /**
   * ★★ `'unknown'` IS ONE OF THE ANSWERS, and carrying it is the point. It means the record could
   * not be READ here — no key, or this key not in that envelope. Collapsing it to `'public'` is
   * what made a member who cannot open a private channel the one member who would post plaintext
   * into it; `recipientsFor` refuses it rather than guessing.
   */
  readonly visibility?: 'public' | 'private' | 'unknown';
  readonly grantAuthorship?: unknown;
}

/**
 * Dereference a grant on the pod its own IRI names and decide whether it seats the viewer.
 *
 * ★ `nameMustTargetMe` IS THE DIFFERENCE BETWEEN A URL SOMEBODY SENT YOU AND ONE YOU FOUND
 * YOURSELF. An `about` out of a world-writable inbox has to name the viewer's own pod in its own
 * name before this reader will dereference it at all. A grant found by SCANNING the pod the
 * workspace's own IRI names has already been reached through the authority-closed route, so its
 * name is free — which it has to be, because grants written before this scheme existed are named
 * for the seat ("…-grant-convener") rather than for the pod.
 */
export async function verifyGrantIri(
  client: WorkspaceClient,
  args: {
    readonly relay: string;
    readonly viewer: Viewer;
    readonly grantIri: string;
    readonly nameMustTargetMe?: boolean;
  },
): Promise<GrantVerdict> {
  const nameMustTargetMe = args.nameMustTargetMe !== false;
  const checks: Check[] = [];
  /**
   * ★ TWO REFUSAL HELPERS RATHER THAN ONE, SO EVERY EXIT HAS TO SAY WHICH KIND IT IS.
   *
   * There was one `no(why)` and every exit below used it, which is exactly how "the read did not
   * resolve" and "no grant is published there" came to be the same value to a caller. Splitting
   * the helper puts the choice in front of whoever adds the next exit; a single helper with a
   * defaulted flag would let the next one inherit somebody else's judgement silently.
   */
  const answered = (repairable: boolean, why: string, extra?: Partial<GrantVerdict>): GrantVerdict => {
    checks.push({ mark: 'n', text: why });
    return { grantIri: args.grantIri, checks, ok: false, basis: 'answered', repairable, why, ...extra };
  };
  /** A read that did not complete. Never repairable — see {@link GrantVerdict.repairable}. */
  const unestablished = (why: string, extra?: Partial<GrantVerdict>): GrantVerdict => {
    checks.push({ mark: 'n', text: why });
    return { grantIri: args.grantIri, checks, ok: false, basis: 'unestablished', repairable: false, why, ...extra };
  };
  const grantIri = args.grantIri;
  const m = GRANT_IRI_RX.exec(grantIri || '');
  if (!m || grantIri.indexOf(args.relay + '/ns/') !== 0) {
    return answered(false, 'that is not a grant IRI in this relay\'s namespace, so there is nothing on a pod to check it against');
  }
  const owner = m[1] as string;
  const target = m[3] as string;
  if (!POD_RX.test(owner)) return answered(false, 'the pod segment in that IRI is not a pod identifier');
  if (nameMustTargetMe && target !== args.viewer.podName) {
    return answered(false, 'that grant is addressed to pod ' + target + ', and you are ' + args.viewer.podName);
  }
  checks.push({ mark: 'y', text: nameMustTargetMe
    ? 'The grant IRI is on pod ' + owner + ' and names your pod in its own name'
    : 'The grant was found on pod ' + owner + ', the pod this workspace\'s own IRI names' });

  let h: HeadResult;
  try { h = await client.currentHead(grantIri, owner); }
  catch (e) { return unestablished('the grant could not be read from ' + owner + ': ' + ((e as Error)?.message ?? String((e as { code?: string })?.code)), { owner }); }
  if (h.forked) return unestablished('that grant\'s chain has ' + h.heads.length + ' unresolved heads, so which grant is current is not decided', { owner });
  if (h.url === null) {
    // Two different facts, and only one of them is "no grant is published there". They now differ
    // in the VERDICT and not only in the sentence: a stated absence is answerable by publishing a
    // grant, and a read that did not resolve is answerable by nothing at all.
    return 'unreadable' in h
      ? unestablished('the read of that IRI on pod ' + owner + ' did not resolve, so whether a grant is published there is not established — ' + h.message, { owner })
      : answered(true, 'no grant is published at that IRI on pod ' + owner + ' — ' + (h.message || 'the relay gave no reason'), { owner });
  }
  // ★ A HEAD WITH A URL AND AN ERROR IS NOT A READABLE HEAD — `HeadResult.headError`, checked here
  // for the same reason `readCanvas` and `foldRoster` check it. Without this the fetch below throws
  // and lands in a catch whose sentence blames the descriptor, which is a true sentence about the
  // wrong document: the relay already said which document it could not fetch and why.
  if (h.headError) {
    return unestablished('the current grant on pod ' + owner + ' reports a head whose body could not be fetched, so '
      + 'nothing was read from bytes anybody signed: ' + h.headError, { owner });
  }
  const grantCid = h.cid;
  let d: Record<string, unknown>;
  try { d = await client.descriptor(h.url); }
  catch (e) { return unestablished('the grant\'s descriptor could not be fetched: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code)), { owner, grantCid }); }
  const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', grantIri);
  if (region === null) return unestablished('the signed region of that grant could not be located, so nothing was read from bytes anybody signed', { owner, grantCid });
  checks.push({ mark: 'y', text: 'Its signed region was located on ' + owner + '\'s pod' });

  const base: Partial<GrantVerdict> = {
    owner, grantCid, grantAuthorship: d['authorship'] ?? null,
    grantedTo: readIri(region, 'wsp:grantedTo'),
    role: readIri(region, 'wsp:role'),
    revoked: hasTrue(region, 'wsp:revoked'),
    modalStatus: readModalStatus(region),
  };
  // ★ TWO DIFFERENT WITHDRAWALS, TESTED SEPARATELY AND REPORTED SEPARATELY. `wsp:revoked` is the
  // convener saying "this seat is withdrawn"; `iep:modalStatus "Retracted"` is the AUTHOR of the
  // bytes saying "this record is no longer an assertion of mine". A reader that honoured only the
  // first kept quoting a document its own author had withdrawn. Retraction is tested first
  // because a retracted document's other fields are not current claims to reason from.
  if (isRetracted(region)) {
    // ★ READ IN FULL, AND STILL NOT REPAIRABLE. The bytes said so, so this is `answered`; but the
    // act that would "fix" it is republishing the grant, and the author of those bytes withdrew
    // them. A member typing in a thread must not undo that — the same judgement the revoked branch
    // below carries, and the reason both are `false`.
    return answered(false, 'that grant states iep:modalStatus "' + String(base.modalStatus)
      + '", so the pod that published it has withdrawn it as an assertion. A withdrawn record seats nobody.', base);
  }
  if (base.revoked) return answered(false, 'that grant carries wsp:revoked true', base);
  // Read, and does not seat anybody as it stands. Rewriting the grant is exactly what fixes both.
  if (!base.grantedTo) return answered(true, 'the grant names no wsp:grantedTo', base);
  if (base.grantedTo !== args.viewer.webId) {
    return answered(true, 'the grant names ' + base.grantedTo + ', and your pod reports your WebID as ' + (args.viewer.webId || 'none'), base);
  }
  checks.push({ mark: 'y', text: 'It names your own WebID as grantee' });
  const workspace = readIri(region, 'wsp:workspace');
  if (!workspace) return answered(true, 'the grant names no wsp:workspace', base);
  const withWs: Partial<GrantVerdict> = { ...base, workspace };

  // The workspace record itself, read from the pod its own IRI names, so the convener it
  // declares can be held against the pod the grant is on.
  const wsOwner = podOfNsIri(workspace);
  if (!wsOwner) return answered(false, 'the workspace IRI in that grant is not one this reader can read a pod out of', withWs);
  const rec = await client.readWorkspaceRecord(workspace, wsOwner).catch((e: unknown) => ({ kind: 'error' as const, error: e }));
  // ★ ALL THREE ARE READS OF THE RECORD THAT DID NOT COMPLETE, `missing` included: the record is
  // the document `acceptGrant` needs and `createWorkspace` already wrote, so its absence is not a
  // state a grant write repairs — it is a state in which this reader knows nothing about the
  // workspace the grant names.
  if (rec.kind === 'forked') return unestablished('the workspace record at ' + workspace + ' has ' + rec.heads.length + ' unresolved heads, so it has no single current head', withWs);
  if (rec.kind === 'missing') return unestablished('the workspace record at ' + workspace + ' could not be read: ' + rec.message, withWs);
  if (rec.kind === 'error') return unestablished('the workspace record could not be read: ' + ((rec.error as Error)?.message ?? String(rec.error)), withWs);
  if (!rec.record.regionFound) {
    /**
     * ★ WITHHELD AND MALFORMED ARE OPPOSITE CLAIMS. Saying "the signed region could not be
     * located" about an encrypted record accuses its author of publishing bytes nobody signed —
     * about a record that is perfectly well formed and simply not this reader's to open. See
     * `WorkspaceRecord.withheld`.
     */
    /**
     * ★★ AND "NOT A MEMBER" IS A THIRD CLAIM AGAIN, WHICH THIS COULD NOT TELL APART. A client with
     * no key installed — the published artifact, which runs in a browser, and any browser sign-in
     * — cannot open ANY sealed record, including one addressed to the person reading it. Telling a
     * seated member "you are not one of them" on that evidence is a false statement about their
     * membership, made by a client that never even attempted the decryption. Which of the two it
     * is, is known exactly: `canOpenSealed`.
     */
    /**
     * ★★ AND A FAILED READ IS A FOURTH, WHICH IS NOT ABOUT MEMBERSHIP AT ALL. A CSS 502 during a
     * redeploy, a damaged envelope, a descriptor naming no distribution — the bytes could not be
     * got. That used to arrive here as the first branch, because the opener returned `null` for
     * both "not addressed to me" and "the read failed": so a transport hiccup told a seated member
     * they were not among their own workspace's members, in the very sentence re-sealing was
     * introduced to stop anybody seeing.
     */
    /**
     * ★★ AND THOSE FOUR CLAIMS ARE NOT FOUR SENTENCES ABOUT ONE VERDICT. Exactly one of them is
     * an answer — the recipient set was read and does not name this identity — and the other three
     * are reads that did not complete. The prose separated them and the single `no(...)` collapsed
     * all four, which is the defect `basis` exists for, committed on the branch that documents it
     * at greatest length.
     */
    if (rec.record.withheld && rec.record.sealedReadFailed) {
      return unestablished('this workspace is private and its record could not be READ here — ' + rec.record.sealedReadFailed
        + '. That is a failure to fetch or open the bytes, not an answer about whether you are a member '
        + 'of it, so nothing is concluded either way. Try again.', withWs);
    }
    if (rec.record.withheld && client.canOpenSealed) {
      // ★ AN ANSWER, AND A REPAIRABLE ONE. The decryption WAS attempted with a key this client
      // holds and this envelope does not name it — that is a fact about the record's recipient
      // set, not a failed read. And it is the one fact in this block a write fixes: `sendInvite`
      // re-seals the record to include somebody BEFORE it writes their grant.
      return answered(true, 'this workspace is private and its record is encrypted to its members, and this identity is not '
        + 'among them. Nothing is wrong with the record; it is not yours to read.', withWs);
    }
    if (rec.record.withheld) {
      // No key installed at all — a browser sign-in, the published artifact. Nothing was attempted,
      // so nothing is established. ★ THIS IS THE EXIT A SHELL GATING ON `repairable` MUST WEIGH:
      // in a private workspace a keyless client reaches it on every message. See the field.
      return unestablished('this workspace is private and its records are encrypted, and this client holds no key to open '
        + 'them — so whether you are a member of it is not something this read can answer either way. '
        + 'Open it in a client signed in with your own key.', withWs);
    }
    // Read in the clear and the block for this IRI is not inside it. Same reading as everywhere
    // else in this vertical: a region that would not locate means nothing signed was read.
    return unestablished('the workspace record\'s signed region could not be located', withWs);
  }
  const full: Partial<GrantVerdict> = {
    ...withWs, title: rec.record.title, convener: rec.record.convener,
    roleProfile: rec.record.roleProfile, entryShape: rec.record.entryShape,
    visibility: rec.record.visibility,
  };
  const cp = rec.record.convenerPod;
  // Both read out of the record's own signed region, so both are answers — and neither is one a
  // grant write repairs: the disagreement is between the RECORD and where this grant lives, and
  // republishing the grant at the same IRI would restate exactly the thing that does not match.
  if (!cp) return answered(false, 'the workspace names no convener this reader can resolve to a pod', full);
  if (cp !== owner) {
    return answered(false, 'the workspace\'s convener resolves to pod ' + cp + ', and this grant is on pod ' + owner
      + '. A grant only counts on the convener\'s own pod, so this one seats nobody.', full);
  }
  checks.push({ mark: 'y', text: 'The workspace names a convener on pod ' + owner + ' — the same pod the grant is on' });

  // ★ AND THE GRANT'S OWN NAME HAS TO BE ONE EVERY READER OF THIS WORKSPACE LOOKS FOR.
  // `foldRoster` folds descriptors whose subject starts with `<workspace>-grant-`, `findSeat`
  // scans for the same prefix, and the acceptance and stream names are built from the
  // workspace's own pod and slug. A grant at any other IRI is invisible to all of them, however
  // well-formed — so accepting one publishes a real acceptance that seats you NOWHERE. The pod
  // segment and the slug are both inside the workspace IRI, so prefix equality tests them
  // together. It runs AFTER the convener test on purpose: the two overlap on a grant sitting on
  // the wrong pod entirely, and that case is better told as "the convener is elsewhere".
  if (grantIri.indexOf(workspace + '-grant-') !== 0) {
    // Repairable: the grant this reader WOULD look for is the one at `<workspace>-grant-<pod>`,
    // and writing that one is what `sendInvite` does. This verdict is about a document that exists
    // under a name nothing reads, not about a read that failed.
    return answered(true, 'that grant is at ' + grantIri + ', and the workspace it names is ' + workspace
      + ' — so it is not one of that workspace\'s own "' + workspace + '-grant-…" documents. '
      + 'Every reader of this workspace looks only under that prefix, so accepting it would write a real '
      + 'acceptance that seats you on nobody\'s roster.', full);
  }
  checks.push({ mark: 'y', text: 'Its IRI is one of ' + workspace + '\'s own grant names, which is where every reader looks' });
  // `basis: 'answered'` on the success path too: every read this verdict rests on completed.
  // `repairable` is meaningless when `ok` is true and is set false rather than left to a spread,
  // so no caller can read a stale value out of `full`.
  return { grantIri, checks, ok: true, basis: 'answered', repairable: false, ...full } as GrantVerdict;
}

export type AcceptOutcome =
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'refused'; readonly refusal: Record<string, unknown> }
  | {
      readonly kind: 'accepted';
      readonly acceptanceIri: string;
      readonly streamIri: string;
      readonly workspace: string;
      readonly grantIri: string;
      readonly grantCid: string | null;
      readonly entryShape: string | null;
      readonly readable: boolean;
      readonly why: string | null;
    };

/**
 * Publish an acceptance on the INVITEE's own pod. One write, their credentials.
 *
 * ★ THE TWO NAMES ARE COMPOSED FROM THE WORKSPACE, NEVER FROM THE GRANT'S OWN FILENAME. They
 * are what every reader of this workspace will look for, and a reader holds the workspace IRI,
 * not the grant's. Building them from the grant IRI's own pod and slug agrees with the workspace
 * only when the grant's filename happens to carry the workspace's slug AND sits on the pod the
 * workspace IRI names. `verifyGrantIri` refuses any grant where they disagree, so the two
 * derivations coincide — and this one is derived from the thing readers hold, so it stays right
 * if that check is ever relaxed.
 */
export async function acceptGrant(
  client: WorkspaceClient,
  args: {
    readonly relay: string;
    readonly viewer: Viewer;
    readonly verdict: GrantVerdict;
    /**
     * This member's X25519 PUBLIC key, published inside their own acceptance.
     *
     * ── ★★ ACCEPTING IS THE RIGHT MOMENT AND THE ONLY GOOD ONE ─────────────────
     *
     * A publisher sealing to the roster needs every member's key, and it must not learn them from
     * anything the relay can rewrite — see `Seat.encryptionKey`. The acceptance is the document a
     * member writes about themselves, on their own pod, in a signed CAS-chained region, and it is
     * PUBLIC-ALWAYS, so it is readable by somebody who does not yet hold a key. Publishing the key
     * anywhere else would need a second write that most people would never make.
     *
     * ★ OPTIONAL, BECAUSE A HOST MAY GENUINELY HOLD NO KEY. The browser artifact is the case: it
     * cannot seal and has nowhere safe to keep a secret. Such a member is seated and readable-from
     * on the relay-sealed path, and `recipientsFromRoster` names them as missing rather than
     * sealing to a subset.
     */
    readonly encryptionKey?: string;
    readonly onState?: (state: string, detail: string) => void;
  },
): Promise<AcceptOutcome> {
  const v = args.verdict;
  const workspace = v.workspace as string;
  const convPod = podOfNsIri(workspace) ?? (v.owner as string);
  const wsSlug = workspace.slice(nsIri(args.relay, convPod, '').length);
  const pod = args.viewer.podName;
  const acceptanceIri = nsIri(args.relay, pod, qualifiedName(convPod, wsSlug, 'acceptance'));
  const streamIri = nsIri(args.relay, pod, qualifiedName(convPod, wsSlug, 'stream'));
  const publishArgs: Record<string, unknown> = {
    graph_iri: acceptanceIri,
    graph_content: acceptanceTurtle({
      acceptance: acceptanceIri, workspace, memberWebId: args.viewer.webId,
      grant: v.grantIri, grantCid: v.grantCid ?? null, stream: streamIri,
      ...(args.encryptionKey ? { encryptionKey: args.encryptionKey } : {}),
    }),
    visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
  };
  if (v.entryShape) publishArgs['conforms_to_shapes'] = [v.entryShape];
  const out = await client.publishAndConfirm(publishArgs, pod, acceptanceIri, args.onState);
  if (out.error) return { kind: 'error', error: out.error };
  if (out.refusal) return { kind: 'refused', refusal: out.refusal as Record<string, unknown> };
  return {
    kind: 'accepted', acceptanceIri, streamIri, workspace, grantIri: v.grantIri,
    grantCid: v.grantCid ?? null, entryShape: v.entryShape ?? null,
    readable: !!out.readable, why: out.why ?? null,
  };
}

export type RevokeOutcome =
  | { readonly kind: 'incomplete'; readonly why: string }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'refused'; readonly refusal: Record<string, unknown> }
  | { readonly kind: 'revoked'; readonly grantIri: string; readonly asserted: string | null; readonly readable: boolean; readonly why: string | null };

/**
 * Withdraw a grant: the same IRI, republished with `wsp:revoked true`, asserting the revision
 * that is there NOW — a revocation written against a grant somebody has already moved is a
 * revocation of something else.
 *
 * Republishing means RESTATING what the grant says, so a grant whose grantee or role could not
 * be read out of its signed region is refused here rather than rewritten with a field missing.
 */
export async function revokeGrant(
  client: WorkspaceClient,
  args: {
    readonly viewer: Viewer;
    readonly workspace: string;
    readonly grantIri: string;
    readonly grantedTo: string | null;
    readonly role: string | null;
    readonly ifMatch: string | null;
    readonly entryShape: string | null;
    readonly onState?: (state: string, detail: string) => void;
  },
): Promise<RevokeOutcome> {
  /**
   * ── ★ THE REPAIR VERB DECLINES EXACTLY THE ROWS THAT NEED REPAIRING, AND NAMES WHAT DOES ────
   *
   * Declining is right, and it is not only this client's caution: the shapes document a workspace
   * publishes carries `#GrantShape`, which targets `wsp:MembershipGrant` — what `grantTurtle`
   * writes — with `sh:minCount 1` on `wsp:grantedTo`. This call passes that document as
   * `conforms_to_shapes` whenever the workspace names one, so a tombstone omitting the grantee
   * would be refused at the relay rather than merely being impolite. Restating a field this client
   * could not read would also be this client deciding what somebody else's document says.
   *
   * ★ WHAT CHANGED IS THAT THE SENTENCE NOW NAMES AN ACT SOMEBODY CAN PERFORM. For a round this
   * refusal was advertised as one of the two ways out of the channel-wide "the roster is
   * incomplete" refusal, and it is not one — it declines precisely the unreadable rows that
   * refusal fired on, which made the pair a closed loop with a workspace inside it. That refusal
   * is gone (see `recipientsFor`), and with it `sendInvite` is reachable again: it republishes
   * `<workspace>-grant-<pod>` with `auto_supersede_prior`, which collapses a fork, creates a
   * missing head and re-files a lost region in one act, and it writes a grantee this reader can
   * read. So the honest exit is to re-invite the pod and then revoke, and that is what is said.
   */
  if (!args.grantedTo || !args.role) {
    return { kind: 'incomplete', why: 'Republishing this grant means restating what it says, and '
      + (!args.grantedTo ? 'its wsp:grantedTo' : 'its wsp:role') + ' could not be read out of its signed region. '
      + 'Rewriting it with a field missing would be this client deciding what the grant says, and this '
      + 'workspace\'s own grant shape requires a grantee, so the relay would refuse it too. Invite that pod '
      + 'again first — that republishes the grant at the same IRI with a grantee this reader can read — and '
      + 'revoking it will then work. Nothing was written.' };
  }
  const publishArgs: Record<string, unknown> = {
    graph_iri: args.grantIri,
    graph_content: grantTurtle({ grant: args.grantIri, workspace: args.workspace, granteeWebId: args.grantedTo, role: args.role, revoked: true }),
    visibility: 'public', auto_supersede_prior: true, sign_authorship: true,
  };
  if (args.ifMatch) publishArgs['if_match'] = args.ifMatch;
  if (args.entryShape) publishArgs['conforms_to_shapes'] = [args.entryShape];
  const out = await client.publishAndConfirm(publishArgs, args.viewer.podName, args.grantIri, args.onState);
  if (out.error) return { kind: 'error', error: out.error };
  if (out.refusal) return { kind: 'refused', refusal: out.refusal as Record<string, unknown> };
  return { kind: 'revoked', grantIri: args.grantIri, asserted: args.ifMatch, readable: !!out.readable, why: out.why ?? null };
}

// ── the inbox ────────────────────────────────────────────────────────────────

/**
 * ★ THE INBOX READ IS CAPPED AND THE CAP IS NOT DETECTABLE FROM THE ANSWER.
 *
 * MEASURED against the live relay: `read_inbox` returns `{inbox, count, items}` and `count` is
 * the number RETURNED, not a total — asking for 2 gives count 2. So there is no field that says
 * "there are more", and the only honest signal is that the read came back exactly full.
 */
export const INBOX_LIMIT = 50;

/** One inbox item, and the verdict on the grant it points at. */
export interface Invitation {
  readonly item: Record<string, unknown>;
  verdict: GrantVerdict | null;
  /** An `about` that is a WORKSPACE rather than a grant: not a member, but a lead worth scanning. */
  lead: string | null;
  state: 'unchecked' | 'checked';
}

export interface InboxRead {
  readonly invitations: readonly Invitation[];
  readonly saturated: boolean;
  readonly limit: number;
}

/**
 * Read the viewer's inbox and keep only offers that carry something to look at.
 *
 * Verification is NOT done here: it is several cross-pod reads per item, and a shell wants the
 * list on screen before they finish. Call {@link verifyInvitation} per item and re-render.
 */
export async function readInbox(client: WorkspaceClient, limit = INBOX_LIMIT): Promise<InboxRead> {
  const p = await client.tool('read_inbox', { limit }) as Record<string, unknown> | null;
  const bad = refusal(p);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  /**
   * ★★ "YOU HAVE NO INVITATIONS" IS A READ, AND A READ THAT CARRIED NO LIST IS NOT THAT READ.
   *
   * This was `Array.isArray(p['items']) ? … : []`, so a `read_inbox` answer of `{inbox, count: 0}`
   * with no `items` key resolved as `{invitations: [], saturated: false}` — the empty inbox
   * screen, stated from an answer that enumerated nothing. It is the invitee-facing instance of
   * the shape closed at three sibling sites this round, two of them in this file: `foldRoster`,
   * `findSeat`'s pod scan and `listWorkspaces` all now refuse a `discover_context` answer with no
   * `entries` array rather than reading it as "nothing is there".
   *
   * Throwing is what the callers are already written for — the same path a refused or unreachable
   * `read_inbox` already takes — whereas an empty list is the one answer they render as a fact
   * about the person's own pod.
   */
  const raw = p?.['items'];
  if (!Array.isArray(raw)) {
    throw fail('tool_error', 'read_inbox answered without an items array, so what is in your inbox could not be '
      + 'enumerated at all — which is not the same as your having no invitations.');
  }
  const all = raw as Record<string, unknown>[];
  const items = all.filter((it) => it && it['type'] === 'Offer' && it['about']);
  return {
    invitations: items.map((item) => ({ item, verdict: null, lead: null, state: 'unchecked' as const })),
    saturated: all.length >= limit,
    limit,
  };
}

/** Verify one inbox item against the pod its `about` names. Mutates the item in place. */
export async function verifyInvitation(
  client: WorkspaceClient, relay: string, viewer: Viewer, inv: Invitation,
): Promise<Invitation> {
  const about = String(inv.item['about'] ?? '');
  try { inv.verdict = await verifyGrantIri(client, { relay, viewer, grantIri: about }); }
  catch (e) {
    const t = errorCopy(e).t;
    // The call itself threw, so nothing about that grant was established — the same reading
    // `verifyGrantIri`'s own catch exits take, restated here because this catch is outside it.
    inv.verdict = { grantIri: about, ok: false, basis: 'unestablished', repairable: false, why: t, checks: [{ mark: 'n', text: t }] };
  }
  inv.state = 'checked';
  // A workspace IRI is not a grant and is not treated as one — but it IS a lead, and the
  // fallback scan turns it into one without believing anything the inbox said.
  inv.lead = !inv.verdict.ok && /^https:\/\/[^/]+\/ns\/[^/]+\/[^/]+$/.test(about) && !/-grant-/.test(about)
    ? about : null;
  return inv;
}

// ── does anything on that pod seat me? ───────────────────────────────────────

/**
 * How many of the grants a scan FINDS are then read. Each read is two round trips.
 *
 * ★ THE SCAN ITSELF IS NO LONGER CAPPED — `SEAT_SCAN_LIMIT = 400` used to sit beside this and is
 * gone. See {@link foldRoster} for the measurement: `discover_context`'s `limit` is optional and
 * unbounded by default, the relay builds and caches the whole manifest either way, and it slices
 * LAST — so the cap truncated the answer and bought nothing. What remains is this read bound,
 * which is real work against possibly-cold pods.
 */
export const SEAT_READ_CAP = 25;

/**
 * The honest path to a seat, and also what happens when a notification never arrives, and also
 * how a workspace whose grants predate this naming scheme is verified:
 *
 *   1. the composed name — one read, and the common case;
 *   2. failing that, every grant for this workspace on the pod the workspace's own IRI names,
 *      read until one names the viewer's WebID.
 *
 * Nothing from an inbox is involved in either.
 */
export async function findSeat(
  client: WorkspaceClient,
  args: { readonly relay: string; readonly viewer: Viewer; readonly workspace: string },
): Promise<GrantVerdict> {
  const owner = podOfNsIri(args.workspace);
  if (!owner) {
    // Nothing was read and nothing is going to be: the argument names no pod. Answered — this is
    // a fact about the string — and not repairable, because there is no pod to publish onto.
    return { grantIri: args.workspace, ok: false, basis: 'answered', repairable: false, checks: [],
      why: 'that is not a workspace IRI this reader can read a pod out of' };
  }
  const direct = await verifyGrantIri(client, { relay: args.relay, viewer: args.viewer, grantIri: args.workspace + '-grant-' + args.viewer.podName });
  if (direct.ok) return direct;

  /**
   * WHAT THE DIRECT READ ALREADY ESTABLISHED ABOUT THIS VIEWER, CARRIED BY EVERY FAILURE BELOW.
   *
   * The final return spreads the verdict that is about the viewer, so a caller can tell "revoked"
   * from "never granted" without matching on prose - the Discord bot's revocation gate reads
   * exactly that flag. Three returns between here and there built a fresh four-key object and
   * dropped it: the relay refusing the pod scan, the scan throwing, and the scan finding no grant.
   *
   * On each of those paths a viewer whose OWN grant is revoked - established right here, before
   * the scan ran - came back with `revoked` undefined. The gate then reads "not seated yet" and
   * re-grants them: the revoked-member-re-seats-by-typing bypass, still reachable through any
   * transport failure on the convener's pod. Found by a reviewer told to break the fix for it.
   *
   * `notSeated` is the one shape all of them use, so a future return cannot forget.
   */
  const mine0: GrantVerdict | null = direct.grantedTo === args.viewer.webId ? direct : null;
  /**
   * ★ AND THE SPREAD CARRIES `basis` AND `repairable` TOO, SO BOTH ARE STATED EXPLICITLY AFTER IT.
   * `mine0` is a whole verdict; inheriting its classification for a DIFFERENT question — the pod
   * scan, not the composed name — is how a caller comes to act on a conclusion nobody drew about
   * the thing it is acting on.
   */
  const notSeated = (basis: GrantVerdict['basis'], repairable: boolean, why: string): GrantVerdict => ({
    ...(mine0 ?? {}), grantIri: direct.grantIri, ok: false, checks: mine0?.checks ?? direct.checks,
    basis, repairable, why,
  });

  let rows: readonly Record<string, unknown>[];
  try {
    // No `limit`: the relay's own default is unbounded and it slices last, so a cap here could
    // only hide an older grant — including, on a long-lived pod, the one that seats this viewer.
    const p = await client.tool('discover_context', { pod_name: owner, sort: 'newest-first' }) as Record<string, unknown> | null;
    const bad = refusal(p);
    if (bad) return notSeated('unestablished', false, String(bad['message'] ?? bad['error']));
    assertPod(owner, p?.['pod'], 'discover_context');
    /**
     * ★★ A FAILED READ MUST NOT LOOK LIKE AN EMPTY ONE, and the sentence twenty lines below states
     * completeness outright — "that pod's whole index and not a window into it". This was
     * `?? []`, which fires precisely when the answer carried NO index at all, so that sentence was
     * asserted on the strength of the one value that establishes nothing. `RelayClient.manifest`
     * refuses the same shape one layer down; this raw call scans a whole pod rather than one
     * graph, so it has to restate the rule rather than inherit it.
     */
    const entries = p?.['entries'];
    if (!Array.isArray(entries)) {
      return notSeated('unestablished', false, 'the scan of ' + owner + ' returned no entries array, so the grants on '
        + 'that pod could not be enumerated at all — which is not the same as none of them naming you');
    }
    rows = entries as readonly Record<string, unknown>[];
  } catch (e) {
    const t = errorCopy(e).t;
    return notSeated('unestablished', false, t + ((e as Error)?.message ? ' - ' + (e as Error).message : ''));
  }

  const prefix = args.workspace + '-grant-';
  const grants: string[] = [];
  const seen = new Set<string>();
  for (const e of rows) {
    const describes = e['describes'];
    if (!Array.isArray(describes)) continue;
    for (const g of describes as string[]) {
      if (typeof g === 'string' && g.indexOf(prefix) === 0 && !seen.has(g)) { seen.add(g); grants.push(g); }
    }
  }
  // ★ AND NOW THIS IS A COMPLETE ANSWER RATHER THAN A HEDGED ONE. There used to be a `capNote`
  // here — "that scan came back full at 400 descriptors, so an older grant may lie past the end
  // of it" — because the scan was capped. It is not, and `discover()` throws rather than return a
  // partial pod, so "no grant for this workspace is on that pod" is now something this can say.
  if (!grants.length) {
    // ★ AND NOW THE SENTENCE IS EARNED. The entries array was present (checked above), the scan is
    // uncapped, and `discover()` throws rather than hand back a partial pod — so this really is an
    // absence somebody's pod stated, and the answer to it is to publish a grant.
    return notSeated('answered', true, 'no grant for this workspace appears among the ' + rows.length + ' descriptors on ' + owner
      + ", which is that pod's whole index and not a window into it");
  }

  /**
   * ★ WHICH GRANTS SURVIVE A TRUNCATED READ, decided rather than left to the relay's order.
   *
   * `foldRoster` was given a stable `prefer` partition for exactly this and `findSeat` — which
   * answers the SAME question for the WRITE path — never got one. The scan is newest-first and
   * grants are written once at invite time, so the oldest members are precisely the rows a cap
   * drops; if one of those is a REVOKED grant naming the viewer, the caller reads "none of them
   * names you" and re-seats somebody the convener removed.
   *
   * The composed name is the only row this can identify without reading anything, so it is the
   * only one moved. A partition, not a sort: every other row stays exactly where the relay put it,
   * because the relay's order is the only ordering evidence there is for the rest.
   */
  const composed = prefix + args.viewer.podName;
  const ordered = grants.indexOf(composed) > 0
    ? [composed, ...grants.filter((g) => g !== composed)]
    : grants;

  // ★ WHICH FAILURE TO REPORT. A workspace has grants for everybody in it, so most fail this
  // reader's check for the boring reason that they are somebody else's. If ONE of them is about
  // you and failed for its own reason — revoked, say — that is the reason worth telling you, and
  // reporting whichever happened to be read last buried it behind "this grant names somebody else".
  let mine: GrantVerdict | null = mine0;
  let last: GrantVerdict | null = null;
  let read = 0;
  /**
   * Grants this scan could not read a GRANTEE out of.
   *
   * ★★ THE COUNT IS WHAT MAKES "NONE OF THEM NAMES YOU" AN ANSWER OR NOT. That sentence is a claim
   * about every grant on the pod, and one unread grant is enough to make it false — including, on
   * a workspace with a revoked member, a grant that would have stopped the caller re-seating them.
   *
   * ★ ONLY THE EXITS BEFORE THE GRANTEE IS READ COUNT, and that is deliberate rather than lazy.
   * `verifyGrantIri` goes on to read the workspace RECORD, which a keyless client cannot open in a
   * private workspace — so counting every `unestablished` verdict would make a private workspace's
   * every scan inconclusive over other people's grants, which say nothing about this viewer once
   * their `wsp:grantedTo` has been read. `grantedTo` being present on the verdict is exactly the
   * line between "this grant is somebody else's, settled" and "this grant was never read".
   */
  let unread = 0;
  for (const g of ordered) {
    if (read >= SEAT_READ_CAP) break;
    read++;
    const v = await verifyGrantIri(client, { relay: args.relay, viewer: args.viewer, grantIri: g, nameMustTargetMe: false });
    if (v.ok) return v;
    if (v.basis === 'unestablished' && v.grantedTo === undefined) unread++;
    if (!mine && v.grantedTo === args.viewer.webId) mine = v;
    last = v;
  }
  /**
   * ★ WHETHER THE SCAN'S OWN CONCLUSION IS ONE. Three ways it is not: the cap stopped it short,
   * the composed-name read that ran first did not resolve, or a grant in the scan did not read.
   * In all three the honest verdict is that this reader does not know whether a grant names the
   * viewer — which is the state in which nothing may be written.
   */
  const truncated = grants.length > read;
  const directUnread = direct.basis === 'unestablished' && direct.grantedTo === undefined;
  const settled = !truncated && !directUnread && unread === 0;
  return {
    /**
     * ★★ THE STRUCTURED FIELDS SURVIVE, NOT ONLY THE SENTENCE. This built a fresh object from
     * four keys, so everything the verdict had ESTABLISHED — `revoked`, `grantedTo`, `role`,
     * `workspace`, `modalStatus` — was dropped, and `why` was the only trace left of it.
     *
     * That made "revoked" and "never granted" indistinguishable to a caller except by matching
     * on prose, and one caller that needed the difference did not: the Discord bot read both as
     * "not seated yet" and re-granted, so a revoked member re-seated themselves by typing. The
     * flag it needed was on the verdict two frames earlier and did not survive the return.
     *
     * A field exists so callers do not have to parse a sentence. Spread first, so the four keys
     * below still win.
     */
    /**
     * ★★ AND ONLY FROM A VERDICT THAT IS ABOUT THE VIEWER. This spread `mine ?? last`, and `last`
     * is the last grant READ — somebody else's. So a viewer no grant names inherited a stranger's
     * `revoked`, `grantedTo` and `role`, while `why` correctly said "none of them names you".
     *
     * ★ REPRODUCED, not reasoned about: a workspace holding one revoked grant answered a
     * never-granted viewer with `revoked: true` and that stranger's WebID. The Discord bot's
     * revocation gate reads exactly that flag and returns BEFORE `seat()` — so a single revoked
     * member permanently blocked every new person from joining the thread, and told each of them
     * their own membership had been revoked. Found by a refute-review of the round that added
     * both the spread and the gate; neither was wrong alone.
     *
     * `last` still contributes its SENTENCE below, which is about a grant and names nobody.
     */
    ...(mine ?? {}),
    grantIri: direct.grantIri, ok: false, checks: mine?.checks ?? direct.checks,
    /**
     * ★ THE CLASSIFICATION IS THE CONCLUSION'S, NOT THE SPREAD'S. When a grant DOES name the
     * viewer, this verdict is that grant's verdict and carries its `basis`/`repairable` unchanged.
     * When none does, the classification is about the SCAN — see `settled` — and the spread above
     * would otherwise hand it whichever values `mine` happened to hold, or none at all.
     */
    ...(mine
      ? { basis: mine.basis, repairable: mine.repairable }
      : { basis: settled ? 'answered' as const : 'unestablished' as const, repairable: settled }),
    why: (mine
      ? 'a grant for this workspace does name you, and it does not seat you: ' + mine.why
      : read + ' grant' + (read === 1 ? '' : 's') + ' for this workspace on ' + owner
        + (settled ? ' were read and none of them names you' : ' were read and none of THOSE names you')
        + (truncated ? ' (of ' + grants.length + ' found; this reader reads at most ' + SEAT_READ_CAP + ')' : '')
        + (unread > 0 ? ' — and ' + unread + ' of them could not be read at all, so whether one of those names you is not established' : '')
        + (directUnread ? ' — and the read of your own composed grant name did not resolve either' : '')
        + (last?.why ? ' — the last one: ' + last.why : '')),
  };
}

// ── Flow D: which workspaces am I in? ────────────────────────────────────────

/** One acceptance found on the viewer's own pod, and what verifying it against a convener found. */
export interface WorkspaceEntry {
  readonly acceptanceIri: string;
  readonly descriptorUrl: string;
  readonly naming: Naming;
  owner: string | null;
  slug: string;
  workspace: string | null;
  /** What the acceptance states about its own status, or null when it states none. */
  modalStatus?: string | null;
  /**
   * undefined = not verified yet, OR verified and not established. A real third state, and shells
   * must render it as one.
   *
   * ★ IT USED TO BE `verdict.ok`, WHICH IS TWO-VALUED, so the lobby's per-workspace tick was false
   * for a convener's pod that did not answer exactly as it was for a revocation. `why` kept the
   * sentence and the shells print it, so this was under-claiming rather than lying — but `verified`
   * is the field a caller keys on, and the third state existed for "not yet" and not for "could
   * not". `verdict.basis` is what tells them apart, and it is now what this is set from.
   */
  verified?: boolean;
  verdict?: GrantVerdict;
  title?: string;
  why?: string;
}

/**
 * An acceptance on the viewer's own pod that is NOT offered as somewhere to go, and which of the
 * two entirely different reasons that is.
 *
 * ★ THE TWO KINDS MUST NEVER RENDER THE SAME, AND ABSENCE IS NOT EVIDENCE OF EITHER.
 *   · `retired` — the record STATES `iep:modalStatus "Retracted"`. Its author withdrew it. That
 *     is a fact read out of the document, and it is the only thing that earns this kind.
 *   · `unreadable` — the descriptor did not fetch, its signed region could not be located, or it
 *     named no `wsp:workspace`. Something is wrong with the READ or with the document, and a
 *     real membership landing here is a defect worth seeing. A truncated read looks exactly like
 *     a tombstone from the outside, which is precisely why the status is read and never inferred.
 */
export interface WithheldAcceptance {
  readonly acceptanceIri: string;
  readonly descriptorUrl: string;
  readonly naming: Naming;
  readonly kind: 'retired' | 'unreadable';
  /** What `iep:modalStatus` said, when it said anything. Null is "the record stated no status". */
  readonly modalStatus: string | null;
  /** The workspace the name or the document named, when either did. */
  readonly workspace: string | null;
  readonly why: string;
}

export interface WorkspaceList {
  /**
   * The workspaces this viewer can be offered. ★ EVERY ONE OF THESE NAMES A WORKSPACE AND NONE
   * OF THEM IS RETIRED — a shell may put an Open control on any row here without a further test.
   */
  readonly entries: readonly WorkspaceEntry[];
  /** Everything the read found and did not offer, with the reason and the kind. Never empty-lossy. */
  readonly withheld: readonly WithheldAcceptance[];
  /**
   * How many descriptors that pod's index held. Reported so a shell can say what was examined —
   * NOT a cap, and there is no `saturated` beside it any more, because the scan is complete.
   */
  readonly scanned: number;
}

/**
 * How many acceptance descriptors are read at once.
 *
 * Every candidate is now read, because whether a record still stands is a fact only the document
 * carries — so the read that used to be paid only by the older unqualified names is paid by all
 * of them. Sequentially that is one round trip per acceptance before the lobby can draw; a small
 * fan-out keeps it to roughly one. It is bounded rather than unbounded because the answers come
 * from a pod that may be cold, and twenty simultaneous reads at a cold relay is a client that
 * appears to hang in a different way.
 *
 * ★ IT IS ALSO A NET SAVING WHERE IT MATTERS. A retired acceptance never reaches
 * `verifyWorkspaceEntry`, which costs a head, a descriptor and — when the composed grant name
 * misses — a whole pod scan and up to {@link SEAT_READ_CAP} more reads.
 */
export const STATUS_READ_CONCURRENCY = 8;

/**
 * Every workspace this viewer has ACCEPTED, read from their own pod.
 *
 * ★ WHAT THE LIST IS FOR DECIDES WHAT MAY BE IN IT. `entries` is the set of places a shell will
 * put an Open control on, so a candidate that does not name a workspace, or whose own author has
 * withdrawn it, IS NOT IN IT. It used to be: an acceptance that named no `wsp:workspace` was
 * returned with a sentence explaining that which workspace it was for could not be established,
 * and the shell drew it as a row you could not open. Measured on the maintainer's own pod
 * (2026-08-11): twenty retired test memberships rendered as twenty such rows, and the one real
 * workspace was lost among them. An honest sentence in the wrong place is still the wrong place.
 *
 * ★ WHERE THE SENTENCE WENT: `withheld`, with a `kind`. Nothing is dropped — a record you
 * published is a fact about you either way, and a REAL membership that fails to parse is a defect
 * a shell must be able to show. What changed is that it is no longer mixed in with the things you
 * can go to, so a shell renders it as a count with the detail one disclosure away.
 *
 * ★ AND THE STATUS IS READ, NEVER INFERRED. A tombstone and a truncated read both produce a
 * document with no `wsp:workspace` in it. The only thing that separates them is what the record
 * SAYS about itself, so every candidate's descriptor is read — including the qualified names,
 * whose filename settles which workspace they are for but says nothing about whether they still
 * stand. `parseAcceptanceIri` still supplies the workspace IRI for those, so the read establishes
 * status only and the fan-out is bounded by {@link STATUS_READ_CONCURRENCY}.
 *
 * ★ THE ENTRY DESCRIBING YOUR OWN POD IS NOT A WORKSPACE. `parseAcceptanceIri` only matches
 * names ending `-acceptance` under `/ns/<your pod>/`, so the pod's own profile descriptor and
 * every other graph on it fall out here rather than being listed as somewhere you are a member.
 */
export async function listWorkspaces(
  client: WorkspaceClient, relay: string, podName: string,
): Promise<WorkspaceList> {
  // `cache: false`, not an omitted option: this list is re-read immediately after an Accept, and
  // a host-cached answer from before that write would show the viewer a workspace list that does
  // not contain the workspace they just joined.
  //
  // ★ AND NO `limit`. This took one (400) and reported `saturated`, which meant the list of rooms
  // you are in could silently omit the one you joined first. The relay's own default is unbounded
  // and it slices last, so the cap only ever hid the oldest acceptances — the ones most likely to
  // matter to somebody who has been here a while.
  const p = await client.tool('discover_context', { pod_name: podName, sort: 'newest-first' }, { cache: false }) as Record<string, unknown> | null;
  const bad = refusal(p);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  assertPod(podName, p?.['pod'], 'discover_context');
  /**
   * ★★ "YOU ARE IN NO WORKSPACE" IS A READ, AND A READ THAT FAILED IS NOT THAT READ.
   *
   * This was `?? []`, so a `discover_context` answer carrying no entries array RESOLVED as an
   * empty list. The shells wrote careful guards for the THROW case — the artifact's boot prints
   * "Whether you are in a workspace is not established" when the call rejects — and this line
   * walked straight past all of them: the second person ever to open the app got the flat "You are
   * in no workspace. Accept an invitation, create one…" on their first screen, from a read that
   * established nothing. Throwing is what those guards are already written for.
   */
  const scanned = p?.['entries'];
  if (!Array.isArray(scanned)) {
    throw fail('tool_error', 'discover_context on ' + podName + ' returned no entries array, so the acceptances on '
      + 'your own pod could not be enumerated at all — which is not the same as your being in no workspace.');
  }
  const rows = scanned as readonly Record<string, unknown>[];
  const found = new Map<string, WorkspaceEntry>();
  for (const e of rows) {
    const describes = e['describes'];
    if (!Array.isArray(describes)) continue;
    for (const g of describes as string[]) {
      const parsed = parseAcceptanceIri(relay, g, podName);
      if (!parsed || found.has(g)) continue;
      found.set(g, {
        acceptanceIri: g, descriptorUrl: String(e['descriptorUrl'] ?? ''), naming: parsed.naming,
        owner: parsed.owner, slug: parsed.slug, workspace: parsed.workspace,
      });
    }
  }
  const candidates = [...found.values()];

  /** Read one candidate's own document: its status always, its workspace when the name lacks one. */
  const readOne = async (c: WorkspaceEntry): Promise<void> => {
    const fromName = c.workspace;
    try {
      const d = await client.descriptor(c.descriptorUrl);
      const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', c.acceptanceIri);
      if (region === null) {
        c.why = 'its signed region could not be located, so nothing was read out of bytes anybody signed — '
          + 'including whether it still stands';
        return;
      }
      c.modalStatus = readModalStatus(region);
      // A qualified name has already settled which workspace this is for, and the filename is
      // what every other reader composes from — so the document does not get to move it.
      if (!fromName) {
        c.workspace = readIri(region, 'wsp:workspace');
        if (c.workspace) c.owner = podOfNsIri(c.workspace);
        else if (!isRetracted(region)) {
          c.why = 'this acceptance names no wsp:workspace, so which workspace it is for is not established';
        }
      }
    } catch (e) {
      c.why = 'its descriptor could not be read: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code));
    }
  };
  for (let i = 0; i < candidates.length; i += STATUS_READ_CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + STATUS_READ_CONCURRENCY).map(readOne));
  }

  const entries: WorkspaceEntry[] = [];
  const withheld: WithheldAcceptance[] = [];
  for (const c of candidates) {
    const retired = (c.modalStatus ?? '').toLowerCase() === MODAL_RETRACTED.toLowerCase();
    if (retired) {
      withheld.push({
        acceptanceIri: c.acceptanceIri, descriptorUrl: c.descriptorUrl, naming: c.naming,
        kind: 'retired', modalStatus: c.modalStatus ?? null, workspace: c.workspace,
        why: 'this acceptance states iep:modalStatus "' + String(c.modalStatus)
          + '", so the pod that published it has withdrawn it. It is a record of a membership that was, not one you are in.',
      });
      continue;
    }
    if (!c.workspace) {
      withheld.push({
        acceptanceIri: c.acceptanceIri, descriptorUrl: c.descriptorUrl, naming: c.naming,
        kind: 'unreadable', modalStatus: c.modalStatus ?? null, workspace: null,
        why: (c.why ?? 'which workspace this acceptance is for could not be established')
          + '. It is NOT being read as withdrawn: '
          + (c.modalStatus
            ? 'it states iep:modalStatus "' + c.modalStatus + '", which is not a retraction.'
            : 'it states no iep:modalStatus at all, and a read that failed looks the same from here as a record that was retired.'),
      });
      continue;
    }
    entries.push(c);
  }
  return { entries, withheld, scanned: rows.length };
}

/**
 * Verify one listed workspace against its convener's pod. Mutates in place.
 *
 * The same routine an invitation goes through, so a workspace you accepted and were then revoked
 * from cannot keep looking live.
 */
export async function verifyWorkspaceEntry(
  client: WorkspaceClient, relay: string, viewer: Viewer, c: WorkspaceEntry,
): Promise<WorkspaceEntry> {
  if (!c.workspace) { c.verified = false; return c; }
  try {
    c.verdict = await findSeat(client, { relay, viewer, workspace: c.workspace });
    // ★ THREE ANSWERS, THREE VALUES. `true` seats you; `false` is a conclusion that you are not
    // seated; `undefined` is this read not having established either — see the field.
    c.verified = c.verdict.ok ? true : (c.verdict.basis === 'answered' ? false : undefined);
    c.title = c.verdict.title ?? '';
    if (!c.verdict.ok) c.why = c.verdict.why;
  } catch (e) {
    // ★ AND A THROW IS THE SAME THIRD STATE, not a fourth. Nothing was established about this
    // workspace, so saying "not verified" of it would be this client's transport failure rendered
    // as a fact about somebody's membership.
    c.verified = undefined;
    c.why = errorCopy(e).t;
  }
  return c;
}

// ── roles are DATA, and a label that was not read is not a label ─────────────

/** A role table as `parseRoleProfile` returns it. */
export interface RoleTable {
  readonly roles: Map<string, { readonly label: string; readonly comment: string; readonly permits: readonly string[] }> | null;
  readonly caps: Map<string, { readonly label: string; readonly comment: string }> | null;
}

/**
 * ★ A ROLE NAME IS READ FROM THE ROLE TABLE, OR IT IS NOT A NAME.
 *
 * This used to fall back to the IRI's FRAGMENT, so a grant naming a role out of some OTHER
 * workspace's table rendered as a confident label — "Convener" — while the capability list
 * beside it was silently omitted because the lookup that would fill it had failed. Reproduced on
 * a grant that exists on the live relay: its workspace names one role profile and the grant
 * names a role in another. A fragment is a string somebody chose; the label is what THIS
 * workspace's own table says.
 */
export function roleName(table: RoleTable, iri: string | null | undefined): string {
  if (iri && table.roles?.get(iri)) return (table.roles.get(iri) as { label: string }).label;
  if (!iri) return 'no role';
  if (!table.roles) return 'role not resolved';
  return 'role not in this table';
}

/** The long form, for a tooltip or a line of copy. Same three states. */
export function roleWhy(table: RoleTable, iri: string | null | undefined): string {
  if (!iri) return 'The grant names no wsp:role.';
  const r = table.roles?.get(iri);
  if (r) return 'Read from this workspace\'s own role table: ' + iri;
  if (!table.roles) {
    return 'This workspace\'s role profile has not resolved, so ' + iri + ' could not be looked up. The fragment of '
      + 'that IRI is not being shown as a label, because a fragment is a name its author chose and not this table\'s statement.';
  }
  return 'The grant names ' + iri + ', and this workspace\'s role table does not define it. So what that role permits '
    + 'here is not established, and no capability list is shown for it. A role IRI from another workspace\'s table is a '
    + 'real way for this to happen.';
}

/** True only when the workspace's own table defines it. */
export const roleKnown = (table: RoleTable, iri: string | null | undefined): boolean => !!(iri && table.roles?.get(iri));

/** Reject a role at CLICK, not only at render — see the note in the invite path. */
export function checkRoleForWorkspace(table: RoleTable, iri: string): { readonly ok: boolean; readonly why: string } {
  if (roleKnown(table, iri)) return { ok: true, why: roleWhy(table, iri) };
  const known = table.roles && table.roles.size
    ? 'The roles this workspace\'s table does define are: ' + [...table.roles.values()].map((r) => r.label).join(', ') + '.'
    : 'This workspace\'s role profile has not resolved, so there is no role to grant at all.';
  return { ok: false, why: roleWhy(table, iri) + ' Nothing was published and nobody was notified. ' + known };
}
