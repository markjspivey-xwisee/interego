/**
 * The relay image installs no devDependency that only tests use.
 *
 * deploy/Dockerfile.relay rewrites the relay's package.json with a `node -e` step before
 * `npm install`, and the runtime stage copies /app/node_modules WHOLE. The step keeps
 * devDependencies on purpose, because the build stage runs tsc. So every devDependency it does
 * not delete ships in the runtime image with its own dependencies. It deleted @playwright/test
 * for exactly that reason; @modelcontextprotocol/client, the MCP SDK client the relay suite reads
 * results through, was added later and was not deleted.
 *
 * This runs the Dockerfile's own step on the relay's package.json and checks the result against
 * the files the image actually compiles (its `COPY deploy/mcp-relay/...` lines): a
 * devDependency survives only if the build toolchain needs it (typescript, tsx, @types/*) or a
 * copied file imports it.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DOCKERFILE = readFileSync(join(ROOT, 'deploy/Dockerfile.relay'), 'utf8');
const MANIFEST = readFileSync(join(ROOT, 'deploy/mcp-relay/package.json'), 'utf8');

const isToolchain = (name: string): boolean => name === 'typescript' || name === 'tsx' || name.startsWith('@types/');

/** The package.json the image installs: the Dockerfile's own rewrite step, run as written. */
function imageManifest(): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  const step = /RUN node -e "((?:[^"\\]|\\.)*package\.json\.template(?:[^"\\]|\\.)*)"/.exec(DOCKERFILE);
  if (!step) throw new Error('no `node -e` step that reads package.json.template in deploy/Dockerfile.relay');
  const dir = mkdtempSync(join(tmpdir(), 'relay-image-manifest-'));
  try {
    writeFileSync(join(dir, 'package.json.template'), MANIFEST);
    execFileSync(process.execPath, ['-e', step[1]!], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every script file under the relay that the image copies (sources of `COPY deploy/mcp-relay/…`). */
function copiedFiles(): string[] {
  const out = new Set<string>();
  const walk = (path: string): void => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) if (entry !== 'node_modules' && entry !== 'dist') walk(join(path, entry));
    } else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(path)) out.add(path);
  };
  for (const line of DOCKERFILE.split('\n')) {
    const copy = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    if (!copy) continue;
    const parts = copy[1]!.split(/\s+/);
    for (const source of parts.slice(0, -1)) if (source.startsWith('deploy/mcp-relay/')) walk(join(ROOT, source));
  }
  return [...out];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const imports = (source: string, pkg: string): boolean =>
  new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"]${escape(pkg)}(?:/[^'"]*)?['"]`).test(source);

describe('the relay image', () => {
  it('installs no devDependency that only tests use', () => {
    const declared = Object.keys((JSON.parse(MANIFEST) as { devDependencies?: Record<string, string> }).devDependencies ?? {});
    const files = copiedFiles();
    // The scan must have something to scan, or every dependency looks unused and this passes on nothing.
    expect(files.length, 'files the image copies from deploy/mcp-relay').toBeGreaterThan(20);
    expect(files.some(f => f.endsWith('/server.ts')), 'server.ts is among them').toBe(true);
    const sources = files.map(f => readFileSync(f, 'utf8'));
    // Empty is fine: a relay with no test-only devDependency has nothing for the image to strip.
    const notForTheImage = declared.filter(d => !isToolchain(d) && !sources.some(s => imports(s, d)));

    const installed = imageManifest();
    const kept = Object.keys(installed.devDependencies ?? {});
    expect(kept, 'the build stage still gets its compiler').toContain('typescript');
    expect(Object.keys(installed.dependencies ?? {}).filter(d => d.startsWith('@interego/'))).toEqual([]);
    expect(kept.filter(d => notForTheImage.includes(d)), 'test-only devDependencies the image would ship').toEqual([]);
  });
});
