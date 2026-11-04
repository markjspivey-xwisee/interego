import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

it('guards workbench navigation and escapes the real downloadable handout', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../applications/foxxi-content-intelligence/i2idlx/app/tools/navigation-links-check.mjs', import.meta.url))], { stdio: 'pipe' });
});
