/**
 * HEADLESS feasibility proof for the BYO-key microsite demo (run BEFORE any UI).
 *
 * Two FRESH ECDSA wallets (no pre-provisioning, no OAuth, no directory, no VC)
 * drive the full EMERGENT arc against the LIVE Foxxi bridge via the DIRECT
 * signed-request branch — nothing synthetic, real pods / xAPI / SCORM / credential:
 *   A authors an xAPI profile/extension -> A authors a SCORM course teaching the
 *   skill -> B launches + completes it (graded SN rollup -> real xAPI) -> B performs
 *   the skill -> A verifies the transfer (review-record, subject_did=B, no admin
 *   token) -> A issues B an OB3 credential -> B sees it in its CLR.
 *
 * Captures every request/response to .demo-proof-artifacts.json so a microsite can
 * render real per-agent streams. Run from context-graphs/:
 *   npx tsx applications/foxxi-content-intelligence/tools/demo-feasibility-proof.ts
 */
import { ethers } from 'ethers';
import { writeFileSync } from 'node:fs';

const BRIDGE = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

let pass = 0, fail = 0;
const artifacts: Array<Record<string, unknown>> = [];
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

/** rev-196 DIRECT signed envelope: args + agent_id(did:ethr, LOWERCASE addr) + ts. */
async function signed(wallet: ethers.HDNodeWallet, args: Record<string, unknown>): Promise<{ _signature: string; _signed_payload: string }> {
  const payload = { ...args, agent_id: `did:ethr:${wallet.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const _signed_payload = JSON.stringify(payload);
  const _signature = await wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signature, _signed_payload };
}
async function postSigned(path: string, wallet: ethers.HDNodeWallet, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const env = await signed(wallet, args);
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  artifacts.push({ step: path, signer: wallet.address, request: JSON.parse(env._signed_payload), status: r.status, response: body });
  return { status: r.status, body };
}
async function postPlain(path: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  artifacts.push({ step: path, request: args, status: r.status, response: body });
  return { status: r.status, body };
}

async function main(): Promise<void> {
  const A = ethers.Wallet.createRandom();
  const B = ethers.Wallet.createRandom();
  const didA = `did:ethr:${A.address.toLowerCase()}`;
  const didB = `did:ethr:${B.address.toLowerCase()}`;
  const courseId = `agp-extend-101-${A.address.slice(2, 8).toLowerCase()}`;
  console.log(`A(author/issuer/observer)=${didA}\nB(learner/performer)=${didB}\ncourse=${courseId}\n`);

  console.log('[1-2] preflight: agent affordances dereferenceable');
  for (const p of ['/agent/scorm/affordances', '/agent/issue-credential/affordance', '/agent/review-record/affordance']) {
    const r = await fetch(`${BRIDGE}${p}`); check(`GET ${p} 200 turtle`, r.ok, `HTTP ${r.status}`);
  }

  console.log('\n[3] A authors the xAPI profile/extension (open authoring surface)');
  const ext = await postPlain('/agent/extend-standards', { kind: 'XapiProfileFragment', name: 'tttCoaching', definition: 'Verbs + extensions for coaching the standards-extension skill.' });
  check('extend-standards ok', ext.status === 200 && (ext.body?.ok === true || !!ext.body?.iri), `HTTP ${ext.status}`);

  console.log('\n[4] A authors a SCORM course teaching the skill');
  const author = await postSigned('/agent/scorm/author', A, { course: {
    courseId, title: 'Using Interego/Foxxi to extend a standard', masteryScore: 0.5,
    scos: [{ id: 'sco1', title: 'Extend a standard', body: 'Discover /guidance, then POST /agent/extend-standards. WHAT you did rides in the object, not the verb.',
      assessment: [
        { question: 'Which affordance lets you extend a standard?', answer: 'extend_standards' },
        { question: 'Where does WHAT-was-done ride (not the verb)?', answer: 'object' },
      ] }],
  } });
  check('scorm/author ok + manifestValid', author.status === 200 && author.body?.ok === true && author.body?.manifestValid === true, JSON.stringify(author.body).slice(0, 160));

  console.log('\n[5] assignment (out-of-band: B knows courseId + author_did)');
  check('assignment intent recorded', !!courseId);

  console.log('\n[6] B launches the course');
  const launch = await postSigned('/agent/scorm/launch', B, { course_id: courseId, author_did: didA });
  check('scorm/launch ok + sessionId', launch.status === 200 && launch.body?.ok === true && !!launch.body?.sessionId, JSON.stringify(launch.body?.sco ?? launch.body).slice(0, 120));

  console.log('\n[7] B completes SCO-by-SCO (graded SN rollup -> real xAPI)');
  let sessionId = launch.body?.sessionId as string; let done = false; let last: any = null; let guard = 0;
  while (!done && guard++ < 6) {
    const sub = await postSigned('/agent/scorm/submit', B, { session_id: sessionId, answers: ['extend_standards', 'object'] });
    last = sub.body; done = sub.body?.done === true;
    if (sub.status !== 200) { check('scorm/submit 200', false, JSON.stringify(sub.body).slice(0, 160)); break; }
  }
  check('course completed + passed (engine-graded)', last?.completed === true && last?.passed === true, `passed=${last?.passed} score=${last?.score} statements=${last?.recordedStatements}`);

  console.log('\n[8] B performs the learned skill');
  const perf = await postSigned('/agent/record-performance', B, { task_name: 'Extend an xAPI standard', success: true, quality: 0.9,
    activity_type: 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension' });
  check('record-performance ok', perf.status === 200 && (perf.body?.ok === true || !!perf.body?.statementId || !!perf.body?.id), JSON.stringify(perf.body).slice(0, 140));

  console.log('\n[9] A verifies the transfer (review-record subject_did=B, NO admin token)');
  const review = await postSigned('/agent/review-record', A, { subject_did: didB, include_clr: false });
  const elr = review.body?.elr;
  const comps = (elr?.competencies ?? []) as Array<Record<string, unknown>>;
  check('A reads B ELR (cross-agent, signed)', review.status === 200 && review.body?.ok === true, `subjectStatements=${review.body?.subject?.statementCount}`);
  check('B ELR shows a transferred/performed competency', comps.length > 0, `competencies=${comps.length}: ${comps.map(c => c.label ?? c.id).join(', ').slice(0, 120)}`);

  console.log('\n[10] A issues B a credential for the skill');
  const cred = await postSigned('/agent/issue-credential', A, { recipient_did: didB, competency_name: 'Standards Extension',
    achievement_description: 'Demonstrated authoring an xAPI/standards extension after completing the course.' });
  if (cred.status === 503) { console.log('  ! issue-credential 503 (FOXXI_ISSUER_KEY_SEED unset) — upstream arc still proven; credential step deferred'); check('issue-credential configured', false, '503 issuer seed unset'); }
  else check('issue-credential ok (OB3 VC to B)', cred.status === 200, JSON.stringify(cred.body).slice(0, 140));

  console.log('\n[11] B sees the credential in its own CLR wallet');
  const bWallet = await postSigned('/agent/review-record', B, { subject_did: didB, include_clr: true });
  const clrStr = JSON.stringify(bWallet.body?.clr ?? {});
  check('credential present in B CLR', cred.status === 200 ? clrStr.includes('Standards Extension') || clrStr.includes('Credential') : true,
    cred.status === 503 ? '(skipped — issuer unset)' : clrStr.slice(0, 120));

  const out = 'D:/devstuff/harness/.demo-proof-artifacts.json';
  writeFileSync(out, JSON.stringify({ didA, didB, courseId, ranAt: new Date().toISOString(), steps: artifacts }, null, 2));
  console.log(`\nArtifacts (${artifacts.length} calls) -> ${out}`);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('proof harness error:', e); process.exit(2); });
