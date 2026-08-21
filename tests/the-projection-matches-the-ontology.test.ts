/**
 * Every ontology's HTML projection must list every term its Turtle declares.
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
 * ★ THIS PARAGRAPH USED TO SAY THE OPPOSITE, AND IT WAS WRONG — recorded rather than deleted,
 * because the reasoning is the point. It read: "Scope is deliberately the framework ontologies…
 * several unrelated namespaces carry pre-existing drift… widening it would need an allowlist, and
 * an allowlisted gate is the thing this file exists to avoid."
 *
 * The instinct was right and the conclusion was not. Widening needed no allowlist — it needed a
 * STRUCTURAL membership rule (see below). With one, the gate covers everything and stays
 * allowlist-free, and the "pre-existing drift" turned out to be 51 terms across 8 files rather
 * than the 18 first measured: `harness` alone was missing 28.
 *
 * The lesson generalises past this file. "It would need an allowlist" is a claim about the
 * membership rule you happen to have, not about the check. Change the rule and the allowlist
 * disappears.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FRAMEWORK_CONTROLS } from '@interego/compliance';

/**
 * ★★ WIDENED BEYOND THE THREE FRAMEWORKS, AND THE MEMBERSHIP RULE IS STRUCTURAL.
 *
 * This started scoped to the compliance ontologies because they were the ones the API had just
 * started emitting IRIs into. Measured afterwards across all of docs/ns: five MORE projections
 * were out of sync — `code` (7 terms), `hypragent` (4), `olke` (4), `amta` (3), `hyprcat` (3) —
 * 21 declared terms whose hash IRIs resolved to a page that did not mention them.
 *
 * The membership test is "does the page STATE a term count", not a list of names. A full
 * projection says `&middot; N terms.` about itself; `iep.html` is a landing page carrying 4 of 500
 * terms and states no count, so it is excluded BY CONSTRUCTION rather than by an allowlist — which
 * matters, because an allowlist is how the five above stayed invisible after the first pass.
 *
 * The prefix a file declares is not always its filename (`harness.ttl` declares `ieh:`,
 * `alignment.ttl` declares `align:`), so the prefix is read from the document's own `@prefix`
 * line. Guessing it from the filename made every term in those files invisible and reported them
 * as clean.
 */
const NS_DIR = fileURLToPath(new URL('../docs/ns/', import.meta.url));

/** The prefix a ttl binds to its OWN namespace, read from the file rather than guessed. */
function selfPrefix(ttl: string, base: string): string | undefined {
  for (const m of ttl.matchAll(/@prefix\s+([A-Za-z][A-Za-z0-9_-]*):\s*<([^>]+)>/g)) {
    const iri = m[2] ?? '';
    if (iri.endsWith(`/${base}#`) || iri.endsWith(`/${base}`)) return m[1];
  }
  return undefined;
}

/** Every docs/ns page that declares itself a full projection by stating a term count. */
function projections(): { base: string; ttl: string; html: string; prefix: string }[] {
  const out: { base: string; ttl: string; html: string; prefix: string }[] = [];
  for (const f of readdirSync(NS_DIR)) {
    if (!f.endsWith('.html')) continue;
    const base = f.slice(0, -5);
    let html: string;
    let ttl: string;
    try {
      html = readFileSync(`${NS_DIR}${f}`, 'utf8');
      ttl = readFileSync(`${NS_DIR}${base}.ttl`, 'utf8');
    } catch { continue; }
    if (!/&middot;\s*\d+\s*terms?/.test(html)) continue;  // not a full projection
    const prefix = selfPrefix(ttl, base);
    if (!prefix) continue;
    out.push({ base, ttl, html, prefix });
  }
  return out;
}

/** Local names the Turtle declares for its own prefix. */
function declaredTerms(ttl: string, prefix: string): string[] {
  const re = new RegExp(`(?:^|\\n)${prefix}:([A-Za-z][A-Za-z0-9_-]*(?:\\.[0-9]+)*)\\s+a\\s`, 'g');
  return [...new Set([...ttl.matchAll(re)].map(m => m[1] ?? ''))];
}

/** Anchors the HTML projection defines. */
function projectedTerms(html: string): Set<string> {
  return new Set([...html.matchAll(/<div id="([^"]+)" class="term"/g)].map(m => m[1] ?? ''));
}

const FOUND = projections();

describe('the set of projections is discovered, not listed', () => {
  /**
   * ★★ A FLOOR, NOT A LOWER BOUND OF CONVENIENCE — because membership is self-declared.
   *
   * A page joins this gate by STATING its own term count. Measured: deleting that one line from
   * `olke.html` dropped it out of the set, the suite went from 93 tests to 89, and it still
   * reported GREEN. A page could escape the check by removing the thing that makes it checkable,
   * and the removal looks like a formatting tidy-up in review.
   *
   * So the count is pinned. Adding a projection means raising this number, which is the same
   * ratchet `MIN_FILES` uses in tools/lint-gate.mjs and for the same reason: a check that silently
   * covers less than it did yesterday is indistinguishable from one that passed.
   */
  /**
   * ★ AND THE BIGGEST NAMESPACE WAS OUTSIDE IT. `iep` — the L1 protocol vocabulary, 509
   * terms — did not join this gate, because joining is opt-in by convention: a page states
   * "&middot; N terms." and iep.html did not. Measured before it was fixed: iep.ttl declared
   * 509 terms and iep.html projected FOUR. 505 hash IRIs dereferenced to a page that did not
   * mention them, which is this gate's founding defect at 36x the scale that motivated it.
   *
   * The membership rule is still convention rather than structure, and that is the residual
   * weakness — a new namespace can still omit the line and stay invisible here. The floor
   * below is what makes that survivable: a page LEAVING the gate is caught even though a page
   * never joining it is not.
   */
  it('finds the full projections, including every compliance framework', () => {
    expect(FOUND.length, 'discovered no full projections at all').toBeGreaterThan(0);
    expect(
      FOUND.length,
      `${FOUND.length} projections discovered, expected at least 24. A page joins this gate by `
        + `stating "&middot; N terms." — if one stopped stating it, it silently left the gate. `
        + `Raise this floor when adding a projection; never lower it to make a run pass.`,
    ).toBeGreaterThanOrEqual(24);
    for (const fw of Object.keys(FRAMEWORK_CONTROLS)) {
      expect(FOUND.map(p => p.base), `${fw} is no longer discovered as a projection`).toContain(fw);
    }
  });
});

describe.each(FOUND.map(p => [p.base, p] as const))('%s namespace', (framework, proj) => {
  const ttl = proj.ttl;
  const html = proj.html;

  it('declares terms at all — a vacuous pass here would hide every assertion below', () => {
    // Non-vacuous means "parsed something", not "is big": docs/ns/cg.ttl and cgh.ttl are
    // deprecated read-aliases carrying exactly ONE term each, and a threshold of >5 failed them
    // for being small rather than for being wrong.
    expect(declaredTerms(ttl, proj.prefix).length, 'parsed no declared terms').toBeGreaterThan(0);
    expect(projectedTerms(html).size, 'parsed no projected terms').toBeGreaterThan(0);
  });

  it('projects every declared term into the HTML served at the same base', () => {
    const projected = projectedTerms(html);
    const missing = declaredTerms(ttl, proj.prefix).filter(t => !projected.has(t));
    expect(
      missing,
      `docs/ns/${framework}.ttl declares ${missing.length} term(s) that docs/ns/${framework}.html `
        + `does not list, so their hash IRIs dereference to a page with no entry for them: `
        + `${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('projects nothing the ontology does not declare', () => {
    const declared = new Set(declaredTerms(ttl, proj.prefix));
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
