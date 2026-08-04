/**
 * The conformance runner, driven through its REAL entry point.
 *
 * ★ WHY THIS FILE EXISTS. The runner gates Candidate Recommendation per STATUS.md, is the
 * thing spec/STABILITY.md points a second implementation at, and was called by no workflow,
 * no npm script and no test. Three fail-open paths were measured on it, and all three
 * reported exit 0:
 *
 *   - `--fixtures` / `--expected`, the flags STABILITY.md documents, were never read. A
 *     second implementation running the documented command validated OUR fixtures and read
 *     the pass as a verdict on ITS code.
 *   - The loop iterates CATEGORY_CHECKS, not the filesystem, so the "drop your output into
 *     fixtures/<their-impl-name>/" procedure in spec/CONFORMANCE.md produced a green run
 *     over a directory nothing had opened — including a fixture violating L1.1 and L1.2.
 *   - A declared category with a missing or empty directory returned `{total:0, fail:0}`
 *     and the caller only tested `fail > 0`, so coverage holes scored as passes.
 *
 * Every case spawns the real script. Re-implementing the scan here would be a double
 * standing in for the thing under test, and could not express any of the three.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO, 'spec', 'conformance', 'runner.mjs');
const BUILTIN = join(REPO, 'spec', 'conformance', 'fixtures');

// Only ever under os.tmpdir(): vitest runs every file in ONE process here
// (singleThread/singleFork), and a test that wrote inside spec/conformance/fixtures/ would
// become a polluter that breaks an unrelated file in a full run.
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
  temps.push(dir);
  return dir;
}

/** A temp fixture tree with a real, populated `revocation/` category. */
function treeWithRevocation(): string {
  const dir = tempTree();
  const rev = join(dir, 'revocation');
  mkdirSync(rev, { recursive: true });
  for (const f of readdirSync(join(BUILTIN, 'revocation')).filter((n) => n.endsWith('.ttl'))) {
    copyFileSync(join(BUILTIN, 'revocation', f), join(rev, f));
  }
  return dir;
}

function run(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('conformance runner', () => {
  it('the built-in run passes and claims no level it did not exercise', () => {
    const { status, out } = run([]);
    expect(status, out).toBe(0);
    // The reproduction: this printed "Interego L1+L2+L3 (Core + Federation + Advanced)"
    // off five fixtures in one of the ten categories its own README enumerates.
    expect(out).not.toContain('L1+L2+L3');
    expect(out).not.toContain('Interego-Full');
    expect(out).toContain('Not exercised by any fixture');
  });

  it('★ refuses a fixture directory it does not know about, instead of skipping it', () => {
    // The documented third-party path. Before this the file was never opened and the run
    // reported a clean pass over it.
    const dir = treeWithRevocation();
    mkdirSync(join(dir, 'their-impl'));
    writeFileSync(
      join(dir, 'their-impl', 'garbage.ttl'),
      '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.\n'
      + '<urn:x> a iep:ContextDescriptor ;\n'
      + '  iep:hasFacet [ a iep:SemioticFacet ; iep:modalStatus iep:Asserted ; iep:groundTruth false ] .\n',
    );
    const { status, out } = run(['--fixtures', dir]);
    expect(status, out).toBe(2);
    expect(out).toContain('no CATEGORY_CHECKS entry');
    expect(out).toContain('their-impl');
  });

  it('★ refuses a declared category with no fixtures behind it', () => {
    const dir = tempTree();
    mkdirSync(join(dir, 'revocation'));
    const { status, out } = run(['--fixtures', dir]);
    expect(status, out).toBe(2);
    expect(out).toContain('contributed 0 fixtures');
  });

  it('★ --fixtures actually redirects the scan — the flag was documented and ignored', () => {
    // Kills the mutant that reverts FIXTURES_DIR to the built-in constant: both cases above
    // would then validate the real tree and exit 0 rather than 2.
    const dir = treeWithRevocation();
    const { status, out } = run(['--fixtures', dir]);
    expect(status, out).toBe(0);
    expect(out).toContain(dir);
  });

  it('refuses --expected rather than accepting a flag that does nothing', () => {
    const { status, out } = run(['--expected', 'spec/conformance/expected']);
    expect(status, out).toBe(2);
    expect(out).toContain('--expected');
  });
});
