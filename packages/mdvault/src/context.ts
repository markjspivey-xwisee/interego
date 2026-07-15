/**
 * External @context composition + @base governance (threat class D).
 *
 * Vault-LD §4: a note MUST NOT carry its own @context; contexts live in `context.jsonld`
 * files and compose EXTERNALLY as a left-to-right array, the governing context being the
 * nearest one at or above the note's folder. §4.5: an INSTANCE mints under the ROOT @base,
 * a SCHEMA note under the nearest (governing) @base.
 *
 * Everything is in-memory + bundle-relative (no URL/file contexts — SSRF/traversal are
 * refused at the path layer). Context files reuse the hardened mapping parser (js-yaml
 * JSON_SCHEMA + json:false), so duplicate JSON keys THROW (A10/D3) rather than last-wins,
 * prototype keys are refused, and size/depth are bounded. `@base`/`@vocab` must be absolute
 * http(s) with a host (D3 — no `javascript:`/`file:`/`urn:` authority). A term a nearer
 * context redefines is FLAGGED (context shadowing, D1); whether that redefinition reaches
 * an authority predicate is caught later by the rung gate on the expanded IRIs (D7).
 */
import type { Diagnostic } from './errors.js';
import { VaultInputError } from './errors.js';
import { assertHttpsIdentityIri } from './iri.js';
import { parentFolder, ancestorFolders } from './paths.js';
import { parseFrontmatter, DEFAULT_FRONTMATTER_LIMITS, type FrontmatterLimits } from './frontmatter.js';

export interface ParsedContext {
  /** the folder this context.jsonld governs ("" = bundle root). */
  readonly folder: string;
  /** the raw `@context` term map (null-prototype). */
  readonly terms: Readonly<Record<string, unknown>>;
  /** declared `@base`, validated http(s), if present. */
  readonly base?: string;
  /** declared `@vocab`, validated http(s), if present. */
  readonly vocab?: string;
}

/** Parse one `context.jsonld` (`{ "@context": {...} }`) at `folder`. */
export function parseContextDocument(
  text: string,
  folder: string,
  limits: FrontmatterLimits = DEFAULT_FRONTMATTER_LIMITS,
): ParsedContext {
  const doc = parseFrontmatter(text, limits); // JSON is valid YAML; dup keys throw here
  const ctxVal = (doc as Record<string, unknown>)['@context'];
  if (ctxVal === undefined) {
    throw new VaultInputError('context.no-context', `context at "${folder}" has no "@context"`);
  }
  if (ctxVal === null || typeof ctxVal !== 'object' || Array.isArray(ctxVal)) {
    throw new VaultInputError('context.shape', `context at "${folder}": "@context" must be an object`);
  }
  const terms = ctxVal as Record<string, unknown>;
  const parsed: { folder: string; terms: Record<string, unknown>; base?: string; vocab?: string } = { folder, terms };
  if (terms['@base'] !== undefined) parsed.base = assertHttpsIdentityIri(terms['@base'], `context "${folder}" @base`);
  if (terms['@vocab'] !== undefined) parsed.vocab = assertHttpsIdentityIri(terms['@vocab'], `context "${folder}" @vocab`);
  return parsed;
}

export interface ComposedContext {
  /** merged term map, root-first (nearer overrides), for expandHmdTerm's `extra` arg. */
  readonly terms: Readonly<Record<string, unknown>>;
  /** root `@base` — used to mint INSTANCE identities (§4.5). Undefined if no root @base. */
  readonly rootBase?: string;
  /** nearest `@base` at/above the note — used to mint SCHEMA identities (§4.5). */
  readonly governingBase?: string;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Index parsed contexts by governing folder (the folder CONTAINING the context.jsonld).
 * A `context.jsonld` at "Ontologies/Culinary/context.jsonld" governs "Ontologies/Culinary".
 */
export function indexContextsByFolder(contexts: readonly ParsedContext[]): ReadonlyMap<string, ParsedContext> {
  const byFolder = new Map<string, ParsedContext>();
  for (const c of contexts) {
    if (byFolder.has(c.folder)) {
      throw new VaultInputError('context.duplicate-folder', `two context documents govern the same folder "${c.folder}"`);
    }
    byFolder.set(c.folder, c);
  }
  return byFolder;
}

/** The folder a `context.jsonld` at `contextPath` governs (its parent folder). */
export function contextGovernedFolder(contextPath: string): string {
  return parentFolder(contextPath);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a as object), bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Compose the effective context governing `notePath`: merge every context.jsonld from the
 * bundle root down to the note's nearest folder (root-first, so a nearer context overrides
 * and shadows), and resolve the root + governing @base for identity minting.
 */
export function composeContextForNote(
  notePath: string,
  byFolder: ReadonlyMap<string, ParsedContext>,
): ComposedContext {
  const ancestors = ancestorFolders(notePath); // nearest-first, ends with ""
  // Governing contexts, root-first, for left-to-right composition.
  const chainRootFirst = ancestors
    .filter(f => byFolder.has(f))
    .map(f => byFolder.get(f)!)
    .reverse();

  const terms: Record<string, unknown> = Object.create(null);
  const diagnostics: Diagnostic[] = [];
  for (const ctx of chainRootFirst) {
    for (const key of Object.keys(ctx.terms)) {
      const next = (ctx.terms as Record<string, unknown>)[key];
      if (key in terms && !deepEqual(terms[key], next)) {
        diagnostics.push({
          severity: 'flag',
          code: 'context.shadow',
          message: `term "${key}" is redefined by a nearer context (folder "${ctx.folder}")`,
          where: notePath,
        });
      }
      terms[key] = next;
    }
  }

  const rootBase = byFolder.get('')?.base;
  let governingBase = rootBase;
  for (const folder of ancestors) {
    const b = byFolder.get(folder)?.base;
    if (b) { governingBase = b; break; }
  }

  const out: { terms: Record<string, unknown>; rootBase?: string; governingBase?: string; diagnostics: Diagnostic[] } =
    { terms, diagnostics };
  if (rootBase !== undefined) out.rootBase = rootBase;
  if (governingBase !== undefined) out.governingBase = governingBase;
  return out;
}
