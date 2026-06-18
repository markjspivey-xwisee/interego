/**
 * HEADLESS proof for the ROADMAP additions on top of the base emergent arc:
 *   - Transfer probe: B extends a DIFFERENT, UNTAUGHT standard (LerTerm) and records it.
 *   - cg:Verification holon: A's verify_extension composes a dereferenceable
 *     foxxi:Verification holon and returns verificationHolonUri.
 *   - Chain of custody: A's issue_credential(justified_by) echoes justifiedBy = that uri.
 *   - Independent re-check: a FRESH third agent C re-runs verify_extension on B's OWN pod.
 *   - BBS+ selective disclosure: B prove_competency -> C verify_presentation, score hidden.
 *
 * Three FRESH ECDSA wallets, DIRECT signed-request branch, LIVE bridge — nothing
 * synthetic. Run from context-graphs/:
 *   npx tsx applications/foxxi-content-intelligence/tools/demo-roadmap-proof.ts
 */
import { ethers } from 'ethers';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const STD_EXT_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);
const labelOf = (w: ethers.HDNodeWallet): string => `eth-${w.address.slice(2, 14).toLowerCase()}`;

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

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
  return { status: r.status, body };
}
async function postPlain(path: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status, body };
}
async function getText(path: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`${BRIDGE}${path}`);
  const text = await r.text().catch(() => '');
  return { status: r.status, text };
}

async function main(): Promise<void> {
  const A = ethers.Wallet.createRandom();
  const B = ethers.Wallet.createRandom();
  const C = ethers.Wallet.createRandom();
  const didA = `did:ethr:${A.address.toLowerCase()}`;
  const didB = `did:ethr:${B.address.toLowerCase()}`;
  const didC = `did:ethr:${C.address.toLowerCase()}`;
  const courseId = `agp-extend-rm-${A.address.slice(2, 8).toLowerCase()}`;
  const taughtExt = 'collaborationDepth';   // the xAPI kind taught by the course
  const untaughtExt = 'peerReviewRigor';    // a DIFFERENT, untaught LerTerm (transfer)
  console.log(`bridge=${BRIDGE}\nA=${didA}\nB=${didB}\nC=${didC}\ncourse=${courseId}\n`);

  console.log('[1] A authors the supporting xAPI vocabulary + a SCORM course');
  await postPlain('/agent/extend-standards', { kind: 'XapiProfileFragment', name: 'collabCoaching', definition: 'Verbs + extensions for coaching the standards-extension skill.' });
  const author = await postSigned('/agent/scorm/author', A, { course: {
    courseId, title: 'Extend a standard (Interego/Foxxi)', masteryScore: 0.5,
    scos: [{ id: 'sco1', title: 'Extend a standard', body: 'Discover /guidance, then call extend_standards. WHAT you did rides in the object, not the verb.',
      assessment: [
        { question: 'Which affordance extends a standard?', answer: 'extend_standards' },
        { question: 'Where does WHAT-was-done ride?', answer: 'object' },
      ] }],
  } });
  check('scorm/author ok + manifestValid', author.status === 200 && author.body?.ok === true && author.body?.manifestValid === true, JSON.stringify(author.body).slice(0, 120));

  console.log('\n[2] B completes the course (engine-graded SN rollup)');
  const launch = await postSigned('/agent/scorm/launch', B, { course_id: courseId, author_did: didA });
  check('scorm/launch ok', launch.status === 200 && !!launch.body?.sessionId, JSON.stringify(launch.body?.sco ?? launch.body).slice(0, 90));
  let sessionId = launch.body?.sessionId as string; let done = false; let last: any = null; let guard = 0;
  while (!done && guard++ < 6) {
    const sub = await postSigned('/agent/scorm/submit', B, { session_id: sessionId, answers: ['extend_standards', 'object'] });
    last = sub.body; done = sub.body?.done === true;
    if (sub.status !== 200) { check('scorm/submit 200', false, JSON.stringify(sub.body).slice(0, 120)); break; }
  }
  check('course PASSED (engine-graded)', last?.completed === true && last?.passed === true, `score=${last?.score} statements=${last?.recordedStatements}`);

  console.log('\n[3] B performs the TAUGHT skill (xAPI extension)');
  // extend-standards is an OPEN (unsigned) authoring surface — the real demo dispatches it via postPlain.
  await postPlain('/agent/extend-standards', { kind: 'XapiContextExtension', name: taughtExt, definition: 'Depth of cross-agent collaboration recorded on a statement.' });
  const perf1 = await postSigned('/agent/record-performance', B, { task_name: `Extend a standard (${taughtExt})`, success: true, quality: 0.9, activity_type: STD_EXT_IRI });
  check('record-performance (taught) ok', perf1.status === 200 && (perf1.body?.ok === true || !!perf1.body?.statementId), JSON.stringify(perf1.body).slice(0, 90));

  console.log('\n[4] TRANSFER PROBE: B extends a DIFFERENT, UNTAUGHT standard (LerTerm)');
  const ext2 = await postPlain('/agent/extend-standards', { kind: 'LerTerm', name: untaughtExt, definition: 'Rigor of peer review applied to a learning record entry.' });
  check('extend untaught LerTerm ok', ext2.status === 200 && (ext2.body?.ok === true || !!ext2.body?.iri), String(ext2.body?.iri ?? '').slice(0, 90));
  const perf2 = await postSigned('/agent/record-performance', B, { task_name: `Extend an UNTAUGHT standard (${untaughtExt})`, success: true, quality: 0.88, activity_type: STD_EXT_IRI });
  check('record-performance (untaught) ok', perf2.status === 200 && (perf2.body?.ok === true || !!perf2.body?.statementId), JSON.stringify(perf2.body).slice(0, 90));

  console.log('\n[5] A reviews B’s record (cross-agent, signed) — transfer evidence present');
  const review = await postSigned('/agent/review-record', A, { subject_did: didB, include_clr: false });
  const comps = (review.body?.elr?.competencies ?? []) as Array<Record<string, unknown>>;
  check('A reads B ELR', review.status === 200 && review.body?.ok === true, `subjectStatements=${review.body?.subject?.statementCount}`);
  check('B ELR shows performed competency(ies)', comps.length > 0, `competencies=${comps.length}: ${comps.map(c => c.label ?? c.id).join(', ').slice(0, 120)}`);

  console.log('\n[6] A independently verifies + composes a cg:Verification holon');
  const verA = await postSigned('/agent/verify-extension', A, { subject_did: didB, name: taughtExt, kind: 'XapiContextExtension' });
  check('verify-extension verified:true', verA.status === 200 && verA.body?.verified === true, `checks=${JSON.stringify(verA.body?.checks)}`);
  const holonUri = verA.body?.verificationHolonUri as string | undefined;
  check('verificationHolonUri returned', !!holonUri, holonUri ?? '(none)');

  console.log('\n[7] the verification holon is DEREFERENCEABLE in A’s lattice (PGSL-composed)');
  if (holonUri) {
    const aLabel = labelOf(A);
    const rdf = await getText(`/agent/lattice/${aLabel}/holon?uri=${encodeURIComponent(holonUri)}&as=rdf`);
    check('GET holon as=rdf 200', rdf.status === 200, `HTTP ${rdf.status} (label ${aLabel})`);
    check('holon RDF is a foxxi:Verification', /Verification/.test(rdf.text), rdf.text.slice(0, 100).replace(/\s+/g, ' '));
    const vc = await getText(`/agent/lattice/${aLabel}/holon?uri=${encodeURIComponent(holonUri)}&as=vc`);
    check('holon also projects as VC', vc.status === 200 && vc.text.length > 0, `HTTP ${vc.status}`);
  } else { check('GET holon as=rdf 200', false, 'no holonUri'); }

  console.log('\n[8] A issues the credential, LINKED to the verification (chain of custody)');
  const cred = await postSigned('/agent/issue-credential', A, { recipient_did: didB, competency_name: 'Standards Extension',
    achievement_description: 'Demonstrated extending a standard (incl. an untaught one) after engine-graded completion.', justified_by: holonUri });
  if (cred.status === 503) check('issue-credential configured', false, '503 issuer seed unset');
  else {
    check('issue-credential ok (OB3)', cred.status === 200 && !!cred.body?.credentialId, String(cred.body?.credentialId ?? '').slice(0, 70));
    check('credential justifiedBy = verification holon', cred.body?.justifiedBy === holonUri, `justifiedBy=${String(cred.body?.justifiedBy ?? '(none)').slice(0, 70)}`);
  }

  console.log('\n[9] INDEPENDENT re-check: fresh agent C re-runs verify on B’s OWN pod');
  const verC = await postSigned('/agent/verify-extension', C, { subject_did: didB, name: taughtExt, kind: 'XapiContextExtension' });
  check('C verify-extension consistent (verified:true)', verC.status === 200 && verC.body?.verified === true, `C=${didC.slice(0, 16)}… checks=${JSON.stringify(verC.body?.checks)}`);

  console.log('\n[10] BBS+ selective disclosure: B proves competency, hiding score/name/dates');
  const prove = await postSigned('/agent/prove-competency', B, { issuer_did: didA, competency_name: 'Standards Extension', score: 0.9, proficiency: 'Advanced' });
  check('prove-competency derived presentation', prove.status === 200 && !!prove.body?.presentation, `revealed=${(prove.body?.revealed ?? []).length} hidden=${(prove.body?.hiddenPaths ?? []).length}`);
  const revealedStr = JSON.stringify(prove.body?.revealed ?? []);
  const hiddenStr = JSON.stringify(prove.body?.hiddenPaths ?? []);
  check('score is among HIDDEN paths', /score/i.test(hiddenStr) && !/score/i.test(revealedStr), `hidden=${hiddenStr.slice(0, 90)}`);

  console.log('\n[11] C verifies the BBS+ presentation — learns ONLY what was disclosed');
  if (prove.body?.presentation) {
    const vp = await postSigned('/agent/verify-presentation', C, { presentation: prove.body.presentation });
    check('verify-presentation verified:true', vp.status === 200 && vp.body?.verified === true, JSON.stringify(vp.body?.disclosed ?? vp.body).slice(0, 110));
    const disclosedStr = JSON.stringify(vp.body?.disclosed ?? []);
    check('disclosed set excludes the score', !/\bscore\b/i.test(disclosedStr), disclosedStr.slice(0, 110));
  } else check('verify-presentation verified:true', false, 'no presentation');

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('roadmap proof harness error:', e); process.exit(2); });
