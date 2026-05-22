/**
 * Foxxi — "ask your networked context", end to end, in live production.
 *
 *   npx tsx tools/ask-your-context-example.mjs
 *
 * Walks the Context Companion against the deployed bridge, LMS and LRS,
 * with a real browser completing a real generated course — and exercises
 * the three things the "honest scope" note named as further work:
 *
 *   · the AUTH GATE  — a progress / assignment question is about a
 *     learner's own record, so it needs a wallet-signed session token;
 *     content questions stay open.
 *   · FEDERATED discovery — scope:interego passes through to the tenant
 *     pod AND a federation peer pod, merged.
 *   · channel TRANSPORT — a `document` delivery is genuinely published
 *     to the pod as a discoverable Context Descriptor.
 *
 * Prerequisite: the federation peer pod must be provisioned first —
 *   npx tsx --tsconfig bridge/tsconfig.json tools/provision-federation-peer.mjs
 * and the bridge deployed with FOXXI_FEDERATION_PODS set to it.
 *
 * Exits non-zero on any failure.
 */

import { chromium } from 'playwright';
import { mintSessionToken } from '../src/auth.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const CSS = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const WEB_ID = `${CSS.replace('interego-css', 'interego-acme-id')}/users/jliu/profile/card#me`;
// The learner is a real Interego user — a Foxxi user *is* an Interego
// user — so progress / assignment questions can be token-bound to them.
const LEARNER = WEB_ID;
const AGENT = 'did:web:acme#support-agent-7';
const PEER_POD = `${CSS}/markj/federation-peer/`;

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};
const h = (s) => console.log(`\n${'─'.repeat(70)}\n${s}\n${'─'.repeat(70)}`);
const post = async (path, body) => {
  const r = await fetch(`${BRIDGE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const ask = async (question, opts = {}) => {
  const { token, ...body } = opts;
  const r = await fetch(`${BRIDGE}/content/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question, ...body }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

console.log('=== Foxxi — ask your networked context (gate · federation · transport) ===');

// A wallet-signed session token for the learner — minted client-side.
const TOKEN = await mintSessionToken({ userId: 'u-joshua', webId: WEB_ID, ttlMs: 30 * 60 * 1000 });

// ── 1. PUBLISH — compose + publish a course and a job aid ───────────
h('1. PUBLISH — a course + a job aid into the networked context');
const author = { id: 'did:web:acme#sme-lee', kind: 'human' };
const composeRes = await post('/content/compose-course', {
  title: `Refund Dispute Resolution ${new Date().toISOString().slice(11, 19)}`,
  competency: 'resolving refund disputes within policy',
  audience: 'human', authoredBy: author,
  modules: [{
    title: 'Refund basics', competencyPoint: 'resolving refund disputes within policy',
    lessons: [
      { title: 'Authority thresholds', competencyPoint: 'refund thresholds', fragments: [
        { modality: 'concept', body: 'A rep may authorise refunds up to $500; above that, route the dispute to a lead.', level: 'foundational' },
        { modality: 'worked-example', body: 'A $420 dispute — the rep resolves it. A $1,300 dispute — route to a lead.', level: 'working' },
      ] },
      { title: 'Thresholds check', competencyPoint: 'refund thresholds', fragments: [
        { modality: 'assessment-item', body: 'Up to what amount may a rep authorise a refund alone? ::: $500', level: 'applied' },
      ] },
    ],
  }],
});
const course = composeRes.json.course;
const pub = (await post('/content/publish-course', { course })).json;
check('the course is published + registered on the LMS', pub.published === true, pub);
const aidRes = await post('/content/job-aid', {
  competencyPoint: 'refund thresholds', triggerContext: 'opening a refund over $500',
  body: 'Over $500 → route the dispute to a lead. The rep handles refunds of $500 or less directly.',
});
const jobAidId = aidRes.json.id;
check('the job aid is published to the CMS', aidRes.status === 200 && !!jobAidId, aidRes.json);

// ── 2. ASK — a concept question (open; agentic RAG) ─────────────────
h('2. ASK — "what does the refund authority threshold mean?" (open)');
const concept = await ask('What does the refund authority threshold mean?', { learner: LEARNER });
console.log(`   intent: ${concept.json.intent} · grounded: ${concept.json.grounded} · llm: ${concept.json.llm?.keySource}`);
check('a content question needs no token and is grounded', concept.status === 200 && concept.json.grounded === true, concept.json);
check('the answer cites a course-fragment source with verbatim content',
  (concept.json.sources ?? []).some(s => s.kind === 'course-fragment'
    && typeof s.excerpt === 'string' && s.excerpt.includes('authorise refunds up to $500')), concept.json.sources);
check('the answer carries the agentic-RAG Interego trace',
  Array.isArray(concept.json.trace) && concept.json.trace.length >= 2, concept.json.trace);

// ── 3. ASK — a procedure question ───────────────────────────────────
h('3. ASK — "how do I handle a refund over $500?"');
const proc = await ask('How do I handle a refund over $500?', { learner: LEARNER });
check('the procedure answer is sourced from the job aid',
  proc.json.grounded === true && (proc.json.sources ?? []).some(s => s.kind === 'job-aid'), proc.json);

// ── 4. ASK — assignments, GATED behind a session token ──────────────
h('4. ASK — assignments (a learner record is PII — it needs a token)');
const noTok = await ask('Do I have any courses assigned to me?');
console.log(`   without a token → HTTP ${noTok.status}`);
check('without a session token a progress/assignment question is rejected (401)',
  noTok.status === 401 && noTok.json.authRequired === true, noTok.json);
const assignPre = await ask('Do I have any courses assigned to me?', { token: TOKEN });
check('with a valid wallet-signed token the assignment question is allowed',
  assignPre.status === 200 && assignPre.json.intent === 'assignments', assignPre.json);
check('the gated answer is bound to the verified identity (not a body-supplied learner)',
  assignPre.json.learner === WEB_ID, assignPre.json.learner);

// ── 5. COMPLETE — a real browser completes the course on the LMS ────
h('5. COMPLETE — a real browser completes the course on the LMS');
const browser = await chromium.launch({ headless: true });
const page = await browser.newContext().then(c => c.newPage());
let completed = 0;
try {
  for (const au of pub.aus) {
    if (completed > 0) await new Promise(r => setTimeout(r, 1800));
    const launchRes = await fetch(`${BRIDGE}/cmi5/launch?course_id=${encodeURIComponent(pub.courseId)}`
      + `&au_id=${encodeURIComponent(au.auId)}&learner=${encodeURIComponent(LEARNER)}&learner_name=Joshua%20Liu`);
    const launch = await launchRes.json();
    if (launchRes.status !== 200 || !launch.launchUrl) { check(`AU "${au.title}" launched`, false, launch); break; }
    await page.goto(launch.launchUrl, { waitUntil: 'networkidle', timeout: 40_000 });
    await page.waitForSelector('#go:not([disabled])', { timeout: 20_000 });
    const answerInput = await page.$('.answer');
    if (answerInput) await answerInput.fill('$500');
    await page.click('#go');
    await page.waitForSelector('text=/completed|sent to the LRS|submitted/i', { timeout: 25_000 });
    completed++;
  }
} finally {
  await browser.close();
}
check('a real browser completed every AU of the course', completed === pub.aus.length, { completed, of: pub.aus.length });
await new Promise(r => setTimeout(r, 2000));

// ── 6. ASK — progress, gated + reading the live LRS ─────────────────
h('6. ASK — "what\'s my progress?" (gated; reads the live LRS)');
const progress = await ask("What's my progress on the refund course?", { token: TOKEN });
console.log(`   intent: ${progress.json.intent} · grounded: ${progress.json.grounded}`);
console.log(`   answer: ${String(progress.json.answer).split('\n')[0]}`);
check('the gated progress question is allowed with the token', progress.status === 200, progress.json);
check('the progress answer is grounded in the learner\'s live LRS activity',
  progress.json.grounded === true && /statement|completed|in progress/i.test(String(progress.json.answer)),
  progress.json.answer);

// ── 7. ASK — agent / human symmetry (open content question) ─────────
h('7. ASK — an agent asks the same question (one substrate, both users)');
const asHuman = await ask('Explain refund thresholds.', { asker: { id: LEARNER, kind: 'human' } });
const asAgent = await ask('Explain refund thresholds.', { asker: { id: AGENT, kind: 'agent' } });
const srcIds = (j) => (j.sources ?? []).map(s => s.id).sort().join(',');
check('an agent and a human get the same grounded retrieval (identical cited sources)',
  asHuman.json.grounded === true && asAgent.json.grounded === true
  && srcIds(asHuman.json).length > 0 && srcIds(asHuman.json) === srcIds(asAgent.json),
  { human: srcIds(asHuman.json), agent: srcIds(asAgent.json) });

// ── 8. ASK — scope + FEDERATED discovery ────────────────────────────
h('8. ASK — scope + federation (Interego passes through to what composes it)');
const golfV = await ask('Do I have anything about golf?', { learner: LEARNER, scope: 'vertical' });
check('scope:vertical narrows the ask to the Foxxi vertical (no golf there)',
  golfV.json.scope === 'vertical' && golfV.json.grounded === false, golfV.json);
const golfI = await ask('Do I have anything about golf?', { learner: LEARNER, scope: 'interego' });
const pods = golfI.json.contextSummary?.interegoPods ?? [];
console.log(`   scope:interego federated across ${pods.length} pod(s): ${pods.length}`);
check('scope:interego federates discovery across multiple pods',
  Array.isArray(pods) && pods.length >= 2, pods);
check('the federated pod set includes the federation peer pod',
  pods.includes(PEER_POD), { pods, expected: PEER_POD });
check('the pass-through surfaces a course the vertical alone never saw (golf, on the tenant pod)',
  golfI.json.grounded === true && (golfI.json.sources ?? []).some(s => s.kind === 'interego-context'),
  golfI.json.sources);
// The federation peer pod carries a course the tenant pod does not.
const peerQ = await ask('How should I triage an incident?', { learner: LEARNER, scope: 'interego' });
console.log(`   peer-course question → grounded: ${peerQ.json.grounded}`);
check('a federation-peer course is discovered, deep-fetched, and answered from',
  peerQ.json.grounded === true && (peerQ.json.sources ?? []).some(s =>
    s.kind === 'interego-context' && typeof s.excerpt === 'string'
    && /triage|severity|incident/i.test(s.excerpt)), peerQ.json.sources);
const peerV = await ask('How should I triage an incident?', { learner: LEARNER, scope: 'vertical' });
check('the same question, vertical-scoped, does NOT reach the peer pod',
  peerV.json.grounded === false, peerV.json);

// ── 9. DELIVER — channel transport, the Interego-native publish ─────
h('9. DELIVER — a document delivery is published to the pod as a descriptor');
const deliver = await post('/content/deliver', { jobAidId, channel: 'document', learner: LEARNER });
const transport = deliver.json.transport ?? {};
console.log(`   transport: mode=${transport.mode} sent=${transport.sent}`);
console.log(`   artifact: ${transport.artifactUrl}`);
check('the document delivery used the Interego-native pod-descriptor transport',
  transport.mode === 'pod-descriptor' && transport.sent === true, transport);
check('the delivery produced a published descriptor artifact', typeof transport.artifactUrl === 'string', transport);
const artifact = transport.artifactUrl
  ? await fetch(transport.artifactUrl).then(r => ({ status: r.status, text: r.text() })).catch(() => null)
  : null;
const artifactText = artifact ? await artifact.text : '';
check('the published delivery descriptor is dereferenceable on the pod',
  !!artifact && artifact.status === 200 && /DeliveredContent|describes/i.test(artifactText),
  artifact?.status);

// ── 10. ASK — an off-topic question, an honest no-match ─────────────
h('10. ASK — an off-topic question (it must refuse to guess)');
const miss = await ask('What is the boiling point of water?', { learner: LEARNER });
check('an off-topic question returns an honest no-match that refuses to guess',
  miss.json.grounded === false && (miss.json.sources ?? []).length === 0
  && /won't guess|couldn't find/i.test(String(miss.json.answer)), miss.json);

// ── 11. VERIFY — every ask is instrumented into the live LRS ────────
h('11. VERIFY — the asks themselves joined the LRS trace graph');
const lrsRes = await fetch(
  `${BRIDGE}/xapi/statements?verb=${encodeURIComponent('http://adlnet.gov/expapi/verbs/interacted')}`
  + `&activity=${encodeURIComponent(`${BRIDGE}/content/ask`)}&limit=100`,
  { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Experience-API-Version': '2.0.0' } },
);
const lrs = await lrsRes.json();
const chatStmts = (lrs.statements ?? []).filter(s =>
  (s.context?.extensions ?? {})[`${BRIDGE}/ns/foxxi#contextKind`] === 'context-chat');
console.log(`   LRS holds ${chatStmts.length} context-chat interaction(s)`);
check('the Context Companion asks are recorded as xAPI in the live LRS', chatStmts.length >= 8, chatStmts.length);

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(70));
if (fail > 0) process.exit(1);
console.log('\nIn production: learner-record questions are gated to a wallet-signed');
console.log('identity; the interego scope federates discovery across pods; and a');
console.log('document delivery is published to the pod as a discoverable descriptor.');
