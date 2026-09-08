/**
 * Foxxi content-package generator — turns an emergent Course into a
 * deployable, runnable training package.
 *
 * The Performance & Knowledge Architecture composes a Course as a typed
 * structure (curriculum → course → module → lesson → grounding
 * fragment). This module is the missing link that makes that structure
 * a real artifact a learner can launch and complete on the LMS:
 *
 *   · a cmi5 package — a `cmi5.xml` course structure + one runnable AU
 *     (an HTML page) per lesson. The AU does the cmi5 launch handshake
 *     (fetch token → auth-token), renders the lesson's text, and emits
 *     xAPI statements straight to the LRS on completion. cmi5 is the
 *     xAPI-native successor to SCORM and is what Foxxi-as-LMS launches.
 *   · a SCORM 2004 package — an `imsmanifest.xml` + one SCO (HTML) per
 *     lesson, zipped. A real, conformant `.zip` artifact that any SCORM
 *     LMS — including Foxxi's own SCORM runtime — can ingest.
 *
 * Content is text. The AU / SCO pages render the fragment bodies as
 * readable text; assessment-item fragments render as scored questions
 * ("question ::: answer"). Nothing here generates media.
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology
 * change.
 */

import { scormArtifactZip, hashScormAnswer, type ScormArtifactCourse } from './scorm-artifacts.js';
import type { Course, Module, Lesson, GroundingFragment } from './emergent-content.js';

const CMI5_NS = 'https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd';

// ── small escapers ──────────────────────────────────────────────────

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function htmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function jsStr(s: unknown): string {
  return JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// ── walking the Course (take the default paradigm cell at each position) ──

export interface FlatLesson {
  moduleId: string;
  moduleTitle: string;
  lesson: Lesson;
  fragments: GroundingFragment[];
}

/** Flatten a Course into its modules → lessons, default-cell at each position. */
export function flattenCourse(course: Course): FlatLesson[] {
  const out: FlatLesson[] = [];
  for (const mPos of course.syntagm) {
    const module: Module | undefined = mPos.paradigm[0];
    if (!module) continue;
    for (const lPos of module.syntagm) {
      const lesson: Lesson | undefined = lPos.paradigm[0];
      if (!lesson) continue;
      out.push({
        moduleId: module.id, moduleTitle: module.title, lesson,
        fragments: lesson.syntagm.map(fp => fp.paradigm[0]).filter((f): f is GroundingFragment => !!f),
      });
    }
  }
  return out;
}

// ── cmi5 package ────────────────────────────────────────────────────

/**
 * Generate the cmi5.xml course structure. `auUrl(lessonId)` supplies the
 * launchable URL of each lesson's AU (served by the bridge).
 */
export function generateCmi5Xml(course: Course, auUrl: (lessonId: string) => string): string {
  const flat = flattenCourse(course);
  // Group lessons by module, preserving order.
  const modules: Array<{ id: string; title: string; lessons: FlatLesson[] }> = [];
  for (const fl of flat) {
    let m = modules.find(x => x.id === fl.moduleId);
    if (!m) { m = { id: fl.moduleId, title: fl.moduleTitle, lessons: [] }; modules.push(m); }
    m.lessons.push(fl);
  }
  const auXml = (fl: FlatLesson): string =>
    `    <au id="${xml(fl.lesson.id)}" moveOn="${xml(String(course.moveOn ?? ''))}" masteryScore="0.6">\n` +
    `      <title><langstring lang="en-US">${xml(fl.lesson.title)}</langstring></title>\n` +
    `      <description><langstring lang="en-US">${xml(fl.lesson.competency)}</langstring></description>\n` +
    `      <url>${xml(auUrl(fl.lesson.id))}</url>\n` +
    `    </au>`;
  const blocks = modules.map(m =>
    `  <block id="${xml(m.id)}">\n` +
    `    <title><langstring lang="en-US">${xml(m.title)}</langstring></title>\n` +
    m.lessons.map(auXml).join('\n') + '\n' +
    `  </block>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<courseStructure xmlns="${CMI5_NS}">
  <course id="${xml(course.id)}">
    <title><langstring lang="en-US">${xml(course.title)}</langstring></title>
    <description><langstring lang="en-US">${xml(course.competency)}</langstring></description>
  </course>
${blocks}
</courseStructure>
`;
}

// ── The runnable AU (a cmi5 Assignable Unit) ────────────────────────

interface AuLessonView {
  id: string;
  title: string;
  competency: string;
  fragments: Array<{ modality: string; level: string; body: string }>;
}

/**
 * Generate a self-contained, runnable cmi5 AU as an HTML page. On load
 * it reads the cmi5 launch parameters from its own URL, exchanges the
 * fetch token for an auth-token, renders the lesson, and — on the
 * learner completing it — emits the cmi5 xAPI statements straight to the
 * LRS. An assessment lesson (assessment-item fragments) is scored.
 */
export function generateAuHtml(courseTitle: string, lesson: AuLessonView): string {
  const isAssessment = lesson.fragments.some(f => f.modality === 'assessment-item');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEsc(lesson.title)}</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:680px;margin:0 auto;padding:24px;color:#15151f;line-height:1.6}
 h1{font-size:1.3rem}h2{font-size:1rem;color:#445}.crumb{font-size:12px;color:#778}
 .frag{border:1px solid #e3e3ee;border-radius:8px;padding:12px 14px;margin:10px 0}
 .mod{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#889}
 button{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:.7rem 1.4rem;font-size:1rem;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 input{padding:.4rem;border:1px solid #ccd;border-radius:5px;font-size:.95rem;width:60%}
 .status{margin-top:14px;font-size:13px;color:#667}.ok{color:#1a7f37}.err{color:#c62828}
</style></head><body>
<div class="crumb">${htmlEsc(courseTitle)}</div>
<h1>${htmlEsc(lesson.title)}</h1>
<div class="crumb">competency: ${htmlEsc(lesson.competency)}</div>
<div id="content"></div>
<div style="margin-top:18px">
  <button id="go" disabled>${isAssessment ? 'Submit answers' : 'Mark complete'}</button>
</div>
<div class="status" id="status">cmi5 — connecting to the LRS…</div>
<script>
const LESSON = ${jsStr(lesson)};
const IS_ASSESSMENT = ${isAssessment};
const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const VERB = {
  initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed:   'http://adlnet.gov/expapi/verbs/completed',
  passed:      'http://adlnet.gov/expapi/verbs/passed',
  failed:      'http://adlnet.gov/expapi/verbs/failed',
  terminated:  'http://adlnet.gov/expapi/verbs/terminated',
};
const q = new URLSearchParams(location.search);
const endpoint = (q.get('endpoint') || '').replace(/\\/?$/, '/');
const fetchUrl = q.get('fetch');
const actor = JSON.parse(q.get('actor') || '{}');
const activityId = q.get('activityId') || LESSON.id;
const registration = q.get('registration') || '';
let authToken = null;
let ready = false;

function setStatus(msg, cls){ const s=document.getElementById('status'); s.textContent=msg; s.className='status '+(cls||''); }

async function sendStatement(verb, result){
  const stmt = {
    actor: actor,
    verb: { id: VERB[verb], display: { 'en-US': verb } },
    object: { objectType: 'Activity', id: activityId,
      definition: { name: { 'en-US': LESSON.title }, type: 'http://adlnet.gov/expapi/activities/lesson' } },
    context: { registration: registration, contextActivities: { category: [ { id: CMI5_CAT } ] } },
    timestamp: new Date().toISOString(),
  };
  if (result) stmt.result = result;
  const r = await fetch(endpoint + 'statements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0',
               'Authorization': 'Bearer ' + authToken },
    body: JSON.stringify(stmt),
  });
  if (!r.ok) throw new Error('LRS ' + r.status + ' on ' + verb);
}

function render(){
  const el = document.getElementById('content');
  for (const f of LESSON.fragments){
    const d = document.createElement('div'); d.className='frag';
    if (IS_ASSESSMENT && f.modality === 'assessment-item'){
      const parts = f.body.split(':::');
      const label = document.createElement('div'); label.textContent = parts[0].trim();
      const inp = document.createElement('input'); inp.className='answer'; inp.dataset.answer=(parts[1]||'').trim();
      d.appendChild(label); d.appendChild(document.createElement('br')); d.appendChild(inp);
    } else {
      const m = document.createElement('div'); m.className='mod'; m.textContent=f.modality;
      const b = document.createElement('div'); b.textContent=f.body;
      d.appendChild(m); d.appendChild(b);
    }
    el.appendChild(d);
  }
}

async function start(){
  try {
    if (!fetchUrl) { setStatus('Not launched via cmi5 — preview only.', 'err'); render(); document.getElementById('go').disabled=true; return; }
    const fr = await fetch(fetchUrl, { method: 'POST' });
    if (!fr.ok) throw new Error('fetch endpoint returned ' + fr.status);
    const fj = await fr.json();
    authToken = fj['auth-token'];
    if (!authToken) throw new Error('no auth-token from fetch endpoint');
    await sendStatement('initialized');
    render();
    ready = true; document.getElementById('go').disabled = false;
    setStatus('Launched. Work through the lesson, then complete it.', 'ok');
  } catch (e) { setStatus('cmi5 launch failed: ' + e.message, 'err'); render(); }
}

document.getElementById('go').onclick = async () => {
  if (!ready) return;
  const btn = document.getElementById('go'); btn.disabled = true;
  try {
    if (IS_ASSESSMENT){
      const inputs = [...document.querySelectorAll('.answer')];
      const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\\s+/g,' ').trim();
      const correct = inputs.filter(i => { const answer=normalize(i.value), expected=normalize(i.dataset.answer||''); return answer.length>0 && [answer,...answer.split(' ').filter(token=>token.length>=4)].includes(expected); }).length;
      const scaled = inputs.length ? correct / inputs.length : 1;
      const passed = scaled >= 0.6;
      await sendStatement(passed ? 'passed' : 'failed', { score: { scaled: scaled }, success: passed, completion: true });
      await sendStatement('completed', { completion: true });
      await sendStatement('terminated');
      setStatus('Assessment submitted — scored ' + Math.round(scaled*100) + '% (' + (passed?'passed':'failed') + '). Statements sent to the LRS.', passed?'ok':'err');
    } else {
      await sendStatement('completed', { completion: true });
      await sendStatement('terminated');
      setStatus('Lesson completed — cmi5 statements sent to the LRS.', 'ok');
    }
  } catch (e) { setStatus('Could not record completion: ' + e.message, 'err'); btn.disabled=false; }
};
start();
</script></body></html>`;
}

// ── SCORM 2004 package ──────────────────────────────────────────────

/** Adapt the composed content model to the same executable SCO artifacts as agent courses. */
export function composedScormCourse(course: Course): ScormArtifactCourse {
  return {
    courseId: course.id, title: course.title, masteryScore: 0.6,
    scos: flattenCourse(course).map(fl => ({
      id: fl.lesson.id, title: fl.lesson.title,
      body: fl.fragments.filter(f => f.modality !== 'assessment-item').map(f => f.body).join('\n\n'),
      assessment: fl.fragments.filter(f => f.modality === 'assessment-item').map(f => {
        const separator = f.body.indexOf(':::');
        if (separator < 0 || !f.body.slice(separator + 3).trim()) throw new Error('An assessment fragment must contain question ::: answer.');
        return { question: f.body.slice(0, separator).trim(), answerHash: hashScormAnswer(f.body.slice(separator + 3).trim()) };
      }),
    })),
  };
}

/** Every manifest resource is materialized; assessments are scored by the emitted SCO. */
export function generateScormZip(course: Course): Buffer {
  return scormArtifactZip(composedScormCourse(course));
}

/** Build the AU view a lesson renders from. */
export function auLessonView(fl: FlatLesson): AuLessonView {
  return {
    id: fl.lesson.id, title: fl.lesson.title, competency: fl.lesson.competency,
    fragments: fl.fragments.map(f => ({ modality: f.modality, level: f.level, body: f.body })),
  };
}
