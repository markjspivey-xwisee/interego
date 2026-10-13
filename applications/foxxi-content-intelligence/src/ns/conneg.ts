/**
 * ns/conneg.ts — serving one /ns document in every representation, by HTTP content negotiation.
 *
 * ★ WHAT WAS WRONG. Each route decided its representation with `accept.includes('text/turtle')`:
 * a substring test that ignores q-values (`text/turtle;q=0` got Turtle), cannot tell a browser from
 * a reasoner except by luck, served JSON-LD to a client that asked only for RDF/XML (so OWL API,
 * ROBOT and Protégé — which ask for RDF/XML first — received a format they did not request), never
 * said `Vary: Accept` (so a shared cache could hand Turtle to the next browser), and never answered
 * 406. The shapes routes ignored Accept altogether.
 *
 * ★ WHAT IT DOES NOW, per RFC 9110 §12.5.1 proactive negotiation: the representation is the offer
 * whose most specific matching media range carries the highest q, ties going to the document's own
 * order (so `*\/*` and an absent Accept get the document's default); a request nothing satisfies is
 * answered 406 with the list of what is available. Every response says `Vary: Accept` and lists
 * its alternates in a `Link` header, and CORS exposes those headers so a browser client can read
 * them. HEAD is answered by the same handler (Express strips the body).
 *
 * Structural types only — no Express import — so this module stays usable from any handler.
 */
import { negotiate } from './rdf.js';

/** One representation: its media type and the body, built only if it is the one chosen. */
export interface Representation {
  readonly type: string;
  readonly body: () => string;
}

/** Other spellings clients use in Accept for a representation we offer. The response carries the
 *  spelling the client asked for: a client that accepts only application/json gets the JSON-LD
 *  (it is JSON, with an inline @context) labelled as what it accepts. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  'application/ld+json': ['application/json'],
  'text/turtle': ['application/x-turtle'],
};

export interface NegotiableRequest { readonly headers: { readonly accept?: string | readonly string[] } }
export interface NegotiableResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): NegotiableResponse;
  type(mediaType: string): NegotiableResponse;
  send(body: string): unknown;
}

/** The representations a document is offered in, as an ordered list (first = default). */
export function offersOf(reps: readonly Representation[]): string[] {
  const out = reps.map(r => r.type);
  for (const r of reps) for (const a of ALIASES[r.type] ?? []) if (!out.includes(a)) out.push(a);
  return out;
}

/** Pick the representation for an Accept header, or null (→ 406). */
export function chooseRepresentation(accept: string | readonly string[] | undefined, reps: readonly Representation[]): { rep: Representation; mediaType: string } | null {
  const header = Array.isArray(accept) ? accept.join(', ') : (accept as string | undefined);
  const chosen = negotiate(header, offersOf(reps));
  if (!chosen) return null;
  const rep = reps.find(r => r.type === chosen) ?? reps.find(r => (ALIASES[r.type] ?? []).includes(chosen));
  return rep ? { rep, mediaType: chosen } : null;
}

/**
 * Answer a request for the document at `url` with the representation it negotiates.
 * `links` are extra Link-header values (already formatted, e.g. `<…>; rel="describedby"`).
 */
export function sendNegotiated(
  req: NegotiableRequest, res: NegotiableResponse, url: string, reps: readonly Representation[], links: readonly string[] = [],
): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Link, Vary, Content-Type, Content-Location');
  res.setHeader('Vary', 'Accept');
  res.setHeader('Link', [...reps.map(r => `<${url}>; rel="alternate"; type="${r.type}"`), ...links].join(', '));
  const pick = chooseRepresentation(req.headers.accept, reps);
  if (!pick) {
    res.status(406).type('text/plain').send(`Not Acceptable. ${url} is available as: ${reps.map(r => r.type).join(', ')}.\n`);
    return;
  }
  res.type(pick.mediaType).send(pick.rep.body());
}

/** A semantic version, as the version segment of a version IRI (`…/ns/xapi/1.0.0`). */
export const isVersionSegment = (s: string): boolean => /^\d+\.\d+\.\d+$/.test(s);

/** One Link header value (RFC 8288): a target, its relation, and optionally its media type. */
export const linkTo = (href: string, rel: string, type?: string): string => `<${href}>; rel="${rel}"${type ? `; type="${type}"` : ''}`;

/** The Link value pointing from a document to its current version IRI (RFC 5829). */
export const latestVersionLink = (versionIri: string): string => linkTo(versionIri, 'latest-version');

/** The usual five representations of an ontology document, JSON-LD first. */
export function ontologyRepresentations(r: {
  jsonld: () => unknown; turtle: () => string; rdfxml: () => string; ntriples: () => string; html: () => string;
}): Representation[] {
  return [
    { type: 'application/ld+json', body: () => JSON.stringify(r.jsonld(), null, 2) },
    { type: 'text/turtle', body: r.turtle },
    { type: 'application/rdf+xml', body: r.rdfxml },
    { type: 'application/n-triples', body: r.ntriples },
    { type: 'text/html', body: r.html },
  ];
}

/** The representations of a SHACL shapes graph, Turtle first (what these routes always served). */
export function shapesRepresentations(r: {
  turtle: () => string; jsonld: () => unknown; rdfxml: () => string; ntriples: () => string;
}): Representation[] {
  return [
    { type: 'text/turtle', body: r.turtle },
    { type: 'application/ld+json', body: () => JSON.stringify(r.jsonld(), null, 2) },
    { type: 'application/rdf+xml', body: r.rdfxml },
    { type: 'application/n-triples', body: r.ntriples },
  ];
}
