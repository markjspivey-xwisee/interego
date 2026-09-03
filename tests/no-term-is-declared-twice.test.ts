/**
 * One IRI, one declaration — across every ontology this repository publishes.
 *
 * ── ★★ WHY: THREE COLLISIONS, AND THE WORST ONE WAS NOT A DUPLICATE ─────────────────────────
 *
 * A census of 1054 term declarations across `docs/ns/*.ttl` found three IRIs declared more than
 * once. Ranked by what each actually did:
 *
 *  1. `ieh:AgentMemory` was TWO DIFFERENT CLASSES. One read "Memory layer sizes for an agent:
 *     semantic (facts), episodic (events), procedural (skills)"; the other "a typed memory entry
 *     persisted by an agent into a pod", `rdfs:subClassOf prov:Entity`. A consumer asking
 *     `?x a ieh:AgentMemory` was answered with retrieval budgets and notes together. The entry
 *     survives — the relay writes it on every private note — and the budget sense had no RDF
 *     writer anywhere, so it was removed rather than renamed into a second unused term.
 *
 *  2. `iep:podUrl` was declared `owl:ObjectProperty` in one place and `owl:DatatypeProperty` with
 *     `rdfs:range xsd:anyURI` in another. No OWL DL reasoner accepts that, and a reader could not
 *     tell whether to expect a node or a literal — which is not academic, because BOTH forms are
 *     written: the directory emits `iep:podUrl <url>` and a notification frame emits
 *     `"url"^^xsd:anyURI`, the form `iep:NotificationShape` constrains. It is now declared once as
 *     `rdf:Property`, the honest supertype of both, naming each use.
 *
 *  3. `iep:signerAddress` was declared twice, identically, one copy without its comment. Harmless
 *     today and the reason the other two happened: a second copy is where a range drifts.
 *
 * ── WHY A GATE AND NOT THREE FIXES ──────────────────────────────────────────────────────────
 *
 * These files are 1000+ lines of hand-maintained Turtle, appended to by section. Nothing compares
 * a new declaration against the rest of the file, so a term added to the section a feature belongs
 * to cannot be seen to already exist somewhere else. That is a structural property of how the
 * files grow, so the fix that lasts is the check, not the three edits.
 *
 * ── SCOPE, STATED ───────────────────────────────────────────────────────────────────────────
 *
 * Subject-position declarations of the form `prefix:Local a owl:…|rdfs:…|sh:…|rdf:…` at the start
 * of a line, which is how every term in these files is written. It does NOT parse full Turtle: a
 * declaration continued from a previous line, or written with a `;`-separated second `a`, is out
 * of reach. The floor below is what keeps that from silently becoming "no declarations found".
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'ns');

/** `iep:Foo a owl:Class` — a term declaring what kind of thing it is, at the start of a line. */
const DECLARATION = /^([a-z0-9]+:[A-Za-z][A-Za-z0-9_-]*)\s+a\s+((?:owl|rdfs|sh|rdf|skos):[A-Za-z]+)/gm;

/**
 * ★ MEASURED 2026-09-03: 1051 declarations across the published ontologies, after the three
 * collisions above were resolved. A FLOOR, not a target — it exists because every assertion below
 * is satisfied by finding nothing, and a regex that stops matching would report a clean run.
 */
const MIN_DECLARATIONS = 900;

interface Declared { readonly file: string; readonly term: string; readonly kinds: string[]; }

function declarations(): { rows: Declared[]; total: number } {
  const rows: Declared[] = [];
  let total = 0;
  for (const file of readdirSync(NS_DIR).filter((f) => f.endsWith('.ttl'))) {
    const kinds = new Map<string, string[]>();
    for (const m of readFileSync(join(NS_DIR, file), 'utf8').matchAll(DECLARATION)) {
      total += 1;
      const list = kinds.get(m[1] as string) ?? [];
      list.push(m[2] as string);
      kinds.set(m[1] as string, list);
    }
    for (const [term, list] of kinds) rows.push({ file, term, kinds: list });
  }
  return { rows, total };
}

describe('no published term is declared twice', () => {
  const { rows, total } = declarations();

  it('reads the ontologies at all', () => {
    // Guards the guard: with no declarations parsed, every leg below passes while checking
    // nothing — the failure mode that let three collisions sit in published files.
    expect(total, `only ${total} declarations parsed from docs/ns/*.ttl; the pattern has stopped `
      + 'matching how these files are written, so this gate is reading an empty census')
      .toBeGreaterThan(MIN_DECLARATIONS);
    expect(rows.length).toBeGreaterThan(MIN_DECLARATIONS - 100);
  });

  it('★ declares each term exactly once per ontology', () => {
    const repeated = rows
      .filter((r) => r.kinds.length > 1)
      .map((r) => `${r.file}  ${r.term}  declared ${r.kinds.length}x as ${r.kinds.join(', ')}`);
    expect(
      repeated,
      'a term declared twice is where a range, a domain or a comment drifts from its twin — and '
        + 'where two different concepts end up sharing one IRI:\n  ' + repeated.join('\n  '),
    ).toEqual([]);
  });

  it('★ never declares one term as two different KINDS of thing', () => {
    // Stated separately because it is the severe half: a term that is both an ObjectProperty and a
    // DatatypeProperty makes the ontology OWL-DL inconsistent, and leaves a reader unable to tell
    // whether a value is a node or a literal.
    const conflicting = rows
      .filter((r) => new Set(r.kinds).size > 1)
      .map((r) => `${r.file}  ${r.term}  ->  ${[...new Set(r.kinds)].join(' AND ')}`);
    expect(
      conflicting,
      'one IRI cannot be two kinds of thing; no OWL DL reasoner accepts this and no consumer can '
        + 'know what to expect:\n  ' + conflicting.join('\n  '),
    ).toEqual([]);
  });
});
