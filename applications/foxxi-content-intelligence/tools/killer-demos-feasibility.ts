/**
 * HEADLESS feasibility proof for the NEW killer-app demo ceremonies, run live
 * BEFORE any UI (same discipline as demo-feasibility-proof.ts).
 *
 * Proves two ceremonies compose end-to-end on the LIVE bridge with fresh,
 * self-sovereign wallets and NO pre-provisioning:
 *
 *  (A) PORTFOLIO — "an agent walks into a new job". A training authority T
 *      teaches + credentials a candidate K (real engine-graded SCORM + OB3 VC).
 *      Then a FRESH employer E (no prior relationship) reads K's OWN pod, re-runs
 *      verification independently, K proves the competency via BBS+ selective
 *      disclosure (score hidden), E verifies the proof, a deterministic decision
 *      function matches it against a job spec, and E records the decision back to
 *      the substrate (the verification act becomes itself verifiable evidence).
 *
 *  (B) EVIDENCE PACK — a fresh agent G performs a signed action; the pack is
 *      assembled with ZERO trust in us: the signer is recovered from the raw
 *      bytes client-side (ethers.verifyMessage), the action is validated against
 *      the live dereferenceable SHACL shapes (/ns/xapi/validate), and the shape
 *      IRI itself dereferences. This is the "curl from a clean seat re-verifies"
 *      kill-shot, exercised headlessly.
 *
 * Run from context-graphs/:
 *   npx tsx applications/foxxi-content-intelligence/tools/killer-demos-feasibility.ts
 */
import { ethers } from 'ethers';

const BRIDGE = 'https://foxxi-bridge.interego.xwisee.com';
const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

interface Env { _signature: string; _signed_payload: string }
async function signEnv(w: ethers.HDNodeWallet, args: Record<string, unknown>): Promise<Env> {
  const payload = { ...args, agent_id: `did:ethr:${w.address.toLowerCase()}`, timestamp: new Date().toISOString() };
  const _signed_payload = JSON.stringify(payload);
  const _signature = await w.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  return { _signature, _signed_payload };
}
async function postSigned(path: string, w: ethers.HDNodeWallet, args: Record<string, unknown>): Promise<{ status: number; body: any; env: Env }> {
  const env = await signEnv(w, args);
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status, body, env };
}
async function postPlain(path: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  let body: any = null; try { body = await r.json(); } catch { body = await r.text().catch(() => null); }
  return { status: r.status, body };
}

const STD_EXT_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';

// ── The deterministic hiring decision function (the net-new logic for demo #2) ──
interface JobSpec { role: string; requiredCompetency: string; minProficiency: string; tamperEvidentRequired: boolean }
const PROFICIENCY_ORDER = ['Novice', 'Beginner', 'Intermediate', 'Advanced', 'Expert'];
interface DecisionInput {
  spec: JobSpec;
  verify: any;                 // employer's independent verify-extension result
  presentation: any;           // verify-presentation result (disclosed claims)
}
function decide(d: DecisionInput): { verdict: 'ACCEPT' | 'REJECT'; reasons: string[] } {
  const reasons: string[] = [];
  const checks = d.verify?.checks ?? {};
  const disclosed: Array<{ path: string; value: string }> = d.presentation?.disclosed ?? [];
  const provVal = disclosed.find(x => /proficiency/i.test(x.path))?.value
    ?? disclosed.find(x => PROFICIENCY_ORDER.includes(x.value))?.value;
  const compVal = disclosed.find(x => /competen|achiev|name/i.test(x.path))?.value;

  const proofValid = d.presentation?.verified === true;
  if (!proofValid) reasons.push('BBS+ presentation did not verify');

  if (d.spec.tamperEvidentRequired) {
    const tamperEvident = !!checks.independentlyGraded && !!checks.shapeConformant;
    if (!tamperEvident) reasons.push('load-bearing competency lacks tamper-evident (engine-graded + shape-conformant) evidence');
  }

  const haveProf = provVal && PROFICIENCY_ORDER.indexOf(provVal) >= PROFICIENCY_ORDER.indexOf(d.spec.minProficiency);
  if (!haveProf) reasons.push(`disclosed proficiency ${provVal ?? 'none'} < required ${d.spec.minProficiency}`);

  const verdict = reasons.length === 0 ? 'ACCEPT' : 'REJECT';
  if (verdict === 'ACCEPT') reasons.push(`competency "${compVal ?? d.spec.requiredCompetency}" backed by tamper-evident evidence at ${provVal}`);
  return { verdict, reasons };
}

async function portfolio(): Promise<void> {
  console.log('\n=== (A) PORTFOLIO — an agent walks into a new job ===');
  const T = ethers.Wallet.createRandom();   // training authority / prior employer
  const K = ethers.Wallet.createRandom();   // candidate
  const didT = `did:ethr:${T.address.toLowerCase()}`;
  const didK = `did:ethr:${K.address.toLowerCase()}`;
  const courseId = `agp-hire-${T.address.slice(2, 8).toLowerCase()}`;
  console.log(`  T(authority)=${didT}\n  K(candidate)=${didK}\n  course=${courseId}`);

  // T teaches
  const ext = await postPlain('/agent/extend-standards', { kind: 'XapiProfileFragment', name: 'hireCoaching', definition: 'Verbs for coaching the standards-extension skill.' });
  check('T authored xAPI profile', ext.status === 200 && (ext.body?.ok === true || !!ext.body?.iri));
  const author = await postSigned('/agent/scorm/author', T, { course: {
    courseId, title: 'Extend a standard', masteryScore: 0.5,
    scos: [{ id: 'sco1', title: 'Extend a standard', body: 'Discover /guidance, then POST /agent/extend-standards. WHAT you did rides in the object, not the verb.',
      assessment: [{ question: 'Which affordance extends a standard?', answer: 'extend_standards' }, { question: 'Where does WHAT-was-done ride?', answer: 'object' }] }],
  } });
  check('T authored SCORM course (manifest valid)', author.status === 200 && author.body?.manifestValid === true);

  // K completes (engine-graded)
  const launch = await postSigned('/agent/scorm/launch', K, { course_id: courseId, author_did: didT });
  check('K launched course', launch.status === 200 && !!launch.body?.sessionId);
  let done = false, last: any = null, guard = 0;
  const sid = launch.body?.sessionId as string;
  while (!done && guard++ < 6) {
    const sub = await postSigned('/agent/scorm/submit', K, { session_id: sid, answers: ['extend_standards', 'object'] });
    last = sub.body; done = sub.body?.done === true;
    if (sub.status !== 200) break;
  }
  check('K passed (engine-graded)', last?.passed === true, `score=${last?.score} statements=${last?.recordedStatements}`);
  const perf = await postSigned('/agent/record-performance', K, { task_name: 'Extend an xAPI standard', success: true, quality: 0.9, activity_type: STD_EXT_IRI });
  check('K recorded performance', perf.status === 200 && (perf.body?.ok === true || !!perf.body?.statementId));
  // transfer onto an untaught standard
  await postPlain('/agent/extend-standards', { kind: 'LerTerm', name: 'collaborationDepth', definition: 'Depth of cross-agent collaboration evidenced.' });
  await postSigned('/agent/record-performance', K, { task_name: 'Extend an untaught LER standard', success: true, quality: 0.88, activity_type: STD_EXT_IRI });

  // T verifies + credentials
  const tVer = await postSigned('/agent/verify-extension', T, { subject_did: didK, name: 'collaborationDepth', kind: 'XapiContextExtension' });
  check('T verified K (engine-graded)', tVer.status === 200 && tVer.body?.verified === true, `holon=${String(tVer.body?.verificationHolonUri ?? '').slice(0, 48)}`);
  const cred = await postSigned('/agent/issue-credential', T, { recipient_did: didK, competency_name: 'Standards Extension', achievement_description: 'Demonstrated extending a standard after an engine-graded course.', justified_by: tVer.body?.verificationHolonUri });
  check('T issued K an OB3 credential', cred.status === 200, cred.status === 503 ? '503 issuer seed unset' : JSON.stringify(cred.body).slice(0, 80));

  // ── The hiring motion: a FRESH employer, no prior relationship ──
  const E = ethers.Wallet.createRandom();
  const didE = `did:ethr:${E.address.toLowerCase()}`;
  console.log(`  E(employer, fresh)=${didE}`);
  const spec: JobSpec = { role: 'Standards Integration Engineer', requiredCompetency: 'Standards Extension', minProficiency: 'Advanced', tamperEvidentRequired: true };

  const review = await postSigned('/agent/review-record', E, { subject_did: didK, include_clr: true });
  check('E read K OWN pod (cross-agent, no admin token)', review.status === 200 && review.body?.ok === true, `subjectStatements=${review.body?.subject?.statementCount}`);
  const eVer = await postSigned('/agent/verify-extension', E, { subject_did: didK, name: 'collaborationDepth', kind: 'XapiContextExtension' });
  check('E independently re-verified K', eVer.status === 200 && eVer.body?.verified === true, `engineGraded=${eVer.body?.checks?.independentlyGraded} shapeConformant=${eVer.body?.checks?.shapeConformant}`);

  // K proves the competency privately; E verifies; learns ONLY disclosed claims
  const prove = await postSigned('/agent/prove-competency', K, { issuer_did: didT, competency_name: 'Standards Extension', score: 0.9, proficiency: 'Advanced' });
  check('K derived BBS+ proof (score hidden)', prove.status === 200 && Array.isArray(prove.body?.revealed) && Array.isArray(prove.body?.hiddenPaths), `revealed=${prove.body?.revealed?.length} hidden=${prove.body?.hiddenPaths?.length}`);
  let vp: any = { body: {} };
  if (prove.body?.presentation) {
    vp = await postSigned('/agent/verify-presentation', E, { presentation: prove.body.presentation });
    check('E verified the BBS+ presentation', vp.status === 200 && vp.body?.verified === true, `disclosed=${(vp.body?.disclosed ?? []).map((d: any) => d.path).join(',').slice(0, 60)}`);
    const scoreLeaked = JSON.stringify(vp.body?.disclosed ?? []).match(/0\.9|score/i);
    check('score did NOT leak to E (selective disclosure honored)', !scoreLeaked, scoreLeaked ? 'LEAK' : 'score hidden');
  }

  // The deterministic decision
  const decision = decide({ spec, verify: eVer.body, presentation: vp.body });
  check('decision function returns ACCEPT for a qualified candidate', decision.verdict === 'ACCEPT', decision.reasons.join('; ').slice(0, 120));

  // Negative control: a stricter spec the candidate does not meet
  const strict: JobSpec = { ...spec, minProficiency: 'Expert' };
  const negative = decide({ spec: strict, verify: eVer.body, presentation: vp.body });
  check('decision function REJECTS when proficiency below bar (no false ACCEPT)', negative.verdict === 'REJECT', negative.reasons.join('; ').slice(0, 100));

  // Recursion close (dogfooding): E records its decision back onto the substrate
  const rec = await postSigned('/agent/record-performance', E, { task_name: `Hiring decision: ${decision.verdict} candidate for ${spec.role}`, success: decision.verdict === 'ACCEPT', quality: 1, activity_type: STD_EXT_IRI });
  check('E recorded the hiring DECISION back to substrate (verification is itself evidence)', rec.status === 200 && (rec.body?.ok === true || !!rec.body?.statementId));
}

async function evidencePack(): Promise<void> {
  console.log('\n=== (B) EVIDENCE PACK — self-proving, verifiable from a clean seat ===');
  const G = ethers.Wallet.createRandom();
  const didG = `did:ethr:${G.address.toLowerCase()}`;
  console.log(`  G(actor, fresh)=${didG}`);

  // 1) a real consequential signed action
  const act = await postSigned('/agent/record-performance', G, { task_name: 'Consequential agent action under audit', success: true, quality: 1, activity_type: STD_EXT_IRI });
  check('G performed a real signed action', act.status === 200 && (act.body?.ok === true || !!act.body?.statementId));

  // 2) KILL-SHOT part 1 — recover the signer from the raw bytes alone (client-side)
  const recovered = ethers.verifyMessage(`sha256:${sha256Hex(act.env._signed_payload)}`, act.env._signature).toLowerCase();
  check('signer recovered from bytes alone == G (no trust in the bridge)', recovered === G.address.toLowerCase(), `${recovered.slice(0, 12)}…`);
  // tamper-evidence: flip one byte of the payload -> recovery no longer matches
  const tampered = act.env._signed_payload.replace(/Consequential/, 'Tampered');
  const recTampered = ethers.verifyMessage(`sha256:${sha256Hex(tampered)}`, act.env._signature).toLowerCase();
  check('one-byte tamper breaks the signature recovery', recTampered !== G.address.toLowerCase(), 'recovery diverges');

  // 3) KILL-SHOT part 2 — validate against the live dereferenceable SHACL shapes
  const stmt = {
    actor: { objectType: 'Agent', account: { homePage: BRIDGE, name: didG } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
    object: { id: STD_EXT_IRI, definition: { type: 'http://adlnet.gov/expapi/activities/performance', name: { 'en-US': 'Standards Extension' } } },
  };
  const val = await postPlain('/ns/xapi/validate', { instance: stmt });
  check('action validates against live /ns/xapi shapes', val.status === 200 && val.body?.conforms === true, `shapesIri=${String(val.body?.shapesIri ?? '').slice(0, 56)}`);
  if (val.body?.shapesIri) {
    const r = await fetch(String(val.body.shapesIri).split('#')[0], { headers: { Accept: 'text/turtle' } });
    check('the cited shape IRI itself dereferences (200 turtle)', r.ok, `HTTP ${r.status}`);
  }

  // 4) authority chain from the agent OWN pod (not the envelope)
  const review = await postSigned('/agent/review-record', G, { subject_did: didG, include_clr: false });
  check('authority/identity walked from G OWN pod', review.status === 200 && review.body?.ok === true);

  // 5) framework control citation dereferenceability (expected to be ADDED by this work)
  for (const m of ['soc2', 'eu-ai-act', 'nist-rmf']) {
    const r = await fetch(`${BRIDGE}/ns/${m}`, { headers: { Accept: 'text/turtle' } });
    check(`/ns/${m} dereferences (compliance ontology served)`, r.ok, `HTTP ${r.status}${r.ok ? '' : ' (to be added)'}`);
  }
}

async function livingCurriculum(): Promise<void> {
  console.log('\n=== (C) LIVING CURRICULUM — a course proposes its own successor ===');
  const course = { courseId: 'demo-living-101', title: 'Field Ops Fundamentals', concepts: [
    { id: 'c1', label: 'Handicapping' }, { id: 'c2', label: 'Scoring' }, { id: 'c3', label: 'Etiquette' },
  ] };
  const concept_signals = [
    { id: 'c1', completion: 0.91, fieldSuccess: 0.44 },  // high/low → NOT a content gap → job aid
    { id: 'c2', completion: 0.40, fieldSuccess: 0.40, frequency: 'continuous' },  // low/low + continuously performed → instruction warranted
    // c3 omitted → no signal → instrument-first
  ];
  const r = await postPlain('/agent/course/propose-successor', { course, concept_signals });
  check('propose-successor ok', r.status === 200 && r.body?.ok === true, JSON.stringify(r.body?.summary ?? r.body).slice(0, 120));
  const byId = new Map<string, any>((r.body?.concepts ?? []).map((p: any) => [p.concept.id, p]));
  check('high-completion/low-field → demote+job-aid (refuses the content-gap frame)', byId.get('c1')?.recommendation === 'demote-add-job-aid', `c1=${byId.get('c1')?.recommendation} cause=${byId.get('c1')?.cause}`);
  check('low/low → revise instruction (real knowledge gap)', byId.get('c2')?.recommendation === 'revise-instruction', `c2=${byId.get('c2')?.recommendation}`);
  check('no signal → instrument-first (refuses to claim a regime)', byId.get('c3')?.recommendation === 'instrument-first', `c3=${byId.get('c3')?.recommendation} method=${byId.get('c3')?.method}`);
  check('emits a iep:supersedes successor holon', !!r.body?.successor?.holonUri, String(r.body?.successor?.holonUri ?? '(none)').slice(0, 48));
}

async function federatedCalibration(): Promise<void> {
  console.log('\n=== (D) FEDERATED CALIBRATION — a shared memory two rivals both trust ===');
  const A = ethers.Wallet.createRandom(), B = ethers.Wallet.createRandom();
  const specsA = [
    { regime: 'Knowable', causeFactor: 'knowledgeSkill', intervention: 'instruction', closed: 5, improved: 2, noChange: 2 },
    { regime: 'Emergent', causeFactor: 'motives', intervention: 'coaching', closed: 2, improved: 1, noChange: 0 }, // 3 → k-anon dropped
  ];
  const specsB = [
    { regime: 'Knowable', causeFactor: 'knowledgeSkill', intervention: 'instruction', closed: 6, improved: 1, noChange: 2 },
  ];
  const contributions = [await signEnv(A, { specs: specsA }), await signEnv(B, { specs: specsB })];
  const r = await postPlain('/agent/calibration/merge', { contributions, k: 8, assertThreshold: 12 });
  check('calibration/merge ok', r.status === 200 && r.body?.ok === true, `contributors=${r.body?.contributors?.length}`);
  const cell = (r.body?.merged?.cells ?? []).find((c: any) => c.intervention === 'instruction' && c.causeFactor === 'knowledgeSkill');
  check('pooled cell Asserted (neither org could alone)', cell?.modalStatus === 'Asserted', `samples=${cell?.samples} status=${cell?.modalStatus}`);
  check('k-anonymity dropped the sub-threshold coaching cell', !(r.body?.merged?.cells ?? []).some((c: any) => c.intervention === 'coaching'), 'no coaching cell crossed the boundary');
  check('promoted (Hypothetical→Asserted on pooling) reported', Array.isArray(r.body?.promoted) && r.body.promoted.length > 0, `promoted=${r.body?.promoted?.length}`);
  check('merged memory composed as a dereferenceable holon', !!r.body?.holon?.holonUri, String(r.body?.holon?.holonUri ?? '(none)').slice(0, 48));
}

async function complianceOntologies(): Promise<void> {
  console.log('\n=== (E) COMPLIANCE ONTOLOGIES — every cited control IRI dereferences ===');
  for (const m of ['soc2', 'eu-ai-act', 'nist-rmf']) {
    const r = await fetch(`${BRIDGE}/ns/${m}`, { headers: { Accept: 'text/turtle' } });
    check(`/ns/${m} dereferences (turtle)`, r.ok, `HTTP ${r.status}`);
  }
  const ev = await postPlain('/ns/soc2/validate', { instance: { '@type': 'AccessChangeEvent', evidences: ['CC6.2'], occurredAt: '2026-06-20T00:00:00Z', actor: 'did:ethr:0xabc', signer: '0xabc' } });
  check('soc2 evidence event conforms to served shape', ev.status === 200 && ev.body?.conforms === true, `shapesIri=${String(ev.body?.shapesIri ?? '').slice(0, 50)}`);
}

async function main(): Promise<void> {
  console.log('Killer-demos feasibility — live bridge:', BRIDGE);
  await portfolio();
  await evidencePack();
  await livingCurriculum();
  await federatedCalibration();
  await complianceOntologies();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('harness error:', e); process.exit(2); });
