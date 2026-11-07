import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Preserve the generator's definitions; do not alias a v6 context to v5. */
export function inlineContext(document, contextIri, dependencyContext) {
  assert.ok(Array.isArray(document['@context']), 'Expected a generated context array');
  assert.ok(document['@context'].includes(contextIri), 'Generated context must import its generator runtime context');
  assert.ok(dependencyContext['@context'] && typeof dependencyContext['@context'] === 'object'
    && !Array.isArray(dependencyContext['@context']), 'Expected self-contained Components.js context definitions');
  return { ...document, '@context': document['@context'].map(value =>
    value === contextIri ? dependencyContext['@context'] : value) };
}

// Run only in the isolated CI fixture, after generation and before pruning the
// generator. Its Components.js 6 context otherwise disappears with that package,
// and CSS's Components.js 5 loader falls back to the public context service.
export async function prepareOfflineContext(packageRoot) {
  const require = createRequire(join(packageRoot, 'package.json'));
  const generatorRequire = createRequire(require.resolve('componentsjs-generator/package.json'));
  const componentsRoot = dirname(generatorRequire.resolve('componentsjs/package.json'));
  const metadata = JSON.parse(await readFile(join(componentsRoot, 'package.json'), 'utf8'));
  const major = metadata.version.split('.')[0];
  const contextIri = `https://linkedsoftwaredependencies.org/bundles/npm/componentsjs/^${major}.0.0/components/context.jsonld`;
  const dependencyContext = JSON.parse(await readFile(join(componentsRoot, 'components/context.json'), 'utf8'));
  const target = join(packageRoot, 'dist/components/context.jsonld');
  const document = JSON.parse(await readFile(target, 'utf8'));
  await writeFile(target, `${JSON.stringify(inlineContext(document, contextIri, dependencyContext), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareOfflineContext(join(dirname(fileURLToPath(import.meta.url)), '..'));
}
