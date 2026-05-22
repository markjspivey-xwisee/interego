/**
 * Local smoke for the Context Companion — chat over a user's networked
 * context.
 *
 *   npx tsx tools/context-chat-smoke.ts
 *
 * Verifies intent classification, the sourced grounded answers, the
 * honest no-match, and the `POST /content/ask` route over a throwaway
 * Express app: a composed course + a job aid are published, then asked
 * about — "what does X mean?", "how do I X?", "do I have any courses
 * assigned to me?", "what's my progress?" — and every content answer is
 * checked to cite a real source. Exits non-zero on any failure.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { authorFragment, authorLesson, authorModule, composeCourse } from '../src/emergent-content.js';
import { attachContentDeliveryRoutes } from '../src/content-delivery.js';
import {
  attachContextChatRoutes, classifyContextIntent, answerContextQuestion, mergeDiscovered,
  type NetworkedContext,
} from '../src/context-chat.js';
import { storeStatementInternal } from '../src/xapi-lrs.js';

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};

// ── Intent classification ───────────────────────────────────────────

console.log('\nIntent classification');
const intentCases: Array<[string, string]> = [
  ['do I have any courses assigned to me?', 'assignments'],
  ['what courses do I have?', 'assignments'],
  ['what does the refund threshold mean?', 'concept'],
  ['what is an authority threshold?', 'concept'],
  ['explain refund thresholds', 'concept'],
  ['how do I handle a refund over $500?', 'procedure'],
  ["what's my progress?", 'progress'],
  ['have I completed the refund course?', 'progress'],
  ['what courses are available?', 'catalog'],
  ['refund', 'general'],
];
for (const [q, expected] of intentCases) {
  const got = classifyContextIntent(q);
  check(`"${q}" → ${expected}`, got === expected, got);
}

// ── Direct answerContextQuestion — honest no-match ──────────────────

console.log('\nGrounded answers — direct');
const emptyCtx: NetworkedContext = {
  learner: 'did:web:x', scope: 'interego',
  courses: [], jobAids: [], interegoContext: [], enrollments: [], activity: [],
};
const noMatch = await answerContextQuestion({
  asker: { id: 'did:web:x', kind: 'human' }, question: 'what is photosynthesis?', context: emptyCtx,
});
check('a question with no content → honest no-match (grounded:false)', noMatch.grounded === false && noMatch.sources.length === 0);
check('the no-match answer refuses to guess', /won't guess|no published content/i.test(noMatch.answer), noMatch.answer);

// ── Federation merge — dedup across pods (mergeDiscovered) ───────────

console.log('\nFederation merge');
const merged = mergeDiscovered([
  { descriptorUrl: 'https://a/x', label: 'x', summary: 's', originPod: 'https://pod-a/' },
  { descriptorUrl: 'https://a/y', label: 'y', summary: 's', originPod: 'https://pod-a/' },
  { descriptorUrl: 'https://a/x', label: 'x-dup', summary: 's', originPod: 'https://pod-b/' },
  { descriptorUrl: 'https://b/z', label: 'z', summary: 's', originPod: 'https://pod-b/' },
]);
check('mergeDiscovered dedups by descriptorUrl', merged.length === 3, merged.length);
check('mergeDiscovered keeps the first pod to publish a descriptor (first wins)',
  merged.find(d => d.descriptorUrl === 'https://a/x')?.label === 'x', merged.map(d => d.label));
check('mergeDiscovered preserves each descriptor\'s originPod',
  merged.find(d => d.descriptorUrl === 'https://b/z')?.originPod === 'https://pod-b/', merged);

// ── Compose a course + the HTTP routes ──────────────────────────────

const author = { id: 'did:web:acme#sme-lee', kind: 'human' as const, role: 'SME' };
const f1 = authorFragment({ modality: 'concept', competencyPoint: 'refund thresholds', level: 'foundational',
  body: 'A rep may authorise refunds up to $500; above that, route the dispute to a lead.', authoredBy: author });
const f2 = authorFragment({ modality: 'worked-example', competencyPoint: 'refund thresholds', level: 'working',
  body: 'A $420 dispute — the rep resolves it. A $1,300 dispute — route to a lead.', authoredBy: author });
const q1 = authorFragment({ modality: 'assessment-item', competencyPoint: 'refund thresholds', level: 'applied',
  body: 'Up to what amount may a rep authorise a refund alone? ::: $500', authoredBy: author });
const lessonContent = authorLesson({ title: 'Authority thresholds', competency: 'resolving refund disputes',
  audience: 'human', authoredBy: author, positions: [{ competencyPoint: 'refund thresholds', fragments: [f1, f2] }] });
const lessonQuiz = authorLesson({ title: 'Thresholds check', competency: 'resolving refund disputes',
  audience: 'human', authoredBy: author, positions: [{ competencyPoint: 'refund thresholds', fragments: [q1] }] });
const module1 = authorModule({ title: 'Refund basics', competency: 'resolving refund disputes', authoredBy: author,
  positions: [
    { competencyPoint: 'refund thresholds', lessons: [lessonContent] },
    { competencyPoint: 'refund thresholds', lessons: [lessonQuiz] },
  ] });
const course = composeCourse({ title: 'Refund Dispute Resolution', competency: 'resolving refund disputes',
  audience: 'human', authoredBy: author, positions: [{ competencyPoint: 'resolving refund disputes', modules: [module1] }] });

const LEARNER = 'did:web:acme#rep-sam';
const NEWCOMER = 'did:web:acme#rep-newcomer';

async function testRoutes(): Promise<void> {
  console.log('\nPOST /content/ask — over the live networked context');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  attachContentDeliveryRoutes(app, { selfBaseUrl: 'http://localhost', authoritativeSource: 'did:web:test' });
  attachContextChatRoutes(app, {
    selfBaseUrl: 'http://localhost',
    authoritativeSource: 'did:web:test',
    emitStatement: (stmt, tenant) => { storeStatementInternal(stmt, tenant); },
    // A stub for the substrate pass-through — descriptors that exist in
    // the wider Interego context but NOT in the Foxxi vertical. The first
    // is surfaced at the metadata level; the second is deep-fetched —
    // its full content folded in, so the pass-through answers from the
    // content itself, not the descriptor's metadata.
    discoverInteregoContext: async () => ([
      {
        descriptorUrl: 'https://pod.example/markj/notes/quarterly-objectives.ttl',
        label: 'quarterly objectives',
        summary: 'Interego context descriptor "quarterly objectives" — the quarterly '
          + 'objective is to cut the refund escalation rate by 30 percent.',
        originPod: 'https://pod.example/markj/',
      },
      {
        descriptorUrl: 'https://pod.example/peer/courses/onboarding.ttl',
        label: 'onboarding basics',
        summary: 'Interego context descriptor "onboarding basics".',
        originPod: 'https://pod.example/peer/',
        course: {
          courseIri: 'urn:demo:course:onboarding', title: 'Onboarding Basics',
          courseLabel: 'Onboarding', courseId: 'demo-onboarding', authoritativeSource: 'did:web:test',
          concepts: [{ id: 'c-badge', label: 'badge activation', confidence: 1, tier: 1, is_free_standing: true, taught_in_slides: ['s-badge'] }],
          slides: [{ id: 's-badge', title: 'Badge activation', sequence_index: 0, concept_ids: ['c-badge'],
            transcript_combined: 'Activate your badge at the front desk on your first day before 9am.' }],
          modifier_pairs: [], prereq_edges: [],
        },
      },
    ]),
  });
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const ask = async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/content/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };

  try {
    // Publish the course + a job aid into the networked context.
    const pubRes = await fetch(`${base}/content/publish-course`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ course }),
    });
    check('the course publishes into the networked context', pubRes.status === 200);
    const aidRes = await fetch(`${base}/content/job-aid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        competencyPoint: 'refund thresholds', triggerContext: 'opening a refund over $500',
        body: 'Over $500 → route the dispute to a lead. The rep handles refunds of $500 or less directly.',
      }),
    });
    check('the job aid publishes into the networked context', aidRes.status === 200);

    // ── A concept question — answered by the agentic RAG ────────────
    const concept = await ask({ question: 'What does the refund authority threshold mean?', learner: LEARNER });
    check('concept question → intent concept', concept.json.intent === 'concept', concept.json.intent);
    check('concept answer is grounded', concept.json.grounded === true, concept.json);
    const cSources = (concept.json.sources ?? []) as Array<Record<string, unknown>>;
    check('concept answer cites a course-fragment source', cSources.some(s => s.kind === 'course-fragment'), cSources);
    check('the cited source carries a course › lesson provenance locator',
      cSources.some(s => typeof s.locator === 'string' && (s.locator as string).includes('›')), cSources);
    check('the cited source quotes the verbatim content',
      cSources.some(s => typeof s.excerpt === 'string' && (s.excerpt as string).includes('authorise refunds up to $500')),
      cSources);
    check('the answer carries the agentic-RAG Interego trace',
      Array.isArray(concept.json.trace) && (concept.json.trace as unknown[]).length >= 2, concept.json.trace);
    check('the ask was instrumented into the LRS', concept.json.instrumented === true);

    // ── A procedure question — grounded, sourced from the job aid ───
    const proc = await ask({ question: 'How do I handle a refund over $500?', learner: LEARNER });
    check('procedure question → intent procedure', proc.json.intent === 'procedure', proc.json.intent);
    check('procedure answer is grounded', proc.json.grounded === true, proc.json);
    const pSources = (proc.json.sources ?? []) as Array<Record<string, unknown>>;
    check('procedure answer cites the job-aid source', pSources.some(s => s.kind === 'job-aid'), pSources);

    // ── An assignment question — no engagement yet ──────────────────
    const assignNew = await ask({ question: 'Do I have any courses assigned to me?', learner: NEWCOMER });
    check('assignment question → intent assignments', assignNew.json.intent === 'assignments', assignNew.json.intent);
    check('a newcomer is honestly told they have nothing assigned',
      assignNew.json.grounded === false && /don't have any courses assigned/i.test(assignNew.json.answer as string),
      assignNew.json.answer);
    check('the newcomer is still pointed at the available course',
      /available/i.test(assignNew.json.answer as string), assignNew.json.answer);

    // ── A catalog question ──────────────────────────────────────────
    const catalog = await ask({ question: 'What courses are available?', learner: NEWCOMER });
    check('catalog question → intent catalog', catalog.json.intent === 'catalog', catalog.json.intent);
    check('catalog answer lists the published course',
      (catalog.json.answer as string).includes('Refund Dispute Resolution'), catalog.json.answer);

    // ── Progress — after a real completion lands in the LRS ──────────
    storeStatementInternal({
      actor: { objectType: 'Agent', account: { homePage: 'did:web:test', name: LEARNER } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/satisfied', display: { 'en-US': 'satisfied' } },
      object: { objectType: 'Activity', id: course.id, definition: { name: { 'en-US': 'Refund Dispute Resolution' } } },
      timestamp: new Date().toISOString(),
    });
    const progress = await ask({ question: "What's my progress?", learner: LEARNER });
    check('progress question → intent progress', progress.json.intent === 'progress', progress.json.intent);
    check('progress answer reflects the completion from the LRS',
      progress.json.grounded === true && /completed/i.test(progress.json.answer as string), progress.json.answer);

    // ── A learner with a completion is told the course is assigned ───
    const assignDone = await ask({ question: 'What courses do I have?', learner: LEARNER });
    check('a learner with engagement sees the course in their learning',
      assignDone.json.grounded === true && (assignDone.json.answer as string).includes('Refund Dispute Resolution'),
      assignDone.json.answer);

    // ── Honest no-match over real content ───────────────────────────
    const miss = await ask({ question: 'What is the boiling point of water?', learner: LEARNER });
    check('an off-topic question → honest no-match even with content present',
      miss.json.grounded === false && (miss.json.sources as unknown[]).length === 0, miss.json);

    // ── Agent / human symmetry — same question, same grounded answer ─
    const asHuman = await ask({ question: 'Explain refund thresholds.', asker: { id: LEARNER, kind: 'human' } });
    const asAgent = await ask({ question: 'Explain refund thresholds.', asker: { id: 'did:web:acme#agent-7', kind: 'agent' } });
    check('a human and an agent asking the same question get the same grounded answer',
      asHuman.json.grounded === true && asAgent.json.grounded === true
      && asHuman.json.answer === asAgent.json.answer, { human: asHuman.json.answer, agent: asAgent.json.answer });
    check('the agent ask records the asker kind', (asAgent.json.asker as Record<string, unknown>)?.kind === 'agent');

    // ── Scope — the interego pass-through vs vertical narrowing ──────
    const wideQ = 'What are our quarterly objectives?';
    const vertical = await ask({ question: wideQ, learner: LEARNER, scope: 'vertical' });
    check('scope:vertical narrows to the Foxxi slice — no match for wider context',
      vertical.json.scope === 'vertical' && vertical.json.grounded === false, vertical.json);
    check('a vertical-scoped no-match suggests trying the interego scope',
      /scope "interego"/i.test(vertical.json.answer as string), vertical.json.answer);
    const wide = await ask({ question: wideQ, learner: LEARNER, scope: 'interego' });
    check('scope:interego passes through to the wider Interego context',
      wide.json.scope === 'interego' && wide.json.grounded === true, wide.json);
    check('the interego-scoped answer cites an interego-context source',
      (wide.json.sources ?? []).some(s => s.kind === 'interego-context'), wide.json.sources);
    const wideSummary = (wide.json.contextSummary ?? {}) as Record<string, unknown>;
    check('the interego scope reports the federated pods it discovered across',
      Array.isArray(wideSummary.interegoPods) && (wideSummary.interegoPods as unknown[]).length >= 2,
      wideSummary.interegoPods);
    const dflt = await ask({ question: wideQ, learner: LEARNER });
    check('the default scope is interego (the whole networked context)',
      dflt.json.scope === 'interego' && dflt.json.grounded === true, dflt.json.scope);

    // ── Deep pass-through — answer from a descriptor's actual content ─
    const deep = await ask({ question: 'How do I activate my badge?', learner: LEARNER, scope: 'interego' });
    check('the pass-through answers from a deep-fetched descriptor\'s own content',
      deep.json.grounded === true && (deep.json.sources ?? []).some(s =>
        s.kind === 'interego-context' && typeof s.excerpt === 'string' && s.excerpt.includes('front desk')),
      deep.json.sources);

    // ── A missing question is rejected ──────────────────────────────
    const bad = await ask({ learner: LEARNER });
    check('a request with no question is a 400', bad.status === 400, bad);
  } finally {
    server.close();
  }
}

/** Auth gate — progress / assignment questions need a session token. */
async function testAuthGate(): Promise<void> {
  console.log('\nAuth gate — progress / assignments require a session token');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  attachContextChatRoutes(app, {
    selfBaseUrl: 'http://localhost',
    authoritativeSource: 'did:web:test',
    verifyCaller: async (token) =>
      token === 'good' ? { ok: true, webId: LEARNER, role: 'learner' }
      : token === 'admin' ? { ok: true, webId: 'did:web:acme#admin', role: 'admin' }
      : { ok: false, reason: 'unknown token' },
  });
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const ask = async (body: Record<string, unknown>, token?: string) => {
    const r = await fetch(`${base}/content/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };
  try {
    const noTok = await ask({ question: "What's my progress?" });
    check('a progress question with no token is rejected (401)',
      noTok.status === 401 && noTok.json.authRequired === true, noTok.json);
    const badTok = await ask({ question: 'Do I have any courses assigned?' }, 'wrong');
    check('an assignment question with a bad token is rejected (401)', badTok.status === 401, badTok.json);
    const okTok = await ask({ question: "What's my progress?" }, 'good');
    check('a progress question with a valid token is allowed (200)', okTok.status === 200, okTok.json);
    check('the gated learner is bound to the verified identity, not the request body',
      okTok.json.learner === LEARNER, okTok.json.learner);
    const spoof = await ask({ question: "What's my progress?", learner: 'did:web:acme#someone-else' }, 'good');
    check('a learner cannot ask about someone else\'s record (bound to the token)',
      spoof.json.learner === LEARNER, spoof.json.learner);
    const content = await ask({ question: 'What does the refund threshold mean?' });
    check('a content question needs no token (not gated)', content.status === 200, content.status);
  } finally {
    server.close();
  }
}

await testRoutes();
await testAuthGate();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('\nThe Context Companion works: one front door — POST /content/ask —');
console.log('classifies intent and answers from the networked context\'s own surfaces,');
console.log('with sourced answers and an honest no-match, the same for humans and agents.');
