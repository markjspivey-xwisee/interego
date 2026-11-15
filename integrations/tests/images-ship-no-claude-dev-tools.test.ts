/**
 * An image that installs the root lockfile with its devDependencies does not ship the Claude Code
 * CLI, the Claude Agent SDK, or the ACP agents that wrap them.
 *
 * ── WHY THE IMAGES HAD THEM ──────────────────────────────────────────────────────────────────
 *
 * Nine images run a plain `npm ci` against the ROOT lockfile, and they have to keep the
 * devDependencies: the services run through `npx tsx`, and tsx is a root devDependency. So every
 * other root devDependency rode along, including `@anthropic-ai/claude-code`, whose platform
 * package carries a native `claude` binary of about 214 MB, and `@zed-industries/claude-code-acp`,
 * which brings `@anthropic-ai/claude-agent-sdk` (about 96 MB with the sharp binaries npm nests
 * under it). They are developer tools; no service runs them. The pending switch to
 * `@agentclientprotocol/claude-agent-acp` brings an agent SDK with its own platform package and a
 * native binary of about 294 MB: about 200 MB more per image than today, unless it is pruned too.
 *
 * `tools/prune-image-dev-tools.mjs` deletes exactly those packages right after `npm ci`, in the
 * SAME `RUN`. The same RUN matters: a later `RUN` that deletes them only adds whiteouts on top of
 * a layer that still holds the bytes, and a single-stage image ships every one of its layers.
 *
 * ── WHAT EACH LEG PINS ───────────────────────────────────────────────────────────────────────
 *
 * (a) Every Dockerfile that installs the root lockfile with devDependencies either prunes in the
 *     same RUN or never lets that node_modules reach the image it builds. Both lists are pinned,
 *     so a parser that silently matched nothing cannot pass.
 * (b) Nothing deployed needs the packages: npm marks every one of them dev-only and nothing else
 *     depends on them; no file an image ships references them except four named developer tools
 *     that are copied along with their directories; and the static import closure of everything
 *     a pruned image runs (its CMD and every script a RUN step executes) reaches none of them and
 *     none of those four.
 * (c) The script removes exactly the listed packages and their .bin links from a fake tree, and
 *     leaves everything else byte-for-byte intact, including `@anthropic-ai/sdk`.
 * (d) Running it again is a no-op that still succeeds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_PATH = 'tools/prune-image-dev-tools.mjs';
const SCRIPT = join(ROOT, SCRIPT_PATH);

/**
 * The prune list, written out here independently of the script so that (b) does not depend on
 * the script existing, and (c) pins the script's own list against it.
 */
const PRUNE_PATTERNS = [
  '@anthropic-ai/claude-code',
  '@anthropic-ai/claude-code-*',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk-*',
  '@zed-industries/claude-code-acp',
  '@agentclientprotocol/claude-agent-acp',
] as const;

/** The executables those packages put in node_modules/.bin. */
const BIN_NAMES = ['claude', 'claude-code-acp', 'claude-agent-acp'] as const;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** One pattern as a regex body: `*` stands for one platform suffix such as `linux-x64-musl`. */
const patternBody = (p: string): string => p.split('*').map(escape).join('[a-z0-9][a-z0-9-]*');
const NAME = `(?:${PRUNE_PATTERNS.map(patternBody).join('|')})`;
const isPrunedName = (name: string): boolean => new RegExp(`^${NAME}$`).test(name);

// ── Reading a Dockerfile ───────────────────────────────────────────────────────────────────────

interface Instruction { readonly op: string; readonly args: string; readonly line: number; cwd: string }
interface Stage { readonly index: number; readonly alias: string | null; readonly base: string; readonly instructions: Instruction[] }

/** Stages and instructions the way Docker reads them: comment lines go before continuations join. */
function parseDockerfile(text: string): Stage[] {
  const logical: { text: string; line: number }[] = [];
  let buffer = '';
  let start = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    if (!buffer) start = i + 1;
    const continues = /\\\s*$/.test(raw);
    buffer += (buffer ? ' ' : '') + raw.replace(/\\\s*$/, '');
    if (!continues) {
      if (buffer.trim()) logical.push({ text: buffer.trim(), line: start });
      buffer = '';
    }
  });
  if (buffer.trim()) logical.push({ text: buffer.trim(), line: start });
  const stages: Stage[] = [];
  for (const l of logical) {
    const m = /^([A-Za-z]+)\s+([\s\S]*)$/.exec(l.text);
    if (!m) continue;
    const op = m[1]!.toUpperCase();
    const args = m[2]!;
    if (op === 'FROM') {
      const f = /^(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(args);
      stages.push({ index: stages.length, base: f?.[1] ?? '', alias: f?.[2]?.toLowerCase() ?? null, instructions: [] });
    } else if (stages.length) {
      stages[stages.length - 1]!.instructions.push({ op, args, line: l.line, cwd: '/' });
    }
  }
  return stages;
}

const stageNamed = (stages: readonly Stage[], ref: string): Stage | undefined =>
  stages.find(s => s.alias === ref.toLowerCase()) ?? (/^\d+$/.test(ref) ? stages[Number(ref)] : undefined);

/** The stage itself and every stage it is built FROM. */
function ancestry(stages: readonly Stage[], stage: Stage): Stage[] {
  const out: Stage[] = [];
  for (let s: Stage | undefined = stage; s && !out.includes(s); s = stageNamed(stages, s.base)) out.push(s);
  return out;
}

const tokens = (args: string): string[] => args.trim().split(/\s+/).filter(Boolean);
const copyParts = (args: string): { sources: string[]; dest: string } => {
  const parts = tokens(args).filter(t => !t.startsWith('--'));
  return { sources: parts.slice(0, -1), dest: parts[parts.length - 1] ?? '' };
};
/** The shell command of a RUN or CMD, without `--mount`/`--network` flags; exec form joined. */
function shellOf(args: string): string {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) {
    try { return (JSON.parse(trimmed) as string[]).join(' '); } catch { return trimmed; }
  }
  return trimmed.replace(/^(?:--\S+\s+)+/, '');
}

interface RootInstall {
  readonly line: number;
  readonly command: string;
  /** The directory the root lockfile was copied to, which is where node_modules lands. */
  readonly dir: string;
  readonly stage: Stage;
  /** The prune script ran later in the same RUN, from a copy this stage chain made of it. */
  readonly pruned: boolean;
}

interface Analysis {
  readonly dockerfile: string;
  readonly stages: Stage[];
  /** The stage CI builds: images.json's `target`, or the last one. */
  readonly built: Stage;
  readonly installs: RootInstall[];
}

const IMAGES = (JSON.parse(readFileSync(join(ROOT, 'deploy/images.json'), 'utf8')) as {
  images: { image: string; dockerfile: string; target?: string }[];
}).images;

/**
 * Every install of the ROOT lockfile that keeps devDependencies: `npm ci` or `npm install` run in
 * the directory a `COPY ... package-lock.json ...` put the root lockfile, without `--prefix`,
 * `--global` or any way of omitting dev. Records each instruction's working directory as it goes.
 */
function analyse(dockerfile: string, text = readFileSync(join(ROOT, dockerfile), 'utf8')): Analysis {
  const stages = parseDockerfile(text);
  const installs: RootInstall[] = [];
  interface State { workdir: string; lockDir: string | null; production: boolean; scripts: Set<string> }
  const states = new Map<Stage, State>();
  for (const stage of stages) {
    const parent = stageNamed(stages, stage.base);
    const inherited = parent ? states.get(parent) : undefined;
    const state: State = inherited
      ? { ...inherited, scripts: new Set(inherited.scripts) }
      : { workdir: '/', lockDir: null, production: false, scripts: new Set() };
    for (const ins of stage.instructions) {
      if (ins.op === 'WORKDIR') state.workdir = posix.resolve(state.workdir, ins.args.trim());
      ins.cwd = state.workdir;
      if (ins.op === 'ENV' && /\bNODE_ENV[= ]+["']?production\b/.test(ins.args)) state.production = true;
      else if (ins.op === 'COPY' && !/--from[= ]/.test(ins.args)) {
        const { sources, dest } = copyParts(ins.args);
        const intoDir = dest.endsWith('/') || dest === '.' || sources.length > 1;
        const target = (source: string): string => intoDir
          ? posix.join(posix.resolve(state.workdir, dest), posix.basename(source))
          : posix.resolve(state.workdir, dest);
        for (const source of sources) {
          if (source === 'package-lock.json') state.lockDir = posix.dirname(target(source));
          if (source === SCRIPT_PATH) state.scripts.add(target(source));
        }
      } else if (ins.op === 'RUN') {
        let cwd = state.workdir;
        const pending: { command: string; dir: string }[] = [];
        for (const raw of shellOf(ins.args).split(/&&|\|\||;|\|/)) {
          const seg = raw.trim().replace(/^(?:[({]\s*|(?:then|else|do)\s+)+/, '').trim();
          const cd = /^cd\s+(\S+)/.exec(seg);
          if (cd) { cwd = posix.resolve(cwd, cd[1]!); continue; }
          if (/^npm\s+(?:ci|install|i)(?:\s|$)/.test(seg)) {
            const devOmitted = /--omit[= ]dev\b|--production\b|--only[= ]prod/.test(seg) || state.production;
            const elsewhere = /--prefix\b|(?:^|\s)(?:-g|--global)\b/.test(seg);
            if (state.lockDir !== null && cwd === state.lockDir && !devOmitted && !elsewhere) pending.push({ command: seg, dir: cwd });
            continue;
          }
          const node = /^node\s+(\S+)/.exec(seg);
          if (node && pending.length && state.scripts.has(posix.resolve(cwd, node[1]!))) {
            for (const p of pending.splice(0)) installs.push({ ...p, line: ins.line, stage, pruned: true });
          }
        }
        for (const p of pending) installs.push({ ...p, line: ins.line, stage, pruned: false });
      }
    }
    states.set(stage, state);
  }
  const target = IMAGES.find(i => i.dockerfile === dockerfile)?.target;
  const built = (target ? stageNamed(stages, target) : undefined) ?? stages[stages.length - 1]!;
  return { dockerfile, stages, built, installs };
}

/**
 * Does this install's node_modules reach the image? Yes when its stage is the built stage or one
 * that stage is FROM, or when any COPY --from a stage descending from it takes the install
 * directory, its node_modules, or a directory above them.
 */
function shipped(a: Analysis, install: RootInstall): boolean {
  if (ancestry(a.stages, a.built).includes(install.stage)) return true;
  const nm = `${install.dir}/node_modules`;
  for (const s of a.stages) {
    for (const ins of s.instructions) {
      const from = /--from[= ](\S+)/.exec(ins.args);
      if (ins.op !== 'COPY' || !from) continue;
      const source = stageNamed(a.stages, from[1]!);
      if (!source || !ancestry(a.stages, source).includes(install.stage)) continue;
      for (const raw of copyParts(ins.args).sources) {
        const src = posix.resolve(ins.cwd, raw).replace(/\/$/, '') || '/';
        if (src === '/' || src === install.dir || install.dir.startsWith(`${src}/`) || src === nm || src.startsWith(`${nm}/`)) return true;
      }
    }
  }
  return false;
}

const git = (...args: string[]): string[] =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
const TRACKED = git('ls-files');
const DOCKERFILES = TRACKED.filter(f => /(^|\/)Dockerfile(\.[^/]+)?$/.test(f));

/** The images that install the root lockfile with devDependencies and ship it: they must prune. */
const MUST_PRUNE = [
  'deploy/Dockerfile.agp-bridge',
  'deploy/Dockerfile.coached-world-bridge',
  'deploy/Dockerfile.discord',
  'deploy/Dockerfile.foxxi-bridge',
  'deploy/Dockerfile.interego-bridge',
  'deploy/Dockerfile.jev-harness-bridge',
  'deploy/Dockerfile.pev-bridge',
  'deploy/Dockerfile.wrd-bridge',
  'deploy/Dockerfile.wsp-bridge',
];

/**
 * The images that also install the root lockfile with devDependencies, but in a build stage whose
 * node_modules no runtime stage takes: they pack tarballs there and install those elsewhere.
 */
const BUILD_STAGE_ONLY = [
  'deploy/Dockerfile.dashboard',
  'deploy/Dockerfile.pgsl-browser',
  'deploy/Dockerfile.relay',
];

/** Installs this Dockerfile text would ship without pruning, as readable lines. */
const unprunedShipped = (a: Analysis): string[] => a.installs.filter(i => !i.pruned && shipped(a, i))
  .map(i => `${a.dockerfile}:${i.line} \`${i.command}\` ships ${i.dir}/node_modules without `
    + `\`&& node ${SCRIPT_PATH}\` in the same RUN, after a COPY of the script`);

describe('(a) a root install that keeps devDependencies is pruned in the same RUN, or never shipped', () => {
  const analyses = DOCKERFILES.map(d => analyse(d));
  const installs = analyses.flatMap(a => a.installs.map(i => ({ a, i })));

  it('finds every such install, so the checks below are not vacuous', () => {
    expect([...new Set(installs.map(x => x.a.dockerfile))].sort()).toEqual([...MUST_PRUNE, ...BUILD_STAGE_ONLY].sort());
    expect(installs.filter(x => MUST_PRUNE.includes(x.a.dockerfile)).map(x => x.i.command.split(/\s+/).slice(0, 2).join(' ')))
      .toEqual(MUST_PRUNE.map(() => 'npm ci'));
  });

  it('every install whose node_modules reaches the image runs the prune script right after it, in the same RUN', () => {
    expect(analyses.flatMap(unprunedShipped)).toEqual([]);
  });

  it('the installs that do not prune are exactly the build-stage-only ones, and those really are not shipped', () => {
    expect([...new Set(installs.filter(x => !x.i.pruned).map(x => x.a.dockerfile))].sort()).toEqual(BUILD_STAGE_ONLY);
    for (const { a, i } of installs.filter(x => BUILD_STAGE_ONLY.includes(x.a.dockerfile))) {
      expect(shipped(a, i), `${a.dockerfile}:${i.line}`).toBe(false);
    }
  });

  it('the checks above can fail', () => {
    const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8');
    const prune = ` && node ${SCRIPT_PATH}`;
    // A prune in the NEXT RUN leaves the binaries in the install's layer of a single-stage image.
    const wsp = read('deploy/Dockerfile.wsp-bridge');
    const later = wsp.replace(`RUN npm ci${prune}`, `RUN npm ci\nRUN node ${SCRIPT_PATH}`);
    expect(later).not.toBe(wsp);
    expect(unprunedShipped(analyse('deploy/Dockerfile.wsp-bridge', later))).toHaveLength(1);
    // A prune of a script that was never copied into the image does not count.
    const uncopied = wsp.replace(/^COPY tools\/prune-image-dev-tools\.mjs .*\r?\n/m, '');
    expect(uncopied).not.toBe(wsp);
    expect(unprunedShipped(analyse('deploy/Dockerfile.wsp-bridge', uncopied))).toHaveLength(1);
    // Two stages: the runtime stage takes the build stage's /app whole, so that install ships too.
    const discord = read('deploy/Dockerfile.discord');
    const plain = discord.replace(`RUN npm ci${prune}`, 'RUN npm ci');
    expect(plain).not.toBe(discord);
    const d = analyse('deploy/Dockerfile.discord', plain);
    expect(ancestry(d.stages, d.built).map(s => s.alias)).toEqual([null]);
    expect(unprunedShipped(d)).toHaveLength(1);
    // And a build-stage-only install stops being one the moment a runtime stage takes its node_modules.
    const relay = read('deploy/Dockerfile.relay');
    const taken = relay.replace('COPY --from=build /app/node_modules ./node_modules', 'COPY --from=build /workspace/node_modules ./node_modules');
    expect(taken).not.toBe(relay);
    expect(unprunedShipped(analyse('deploy/Dockerfile.relay', taken))).toHaveLength(1);
  });
});

// ── (b) nothing deployed needs them ─────────────────────────────────────────────────────────────

/** Ways a source file could reach one of the packages or their executables. */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['names a pruned package', new RegExp(`['"\`]${NAME}(?:/[^'"\`\\s]*)?['"\`]`)],
  ['joins a pruned package path', new RegExp(PRUNE_PATTERNS.map(p => {
    const [scope, name] = p.split('/');
    return `['"\`]${escape(scope!)}['"\`]\\s*,\\s*['"\`]${patternBody(name!)}['"\`]`;
  }).join('|'))],
  ['reaches into node_modules for one', new RegExp(`node_modules[\\\\/](?:\\.bin[\\\\/](?:${BIN_NAMES.join('|')})\\b|${
    PRUNE_PATTERNS.map(p => patternBody(p).replace('\\/', '[\\\\/]')).join('|')})`)],
  ['runs one of their executables', new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|execa)\\s*\\(\\s*['"\`](?:${
    BIN_NAMES.join('|')})(?:\\.exe|\\.cmd)?['"\`]|\\bnpx\\s+(?:-y\\s+|--yes\\s+)?(?:${BIN_NAMES.join('|')}|${NAME})(?![\\w-])`)],
];
const offences = (text: string): string[] => FORBIDDEN.filter(([, rx]) => rx.test(text)).map(([why]) => why);

/**
 * Shipped, never run. Each is in an image only because that image copies a whole directory, and
 * the closure legs below prove none is reachable from anything the image runs. A new entry needs
 * the same proof; a stale one fails the equality check.
 */
const SHIPPED_DEVELOPER_TOOLS: Readonly<Record<string, string>> = {
  'applications/foxxi-content-intelligence/tools/emergent-collective-agents.mjs':
    'imports the agent SDK to drive agents on a signed-in developer machine; in the foxxi-bridge image only because the vertical is copied whole',
  'applications/foxxi-content-intelligence/tools/emergent-collective-live.mjs':
    'the live variant of the same developer driver; same reason',
  'applications/shared-workspace/desktop/src/modelprovider.ts':
    "the desktop app's lookup of the user's own Claude Code install; in the wsp, agp and discord images only because applications/shared-workspace/ is copied whole",
  'demos/agent-lib.ts':
    'spawns the claude CLI for the local demo runner (demos/run-all.*); in the interego-bridge image only because demos/ is copied whole',
};

/** The step-2 scope: what any image ships or runs. Every Dockerfile's COPY sources, plus the trees named. */
function shippedScope(): string[] {
  const prefixes = new Set<string>(['deploy/', 'demos/']);
  for (const f of TRACKED) {
    const m = /^(applications\/[^/]+\/(?:bridge|src)\/|packages\/[^/]+\/src\/)/.exec(f);
    if (m) prefixes.add(m[1]!);
  }
  for (const d of DOCKERFILES) {
    for (const stage of parseDockerfile(readFileSync(join(ROOT, d), 'utf8'))) {
      for (const ins of stage.instructions) {
        if (ins.op !== 'COPY' || /--from[= ]/.test(ins.args)) continue;
        for (const s of copyParts(ins.args).sources) prefixes.add(s.replace(/^\.\//, ''));
      }
    }
  }
  const covers = (f: string): boolean => [...prefixes].some(p => (p.endsWith('/') ? f.startsWith(p) : f === p || f.startsWith(`${p}/`)));
  // The prune script names the packages in order to delete them.
  return TRACKED.filter(f => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/.test(f) && f !== SCRIPT_PATH && covers(f));
}

/** Specifiers a source imports, re-exports or requires. Comments included: reaching too far is safe. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\brequire\.resolve\s*\(\s*)['"`]([^'"`\n]+)['"`]/g;

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = posix.join(posix.dirname(fromFile), spec);
  const candidates = [base];
  if (/\.(?:m|c)?js$/.test(base)) candidates.push(base.replace(/\.(?:m|c)?js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.mjs$/, '.mts'));
  candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`, `${base}/index.mjs`);
  return candidates.find(c => existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()) ?? null;
}

/**
 * Every repo file statically reachable from the entries: relative imports followed file by file,
 * and an `@interego/<name>` import taken as ALL of packages/<name>/src (more than it loads, never less).
 */
function closure(entries: readonly string[]): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const packages = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) continue;
    for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) {
        const r = resolveRelative(file, spec);
        if (r) todo.push(r);
      } else if (spec.startsWith('@interego/')) {
        const name = spec.split('/')[1]!;
        if (packages.has(name)) continue;
        packages.add(name);
        todo.push(...TRACKED.filter(f => f.startsWith(`packages/${name}/src/`) && /\.(?:ts|mts|mjs|js)$/.test(f) && !f.endsWith('.d.ts')));
      } else if (!spec.startsWith('node:') && /^[@a-z0-9]/.test(spec)) {
        bare.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      }
    }
  }
  return { files: [...seen].sort(), bare };
}

/** What an image runs: its CMD, and every script a RUN step executes with node or tsx, as repo paths. */
function entriesOf(dockerfile: string): string[] {
  const a = analyse(dockerfile);
  const appDir = a.installs[0]?.dir ?? '/app';
  const out = new Set<string>();
  for (const stage of a.stages) {
    for (const ins of stage.instructions) {
      if (ins.op !== 'RUN' && ins.op !== 'CMD' && ins.op !== 'ENTRYPOINT') continue;
      for (const m of shellOf(ins.args).matchAll(/(?:^|[\s;&|(])(?:npx\s+tsx|node(?:\s+--import\s+tsx)?)\s+([./A-Za-z0-9_-]+\.(?:ts|mts|mjs|cjs|js))\b/g)) {
        const abs = posix.resolve(ins.cwd, m[1]!);
        if (!abs.startsWith(`${appDir}/`)) continue;
        const rel = abs.slice(appDir.length + 1);
        if (rel !== SCRIPT_PATH) out.add(rel);
      }
    }
  }
  return [...out].sort();
}

describe('(b) nothing deployed needs the pruned packages', () => {
  it('npm marks every one of them dev-only, and nothing but another of them or a devDependency asks for one', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { dev?: boolean; dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>;
    };
    const nameOf = (loc: string): string => loc.replace(/^.*node_modules\//, '');
    const underPruned = (loc: string): boolean =>
      loc.split('node_modules/').slice(1).map(p => p.replace(/\/$/, '')).slice(0, -1).some(isPrunedName);
    const isPrunedLoc = (loc: string): boolean => loc.includes('node_modules/') && (isPrunedName(nameOf(loc)) || underPruned(loc));
    // The lockfile has them today; if it ever did not, the rest of this leg would check nothing.
    expect(Object.keys(lock.packages).filter(loc => loc.includes('node_modules/') && isPrunedName(nameOf(loc))).length).toBeGreaterThan(5);
    const notDev = Object.entries(lock.packages).filter(([loc, p]) => isPrunedLoc(loc) && p.dev !== true).map(([loc]) => loc);
    expect(notDev, 'locked without dev:true, so npm says something in production needs it').toEqual([]);
    const askers: string[] = [];
    for (const [loc, p] of Object.entries(lock.packages)) {
      if (isPrunedLoc(loc)) continue;
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
        for (const dep of Object.keys(p[field] ?? {})) if (isPrunedName(dep)) askers.push(`${loc || '(root)'} ${field} ${dep}`);
      }
    }
    expect(askers).toEqual([]);
  });

  it('no file an image ships references them, except the named developer tools', () => {
    const scope = shippedScope();
    expect(scope.length, 'files in scope').toBeGreaterThan(1000);
    for (const must of ['applications/foxxi-content-intelligence/bridge/server.ts', 'demos/interego-bridge/server.ts',
      'packages/core/src/index.ts', 'tools/smoke-foxxi-container.mjs', 'examples/pgsl-browser/server.ts']) {
      expect(scope).toContain(must);
    }
    const flagged: Record<string, string[]> = {};
    for (const f of scope) {
      const why = offences(readFileSync(join(ROOT, f), 'utf8'));
      if (why.length) flagged[f] = why;
    }
    expect(Object.keys(flagged).sort()).toEqual(Object.keys(SHIPPED_DEVELOPER_TOOLS).sort());
  });

  describe.each(MUST_PRUNE)('%s runs nothing that reaches them', (dockerfile) => {
    let entries: string[] = [];
    let reached: { files: string[]; bare: Set<string> } = { files: [], bare: new Set() };
    beforeAll(() => {
      entries = entriesOf(dockerfile);
      reached = closure(entries);
    });

    it('has entry points that exist, and a closure that reaches the substrate', () => {
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) expect(existsSync(join(ROOT, e)), e).toBe(true);
      expect(reached.files.length).toBeGreaterThan(50);
      expect(reached.files).toContain('packages/core/src/index.ts');
    });

    it('imports none of them, runs none of their executables, and reaches no shipped developer tool', () => {
      expect([...reached.bare].filter(isPrunedName)).toEqual([]);
      const hits = reached.files.flatMap(f => offences(readFileSync(join(ROOT, f), 'utf8')).map(why => `${f}: ${why}`));
      expect(hits).toEqual([]);
      expect(reached.files.filter(f => f in SHIPPED_DEVELOPER_TOOLS)).toEqual([]);
    });
  });

  it('the checks above can fail', () => {
    for (const f of Object.keys(SHIPPED_DEVELOPER_TOOLS)) expect(offences(readFileSync(join(ROOT, f), 'utf8')), f).not.toEqual([]);
    expect(offences(`import { query } from '@anthropic-ai/claude-agent-sdk';`)).not.toEqual([]);
    expect(offences(`await import('@anthropic-ai/claude-agent-sdk-linux-x64/claude')`)).not.toEqual([]);
    expect(offences(`const { query } = require("@zed-industries/claude-code-acp")`)).not.toEqual([]);
    expect(offences(`spawn('claude', ['-p'])`)).not.toEqual([]);
    expect(offences(`join(root, 'node_modules', '@zed-industries', 'claude-code-acp', 'dist', 'index.js')`)).not.toEqual([]);
    expect(offences(`const bin = 'node_modules/.bin/claude';`)).not.toEqual([]);
    expect(offences(`execSync('npx @agentclientprotocol/claude-agent-acp')`)).not.toEqual([]);
    expect(offences(`import Anthropic from '@anthropic-ai/sdk';`)).toEqual([]);
    expect(offences(`const surface = 'claude-code-vscode';`)).toEqual([]);
    expect(offences(`execSync('npx claude-code-vscode-helper')`)).toEqual([]);
    // The closure follows imports into the files that matter, and stops short of the demo runner.
    expect(closure(['applications/coached-world/bridge/server.ts']).files).toContain('deploy/identity/hosted-terms.ts');
    expect(closure(['demos/interego-bridge/server.ts']).files).not.toContain('demos/agent-lib.ts');
    expect(entriesOf('deploy/Dockerfile.foxxi-bridge')).toEqual(expect.arrayContaining([
      'applications/foxxi-content-intelligence/bridge/server.ts', 'tools/smoke-foxxi-container.mjs',
      'applications/foxxi-content-intelligence/i2idlx/typescript/build.ts',
      'applications/foxxi-content-intelligence/i2idlx/tools/seed-pinned-upper.mjs',
    ]));
  });
});

// ── (c) and (d): the script against a fake tree ─────────────────────────────────────────────────

type Entry = 'd' | `l:${string}` | `f:${number}:${string}`;
/** Every path under `dir`, without following links: directories, link targets, file sizes and hashes. */
function snapshot(dir: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs)) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) out.set(r, `l:${readlinkSync(a)}`);
      else if (st.isDirectory()) { out.set(r, 'd'); walk(a, r); }
      else out.set(r, `f:${st.size}:${createHash('sha256').update(readFileSync(a)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}

function put(root: string, rel: string, bytes: number | string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof bytes === 'number' ? Buffer.alloc(bytes, 7) : bytes);
}
function pkg(root: string, at: string, name: string, files: Record<string, number | string> = {}): void {
  put(root, `${at}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
  for (const [f, b] of Object.entries(files)) put(root, `${at}/${f}`, b);
}
function link(root: string, rel: string, target: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(target, join(root, rel));
}

const run = (args: readonly string[], cwd: string): { status: number | null; out: string } => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

describe('(c) the script removes exactly the listed packages, and (d) running it twice is fine', () => {
  let work = '';
  let before = new Map<string, Entry>();
  /** The package directories the script must remove, each reported by path. */
  const removedPackages = [
    'node_modules/@anthropic-ai/claude-code',
    'node_modules/@anthropic-ai/claude-code-linux-x64',
    'node_modules/@anthropic-ai/claude-code-linux-x64-musl',
    'node_modules/@anthropic-ai/claude-agent-sdk',
    'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
    'node_modules/@zed-industries/claude-code-acp',
    'node_modules/@agentclientprotocol/claude-agent-acp',
    'node_modules/some-tool/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64',
  ];
  const removedBins = [
    'node_modules/.bin/claude', 'node_modules/.bin/claude-code-acp', 'node_modules/.bin/claude-agent-acp',
    'node_modules/.bin/claude-stale', 'node_modules/some-tool/node_modules/.bin/claude',
  ];
  /** What disappears, outermost path only: the nested copy took its emptied scope with it. */
  const gone = [
    ...removedPackages.filter(p => !p.startsWith('node_modules/some-tool/')),
    'node_modules/some-tool/node_modules/@anthropic-ai',
    ...removedBins,
  ];
  let expectedBytes = 0;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'prune-image-dev-tools-'));
    const nm = join(work, 'node_modules');
    // Pruned: the CLI and its platform packages, with the postinstall's hard link of the binary.
    pkg(work, 'node_modules/@anthropic-ai/claude-code', '@anthropic-ai/claude-code', { 'install.cjs': 'x', 'cli-wrapper.cjs': 'y' });
    pkg(work, 'node_modules/@anthropic-ai/claude-code-linux-x64', '@anthropic-ai/claude-code-linux-x64', { claude: 40_000 });
    mkdirSync(join(nm, '@anthropic-ai/claude-code/bin'), { recursive: true });
    linkSync(join(nm, '@anthropic-ai/claude-code-linux-x64/claude'), join(nm, '@anthropic-ai/claude-code/bin/claude.exe'));
    pkg(work, 'node_modules/@anthropic-ai/claude-code-linux-x64-musl', '@anthropic-ai/claude-code-linux-x64-musl', { claude: 30_000 });
    // The agent SDK, with the sharp binaries npm nests under it, and its own platform package.
    pkg(work, 'node_modules/@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', { 'cli.js': 9_000, 'vendor/x.node': 5_000 });
    pkg(work, 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@img/sharp-linux-x64', '@img/sharp-linux-x64', { 'lib/sharp.node': 3_000 });
    pkg(work, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64', { claude: 50_000 });
    // The ACP agents, old and new.
    pkg(work, 'node_modules/@zed-industries/claude-code-acp', '@zed-industries/claude-code-acp', { 'dist/index.js': 700 });
    pkg(work, 'node_modules/@zed-industries/claude-code-acp/node_modules/minimatch', 'minimatch', { 'index.js': 300 });
    pkg(work, 'node_modules/@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/claude-agent-acp', { 'dist/index.js': 800 });
    // A copy npm nested under some other package is the same package.
    pkg(work, 'node_modules/some-tool', 'some-tool', { 'index.js': 'module.exports = 1' });
    pkg(work, 'node_modules/some-tool/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64', '@anthropic-ai/claude-agent-sdk-darwin-arm64', { claude: 2_000 });

    // Kept: similarly named packages, and everything else.
    pkg(work, 'node_modules/@anthropic-ai/sdk', '@anthropic-ai/sdk', { 'index.js': 'sdk', 'bin/cli': 'cli' });
    pkg(work, 'node_modules/@anthropic-ai/claude-codex', '@anthropic-ai/claude-codex', { 'index.js': 'not the CLI' });
    pkg(work, 'node_modules/@anthropic-ai/claude-agent', '@anthropic-ai/claude-agent', { 'index.js': 'not the SDK' });
    pkg(work, 'node_modules/@agentclientprotocol/sdk', '@agentclientprotocol/sdk', { 'index.js': 'protocol' });
    pkg(work, 'node_modules/@zed-industries/zed-other', '@zed-industries/zed-other', { 'index.js': 'other' });
    pkg(work, 'node_modules/claude-code', 'claude-code', { 'index.js': 'unscoped namesake' });
    pkg(work, 'node_modules/@other/claude-code', '@other/claude-code', { 'index.js': 'other scope' });
    pkg(work, 'node_modules/tsx', 'tsx', { 'dist/cli.mjs': 'tsx' });
    put(work, 'node_modules/.package-lock.json', '{"lockfileVersion":3}');
    // A workspace link is not followed, so a copy behind it is not this tree's to delete.
    pkg(work, 'packages/core', '@interego/core', { 'index.js': 'core' });
    pkg(work, 'packages/core/node_modules/@anthropic-ai/claude-code', '@anthropic-ai/claude-code', { 'cli.js': 'behind a link' });
    link(work, 'node_modules/@interego/core', '../../packages/core');

    link(work, 'node_modules/.bin/claude', '../@anthropic-ai/claude-code/bin/claude.exe');
    link(work, 'node_modules/.bin/claude-code-acp', '../@zed-industries/claude-code-acp/dist/index.js');
    link(work, 'node_modules/.bin/claude-agent-acp', '../@agentclientprotocol/claude-agent-acp/dist/index.js');
    // Left dangling by an earlier, interrupted prune: it still points into a pruned package.
    link(work, 'node_modules/.bin/claude-stale', '../@anthropic-ai/claude-code-linux-arm64/claude');
    link(work, 'node_modules/.bin/tsx', '../tsx/dist/cli.mjs');
    link(work, 'node_modules/.bin/anthropic-ai-sdk', '../@anthropic-ai/sdk/bin/cli');
    link(work, 'node_modules/.bin/core', '../@interego/core/index.js');
    link(work, 'node_modules/some-tool/node_modules/.bin/claude', '../@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');

    before = snapshot(work);
    // Bytes of the regular files under the removed packages, a hard-linked file counted once.
    const inodes = new Set<string>();
    for (const [rel, entry] of before) {
      if (!entry.startsWith('f:') || !removedPackages.some(p => rel.startsWith(`${p}/`))) continue;
      const st = lstatSync(join(work, rel));
      if (inodes.has(`${st.dev}:${st.ino}`)) continue;
      inodes.add(`${st.dev}:${st.ino}`);
      expectedBytes += st.size;
    }
  });
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it('lists the same packages this test does', () => {
    const r = run(['--list'], work);
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(r.out)).toEqual(PRUNE_PATTERNS);
  });

  it('(c) removes exactly the listed packages and their .bin links, and nothing else', () => {
    const r = run([], work);
    expect(r.status, r.out).toBe(0);
    const after = snapshot(work);
    const missing = [...before.keys()].filter(k => !after.has(k));
    expect(missing.filter(k => !missing.some(o => k.startsWith(`${o}/`))).sort()).toEqual([...gone].sort());
    expect([...after.keys()].filter(k => !before.has(k))).toEqual([]);
    for (const [k, v] of after) expect(v, k).toBe(before.get(k));
    // The report names each removal and the bytes they held.
    for (const p of [...removedPackages, ...removedBins]) expect(r.out).toContain(p);
    expect(r.out).toContain(`removed ${removedPackages.length} package(s) and ${removedBins.length} .bin link(s), ${expectedBytes} bytes`);
    expect(expectedBytes).toBeGreaterThan(140_000);
  });

  it('(d) a second run removes nothing, changes nothing and still succeeds', () => {
    const settled = snapshot(work);
    const r = run([], work);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('removed 0 package(s) and 0 .bin link(s), 0 bytes');
    expect(snapshot(work)).toEqual(settled);
  });

  it('takes the node_modules directory as an argument, and a scope it empties goes too', () => {
    const other = mkdtempSync(join(tmpdir(), 'prune-image-dev-tools-'));
    try {
      pkg(other, 'deps/@zed-industries/claude-code-acp', '@zed-industries/claude-code-acp', { 'dist/index.js': 10 });
      pkg(other, 'deps/left-pad', 'left-pad', { 'index.js': 'pad' });
      const r = run([join(other, 'deps')], work);
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(other, 'deps/@zed-industries'))).toBe(false);
      expect(readFileSync(join(other, 'deps/left-pad/index.js'), 'utf8')).toBe('pad');
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it('a node_modules that is not there is an error, not a silent no-op', () => {
    const r = run([join(work, 'no-such-node-modules')], work);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no-such-node-modules');
  });
});
