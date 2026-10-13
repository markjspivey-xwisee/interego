/**
 * Every released version of a Foxxi /ns artifact stays resolvable at its version IRI, with the
 * content it was released with.
 *
 * ★ WHY. Each document's header says the content at its version IRI never changes, and a test pinned
 * that content — but the bridge answered only the current version, so the day a document took a new
 * version the IRI of the one before would have begun to 404, while citations (which name the version
 * IRI), mapping sets (subject_source_version) and importing documents still pointed there. And the
 * imports named unversioned IRIs, so even a kept version would have changed meaning when what it
 * imports did. Released versions are now archived in ns-releases/ and answered from there
 * (src/ns/releases.ts); this holds the archive, and what the bridge serves from it, to the promise.
 *
 * ★ WHAT IS HELD.
 *  - Every artifact (src/ns/published.ts) is archived at its current version with the same content:
 *    the same graph for a document, the same bytes for a mapping set or a context. A changed artifact
 *    fails here until it takes a new version and is released (tools/release-ns.ts).
 *  - SHA256SUMS lists exactly the archived files and their bytes: a released file never changes.
 *  - Each archived version is what it says it is, versions only go up, and each document names the
 *    release before it (owl:priorVersion).
 *  - A Foxxi document imports another by a version IRI that resolves.
 *  - What a version IRI is answered with: every form of a document is the archived graph, a mapping
 *    set and a context are the archived bytes, and the RFC 5829 links say where the version sits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { turtleQuads, ntriplesQuads, jsonLdQuads, rdfXmlQuads, canonical, OWL } from './support/ns-graph.js';
import { publishedArtifacts, type Published } from '../src/ns/published.js';
import {
  RELEASES_DIR, compareVersions, readRelease, releaseFile, releasePath, releasedVersions, releasedVersion, versionLinks,
} from '../src/ns/releases.js';
import { NS_BASE } from '../src/ns/catalog.js';
import { chooseRepresentation } from '../src/ns/conneg.js';

const ARTIFACTS = publishedArtifacts();
const isDocument = (a: Pick<Published, 'kind'>): boolean => a.kind === 'ontology' || a.kind === 'shapes';
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
/** Every archived file, as a path relative to ns-releases/. */
const ARCHIVED = filesUnder(RELEASES_DIR).map(f => relative(RELEASES_DIR, f).split(sep).join('/'))
  .filter(f => f !== 'SHA256SUMS' && f !== 'README.md').sort();

/** An archived file read back: which artifact and version it is. */
interface ArchivedFile { readonly file: string; readonly iri: string; readonly version: string; readonly kind: Published['kind'] }
const archivedFiles: ArchivedFile[] = ARCHIVED.map(file => {
  const m = /^(.+)\/(\d{4}\.\d{1,2}\.\d+)\.(ttl|sssom\.tsv|jsonld)$/.exec(file);
  if (!m) throw new Error(`ns-releases/${file} is not <path>/<version>.<ttl|sssom.tsv|jsonld>`);
  const [, path, version, ext] = m as unknown as [string, string, string, string];
  const kind: Published['kind'] = ext === 'sssom.tsv' ? 'mappings' : ext === 'jsonld' ? 'context' : path.endsWith('/shapes') ? 'shapes' : 'ontology';
  return { file, iri: NS_BASE + path, version, kind };
});
const currentOf = (iri: string): string => ARTIFACTS.find(a => a.iri === iri)!.version;

// ★ REVISED: ten contexts — xAPI's, the Enterprise Learner Record's, and the eight generated from the
// documents whose JSON instances they read (src/ns/model-context.ts).
it('covers every artifact the bridge publishes: 14 ontologies, 12 shapes graphs, 8 mapping sets, 10 contexts', () => {
  const count = (k: Published['kind']): number => ARTIFACTS.filter(a => a.kind === k).length;
  expect([count('ontology'), count('shapes'), count('mappings'), count('context')]).toEqual([14, 12, 8, 10]);
  expect(new Set(ARTIFACTS.map(a => a.iri)).size).toBe(ARTIFACTS.length);
  // …and nothing is archived that the bridge does not publish.
  for (const f of archivedFiles) expect(ARTIFACTS.some(a => a.iri === f.iri && a.kind === f.kind), f.file).toBe(true);
});

describe('each artifact is archived at its current version, with the same content', () => {
  for (const a of ARTIFACTS) {
    it(`${a.iri.slice(NS_BASE.length)} ${a.version}`, async () => {
      const released = readRelease(a.iri, a.kind, a.version);
      expect(released, `${a.iri}/${a.version} is not archived: run tools/release-ns.ts`).not.toBeNull();
      if (isDocument(a)) {
        expect(await canonical(turtleQuads(a.render())), `${a.iri} changed without a new version: take the next YYYY.MM.PATCH and release it`)
          .toBe(await canonical(turtleQuads(released!)));
      } else {
        expect(a.render(), `${a.iri} changed without a new version: take the next YYYY.MM.PATCH and release it`).toBe(released);
      }
      // Its current version is the newest released, so a version never goes back.
      expect(releasedVersions(a.iri, a.kind).at(-1)).toBe(a.version);
    });
  }
});

describe('the archive', () => {
  it('lists every archived file in SHA256SUMS, with the bytes it was released with', () => {
    const sums = readFileSync(join(RELEASES_DIR, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)
      .map(l => /^([0-9a-f]{64}) {2}(.+)$/.exec(l)!);
    expect(sums.every(Boolean)).toBe(true);
    expect(sums.map(m => m[2]).sort()).toEqual(ARCHIVED);
    for (const [, digest, file] of sums) expect(sha256(readFileSync(join(RELEASES_DIR, ...file!.split('/')))), `ns-releases/${file} changed after it was released`).toBe(digest);
  });

  it('holds each version as what it says it is', () => {
    expect(archivedFiles.length).toBeGreaterThanOrEqual(ARTIFACTS.length);
    for (const f of archivedFiles) {
      const text = readFileSync(join(RELEASES_DIR, ...f.file.split('/')), 'utf8');
      if (f.kind === 'mappings') {
        expect(text, f.file).toContain(`#mapping_set_id: "${f.iri}"`);
        expect(text, f.file).toContain(`#mapping_set_version: "${f.version}"`);
      } else if (f.kind === 'context') {
        expect(typeof (JSON.parse(text) as { '@context': unknown })['@context'], f.file).toBe('object');
      } else {
        const of = (p: string): string[] => turtleQuads(text).filter(q => q.subject.value === f.iri && q.predicate.value === p).map(q => q.object.value);
        expect(of(`${OWL}versionIRI`), f.file).toEqual([`${f.iri}/${f.version}`]);
        expect(of(`${OWL}versionInfo`), f.file).toEqual([f.version]);
      }
    }
  });

  it('names, in each version of a document, the release before it (owl:priorVersion)', () => {
    for (const f of archivedFiles.filter(isDocument)) {
      const before = releasedVersions(f.iri, f.kind).filter(v => compareVersions(v, f.version) < 0).at(-1);
      const prior = turtleQuads(readFileSync(join(RELEASES_DIR, ...f.file.split('/')), 'utf8'))
        .filter(q => q.subject.value === f.iri && q.predicate.value === `${OWL}priorVersion`).map(q => q.object.value);
      expect(prior, f.file).toEqual(before ? [`${f.iri}/${before}`] : []);
    }
  });

  it('imports Foxxi documents by version IRIs that resolve', () => {
    const imports = new Map<string, number>();
    for (const f of archivedFiles.filter(isDocument)) {
      const q = turtleQuads(readFileSync(join(RELEASES_DIR, ...f.file.split('/')), 'utf8'));
      for (const imp of q.filter(x => x.predicate.value === `${OWL}imports`).map(x => x.object.value)) {
        imports.set(f.version, (imports.get(f.version) ?? 0) + 1);
        expect(imp.startsWith(NS_BASE), `${f.file} imports ${imp}`).toBe(true);
        const m = /^(.+)\/(\d{4}\.\d{1,2}\.\d+)$/.exec(imp);
        expect(m, `${f.file} imports ${imp}, which is not a version IRI`).not.toBeNull();
        expect(readRelease(m![1]!, 'ontology', m![2]!), `${f.file} imports ${imp}, which was never released`).not.toBeNull();
      }
    }
    // In each release, every shapes graph imports its ontology, and cmi5, ai-elearning and scorm-sn
    // import another. ★ REVISED: counted by release, now that there are two.
    expect([...imports.values()]).toEqual([...imports.keys()].map(() => 12 + 3));
    expect(imports.size).toBe(new Set(archivedFiles.map(f => f.version)).size);
  });
});

describe('a version IRI is answered from the archive', () => {
  for (const f of archivedFiles) {
    it(`${f.file}`, async () => {
      const current = currentOf(f.iri);
      const answer = releasedVersion(f.iri, f.kind, f.version, current)!;
      expect(answer).not.toBeNull();
      const bytes = readFileSync(releaseFile(f.iri, f.kind, f.version), 'utf8');
      const body = (type: string): string => {
        const r = chooseRepresentation(type, answer.representations);
        expect(r, `${f.file} offers ${type}`).not.toBeNull();
        return r!.rep.body();
      };
      expect(answer.links).toContain(`<${f.iri}/${current}>; rel="latest-version"`);
      if (f.kind === 'mappings') { expect(body('text/tab-separated-values')).toBe(bytes); return; }
      if (f.kind === 'context') { expect(body('application/ld+json')).toBe(bytes); return; }
      // A document: its Turtle byte for byte, and every other form the same graph.
      expect(body('text/turtle')).toBe(bytes);
      const graph = await canonical(turtleQuads(bytes));
      expect(await canonical(ntriplesQuads(body('application/n-triples'))), 'N-Triples').toBe(graph);
      expect(await canonical(await rdfXmlQuads(body('application/rdf+xml'), f.iri)), 'RDF/XML').toBe(graph);
      expect(await canonical(await jsonLdQuads(JSON.parse(body('application/ld+json')))), 'JSON-LD').toBe(graph);
      if (f.kind === 'ontology') {
        const html = body('text/html');
        const title = turtleQuads(bytes).find(q => q.subject.value === f.iri && q.predicate.value === 'http://purl.org/dc/terms/title')!.object.value;
        expect(html).toContain(`<h1>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>`);
        expect(html).toContain(`This is version ${f.version}`);
      } else {
        expect(chooseRepresentation('text/html', answer.representations)).toBeNull();
      }
    });
  }

  it('and a version never released is not answered', () => {
    const a = ARTIFACTS[0]!;
    expect(releasedVersion(a.iri, a.kind, '2001.1.0', a.version)).toBeNull();
    expect(releasedVersion(a.iri, a.kind, '../../../etc/passwd', a.version)).toBeNull();
    expect(() => releasePath('https://example.org/ns/xapi')).toThrow();
  });
});

describe('versions are found, ordered and linked across releases', () => {
  // A copy of the archive with an earlier and a later release of /ns/xapi, to read as the bridge does.
  let dir = '';
  const xapi = `${NS_BASE}xapi`;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'foxxi-ns-releases-'));
    mkdirSync(join(dir, 'xapi'), { recursive: true });
    const current = releaseFile(xapi, 'ontology', currentOf(xapi));
    for (const v of ['2026.9.0', '2026.10.0', '2026.10.2', '2027.1.0']) copyFileSync(current, join(dir, 'xapi', `${v}.ttl`));
    writeFileSync(join(dir, 'xapi', 'notes.ttl'), '# not a release\n');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('orders versions by number, not as text, and ignores what is not a release', () => {
    expect(releasedVersions(xapi, 'ontology', dir)).toEqual(['2026.9.0', '2026.10.0', '2026.10.2', '2027.1.0']);
    expect(compareVersions('2026.9.0', '2026.10.0')).toBeLessThan(0);
    expect(releasedVersions(`${xapi}/shapes`, 'shapes', dir)).toEqual([]);
  });

  it('links a version to the current one and to its neighbours (RFC 5829)', () => {
    expect(versionLinks(xapi, 'ontology', '2026.10.0', '2027.1.0', dir)).toEqual([
      `<${xapi}/2027.1.0>; rel="latest-version"`,
      `<${xapi}/2026.9.0>; rel="predecessor-version"`,
      `<${xapi}/2026.10.2>; rel="successor-version"`,
    ]);
    // The current version, from its unversioned IRI: the release before it, and nothing after.
    expect(versionLinks(xapi, 'ontology', '2027.1.0', '2027.1.0', dir)).toEqual([
      `<${xapi}/2027.1.0>; rel="latest-version"`,
      `<${xapi}/2026.10.2>; rel="predecessor-version"`,
    ]);
    // A current version not archived yet is still the latest, and the successor of the newest release.
    expect(versionLinks(xapi, 'ontology', '2027.1.0', '2027.2.0', dir)).toContain(`<${xapi}/2027.2.0>; rel="successor-version"`);
  });

  it('answers an older version with what was released, and says which version is current', () => {
    const old = releasedVersion(xapi, 'ontology', '2026.9.0', '2027.1.0', dir)!;
    expect(chooseRepresentation('text/turtle', old.representations)!.rep.body()).toBe(readFileSync(join(dir, 'xapi', '2026.9.0.ttl'), 'utf8'));
    const html = chooseRepresentation('text/html', old.representations)!.rep.body();
    expect(html).toContain('kept as it was released');
    expect(html).toContain(`<a href="${xapi}/2027.1.0">2027.1.0</a>`);
  });
});
