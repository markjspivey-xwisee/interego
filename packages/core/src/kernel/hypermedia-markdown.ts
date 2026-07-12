/**
 * @module kernel/hypermedia-markdown
 * @description Markdown + YAML-LD frontmatter — a PROJECTION of the substrate's
 * hypermedia surface into a document channel.
 *
 * WHAT THIS IS (and is not). This is NOT a new protocol and NOT a new media type.
 * It is a *rendering* of an existing, signed `iep:ContextDescriptor` into a form
 * that survives channels RDF cannot cross: a git file, a README, a pasted message,
 * an MCP resource. The protocol remains HTTP content negotiation; the controls
 * remain `iep:Affordance` / `hydra:Operation`; the executor remains
 * `followAffordance()`. Per spec/LAYERS.md this is an L3 serialization — Layer 1
 * gains nothing and defines no new terms (naming "Markdown" in an L1 MUST would
 * trip drift trigger #2).
 *
 * The frontmatter `@context` is {@link KERNEL_JSONLD_CONTEXT} VERBATIM — the same
 * object every kernel-verb response already carries. It already aliases
 * `affordances / action / method / mediaType / conformsToShape` onto `iep:`/`hydra:`
 * IRIs, so this document needs ZERO new vocabulary and adds nothing to docs/ns/.
 *
 * ── SECURITY INVARIANT (the spine of the design) ────────────────────────────
 * A control in this document carries `actionIri` and `descriptorUrl` — it NEVER
 * carries `hydra:target`. {@link HypermediaControl} has no `target` field, so the
 * invariant is enforced by the type system, not by convention.
 *
 * Rationale: MCP grants approval per-TOOL, not per-TARGET. `invoke_affordance` is
 * openWorld. If a document could name its own target, then untrusted prose (a
 * README, a pasted note, an attacker-authored pod resource) could steer an
 * auto-approved tool at an arbitrary URL — a textbook confused deputy / SSRF /
 * token-exfiltration surface. So the execution path is unchanged and unchanged on
 * purpose:
 *
 *     read doc → invoke_affordance(descriptorUrl, actionIri)
 *              → followAffordance() re-resolves hydra:target from the SIGNED Turtle
 *
 * THE DOCUMENT IS A VIEW. THE DESCRIPTOR IS THE AUTHORITY.
 *
 * ── Honest scope ────────────────────────────────────────────────────────────
 * This unlocks no new capability: anything the document reaches,
 * `discover → dereference → invoke_affordance` already reached. What it buys is
 * legibility — the affordance set lands in an LLM's context window as prose it
 * natively reads, instead of Turtle only a parser can see. MCP clients do NOT
 * follow these controls (MCP is an RPC catalog: resources are opaque bytes with a
 * mimeType). The MODEL reads the frontmatter and CHOOSES to call invoke_affordance.
 * Any claim stronger than that is false.
 *
 * Pure + deterministic + zero-dependency: same input → byte-identical output, no
 * clock read, no YAML library (core is zero-runtime-deps by design; we emit and
 * re-read a closed subset we ourselves produce).
 */
import { KERNEL_JSONLD_CONTEXT } from './hypermedia.js';
import type { Affordance } from './types.js';

/**
 * RFC 7763 already registers `text/markdown` WITH a `variant` parameter, and
 * RFC 7764's variant registry explicitly contemplates variants that "introduce
 * control information into the textual content stream (such as via a metadata
 * block)" — which is exactly this. So we do NOT mint a new top-level media type;
 * we use the parameter the standard already gives us.
 */
export const HYPERMEDIA_MARKDOWN_VARIANT = 'Interego' as const;
export const HYPERMEDIA_MARKDOWN_MEDIA_TYPE = `text/markdown; variant=${HYPERMEDIA_MARKDOWN_VARIANT}` as const;

/**
 * A control as it appears IN A DOCUMENT.
 *
 * Deliberately has no `target`. See the SECURITY INVARIANT above: the document
 * names WHAT may be done (`actionIri`) and WHERE THE AUTHORITY LIVES
 * (`HypermediaMarkdownDoc.descriptorUrl`); the WHERE-TO-POST is re-resolved from
 * the signed descriptor at execution time and never read from prose.
 */
export interface HypermediaControl {
  /** The `iep:action` IRI — what this control does. */
  readonly actionIri: string;
  /** Advisory only; the signed descriptor remains authoritative. */
  readonly method?: string;
  /** `dcat:mediaType` of the response, when declared. */
  readonly mediaType?: string;
  /** Model-facing guidance (sourced from AffordanceGuidance where available). */
  readonly whenToUse?: string;
  /** Preconditions a caller must satisfy (e.g. `proof-of-possession`). */
  readonly requires?: readonly string[];
}

/** The document: identity + data + controls + prose. */
export interface HypermediaMarkdownDoc {
  /** `@id` — the content-addressed graph/holon IRI this document renders. */
  readonly id: string;
  /** `@type` — e.g. `iep:ContextDescriptor`. */
  readonly type: string;
  /** THE AUTHORITY. The signed descriptor every control is re-resolved against. */
  readonly descriptorUrl: string;
  /** `sh:shapesGraph` the payload conforms to, when declared. */
  readonly conformsToShape?: string;
  /** Lattice pointer back to the holon this projects (when projected from PGSL). */
  readonly pgslUri?: string;
  readonly pgslLevel?: number;
  /** The control surface — target-free by construction. */
  readonly controls: readonly HypermediaControl[];
  /** The human half. Markdown prose, rendered verbatim after the frontmatter. */
  readonly body: string;
}

// ── YAML emission (closed subset, zero deps) ────────────────────────────────
//
// NOTE the quoting of `@`-prefixed keys. `@` is a YAML reserved indicator, so a
// BARE `@context:` / `@id:` / `@type:` key is INVALID YAML and will fail every
// conformant parser. They MUST be quoted. (This is a real, verified defect in
// several markdown-linked-data formats in the wild.)
const AT_KEYS = new Set(['@context', '@id', '@type', '@container']);

function yamlKey(k: string): string {
  return AT_KEYS.has(k) || k.startsWith('@') ? `"${k}"` : k;
}

/** Double-quote every scalar: total, deterministic, and colon/`#`-safe. */
function yamlScalar(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Emit a plain object as a YAML block at `indent`. Key order is insertion order (stable). */
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

/**
 * Render a document. Pure + deterministic: same doc → byte-identical string.
 * Emits the kernel JSON-LD context verbatim, then identity, then the authority
 * pointer, then the target-free control list, then the prose body.
 */
export function renderHypermediaMarkdown(doc: HypermediaMarkdownDoc): string {
  const fm: string[] = ['---'];

  // @context — KERNEL_JSONLD_CONTEXT verbatim (zero new vocabulary).
  fm.push('"@context":');
  fm.push(...yamlBlock(KERNEL_JSONLD_CONTEXT as Record<string, unknown>, '  '));

  fm.push(`"@id": ${yamlScalar(doc.id)}`);
  fm.push(`"@type": ${yamlScalar(doc.type)}`);
  // THE AUTHORITY. Every control below is re-resolved against this signed descriptor.
  fm.push(`descriptorUrl: ${yamlScalar(doc.descriptorUrl)}`);
  if (doc.conformsToShape) fm.push(`conformsToShape: ${yamlScalar(doc.conformsToShape)}`);
  if (doc.pgslUri) fm.push(`pgslUri: ${yamlScalar(doc.pgslUri)}`);
  if (doc.pgslLevel !== undefined) fm.push(`pgslLevel: ${doc.pgslLevel}`);

  if (doc.controls.length > 0) {
    fm.push('affordances:');
    for (const c of doc.controls) {
      fm.push(`  - actionIri: ${yamlScalar(c.actionIri)}`);
      if (c.method) fm.push(`    method: ${yamlScalar(c.method)}`);
      if (c.mediaType) fm.push(`    mediaType: ${yamlScalar(c.mediaType)}`);
      if (c.whenToUse) fm.push(`    whenToUse: ${yamlScalar(c.whenToUse)}`);
      if (c.requires && c.requires.length > 0) fm.push(`    requires: [${c.requires.map(yamlScalar).join(', ')}]`);
    }
    // The one comment that earns its place: it states the invariant at the point
    // a reader would otherwise go looking for a URL to POST to.
    fm.push('  # No hydra:target by design — re-resolved from descriptorUrl at execution.');
  }

  fm.push('---');
  return `${fm.join('\n')}\n\n${doc.body.trimEnd()}\n`;
}

// ── Reading back (round-trip) ───────────────────────────────────────────────

function unquote(v: string): string {
  const t = v.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

function parseInlineList(v: string): string[] {
  const t = v.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return [];
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(s => unquote(s.trim())).filter(Boolean);
}

/**
 * Read back a document this module emitted. A strict reader for OUR closed subset
 * — deliberately not a general YAML parser (core takes no runtime deps; a general
 * frontmatter reader belongs in a leaf workspace like @interego/skills, which
 * already owns that machinery for SKILL.md).
 *
 * The `@context` block is skipped, not re-parsed: it is a constant the renderer
 * emits (KERNEL_JSONLD_CONTEXT), never document state.
 */
export function parseHypermediaMarkdown(md: string): HypermediaMarkdownDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) throw new Error('hypermedia-markdown: missing YAML frontmatter block');
  const fm = m[1] ?? '';
  const body = md.slice(m[0].length).replace(/^\r?\n/, '');

  let id = '', type = '', descriptorUrl = '', conformsToShape: string | undefined,
    pgslUri: string | undefined, pgslLevel: number | undefined;
  const controls: HypermediaControl[] = [];
  let cur: { -readonly [K in keyof HypermediaControl]?: HypermediaControl[K] } | null = null;
  let inAffordances = false;
  let inContext = false;

  const flush = () => {
    if (cur?.actionIri) controls.push(cur as HypermediaControl);
    cur = null;
  };

  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*#/.test(line)) continue;

    // Skip the nested @context block (any indented line while we're inside it).
    if (inContext) {
      if (/^\s/.test(line)) continue;
      inContext = false;
    }
    if (/^"@context"\s*:/.test(line)) { inContext = true; continue; }

    if (/^affordances\s*:/.test(line)) { flush(); inAffordances = true; continue; }

    if (inAffordances && /^\s*-\s+actionIri\s*:/.test(line)) {
      flush();
      cur = { actionIri: unquote(line.replace(/^\s*-\s+actionIri\s*:/, '')) };
      continue;
    }
    if (inAffordances && cur && /^\s+\w+\s*:/.test(line)) {
      const km = /^\s+(\w+)\s*:\s*(.*)$/.exec(line);
      if (km) {
        const k = km[1]!, v = km[2] ?? '';
        if (k === 'method') cur.method = unquote(v);
        else if (k === 'mediaType') cur.mediaType = unquote(v);
        else if (k === 'whenToUse') cur.whenToUse = unquote(v);
        else if (k === 'requires') cur.requires = parseInlineList(v);
      }
      continue;
    }

    // Top-level scalars end any affordance run.
    if (!/^\s/.test(line)) { flush(); inAffordances = false; }
    const km = /^("?@?[\w@]+"?)\s*:\s*(.*)$/.exec(line);
    if (!km) continue;
    const key = km[1]!.replace(/"/g, '');
    const val = km[2] ?? '';
    if (key === '@id') id = unquote(val);
    else if (key === '@type') type = unquote(val);
    else if (key === 'descriptorUrl') descriptorUrl = unquote(val);
    else if (key === 'conformsToShape') conformsToShape = unquote(val);
    else if (key === 'pgslUri') pgslUri = unquote(val);
    else if (key === 'pgslLevel') pgslLevel = Number(unquote(val));
  }
  flush();

  if (!id || !descriptorUrl) {
    throw new Error('hypermedia-markdown: frontmatter must carry "@id" and descriptorUrl');
  }
  return {
    id, type, descriptorUrl,
    ...(conformsToShape ? { conformsToShape } : {}),
    ...(pgslUri ? { pgslUri } : {}),
    ...(pgslLevel !== undefined && !Number.isNaN(pgslLevel) ? { pgslLevel } : {}),
    controls, body,
  };
}

/**
 * Project executable {@link Affordance}s (which DO carry `hydra:target`, read from
 * the signed descriptor) down into document-safe {@link HypermediaControl}s.
 *
 * THIS FUNCTION IS THE SECURITY CUT: it drops `target` on the floor. That is the
 * entire point — the document must never be able to name where to POST.
 */
export function controlsFromAffordances(
  affordances: readonly Affordance[],
  guidance?: Readonly<Record<string, { whenToUse?: string; requires?: readonly string[] }>>,
): HypermediaControl[] {
  return affordances.map((a) => {
    const g = guidance?.[a.action];
    return {
      actionIri: a.action,
      ...(a.method ? { method: a.method } : {}),
      ...(a.mediaType ? { mediaType: a.mediaType } : {}),
      ...(g?.whenToUse ? { whenToUse: g.whenToUse } : {}),
      ...(g?.requires && g.requires.length > 0 ? { requires: g.requires } : {}),
      // a.target is deliberately NOT copied. See SECURITY INVARIANT.
    };
  });
}
