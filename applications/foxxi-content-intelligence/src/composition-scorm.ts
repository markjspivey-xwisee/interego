/**
 * A composition projected as a SCORM 2004 package, for an LMS that speaks SCORM rather than cmi5.
 *
 * ★ THE PACKAGE HOLDS NO CONTENT AND NO ANSWERS. A SCO runs inside the LMS and talks to it through
 * a JavaScript API. This package's one SCO is a wrapper: it opens the bridge's player
 * (composition-au-page.ts, with transport=scorm) in a frame, and records what the player posts it
 * through the LMS's API. Resolution and grading stay on the bridge, so a package anyone may
 * download and unzip holds no answer, verifier or salt. (The packages the older course model makes
 * grade inside the SCO, from hashes shipped in the zip.)
 *
 * ★ THE WRAPPER BELIEVES ONLY THE BRIDGE. It records a message only from the bridge's origin, fixed
 * into the package when it is built, and tells the player its own origin, so the player posts only
 * to it.
 *
 * ★ WHAT SCORM RECORDS. Each answered question as an interaction: its id, type, the learner's
 * response in SCORM's format and whether it was right, never its correct responses. When the play
 * ends: completion, the score over every graded question, and success against the LMS's passing
 * score (cmi.scaled_passing_score), or, with none set, every graded question right. The LMS names
 * its learner by an id the bridge cannot verify, so, as under cmi5, the attempt resolves with no
 * record and counts nothing toward what has worked.
 *
 * The wrapper's script uses no regular expressions and no backslashes: it is written inside a
 * template literal, where a backslash would not survive into the page. Each value written into it
 * goes in as JSON with no "<" or ">" (scriptData), because a composition's title is its author's.
 */
import AdmZip from 'adm-zip';
import type { Composition } from './compositions.js';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/**
 * A value written into the wrapper's script: JSON with no "<" or ">", so nothing in it (an
 * author's title of "</script><script>…", say) can end the script and run inside the LMS.
 */
const scriptData = (s: unknown): string => JSON.stringify(s).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

/** The activity a SCORM attempt at a composition names: its IRI with a fragment of its own. */
export const scoIdOf = (compositionIri: string): string => `${compositionIri}#sco`;

/** The manifest (SCORM 2004 4th Edition): one organization, one item, one SCO, the wrapper. */
export function compositionScormManifest(c: Composition): string {
  const id = c['@id'].split('/').at(-1)!.slice(0, 16);
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST-${id}" version="1.0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:imsss="http://www.imsglobal.org/xsd/imsss">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="ORG-${id}"><organization identifier="ORG-${id}"><title>${esc(c.title)}</title>
    <item identifier="ITEM-${id}" identifierref="RES-${id}"><title>${esc(c.title)}</title></item>
  </organization></organizations>
  <resources>
    <resource identifier="RES-${id}" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/></resource>
  </resources>
</manifest>`;
}

/** The wrapper SCO: finds the LMS's API, opens the player in a frame, and records what the bridge posts. */
export function compositionScormWrapper(opts: { title: string; playerUrl: string; activityId: string }): string {
  const bridgeOrigin = new URL(opts.playerUrl).origin;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
 html,body{margin:0;height:100%;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
 iframe{border:0;width:100%;height:calc(100% - 28px)}
 #status{font-size:12px;padding:6px 12px;opacity:.8}
</style></head><body>
<div id="status">Connecting to the learning system…</div>
<script>
(function () {
  var PLAYER = ${scriptData(opts.playerUrl)};
  var BRIDGE = ${scriptData(bridgeOrigin)};
  var ACTIVITY = ${scriptData(opts.activityId)};
  var status = document.getElementById('status');
  function findAPI(w) {
    for (var n = 0; w && n < 12; n++) {
      try { if (w.API_1484_11) return w.API_1484_11; if (w.parent === w) break; w = w.parent; } catch (e) { break; }
    }
    return null;
  }
  var API = findAPI(window);
  if (!API) { try { API = findAPI(window.opener); } catch (e) { API = null; } }
  function call(method, a, b) {
    var r = API[method](a, b);
    if (String(r) !== 'true') throw new Error(method + ' failed (SCORM ' + API.GetLastError() + ')');
  }
  var initialized = false;
  var terminated = false;
  var count = 0;
  var learner = 'preview';
  var passing = 1;
  try {
    if (API) {
      call('Initialize', '');
      initialized = true;
      count = Number(API.GetValue('cmi.interactions._count')) || 0;
      learner = API.GetValue('cmi.learner_id') || 'unknown';
      var ps = API.GetValue('cmi.scaled_passing_score');
      passing = ps === '' || ps === null || ps === undefined ? 1 : Number(ps);
      status.textContent = 'Connected to the learning system.';
    } else {
      status.textContent = 'Preview only: launch this from a SCORM 2004 learning system to record an attempt.';
    }
  } catch (e) { status.textContent = String((e && e.message) || e); }

  var actor = { objectType: 'Agent', account: { homePage: location.origin, name: learner } };
  var frame = document.createElement('iframe');
  frame.title = ${scriptData(opts.title)};
  frame.src = PLAYER + '?transport=scorm&parentOrigin=' + encodeURIComponent(location.origin)
    + '&activityId=' + encodeURIComponent(ACTIVITY) + '&actor=' + encodeURIComponent(JSON.stringify(actor));
  document.body.appendChild(frame);

  function firstValue(map) { for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k)) return String(map[k]); } return ''; }
  function record(s) {
    if (!s || !s.verb || String(s.verb.id).split('/').pop() !== 'answered') return;
    var d = (s.object && s.object.definition) || {};
    var r = s.result || {};
    var p = 'cmi.interactions.' + (count++) + '.';
    call('SetValue', p + 'id', String(s.object.id));
    call('SetValue', p + 'type', String(d.interactionType || 'other'));
    if (d.description) call('SetValue', p + 'description', firstValue(d.description).slice(0, 250));
    if (typeof r.response === 'string') call('SetValue', p + 'learner_response', r.response.slice(0, d.interactionType === 'long-fill-in' ? 4000 : 250));
    call('SetValue', p + 'result', r.success === true ? 'correct' : r.success === false ? 'incorrect' : 'neutral');
  }
  function close(summary) {
    var graded = (summary && summary.graded) || { correct: 0, total: 0 };
    if (graded.total > 0) {
      var scaled = Math.round((graded.correct / graded.total) * 10000) / 10000;
      call('SetValue', 'cmi.score.raw', String(graded.correct));
      call('SetValue', 'cmi.score.min', '0');
      call('SetValue', 'cmi.score.max', String(graded.total));
      call('SetValue', 'cmi.score.scaled', String(scaled));
      call('SetValue', 'cmi.success_status', scaled >= passing ? 'passed' : 'failed');
    }
    call('SetValue', 'cmi.completion_status', 'completed');
    call('Commit', '');
    call('Terminate', '');
    terminated = true;
    status.textContent = 'Recorded in the learning system.';
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== BRIDGE || !e.data || e.data.type !== 'foxxi.scorm') return;
    if (!API || !initialized || terminated) return;
    try {
      (e.data.statements || []).forEach(record);
      if (e.data.done) close(e.data.summary); else call('Commit', '');
    } catch (err) { status.textContent = String((err && err.message) || err); }
  });
  window.addEventListener('beforeunload', function () {
    if (API && initialized && !terminated) { try { API.Terminate(''); } catch (e) { /* the LMS is closing the attempt */ } terminated = true; }
  });
})();
</script>
</body></html>
`;
}

/** The package, byte for byte the same whenever it is built from the same composition and player. */
export function compositionScormZip(c: Composition, playerUrl: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(compositionScormManifest(c)));
  zip.addFile('index.html', Buffer.from(compositionScormWrapper({ title: c.title, playerUrl, activityId: scoIdOf(c['@id']) })));
  zip.addFile('README.txt', Buffer.from('SCORM 2004 4th Edition. Import this archive into a SCORM 2004 learning system.\n'
    + 'Its one SCO opens the Foxxi player for this composition, which resolves it for each learner and grades on the bridge.\n'
    + 'The package holds no content and no answers, and needs the learning system to allow a frame to the bridge.\n'));
  for (const entry of zip.getEntries()) entry.header.time = new Date(2000, 0, 1);
  return zip.toBuffer();
}
