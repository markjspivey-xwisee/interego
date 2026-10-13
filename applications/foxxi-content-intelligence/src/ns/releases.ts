/**
 * ns/releases.ts — every released version of a Foxxi /ns artifact stays resolvable, unchanged.
 *
 * ★ WHAT WAS WRONG. Each document's header says the content at its version IRI never changes, and a
 * test pinned that content, but the bridge answered only the current version. The day a document
 * took a new version, the IRI of the one before would have begun to 404, while every citation of it
 * (dct:bibliographicCitation names the version IRI), every mapping set released with it
 * (subject_source_version) and every document importing it still pointed there.
 *
 * ★ WHAT IT DOES NOW. Each released version is archived in ns-releases/ by tools/release-ns.ts, at
 * the path its version IRI names under /ns/: <…/ns/xapi/shapes/2026.10.0> is the file
 * ns-releases/xapi/shapes/2026.10.0.ttl; a mapping set's version is a .sssom.tsv there, a JSON-LD
 * context's a .jsonld. SHA256SUMS fixes the bytes of every archived file. A version IRI is answered
 * from the archive: a mapping set and a context byte for byte; a document's Turtle byte for byte,
 * and its other forms generated from the graph that Turtle is — the graph is what a version IRI
 * names, and RDF/XML, N-Triples, JSON-LD and the HTML documentation are views of it.
 *
 * ★ VERSIONS ARE LINKED (RFC 5829). Every answer at a version IRI links the current version
 * (latest-version) and the versions either side of it (predecessor-version, successor-version).
 *
 * Node-only (it reads the archive), so it is imported by the bridge, the release tool and the
 * tests, never by a model the dashboard bundles.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTurtle, toNTriples, toRdfXml, toJsonLd, iri, RDFS, OWL, DCT, VANN, type Graph, type Prefixes } from './rdf.js';
import { NS_BASE, alternates, type DocMeta } from './catalog.js';
import { renderOntologyHtml } from './html.js';
import { SSSOM_MEDIA_TYPE } from './sssom.js';
import { ontologyRepresentations, shapesRepresentations, linkTo, type Representation } from './conneg.js';
import type { PublishedKind } from './published.js';

/** Where released versions are archived. */
export const RELEASES_DIR = fileURLToPath(new URL('../../ns-releases/', import.meta.url));

/** A release version: YYYY.MM.PATCH. */
export const RELEASE_VERSION = /^(\d{4})\.(\d{1,2})\.(\d+)$/;

/** Order two release versions. */
export function compareVersions(a: string, b: string): number {
  const x = RELEASE_VERSION.exec(a), y = RELEASE_VERSION.exec(b);
  if (!x || !y) throw new Error(`not a release version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return 0;
}

/** The file extension each kind of artifact is archived with. */
export const RELEASE_EXTENSION: Readonly<Record<PublishedKind, string>> = {
  ontology: 'ttl', shapes: 'ttl', mappings: 'sssom.tsv', context: 'jsonld',
};

/** An artifact's path under /ns/, which is also its directory in the archive. */
export function releasePath(artifactIri: string): string {
  if (!artifactIri.startsWith(NS_BASE)) throw new Error(`${artifactIri} is not published under ${NS_BASE}`);
  return artifactIri.slice(NS_BASE.length);
}

/** The archived file of one version of an artifact. */
export function releaseFile(artifactIri: string, kind: PublishedKind, version: string, dir = RELEASES_DIR): string {
  return join(dir, ...releasePath(artifactIri).split('/'), `${version}.${RELEASE_EXTENSION[kind]}`);
}

/** The released versions of an artifact, oldest first. */
export function releasedVersions(artifactIri: string, kind: PublishedKind, dir = RELEASES_DIR): string[] {
  const at = join(dir, ...releasePath(artifactIri).split('/'));
  if (!existsSync(at)) return [];
  const suffix = `.${RELEASE_EXTENSION[kind]}`;
  return readdirSync(at, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(suffix) && RELEASE_VERSION.test(e.name.slice(0, -suffix.length)))
    .map(e => e.name.slice(0, -suffix.length))
    .sort(compareVersions);
}

/** The archived bytes of one version, or null if that version was never released. */
export function readRelease(artifactIri: string, kind: PublishedKind, version: string, dir = RELEASES_DIR): string | null {
  if (!RELEASE_VERSION.test(version)) return null;
  const f = releaseFile(artifactIri, kind, version, dir);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/**
 * The RFC 5829 links from one version of an artifact: the current version, and the versions either
 * side of this one among those released (and the current one, which may not be archived yet).
 */
export function versionLinks(artifactIri: string, kind: PublishedKind, version: string, current: string, dir = RELEASES_DIR): string[] {
  const all = [...new Set([...releasedVersions(artifactIri, kind, dir), current])].sort(compareVersions);
  const older = all.filter(v => compareVersions(v, version) < 0).at(-1);
  const newer = all.find(v => compareVersions(v, version) > 0);
  return [
    linkTo(`${artifactIri}/${current}`, 'latest-version'),
    ...(older ? [linkTo(`${artifactIri}/${older}`, 'predecessor-version')] : []),
    ...(newer ? [linkTo(`${artifactIri}/${newer}`, 'successor-version')] : []),
  ];
}

/** The prefixes a Turtle document declares, in its order. */
export function declaredPrefixes(turtle: string): Prefixes {
  const out: Record<string, string> = {};
  for (const m of turtle.matchAll(/^@prefix\s+([A-Za-z][\w.-]*)?:\s*<([^>]*)>\s*\.\s*$/gm)) out[m[1] ?? ''] = m[2]!;
  return out;
}

/** A document's self-description, read back from its graph — what an archived page is about. */
function metaFromGraph(g: Graph, docIri: string): DocMeta & { citation?: string } {
  const O = iri(docIri);
  const text = (p: string): string => g.objects(O, p).find(t => t.termType === 'Literal')?.value ?? '';
  const comments = g.objects(O, RDFS + 'comment').filter(t => t.termType === 'Literal').map(t => t.value);
  const notice = comments.find(c => /affiliated with or endorsed by/.test(c));
  const ns = text(VANN + 'preferredNamespaceUri');
  const prefix = text(VANN + 'preferredNamespacePrefix');
  const citation = text(DCT + 'bibliographicCitation');
  return {
    iri: docIri, ...(ns ? { ns } : {}), ...(prefix ? { prefix } : {}),
    title: text(DCT + 'title'), description: text(DCT + 'description'), version: text(OWL + 'versionInfo'),
    created: text(DCT + 'created'), modified: text(DCT + 'modified'), issued: text(DCT + 'issued'),
    // The graph names what a document formalizes by IRI only (dct:source).
    standards: g.objects(O, DCT + 'source').map(s => ({ title: s.value, url: s.value })),
    bodies: [], ...(notice ? { notice } : {}), ...(citation ? { citation } : {}),
  };
}

/** One archived version of an artifact, answered as the bridge answers a version IRI. */
export interface ReleasedVersion {
  /** The forms it is served in, for content negotiation. */
  readonly representations: Representation[];
  /** Link header values: its versions (RFC 5829) and what it describes or is described by. */
  readonly links: string[];
}

const parsed = new Map<string, { graph: Graph; prefixes: Prefixes }>();
/** An archived document's graph (archived files never change, so it is read once). */
function archivedGraph(file: string, turtle: string): { graph: Graph; prefixes: Prefixes } {
  let p = parsed.get(file);
  if (!p) { p = { graph: parseTurtle(turtle), prefixes: declaredPrefixes(turtle) }; parsed.set(file, p); }
  return p;
}

/**
 * One version of an artifact from the archive, with its links, or null if it was never released.
 * `current` is the version the artifact's unversioned IRI answers with now.
 */
export function releasedVersion(artifactIri: string, kind: PublishedKind, version: string, current: string, dir = RELEASES_DIR): ReleasedVersion | null {
  const bytes = readRelease(artifactIri, kind, version, dir);
  if (bytes === null) return null;
  const links = versionLinks(artifactIri, kind, version, current, dir);
  const versionIri = `${artifactIri}/${version}`;
  if (kind === 'mappings') {
    // The ontology this mapping set was generated from, at the same version.
    const doc = artifactIri.replace(/\/mappings$/, '');
    return { representations: [{ type: SSSOM_MEDIA_TYPE, body: () => bytes }], links: [...links, linkTo(`${doc}/${version}`, 'related')] };
  }
  if (kind === 'context') {
    // The vocabulary this context reads data into, at the same version.
    const doc = artifactIri.replace(/\/context$/, '');
    return { representations: [{ type: 'application/ld+json', body: () => bytes }], links: [...links, linkTo(`${doc}/${version}`, 'describedby', 'text/turtle')] };
  }
  const file = releaseFile(artifactIri, kind, version, dir);
  const { graph, prefixes } = archivedGraph(file, bytes);
  const forms = {
    turtle: () => bytes,
    ntriples: () => toNTriples(graph),
    rdfxml: () => toRdfXml(graph, prefixes),
    jsonld: () => toJsonLd(graph, prefixes, { first: [artifactIri] }),
  };
  if (kind === 'shapes') return { representations: shapesRepresentations(forms), links };
  // An ontology's shapes graph at the same version, when that one was written for this one.
  const shapesIri = `${artifactIri}/shapes`;
  const shapesTurtle = readRelease(shapesIri, 'shapes', version, dir);
  const shapes = shapesTurtle !== null ? archivedGraph(releaseFile(shapesIri, 'shapes', version, dir), shapesTurtle).graph : null;
  const constrainsThis = shapes?.objects(iri(shapesIri), OWL + 'imports').some(t => t.value === versionIri) ?? false;
  const html = (): string => {
    const meta = metaFromGraph(graph, artifactIri);
    const latest = `${artifactIri}/${current}`;
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return renderOntologyHtml({
      graph, meta, prefixes,
      ...(constrainsThis && shapes ? { shapes, shapesIri: `${shapesIri}/${version}` } : {}),
      ...(meta.citation ? { cite: meta.citation } : {}),
      banner: version === current
        ? `This is version ${esc(version)}, the current version of this document.`
        : `This is version ${esc(version)} of this document, kept as it was released. The current version is <a href="${esc(latest)}">${esc(current)}</a>.`,
      links: [
        ...alternates(versionIri),
        ...(constrainsThis ? [{ label: 'SHACL shapes', href: `${shapesIri}/${version}`, type: 'text/turtle' }] : []),
        { label: `the current version (${current})`, href: artifactIri },
      ],
    });
  };
  return {
    representations: ontologyRepresentations({ ...forms, html }),
    links: [...links, ...(constrainsThis ? [linkTo(`${shapesIri}/${version}`, 'describedby', 'text/turtle')] : [])],
  };
}
