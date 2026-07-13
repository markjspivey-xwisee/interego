/**
 * @module kernel/hypermedia-markdown
 * @description HyperMarkdown — the substrate's Markdown projection. ONE general
 * renderer for ANY dereferenceable resource (ontology page, context descriptor,
 * exchange document, lattice holon, collection …): the consumers compose it;
 * none of them formats Markdown themselves.
 *
 * A HyperMarkdown document is a PROGRESSIVELY ENHANCED representation with four
 * rungs, each inert to the rung below (the HyperMarkdown 0.1 model):
 *
 *   1. PROSE      — CommonMark a human reads; everything above renders inert.
 *   2. STRUCTURE  — YAML frontmatter any YAML parser queries (quoted `@`-keys).
 *   3. SEMANTICS  — the frontmatter is valid JSON-LD 1.1 under its own INLINE
 *                   `@context`: every key expands to a real triple, offline.
 *   4. HYPERMEDIA — typed links `[label](href){rel="…"}` and `:::control`
 *                   fenced blocks a generic agent discovers and acts on.
 *
 * This is a projection requested by content negotiation — a peer of Turtle and
 * JSON-LD, never a side-channel. It is NOT a new media type: the wire type is
 * `text/markdown; charset=UTF-8; variant=CommonMark` (RFC 7763 — charset is the
 * registration's REQUIRED parameter; `variant` names the SYNTAX flavor per the
 * RFC 7764 registry) and the SEMANTIC dialect is declared where semantics
 * belong: an RFC 6906 profile link ({@link HMD_PROFILE_LINK_HEADER}) plus the
 * in-band `profile:` key (`dct:conformsTo`), because headers die at the first
 * copy-paste and these bytes travel store-and-forward.
 *
 * ── SECURITY INVARIANT (authority closure) ──────────────────────────────────
 * A control NEVER carries a transport endpoint. {@link HypermediaControl} has
 * no target field — the type system enforces it — and the renderer COMPUTES
 * every control's `target` as a fragment of the document's own `@id`
 * (`<id>#control-<name>`), exactly the shape of the HyperMarkdown demo's
 * `urn:decision:…#approval`. {@link parseHypermediaMarkdown} rejects any
 * control whose target escapes that closure. So HyperMarkdown's REQUIRED
 * `hmd:target` and the zero-trust rule are the same emitted bytes:
 *
 *     read doc → invoke_affordance(descriptorUrl, rel)
 *              → re-resolves hydra:target from the SIGNED descriptor
 *
 * THE DOCUMENT IS A VIEW. THE DESCRIPTOR IS THE AUTHORITY. A naive tool that
 * blindly fires `method` at `target` hits the document's own (read-only)
 * resource — never an attacker-chosen URL.
 *
 * Pure + deterministic + zero-dependency: same input → byte-identical output,
 * no clock read, no YAML library (we emit and re-read a closed subset we
 * ourselves produce; conformance against real YAML/JSON-LD processors is
 * asserted in the tests workspace).
 */
import { KERNEL_JSONLD_CONTEXT } from './hypermedia.js';
import type { Affordance } from './types.js';

// ── Media type + profile (RFC 7763/7764 + RFC 6906) ────────────────────────

/** RFC 7764-registered Markdown SYNTAX variant. The document body is valid
 *  CommonMark; frontmatter, `{rel=…}` groups and `:::` fences degrade to inert
 *  text — which is rung 1 of the model, not a defect. */
export const HYPERMEDIA_MARKDOWN_VARIANT = 'CommonMark' as const;
/** The wire type. charset is REQUIRED by the text/markdown registration. */
export const HYPERMEDIA_MARKDOWN_MEDIA_TYPE =
  'text/markdown; charset=UTF-8; variant=CommonMark' as const;
/** @deprecated Never emitted. Recognized on read paths only: `variant` names a
 *  syntax flavor (RFC 7764 registry), and "Interego" was a semantic profile
 *  squatting in a syntax parameter. Documents stamped with it persist in
 *  store-and-forward channels indefinitely, so recognition is permanent. */
export const HYPERMEDIA_MARKDOWN_MEDIA_TYPE_LEGACY =
  'text/markdown; variant=Interego' as const;
/** RFC 6906 profile IRI — the live, conneg-dereferenceable HyperMarkdown
 *  vocabulary, hosted by the substrate's own /ns route (the github.io mirror
 *  serves the raw Turtle as cold standby). */
export const HMD_PROFILE_IRI =
  'https://relay.interego.xwisee.com/ns/maintainer/hmd' as const;
export const HMD_NS = `${HMD_PROFILE_IRI}#` as const;
/** Ready-made `Link` header value (RFC 8288). */
export const HMD_PROFILE_LINK_HEADER = `<${HMD_PROFILE_IRI}>; rel="profile"` as const;

// ── The projection @context ─────────────────────────────────────────────────
//
// Emitted as the SECOND entry of the frontmatter's `@context` array, after
// KERNEL_JSONLD_CONTEXT (verbatim, wire-compatible with every kernel verb
// response). JSON-LD 1.1 processes context arrays in order, so entries here
// deliberately OVERRIDE kernel aliases — exactly one matters:
//
//   target → hmd:target   (kernel: hydra:target)
//
// In a DOCUMENT, `target` is the logical action junction (a fragment of the
// document's own @id), never the transport endpoint — so even a hand-edited
// frontmatter `target:` key cannot expand to hydra:target under the document's
// own declared context. Everything else maps onto EXISTING vocabularies
// (wdrs/skos/schema/dct/hmd) — this projection mints zero new terms.
export const HMD_PROJECTION_CONTEXT = Object.freeze({
  hmd: HMD_NS,
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  schema: 'https://schema.org/',
  wdrs: 'http://www.w3.org/2007/05/powder-s#',
  // `type:` inside :::control blocks is a keyword alias — without it the key
  // would silently drop under expansion (the exact defect class this module
  // exists to end).
  type: '@type',
  profile: { '@id': 'dct:conformsTo', '@type': '@id' },
  title: { '@id': 'dct:title' },
  // The projected resource's pointer to THIS representation's own node —
  // where the profile claim and hmd:Document typing live (a representation
  // conforms to the profile; the resource it depicts does not).
  document: { '@id': 'schema:subjectOf' },
  about: { '@id': 'schema:about', '@type': '@id' },
  descriptorUrl: { '@id': 'wdrs:describedby', '@type': '@id' },
  state: { '@id': 'schema:creativeWorkStatus' },
  rel: { '@id': 'hmd:rel', '@type': '@id' },
  control: { '@id': 'hmd:control', '@type': '@id', '@container': '@set' },
  condition: { '@id': 'hmd:condition' },
  whenToUse: { '@id': 'skos:scopeNote' },
  requires: { '@id': 'dct:requires', '@container': '@set' },
  target: { '@id': 'hmd:target', '@type': '@id' },
}) as Readonly<Record<string, unknown>>;

// ── Input model ──────────────────────────────────────────────────────────────

/** A typed link — rung 4's other half. Rendered `[label](href){rel="…" type="…"}`
 *  (quoted-attribute form: the HyperMarkdown reference attribute parser only
 *  recognizes quoted values). Always full IRIs — `[[wiki-links]]` are a consumer
 *  authoring idiom, never server output. */
export interface HypermediaLink {
  readonly label: string;
  readonly href: string;
  readonly rel: string;
  readonly type?: string;
}

/**
 * A control as it appears IN A DOCUMENT.
 *
 * Deliberately has no `target` field. See the SECURITY INVARIANT above: the
 * renderer computes `target = <doc.id>#control-<id>` (authority closure), so a
 * composer — or an attacker upstream of one — cannot inject a transport
 * endpoint into the bytes.
 */
export interface HypermediaControl {
  /** The `iep:action` IRI — what this control does (emitted as `rel`). */
  readonly action: string;
  /** Block id override (without the `control-` prefix). Default: sanitized
   *  local name of `action`, deduped `-2`, `-3`… within the document. */
  readonly id?: string;
  /** Advisory only; the signed descriptor remains authoritative. */
  readonly method?: string;
  /** `hydra:returnsContentType` of the response, when declared. */
  readonly mediaType?: string;
  /** `hydra:expects` input type (IRI/CURIE), when declared. */
  readonly expects?: string;
  /** `hydra:returns` output type (IRI/CURIE), when declared. */
  readonly returns?: string;
  /** Model-facing guidance → `skos:scopeNote`. */
  readonly whenToUse?: string;
  /** Preconditions a caller must satisfy → `dct:requires`. */
  readonly requires?: readonly string[];
  /** HATEOAS gate, e.g. `{ state: 'pending' }` → `hmd:condition`. Gated
   *  against the document's `state`; executors re-check LIVE state — the
   *  frontmatter snapshot is advisory rung-2 data, never an authz input. */
  readonly condition?: Readonly<Record<string, string>>;
}

/** The document: identity + grounding + data + links + controls + prose. */
export interface HypermediaMarkdownDoc {
  /** `@id` — absolute, fragment-free IRI of the graph resource this document
   *  is a peer representation of (render throws on a fragment). */
  readonly id: string;
  /** `@type` — one or many; every entry must resolve in the merged context. */
  readonly type: string | readonly string[];
  /** THE AUTHORITY (`wdrs:describedby`) — the signed descriptor every control
   *  is re-resolved against at execution time. */
  readonly descriptorUrl: string;
  /** `dct:title`, when known. */
  readonly title?: string;
  /** `schema:creativeWorkStatus` — advisory lifecycle snapshot; REQUIRED when
   *  any control carries a `condition` (a gate with nothing to gate against
   *  reads as permanently disabled). */
  readonly state?: string;
  /** `sh:shapesGraph` the payload conforms to, when declared. */
  readonly conformsToShape?: string;
  /** Additional frontmatter data (rungs 2–3). Every key MUST resolve under
   *  the merged context — a declared term, a CURIE with a declared prefix, or
   *  an absolute IRI. Undeclared keys throw at render time: silent-drop under
   *  expansion is the defect this module exists to end. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Caller context extensions (e.g. `{ amep: 'https://…/0.1#' }`), appended
   *  AFTER the projection context. May not override `target`. */
  readonly extraContext?: Readonly<Record<string, unknown>>;
  /** The control surface — emitted as `:::control` blocks after the body. */
  readonly controls: readonly HypermediaControl[];
  /** Typed links, emitted as a bullet list between prose and controls. */
  readonly links?: readonly HypermediaLink[];
  /** The human half. CommonMark prose, rendered verbatim after the
   *  frontmatter. Lines beginning `:::` are rejected (block smuggling). */
  readonly body: string;
}

// ── YAML emission (closed subset, zero deps) ────────────────────────────────
//
// NOTE the quoting of `@`-prefixed keys. `@` is a YAML reserved indicator, so a
// BARE `@context:` / `@id:` / `@type:` key is INVALID YAML and will fail every
// conformant parser. They MUST be quoted.
const AT_KEYS = new Set(['@context', '@id', '@type', '@container']);

function yamlKey(k: string): string {
  return AT_KEYS.has(k) || k.startsWith('@') ? `"${k}"` : k;
}

/** Double-quote every string scalar: total, deterministic, and colon/`#`-safe.
 *
 * Escapes backslash, quote, and every C0/DEL control character (newline, CR,
 * tab, ...) using YAML double-quoted escapes. A raw newline in a value would
 * otherwise terminate the scalar early — injecting a spurious YAML key or a
 * bare `---` that splits the frontmatter — and make the output invalid for any
 * conformant parser. Since a value can originate from attacker-published RDF
 * (a `dcat:mediaType` / `rdfs:label` carrying a newline), this is a correctness
 * boundary, not a nicety. `unquote` is the exact inverse. */
function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) =>
      `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return `"${s}"`;
}

/** Emit a plain object as a YAML block at `indent`. Key order is insertion
 *  order (stable). Nested objects recurse; arrays emit as inline flow lists. */
function yamlBlock(obj: Readonly<Record<string, unknown>>, indent: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(`${indent}${yamlKey(k)}:`);
      out.push(...yamlBlock(v as Record<string, unknown>, `${indent}  `));
    } else if (Array.isArray(v)) {
      out.push(`${indent}${yamlKey(k)}: [${v.map(yamlScalar).join(', ')}]`);
    } else {
      out.push(`${indent}${yamlKey(k)}: ${yamlScalar(v)}`);
    }
  }
  return out;
}

/** Emit a YAML sequence of maps (`- k: v` / continuation-indented) — the
 *  frontmatter `@context` array shape. */
function yamlSeqOfMaps(maps: ReadonlyArray<Readonly<Record<string, unknown>>>, indent: string): string[] {
  const out: string[] = [];
  for (const m of maps) {
    const block = yamlBlock(m, `${indent}  `);
    if (block.length === 0) continue;
    out.push(`${indent}- ${block[0]!.slice(indent.length + 2)}`);
    out.push(...block.slice(1));
  }
  return out;
}

// ── Term resolution (the no-silent-drop guarantee) ──────────────────────────

const ABSOLUTE_IRI_RE = /^[a-z][a-z0-9+.-]*:/i;

function mergedContext(extra?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { ...KERNEL_JSONLD_CONTEXT, ...HMD_PROJECTION_CONTEXT, ...(extra ?? {}) };
}

/** The IRI a context entry maps its term onto (string entry → the IRI itself;
 *  object entry → its `@id`). */
function contextTermIri(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry !== null && typeof entry === 'object') {
    const id = (entry as Record<string, unknown>)['@id'];
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Expand a key/term to an absolute IRI under the merged context, or throw.
 * Resolution order: declared term alias → CURIE with declared prefix →
 * already-absolute IRI. This is what makes a private dialect impossible: a
 * key that would silently drop under JSON-LD expansion fails loudly at
 * render time instead.
 */
export function expandHmdTerm(term: string, extra?: Readonly<Record<string, unknown>>): string {
  const ctx = mergedContext(extra);
  const alias = contextTermIri(ctx[term]);
  if (alias) return alias.includes(':') && !ABSOLUTE_IRI_RE.test(alias) ? alias : expandMaybeCurie(alias, ctx) ?? alias;
  const viaCurie = expandMaybeCurie(term, ctx);
  if (viaCurie) return viaCurie;
  // Any RFC 3986 scheme is accepted as absolute. Control action IRIs arrive
  // from USER-PUBLISHED graphs (any scheme: ws:, geo:, ni:, …) — a hardcoded
  // scheme allowlist here turned one exotic-but-legal IRI in one public graph
  // into a render-time throw on a public route. The cost is that a mistyped
  // CURIE with an undeclared prefix passes as an "IRI" instead of throwing —
  // exactly how a JSON-LD processor treats it.
  if (ABSOLUTE_IRI_RE.test(term) && !term.startsWith('@')) return term;
  throw new Error(
    `hypermedia-markdown: "${term}" does not resolve under the document @context — `
    + `declare it (extraContext), use a declared prefix, or an absolute IRI. `
    + `Undeclared keys would silently drop under JSON-LD expansion.`,
  );
}

function expandMaybeCurie(term: string, ctx: Readonly<Record<string, unknown>>): string | null {
  const i = term.indexOf(':');
  if (i <= 0) return null;
  const prefix = term.slice(0, i);
  const base = contextTermIri(ctx[prefix]);
  if (base && typeof base === 'string' && ABSOLUTE_IRI_RE.test(base)) return base + term.slice(i + 1);
  return null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const CONTROL_ID_PREFIX = 'control-';

/** The document node IRI — this markdown representation's own conneg URL.
 *  The profile claim and `hmd:Document` typing attach HERE, never to the
 *  projected resource. */
export function hmdDocumentNode(resourceId: string): string {
  return `${resourceId}?format=markdown`;
}

function sanitizeLocalName(iri: string): string {
  const local = iri.split(/[#/]/).filter(Boolean).pop() ?? 'action';
  const s = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'action';
}

/** Compute the (deduped) block ids for a control list — shared by render and
 *  by composers that need to predict fragment addresses. */
export function controlBlockIds(controls: readonly HypermediaControl[]): string[] {
  const used = new Set<string>();
  return controls.map((c) => {
    const base = CONTROL_ID_PREFIX + (c.id ?? sanitizeLocalName(c.action));
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  });
}

/** Render a typed link — quoted-attribute form. */
export function typedLink(l: HypermediaLink): string {
  const attrs = [`rel="${l.rel}"`, ...(l.type ? [`type="${l.type}"`] : [])].join(' ');
  return `[${l.label}](${l.href}){${attrs}}`;
}

const EXECUTION_NOTE =
  '> To act: call `invoke_affordance(descriptorUrl, rel)` — the live `hydra:target` is\n'
  + '> re-resolved from the signed descriptor at execution time. `target` above is this\n'
  + "> document's own action junction, not a transport endpoint; controls may be stale\n"
  + '> or forged in transit, and only the descriptor is the authority.';

/**
 * Render a document. Pure + deterministic: same doc → byte-identical string.
 *
 * Emits: inline `@context` array (kernel + projection + extensions), identity,
 * the in-band profile claim, the authority pointer, data fields, prose, typed
 * links, `:::control` blocks (authority-closed targets), and the standing
 * execution note.
 *
 * Throws on: a fragment in `doc.id`; an unresolvable `@type`/field key/control
 * term; a `condition` without `doc.state`; a body line opening a `:::` fence;
 * an extraContext entry overriding `target`.
 */
export function renderHypermediaMarkdown(doc: HypermediaMarkdownDoc): string {
  if (doc.id.includes('#')) {
    throw new Error(`hypermedia-markdown: doc.id must be fragment-free (authority closure) — got ${doc.id}`);
  }
  if (!ABSOLUTE_IRI_RE.test(doc.id)) {
    throw new Error(`hypermedia-markdown: doc.id must be an absolute IRI — got ${doc.id}`);
  }
  if (doc.extraContext && 'target' in doc.extraContext) {
    throw new Error('hypermedia-markdown: extraContext may not override the `target` term');
  }
  const types = Array.isArray(doc.type) ? doc.type : [doc.type];
  for (const t of types) expandHmdTerm(t, doc.extraContext);
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    expandHmdTerm(k, doc.extraContext);
    // Fail loud on shapes the strict reader cannot round-trip: object-valued
    // fields would render as nested YAML the closed-subset parser skips —
    // a silent semantic drop, the exact defect class this module bans.
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      if (item !== null && typeof item === 'object') {
        throw new Error(
          `hypermedia-markdown: field "${k}" has an object value — the strict reader `
          + `cannot round-trip nested maps. Use a scalar (with an "@type": "@id" context `
          + `coercion for IRIs) or an inline list of scalars.`,
        );
      }
    }
  }
  if (doc.controls.some((c) => c.condition) && doc.state === undefined) {
    throw new Error('hypermedia-markdown: controls carry `condition` but doc.state is unset — the gate would read permanently disabled');
  }
  for (const line of doc.body.split('\n')) {
    if (/^:::/.test(line)) {
      throw new Error('hypermedia-markdown: body lines may not open a ::: fence (reserved for renderer-emitted control blocks)');
    }
  }

  // ── frontmatter ──
  const fm: string[] = ['---'];
  fm.push('"@context":');
  // The kernel context is emitted minus its `target` alias (→ hydra:target):
  // the projection context REDECLARES `target` as hmd:target, and while the
  // array override would win anyway under JSON-LD 1.1, omitting the shadowed
  // entry keeps the transport-endpoint IRI out of the bytes entirely — a
  // grep-level invariant auditors can check without a JSON-LD processor.
  const { target: _shadowed, ...kernelCtxSansTarget } = KERNEL_JSONLD_CONTEXT as Record<string, unknown>;
  const ctxSeq: Array<Readonly<Record<string, unknown>>> = [
    kernelCtxSansTarget,
    HMD_PROJECTION_CONTEXT as Record<string, unknown>,
  ];
  if (doc.extraContext && Object.keys(doc.extraContext).length > 0) ctxSeq.push(doc.extraContext);
  fm.push(...yamlSeqOfMaps(ctxSeq, '  '));

  fm.push(`"@id": ${yamlScalar(doc.id)}`);
  fm.push(types.length === 1
    ? `"@type": ${yamlScalar(types[0])}`
    : `"@type": [${types.map(yamlScalar).join(', ')}]`);
  if (doc.title !== undefined) fm.push(`title: ${yamlScalar(doc.title)}`);
  fm.push(`descriptorUrl: ${yamlScalar(doc.descriptorUrl)}`);
  if (doc.conformsToShape) fm.push(`conformsToShape: ${yamlScalar(doc.conformsToShape)}`);
  if (doc.state !== undefined) fm.push(`state: ${yamlScalar(doc.state)}`);
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) fm.push(`${yamlKey(k)}: [${v.map(yamlScalar).join(', ')}]`);
    else fm.push(`${yamlKey(k)}: ${yamlScalar(v)}`);
  }
  // The RFC 6906 profile claim rides on a DISTINCT DOCUMENT NODE — this
  // markdown representation's own conneg URL — never on the projected
  // resource: `<resource> dct:conformsTo <hmd>` would be a false triple (the
  // SOC2 ontology does not conform to the HyperMarkdown vocabulary; its
  // markdown REPRESENTATION does). Deterministic, computed from @id; the
  // strict reader skips it and render() regenerates it.
  fm.push('document:');
  fm.push(`  "@id": ${yamlScalar(hmdDocumentNode(doc.id))}`);
  fm.push('  "@type": "hmd:Document"');
  fm.push(`  profile: ${yamlScalar(HMD_PROFILE_IRI)}`);
  fm.push(`  about: ${yamlScalar(doc.id)}`);
  fm.push('---');

  // ── body + links + controls ──
  const parts: string[] = [fm.join('\n'), '', doc.body.trimEnd()];

  if (doc.links && doc.links.length > 0) {
    parts.push('', doc.links.map((l) => `- ${typedLink(l)}`).join('\n'));
  }

  if (doc.controls.length > 0) {
    const ids = controlBlockIds(doc.controls);
    doc.controls.forEach((c, i) => {
      expandHmdTerm(c.action, doc.extraContext);
      if (c.expects) expandHmdTerm(c.expects, doc.extraContext);
      if (c.returns) expandHmdTerm(c.returns, doc.extraContext);
      const b: string[] = [`:::control ${ids[i]}`];
      const ctypes = ['hmd:Control', 'hydra:Operation'];
      b.push(`type: [${ctypes.map(yamlScalar).join(', ')}]`);
      b.push(`rel: ${yamlScalar(c.action)}`);
      b.push(`method: ${yamlScalar((c.method ?? 'POST').toUpperCase())}`);
      // AUTHORITY CLOSURE — computed, never caller-supplied.
      b.push(`target: ${yamlScalar(`${doc.id}#${ids[i]}`)}`);
      if (c.expects) b.push(`expects: ${yamlScalar(c.expects)}`);
      if (c.returns) b.push(`returns: ${yamlScalar(c.returns)}`);
      if (c.mediaType) b.push(`mediaType: ${yamlScalar(c.mediaType)}`);
      if (c.whenToUse) b.push(`whenToUse: ${yamlScalar(c.whenToUse)}`);
      if (c.requires && c.requires.length > 0) b.push(`requires: [${c.requires.map(yamlScalar).join(', ')}]`);
      if (c.condition) {
        const entries = Object.entries(c.condition).map(([k, v]) => `${k}: ${yamlScalar(v)}`);
        b.push(`condition: { ${entries.join(', ')} }`);
      }
      b.push(':::');
      parts.push('', b.join('\n'));
    });
    parts.push('', EXECUTION_NOTE);
  }

  return `${parts.join('\n')}\n`;
}

// ── Reading back (round-trip) ───────────────────────────────────────────────

/** Inverse of `yamlScalar`. Single left-to-right pass over the escape
 *  sequences — NOT sequential `.replace()` calls, which double-unescape (a
 *  literal `\\n` in the source would wrongly decode to a newline). */
function unquote(v: string): string {
  const t = v.trim();
  if (!(t.startsWith('"') && t.endsWith('"'))) return t;
  const inner = t.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = inner[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'x') { out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 3), 16)); i += 2; }
    else out += n ?? ''; // covers \" \\ and any stray escape
  }
  return out;
}

/** Split on commas OUTSIDE double quotes — shared by inline lists and maps so
 *  a quoted value containing a comma survives intact. */
function splitOutsideQuotes(inner: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '"' && inner[i - 1] !== '\\') inStr = !inStr;
    if (c === ',' && !inStr) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** First `:` OUTSIDE double quotes — so quoted keys/values containing colons
 *  cannot mis-split a map entry. Returns -1 when none. */
function colonOutsideQuotes(s: string): number {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' && s[i - 1] !== '\\') inStr = !inStr;
    if (c === ':' && !inStr) return i;
  }
  return -1;
}

function parseInlineList(v: string): string[] {
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return [];
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return splitOutsideQuotes(inner).map((s) => unquote(s.trim())).filter((s) => s.length > 0);
}

function parseInlineMap(v: string): Record<string, string> | null {
  const t = v.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  const inner = t.slice(1, -1).trim();
  const out: Record<string, string> = {};
  if (!inner) return out;
  for (const part of splitOutsideQuotes(inner)) {
    const i = colonOutsideQuotes(part);
    if (i <= 0) continue;
    out[unquote(part.slice(0, i).trim())] = unquote(part.slice(i + 1).trim());
  }
  return out;
}

const KNOWN_TOP_KEYS = new Set(['@id', '@type', 'profile', 'title', 'descriptorUrl', 'conformsToShape', 'state']);

/**
 * Read back a document this module emitted (or a legacy `variant=Interego`
 * document — the frozen v0 dialect with a frontmatter `affordances:` list and
 * `actionIri:` keys; those bytes persist in store-and-forward channels
 * indefinitely, so the read path is permanent).
 *
 * A strict reader for OUR closed subset — deliberately not a general YAML
 * parser (core takes no runtime deps). The `@context` block is skipped, not
 * re-parsed: it is a constant the renderer emits, never document state.
 *
 * VERIFIES on parse (authority closure): every control's `target` is
 * `<@id>#control-…` and never equals its `rel` — a tampered target throws.
 */
export function parseHypermediaMarkdown(md: string): HypermediaMarkdownDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) throw new Error('hypermedia-markdown: missing YAML frontmatter block');
  const fm = m[1] ?? '';
  const rest = md.slice(m[0].length).replace(/^\r?\n/, '');

  let id = '', descriptorUrl = '', title: string | undefined, state: string | undefined,
    conformsToShape: string | undefined;
  let types: string[] = [];
  const fields: Record<string, unknown> = {};
  const ctxPrefixes: Record<string, string> = {};
  const legacyControls: Array<{ -readonly [K in keyof HypermediaControl]?: HypermediaControl[K] }> = [];
  let legacyCur: { -readonly [K in keyof HypermediaControl]?: HypermediaControl[K] } | null = null;
  let inLegacyAffordances = false;
  let inContext = false;
  let skipIndented = false;

  const flushLegacy = () => {
    if (legacyCur?.action) legacyControls.push(legacyCur);
    legacyCur = null;
  };

  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;

    if (inContext || skipIndented) {
      if (/^\s/.test(line) || /^-\s/.test(line)) {
        if (inContext) {
          // Capture prefix-map entries so extraContext prefixes survive the
          // round trip (the kernel/projection constants are filtered out below).
          const pm = /^\s*-?\s*([\w-]+):\s*"([^"]+)"\s*$/.exec(line);
          if (pm && ABSOLUTE_IRI_RE.test(pm[2]!)) ctxPrefixes[pm[1]!] = pm[2]!;
        }
        continue;
      }
      inContext = false;
      skipIndented = false;
    }
    if (/^"@context"\s*:/.test(line)) { inContext = true; continue; }

    // Legacy dialect: frontmatter `affordances:` list with actionIri entries.
    if (/^affordances\s*:/.test(line)) { flushLegacy(); inLegacyAffordances = true; continue; }
    if (inLegacyAffordances && /^\s*-\s+actionIri\s*:/.test(line)) {
      flushLegacy();
      legacyCur = { action: unquote(line.replace(/^\s*-\s+actionIri\s*:/, '')) };
      continue;
    }
    if (inLegacyAffordances && legacyCur && /^\s+\w+\s*:/.test(line)) {
      const km = /^\s+(\w+)\s*:\s*(.*)$/.exec(line);
      if (km) {
        const k = km[1]!, v = km[2] ?? '';
        if (k === 'method') legacyCur.method = unquote(v);
        else if (k === 'mediaType') legacyCur.mediaType = unquote(v);
        else if (k === 'whenToUse') legacyCur.whenToUse = unquote(v);
        else if (k === 'requires') legacyCur.requires = parseInlineList(v);
      }
      continue;
    }
    if (!/^\s/.test(line)) { flushLegacy(); inLegacyAffordances = false; }

    // Key = the maximal whitespace-free token before the separating colon —
    // greedy backtracking makes CURIE keys (`dct:title: "x"`) parse whole.
    const km = /^("[^"]+"|\S+):\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1]!.replace(/^"|"$/g, '');
    const val = km[2] ?? '';
    if (key === '@id') id = unquote(val);
    else if (key === '@type') {
      types = val.trim().startsWith('[') ? parseInlineList(val) : [unquote(val)];
    } else if (key === 'profile') { /* constant claim — not doc state */ }
    else if (key === 'descriptorUrl') descriptorUrl = unquote(val);
    else if (key === 'title') title = unquote(val);
    else if (key === 'state') state = unquote(val);
    else if (key === 'conformsToShape') conformsToShape = unquote(val);
    else if (key === '@context') { inContext = true; }
    else if (!KNOWN_TOP_KEYS.has(key)) {
      if (val === '') { skipIndented = true; continue; } // nested block field — opaque to the strict reader
      if (val.trim().startsWith('[')) fields[key] = parseInlineList(val);
      else if (/^-?\d+(\.\d+)?$/.test(val.trim())) fields[key] = Number(val.trim());
      else if (val.trim() === 'true' || val.trim() === 'false') fields[key] = val.trim() === 'true';
      else fields[key] = unquote(val);
    }
  }
  flushLegacy();

  // ── body + :::control blocks ──
  const controls: Array<{ -readonly [K in keyof HypermediaControl]?: HypermediaControl[K] }> = [];
  const bodyLines: string[] = [];
  const lines = rest.split(/\r?\n/);
  let i = 0;
  let sawControl = false;
  while (i < lines.length) {
    const line = lines[i]!;
    const opener = /^:::control ([A-Za-z][\w-]*)\s*$/.exec(line);
    if (!opener) {
      // Drop the constant execution note (re-emitted by render); keep other prose.
      if (sawControl && line.startsWith('> ')) { i++; continue; }
      bodyLines.push(line);
      i++;
      continue;
    }
    sawControl = true;
    const blockId = opener[1]!;
    if (!blockId.startsWith(CONTROL_ID_PREFIX)) {
      throw new Error(`hypermedia-markdown: control block id "${blockId}" outside the reserved ${CONTROL_ID_PREFIX} space`);
    }
    const c: { -readonly [K in keyof HypermediaControl]?: HypermediaControl[K] } = {
      id: blockId.slice(CONTROL_ID_PREFIX.length),
    };
    let target = '';
    i++;
    for (; i < lines.length && !/^:::\s*$/.test(lines[i]!); i++) {
      const pm = /^(\w+)\s*:\s*(.*)$/.exec(lines[i]!);
      if (!pm) continue;
      const k = pm[1]!, v = pm[2] ?? '';
      if (k === 'rel') c.action = unquote(v);
      else if (k === 'method') c.method = unquote(v);
      else if (k === 'target') target = unquote(v);
      else if (k === 'expects') c.expects = unquote(v);
      else if (k === 'returns') c.returns = unquote(v);
      else if (k === 'mediaType') c.mediaType = unquote(v);
      else if (k === 'whenToUse') c.whenToUse = unquote(v);
      else if (k === 'requires') c.requires = parseInlineList(v);
      else if (k === 'condition') { const cm = parseInlineMap(v); if (cm) c.condition = cm; }
      // `type:` is constant [hmd:Control, hydra:Operation] — not doc state.
    }
    i++; // consume closer
    if (!c.action) throw new Error(`hypermedia-markdown: control block "${blockId}" is missing rel`);
    // ── AUTHORITY CLOSURE CHECK ──
    if (target !== `${id}#${blockId}`) {
      throw new Error(
        `hypermedia-markdown: control "${blockId}" target escapes the authority closure `
        + `(expected ${id}#${blockId}, got ${target || '(none)'}) — refusing tampered bytes`,
      );
    }
    if (target === c.action) {
      throw new Error(`hypermedia-markdown: control "${blockId}" target must not equal its rel`);
    }
    controls.push(c);
  }

  if (!id || !descriptorUrl) {
    throw new Error('hypermedia-markdown: frontmatter must carry "@id" and descriptorUrl');
  }

  // Reconstruct extraContext: prefixes captured from the @context block that
  // the kernel/projection constants do not already declare.
  const known = mergedContext();
  const extra: Record<string, unknown> = {};
  for (const [pfx, iri] of Object.entries(ctxPrefixes)) {
    if (contextTermIri(known[pfx]) !== iri) extra[pfx] = iri;
  }

  const allControls = [...legacyControls, ...controls] as HypermediaControl[];
  return {
    id,
    type: types.length === 1 ? types[0]! : types,
    descriptorUrl,
    ...(title !== undefined ? { title } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(conformsToShape ? { conformsToShape } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(Object.keys(extra).length > 0 ? { extraContext: extra } : {}),
    controls: allControls,
    body: bodyLines.join('\n').replace(/\n+$/, ''),
  };
}

// ── Deterministic RDF lift (HyperMarkdown → triples) ────────────────────────

/** One lifted statement. `oKind` distinguishes IRIs from literals; blank
 *  nodes use stable `_:cN` labels in document order. */
export interface HmdTriple {
  readonly s: string;
  readonly p: string;
  readonly o: string;
  readonly oKind: 'iri' | 'literal' | 'blank';
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Deterministic RDF lift of an emitted document: frontmatter keys under the
 * projection context, `:::control` blocks per the fixed lift table (the
 * control node is `<@id>#<blockId>`, attached via `hmd:control`; `rel` is
 * dual-asserted as `hmd:rel` AND `iep:action` so substrate tools keying on
 * `iep:action` need no inference), and typed links as edges. Output sorted
 * by (s, p, o); zero-dep. Conformance of this lift against a real JSON-LD
 * processor is asserted in the tests workspace.
 */
export function liftHypermediaMarkdown(md: string): readonly HmdTriple[] {
  const doc = parseHypermediaMarkdown(md);
  const out: HmdTriple[] = [];
  const D = doc.id;
  const ex = (t: string) => expandHmdTerm(t, doc.extraContext);
  const push = (s: string, p: string, o: string, oKind: HmdTriple['oKind']) =>
    out.push({ s, p, o, oKind });

  const types = Array.isArray(doc.type) ? doc.type : [doc.type];
  for (const t of types) push(D, RDF_TYPE, ex(t), 'iri');
  // Representation-scoped claims live on the DOCUMENT NODE (see render).
  const DOCN = hmdDocumentNode(D);
  push(D, ex('document'), DOCN, 'iri');
  push(DOCN, RDF_TYPE, ex('hmd:Document'), 'iri');
  push(DOCN, ex('profile'), HMD_PROFILE_IRI, 'iri');
  push(DOCN, ex('about'), D, 'iri');
  push(D, ex('descriptorUrl'), doc.descriptorUrl, 'iri');
  if (doc.title !== undefined) push(D, ex('title'), doc.title, 'literal');
  if (doc.state !== undefined) push(D, ex('state'), doc.state, 'literal');
  if (doc.conformsToShape) push(D, ex('conformsToShape'), ex(doc.conformsToShape), 'iri');
  // A field whose context term declares `"@type": "@id"` lifts its string
  // values as IRIs — the same coercion a real JSON-LD processor applies.
  const ctx = mergedContext(doc.extraContext);
  const coercesToId = (k: string): boolean => {
    const entry = ctx[k];
    return entry !== null && typeof entry === 'object'
      && (entry as Record<string, unknown>)['@type'] === '@id';
  };
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    const p = ex(k);
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === 'string' && coercesToId(k)) {
        push(D, p, ex(item), 'iri');
      } else {
        push(D, p, String(item), 'literal');
      }
    }
  }

  // Typed links (derived, not doc state). Anchored to the renderer's own
  // emission — a top-level `- [label](href){attrs}` bullet line. NOT a free
  // scan of the prose: memory bodies and other third-party text are
  // blockquoted or inline, and lifting a `{rel=…}` link out of attacker
  // prose would hand action-rel edges to consumers — the links side door
  // around the control authority closure.
  const linkLineRe = /^- \[([^\]]+)\]\(([^)]+)\)\{([^}]*)\}\s*$/;
  for (const bodyLine of doc.body.split('\n')) {
    const lm = linkLineRe.exec(bodyLine);
    if (!lm) continue;
    const attrs: Record<string, string> = {};
    for (const am of lm[3]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[am[1]!] = am[2]!;
    if (attrs['rel']) {
      const relIri = /^[a-z][\w.+-]*:/i.test(attrs['rel']) ? ex(attrs['rel']) : `http://www.iana.org/assignments/relation/${attrs['rel']}`;
      push(D, relIri, lm[2]!, 'iri');
    }
  }

  const ids = controlBlockIds(doc.controls);
  doc.controls.forEach((c, idx) => {
    const N = `${D}#${ids[idx]}`;
    push(D, ex('control'), N, 'iri');
    push(N, RDF_TYPE, ex('hmd:Control'), 'iri');
    push(N, RDF_TYPE, ex('hydra:Operation'), 'iri');
    push(N, ex('rel'), ex(c.action), 'iri');
    push(N, ex('action'), ex(c.action), 'iri');
    push(N, ex('method'), (c.method ?? 'POST').toUpperCase(), 'literal');
    push(N, ex('target'), N, 'iri');
    if (c.expects) push(N, ex('expects'), ex(c.expects), 'iri');
    if (c.returns) push(N, ex('returns'), ex(c.returns), 'iri');
    if (c.mediaType) push(N, ex('mediaType'), c.mediaType, 'literal');
    if (c.whenToUse) push(N, ex('whenToUse'), c.whenToUse, 'literal');
    for (const r of c.requires ?? []) push(N, ex('requires'), r, 'literal');
    if (c.condition) {
      const b = `_:c${idx}cond`;
      push(N, ex('condition'), b, 'blank');
      for (const [ck, cv] of Object.entries(c.condition)) {
        push(b, ck === 'state' ? ex('state') : ex(ck), cv, 'literal');
      }
    }
  });

  return out.sort((a, b) => a.s.localeCompare(b.s) || a.p.localeCompare(b.p) || a.o.localeCompare(b.o));
}

// ── Content negotiation (the ONE rule for every route) ─────────────────────

/**
 * Unified representation negotiation — kills per-route guard asymmetry.
 * Explicit `?format=` always wins; otherwise the `Accept` header is parsed
 * q-aware (RFC 9110) over the four projection types, ties broken
 * turtle > jsonld > html > markdown. Returns `'default'` when the request
 * expresses no preference among them — each route maps that to its own
 * canonical representation (Turtle for /ns; the negotiated YAML for exchange
 * documents).
 */
export function negotiateRepresentation(
  format: string | undefined,
  accept: string | undefined,
): 'turtle' | 'jsonld' | 'html' | 'markdown' | 'default' {
  const f = (format ?? '').toLowerCase();
  if (f === 'turtle' || f === 'ttl') return 'turtle';
  if (f === 'jsonld') return 'jsonld';
  if (f === 'html') return 'html';
  if (f === 'markdown' || f === 'md' || f === 'hmd') return 'markdown';
  const MAP: ReadonlyArray<readonly [string, 'turtle' | 'jsonld' | 'html' | 'markdown']> = [
    ['text/turtle', 'turtle'],
    ['application/ld+json', 'jsonld'],
    ['text/html', 'html'],
    ['text/markdown', 'markdown'],
  ];
  const PREFERENCE: Record<string, number> = { turtle: 0, jsonld: 1, html: 2, markdown: 3 };
  let best: { kind: 'turtle' | 'jsonld' | 'html' | 'markdown'; q: number } | null = null;
  for (const part of (accept ?? '').split(',')) {
    const [typeRaw, ...params] = part.trim().split(';');
    const type = (typeRaw ?? '').trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      // RFC 9110 §5.6.6: parameter names are case-insensitive (`Q=0` counts).
      const qm = /^\s*q\s*=\s*([\d.]+)/i.exec(p);
      if (qm) q = Number(qm[1]);
    }
    if (q <= 0) continue;
    for (const [mt, kind] of MAP) {
      if (type === mt) {
        if (!best || q > best.q || (q === best.q && PREFERENCE[kind]! < PREFERENCE[best.kind]!)) {
          best = { kind, q };
        }
      }
    }
  }
  return best ? best.kind : 'default';
}

/**
 * Project executable {@link Affordance}s (which DO carry `hydra:target`, read
 * from the signed descriptor) down into document-safe controls.
 *
 * THIS FUNCTION IS THE SECURITY CUT: it drops `target` on the floor. That is
 * the entire point — the document must never carry where to POST.
 */
export function controlsFromAffordances(
  affordances: readonly Affordance[],
  guidance?: Readonly<Record<string, { whenToUse?: string; requires?: readonly string[] }>>,
): HypermediaControl[] {
  return affordances.map((a) => {
    const g = guidance?.[a.action];
    return {
      action: a.action,
      ...(a.method ? { method: a.method } : {}),
      ...(a.mediaType ? { mediaType: a.mediaType } : {}),
      ...(g?.whenToUse ? { whenToUse: g.whenToUse } : {}),
      ...(g?.requires && g.requires.length > 0 ? { requires: g.requires } : {}),
      // a.target is deliberately NOT copied. See SECURITY INVARIANT.
    };
  });
}
