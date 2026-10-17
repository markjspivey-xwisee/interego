import { it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('collects a live atom payload larger than its heap without retaining bodies', () => {
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--import', 'tsx',
    fileURLToPath(new URL('./fixtures/pgsl-store-gc/large-atoms.mjs', import.meta.url)),
    new URL('../packages/pgsl-store/src/gc.ts', import.meta.url).href,
    new URL('../packages/pgsl-store/src/keyspace.ts', import.meta.url).href,
    new URL('../packages/pgsl-store/src/addressing.ts', import.meta.url).href,
  ], { encoding: 'utf8', timeout: 45_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).liveNodeBytes).toBeGreaterThan(384 * 1024 * 1024);
}, 50_000);
