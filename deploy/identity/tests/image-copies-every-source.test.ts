/**
 * Every module server.ts imports is in the identity image.
 *
 * deploy/Dockerfile.identity copies the server's sources one file at a time and compiles
 * them with tsc. A new module that server.ts imports passes tsc, these tests and CI from the
 * repository, and is simply absent from the image: surface-agent-restore.ts merged that way,
 * and the image build failed on master with
 *
 *   server.ts(62,8): error TS2307: Cannot find module './surface-agent-restore.js'
 *
 * which stopped the auto-deploy of every service. This walks the relative imports from
 * server.ts, as deploy/mcp-relay/tests/image-copies-every-source.test.ts does for the relay,
 * and asserts each module reached is copied.
 *
 * Run:
 *   node --test --import tsx tests/image-copies-every-source.test.ts
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const identityDir = fileURLToPath(new URL('..', import.meta.url));
const dockerfile = readFileSync(join(identityDir, '..', 'Dockerfile.identity'), 'utf8');

/** The local modules reachable from server.ts by relative imports (bare ones come from node_modules). */
function reachableFromServer(): Set<string> {
  const reachable = new Set<string>();
  const walk = (file: string): void => {
    if (reachable.has(file)) return;
    reachable.add(file);
    const src = readFileSync(join(identityDir, file), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.\/[^'"]+)['"]/g)) {
      // TypeScript ESM imports name the emitted .js; the source is .ts.
      const candidate = m[1]!.replace(/^\.\//, '').replace(/\.js$/, '.ts');
      if (existsSync(join(identityDir, candidate))) walk(candidate);
    }
  };
  walk('server.ts');
  return reachable;
}

test('Dockerfile.identity copies every module server.ts reaches', () => {
  const reachable = reachableFromServer();
  assert.ok(reachable.has('surface-agent-restore.ts'), [...reachable].join(', '));
  const missing = [...reachable].filter(f => !dockerfile.includes(`COPY deploy/identity/${f} ./`));
  assert.deepEqual(missing, [], `missing from deploy/Dockerfile.identity: ${missing.join(', ')}`);
});
