/**
 * @module rdf/rdf12
 * @description RDF 1.2-specific helpers per the April 2026 CR.
 *
 * RDF 1.2 adds three concepts over RDF 1.1:
 *
 *   1. Triple terms (RDF-star formalized) — embedded triples as
 *      objects of other triples. We already serialize these via
 *      `toTripleAnnotationTurtle` in serializer.ts using the
 *      standard `{| ... |}` syntax.
 *
 *   2. Directional language-tagged strings — language tags
 *      carrying a base direction marker (ltr / rtl) for
 *      bidirectional-text rendering. Serialized as:
 *          "text"@en--ltr
 *          "نص"@ar--rtl
 *
 *   3. Version announcements — the serialized document MAY
 *      declare the RDF version it uses via a `@version "1.2"`
 *      directive so parsers can branch on feature support.
 *
 * This module provides helpers for #2 and #3; #1 is in
 * serializer.ts.
 */

// ── Directional language-tagged strings (RDF 1.2 §5.2) ─────

export type BaseDirection = 'ltr' | 'rtl';

/**
 * Format a language-tagged literal with an optional base
 * direction per RDF 1.2. Bidirectional text rendering hints are
 * carried in the `--ltr` / `--rtl` suffix after the language tag.
 *
 * Examples:
 *   langString('hello', 'en')          → `"hello"@en`
 *   langString('hello', 'en', 'ltr')   → `"hello"@en--ltr`
 *   langString('سلام',  'ar', 'rtl')   → `"سلام"@ar--rtl`
 */
export function langString(
  lexical: string,
  lang: string,
  direction?: BaseDirection,
): string {
  const escaped = lexical.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tag = direction ? `${lang}--${direction}` : lang;
  return `"${escaped}"@${tag}`;
}

/**
 * Parse a language-tagged literal, returning the lexical form,
 * language, and optional direction.
 */
export function parseLangString(input: string): {
  lexical: string;
  lang: string;
  direction?: BaseDirection;
} | null {
  const m = input.match(/^"((?:[^"\\]|\\.)*)"@([a-zA-Z][a-zA-Z0-9-]*?)(?:--(ltr|rtl))?$/);
  if (!m) return null;
  const lexical = m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const result: { lexical: string; lang: string; direction?: BaseDirection } = {
    lexical,
    lang: m[2]!,
  };
  if (m[3] === 'ltr' || m[3] === 'rtl') result.direction = m[3];
  return result;
}

// ── Version announcement (RDF 1.2 §4) ──────────────────────

/**
 * The canonical RDF 1.2 version directive. Implementations that
 * emit RDF 1.2-specific features SHOULD include this at the top
 * of their Turtle documents so consumers can branch on it.
 */
export const RDF12_VERSION_DIRECTIVE = '@version "1.2" .';

/**
 * Prefix a Turtle document with the RDF 1.2 version directive
 * if the document actually uses RDF 1.2-specific features
 * (triple-term annotations or directional language-tagged
 * strings). Idempotent — does not duplicate if already present.
 */
export function withRdf12VersionDirective(ttl: string): string {
  if (/^@version\s+"1\.2"\s*\./m.test(ttl)) return ttl;
  return `${RDF12_VERSION_DIRECTIVE}\n${ttl}`;
}

/**
 * Detect whether a Turtle document declares RDF 1.2 via the
 * version directive OR uses RDF 1.2-specific syntax (triple
 * annotations, directional language tags). Useful for parsers
 * that need to branch on feature support.
 */
export function detectRdf12Features(ttl: string): {
  hasVersionDirective: boolean;
  hasTripleAnnotations: boolean;
  hasDirectionalLangTags: boolean;
  isRdf12: boolean;
} {
  const hasVersionDirective = /^@version\s+"1\.2"\s*\./m.test(ttl);
  const hasTripleAnnotations = /\{\|[\s\S]*?\|\}/.test(ttl);
  const hasDirectionalLangTags = /"[^"]*"@[a-zA-Z-]+--(?:ltr|rtl)/.test(ttl);
  return {
    hasVersionDirective,
    hasTripleAnnotations,
    hasDirectionalLangTags,
    isRdf12: hasVersionDirective || hasTripleAnnotations || hasDirectionalLangTags,
  };
}
