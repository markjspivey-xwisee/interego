/**
 * WHAT A WORKSPACE ADDS TO A RELAY CLIENT — and nothing else.
 *
 * ★ THE CLIENT ITSELF IS NOT HERE ANY MORE. Reading a chain head, turning an in-fleet descriptor
 * URL into bytes, telling a failed manifest read from an empty one, following a page to the Turtle
 * it advertises, and the three-state write that only says "readable" once the head is your own
 * descriptor — every one of those is a statement about the RELAY, needed by every client in every
 * vertical, and they sat in this vertical's package where a peer had to reach sideways for them.
 * They are `RelayClient` in `@interego/core/relay` now.
 *
 * Two methods stayed, because two of them really were the workspace's: resolving a MEMBER DOCUMENT
 * under either naming form, and reading a `wsp:`-typed workspace record out of a signed region.
 * {@link WorkspaceClient} IS a `RelayClient` with those two added — composition, so there is still
 * exactly one implementation of everything it inherits and no second client to keep in agreement.
 */

import { RelayClient, type HeadResult } from '@interego/core/relay';
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
 * A {@link RelayClient} that also knows what a workspace's own documents are.
 *
 * Constructed with a transport rather than a token, like its base: what authenticates the calls
 * is the transport's business, and this must work identically under a connector grant and under
 * a relay OAuth bearer or the artifact and the desktop app would drift.
 */
export class WorkspaceClient extends RelayClient {
  /**
   * The eleven tools, bound. The base takes the list because it has no opinion about which tools
   * a particular client needs; this one does, and it is `REQUIRED_TOOLS`.
   */
  override connect(): Promise<{ granted: readonly string[] }> {
    return super.connect(REQUIRED_TOOLS, PROBE_TOOL);
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
}

/**
 * The substrate's relay surface, re-exported so this package's consumers — and the generated
 * artifact bundle — reach ONE implementation. Nothing below is defined here.
 */
export { RelayClient, errorCopy, assertPod, ToolCallError } from '@interego/core/relay';
export type { HeadResult } from '@interego/core/relay';
