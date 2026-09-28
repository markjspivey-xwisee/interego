#!/usr/bin/env node
/**
 * The base names no vertical.
 *
 * ★ WHY A GATE. The substrate is supposed to be domain-neutral: packages/*, the MCP relay, the
 * stdio server and the identity/validator services carry no knowledge of any vertical under
 * `applications/`, and a vertical reaches them only through published descriptors, affordances and
 * operator configuration. #366 found that claim false in exactly the way such claims go false —
 * one convenient default at a time: the relay's tier-2 lattice resolver and its action roster both
 * defaulted to one vertical's host, the Solid client probed that vertical's credential container on
 * every pod, and MCP tool descriptions served to every client named verticals as examples. Each
 * was reasonable where it was written, and nothing measured the sum. This measures it on every run.
 *
 * Three checks over the BASE's production source (tests excluded — base tests are #366's
 * separate item):
 *
 *   1. DEPENDENCIES — hard zero. No import, re-export, dynamic `import()`, `require()` or
 *      `import('…')` type reaches `applications/`, `integrations/`, `examples/`, a vertical-owned
 *      package, or a package published from any of them.
 *   2. CODE TOKENS — hard zero outside a narrow allowlist. Vertical vocabulary in string
 *      literals, template text, identifiers and regular expressions is a vertical's behaviour
 *      living in the base. Every allowlist entry names its file, the exact text, how many times it
 *      occurs and why it is not that; an entry that no longer matches fails too, so the list can
 *      only shrink.
 *   3. COMMENT TOKENS — a ratchet. Prose that uses a vertical as an illustration is not a
 *      dependency, and pretending the honest number is zero would mean editing a hundred unrelated
 *      comments to make a count look better. So the number is pinned per root: growth fails, and
 *      a pin above the measured count fails as stale.
 *
 * Code and comments are told apart by the TypeScript parser, not by a regex over lines: a vertical
 * named inside a string on a line that also carries a comment is code.
 *
 * Run: node tools/base-neutrality-lint.mjs      Exit: 0 clean, 1 boundary broken.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Packages that live under `packages/` for workspace resolution but belong to a vertical. They
 * are not base, so they are not scanned — and, being a vertical's, no base root may import them.
 */
export const VERTICAL_OWNED = [
  {
    dir: 'packages/workspace-client',
    vertical: 'applications/shared-workspace',
    why: 'the shared-workspace vertical\'s own client library (its `wsp:` vocabulary, member documents and seat fold); it is published as a package so the vertical\'s desktop and Discord conduits can share it, not because the substrate uses it',
  },
];

/** Directories inside a base root that are not the base's own source. */
const NOT_SOURCE = [
  { dir: 'deploy/mcp-relay/amep-vendor', why: 'the AMEP reference validator and JSON-LD context, vendored verbatim' },
];

/** The vocabulary of every vertical this repository holds, one entry per vertical. */
export const VERTICAL_TOKENS = [
  { vertical: 'foxxi-content-intelligence', pattern: /foxxi/gi },
  { vertical: 'agentic-performance-practice', pattern: /\bagp\b|agentic[-_ ]performance/gi },
  { vertical: 'agent-collective', pattern: /\bac:[a-z_]+|urn:graph:ac:|\bac\.(?:author|attest|promote|bundle|record)_|\bagenttool\b|agent[-_ ]?collective/gi },
  { vertical: 'release control (examples/application-simulation)', pattern: /release[-_ ]?control/gi },
  { vertical: 'SCORM, xAPI and cmi5', pattern: /scorm|xapi|cmi5|\blrs\b/gi },
  { vertical: 'LER and ADL TLA', pattern: /\bler\b|ieee[-_]lers?\b|adl[-_]tla|\btla\b(?!\+)/gi },
  { vertical: 'learner-performer-companion', pattern: /\blpc\b|learner[-_ ]performer/gi },
  { vertical: 'organizational-working-memory', pattern: /\bowm\b|organizational[-_ ]working[-_ ]memory/gi },
  { vertical: 'agent-development-practice', pattern: /\badp\b|agent[-_ ]development[-_ ]practice/gi },
  { vertical: 'shared-workspace', pattern: /\bwsp\b|shared[-_ ]workspace/gi },
  { vertical: 'jev-harness', pattern: /\bjev\b|jev[-_]harness/gi },
  { vertical: 'llm-telemetry', pattern: /llm[-_ ]telemetry/gi },
  { vertical: 'lrs-adapter', pattern: /lrs[-_]adapter/gi },
];

/**
 * Vertical vocabulary allowed in base CODE. Each entry is a claim that the text is not the
 * vertical's behaviour, with the reason; `count` is exact.
 */
export const ALLOWED_CODE_TOKENS = [
  {
    file: 'packages/core/src/crypto/types.ts',
    text: 'IEEE_LERS',
    count: 1,
    why: 'one member of the generic `ExternalCredentialType` union, beside W3C_VC and OpenBadge: the name of a public credential standard a pod may import, not a vertical\'s code path',
  },
];

/**
 * Vertical vocabulary in comments, pinned per root. Lower a pin when the count falls; a pin above
 * the measured count fails as stale.
 */
export const COMMENT_PINS = {
  packages: 127,
  'deploy/mcp-relay': 60,
  'deploy/identity': 0,
  'deploy/validator': 0,
  'mcp-server': 5,
};

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const isTestPath = (rel, name) =>
  /(^|\/)(tests?|__tests__)(\/|$)/.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /^_.*-test\.ts$/.test(name);

function sourceFiles(root, dir) {
  const out = [];
  const walk = d => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(d, name);
      const rel = relative(root, p).replace(/\\/g, '/');
      if (NOT_SOURCE.some(n => rel === n.dir || rel.startsWith(`${n.dir}/`))) continue;
      if (VERTICAL_OWNED.some(v => rel === v.dir || rel.startsWith(`${v.dir}/`))) continue;
      if (statSync(p).isDirectory()) { if (!isTestPath(`${rel}/`, name)) walk(p); continue; }
      if (!SOURCE_FILE.test(name) || name.endsWith('.d.ts') || isTestPath(rel, name)) continue;
      out.push(p);
    }
  };
  walk(join(root, dir));
  return out.sort();
}

/** The base, as roots of source directories. `packages` is every package's `src/` but the vertical-owned ones. */
export function baseRoots(root = ROOT) {
  const packages = readdirSync(join(root, 'packages'))
    .filter(name => !VERTICAL_OWNED.some(v => v.dir === `packages/${name}`))
    .flatMap(name => sourceFiles(root, `packages/${name}/src`));
  return {
    packages,
    'deploy/mcp-relay': sourceFiles(root, 'deploy/mcp-relay'),
    'deploy/identity': sourceFiles(root, 'deploy/identity'),
    'deploy/validator': sourceFiles(root, 'deploy/validator'),
    'mcp-server': sourceFiles(root, 'mcp-server'),
  };
}

function matchesIn(text) {
  const hits = [];
  for (const { vertical, pattern } of VERTICAL_TOKENS) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) hits.push({ vertical, text: m[0], index: m.index });
  }
  return hits;
}

/**
 * Split one source file into what its CODE says and what its COMMENTS say about verticals, and
 * list every module specifier it names.
 */
export function scanSource(text, fileName = 'file.ts') {
  const kind = /\.[cm]?jsx?$/.test(fileName) ? ts.ScriptKind.JS : fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const K = ts.SyntaxKind;
  const TOKENS = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle,
    K.TemplateTail, K.RegularExpressionLiteral, K.Identifier, K.PrivateIdentifier, K.JsxText]);
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const code = [];
  const specifiers = [];
  const covered = [];
  const literal = node => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);
  const visit = node => {
    if (TOKENS.has(node.kind)) {
      const start = node.getStart(sf);
      covered.push([start, node.end]);
      for (const h of matchesIn(text.slice(start, node.end))) code.push({ ...h, line: lineOf(start + h.index) });
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const s = literal(node.moduleSpecifier);
      if (s !== undefined) specifiers.push({ specifier: s, line: lineOf(node.getStart(sf)) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const s = literal(node.moduleReference.expression);
      if (s !== undefined) specifiers.push({ specifier: s, line: lineOf(node.getStart(sf)) });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === K.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if ((isImport || isRequire) && node.arguments.length > 0) {
        const s = literal(node.arguments[0]);
        if (s !== undefined) specifiers.push({ specifier: s, line: lineOf(node.getStart(sf)) });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const s = literal(node.argument.literal);
      if (s !== undefined) specifiers.push({ specifier: s, line: lineOf(node.getStart(sf)) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // What is left once every code token is blanked is comments, keywords and punctuation, and only
  // comments can hold a vertical's name.
  const chars = text.split('');
  const NL = String.fromCharCode(10);
  for (const [a, b] of covered) for (let i = a; i < b; i++) if (chars[i] !== NL) chars[i] = ' ';
  const comments = matchesIn(chars.join('')).map(h => ({ ...h, line: lineOf(h.index) }));
  return { code, comments, specifiers };
}

/**
 * Package names published from anywhere a base root may not depend on: every `package.json` under
 * `applications/`, `integrations/` and `examples/`, at any depth, and the vertical-owned packages.
 *
 * ★ FOUND BY WALKING, NOT BY NAMING. This first read three second-level directory names (bridge,
 * desktop, discord), so the Foxxi dashboard, microsite and reports packages were importable from
 * the base without a word (Codex, on #556). A list of places a package might be is the list that
 * goes stale; the tree is the authority.
 */
export function forbiddenPackages(root = ROOT) {
  const names = new Set();
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        walk(join(dir, e.name));
      } else if (e.name === 'package.json') {
        try { const name = JSON.parse(readFileSync(join(dir, e.name), 'utf8')).name; if (name) names.add(name); } catch { /* unreadable: not a package */ }
      }
    }
  };
  for (const top of ['applications', 'integrations', 'examples']) walk(join(root, top));
  for (const v of VERTICAL_OWNED) walk(join(root, v.dir));
  return names;
}

/** Why a specifier from `file` is a dependency on a vertical, or undefined when it is not one. */
export function forbiddenReason(specifier, file, root = ROOT, packages = forbiddenPackages(root)) {
  if (specifier.startsWith('.')) {
    const target = relative(root, resolve(dirname(file), specifier)).replace(/\\/g, '/');
    for (const top of ['applications/', 'integrations/', 'examples/']) {
      if (target.startsWith(top)) return `reaches ${top}`;
    }
    for (const v of VERTICAL_OWNED) if (target === v.dir || target.startsWith(`${v.dir}/`)) return `reaches ${v.dir}, which belongs to ${v.vertical}`;
    return undefined;
  }
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  return packages.has(name) ? `imports ${name}, a package published outside the base` : undefined;
}

export function measure(root = ROOT) {
  const roots = baseRoots(root);
  const packages = forbiddenPackages(root);
  const result = { roots: {}, dependencies: [], code: [], comments: {} };
  for (const [name, files] of Object.entries(roots)) {
    result.roots[name] = files.length;
    result.comments[name] = { count: 0, examples: [] };
    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const { code, comments, specifiers } = scanSource(readFileSync(file, 'utf8'), file);
      for (const s of specifiers) {
        const why = forbiddenReason(s.specifier, file, root, packages);
        if (why) result.dependencies.push({ file: rel, line: s.line, specifier: s.specifier, why });
      }
      for (const h of code) result.code.push({ file: rel, line: h.line, text: h.text, vertical: h.vertical });
      result.comments[name].count += comments.length;
      for (const h of comments) if (result.comments[name].examples.length < 6) result.comments[name].examples.push(`${rel}:${h.line}`);
    }
  }
  return result;
}

/** Apply the three rules to a measurement. Returns the failures, each a printable block. */
export function judge(m, allowed = ALLOWED_CODE_TOKENS, pins = COMMENT_PINS) {
  const failures = [];
  for (const [name, count] of Object.entries(m.roots)) {
    if (count === 0) failures.push(`★ ${name}: no source files found — a root that scans nothing passes everything`);
  }
  for (const d of m.dependencies) {
    failures.push(`★ DEPENDENCY ON A VERTICAL — ${d.file}:${d.line} '${d.specifier}' ${d.why}`);
  }
  const unexplained = [];
  for (const entry of allowed) {
    const found = m.code.filter(h => h.file === entry.file && h.text === entry.text).length;
    if (found !== entry.count) {
      failures.push(`★ ALLOWLIST ENTRY OUT OF DATE — ${entry.file} '${entry.text}': allowed ${entry.count}, found ${found}. `
        + (found < entry.count ? 'Lower or remove the entry.' : 'This is growth, not an exception.'));
    }
  }
  for (const h of m.code) {
    if (allowed.some(e => e.file === h.file && e.text === h.text)) continue;
    unexplained.push(h);
  }
  for (const h of unexplained) {
    failures.push(`★ VERTICAL VOCABULARY IN BASE CODE — ${h.file}:${h.line} '${h.text}' (${h.vertical})`);
  }
  for (const [name, { count, examples }] of Object.entries(m.comments)) {
    const pinned = pins[name];
    if (pinned === undefined) { failures.push(`★ ${name}: no comment pin recorded (measured ${count})`); continue; }
    if (count > pinned) failures.push(`★ VERTICAL MENTIONS IN ${name} COMMENTS GREW — pinned ${pinned}, found ${count}: ${examples.join(', ')}`);
    else if (count < pinned) failures.push(`★ STALE PIN — ${name} comments: pinned ${pinned}, found ${count}. Lower the pin to ${count}.`);
  }
  return failures;
}

function main() {
  const m = measure();
  const failures = judge(m);
  for (const [name, files] of Object.entries(m.roots)) {
    const c = m.comments[name];
    console.log(`scanned ${name}: ${files} file(s); ${c.count} comment mention(s) of a vertical (pin ${COMMENT_PINS[name]})`);
  }
  console.log(`code tokens: ${m.code.length} (allowlisted ${ALLOWED_CODE_TOKENS.reduce((n, e) => n + e.count, 0)}); dependencies on a vertical: ${m.dependencies.length}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(f);
    console.error(`\nbase neutrality: ${failures.length} failure(s). The base's code names no vertical; a vertical reaches it through published data and operator configuration.`);
    process.exit(1);
  }
  console.log('\nbase neutrality: intact.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
