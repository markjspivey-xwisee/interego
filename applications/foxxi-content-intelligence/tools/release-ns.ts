/**
 * Release the Foxxi /ns artifacts: archive each one's current version in ns-releases/, where the
 * bridge answers its version IRI from for good (src/ns/releases.ts), and record every archived
 * file's SHA-256 in ns-releases/SHA256SUMS.
 *
 * An archived version is never rewritten. For each artifact (src/ns/published.ts):
 *  - its current version already archived: the archive must hold the same content — the same graph
 *    for a document (RDFC-1.0), the same bytes for a mapping set or a context — or the artifact has
 *    changed without a new version, which is refused;
 *  - its current version not archived yet: it must be above every archived version, and a document
 *    must name the newest of them as its priorVersion (owl:priorVersion) and say whether it keeps
 *    that version's meaning (owl:backwardCompatibleWith or owl:incompatibleWith); then it is archived.
 *  - and its version must still be open: a version whose release tag (`foxxi-ns-<version>`, see
 *    src/ns/catalog.ts) exists has been released, and its documents cite their sources at that tag,
 *    so nothing more is released under it.
 * A file in the archive whose bytes no longer match SHA256SUMS is refused too.
 *
 * usage: npx tsx applications/foxxi-content-intelligence/tools/release-ns.ts [--check]
 *   --check  write nothing; exit 1 if anything would be archived or anything is refused.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { Parser, Writer } from 'n3';
import { publishedArtifacts, type Published } from '../src/ns/published.js';
import { RELEASES_DIR, compareVersions, releaseFile, releasedVersions } from '../src/ns/releases.js';
import { releaseTag } from '../src/ns/catalog.js';

const require = createRequire(import.meta.url);
const { canonize } = require('rdf-canonize') as {
  canonize(input: string, opts: { algorithm: 'RDFC-1.0'; inputFormat: 'application/n-quads'; maxWorkFactor?: number }): Promise<string>;
};

const check = process.argv.includes('--check');
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
/** A Turtle document's graph, as RDFC-1.0 canonical N-Quads: equal strings, equal graphs. */
const canonicalGraph = (turtle: string): Promise<string> => canonize(
  new Writer({ format: 'application/n-quads' }).quadsToString(new Parser({ format: 'text/turtle' }).parse(turtle)),
  { algorithm: 'RDFC-1.0', inputFormat: 'application/n-quads', maxWorkFactor: 2 },
);
const isDocument = (a: Published): boolean => a.kind === 'ontology' || a.kind === 'shapes';
/** Whether a version's release tag exists in this clone (fetch tags first: `git fetch --tags`). */
const tagged = new Map<string, boolean>();
const isTagged = (version: string): boolean => {
  if (!tagged.has(version)) {
    const out = execFileSync('git', ['tag', '--list', releaseTag(version)], { encoding: 'utf8' }).trim();
    tagged.set(version, out.length > 0);
  }
  return tagged.get(version)!;
};

const refused: string[] = [];
const archived: string[] = [];

for (const a of publishedArtifacts()) {
  const versions = releasedVersions(a.iri, a.kind);
  const newest = versions.at(-1);
  const file = releaseFile(a.iri, a.kind, a.version);
  const bytes = a.render();
  if (newest && compareVersions(newest, a.version) > 0) {
    refused.push(`${a.iri} is at ${a.version}, below ${newest}, which was released: a version never goes back`);
    continue;
  }
  if (existsSync(file)) {
    const released = readFileSync(file, 'utf8');
    const same = isDocument(a) ? await canonicalGraph(released) === await canonicalGraph(bytes) : released === bytes;
    if (!same) refused.push(`${a.iri} has changed since ${a.version} was released: give it a new version above ${newest} and release that`);
    continue;
  }
  if (isTagged(a.version)) {
    refused.push(`${a.iri}/${a.version}: version ${a.version} was released (tag ${releaseTag(a.version)}); release this at a version above it`);
    continue;
  }
  if (isDocument(a) && newest && !a.priorCompatibility) {
    refused.push(`${a.iri}/${a.version}: say whether it keeps ${newest}'s meaning (priorCompatibility: owl:backwardCompatibleWith or owl:incompatibleWith)`);
    continue;
  }
  if (isDocument(a) && (a.priorVersion ?? undefined) !== newest) {
    refused.push(newest
      ? `${a.iri}/${a.version} follows ${newest}: name it as the document's priorVersion`
      : `${a.iri}/${a.version} names ${a.priorVersion} as its priorVersion, which was never released`);
    continue;
  }
  archived.push(`${a.iri}/${a.version}`);
  if (!check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

// SHA256SUMS: every archived file, in the format `sha256sum -c` reads. A recorded file whose bytes
// changed is refused; so is one that is missing.
const SUMS = join(RELEASES_DIR, 'SHA256SUMS');
const recorded = new Map<string, string>();
if (existsSync(SUMS)) {
  for (const line of readFileSync(SUMS, 'utf8').split('\n').filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { refused.push(`SHA256SUMS: not a checksum line: ${line}`); continue; }
    recorded.set(m[2]!, m[1]!);
  }
}
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
const releaseFiles = existsSync(RELEASES_DIR)
  ? filesUnder(RELEASES_DIR).map(f => relative(RELEASES_DIR, f).split(sep).join('/')).filter(f => f !== 'SHA256SUMS' && f !== 'README.md').sort()
  : [];
const sums: string[] = [];
for (const f of releaseFiles) {
  const digest = sha256(readFileSync(join(RELEASES_DIR, ...f.split('/'))));
  const before = recorded.get(f);
  if (before && before !== digest) refused.push(`ns-releases/${f} has changed since it was released (SHA256SUMS has ${before})`);
  sums.push(`${digest}  ${f}`);
}
for (const f of recorded.keys()) if (!releaseFiles.includes(f)) refused.push(`ns-releases/${f} is in SHA256SUMS but missing`);
const newSums = `${sums.join('\n')}\n`;
const sumsChanged = !existsSync(SUMS) || readFileSync(SUMS, 'utf8') !== newSums;
if (!check && sumsChanged && refused.length === 0) writeFileSync(SUMS, newSums);

for (const r of archived) console.log(`${check ? 'would archive' : 'archived'} ${r}`);
for (const r of refused) console.error(`refused: ${r}`);
if (refused.length) process.exit(1);
if (check && (archived.length || sumsChanged)) {
  console.error('ns-releases/ is not up to date: run this tool without --check');
  process.exit(1);
}
console.log(`${publishedArtifacts().length} artifacts; ${archived.length} ${check ? 'to archive' : 'archived'}; ${releaseFiles.length + (check ? archived.length : 0)} files in ns-releases/`);
