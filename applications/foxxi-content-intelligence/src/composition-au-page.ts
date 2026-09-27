/**
 * The page a projected composition's AU launches (composition-cmi5.ts): the player a person meets
 * inside an LMS that knows nothing of Foxxi.
 *
 * ★ IT DOES WHAT CMI5 ASKS OF AN AU, AND NOTHING THE BRIDGE SHOULD DO INSTEAD. It takes its token
 * from the fetch URL (§8.2), reads LMS.LaunchData (§10), sends the statements the bridge hands it
 * to the LMS's LRS, and shows each step. Resolution and grading stay on the bridge, so the page
 * never holds an answer, a verifier or anything a learner could read one from.
 *
 * ★ A STATEMENT THE LMS REFUSED IS SENT AGAIN, NOT DROPPED. The page keeps what it could not send
 * and offers to try again before anything else happens.
 *
 * The script uses no regular expressions and no backslashes: it is written inside a template
 * literal, where a backslash would not survive into the page.
 */

import { createHash } from 'node:crypto';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The Content-Security-Policy the page is served with: its one script, by hash, and no other that
 * could run, a `javascript:` address included. It talks to whatever LRS the launching LMS names and
 * is framed by whatever LMS launches it, so connections and framing stay open; scripts do not.
 */
export function compositionAuPageCsp(html: string): string {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  const hash = createHash('sha256').update(html.slice(start, end), 'utf8').digest('base64');
  return [
    "default-src 'none'", `script-src 'sha256-${hash}'`, "style-src 'unsafe-inline'", 'img-src * data:', 'media-src *',
    'connect-src *', 'frame-ancestors *', "base-uri 'none'", "form-action 'none'",
  ].join('; ');
}

/** The AU page for a composition, whose session routes live under `sessionBase`. */
export function compositionAuPage(opts: { title: string; sessionBase: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
 :root{color-scheme:light dark}
 body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;line-height:1.6}
 h1{font-size:1.3rem;margin:0 0 4px}.crumb{font-size:12px;opacity:.7}
 .step{border:1px solid #8884;border-radius:8px;padding:14px 16px;margin:14px 0}
 .question{margin:14px 0}.question p{margin:0 0 6px;font-weight:600}
 label{display:block;margin:2px 0}input[type=text],textarea{width:100%;box-sizing:border-box;padding:.45rem;border:1px solid #8886;border-radius:5px;font:inherit}
 button{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:.65rem 1.3rem;font-size:1rem;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 .status{margin-top:14px;font-size:13px;opacity:.85}.ok{color:#1a7f37}.err{color:#c62828}
 .feedback{margin:10px 0;font-size:14px}.feedback li{margin:4px 0}
</style></head><body>
<div class="crumb" id="progress"></div>
<h1 id="title">${esc(opts.title)}</h1>
<div id="feedback" class="feedback"></div>
<div id="step" class="step" hidden></div>
<div><button id="go" disabled>Continue</button> <button id="retry" hidden>Send again</button></div>
<div class="status" id="status">Connecting to your course…</div>
<script>
(function () {
  var SESSION = ${JSON.stringify(opts.sessionBase)};
  var q = new URLSearchParams(location.search);
  var endpoint = q.get('endpoint') || '';
  var lrs = endpoint.slice(-1) === '/' ? endpoint : endpoint + '/';
  var actorText = q.get('actor') || '';
  var registration = q.get('registration') || '';
  var activityId = q.get('activityId') || '';
  var auth = '';
  var session = '';
  var launchData = {};
  var pending = [];
  var current = null;
  var $ = function (id) { return document.getElementById(id); };
  function status(text, cls) { var s = $('status'); s.textContent = text; s.className = 'status' + (cls ? ' ' + cls : ''); }
  function lrsHeaders() { return { 'Authorization': auth, 'X-Experience-API-Version': '1.0.3', 'Content-Type': 'application/json' }; }

  // Statements the LMS has not taken yet are kept and sent first, in order.
  async function send(statements) {
    pending = pending.concat(statements || []);
    if (!pending.length) return;
    var r = await fetch(lrs + 'statements', { method: 'POST', headers: lrsHeaders(), body: JSON.stringify(pending) });
    if (!r.ok) throw new Error('your course did not take the record (' + r.status + ')');
    pending = [];
  }
  async function bridge(path, body) {
    var r = await fetch(SESSION + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('the player answered ' + r.status));
    return j;
  }
  function letter(i) { return String.fromCharCode(65 + i); }
  function option(name, type, value, text) {
    var l = document.createElement('label');
    var input = document.createElement('input');
    input.type = type; input.name = name; input.value = value;
    l.appendChild(input); l.appendChild(document.createTextNode(' ' + text));
    return l;
  }
  function field(name, multiline) {
    var input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = 'text';
    input.name = name;
    return input;
  }
  function note(text) { var p = document.createElement('div'); p.className = 'crumb'; p.textContent = text; return p; }

  function render(view) {
    current = view;
    var box = $('step');
    box.hidden = false;
    box.textContent = '';
    $('progress').textContent = 'Step ' + view.step + ' of ' + view.of;
    var f = view.fragment || {};
    if (f.title) { var h = document.createElement('h2'); h.textContent = f.title; box.appendChild(h); }
    var body = document.createElement('div');
    body.innerHTML = f.bodyHtml || '';
    box.appendChild(body);
    (f.questions || []).forEach(function (question, i) {
      var name = 'q' + i;
      var wrap = document.createElement('div'); wrap.className = 'question';
      var p = document.createElement('p'); p.textContent = (i + 1) + '. ' + question.question; wrap.appendChild(p);
      var input = question.input || {};
      var type = input.type || '';
      if (type === 'choice') {
        (input.options || []).forEach(function (o, k) { wrap.appendChild(option(name, input.multiple ? 'checkbox' : 'radio', letter(k), letter(k) + '. ' + o)); });
      } else if (type === 'true-false') {
        wrap.appendChild(option(name, 'radio', 'true', 'True'));
        wrap.appendChild(option(name, 'radio', 'false', 'False'));
      } else if (type === 'likert') {
        (input.options || []).forEach(function (o, k) { wrap.appendChild(option(name, 'radio', letter(k), o)); });
      } else if (type === 'sequencing') {
        (input.items || []).forEach(function (o, k) { wrap.appendChild(note(letter(k) + '. ' + o)); });
        wrap.appendChild(field(name, false));
        wrap.appendChild(note('Put them in order, as letters: C, A, B'));
      } else if (type === 'matching') {
        (input.items || []).forEach(function (o, k) { wrap.appendChild(note((k + 1) + '. ' + o)); });
        (input.targets || []).forEach(function (o, k) { wrap.appendChild(note(letter(k) + '. ' + o)); });
        wrap.appendChild(field(name, false));
        wrap.appendChild(note('A letter for each numbered prompt, in order: B, A'));
      } else {
        wrap.appendChild(field(name, type === 'long-fill-in'));
      }
      box.appendChild(wrap);
    });
    $('go').textContent = (f.questions || []).length ? 'Submit' : 'Continue';
  }

  function answers() {
    var qs = (current && current.fragment && current.fragment.questions) || [];
    return qs.map(function (question, i) {
      var name = 'q' + i;
      var picked = Array.prototype.slice.call(document.querySelectorAll('[name="' + name + '"]'));
      var checked = picked.filter(function (x) { return (x.type === 'radio' || x.type === 'checkbox') && x.checked; }).map(function (x) { return x.value; });
      if (checked.length) return checked.join(', ');
      var typed = picked.filter(function (x) { return x.type !== 'radio' && x.type !== 'checkbox'; })[0];
      return typed ? typed.value : '';
    });
  }

  function feedback(graded) {
    var box = $('feedback');
    box.textContent = '';
    if (!graded || !graded.detail) return;
    var list = document.createElement('ul');
    graded.detail.forEach(function (d, i) {
      if (d.correct === null) return;
      var li = document.createElement('li');
      li.className = d.correct ? 'ok' : 'err';
      li.textContent = (i + 1) + '. ' + (d.correct ? 'Right.' : 'Not right.') + (d.explanation ? ' ' + d.explanation : '');
      list.appendChild(li);
    });
    if (list.childNodes.length) box.appendChild(list);
  }

  var finished = null;
  function finish(summary) {
    finished = summary || {};
    $('step').hidden = true;
    $('go').hidden = true;
    var graded = finished.graded;
    var said = graded && graded.total ? 'Done: ' + graded.correct + ' of ' + graded.total + ' graded questions right.' : 'Done.';
    status(said, 'ok');
    var back = webAddress(launchData.returnURL);
    if (back) {
      var a = document.createElement('a'); a.href = back; a.textContent = 'Return to your course';
      $('status').appendChild(document.createElement('br')); $('status').appendChild(a);
    }
  }
  // Only a web address is offered as the way back: LaunchData comes from whatever LMS launched
  // this page, and must not name a script to run here.
  function webAddress(value) {
    try { var u = new URL(String(value || '')); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; }
    catch (e) { return ''; }
  }

  // The page moves with the bridge, and waits for the LMS: once a step is taken it is shown, but
  // nothing more is taken until its record has reached the course.
  async function deliver(statements) {
    try {
      await send(statements);
      $('retry').hidden = true;
      if (finished) finish(finished); else { $('go').disabled = false; status('Saved to your course.', 'ok'); }
    } catch (e) {
      status(String((e && e.message) || e), 'err');
      $('retry').hidden = false;
      $('go').disabled = true;
    }
  }

  async function next() {
    $('go').disabled = true;
    var j;
    try {
      j = await bridge('/next', { session: session, answers: answers() });
    } catch (e) {
      status(String((e && e.message) || e), 'err');
      $('go').disabled = false;
      return;
    }
    feedback(j.graded);
    if (j.done) finish(j.summary); else render(j.step);
    await deliver(j.statements);
  }

  $('go').addEventListener('click', next);
  $('retry').addEventListener('click', function () { deliver([]); });

  (async function start() {
    var j;
    try {
      var tr = await fetch(q.get('fetch') || '', { method: 'POST' });
      var token = String(((await tr.json()) || {})['auth-token'] || '');
      auth = token.indexOf('Basic ') === 0 || token.indexOf('Bearer ') === 0 ? token : 'Basic ' + token;
      var state = lrs + 'activities/state?' + new URLSearchParams({ stateId: 'LMS.LaunchData', activityId: activityId, agent: actorText, registration: registration }).toString();
      var ld = await fetch(state, { headers: lrsHeaders() });
      launchData = ld.ok ? await ld.json() : {};
      j = await bridge('/session', {
        actor: JSON.parse(actorText), registration: registration, activityId: activityId,
        contextTemplate: launchData.contextTemplate, masteryScore: launchData.masteryScore, moveOn: launchData.moveOn, launchMode: launchData.launchMode,
      });
    } catch (e) {
      status(String((e && e.message) || e), 'err');
      return;
    }
    session = j.session || '';
    if (j.done) finish(j.summary); else render(j.step);
    await deliver(j.statements);
  })();
})();
</script>
</body></html>
`;
}
