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
// The three answers an opener may give. Type-only, so the browser bundle is unaffected.
import type { OpenedGraph } from './opener.js';
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

/**
 * Turns the sealed payload `get_encrypted_graph` returns into plaintext, or `null` if it is not
 * for this holder.
 *
 * ★★ THE HOST IMPLEMENTS THIS, AND THE HOST KEEPS THE KEY. Three answers, and the reason there are
 * three is that this used to have two: `not-for-you` and `unreadable` were both `null`, so a CSS
 * 502 during a redeploy became "you are not among this workspace's members" — said to somebody who
 * is one. A fault must never be reported as a permission; the readers render an unopened record as
 * a permission, so anything collapsed into that answer becomes an accusation about membership.
 */
export type GraphOpener = (sealed: unknown) => OpenedGraph;

/** A workspace record, as far as it could be read. Every field says how it was obtained. */
export interface WorkspaceRecord {
  readonly head: Extract<HeadResult, { url: string }>;
  /** `graphRegion` returned a string. `''` counts — see the note on `graphRegion`. */
  readonly regionFound: boolean;
  /**
   * True when the region is absent because the payload is ENCRYPTED and this reader is not
   * entitled to it — as opposed to absent because nothing was found.
   *
   * ★★ THE TWO ARE OPPOSITE CLAIMS AND WERE BEING COLLAPSED INTO ONE SENTENCE. "The signed region
   * could not be located" says a record is malformed — that somebody published bytes nobody
   * signed. Said about a perfectly good encrypted record, it is an accusation this vertical has no
   * business making, in a system whose whole argument is that it does not assert what it has not
   * established. `get_descriptor` already answers `{ content: null, encrypted: true }`; the flag
   * was read on the way in and dropped on the way to the reader.
   */
  readonly withheld: boolean;
  /**
   * Set when the sealed read FAILED rather than being refused — see `GraphOpener`.
   *
   * ★ `withheld` is still true, because the content is still absent; what this adds is WHY. A
   * reader that only had `withheld` could not tell "not yours" from "we could not fetch it", and
   * every caller therefore said the first.
   */
  readonly sealedReadFailed: string | null;
  /**
   * Whether this workspace's documents are published in the clear or encrypted to its members.
   *
   * ★★ ABSENT MEANS PUBLIC, AND THAT IS A DECISION RATHER THAN A DEFAULT. Every workspace
   * published before `wsp:visibility` existed carries no value, and a reader that read missing as
   * private would hide records that are not hidden — telling members a public conversation was
   * secret. The other direction is the one to be careful about, and it is why an UNRECOGNISED
   * value is also treated as public: a typo must not silently promise a privacy the writer never
   * arranged. Nothing validates this value at publish time, so the reader is the only place the
   * question is settled.
   */
  readonly visibility: 'public' | 'private' | 'unknown';
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
   * Opens sealed bytes. Supplied by the HOST, because the host is what holds the secret.
   *
   * ★ THIS PACKAGE NEVER SEES A PRIVATE KEY. The desktop app derives one in its main process from
   * the account key in the OS secret store and installs this; a published artifact installs
   * nothing and simply reads less. The split is deliberate — a shared client that took key
   * material would put it wherever the client runs, including a browser.
   */
  private opener: GraphOpener | null = null;

  /** Install (or clear) the local opener. See {@link GraphOpener}. */
  setGraphOpener(opener: GraphOpener | null): void { this.opener = opener; }

  /**
   * Sealed payloads are opened BEFORE they reach this client, by whatever it is talking to.
   *
   * ★★ THE DESKTOP RENDERER IS THIS CASE, AND WITHOUT IT THE APP LIES ABOUT ITSELF. The renderer
   * is sandboxed and holds no key on purpose; its reads go over an IPC bridge to the main process,
   * which opens them there. So it has no opener and never will — but its reads DO come back
   * readable, and a client reporting `canOpenSealed: false` makes `verifyGrantIri` tell a member
   * "this client holds no key to open them" while it is looking at the decrypted record.
   *
   * This is deliberately NOT `setGraphOpener(() => …)`: there is no key here, nothing to open with,
   * and pretending otherwise would put a stub on the one path that must stay honest.
   */
  private sealedUpstream = false;

  /** Declare that this client's transport returns sealed payloads already opened. */
  declareSealedReadsUpstream(): void { this.sealedUpstream = true; }

  /** Whether sealed content is readable through this client at all — what the UI may say "private" means here. */
  get canOpenSealed(): boolean { return this.opener !== null || this.sealedUpstream; }

  /**
   * `get_descriptor`, and — when this client holds a key — the sealed read behind it.
   *
   * ── ★★ WHY THE OPENING HAPPENS HERE AND NOT AT THE SEVEN CALL SITES ────────
   *
   * Every reader in this package (workspace record, canvas, seats, acceptances, presence, the
   * entry chain) turns a descriptor URL into bytes through this one method. Opening here means a
   * private workspace is READ everywhere it is read today, with no site aware of encryption.
   * Handling it per-site would have been six chances to miss one, and a missed site does not
   * error — it silently reports an empty or malformed record for content that is merely sealed.
   *
   * ── ★ IT DEGRADES RATHER THAN FAILS ────────────────────────────────────────
   *
   * `get_encrypted_graph` is deliberately NOT in `REQUIRED_TOOLS`: adding a twelfth tool would
   * invalidate every grant already issued against the eleven, and a connector that has not been
   * re-granted would stop connecting entirely rather than read a little less. So a relay or grant
   * without it leaves the record exactly as withheld as it is today.
   *
   * ★ AND IT NEVER TURNS A REFUSAL INTO PLAINTEXT. If the envelope does not name this key the
   * opener returns null and the content stays absent — which the readers already render as
   * "encrypted to its members, and you are not one of them".
   */
  override async descriptor(url: string): Promise<Record<string, unknown>> {
    return this.openSealedDescriptor(await super.descriptor(url), url);
  }

  /**
   * The opening step, on a `get_descriptor` response somebody else already fetched.
   *
   * ★★ SEPARATE FROM `descriptor()` BECAUSE THE DESKTOP'S READS DO NOT GO THROUGH IT. The renderer
   * is sandboxed and holds no key, so it builds its own client over an IPC bridge whose
   * `substrate:call` is a raw `client.tool(name, input)` passthrough — it never calls
   * `descriptor()`, so the main process's override, and the opener inside it, were dead code for
   * every read the app actually makes. The whole feature was unreachable from the UI while every
   * test and live driver passed, because they all drive `WorkspaceClient` directly.
   *
   * Exposing the step lets the bridge apply it to the raw response WITHOUT losing the caller's
   * other arguments — `bypass_cache` among them, which `descriptor(url)` cannot carry and which
   * the renderer needs after a write.
   */
  async openSealedDescriptor(d: Record<string, unknown>, url: string): Promise<Record<string, unknown>> {
    const graph = d['graph'] as { content?: string | null; encrypted?: boolean } | undefined;
    // Nothing to do when there is no key here, the payload is not sealed, or the relay already
    // answered in the clear (which it does for the caller's own pod).
    if (!this.opener || graph?.encrypted !== true || typeof graph?.content === 'string') return d;

    let sealed: unknown;
    try {
      sealed = await this.tool('get_encrypted_graph', { url });
    } catch (e) {
      // An ungranted or absent tool is not a fault in the record. Say which it was, rather than
      // leaving a private workspace looking broken for a reason nothing states.
      return { ...d, sealedReadFailed: (e as Error)?.message ?? String(e) };
    }
    const opened = this.opener(sealed);
    /**
     * ★★ A FAILED READ IS NOT A PERMISSION, AND IT IS RECORDED AS SUCH. `unreadable` means the
     * bytes could not be got or could not be opened — a CSS 502 during a redeploy, a damaged
     * envelope, an absent distribution. Reporting it as `not-for-you` is what let a transport
     * hiccup become "you are not a member of this workspace", said to somebody who is.
     */
    if (opened.kind === 'unreadable') return { ...d, sealedReadFailed: opened.why };
    if (opened.kind !== 'opened') return d;
    return {
      ...d,
      graph: { ...graph, content: opened.content },
      // ★ Evidence, not decoration: this content was decrypted HERE, with a key the relay does
      // not hold. A reader that could not tell this from ordinary plaintext could not honestly
      // tell anyone their workspace is end-to-end encrypted.
      openedWithOwnKey: true,
    };
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
    const graph = d['graph'] as { content?: string; encrypted?: boolean } | undefined;
    const region = graphRegion(graph?.content ?? '', workspaceIri);
    const convener = readIri(region, 'wsp:convener');
    return {
      kind: 'record',
      record: {
        head: h,
        // `null` and `''` are different answers and were being collapsed. Only `null` means
        // not found, so only `null` is tested for.
        regionFound: region !== null,
        /**
         * Withheld, not missing. See the field's own note.
         *
         * ★ ENCRYPTED IS NOT THE SAME AS UNREADABLE. When this client holds the key, `descriptor`
         * has already opened the payload and `content` is a string — the record is sealed on the
         * pod and perfectly readable here. Reporting it as withheld on the strength of the
         * `encrypted` flag alone would hide a workspace from the very member who can read it.
         */
        withheld: graph?.encrypted === true && typeof graph?.content !== 'string',
        sealedReadFailed: typeof d['sealedReadFailed'] === 'string' ? d['sealedReadFailed'] : null,
        /**
         * ★★ "I COULD NOT READ IT" IS NOT "IT IS PUBLIC", AND THEY WERE THE SAME VALUE.
         *
         * `region` is null in exactly the case `withheld` is true, and `readLiteral(null, …)`
         * answers null, which fell through to `'public'`. So a member who is seated but cannot
         * open the record — a client with no key, or one whose key was not in that envelope —
         * read a PRIVATE workspace as public, and every fail-closed guard downstream keys on
         * `=== 'private'`: they would post PLAINTEXT into the sealed channel, with `acl:Read` for
         * `foaf:Agent`, and other members' folds would show it. The one thing the guards exist to
         * prevent, reached by the reader that most needed them.
         *
         * Absent-but-readable still means public — that is the compatibility rule every workspace
         * written before `wsp:visibility` existed depends on, and it is decided by `regionFound`,
         * not by the literal.
         */
        visibility: region === null ? 'unknown'
          : readLiteral(region, 'wsp:visibility') === 'private' ? 'private' : 'public',
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
