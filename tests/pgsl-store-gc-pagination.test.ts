import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('never skips a longer key extending the last key of a page in either backend', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('./fixtures/pgsl-store-gc/prefix-pagination.mjs', import.meta.url)),
    new URL('../packages/pgsl-store/src/gc.ts', import.meta.url).href,
    new URL('../packages/pgsl-store/src/keyspace.ts', import.meta.url).href,
    new URL('../packages/pgsl-store/src/mem-fdb.ts', import.meta.url).href,
  ], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
