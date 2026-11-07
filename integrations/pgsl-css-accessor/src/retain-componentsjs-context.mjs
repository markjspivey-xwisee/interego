// Preserve the generator's context before its build-only dependency is pruned.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const generatorPath = require.resolve('componentsjs-generator/package.json');
const generator = JSON.parse(readFileSync(generatorPath, 'utf8'));
assert.equal(generator.version, lock.packages['node_modules/componentsjs-generator'].version);
const providerPath = createRequire(generatorPath).resolve('componentsjs/package.json');
const provider = JSON.parse(readFileSync(providerPath, 'utf8'));
const pinned = lock.packages['node_modules/componentsjs-generator/node_modules/componentsjs'];
assert.equal(pinned.version, '6.4.0', 'The generator context version requires explicit review');
assert.equal(provider.version, pinned.version, 'Resolve the generator context, not runtime ComponentsJS 5');
const bytes = readFileSync(join(dirname(providerPath), 'components/context.jsonld'));
const expected = 'e901f402321d504bbd2722e48e8d1fe197558f63865ecd137ab15ef98592e2eb';
assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, 'Pinned ComponentsJS 6 context bytes differ');
const target = join(root, 'dist/components/componentsjs-6-context.jsonld');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, bytes);
process.stdout.write(`Retained exact ComponentsJS ${provider.version} context: ${expected}\n`);
