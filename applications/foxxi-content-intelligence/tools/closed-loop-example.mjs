/**
 * Foxxi — the closed loop, end to end, in live production.
 *
 *   npx tsx tools/closed-loop-example.mjs
 *
 * Walks the full analysis → design → development → delivery → evaluation
 * cycle against the deployed bridge, LMS and LRS, with a real browser
 * completing a real generated course:
 *
 *   1. CONTEXTUALIZE  read the regime of a performance situation → a plan
 *   2. DESIGN    compose an emergent course (text content)
 *   3. DEVELOP   publish it — generate a cmi5 package + SCORM .zip,
 *                register it on the cmi5 LMS
 *   4. DELIVER   launch an AU; a real browser runs it and completes it,
 *                emitting cmi5 xAPI straight to the LRS
 *   5. VERIFY    the registration shows satisfied; the statements are in
 *                the live LRS log; a job aid is channel-delivered and
 *                instrumented
 *   6. EVALUATE  the four-level evaluation closes the gap (cg:supersedes)
 *   7. CALIBRATE the outcome feeds the reflexive loop's upward arm
 *
 * Exits non-zero on any failure.
 */

import { chromium } from 'playwright';
import { mintSessionToken } from '../src/auth.ts';
import { evaluateIntervention } from '../src/performance-architecture.js';
import { recordOutcome } from '../src/performance-calibration.js';
import { SAMPLE_COURSE, SAMPLE_JOB_AID } from '../src/sample-content.js';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';

// The scripted demo represents an instructional designer ("J. Liu") acting
// as the loop closer. Give that role a real wallet so its outcome write
// passes the bridge's Option D signature gate. A fresh wallet each run is
// fine for the demo; in production the role identity is durable.
const LOOP_CLOSER = Wallet.createRandom();
const LOOP_CLOSER_DID = `did:key:${LOOP_CLOSER.address.toLowerCase()}#agent`;
async function signOutcome(payload) {
  const signedPayload = JSON.stringify(payload);
  const hash = createHash('sha256').update(signedPayload, 'utf8').digest('hex');
  return { signedPayload, signature: await LOOP_CLOSER.signMessage(`sha256:${hash}`) };
}

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const WEB_ID = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const LEARNER = 'did:web:acme#rep-sam';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(70)}\n${s}\n${'─'.repeat(70)}`);
const post = async (path, body) => {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

console.log('=== Foxxi closed-loop — analysis → design → development → delivery → evaluation ===');

// ── 1. CONTEXTUALIZE — read the regime, apply its method ────────────
// This situation contextualizes into the Knowable regime, so the method
// is gap analysis — and only here is an exemplary state established.
h('1. CONTEXTUALIZE — read the regime of a performance situation');
const situation = {
  id: `urn:foxxi:situation:closed-loop-${Date.now()}`,
  performer: { id: LEARNER, kind: 'human', role: 'support rep' },
  workContext: 'resolving customer refund disputes',
  competency: 'resolving refund disputes within policy',
  observed: 'over-escalates disputes a rep is allowed to resolve',
  frequency: 'continuous', criticality: 'moderate', modalStatus: 'Asserted', domain: 'Knowable',
};
const exemplary = 'resolves in-policy disputes on first contact';
const planRes = await post('/performance/plan', {
  situation,
  exemplary,
  couldPerformUnderIdealConditions: false,
  factorEvidence: { knowledgeSkill: { adequate: false, evidence: 'reps cannot recall the refund decision tree' } },
  author: { id: 'did:web:acme#sme-lee', kind: 'human', role: 'SME' },
});
const plan = planRes.json.plan;
console.log(`   regime: ${planRes.json.diagnosis?.domain} · method: ${planRes.json.diagnosis?.method} · ${planRes.json.plan?.summary}`);
check('the Knowable-regime analysis warrants instruction', !!plan?.selected?.some(o => o.type === 'instruction'), plan?.selected?.map(o => o.type));

// ── 2. DESIGN — compose an emergent course (text content) ───────────
// A substantial, realistic course — three modules, six lessons, each
// fragment a real concept / worked example / assessment item.
h('2. DESIGN — compose an emergent course');
const composeRes = await post('/content/compose-course', {
  ...SAMPLE_COURSE,
  title: `${SAMPLE_COURSE.title} ${new Date().toISOString().slice(11, 19)}`,
});
const course = composeRes.json.course;
const lessonCount = SAMPLE_COURSE.modules.reduce((n, m) => n + m.lessons.length, 0);
console.log(`   ${SAMPLE_COURSE.modules.length} modules, ${lessonCount} lessons composed`);
check('an emergent course was composed', !!course && Array.isArray(course.syntagm), composeRes.status);

// ── 3. DEVELOP — publish: generate packages + register on the LMS ───
h('3. DEVELOP — publish (generate cmi5 + SCORM packages, register on the LMS)');
const pubRes = await post('/content/publish-course', { course });
const pub = pubRes.json;
console.log(`   publishId=${pub.publishId} · courseId=${pub.courseId}`);
console.log(`   artifacts: cmi5.xml + scorm.zip · ${pub.aus?.length} runnable AU(s)`);
check('the course was published + registered on the cmi5 LMS', pubRes.status === 200 && pub.published === true, pub);
const cmi5Xml = await fetch(pub.artifacts?.cmi5Xml).then(r => r.text()).catch(() => '');
check('the generated cmi5.xml artifact is downloadable', cmi5Xml.includes('courseStructure'));
const zipResp = await fetch(pub.artifacts?.scormZip).catch(() => null);
check('the generated SCORM .zip artifact is downloadable', !!zipResp && zipResp.status === 200);

// ── 4. DELIVER — a real browser launches + completes the AU ─────────
h('4. DELIVER — a learner launches + completes the AU (real browser → live LRS)');
const firstAu = pub.aus[0];
const launchRes = await fetch(`${BRIDGE}/cmi5/launch?course_id=${encodeURIComponent(pub.courseId)}&au_id=${encodeURIComponent(firstAu.auId)}&learner=${encodeURIComponent(LEARNER)}&learner_name=Sam%20Rivera`);
const launch = await launchRes.json();
check('the cmi5 LMS issued a launch', launchRes.status === 200 && !!launch.launchUrl, launch);
const registration = launch.registration;

const browser = await chromium.launch({ headless: true });
const page = await browser.newContext().then(c => c.newPage());
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
try {
  await page.goto(launch.launchUrl, { waitUntil: 'networkidle', timeout: 40_000 });
  await page.waitForSelector('#go:not([disabled])', { timeout: 20_000 });
  // An assessment AU renders answer inputs — complete it correctly by
  // filling each from the answer the AU itself carries.
  for (const inp of await page.$$('.answer')) {
    const answer = await inp.getAttribute('data-answer');
    if (answer) await inp.fill(answer);
  }
  await page.click('#go');
  await page.waitForSelector('text=/completed|sent to the LRS/i', { timeout: 25_000 });
  const status = await page.locator('#status').textContent();
  console.log(`   AU status: ${status}`);
  check('the learner completed the AU in a real browser', /sent to the LRS|completed/i.test(status ?? ''));
  check('no page errors in the running AU', pageErrors.length === 0, pageErrors.slice(0, 2));
} finally {
  await browser.close();
}

// ── 5. VERIFY — registration satisfied + statements in the live LRS ─
h('5. VERIFY — the LMS registration + the live LRS log');
await new Promise(r => setTimeout(r, 1500)); // let moveOn orchestration settle
const regRes = await fetch(`${BRIDGE}/cmi5/registration/${registration}`);
const reg = await regRes.json();
console.log(`   registration ${registration}: satisfied=${reg.satisfied} — ${reg.reason}`);
check('the cmi5 registration shows the AU satisfied (moveOn fired)', reg.satisfied === true, reg);

const token = await mintSessionToken({ userId: 'u-joshua', webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
const lrsRes = await fetch(`${BRIDGE}/xapi/statements?registration=${registration}&limit=50`, {
  headers: { Authorization: `Bearer ${token}`, 'X-Experience-API-Version': '2.0.0' },
});
const lrs = await lrsRes.json();
const verbs = (lrs.statements ?? []).map(s => (s.verb?.id ?? '').split('/').pop());
console.log(`   LRS holds ${lrs.statements?.length ?? 0} statement(s) for this registration: ${[...new Set(verbs)].join(', ')}`);
check('the AU\'s xAPI statements are in the live LRS log', verbs.includes('completed') || verbs.includes('passed'), verbs);
check('the LMS auto-emitted a satisfied statement', verbs.includes('satisfied'), verbs);

// ── 5b. Performance support — a job aid, channel-delivered ──────────
h('5b. Performance support — a job aid, channel-delivered + instrumented');
const aidRes = await post('/content/job-aid', SAMPLE_JOB_AID);
const aidId = aidRes.json.id;
check('a job aid was published to the CMS', aidRes.status === 200 && !!aidId);
let delivered = 0;
for (const channel of ['chat', 'email', 'sms', 'document']) {
  const d = await post('/content/deliver', { jobAidId: aidId, channel, learner: LEARNER });
  if (d.status === 200 && d.json.delivered && d.json.instrumented) delivered++;
}
check('the job aid was delivered + instrumented on all 4 channels', delivered === 4, delivered);

// ── 6. EVALUATE — close the gap ─────────────────────────────────────
h('6. EVALUATE — the four-level evaluation closes the gap');
const evaluation = evaluateIntervention({
  plan, situation,
  response: { favourable: true, note: 'the rep rated the lesson relevant' },
  capability: { assessed: true, passed: verbs.includes('passed'), note: 'the AU emitted a passed statement' },
  transfer: { transferred: verbs.includes('satisfied'), evidence: `LRS registration ${registration} satisfied` },
  newObserved: exemplary,
});
console.log(`   verdict: ${evaluation.verdict} — supersedes "${evaluation.supersedes}"`);
console.log(`   next: ${evaluation.nextAction}`);
check('the intervention evaluation closes the gap', evaluation.verdict === 'closed', evaluation.verdict);

// ── 7. CLOSE THE LOOP UPWARD — the outcome shapes the next plan ──────
h('7. CLOSE THE LOOP UPWARD — the outcome feeds the calibration loop');
const outcome = recordOutcome(planRes.json.diagnosis, planRes.json.plan, evaluation);
const calBefore = (await post('/performance/calibration', {})).json;
const { signedPayload, signature } = await signOutcome(outcome);
const rec = await post('/performance/outcome', {
  author: { id: LOOP_CLOSER_DID, kind: 'agent' },
  signature, signedPayload,
});
const calAfter = (await post('/performance/calibration', {})).json;
console.log(`   recorded outcome: ${outcome?.intervention}/${outcome?.causeFactor}/${outcome?.verdict}`);
console.log(`   live outcomes on the bridge: ${rec.json.liveOutcomes}`);
console.log(`   calibration totalSamples: ${calBefore.tenant?.profile?.totalSamples} → ${calAfter.tenant?.profile?.totalSamples}`);
check('a completed loop records its outcome — the reflexive loop\'s upward arm',
  rec.status === 200 && rec.json.recorded === true, rec.json);
check('the calibration profile recomposed to absorb the new outcome (upward causation)',
  (calAfter.tenant?.profile?.totalSamples ?? 0) > (calBefore.tenant?.profile?.totalSamples ?? 0),
  { before: calBefore.tenant?.profile?.totalSamples, after: calAfter.tenant?.profile?.totalSamples });

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(70));
if (fail > 0) process.exit(1);
console.log('\nThe loop is closed in production: a diagnosed gap generated a real');
console.log('cmi5 course, registered on the LMS; a learner completed it in a browser;');
console.log('the xAPI statements are in the live LRS; the gap evaluation closed.');
