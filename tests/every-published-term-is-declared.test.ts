/**
 * A term our published ontologies USE must be a term our published ontologies DECLARE.
 *
 * ★ THE GAP. `tools/ontology-lint.mjs` enforces exactly this rule and scans only TypeScript,
 * so a term referenced by one published ontology and declared by none was checked by nothing.
 * Found this way and now fixed: `iep:AgentDelegationCredential` (cited by two alignments via
 * skos:closeMatch), six vault-ld profile knobs the engine reads, `ieh:Agent` (cited as a
 * SUPERCLASS by two ontologies), `align:Renamed`, and — surfaced only when an inert sh:sparql
 * shape was rewritten in Core — `iep:agent` and `iep:wasGeneratedBy`, which turned out to be
 * the WRONG predicates entirely.
 *
 * ★ THIS GATE WAS WRITTEN, MEASURED VACUOUS, AND DELETED THREE TIMES BEFORE IT SHIPPED. Each
 * version passed while checking nothing, and each was caught the same way — by deleting a
 * real declaration and watching the check stay green:
 *
 *   1. "declared = the term appears at the start of a line" — in Turtle a predicate on a
 *      continuation line (`  vldp:linkGrammar "wiki" ;`) is indistinguishable from a subject,
 *      so every term declared ITSELF.
 *   2. "checkable namespaces are the .ttl filenames" — vault-ld.ttl binds its own namespace
 *      to the prefix `vldp`, so the entire namespace was skipped.
 *   3. "checkable = the namespace IRI ends in /<filename>#" — also matches the EXTERNAL
 *      vld: namespace (github.com/The-Knowledge-Graph-Guys/vault-ld#), and still misses a2ap:,
 *      which IS ours but is published on a pod rather than in docs/ns.
 *
 * What finally works is asking the documents instead of guessing: an ontology DECLARES which
 * namespace it defines, via `<iri> a owl:Ontology` and vann:preferredNamespaceUri. A namespace
 * no document here claims is not this gate's business, which is exactly right for both the
 * external vocabulary and the pod-published one.
 *
 * ★ AND IT PARSES RATHER THAN PATTERN-MATCHES. Every vacuous version above was a regex.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrig } from '@interego/core';

const NS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'ns');
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const VANN_PREF = 'http://purl.org/vocab/vann/preferredNamespaceUri';

const FILES = readdirSync(NS_DIR).filter(f => f.endsWith('.ttl'));
const DOCS = FILES.map(f => {
  try { return { f, doc: parseTrig(readFileSync(join(NS_DIR, f), 'utf8')) }; }
  catch { return { f, doc: undefined }; }
});

/** Namespaces a document in this directory declares as its OWN. */
function declaredNamespaces(): Set<string> {
  const out = new Set<string>();
  for (const { doc } of DOCS) {
    if (!doc) continue;
    for (const s of doc.subjects) {
      const isOntology = (s.properties.get(RDF_TYPE as never) ?? [])
        .some(t => t.kind === 'iri' && t.iri === OWL_ONTOLOGY);
      if (isOntology && typeof s.subject === 'string') {
        out.add(s.subject.endsWith('#') ? s.subject : `${s.subject}#`);
      }
      for (const t of s.properties.get(VANN_PREF as never) ?? []) {
        if (t.kind === 'literal') out.add(t.value);
        else if (t.kind === 'iri') out.add(t.iri);
      }
    }
  }
  return out;
}

const OWN = declaredNamespaces();

describe('every owned term a published ontology references', () => {
  it('parses every published ontology', () => {
    const unparseable = DOCS.filter(d => !d.doc).map(d => d.f);
    expect(unparseable, 'a published ontology no longer parses').toEqual([]);
  });

  it('discovers namespaces and subjects at all', () => {
    // A scan that matched nothing would report full coverage while checking nothing — which
    // is what all three earlier versions of this gate did.
    expect(FILES.length).toBeGreaterThan(20);
    expect(OWN.size).toBeGreaterThan(20);
  });

  it('is declared by one of them', () => {
    const declared = new Set<string>();
    const referenced = new Map<string, Set<string>>();
    for (const { f, doc } of DOCS) {
      if (!doc) continue;
      for (const s of doc.subjects) {
        if (typeof s.subject === 'string') declared.add(s.subject);
        for (const [pred, terms] of s.properties) {
          (referenced.get(pred as string) ?? referenced.set(pred as string, new Set()).get(pred as string)!).add(f);
          for (const t of terms) {
            if (t.kind !== 'iri') continue;
            (referenced.get(t.iri) ?? referenced.set(t.iri, new Set()).get(t.iri)!).add(f);
          }
        }
      }
    }
    const missing: string[] = [];
    for (const [iri, where] of referenced) {
      if (declared.has(iri)) continue;
      const owned = [...OWN].some(n => iri.startsWith(n) && iri.length > n.length);
      if (!owned) continue;
      missing.push(`${iri}  (referenced in ${[...where].join(', ')})`);
    }
    missing.sort();
    expect(missing, 'terms referenced in published Turtle whose own namespace document '
      + 'declares them nowhere. A term cited by an ontology and defined by none dereferences '
      + 'to a document that does not mention it.\n  ' + missing.join('\n  ')).toEqual([]);
  });
});
