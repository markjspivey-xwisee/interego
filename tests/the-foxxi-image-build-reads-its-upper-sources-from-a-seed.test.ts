/**
 * The Foxxi image build reads its pinned upper-ontology sources from a seed, and only that leg does.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 *
 * deploy/Dockerfile.foxxi-bridge's i2idlx-builder stage restores 21 sources that
 * evidence/upper/manifest.json pins by SHA-256, and it fetched every one from its publisher whenever
 * the stage ran, which is every build that changed what the bridge copies (otherwise the registry
 * layer cache serves it). On 2026-10-27 data.europa.eu timed out on ESCO, the leg failed, and the
 * all-or-nothing auto-deploy deployed no service; a re-run succeeded. build-ghcr.yml now fetches and verifies them
 * on the runner (tools/seed-pinned-upper.mjs --all), keeps them in the Actions cache, and passes the
 * directory as the build context `upper-seed`, which replaces an empty `FROM scratch` stage.
 *
 * What is pinned here is the wiring, because each piece fails quietly on its own:
 *   - a context passed to a leg whose Dockerfile has no such stage is ignored, and one passed to
 *     every leg would put a Foxxi cache step in every other leg's build, none of which reads it;
 *   - a seed directory that the main context also carried would enter bridge-base and so the
 *     runtime image;
 *   - a COPY that lands anywhere but `<root>/.cache/upper/<key>.source` is never read, and every
 *     build goes back to fetching live while looking seeded;
 *   - a seed step that can fail the leg would make the cure a new way to block every deploy.
 *
 * The seed script's own behaviour (only pinned bytes, nothing skipped silently, complete or not)
 * is in applications/foxxi-content-intelligence/tests/i2idlx-upper-seed.test.ts. The Docker
 * mechanics (an empty stage copies nothing; a named context under a dockerignored path still
 * arrives whole) were measured with docker buildx 0.38 on 2026-10-27; see the CHANGELOG entry.
 *
 * No YAML parser, for the reason tests/workflow-header-matches-triggers.test.ts gives: the steps are
 * read as text, by the indentation the workflow is written in.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const WORKFLOW = read('.github/workflows/build-ghcr.yml');
const DOCKERFILE_PATH = 'deploy/Dockerfile.foxxi-bridge';
const DOCKERFILE = read(DOCKERFILE_PATH);
const I2IDLX = 'applications/foxxi-content-intelligence/i2idlx';
const SEED = 'i2idlx-upper';
const CONTEXT = 'upper-seed';

interface ImageRow { image: string; dockerfile: string; prebuild?: string; seed?: string }
const IMAGES = (JSON.parse(read('deploy/images.json')) as { images: ImageRow[] }).images;

/** The build job's steps, each as its own block of text. */
function buildSteps(): string[] {
  const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  build:\n'));
  const steps = job.slice(job.indexOf('\n    steps:\n'));
  return steps.split(/\n(?= {6}- )/).slice(1);
}
const field = (step: string, name: string): string | undefined =>
  new RegExp(`^ {6}[- ] (?:${name}): (.*)$`, 'm').exec(step)?.[1]?.trim()
  ?? new RegExp(`^ {8}${name}: (.*)$`, 'm').exec(step)?.[1]?.trim();
const withInput = (step: string, name: string): string | undefined => new RegExp(`^ {10}${name}: (.*)$`, 'm').exec(step)?.[1]?.trim();

/** The build job's `env:` values. */
function jobEnv(): Record<string, string> {
  const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  build:\n'));
  const block = /\n {4}env:\n((?: {6}.*\n)+)/.exec(job.slice(0, job.indexOf('\n    steps:\n') + 1))?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/^ {6}([A-Z_]+): (.+)$/gm)].map(m => [m[1]!, m[2]!.trim()]));
}

/** Docker's continuation lines joined and comments dropped, in Docker's order. */
function instructions(dockerfile: string): string[] {
  return dockerfile.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')
    .replace(/\\[ \t]*\n/g, ' ').split('\n').map(l => l.trim()).filter(Boolean);
}
/** Stages in order, each with its instructions after the FROM. */
function stages(dockerfile: string): { from: string; name?: string; body: string[] }[] {
  const out: { from: string; name?: string; body: string[] }[] = [];
  for (const line of instructions(dockerfile)) {
    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    if (from) out.push({ from: from[1]!, name: from[2], body: [] });
    else out.at(-1)?.body.push(line);
  }
  return out;
}

/** Is `path` excluded from the main build context by /.dockerignore (last matching pattern wins)? */
function dockerignored(path: string): boolean {
  const patterns = read('.dockerignore').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const rx = (pattern: string): RegExp => new RegExp('^' + pattern.replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*') + '$');
  const prefixes = path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  let excluded = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = rx(negated ? raw.slice(1) : raw);
    if (prefixes.some(p => pattern.test(p))) excluded = !negated;
  }
  return excluded;
}

describe('only the Foxxi leg carries the seed', () => {
  it('deploy/images.json gives `seed` to the Foxxi bridge row and to no other', () => {
    expect(IMAGES.filter(r => r.seed).map(r => [r.image, r.seed])).toEqual([['interego-foxxi-bridge', SEED]]);
  });

  it('the matrix tool hands the field to that leg as it hands `prebuild`', () => {
    const run = (image: string): ImageRow[] => JSON.parse(execFileSync(process.execPath, [join(ROOT, 'tools/ci-image-matrix.mjs'), image],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as ImageRow[];
    expect(run('interego-foxxi-bridge')).toEqual([expect.objectContaining({ image: 'interego-foxxi-bridge', prebuild: 'dist', seed: SEED })]);
    expect(run('').filter(r => r.seed).map(r => r.image)).toEqual(['interego-foxxi-bridge']);
  });

  it('build-push-action gets a named context only when the leg declares the seed', () => {
    const push = buildSteps().find(s => /uses: docker\/build-push-action@/.test(s))!;
    expect(push, 'no build-push-action step').toBeTruthy();
    expect(WORKFLOW.match(/build-contexts:/g)).toHaveLength(1);
    const value = withInput(push, 'build-contexts');
    const m = /^\$\{\{ matrix\.seed == '([^']+)' && format\('([^=]+)=\{0\}', env\.([A-Z_]+)\) \|\| '' \}\}$/.exec(value ?? '');
    expect(m, `build-contexts is not the one gated expression: ${value}`).toBeTruthy();
    const [, seed, context, variable] = m!;
    expect([seed, context]).toEqual([SEED, CONTEXT]);
    expect(jobEnv()[variable!]).toBe(`${I2IDLX}/.cache/upper-seed`);
    // Evaluated per leg, as the expression is: one leg gets a context, every other gets ''.
    expect(IMAGES.filter(r => r.seed === seed).map(r => r.image)).toEqual(['interego-foxxi-bridge']);
  });

  it('the leg that gets the context builds a Dockerfile with a stage of that name', () => {
    for (const row of IMAGES.filter(r => r.seed === SEED)) {
      expect(stages(read(row.dockerfile)).map(s => s.name), row.dockerfile).toContain(CONTEXT);
    }
  });
});

describe('the seed steps in build-ghcr.yml', () => {
  const steps = buildSteps();
  const seedSteps = steps.filter(s => /matrix\.seed/.test(field(s, 'if') ?? ''));
  const byId = (id: string): string => seedSteps.find(s => field(s, 'id') === id)!;
  const env = jobEnv();
  const seedDir = env.UPPER_SEED_DIR!;

  it('are three — restore, fill, save — each gated on this seed and on the leg running, none able to fail it', () => {
    expect(seedSteps.map(s => field(s, 'id') ?? field(s, 'name'))).toEqual(['upper-seed', 'upper-seed-fill', field(seedSteps[2]!, 'name')]);
    for (const step of seedSteps) {
      expect(field(step, 'if')).toContain(`steps.gate.outputs.skip != 'true' && matrix.seed == '${SEED}'`);
      // The seed is how a build avoids a publisher outage; it must not become a new way to fail one.
      expect(field(step, 'continue-on-error'), field(step, 'name')).toBe('true');
    }
    const order = (pred: (s: string) => boolean): number => steps.findIndex(pred);
    expect(order(s => s === seedSteps[2])).toBeLessThan(order(s => /uses: docker\/build-push-action@/.test(s)));
  });

  it('restores by a key over the pins, the request data and the script with its mirror table', () => {
    const restore = byId('upper-seed');
    expect(field(restore, 'uses')).toMatch(/^actions\/cache\/restore@v\d+$/);
    expect(withInput(restore, 'path')).toBe('${{ env.UPPER_SEED_DIR }}');
    const key = withInput(restore, 'key')!;
    const hashed = [...key.matchAll(/'([^']+)'/g)].map(m => m[1]!);
    expect(hashed).toEqual([
      `${I2IDLX}/evidence/upper/manifest.json`,
      `${I2IDLX}/typescript/refresh-upper-data.json`,
      `${I2IDLX}/tools/seed-pinned-upper.mjs`,
    ]);
    const tracked = execFileSync('git', ['ls-files', '--', ...hashed], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    expect(tracked.sort()).toEqual([...hashed].sort());
  });

  it('fills the directory with the script in --all mode, creating it first', () => {
    const fill = byId('upper-seed-fill');
    expect(field(fill, 'continue-on-error')).toBe('true');
    const run = fill.slice(fill.indexOf('run: |'));
    const mkdir = run.indexOf('mkdir -p "$UPPER_SEED_DIR"');
    const script = run.indexOf(`node ${I2IDLX}/tools/seed-pinned-upper.mjs`);
    // buildx refuses a named context that does not exist, so the directory comes first.
    expect(mkdir).toBeGreaterThan(-1);
    expect(script).toBeGreaterThan(mkdir);
    expect(run).toMatch(new RegExp(`${I2IDLX}\\s+--all "\\$UPPER_SEED_DIR"`));
  });

  it('saves only a complete set, only on a miss, under the key it restored by', () => {
    const save = seedSteps[2]!;
    expect(field(save, 'uses')).toMatch(/^actions\/cache\/save@v\d+$/);
    expect(field(save, 'if')).toContain(`steps.upper-seed.outputs.cache-hit != 'true'`);
    expect(field(save, 'if')).toContain(`steps.upper-seed-fill.outputs.complete == 'true'`);
    expect(field(save, 'continue-on-error')).toBe('true');
    expect(withInput(save, 'path')).toBe('${{ env.UPPER_SEED_DIR }}');
    expect(withInput(save, 'key')).toBe('${{ steps.upper-seed.outputs.cache-primary-key }}');
  });

  it('keeps the directory out of the main context, so it never enters bridge-base', () => {
    expect(seedDir.startsWith(`${I2IDLX}/.cache/`)).toBe(true);
    expect(dockerignored(seedDir)).toBe(true);
    expect(dockerignored(`${seedDir}/esco.source`)).toBe(true);
    // The matcher is not vacuous: what the bridge does copy is not ignored.
    expect(dockerignored(`${I2IDLX}/evidence/upper/manifest.json`)).toBe(false);
    expect(dockerignored(`${I2IDLX}/tools/seed-pinned-upper.mjs`)).toBe(false);
    // Nor is it committed by accident.
    expect(execFileSync('git', ['check-ignore', '-q', '--no-index', `${seedDir}/esco.source`], { cwd: ROOT }).length).toBe(0);
  });
});

describe('deploy/Dockerfile.foxxi-bridge', () => {
  const all = stages(DOCKERFILE);
  const index = (name: string): number => all.findIndex(s => s.name === name);
  const builder = all[index('i2idlx-builder')]!;

  it('declares upper-seed as an empty FROM scratch stage, so a build without the context is unchanged', () => {
    const seed = all[index(CONTEXT)];
    expect(seed, 'no upper-seed stage').toBeTruthy();
    expect(seed!.from).toBe('scratch');
    expect(seed!.body).toEqual([]);
    expect(index(CONTEXT)).toBeLessThan(index('i2idlx-builder'));
  });

  it('copies the seed into the directory refresh-upper.ts reads, after prepare-source.ts and before the steps that read .cache/upper', () => {
    const copies = all.flatMap(s => s.body.filter(l => /^COPY\s+--from=upper-seed\s/.test(l)).map(l => [s.name, l]));
    expect(copies).toHaveLength(1);
    expect(copies[0]![0]).toBe('i2idlx-builder');
    const [, source, destination] = /^COPY\s+--from=upper-seed\s+(\S+)\s+(\S+)$/.exec(copies[0]![1]!)!;
    expect(source).toBe('/');

    // The root prepare-build-inputs.ts is given, + /.cache/upper/: where refresh-upper.ts looks.
    const prepare = builder.body.find(l => l.includes('prepare-build-inputs.ts'))!;
    const root = prepare.split(/\s+/).at(-1)!;
    expect(destination).toBe(`${root}/.cache/upper/`);
    const reader = read(`${I2IDLX}/typescript/refresh-upper.ts`);
    expect(reader).toContain(`const cache = join(root, '.cache', 'upper')`);
    expect(reader).toContain(`join(cache, pin.key + '.source')`);

    // Before the two steps that read .cache/upper: the default-mode seed step and
    // prepare-build-inputs.ts. Not before everything that fetches: apt-get, the workbench's npm ci
    // and prepare-source.ts (the github.com clone and the ROBOT jar) come first, so a seed that
    // differs from the last build's re-runs only the steps that read it, not the clone.
    const at = (needle: string): number => {
      const i = builder.body.findIndex(l => l.includes(needle));
      expect(i, `no ${needle} step in i2idlx-builder`).toBeGreaterThan(-1);
      return i;
    };
    const copy = at('COPY --from=upper-seed');
    expect(copy).toBeLessThan(at('tools/seed-pinned-upper.mjs'));
    expect(copy).toBeLessThan(at('prepare-build-inputs.ts'));
    expect(copy).toBeGreaterThan(at('prepare-source.ts'));
  });

  it('never lets the cache reach the runtime image', () => {
    const fromBuilder = all.flatMap(s => s.body.filter(l => /^COPY\s+--from=i2idlx-builder\s/.test(l)));
    expect(fromBuilder.length).toBeGreaterThan(0);
    for (const line of fromBuilder) expect(line.split(/\s+/)[2]).not.toContain('.cache');
  });
});
