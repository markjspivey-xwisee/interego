/**
 * Note -> RDF lift (the heart; §4/§5/§6 + georgio A/C/F).
 *
 * A participating note (frontmatter + @type, §4.4.1) lifts to HmdTriple[]:
 *  - the subject is the minted §4.5 identity;
 *  - each @type value becomes an rdf:type edge (a CURIE/absolute type expands; a [[wiki]]
 *    type resolves to the referenced note — instance-of);
 *  - each other frontmatter key expands to a predicate THROUGH THE VAULT'S ACTIVE CONTEXT
 *    ONLY (not the kernel context, whose `target`/`action` aliases must not leak); an
 *    UNMAPPED term is FLAGGED, never dropped silently (§6/D5);
 *  - a value that is a [[wiki-link]] (or a term coerced @type:@id) is an object edge to the
 *    resolved note IRI (dangling/ambiguous -> diagnostic, no edge); otherwise a datatype
 *    literal (typed by the context's @type or inferred from a number/boolean).
 *
 * The body is NEVER lifted (§5.3). Finally the EXPANDED predicates + rdf:type objects are
 * screened by the rung ceiling: a rung-<=3 note that produced any authority predicate/type
 * (A8/E6/D7) throws VaultConformanceError -> the vault quarantines it (source still
 * recovers), never emitting an executable affordance into the active/signed graph.
 */
import type { HmdTriple } from '@interego/core';
import type { Diagnostic } from './errors.js';
import { VaultConformanceError } from './errors.js';
import { assertSerializableIri, escapeTurtleLiteral } from './iri.js';
import { parseWikiLink, type WikiIndex } from './wiki.js';
import type { ComposedContext } from './context.js';
import type { VaultProfile } from './profile.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const ABSOLUTE_IRI_RE = /^[a-z][a-z0-9+.-]*:/i;

function termIri(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const id = (v as Record<string, unknown>)['@id'];
    if (typeof id === 'string') return id;
  }
  return null;
}

function expandCurie(term: string, ctx: Record<string, unknown>): string | null {
  const i = term.indexOf(':');
  if (i <= 0) return null;
  const base = termIri(ctx[term.slice(0, i)]);
  return base && ABSOLUTE_IRI_RE.test(base) ? base + term.slice(i + 1) : null;
}

/** Expand a term to an absolute IRI THROUGH THE VAULT CONTEXT ONLY, or null if unmapped
 *  (caller flags — §6 flag-not-drop). Keyword aliases (`@id`/`@type`) return null. */
export function expandVaultTerm(term: string, ctx: Record<string, unknown>): string | null {
  const alias = termIri(ctx[term]);
  if (alias !== null) {
    if (alias.startsWith('@')) return null;
    return expandCurie(alias, ctx) ?? (ABSOLUTE_IRI_RE.test(alias) ? alias : null);
  }
  const curie = expandCurie(term, ctx);
  if (curie) return curie;
  return ABSOLUTE_IRI_RE.test(term) && !term.startsWith('@') ? term : null;
}

/** Keyword-alias sets from the composed context: which frontmatter keys mean @id/@type/
 *  @context (via a `"id":"@id"`-style alias), plus the literal keywords themselves. */
export interface KeywordKeys {
  readonly id: ReadonlySet<string>;
  readonly type: ReadonlySet<string>;
  readonly context: ReadonlySet<string>;
}

export function keywordKeys(ctx: Record<string, unknown>): KeywordKeys {
  const id = new Set(['@id']);
  const type = new Set(['@type']);
  const context = new Set(['@context']);
  for (const k of Object.keys(ctx)) {
    const v = ctx[k];
    if (v === '@id') id.add(k);
    else if (v === '@type') type.add(k);
    else if (v === '@context') context.add(k);
  }
  return { id, type, context };
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** The context's typing hint for a term: object-edge (@type:@id) or a datatype IRI. */
function termTyping(key: string, ctx: Record<string, unknown>): { coerceToId: boolean; datatype?: string } {
  const def = ctx[key];
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    const t = (def as Record<string, unknown>)['@type'];
    if (t === '@id') return { coerceToId: true };
    if (typeof t === 'string' && t !== '@id') {
      const dt = expandVaultTerm(t, ctx);
      return dt ? { coerceToId: false, datatype: dt } : { coerceToId: false };
    }
  }
  return { coerceToId: false };
}

function inferLiteral(value: unknown): { lex: string; datatype?: string } | null {
  if (typeof value === 'string') return { lex: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { lex: String(value), datatype: `${XSD}integer` } : { lex: String(value), datatype: `${XSD}decimal` };
  }
  if (typeof value === 'boolean') return { lex: String(value), datatype: `${XSD}boolean` };
  return null; // objects/null are not datatype scalars
}

export interface LiftInputs {
  readonly notePath: string;
  readonly frontmatter: Record<string, unknown>;
  readonly context: ComposedContext;
  readonly subject: string;
  readonly wiki: WikiIndex;
  readonly profile: VaultProfile;
  /** the keyword-key sets (precomputed once per note by the vault). */
  readonly keywords: KeywordKeys;
}

export interface LiftResult {
  readonly triples: readonly HmdTriple[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Lift one participating note. Throws VaultConformanceError if it breaches the rung ceiling
 *  (authority) or carries an inline @context under a forbid-inline profile. */
export function liftNote(inputs: LiftInputs): LiftResult {
  const { notePath, frontmatter, context, subject, wiki, profile, keywords } = inputs;
  const ctx = context.terms as Record<string, unknown>;
  const triples: HmdTriple[] = [];
  const diagnostics: Diagnostic[] = [];

  // Inline @context is forbidden for an external-context profile (Vault-LD §4).
  if (profile.forbidInlineContext) {
    for (const k of keywords.context) {
      if (k in frontmatter) {
        throw new VaultConformanceError('context.inline', `note "${notePath}" carries its own inline @context, which Vault-LD forbids`);
      }
    }
  }

  const pushIri = (p: string, o: string) => {
    triples.push({ s: subject, p: assertSerializableIri(p), o: assertSerializableIri(o), oKind: 'iri' });
  };
  const pushLit = (p: string, lex: string, datatype?: string) => {
    // lex is escaped at serialization; store raw + validated datatype IRI.
    const safeDt = datatype !== undefined ? assertSerializableIri(datatype) : undefined;
    triples.push(safeDt !== undefined
      ? { s: subject, p: assertSerializableIri(p), o: lex, oKind: 'literal', datatype: safeDt }
      : { s: subject, p: assertSerializableIri(p), o: lex, oKind: 'literal' });
    void escapeTurtleLiteral; // literals are escaped by the serializer; escaper lives in iri.ts
  };

  // rdf:type edges.
  for (const key of keywords.type) {
    if (!(key in frontmatter)) continue;
    for (const raw of asArray(frontmatter[key])) {
      const wl = parseWikiLink(raw);
      if (wl) {
        const r = wiki.resolve(wl, notePath);
        if (r.subject) triples.push({ s: subject, p: RDF_TYPE, o: assertSerializableIri(r.subject), oKind: 'iri' });
        else if (r.diagnostic) diagnostics.push(r.diagnostic);
      } else if (typeof raw === 'string') {
        const t = expandVaultTerm(raw, ctx);
        if (t) triples.push({ s: subject, p: RDF_TYPE, o: assertSerializableIri(t), oKind: 'iri' });
        else diagnostics.push({ severity: 'flag', code: 'unmapped-type', message: `@type "${raw}" does not resolve under the active context`, where: notePath });
      }
    }
  }

  // Every other property.
  for (const key of Object.keys(frontmatter)) {
    if (keywords.id.has(key) || keywords.type.has(key) || keywords.context.has(key)) continue;
    const predicate = expandVaultTerm(key, ctx);
    if (!predicate) {
      diagnostics.push({ severity: 'flag', code: 'unmapped-term', message: `term "${key}" does not resolve under the active context (retained in source, not lifted)`, where: notePath });
      continue;
    }
    const typing = termTyping(key, ctx);
    for (const raw of asArray(frontmatter[key])) {
      const wl = parseWikiLink(raw);
      if (wl) {
        const r = wiki.resolve(wl, notePath);
        if (r.subject) pushIri(predicate, r.subject);
        else if (r.diagnostic) diagnostics.push(r.diagnostic);
      } else if (typing.coerceToId && typeof raw === 'string') {
        // @type:@id term: the value is an IRI reference. EXPAND it through the vault context
        // (a CURIE like `hydra:Operation` must become its full IRI, not stay compact — else
        // the authority closure would miss it). Reuse the same resolver as predicates/types.
        const iri = expandVaultTerm(raw, ctx);
        if (iri) pushIri(predicate, iri);
        else diagnostics.push({ severity: 'flag', code: 'unmapped-object-value', message: `@id value "${raw}" for "${key}" does not resolve under the active context`, where: notePath });
      } else {
        const lit = inferLiteral(raw);
        if (lit) pushLit(predicate, lit.lex, typing.datatype ?? lit.datatype);
        else diagnostics.push({ severity: 'flag', code: 'unliftable-value', message: `value for "${key}" is not a scalar or wiki-link`, where: notePath });
      }
    }
  }

  // Placement provenance (vld:path) — never identity or authority (F3).
  if (profile.placementPredicate) {
    triples.push({ s: subject, p: profile.placementPredicate, o: notePath, oKind: 'literal' });
  }

  // NOTE: the rung-ceiling authority screen is now a GRAPH-LEVEL pass in vault.ts. It must
  // see subClassOf / equivalentClass / subPropertyOf / equivalentProperty / sameAs axioms
  // ACROSS notes to catch entailment-based authority smuggling (a class that reaches an
  // authority class by inference), which a per-note check structurally cannot.
  return { triples, diagnostics };
}
