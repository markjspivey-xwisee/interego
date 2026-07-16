/**
 * Foxxi agent-course player — plays a SCORM 2004 course AUTHORED BY AN AGENT.
 *
 * This is not the Golf player. Golf plays a pre-packaged vendor course: the
 * slides run in an iframe, a client-side RTE shim holds the CMI data model, and
 * the page itself decides what to report. That is SCORM's original sin — the
 * CONTENT reports its own outcome, so the record is only as trustworthy as the
 * page that wrote it.
 *
 * Here the sequencing engine is authoritative and REMOTE:
 *   launch  -> the bridge's SCORM 2004 SN runtime parses the real manifest,
 *              starts an attempt, and DELIVERS a SCO. This page renders it.
 *   submit  -> answers go to the engine. The ENGINE grades them against the
 *              package's answer hashes (the plaintext answers are hashed at
 *              author time and never leave the author's side), commits
 *              cmi.completion/success/score, and sequences on.
 *   rollup  -> when sequencing ends, the ENGINE's rollup decides pass/fail and
 *              writes the learner's record.
 *
 * So this player CANNOT forge an outcome: it holds no answer key, no CMI model,
 * and no write path to anyone's record. Every state-changing call is a signed
 * envelope the engine authenticates. The course you are about to take is about
 * exactly that property — authority closure — and the player demonstrates it.
 *
 * Identity: a real secp256k1 keypair is derived IN THIS BROWSER and kept in
 * localStorage. Your did:ethr IS that key — no account, no signup. The bridge
 * authenticates you in DIRECT mode (the signature recovers to your own DID), so
 * a first-time visitor is a first-class agent taking the course as themselves.
 *
 * URL contract: agent.html?course_id=<id>&author_did=<did>[&bridge=<url>]
 */

// ethers is loaded from a CDN: this is a static nginx site (no bundler step),
// and the only browser-side crypto needed is a wallet + signMessage.
import { Wallet, sha256 } from 'https://esm.sh/ethers@6.13.4';

const url = new URL(location.href);
const BRIDGE = (url.searchParams.get('bridge') || 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');
const COURSE_ID = url.searchParams.get('course_id') || '';
const AUTHOR_DID = url.searchParams.get('author_did') || '';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const sha256Hex = (s) => sha256(enc.encode(s)).slice(2);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── identity ────────────────────────────────────────────────────────────────
// Your key never leaves this browser; only signatures do.
const KEY = 'foxxi.agent-player.key';
let wallet;
try {
  const saved = localStorage.getItem(KEY);
  wallet = saved ? new Wallet(saved) : Wallet.createRandom();
  if (!saved) localStorage.setItem(KEY, wallet.privateKey);
} catch {
  wallet = Wallet.createRandom(); // private mode / storage blocked — ephemeral identity
}
const DID = 'did:ethr:' + wallet.address;

// ── signed-request envelope ─────────────────────────────────────────────────
// { _signed_payload, _signature } where the signature is over the sha256 DIGEST
// STRING of the payload — not the payload bytes.
async function signedPost(path, args) {
  const _signed_payload = JSON.stringify({ agent_id: DID, timestamp: new Date().toISOString(), ...args });
  const _signature = await wallet.signMessage(`sha256:${sha256Hex(_signed_payload)}`);
  trace(path.split('/').pop(), _signature);
  const r = await fetch(BRIDGE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _signed_payload, _signature }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function trace(label, signature) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="verb">${esc(label)}</span> signed as <code>${esc(DID.slice(0, 24))}…</code><br><span class="dim">sig ${esc(signature.slice(0, 34))}…</span>`;
  $('trace-list').prepend(li);
}
function note(msg, kind) {
  const li = document.createElement('li');
  if (kind) li.className = kind;
  li.innerHTML = `<span class="verb">${esc(msg)}</span>`;
  $('trace-list').prepend(li);
}

// ── state ───────────────────────────────────────────────────────────────────
let sessionId = null;
let currentSco = null;
let seen = [];

// ── render ──────────────────────────────────────────────────────────────────
function renderIdentity() {
  $('learner-chip').innerHTML = `taking this course as <code>${esc(DID)}</code>`;
}

function renderToc(course, scos) {
  $('toc').innerHTML =
    `<h3>${esc(course.title)}</h3>` +
    `<div class="dim" style="font-size:12px;margin-bottom:10px">mastery ${course.masteryScore} · authored by an agent</div>` +
    `<ul>${scos.map((s) => {
      const state = seen.includes(s.id) ? 'viewed' : (currentSco && currentSco.id === s.id ? 'active' : '');
      return `<li class="${state}">${esc(s.title)}</li>`;
    }).join('')}</ul>` +
    `<div class="seq-note dim">The engine decides what comes next — this page only renders what it delivers.</div>`;
}

function renderSco(sco) {
  currentSco = sco;
  if (!seen.includes(sco.id)) seen.push(sco.id);
  $('slide-title').textContent = sco.title;
  $('meta').textContent = `SCO ${sco.id} · delivered by the SCORM 2004 SN runtime`;

  const hasQs = Array.isArray(sco.assessment) && sco.assessment.length > 0;
  $('sco-body').innerHTML = `<p>${esc(sco.body)}</p>`;
  $('assessment').innerHTML = hasQs
    ? `<h4>Assessment</h4>` + sco.assessment.map((q) => `
        <label class="q">
          <span class="qtext">${esc(q.question)}</span>
          <input type="text" data-idx="${q.index}" autocomplete="off" placeholder="your answer" />
        </label>`).join('') +
      `<p class="dim gradenote">Graded by the engine against the package's answer hashes — this page holds no answer key.</p>`
    : '';
  $('btn-submit').textContent = hasQs ? 'Submit answers →' : 'Continue →';
  $('btn-submit').disabled = false;
}

function renderRollup(r) {
  $('stage-body').innerHTML = `
    <div class="rollup ${r.passed ? 'pass' : 'fail'}">
      <div class="rollup-verdict">${r.passed ? 'Passed' : 'Not passed'}</div>
      <dl>
        <dt>score</dt><dd>${r.score}</dd>
        <dt>completed</dt><dd>${r.completed}</dd>
        <dt>recorded statements</dt><dd>${r.recordedStatements ?? 0}</dd>
        <dt>your record</dt><dd><code>${esc(r.lens ?? DID)}</code></dd>
      </dl>
      <p class="dim">${esc(r.note ?? '')}</p>
      <p class="dim">This verdict was rolled up by the sequencing engine from the tracking IT committed — not reported by this page.</p>
    </div>`;
}

// ── flow ────────────────────────────────────────────────────────────────────
async function start() {
  renderIdentity();
  if (!COURSE_ID) { $('slide-title').textContent = 'No course_id'; $('meta').textContent = 'Open this player from a course link.'; return; }

  $('slide-title').textContent = 'Loading course…';
  let course;
  try {
    const r = await fetch(`${BRIDGE}/agent/scorm/course/${encodeURIComponent(COURSE_ID)}`);
    course = await r.json();
    if (!r.ok) throw new Error(course.error || `HTTP ${r.status}`);
  } catch (e) {
    $('slide-title').textContent = 'Course not found';
    $('meta').textContent = String(e.message);
    return;
  }
  document.title = `${course.title} — Foxxi`;
  $('course-title').textContent = course.title;
  $('course-links').innerHTML =
    `<a href="${esc(course.hmd)}">read as HyperMarkdown</a> · ` +
    `<a href="${esc(course.manifest)}">imsmanifest.xml</a> · ` +
    `<a href="${esc(course.href)}">catalog record</a>`;
  renderToc(course, course.scos ?? []);

  $('slide-title').textContent = 'Ready';
  $('meta').textContent = 'Starting a new attempt on the sequencing engine…';

  try {
    const l = await signedPost('/agent/scorm/launch', { course_id: COURSE_ID, ...(AUTHOR_DID ? { author_did: AUTHOR_DID } : {}) });
    sessionId = l.sessionId;
    note(`attempt started · session ${String(l.sessionId).slice(0, 8)}…`);
    renderToc(course, course.scos ?? []);
    renderSco(l.sco);
  } catch (e) {
    $('slide-title').textContent = 'Could not start an attempt';
    $('meta').textContent = String(e.message);
    note(String(e.message), 'err');
    return;
  }

  $('btn-submit').addEventListener('click', async () => {
    $('btn-submit').disabled = true;
    // The engine takes answers POSITIONALLY, ordered by question index.
    const inputs = [...document.querySelectorAll('#assessment input')];
    const answers = inputs.sort((a, b) => Number(a.dataset.idx) - Number(b.dataset.idx)).map((i) => i.value);
    try {
      const s = await signedPost('/agent/scorm/submit', { session_id: sessionId, ...(answers.length ? { answers } : {}) });
      if (s.graded) note(`engine graded: ${s.graded.correct}/${s.graded.total} · ${s.graded.passed ? 'passed' : 'failed'}`, s.graded.passed ? '' : 'err');
      if (s.done) { renderRollup(s); renderToc(course, course.scos ?? []); return; }
      renderSco(s.sco);
      renderToc(course, course.scos ?? []);
    } catch (e) {
      note(String(e.message), 'err');
      $('btn-submit').disabled = false;
    }
  });
}

start();
