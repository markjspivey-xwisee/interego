/**
 * SCORM dispatch: a course authored on this bridge, played inside another organization's LMS.
 *
 * The course's author makes a dispatch, and the bridge builds a stub package for it, SCORM 2004
 * 4th Edition or SCORM 1.2. The LMS imports the stub like any other package. Its one SCO opens the
 * course on this bridge in a frame, and the bridge's SCORM engine sequences and grades it. The stub
 * reports the outcome back through the LMS's own SCORM API: score, completion, success, an
 * interaction per answered question, and the time spent.
 *
 * ★ THE STUB HOLDS NO CONTENT AND NO ANSWERS. It holds the dispatch's address and the bridge's
 * origin, nothing else. The course stays on the bridge, so the author updates it in one place, and
 * revoking the dispatch, letting it expire, or reaching its launch limit stops every copy of the
 * stub at once.
 *
 * ★ THE LMS KEEPS THE LEARNER'S RECORD. The stub never sends the bridge the LMS's learner id, so the
 * bridge does not know who is learning and records nothing in anyone's name. What it keeps is the
 * author's view of the dispatch: how many attempts were launched, completed and passed. The same
 * choice the composition package makes (composition-scorm.ts), for the same reason: an LMS's
 * learner id is a name the bridge cannot verify.
 *
 * ★ THE STUB BELIEVES ONLY THE BRIDGE, AND THE BRIDGE POSTS ONLY TO THE STUB. The stub records a
 * message only from the bridge's origin, fixed into the package when it is built. It tells the
 * bridge its own origin, and the bridge posts each page's report to that origin only.
 *
 * ★ AN ATTEMPT RESUMES. The stub keeps the bridge's attempt address in the LMS's suspend data, so a
 * learner who closes the course mid-way opens it again where they were, for as long as the attempt
 * lasts on the bridge.
 *
 * The routes expect the app to parse JSON bodies itself (the bridge's app does), and parse only the
 * play page's urlencoded form here.
 *
 * The stub's script uses no regular expressions and no backslashes: it is written inside a template
 * literal, where a backslash would not survive into the page. Every value written into it is JSON
 * with no "<" or ">" (scriptData), because a course's title is its author's.
 *
 * Layer: L3 vertical (Foxxi).
 */
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import express, { type Express, type Request, type Response } from 'express';
import { askCourse, type AskableCourse, type CourseAnswer } from './course-ask.js';
import type { GlossarySources } from './i2idl-glossary.js';
import {
  answersFrom, gradedCard, htmlEscape, page, renderGonePage, renderScoPage,
  type GradedView, type LearnerQuestion, type ScoView,
} from './lti-player.js';

export type ScormVersion = '1.2' | '2004';
export const SCORM_VERSIONS: readonly ScormVersion[] = ['2004', '1.2'];

// ── The dispatch registry ───────────────────────────────────────────────────────────────────────

export interface DispatchUsage { launches: number; completed: number; passed: number; lastLaunchAt?: string }

export interface DispatchRecord {
  readonly id: string;
  readonly courseId: string;
  readonly title: string;
  /** The DID that made the dispatch: the course's author. */
  readonly owner: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly launchLimit?: number;
  revokedAt?: string;
  usage: DispatchUsage;
}

export type DispatchState = 'live' | 'revoked' | 'expired' | 'exhausted';

export function dispatchState(d: DispatchRecord, now: number): DispatchState {
  if (d.revokedAt) return 'revoked';
  if (d.expiresAt && Date.parse(d.expiresAt) <= now) return 'expired';
  if (d.launchLimit !== undefined && d.usage.launches >= d.launchLimit) return 'exhausted';
  return 'live';
}

const STATE_WORDS: Record<Exclude<DispatchState, 'live'>, string> = {
  revoked: 'Its author has withdrawn this course from this learning system.',
  expired: 'This course\'s dispatch has expired. Ask whoever runs your learning system to renew it.',
  exhausted: 'This course\'s dispatch has reached its launch limit. Ask whoever runs your learning system to raise it.',
};

/** Two copies of one dispatch as one: the larger counts, the earlier withdrawal. */
export function mergeDispatch(a: DispatchRecord, b: DispatchRecord): DispatchRecord {
  const revokedAt = [a.revokedAt, b.revokedAt].filter((x): x is string => !!x).sort()[0];
  const last = [a.usage.lastLaunchAt, b.usage.lastLaunchAt].filter((x): x is string => !!x).sort().at(-1);
  return {
    ...a,
    ...(revokedAt ? { revokedAt } : {}),
    usage: {
      launches: Math.max(a.usage.launches, b.usage.launches),
      completed: Math.max(a.usage.completed, b.usage.completed),
      passed: Math.max(a.usage.passed, b.usage.passed),
      ...(last ? { lastLaunchAt: last } : {}),
    },
  };
}

function validRecord(v: unknown): v is DispatchRecord {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  const u = d.usage as Record<string, unknown> | undefined;
  return typeof d.id === 'string' && /^d-[A-Za-z0-9_-]{16,64}$/.test(d.id) && typeof d.courseId === 'string' && typeof d.title === 'string'
    && typeof d.owner === 'string' && typeof d.createdAt === 'string' && !!u
    && typeof u.launches === 'number' && typeof u.completed === 'number' && typeof u.passed === 'number';
}

/**
 * Every dispatch this bridge has made, by id. Bounded, and never by evicting: a dispatch is a promise
 * to another organization, so a full registry, or an author holding as many as one may, refuses a
 * new one instead.
 */
export class DispatchRegistry {
  private readonly byId = new Map<string, DispatchRecord>();
  /** Set when something changed that the durable copy does not hold yet. */
  dirty = false;
  constructor(private readonly max = 50_000, private readonly perOwner = 1_000) {}

  /** A new dispatch, or why there cannot be one. */
  create(input: { courseId: string; title: string; owner: string; expiresAt?: string; launchLimit?: number }, now: number): DispatchRecord | { refused: string } {
    if (this.byId.size >= this.max) return { refused: 'this bridge holds as many dispatches as it can' };
    if (this.ownedBy(input.owner).length >= this.perOwner) return { refused: `an author may hold ${this.perOwner} dispatches; withdraw one you no longer need` };
    const rec: DispatchRecord = {
      id: `d-${randomBytes(18).toString('base64url')}`,
      courseId: input.courseId, title: input.title, owner: input.owner, createdAt: new Date(now).toISOString(),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.launchLimit !== undefined ? { launchLimit: input.launchLimit } : {}),
      usage: { launches: 0, completed: 0, passed: 0 },
    };
    this.byId.set(rec.id, rec);
    this.dirty = true;
    return rec;
  }
  get(id: string): DispatchRecord | undefined { return this.byId.get(id); }
  ownedBy(owner: string): DispatchRecord[] { return [...this.byId.values()].filter(d => d.owner === owner); }
  revoke(id: string, now: number): void { const d = this.byId.get(id); if (d && !d.revokedAt) { d.revokedAt = new Date(now).toISOString(); this.dirty = true; } }
  countLaunch(id: string, now: number): void { const d = this.byId.get(id); if (d) { d.usage.launches++; d.usage.lastLaunchAt = new Date(now).toISOString(); this.dirty = true; } }
  countEnd(id: string, outcome: { completed: boolean; passed: boolean }): void {
    const d = this.byId.get(id);
    if (!d) return;
    if (outcome.completed) d.usage.completed++;
    if (outcome.passed) d.usage.passed++;
    this.dirty = true;
  }
  /** The durable form: one JSON object, dispatch id to record. */
  toJSON(): Record<string, DispatchRecord> { return Object.fromEntries(this.byId); }
  /** Take in a durable copy, merging with what this process holds. Malformed entries are skipped. */
  load(json: unknown): number {
    if (!json || typeof json !== 'object') return 0;
    let n = 0;
    for (const v of Object.values(json as Record<string, unknown>)) {
      if (!validRecord(v)) continue;
      const held = this.byId.get(v.id);
      this.byId.set(v.id, held ? mergeDispatch(held, v) : { ...v, usage: { ...v.usage } });
      n++;
    }
    return n;
  }
  get size(): number { return this.byId.size; }
}

/** What the author sees of a dispatch: its record, its state, and where its packages are. */
export function dispatchView(d: DispatchRecord, baseUrl: string, now: number): Record<string, unknown> {
  const base = baseUrl.replace(/\/$/, '');
  return {
    id: d.id, courseId: d.courseId, title: d.title, owner: d.owner, createdAt: d.createdAt,
    ...(d.expiresAt ? { expiresAt: d.expiresAt } : {}), ...(d.launchLimit !== undefined ? { launchLimit: d.launchLimit } : {}),
    ...(d.revokedAt ? { revokedAt: d.revokedAt } : {}),
    state: dispatchState(d, now), usage: d.usage,
    packages: Object.fromEntries(SCORM_VERSIONS.map(v => [v, dispatchPackageUrl(base, d.id, v)])),
    ask: `${base}/scorm/dispatch/${d.id}/ask`,
  };
}

export const dispatchPackageUrl = (baseUrl: string, id: string, version: ScormVersion): string =>
  `${baseUrl.replace(/\/$/, '')}/scorm/dispatch/${id}/package.zip?scorm=${version}`;

// ── The stub package ────────────────────────────────────────────────────────────────────────────

const xmlEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A value written into a script: JSON with no "<" or ">", so nothing in it can end the script. */
export const scriptData = (s: unknown): string => JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const idPart = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'x';

/**
 * The stub's manifest. One organization, one item, one SCO. The course's mastery score goes in as
 * the passing score: SCORM 2004 as the primary objective's minimum normalized measure, SCORM 1.2 as
 * the item's mastery score. An LMS administrator may change it there, and the stub then grades
 * against theirs.
 */
export function dispatchManifest(d: { id: string; title: string }, version: ScormVersion, masteryScore: number): string {
  const id = idPart(d.id);
  const mastery = masteryScore > 1 ? masteryScore / 100 : masteryScore;
  const title = xmlEsc(d.title);
  if (version === '1.2') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="FOXXI-DISPATCH-${id}" version="1.0" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-${id}"><organization identifier="ORG-${id}"><title>${title}</title>
    <item identifier="ITEM-${id}" identifierref="RES-${id}" isvisible="true"><title>${title}</title><adlcp:masteryscore>${Math.round(mastery * 100)}</adlcp:masteryscore></item>
  </organization></organizations>
  <resources>
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
  </resources>
</manifest>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="FOXXI-DISPATCH-${id}" version="1.0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="ORG-${id}"><organization identifier="ORG-${id}"><title>${title}</title>
    <item identifier="ITEM-${id}" identifierref="RES-${id}"><title>${title}</title>
      <imsss:sequencing><imsss:objectives><imsss:primaryObjective objectiveID="PRIMARY-${id}" satisfiedByMeasure="true"><imsss:minNormalizedMeasure>${Number(mastery.toFixed(4))}</imsss:minNormalizedMeasure></imsss:primaryObjective></imsss:objectives></imsss:sequencing>
    </item>
  </organization></organizations>
  <resources>
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/></resource>
  </resources>
</manifest>`;
}

/** The SCORM data model names the stub uses, per version. */
const DATA_MODEL: Record<ScormVersion, Record<string, string>> = {
  '2004': {
    api: 'API_1484_11', init: 'Initialize', get: 'GetValue', set: 'SetValue', commit: 'Commit', finish: 'Terminate', err: 'GetLastError',
    passing: 'cmi.scaled_passing_score', suspend: 'cmi.suspend_data', exit: 'cmi.exit', sessionTime: 'cmi.session_time',
    count: 'cmi.interactions._count', response: 'learner_response', wrong: 'incorrect', type: 'other',
  },
  '1.2': {
    api: 'API', init: 'LMSInitialize', get: 'LMSGetValue', set: 'LMSSetValue', commit: 'LMSCommit', finish: 'LMSFinish', err: 'LMSGetLastError',
    passing: 'cmi.student_data.mastery_score', suspend: 'cmi.suspend_data', exit: 'cmi.core.exit', sessionTime: 'cmi.core.session_time',
    count: 'cmi.interactions._count', response: 'student_response', wrong: 'wrong', type: 'performance',
  },
};

/** The stub's one SCO: finds the LMS's API, opens the course on the bridge in a frame, and reports what the bridge posts. */
export function dispatchWrapper(opts: { title: string; launchUrl: string; version: ScormVersion }): string {
  const bridgeOrigin = new URL(opts.launchUrl).origin;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${xmlEsc(opts.title)}</title>
<style>
 html,body{margin:0;height:100%;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
 iframe{border:0;width:100%;height:calc(100% - 28px)}
 #status{font-size:12px;padding:6px 12px;opacity:.8}
</style></head><body>
<div id="status">Connecting to the learning system…</div>
<script>
(function () {
  var LAUNCH = ${scriptData(opts.launchUrl)};
  var BRIDGE = ${scriptData(bridgeOrigin)};
  var VERSION = ${scriptData(opts.version)};
  var M = ${scriptData(DATA_MODEL[opts.version])};
  var TITLE = ${scriptData(opts.title)};
  var status = document.getElementById('status');
  var started = new Date().getTime();
  function findAPI(w) {
    for (var n = 0; w && n < 12; n++) {
      try { if (w[M.api]) return w[M.api]; if (w.parent === w) break; w = w.parent; } catch (e) { break; }
    }
    return null;
  }
  var API = findAPI(window);
  if (!API) { try { API = findAPI(window.opener); } catch (e) { API = null; } }
  function call(method, a, b) {
    var r = API[M[method]](a, b);
    if (String(r) !== 'true') throw new Error(M[method] + ' failed (SCORM ' + API[M.err]() + ')');
  }
  function get(name) { var v = API[M.get](name); return v === null || v === undefined ? '' : String(v); }
  var initialized = false;
  var terminated = false;
  var interactions = true;
  var count = 0;
  var passing = null;
  var resume = '';
  var play = '';
  try {
    if (API) {
      call('init', '');
      initialized = true;
      count = Number(get(M.count)) || 0;
      var ps = get(M.passing);
      if (ps !== '' && !isNaN(Number(ps))) passing = VERSION === '1.2' ? Number(ps) / 100 : Number(ps);
      var sd = get(M.suspend);
      if (sd.indexOf('foxxi-play:') === 0) resume = sd.slice(11);
      if (VERSION === '1.2') { if (get('cmi.core.lesson_status') === 'not attempted') call('set', 'cmi.core.lesson_status', 'incomplete'); }
      else if (get('cmi.completion_status') !== 'completed') call('set', 'cmi.completion_status', 'incomplete');
      status.textContent = 'Connected to the learning system.';
    } else {
      status.textContent = 'Preview only: launch this from a SCORM ' + VERSION + ' learning system to record an attempt.';
    }
  } catch (e) { status.textContent = String((e && e.message) || e); }

  var frame = document.createElement('iframe');
  frame.title = TITLE;
  frame.src = LAUNCH + '?scorm=' + encodeURIComponent(VERSION) + '&parentOrigin=' + encodeURIComponent(location.origin)
    + (resume ? '&resume=' + encodeURIComponent(resume) : '');
  document.body.appendChild(frame);

  function two(n) { return (n < 10 ? '0' : '') + n; }
  function sessionTime() {
    var s = Math.max(0, Math.round((new Date().getTime() - started) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (VERSION === '2004') return 'PT' + h + 'H' + m + 'M' + r + 'S';
    var hh = String(h); while (hh.length < 4) hh = '0' + hh;
    return hh + ':' + two(m) + ':' + two(r);
  }
  function record(s) {
    if (!interactions || !s || !s.verb || String(s.verb.id).split('/').pop() !== 'answered') return;
    var d = (s.object && s.object.definition) || {};
    var r = s.result || {};
    var p = 'cmi.interactions.' + count + '.';
    try {
      call('set', p + 'id', String(s.object.id));
      call('set', p + 'type', M.type);
      if (VERSION === '2004' && d.description && d.description.en) call('set', p + 'description', String(d.description.en).slice(0, 250));
      if (typeof r.response === 'string') call('set', p + M.response, r.response.slice(0, VERSION === '2004' ? 4000 : 255));
      call('set', p + 'result', r.success === true ? 'correct' : r.success === false ? M.wrong : 'neutral');
      count++;
    } catch (e) { interactions = false; }
  }
  function close(summary) {
    var graded = (summary && summary.graded) || { correct: 0, total: 0 };
    var scaled = Math.max(0, Math.min(1, Number(summary && summary.score) || 0));
    var success = passing === null ? !!(summary && summary.passed) : scaled >= passing;
    if (VERSION === '2004') {
      if (graded.total > 0) {
        call('set', 'cmi.score.raw', String(Math.round(scaled * 100)));
        call('set', 'cmi.score.min', '0');
        call('set', 'cmi.score.max', '100');
        call('set', 'cmi.score.scaled', String(Math.round(scaled * 10000) / 10000));
        call('set', 'cmi.success_status', success ? 'passed' : 'failed');
      }
      call('set', 'cmi.completion_status', 'completed');
      call('set', M.exit, 'normal');
    } else {
      if (graded.total > 0) {
        call('set', 'cmi.core.score.raw', String(Math.round(scaled * 100)));
        call('set', 'cmi.core.score.min', '0');
        call('set', 'cmi.core.score.max', '100');
      }
      call('set', 'cmi.core.lesson_status', graded.total > 0 ? (success ? 'passed' : 'failed') : 'completed');
      call('set', M.exit, '');
    }
    call('set', M.suspend, '');
    call('set', M.sessionTime, sessionTime());
    call('commit', '');
    call('finish', '');
    terminated = true;
    status.textContent = 'Recorded in the learning system.';
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== BRIDGE || !e.data || e.data.type !== 'foxxi.scorm') return;
    if (!API || !initialized || terminated) return;
    try {
      if (typeof e.data.play === 'string' && e.data.play !== play && !e.data.done) { play = e.data.play; call('set', M.suspend, 'foxxi-play:' + play); }
      (e.data.statements || []).forEach(record);
      if (e.data.done) close(e.data.summary); else call('commit', '');
    } catch (err) { status.textContent = String((err && err.message) || err); }
  });
  window.addEventListener('beforeunload', function () {
    if (!API || !initialized || terminated) return;
    try {
      if (play) API[M.set](M.exit, 'suspend');
      API[M.set](M.sessionTime, sessionTime());
      API[M.commit]('');
      API[M.finish]('');
    } catch (e) { /* the LMS is closing the attempt */ }
    terminated = true;
  });
})();
</script>
</body></html>
`;
}

/** The stub package, byte for byte the same whenever it is built for the same dispatch and version. */
export function dispatchZip(d: { id: string; title: string }, opts: { baseUrl: string; version: ScormVersion; masteryScore: number }): Buffer {
  const base = opts.baseUrl.replace(/\/$/, '');
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(dispatchManifest(d, opts.version, opts.masteryScore)));
  zip.addFile('index.html', Buffer.from(dispatchWrapper({ title: d.title, launchUrl: `${base}/scorm/dispatch/${d.id}/launch`, version: opts.version })));
  zip.addFile('README.txt', Buffer.from([
    `${opts.version === '1.2' ? 'SCORM 1.2' : 'SCORM 2004 4th Edition'}. Import this archive into a learning system that plays that version.`,
    'Its one SCO opens the course on the Foxxi bridge in a frame. The bridge sequences and grades it, and this',
    'package reports the score, completion, success, each answered question and the time spent through your',
    'learning system\'s SCORM API. Your learning system keeps the learner\'s record; the bridge is not told who the',
    'learner is. The package holds no content and no answers, and needs your learning system to allow a frame to',
    `${new URL(base).origin}. The course's author can withdraw it, or let it expire, from the bridge.`,
    `Ask the course a question: ${base}/scorm/dispatch/${d.id}/ask`,
    '',
  ].join('\n')));
  for (const entry of zip.getEntries()) entry.header.time = new Date(2000, 0, 1);
  return zip.toBuffer();
}

// ── Playing a dispatched course ─────────────────────────────────────────────────────────────────

export interface DispatchCourse extends AskableCourse { readonly masteryScore: number }

export type DispatchStep =
  | { ok: false; status: number; error: string }
  | { ok: true; done: false; graded?: GradedView; sco: ScoView }
  | { ok: true; done: true; graded?: GradedView; completed: boolean; passed: boolean; score: number };

/** The SCORM engine, as the dispatch routes use it. The bridge supplies it (bridge/server.ts). */
export interface DispatchEngine<P, C extends DispatchCourse = DispatchCourse> {
  start(course: C, attempt: string): { ok: true; play: P } | { ok: false; status: number; error: string };
  /** The SCO the attempt is on, as a learner may see it, and its questions. */
  current(play: P): { sco: ScoView; questions: readonly LearnerQuestion[] } | null;
  advance(play: P, answers: unknown): Promise<DispatchStep>;
  courseTitle(play: P): string;
}

interface Answered { verb: { id: string }; object: { id: string; definition: { description: { en: string } } }; result: { response: string; success?: boolean } }

interface DispatchPlay<P> {
  readonly id: string;
  readonly dispatchId: string;
  readonly play: P;
  readonly version: ScormVersion;
  readonly parentOrigin?: string;
  expiresAt: number;
  tally: { correct: number; total: number };
  /** The answers the last step graded, for the next page to report to the stub once. */
  report: Answered[];
  ended?: { completed: boolean; passed: boolean; score: number; graded?: GradedView };
  reported?: boolean;
}

const PLAY_TTL_MS = 3 * 60 * 60_000;
const PLAYS_MAX = 5000;
const ANSWERED = 'http://adlnet.gov/expapi/verbs/answered';

/** The origin a stub says it is on, when it is one: http(s), and nothing past the origin. */
export function stubOrigin(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 300) return undefined;
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === raw ? u.origin : undefined;
  } catch { return undefined; }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'sco';

/** The answers a step graded, as the "answered" statements the stub turns into interactions. */
export function answeredFor(scoId: string, graded: GradedView | undefined): Answered[] {
  return (graded?.detail ?? []).map((d, i) => ({
    verb: { id: ANSWERED },
    object: { id: `q-${slug(scoId)}-${i + 1}`, definition: { description: { en: d.question.slice(0, 250) } } },
    result: { response: String(d.your ?? ''), ...(d.correct === null ? {} : { success: d.correct }) },
  }));
}

/** The message a page posts to the stub, and the script that posts it: to the stub's origin only. */
export function reportScript(parentOrigin: string | undefined, message: Record<string, unknown>): string {
  if (!parentOrigin) return '';
  return `<script>(function(){try{if(window.parent&&window.parent!==window)window.parent.postMessage(${scriptData(message)},${scriptData(parentOrigin)});}catch(e){}})();</script>`;
}

function askForm(action: string, playId: string | undefined, q = ''): string {
  return `<form method="GET" action="${htmlEscape(action)}" class="card" style="margin-top:2rem">
<label><span><b>Ask about this course</b></span><input name="q" maxlength="500" value="${htmlEscape(q)}" placeholder="What does this course mean by…?"></label>
${playId ? `<input type="hidden" name="play" value="${htmlEscape(playId)}">` : ''}<button type="submit">Ask</button>
<p class="muted">Answered from the course and the I2IDL Digital Learning Glossary. No model is called.</p></form>`;
}

/** The answer to a question, as a page: what it says, the I2IDL terms with their origins, the sections. */
export function renderAnswerPage(a: CourseAnswer, opts: { askAction: string; back?: string; playId?: string; crumb: string }): string {
  const terms = a.concepts.map(c => {
    const def = c.definition
      ? `<p>${htmlEscape(c.definition)}</p><p class="muted">${htmlEscape(c.provenance.wording)} · I2IDL · <a href="${htmlEscape(c.card)}" target="_blank" rel="noopener">I2IDL's card</a></p>`
      : `<p class="muted">${htmlEscape(c.definitionWithheld ?? '')} <a href="${htmlEscape(c.card)}" target="_blank" rel="noopener">I2IDL's card</a></p>`;
    const kind = c.i2idlx?.referent ? `<p class="muted">Names: ${htmlEscape(c.i2idlx.referent.label)} · I2IDL-X proposal (Hypothetical)</p>` : '';
    return `<div class="card"><b>${htmlEscape(c.label)}</b>${def}${kind}</div>`;
  }).join('');
  const sections = a.sections.length
    ? `<h2 style="font-size:1rem">In this course</h2>${a.sections.map(s => `<div class="card"><b>${htmlEscape(s.title)}</b><p>${htmlEscape(s.snippet)}</p></div>`).join('')}`
    : '';
  const attribution = a.attribution
    ? `<p class="muted">Definitions: ${htmlEscape(a.attribution.glossary.title)}, release ${htmlEscape(a.attribution.glossary.release)}, by I2IDL. ${htmlEscape(a.attribution.glossary.rights)}${a.attribution.i2idlx ? ` ${htmlEscape(a.attribution.i2idlx.note)}` : ''}</p>`
    : '';
  const inner = `<h1>${htmlEscape(a.question || 'Ask about this course')}</h1>
<p>${htmlEscape(a.answer)}</p>${terms}${sections}${attribution}
${opts.back ? `<p><a href="${htmlEscape(opts.back)}">Back to the course</a></p>` : ''}
${askForm(opts.askAction, opts.playId)}`;
  return page(`${a.question || 'Ask'} · ${a.course.title}`, opts.crumb, inner);
}

function renderDispatchOutcome(args: { courseTitle: string; ended: NonNullable<DispatchPlay<unknown>['ended']>; report: string; askAction: string; crumb: string }): string {
  const pct = Math.round(args.ended.score * 100);
  const inner = `${gradedCard(args.ended.graded)}
<h1>${args.ended.passed ? 'Passed' : 'Not passed yet'}: ${pct}%</h1>
<p>Your learning system has your result. You can close this window.</p>
${askForm(args.askAction, undefined)}${args.report}`;
  return page(`${args.ended.passed ? 'Passed' : 'Not passed'} · ${args.courseTitle}`, args.crumb, inner);
}

export interface DispatchRouteDeps<P, C extends DispatchCourse = DispatchCourse> {
  readonly baseUrl: string;
  readonly registry: DispatchRegistry;
  readonly engine: DispatchEngine<P, C>;
  verifyCaller(body: unknown): Promise<{ ok: true; callerDid: string; payload: Record<string, unknown> } | { ok: false; status: number; error: string }>;
  resolveCourse(courseId: string): Promise<C | null>;
  /** Who authored a course: only they may dispatch it. */
  ownerOf(course: C): Promise<string | undefined>;
  /** Read the durable registry again, when a dispatch is not in this process (another one made it, or this one just started). */
  reload?(): Promise<void>;
  /** The limit on the author's signed calls (the bridge's agentic limit). */
  rateLimit(ip: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  /** Launches and asks a minute, per address (defaults: 120 and 60). */
  publicLimits?: { launchesPerMinute?: number; asksPerMinute?: number };
  /** Called whenever the registry changed; writes the durable copy when it can. */
  persist(): void;
  glossary?: () => Promise<GlossarySources | null>;
  now?: () => number;
  /** Answers an unexpected failure without leaking its detail (the bridge's sendServerError). */
  serverError?: (res: Response, err: unknown, where: string) => void;
}

/**
 * A per-address fixed window for the routes a learner's browser reaches (launch, ask). Wider than an
 * agent's limit, because one organization's learners can share one address, and no model is called.
 */
export function perAddressLimiter(max: number, windowMs: number, now: () => number = Date.now): (ip: string) => { ok: true } | { ok: false; retryAfterSeconds: number } {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (ip) => {
    const t = now();
    let e = seen.get(ip);
    if (!e || t > e.resetAt) { e = { count: 0, resetAt: t + windowMs }; seen.set(ip, e); }
    if (seen.size > 10_000) for (const [k, v] of seen) if (v.resetAt < t) seen.delete(k);
    return ++e.count > max ? { ok: false, retryAfterSeconds: Math.ceil((e.resetAt - t) / 1000) } : { ok: true };
  };
}

const clientIp = (req: Request): string => {
  const xff = req.headers['x-forwarded-for'];
  return typeof xff === 'string' ? xff.split(',').at(-1)!.trim() : Array.isArray(xff) ? xff.at(-1)!.trim() : req.ip ?? 'unknown';
};
const wantsJson = (req: Request): boolean => req.accepts(['html', 'json']) === 'json';
const MAX_LAUNCH_LIMIT = 10_000_000;

/**
 * The dispatch surface:
 *   POST /agent/scorm/dispatch            signed: the course's author makes a dispatch
 *   POST /agent/scorm/dispatch/revoke     signed: its author withdraws it
 *   POST /agent/scorm/dispatches          signed: an author's dispatches, with their usage
 *   GET  /scorm/dispatch/:id/package.zip  the stub (?scorm=2004|1.2)
 *   GET  /scorm/dispatch/:id/launch       what the stub frames: starts or resumes an attempt
 *   GET|POST /scorm/dispatch/play/:play   the attempt, a SCO at a time
 *   GET  /scorm/dispatch/:id/ask          ask the course (?q=)
 */
export function attachScormDispatchRoutes<P, C extends DispatchCourse = DispatchCourse>(app: Express, deps: DispatchRouteDeps<P, C>): void {
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl.replace(/\/$/, '');
  const plays = new Map<string, DispatchPlay<P>>();
  const crumb = (title: string): string => `${title} · from Foxxi, in your learning system`;
  const askAction = (id: string): string => `${base}/scorm/dispatch/${id}/ask`;
  const failed = deps.serverError ?? ((res: Response) => { if (!res.headersSent) res.status(500).json({ error: 'internal error' }); });

  const playAt = (id: string): DispatchPlay<P> | undefined => {
    const p = plays.get(id);
    if (p && p.expiresAt < now()) { plays.delete(id); return undefined; }
    return p;
  };
  const launchesByAddress = perAddressLimiter(deps.publicLimits?.launchesPerMinute ?? 120, 60_000, now);
  const asksByAddress = perAddressLimiter(deps.publicLimits?.asksPerMinute ?? 60, 60_000, now);
  const limited = (req: Request, res: Response, by: (ip: string) => { ok: true } | { ok: false; retryAfterSeconds: number } = deps.rateLimit): boolean => {
    const rl = by(clientIp(req));
    if (rl.ok) return false;
    res.status(429).json({ error: `rate limit — retry in ${rl.retryAfterSeconds}s` });
    return true;
  };
  const gone = (req: Request, res: Response, status: number, message: string): void => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    if (wantsJson(req)) res.status(status).json({ error: message }); else res.status(status).type('html').send(renderGonePage(message));
  };
  const known = async (id: string): Promise<DispatchRecord | undefined> => {
    let d = deps.registry.get(id);
    if (!d && deps.reload && /^d-[A-Za-z0-9_-]{16,64}$/.test(id)) { await deps.reload(); d = deps.registry.get(id); }
    return d;
  };
  const liveDispatch = async (req: Request, res: Response): Promise<DispatchRecord | undefined> => {
    const d = await known(String(req.params.id ?? ''));
    if (!d) { gone(req, res, 404, 'There is no such course dispatch.'); return undefined; }
    const state = dispatchState(d, now());
    if (state !== 'live') { gone(req, res, 410, STATE_WORDS[state]); return undefined; }
    return d;
  };

  // ── The author's side: make, withdraw, read usage ──
  app.post('/agent/scorm/dispatch', async (req, res) => {
    try {
      const auth = await deps.verifyCaller(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error, hint: 'sign_request the args, then act urn:iep:action:foxxi:scorm-dispatch-signed.' }); return; }
      if (limited(req, res)) return;
      const p = auth.payload;
      const courseId = typeof p.course_id === 'string' ? p.course_id.trim() : '';
      if (!courseId) { res.status(400).json({ error: 'course_id is required: a course authored on this bridge' }); return; }
      const course = await deps.resolveCourse(courseId);
      if (!course) { res.status(404).json({ error: `no course ${courseId} is played on this bridge's SCORM engine` }); return; }
      const owner = await deps.ownerOf(course);
      if (!owner || owner !== auth.callerDid) { res.status(403).json({ error: 'only the course\'s author may dispatch it' }); return; }
      let expiresAt: string | undefined;
      if (p.expires_at !== undefined) {
        const t = typeof p.expires_at === 'string' ? Date.parse(p.expires_at) : NaN;
        if (!Number.isFinite(t) || t <= now()) { res.status(400).json({ error: 'expires_at must be an ISO 8601 time in the future' }); return; }
        expiresAt = new Date(t).toISOString();
      }
      let launchLimit: number | undefined;
      if (p.launch_limit !== undefined) {
        if (typeof p.launch_limit !== 'number' || !Number.isInteger(p.launch_limit) || p.launch_limit < 1 || p.launch_limit > MAX_LAUNCH_LIMIT) {
          res.status(400).json({ error: `launch_limit must be a whole number from 1 to ${MAX_LAUNCH_LIMIT}` }); return;
        }
        launchLimit = p.launch_limit;
      }
      const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 200) : course.title;
      const d = deps.registry.create({ courseId: course.courseId, title, owner, ...(expiresAt ? { expiresAt } : {}), ...(launchLimit !== undefined ? { launchLimit } : {}) }, now());
      if ('refused' in d) { res.status(503).json({ error: d.refused }); return; }
      deps.persist();
      res.status(201).json({
        kind: 'scorm-dispatch', dispatch: dispatchView(d, base, now()),
        note: 'Import a package into the other learning system. Each is a stub that holds no content: the course plays on this bridge in a frame, and the stub reports the score, completion, success and each answer through that system\'s SCORM API. That system keeps the learner\'s record; this bridge counts launches, completions and passes for you. Withdraw the dispatch with urn:iep:action:foxxi:scorm-dispatch-revoke-signed and every copy of the stub stops launching.',
      });
    } catch (err) { failed(res, err, 'dispatch-create'); }
  });

  app.post('/agent/scorm/dispatch/revoke', async (req, res) => {
    try {
      const auth = await deps.verifyCaller(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      if (limited(req, res)) return;
      const id = typeof auth.payload.dispatch_id === 'string' ? auth.payload.dispatch_id : '';
      const d = await known(id);
      // Another author's dispatch answers exactly as an absent one does.
      if (!d || d.owner !== auth.callerDid) { res.status(404).json({ error: 'no such dispatch of yours' }); return; }
      deps.registry.revoke(id, now());
      deps.persist();
      res.json({ kind: 'scorm-dispatch', dispatch: dispatchView(d, base, now()), note: 'Withdrawn: every copy of its stub now answers that the course was withdrawn. Attempts already under way may finish.' });
    } catch (err) { failed(res, err, 'dispatch-revoke'); }
  });

  app.post('/agent/scorm/dispatches', async (req, res) => {
    try {
      const auth = await deps.verifyCaller(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      const courseId = typeof auth.payload.course_id === 'string' ? auth.payload.course_id : '';
      const mine = deps.registry.ownedBy(auth.callerDid).filter(d => !courseId || d.courseId === courseId);
      res.json({ kind: 'scorm-dispatches', owner: auth.callerDid, count: mine.length, dispatches: mine.map(d => dispatchView(d, base, now())) });
    } catch (err) { failed(res, err, 'dispatch-list'); }
  });

  // ── The stub ──
  app.get('/scorm/dispatch/:id/package.zip', async (req, res) => {
    try {
      const d = await liveDispatch(req, res);
      if (!d) return;
      const version: ScormVersion = req.query.scorm === '1.2' ? '1.2' : '2004';
      const course = await deps.resolveCourse(d.courseId);
      if (!course) { gone(req, res, 404, 'The course behind this dispatch is not available.'); return; }
      const bytes = dispatchZip(d, { baseUrl: base, version, masteryScore: course.masteryScore });
      const name = `${slug(d.title)}-scorm-${version === '1.2' ? '12' : '2004'}.zip`;
      res.set('Cache-Control', 'no-store').type('application/zip').set('Content-Disposition', `attachment; filename="${name}"`).send(bytes);
    } catch (err) { failed(res, err, 'dispatch-package'); }
  });

  app.get('/scorm/dispatch/:id/launch', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
      const d = await liveDispatch(req, res);
      if (!d) return;
      const resume = typeof req.query.resume === 'string' ? playAt(req.query.resume) : undefined;
      if (resume && resume.dispatchId === d.id && !resume.ended) { res.redirect(303, `${base}/scorm/dispatch/play/${resume.id}`); return; }
      if (limited(req, res, launchesByAddress)) return;
      const course = await deps.resolveCourse(d.courseId);
      if (!course) { gone(req, res, 404, 'The course behind this dispatch is not available.'); return; }
      const id = randomBytes(24).toString('base64url');
      const started = deps.engine.start(course, `dispatch:${d.id}:${id}`);
      if (!started.ok) { gone(req, res, started.status, started.error); return; }
      for (const [k, v] of plays) if (v.expiresAt < now()) plays.delete(k);
      if (plays.size >= PLAYS_MAX) { const oldest = plays.keys().next().value; if (oldest !== undefined) plays.delete(oldest); }
      const parentOrigin = stubOrigin(req.query.parentOrigin);
      plays.set(id, {
        id, dispatchId: d.id, play: started.play, version: req.query.scorm === '1.2' ? '1.2' : '2004',
        ...(parentOrigin ? { parentOrigin } : {}), expiresAt: now() + PLAY_TTL_MS, tally: { correct: 0, total: 0 }, report: [],
      });
      deps.registry.countLaunch(d.id, now());
      deps.persist();
      res.redirect(303, `${base}/scorm/dispatch/play/${id}`);
    } catch (err) { failed(res, err, 'dispatch-launch'); }
  });

  const sendPlay = (req: Request, res: Response, dp: DispatchPlay<P>, extra?: { graded?: GradedView; error?: string; status?: number }): void => {
    const title = deps.engine.courseTitle(dp.play);
    if (dp.ended) {
      const message = { type: 'foxxi.scorm', play: dp.id, statements: dp.report, done: true, summary: { completed: dp.ended.completed, passed: dp.ended.passed, score: dp.ended.score, graded: dp.tally } };
      dp.report = [];
      if (wantsJson(req)) { res.json({ kind: 'dispatch-play', done: true, course: { title }, outcome: dp.ended, report: message }); return; }
      res.type('html').send(renderDispatchOutcome({ courseTitle: title, ended: dp.ended, report: reportScript(dp.parentOrigin, message), askAction: askAction(dp.dispatchId), crumb: crumb(title) }));
      return;
    }
    const cur = deps.engine.current(dp.play);
    if (!cur) { gone(req, res, 409, 'This attempt has no section to show.'); return; }
    const message = { type: 'foxxi.scorm', play: dp.id, statements: dp.report, done: false };
    dp.report = [];
    if (wantsJson(req)) {
      res.status(extra?.status ?? 200).json({ kind: 'dispatch-play', done: false, course: { title }, sco: cur.sco, ...(extra?.graded ? { graded: extra.graded } : {}), ...(extra?.error ? { error: extra.error } : {}), submit: { method: 'POST', href: `${base}/scorm/dispatch/play/${dp.id}`, body: '{ "answers": ["one answer per question, in order"] }' }, report: message });
      return;
    }
    res.status(extra?.status ?? 200).type('html').send(renderScoPage({
      courseTitle: title, sco: cur.sco, crumb: crumb(title),
      ...(extra?.graded ? { graded: extra.graded } : {}), ...(extra?.error ? { error: extra.error } : {}),
      after: askForm(askAction(dp.dispatchId), dp.id) + reportScript(dp.parentOrigin, message),
    }));
  };

  app.get('/scorm/dispatch/play/:play', (req, res) => {
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    const dp = playAt(String(req.params.play ?? ''));
    if (!dp) { gone(req, res, 404, 'This attempt has ended, or it expired. Open the course again from your learning system.'); return; }
    sendPlay(req, res, dp);
  });

  // The page's form posts urlencoded; a JSON body is the app's own parser's (a second JSON parser here
  // would read a stream the first one has consumed, when the two come from different body-parser majors).
  app.post('/scorm/dispatch/play/:play', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
      const dp = playAt(String(req.params.play ?? ''));
      if (!dp) { gone(req, res, 404, 'This attempt has ended, or it expired. Open the course again from your learning system.'); return; }
      if (dp.ended) { sendPlay(req, res, dp); return; }
      const cur = deps.engine.current(dp.play);
      const step = await deps.engine.advance(dp.play, answersFrom(req.body, cur?.questions ?? 0));
      if (!step.ok) { sendPlay(req, res, dp, { error: step.error, status: step.status }); return; }
      if (step.graded && cur) {
        dp.report = answeredFor(cur.sco.id, step.graded);
        dp.tally = { correct: dp.tally.correct + step.graded.correct, total: dp.tally.total + step.graded.total };
      }
      if (step.done) {
        dp.ended = { completed: step.completed, passed: step.passed, score: Number(step.score.toFixed(4)), ...(step.graded ? { graded: step.graded } : {}) };
        deps.registry.countEnd(dp.dispatchId, dp.ended);
        deps.persist();
      }
      sendPlay(req, res, dp, step.graded ? { graded: step.graded } : undefined);
    } catch (err) { failed(res, err, 'dispatch-play'); }
  });

  // ── Ask the course ──
  app.get('/scorm/dispatch/:id/ask', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
      const d = await liveDispatch(req, res);
      if (!d) return;
      const q = typeof req.query.q === 'string' ? req.query.q : '';
      const playId = typeof req.query.play === 'string' ? req.query.play : '';
      const back = playId && playAt(playId)?.dispatchId === d.id ? `${base}/scorm/dispatch/play/${playId}` : undefined;
      const course = await deps.resolveCourse(d.courseId);
      if (!course) { gone(req, res, 404, 'The course behind this dispatch is not available.'); return; }
      if (!q.trim()) {
        if (wantsJson(req)) { res.status(400).json({ error: 'q is required: a question about the course' }); return; }
        res.type('html').send(page(`Ask · ${course.title}`, crumb(course.title), `<h1>Ask about this course</h1>${askForm(askAction(d.id), playId || undefined)}${back ? `<p><a href="${htmlEscape(back)}">Back to the course</a></p>` : ''}`));
        return;
      }
      if (limited(req, res, asksByAddress)) return;
      const answer = askCourse({ course, question: q, sources: deps.glossary ? await deps.glossary() : null });
      if (wantsJson(req)) { res.json(answer); return; }
      res.type('html').send(renderAnswerPage(answer, { askAction: askAction(d.id), crumb: crumb(course.title), ...(back ? { back, playId } : {}) }));
    } catch (err) { failed(res, err, 'dispatch-ask'); }
  });
}
