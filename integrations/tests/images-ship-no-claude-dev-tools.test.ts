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
 * which brings `@anthropic-ai/claude-agent-sdk` (about 113 MB with the two builds of sharp npm
 * nests under it). They are developer tools; no service runs them. The pending switch to
 * `@agentclientprotocol/claude-agent-acp` brings an agent SDK whose platform packages are native
 * binaries of about 290 MB each, two of them on linux x64 (glibc and musl, as its lockfile entries
 * record no libc): about 470 MB more per image than today, unless they are pruned too.
 *
 * `tools/prune-image-dev-tools.mjs` deletes exactly those packages right after `npm ci`, in the
 * SAME `RUN`. The same RUN matters: a later `RUN` that deletes them only adds whiteouts on top of
 * a layer that still holds the bytes, and a single-stage image ships every one of its layers.
 *
 * ── WHAT EACH LEG PINS ───────────────────────────────────────────────────────────────────────
 *
 * (a) Every Dockerfile that installs the root lockfile with devDependencies either prunes in the
 *     same RUN or never lets that node_modules reach the image it builds. Both lists are pinned,
 *     so a parser that silently matched nothing cannot pass. And the parser fails closed for a
 *     Dockerfile nobody has written yet: it reads every form of COPY and of npm install that
 *     Docker and npm accept (globs, `.`, JSON form, `--from` a stage, `VAR=x npm ci`, npm's
 *     aliases, `--prefix`), and an npm install it cannot attribute to a manifest it saw copied,
 *     or to packages the command names, fails the test instead of passing unseen.
 * (b) Nothing deployed needs the packages. The proof is what the images run: no file an image
 *     ships references them except four named developer tools that are copied along with their
 *     directories, and the static import closure of everything a pruned image runs (its CMD and
 *     every script a RUN step executes) reaches none of them and none of those four. That npm
 *     marks them dev-only is NOT that proof, because these images install devDependencies on
 *     purpose and import some at run time (express, n3, jose, tsx). The lockfile leg is a guard
 *     on the list instead: each pruned package is dev-only and only the root's devDependencies or
 *     another of them asks for one, so the list cannot delete what a production dependency needs;
 *     every platform package npm may install for them is on it; and every place npm may nest a
 *     copy is one the script walks.
 * (c) The script removes exactly the listed packages and their .bin links from a fake tree, the
 *     copies npm nested under workspaces included, and leaves everything else byte-for-byte
 *     intact, including `@anthropic-ai/sdk` and `@anthropic-ai/claude-code-sdk`. A copy the
 *     lockfile records where its walk cannot reach fails the run.
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
  '@anthropic-ai/claude-code-<platform>',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk-<platform>',
  '@zed-industries/claude-code-acp',
  '@agentclientprotocol/claude-agent-acp',
] as const;

/**
 * `<platform>` is a platform suffix and nothing else: an os and a cpu as Node's process.platform
 * and process.arch name them, optionally `-musl`. Not any suffix: these images run some root
 * devDependencies, so a runtime library named `@anthropic-ai/claude-code-<anything>` must survive.
 */
const PLATFORM = '(?:aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)'
  + '-(?:arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)(?:-musl)?';

/** The executables those packages put in node_modules/.bin. */
const BIN_NAMES = ['claude', 'claude-code-acp', 'claude-agent-acp'] as const;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** One pattern as a regex body. */
const patternBody = (p: string): string => p.split('<platform>').map(escape).join(PLATFORM);
const NAME = `(?:${PRUNE_PATTERNS.map(patternBody).join('|')})`;
const isPrunedName = (name: string): boolean => new RegExp(`^${NAME}$`).test(name);

// ── The tree, as git tracks it ─────────────────────────────────────────────────────────────────

const git = (...args: string[]): string[] =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
const TRACKED = git('ls-files');
/** Every Dockerfile, whatever its naming: `Dockerfile`, `Dockerfile.x`, `x.Dockerfile`, `Containerfile`. */
const DOCKERFILES = TRACKED.filter(f =>
  /(^|\/)(?:Dockerfile|Containerfile)(?:\.[^/]+)?$|\.(?:Dockerfile|dockerfile|Containerfile)$/.test(f));
/** The files npm installs from. Where each lands in an image is all the analyser follows of a COPY. */
const NPM_INPUTS = TRACKED.filter(f => /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(f));

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
/** A COPY or ADD: its `--flags`, sources and destination, in shell form or JSON form. */
function copyParts(args: string): { flags: string[]; sources: string[]; dest: string } {
  const flags: string[] = [];
  let rest = args.trim();
  for (let m = /^(--\S+)\s+/.exec(rest); m; m = /^(--\S+)\s+/.exec(rest)) {
    flags.push(m[1]!);
    rest = rest.slice(m[0].length);
  }
  let parts = tokens(rest);
  if (rest.startsWith('[')) {
    try { parts = (JSON.parse(rest) as unknown[]).map(String); } catch { /* not JSON after all: words */ }
  }
  return { flags, sources: parts.slice(0, -1), dest: parts[parts.length - 1] ?? '' };
}
const copyFrom = (flags: readonly string[]): string | undefined =>
  flags.map(f => /^--from=(.+)$/.exec(f)?.[1]).find((x): x is string => x !== undefined);

/** The shell command of a RUN or CMD, without `--mount`/`--network` flags; exec form joined. */
function shellOf(args: string): string {
  const trimmed = args.trim();
  if (trimmed.startsWith('[')) {
    try { return (JSON.parse(trimmed) as string[]).join(' '); } catch { return trimmed; }
  }
  return trimmed.replace(/^(?:--\S+\s+)+/, '');
}

/** Shell commands split on `&&`, `||`, `;`, `|` and newlines outside quotes, each with the operator before it. */
function shellSegments(shell: string): { text: string; after: string }[] {
  const out: { text: string; after: string }[] = [];
  let quote = '';
  let current = '';
  let after = '';
  for (let i = 0; i < shell.length; i++) {
    const c = shell[i]!;
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"' && i + 1 < shell.length) current += shell[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    const op = /^(?:&&|\|\||;|\||\n)/.exec(shell.slice(i, i + 2))?.[0];
    if (op) {
      out.push({ text: current, after });
      current = '';
      after = op;
      i += op.length - 1;
      continue;
    }
    current += c;
  }
  out.push({ text: current, after });
  return out;
}

const GLOB = /[*?[]/;
/** A COPY source pattern as Go's filepath.Match reads it: `*` and `?` stop at `/`; `**` is taken to cross it. */
function globRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[' && pattern.indexOf(']', i + 2) > 0) {
      const end = pattern.indexOf(']', i + 2);
      out += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (c === '\\' && i + 1 < pattern.length) out += escape(pattern[++i]!);
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

/**
 * Which of `files` a COPY source takes from the build context (the repository root), each with
 * its path below the destination: `null` when the source named the file itself, so where it
 * lands depends on whether the destination is a directory. A directory source, `.` and a glob
 * that matches a directory copy that directory's contents, as Docker does.
 */
function contextMatches(source: string, files: readonly string[]): { file: string; within: string | null }[] {
  const s = source.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '' || s === '.') return files.map(file => ({ file, within: file }));
  const out: { file: string; within: string | null }[] = [];
  if (GLOB.test(s)) {
    const rx = globRegex(s);
    for (const file of files) {
      const parts = file.split('/');
      for (let k = 1; k <= parts.length; k++) {
        if (!rx.test(parts.slice(0, k).join('/'))) continue;
        out.push({ file, within: k === parts.length ? null : parts.slice(k).join('/') });
        break;
      }
    }
    return out;
  }
  for (const file of files) {
    if (file === s) out.push({ file, within: null });
    else if (file.startsWith(`${s}/`)) out.push({ file, within: file.slice(s.length + 1) });
  }
  return out;
}

const placeAt = (dest: string, within: string | null, name: string, intoDir: boolean): string =>
  within !== null ? posix.join(dest, within) : intoDir ? posix.join(dest, posix.basename(name)) : dest;

/** npm's install commands and every alias npm 10 accepts for them. */
const NPM_INSTALL_VERBS = new Set([
  'ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean',
  'install', 'add', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall',
  'install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit',
]);
/** npm options whose value may follow as the next word. */
const NPM_VALUE_FLAGS = new Set(['--prefix', '-C', '--omit', '--include', '--only', '--workspace', '-w', '--loglevel',
  '--registry', '--cache', '--userconfig', '--globalconfig', '--location', '--install-strategy', '--tag', '--before']);
/** node options whose value follows as the next word. */
const NODE_VALUE_FLAGS = new Set(['--import', '-r', '--require', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C']);

/** What an npm install installs from. */
type InstallKind =
  /** The root package.json or package-lock.json is in the directory it installs. */
  | 'root'
  /** Another package.json or lockfile from the repository is there. */
  | 'other'
  /** `-g`: the packages it names, outside any project. */
  | 'global'
  /** No manifest the analyser saw copied there, but it names what it installs (tarballs, `pg@8`). */
  | 'named'
  /** None of those: the analyser cannot say what this installs, so the test fails until it can. */
  | 'unattributed';

interface NpmInstall {
  readonly line: number;
  /** The npm command, without the environment assignments or wrappers before it. */
  readonly command: string;
  /** The directory it installs, which is where node_modules lands. */
  readonly dir: string;
  readonly stage: Stage;
  readonly kind: InstallKind;
  /** Whether devDependencies are installed: nothing omits them, or `--include=dev` puts them back. */
  readonly keepsDev: boolean;
  /** The package specs it names. */
  readonly named: string[];
  /** The prune script ran later in the same RUN, joined by `&&` or `;`, on this install's node_modules. */
  pruned: boolean;
  /** A `||` or `|` came after the install, so a prune after it does not certainly run once it is done. */
  broken: boolean;
}

/** An install of the ROOT manifests that keeps devDependencies. */
type RootInstall = NpmInstall & { readonly kind: 'root'; readonly keepsDev: true };

interface Analysis {
  readonly dockerfile: string;
  readonly stages: Stage[];
  /** The stage CI builds: images.json's `target`, or the last one. */
  readonly built: Stage;
  /** Every npm install in the file. */
  readonly npm: NpmInstall[];
  /** The ones that install the root manifests with devDependencies. */
  readonly installs: RootInstall[];
}

const IMAGES = (JSON.parse(readFileSync(join(ROOT, 'deploy/images.json'), 'utf8')) as {
  images: { image: string; dockerfile: string; target?: string }[];
}).images;

/** A package spec's name: `@scope/name@1` is `@scope/name`, `pg@8` is `pg`. */
const specName = (spec: string): string =>
  spec.startsWith('@') ? spec.split('@').slice(0, 2).join('@') : spec.split('@')[0]!;

/**
 * Every npm install in a Dockerfile, with what it installs from. The analyser follows where each
 * COPY or ADD puts the repository's package.json, package-lock.json and npm-shrinkwrap.json files
 * (and the prune script), in any form Docker accepts: a literal path, `./path`, a glob, a
 * directory, `.` (the whole context), JSON form, and `--from` an earlier stage. A RUN is split
 * into commands outside quotes; leading `VAR=value` assignments and `env`/`exec`-style wrappers
 * are read past, as are npm's options before the verb; every npm alias of `ci` and `install`
 * counts; `--prefix`/`-C` moves the install. An install counts as pruned only when the script
 * runs after it in the same RUN, joined by `&&` or `;`, on that install's own node_modules.
 */
function analyse(dockerfile: string, text = readFileSync(join(ROOT, dockerfile), 'utf8')): Analysis {
  const stages = parseDockerfile(text);
  const npm: NpmInstall[] = [];
  interface State { workdir: string; manifests: Map<string, string>; omitsDev: boolean; scripts: Set<string> }
  const states = new Map<Stage, State>();
  for (const stage of stages) {
    const parent = stageNamed(stages, stage.base);
    const inherited = parent ? states.get(parent) : undefined;
    const state: State = inherited
      ? { ...inherited, manifests: new Map(inherited.manifests), scripts: new Set(inherited.scripts) }
      : { workdir: '/', manifests: new Map(), omitsDev: false, scripts: new Set() };
    for (const ins of stage.instructions) {
      if (ins.op === 'WORKDIR') state.workdir = posix.resolve(state.workdir, ins.args.trim());
      ins.cwd = state.workdir;
      if (ins.op === 'ENV') {
        const nodeEnv = /\bNODE_ENV[= ]+["']?([\w-]+)/.exec(ins.args);
        if (nodeEnv) state.omitsDev = nodeEnv[1] === 'production';
        if (/\bnpm_config_(?:omit[= ]+["']?[\w,]*dev|production[= ]+["']?true)\b/i.test(ins.args)) state.omitsDev = true;
      } else if (ins.op === 'COPY' || ins.op === 'ADD') {
        const { flags, sources, dest } = copyParts(ins.args);
        const destAbs = posix.resolve(state.workdir, dest);
        const intoDir = dest.endsWith('/') || dest === '.' || sources.length > 1 || sources.some(s => GLOB.test(s))
          || destAbs === state.workdir;
        const from = copyFrom(flags);
        if (from === undefined) {
          for (const source of sources) {
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) continue;
            for (const { file, within } of contextMatches(source, NPM_INPUTS)) state.manifests.set(placeAt(destAbs, within, file, intoDir), file);
            for (const { within } of contextMatches(source, [SCRIPT_PATH])) state.scripts.add(placeAt(destAbs, within, SCRIPT_PATH, intoDir));
          }
        } else {
          // Out of an earlier stage: whatever that stage had at the source path. Out of any other
          // image the analyser knows nothing, so an install that needs it stays unattributed.
          const source = stageNamed(stages, from);
          const known = source ? states.get(source) : undefined;
          for (const raw of known ? sources : []) {
            const abs = posix.resolve('/', raw);
            for (const [path, file] of known!.manifests) {
              const within = path === abs ? null : abs === '/' ? path.slice(1) : path.startsWith(`${abs}/`) ? path.slice(abs.length + 1) : undefined;
              if (within !== undefined) state.manifests.set(placeAt(destAbs, within, path, intoDir), file);
            }
          }
        }
      } else if (ins.op === 'RUN') {
        let cwd = state.workdir;
        const pending: NpmInstall[] = [];
        for (const { text: raw, after } of shellSegments(shellOf(ins.args))) {
          if (after === '||' || after === '|') for (const p of pending) p.broken = true;
          let seg = raw.trim().replace(/^(?:[({!]\s*|(?:then|else|elif|do|if|while|until)\s+)+/, '').replace(/[\s)}]+$/, '').trim();
          const assignments: string[] = [];
          for (let m = /^(?:(?:env|exec|command|time|nice|nohup|sudo)\s+|([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))\s+)/.exec(seg); m;
            m = /^(?:(?:env|exec|command|time|nice|nohup|sudo)\s+|([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))\s+)/.exec(seg)) {
            if (m[1]) assignments.push(m[1]);
            seg = seg.slice(m[0].length);
          }
          const words = tokens(seg);
          const program = posix.basename(words[0] ?? '');
          if (program === 'cd') {
            if (words[1] && words[1] !== '-') cwd = posix.resolve(cwd, words[1]);
          } else if (program === 'npm') {
            const flags: [string, string | true][] = [];
            const positional: string[] = [];
            for (let i = 1; i < words.length; i++) {
              const w = words[i]!;
              if (!w.startsWith('-') || w === '-') positional.push(w);
              else if (w.includes('=')) flags.push([w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]);
              else if (NPM_VALUE_FLAGS.has(w) && i + 1 < words.length) flags.push([w, words[++i]!]);
              else flags.push([w, true]);
            }
            const verb = positional.shift();
            if (!verb || !NPM_INSTALL_VERBS.has(verb)) continue;
            const values = (...names: string[]): (string | true)[] => flags.filter(([n]) => names.includes(n)).map(([, v]) => v);
            const lists = (name: string, item: string): boolean => values(name).some(v => typeof v === 'string' && v.split(',').includes(item));
            const prefix = values('--prefix', '-C').filter((v): v is string => typeof v === 'string').at(-1);
            const dir = prefix === undefined ? cwd : posix.resolve(cwd, prefix);
            const omitsDev = state.omitsDev || lists('--omit', 'dev') || values('--production').some(v => v === true || v === 'true')
              || values('--only').some(v => typeof v === 'string' && /^prod/.test(v))
              || assignments.some(a => /^(?:NODE_ENV=["']?production|npm_config_omit=["']?[\w,]*dev|npm_config_production=["']?true)\b/i.test(a));
            const keepsDev = !omitsDev || lists('--include', 'dev');
            const lock = state.manifests.get(posix.join(dir, 'package-lock.json')) ?? state.manifests.get(posix.join(dir, 'npm-shrinkwrap.json'));
            const manifest = state.manifests.get(posix.join(dir, 'package.json'));
            const global = values('-g', '--global').some(v => v !== 'false') || values('--location').includes('global');
            const kind: InstallKind = global ? 'global'
              : lock === 'package-lock.json' || manifest === 'package.json' ? 'root'
                : lock !== undefined || manifest !== undefined ? 'other'
                  : positional.length ? 'named' : 'unattributed';
            const install: NpmInstall = { line: ins.line, command: seg, dir, stage, kind, keepsDev, named: positional, pruned: false, broken: false };
            npm.push(install);
            if (kind === 'root' && keepsDev) pending.push(install);
          } else if (program === 'node') {
            let i = 1;
            let evaluates = false;
            for (; i < words.length && words[i]!.startsWith('-'); i++) {
              if (/^(?:-e|--eval|-p|--print)$/.test(words[i]!)) evaluates = true;
              if (NODE_VALUE_FLAGS.has(words[i]!)) i++;
            }
            const script = words[i];
            if (evaluates || !script || !state.scripts.has(posix.resolve(cwd, script))) continue;
            const args = words.slice(i + 1);
            if (args.includes('--list')) continue;
            const named = args.filter(a => !a.startsWith('-'));
            const targets = (named.length ? named : ['node_modules']).map(a => posix.resolve(cwd, a));
            for (const p of pending) if (!p.broken && targets.includes(posix.join(p.dir, 'node_modules'))) p.pruned = true;
          }
        }
      }
    }
    states.set(stage, state);
  }
  const target = IMAGES.find(i => i.dockerfile === dockerfile)?.target;
  const built = (target ? stageNamed(stages, target) : undefined) ?? stages[stages.length - 1]!;
  const installs = npm.filter((i): i is RootInstall => i.kind === 'root' && i.keepsDev);
  return { dockerfile, stages, built, npm, installs };
}

/**
 * Does this install's node_modules reach the image? Yes when its stage is the built stage or one
 * that stage is FROM, or when any COPY --from a stage descending from it takes the install
 * directory, its node_modules, or a directory above them.
 */
function shipped(a: Analysis, install: NpmInstall): boolean {
  if (ancestry(a.stages, a.built).includes(install.stage)) return true;
  const nm = `${install.dir}/node_modules`;
  for (const s of a.stages) {
    for (const ins of s.instructions) {
      if (ins.op !== 'COPY') continue;
      const { flags, sources } = copyParts(ins.args);
      const from = copyFrom(flags);
      const source = from === undefined ? undefined : stageNamed(a.stages, from);
      if (!source || !ancestry(a.stages, source).includes(install.stage)) continue;
      for (const raw of sources) {
        const src = posix.resolve(ins.cwd, raw).replace(/\/$/, '') || '/';
        if (src === '/' || src === install.dir || install.dir.startsWith(`${src}/`) || src === nm || src.startsWith(`${nm}/`)) return true;
      }
    }
  }
  return false;
}

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

/** npm installs the analyser cannot attribute to anything: each one fails the test until it can. */
const unattributed = (a: Analysis): string[] => a.npm.filter(i => i.kind === 'unattributed')
  .map(i => `${a.dockerfile}:${i.line} \`${i.command}\` in ${i.dir}: no package.json or lockfile from the repository `
    + 'was seen copied there, and it names no package');

/** Installs that name one of the pruned packages outright. */
const namesPruned = (a: Analysis): string[] => a.npm.filter(i => i.named.some(n => isPrunedName(specName(n))))
  .map(i => `${a.dockerfile}:${i.line} \`${i.command}\``);

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

  it('every npm install in every Dockerfile is placed, so one the parser cannot read fails rather than passes', () => {
    expect(analyses.flatMap(unattributed)).toEqual([]);
    expect(analyses.flatMap(namesPruned)).toEqual([]);
    // Each kind occurs in the tree today, so none of the branches above is dead.
    const kinds = new Set(analyses.flatMap(a => a.npm.map(i => i.kind)));
    expect([...kinds].sort()).toEqual(['global', 'named', 'other', 'root']);
    expect(analyses.flatMap(a => a.npm).length).toBeGreaterThan(20);
  });

  it('reads every Dockerfile an image is built from, however it is named', () => {
    expect(IMAGES.map(i => i.dockerfile).filter(d => !DOCKERFILES.includes(d))).toEqual([]);
    expect(DOCKERFILES).toContain('integrations/pgsl-css-accessor/Dockerfile');
    const names = ['Dockerfile', 'deploy/Dockerfile.x', 'deploy/x.Dockerfile', 'deploy/x.dockerfile', 'x/Containerfile'];
    expect(names.filter(f => /(^|\/)(?:Dockerfile|Containerfile)(?:\.[^/]+)?$|\.(?:Dockerfile|dockerfile|Containerfile)$/.test(f))).toEqual(names);
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

  it('reads every way of copying the root lockfile and of running npm, and of pruning somewhere else', () => {
    const wsp = readFileSync(join(ROOT, 'deploy/Dockerfile.wsp-bridge'), 'utf8');
    const install = `RUN npm ci && node ${SCRIPT_PATH}`;
    const lockCopy = 'COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./';
    expect(wsp).toContain(install);
    expect(wsp).toContain(lockCopy);
    const plain = wsp.replace(install, 'RUN npm ci');
    const count = (text: string): number => unprunedShipped(analyse('deploy/Dockerfile.wsp-bridge', text)).length;
    /** Each of these ships the root devDependencies unpruned, so each must be found exactly once. */
    const unpruned: Record<string, string> = {
      'the literal form': plain,
      'COPY package*.json': plain.replace(lockCopy, 'COPY package*.json tsconfig.base.json tsconfig.json ./'),
      'COPY ./package-lock.json': plain.replace(lockCopy, 'COPY ./package.json ./package-lock.json tsconfig.base.json tsconfig.json ./'),
      'JSON-form COPY': plain.replace(lockCopy, 'COPY ["package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.json", "./"]'),
      'COPY with --chown into the absolute dir': plain.replace(lockCopy, 'COPY --chown=node:node package.json package-lock.json tsconfig.base.json tsconfig.json /app/'),
      'COPY . .': plain.replace(lockCopy, 'COPY . .'),
      'an env-prefixed npm ci': wsp.replace(install, 'RUN NODE_OPTIONS=--max-old-space-size=4096 npm ci'),
      'env before npm': wsp.replace(install, 'RUN env CI=1 npm ci'),
      'npm clean-install': wsp.replace(install, 'RUN npm clean-install'),
      'npm install-clean': wsp.replace(install, 'RUN npm install-clean'),
      'npm isntall': wsp.replace(install, 'RUN npm isntall'),
      'a flag before the verb': wsp.replace(install, 'RUN npm --loglevel=warn ci'),
      'npm ci in a subshell': wsp.replace(install, 'RUN (npm ci)'),
      'npm ci --prefix from elsewhere': wsp.replace(install, 'RUN cd /tmp && npm ci --prefix /app'),
      'dev omitted, then included again': wsp.replace(install, 'RUN npm ci --omit=dev --include=dev'),
      'a prune of another directory': wsp.replace(install, `RUN npm ci && node ${SCRIPT_PATH} /tmp`),
      'a prune from another directory': wsp.replace(install, `RUN npm ci && cd /tmp && node ${SCRIPT_PATH}`),
      'a prune that runs only when npm ci fails': wsp.replace(install, `RUN npm ci || node ${SCRIPT_PATH}`),
      'a prune that only lists': wsp.replace(install, `RUN npm ci && node ${SCRIPT_PATH} --list`),
      'a fresh image that copies the whole context': 'FROM node:22-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["npx", "tsx", "server.ts"]\n',
      'a lockfile carried over from an earlier stage': 'FROM node:22-slim AS manifests\nWORKDIR /src\nCOPY package.json package-lock.json ./\n'
        + 'FROM node:22-slim\nWORKDIR /app\nCOPY --from=manifests /src/ ./\nRUN npm ci\nCMD ["npx", "tsx", "server.ts"]\n',
    };
    expect(Object.fromEntries(Object.entries(unpruned).map(([k, t]) => [k, count(t)])))
      .toEqual(Object.fromEntries(Object.keys(unpruned).map(k => [k, 1])));
    /** And each of these does prune the install it follows. */
    const pruned: Record<string, string> = {
      'the node_modules it installed, named': wsp.replace(install, `RUN npm ci && node ${SCRIPT_PATH} node_modules`),
      'the node_modules it installed, absolute': wsp.replace(install, `RUN npm ci && node ${SCRIPT_PATH} /app/node_modules`),
      'after a semicolon': wsp.replace(install, `RUN npm ci; node ${SCRIPT_PATH}`),
      'with node flags and an env prefix': wsp.replace(install, `RUN NODE_OPTIONS=x npm ci && node --no-warnings ${SCRIPT_PATH}`),
    };
    expect(Object.fromEntries(Object.entries(pruned).map(([k, t]) => [k, count(t)])))
      .toEqual(Object.fromEntries(Object.keys(pruned).map(k => [k, 0])));
    /** An install the analyser cannot place is a failure of its own, not a pass. */
    const unplaced: Record<string, string> = {
      'npm ci with nothing copied': 'FROM node:22-slim\nWORKDIR /app\nRUN npm ci\n',
      'a lockfile out of an image the analyser cannot read': 'FROM node:22-slim\nWORKDIR /app\nCOPY --from=node:22 /srv/package-lock.json ./\nRUN npm ci\n',
      'a lockfile copied to a file of another name': 'FROM node:22-slim\nWORKDIR /srv\nCOPY package-lock.json /app\nWORKDIR /app\nRUN npm ci\n',
    };
    expect(Object.fromEntries(Object.entries(unplaced).map(([k, t]) => [k, unattributed(analyse('deploy/Dockerfile.x', t)).length])))
      .toEqual(Object.fromEntries(Object.keys(unplaced).map(k => [k, 1])));
    expect(namesPruned(analyse('deploy/Dockerfile.css',
      readFileSync(join(ROOT, 'deploy/Dockerfile.css'), 'utf8').replace('@solid/community-server@7', '@anthropic-ai/claude-code@2')))).toHaveLength(1);
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

/**
 * The step-2 scope: what any image ships or runs. Every file any Dockerfile's COPY or ADD takes
 * from the context, read the way (a) reads them (so `.` is the whole tree and a glob is matched),
 * plus the trees named.
 */
function shippedScope(): string[] {
  const named = (f: string): boolean => f.startsWith('deploy/') || f.startsWith('demos/')
    || /^(?:applications\/[^/]+\/(?:bridge|src)\/|packages\/[^/]+\/src\/)/.test(f);
  const copied = new Set<string>();
  for (const d of DOCKERFILES) {
    for (const stage of parseDockerfile(readFileSync(join(ROOT, d), 'utf8'))) {
      for (const ins of stage.instructions) {
        if (ins.op !== 'COPY' && ins.op !== 'ADD') continue;
        const { flags, sources } = copyParts(ins.args);
        if (copyFrom(flags) !== undefined) continue;
        for (const s of sources) for (const { file } of contextMatches(s, TRACKED)) copied.add(file);
      }
    }
  }
  // The prune script names the packages in order to delete them.
  return TRACKED.filter(f => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sh)$/.test(f) && f !== SCRIPT_PATH && (copied.has(f) || named(f)));
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

/**
 * The root lockfile. Read in (b) as a guard on the LIST, not as the safety argument: these images
 * install devDependencies on purpose and import some at run time (express, n3, jose and tsx are
 * root devDependencies), so dev-only says nothing about whether a service runs a package. What
 * says that is the shipped-file scan and the import closures below.
 */
type LockEntry = { dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
const LOCK = (JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> }).packages;
const nameOf = (loc: string): string => loc.replace(/^.*node_modules\//, '');

describe('(b) nothing deployed needs the pruned packages', () => {
  it('the list cannot delete a production dependency: each is dev-only, and only the root devDependencies or each other ask for one', () => {
    const underPruned = (loc: string): boolean =>
      loc.split('node_modules/').slice(1).map(p => p.replace(/\/$/, '')).slice(0, -1).some(isPrunedName);
    const isPrunedLoc = (loc: string): boolean => loc.includes('node_modules/') && (isPrunedName(nameOf(loc)) || underPruned(loc));
    // The lockfile has them today; if it ever did not, the rest of this leg would check nothing.
    expect(Object.keys(LOCK).filter(loc => loc.includes('node_modules/') && isPrunedName(nameOf(loc))).length).toBeGreaterThan(5);
    const notDev = Object.entries(LOCK).filter(([loc, p]) => isPrunedLoc(loc) && p.dev !== true).map(([loc]) => loc);
    expect(notDev, 'locked without dev:true, so npm says something in production needs it').toEqual([]);
    // A workspace's devDependency counts too: npm installs it in these images, and may nest its
    // own copy under that workspace.
    const askers: string[] = [];
    for (const [loc, p] of Object.entries(LOCK)) {
      if (isPrunedLoc(loc)) continue;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
        if (loc === '' && field === 'devDependencies') continue;
        for (const dep of Object.keys(p[field] ?? {})) if (isPrunedName(dep)) askers.push(`${loc || '(root)'} ${field} ${dep}`);
      }
    }
    expect(askers).toEqual([]);
  });

  it('every platform package npm may install for them is on the list, and every copy npm may place is one the script walks', () => {
    // The suffix is narrow on purpose, so a platform npm adds must be one it covers.
    const platforms: string[] = [];
    for (const [loc, p] of Object.entries(LOCK)) {
      const name = nameOf(loc);
      if (!loc.includes('node_modules/') || !isPrunedName(name)) continue;
      for (const dep of Object.keys(p.optionalDependencies ?? {})) if (dep.startsWith(`${name}-`)) platforms.push(dep);
    }
    expect(platforms.length, 'the CLI lists its platform packages; if it stopped, this checks nothing').toBeGreaterThanOrEqual(8);
    expect(platforms.filter(d => !isPrunedName(d))).toEqual([]);
    // npm nests a copy under a workspace (a lockfile location outside node_modules) when its version
    // conflicts with the root's. The script walks the root node_modules and each of those.
    const packageDirs = Object.keys(LOCK).filter(l => l !== '' && !l.split('/').includes('node_modules'));
    expect(packageDirs).toContain('applications/foxxi-content-intelligence/bridge');
    const unwalked = Object.keys(LOCK).filter(l => l.includes('node_modules/') && isPrunedName(nameOf(l)))
      .filter(l => !l.startsWith('node_modules/') && !packageDirs.some(d => l.startsWith(`${d}/node_modules/`)));
    expect(unwalked).toEqual([]);
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
    // The platform suffix is a platform and nothing else.
    expect(['@anthropic-ai/claude-code-linux-x64', '@anthropic-ai/claude-code-linux-arm64-musl', '@anthropic-ai/claude-code-win32-x64',
      '@anthropic-ai/claude-agent-sdk-darwin-arm64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl'].filter(n => !isPrunedName(n))).toEqual([]);
    expect(['@anthropic-ai/claude-code-sdk', '@anthropic-ai/claude-code-router', '@anthropic-ai/claude-code-linux',
      '@anthropic-ai/claude-agent-sdk-tools', '@anthropic-ai/claude-agent-sdk-linux-x64-extra'].filter(isPrunedName)).toEqual([]);
    expect(offences(`import { query } from '@anthropic-ai/claude-code-sdk';`)).toEqual([]);
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
    // Copies npm nested under workspaces, which the lockfile records and the script reaches through it.
    'packages/core/node_modules/@anthropic-ai/claude-code',
    'applications/demo/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64',
  ];
  const removedBins = [
    'node_modules/.bin/claude', 'node_modules/.bin/claude-code-acp', 'node_modules/.bin/claude-agent-acp',
    'node_modules/.bin/claude-stale', 'node_modules/some-tool/node_modules/.bin/claude',
    'packages/core/node_modules/.bin/claude', 'applications/demo/bridge/node_modules/.bin/claude-code-acp',
  ];
  /** What disappears, outermost path only: a nested copy that was alone in its scope took the scope with it. */
  const gone = [
    ...removedPackages.filter(p => !p.startsWith('node_modules/some-tool/') && !p.startsWith('packages/core/')),
    'node_modules/some-tool/node_modules/@anthropic-ai',
    'packages/core/node_modules/@anthropic-ai',
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
    // Not a platform suffix, so not on the list: names a runtime library could plausibly have.
    pkg(work, 'node_modules/@anthropic-ai/claude-code-sdk', '@anthropic-ai/claude-code-sdk', { 'index.js': 'a library' });
    pkg(work, 'node_modules/@anthropic-ai/claude-agent-sdk-tools', '@anthropic-ai/claude-agent-sdk-tools', { 'index.js': 'tools' });
    put(work, 'node_modules/.package-lock.json', '{"lockfileVersion":3}');
    // Workspaces, each with a copy npm nested under it; the links to them are not followed, the
    // lockfile names them. A kept package shares the bridge's scope.
    pkg(work, 'packages/core', '@interego/core', { 'index.js': 'core' });
    pkg(work, 'packages/core/node_modules/@anthropic-ai/claude-code', '@anthropic-ai/claude-code', { 'cli.js': 'nested in a workspace' });
    link(work, 'node_modules/@interego/core', '../../packages/core');
    pkg(work, 'applications/demo/bridge', '@interego/demo-bridge', { 'server.js': 'bridge' });
    pkg(work, 'applications/demo/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64', { claude: 20_000 });
    pkg(work, 'applications/demo/bridge/node_modules/@anthropic-ai/sdk', '@anthropic-ai/sdk', { 'index.js': 'kept' });
    pkg(work, 'applications/demo/bridge/node_modules/express', 'express', { 'index.js': 'kept' });
    link(work, 'node_modules/@interego/demo-bridge', '../../applications/demo/bridge');
    // A linked package the lockfile does not know: what lies behind it is not this tree's to delete.
    pkg(work, 'vendor/linked-tool', 'linked-tool', { 'index.js': 'linked' });
    pkg(work, 'vendor/linked-tool/node_modules/@anthropic-ai/claude-code', '@anthropic-ai/claude-code', { 'cli.js': 'behind a link' });
    link(work, 'node_modules/linked-tool', '../vendor/linked-tool');
    put(work, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
      '': { name: 'fake-root', workspaces: ['packages/*', 'applications/*/bridge'] },
      'packages/core': { name: '@interego/core' },
      'applications/demo/bridge': { name: '@interego/demo-bridge' },
      'node_modules/@interego/core': { resolved: 'packages/core', link: true },
      'node_modules/@interego/demo-bridge': { resolved: 'applications/demo/bridge', link: true },
      'node_modules/@anthropic-ai/claude-code': { dev: true },
      'node_modules/@anthropic-ai/claude-code-linux-x64': { dev: true, optional: true },
      'node_modules/@anthropic-ai/claude-code-linux-arm64': { dev: true, optional: true },
      'packages/core/node_modules/@anthropic-ai/claude-code': { dev: true },
      'applications/demo/bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64': { dev: true, optional: true },
    } }, null, 2));

    link(work, 'node_modules/.bin/claude', '../@anthropic-ai/claude-code/bin/claude.exe');
    link(work, 'node_modules/.bin/claude-code-acp', '../@zed-industries/claude-code-acp/dist/index.js');
    link(work, 'node_modules/.bin/claude-agent-acp', '../@agentclientprotocol/claude-agent-acp/dist/index.js');
    // Left dangling by an earlier, interrupted prune: it still points into a pruned package.
    link(work, 'node_modules/.bin/claude-stale', '../@anthropic-ai/claude-code-linux-arm64/claude');
    link(work, 'node_modules/.bin/tsx', '../tsx/dist/cli.mjs');
    link(work, 'node_modules/.bin/anthropic-ai-sdk', '../@anthropic-ai/sdk/bin/cli');
    link(work, 'node_modules/.bin/core', '../@interego/core/index.js');
    link(work, 'node_modules/some-tool/node_modules/.bin/claude', '../@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
    link(work, 'packages/core/node_modules/.bin/claude', '../@anthropic-ai/claude-code/cli.js');
    // A workspace's link up into the root's copy.
    link(work, 'applications/demo/bridge/node_modules/.bin/claude-code-acp', '../../../../../node_modules/@zed-industries/claude-code-acp/dist/index.js');

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
    expect(r.out).toContain('from 3 node_modules directories');
    expect(expectedBytes).toBeGreaterThan(160_000);
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
      pkg(other, 'deps/node_modules/@zed-industries/claude-code-acp', '@zed-industries/claude-code-acp', { 'dist/index.js': 10 });
      pkg(other, 'deps/node_modules/left-pad', 'left-pad', { 'index.js': 'pad' });
      const r = run([join(other, 'deps/node_modules')], work);
      expect(r.status, r.out).toBe(0);
      expect(existsSync(join(other, 'deps/node_modules/@zed-industries'))).toBe(false);
      expect(readFileSync(join(other, 'deps/node_modules/left-pad/index.js'), 'utf8')).toBe('pad');
      expect(r.out).toContain('from 1 node_modules directory');
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it('a node_modules that is not there, or a directory that is not one, is an error, not a silent no-op', () => {
    const missing = run([join(work, 'no-such-node-modules')], work);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain('no-such-node-modules');
    // `node tools/prune-image-dev-tools.mjs /tmp` exits 0 having pruned nothing of the image's.
    const elsewhere = run([join(work, 'packages')], work);
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.out).toContain('not a node_modules directory');
  });

  it('fails, naming it, when a copy the lockfile records is still on disk where the walk does not reach', () => {
    const other = mkdtempSync(join(tmpdir(), 'prune-image-dev-tools-'));
    try {
      pkg(other, 'vendor/linked/node_modules/@anthropic-ai/claude-code', '@anthropic-ai/claude-code', { 'cli.js': 'behind a link' });
      link(other, 'node_modules/linked', '../vendor/linked');
      put(other, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'r' }, 'node_modules/linked/node_modules/@anthropic-ai/claude-code': { dev: true } } }));
      const r = run([], other);
      expect(r.status).toBe(3);
      expect(r.out).toContain('node_modules/linked/node_modules/@anthropic-ai/claude-code is recorded in the lockfile and still on disk');
      // Not followed, so not deleted: the run fails instead of reaching through the link.
      expect(existsSync(join(other, 'vendor/linked/node_modules/@anthropic-ai/claude-code/cli.js'))).toBe(true);
      // A lockfile it cannot read is an error too.
      put(other, 'package-lock.json', '{"lockfileVersion":1,"dependencies":{}}');
      const old = run([], other);
      expect(old.status).toBe(2);
      expect(old.out).toContain('no "packages" map');
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
