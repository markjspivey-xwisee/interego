/**
 * Live GAP 5 verification: the deployed projector emits expressive verbs.
 * Pushes varied modal statuses + a self-declared verb to a fresh lens, then reads
 * them back via the admin aggregates (byVerb) — proving the monoculture is gone.
 *
 * Run from context-graphs/: npx tsx applications/foxxi-content-intelligence/tools/verify-gap5-live.ts
 */
import { ethers } from 'ethers';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
const GATE_ORIGIN = 'https://gate.interego.xwisee.com';
const DEMO_SEED = 'foxxi-demo-acme-training-2026-05-17-v1';
const ADMIN_WEB_ID = 'https://acme-id.interego.xwisee.com/users/admin/profile/card#me';
const enc = new TextEncoder();

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);
const deriveUserWallet = (userId: string): ethers.Wallet => new ethers.Wallet(ethers.hexlify(ethers.getBytes(ethers.sha256(enc.encode(`${DEMO_SEED}:${userId}`)))));
async function mintAdminToken(): Promise<string> {
  const w = deriveUserWallet('u-admin'); const now = new Date();
  const body = { sub: ADMIN_WEB_ID, iat: now.toISOString(), exp: new Date(now.getTime() + 3_600_000).toISOString(), nonce: sha256Hex(`u-admin:${now.getTime()}:${Math.random()}`).slice(0, 16), address: w.address };
  const sig = await w.signMessage(`Foxxi session\n  sub: ${body.sub}\n  iat: ${body.iat}\n  exp: ${body.exp}\n  nonce: ${body.nonce}`);
  return Buffer.from(JSON.stringify({ ...body, sig }), 'utf8').toString('base64url');
}
const push = (b: Record<string, unknown>) => fetch(`${BRIDGE}/agent/mesh-event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

async function main(): Promise<void> {
  const w = ethers.Wallet.createRandom();
  const first12 = w.address.slice(2, 14).toLowerCase();
  const pod = `${GATE_ORIGIN}/eth-${first12}/`;
  const lens = `lens:eth-${first12}`;
  const token = await mintAdminToken();
  const authH = { Authorization: `Bearer ${token}` };
  const desc = (n: string) => `${pod}contexts/d-${n}.json`;
  const ms = 1781000000000;

  console.log('[deploy] waiting for the GAP5 revision (Hypothetical push -> intended verb)...');
  let ready = false;
  for (let i = 0; i < 45 && !ready; i++) {
    await push({ originPod: pod, descriptorUrl: desc('probe'), describes: [`urn:g:${ms}`], modalStatus: 'Hypothetical' });
    const agg = await fetch(`${BRIDGE}/xapi/admin/aggregates?tenant=${encodeURIComponent(lens)}`, { headers: authH }).then(r => r.ok ? r.json() : null) as { topVerbs?: Array<{ id: string }> } | null;
    if (agg?.topVerbs?.some(v => v.id.endsWith('verbs/intended'))) ready = true; else await new Promise(r => setTimeout(r, 4000));
  }
  if (!ready) { console.log('  ! GAP5 revision did not come up'); process.exit(2); }

  // Fresh lens for clean counts.
  const w2 = ethers.Wallet.createRandom(); const f2 = w2.address.slice(2, 14).toLowerCase();
  const pod2 = `${GATE_ORIGIN}/eth-${f2}/`; const lens2 = `lens:eth-${f2}`;
  await push({ originPod: pod2, descriptorUrl: `${pod2}contexts/d-a.json`, describes: [`urn:g:${ms}`], modalStatus: 'Asserted' });
  await push({ originPod: pod2, descriptorUrl: `${pod2}contexts/d-h.json`, describes: [`urn:g:${ms + 1}`], modalStatus: 'Hypothetical' });
  await push({ originPod: pod2, descriptorUrl: `${pod2}contexts/d-c.json`, describes: [`urn:g:${ms + 2}`], modalStatus: 'Counterfactual' });
  await push({ originPod: pod2, descriptorUrl: `${pod2}contexts/d-r.json`, describes: [`urn:g:${ms + 3}`], modalStatus: 'Asserted', verb: 'reviewed' });

  const agg = await fetch(`${BRIDGE}/xapi/admin/aggregates?tenant=${encodeURIComponent(lens2)}`, { headers: authH }).then(r => r.json()) as { topVerbs?: Array<{ id: string; count: number }> };
  const ids = (agg.topVerbs ?? []).map(v => v.id);
  console.log('\n[GAP5 live] byVerb on the lens:', JSON.stringify(ids));
  check('performed present', ids.some(i => i.endsWith('#performed')));
  check('intended present (Hypothetical)', ids.some(i => i.endsWith('verbs/intended')));
  check('considered present (Counterfactual)', ids.some(i => i.endsWith('verbs/considered')));
  check('self-declared "reviewed" present', ids.some(i => i.endsWith('verbs/reviewed')));
  check('verb monoculture is gone (>=4 distinct verbs)', new Set(ids).size >= 4, `${new Set(ids).size} distinct`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(2); });
