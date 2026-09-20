/**
 * Repository inventory and the deterministic half of every judgment.
 *
 * Everything here is code, not model: file listing, test detection, sensitive-path rules,
 * git diffs, and the import graph. The judgment modules hand Jev only what code cannot
 * decide (which of these files a sentence is about), and combine its answer with what code
 * already knows (which tests import the changed file).
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface RepoFile {
  readonly id: string;
  readonly path: string;
  /** First meaningful line of the file (a header comment or heading), when read. */
  readonly head?: string;
  readonly isTest: boolean;
  readonly isDoc: boolean;
}

export interface RepoInventory {
  readonly root: string;
  readonly name: string;
  readonly commit: string | null;
  readonly files: readonly RepoFile[];
}

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|json|md|mdx|ttl|trig|yml|yaml|toml|txt|html|css|py|sh|ps1|mjs|sql|graphql|jsonld|xml)$/i;
const EXCLUDE = /(^|\/)(node_modules|dist|build|coverage|\.git|vendor|\.jev-harness|package-lock\.json)(\/|$)/;

export const TEST_PATTERNS: readonly RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)checks\/.*\.check\.[cm]?[jt]s$/,
  /(^|\/)__tests__\//,
];
export const DOC_PATTERNS: readonly RegExp[] = [/\.(md|mdx)$/i];

/** Paths whose change always warrants a human and the whole suite. */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /auth/i, /sign(ing|ature|ed)?[-_./]/i, /\bacl\b/i, /abac/i, /crypto/i, /jwt/i, /jws/i, /\bkeys?[-_./]/i, /secret/i,
  /password/i, /token/i, /passkey/i, /oauth/i, /delegation/i, /credential/i,
  /(^|\/)\.github\/workflows\//, /^deploy\//, /Dockerfile/, /(^|\/)package\.json$/, /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)vitest\.config\./, /\.env/,
];

export function isTestPath(path: string): boolean { return TEST_PATTERNS.some((re) => re.test(path)); }
export function isDocPath(path: string): boolean { return DOC_PATTERNS.some((re) => re.test(path)); }
export function isSensitivePath(path: string): boolean { return SENSITIVE_PATTERNS.some((re) => re.test(path)); }

export function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

export interface InventoryOptions {
  readonly scope?: string;
  readonly includeHeads?: boolean;
  readonly maxFiles?: number;
}

export function inventory(rootPath: string, opts: InventoryOptions = {}): RepoInventory {
  const root = resolve(rootPath);
  if (!existsSync(root)) throw new Error(`repository root does not exist: ${root}`);
  const scope = opts.scope ? opts.scope.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '') : '';
  let paths = listPaths(root);
  if (scope) paths = paths.filter((p) => p === scope || p.startsWith(`${scope}/`));
  paths = paths.filter((p) => TEXT_EXT.test(p) && !EXCLUDE.test(p));
  if (opts.maxFiles && paths.length > opts.maxFiles) paths = paths.slice(0, opts.maxFiles);
  const files: RepoFile[] = paths.map((path, i) => {
    const base = { id: `F${String(i).padStart(4, '0')}`, path, isTest: isTestPath(path), isDoc: isDocPath(path) };
    if (opts.includeHeads) {
      const head = readHead(join(root, path));
      return head ? { ...base, head } : base;
    }
    return base;
  });
  const commit = git(root, ['rev-parse', 'HEAD'])?.trim() ?? null;
  return { root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root, commit, files };
}

function listPaths(root: string): string[] {
  const tracked = git(root, ['ls-files', '-z']);
  if (tracked !== null) {
    return tracked.split('\0').filter((p) => p.length > 0).map((p) => p.replace(/\\/g, '/')).sort();
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(root, full).split(sep).join('/');
      if (EXCLUDE.test(rel)) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

/** The first non-boilerplate line of a file, trimmed to 160 characters. */
export function readHead(fullPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(fullPath, 'r');
    const buf = Buffer.alloc(1200);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/|#|@prefix.*)\s?/, '').trim();
      if (!line) continue;
      if (/^(import|export|const|let|var|function|class|use strict|\{|\}|\[|\]|"|'|@)/.test(line)) continue;
      if (line.length < 8) continue;
      return line.slice(0, 160);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Files changed between refs (three-dot when both given) or in the working tree vs base. */
export function changedFiles(root: string, baseRef: string, headRef?: string): string[] {
  const range = headRef ? `${baseRef}...${headRef}` : baseRef;
  const out = git(root, ['diff', '--name-only', '--diff-filter=ACMRD', range]);
  const listed = (out ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!headRef) {
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard']) ?? '';
    for (const u of untracked.split('\n').map((s) => s.trim()).filter(Boolean)) if (!listed.includes(u)) listed.push(u);
  }
  return listed.map((p) => p.replace(/\\/g, '/'));
}

export function unifiedDiff(root: string, baseRef: string, headRef?: string): string {
  const range = headRef ? `${baseRef}...${headRef}` : baseRef;
  return git(root, ['diff', '--no-color', '--unified=3', range]) ?? '';
}

/** Paths named in a unified diff's `diff --git a/x b/y` headers. */
export function pathsInDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const after = m[2];
    if (after) out.add(after.trim());
  }
  return [...out];
}

/** Test files deleted by a diff (a review-gate signal). */
export function deletedTestsInDiff(diff: string): string[] {
  const out: string[] = [];
  const blocks = diff.split(/^diff --git /m);
  for (const block of blocks) {
    const header = block.split('\n')[0] ?? '';
    const m = /a\/(.+?) b\/(.+)$/.exec(header);
    if (!m || !m[1]) continue;
    if (/^deleted file mode/m.test(block) && isTestPath(m[1])) out.push(m[1]);
  }
  return out;
}

// ── Import graph ──────────────────────────────────────────────────────────────

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx'];

/** For each source file, the repository-relative files it imports (relative specifiers only). */
export function importGraph(root: string, files: readonly RepoFile[]): Map<string, Set<string>> {
  const known = new Set(files.map((f) => f.path));
  const graph = new Map<string, Set<string>>();
  for (const f of files) {
    if (!/\.[cm]?[jt]sx?$/.test(f.path)) continue;
    let text: string;
    try { text = readFileSync(join(root, f.path), 'utf8'); } catch { continue; }
    const deps = new Set<string>();
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || !spec.startsWith('.')) continue;
      const target = resolveSpecifier(f.path, spec, known);
      if (target) deps.add(target);
    }
    graph.set(f.path, deps);
  }
  return graph;
}

function resolveSpecifier(fromPath: string, spec: string, known: Set<string>): string | undefined {
  const base = normalizeJoin(dirname(fromPath), spec);
  const candidates: string[] = [base];
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  if (stripped !== base) candidates.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`);
  for (const ext of RESOLVE_EXT) candidates.push(`${base}${ext}`);
  for (const ext of RESOLVE_EXT) candidates.push(`${base}/index${ext}`);
  return candidates.find((c) => known.has(c));
}

function normalizeJoin(dir: string, spec: string): string {
  const parts = (dir === '.' ? [] : dir.split('/')).concat(spec.split('/'));
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Tests that import any changed file within `hops` import steps (reverse traversal). */
export function testsImporting(changed: readonly string[], graph: Map<string, Set<string>>, hops = 2): string[] {
  const reverse = new Map<string, Set<string>>();
  for (const [from, deps] of graph) {
    for (const dep of deps) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep)!.add(from);
    }
  }
  let frontier = new Set(changed);
  const seen = new Set(changed);
  const tests = new Set<string>();
  for (let hop = 0; hop < hops; hop += 1) {
    const next = new Set<string>();
    for (const node of frontier) {
      for (const importer of reverse.get(node) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (isTestPath(importer)) tests.add(importer);
        else next.add(importer);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return [...tests].sort();
}

/** Top-level grouping used when a candidate set exceeds a Choice's option limit. */
export function groupByPrefix(files: readonly RepoFile[], depth = 2): Map<string, RepoFile[]> {
  const groups = new Map<string, RepoFile[]>();
  for (const f of files) {
    const parts = f.path.split('/');
    const key = parts.length > depth ? parts.slice(0, depth).join('/') + '/' : parts.slice(0, -1).join('/') + '/';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return groups;
}

/**
 * One line that says what a directory is for: the first meaningful line of its README, its
 * CLAUDE.md or its index file, else the description in its package.json. The directory pass
 * hands this to the model beside the path and a sample of file names, because a path such as
 * `packages/solid/` says nothing to a reader who does not already know the repository.
 */
export function directoryAbout(root: string, dirKey: string): string | undefined {
  const dir = join(root, dirKey);
  for (const name of ['README.md', 'readme.md', 'CLAUDE.md', 'index.ts', 'index.js', 'index.mjs', 'mod.ts']) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    const head = readHead(p);
    if (head) return head;
  }
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const description = (JSON.parse(readFileSync(pkg, 'utf8')) as { description?: unknown }).description;
      if (typeof description === 'string' && description.trim().length >= 8) return description.trim().slice(0, 160);
    } catch { /* not JSON: no description */ }
  }
  return undefined;
}
