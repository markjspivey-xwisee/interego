/**
 * Delete the Claude developer tools from an image's node_modules, right after `npm ci`.
 *
 * ── WHY AN IMAGE HAS THEM ────────────────────────────────────────────────────────────────────
 *
 * Nine images (the vertical bridges, the substrate demo bridge and the Discord bot) run a plain
 * `npm ci` against the ROOT lockfile and must keep its devDependencies, because they run their
 * service with `npx tsx` and tsx is a root devDependency. Every other root devDependency comes
 * along, and the largest are developer tools no service runs: the Claude Code CLI, whose platform
 * package is a native binary of about 214 MB, and the ACP agent with the agent SDK it pulls in,
 * about 113 MB with the two builds of sharp npm nests under it. The ACP agent's successor brings
 * an agent SDK whose platform packages are native binaries of about 290 MB each, and on linux x64
 * npm installs two of them, glibc and musl, because its lockfile entries record no libc.
 *
 * ── WHAT IT DELETES ──────────────────────────────────────────────────────────────────────────
 *
 * Exactly the packages named in PRUNE_PATTERNS, wherever npm put them: anywhere under the
 * node_modules it is given (a copy nested under another package is the same package), and under
 * the node_modules of every package directory the lockfile beside it records outside
 * node_modules. Those are the workspaces, where npm nests a copy whose version conflicts with the
 * root's. It also deletes the node_modules/.bin links that point into them, including links left
 * dangling by an earlier run.
 *
 * `<platform>` is a platform suffix and nothing else: an os and a cpu as Node names them
 * (process.platform, process.arch), optionally `-musl`, such as `linux-x64` or `linux-x64-musl`.
 * So `@anthropic-ai/claude-code-<platform>` never matches `@anthropic-ai/claude-code-sdk`,
 * `@anthropic-ai/sdk` or `@anthropic-ai/claude-codex`. That matters here more than usual: these
 * images run some root devDependencies, so a runtime library with such a name, added as a
 * devDependency, must not be deleted.
 *
 * Symbolic links to directories are not followed. A workspace is reached at its own path through
 * the lockfile, not through its link in node_modules.
 *
 * Then it checks that no location the lockfile records for a pruned package is still on disk,
 * and fails if one is, naming it: a copy the walk could not reach would otherwise ship unseen.
 *
 * ── WHY IT IS SAFE ───────────────────────────────────────────────────────────────────────────
 *
 * Because nothing those images run uses them. `integrations/tests/images-ship-no-claude-dev-tools.test.ts`
 * follows the static imports from each image's CMD and from every script a RUN step executes, and
 * scans every file any image copies: none reaches these packages or starts their executables.
 *
 * That npm marks them dev-only is not the reason. These images install devDependencies on purpose
 * and import some at run time (express, n3, jose and tsx are root devDependencies), so being
 * dev-only says nothing about whether a service needs a package. The same test checks the
 * lockfile for a narrower thing: every one of these packages is dev-only, and only the root's
 * devDependencies or another of them asks for one, so this list cannot delete something a
 * production dependency needs. It also checks that every image installing the root lockfile with
 * devDependencies runs this script in the same RUN as its `npm ci`, or never ships that
 * node_modules.
 *
 * ── WHY THE SAME RUN ─────────────────────────────────────────────────────────────────────────
 *
 * A later RUN that deletes files only writes whiteouts over a layer that still holds them, and a
 * single-stage image ships every layer. Only a delete in the layer that installed them saves the
 * bytes.
 *
 * Idempotent: a package that is not there is simply not removed. It fails when the directory it
 * was given does not exist or is not named node_modules (it was pointed at the wrong place, and
 * would otherwise report success having pruned nothing), when the lockfile beside it cannot be
 * read, and when a recorded copy survives.
 *
 *   node tools/prune-image-dev-tools.mjs [node_modules-dir ...]   (default: ./node_modules)
 *   node tools/prune-image-dev-tools.mjs --list                    (the patterns, as JSON)
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The packages to delete. `<platform>` stands for a platform suffix (see PLATFORM). */
export const PRUNE_PATTERNS = Object.freeze([
  // The Claude Code CLI, and its per-platform native binaries.
  '@anthropic-ai/claude-code',
  '@anthropic-ai/claude-code-<platform>',
  // The Claude Agent SDK, and (from 0.3) its per-platform native binaries.
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk-<platform>',
  // The ACP agents that wrap them: the deprecated name, and the one it was renamed to.
  '@zed-industries/claude-code-acp',
  '@agentclientprotocol/claude-agent-acp',
]);

/** A platform suffix: an os and a cpu as Node's process.platform and process.arch name them, optionally `-musl`. */
export const PLATFORM = '(?:aix|android|darwin|freebsd|linux|netbsd|openbsd|sunos|win32)'
  + '-(?:arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)(?:-musl)?';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PRUNED = new RegExp(`^(?:${PRUNE_PATTERNS.map((p) => p.split('<platform>').map(escape).join(PLATFORM)).join('|')})$`);

/** Is this package name one to delete? */
export function isPruned(name) {
  return PRUNED.test(name);
}

/** Bytes of the regular files under `path`, links not followed, a hard-linked file counted once. */
function bytesUnder(path, inodes) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) {
    const key = `${st.dev}:${st.ino}`;
    if (inodes.has(key)) return 0;
    inodes.add(key);
    return st.size;
  }
  let total = 0;
  for (const entry of readdirSync(path)) total += bytesUnder(join(path, entry), inodes);
  return total;
}

/** The first pruned package a path lies inside, at any node_modules level, or null. */
function prunedOwner(path) {
  const parts = path.split(sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'node_modules') continue;
    const name = parts[i + 1].startsWith('@') ? (parts[i + 2] ? `${parts[i + 1]}/${parts[i + 2]}` : null) : parts[i + 1];
    if (name && isPruned(name)) return name;
  }
  return null;
}

/** Is there anything at `path`? A link counts, dangling or not; links on the way to it are followed. */
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A directory and not a link to one. */
function realDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the lockfile beside `nodeModules` records, or null when there is none: the package
 * directories outside node_modules (workspaces, and any `file:` package inside the tree), and
 * every location of a pruned package. Throws when it is there but unreadable.
 */
export function lockfileBeside(nodeModules) {
  const root = dirname(nodeModules);
  const path = join(root, 'package-lock.json');
  if (!existsSync(path)) return null;
  const packages = JSON.parse(readFileSync(path, 'utf8')).packages;
  if (!packages || typeof packages !== 'object') throw new Error(`${path} has no "packages" map (lockfileVersion 2 or later is needed)`);
  const locations = Object.keys(packages);
  return {
    root,
    packageDirs: locations.filter((l) => l !== '' && !l.split('/').includes('node_modules') && !l.startsWith('../') && !l.startsWith('/')),
    pruned: locations.filter((l) => l.includes('node_modules/') && isPruned(l.slice(l.lastIndexOf('node_modules/') + 'node_modules/'.length))),
  };
}

/**
 * Delete every pruned package under `nodeModules`, and under each workspace's node_modules the
 * lockfile beside it records, and every .bin link into one. Returns what went, with the bytes
 * each package held, the directories it walked, and any recorded copy still on disk.
 */
export function prune(nodeModules) {
  const packages = [];
  const bins = [];
  const inodes = new Set();

  const remove = (path, name) => {
    const st = lstatSync(path);
    const bytes = bytesUnder(path, inodes);
    if (st.isSymbolicLink()) unlinkSync(path);
    else rmSync(path, { recursive: true, force: true });
    packages.push({ name, path, bytes });
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        if (!entry.isDirectory()) continue;
        const scope = join(dir, entry.name);
        let removedHere = false;
        for (const sub of readdirSync(scope, { withFileTypes: true })) {
          const name = `${entry.name}/${sub.name}`;
          if (isPruned(name)) {
            remove(join(scope, sub.name), name);
            removedHere = true;
          } else if (sub.isDirectory()) walk(join(scope, sub.name, 'node_modules'));
        }
        if (removedHere && readdirSync(scope).length === 0) rmdirSync(scope);
      } else if (isPruned(entry.name)) {
        remove(join(dir, entry.name), entry.name);
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name, 'node_modules'));
      }
    }
    // The executables: any link whose target lies in a pruned package, there or not.
    const binDir = join(dir, '.bin');
    let links;
    try {
      links = readdirSync(binDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const link of links) {
      if (!link.isSymbolicLink()) continue;
      const path = join(binDir, link.name);
      const target = readlinkSync(path);
      if (prunedOwner(resolve(binDir, target))) {
        unlinkSync(path);
        bins.push({ path, target });
      }
    }
  };

  const lock = lockfileBeside(nodeModules);
  const walked = [nodeModules];
  walk(nodeModules);
  for (const dir of lock?.packageDirs ?? []) {
    const nm = join(lock.root, dir, 'node_modules');
    if (!realDirectory(nm)) continue;
    walk(nm);
    walked.push(nm);
  }
  const survivors = (lock?.pruned ?? []).filter((loc) => present(join(lock.root, loc)));
  return { packages, bins, bytes: packages.reduce((sum, p) => sum + p.bytes, 0), walked, survivors };
}

const human = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(1)} kB`);

function main(argv) {
  if (argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(PRUNE_PATTERNS)}\n`);
    return 0;
  }
  const dirs = argv.length ? argv : ['node_modules'];
  const shown = (p) => relative(process.cwd(), p) || '.';
  let status = 0;
  for (const dir of dirs) {
    const nodeModules = resolve(dir);
    if (!realDirectory(nodeModules) || basename(nodeModules) !== 'node_modules') {
      process.stderr.write(`prune-image-dev-tools: ${dir} is not a node_modules directory; nothing was pruned\n`);
      status = 2;
      continue;
    }
    let result;
    try {
      result = prune(nodeModules);
    } catch (error) {
      process.stderr.write(`prune-image-dev-tools: ${dir}: ${error instanceof Error ? error.message : error}\n`);
      status = 2;
      continue;
    }
    for (const p of result.packages) process.stdout.write(`  removed ${shown(p.path)} (${p.bytes} bytes)\n`);
    for (const b of result.bins) process.stdout.write(`  removed ${shown(b.path)} -> ${b.target}\n`);
    process.stdout.write(`prune-image-dev-tools: ${shown(nodeModules)}: removed ${result.packages.length} package(s) and `
      + `${result.bins.length} .bin link(s), ${result.bytes} bytes (${human(result.bytes)}), `
      + `from ${result.walked.length} node_modules director${result.walked.length === 1 ? 'y' : 'ies'}\n`);
    for (const loc of result.survivors) {
      process.stderr.write(`prune-image-dev-tools: ${loc} is recorded in the lockfile and still on disk, where this walk `
        + 'does not reach (behind a link?); delete it or teach the script where it is\n');
      status = 3;
    }
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
