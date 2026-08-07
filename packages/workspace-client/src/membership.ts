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

import { acceptanceTurtle, grantTurtle, rolesTurtle, shapesTurtle, workspaceTurtle } from './documents.js';
import {
  nsIri, parseAcceptanceIri, podOfDescriptorUrl, podOfNsIri, podOfWebid, POD_RX, qualifiedName,
  slugProblem, type Naming,
} from './naming.js';
import { graphRegion, hasTrue, readIri } from './turtle.js';
import { fail, refusal } from './transport.js';
import { assertPod, errorCopy, type HeadResult, type WorkspaceClient } from './substrate.js';

/**
 * One line of evidence behind a verdict.
 *
 * `y` / `n` are findings. `q` is "this was not established" — and it is a THIRD value on
 * purpose: a check that could not run is not a check that failed, and collapsing the two is how
 * absence gets rendered as a negative fact.
 */
export interface Check {
  readonly mark: 'y' | 'n' | 'q';
  readonly text: string;
  /** Detail a shell may show on hover — typically an address a reader cannot fetch. */
  readonly detail?: string;
}

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
    label: string, iri: string, content: string, shapes?: readonly string[],
  ): Promise<{ readonly ok: true; readonly readable: boolean; readonly why: string | null; readonly head: HeadResult | undefined } | { readonly ok: false; readonly out: CreateOutcome }> => {
    const publishArgs: Record<string, unknown> = {
      graph_iri: iri, graph_content: content, visibility: 'public',
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

  let step = await publish('shape contract', shapeIri, shapesTurtle(shapeIri));
  if (!step.ok) return step.out;
  if (!step.readable) {
    return { kind: 'stalled', at: 'shape contract', done: done.slice(),
      why: (step.why ?? '') + ' Everything after this names it, and a name that does not resolve makes the relay refuse the write rather than publish it unvalidated.' };
  }

  step = await publish('role table', rolesIri, rolesTurtle(rolesIri));
  if (!step.ok) return step.out;
  if (!step.readable) return { kind: 'stalled', at: 'role table', why: step.why ?? '', done: done.slice() };

  step = await publish('workspace record', workspace,
    workspaceTurtle({ workspace, title: args.title, convenerWebId: me, rolesIri, shapeIri }), [shapeIri]);
  if (!step.ok) return step.out;
  if (!step.readable) return { kind: 'stalled', at: 'workspace record', why: step.why ?? '', done: done.slice() };

  step = await publish('your own grant', grantIri,
    grantTurtle({ grant: grantIri, workspace, granteeWebId: me, role: rolesIri + '#Convener' }), [shapeIri]);
  if (!step.ok) return step.out;
  if (!step.readable) return { kind: 'stalled', at: 'your own grant', why: step.why ?? '', done: done.slice() };
  const head = step.head;
  const grantCid = head && !head.forked ? head.cid : null;

  step = await publish('your acceptance', acceptanceIri,
    acceptanceTurtle({ acceptance: acceptanceIri, workspace, memberWebId: me, grant: grantIri, grantCid, stream: streamIri }), [shapeIri]);
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
export async function sendInvite(
  client: WorkspaceClient,
  args: {
    readonly viewer: Viewer;
    readonly workspace: string;
    readonly workspaceTitle: string;
    readonly handle: string;
    readonly role: string;
    readonly entryShape: string | null;
    readonly onState?: (state: string, detail: string) => void;
  },
): Promise<InviteOutcome> {
  let who: InviteeResolution;
  try { who = await resolveInvitee(client, args.handle); }
  catch (e) { return { kind: 'resolve-failed', error: e }; }
  if (who.blocked) return { kind: 'blocked', resolution: who };

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
  readonly owner?: string;
  readonly grantCid?: string | null;
  readonly grantedTo?: string | null;
  readonly role?: string | null;
  readonly revoked?: boolean;
  readonly workspace?: string;
  readonly title?: string;
  readonly convener?: string | null;
  readonly roleProfile?: string | null;
  readonly entryShape?: string | null;
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
  const no = (why: string, extra?: Partial<GrantVerdict>): GrantVerdict => {
    checks.push({ mark: 'n', text: why });
    return { grantIri: args.grantIri, checks, ok: false, why, ...extra };
  };
  const grantIri = args.grantIri;
  const m = GRANT_IRI_RX.exec(grantIri || '');
  if (!m || grantIri.indexOf(args.relay + '/ns/') !== 0) {
    return no('that is not a grant IRI in this relay\'s namespace, so there is nothing on a pod to check it against');
  }
  const owner = m[1] as string;
  const target = m[3] as string;
  if (!POD_RX.test(owner)) return no('the pod segment in that IRI is not a pod identifier');
  if (nameMustTargetMe && target !== args.viewer.podName) {
    return no('that grant is addressed to pod ' + target + ', and you are ' + args.viewer.podName);
  }
  checks.push({ mark: 'y', text: nameMustTargetMe
    ? 'The grant IRI is on pod ' + owner + ' and names your pod in its own name'
    : 'The grant was found on pod ' + owner + ', the pod this workspace\'s own IRI names' });

  let h: HeadResult;
  try { h = await client.currentHead(grantIri, owner); }
  catch (e) { return no('the grant could not be read from ' + owner + ': ' + ((e as Error)?.message ?? String((e as { code?: string })?.code)), { owner }); }
  if (h.forked) return no('that grant\'s chain has ' + h.heads.length + ' unresolved heads, so which grant is current is not decided', { owner });
  if (h.url === null) {
    // Two different facts, and only one of them is "no grant is published there".
    return no('unreadable' in h
      ? 'the read of that IRI on pod ' + owner + ' did not resolve, so whether a grant is published there is not established — ' + h.message
      : 'no grant is published at that IRI on pod ' + owner + ' — ' + (h.message || 'the relay gave no reason'), { owner });
  }
  const grantCid = h.cid;
  let d: Record<string, unknown>;
  try { d = await client.descriptor(h.url); }
  catch (e) { return no('the grant\'s descriptor could not be fetched: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code)), { owner, grantCid }); }
  const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', grantIri);
  if (region === null) return no('the signed region of that grant could not be located, so nothing was read from bytes anybody signed', { owner, grantCid });
  checks.push({ mark: 'y', text: 'Its signed region was located on ' + owner + '\'s pod' });

  const base: Partial<GrantVerdict> = {
    owner, grantCid, grantAuthorship: d['authorship'] ?? null,
    grantedTo: readIri(region, 'wsp:grantedTo'),
    role: readIri(region, 'wsp:role'),
    revoked: hasTrue(region, 'wsp:revoked'),
  };
  if (base.revoked) return no('that grant carries wsp:revoked true', base);
  if (!base.grantedTo) return no('the grant names no wsp:grantedTo', base);
  if (base.grantedTo !== args.viewer.webId) {
    return no('the grant names ' + base.grantedTo + ', and your pod reports your WebID as ' + (args.viewer.webId || 'none'), base);
  }
  checks.push({ mark: 'y', text: 'It names your own WebID as grantee' });
  const workspace = readIri(region, 'wsp:workspace');
  if (!workspace) return no('the grant names no wsp:workspace', base);
  const withWs: Partial<GrantVerdict> = { ...base, workspace };

  // The workspace record itself, read from the pod its own IRI names, so the convener it
  // declares can be held against the pod the grant is on.
  const wsOwner = podOfNsIri(workspace);
  if (!wsOwner) return no('the workspace IRI in that grant is not one this reader can read a pod out of', withWs);
  const rec = await client.readWorkspaceRecord(workspace, wsOwner).catch((e: unknown) => ({ kind: 'error' as const, error: e }));
  if (rec.kind === 'forked') return no('the workspace record at ' + workspace + ' has ' + rec.heads.length + ' unresolved heads, so it has no single current head', withWs);
  if (rec.kind === 'missing') return no('the workspace record at ' + workspace + ' could not be read: ' + rec.message, withWs);
  if (rec.kind === 'error') return no('the workspace record could not be read: ' + ((rec.error as Error)?.message ?? String(rec.error)), withWs);
  if (!rec.record.regionFound) return no('the workspace record\'s signed region could not be located', withWs);
  const full: Partial<GrantVerdict> = {
    ...withWs, title: rec.record.title, convener: rec.record.convener,
    roleProfile: rec.record.roleProfile, entryShape: rec.record.entryShape,
  };
  const cp = rec.record.convenerPod;
  if (!cp) return no('the workspace names no convener this reader can resolve to a pod', full);
  if (cp !== owner) {
    return no('the workspace\'s convener resolves to pod ' + cp + ', and this grant is on pod ' + owner
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
    return no('that grant is at ' + grantIri + ', and the workspace it names is ' + workspace
      + ' — so it is not one of that workspace\'s own "' + workspace + '-grant-…" documents. '
      + 'Every reader of this workspace looks only under that prefix, so accepting it would write a real '
      + 'acceptance that seats you on nobody\'s roster.', full);
  }
  checks.push({ mark: 'y', text: 'Its IRI is one of ' + workspace + '\'s own grant names, which is where every reader looks' });
  return { grantIri, checks, ok: true, ...full } as GrantVerdict;
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
  if (!args.grantedTo || !args.role) {
    return { kind: 'incomplete', why: 'Republishing this grant means restating what it says, and '
      + (!args.grantedTo ? 'its wsp:grantedTo' : 'its wsp:role') + ' could not be read out of its signed region. '
      + 'Rewriting it with a field missing would be this client deciding what the grant says.' };
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
  const all = Array.isArray(p?.['items']) ? p?.['items'] as Record<string, unknown>[] : [];
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
    inv.verdict = { grantIri: about, ok: false, why: t, checks: [{ mark: 'n', text: t }] };
  }
  inv.state = 'checked';
  // A workspace IRI is not a grant and is not treated as one — but it IS a lead, and the
  // fallback scan turns it into one without believing anything the inbox said.
  inv.lead = !inv.verdict.ok && /^https:\/\/[^/]+\/ns\/[^/]+\/[^/]+$/.test(about) && !/-grant-/.test(about)
    ? about : null;
  return inv;
}

// ── does anything on that pod seat me? ───────────────────────────────────────

/** How many entries a pod is scanned for when the composed grant name did not answer. */
export const SEAT_SCAN_LIMIT = 400;
/** How many of the grants that scan FINDS are then read. Each read is two round trips. */
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
    return { grantIri: args.workspace, ok: false, checks: [], why: 'that is not a workspace IRI this reader can read a pod out of' };
  }
  const direct = await verifyGrantIri(client, { relay: args.relay, viewer: args.viewer, grantIri: args.workspace + '-grant-' + args.viewer.podName });
  if (direct.ok) return direct;

  let rows: readonly Record<string, unknown>[];
  let saturated = false;
  try {
    const p = await client.tool('discover_context', { pod_name: owner, limit: SEAT_SCAN_LIMIT, sort: 'newest-first' }) as Record<string, unknown> | null;
    const bad = refusal(p);
    if (bad) return { grantIri: direct.grantIri, ok: false, checks: direct.checks, why: String(bad['message'] ?? bad['error']) };
    assertPod(owner, p?.['pod'], 'discover_context');
    rows = (p?.['entries'] as readonly Record<string, unknown>[]) ?? [];
    saturated = rows.length >= SEAT_SCAN_LIMIT;
  } catch (e) {
    const t = errorCopy(e).t;
    return { grantIri: direct.grantIri, ok: false, checks: direct.checks, why: t + ((e as Error)?.message ? ' — ' + (e as Error).message : '') };
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
  // ★ THE TRUNCATION GOES INTO THE SENTENCE, NOT ONTO AN UNREAD FLAG. A `saturated` boolean
  // lived on this return and no caller ever read it, so a scan that came back full said "none of
  // them names you" with nothing about the scan having been cut off.
  const capNote = saturated ? '. That scan of ' + owner + ' came back full at ' + SEAT_SCAN_LIMIT
    + ' descriptors, so an older grant may lie past the end of it' : '';
  if (!grants.length) {
    return { grantIri: direct.grantIri, ok: false, checks: direct.checks,
      why: 'no grant for this workspace appeared among the ' + rows.length + ' most recent descriptors on ' + owner + capNote };
  }

  // ★ WHICH FAILURE TO REPORT. A workspace has grants for everybody in it, so most fail this
  // reader's check for the boring reason that they are somebody else's. If ONE of them is about
  // you and failed for its own reason — revoked, say — that is the reason worth telling you, and
  // reporting whichever happened to be read last buried it behind "this grant names somebody else".
  let mine: GrantVerdict | null = direct.grantedTo === args.viewer.webId ? direct : null;
  let last: GrantVerdict | null = null;
  let read = 0;
  for (const g of grants) {
    if (read >= SEAT_READ_CAP) break;
    read++;
    const v = await verifyGrantIri(client, { relay: args.relay, viewer: args.viewer, grantIri: g, nameMustTargetMe: false });
    if (v.ok) return v;
    if (!mine && v.grantedTo === args.viewer.webId) mine = v;
    last = v;
  }
  const pick = mine ?? last;
  return {
    grantIri: direct.grantIri, ok: false, checks: pick?.checks ?? direct.checks,
    why: (mine
      ? 'a grant for this workspace does name you, and it does not seat you: ' + mine.why
      : read + ' grant' + (read === 1 ? '' : 's') + ' for this workspace on ' + owner
        + ' were read and none of them names you'
        + (grants.length > read ? ' (of ' + grants.length + ' found; this reader reads at most ' + SEAT_READ_CAP + ')' : '')
        + (last?.why ? ' — the last one: ' + last.why : '')) + capNote,
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
  /** undefined = not verified yet. A real third state, and shells must render it as one. */
  verified?: boolean;
  verdict?: GrantVerdict;
  title?: string;
  why?: string;
}

export interface WorkspaceList {
  readonly entries: readonly WorkspaceEntry[];
  readonly saturated: boolean;
  readonly limit: number;
}

/**
 * Every workspace this viewer has ACCEPTED, read from their own pod in ONE manifest read.
 *
 * A workspace-qualified acceptance name carries the convener pod and the slug inside it, so the
 * list needs no descriptor reads at all — that is the whole reason the qualified form exists.
 * Only the older unqualified names cost one each.
 *
 * ★ THE ENTRY DESCRIBING YOUR OWN POD IS NOT A WORKSPACE. `parseAcceptanceIri` only matches
 * names ending `-acceptance` under `/ns/<your pod>/`, so the pod's own profile descriptor and
 * every other graph on it fall out here rather than being listed as somewhere you are a member.
 */
export async function listWorkspaces(
  client: WorkspaceClient, relay: string, podName: string, limit = SEAT_SCAN_LIMIT,
): Promise<WorkspaceList> {
  // `cache: false`, not an omitted option: this list is re-read immediately after an Accept, and
  // a host-cached answer from before that write would show the viewer a workspace list that does
  // not contain the workspace they just joined.
  const p = await client.tool('discover_context', { pod_name: podName, limit, sort: 'newest-first' }, { cache: false }) as Record<string, unknown> | null;
  const bad = refusal(p);
  if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
  assertPod(podName, p?.['pod'], 'discover_context');
  const rows = (p?.['entries'] as readonly Record<string, unknown>[]) ?? [];
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
  const entries = [...found.values()];
  // An unqualified name says nothing about which workspace it accepts, so THAT one is read —
  // one descriptor each, and only for those.
  for (const c of entries) {
    if (c.workspace) continue;
    try {
      const d = await client.descriptor(c.descriptorUrl);
      const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', c.acceptanceIri);
      if (region === null) { c.why = 'its signed region could not be located'; continue; }
      c.workspace = readIri(region, 'wsp:workspace');
      if (!c.workspace) c.why = 'this acceptance names no wsp:workspace, so which workspace it is for is not established';
      else c.owner = podOfNsIri(c.workspace);
    } catch (e) {
      c.why = 'its descriptor could not be read: ' + ((e as Error)?.message ?? String((e as { code?: string })?.code));
    }
  }
  return { entries, saturated: rows.length >= limit, limit };
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
    c.verified = c.verdict.ok;
    c.title = c.verdict.title ?? '';
    if (!c.verified) c.why = c.verdict.why;
  } catch (e) {
    c.verified = false;
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
