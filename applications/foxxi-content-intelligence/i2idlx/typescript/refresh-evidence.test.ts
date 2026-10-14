import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshEvidence } from './refresh-evidence.js';
import type { BuildConfig } from './config.js';
import { parseTurtle } from './rdf.js';
import { publicationReceiptMetadata } from './publication-record.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
async function fixture(): Promise<{ root: string; cfg: BuildConfig; clean: () => Promise<void> }> {
  const prefix = join(tmpdir(), 'i2idlx-refresh-test-'), root = await mkdtemp(prefix);
  const cfg: BuildConfig = {
    relayNsRoot: 'https://relay.interego.xwisee.com/ns', owner: 'test-owner',
    slugs: { ontology: 'i2idlx', mappings: 'i2idlx-mappings' },
    i2idl: { release: 'v0.0.86', repo: 'https://github.com/blakeplock/i2idl-linked-data', localClone: '.', graphPath: 'public/glossary.jsonld' },
    foxxiManifest: 'https://foxxi-bridge.interego.xwisee.com/affordances',
    foxxiNs: { version: 'test-version', base: 'https://foxxi-bridge.interego.xwisee.com/ns', archive: 'archive', modules: ['one', 'two'], sha256: {} },
    reasoner: { name: 'test reasoner', url: 'https://github.com/ontodev/robot/releases/download/test/robot.jar', sha256: hash('pinned reasoner'), jar: '.cache/robot.jar' },
    version: 'test', interegoCoreSrc: '.', tsx: '.', appArtifactUrl: '',
  };
  await writeFile(join(root, 'config.json'), JSON.stringify(cfg));
  const clean = async (): Promise<void> => {
    assert.ok(resolve(root).startsWith(resolve(prefix)), 'temporary cleanup remains inside the fixture prefix');
    await rm(root, { recursive: true, force: true });
  };
  return { root, cfg, clean };
}
function mockFetch(body: (url: string) => string): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = new Response(body(url), { status: 200 });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  return () => { globalThis.fetch = previous; };
}
const moduleTurtle = '@prefix ex: <https://example.org/> . ex:module ex:version "test-version" .\n';

test('reasoner SHA mismatch keeps the installed jar byte-for-byte', async t => {
  const f = await fixture(); t.after(f.clean);
  const destination = join(f.root, '.cache', 'robot.jar'); await mkdir(join(f.root, '.cache')); await writeFile(destination, 'installed original');
  const restore = mockFetch(() => 'untrusted changed jar'); t.after(restore);
  await assert.rejects(refreshEvidence(f.root, { mode: 'reasoner', reasonerFile: destination }), /not the one pinned/u);
  assert.equal(await readFile(destination, 'utf8'), 'installed original');
  assert.deepEqual(await readdir(join(f.root, '.cache')), ['robot.jar']);
});
test('pinned reasoner installation preserves exactly the verified bytes', async t => {
  const f = await fixture(); t.after(f.clean);
  const restore = mockFetch(() => 'pinned reasoner'); t.after(restore);
  const destination = join(f.root, '.cache', 'robot.jar'), result = await refreshEvidence(f.root, { mode: 'reasoner', reasonerFile: destination });
  assert.equal(await readFile(destination, 'utf8'), 'pinned reasoner');
  assert.equal(result.retrievals[0]!.sha256, f.cfg.reasoner.sha256);
  assert.deepEqual(result.files, [destination]);
});
test('an existing nonempty Foxxi archive is refused before any request', async t => {
  const f = await fixture(); t.after(f.clean); const destination = join(f.root, 'archive');
  await mkdir(destination); await writeFile(join(destination, 'retained.ttl'), 'immutable release'); let requests = 0;
  const restore = mockFetch(() => { requests++; return moduleTurtle; }); t.after(restore);
  await assert.rejects(refreshEvidence(f.root, { mode: 'foxxi', foxxiDir: destination }), /not empty/u);
  assert.equal(requests, 0); assert.equal(await readFile(join(destination, 'retained.ttl'), 'utf8'), 'immutable release');
});
test('one invalid module pin leaves the empty target archive untouched', async t => {
  const f = await fixture(); t.after(f.clean); const destination = join(f.root, 'archive');
  await mkdir(destination); f.cfg.foxxiNs.sha256 = { one: hash(moduleTurtle), two: hash('the pinned second module') };
  await writeFile(join(f.root, 'config.json'), JSON.stringify(f.cfg));
  const restore = mockFetch(() => moduleTurtle); t.after(restore);
  await assert.rejects(refreshEvidence(f.root, { mode: 'foxxi', foxxiDir: destination }), /not the release pinned/u);
  assert.deepEqual(await readdir(destination), []);
  assert.ok((await readdir(f.root)).every(name => !name.startsWith('.i2idlx-foxxi-')));
});
test('valid Foxxi pins install immutable release files and the config-derived checksum manifest', async t => {
  const f = await fixture(); t.after(f.clean); const destination = join(f.root, 'archive');
  f.cfg.foxxiNs.sha256 = { one: hash(moduleTurtle), two: hash(moduleTurtle) }; await writeFile(join(f.root, 'config.json'), JSON.stringify(f.cfg));
  const restore = mockFetch(() => moduleTurtle); t.after(restore);
  const result = await refreshEvidence(f.root, { mode: 'foxxi', foxxiDir: destination });
  assert.equal(await readFile(join(destination, 'one', 'test-version.ttl'), 'utf8'), moduleTurtle);
  assert.equal(await readFile(join(destination, 'two', 'test-version.ttl'), 'utf8'), moduleTurtle);
  assert.equal(await readFile(join(destination, 'SHA256SUMS'), 'utf8'), hash(moduleTurtle) + '  one/test-version.ttl\n' + hash(moduleTurtle) + '  two/test-version.ttl\n');
  assert.equal(result.retrievals.length, 2); assert.equal(result.files.length, 3);
});
test('a bad RDF download prevents every evidence snapshot replacement in the batch', async t => {
  const f = await fixture(); t.after(f.clean); const evidence = join(f.root, 'evidence'); await mkdir(evidence);
  await writeFile(join(evidence, 'foxxi-manifest.ttl'), 'retained manifest'); await writeFile(join(evidence, 'relay-operations.json'), '{"retained":true}');
  const manifest = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> . @prefix hydra: <http://www.w3.org/ns/hydra/core#> .\n' +
    '<https://example.org/affordance> a iep:Affordance ; iep:action <https://example.org/action> ; hydra:target <https://example.org/target> ; hydra:method "GET" .\n';
  const restore = mockFetch(url => url === f.cfg.foxxiManifest ? manifest : url.endsWith('/.well-known/operations') ? '{"hydra:member":[{"action":"https://example.org/action"}]}' : 'this is not Turtle');
  t.after(restore);
  await assert.rejects(refreshEvidence(f.root, { mode: 'base' }));
  assert.equal(await readFile(join(evidence, 'foxxi-manifest.ttl'), 'utf8'), 'retained manifest');
  assert.equal(await readFile(join(evidence, 'relay-operations.json'), 'utf8'), '{"retained":true}');
  assert.deepEqual((await readdir(evidence)).sort(), ['foxxi-manifest.ttl', 'relay-operations.json']);
});

const receiptUrl='https://example.org/context-graphs/receipt.ttl';
const receiptGraph=(body:string)=>parseTurtle(
  '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> . '+
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> . '+body,receiptUrl);
test('publication receipts read modal and temporal facets plus the linked authorship proof', () => {
  const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; '+
    'iep:hasFacet [a iep:SemioticFacet;iep:modalStatus iep:Asserted], '+
    '[a iep:TemporalFacet;iep:validFrom "2026-10-13T20:30:00Z"^^xsd:dateTime]; '+
    'iep:authorshipProof [a iep:SignedAuthorship;iep:contentHash "sha256:pinned";iep:signerAddress "0x123"]; '+
    'iep:supersedes <https://example.org/context-graphs/prior.ttl> .');
  assert.deepEqual(publicationReceiptMetadata(graph,'i2idlx',receiptUrl),{
    graph:'i2idlx',graphIri:'https://example.org/ns/i2idlx',descriptor:receiptUrl,
    modalStatus:'Asserted',validFrom:'2026-10-13T20:30:00+00:00',
    contentHash:'sha256:pinned',signer:'0x123',supersedes:['https://example.org/context-graphs/prior.ttl'],
  });
});
test('publication receipts continue to accept metadata directly on the descriptor', () => {
  const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; '+
    'iep:modalStatus iep:Hypothetical;iep:contentHash "sha256:flat";iep:signerAddress "0x456" .');
  const row=publicationReceiptMetadata(graph,'i2idlx',receiptUrl);
  assert.equal(row.modalStatus,'Hypothetical');
  assert.equal(row.contentHash,'sha256:flat');
  assert.equal(row.signer,'0x456');
});
test('unrelated RDF nodes cannot supply missing descriptor receipt metadata', () => {
  const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx> . '+
    '<https://example.org/unrelated> iep:modalStatus iep:Asserted; '+
    'iep:validFrom "2026-10-13";iep:contentHash "unrelated";iep:signerAddress "0xbad" .');
  const row=publicationReceiptMetadata(graph,'i2idlx',receiptUrl);
  assert.equal(row.modalStatus,null);
  assert.equal(row.validFrom,null);
  assert.equal(row.contentHash,null);
  assert.equal(row.signer,null);
});
test('conflicting values across linked authorship proofs are refused', () => {
  const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; '+
    'iep:authorshipProof [iep:contentHash "first"],[iep:contentHash "different"] .');
  assert.throws(()=>publicationReceiptMetadata(graph,'i2idlx',receiptUrl),/multiple values.*contentHash/);
});

test('legacy document-linked proofs bind to the distinct URN descriptor subject', () => {
  const graph=receiptGraph('<urn:iep:test:123> iep:describes <https://example.org/ns/i2idlx>; '+
    'iep:hasFacet [a iep:SemioticFacet;iep:modalStatus iep:Asserted] . '+
    '<> iep:authorshipProof [a iep:SignedAuthorship;iep:descriptorId <urn:iep:test:123>; '+
    'iep:contentHash "sha256:legacy";iep:signerAddress "0x789"] .');
  const row=publicationReceiptMetadata(graph,'i2idlx',receiptUrl);
  assert.equal(row.graphIri,'https://example.org/ns/i2idlx');
  assert.equal(row.modalStatus,'Asserted');
  assert.equal(row.contentHash,'sha256:legacy');
  assert.equal(row.signer,'0x789');
});
test('a document-linked proof for another descriptor cannot supply receipt metadata', () => {
  const graph=receiptGraph('<urn:iep:test:123> iep:describes <https://example.org/ns/i2idlx> . '+
    '<> iep:authorshipProof [iep:descriptorId <urn:iep:other:456>; '+
    'iep:contentHash "wrong-descriptor";iep:signerAddress "0xbad"] .');
  const row=publicationReceiptMetadata(graph,'i2idlx',receiptUrl);
  assert.equal(row.contentHash,null);
  assert.equal(row.signer,null);
});

test('publication receipt datetime values match the independent RDFLib microsecond and offset spelling', () => {
  // Expected values follow pinned RDFLib 7.1.4 / Python 3.12 datetime.isoformat,
  // including the actual signed receipt that failed complete golden parity.
  const cases=[
    ['2026-10-13T21:48:39.179Z','2026-10-13T21:48:39.179000+00:00'],
    ['2026-10-13T21:48:39.1+00:00','2026-10-13T21:48:39.100000+00:00'],
    ['2026-10-13T21:48:39.1234569+05:30','2026-10-13T21:48:39.123456+05:30'],
    ['2026-10-13T21:48:39.000000Z','2026-10-13T21:48:39+00:00'],
    ['2026-10-13T21:48:39-00:00','2026-10-13T21:48:39+00:00'],
    ['2026-10-13T21:48:39-07:00','2026-10-13T21:48:39-07:00'],
    ['2024-02-29T21:48:39.12','2024-02-29T21:48:39.120000'],
    ['2026-10-13T21:48:39.0000001Z','2026-10-13T21:48:39+00:00'],
  ] as const;
  for(const [lexical,expected]of cases){
    const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; '+
      'iep:hasFacet [a iep:TemporalFacet;iep:validFrom '+JSON.stringify(lexical)+'^^xsd:dateTime] .');
    const row=publicationReceiptMetadata(graph,'i2idlx',receiptUrl);
    assert.equal(row.validFrom,expected,lexical);
    assert.equal(graph.getQuads(null,'https://markjspivey-xwisee.github.io/interego/ns/iep#validFrom',null,null)[0]!.object.value,lexical,'signed RDF lexical form remains unchanged');
  }
});
test('publication receipt datetime formatting retains invalid and untyped lexical values', () => {
  for(const lexical of ['2025-02-29T12:00:00Z','2026-04-31T12:00:00Z','0000-01-01T12:00:00Z','2026-10-13T24:00:00Z','2026-10-13T12:00:60Z','2026-10-13T12:00:00+24:00','2026-10-13T12:00:00+00:60','unparseable']){
    const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; iep:validFrom '+JSON.stringify(lexical)+'^^xsd:dateTime .');
    assert.equal(publicationReceiptMetadata(graph,'i2idlx',receiptUrl).validFrom,lexical);
  }
  const lexical='2026-10-13T21:48:39.179Z';
  for(const suffix of ['', '@en', '^^xsd:string']){
    const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; iep:validFrom '+JSON.stringify(lexical)+suffix+' .');
    assert.equal(publicationReceiptMetadata(graph,'i2idlx',receiptUrl).validFrom,lexical);
  }
});
test('equivalent datetime spellings cannot hide conflicting receipt values', () => {
  const graph=receiptGraph('<> iep:describes <https://example.org/ns/i2idlx>; '+
    'iep:validFrom "2026-10-13T21:48:39.179Z"^^xsd:dateTime; '+
    'iep:hasFacet [iep:validFrom "2026-10-13T21:48:39.179000+00:00"^^xsd:dateTime] .');
  assert.throws(()=>publicationReceiptMetadata(graph,'i2idlx',receiptUrl),/multiple values.*validFrom/);
});
