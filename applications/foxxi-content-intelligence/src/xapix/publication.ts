/**
 * What is published for xapi-x on the pod, as the bytes that are published.
 *
 * Two public graphs, each at the IRI it names, dereferenced by the relay's `/ns/<owner>/<slug>`:
 *
 *   …/xapix           the ontology, xapix/xapix.ttl, verbatim
 *   …/xapix-profile   the profile, as the triples the profile server reads from the JSON-LD
 *
 * The profile is authored as an xAPI Profiles JSON-LD document (profile.ts). A pod holds RDF, so
 * the graph is that document's triples, written by the same function the profile server uses to
 * read a profile (`profileTriples`). Its version, its template and its concepts are subjects in
 * it, so `…/xapix-profile/v/1` and `…/xapix-profile/templates/descriptor-projection` resolve to
 * the document they are part of.
 *
 * Publishing is a person's or an agent's act through the relay (`publish_context`, public,
 * signed authorship). Nothing here writes anywhere; a test checks that what this returns parses
 * and says what the JSON-LD says.
 */
import { DataFactory, Writer, type Quad_Object, type Quad_Subject } from 'n3';
import { profileTriples, toRdfTerm, type Json } from '../xapi-profile-server/rdf.js';
import { buildXapixProfileDoc } from './profile.js';
import { XAPIX_NS_ROOT, XAPIX_PROFILE_ID } from './namespace.js';

/** The IRIs the two graphs are published at. A graph's IRI is where it dereferences. */
export const XAPIX_GRAPHS = {
  ontology: `${XAPIX_NS_ROOT}/xapix`,
  profile: XAPIX_PROFILE_ID,
} as const;

const { namedNode, blankNode, literal } = DataFactory;

function node(stored: string): Quad_Object {
  const t = toRdfTerm(stored);
  if (t.type === 'uri') return namedNode(t.value);
  if (t.type === 'bnode') return blankNode(t.value);
  return literal(t.value, t['xml:lang'] ?? (t.datatype ? namedNode(t.datatype) : undefined));
}

/** The xapi-x profile as N-Triples, one triple a line, sorted, so the same profile gives the same bytes. */
export function xapixProfileTurtle(): string {
  const writer = new Writer({ format: 'N-Triples' });
  const lines = profileTriples(buildXapixProfileDoc() as Json, XAPIX_PROFILE_ID)
    .map(t => writer.quadToString(node(t.subject) as Quad_Subject, namedNode(t.predicate), node(t.object)));
  return [...new Set(lines)].sort().join('');
}
