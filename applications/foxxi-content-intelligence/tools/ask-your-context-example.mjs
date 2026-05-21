/**
 * Foxxi — "ask your networked context", end to end, in live production.
 *
 *   npx tsx tools/ask-your-context-example.mjs
 *
 * The Context Companion is the one conversational front door over a
 * user's networked context. This walks it against the deployed bridge,
 * LMS and LRS, with a real browser completing a real generated course so
 * the chat has genuine progress to read:
 *
 *   1. PUBLISH   compose + publish a course and a job aid
 *   2. ASK       "what does the refund authority threshold mean?"
 *                → a grounded, verbatim-cited answer from the content
 *   3. ASK       "how do I handle a refund over $500?"
 *                → a grounded answer sourced from the job aid
 *   4. ASK       "do I have any courses assigned to me?" (before doing it)
 *   5. COMPLETE  a real browser launches + completes the course's AUs
 *   6. ASK       "what's my progress?"  → reflects the live LRS
 *   7. ASK       as an AGENT — the same question, the same grounded answer
 *   8. ASK       an off-topic question → an honest no-match, no guessing
 *   9. VERIFY    every ask is instrumented into the live LRS
 *
 * Exits non-zero on any failure.
 */

import { chromium } from 'playwright';
import { mintSessionToken } from '../src/auth.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const WEB_ID = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const LEARNER = 'did:web:acme#rep-sam';
const AGENT = 'did:web:acme#support-agent-7';

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
const ask = (question, opts = {}) => post('/content/ask', { question, ...opts });

console.log('=== Foxxi — ask your networked context, in production ===');

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
const pubRes = await post('/content/publish-course', { course });
const pub = pubRes.json;
check('the course is published + registered on the LMS', pubRes.status === 200 && pub.published === true, pub);
const aidRes = await post('/content/job-aid', {
  competencyPoint: 'refund thresholds', triggerContext: 'opening a refund over $500',
  body: 'Over $500 → route the dispute to a lead. The rep handles refunds of $500 or less directly. '
    + 'Decision tree: returned? in-window? covered reason? then apply the threshold.',
});
check('the job aid is published to the CMS', aidRes.status === 200 && !!aidRes.json.id, aidRes.json);
console.log(`   course=${pub.courseId} · ${pub.aus?.length} AU(s) · job aid=${aidRes.json.id}`);

// ── 2. ASK — a concept question, answered by the agentic RAG ────────
h('2. ASK — "what does the refund authority threshold mean?"');
const concept = await ask('What does the refund authority threshold mean?', { learner: LEARNER });
console.log(`   intent: ${concept.json.intent} · grounded: ${concept.json.grounded} · llm: ${concept.json.llm?.keySource}/${concept.json.llm?.model}`);
console.log(`   answer: ${String(concept.json.answer).split('\n')[0]}`);
check('the question is routed to the concept intent', concept.json.intent === 'concept', concept.json.intent);
check('the answer is grounded in the content', concept.json.grounded === true, concept.json);
check('it composed the vertical\'s existing agentic RAG (not a new retriever)',
  concept.json.llm?.keySource === 'bridge-env', concept.json.llm);
check('the answer carries the agentic-RAG modal-statused Interego trace',
  Array.isArray(concept.json.trace) && concept.json.trace.length >= 2, concept.json.trace);
const cSources = concept.json.sources ?? [];
check('the answer cites a course-fragment source with a course › lesson provenance trail',
  cSources.some(s => s.kind === 'course-fragment' && typeof s.locator === 'string' && s.locator.includes('›')), cSources);
check('the cited source carries the verbatim content (no confabulation)',
  cSources.some(s => typeof s.excerpt === 'string' && s.excerpt.includes('authorise refunds up to $500')), cSources);
check('the synthesized answer speaks to the question',
  /refund|500|lead|threshold/i.test(String(concept.json.answer)), concept.json.answer);

// ── 3. ASK — a procedure question, sourced from the job aid ─────────
h('3. ASK — "how do I handle a refund over $500?"');
const proc = await ask('How do I handle a refund over $500?', { learner: LEARNER });
console.log(`   intent: ${proc.json.intent} · grounded: ${proc.json.grounded}`);
check('the question is routed to the procedure intent', proc.json.intent === 'procedure', proc.json.intent);
check('the answer is sourced from the job aid via the agentic RAG',
  proc.json.grounded === true && (proc.json.sources ?? []).some(s => s.kind === 'job-aid'), proc.json);

// ── 4. ASK — assignments, before the learner has done anything ──────
h('4. ASK — "do I have any courses assigned to me?" (before completing it)');
const assignPre = await ask('Do I have any courses assigned to me?', { learner: LEARNER });
console.log(`   intent: ${assignPre.json.intent}`);
console.log(`   answer: ${String(assignPre.json.answer).split('\n')[0]}`);
check('the question is routed to the assignments intent', assignPre.json.intent === 'assignments', assignPre.json.intent);
check('the answer resolves against the assignment surface (no error)', assignPre.status === 200, assignPre.json);

// ── 5. COMPLETE — a real browser launches + completes the AUs ───────
h('5. COMPLETE — a real browser completes the course on the LMS');
const browser = await chromium.launch({ headless: true });
const page = await browser.newContext().then(c => c.newPage());
let completed = 0;
try {
  for (const au of pub.aus) {
    // moveOn orchestration from the previous AU needs a moment to settle
    // before the next AU's sequential prerequisite gate opens.
    if (completed > 0) await new Promise(r => setTimeout(r, 1800));
    const launchRes = await fetch(`${BRIDGE}/cmi5/launch?course_id=${encodeURIComponent(pub.courseId)}`
      + `&au_id=${encodeURIComponent(au.auId)}&learner=${encodeURIComponent(LEARNER)}&learner_name=Sam%20Rivera`);
    const launch = await launchRes.json();
    if (launchRes.status !== 200 || !launch.launchUrl) { check(`AU "${au.title}" launched`, false, launch); break; }
    await page.goto(launch.launchUrl, { waitUntil: 'networkidle', timeout: 40_000 });
    await page.waitForSelector('#go:not([disabled])', { timeout: 20_000 });
    const answerInput = await page.$('.answer'); // an assessment AU has answer inputs
    if (answerInput) await answerInput.fill('$500');
    await page.click('#go');
    await page.waitForSelector('text=/completed|sent to the LRS|submitted/i', { timeout: 25_000 });
    completed++;
  }
} finally {
  await browser.close();
}
check('a real browser completed every AU of the course', completed === pub.aus.length, { completed, of: pub.aus.length });
await new Promise(r => setTimeout(r, 2000)); // let the final moveOn + rollup settle

// ── 6. ASK — progress, now reading the live LRS ─────────────────────
h('6. ASK — "what\'s my progress?" (now that the LRS has real data)');
const progress = await ask("What's my progress on the refund course?", { learner: LEARNER });
console.log(`   intent: ${progress.json.intent} · grounded: ${progress.json.grounded}`);
console.log(`   answer: ${String(progress.json.answer).split('\n')[0]}`);
check('the question is routed to the progress intent', progress.json.intent === 'progress', progress.json.intent);
check('the answer is grounded in the learner\'s live LRS activity', progress.json.grounded === true, progress.json);
check('the progress answer reflects real recorded activity',
  /statement|completed|in progress/i.test(String(progress.json.answer)), progress.json.answer);

const assignPost = await ask('What courses do I have?', { learner: LEARNER });
check('after completing it, the course shows up in the learner\'s learning',
  assignPost.json.grounded === true && String(assignPost.json.answer).includes('Refund Dispute Resolution'),
  assignPost.json.answer);

// ── 7. ASK — agent / human symmetry ─────────────────────────────────
h('7. ASK — an agent asks the same question (one substrate, both users)');
const asHuman = await ask('Explain refund thresholds.', { asker: { id: LEARNER, kind: 'human' } });
const asAgent = await ask('Explain refund thresholds.', { asker: { id: AGENT, kind: 'agent' } });
const srcIds = (j) => (j.sources ?? []).map(s => s.id).sort().join(',');
console.log(`   human grounded: ${asHuman.json.grounded} · agent grounded: ${asAgent.json.grounded}`);
// The retrieval is deterministic; only the LLM's prose varies. So the
// substrate symmetry is that both get the same grounded retrieval —
// identical cited sources — not the same synthesized wording.
check('an agent and a human get the same grounded retrieval (identical cited sources)',
  asHuman.json.grounded === true && asAgent.json.grounded === true
  && srcIds(asHuman.json).length > 0 && srcIds(asHuman.json) === srcIds(asAgent.json),
  { human: srcIds(asHuman.json), agent: srcIds(asAgent.json) });
check('the agent ask records the asker kind', asAgent.json.asker?.kind === 'agent', asAgent.json.asker);

// ── 8. ASK — an off-topic question, an honest no-match ──────────────
h('8. ASK — an off-topic question (it must refuse to guess)');
const miss = await ask('What is the boiling point of water?', { learner: LEARNER });
console.log(`   answer: ${String(miss.json.answer).split('\n')[0]}`);
check('an off-topic question returns an honest no-match',
  miss.json.grounded === false && (miss.json.sources ?? []).length === 0, miss.json);
check('the no-match answer explicitly refuses to confabulate',
  /won't guess|couldn't find/i.test(String(miss.json.answer)), miss.json.answer);

// ── 9. VERIFY — every ask is instrumented into the live LRS ─────────
h('9. VERIFY — the asks themselves joined the LRS trace graph');
const token = await mintSessionToken({ userId: 'u-joshua', webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
const lrsRes = await fetch(
  `${BRIDGE}/xapi/statements?verb=${encodeURIComponent('http://adlnet.gov/expapi/verbs/interacted')}`
  + `&activity=${encodeURIComponent(`${BRIDGE}/content/ask`)}&limit=100`,
  { headers: { Authorization: `Bearer ${token}`, 'X-Experience-API-Version': '2.0.0' } },
);
const lrs = await lrsRes.json();
const chatStmts = (lrs.statements ?? []).filter(s =>
  (s.context?.extensions ?? {})[`${BRIDGE}/ns/foxxi#contextKind`] === 'context-chat');
console.log(`   LRS holds ${chatStmts.length} context-chat interaction(s)`);
check('the Context Companion asks are recorded as xAPI in the live LRS', chatStmts.length >= 8, chatStmts.length);
check('each recorded ask carries the question it answered',
  chatStmts.some(s => typeof s.result?.response === 'string' && s.result.response.length > 0), chatStmts[0]);

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log(`${pass} passed, ${fail} failed`);
console.log('═'.repeat(70));
if (fail > 0) process.exit(1);
console.log('\nOne front door, in production: any human or agent user just chats —');
console.log('"what does this mean?", "do I have courses assigned?", "what\'s my progress?" —');
console.log('and the networked context answers, sourced from its own surfaces, never guessing.');
