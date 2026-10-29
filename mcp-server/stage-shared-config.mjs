import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copy compiled output from the one shared source, never a hand-maintained fork.
// The public MCP package must run without installing a private workspace package.
const sharedDist = fileURLToPath(new URL('../packages/deployment-config/dist/', import.meta.url));
const targetDist = fileURLToPath(new URL('./dist/', import.meta.url));
for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
  const content = await readFile(join(sharedDist, `stdio${suffix}`), 'utf8');
  await writeFile(join(targetDist, `deployment-config${suffix}`),
    content.replaceAll('stdio.js', 'deployment-config.js').replaceAll('stdio.d.ts', 'deployment-config.d.ts'), 'utf8');
}
