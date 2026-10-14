import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { refreshEvidence } from './refresh-evidence.js';
import type { BuildConfig } from './config.js';

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
