/**
 * Local smoke test for the LMS-conformance gap-closure work:
 *   · SCORM 2004 Sequencing & Navigation runtime (scorm-sequencing.ts)
 *   · LTI 1.3 Advantage — JWKS / NRPS / AGS line-item CRUD / Deep Linking
 *   · OneRoster 1.2 — CSV consumer apply-step + /courses
 *
 * Run:  npx tsx tools/lms-conformance-smoke.ts
 *
 * Exercises the modules directly + over a throwaway Express app, so a
 * regression is caught before a deploy. Exits non-zero on any failure.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import {
  parseManifest, createSession, processNavigation, commitTracking,
} from '../src/scorm-sequencing.js';
import { attachScormSequencingRoutes } from '../src/scorm-sequencing.js';
import { attachLti13Routes } from '../src/lti13.js';
import { attachOneRosterRoutes } from '../src/oneroster.js';
import { applyCsvBundle, tenantOrUsers } from '../src/oneroster.js';
import { DEFAULT_TENANT } from '../src/tenant-context.js';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// ── A representative SCORM 2004 manifest ─────────────────────────────

const MANIFEST = `<?xml version="1.0"?>
<manifest identifier="MAN-1"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Compliance Onboarding</title>
      <item identifier="MOD-A">
        <title>Module A — Foundations</title>
        <item identifier="SCO-A1" identifierref="RES-A1"><title>Lesson A1</title></item>
        <item identifier="SCO-A2" identifierref="RES-A2"><title>Lesson A2</title></item>
        <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
      </item>
      <item identifier="MOD-B">
        <title>Module B — Assessment</title>
        <item identifier="SCO-B1" identifierref="RES-B1"><title>Final Exam</title>
          <imsss:sequencing>
            <imsss:controlMode choice="true" flow="true"/>
            <imsss:limitConditions attemptLimit="2"/>
            <imsss:objectives>
              <imsss:primaryObjective satisfiedByMeasure="true">
                <imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure>
              </imsss:primaryObjective>
            </imsss:objectives>
          </imsss:sequencing>
        </item>
        <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
      </item>
      <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-A1" href="a1.html" adlcp:scormType="sco"/>
    <resource identifier="RES-A2" href="a2.html" adlcp:scormType="sco"/>
    <resource identifier="RES-B1" href="b1.html" adlcp:scormType="sco"/>
  </resources>
</manifest>`;

// A manifest with a pre-condition skip rule on the middle activity.
const SKIP_MANIFEST = `<?xml version="1.0"?>
<manifest identifier="MAN-2" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <organizations default="ORG-2">
    <organization identifier="ORG-2">
      <title>Skip Course</title>
      <item identifier="S1" identifierref="R1"><title>First</title></item>
      <item identifier="S2" identifierref="R2"><title>Skipped</title>
        <imsss:sequencing>
          <imsss:sequencingRules>
            <imsss:preConditionRule>
              <imsss:ruleConditions><imsss:ruleCondition condition="always"/></imsss:ruleConditions>
              <imsss:ruleAction action="skip"/>
            </imsss:preConditionRule>
          </imsss:sequencingRules>
        </imsss:sequencing>
      </item>
      <item identifier="S3" identifierref="R3"><title>Last</title></item>
      <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
    </organization>
  </organizations>
  <resources>
    <resource identifier="R1" href="1.html"/><resource identifier="R2" href="2.html"/>
    <resource identifier="R3" href="3.html"/>
  </resources>
</manifest>`;

function testScormSequencing(): void {
  console.log('\nSCORM 2004 Sequencing & Navigation engine');

  const tree = parseManifest(MANIFEST);
  check('parses the activity tree', tree.preorder.length === 6, tree.preorder.length);
  check('course title lifted', tree.courseTitle === 'Compliance Onboarding', tree.courseTitle);
  check('attemptLimit parsed on SCO-B1',
    tree.preorder.find(a => a.id === 'SCO-B1')?.sequencing.attemptLimit === 2);
  check('satisfiedByMeasure parsed',
    tree.preorder.find(a => a.id === 'SCO-B1')?.sequencing.primaryObjective.satisfiedByMeasure === true);

  const s = createSession(DEFAULT_TENANT, tree);
  const r1 = processNavigation(s, 'start');
  check('Start delivers SCO-A1', r1.delivered?.activityId === 'SCO-A1', r1);
  const r2 = processNavigation(s, 'continue');
  check('Continue → SCO-A2', r2.delivered?.activityId === 'SCO-A2', r2);
  const r3 = processNavigation(s, 'continue');
  check('Continue crosses module boundary → SCO-B1', r3.delivered?.activityId === 'SCO-B1', r3);
  const r4 = processNavigation(s, 'continue');
  check('Continue past the last activity ends the sequence', r4.sequencingEnded === true, r4);

  // Choice back to a specific activity.
  const r5 = processNavigation(s, 'choice', 'SCO-A2');
  check('Choice delivers the chosen activity', r5.delivered?.activityId === 'SCO-A2', r5);
  const r6 = processNavigation(s, 'previous');
  check('Previous → SCO-A1', r6.delivered?.activityId === 'SCO-A1', r6);

  // Commit + rollup: complete both Module A SCOs, A should roll up completed.
  processNavigation(s, 'choice', 'SCO-A1');
  commitTracking(s, { completion: 'completed', success: 'passed', scoreScaled: 0.9 });
  processNavigation(s, 'choice', 'SCO-A2');
  const commitA2 = commitTracking(s, { completion: 'completed', success: 'passed', scoreScaled: 1.0 });
  check('commit returns activity state', commitA2.ok === true, commitA2);
  const modA = s.states.get('MOD-A')!;
  check('rollup: Module A is completed', modA.attemptCompletionStatus === true && modA.attemptProgressStatus === true, modA);
  check('rollup: Module A measure averaged (0.95)', Math.abs(modA.objectiveNormalizedMeasure - 0.95) < 1e-6, modA.objectiveNormalizedMeasure);

  // satisfiedByMeasure: a 0.7 score on SCO-B1 (min 0.8) → not satisfied.
  processNavigation(s, 'choice', 'SCO-B1');
  commitTracking(s, { completion: 'completed', scoreScaled: 0.7 });
  check('satisfiedByMeasure: 0.7 < 0.8 → not satisfied',
    s.states.get('SCO-B1')!.objectiveSatisfiedStatus === false);
  // A 0.85 retry → satisfied.
  processNavigation(s, 'choice', 'SCO-B1');
  commitTracking(s, { completion: 'completed', scoreScaled: 0.85 });
  check('satisfiedByMeasure: 0.85 ≥ 0.8 → satisfied',
    s.states.get('SCO-B1')!.objectiveSatisfiedStatus === true);

  // attemptLimit: SCO-B1 attemptLimit=2, now attempted twice → choice refused.
  const overLimit = processNavigation(s, 'choice', 'SCO-B1');
  check('attemptLimit enforced — 3rd attempt refused', overLimit.ok === false, overLimit);

  // Pre-condition skip rule.
  const skipTree = parseManifest(SKIP_MANIFEST);
  const ss = createSession(DEFAULT_TENANT, skipTree);
  const sk1 = processNavigation(ss, 'start');
  check('skip-manifest Start → S1', sk1.delivered?.activityId === 'S1', sk1);
  const sk2 = processNavigation(ss, 'continue');
  check('pre-condition skip: Continue skips S2 → S3', sk2.delivered?.activityId === 'S3', sk2);

  // Suspend / resume.
  const rs = createSession(DEFAULT_TENANT, tree);
  processNavigation(rs, 'start');
  const susp = processNavigation(rs, 'suspendAll');
  check('Suspend All succeeds', susp.ok === true && rs.suspended?.id === 'SCO-A1', susp);
  const resume = processNavigation(rs, 'resumeAll');
  check('Resume All restores the suspended activity', resume.delivered?.activityId === 'SCO-A1', resume);
}

// ── HTTP integration over a throwaway Express app ────────────────────

async function testHttpRoutes(): Promise<void> {
  console.log('\nLTI 1.3 / OneRoster / SCORM HTTP routes');

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  attachLti13Routes(app, {
    selfBaseUrl: 'http://localhost',
    tenantDid: 'did:web:test',
    keySeed: 'smoke-test-seed',
    dashboardUrl: 'http://localhost/dash',
    platformsConfig: 'https://platform.example||client-123||deploy-1||https://platform.example/jwks||https://platform.example/auth||https://platform.example/token',
  });
  attachOneRosterRoutes(app, { tenantDid: 'did:web:test' });
  attachScormSequencingRoutes(app, { selfBaseUrl: 'http://localhost' });

  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;

  try {
    // ── LTI JWKS ──
    const jwks = await fetch(`${base}/lti/.well-known/jwks.json`).then(r => r.json()) as { keys?: unknown[] };
    check('LTI JWKS exposes a key', Array.isArray(jwks.keys) && jwks.keys.length === 1, jwks);

    // ── LTI NRPS — Foxxi roster as a membership container ──
    const nrpsResp = await fetch(`${base}/lti/nrps/members`);
    const nrps = await nrpsResp.json() as { members?: unknown[]; context?: unknown };
    check('NRPS returns a membership container', nrpsResp.status === 200 && Array.isArray(nrps.members), nrps);
    check('NRPS members are populated from the tenant directory', (nrps.members?.length ?? 0) > 0, nrps.members?.length);

    // ── LTI AGS line-item CRUD ──
    const emptyList = await fetch(`${base}/lti/ags/lineitems`).then(r => r.json()) as unknown[];
    check('AGS line items start empty', Array.isArray(emptyList) && emptyList.length === 0, emptyList);
    const created = await fetch(`${base}/lti/ags/lineitems`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Quiz 1', scoreMaximum: 100, tag: 'quiz' }),
    });
    const li = await created.json() as { id?: string; label?: string };
    check('AGS create returns 201 + a line item', created.status === 201 && li.label === 'Quiz 1', li);
    const liId = (li.id ?? '').split('/').pop() ?? '';
    const got = await fetch(`${base}/lti/ags/lineitems/${liId}`);
    check('AGS line item is retrievable by id', got.status === 200, got.status);
    const list2 = await fetch(`${base}/lti/ags/lineitems`).then(r => r.json()) as unknown[];
    check('AGS list now has 1 line item', list2.length === 1, list2.length);
    const put = await fetch(`${base}/lti/ags/lineitems/${liId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scoreMaximum: 50 }),
    });
    const updated = await put.json() as { scoreMaximum?: number };
    check('AGS line item update applies', put.status === 200 && updated.scoreMaximum === 50, updated);
    const del = await fetch(`${base}/lti/ags/lineitems/${liId}`, { method: 'DELETE' });
    check('AGS line item delete returns 204', del.status === 204, del.status);

    // ── LTI Deep Linking — picker rejects an unsigned ticket ──
    const dlBad = await fetch(`${base}/lti/deeplink?dl=not-a-ticket`);
    check('Deep Linking picker rejects a bad ticket', dlBad.status === 400, dlBad.status);

    // ── LTI Deep Linking — full content-item round trip ──
    const now = Math.floor(Date.now() / 1000);
    const dlTicket = forgeTicket({
      kind: 'deeplink',
      iss: 'https://platform.example',
      clientId: 'client-123',
      deploymentId: 'deploy-1',
      returnUrl: `${base}/dl-return`,
      acceptMultiple: true,
      iat: now,
      exp: now + 900,
    }, 'smoke-test-seed');
    const picker = await fetch(`${base}/lti/deeplink?dl=${encodeURIComponent(dlTicket)}`);
    const pickerHtml = await picker.text();
    check('Deep Linking picker renders for a valid ticket',
      picker.status === 200 && pickerHtml.includes('name="dl"'), picker.status);
    const dlPost = await fetch(`${base}/lti/deeplink`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dl: dlTicket, generic: 'dashboard' }).toString(),
    });
    const dlHtml = await dlPost.text();
    check('Deep Linking POST returns an auto-submit JWT form',
      dlPost.status === 200 && dlHtml.includes('name="JWT"') && dlHtml.includes(`${base}/dl-return`),
      dlPost.status);
    const jwtMatch = /name="JWT" value="([^"]+)"/.exec(dlHtml);
    const jwtPayload = jwtMatch
      ? JSON.parse(Buffer.from(jwtMatch[1]!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
      : {};
    check('DeepLinkingResponse JWT is a signed LtiDeepLinkingResponse with content_items',
      jwtPayload['https://purl.imsglobal.org/spec/lti/claim/message_type'] === 'LtiDeepLinkingResponse'
      && Array.isArray(jwtPayload['https://purl.imsglobal.org/spec/lti-dl/claim/content_items']),
      jwtPayload);

    // ── OneRoster CSV consumer apply-step ──
    const bundle = {
      'users.csv': 'sourcedId,status,givenName,familyName,email,role\nu-imp-1,active,Dana,Imported,dana@ext.example,student\nu-imp-2,active,Eli,Imported,eli@ext.example,teacher',
      'courses.csv': 'sourcedId,title,courseCode\nc-imp-1,Imported Safety Course,SAFE-101',
      'enrollments.csv': 'sourcedId,classSourcedId,userSourcedId,role\ne-imp-1,cls-1,u-imp-1,student',
    };
    const imp = await fetch(`${base}/ims/oneroster/v1p2/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
    });
    const impBody = await imp.json() as { ok?: boolean; applied?: Record<string, number> };
    check('OneRoster import applies users', imp.status === 200 && impBody.applied?.users === 2, impBody);
    check('OneRoster import applies courses', impBody.applied?.courses === 1, impBody);

    const orUsers = await fetch(`${base}/ims/oneroster/v1p2/users`).then(r => r.json()) as { users?: Array<{ sourcedId: string }> };
    check('GET /users reflects the imported overlay',
      !!orUsers.users?.some(u => u.sourcedId === 'u-imp-1'), orUsers.users?.length);
    const orCourses = await fetch(`${base}/ims/oneroster/v1p2/courses`).then(r => r.json()) as { courses?: Array<{ sourcedId: string }> };
    check('GET /courses returns the imported course',
      !!orCourses.courses?.some(c => c.sourcedId === 'c-imp-1'), orCourses.courses?.length);
    const oneCourse = await fetch(`${base}/ims/oneroster/v1p2/courses/c-imp-1`);
    check('GET /courses/:id resolves the imported course', oneCourse.status === 200, oneCourse.status);

    // ── SCORM sequencing over HTTP ──
    const sess = await fetch(`${base}/scorm/sequencing/session`, {
      method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: MANIFEST,
    });
    const sessBody = await sess.json() as { sessionId?: string };
    check('SCORM session created over HTTP', sess.status === 200 && !!sessBody.sessionId, sessBody.sessionId);
    const nav = await fetch(`${base}/scorm/sequencing/${sessBody.sessionId}/navigate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'start' }),
    });
    const navBody = await nav.json() as { delivered?: { activityId?: string } };
    check('SCORM navigate(start) delivers over HTTP', navBody.delivered?.activityId === 'SCO-A1', navBody);
  } finally {
    server.close();
  }
}

/** Forge an HMAC ticket the same way `lti13.ts` `signTicket` does — so
 *  the deep-linking round trip can be exercised without a real launch. */
function forgeTicket(payload: Record<string, unknown>, keySeed: string): string {
  const sig = createHmac('sha256', keySeed).update(JSON.stringify(payload)).digest('base64url');
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString('base64url');
}

function testOneRosterDirect(): void {
  console.log('\nOneRoster apply-step (direct)');
  const before = tenantOrUsers(DEFAULT_TENANT).length;
  applyCsvBundle(DEFAULT_TENANT, {
    'users.csv': 'sourcedId,givenName,familyName,role\nu-direct-1,Test,User,student',
  });
  const after = tenantOrUsers(DEFAULT_TENANT).length;
  check('applyCsvBundle merges into tenantOrUsers', after >= before + 1, { before, after });
}

async function main(): Promise<void> {
  console.log('LMS-conformance gap-closure smoke test');
  testScormSequencing();
  testOneRosterDirect();
  await testHttpRoutes();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
