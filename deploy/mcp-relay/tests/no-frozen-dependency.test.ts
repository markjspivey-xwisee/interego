#!/usr/bin/env tsx
/**
 * The relay depends on no frozen package for authentication.
 *
 * ★ WHY. `@modelcontextprotocol/server-legacy` is, in its own README, "a frozen copy of
 * v1 code for migration purposes only" that "will not receive new features and is
 * planned for removal in v3". The relay's OAuth Authorization Server ran on it, because
 * MCP SDK v2 ships no AS at all — its position is that an MCP server verifies tokens
 * rather than issuing them.
 *
 * We issue them deliberately: the relay mints tokens carrying a DID-bound, pod-scoped
 * identity no third-party IdP can produce, and the spec explicitly permits an AS
 * co-hosted with the resource server. So the routes are now ours
 * (deploy/mcp-relay/oauth-router.ts) and the dependency is gone.
 *
 * This test exists because that is easy to undo by accident. An `import` added for one
 * convenient helper re-introduces a package that receives no fixes, and nothing else
 * would notice.
 *
 * ★ IT ALSO GUARDS THE BRAND. server-legacy defines its OWN unbranded `OAuthError`,
 * distinct from the branded class in `@modelcontextprotocol/server`. Mixing them is not
 * cosmetic: `requireBearerAuth` decides 401-vs-500 by a brand-based `instanceof`, so an
 * unbranded error turns every invalid token into a 500 with no `WWW-Authenticate` and no
 * client ever begins an OAuth flow. That exact trap was closed once already; this keeps
 * the door shut.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const relayDir = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('\nThe relay owns its authorization server');

// ── No source file imports the frozen package ────────────────────────────
const sources: string[] = [];
const walk = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs')) sources.push(p);
  }
};
walk(relayDir);

const importers = sources.filter(p => {
  const src = readFileSync(p, 'utf8');
  // Only real import/require statements — the header comments in oauth-router.ts and
  // oauth-provider.ts explain WHY the package is not used, and must stay readable.
  return /(?:from|require\()\s*['"]@modelcontextprotocol\/server-legacy/.test(src);
});
ok(importers.length === 0,
  'no relay source imports @modelcontextprotocol/server-legacy',
  importers.map(p => p.replace(relayDir, '')).join(', '));

// ── Nor does the manifest declare it ─────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(relayDir, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
};
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
ok(!('@modelcontextprotocol/server-legacy' in declared),
  'the relay manifest does not declare it either',
  Object.keys(declared).filter(k => k.includes('server-legacy')).join(', '));

// ── And it is not installed, so an import could not silently succeed ─────
ok(!existsSync(join(relayDir, '..', '..', 'node_modules', '@modelcontextprotocol', 'server-legacy')),
  'it is not installed in the workspace, so a stray import fails loudly');

// ── The v1 SDK is gone too ───────────────────────────────────────────────
const v1 = sources.filter(p => /(?:from|require\()\s*['"]@modelcontextprotocol\/sdk/.test(readFileSync(p, 'utf8')));
ok(v1.length === 0, 'no relay source imports the v1 @modelcontextprotocol/sdk',
  v1.map(p => p.replace(relayDir, '')).join(', '));

// ── The AS routes are ours, and mounted ──────────────────────────────────
const serverSrc = readFileSync(join(relayDir, 'server.ts'), 'utf8');
ok(/interegoOAuthRouter\(/.test(serverSrc), 'server.ts mounts our own OAuth router');
ok(!/mcpAuthRouter/.test(serverSrc.replace(/^\s*(\/\/|\*).*$/gm, '')),
  'server.ts no longer calls mcpAuthRouter outside comments');

// ── The error hierarchy is single ────────────────────────────────────────
const routerSrc = readFileSync(join(relayDir, 'oauth-router.ts'), 'utf8');
ok(/from '@modelcontextprotocol\/server'/.test(routerSrc),
  'the router takes its OAuthError from the BRANDED package (401-vs-500 depends on the brand)');

console.log(failures === 0
  ? `\n${'-'.repeat(60)}\nNo frozen dependency in the authorization path.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
