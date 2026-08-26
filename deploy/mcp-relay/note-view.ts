/**
 * note-view — project a note/graph the caller already holds in the clear as a complete
 * HyperMarkdown document: the human-legible + agent-actionable view of that resource.
 *
 * Extracted from server.ts so it is unit-testable without booting the relay (server.ts is
 * self-starting). It renders the plaintext its CALLER hands it — the note's own text as rung-1
 * prose, the descriptor's affordances as target-free :::control blocks, describedby/alternate
 * links to the authority. It exposes nothing new because it reads nothing: every byte in the
 * output came in through the arguments.
 *
 * ★ IT IS NOT A POST-AUTHORIZATION FUNCTION, whatever an earlier version of this header said
 * ("called only AFTER /render's bearer + recipient-set + decrypt checks pass"). There are four
 * callers — publish_context's inline hand-back, `get_descriptor` via
 * {@link inlineRenderedForDescriptor}, and both branches of `/render` — and only the last two
 * sit behind that gate. THE AUTHORIZATION DECISION IS THE CALLER'S, at each of the four; a
 * change here that started fetching, or that assumed the reader is the pod owner, would be
 * wrong at three of them. `inlineRenderedForDescriptor` is fail-closed for exactly this reason:
 * a non-recipient's `plaintextTurtle` is null and it returns null rather than projecting.
 */
import {
  actionKey,
  controlsFromAffordances,
  extractAffordancesFromTurtle,
  renderHypermediaMarkdown,
  HYPERMEDIA_MARKDOWN_MEDIA_TYPE,
  type HypermediaControl,
} from '@interego/core';

const IEP_NS_VIEW = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
/** Descriptor-level TRANSPORT affordances — how the relay serves/decrypts the note,
 *  NOT actions a human takes on it. Filtered from the interactive viewer's control
 *  set (the raw HMD-source tab still shows them; the projection still carries them). */
const VIEWER_TRANSPORT_ACTIONS: ReadonlySet<string> = new Set([
  `${IEP_NS_VIEW}canDecrypt`,
  `${IEP_NS_VIEW}renderView`,
  // canFetchPayload is how the relay serves the graph bytes — descriptor
  // transport plumbing, not a human/learning action. Drop it from the viewer's
  // control set (still present in raw HMD/authority data). (georgio.)
  `${IEP_NS_VIEW}canFetchPayload`,
]);

/** The controls the interactive HMD viewer should OFFER: the note's payload/vertical
 *  actions, with descriptor transport affordances dropped. Each is marked `executable`
 *  iff its action is in `executableActions` — the set the CALLER built from actions with a
 *  REAL hydra:target in the signed descriptor or graph, so `invoke_affordance` can follow it.
 *  A control outside that set is DECLARATIVE (describes an interaction shape, no execution
 *  endpoint): the viewer shows it read-only instead of firing a doomed submit. Omit the set
 *  and NOTHING is executable — read-only is the fail-closed direction for a viewer that fires
 *  requests. */
export function viewerControls(
  controls: readonly HypermediaControl[],
  executableActions?: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  // Executability membership is scheme-independent: a control whose action is in URL
  // form must still match a urn-form entry in executableActions (and vice versa), so
  // key both the set entries and the lookup through actionKey. Behavior is identical
  // for single-scheme inputs (raw membership still matches; actionKey only adds the twin).
  const executableKeys = executableActions
    ? new Set([...executableActions].map((a) => actionKey(a)))
    : undefined;
  return controls
    .filter((c) => !VIEWER_TRANSPORT_ACTIONS.has(c.action))
    .map((c) => ({
      id: c.id,
      action: c.action,
      method: c.method,
      ...(c.expects ? { expects: c.expects } : {}),
      ...(c.source ? { source: c.source } : {}),
      ...(c.whenToUse ? { whenToUse: c.whenToUse } : {}),
      ...(c.fields && c.fields.length > 0 ? { fields: c.fields } : {}),
      executable: executableActions
        ? executableActions.has(c.action) || executableKeys!.has(actionKey(c.action))
        : false,
    }));
}

export interface NoteViewInput {
  /** The note's dereferenceable HTTPS identity (this render URL). Fragment-free. */
  readonly viewUrl: string;
  /** The signed descriptor (authority) — already resolved to a public https URL. */
  readonly authority: string;
  /** The descriptor Turtle, for affordance extraction. */
  readonly descriptorTurtle: string;
  /** The decrypted note graph (Turtle/TriG). */
  readonly plaintextTurtle: string;
  /** The CANONICAL graph IRI (descriptor's iep:describes) — the stable provenance
   *  base for payload controls + their relative shape refs. Supply it when the
   *  descriptor turtle doesn't carry iep:describes (publish_context's synthesized
   *  affordance turtle); otherwise it is derived from descriptorTurtle. */
  readonly graphIri?: string;
  /**
   * The note's audience class, when the CALLER already holds it as a value.
   *
   * ★ SUPPLIED BECAUSE A REGEX OVER A SERIALIZATION IS NOT A POLICY READ. Without it this
   * function infers public-vs-private by probing `descriptorTurtle` for `iep:visibility` /
   * `iep:encrypted` — correct against a PERSISTED descriptor, and silently wrong against a
   * synthesized one that omits them. Both probes then fail for reasons that have nothing to do
   * with the note, which is how every publish_context hand-back came to project `state:
   * "private"` and "the note stays private" whatever the caller's `visibility` said.
   * publish_context has the audience class in a variable; it passes it. `get_descriptor` does
   * not (it only has the persisted bytes), so the probe below remains its path.
   */
  readonly isPublic?: boolean;
  /**
   * Can `invoke_affordance` follow a control declaring this `hydra:target`?
   *
   * ★ INJECTED SO THE MARKING CANNOT PROMISE MORE THAN INVOKE WILL DO. The relay passes
   * `isFollowableTarget` — http(s) plus the identical SSRF/internal-host screen the invoke
   * fetch enforces — so a control this document leaves unmarked is one invoke would accept a
   * target for. Omitted (unit tests, any caller with no egress screen) it degrades to a bare
   * http(s) test, which is strictly MORE permissive: such a caller can over-mark, never
   * under-mark.
   *
   * ★ THE RELAY PASSES IT AT EVERY CALL SITE, AND FOR ONE ROUND IT DID NOT. An earlier draft
   * of this note asserted "the relay never omits it" while both `/render` branches
   * (server.ts's `app.get('/render/:descriptorIri')`) called `noteToHyperMarkdown` without a
   * screen — so the surface a raw HTTP reader gets marked with the permissive fallback and
   * could mark executable a target `guardedInvokeFetch` refuses, which is the divergence
   * `isFollowableTarget`'s own doc comment forbids. `tests/note-projection-honesty.test.ts` §7
   * now enumerates the call sites in server.ts rather than grepping for a spelling, because
   * the omission was invisible to a guard that pattern-matched the fixed sites.
   */
  readonly isFollowable?: (target: string) => boolean;
}

/** No execution endpoint exists for this action, so `invoke_affordance` cannot follow it.
 *  Carried as `skos:scopeNote` on the control — see `noteToHyperMarkdown`. */
const DECLARATIVE_SCOPE_NOTE =
  'DECLARATIVE — no execution endpoint is declared for this action, in either the signed '
  + 'descriptor or the signed graph, so `invoke_affordance` cannot follow it. It states the '
  + 'interaction SHAPE (method, and any input fields); acting on it needs a target the '
  + 'publisher has not declared.';

/**
 * The prose qualifier that makes the standing execution footer honest — emitted only when
 * at least one control is declarative, i.e. only when the footer would otherwise over-promise.
 *
 * ★ WHAT IT SAYS ABOUT THE *UNMARKED* ONES IS THE HALF THAT CAN GO FALSE, and it did: an
 * earlier draft claimed they "re-resolve a live target from the signed descriptor". Two things
 * were wrong with that. A payload control's target comes from the signed GRAPH, not the
 * descriptor; and "live target" reads as "this call will work", which unmarked does not mean —
 * `isFollowable` asks whether the egress screen would let the fetch out, so a bearer-gated
 * endpoint (`/render`) is unmarked and still answers 401 to a caller invoke does not
 * authenticate. The claim is now exactly the predicate that produced the marking.
 */
const DECLARATIVE_BODY_NOTE =
  '_Controls marked DECLARATIVE below have no execution endpoint: `invoke_affordance` cannot '
  + 'follow them, whatever the standing note under the controls says. An unmarked control '
  + 'declares a target — in the signed descriptor or in the signed graph — that '
  + '`invoke_affordance` re-resolves and is allowed to fetch; that is a reachable endpoint, '
  + 'not a promise the call is authorized._';

/** A bare http(s) test — the fallback when no caller screen is supplied. See
 *  {@link NoteViewInput.isFollowable} for why the fallback is the permissive direction. */
function httpTarget(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** First literal value of any of the given predicates (triple- or single-quoted). */
function pickLiteral(turtle: string, preds: string): string {
  const p = `(?:${preds})`;
  const triple = new RegExp(`${p}\\s+"""([\\s\\S]*?)"""`).exec(turtle);
  if (triple) return triple[1]!.trim();
  const single = new RegExp(`${p}\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(turtle);
  return single ? single[1]!.replace(/\\"/g, '"').replace(/\\n/g, '\n').trim() : '';
}

/** The subject IRI of the first typed statement (`<iri> a …` / `urn:… a …`) —
 *  the payload graph's own identity, used to source-tag its controls. */
function primarySubject(turtle: string): string | undefined {
  const m = /(?:^|\n)\s*<([^>]+)>\s+a\s+/.exec(turtle) ?? /(?:^|\n)\s*((?:urn|did|https?):[^\s;]+)\s+a\s+/.exec(turtle);
  return m ? m[1] : undefined;
}

/** The CANONICAL graph IRI the descriptor names via `iep:describes` — the stable
 *  provenance identity, the SAME in the publish hand-back and a later re-fetch.
 *  Prefer this over primarySubject: the relay re-mints the stored graph's own
 *  subject on persist, so primarySubject differs between the authored payload and
 *  the re-serialized stored copy (georgio saw the two projections disagree). */
function describesFromTurtle(turtle: string): string | undefined {
  const m = /iep:describes\s+<([^>]+)>/.exec(turtle);
  return m ? m[1] : undefined;
}

/** Normalize note-body indentation introduced by a Turtle serializer re-writing a
 *  multi-line literal on persist — ≥4 leading spaces make CommonMark render prose
 *  as a code block, which happened on re-fetch but not on the publish hand-back.
 *  First remove the common minimum indent (non-lossy for a uniform block indent),
 *  then cap any residual leading run below the 4-space code-block threshold, so no
 *  serializer style yields a spurious code block and both projections render the
 *  same. Notes carry code as fenced ``` blocks (col 0), unaffected. */
function dedent(s: string): string {
  const lines = s.split('\n');
  const nonBlank = lines.filter((l) => l.trim());
  const min = nonBlank.length ? Math.min(...nonBlank.map((l) => /^[ \t]*/.exec(l)![0].length)) : 0;
  const deMin = min ? lines.map((l) => l.slice(min)) : lines;
  return deMin.map((l) => l.replace(/^[ \t]{4,}/, '   ')).join('\n');
}

export function noteToHyperMarkdown(input: NoteViewInput): string {
  // DESCRIPTOR-level controls (canDecrypt / renderView) — source = the signed
  // descriptor (the transport authority).
  const descriptorAffordances = extractAffordancesFromTurtle(input.descriptorTurtle, input.authority);
  const descriptorControls = controlsFromAffordances(
    descriptorAffordances,
    undefined,
    input.authority,
  );
  // PAYLOAD-level controls declared IN the signed graph (e.g. ask / acknowledge /
  // propose-correction, with their SHACL input shapes) — source = the payload
  // graph itself. Previously dropped: the projection only read the descriptor,
  // so a client had to reconstruct these after verifying the signed graph.
  // CANONICAL, stable provenance base: the graph IRI the descriptor names
  // (iep:describes), explicit graphIri override for callers whose descriptor
  // turtle doesn't carry it (publish_context's synthesized affordance turtle),
  // then the payload's own subject as a last resort. This makes the publish
  // hand-back and a get_descriptor re-fetch tag identical source/expects bases.
  const payloadSource = input.graphIri
    ?? describesFromTurtle(input.descriptorTurtle)
    ?? primarySubject(input.plaintextTurtle)
    ?? 'urn:interego:signed-payload';
  const payloadControls = controlsFromAffordances(
    // requireTarget:false — payload-declared HMD controls are authority-closed and
    // carry NO hydra:target (the target is re-computed as <@id>#control-*). Without
    // this they extract as zero and only the 2 descriptor controls project.
    extractAffordancesFromTurtle(input.plaintextTurtle, payloadSource, { requireTarget: false }),
    undefined,
    payloadSource,
  );
  /**
   * ── ★★ WHICH OF THESE CONTROLS CAN ANYTHING ACTUALLY FOLLOW ─────────────────────────────
   *
   * The renderer emits ONE standing footer for the whole document — "To act: call
   * `invoke_affordance(descriptorUrl, rel)`" — unconditionally, for every control. But a
   * target-less authority-closed control (the shape `requireTarget:false` above exists to
   * surface) has no endpoint to re-resolve, so that instruction is guaranteed to fail for it,
   * and nothing in the emitted bytes said which was which. `render_hmd`'s STRUCTURED output has
   * carried the distinction since e73b52fe; the markdown never did, so an agent reading the
   * document TEXT had no way to tell a control that will run from one that cannot. That is what
   * is fixed here: the ones that cannot are named as such.
   *
   * ★ THE SECOND EXTRACTION IS NOT REDUNDANT, AND REUSING `payloadAffordances` WOULD BE A BUG.
   * Under `requireTarget:false` the extractor SYNTHESIZES a target for a target-less control —
   * the control's own subject IRI (affordance-extraction.ts: `target = key.startsWith('_:') ?
   * action : key`). For a payload whose subject IRIs are `urn:`/fragment that reads as
   * unfollowable and the answer happens to come out right; for one published under https
   * subject IRIs the synthesized target IS an https URL, and every declarative control would
   * mark itself executable. Asking again with the DEFAULT `requireTarget` is asking about a
   * REAL `hydra:target`, which is the actual question — and it is the same extraction
   * `render_hmd` runs to build its executable set, so the two never disagree.
   */
  const followable = input.isFollowable ?? httpTarget;
  const executableKeys = new Set<string>();
  for (const a of [
    ...descriptorAffordances,
    ...extractAffordancesFromTurtle(input.plaintextTurtle, payloadSource),
  ]) {
    if (a.target && followable(a.target)) executableKeys.add(actionKey(a.action));
  }
  // Merge; on an action collision the signed PAYLOAD control wins (authored,
  // verified content outranks a transport-descriptor affordance).
  const byAction = new Map<string, (typeof descriptorControls)[number]>();
  for (const c of [...descriptorControls, ...payloadControls]) byAction.set(actionKey(c.action), c);
  // Stamp the declarative ones. `whenToUse` (skos:scopeNote) is free to carry it: nothing
  // authored reaches it — `controlsFromAffordances` sets it only from a `guidance` map, and
  // both calls above pass `undefined` — so this clobbers no publisher content.
  const controls = [...byAction.values()].map((c) => (
    executableKeys.has(actionKey(c.action)) ? c : { ...c, whenToUse: DECLARATIVE_SCOPE_NOTE }
  ));
  const anyDeclarative = controls.length > 0 && controls.some((c) => c.whenToUse === DECLARATIVE_SCOPE_NOTE);
  // Reflect the note's ACTUAL visibility in the projection. A PUBLIC note must NOT be labelled
  // or stated as private/encrypted (georgio: public note mislabeled private). The caller's own
  // `isPublic` wins when supplied; otherwise read the descriptor's `iep:visibility` /
  // `iep:encrypted`. See NoteViewInput.isPublic for why the probe alone was not enough.
  const isPublic = input.isPublic ?? (
    /iep:visibility\s+"public"/.test(input.descriptorTurtle) || /iep:encrypted\s+false\b/.test(input.descriptorTurtle)
  );
  const title = pickLiteral(input.plaintextTurtle, 'dct:title|schema:name|rdfs:label|schema:headline') || (isPublic ? 'Note' : 'Private note');
  // Dedent: the stored graph is re-serialized on persist and its multi-line text
  // literal comes back uniformly indented, which CommonMark renders as a code
  // block on re-fetch (but not on the publish hand-back). Normalize both.
  const text = dedent(pickLiteral(input.plaintextTurtle, 'schema:text|schema:articleBody|dct:description|rdfs:comment'));
  // Neutralize any leading ::: in the note text so it can't collide with the
  // renderer's reserved control-fence (owner content is trusted, but the fence
  // guard is strict; a leading space keeps it valid CommonMark and inert).
  const safeText = text.split('\n').map((l) => (/^:::/.test(l) ? ` ${l}` : l)).join('\n');
  // If the note's own text already opens with an ATX H1, use it as THE title —
  // prepending `# ${title}` on top of it produced a duplicate H1 (georgio's
  // progressive-enhancement demo, whose body is Markdown that starts with a heading).
  const textOpensWithH1 = /^\s*#\s+\S/.test(safeText);
  const body = [
    ...(textOpensWithH1 ? [] : [`# ${title.replace(/\s+/g, ' ')}`, ``]),
    ...(safeText ? [safeText, ``] : []),
    isPublic
      ? `_Public note — plaintext, readable by anyone. Its controls and links are below._`
      : `_Private note — encrypted at rest; decrypted here for you, the authorized agent. Its controls and links are below; the note stays private._`,
    // Only when at least one control is declarative — i.e. only when the standing footer would
    // otherwise over-promise. A document whose controls are all followable needs no qualifier.
    ...(anyDeclarative ? [``, DECLARATIVE_BODY_NOTE] : []),
  ].join('\n');
  return renderHypermediaMarkdown({
    id: input.viewUrl,
    type: ['ieh:AgentMemory', 'hmd:Document'],
    descriptorUrl: input.authority,
    state: isPublic ? 'public' : 'private',
    links: [
      { label: 'Signed descriptor (authority)', href: input.authority, rel: 'describedby', type: 'text/turtle' },
      { label: isPublic ? 'Turtle' : 'Turtle (decrypted)', href: `${input.viewUrl}?format=turtle`, rel: 'alternate', type: 'text/turtle' },
    ],
    controls,
    body,
  });
}

/**
 * True when a URL carries an `internal` DNS label — terminal `.internal` OR mid-label
 * `.internal.` (as Azure ACA synthesizes). Such a host must never enter a store-and-forward
 * projection's bytes. Unparseable → treated as unsafe.
 *
 * ★★ THIS PROBE, NOT THE INJECTED SCREEN, IS WHAT KEEPS THE STORE HOST OUT — measured, and the
 * opposite of what an earlier note here and at the publish hand-back claimed. The relay's
 * `isFollowableTarget` runs `assertInvokeTargetAllowed` (egress.ts), which returns `'pinned'`
 * for the relay's OWN CSS origin BEFORE it reaches its internal-label check — and on this fleet
 * that origin IS `css.railway.internal`. So `isFollowableTarget('http://css.railway.internal:3456/…')`
 * is TRUE, deliberately: the relay must be able to fetch its own store. Delete the line below and
 * `publishableAuthority` starts publishing the internal host on any deployment with no
 * CSS_PUBLIC_URL configured. Pinned by the `internal despite an accepting screen` case in
 * tests/note-projection-honesty.test.ts §3.
 */
function hasInternalHostLabel(u: string): boolean {
  try { return new URL(u).hostname.toLowerCase().split('.').includes('internal'); }
  catch { return true; }
}

/**
 * The value a projection may put in its `descriptorUrl` frontmatter — THE AUTHORITY, the URL a
 * reader is told to hand to `invoke_affordance`.
 *
 * ── ★★ THE AUTHORITY WAS A PROJECTION URL, AND NOTHING COULD FOLLOW IT ──────────────────────
 *
 * Every projection used to put the bearer-gated `/render/<id>` URL here (and, on an internal-host
 * pod, a bare `urn:iep:…`). `/render` is a PROJECTION, not a descriptor: it carries no
 * `iep:Affordance` blocks to re-resolve and it answers 401 without a bearer, which
 * `invoke_affordance` forwards only to same-origin `/amep` targets. `invoke_affordance` resolves
 * every control THROUGH this field, so with a projection URL in it not one control in the
 * document was invocable — and the 401 surfaces as a bare fetch error that names none of this.
 *
 * ★★ ONE RULE, FOUR CALL SITES — AND THE FIRST ROUND OF THIS FIX REACHED TWO OF THEM. Every
 * `noteToHyperMarkdown` caller in the relay decides an authority, and there are four:
 * `publish_context`'s inline hand-back, `inlineRenderedForDescriptor` (below, for
 * `get_descriptor`), and BOTH branches of `GET /render/:descriptorIri` — the public-note branch
 * and the decrypted branch. The round that introduced this function fixed the two the report
 * named and left the two it did not, which kept the original defect standing on the surface a
 * raw HTTP reader actually gets: via the older `publishableDescriptorUrl(descriptorUrl, viewUrl)`
 * rule, whose fallback is its second argument, `/render`'s own document went on naming `/render`
 * as its authority wherever the store is on an internal host — i.e. on this fleet. A guard that
 * greps for the fixed spelling cannot see that, because the same mistake is spelled through a
 * helper there, so §7 of tests/note-projection-honesty.test.ts enumerates the call sites instead.
 *
 * `candidate` is the descriptor in its OUTWARD spelling (identity out, routing in — the relay
 * still fetches on the internal origin); it is accepted only when it carries no `internal` DNS
 * label AND passes the caller's invoke screen. The two conditions are not redundant and neither
 * subsumes the other: see `hasInternalHostLabel` for why the screen alone says yes to the store
 * host. Anything else keeps `fallback`, which is the previous behaviour rather than a new
 * failure.
 */
export function publishableAuthority(
  candidate: string | undefined,
  fallback: string,
  isFollowable?: (target: string) => boolean,
): string {
  if (!candidate) return fallback;
  if (hasInternalHostLabel(candidate)) return fallback;
  return (isFollowable ?? httpTarget)(candidate) ? candidate : fallback;
}

/** Parse the publisher-advertised HOST-FREE render identity out of a persisted
 *  descriptor: `... iep:action iep:renderView ; ... hydra:target <BASE/render/<id>>`
 *  (emitted for every encrypted note; solid/client.ts). Only matches a target
 *  under the relay's own /render/ base, so the internal envelope/canDecrypt
 *  accessURL is structurally never selected as the view identity. */
function renderTargetFromTurtle(turtle: string, base: string): string | undefined {
  if (!base) return undefined;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`hydra:target\\s+<(${esc}/render/[^>\\s]+)>`).exec(turtle);
  return m ? m[1] : undefined;
}

/** The descriptor's own HOST-FREE @id — a `urn:iep:<pod>:<ts>` minted at publish
 *  time. Carries the pod SLUG (already public in the external gate URL) but NEVER
 *  the internal pod HOST, so it is a leak-safe render identity for a PUBLIC note
 *  whose only fetch URL is the internal host. Same shape /render/<id> already
 *  resolves for encrypted notes (server.ts:2878 uses descriptor.id verbatim). */
function descriptorUrnFromTurtle(turtle: string): string | undefined {
  const m = /<(urn:[^>\s]+)>\s+a\s+iep:ContextDescriptor/.exec(turtle);
  return m ? m[1] : undefined;
}

/**
 * Leak-safe inline HyperMarkdown projection for a resolved descriptor — the
 * verifiable, no-bearer re-fetch surface `get_descriptor` returns so a client
 * never needs the bearer-gated `/render` round-trip (georgio: "returning the
 * rendered projection from get_descriptor would make the fix independently
 * verifiable").
 *
 * ★ REQUIRED TO BE BYTE-SHAPE-IDENTICAL TO publish_context's inline `rendered` — AND IT WAS NOT.
 * For the same public note the hand-back listed `control-renderview` (which the persisted
 * descriptor does not advertise, so invoking it answers `AffordanceNotFoundError`) while this
 * projection listed `control-canfetchpayload` (which works): the hand-back offered the broken
 * control and hid the working one, because it synthesized its own descriptor and did not mirror
 * what `packages/solid/src/client.ts` actually writes. Fixed at the synthesis site; the
 * agreement is now measured, with a non-vacuity pair, in tests/note-projection-honesty.test.ts §5.
 *
 * Returns null (→ caller omits the field) when the payload is NOT materialized
 * (`plaintextTurtle` null — a non-recipient's `graph.content` is null, so E2EE
 * is fail-closed here for free), is not note-like, or no HOST-FREE identity is
 * available. NEVER embeds an internal pod host: it prefers the descriptor's own
 * advertised host-free render target, and only falls back to the descriptor URL
 * when that URL carries no `internal` DNS label.
 */
export function inlineRenderedForDescriptor(input: {
  /** The (possibly internal-host) descriptor fetch URL. */
  readonly descriptorUrl: string;
  /** `descriptorUrl` in its OUTWARD spelling, when the deployment has one (the relay passes
   *  `asPublicPodUrl(url)`). Becomes the document's authority when {@link publishableAuthority}
   *  accepts it — see there for why the identity URL was never a usable authority. */
  readonly authorityUrl?: string;
  /** The persisted descriptor Turtle. */
  readonly descriptorTurtle: string;
  /** Decrypted (private) or plaintext (public) payload — null when unavailable. */
  readonly plaintextTurtle: string | null;
  /** PUBLIC_BASE_URL ('' in dev → localhost fallback). */
  readonly publicBase: string;
  /** PORT, for the dev localhost fallback. */
  readonly port: number;
  /** The invoke screen — see {@link NoteViewInput.isFollowable}. */
  readonly isFollowable?: (target: string) => boolean;
}): { rendered: string; mediaType: string } | null {
  const { descriptorUrl, descriptorTurtle, plaintextTurtle, publicBase, port } = input;
  if (!plaintextTurtle) return null; // fail-closed: non-recipient / no key → no projection
  // The same note-like gate publish_context uses — arbitrary ontologies are not notes.
  if (!/\b(schema:text|schema:articleBody|dct:description|rdfs:comment|schema:name|dct:title|AgentMemory|NoteDigitalDocument)\b/.test(plaintextTurtle)) return null;
  const base = (publicBase || `http://localhost:${port}`).replace(/\/+$/, '');
  let viewUrl = renderTargetFromTurtle(descriptorTurtle, base);
  let authority: string;
  if (viewUrl) {
    // Host-free render identity recovered (every encrypted note has one). It is the @id.
    // It is NOT the authority any more: `publishableAuthority` below prefers the descriptor's
    // outward spelling, because /render carries no affordances and is bearer-gated. This
    // branch's own fallback stays what it was — an internal descriptor URL can never enter
    // the projection.
    authority = viewUrl;
  } else if (hasInternalHostLabel(descriptorUrl)) {
    // No advertised render target AND the only fetch URL carries an `internal` DNS
    // label (a PUBLIC note persisted to an internal-host pod — encrypted notes get
    // a host-free /render target, public ones did not). Rather than skip and hand
    // back an empty projection (georgio's render_hmd-returns-empty defect),
    // synthesize a HOST-FREE identity from the descriptor's own urn:iep: @id (pod
    // slug only, never the internal host). This is the same host-free /render/<urn>
    // shape encrypted notes advertise, and /render resolves the urn — so the public
    // note projects while the internal host never enters the output. Skip only if
    // no urn identity is derivable.
    const urn = descriptorUrnFromTurtle(descriptorTurtle);
    if (!urn) return null;
    viewUrl = `${base}/render/${encodeURIComponent(urn)}`;
    authority = urn;
  } else {
    // No advertised render target, but the descriptor URL is host-free: synthesize
    // directly from it (the pre-existing public-note fallback).
    viewUrl = `${base}/render/${encodeURIComponent(descriptorUrl)}`;
    authority = descriptorUrl;
  }
  try {
    const rendered = noteToHyperMarkdown({
      viewUrl,
      // The descriptor when it is reachable and leak-safe; otherwise the identity, as before.
      authority: publishableAuthority(input.authorityUrl, authority, input.isFollowable),
      descriptorTurtle,
      plaintextTurtle,
      // No `isPublic`: this caller has only the PERSISTED descriptor, which carries
      // `iep:visibility` / `iep:encrypted` itself (packages/solid/src/client.ts writes both),
      // so the probe inside noteToHyperMarkdown is the right — and only — read here.
      ...(input.isFollowable ? { isFollowable: input.isFollowable } : {}),
    });
    return { rendered, mediaType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE };
  } catch { return null; }
}
