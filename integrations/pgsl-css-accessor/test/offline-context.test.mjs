import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { inlineContext, prepareOfflineContext } from './prepare-offline-context.mjs';

const require = createRequire(import.meta.url);
const { RdfParser } = require('componentsjs');
const v6 = 'https://linkedsoftwaredependencies.org/bundles/npm/componentsjs/^6.0.0/components/context.jsonld';
const own = 'https://example.invalid/components/context.jsonld';
const generated = { '@context': [v6, { ex: 'https://example.invalid/', Fixture: 'ex:Fixture' }] };
// The fixture keeps a distinctive definition so substituting the v5 context
// cannot accidentally satisfy the assertions.
const definitions = { '@context': { fixtureType: { '@id': '@type' }, fixtureValue: 'https://example.invalid/value' } };

test('CSS parser resolves retained generated definitions without fetching a remote context', async () => {
  assert.match(require('componentsjs/package.json').version, /^5\./, 'Exercise the isolated CSS v5 parser');
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('Remote context fetch blocked by regression test'); };
  try {
    const parse = async context => {
      const stream = new RdfParser().parse(Readable.from([JSON.stringify({
        '@context': own, '@id': 'https://example.invalid/instance', fixtureType: 'Fixture', fixtureValue: 'retained',
      })]), { path: '/fixture/config.jsonld', contexts: { [own]: context }, remoteContextLookups: true });
      const quads = [];
      for await (const quad of stream) quads.push(quad);
      return quads;
    };
    await assert.rejects(parse(generated), /remote context|Remote context/i);
    assert.ok(attempts > 0, 'The unprepared fixture must expose the original remote fallback');
    attempts = 0;
    const prepared = inlineContext(generated, v6, definitions);
    const quads = await parse(prepared);
    assert.equal(attempts, 0);
    assert.equal(quads.length, 2);
    assert.ok(quads.some(q => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' && q.object.value === 'https://example.invalid/Fixture'));
    assert.ok(quads.some(q => q.predicate.value === 'https://example.invalid/value' && q.object.value === 'retained'));
    assert.equal(generated['@context'][0], v6, 'Input source remains immutable');
  } finally { globalThis.fetch = originalFetch; }
});

test('preparation resolves the generator dependency before it is pruned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'css-offline-context-'));
  try {
    const generator = join(root, 'node_modules/componentsjs-generator');
    const components = join(generator, 'node_modules/componentsjs');
    await mkdir(join(components, 'components'), { recursive: true });
    await mkdir(join(root, 'dist/components'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(generator, 'package.json'), '{"name":"componentsjs-generator"}');
    await writeFile(join(components, 'package.json'), '{"name":"componentsjs","version":"6.4.0"}');
    await writeFile(join(components, 'components/context.json'), JSON.stringify(definitions));
    const target = join(root, 'dist/components/context.jsonld');
    await writeFile(target, JSON.stringify(generated));
    await prepareOfflineContext(root);
    await rm(generator, { recursive: true });
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), inlineContext(generated, v6, definitions));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing or unsupported context shapes fail rather than silently changing semantics', () => {
  assert.throws(() => inlineContext({ '@context': [] }, v6, definitions), /must import/);
  assert.throws(() => inlineContext(generated, v6, { '@context': v6 }), /self-contained/);
});
