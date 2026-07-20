/**
 * Foxxi course player — Golf Explained (SCORM Cloud sample).
 *
 * Pure vanilla JS. Loads the SCORM-extracted HTML slides from /course/,
 * tracks the learner's progression, and emits granular xAPI statements
 * to the Foxxi bridge's inbound LRS endpoint (Foxxi-as-LRS) as the
 * learner moves through the course. Every navigation, every slide
 * view, the final completion — each lands as its own Statement with
 * the proper verb, activity-type, context, and result per Foxxi's
 * published xAPI Profile.
 *
 * URL contract: ?code=<launch-code>&bridge=<url>&learner_did=<webid>&course_id=golf-explained
 *   (or, for stand-alone testing: ?bearer=<token>&bridge=<url>&…)
 *
 * When the player is opened from the Foxxi dashboard, the dashboard
 * does NOT put the long-lived session bearer in the URL. It mints a
 * short-lived single-use `code` (out-of-band auth handoff — see
 * docs/patterns/out-of-band-auth-exchange.md) and passes that instead.
 * The player exchanges `code` → bearer on startup. A `bearer` param is
 * still accepted for stand-alone testing. When opened with neither, the
 * player still renders the course but emits statements anonymously (the
 * bridge rejects them with 401 — surfaced in the trace panel).
 */

const url = new URL(location.href);
const params = {
  bearer: url.searchParams.get('bearer') || '',
  code: url.searchParams.get('code') || '',
  bridge: url.searchParams.get('bridge') || 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  learnerDid: url.searchParams.get('learner_did') || 'urn:anonymous:player',
  learnerName: url.searchParams.get('learner_name') || 'Anonymous Learner',
  courseId: url.searchParams.get('course_id') || 'golf-explained',
  registration: url.searchParams.get('registration') || crypto.randomUUID(),
};

// Hand the SCORM RTE the session config so its auto-emissions on Commit /
// Terminate carry the right actor + bridge + registration. The SCO would
// see this via window.parent.API_1484_11 in the standard discovery chain.
// The course's canonical id is a dereferenceable URL (matches the bridge's courseIri
// mint), so the SCO's auto-emitted xAPI object.id lines up with the bridge's — no split
// activity history across urn/URL for the same course.
const COURSE_IRI = `${(params.bridge || 'https://foxxi-bridge.interego.xwisee.com').replace(/\/+$/, '')}/agent/scorm/course/${encodeURIComponent(params.courseId)}`;
window.__foxxiPlayerConfig = {
  bearer: params.bearer,
  bridge: params.bridge,
  learnerDid: params.learnerDid,
  learnerName: params.learnerName,
  registration: params.registration,
  courseId: params.courseId,
  courseIri: COURSE_IRI,
  courseTitle: 'Golf Explained',
  identityServer: 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  onEmit: (stmt, ok, status, errMsg) => {
    const v = stmt?.verb?.display?.en || stmt?.verb?.id?.split('/').pop();
    if (ok) logTrace(`<span class="verb">scorm:${v}</span> → CMI commit→xAPI`);
    else    logTrace(`scorm:${v} → HTTP ${status} ${errMsg || ''}`, true);
  },
};

// Slide map — mirrors generate-demo-course-data.mjs scene/slide structure
// plus the actual file paths in the extracted SCORM package.
const SLIDES = [
  // Etiquette
  { id: 'etq-course',      scene: 'Etiquette',    title: 'On the course',                file: 'Etiquette/Course.html' },
  { id: 'etq-distracting', scene: 'Etiquette',    title: 'Avoiding distractions',        file: 'Etiquette/Distracting.html' },
  { id: 'etq-play',        scene: 'Etiquette',    title: 'Order of play',                file: 'Etiquette/Play.html' },
  // Handicapping
  { id: 'hcp-overview',    scene: 'Handicapping', title: 'Handicapping overview',        file: 'Handicapping/Overview.html' },
  { id: 'hcp-calc-score',  scene: 'Handicapping', title: 'Calculating your score',       file: 'Handicapping/CalculatingScore.html' },
  { id: 'hcp-calc-handi',  scene: 'Handicapping', title: 'Calculating your handicap',    file: 'Handicapping/CalculatingHandicap.html' },
  { id: 'hcp-example',     scene: 'Handicapping', title: 'Worked example',               file: 'Handicapping/Example.html' },
  // Having Fun
  { id: 'fun-howto',       scene: 'Having Fun',   title: 'How to have fun',              file: 'HavingFun/HowToHaveFun.html' },
  { id: 'fun-friends',     scene: 'Having Fun',   title: 'Making friends',               file: 'HavingFun/MakeFriends.html' },
  // Playing
  { id: 'pl-rules',        scene: 'Playing',      title: 'The Rules of Golf',            file: 'Playing/RulesOfGolf.html' },
  { id: 'pl-playing',      scene: 'Playing',      title: 'How to play',                  file: 'Playing/Playing.html' },
  { id: 'pl-par',          scene: 'Playing',      title: 'What is par?',                 file: 'Playing/Par.html' },
  { id: 'pl-scoring',      scene: 'Playing',      title: 'Scoring',                      file: 'Playing/Scoring.html' },
  { id: 'pl-other',        scene: 'Playing',      title: 'Other scoring methods',        file: 'Playing/OtherScoring.html' },
];

// ── xAPI emission ──────────────────────────────────────────────────

const FOXXI_NS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
const ADL = 'http://adlnet.gov/expapi/';
const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
// COURSE_IRI is declared at the top of the file (line 35) — reused here
const COURSE_DEF = {
  name: { 'en': 'Golf Explained' },
  description: { 'en': 'SCORM Cloud sample course (Single SCO SCORM 2004 3rd Edition) by Rustici Software, used as the Foxxi demo content.' },
  type: `${ADL}activities/course`,
};

function actor() {
  return {
    objectType: 'Agent',
    name: params.learnerName,
    account: {
      homePage: 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io',
      name: params.learnerDid,
    },
  };
}

function baseContext(extraExt = {}) {
  return {
    registration: params.registration,
    contextActivities: {
      category: [
        { id: CMI5_CAT, definition: { type: `${ADL}activities/profile` } },
        { id: `${FOXXI_NS}profile`, definition: { type: 'http://w3id.org/xapi/profiles' } },
      ],
      parent: [{ id: COURSE_IRI, definition: COURSE_DEF }],
      grouping: [{ id: COURSE_IRI }],
    },
    extensions: {
      [`${FOXXI_NS}session`]: params.registration,
      [`${FOXXI_NS}player`]: 'foxxi-scorm-player-v1',
      ...extraExt,
    },
  };
}

async function emit(stmt) {
  // Stamp every emitted statement with an xAPI 2.0 envelope:
  //   - id MUST be a UUID v4 (xAPI 2.0 §4.1.1)
  //   - version SHOULD declare the spec level the statement was authored against
  //   - actor.objectType is already 'Agent' in actor()
  const enriched = { id: crypto.randomUUID(), version: '2.0.0', ...stmt };
  // No bearer = no point round-tripping to the LRS just to collect a 401.
  // The bridge requires auth on every /xapi/* resource (xAPI 2.0 §6.4), so
  // an anonymous player can only log statements locally.
  if (!params.bearer) {
    logTrace(`<span class="verb">${enriched.verb.display.en}</span> · <em>not emitted (no session)</em>`);
    return enriched.id;
  }
  const headers = { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0' };
  headers['Authorization'] = `Bearer ${params.bearer}`;
  try {
    const r = await fetch(`${params.bridge}/xapi/statements`, {
      method: 'POST', headers, body: JSON.stringify(enriched),
    });
    if (!r.ok) {
      logTrace(`[${stmt.verb.display.en}] HTTP ${r.status} — ${await r.text().catch(() => '')}`, true);
      return null;
    }
    const ids = await r.json();
    logTrace(`<span class="verb">${enriched.verb.display.en}</span> → ${ids[0]?.slice(0, 8)}…`);
    return ids[0];
  } catch (err) {
    logTrace(`[${stmt.verb.display.en}] threw: ${err.message}`, true);
    return null;
  }
}

function logTrace(msg, isErr = false) {
  const li = document.createElement('li');
  if (isErr) li.classList.add('err');
  const ts = new Date().toISOString().slice(11, 19);
  li.innerHTML = `<span class="dim">${ts}</span> ${msg}`;
  const list = document.getElementById('trace-list');
  list.prepend(li);
  if (list.children.length > 30) list.removeChild(list.lastChild);
}

// ── Statement templates (Foxxi xAPI Profile) ───────────────────────

function statementLaunched() {
  return {
    actor: actor(),
    verb: { id: `${ADL}verbs/launched`, display: { en: 'launched' } },
    object: { objectType: 'Activity', id: COURSE_IRI, definition: COURSE_DEF },
    timestamp: new Date().toISOString(),
    context: baseContext({
      [`${CMI5_CAT}/launchMode`]: 'Normal',
      [`${FOXXI_NS}slideCount`]: SLIDES.length,
    }),
  };
}

function statementInitialized() {
  return {
    actor: actor(),
    verb: { id: `${ADL}verbs/initialized`, display: { en: 'initialized' } },
    object: { objectType: 'Activity', id: COURSE_IRI, definition: COURSE_DEF },
    timestamp: new Date().toISOString(),
    context: baseContext(),
  };
}

function statementSlideViewed(slide, index) {
  return {
    actor: actor(),
    verb: { id: `${ADL}verbs/experienced`, display: { en: 'experienced' } },
    object: {
      objectType: 'Activity',
      id: `${COURSE_IRI}#slide-${slide.id}`,
      definition: {
        name: { en: `${slide.scene}: ${slide.title}` },
        type: `${ADL}activities/lesson`,
        extensions: {
          [`${FOXXI_NS}sceneTitle`]: slide.scene,
          [`${FOXXI_NS}slideId`]: slide.id,
          [`${FOXXI_NS}sequenceIndex`]: index,
        },
      },
    },
    timestamp: new Date().toISOString(),
    context: baseContext({
      [`${FOXXI_NS}slideId`]: slide.id,
      [`${FOXXI_NS}sceneTitle`]: slide.scene,
    }),
    result: { duration: 'PT0M' },
  };
}

function statementSceneCompleted(sceneTitle, slidesInScene) {
  return {
    actor: actor(),
    verb: { id: `${FOXXI_NS}verbs/scene-completed`, display: { en: 'scene-completed' } },
    object: {
      objectType: 'Activity',
      id: `${COURSE_IRI}#scene-${encodeURIComponent(sceneTitle)}`,
      definition: {
        name: { en: sceneTitle },
        type: `${FOXXI_NS}activities/scene`,
        extensions: { [`${FOXXI_NS}slideIds`]: slidesInScene.map(s => s.id) },
      },
    },
    timestamp: new Date().toISOString(),
    context: baseContext({ [`${FOXXI_NS}sceneTitle`]: sceneTitle }),
  };
}

function statementCompleted(viewed) {
  const completion = viewed.size === SLIDES.length;
  return {
    actor: actor(),
    verb: { id: `${ADL}verbs/completed`, display: { en: 'completed' } },
    object: { objectType: 'Activity', id: COURSE_IRI, definition: COURSE_DEF },
    timestamp: new Date().toISOString(),
    context: baseContext({
      [`${FOXXI_NS}viewedCount`]: viewed.size,
      [`${FOXXI_NS}slideCount`]: SLIDES.length,
    }),
    result: {
      completion,
      success: completion,
      score: { scaled: viewed.size / SLIDES.length },
    },
  };
}

function statementPassed(score) {
  return {
    actor: actor(),
    verb: { id: `${ADL}verbs/passed`, display: { en: 'passed' } },
    object: { objectType: 'Activity', id: COURSE_IRI, definition: COURSE_DEF },
    timestamp: new Date().toISOString(),
    context: baseContext({ [`${FOXXI_NS}masteryThreshold`]: 0.7 }),
    result: { completion: true, success: true, score: { scaled: score } },
  };
}

function statementTerminated() {
  return {
    actor: actor(),
    verb: { id: `${ADL}verbs/terminated`, display: { en: 'terminated' } },
    object: { objectType: 'Activity', id: COURSE_IRI, definition: COURSE_DEF },
    timestamp: new Date().toISOString(),
    context: baseContext(),
  };
}

// ── State + DOM ────────────────────────────────────────────────────

const state = {
  current: 0,
  viewed: new Set(),
  scenesCompleted: new Set(),
  sceneEnterTimestamps: new Map(),
  slideEnterTimestamps: new Map(),
  completed: false,
};

function renderToc() {
  const toc = document.getElementById('toc');
  toc.innerHTML = '<h3>Contents</h3>';
  const scenes = [...new Set(SLIDES.map(s => s.scene))];
  for (const scene of scenes) {
    const div = document.createElement('div');
    div.className = 'scene';
    const slidesInScene = SLIDES.filter(s => s.scene === scene);
    div.innerHTML = `<div class="scene-title">${scene}</div><ul></ul>`;
    const ul = div.querySelector('ul');
    for (const s of slidesInScene) {
      const idx = SLIDES.indexOf(s);
      const li = document.createElement('li');
      li.textContent = s.title;
      if (state.viewed.has(idx)) li.classList.add('viewed');
      if (idx === state.current) li.classList.add('active');
      li.addEventListener('click', () => jumpTo(idx));
      ul.appendChild(li);
    }
    toc.appendChild(div);
  }
}

function renderStage() {
  const s = SLIDES[state.current];
  document.getElementById('slide-title').textContent = `${s.scene}: ${s.title}`;
  document.getElementById('meta').innerHTML = `<code>slide id: ${s.id}</code> · <code>file: ${s.file}</code>`;
  document.getElementById('slide-frame').src = `course/${s.file}`;
  document.getElementById('progress').textContent = `slide ${state.current + 1} of ${SLIDES.length} · viewed ${state.viewed.size}`;
  document.getElementById('btn-prev').disabled = state.current === 0;
  document.getElementById('btn-next').disabled = state.current === SLIDES.length - 1;
  document.getElementById('btn-complete').disabled = state.viewed.size < SLIDES.length || state.completed;
}

async function jumpTo(idx) {
  if (idx < 0 || idx >= SLIDES.length || idx === state.current) return;
  const prevScene = SLIDES[state.current]?.scene;
  state.current = idx;
  const slide = SLIDES[idx];
  if (!state.viewed.has(idx)) {
    state.viewed.add(idx);
    state.slideEnterTimestamps.set(idx, Date.now());
    await emit(statementSlideViewed(slide, idx));
  }
  // Scene-completed check: emit when all slides of the previous scene are now viewed
  if (prevScene && prevScene !== slide.scene) {
    const prevSceneSlides = SLIDES.filter(s => s.scene === prevScene);
    const allViewed = prevSceneSlides.every(s => state.viewed.has(SLIDES.indexOf(s)));
    if (allViewed && !state.scenesCompleted.has(prevScene)) {
      state.scenesCompleted.add(prevScene);
      await emit(statementSceneCompleted(prevScene, prevSceneSlides));
    }
  }
  renderToc();
  renderStage();
}

/**
 * Out-of-band auth handoff. A `code` param means the dashboard kept the
 * long-lived session bearer out of the URL and handed us a short-lived
 * single-use code instead. POST it to the bridge's exchange endpoint to
 * obtain the real bearer. No-op when a `bearer` was supplied directly
 * (stand-alone testing) or when neither is present (anonymous render).
 */
async function resolveBearer() {
  if (params.bearer || !params.code) return;
  try {
    const r = await fetch(
      `${params.bridge}/api/foxxi/v1/launch-codes/${encodeURIComponent(params.code)}`,
      { method: 'POST' },
    );
    if (!r.ok) {
      logTrace(`launch-code exchange → HTTP ${r.status} (${await r.text().catch(() => '')})`, true);
      return;
    }
    const j = await r.json();
    if (j && j.bearer) {
      params.bearer = j.bearer;
      window.__foxxiPlayerConfig.bearer = j.bearer;
      logTrace('launch-code exchanged → session bearer acquired');
    }
  } catch (err) {
    logTrace(`launch-code exchange threw: ${err.message}`, true);
  }
}

async function init() {
  // Out-of-band auth: swap the one-time code for the session bearer
  // before anything that needs auth (chip render, statement emission).
  await resolveBearer();
  // Render learner chip
  const chip = document.getElementById('learner-chip');
  if (params.bearer) {
    chip.innerHTML = `${params.learnerName} <span class="dim">·</span> <code>${params.learnerDid.slice(0, 60)}…</code>`;
  } else {
    chip.innerHTML = `<span class="dim" style="color:var(--warn);">⚠ no session — open from dashboard ▶ Launch button. Statements will NOT post to LRS.</span>`;
  }
  renderToc();
  renderStage();
  // Emit launched + initialized + first slide-viewed
  await emit(statementLaunched());
  await emit(statementInitialized());
  state.viewed.add(0);
  await emit(statementSlideViewed(SLIDES[0], 0));
  renderToc();
  renderStage();
}

document.getElementById('btn-prev').addEventListener('click', () => jumpTo(state.current - 1));
document.getElementById('btn-next').addEventListener('click', () => jumpTo(state.current + 1));
document.getElementById('btn-complete').addEventListener('click', async () => {
  if (state.completed) return;
  state.completed = true;
  // Emit any unfired scene-completed for the final scene
  const finalScene = SLIDES[state.current].scene;
  const finalSceneSlides = SLIDES.filter(s => s.scene === finalScene);
  if (!state.scenesCompleted.has(finalScene)
      && finalSceneSlides.every(s => state.viewed.has(SLIDES.indexOf(s)))) {
    state.scenesCompleted.add(finalScene);
    await emit(statementSceneCompleted(finalScene, finalSceneSlides));
  }
  await emit(statementCompleted(state.viewed));
  await emit(statementPassed(state.viewed.size / SLIDES.length));
  document.getElementById('btn-complete').textContent = '✓ Completed';
  document.getElementById('btn-complete').disabled = true;
});

window.addEventListener('beforeunload', () => {
  // Best-effort terminated; sync XHR no longer works in modern browsers.
  // We use sendBeacon with the bearer in the body for unauthenticated channel.
  if (!state.completed) {
    const stmt = statementTerminated();
    const blob = new Blob([JSON.stringify(stmt)], { type: 'application/json' });
    try { navigator.sendBeacon(`${params.bridge}/xapi/statements?_beacon=1`, blob); } catch { /* ignore */ }
  }
});

init().catch(err => logTrace(`init failed: ${err.message}`, true));
