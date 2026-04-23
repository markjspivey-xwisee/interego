/**
 * RDF 1.2 helper tests.
 * Covers: langString formatting / parsing, version-directive emission,
 * detectRdf12Features feature classification.
 */

import { describe, it, expect } from 'vitest';
import {
  langString,
  parseLangString,
  withRdf12VersionDirective,
  detectRdf12Features,
  RDF12_VERSION_DIRECTIVE,
} from '../src/rdf/rdf12.js';

describe('RDF 1.2 — directional language-tagged strings', () => {
  it('formats plain language tag', () => {
    expect(langString('hello', 'en')).toBe('"hello"@en');
  });

  it('formats with ltr direction', () => {
    expect(langString('hello', 'en', 'ltr')).toBe('"hello"@en--ltr');
  });

  it('formats with rtl direction', () => {
    expect(langString('سلام', 'ar', 'rtl')).toBe('"سلام"@ar--rtl');
  });

  it('escapes embedded quotes + backslashes', () => {
    expect(langString('she said "hi"', 'en', 'ltr')).toBe('"she said \\"hi\\""@en--ltr');
  });

  it('parses plain language tag', () => {
    expect(parseLangString('"hello"@en')).toEqual({
      lexical: 'hello', lang: 'en',
    });
  });

  it('parses directional tag', () => {
    expect(parseLangString('"سلام"@ar--rtl')).toEqual({
      lexical: 'سلام', lang: 'ar', direction: 'rtl',
    });
  });

  it('round-trips', () => {
    const cases: Array<{ lex: string; lang: string; dir?: 'ltr' | 'rtl' }> = [
      { lex: 'plain', lang: 'en' },
      { lex: 'dir', lang: 'en', dir: 'ltr' },
      { lex: 'rtl', lang: 'he', dir: 'rtl' },
    ];
    for (const c of cases) {
      const formatted = langString(c.lex, c.lang, c.dir);
      const parsed = parseLangString(formatted);
      expect(parsed).toEqual({
        lexical: c.lex,
        lang: c.lang,
        ...(c.dir ? { direction: c.dir } : {}),
      });
    }
  });
});

describe('RDF 1.2 — version directive', () => {
  it('prefixes a document with the directive', () => {
    const out = withRdf12VersionDirective('<x> <y> <z> .');
    expect(out).toContain(RDF12_VERSION_DIRECTIVE);
    expect(out).toContain('<x> <y> <z> .');
  });

  it('is idempotent — does not duplicate', () => {
    const once = withRdf12VersionDirective('<x> <y> <z> .');
    const twice = withRdf12VersionDirective(once);
    // Only one @version line.
    expect(twice.split('@version').length).toBe(2); // split yields [before, rest]
  });

  it('detectRdf12Features identifies directive', () => {
    const r = detectRdf12Features('@version "1.2" .\n<x> <y> <z> .');
    expect(r.hasVersionDirective).toBe(true);
    expect(r.isRdf12).toBe(true);
  });

  it('detectRdf12Features identifies triple annotations', () => {
    const r = detectRdf12Features('<x> <y> <z> {| <p> "meta" |} .');
    expect(r.hasTripleAnnotations).toBe(true);
    expect(r.isRdf12).toBe(true);
  });

  it('detectRdf12Features identifies directional lang tags', () => {
    const r = detectRdf12Features('<x> <y> "hello"@en--ltr .');
    expect(r.hasDirectionalLangTags).toBe(true);
    expect(r.isRdf12).toBe(true);
  });

  it('detectRdf12Features returns false for pure RDF 1.1', () => {
    const r = detectRdf12Features('@prefix ex: <http://example.org/> .\nex:a ex:b ex:c .');
    expect(r.isRdf12).toBe(false);
  });
});
