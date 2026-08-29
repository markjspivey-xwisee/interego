/**
 * Which pod a call is ABOUT — resolved once, in one place, from the two spellings a
 * caller may use, with the relay's own auto-fill told apart from what the caller asked.
 *
 * ── THE DEFECT THIS MODULE EXISTS TO CLOSE ───────────────────────────────────
 *
 * `verify_agent` read `args.pod_url` and never looked at `args.pod_name`. The `/mcp`
 * dispatcher auto-fills `args.pod_url` with the CALLER'S OWN pod whenever it is absent.
 * So `verify_agent { agent_id, pod_name: "<someone else's pod>" }` answered about the
 * caller's own pod — and `verify_agent` is an AUTHORITY question, so the wrong answer is
 * shaped exactly like the right one.
 *
 * Measured live against relay.interego.xwisee.com at f1ea9c2, one disposable identity
 * (`u-eth-9bf50894ff23`) with one ReadOnly agent registered on its OWN pod, asking about
 * the maintainer's pod `u-eth-8f3b8e939600`:
 *
 *   verify_agent { agent_id, pod_name: "u-eth-8f3b8e939600" }
 *     → verified: true, trustLevel: "CryptographicallyVerified",
 *       enforcement: { enforced: true, scope: "ReadOnly", basis: "signed-chain" }
 *
 *   verify_agent { agent_id, pod_url:  ".../u-eth-8f3b8e939600/" }   ← the same question
 *     → verified: false, enforcement: { enforced: false, basis: "none",
 *       note: "The relay grants this agent nothing on this pod." }
 *
 *   verify_agent { agent_id, pod_name: "totally-nonexistent-pod-zzz" }
 *     → verified: true, "CryptographicallyVerified"   ← for a pod that does not exist
 *
 * A caller checking whether an agent is authorised somewhere it does not own got back a
 * cryptographically-confident YES about a completely different pod, and nothing in the
 * response named which pod had been examined, so there was nothing to notice.
 *
 * ── WHY A SHARED MODULE AND NOT AN `if` IN THE HANDLER ───────────────────────
 *
 * `verify_agent` was not alone, and could not have been: the auto-fill sits under every
 * tool. Also measured live at f1ea9c2, same session:
 *
 *   get_current_head { urn, pod_name: "u-eth-8f3b8e939600" }
 *     → podUrl: ".../u-eth-9bf50894ff23/"   ← the caller's own pod, and this tool's
 *       own schema says "Provide either pod_url or pod_name". On `/mcp` that promise
 *       could never be kept, because the dispatcher always supplied `pod_url` first.
 *   get_current_head { urn }  on /messages
 *     → podUrl: ".../default/"              ← nobody's pod, from a `?? 'default'` fallback
 *   get_pod_status {}         on /messages
 *     → { agentsSource: "none", registry: null, descriptors: 0, entries: [] } and NO
 *       field naming a pod — a successful-looking status for a subject that was never
 *       resolved, because only `/mcp` fills `pod_url` and nothing refused its absence.
 *   remove_pod {}             on /mcp
 *     → { removed: true, url: "<the caller's own pod>", total: 101 → 100 } — the
 *       dispatcher filled a TARGET parameter with the caller's own pod and the caller's
 *       own federation record was deleted. `required-args.ts` requires `pod_url` here;
 *       the gate wraps the handler and therefore runs AFTER the injection, so it saw a
 *       present argument and could not fire.
 *
 * Same root every time: the handler cannot tell a value the CALLER SENT from a value the
 * RELAY SUPPLIED, so "the caller named no pod" and "the caller named this pod" are the
 * same input. Fixing that per handler is five chances to fix it four times, which is the
 * shape this file's siblings (`required-args.ts`, `supersession-frontier.ts`) exist to
 * stop repeating. And `server.ts` opens a listener on import, so a rule written inline
 * there is a branch no unit test can reach; the rule lives here so the test can call it.
 *
 * ── THE THREE ANSWERS, AND WHY EACH IS THE ONE IT IS ─────────────────────────
 *
 * 1. `pod_name` is HONOURED, not refused. Refusing it was the safer-sounding option and
 *    it is the wrong one, because it buys nothing: the same caller can already ask the
 *    same question by spelling the pod as a URL. Measured — a brand-new disposable wallet
 *    with no relationship to the maintainer already got the maintainer pod's full
 *    delegation verdict, descriptor list and pod status by passing `pod_url` (case B
 *    above). `pod_name` resolves to `CSS_URL + name + '/'`, a pure string concat of a
 *    value the caller supplies, read with the same credential, returning the same bytes.
 *    Honouring it discloses NOTHING that `pod_url` did not already disclose; refusing it
 *    would remove a capability that demonstrably already exists, which is cost with no
 *    security gain. This applies to the READ tools that answer a question about a pod.
 *    It is deliberately NOT extended to the write tools (`register_agent`,
 *    `revoke_agent`, `publish_directory`, `pgsl_ingest`, `publish_context`), which key on
 *    `pod_name` already and are gated by `requireOwnPod` — that gate is untouched.
 *
 * 2. DISAGREEMENT REFUSES; there is no winner to pick. Today `pod_url` silently wins, so
 *    `{ pod_name: A, pod_url: B }` answers about B while reading as a question about A.
 *    Picking the other one would be the same defect facing the other way. The caller
 *    named two pods and only one answer exists, so the honest reply is that the request
 *    is unanswerable as written.
 *
 * 3. THE ANSWER NAMES ITS SUBJECT. An authority verdict a caller cannot attribute to a
 *    pod is not checkable, and unattributability is the whole reason the original defect
 *    was invisible rather than merely wrong. `get_current_head` already named its subject
 *    (`podUrl`), which is precisely why its instance of this bug could be SEEN in one
 *    call while `verify_agent`'s could not.
 *
 * ── WHY THE MARKERS ARE RESERVED WIRE FIELDS ─────────────────────────────────
 *
 * Rule 2 is unshippable without rule 0. On `/mcp` the dispatcher fills `pod_url` on EVERY
 * call, so without a way to tell injected from asked-for, every `pod_name` call would look
 * like a disagreement and refuse — a refusal that would break every honest caller.
 * `POD_URL_INJECTED` / `POD_NAME_INJECTED` are therefore set by the dispatcher at the
 * moment it fills the value, and are members of `RESERVED_WIRE_FIELDS` so they are
 * stripped from the wire before any auth branch on all four transports. A caller who could
 * forge `_pod_url_injected` could not escalate with it, but it could defeat the
 * disagreement refusal, so it is stripped for the same reason `_session_user_id` is.
 */

/** Set by a dispatcher when IT supplied `pod_url`. Reserved + wire-stripped. */
export const POD_URL_INJECTED = '_pod_url_injected';
/** Set by a dispatcher when IT supplied `pod_name`. Reserved + wire-stripped. */
export const POD_NAME_INJECTED = '_pod_name_injected';

/** How the subject pod was arrived at — reported so a caller can tell. */
export type PodSelectorSource =
  /** The caller sent `pod_url`. */
  | 'pod_url'
  /** The caller sent `pod_name`. */
  | 'pod_name'
  /** The caller named no pod; this is the authenticated session's own pod. */
  | 'session';

export interface PodSubject {
  /** The pod this call is about. Always ends in `/`. */
  readonly podUrl: string;
  /** Its last path segment, when there is one — the `pod_name` spelling of `podUrl`. */
  readonly podName: string | null;
  readonly source: PodSelectorSource;
}

export interface PodSelectorRefusal {
  readonly error: string;
  readonly code: 400;
  /**
   * False for the same reason `required-args.ts` says so: no number of retries turns two
   * pods into one, and a client that believes `retryable` loops until it gives up.
   */
  readonly retryable: false;
  readonly tool: string;
  readonly pod_name?: string;
  readonly pod_url?: string;
  readonly message: string;
}

export type PodSelectorResult =
  | { readonly subject: PodSubject; readonly refusal?: undefined }
  | { readonly refusal: PodSelectorRefusal; readonly subject?: undefined };

export interface PodSelectorOptions {
  /** The relay's CSS base, e.g. `http://css.railway.internal:3456/`. Must end in `/`. */
  readonly cssUrl: string;
  /** Tool name, for the refusal text. */
  readonly tool: string;
  /**
   * When true, a relay-injected `pod_url` / `pod_name` does NOT resolve a subject — the
   * call is refused as naming no pod.
   *
   * For `add_pod` / `remove_pod` / `subscribe_to_pod` / `unsubscribe_from_pod` the
   * parameter is a PEER being acted on, not "my pod", and defaulting it to the caller's
   * own pod is never what the caller meant: measured, `remove_pod {}` on `/mcp` deleted
   * the caller's own federation record and reported `removed: true`. Those tools already
   * declare `pod_url` required in `required-args.ts`; that gate wraps the handler and so
   * runs after the dispatcher's injection, which is why it never fired. This flag is what
   * lets it mean what it says.
   */
  readonly targetOnly?: boolean;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function withTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * Origin + path, lowercased, trailing slash normalised — the identity used to decide
 * whether two spellings name the SAME pod.
 *
 * ★ THE FULL ORIGIN IS PART OF IT, which is STRICTER than `canonicalPodKey` in `server.ts`.
 * That key collapses the css-gate public host and the css internal host to one bucket — they
 * are two spellings of one store, and de-duping the federation directory requires it — while
 * keying every OTHER origin separately. (It used to compare the path alone, which called
 * `pod_name: "u-eth-alice"` and `pod_url: "https://elsewhere.example/u-eth-alice/"` an
 * AGREEMENT and would then have answered about elsewhere.example while the caller read the
 * request as being about their own relay's pod; that is closed there too now.) This one keeps
 * even the two store spellings apart, because a caller who names a pod twice in one call
 * should be answered about the thing they actually typed rather than about a host-variant of
 * it. The cost of the stricter comparison is a false refusal when a caller
 * passes a host-variant URL together with a matching `pod_name`; no caller in this repo
 * passes both to any of these tools (grepped: the only `pod_name` consumers of a read tool
 * are `applications/shared-workspace/src/membership.ts:1208,1449`, which pass `pod_name`
 * alone), so that costs nothing measurable and fails in the safe direction.
 */
function podIdentity(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${withTrailingSlash(u.pathname)}`.toLowerCase();
  } catch {
    return withTrailingSlash(url).toLowerCase();
  }
}

/** The `pod_name` spelling of a pod URL: its last non-empty path segment. */
export function podNameOf(podUrl: string): string | null {
  try {
    const segs = new URL(podUrl).pathname.split('/').filter(s => s.length > 0);
    return segs.length > 0 ? segs[segs.length - 1]! : null;
  } catch {
    const segs = podUrl.split('/').filter(s => s.length > 0);
    return segs.length > 0 ? segs[segs.length - 1]! : null;
  }
}

/**
 * Resolve the pod a call is about, or refuse.
 *
 * `args` is the handler's own argument object — post-injection, exactly what the handler
 * sees — so this reads the same values the handler would have read.
 */
export function resolvePodSubject(
  args: Record<string, unknown>,
  opts: PodSelectorOptions,
): PodSelectorResult {
  const cssUrl = withTrailingSlash(opts.cssUrl);

  // `podUrl` (camelCase) is an undeclared alias two handlers accepted before this module
  // existed (`verify_agent`, `read_inbox`). Kept so those calls keep working, and treated
  // as caller-supplied because no dispatcher ever writes it.
  const rawUrl = asNonEmptyString(args.pod_url) ?? asNonEmptyString(args.podUrl);
  const rawName = asNonEmptyString(args.pod_name);

  // Only `pod_url` and `pod_name` are ever written by a dispatcher. The camelCase alias
  // is not, so a caller who sends `podUrl` has asked for it even on a call where the
  // dispatcher also filled `pod_url` — resolve each spelling against its own marker
  // rather than against whichever one `rawUrl` happened to prefer.
  const askedUrl = (args[POD_URL_INJECTED] === true ? undefined : asNonEmptyString(args.pod_url))
    ?? asNonEmptyString(args.podUrl);
  const askedName = args[POD_NAME_INJECTED] === true ? undefined : rawName;

  // ── the caller named two pods ──
  if (askedUrl !== undefined && askedName !== undefined) {
    const fromName = `${cssUrl}${askedName}/`;
    if (podIdentity(fromName) !== podIdentity(askedUrl)) {
      return {
        refusal: {
          error: 'pod_selector_conflict',
          code: 400,
          retryable: false,
          tool: opts.tool,
          pod_name: askedName,
          pod_url: askedUrl,
          message:
            `${opts.tool} was called with pod_name "${askedName}" (which is <${fromName}>) `
            + `and pod_url <${askedUrl}>. Those are different pods and this call can only be `
            + 'about one of them, so it is refused rather than answered about whichever the '
            + 'implementation happens to read first. Send exactly one of the two.',
        },
      };
    }
    // They agree. Prefer the URL: it is the more specific of two equal spellings.
    return { subject: { podUrl: withTrailingSlash(askedUrl), podName: podNameOf(askedUrl), source: 'pod_url' } };
  }

  if (askedUrl !== undefined) {
    return { subject: { podUrl: withTrailingSlash(askedUrl), podName: podNameOf(askedUrl), source: 'pod_url' } };
  }
  if (askedName !== undefined) {
    const podUrl = `${cssUrl}${askedName}/`;
    return { subject: { podUrl, podName: askedName, source: 'pod_name' } };
  }

  // ── the caller named no pod ──
  if (opts.targetOnly === true) {
    return {
      refusal: {
        error: 'pod_target_not_named',
        code: 400,
        retryable: false,
        tool: opts.tool,
        message:
          `${opts.tool} acts on a specific pod and this call named none. It is refused rather `
          + 'than defaulted to your own pod: this parameter is the pod being acted on, not '
          + '"my pod", and defaulting it made `remove_pod {}` delete the caller\'s own '
          + 'federation record while reporting success. Pass pod_url (or pod_name).',
      },
    };
  }

  const sessionUrl = rawUrl ?? (rawName !== undefined ? `${cssUrl}${rawName}/` : undefined);
  if (sessionUrl === undefined) {
    return {
      refusal: {
        error: 'pod_subject_unresolved',
        code: 400,
        retryable: false,
        tool: opts.tool,
        message:
          `${opts.tool} answers a question about a pod, and neither this call nor the `
          + 'authenticated session resolved one. It is refused rather than answered about a '
          + 'placeholder: the previous behaviour read <'
          + `${cssUrl}default/> — a pod belonging to nobody — and reported the resulting empty `
          + 'result as a finding. Authenticate, or pass pod_url / pod_name.',
      },
    };
  }
  return { subject: { podUrl: withTrailingSlash(sessionUrl), podName: podNameOf(sessionUrl), source: 'session' } };
}
