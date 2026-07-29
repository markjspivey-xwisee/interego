#!/usr/bin/env node
/**
 * Add the ONE missing DNS record that brings interego.xwisee.com back.
 *
 *   CNAME  interego  ->  rh9mok2f.up.railway.app   (DNS only, not proxied)
 *
 * WHY IT IS MISSING. Every `*.interego.xwisee.com` host has its own explicit CNAME,
 * created during the Railway migration. `interego.xwisee.com` never did — it was
 * served by the zone's catch-all wildcard, and when that wildcard was removed during
 * the Turbify -> Cloudflare move it was the single name left with nothing behind it.
 * Verified: Cloudflare's own resolver returns NODATA for it, and a junk subdomain
 * returns nothing, so no wildcard remains. Railway reports the domain configured with
 * `currentValue: ""` — it has been waiting for this record.
 *
 * ★ THE THING THAT MUST NOT BREAK: this zone carries LIVE Yahoo Business Mail. The MX
 * records are load-bearing and a mistake here silently stops mail. So this script
 * snapshots every MX and NS record BEFORE the write, adds exactly one CNAME, then
 * re-reads and compares. Any difference is a hard failure with the before/after
 * printed. It never updates, never deletes, and refuses if the name already exists.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... node tools/cloudflare-add-interego-cname.mjs [--apply]
 *   (or place the token at .interego/cloudflare-token.txt)
 *
 * Without --apply it is a DRY RUN: it shows exactly what it would do and changes
 * nothing. Token needs only Zone -> DNS -> Edit on xwisee.com.
 */
import { readFileSync, existsSync } from 'node:fs';

const ZONE = 'xwisee.com';
const NAME = 'interego';
const TARGET = 'rh9mok2f.up.railway.app';
const FQDN = `${NAME}.${ZONE}`;
const APPLY = process.argv.includes('--apply');

const TOKEN_FILE = 'D:/devstuff/harness/context-graphs/.interego/cloudflare-token.txt';
const TOKEN = (process.env.CLOUDFLARE_API_TOKEN
  || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : '')).trim();

if (!TOKEN) {
  console.error('No Cloudflare token. Set CLOUDFLARE_API_TOKEN or write it to');
  console.error(`  ${TOKEN_FILE}`);
  console.error('Scope needed: Zone -> DNS -> Edit, on xwisee.com only.');
  process.exit(2);
}

const api = async (path, init = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  // Cloudflare reports failure in `success`, not only in the status code.
  if (!j.success) {
    const msg = (j.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j.result;
};

// ── Zone
const zones = await api(`/zones?name=${encodeURIComponent(ZONE)}`);
if (!zones.length) throw new Error(`zone ${ZONE} not visible to this token`);
const zoneId = zones[0].id;
console.log(`zone ${ZONE} -> ${zoneId}`);

// ── Snapshot what must not move
const snapshot = async () => {
  const recs = await api(`/zones/${zoneId}/dns_records?per_page=200`);
  return recs
    .filter(r => r.type === 'MX' || r.type === 'NS' || r.type === 'TXT')
    .map(r => `${r.type} ${r.name} ${r.priority ?? ''} ${r.content}`)
    .sort();
};
const before = await snapshot();
console.log(`\nload-bearing records before (${before.length}) — MAIL LIVES HERE:`);
for (const r of before.filter(x => x.startsWith('MX'))) console.log(`  ${r}`);

// ── Refuse if the name already exists; this script only ever CREATES.
const existing = await api(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(FQDN)}`);
if (existing.length) {
  console.log(`\n${FQDN} already has ${existing.length} record(s):`);
  for (const r of existing) console.log(`  ${r.type} -> ${r.content} (proxied=${r.proxied})`);
  console.log('Refusing to modify an existing record. Nothing changed.');
  process.exit(existing.some(r => r.type === 'CNAME' && r.content === TARGET) ? 0 : 1);
}

console.log(`\nwould create:  CNAME ${FQDN} -> ${TARGET}  (proxied=false)`);
console.log('  proxied=false to match the sibling hosts: they are plain CNAMEs to');
console.log('  Railway, and Railway issues the TLS certificate. Proxying can block');
console.log('  certificate issuance.');

if (!APPLY) {
  console.log('\nDRY RUN — nothing changed. Re-run with --apply to create it.');
  process.exit(0);
}

// ── Create exactly one record
const created = await api(`/zones/${zoneId}/dns_records`, {
  method: 'POST',
  body: JSON.stringify({ type: 'CNAME', name: NAME, content: TARGET, ttl: 1, proxied: false }),
});
console.log(`\ncreated ${created.type} ${created.name} -> ${created.content} (id ${created.id})`);

// ★ ASSERT proxied=false RATHER THAN ASSUMING IT.
//
// A proxied record answers on CLOUDFLARE's addresses, so Railway never sees the
// request: it cannot complete ownership validation, its edge has no route for the
// hostname, and the symptom is a 404 that looks like it comes from our own service.
// That cost hours here — because `proxied: false` was SENT and never CHECKED, and a
// later PATCH silently re-applied the zone default and turned proxying back on.
//
// Sending a value is not the same as the zone having it. Verify, then continue.
if (created.proxied !== false) {
  console.error('\n*** RECORD IS PROXIED. Cloudflare will answer on its own IPs and');
  console.error('    Railway will never see the request. Set it to DNS-only (grey cloud).');
  process.exit(1);
}
console.log('  proxied=false confirmed (DNS-only, as every sibling in this zone is)');

// ── Prove nothing else moved
const after = await snapshot();
const added = after.filter(r => !before.includes(r));
const removed = before.filter(r => !after.includes(r));
if (added.length || removed.length) {
  console.error('\n*** MX/NS/TXT CHANGED — INVESTIGATE IMMEDIATELY ***');
  for (const r of removed) console.error(`  REMOVED ${r}`);
  for (const r of added) console.error(`  ADDED   ${r}`);
  process.exit(1);
}
console.log('MX / NS / TXT byte-identical before and after. Mail untouched.');

// ── Verify it actually resolves and serves
console.log('\nwaiting for propagation…');
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 6000));
  const dns = await (await fetch(
    `https://cloudflare-dns.com/dns-query?name=${FQDN}&type=A`,
    { headers: { Accept: 'application/dns-json' } })).json().catch(() => ({}));
  if (dns.Answer?.length) {
    console.log(`  resolves: ${dns.Answer.map(a => a.data).join(', ')}`);
    const r = await fetch(`https://${FQDN}/`, { redirect: 'follow' }).catch(e => ({ status: 0, err: e.message }));
    console.log(`  https://${FQDN}/ -> ${r.status}${r.err ? ` (${r.err})` : ''}`);
    if (r.status >= 200 && r.status < 400) { console.log('\nLive.'); process.exit(0); }
    console.log('  (DNS is live; TLS may still be issuing — retry in a minute)');
    process.exit(0);
  }
  process.stdout.write('.');
}
console.log('\nnot resolving yet — DNS can take a few minutes. Re-check with:');
console.log(`  curl -H 'Accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=${FQDN}&type=A'`);
