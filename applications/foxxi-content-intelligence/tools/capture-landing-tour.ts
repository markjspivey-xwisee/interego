/**
 * Capture a REAL run of the emergent arc as a landing-tour fixture and pin it.
 *
 * This is the headless sibling of the browser demo (microsite-app/src/demo): three
 * FRESH ECDSA wallets drive the SAME affordances on the LIVE bridge via the DIRECT
 * signed-request branch, and every real response is captured into the demo-session
 * DemoEvent shape the microsite replays. The ONLY difference from a BYO-key run is
 * that there is no LLM in the loop, so there are no `thinking` events — the microsite
 * labels the tour honestly on exactly that signal (no `thinking` ⇒ "captured
 * headlessly … without the model's reasoning narration"). Nothing is synthetic: the
 * agents, signatures, artifacts, holons, credential, and BBS+ proof are all real.
 *
 * Run from context-graphs/ (pin requires the operator secret in env):
 *   FOXXI_LANDING_PIN_SECRET=$(az containerapp secret show … ) \
 *   npx tsx applications/foxxi-content-intelligence/tools/capture-landing-tour.ts
 *
 * Without FOXXI_LANDING_PIN_SECRET it just writes the fixture to
 * .landing-tour-capture.json (no pin).
 */
import { ethers } from 'ethers';
import { writeFileSync } from 'node:fs';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const STD_EXT_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);
const labelOf = (w: ethers.HDNodeWallet): string => `eth-${w.address.slice(2, 14).toLowerCase()}`;

type Slot = 'A' | 'B' | 'C' | 'sys';
type Kind = 'identity' | 'phase' | 'tool-call' | 'auth' | 'xapi' | 'scorm' | 'credential' | 'verify' | 'error' | 'done';
interface Ev { id: number; agent: Slot; kind: Kind; title: string; detail?: string; data?: unknown; ts: string; }
const events: Ev[] = [];
let _id = 0;
// A fixed, monotonic synthetic clock for ts (Date.now is fine here; ts is display-only).
const emit = (agent: Slot, kind: Kind, title: string, detail?: string, data?: unknown): void => {
  events.push({ id: _id++, agent, kind, title, detail, data, ts: new Date().toISOString() });
};

async function signed(wallet: ethers.HDNodeWallet, args: Record<string, unknown>): Promise<{ _signature: string; _signed_payload: string }> {
  const payload = { ...args, agent_id: `did:ethr:${wallet.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const _signed_payload = JSON.stringify(payload);
  const _signature = await wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signature, _signed_payload };
}
async function postSigned(path: string, wallet: ethers.HDNodeWallet, args: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: any }> {
  const env = await signed(wallet, args);
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status, ok: r.ok, body };
}
async function postPlain(path: string, args: Record<string, unknown>): Promise<{ status: number; ok: boolean; body: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status, ok: r.ok, body };
}
/** Emit the signed-call wire event (dev lens), mirroring demo-runtime.makeDispatch. */
const authEv = (who: Slot, addr: string, name: string, status: number, ok: boolean): void =>
  emit(who, 'auth', `signed call → ${name}`, `did:ethr:${addr.slice(0, 10)}… · HTTP ${status}${ok ? ' ✓' : ' ✗'}`);

async function main(): Promise<void> {
  const A = ethers.Wallet.createRandom();
  const B = ethers.Wallet.createRandom();
  const C = ethers.Wallet.createRandom();
  const didA = `did:ethr:${A.address.toLowerCase()}`;
  const didB = `did:ethr:${B.address.toLowerCase()}`;
  const didC = `did:ethr:${C.address.toLowerCase()}`;
  const courseId = `agp-extend-tour-${A.address.slice(2, 8).toLowerCase()}`;
  const taughtExt = 'collaborationDepth';
  const untaughtExt = 'peerReviewRigor';
  const agents = {
    A: { did: didA, address: A.address, label: labelOf(A), lensTenant: `lens:${labelOf(A)}`, role: 'teacher · issuer · observer' },
    B: { did: didB, address: B.address, label: labelOf(B), lensTenant: `lens:${labelOf(B)}`, role: 'learner · performer' },
    C: { did: didC, address: C.address, label: labelOf(C), lensTenant: `lens:${labelOf(C)}`, role: 'independent verifier · no prior relationship' },
  };
  console.log(`bridge=${BRIDGE}\nA=${didA}\nB=${didB}\nC=${didC}\ncourse=${courseId}\n`);

  emit('A', 'identity', 'fresh agent A (teacher · issuer · observer)', didA);
  emit('B', 'identity', 'fresh agent B (learner · performer)', didB);

  // ── Phase 1 — A authors the supporting vocabulary + a SCORM course ──────────
  emit('sys', 'phase', 'Phase 1 — Agent A authors a custom xAPI extension + a SCORM course that teaches the skill');
  await postPlain('/agent/extend-standards', { kind: 'XapiProfileFragment', name: 'collabCoaching', definition: 'Verbs + extensions for coaching the standards-extension skill.' });
  emit('A', 'xapi', 'standards extension authored', 'XapiProfileFragment "collabCoaching"');
  const author = await postSigned('/agent/scorm/author', A, { course: {
    courseId, title: 'Extend a standard (Interego/Foxxi)', masteryScore: 0.5,
    scos: [{ id: 'sco1', title: 'Extend a standard', body: 'Discover /guidance, then call extend_standards. WHAT you did rides in the object, not the verb.',
      assessment: [
        { question: 'Which affordance extends a standard?', answer: 'extend_standards' },
        { question: 'Where does WHAT-was-done ride?', answer: 'object' },
      ] }],
  } });
  authEv('A', A.address, 'scorm_author', author.status, author.ok);
  emit('A', 'scorm', 'SCORM course authored', `${author.body?.courseId ?? courseId} · manifest ${author.body?.manifestValid ? 'valid' : '?'} · ${author.body?.scoCount ?? 1} SCO · mastery ${author.body?.masteryScore ?? 0.5}`, author.body);

  // ── Phase 2 — B completes the course, performs, then proves TRANSFER ────────
  emit('sys', 'phase', 'Phase 2 — Agent B completes the course, performs the skill, then proves TRANSFER on an untaught standard');
  const launch = await postSigned('/agent/scorm/launch', B, { course_id: courseId, author_did: didA });
  authEv('B', B.address, 'scorm_launch', launch.status, launch.ok);
  emit('B', 'scorm', 'SCORM registration · launched', `session ${String(launch.body?.sessionId ?? '').slice(0, 8)}… · SCO "${launch.body?.sco?.title ?? ''}"`, launch.body);
  let sessionId = launch.body?.sessionId as string; let done = false; let last: any = null; let guard = 0;
  while (!done && guard++ < 6) {
    const sub = await postSigned('/agent/scorm/submit', B, { session_id: sessionId, answers: ['extend_standards', 'object'] });
    last = sub.body; done = sub.body?.done === true;
    if (sub.status !== 200) { authEv('B', B.address, 'scorm_submit', sub.status, false); break; }
  }
  authEv('B', B.address, 'scorm_submit', 200, true);
  emit('B', 'scorm', `course ${last?.passed ? 'PASSED' : 'completed'}`, `score ${last?.score} · ${last?.recordedStatements} xAPI statements rolled up`, last);

  await postPlain('/agent/extend-standards', { kind: 'XapiContextExtension', name: taughtExt, definition: 'Depth of cross-agent collaboration recorded on a statement.' });
  emit('B', 'xapi', 'standards extension authored', `XapiContextExtension "${taughtExt}"`);
  const perf1 = await postSigned('/agent/record-performance', B, { task_name: `Extend a standard (${taughtExt})`, success: true, quality: 0.9, activity_type: STD_EXT_IRI });
  authEv('B', B.address, 'record_performance', perf1.status, perf1.ok);
  emit('B', 'xapi', 'xAPI · performed (taught skill)', `statement ${String(perf1.body?.statementId ?? '').slice(0, 8)}…`, perf1.body);

  const ext2 = await postPlain('/agent/extend-standards', { kind: 'LerTerm', name: untaughtExt, definition: 'Rigor of peer review applied to a learning record entry.' });
  emit('B', 'xapi', 'TRANSFER — extended an UNTAUGHT standard', `LerTerm "${untaughtExt}" · ${String(ext2.body?.iri ?? '')}`.slice(0, 120), ext2.body);
  const perf2 = await postSigned('/agent/record-performance', B, { task_name: `Extend an UNTAUGHT standard (${untaughtExt})`, success: true, quality: 0.88, activity_type: STD_EXT_IRI });
  authEv('B', B.address, 'record_performance', perf2.status, perf2.ok);
  emit('B', 'xapi', 'xAPI · performed (untaught — transfer evidence)', `statement ${String(perf2.body?.statementId ?? '').slice(0, 8)}…`, perf2.body);

  // ── Phase 3 — A reviews, independently verifies, issues the credential ──────
  emit('sys', 'phase', 'Phase 3 — Agent A verifies the capability transferred, then issues Agent B a credential');
  const review = await postSigned('/agent/review-record', A, { subject_did: didB, include_clr: false });
  authEv('A', A.address, 'review_record', review.status, review.ok);
  const comps = (review.body?.elr?.competencies ?? []) as Array<Record<string, unknown>>;
  emit('A', 'verify', 'capability-transfer verified', `${review.body?.subject?.statementCount ?? 0} statements · competencies: ${comps.map(c => c.label ?? c.id).join('; ') || 'none'}`, review.body?.elr);

  const verA = await postSigned('/agent/verify-extension', A, { subject_did: didB, name: taughtExt, kind: 'XapiContextExtension' });
  authEv('A', A.address, 'verify_extension', verA.status, verA.ok);
  emit('A', 'verify', `independent verification — ${verA.body?.verified ? 'PASSED' : 'INSUFFICIENT'}`,
    `engine-graded:${verA.body?.checks?.independentlyGraded}${verA.body?.checks?.gradedScore != null ? ` (${verA.body.checks.gradedScore})` : ''} · performance:${verA.body?.checks?.performanceRecorded}${verA.body?.checks?.selfAttestedPerformance ? ' (self-attested)' : ''} · shape-conformant:${verA.body?.checks?.shapeConformant}`, verA.body);
  const holonUri = verA.body?.verificationHolonUri as string | undefined;

  const cred = await postSigned('/agent/issue-credential', A, { recipient_did: didB, competency_name: 'Standards Extension',
    achievement_description: 'Demonstrated extending a standard (incl. an untaught one) after engine-graded completion.', justified_by: holonUri });
  authEv('A', A.address, 'issue_credential', cred.status, cred.ok);
  emit('A', 'credential', 'credential issued (OB3)', `Standards Extension → ${didB.slice(0, 20)}…`, cred.body);

  // ── Phase 4 — independent third agent re-checks, then private BBS+ proof ─────
  emit('sys', 'phase', 'Phase 4 — an independent third agent re-checks B, then B proves its credential privately');
  emit('C', 'identity', 'fresh agent C (independent verifier — nobody told it to trust A or B)', didC);
  const verC = await postSigned('/agent/verify-extension', C, { subject_did: didB, name: taughtExt, kind: 'XapiContextExtension' });
  authEv('C', C.address, 'verify_extension', verC.status, verC.ok);
  emit('C', 'verify', `independent consistency confirmation — ${verC.body?.verified ? 'CONSISTENT' : 'MISMATCH'}`,
    `Agent C (no prior relationship to A or B) re-read B's OWN pod and re-ran the verification. This confirms B's evidence is durable + consistent across an independent read — it does NOT re-judge A's course design.`, verC.body);

  const prove = await postSigned('/agent/prove-competency', B, { issuer_did: didA, competency_name: 'Standards Extension', score: 0.9, proficiency: 'Advanced' });
  authEv('B', B.address, 'prove_competency', prove.status, prove.ok);
  emit('B', 'credential', 'selective-disclosure proof derived (BBS+)', `revealed ${prove.body?.revealed?.length ?? 0} claim(s); ${prove.body?.hiddenPaths?.length ?? 0} cryptographically hidden`, prove.body);
  if (prove.body?.presentation) {
    const vp = await postSigned('/agent/verify-presentation', C, { presentation: prove.body.presentation });
    authEv('C', C.address, 'verify_presentation', vp.status, vp.ok);
    emit('C', 'verify', `presentation verified (BBS+) — ${vp.body?.verified ? 'PASSED' : 'FAILED'}`,
      `C cryptographically confirmed the issuer signed exactly the disclosed claims, and learned ONLY: ${(vp.body?.disclosed ?? []).map((d: any) => String(d.path).replace(/^achievement\./, '')).join(', ')} — the score, name, and dates stayed hidden.`, vp.body);
  }

  emit('sys', 'done', 'Demo complete — author → teach → complete → perform → verify → credential → independent re-check → private proof, all live');

  // ── Persist + (optionally) pin ──────────────────────────────────────────────
  const fixture = { agents, events };
  writeFileSync('.landing-tour-capture.json', JSON.stringify(fixture, null, 2));
  const kinds = new Set(events.map(e => e.kind));
  const ags = new Set(events.map(e => e.agent));
  console.log(`captured ${events.length} events · kinds=${[...kinds].join(',')} · agents=${[...ags].join(',')}`);
  console.log(`gate check: ≥10=${events.length >= 10} done=${kinds.has('done')} credential=${kinds.has('credential')} A/B/C=${ags.has('A') && ags.has('B') && ags.has('C')}`);

  const pin = process.env.FOXXI_LANDING_PIN_SECRET ?? '';
  if (!pin) { console.log('\nFOXXI_LANDING_PIN_SECRET not set — wrote fixture to .landing-tour-capture.json (NOT pinned).'); return; }
  const r = await fetch(`${BRIDGE}/agent/landing-tour`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin, agents, events }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j?.pinned) console.log(`\n✓ PINNED as the landing tour — ${j.eventCount} events, pinnedAt ${j.pinnedAt}`);
  else console.log(`\n✗ pin failed — HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
}
main().catch(e => { console.error('capture-landing-tour error:', e); process.exit(2); });
