/**
 * LIVE proof that an AGENT-authored course flows into Course IQ:
 *   fresh wallet → signed /agent/scorm/author → /agent/course/analyze-authored
 *   → /agent/course/ask. Confirms the Foxxi-agent provenance fingerprint, the
 *   course KG holon, and grounded chat — all against the deployed bridge.
 *
 *   npx tsx applications/foxxi-content-intelligence/tools/agent-course-live-proof.ts
 */
import { ethers } from 'ethers';

const BRIDGE = process.env.FOXXI_BRIDGE_URL ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const enc = new TextEncoder();
const sha = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = ''): void => { if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); } };

async function signed(w: ethers.HDNodeWallet, args: Record<string, unknown>) {
  const payload = { ...args, agent_id: `did:ethr:${w.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const sp = JSON.stringify(payload);
  return { _signature: await w.signMessage(`sha256:${sha(sp)}`), _signed_payload: sp };
}
async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let b: any = null; try { b = await r.json(); } catch { b = await r.text().catch(() => null); }
  return { status: r.status, body: b };
}

async function main(): Promise<void> {
  const A = ethers.Wallet.createRandom();
  const didA = `did:ethr:${A.address.toLowerCase()}`;
  const courseId = `agp-courseiq-${A.address.slice(2, 8).toLowerCase()}`;
  console.log(`bridge=${BRIDGE}\nA=${didA}\ncourse=${courseId}\n`);

  console.log('[1] agent A authors a SCORM course (signed)');
  const author = await post('/agent/scorm/author', await signed(A, { course: {
    courseId, title: 'Extend a standard (Interego/Foxxi)', masteryScore: 0.5,
    scos: [{ id: 'sco1', title: 'Extend a standard', body: 'Discover the /guidance catalog, then call the extend_standards affordance. What you did rides in the object, not the verb.',
      assessment: [{ question: 'Which affordance extends a standard?', answer: 'extend_standards' }] }],
  } }));
  ok('scorm/author ok', author.status === 200 && author.body?.ok === true, `courseId=${author.body?.courseId}`);

  console.log('\n[2] Course IQ analyzes the AGENT-authored course (provenance fingerprint)');
  const an = await post('/agent/course/analyze-authored', { courseId, author_did: didA });
  ok('analyze-authored ok', an.status === 200 && an.body?.ok === true, `HTTP ${an.status}`);
  ok('fingerprint = Foxxi (agent-authored)', an.body?.fingerprint?.toolId === 'foxxi-agent', `${an.body?.fingerprint?.tool} · conf ${an.body?.fingerprint?.confidence}`);
  ok('provenance signal cites the author DID', JSON.stringify(an.body?.fingerprint?.signals ?? []).includes(A.address.toLowerCase()), '');
  ok('course graph built (concepts + slides)', (an.body?.course?.concepts?.length ?? 0) >= 1 && (an.body?.course?.slides?.length ?? 0) >= 1, `${an.body?.course?.concepts?.length} concepts / ${an.body?.course?.slides?.length} slides`);
  ok('course KG holon composed', !!an.body?.courseKg?.holonUri, an.body?.courseKg?.holonUri ?? '(none)');

  console.log('\n[3] grounded chat over the agent-authored course');
  const ask = await post('/agent/course/ask', { course: an.body.course, role: 'learner', question: 'How do I extend a standard?' });
  ok('ask grounded (graph hit)', ask.status === 200 && ask.body?.grounded === true && ask.body?.retrievalKind === 'graph', `kind=${ask.body?.retrievalKind} cited=${(ask.body?.retrieval?.citedSlides ?? []).map((s: any) => s.slideTitle).join(', ')}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('agent-course-live-proof error:', e); process.exit(2); });
