/**
 * Delete the Claude developer tools from an image's node_modules, right after `npm ci`.
 *
 * ── WHY AN IMAGE HAS THEM ────────────────────────────────────────────────────────────────────
 *
 * Nine images (the vertical bridges, the substrate demo bridge and the Discord bot) run a plain
 * `npm ci` against the ROOT lockfile and must keep its devDependencies, because they run their
 * service with `npx tsx` and tsx is a root devDependency. Every other root devDependency comes
 * along, and the largest are developer tools no service runs: the Claude Code CLI, whose platform
 * package is a native binary of about 214 MB, and the ACP agent with the agent SDK it pulls in.
 * The ACP agent's successor brings an agent SDK whose own platform package is another native
 * binary of about 294 MB.
 *
 * ── WHAT IT DELETES ──────────────────────────────────────────────────────────────────────────
 *
 * Exactly the packages named in PRUNE_PATTERNS, wherever npm put them in the tree (a copy nested
 * under another package is the same package), and the node_modules/.bin links that point into
 * them, including links left dangling by an earlier run. `*` matches one platform suffix, so
 * `@anthropic-ai/claude-code-*` is `@anthropic-ai/claude-code-linux-x64` and never
 * `@anthropic-ai/sdk` or `@anthropic-ai/claude-codex`. Symbolic links to directories (workspace
 * packages) are not followed: what lies behind them is not this tree's to delete.
 *
 * ── WHY IT IS SAFE ───────────────────────────────────────────────────────────────────────────
 *
 * npm marks every one of these packages `dev: true` in the lockfile, nothing but another of them
 * or a root devDependency depends on them, and nothing any of those images runs imports them or
 * spawns their executables. `integrations/tests/images-ship-no-claude-dev-tools.test.ts` checks
 * all three, and that every image installing the root lockfile with devDependencies either runs
 * this script in the same RUN as its `npm ci` or never ships that node_modules.
 *
 * ── WHY THE SAME RUN ─────────────────────────────────────────────────────────────────────────
 *
 * A later RUN that deletes files only writes whiteouts over a layer that still holds them, and a
 * single-stage image ships every layer. Only a delete in the layer that installed them saves the
 * bytes.
 *
 * Idempotent: a package that is not there is simply not removed. It fails only when the
 * node_modules directory it was given does not exist, which means it was pointed at the wrong
 * place and would otherwise report success having pruned nothing.
 *
 *   node tools/prune-image-dev-tools.mjs [node_modules-dir ...]   (default: ./node_modules)
 *   node tools/prune-image-dev-tools.mjs --list                    (the patterns, as JSON)
 */

import { lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The packages to delete. `*` stands for one platform suffix such as `linux-x64-musl`. */
export const PRUNE_PATTERNS = Object.freeze([
  // The Claude Code CLI, and its per-platform native binaries.
  '@anthropic-ai/claude-code',
  '@anthropic-ai/claude-code-*',
  // The Claude Agent SDK, and (from 0.3) its per-platform native binaries.
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk-*',
  // The ACP agents that wrap them: the deprecated name, and the one it was renamed to.
  '@zed-industries/claude-code-acp',
  '@agentclientprotocol/claude-agent-acp',
]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PRUNED = new RegExp(`^(?:${PRUNE_PATTERNS.map((p) => p.split('*').map(escape).join('[a-z0-9][a-z0-9-]*')).join('|')})$`);

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

/** The package a path inside `nodeModules` belongs to, or null when it lies outside it. */
function packageOf(nodeModules, path) {
  const rel = relative(nodeModules, path).split(sep);
  if (!rel[0] || rel[0] === '..' || rel[0] === '.bin') return null;
  return rel[0].startsWith('@') ? (rel[1] ? `${rel[0]}/${rel[1]}` : null) : rel[0];
}

/**
 * Delete every pruned package under `nodeModules` and every .bin link into one.
 * Returns what went, with the bytes each package held.
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
      const owner = packageOf(dir, resolve(binDir, target));
      if (owner && isPruned(owner)) {
        unlinkSync(path);
        bins.push({ path, target });
      }
    }
  };

  walk(nodeModules);
  return { packages, bins, bytes: packages.reduce((sum, p) => sum + p.bytes, 0) };
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
    let isDir = false;
    try {
      isDir = lstatSync(nodeModules).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      process.stderr.write(`prune-image-dev-tools: ${dir} is not a directory; nothing was pruned\n`);
      status = 2;
      continue;
    }
    const result = prune(nodeModules);
    for (const p of result.packages) process.stdout.write(`  removed ${shown(p.path)} (${p.bytes} bytes)\n`);
    for (const b of result.bins) process.stdout.write(`  removed ${shown(b.path)} -> ${b.target}\n`);
    process.stdout.write(`prune-image-dev-tools: ${shown(nodeModules)}: removed ${result.packages.length} package(s) and `
      + `${result.bins.length} .bin link(s), ${result.bytes} bytes (${human(result.bytes)})\n`);
  }
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
