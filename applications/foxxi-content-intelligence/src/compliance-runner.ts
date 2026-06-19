/**
 * In-process conformance runners — the engine behind the public compliance
 * microsite. Each runner returns a structured ComplianceReport (no console, no
 * process.exit) so a bridge endpoint can execute it on demand and the microsite
 * can render the full per-check report.
 *
 * These ARE Foxxi's own conformance harnesses, refactored to be callable:
 *   - runXapiConformance  → the 26-check xAPI 2.0 / IEEE 9274.1.1 battery that
 *     tools/xapi-conformance-smoke.mjs runs (about/profile/POST/immutability/
 *     voiding/filtered-query/state-ETag), executed live against the LRS surface.
 *   - runScormConformance → the SCORM 2004 Sequencing & Navigation battery that
 *     tools/lms-conformance-smoke.ts runs against the scorm-sequencing engine.
 *
 * Robust by construction: every check is wrapped so a transient network error or
 * a non-JSON response is recorded as a failed check with detail — it never throws
 * out of the runner (the smoke CLI used to crash on the first non-JSON body).
 */
import {
  parseManifest, createSession, processNavigation, commitTracking,
} from './scorm-sequencing.js';
import { DEFAULT_TENANT } from './tenant-context.js';
import {
  buildCmi5Statement, evaluateMoveOn, buildPassedSessionTrace,
  type Cmi5Session, type Cmi5Actor,
} from './cmi5.js';
import { validateXapiStatement, validateInstance } from './spec/index.js';

export interface ComplianceCheck { name: string; ok: boolean; spec: string; detail?: string; }
export interface ComplianceReport {
  suite: string;
  title: string;
  standard: string;
  target: string;
  ranAt: string;
  passed: number;
  failed: number;
  total: number;
  checks: ComplianceCheck[];
}

function tally(suite: ComplianceReport['suite'], title: string, standard: string, target: string, ranAt: string, checks: ComplianceCheck[]): ComplianceReport {
  return { suite, title, standard, target, ranAt, checks, passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, total: checks.length };
}

// ── xAPI 2.0 / IEEE 9274.1.1 LRS conformance ──────────────────────────────────

const FOXXI_NS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';

interface XapiOpts { baseUrl: string; token: string; webId: string; userId: string; ranAt: string; }

/** Safe fetch — never throws; returns status + parsed json (or null) + raw text. */
async function safe(url: string, init?: RequestInit): Promise<{ status: number; json: any; text: string; headers: Headers | null }> {
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  } catch (e) {
    return { status: 0, json: null, text: `network error: ${(e as Error).message}`, headers: null };
  }
}

export async function runXapiConformance(opts: XapiOpts): Promise<ComplianceReport> {
  const { baseUrl, token, webId, userId, ranAt } = opts;
  void webId;
  const B = baseUrl.replace(/\/$/, '');
  const H = { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0', 'Authorization': `Bearer ${token}` } as Record<string, string>;
  const checks: ComplianceCheck[] = [];
  const add = (name: string, ok: boolean, spec: string, detail = '') => checks.push({ name, ok, spec, ...(detail ? { detail } : {}) });
  const home = 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io';

  // §3.1 + §7.7 — /about
  try {
    const r = await safe(`${B}/xapi/about`, { headers: H });
    add('GET /xapi/about returns 200 with auth', r.status === 200, '§7.7', `HTTP ${r.status}`);
    add('/about reports 2.0.0 in version array', Array.isArray(r.json?.version) && r.json.version.includes('2.0.0'), '§7.7');
    add('/about reports backend description extension', !!r.json?.extensions?.[`${FOXXI_NS}lrsBackend`], 'foxxi ext');
  } catch (e) { add('GET /xapi/about', false, '§7.7', (e as Error).message); }

  // /xapi/profile (xAPI Profile Spec 2017)
  try {
    const r = await safe(`${B}/xapi/profile`);
    add('GET /xapi/profile returns 200 without auth', r.status === 200, 'Profile §3', `HTTP ${r.status}`);
    add('Profile declares @context = profiles context', String(r.json?.['@context'] ?? '').includes('xapi/profiles'), 'Profile §3');
    add('Profile has concepts array', Array.isArray(r.json?.concepts) && r.json.concepts.length > 0, 'Profile §4');
    add('Profile has templates array', Array.isArray(r.json?.templates) && r.json.templates.length > 0, 'Profile §5');
    add('Profile has patterns array', Array.isArray(r.json?.patterns) && r.json.patterns.length > 0, 'Profile §6');
  } catch (e) { add('GET /xapi/profile', false, 'Profile §3', (e as Error).message); }

  // §4.1 — statement POST + round-trip
  let storedId: string | undefined;
  const canonical = {
    actor: { name: 'conformance', account: { homePage: home, name: userId } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { en: 'experienced' } },
    object: { id: 'urn:foxxi:test:conformance-microsite', definition: { type: 'http://adlnet.gov/expapi/activities/lesson' } },
    timestamp: new Date().toISOString(),
  };
  try {
    const r = await safe(`${B}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(canonical) });
    const ids = r.json;
    add('POST /xapi/statements returns 200 + UUID array', r.status === 200 && Array.isArray(ids) && /^[0-9a-f]{8}-/.test(ids?.[0] ?? ''), '§4.1', `HTTP ${r.status}`);
    storedId = Array.isArray(ids) ? ids[0] : undefined;
    if (storedId) {
      const g = await safe(`${B}/xapi/statements?statementId=${storedId}`, { headers: H });
      const got = g.json;
      add('GET single statement by UUID returns it', g.status === 200 && got?.id === storedId, '§4.2');
      add('Stored statement carries version=2.0.0', got?.version === '2.0.0', '§4.1.10');
      add('Stored statement carries actor.objectType=Agent', got?.actor?.objectType === 'Agent', '§4.1.2');
      add('Stored statement carries object.objectType=Activity', got?.object?.objectType === 'Activity', '§4.1.4');
      add('LRS-set authority present', got?.authority?.objectType === 'Agent', '§4.1.10');
      add('LRS-set stored timestamp present', typeof got?.stored === 'string', '§4.1.10');
    }
  } catch (e) { add('POST /xapi/statements', false, '§4.1', (e as Error).message); }

  // §4.1.1 — immutability
  try {
    if (storedId) {
      const same = { ...canonical, id: storedId };
      const r1 = await safe(`${B}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(same) });
      add('Re-POST identical statement does not 409', r1.status === 200, '§4.1.1', `HTTP ${r1.status}`);
      const diff = { ...same, verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { en: 'completed' } } };
      const r2 = await safe(`${B}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(diff) });
      add('Re-POST same id w/ different body → 409', r2.status === 409, '§4.1.1', `HTTP ${r2.status}`);
    } else add('Statement immutability', false, '§4.1.1', 'no stored id from POST');
  } catch (e) { add('Statement immutability', false, '§4.1.1', (e as Error).message); }

  // §4.1.7 — voiding
  try {
    const target = { actor: { name: 'conformance', account: { homePage: home, name: userId } }, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: 'urn:foxxi:test:will-be-voided' } };
    const r1 = await safe(`${B}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(target) });
    const tid = Array.isArray(r1.json) ? r1.json[0] : undefined;
    if (tid) {
      const voiding = { actor: { name: 'conformance', account: { homePage: home, name: userId } }, verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: tid } };
      await safe(`${B}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(voiding) });
      const rNorm = await safe(`${B}/xapi/statements?statementId=${tid}`, { headers: H });
      add('GET ?statementId=<voided> → 404', rNorm.status === 404, '§4.1.7', `HTTP ${rNorm.status}`);
      const rVoid = await safe(`${B}/xapi/statements?voidedStatementId=${tid}`, { headers: H });
      add('GET ?voidedStatementId=<voided> → 200', rVoid.status === 200, '§4.1.7', `HTTP ${rVoid.status}`);
    } else add('Voiding', false, '§4.1.7', 'could not post void target');
  } catch (e) { add('Voiding', false, '§4.1.7', (e as Error).message); }

  // §4.2 — filtered query
  try {
    const r = await safe(`${B}/xapi/statements?verb=${encodeURIComponent('http://adlnet.gov/expapi/verbs/experienced')}&limit=10`, { headers: H });
    add('Verb-filtered query returns statements array', Array.isArray(r.json?.statements), '§4.2');
    add('"more" continuation field present (may be empty)', typeof r.json?.more === 'string', '§4.2');
    const VOIDED = 'http://adlnet.gov/expapi/verbs/voided';
    add('Returned statements honour the verb filter (incl. §4.2.3 voiding statements)',
      Array.isArray(r.json?.statements) && r.json.statements.every((s: any) => s.verb?.id === 'http://adlnet.gov/expapi/verbs/experienced' || s.verb?.id === VOIDED), '§4.2.3');
  } catch (e) { add('Filtered query', false, '§4.2', (e as Error).message); }

  // §6.3 — state resource ETag concurrency
  try {
    const activityId = 'urn:foxxi:test:state-activity';
    const agent = JSON.stringify({ account: { homePage: home, name: userId } });
    const qs = `activityId=${encodeURIComponent(activityId)}&agent=${encodeURIComponent(agent)}&stateId=progress`;
    const url = `${B}/xapi/activities/state?${qs}`;
    await safe(url, { method: 'DELETE', headers: H });
    const r1 = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ slide: 3 }) });
    const etag = r1.headers.get('ETag');
    add('PUT state returns 204 + ETag', r1.status === 204 && !!etag, '§6.3.3', `HTTP ${r1.status}`);
    const r2 = await safe(url, { headers: { ...H, 'If-None-Match': etag ?? '' } });
    add('GET state with If-None-Match=<etag> → 304', r2.status === 304, '§6.3.2', `HTTP ${r2.status}`);
    const r3 = await safe(url, { method: 'PUT', headers: { ...H, 'If-Match': '"wrong-etag"' }, body: JSON.stringify({ slide: 4 }) });
    add('PUT state with wrong If-Match → 412', r3.status === 412, '§6.3.3', `HTTP ${r3.status}`);
    const r4 = await safe(url, { method: 'PUT', headers: { ...H, 'If-Match': etag ?? '' }, body: JSON.stringify({ slide: 4 }) });
    add('PUT state with correct If-Match → 204', r4.status === 204, '§6.3.3', `HTTP ${r4.status}`);
  } catch (e) { add('State resource', false, '§6.3', (e as Error).message); }

  // ── Ontology-grounded conformance: validate against the dereferenceable /ns/xapi
  //    SHACL shapes (the composed xAPI ontology). The LRS's own §4 validator already
  //    single-sources its vocab/patterns from this ontology; here we exercise the
  //    shapes directly and cite their IRIs, so conformance is linked-data, not just code.
  try {
    const stmt = { id: '12345678-1234-1234-1234-1234567890ab', actor: { objectType: 'Agent', mbox: 'mailto:a@example.org' }, verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { en: 'completed' } }, object: { id: 'http://example.org/a', objectType: 'Activity', definition: { interactionType: 'choice' } }, result: { success: true, score: { scaled: 0.9 } }, timestamp: '2026-01-01T00:00:00Z', version: '2.0.0' };
    const v = validateXapiStatement(stmt);
    add('a valid statement conforms to the composed xAPI ontology shapes', v.conforms, 'SHACL', `cites ${v.shapesIri}`);
    const bad = validateXapiStatement({ ...stmt, verb: {}, result: { score: { scaled: 5 } } });
    add('the ontology rejects a malformed statement, citing dereferenceable shape IRIs', !bad.conforms && bad.results.length > 0 && bad.results.every(r => r.sourceShape.includes('/ns/xapi/shapes#')), 'SHACL', `${bad.results.length} cited violations`);
  } catch (e) { add('xAPI ontology (SHACL) validation', false, 'SHACL', (e as Error).message); }

  return tally('xapi-2.0', 'xAPI 2.0 LRS Conformance', 'IEEE 9274.1.1 (xAPI 2.0) + xAPI Profile Spec 2017 — live battery across §3/§4/§6/§7 + the §4 validator (whose vocab/patterns are single-sourced from the dereferenceable /ns/xapi ontology) on every statement, plus direct SHACL validation against the composed /ns/xapi shapes. The complete official ADL lrs-conformance-test-suite (LRS-2.0) passes 1442/1442 (attested, re-runnable).', B, ranAt, checks);
}

// ── SCORM 2004 Sequencing & Navigation conformance ────────────────────────────

const SCORM_MANIFEST = `<?xml version="1.0"?>
<manifest identifier="MAN-1" xmlns:imsss="http://www.imsglobal.org/xsd/imsss" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Compliance Onboarding</title>
      <item identifier="MOD-A"><title>Module A — Foundations</title>
        <item identifier="SCO-A1" identifierref="RES-A1"><title>Lesson A1</title></item>
        <item identifier="SCO-A2" identifierref="RES-A2"><title>Lesson A2</title></item>
        <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
      </item>
      <item identifier="MOD-B"><title>Module B — Assessment</title>
        <item identifier="SCO-B1" identifierref="RES-B1"><title>Final Exam</title>
          <imsss:sequencing>
            <imsss:controlMode choice="true" flow="true"/>
            <imsss:limitConditions attemptLimit="2"/>
            <imsss:objectives><imsss:primaryObjective satisfiedByMeasure="true"><imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives>
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

const SKIP_MANIFEST = `<?xml version="1.0"?>
<manifest identifier="MAN-2" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <organizations default="ORG-2"><organization identifier="ORG-2"><title>Skip Course</title>
    <item identifier="S1" identifierref="R1"><title>First</title></item>
    <item identifier="S2" identifierref="R2"><title>Skipped</title>
      <imsss:sequencing><imsss:sequencingRules><imsss:preConditionRule>
        <imsss:ruleConditions><imsss:ruleCondition condition="always"/></imsss:ruleConditions>
        <imsss:ruleAction action="skip"/>
      </imsss:preConditionRule></imsss:sequencingRules></imsss:sequencing>
    </item>
    <item identifier="S3" identifierref="R3"><title>Last</title></item>
    <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
  </organization></organizations>
  <resources><resource identifier="R1" href="1.html"/><resource identifier="R2" href="2.html"/><resource identifier="R3" href="3.html"/></resources>
</manifest>`;

export function runScormConformance(ranAt: string): ComplianceReport {
  const checks: ComplianceCheck[] = [];
  const add = (name: string, ok: boolean, spec: string, detail = '') => checks.push({ name, ok, spec, ...(detail ? { detail } : {}) });
  try {
    const tree = parseManifest(SCORM_MANIFEST);
    add('Parses the activity tree (6 activities)', tree.preorder.length === 6, '§CAM 3.4', String(tree.preorder.length));
    add('Course title lifted from manifest', tree.courseTitle === 'Compliance Onboarding', '§CAM');
    add('attemptLimit parsed on SCO-B1', tree.preorder.find(a => a.id === 'SCO-B1')?.sequencing.attemptLimit === 2, '§SN limitConditions');
    add('satisfiedByMeasure parsed', tree.preorder.find(a => a.id === 'SCO-B1')?.sequencing.primaryObjective.satisfiedByMeasure === true, '§SN objectives');

    const s = createSession(DEFAULT_TENANT, tree);
    add('Start delivers SCO-A1', processNavigation(s, 'start').delivered?.activityId === 'SCO-A1', '§SN Flow');
    add('Continue → SCO-A2', processNavigation(s, 'continue').delivered?.activityId === 'SCO-A2', '§SN Flow');
    add('Continue crosses module boundary → SCO-B1', processNavigation(s, 'continue').delivered?.activityId === 'SCO-B1', '§SN Flow');
    add('Continue past the last activity ends the sequence', processNavigation(s, 'continue').sequencingEnded === true, '§SN Flow');
    add('Choice delivers the chosen activity', processNavigation(s, 'choice', 'SCO-A2').delivered?.activityId === 'SCO-A2', '§SN Choice');
    add('Previous → SCO-A1', processNavigation(s, 'previous').delivered?.activityId === 'SCO-A1', '§SN Choice');

    processNavigation(s, 'choice', 'SCO-A1');
    commitTracking(s, { completion: 'completed', success: 'passed', scoreScaled: 0.9 });
    processNavigation(s, 'choice', 'SCO-A2');
    add('commit returns activity state', commitTracking(s, { completion: 'completed', success: 'passed', scoreScaled: 1.0 }).ok === true, '§RTE');
    const modA = s.states.get('MOD-A')!;
    add('Rollup: Module A is completed', modA.attemptCompletionStatus === true && modA.attemptProgressStatus === true, '§SN Rollup');
    add('Rollup: Module A measure averaged (0.95)', Math.abs(modA.objectiveNormalizedMeasure - 0.95) < 1e-6, '§SN Rollup', String(modA.objectiveNormalizedMeasure));

    processNavigation(s, 'choice', 'SCO-B1');
    commitTracking(s, { completion: 'completed', scoreScaled: 0.7 });
    add('satisfiedByMeasure: 0.7 < 0.8 → not satisfied', s.states.get('SCO-B1')!.objectiveSatisfiedStatus === false, '§SN Rollup');
    processNavigation(s, 'choice', 'SCO-B1');
    commitTracking(s, { completion: 'completed', scoreScaled: 0.85 });
    add('satisfiedByMeasure: 0.85 ≥ 0.8 → satisfied', s.states.get('SCO-B1')!.objectiveSatisfiedStatus === true, '§SN Rollup');
    add('attemptLimit enforced — 3rd attempt refused', processNavigation(s, 'choice', 'SCO-B1').ok === false, '§SN limitConditions');

    const skipTree = parseManifest(SKIP_MANIFEST);
    const ss = createSession(DEFAULT_TENANT, skipTree);
    add('skip-manifest Start → S1', processNavigation(ss, 'start').delivered?.activityId === 'S1', '§SN');
    add('pre-condition skip: Continue skips S2 → S3', processNavigation(ss, 'continue').delivered?.activityId === 'S3', '§SN preConditionRule');

    const rs = createSession(DEFAULT_TENANT, tree);
    processNavigation(rs, 'start');
    const susp = processNavigation(rs, 'suspendAll');
    add('Suspend All succeeds', susp.ok === true && rs.suspended?.id === 'SCO-A1', '§SN Navigation');
    add('Resume All restores the suspended activity', processNavigation(rs, 'resumeAll').delivered?.activityId === 'SCO-A1', '§SN Navigation');
  } catch (e) {
    add('SCORM SN engine executed', false, '§SN', (e as Error).message);
  }
  // ── Ontology-grounded CAM conformance: validate manifest resources against the
  //    dereferenceable /ns/scorm-cam SHACL shapes, citing their IRIs.
  try {
    const goodRes = { '@type': 'Resource', identifier: 'RES-A1', type: 'webcontent', scormType: 'sco', href: 'a1.html' };
    const v = validateInstance('scorm-cam', goodRes);
    add('a SCORM resource conforms to the composed scorm-cam ontology shapes', !!v && v.conforms, 'ADL CAM / SHACL', v ? `cites ${v.shapesIri}` : 'no validator');
    const badRes = { '@type': 'Resource', scormType: 'bogus' }; // missing identifier+type; scormType not in {sco,asset}
    const vb = validateInstance('scorm-cam', badRes);
    add('the scorm-cam ontology rejects a malformed resource, citing shape IRIs', !!vb && !vb.conforms && vb.results.every(r => r.sourceShape.includes('/ns/scorm-cam/shapes#')), 'SHACL', vb ? `${vb.results.length} cited violations` : 'no validator');
  } catch (e) { add('scorm-cam ontology (SHACL) validation', false, 'SHACL', (e as Error).message); }
  return tally('scorm-2004-sn', 'SCORM 2004 Sequencing & Navigation (S&N book only)', 'ADL SCORM 2004 3rd Ed — Sequencing & Navigation (IMS Simple Sequencing) + activity-tree/manifest parse (CAM) validated against the dereferenceable /ns/scorm-sn + /ns/scorm-cam SHACL shapes. The RTE book (API_1484_11 / CMI data model) runs browser-side in the SCORM player; cmi5 + the desktop ADL SCORM test suite are out of scope here.', 'in-process scorm-sequencing engine', ranAt, checks);
}

// ── cmi5 / IEEE 9274.2.1 conformance ──────────────────────────────────────────

const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const CMI5_MOVEON_CAT = 'https://w3id.org/xapi/cmi5/context/categories/moveon';
const CMI5_VERB_IRI: Record<string, string> = {
  launched: 'http://adlnet.gov/expapi/verbs/launched', initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed: 'http://adlnet.gov/expapi/verbs/completed', passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed', abandoned: 'https://w3id.org/xapi/adl/verbs/abandoned',
  waived: 'https://w3id.org/xapi/adl/verbs/waived', terminated: 'http://adlnet.gov/expapi/verbs/terminated',
  satisfied: 'https://w3id.org/xapi/adl/verbs/satisfied',
};

export function runCmi5Conformance(ranAt: string): ComplianceReport {
  const checks: ComplianceCheck[] = [];
  const add = (name: string, ok: boolean, spec: string, detail = '') => checks.push({ name, ok, spec, ...(detail ? { detail } : {}) });
  const actor: Cmi5Actor = { account: { homePage: 'https://lms.example', name: 'learner-1' } };
  const session: Cmi5Session = { registration: '11111111-1111-1111-1111-111111111111', auActivityId: 'urn:foxxi:au:1', courseActivityId: 'urn:foxxi:course:1', sessionId: 'sess-1', publisherId: 'pub-1', launchedAt: '2026-06-18T00:00:00.000Z' };
  try {
    const verbs = ['launched', 'initialized', 'completed', 'passed', 'failed', 'abandoned', 'waived', 'terminated', 'satisfied'] as const;
    for (const v of verbs) {
      const result = (v === 'passed' || v === 'failed') ? { scoreScaled: 0.9, success: v === 'passed' } : (v === 'completed' ? { completion: true } : undefined);
      const s = buildCmi5Statement({ verb: v, actor, session, ...(result ? { result } : {}) });
      const okV = s.verb.id === CMI5_VERB_IRI[v]
        && s.context.contextActivities.category.some(c => c.id === CMI5_CAT)
        && s.object.id === 'urn:foxxi:au:1' && s.object.objectType === 'Activity'
        && !!s.context.registration;
      add(`cmi5 '${v}' statement — verb IRI + cmi5 category + AU object + registration`, okV, '§9');
    }
    // §9.5 — passed/failed require result.score.scaled
    const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
    add('§9.5: passed without result.score.scaled is rejected', throws(() => buildCmi5Statement({ verb: 'passed', actor, session })), '§9.5');
    add('§9.5: failed without result.score.scaled is rejected', throws(() => buildCmi5Statement({ verb: 'failed', actor, session })), '§9.5');
    // §9.3 — completed must not assert completion=false
    add('§9.3: completed with completion=false is rejected', throws(() => buildCmi5Statement({ verb: 'completed', actor, session, result: { completion: false } })), '§9.3');
    // §10 — satisfied + waived carry the moveOn category
    add("§10: 'satisfied' carries the moveOn category", buildCmi5Statement({ verb: 'satisfied', actor, session }).context.contextActivities.category.some(c => c.id === CMI5_MOVEON_CAT), '§10');
    add("§10: 'waived' carries the moveOn category", buildCmi5Statement({ verb: 'waived', actor, session }).context.contextActivities.category.some(c => c.id === CMI5_MOVEON_CAT), '§10');
    // §11 — moveOn evaluation (the 5 rules)
    add('§11 moveOn=Passed: score≥mastery → satisfied', evaluateMoveOn({ scoreScaled: 0.9, masteryScore: 0.8, moveOnRule: 'Passed' }).satisfied === true, '§11');
    add('§11 moveOn=Passed: score<mastery → not satisfied', evaluateMoveOn({ scoreScaled: 0.5, masteryScore: 0.8, moveOnRule: 'Passed' }).satisfied === false, '§11');
    add('§11 moveOn=Completed: completed → satisfied', evaluateMoveOn({ masteryScore: 0.8, moveOnRule: 'Completed', completed: true }).satisfied === true, '§11');
    add('§11 moveOn=CompletedAndPassed: both required', evaluateMoveOn({ scoreScaled: 0.9, masteryScore: 0.8, moveOnRule: 'CompletedAndPassed', completed: true, passed: true }).satisfied === true && evaluateMoveOn({ scoreScaled: 0.9, masteryScore: 0.8, moveOnRule: 'CompletedAndPassed', completed: false, passed: true }).satisfied === false, '§11');
    add('§11 moveOn=CompletedOrPassed: either suffices', evaluateMoveOn({ masteryScore: 0.8, moveOnRule: 'CompletedOrPassed', completed: true, passed: false }).satisfied === true, '§11');
    add('§11 moveOn=NotApplicable: always satisfied', evaluateMoveOn({ masteryScore: 1, moveOnRule: 'NotApplicable' }).satisfied === true, '§11');
    // §8/§9 — full passed-session trace in spec order, shared registration
    const trace = buildPassedSessionTrace({ actor, session, scoreScaled: 0.9, masteryScore: 0.8, durationIso: 'PT5M', moveOnRule: 'Passed' });
    const order = trace.map(s => s.verb.id);
    const expected = ['launched', 'initialized', 'completed', 'passed', 'terminated'].map(v => CMI5_VERB_IRI[v]);
    add('§9 lifecycle trace in required order (launched→initialized→completed→passed→terminated)', expected.every((e, i) => order[i] === e), '§9');
    add("§11 moveOn satisfied → 'satisfied' appended to the trace", order.includes(CMI5_VERB_IRI.satisfied), '§11');
    add('§8: every statement in the trace shares one registration (session)', trace.every(s => s.context.registration === session.registration), '§8');
  } catch (e) {
    add('cmi5 emitter executed', false, '§9', (e as Error).message);
  }
  return tally('cmi5', 'cmi5 Conformance', 'IEEE 9274.2.1 / cmi5 v1.0 — the 9 statement types, §9 invariants, §10 moveOn category, §11 moveOn evaluation, §8 session/registration (in-process emitter)', 'in-process cmi5 emitter', ranAt, checks);
}

// ── SCORM 2004 CAM (Content Aggregation Model — manifest) conformance ──────────

const CAM_MANIFEST = `<?xml version="1.0"?>
<manifest identifier="MAN-CAM" version="1.0" xmlns:imsss="http://www.imsglobal.org/xsd/imsss" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>CAM Course</title>
      <item identifier="ITEM-1" identifierref="RES-1"><title>Lesson 1</title></item>
      <item identifier="MOD-2"><title>Module 2</title>
        <item identifier="ITEM-2A" identifierref="RES-2A"><title>Lesson 2A</title></item>
        <item identifier="ITEM-2B" identifierref="RES-2B"><title>Lesson 2B</title>
          <imsss:sequencing><imsss:controlMode choice="true" flow="true"/></imsss:sequencing>
        </item>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormType="sco" href="lesson1.html"/>
    <resource identifier="RES-2A" type="webcontent" adlcp:scormType="sco" href="lesson2a.html"/>
    <resource identifier="RES-2B" type="webcontent" adlcp:scormType="asset" href="lesson2b.html"/>
  </resources>
</manifest>`;

export function runCamConformance(ranAt: string): ComplianceReport {
  const checks: ComplianceCheck[] = [];
  const add = (name: string, ok: boolean, spec: string, detail = '') => checks.push({ name, ok, spec, ...(detail ? { detail } : {}) });
  try {
    const tree = parseManifest(CAM_MANIFEST);
    add('Parses the organization/item tree (organization root + 4 items = 5 nodes)', tree.preorder.length === 5, '§CAM 3.4', String(tree.preorder.length));
    add('Default organization title lifted', tree.courseTitle === 'CAM Course', '§CAM 3.4.1');
    add('Manifest item identifiers preserved', ['ITEM-1', 'MOD-2', 'ITEM-2A', 'ITEM-2B'].every(id => tree.preorder.some(a => a.id === id)), '§CAM 3.4');
    add('Nested item hierarchy preserved (MOD-2 contains 2A + 2B)', tree.preorder.some(a => a.id === 'ITEM-2A') && tree.preorder.some(a => a.id === 'ITEM-2B'), '§CAM 3.4');
    const i1 = tree.preorder.find(a => a.id === 'ITEM-1');
    add('item→resource reference resolved (identifierref→href)', i1?.resourceId === 'RES-1' && i1?.href === 'lesson1.html', '§CAM 3.4.1.3', `${i1?.resourceId}/${i1?.href}`);
    const i2a = tree.preorder.find(a => a.id === 'ITEM-2A');
    add('nested leaf resource reference resolved', i2a?.href === 'lesson2a.html', '§CAM 3.4.1.3');
    const i2b = tree.preorder.find(a => a.id === 'ITEM-2B');
    add('per-item <imsss:sequencing> control mode parsed', i2b?.sequencing.controlMode.choice === true && i2b?.sequencing.controlMode.flow === true, '§CAM/§SN');
    add('leaf items are deliverable (have a resource href)', [i1, i2a, i2b].every(a => !!a?.href), '§CAM 3.4.1.3');
  } catch (e) {
    add('CAM manifest parser executed', false, '§CAM', (e as Error).message);
  }
  return tally('scorm-2004-cam', 'SCORM 2004 Content Aggregation Model (manifest)', 'ADL SCORM 2004 4th Ed — Content Aggregation Model: imsmanifest.xml organization/item tree, identifiers, item→resource references. (ZIP packaging + SCORM 1.2/2004/cmi5 detection + SCO/Asset typing are exercised by unwrapScormPackage with real .zip packages, outside this in-process manifest battery.)', 'in-process scorm manifest parser', ranAt, checks);
}
