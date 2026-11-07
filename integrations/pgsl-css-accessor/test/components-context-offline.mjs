// Exercise the real runtime loader in the pruned, deployment-shaped tree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
assert.throws(() => require.resolve('componentsjs-generator/package.json'), { code: 'MODULE_NOT_FOUND' }, 'Generator must be absent at runtime');
const iri = 'https://linkedsoftwaredependencies.org/bundles/npm/componentsjs/^6.0.0/components/context.jsonld';
const generated = JSON.parse(readFileSync(join(root, 'dist/components/context.jsonld'), 'utf8'));
assert.ok(JSON.stringify(generated).includes(iri), 'Keep the generator-emitted v6 IRI; do not alias it to v5');
const bytes = readFileSync(join(root, 'dist/components/componentsjs-6-context.jsonld'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'e901f402321d504bbd2722e48e8d1fe197558f63865ecd137ab15ef98592e2eb', 'Retained context bytes changed');
const expected = JSON.parse(bytes.toString('utf8'));
const originals = { fetch: globalThis.fetch, request: http.request, get: http.get, tlsRequest: https.request, tlsGet: https.get };
let attempts = 0;
const deny = () => { attempts++; throw new Error('OFFLINE_CONTEXT_NETWORK_FORBIDDEN'); };
globalThis.fetch = async () => deny();
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
try {
  // Import only after the guards: even a fallback loader capturing HTTP helpers
  // cannot access the network while registering the actual generated modules.
  const cssRequire = createRequire(require.resolve('@solid/community-server/package.json'));
  const runtime = JSON.parse(readFileSync(cssRequire.resolve('componentsjs/package.json'), 'utf8'));
  assert.equal(runtime.version, '5.5.1', 'Use the CSS lockfile-pinned runtime, not generator ComponentsJS 6');
  const { ComponentsManager, PrefetchedDocumentLoader } = cssRequire('componentsjs');
  const manager = await ComponentsManager.build({ mainModulePath: root, typeChecking: false, logLevel: 'error',
    configLoader: registry => registry.register(join(root, 'config/pgsl-server.json')) });
  assert.deepEqual(manager.moduleState.contexts[iri], expected, 'Real module-state discovery must retain the exact v6 context');
  const loader = new PrefetchedDocumentLoader({ contexts: manager.moduleState.contexts });
  assert.deepEqual(await loader.load(iri), expected);
  assert.equal(attempts, 0, 'Actual manager/config loading must need no remote context');
  await assert.rejects(loader.load('https://example.invalid/offline-unmapped-context.jsonld'), /OFFLINE_CONTEXT_NETWORK_FORBIDDEN/);
  assert.ok(attempts > 0, 'An unmapped context must reach the denied-network guard');
  process.stdout.write('PASS actual ComponentsJS 5 manager/config loading: exact v6 context, generator absent, no remote fetch; unmapped context refused\n');
} finally {
  globalThis.fetch = originals.fetch; http.request = originals.request; http.get = originals.get;
  https.request = originals.tlsRequest; https.get = originals.tlsGet;
}
