/**
 * Each framework ontology's HTML projection must list every term the Turtle declares.
 *
 * ★★ WHY THIS BECAME LOAD-BEARING. `docs/ns/<framework>.html` is the browser-facing twin of
 * `docs/ns/<framework>.ttl` — it carries `<link rel="alternate" type="text/turtle">` and its own
 * prose says "each term below is identified by a hash IRI under this base". Content negotiation
 * serves it to a human who follows one of those IRIs.
 *
 * The compliance API now emits exactly those IRIs. Every report carries `scopeIri`
 * (`…/soc2#AuditScope`) and every entry's `controlIri` is the absolute, dereferenceable form
 * rather than a CURIE. So an auditor handed a report can click straight through to the page — and
 * measured at the time this was written, the change that started emitting them had added
 * `AuditScope`, `Article10` and ten NIST short codes to the Turtle and none of them to the HTML.
 * Fourteen IRIs advertised by a live API resolved to a page that did not mention them.
 *
 * The three projections were in EXACT sync before that change, which is the point: this is a
 * property that held by care alone until something made it easy to break silently. The frameworks
 * are read from the compliance package, so publishing a fourth fails here until its page exists.
 *
 * Scope is deliberately the framework ontologies, not all of `docs/ns`. Others are genuinely
 * different artifacts — `iep.html` is a landing page carrying 4 of 500 terms, not a projection —
 * and several unrelated namespaces (`code`, `hypragent`, `olke`, `hyprcat`) carry pre-existing
 * drift that is real debt but is not what this guard is about. Widening it would need an
 * allowlist, and an allowlisted gate is the thing this file exists to avoid.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_CONTROLS } from '@interego/compliance';

const nsFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../docs/ns/${name}`, import.meta.url)), 'utf8');

/** Local names the Turtle declares for its own prefix. */
function declaredTerms(ttl: string, prefix: string): string[] {
  const re = new RegExp(`(?:^|\\n)${prefix}:([A-Za-z][A-Za-z0-9_-]*(?:\\.[0-9]+)*)\\s+a\\s`, 'g');
  return [...new Set([...ttl.matchAll(re)].map(m => m[1] ?? ''))];
}

/** Anchors the HTML projection defines. */
function projectedTerms(html: string): Set<string> {
  return new Set([...html.matchAll(/<div id="([^"]+)" class="term"/g)].map(m => m[1] ?? ''));
}

describe.each(Object.keys(FRAMEWORK_CONTROLS))('%s namespace', (framework) => {
  const ttl = nsFile(`${framework}.ttl`);
  const html = nsFile(`${framework}.html`);

  it('declares terms at all — a vacuous pass here would hide every assertion below', () => {
    expect(declaredTerms(ttl, framework).length).toBeGreaterThan(5);
    expect(projectedTerms(html).size).toBeGreaterThan(5);
  });

  it('projects every declared term into the HTML served at the same base', () => {
    const projected = projectedTerms(html);
    const missing = declaredTerms(ttl, framework).filter(t => !projected.has(t));
    expect(
      missing,
      `docs/ns/${framework}.ttl declares ${missing.length} term(s) that docs/ns/${framework}.html `
        + `does not list, so their hash IRIs dereference to a page with no entry for them: `
        + `${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('projects nothing the ontology does not declare', () => {
    const declared = new Set(declaredTerms(ttl, framework));
    const extra = [...projectedTerms(html)].filter(t => !declared.has(t));
    expect(extra, `docs/ns/${framework}.html lists terms absent from the Turtle: ${extra.join(', ')}`)
      .toEqual([]);
  });

  /**
   * The count is prose the page states about itself. It sat at 60 while the page carried 62
   * entries — a small lie, but the same kind: a claim nothing checked.
   */
  it('states a term count that matches the number of terms on the page', () => {
    const stated = /&middot;\s*(\d+)\s*terms?/.exec(html)?.[1];
    expect(stated, `docs/ns/${framework}.html states no term count`).toBeDefined();
    expect(Number(stated)).toBe(projectedTerms(html).size);
  });
});
