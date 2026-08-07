/**
 * Reading and writing the substrate through relay tools, over an injected {@link Transport}.
 *
 * ★ EVERY READ GOES THROUGH A RELAY TOOL AND NOTHING HERE DEREFERENCES A DESCRIPTOR URL.
 * Descriptor URLs come back as `http://css.railway.internal:3456/…` — an address inside the
 * fleet, not reachable from a browser or a desktop machine. `get_descriptor` is the only way
 * to turn one into bytes from outside, so it is the only way used.
 */

import {
  type AnyTransport, type CallOptions, ToolCallError, fail, refusal,
} from './transport.js';
import { graphRegion, readIri, readLiteral } from './turtle.js';
import { memberDocIris, type MemberDocKind, type Naming, podOfDescriptorUrl, podOfWebid } from './naming.js';

/** The eleven tools this client calls, and the manifest a published artifact must be given. */
export const REQUIRED_TOOLS = [
  'dereference', 'discover_context', 'get_current_head', 'get_descriptor',
  'get_pod_status', 'invoke_affordance', 'notify_agent', 'publish_context', 'read_inbox',
  'resolve_webfinger', 'verify_agent',
] as const;

/**
 * The one probed for. Any of the eleven would do; this is the first call boot makes, so a
 * grant missing it cannot get past the first step anyway.
 */
export const PROBE_TOOL = 'get_pod_status';

/** A title and a detail for an error code, in words that match what actually happened. */
export function errorCopy(err: unknown): { readonly t: string; readonly d: string } {
  const e = err as { code?: string; message?: string } | null;
  const c = e?.code ?? 'upstream_error';
  switch (c) {
    case 'needs_reauth': return { t: 'This session has expired', d: e?.message ?? 'Sign in again to mint a fresh token.' };
    case 'server_not_connected': return { t: 'No connector answered', d: e?.message ?? '' };
    case 'manifest_incomplete': return { t: 'The tool manifest is incomplete', d: e?.message ?? '' };
    case 'selection_required': return { t: 'Choose a connector', d: 'More than one connector answers to this name and none has been picked yet.' };
    case 'not_in_manifest': return { t: 'Tool outside this grant', d: 'A tool was called that the viewer did not consent to. ' + (e?.message ?? '') };
    case 'blocked_by_policy': return { t: 'Blocked by policy', d: 'Your organisation blocks this tool here.' };
    case 'approval_required': return { t: 'Needs approval', d: 'Your organisation requires per-call approval, which this client cannot request.' };
    case 'not_granted': return { t: 'No connector access', d: 'This view did not grant connector access.' };
    case 'capability_disabled':
    case 'capability_removed': return { t: 'Connectors unavailable here', d: 'This view reached no connector runtime at all.' };
    case 'server_unavailable': return { t: 'The relay did not answer', d: e?.message ?? 'Temporary. Try again in a moment.' };
    case 'tool_error': return { t: 'The relay reported a failure', d: e?.message ?? '' };
    default: return { t: 'Could not complete the call', d: e?.message ?? String(c) };
  }
}

/**
 * THE POD ECHO, checked on every cross-pod read.
 *
 * MEASURED: `get_current_head` and `discover_context` both echo which pod they answered for —
 * `podUrl` and `pod` respectively. A read that quietly fell back to the CALLER'S OWN pod would
 * be invisible in a workspace where the caller is also the convener, and catastrophic in one
 * where they are not: the roster would be folded from the wrong pod's documents. So the echo
 * is compared, once, here, and a mismatch is an error rather than a silent answer.
 */
export function assertPod(asked: string | null | undefined, gotUrl: unknown, where: string): void {
  if (!asked) return;
  const got = typeof gotUrl === 'string' ? gotUrl.replace(/\/$/, '').split('/').pop() : null;
  if (!got) return;                       // not reported is not a mismatch
  if (got !== asked) {
    throw fail('tool_error', where + ' was asked for pod ' + asked + ' and the response says it answered for pod '
      + got + '. These disagree, so nothing is being read out of it.');
  }
}

/**
 * FOUR OUTCOMES, KEPT APART ON PURPOSE. "The relay said nothing is here" and "this reader
 * could not make sense of the answer" are different facts, and only the first of them
 * licenses offering to create the document.
 */
export type HeadResult =
  | { readonly forked: true; readonly heads: readonly unknown[]; readonly message: string }
  | { readonly forked: false; readonly url: string; readonly cid: string | null; readonly headError: string | null; readonly message: string | null }
  | { readonly forked: false; readonly url: null; readonly cid: null; readonly absent: true; readonly message: string }
  | { readonly forked: false; readonly url: null; readonly cid: null; readonly unreadable: true; readonly message: string };

/** A workspace record, as far as it could be read. Every field says how it was obtained. */
export interface WorkspaceRecord {
  readonly head: Extract<HeadResult, { url: string }>;
  /** `graphRegion` returned a string. `''` counts — see the note on `graphRegion`. */
  readonly regionFound: boolean;
  readonly convener: string | null;
  readonly roleProfile: string | null;
  readonly entryShape: string | null;
  readonly grantCapability: string | null;
  readonly title: string;
  readonly authorship: unknown;
  readonly convenerPod: string | null;
  readonly servedFrom: string | null;
}

/** What happened when a member document was looked for under both naming forms. */
export interface MemberDocLookup {
  readonly iri: string;
  readonly naming: Naming;
  readonly found: boolean;
  readonly head: Extract<HeadResult, { url: string }> | null;
  readonly forked: Extract<HeadResult, { forked: true }> | null;
  readonly error: string | null;
}

/**
 * The substrate surface a workspace client needs, over one transport.
 *
 * Constructed with a transport rather than a token: what authenticates the calls is the
 * transport's business, and this class must work identically under a connector grant and
 * under a relay OAuth bearer or the artifact and the desktop app would drift.
 */
export class WorkspaceClient {
  readonly relay: string;
  private readonly transport: AnyTransport;

  constructor(relay: string, transport: AnyTransport) {
    this.relay = relay.replace(/\/$/, '');
    this.transport = transport;
  }

  get tx(): AnyTransport { return this.transport; }

  /** Raw tool call. Everything below composes this and nothing else. */
  tool(name: string, input: Record<string, unknown>, opts?: CallOptions): Promise<unknown> {
    return this.transport.callTool(name, input, opts);
  }

  connect(): Promise<{ granted: readonly string[] }> {
    return this.transport.connect(REQUIRED_TOOLS, PROBE_TOOL);
  }

  /** `get_pod_status` — who the viewer is, and the only pod they can write to. */
  async podStatus(): Promise<Record<string, unknown>> {
    const p = await this.tool('get_pod_status', {}) as Record<string, unknown>;
    const bad = refusal(p);
    if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
    return p ?? {};
  }

  /**
   * The current head of a chain, on a named pod.
   *
   * ★ THE BRANCH THAT WAS DEAD, AND WHAT IT COST. This used to test `'head' in p` — the
   * PRESENCE of the key — as the signal that the relay had answered "nothing is here".
   * MEASURED against the live relay: a graph that was never written answers
   * `{urn, podUrl, message:"No descriptor on this pod describes the requested urn."}` with NO
   * `head` key at all. So the absent branch never ran on this fleet and every unpublished
   * graph fell through to "unreadable" — a canvas that never offered Create to anybody who
   * had not already written one, and a granted-but-unaccepted member reading "their
   * acceptance could not be resolved" instead of "invited". It survived three rounds because
   * a test harness's stand-in returned `head: null` explicitly, which the relay never does.
   */
  async currentHead(urn: string, podName: string): Promise<HeadResult> {
    const p = await this.tool('get_current_head', { urn, pod_name: podName }) as Record<string, unknown> | null;
    const bad = refusal(p);
    if (bad) throw fail('tool_error', String(bad['message'] ?? bad['error']));
    assertPod(podName, p?.['podUrl'], 'get_current_head');
    if (p?.['forked']) {
      return { forked: true, heads: (p['heads'] as readonly unknown[]) ?? [], message: String(p['message'] ?? '') };
    }
    const head = p?.['head'] as { descriptorUrl?: string; cid?: string; error?: string } | undefined;
    if (head?.descriptorUrl) {
      return {
        forked: false, url: head.descriptorUrl, cid: head.cid ?? null,
        // A head whose body could not be fetched still reports a URL, with no CID and an error
        // string. That is not a readable head.
        headError: head.error ?? null,
        message: (p?.['message'] as string) ?? null,
      };
    }
    if (p && !head && typeof p['message'] === 'string' && p['message']) {
      return { forked: false, url: null, cid: null, absent: true, message: p['message'] };
    }
    // Reserved for a response carrying neither a head nor a reason — a read this client cannot
    // interpret, NOT a statement that nothing is there.
    return {
      forked: false, url: null, cid: null, unreadable: true,
      message: "the relay's answer carried neither a head nor a reason, so whether anything is published here is not established",
    };
  }

  /** `get_descriptor` — the only way to turn an in-fleet descriptor URL into bytes. */
  async descriptor(url: string): Promise<Record<string, unknown>> {
    const p = await this.tool('get_descriptor', { url }, { cache: { staleTime: 120000 } }) as Record<string, unknown> | null;
    if (refusal(p)) throw fail('tool_error', String(p?.['message'] ?? p?.['error']));
    return p ?? {};
  }

  /**
   * One manifest read of one graph on one pod.
   *
   * A FAILED read must not look like an EMPTY one, so a response without an entries array
   * throws rather than returning `[]`.
   */
  async manifest(podName: string, graphIri: string): Promise<readonly Record<string, unknown>[]> {
    const p = await this.tool('discover_context', { pod_name: podName, graph_iri: graphIri, sort: 'oldest-first' }) as Record<string, unknown> | null;
    if (refusal(p)) throw fail('tool_error', String(p?.['message'] ?? p?.['error']));
    assertPod(podName, p?.['pod'], 'discover_context');
    const entries = p?.['entries'];
    if (!Array.isArray(entries)) {
      throw fail('tool_error', 'discover_context on ' + podName + ' returned no entries array, so this stream could not be read at all — which is not the same as the member having written nothing.');
    }
    return (entries as Record<string, unknown>[]).filter((e) => {
      const d = e['describes'];
      return Array.isArray(d) && d.indexOf(graphIri) >= 0;
    });
  }

  /**
   * A member document under either naming form, qualified first.
   *
   * Which one answered is carried back, because a member seated under the old name is seated
   * by a document that cannot tell two workspaces apart — and that is worth saying rather
   * than smoothing over.
   */
  async resolveMemberDoc(memberPod: string, convenerPod: string, slug: string, kind: MemberDocKind): Promise<MemberDocLookup> {
    const candidates = memberDocIris(this.relay, memberPod, convenerPod, slug, kind);
    let firstError: string | null = null;
    for (const c of candidates) {
      try {
        const h = await this.currentHead(c.iri, memberPod);
        if (h.forked) return { iri: c.iri, naming: c.naming, found: false, head: null, forked: h, error: null };
        if (h.url) return { iri: c.iri, naming: c.naming, found: true, head: h, forked: null, error: null };
        // ★ AN UNREADABLE HEAD IS NOT AN ABSENT ONE, AND ONLY THE THROW USED TO BE CARRIED.
        // `currentHead` already separates "the relay said nothing is published here" (absent)
        // from "the answer carried neither a head nor a reason" (unreadable). Both arrive here
        // as a resolved value with no `url`, so a loop that only recorded EXCEPTIONS returned
        // `error: null` for the unreadable case — and every caller reads `error: null` as
        // licence to say "granted, but no acceptance published on their pod yet". That is
        // absence rendered as a positive fact about somebody else's pod, from a read that
        // established nothing. The `unreadable` message is carried as an error instead.
        if ('unreadable' in h && firstError === null) firstError = h.message;
      } catch (e) {
        if (firstError === null) firstError = (e as Error)?.message ?? String(e);
      }
    }
    // Nothing answered. The QUALIFIED name is the one reported back, because that is where a
    // write would go — reporting the legacy name would offer to create a document under a name
    // this client has decided not to write any more.
    const primary = candidates[0] as { iri: string; naming: Naming };
    return { iri: primary.iri, naming: primary.naming, found: false, head: null, forked: null, error: firstError };
  }

  /**
   * The workspace record itself.
   *
   * ★ NO FALLBACK TO THE WHOLE DOCUMENT. Only the signed region is read — falling back to
   * `d.turtle` would read the unsigned descriptor as if it were the payload, which is the
   * opposite of what every field below claims.
   */
  async readWorkspaceRecord(workspaceIri: string, ownerPod: string): Promise<
    | { readonly kind: 'record'; readonly record: WorkspaceRecord }
    | { readonly kind: 'forked'; readonly message: string; readonly heads: readonly unknown[] }
    | { readonly kind: 'missing'; readonly unreadable: boolean; readonly message: string }
  > {
    const h = await this.currentHead(workspaceIri, ownerPod);
    if (h.forked) return { kind: 'forked', message: h.message, heads: h.heads };
    // `=== null` rather than falsiness: the readable variant types `url` as `string`, so a
    // truthiness test does not narrow the union and `message` stays `string | null`.
    if (h.url === null) return { kind: 'missing', unreadable: 'unreadable' in h, message: h.message };
    const d = await this.descriptor(h.url);
    const graph = d['graph'] as { content?: string } | undefined;
    const region = graphRegion(graph?.content ?? '', workspaceIri);
    const convener = readIri(region, 'wsp:convener');
    return {
      kind: 'record',
      record: {
        head: h,
        // `null` and `''` are different answers and were being collapsed. Only `null` means
        // not found, so only `null` is tested for.
        regionFound: region !== null,
        convener,
        roleProfile: readIri(region, 'wsp:roleProfile'),
        // ★ THE CONFORMANCE CONTRACT, READ RATHER THAN CHOSEN. A client that held one shape
        // IRI and validated every post against it was asserting its own contract under the
        // workspace's name.
        entryShape: readIri(region, 'wsp:entryShape'),
        grantCapability: readIri(region, 'wsp:grantCapability'),
        title: readLiteral(region, 'dct:title') ?? '',
        authorship: d['authorship'] ?? null,
        // The pod grants are read from is derived from the convener the record NAMES, not from
        // the pod segment inside the workspace IRI.
        convenerPod: podOfWebid(convener),
        servedFrom: podOfDescriptorUrl(h.url),
      },
    };
  }

  /**
   * One hop from a role-profile page to the Turtle it advertises.
   *
   * Our published profile is an HTML page on GitHub Pages carrying
   * `<link rel="alternate" type="text/turtle">`. Following the href the PAGE names is the only
   * correct way to get from the name to the document — guessing a filename is how a client
   * ends up reporting a role table nobody published.
   */
  async fetchProfileTurtle(iri: string): Promise<{ readonly turtle: string; readonly from: string; readonly hops: number }> {
    const first = await this.tool('dereference', { iri }, { cache: { staleTime: 300000 } }) as Record<string, unknown> | null;
    const rep = String(first?.['representation'] ?? '');
    const ct = String(first?.['contentType'] ?? '');
    if (first && first['status'] !== 'ok') {
      throw fail('tool_error', 'the role profile at ' + iri + ' did not resolve (' + String(first['httpStatus'] ?? first['status']) + ')');
    }
    const looksHtml = /html/i.test(ct) || /^\s*<(!doctype|html)/i.test(rep);
    if (!looksHtml) return { turtle: rep, from: iri, hops: 1 };
    const m = /<link[^>]+rel=["']?alternate["']?[^>]*>/gi;
    let href: string | null = null;
    let tag: RegExpExecArray | null;
    while ((tag = m.exec(rep))) {
      if (!/type=["']?text\/turtle/i.test(tag[0])) continue;
      const h = /href=["']([^"']+)["']/i.exec(tag[0]);
      if (h?.[1]) { href = h[1]; break; }
    }
    if (!href) throw fail('tool_error', 'the role profile page advertises no Turtle alternate, and this reader will not guess a filename for it');
    const abs = new URL(href, iri).toString();
    if (new URL(abs).origin !== new URL(iri).origin) {
      throw fail('tool_error', 'the profile page points its Turtle at a different origin, which would hand the governance to a different party');
    }
    const second = await this.tool('dereference', { iri: abs }, { cache: { staleTime: 300000 } }) as Record<string, unknown> | null;
    if (!second || second['status'] !== 'ok') throw fail('tool_error', 'the Turtle the profile page names did not resolve: ' + abs);
    return { turtle: String(second['representation'] ?? ''), from: abs, hops: 2 };
  }

  /**
   * ONE WRITE, THREE STATES, AND THE THIRD ONE IS CHECKED.
   *
   * Sending → the relay took it → it is READABLE. The middle state is the relay's own
   * `status`, and it is not the last one: a write is called readable only when
   * `get_current_head` returns a head whose descriptorUrl is the descriptorUrl this publish
   * returned. Backoff 400 ms → 5 s, about 30 s in total, then "accepted and not yet reported
   * readable" — which is neither saved nor failed, and says so.
   */
  async publishAndConfirm(
    args: Record<string, unknown>, podName: string, graphIri: string,
    onState?: (state: string, detail: string) => void,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<{ readonly res?: Record<string, unknown>; readonly readable?: boolean; readonly why?: string; readonly error?: unknown; readonly refusal?: unknown; readonly head?: HeadResult }> {
    const tell = (s: string, d: string): void => { try { onState?.(s, d); } catch { /* a reporter must not break a write */ } };
    tell('sending', 'Publishing ' + graphIri.replace(/^https:\/\//, ''));
    // ★ THE POD THE WRITE LANDS ON IS THE POD THE READ-BACK CHECKS, BY CONSTRUCTION.
    //
    // `podName` used to be used ONLY for the confirmation read below, and the publish itself
    // named no pod at all — so the relay filled it from the session. For a client that is the
    // pod owner those coincide and nothing showed. For a client acting on somebody ELSE'S pod
    // under a delegation they coincide never: the write landed on the caller's own pod, the
    // confirmation loop read the member's, found nothing, and the whole 30 s wait ended in
    // "accepted, not yet reported readable" — a sentence about the wrong pod entirely.
    //
    // MEASURED (2026-08-07, live relay, three disposable identities): `publish_context` honours
    // `pod_name` for a cross-pod target and gates it on the delegation registry alone —
    // an undelegated agent is refused `403 scope_violation, "agent is not registered on this
    // pod"`. So naming the pod is what makes the two halves of this method talk about one
    // document; it grants nothing that was not already granted on the pod itself.
    //
    // Only when the caller did not already name one: any future caller with its own opinion
    // about the target keeps it.
    const sent = typeof args['pod_name'] === 'string' ? args : { ...args, pod_name: podName };
    let res: Record<string, unknown>;
    try { res = await this.tool('publish_context', sent) as Record<string, unknown>; }
    catch (e) { tell('failed', errorCopy(e).t); return { error: e }; }
    const bad = refusal(res);
    if (bad) { tell('refused', String(bad['error'] ?? 'refused')); return { refusal: bad }; }
    const url = (res['descriptorUrl'] as string) ?? null;
    tell('accepted', 'The relay reported status ' + String(res['status'] ?? 'none') + (url ? '' : ' and named no descriptor URL'));
    if (!url) return { res, readable: false, why: 'the response named no descriptor URL, so there is nothing to read back and match' };
    let wait = 400;
    const until = Date.now() + 30000;
    let lastWhy: string | null = null;
    while (Date.now() < until) {
      await sleep(wait);
      wait = Math.min(Math.round(wait * 1.6), 5000);
      try {
        const h = await this.currentHead(graphIri, podName);
        if (h.forked) { lastWhy = 'the chain for this IRI has ' + h.heads.length + ' unresolved heads'; continue; }
        if (h.url === url) { tell('readable', 'Read back from ' + podName); return { res, readable: true, head: h }; }
        if (h.url) lastWhy = 'the head is a different descriptor (' + h.url + ')';
        else lastWhy = h.message || 'the relay reports no head for this IRI yet';
      } catch (e) { lastWhy = errorCopy(e).t; }
    }
    tell('pending', 'accepted, not yet reported readable');
    return { res, readable: false, why: lastWhy ?? 'the wait ran out before the head matched' };
  }
}

export { ToolCallError };
