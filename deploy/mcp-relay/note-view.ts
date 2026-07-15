/**
 * note-view — project a decrypted note/graph as a complete HyperMarkdown
 * document: the human-legible + agent-actionable view of a PRIVATE resource.
 *
 * Extracted from server.ts so it is unit-testable without booting the relay
 * (server.ts is self-starting). Called only AFTER /render's bearer +
 * recipient-set + decrypt checks pass, so it exposes nothing new — it renders
 * what the authorized owner already received as plaintext, but as HyperMarkdown
 * (the note's own text as rung-1 prose, the descriptor's affordances as
 * target-free :::control blocks, describedby/alternate links to the authority).
 */
import {
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
 *  actions, with descriptor transport affordances dropped. Each is marked
 *  `executable` — true iff its action has a REAL hydra:target resolvable from the
 *  signed descriptor or graph (so `invoke_affordance` can follow it). A control
 *  with no target is DECLARATIVE (describes an interaction shape, no execution
 *  endpoint): the viewer shows it read-only instead of firing a doomed submit. */
export function viewerControls(
  controls: readonly HypermediaControl[],
  executableActions?: ReadonlySet<string>,
): Array<Record<string, unknown>> {
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
      executable: executableActions ? executableActions.has(c.action) : false,
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
  const descriptorControls = controlsFromAffordances(
    extractAffordancesFromTurtle(input.descriptorTurtle, input.authority),
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
  // Merge; on an action collision the signed PAYLOAD control wins (authored,
  // verified content outranks a transport-descriptor affordance).
  const byAction = new Map<string, (typeof descriptorControls)[number]>();
  for (const c of [...descriptorControls, ...payloadControls]) byAction.set(c.action, c);
  const controls = [...byAction.values()];
  // Reflect the note's ACTUAL visibility (from the descriptor) in the projection.
  // A PUBLIC note (iep:visibility "public" / iep:encrypted false) must NOT be
  // labelled or stated as private/encrypted (georgio: public note mislabeled private).
  const isPublic = /iep:visibility\s+"public"/.test(input.descriptorTurtle) || /iep:encrypted\s+false\b/.test(input.descriptorTurtle);
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

/** True when a URL carries an `internal` DNS label — terminal `.internal` OR
 *  mid-label `.internal.` (as Azure ACA synthesizes). Such a host must never
 *  enter a store-and-forward projection's bytes. Mirrors the relay's invoke
 *  guard (server.ts assertInvokeTargetAllowed). Unparseable → treated as unsafe. */
function hasInternalHostLabel(u: string): boolean {
  try { return new URL(u).hostname.toLowerCase().split('.').includes('internal'); }
  catch { return true; }
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
 * verifiable"). Byte-shape-identical to publish_context's inline `rendered`.
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
  /** The persisted descriptor Turtle. */
  readonly descriptorTurtle: string;
  /** Decrypted (private) or plaintext (public) payload — null when unavailable. */
  readonly plaintextTurtle: string | null;
  /** PUBLIC_BASE_URL ('' in dev → localhost fallback). */
  readonly publicBase: string;
  /** PORT, for the dev localhost fallback. */
  readonly port: number;
}): { rendered: string; mediaType: string } | null {
  const { descriptorUrl, descriptorTurtle, plaintextTurtle, publicBase, port } = input;
  if (!plaintextTurtle) return null; // fail-closed: non-recipient / no key → no projection
  // The same note-like gate publish_context uses — arbitrary ontologies are not notes.
  if (!/\b(schema:text|schema:articleBody|dct:description|rdfs:comment|schema:name|dct:title|AgentMemory|NoteDigitalDocument)\b/.test(plaintextTurtle)) return null;
  const base = (publicBase || `http://localhost:${port}`).replace(/\/+$/, '');
  let viewUrl = renderTargetFromTurtle(descriptorTurtle, base);
  let authority: string;
  if (viewUrl) {
    // Host-free render identity recovered (every encrypted note has one). Use it
    // for BOTH @id and describedby, so an internal descriptor URL can never enter
    // the projection — matches publish_context (authority = viewUrl).
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
    const rendered = noteToHyperMarkdown({ viewUrl, authority, descriptorTurtle, plaintextTurtle });
    return { rendered, mediaType: HYPERMEDIA_MARKDOWN_MEDIA_TYPE };
  } catch { return null; }
}
