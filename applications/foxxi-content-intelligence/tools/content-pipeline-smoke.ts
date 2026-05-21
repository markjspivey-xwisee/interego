/**
 * Local smoke for the content pipeline that closes the loop:
 *   compose a Course → generate a cmi5 package + a SCORM .zip →
 *   publish (register on the LMS) → serve the runnable AU →
 *   channel-deliver a job aid (chat / email / SMS / document).
 *
 *   npx tsx tools/content-pipeline-smoke.ts
 *
 * Verifies the generators round-trip (the cmi5.xml re-parses; the SCORM
 * .zip's imsmanifest re-parses through the SCORM engine) and the
 * delivery routes work over a throwaway Express app. Exits non-zero on
 * any failure.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import { authorFragment, authorLesson, authorModule, composeCourse } from '../src/emergent-content.js';
import { generateCmi5Xml, generateScormZip, flattenCourse } from '../src/content-package.js';
import { attachContentDeliveryRoutes } from '../src/content-delivery.js';
import { parseCmi5Course, flatAus } from '../src/cmi5-course.js';
import { parseManifest } from '../src/scorm-sequencing.js';

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};

// ── Compose a small course (one content lesson, one assessment) ─────

const author = { id: 'did:web:acme#sme-lee', kind: 'human' as const, role: 'SME' };
const f1 = authorFragment({ modality: 'concept', competencyPoint: 'refund thresholds', level: 'foundational',
  body: 'A rep may authorise refunds up to $500; above that, escalate to a lead.', authoredBy: author });
const f2 = authorFragment({ modality: 'worked-example', competencyPoint: 'refund thresholds', level: 'working',
  body: 'A $420 dispute — the rep resolves it directly. A $1,300 dispute — route to a lead.', authoredBy: author });
const q1 = authorFragment({ modality: 'assessment-item', competencyPoint: 'refund thresholds', level: 'applied',
  body: 'A rep may authorise refunds up to what amount? ::: $500', authoredBy: author });
const lessonContent = authorLesson({ title: 'Refund thresholds', competency: 'resolving refund disputes',
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

// ── Direct: the generators round-trip ──────────────────────────────

console.log('\nGenerator round-trips');
const flat = flattenCourse(course);
check('the course flattens to 2 lessons', flat.length === 2, flat.length);

const cmi5Xml = generateCmi5Xml(course, id => `https://bridge.example/content/au/pub-x/${id}`);
let cmi5Ok = false;
try {
  const parsed = parseCmi5Course(cmi5Xml);
  cmi5Ok = parsed.id === course.id && flatAus(parsed).length === 2;
} catch (e) { console.log(`   parse error: ${(e as Error).message}`); }
check('generated cmi5.xml re-parses as a 2-AU course', cmi5Ok);

const scormZip = generateScormZip(course);
check('generated SCORM .zip is a non-empty Buffer', Buffer.isBuffer(scormZip) && scormZip.length > 200, scormZip.length);
let scormOk = false;
try {
  const zip = new AdmZip(scormZip);
  const manifest = zip.getEntry('imsmanifest.xml')?.getData().toString('utf8') ?? '';
  const tree = parseManifest(manifest);
  scormOk = tree.preorder.length >= 3; // root + 2 lesson items
} catch (e) { console.log(`   scorm parse error: ${(e as Error).message}`); }
check('the SCORM package imsmanifest.xml re-parses through the SCORM engine', scormOk);

// ── HTTP: the delivery routes ──────────────────────────────────────

async function testRoutes(): Promise<void> {
  console.log('\nContent-delivery routes');
  const emitted: Array<{ verb: string; channel?: string }> = [];
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  attachContentDeliveryRoutes(app, {
    selfBaseUrl: 'http://localhost',
    authoritativeSource: 'did:web:test',
    emitStatement: (stmt) => {
      const verb = (stmt.verb as { id?: string })?.id ?? '';
      const ext = (stmt.context as { extensions?: Record<string, unknown> })?.extensions ?? {};
      const channel = ext['http://localhost/ns/foxxi#deliveryChannel'] as string | undefined;
      emitted.push({ verb, ...(channel ? { channel } : {}) });
    },
  });
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    // Publish the composed course.
    const pubRes = await fetch(`${base}/content/publish-course`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course }),
    });
    const pub = await pubRes.json() as { published?: boolean; publishId?: string; aus?: Array<{ index: number }>; artifacts?: Record<string, string> };
    check('POST /content/publish-course registers the course', pubRes.status === 200 && pub.published === true, pub);
    check('publish returns 2 runnable AUs', (pub.aus?.length ?? 0) === 2);

    // The runnable AU is served as HTML with the cmi5 runtime.
    const auRes = await fetch(`${base}/content/au/${pub.publishId}/0`);
    const auHtml = await auRes.text();
    check('GET /content/au serves a runnable AU', auRes.status === 200 && auHtml.includes('cmi5') && auHtml.includes('sendStatement'));

    // The artifacts.
    const xmlRes = await fetch(`${base}/content/package/${pub.publishId}/cmi5.xml`);
    check('the cmi5.xml artifact is served', xmlRes.status === 200 && (await xmlRes.text()).includes('courseStructure'));
    const zipRes = await fetch(`${base}/content/package/${pub.publishId}/scorm.zip`);
    check('the SCORM .zip artifact is served', zipRes.status === 200);

    // Publish + serve a job aid.
    const aidRes = await fetch(`${base}/content/job-aid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competencyPoint: 'refund thresholds', body: 'Up to $500 a rep can authorise alone.', triggerContext: 'opening a refund' }),
    });
    const aid = await aidRes.json() as { id?: string };
    check('POST /content/job-aid publishes a job aid', aidRes.status === 200 && !!aid.id);
    const aidView = await fetch(`${base}/content/job-aid/${aid.id}?learner=did:web:acme%23rep-sam`);
    check('GET /content/job-aid serves it + instruments the LRS',
      aidView.status === 200 && emitted.some(e => e.verb.endsWith('/experienced')));

    // Channel delivery — chat / email / SMS / document, each instrumented.
    for (const channel of ['document', 'email', 'chat', 'sms'] as const) {
      const dRes = await fetch(`${base}/content/deliver`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobAidId: aid.id, channel, learner: 'did:web:acme#rep-sam' }),
      });
      const d = await dRes.json() as { delivered?: boolean; rendering?: { body?: string } };
      check(`POST /content/deliver renders + instruments the ${channel} channel`,
        dRes.status === 200 && d.delivered === true && !!d.rendering?.body
        && emitted.some(e => e.channel === channel));
    }
    // Deliver a published-course lesson to a channel.
    const lessonDeliver = await fetch(`${base}/content/deliver`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishId: pub.publishId, auIndex: 0, channel: 'email', learner: 'did:web:acme#rep-sam' }),
    });
    check('a published-course lesson channel-delivers too', lessonDeliver.status === 200);
  } finally {
    server.close();
  }
}

await testRoutes();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('\nThe loop is wired: composed course → generated cmi5 + SCORM packages →');
console.log('registered on the LMS → runnable AU served → job aids channel-delivered,');
console.log('every delivery instrumented into the LRS.');
