/**
 * The Foxxi image build reads its pinned upper-ontology sources from a seed, and only that leg does.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────────
 *
 * deploy/Dockerfile.foxxi-bridge's i2idlx-builder stage restores 21 sources that
 * evidence/upper/manifest.json pins by SHA-256, and it fetched every one from its publisher whenever
 * the stage ran, which is every build that changed what the bridge copies (otherwise the registry
 * layer cache serves it). On 2026-10-27 data.europa.eu timed out on ESCO, the leg failed, and the
 * all-or-nothing auto-deploy deployed no service; a re-run succeeded. build-ghcr.yml now fetches and
 * verifies them on the runner (tools/seed-pinned-upper.mjs --all), pushes a complete set once as a
 * FROM scratch image tagged by the manifest's hash, and passes that image (or, when there is no
 * complete set, the directory) as the build context `upper-seed`, which replaces an empty
 * `FROM scratch` stage.
 *
 * Why an image and not only the Actions cache: the Dockerfile's COPY of the seed puts its bytes in
 * the layer-cache key of every step after it, so a seed that is not what the cached build had runs
 * those steps again, live fetches and the gate read included, even when bridge-base has not changed
 * and the whole stage used to come from the layer cache. A seed refilled after an Actions-cache
 * eviction with one publisher down was exactly that. The image is the same bytes for the same pins
 * on every build, whatever the Actions cache or any publisher is doing.
 *
 * What is pinned here is the wiring, because each piece fails quietly on its own:
 *   - a context passed to a leg whose Dockerfile has no such stage is ignored, and one passed to
 *     every leg would put a Foxxi cache step in every other leg's build, none of which reads it;
 *   - a seed directory that the main context also carried would enter bridge-base and so the
 *     runtime image;
 *   - a COPY that lands anywhere but `<root>/.cache/upper/<key>.source` is never read, and every
 *     build goes back to fetching live while looking seeded;
 *   - a seed step that can fail the leg would make the cure a new way to block every deploy;
 *   - a build that passed the directory when the image exists would key the stage on whatever the
 *     runner managed to fetch, and a partial image would make every later build start from it.
 * The steps' run blocks are also run here, through bash -e as GitHub runs an unspecified shell,
 * with a stand-in `docker`, so what they write to $GITHUB_OUTPUT is checked rather than read.
 *
 * The seed script's own behaviour (only pinned bytes, nothing skipped silently, complete or not)
 * is in applications/foxxi-content-intelligence/tests/i2idlx-upper-seed.test.ts. The Docker
 * mechanics (an empty stage copies nothing; a named context under a dockerignored path still
 * arrives whole; the image context is a cache hit on a fresh builder; a directory is not, even with
 * the same bytes) were measured with docker buildx 0.38 on 2026-10-27; see the CHANGELOG entry.
 *
 * No YAML parser, for the reason tests/workflow-header-matches-triggers.test.ts gives: the steps are
 * read as text, by the indentation the workflow is written in.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const WORKFLOW = read('.github/workflows/build-ghcr.yml');
const DOCKERFILE_PATH = 'deploy/Dockerfile.foxxi-bridge';
const DOCKERFILE = read(DOCKERFILE_PATH);
const I2IDLX = 'applications/foxxi-content-intelligence/i2idlx';
const MANIFEST = `${I2IDLX}/evidence/upper/manifest.json`;
const SEED = 'i2idlx-upper';
const CONTEXT = 'upper-seed';
const GATED = `steps.gate.outputs.skip != 'true' && matrix.seed == '${SEED}'`;
const NO_IMAGE = `steps.upper-seed-image.outputs.found != 'true'`;

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
/** A step's `run: |` block, dedented as YAML does. */
function runBlock(step: string): string {
  const lines = step.split('\n');
  const at = lines.findIndex(l => /^ {8}run: \|$/.test(l));
  expect(at, `no run block in ${field(step, 'name')}`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '') { body.push(''); continue; }
    if (!line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n').trimEnd() + '\n';
}

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

const steps = buildSteps();
const seedSteps = steps.filter(s => /matrix\.seed/.test(field(s, 'if') ?? ''));
const byId = (id: string): string => {
  const step = seedSteps.find(s => field(s, 'id') === id);
  expect(step, `no seed step with id ${id}`).toBeTruthy();
  return step!;
};
const save = (): string => seedSteps.find(s => /uses: actions\/cache\/save@/.test(s))!;

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

  it('build-push-action gets a named context only from the step that chooses it, which only the seed leg runs', () => {
    const push = steps.find(s => /uses: docker\/build-push-action@/.test(s))!;
    expect(push, 'no build-push-action step').toBeTruthy();
    expect(WORKFLOW.match(/build-contexts:/g)).toHaveLength(1);
    expect(withInput(push, 'build-contexts')).toBe('${{ steps.upper-seed-context.outputs.context }}');
    // A step skipped by its `if:` has no outputs, so every leg but the seed's gets '' (none).
    expect(field(byId('upper-seed-context'), 'if')).toBe(GATED);
    expect(IMAGES.filter(r => r.seed === SEED).map(r => r.image)).toEqual(['interego-foxxi-bridge']);
  });

  it('the leg that gets the context builds a Dockerfile with a stage of that name', () => {
    for (const row of IMAGES.filter(r => r.seed === SEED)) {
      expect(stages(read(row.dockerfile)).map(s => s.name), row.dockerfile).toContain(CONTEXT);
    }
  });
});

describe('the seed steps in build-ghcr.yml', () => {
  const env = jobEnv();
  const seedDir = env.UPPER_SEED_DIR!;
  const order = (pred: (s: string) => boolean): number => steps.findIndex(pred);

  it('are six, each gated on this seed and on the leg running, none able to fail it, between the login and the build', () => {
    expect(seedSteps.map(s => field(s, 'id') ?? field(s, 'uses'))).toEqual([
      'upper-seed-image', 'upper-seed', 'upper-seed-fill', 'upper-seed-push', 'actions/cache/save@v5', 'upper-seed-context',
    ]);
    for (const step of seedSteps) {
      expect(field(step, 'if')).toContain(GATED);
      // The seed is how a build avoids a publisher outage; it must not become a new way to fail one.
      expect(field(step, 'continue-on-error'), field(step, 'name')).toBe('true');
    }
    // The lookup and the push talk to the registry, and the push builds with the job's builder.
    const first = order(s => s === seedSteps[0]);
    expect(first).toBeGreaterThan(order(s => field(s, 'name') === 'Log in to GHCR'));
    expect(first).toBeGreaterThan(order(s => /uses: docker\/setup-buildx-action@/.test(s)));
    expect(order(s => s === seedSteps.at(-1))).toBe(order(s => /uses: docker\/build-push-action@/.test(s)) - 1);
  });

  it('fetch, push and save only when the registry has no image for these pins; the restore runs on every build', () => {
    expect(field(byId('upper-seed-fill'), 'if')).toBe(`${GATED} && ${NO_IMAGE}`);
    expect(field(byId('upper-seed-push'), 'if')).toContain(NO_IMAGE);
    expect(field(save(), 'if')).toContain(NO_IMAGE);
    // Restored on every build only so the entry is not evicted (seven days unused) between re-pins,
    // when it lets the fill fetch only what changed. It must not gate anything the image path needs.
    expect(field(byId('upper-seed'), 'if')).toBe(GATED);
    expect(field(byId('upper-seed'), 'timeout-minutes')).toBeTruthy();
  });

  it('looks for the image in the leg\'s own package, tagged by the hash of the manifest that decides its bytes', () => {
    const lookup = byId('upper-seed-image');
    expect(withInput(lookup, 'REF')).toBe(`ghcr.io/\${{ github.repository_owner }}/\${{ matrix.image }}:upper-seed-\${{ hashFiles('${MANIFEST}') }}`);
    // Beside the layer cache it has to agree with, which lives in the same package.
    expect(WORKFLOW).toContain('ref=ghcr.io/${{ github.repository_owner }}/${{ matrix.image }}:buildcache,mode=max');
    expect(withInput(byId('upper-seed-push'), 'REF')).toBe('${{ steps.upper-seed-image.outputs.ref }}');
    expect(withInput(byId('upper-seed-context'), 'REF')).toBe('${{ steps.upper-seed-image.outputs.ref }}');
  });

  it('restores by a key over the pins, the request data and the script with its mirror table', () => {
    const restore = byId('upper-seed');
    expect(field(restore, 'uses')).toMatch(/^actions\/cache\/restore@v\d+$/);
    expect(withInput(restore, 'path')).toBe('${{ env.UPPER_SEED_DIR }}');
    const key = withInput(restore, 'key')!;
    const hashed = [...key.matchAll(/'([^']+)'/g)].map(m => m[1]!);
    expect(hashed).toEqual([
      MANIFEST,
      `${I2IDLX}/typescript/refresh-upper-data.json`,
      `${I2IDLX}/tools/seed-pinned-upper.mjs`,
    ]);
    const tracked = execFileSync('git', ['ls-files', '--', ...hashed], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    expect(tracked.sort()).toEqual([...hashed].sort());
  });

  it('fills the directory with the script in --all mode, creating it first', () => {
    const fill = byId('upper-seed-fill');
    const run = runBlock(fill);
    const mkdir = run.indexOf('mkdir -p "$UPPER_SEED_DIR"');
    const script = run.indexOf(`node ${I2IDLX}/tools/seed-pinned-upper.mjs`);
    expect(mkdir).toBeGreaterThan(-1);
    expect(script).toBeGreaterThan(mkdir);
    expect(run).toMatch(new RegExp(`${I2IDLX}\\s+--all "\\$UPPER_SEED_DIR"`));
  });

  it('pushes only a complete set that it filled itself', () => {
    expect(field(byId('upper-seed-push'), 'if')).toBe(`${GATED} && ${NO_IMAGE} && steps.upper-seed-fill.outputs.complete == 'true'`);
  });

  it('saves only a complete set, only on a miss, under the key it restored by', () => {
    const step = save();
    expect(field(step, 'if')).toContain(`steps.upper-seed.outputs.cache-hit != 'true'`);
    expect(field(step, 'if')).toContain(`steps.upper-seed-fill.outputs.complete == 'true'`);
    expect(withInput(step, 'path')).toBe('${{ env.UPPER_SEED_DIR }}');
    expect(withInput(step, 'key')).toBe('${{ steps.upper-seed.outputs.cache-primary-key }}');
  });

  it('passes the image whenever the registry has it or the build just pushed it', () => {
    expect(withInput(byId('upper-seed-context'), 'IN_REGISTRY'))
      .toBe(`\${{ steps.upper-seed-image.outputs.found == 'true' || steps.upper-seed-push.outputs.pushed == 'true' }}`);
  });

  it('keeps the directory out of the main context, so it never enters bridge-base', () => {
    expect(seedDir.startsWith(`${I2IDLX}/.cache/`)).toBe(true);
    expect(dockerignored(seedDir)).toBe(true);
    expect(dockerignored(`${seedDir}/esco.source`)).toBe(true);
    // The matcher is not vacuous: what the bridge does copy is not ignored.
    expect(dockerignored(MANIFEST)).toBe(false);
    expect(dockerignored(`${I2IDLX}/tools/seed-pinned-upper.mjs`)).toBe(false);
    // Nor is it committed by accident.
    expect(execFileSync('git', ['check-ignore', '-q', '--no-index', `${seedDir}/esco.source`], { cwd: ROOT }).length).toBe(0);
  });
});

describe('the seed steps\' run blocks, run', () => {
  const REF = 'ghcr.io/owner/interego-foxxi-bridge:upper-seed-' + 'a'.repeat(64);

  /** Run one step's block as GitHub runs an unspecified shell (bash -e), with a stand-in docker. */
  function run(id: string, env: Record<string, string>, docker: { exit?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'upper-seed-step-'));
    try {
      const bin = join(dir, 'bin');
      execFileSync('mkdir', ['-p', bin]);
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_ARGS"\ncat > "$STUB_STDIN"\nexit "$STUB_EXIT"\n');
      chmodSync(join(bin, 'docker'), 0o755);
      const script = join(dir, 'step.sh');
      writeFileSync(script, runBlock(byId(id)));
      const output = join(dir, 'output');
      writeFileSync(output, '');
      const seedDir = join(dir, 'seed');
      const result = spawnSync('bash', ['-e', script], {
        cwd: dir, encoding: 'utf8', input: '',
        env: {
          PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, UPPER_SEED_DIR: seedDir,
          STUB_ARGS: join(dir, 'args'), STUB_STDIN: join(dir, 'stdin'), STUB_EXIT: String(docker.exit ?? 0), ...env,
        },
      });
      const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const called = existsSync(join(dir, 'args'));
      return {
        status: result.status, outputs, seedDir, seedDirExists: existsSync(seedDir),
        args: called ? readFileSync(join(dir, 'args'), 'utf8').trimEnd().split('\n') : undefined,
        stdin: called ? readFileSync(join(dir, 'stdin'), 'utf8') : undefined,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the lookup says found only when the registry answers for that tag, and never fails', () => {
    const found = run('upper-seed-image', { REF });
    expect(found.status).toBe(0);
    expect(found.outputs).toEqual({ ref: REF, found: 'true' });
    expect(found.args).toEqual(['buildx', 'imagetools', 'inspect', REF]);
    const missing = run('upper-seed-image', { REF }, { exit: 1 });
    expect(missing.status).toBe(0);
    expect(missing.outputs).toEqual({ ref: REF, found: 'false' });
  });

  it('the push builds FROM scratch with the directory as its only content, and says pushed only when docker succeeded', () => {
    const pushed = run('upper-seed-push', { REF });
    expect(pushed.status).toBe(0);
    expect(pushed.outputs).toEqual({ pushed: 'true' });
    expect(pushed.args).toEqual(['buildx', 'build', '--provenance=false', '--push', '-t', REF, '-f', '-', pushed.seedDir]);
    expect(pushed.stdin).toBe('FROM scratch\nCOPY . /\n');
    const refused = run('upper-seed-push', { REF }, { exit: 1 });
    expect(refused.status).not.toBe(0);
    expect(refused.outputs).toEqual({});
  });

  it('the build reads the image when the registry has it, whatever the directory holds', () => {
    const chosen = run('upper-seed-context', { REF, IN_REGISTRY: 'true' });
    expect(chosen.status).toBe(0);
    expect(chosen.outputs).toEqual({ context: `${CONTEXT}=docker-image://${REF}` });
    expect(chosen.args, 'choosing the context talks to nothing').toBeUndefined();
  });

  it('and the directory, created if need be, only when there is no image', () => {
    for (const env of [{ REF, IN_REGISTRY: 'false' }, { REF: '', IN_REGISTRY: 'true' }]) {
      const chosen = run('upper-seed-context', env);
      expect(chosen.status).toBe(0);
      expect(chosen.outputs).toEqual({ context: `${CONTEXT}=${chosen.seedDir}` });
      // buildx refuses a named context that does not exist.
      expect(chosen.seedDirExists).toBe(true);
    }
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
    // differs from the cached build's re-runs the COPY and every step after it, not the clone.
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

  it('runs exactly the steps the comments name after the COPY, which run again whenever the seed is not the cached build\'s', () => {
    // The COPY puts the seed in the layer-cache key of every later instruction in the stage, not
    // only of the two that read it, so build.ts (and its read of gate.interego.xwisee.com) is one of
    // them. That is the reason the workflow passes the same image for the same pins every time.
    const after = builder.body.slice(builder.body.findIndex(l => l.startsWith('COPY --from=upper-seed')) + 1);
    const named = [/tools\/seed-pinned-upper\.mjs/, /typescript\/prepare-build-inputs\.ts/, /typescript\/build\.ts/, /^RUN test -s /];
    expect(after.length).toBe(named.length);
    after.forEach((line, i) => expect(line).toMatch(named[i]!));
    // build.ts is the one that reads the gate: it records the signed descriptors publications.json names.
    expect(read(`${I2IDLX}/typescript/build.ts`)).toContain('publicationRecord(root');
    expect(read(`${I2IDLX}/publications.json`)).toContain('"https://gate.interego.xwisee.com/');
  });

  it('never lets the cache reach the runtime image', () => {
    const fromBuilder = all.flatMap(s => s.body.filter(l => /^COPY\s+--from=i2idlx-builder\s/.test(l)));
    expect(fromBuilder.length).toBeGreaterThan(0);
    for (const line of fromBuilder) expect(line.split(/\s+/)[2]).not.toContain('.cache');
  });
});
