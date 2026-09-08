/** One artifact implementation for agent-authored and composed SCORM courses. */
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { Express } from 'express';

export interface ScormArtifactSco {
  id: string; title: string; body: string;
  assessment?: readonly { question: string; answerHash: string }[];
}
export interface ScormArtifactCourse {
  courseId: string; title: string; masteryScore: number;
  scos: readonly ScormArtifactSco[];
}
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const scriptData = (s: unknown): string => JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
export const scormArtifactSlug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
export const scormScoFilename = (id: string): string => `sco-${scormArtifactSlug(id)}.html`;
export const normalizeScormAnswer = (s: string): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
export const hashScormAnswer = (s: string): string => createHash('sha256').update(normalizeScormAnswer(s)).digest('hex');

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
      if (!q.question || !/^[0-9a-f]{64}$/.test(q.answerHash)) throw new Error('An assessment question requires a SHA-256 answer verifier.');
    }
  }
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

/** Runs in any SCORM 2004 host. A preview cannot record completion. */
export function scormScoHtml(course: ScormArtifactCourse, sco: ScormArtifactSco): string {
  validateScormArtifacts(course);
  if (!course.scos.includes(sco)) throw new Error('SCO does not belong to this course.');
  const mastery = course.masteryScore > 1 ? course.masteryScore / 100 : course.masteryScore;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(sco.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:auto;padding:24px;line-height:1.6;color:#172033}pre{white-space:pre-wrap;font:inherit}label{display:block;margin:20px 0}input{display:block;width:95%;padding:10px}button{padding:12px 20px;background:#3531cc;color:white;border:0;border-radius:6px}button:disabled{opacity:.5}#status{margin-top:16px}</style></head><body>
<p>${esc(course.title)}</p><h1>${esc(sco.title)}</h1><pre id="body"></pre><form id="assessment"><div id="questions"></div><button id="submit" disabled>${sco.assessment?.length ? 'Submit answers' : 'Mark complete'}</button></form><p id="status" role="status"></p>
<script>
const SCO=${scriptData(sco)}, MASTERY=${mastery};
const button=document.getElementById('submit'), status=document.getElementById('status');
document.getElementById('body').textContent=SCO.body;
for(const [i,q] of (SCO.assessment||[]).entries()){const label=document.createElement('label');label.textContent=q.question;const input=document.createElement('input');input.name='answer-'+i;input.autocomplete='off';label.appendChild(input);document.getElementById('questions').appendChild(label);}
function findAPI(w){for(let n=0;w&&n<12;n++){try{if(w.API_1484_11)return w.API_1484_11;if(w.parent===w)break;w=w.parent;}catch(e){break;}}return null;}
let API=findAPI(window);if(!API){try{API=findAPI(window.opener);}catch(e){}}
function call(method,...args){const result=API[method](...args);if(result!=='true')throw new Error(method+' failed (SCORM '+API.GetLastError()+').');}
let initialized=false, committed=false, terminated=false, lastScore=null;
try{if(API){call('Initialize','');initialized=true;button.disabled=false;status.textContent='Connected to the learning system.';}else{status.textContent='Preview only. Launch this SCO from a SCORM 2004 learning system to record an attempt.';}}catch(e){status.textContent=e.message;}
async function digestAnswer(answer){const normalized=String(answer).toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\\s+/g,' ').trim();const bytes=new TextEncoder().encode(normalized);const digest=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');}
document.getElementById('assessment').onsubmit=async function(event){event.preventDefault();if(!initialized||button.disabled)return;button.disabled=true;try{
  let score=null;
  if(!committed){const questions=SCO.assessment||[];if(questions.length){let correct=0;for(let i=0;i<questions.length;i++){const raw=document.querySelector('[name="answer-'+i+'"]').value;const normalized=String(raw).toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\\s+/g,' ').trim();const candidates=normalized?[raw,...normalized.split(' ').filter(token=>token.length>=4)]:[];for(const candidate of candidates){if(await digestAnswer(candidate)===questions[i].answerHash){correct++;break;}}}score=correct/questions.length;}
    if(score!==null){call('SetValue','cmi.score.scaled',String(score));call('SetValue','cmi.success_status',score>=MASTERY?'passed':'failed');}call('SetValue','cmi.completion_status','completed');call('Commit','');committed=true;lastScore=score;
  }else{score=lastScore;}
  if(!terminated){call('Terminate','');terminated=true;}if(API.__foxxiFlush)await API.__foxxiFlush();initialized=false;status.textContent=score===null?'Recorded: completed. No assessment score.':'Recorded: '+Math.round(score*100)+'% — '+(score>=MASTERY?'passed':'failed')+'.';
}catch(e){status.textContent='Could not finish recording: '+e.message;button.disabled=false;}};
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
