#!/usr/bin/env node
/**
 * acme-id — every URL these identity documents publish must resolve.
 *
 * ★ WHY. A live audit found two dangling references in documents whose entire value
 * is that a stranger can resolve what they say:
 *
 *   1. The did:web document advertised a `#tenantPod` service at
 *      `https://gate.interego.xwisee.com/acme/`, which 404s. No such pod exists —
 *      Foxxi tenancy keeps a tenant's data inside the vertical's own pod, so a
 *      separate `acme` pod was aspirational. Removed rather than repointed at the
 *      vertical's pod, because a wrong-but-resolving pointer is harder to catch
 *      than a dangling one.
 *
 *   2. All three WebID profiles bound `fxd:` to
 *      `https://acme-id.interego.xwisee.com/ns/foxxi-demo` and asserted facts in it
 *      — userId, walletAddress, audienceTag — and the namespace 404'd. A reader
 *      could parse every triple and had no way to learn what a single predicate
 *      MEANT. That namespace is now served.
 *
 * These are static files, so this checks the SOURCE. It is the layer that would have
 * caught both: no deploy, no network, no credential.
 *
 * Run: node deploy/acme-id/identity-documents.test.mjs [--live]
 *   --live additionally dereferences each URL against the deployed site.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), 'site');
const LIVE = process.argv.includes('--live');
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nacme-id: an identity document may not cite what it cannot resolve');

// ── The DID document
const did = JSON.parse(readFileSync(join(SITE, '.well-known', 'did.json'), 'utf8'));
check('did.json is valid JSON with an id', typeof did.id === 'string', String(did.id));

// Any service endpoint under our own control must exist as a file we ship.
const localPrefix = 'https://acme-id.interego.xwisee.com';
for (const svc of did.service ?? []) {
  const ep = svc.serviceEndpoint;
  check(`service ${svc.id.split('#')[1]} has an http(s) endpoint`, /^https?:\/\//.test(ep), ep);
  // The specific dangling pod that shipped. Named so a reinstatement fails loudly.
  check(`  ...and is not the pod that does not exist`,
    ep !== 'https://gate.interego.xwisee.com/acme/',
    'the acme pod 404s; Foxxi tenancy keeps tenant data in the vertical pod');
}

// ── The WebID profiles and the vocabulary they cite
const users = readdirSync(join(SITE, 'users'), { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);
check('WebID profiles are present', users.length > 0, users.join(','));

const cited = new Set();
for (const u of users) {
  const card = join(SITE, 'users', u, 'profile', 'card');
  check(`${u} has a profile card`, existsSync(card), card);
  if (!existsSync(card)) continue;
  const ttl = readFileSync(card, 'utf8');
  // Every prefix bound to our OWN host must be a document we actually serve.
  for (const m of ttl.matchAll(/@prefix\s+\w+:\s+<(https:\/\/acme-id\.interego\.xwisee\.com[^>#]*)#?>/g)) {
    cited.add(m[1]);
  }
}
check('profiles cite at least one namespace on this host', cited.size > 0, [...cited].join(','));

for (const ns of cited) {
  const rel = ns.replace(localPrefix, '').replace(/^\//, '');
  const file = join(SITE, ...rel.split('/'));
  check(`the cited namespace ${rel} is a file we ship`, existsSync(file), file);
  if (!existsSync(file)) continue;
  const body = readFileSync(file, 'utf8');
  // Every term the profiles USE must be DEFINED. A namespace that resolves to a
  // document missing the predicate in question is only half an answer.
  const used = new Set();
  for (const u of users) {
    const card = join(SITE, 'users', u, 'profile', 'card');
    if (!existsSync(card)) continue;
    for (const m of readFileSync(card, 'utf8').matchAll(/\bfxd:([A-Za-z][A-Za-z0-9_-]*)/g)) used.add(m[1]);
  }
  for (const term of used) {
    check(`  ...and defines fxd:${term}, which a profile asserts`,
      new RegExp(`fxd:${term}\\b`).test(body));
  }
}

if (LIVE) {
  console.log('\n  live dereference:');
  const urls = [...(did.service ?? []).map(s => s.serviceEndpoint), ...cited];
  for (const u of urls) {
    const r = await fetch(u, { redirect: 'follow' }).catch(() => ({ status: 0 }));
    check(`  ${u} resolves`, r.status >= 200 && r.status < 400, String(r.status));
  }
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nEvery published reference resolves.\n');
