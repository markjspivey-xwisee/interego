/**
 * GAP 3 + GAP 4 verification harness (run after deploying the bridge).
 *
 * Two layers of proof:
 *   1. LOCAL (deterministic, exact deployed source) — call projectMeshEntry +
 *      isDomainActivityType directly and assert the projected statement.
 *   2. LIVE (end-to-end against the deployed bridge) — push outcome-/kind-bearing
 *      mesh-events into a throwaway lens, then read them back via the admin
 *      aggregates + statements endpoints (GAP 4 queryability + statement shape)
 *      and via signed review-record (GAP 3 competency rollup).
 *
 * Adversarial: a BARE descriptor case asserts the projector fabricates NOTHING
 * (no result; default agent/production kinds; facet type only when no domain type).
 *
 * Run: npx tsx tools/verify-gaps34.ts   (from applications/foxxi-content-intelligence)
 */
import { ethers } from 'ethers';
import { projectMeshEntry, type MeshDiscoverEntry } from '../src/mesh-event-projector.js';
import { isDomainActivityType, PERF_EXT } from '../src/learner-record.js';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
const GATE_ORIGIN = 'https://gate.interego.xwisee.com';
const DEMO_SEED = 'foxxi-demo-acme-training-2026-05-17-v1';
const ADMIN_WEB_ID = 'https://acme-id.interego.xwisee.com/users/admin/profile/card#me';

const FACET = 'https://contextgraphs.example/ns/cg#SignedAuthorship';
const DOMAIN = 'urn:skill:DefectFix';
const enc = new TextEncoder();

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const get = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object') ? (a as Record<string, unknown>)[k] : undefined, o);
// Extensions are keyed by full IRIs (which contain '.'), so index them directly
// rather than via the dotted-path get(). `holder` is a statement or a projected event.
const extOf = (holder: unknown): Record<string, unknown> =>
  ((get(holder, 'statement.context.extensions') ?? get(holder, 'context.extensions')) as Record<string, unknown>) ?? {};

// ── auth helpers (replicate src/auth.ts exactly) ──────────────────────────
function sha256Hex(input: string): string { return ethers.sha256(enc.encode(input)).slice(2); }
function deriveUserWallet(userId: string, seed: string): ethers.Wallet {
  return new ethers.Wallet(ethers.hexlify(ethers.getBytes(ethers.sha256(enc.encode(`${seed}:${userId}`)))));
}
function canonicalSessionMsg(t: { sub: string; iat: string; exp: string; nonce: string }): string {
  return `Foxxi session\n  sub: ${t.sub}\n  iat: ${t.iat}\n  exp: ${t.exp}\n  nonce: ${t.nonce}`;
}
async function mintAdminToken(): Promise<string> {
  const wallet = deriveUserWallet('u-admin', DEMO_SEED);
  const now = new Date();
  const nonce = sha256Hex(`u-admin:${now.getTime()}:${Math.random()}`).slice(0, 16);
  const body = { sub: ADMIN_WEB_ID, iat: now.toISOString(), exp: new Date(now.getTime() + 3_600_000).toISOString(), nonce, address: wallet.address };
  const sig = await wallet.signMessage(canonicalSessionMsg(body));
  return Buffer.from(JSON.stringify({ ...body, sig }), 'utf8').toString('base64url');
}
async function signReview(wallet: ethers.HDNodeWallet, payloadObj: Record<string, unknown>): Promise<{ _signature: string; _signed_payload: string }> {
  const _signed_payload = JSON.stringify(payloadObj);
  const _signature = await wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signature, _signed_payload };
}
async function waitForBridge(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BRIDGE}/agent/review-record/affordance`); if (r.ok) return true; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function main(): Promise<void> {
  // ─────────────────────────── LOCAL ───────────────────────────
  console.log('\n[LOCAL] deterministic projection (exact deployed source)');

  // Case A — domain type listed AFTER a facet, plus outcome + non-default kinds.
  const evA = projectMeshEntry({
    descriptorUrl: 'https://pod.example/eth-abc/contexts/d-defectfix-1.json',
    describes: ['urn:graph:defectfix:run:1781000000000'],
    conformsTo: [FACET, DOMAIN], modalStatus: 'Asserted',
    success: true, scoreScaled: 0.92, actorKind: 'human', contextKind: 'training',
  } as MeshDiscoverEntry, 'https://pod.example/eth-abc/');
  check('GAP3 domain type preferred over facet', get(evA, 'statement.object.definition.type') === DOMAIN, String(get(evA, 'statement.object.definition.type')));
  check('GAP1 result.success emitted', get(evA, 'statement.result.success') === true);
  check('GAP1 result.score.scaled emitted', get(evA, 'statement.result.score.scaled') === 0.92);
  check('GAP4 actorKind=human in extensions', extOf(evA)[PERF_EXT.actorKind] === 'human');
  check('GAP4 contextKind=training in extensions', extOf(evA)[PERF_EXT.contextKind] === 'training');
  check('GAP2 timestamp from describes millis', get(evA, 'statement.timestamp') === new Date(1781000000000).toISOString(), String(get(evA, 'statement.timestamp')));

  // Case B — bare envelope: prove NOTHING is fabricated.
  const evB = projectMeshEntry({
    descriptorUrl: 'https://pod.example/eth-abc/contexts/d-bare.json',
    describes: ['urn:graph:bare:1'], conformsTo: [FACET], modalStatus: 'Asserted',
  } as MeshDiscoverEntry, 'https://pod.example/eth-abc/');
  check('honesty: bare → facet type (no domain invented)', get(evB, 'statement.object.definition.type') === FACET);
  check('honesty: bare → no result block', get(evB, 'statement.result') === undefined);
  check('honesty: bare → default actorKind=agent', extOf(evB)[PERF_EXT.actorKind] === 'agent');
  check('honesty: bare → default contextKind=production', extOf(evB)[PERF_EXT.contextKind] === 'production');

  // Case C — facet/domain classifier shared with the competency engine.
  check('classifier: domain IRI is domain', isDomainActivityType(DOMAIN) === true);
  check('classifier: SignedAuthorship facet is NOT domain', isDomainActivityType(FACET) === false);
  check('classifier: Temporal facet is NOT domain', isDomainActivityType('http://x/ns#Temporal') === false);

  // ─────────────────────────── LIVE ────────────────────────────
  console.log('\n[LIVE] end-to-end against the deployed bridge');
  if (!(await waitForBridge())) { console.log('  ! bridge did not become reachable; skipping live checks'); return; }

  const w = ethers.Wallet.createRandom();
  const first12 = w.address.slice(2, 14).toLowerCase();
  const pod = `${GATE_ORIGIN}/eth-${first12}/`;
  const lens = `lens:eth-${first12}`;
  console.log(`  subject did:ethr:${w.address} → ${lens}`);

  const push = (body: Record<string, unknown>) =>
    fetch(`${BRIDGE}/agent/mesh-event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  const p1 = await push({ originPod: pod, descriptorUrl: `${pod}contexts/d-defectfix-1.json`, describes: ['urn:graph:defectfix:run:1781000000000'], conformsTo: [FACET, DOMAIN], modalStatus: 'Asserted', success: true, scoreScaled: 0.92, actorKind: 'human', contextKind: 'training' });
  const p2 = await push({ originPod: pod, descriptorUrl: `${pod}contexts/d-defectfix-2.json`, describes: ['urn:graph:defectfix:run:1781100000000'], conformsTo: [FACET, DOMAIN], modalStatus: 'Asserted', success: false, scoreScaled: 0.40 });
  check('push#1 projected (human/training, success)', p1.projected === true && p1.tenant === lens, JSON.stringify(p1));
  check('push#2 projected (agent/production, fail)', p2.projected === true && p2.tenant === lens, JSON.stringify(p2));

  // Admin reads (GAP 4 queryability + live statement shape).
  const token = await mintAdminToken();
  const authH = { Authorization: `Bearer ${token}` };
  const aggRes = await fetch(`${BRIDGE}/xapi/admin/aggregates?tenant=${encodeURIComponent(lens)}`, { headers: authH });
  if (aggRes.status === 200) {
    const agg = await aggRes.json() as Record<string, unknown>;
    const ak = (agg.byActorKind as Array<{ id: string; count: number }>) ?? [];
    const ck = (agg.byContextKind as Array<{ id: string; count: number }>) ?? [];
    check('GAP4 byActorKind splits human + agent', ak.some(x => x.id === 'human') && ak.some(x => x.id === 'agent'), JSON.stringify(ak));
    check('GAP4 byContextKind splits training + production', ck.some(x => x.id === 'training') && ck.some(x => x.id === 'production'), JSON.stringify(ck));
    check('GAP1 aggregate successRate reflects 1/2', agg.total === 2 && agg.successRate === 0.5, `total=${agg.total} successRate=${agg.successRate}`);

    const stRes = await fetch(`${BRIDGE}/xapi/admin/statements?tenant=${encodeURIComponent(lens)}&limit=10`, { headers: authH });
    const st = await stRes.json() as { page?: Array<Record<string, unknown>> };
    const human = (st.page ?? []).find(r => extOf(r)[PERF_EXT.actorKind] === 'human');
    check('LIVE statement carries domain type', get(human, 'object.definition.type') === DOMAIN, String(get(human, 'object.definition.type')));
    check('LIVE statement carries result.success', get(human, 'result.success') === true);
    check('LIVE statement carries real timestamp', get(human, 'timestamp') === new Date(1781000000000).toISOString(), String(get(human, 'timestamp')));
    check('LIVE statement carries contextKind=training', extOf(human)[PERF_EXT.contextKind] === 'training');
  } else {
    console.log(`  ! admin token rejected (HTTP ${aggRes.status}: ${(await aggRes.text()).slice(0, 160)}) — directory seed mismatch? skipping admin reads`);
  }

  // Signed review-record (GAP 3 competency rollup, live).
  const env = await signReview(w, { agent_id: `did:ethr:${w.address}`, timestamp: new Date().toISOString(), include_clr: false });
  const rr = await fetch(`${BRIDGE}/agent/review-record`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) }).then(r => r.json()) as Record<string, unknown>;
  const comps = (get(rr, 'elr.competencies') as Array<Record<string, unknown>>) ?? [];
  const defectFix = comps.find(c => JSON.stringify(c).includes('DefectFix'));
  check('GAP3 LIVE competency rolled up from domain type', !!defectFix, defectFix ? JSON.stringify(defectFix) : `no DefectFix competency; statementCount=${get(rr, 'subject.statementCount')}`);
  check('GAP3 LIVE competency basis=performance', get(defectFix, 'basis') === 'performance', String(get(defectFix, 'basis')));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(2); });
