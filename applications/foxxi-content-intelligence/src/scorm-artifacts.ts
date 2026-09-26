/** One artifact implementation for agent-authored and composed SCORM courses. */
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { Express } from 'express';
import { normalizeScormAnswer, scormAnswerCandidates, scormAssessmentScript, type ScormAnswerInput, type ScormAssessmentQuestion } from './scorm-assessment.js';
import { checkStoredInput } from './course-questions.js';
import { courseMarkdownHtml } from './course-markdown.js';
export { normalizeScormAnswer } from './scorm-assessment.js';

export interface ScormArtifactSco {
  id: string; title: string; body: string;
  assessment?: readonly ScormAssessmentQuestion[];
}
export interface ScormArtifactCourse {
  courseId: string; title: string; masteryScore: number;
  scos: readonly ScormArtifactSco[];
}
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const scriptData = (s: unknown): string => JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
export const scormArtifactSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
export const scormScoFilename = (id: string): string => `sco-${scormArtifactSlug(id)}.html`;
export const hashScormAnswer = (s: string, input?: ScormAnswerInput): string => {
  const normalized = input ? scormAnswerCandidates(s, input)[0] : normalizeScormAnswer(s);
  if (!normalized) throw new Error('An assessment answer must be non-empty and satisfy its input constraints.');
  return createHash('sha256').update(normalized).digest('hex');
};

export function validateScormArtifacts(course: ScormArtifactCourse): void {
  if (!course.courseId || !course.title || !Array.isArray(course.scos) || !course.scos.length) throw new Error('A SCORM course requires an identity, title and at least one SCO.');
  if (!Number.isFinite(course.masteryScore) || course.masteryScore < 0 || course.masteryScore > 100) throw new Error('Invalid SCORM mastery score.');
  const files = new Set<string>();
  for (const sco of course.scos) {
    if (!sco.id || typeof sco.title !== 'string' || typeof sco.body !== 'string') throw new Error('Invalid SCO content.');
    const file = scormScoFilename(sco.id);
    if (files.has(file)) throw new Error(`SCO identifiers collide at ${file}.`);
    files.add(file);
    for (const q of sco.assessment ?? []) {
      if (!q.question) throw new Error('An assessment question requires its text.');
      checkStoredInput(q.input);
      const ungraded = q.input?.type === 'likert' || q.input?.type === 'long-fill-in';
      if (ungraded ? q.answerHash !== undefined : !/^[0-9a-f]{64}$/.test(q.answerHash ?? '')) {
        throw new Error(ungraded ? `A ${q.input!.type} question has no answer verifier.` : 'An assessment question requires a SHA-256 answer verifier.');
      }
      if (q.acceptHashes !== undefined && (!Array.isArray(q.acceptHashes) || q.acceptHashes.some((h: unknown) => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)))) throw new Error('Invalid accepted-answer verifiers.');
      if (q.explanation !== undefined && (typeof q.explanation !== 'string' || q.explanation.length > 2000)) throw new Error('Invalid assessment explanation.');
    }
  }
}

/** Render authored typed links as safe navigation, preserving their HMD metadata.
 * Everything else stays escaped prose; no authored HTML or control is executable. */
export function scormProseHtml(body: string): string {
  const links = /\[([^\]\n]+)\]\(([^\s)]+)\)(?:\{([^{}\n]*)\})?/g;
  let result = '', offset = 0;
  for (const match of body.matchAll(links)) {
    result += esc(body.slice(offset, match.index));
    offset = match.index! + match[0].length;
    try {
      const url = new URL(match[2]!);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsafe link.');
      const attrs = match[3] ?? '';
      const rel = /(?:^|\s)rel=["']([^"']*)["']/.exec(attrs)?.[1] ?? 'related';
      const type = /(?:^|\s)type=["']([^"']*)["']/.exec(attrs)?.[1];
      result += `<a href="${esc(url.href)}" rel="${esc(rel)} noopener noreferrer" target="_blank"${type ? ` type="${esc(type)}"` : ''}>${esc(match[1]!)}</a>`;
    } catch { result += esc(match[0]); }
  }
  return result + esc(body.slice(offset));
}

/** resourceBase is used only by the legacy query-parameter manifest URL. */
export function scormArtifactManifest(course: ScormArtifactCourse, resourceBase = ''): string {
  validateScormArtifacts(course);
  const id = scormArtifactSlug(course.courseId);
  const mastery = course.masteryScore > 1 ? course.masteryScore / 100 : course.masteryScore;
  const objective = `<imsss:sequencing><imsss:objectives><imsss:primaryObjective satisfiedByMeasure="true"><imsss:minNormalizedMeasure>${mastery}</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives></imsss:sequencing>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${id}" version="1.0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="ORG-${id}"><organization identifier="ORG-${id}"><title>${esc(course.title)}</title>
${course.scos.map(s => `    <item identifier="ITEM-${scormArtifactSlug(s.id)}" identifierref="RES-${scormArtifactSlug(s.id)}"><title>${esc(s.title)}</title>${objective}</item>`).join('\n')}
    <imsss:sequencing><imsss:controlMode choice="true" flow="true"/><imsss:objectives><imsss:primaryObjective satisfiedByMeasure="true"><imsss:minNormalizedMeasure>${mastery}</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives></imsss:sequencing>
  </organization></organizations>
  <resources>
${course.scos.map(s => `    <resource identifier="RES-${scormArtifactSlug(s.id)}" type="webcontent" adlcp:scormType="sco" href="${esc(resourceBase + scormScoFilename(s.id))}"><file href="${esc(resourceBase + scormScoFilename(s.id))}"/></resource>`).join('\n')}
  </resources>
</manifest>`;
}

/**
 * Runs in any SCORM 2004 host. A preview cannot record completion.
 *
 * The section's Markdown is rendered here, on the server, by course-markdown.ts. Each question
 * gets the control its type calls for, and records as that xAPI/SCORM interaction type with its
 * response in the standard format. A question nothing grades (likert, long-fill-in) records as
 * neutral and counts toward no score. An explanation shows once the attempt is recorded.
 */
export function scormScoHtml(course: ScormArtifactCourse, sco: ScormArtifactSco): string {
  validateScormArtifacts(course);
  if (!course.scos.includes(sco)) throw new Error('SCO does not belong to this course.');
  const mastery = course.masteryScore > 1 ? course.masteryScore / 100 : course.masteryScore;
  const asked = sco.assessment?.length ?? 0;
  const graded = (sco.assessment ?? []).filter(q => q.answerHash).length;
  const note = !asked ? ''
    : `Answer all ${asked} question${asked === 1 ? '' : 's'}. ${graded ? `Each of the ${graded} graded answer${graded === 1 ? '' : 's'} is worth one point. Passing score: ${Math.round(mastery * 100)}%.` : 'None of them is graded.'} Submitting records this attempt.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(sco.title)}</title><style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:auto;padding:24px;line-height:1.6;color:#172033}
a{color:#3531cc;text-underline-offset:3px}#body img{max-width:100%;height:auto}
#body table{border-collapse:collapse;margin:12px 0}#body th,#body td{border:1px solid #c9ceda;padding:6px 10px;vertical-align:top}
#body pre{background:#f4f5f8;padding:12px;border-radius:6px;overflow:auto}#body code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
#body blockquote{border-left:4px solid #c9ceda;margin:12px 0;padding:2px 14px;color:#4a5364}
fieldset{border:0;padding:0;margin:22px 0 6px}legend{padding:0;margin-bottom:6px;font-weight:600}
.opt{display:flex;gap:8px;align-items:baseline;margin:4px 0}
input[type=text],input:not([type]),textarea{display:block;box-sizing:border-box;width:100%;padding:10px;font:inherit;border:1px solid #6c7485;border-radius:5px}
textarea{min-height:120px}select{font:inherit;padding:6px;border:1px solid #6c7485;border-radius:5px;margin:2px 0;max-width:100%}
fieldset[aria-invalid=true] legend{color:#a12626}input:disabled,textarea:disabled,select:disabled{background:#f4f5f8;color:#172033}
.hint{color:#4a5364;font-size:.9rem;margin:4px 0}.feedback{margin:4px 0}.explanation{color:#4a5364;margin:2px 0 0}
.error,.incorrect{color:#a12626}.correct{color:#17602e}
button{padding:12px 20px;background:#3531cc;color:white;border:0;border-radius:6px;font:inherit;cursor:pointer}
button:disabled{opacity:.5;cursor:default}#status{margin-top:16px}
</style></head><body>
<p>${esc(course.title)}</p><h1>${esc(sco.title)}</h1><div id="body">${courseMarkdownHtml(sco.body)}</div>
${note ? `<p id="scoring">${esc(note)}</p>` : ''}
<form id="assessment" novalidate><div id="questions"></div><button id="submit" disabled>${asked ? 'Submit answers' : 'Mark complete'}</button></form><p id="status" role="status" aria-live="polite"></p>
<script>
const SCO=${scriptData(sco)}, MASTERY=${mastery};
${scormAssessmentScript()}
const button=document.getElementById('submit'), status=document.getElementById('status');
const questions=SCO.assessment||[], groups=[], feedback=[], readers=[];
const letter=k=>String.fromCharCode(65+k);
for(const [i,q] of questions.entries()){
  const type=(q.input&&q.input.type)||'text';
  const group=document.createElement('fieldset'), legend=document.createElement('legend');
  legend.textContent=q.question;group.id='question-'+i;group.appendChild(legend);
  const hint=document.createElement('p');hint.id='hint-'+i;hint.className='hint';
  const message=document.createElement('p');message.id='feedback-'+i;message.className='feedback';
  group.setAttribute('aria-describedby',hint.id+' '+message.id);
  let read;
  if(type==='choice'||type==='likert'||type==='true-false'){
    const labels=type==='true-false'?['True','False']:q.input.options, many=type==='choice'&&!!q.input.multiple;
    const boxes=labels.map((text,k)=>{const row=document.createElement('label');row.className='opt';const box=document.createElement('input');box.type=many?'checkbox':'radio';box.name='answer-'+i;box.value=type==='true-false'?(k===0?'true':'false'):letter(k);const span=document.createElement('span');span.textContent=(type==='true-false'?'':letter(k)+'. ')+text;row.append(box,span);group.appendChild(row);return box;});
    hint.textContent=many?'Choose every option that applies.':type==='likert'?'Choose one. This is not graded.':'Choose one.';
    read=()=>boxes.filter(b=>b.checked).map(b=>b.value).join(', ');
  }else if(type==='sequencing'||type==='matching'){
    const rows=type==='sequencing'?q.input.items.map((_,k)=>'Position '+(k+1)):q.input.items, choices=type==='sequencing'?q.input.items:q.input.targets;
    const selects=rows.map((rowLabel,k)=>{const row=document.createElement('label');row.className='opt';const span=document.createElement('span');span.textContent=rowLabel;const select=document.createElement('select');select.name='answer-'+i+'-'+k;const blank=document.createElement('option');blank.value='';blank.textContent='Choose…';select.appendChild(blank);choices.forEach((text,c)=>{const o=document.createElement('option');o.value=letter(c);o.textContent=letter(c)+'. '+text;select.appendChild(o);});row.append(span,select);group.appendChild(row);return select;});
    hint.textContent=type==='sequencing'?'Put the items in order: choose the first, then the second, and so on, each once.':'Match each prompt to one answer.';
    read=()=>selects.some(s=>!s.value)?'':selects.map(s=>s.value).join(', ');
  }else{
    const input=document.createElement(type==='long-fill-in'?'textarea':'input');input.id='answer-'+i;input.name='answer-'+i;input.autocomplete='off';input.required=true;input.maxLength=type==='long-fill-in'?4000:250;
    if(type==='integer'||type==='number'){
      input.inputMode=type==='integer'?'numeric':'decimal';
      hint.textContent=type==='integer'?'Enter a whole number.':'Enter a number.';
      if(q.input.min!==undefined&&q.input.max!==undefined)hint.textContent+=' Allowed range: '+q.input.min+' to '+q.input.max+'.';
      else if(q.input.min!==undefined)hint.textContent+=' Minimum: '+q.input.min+'.';
      else if(q.input.max!==undefined)hint.textContent+=' Maximum: '+q.input.max+'.';
    }else hint.textContent=type==='long-fill-in'?'Write your answer, up to 4000 characters. This is not graded.':'Required. Use 250 characters or fewer.';
    group.appendChild(input);read=()=>input.value;
  }
  group.addEventListener('input',()=>{group.removeAttribute('aria-invalid');message.textContent='';message.className='feedback';});
  group.addEventListener('change',()=>{group.removeAttribute('aria-invalid');message.textContent='';message.className='feedback';});
  group.append(hint,message);document.getElementById('questions').appendChild(group);groups.push(group);feedback.push(message);readers.push(read);
}
function findAPI(w){for(let n=0;w&&n<12;n++){try{if(w.API_1484_11)return w.API_1484_11;if(w.parent===w)break;w=w.parent;}catch(e){break;}}return null;}
let API=findAPI(window);if(!API){try{API=findAPI(window.opener);}catch(e){}}
function call(method,...args){const result=API[method](...args);if(result!=='true')throw new Error(method+' failed (SCORM '+API.GetLastError()+').');}
let initialized=false, committed=false, terminated=false, pending=null, interactionOffset=0;
try{if(API){call('Initialize','');initialized=true;interactionOffset=Number(API.GetValue('cmi.interactions._count'))||0;button.disabled=false;status.textContent='Connected to the learning system.';}else{status.textContent='Preview only. Launch this SCO from a SCORM 2004 learning system to record an attempt.';}}catch(e){status.textContent=e.message;}
async function digestAnswer(normalized){const bytes=new TextEncoder().encode(normalized);const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');}
document.getElementById('assessment').onsubmit=async function(event){event.preventDefault();if(!initialized||button.disabled)return;
  if(!pending){
    const answers=readers.map(read=>read()), errors=validateScormResponses(questions,answers);
    if(errors.length){
      for(const error of errors){if(error.index>=0){groups[error.index].setAttribute('aria-invalid','true');feedback[error.index].textContent=error.message;feedback[error.index].className='feedback error';}}
      status.textContent='Check the highlighted answers. No score has been recorded.';
      groups.find(group=>group.getAttribute('aria-invalid')==='true')?.querySelector('input,textarea,select')?.focus();return;
    }
    // Freeze before the first asynchronous operation; a recording retry uses these answers.
    pending={answers,results:null,score:null,timestamp:new Date().toISOString()};groups.forEach(group=>{group.disabled=true;group.querySelectorAll('input,textarea,select').forEach(control=>control.disabled=true);});
  }
  button.disabled=true;status.textContent='Checking answers and recording this attempt…';
  const gradedCount=questions.filter(q=>q.answerHash).length;
  try{
    if(!pending.results){
      const results=[];
      for(let i=0;i<questions.length;i++){
        if(!questions[i].answerHash){results.push(null);continue;}
        const verifiers=[questions[i].answerHash].concat(questions[i].acceptHashes||[]);let correct=false;
        for(const candidate of scormAnswerCandidates(pending.answers[i],questions[i].input)){if(verifiers.includes(await digestAnswer(candidate))){correct=true;break;}}
        results.push(correct);
      }
      pending.results=results;pending.score=gradedCount?results.filter(r=>r===true).length/gradedCount:null;
    }
    const score=pending.score, correct=pending.results.filter(r=>r===true).length;
    if(!committed){
      for(let i=0;i<questions.length;i++){
        const prefix='cmi.interactions.'+(interactionOffset+i)+'.', type=scormInteractionType(questions[i].input);
        call('SetValue',prefix+'id','urn:foxxi:sco:'+encodeURIComponent(SCO.id)+':question:'+(i+1));
        call('SetValue',prefix+'type',type);
        call('SetValue',prefix+'description',questions[i].question.slice(0,250));
        call('SetValue',prefix+'learner_response',scormInteractionResponse(pending.answers[i],questions[i].input).slice(0,type==='long-fill-in'?4000:250));
        call('SetValue',prefix+'result',pending.results[i]===null?'neutral':pending.results[i]?'correct':'incorrect');
        call('SetValue',prefix+'timestamp',pending.timestamp);
      }
      if(score!==null){call('SetValue','cmi.score.raw',String(correct));call('SetValue','cmi.score.min','0');call('SetValue','cmi.score.max',String(gradedCount));call('SetValue','cmi.score.scaled',String(score));call('SetValue','cmi.success_status',score>=MASTERY?'passed':'failed');}
      call('SetValue','cmi.completion_status','completed');call('Commit','');committed=true;
    }
    if(!terminated){call('Terminate','');terminated=true;}if(API.__foxxiFlush)await API.__foxxiFlush();initialized=false;
    for(let i=0;i<questions.length;i++){
      const r=pending.results[i];feedback[i].textContent=r===null?'Recorded.':r?'Correct.':'Incorrect. Review the lesson before your next attempt.';feedback[i].className='feedback '+(r===null?'':r?'correct':'incorrect');
      if(questions[i].explanation){const why=document.createElement('p');why.className='explanation';why.textContent=questions[i].explanation;feedback[i].after(why);}
    }
    button.textContent='Attempt recorded';
    status.textContent=score===null?'Recorded: completed. No assessment score.':'Recorded: '+correct+'/'+gradedCount+' correct ('+Math.round(score*100)+'%) — '+(score>=MASTERY?'passed':'failed')+'. Passing score: '+Math.round(MASTERY*100)+'%. Use the learning system to continue or start another attempt.';
  }catch(e){status.textContent='Could not finish recording: '+e.message+' Your submitted answers are retained. Retry recording this same attempt.';button.textContent='Retry recording';button.disabled=false;}
};
</script></body></html>`;
}

export function scormArtifactZip(course: ScormArtifactCourse): Buffer {
  const manifest = scormArtifactManifest(course);
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(manifest));
  for (const sco of course.scos) zip.addFile(scormScoFilename(sco.id), Buffer.from(scormScoHtml(course, sco)));
  zip.addFile('README.txt', Buffer.from('SCORM 2004 4th Edition. Import this archive into a SCORM 2004 LMS.\nOpening a SCO directly is preview-only and cannot record completion.\nAssessment scoring is performed in the SCO. Downloadable client-side assessment data is inspectable and is not a secret answer key or evidence of independent assessment.\n'));
  // Regeneration and alternate representations must identify the same bytes.
  for (const entry of zip.getEntries()) entry.header.time = new Date(2000, 0, 1);
  return zip.toBuffer();
}

export function scormArtifactLinks(base: string, courseId: string): { manifest: string; scormZip: string; packageData: string; sco: (id: string) => string } {
  const root = `${base.replace(/\/+$/, '')}/agent/scorm/course/${encodeURIComponent(courseId)}`;
  return { manifest: `${root}/imsmanifest.xml`, scormZip: `${root}/scorm.zip`, packageData: `${root}/scorm.zip?format=json`, sco: id => `${root}/${scormScoFilename(id)}` };
}

/** Reads rehydrate from the same authoritative course resolver used by launch. */
export function attachAgentScormArtifacts(app: Express, resolveCourse: (id: string, author?: string) => Promise<ScormArtifactCourse | null>): void {
  app.get('/agent/scorm/course/:id/:file', async (req, res) => {
    try {
      const course = await resolveCourse(String(req.params.id), typeof req.query.author_did === 'string' ? req.query.author_did : undefined);
      if (!course) { res.status(404).json({ error: 'No such authored course.' }); return; }
      const file = String(req.params.file);
      if (file === 'imsmanifest.xml') { res.type('application/xml').send(scormArtifactManifest(course)); return; }
      if (file === 'scorm.zip') {
        const bytes = scormArtifactZip(course);
        res.set('Cache-Control', 'no-store');
        if (req.query.format === 'json') {
          res.json({ mediaType: 'application/zip', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'base64', data: bytes.toString('base64') }); return;
        }
        res.type('application/zip').set('Content-Disposition', `attachment; filename="${scormArtifactSlug(course.courseId)}-scorm.zip"`).send(bytes); return;
      }
      const sco = course.scos.find(s => scormScoFilename(s.id) === file);
      if (!sco) { res.status(404).json({ error: 'No such SCO resource.' }); return; }
      res.type('html').set('Cache-Control', 'no-store').send(scormScoHtml(course, sco));
    } catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : 'Invalid SCORM course.' }); }
  });
}
