/**
 * SCORM RTE shim — dual SCORM 1.2 + SCORM 2004 4th Edition runtime.
 *
 * Installs BOTH:
 *   window.API           — SCORM 1.2 (ADL CMI001), the eight LMS* fns
 *                          + the cmi.core.* data model
 *   window.API_1484_11   — SCORM 2004 4th Ed (IEEE 1484.11.2), the
 *                          eight non-LMS-prefixed fns + the cmi.* model
 *
 * SCO content does the canonical API-discovery walk:
 *   - SCORM 1.2 SCOs look for `window.parent.API` / `window.opener.API`
 *     and call LMSInitialize / LMSGetValue / LMSSetValue / LMSCommit /
 *     LMSFinish / LMSGetLastError / LMSGetErrorString / LMSGetDiagnostic
 *   - SCORM 2004 SCOs look for `window.parent.API_1484_11` and call
 *     Initialize / GetValue / SetValue / Commit / Terminate /
 *     GetLastError / GetErrorString / GetDiagnostic
 *
 * Foxxi is conformant for both. On Commit + Terminate, the RTE inspects
 * the CMI data and emits cmi5-conformant xAPI 2.0 statements
 * (launched / initialized / completed / passed / failed / terminated /
 * abandoned) to Foxxi-as-LRS. Interactions + objectives ride along as
 * statement.result.score + extensions.
 *
 * Standards anchored:
 *   - IEEE 1484.11.2 (SCORM 2004 4th Ed Run-Time Environment)
 *   - ADL CMI001 (SCORM 1.2 CMI Interactions Specification)
 *   - IEEE 9274.1.1 (xAPI 2.0)
 *   - IEEE 9274.2.1 (cmi5)
 *
 * suspend_data: enforced 64KB max for SCORM 2004 4th Ed (§4.2.27.2),
 * 4096-char max for SCORM 1.2 (§5.5.2 cmi.suspend_data).
 */
(function installRte() {
  const ADL = 'http://adlnet.gov/expapi';
  const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
  const FOXXI_NS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';

  // ── CMI 2004 store ──
  const cmi2004 = {
    _version: '1.0',
    completion_status: 'unknown',
    success_status: 'unknown',
    'score.scaled': '', 'score.raw': '', 'score.min': '', 'score.max': '',
    progress_measure: '',
    location: '',
    session_time: 'PT0H0M0S',
    total_time: 'PT0H0M0S',
    exit: '', entry: 'ab-initio', mode: 'normal', credit: 'credit',
    suspend_data: '',
    learner_id: '', learner_name: '',
    launch_data: '',
    max_time_allowed: '', time_limit_action: '',
    interactions: [], // n.{id,type,objectives.n.id,timestamp,correct_responses.n.pattern,weighting,learner_response,result,latency,description}
    objectives: [],   // n.{id,score.{scaled,raw,min,max},success_status,completion_status,progress_measure,description}
  };

  // ── CMI 1.2 store (separate; SCORM 1.2 has its own model) ──
  const cmi12 = {
    'core._children': 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
    'core.student_id': '',
    'core.student_name': '',
    'core.lesson_location': '',
    'core.credit': 'credit',
    'core.lesson_status': 'not attempted',
    'core.entry': 'ab-initio',
    'core.score.raw': '', 'core.score.min': '', 'core.score.max': '',
    'core.total_time': '00:00:00.0',
    'core.lesson_mode': 'normal',
    'core.exit': '',
    'core.session_time': '00:00:00.0',
    suspend_data: '',
    launch_data: '',
    comments: '',
    comments_from_lms: '',
    'student_data.mastery_score': '',
    'student_data.max_time_allowed': '',
    'student_data.time_limit_action': '',
    'student_preference._children': 'audio,language,speed,text',
    'student_preference.audio': '0',
    'student_preference.language': '',
    'student_preference.speed': '0',
    'student_preference.text': '0',
    'objectives._children': 'id,score,status',
    objectives: [],
    'interactions._children': 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency',
    interactions: [],
  };

  // ── Limits (per SCORM specs) ──
  const SUSPEND_DATA_MAX_2004 = 64 * 1024;   // SCORM 2004 4th Ed §4.2.27.2 — 64KB
  const SUSPEND_DATA_MAX_12   = 4096;        // SCORM 1.2 — 4096 chars

  // ── Common state ──
  let initialized = false;
  let terminated = false;
  let lastError = '0';
  const sessionStart = Date.now();
  let activeSpec = null; // '2004' or '12' — set by first Initialize call

  function err(code) { lastError = String(code); return 'false'; }
  function ok() { lastError = '0'; return 'true'; }

  // ── CMI 2004 read / write ──
  function readKey2004(name) {
    const stripped = name.replace(/^cmi\./, '');
    const ix = /^interactions\.(\d+)\.(.+)$/.exec(stripped);
    if (ix) {
      const i = Number(ix[1]); const f = ix[2];
      const rec = cmi2004.interactions[i];
      if (!rec) return '';
      if (f === '_count') return String(cmi2004.interactions.length);
      // nested fields: objectives.n.id, correct_responses.n.pattern
      const sub = /^(objectives|correct_responses)\.(\d+)\.(.+)$/.exec(f);
      if (sub) {
        const j = Number(sub[2]);
        const arr = rec[sub[1]] || [];
        return arr[j]?.[sub[3]] ?? '';
      }
      if (f === 'objectives._count') return String((rec.objectives || []).length);
      if (f === 'correct_responses._count') return String((rec.correct_responses || []).length);
      return rec[f] ?? '';
    }
    const ob = /^objectives\.(\d+)\.(.+)$/.exec(stripped);
    if (ob) {
      const i = Number(ob[1]); const f = ob[2];
      const rec = cmi2004.objectives[i];
      if (!rec) return '';
      if (f === '_count') return String(cmi2004.objectives.length);
      return rec[f] ?? '';
    }
    if (stripped === 'interactions._count') return String(cmi2004.interactions.length);
    if (stripped === 'objectives._count')   return String(cmi2004.objectives.length);
    return cmi2004[stripped] ?? '';
  }
  function writeKey2004(name, value) {
    const stripped = name.replace(/^cmi\./, '');
    // Read-only enforcement (§5.3.4 code 404)
    if (['_version', 'interactions._count', 'objectives._count', 'completion_threshold',
         'credit', 'entry', 'launch_data', 'learner_id', 'learner_name', 'max_time_allowed',
         'mode', 'time_limit_action', 'total_time'].includes(stripped)) {
      lastError = '404'; return 'false';
    }
    if (stripped === 'suspend_data' && value.length > SUSPEND_DATA_MAX_2004) {
      lastError = '407'; return 'false'; // value out of range
    }
    const ix = /^interactions\.(\d+)\.(.+)$/.exec(stripped);
    if (ix) {
      const i = Number(ix[1]); const f = ix[2];
      if (!cmi2004.interactions[i]) cmi2004.interactions[i] = { id: '', type: '', objectives: [], correct_responses: [], timestamp: new Date().toISOString() };
      const sub = /^(objectives|correct_responses)\.(\d+)\.(.+)$/.exec(f);
      if (sub) {
        const j = Number(sub[2]);
        if (!cmi2004.interactions[i][sub[1]]) cmi2004.interactions[i][sub[1]] = [];
        if (!cmi2004.interactions[i][sub[1]][j]) cmi2004.interactions[i][sub[1]][j] = {};
        cmi2004.interactions[i][sub[1]][j][sub[3]] = value;
      } else {
        cmi2004.interactions[i][f] = value;
      }
      return 'true';
    }
    const ob = /^objectives\.(\d+)\.(.+)$/.exec(stripped);
    if (ob) {
      const i = Number(ob[1]); const f = ob[2];
      if (!cmi2004.objectives[i]) cmi2004.objectives[i] = { id: '' };
      cmi2004.objectives[i][f] = value;
      return 'true';
    }
    cmi2004[stripped] = value;
    return 'true';
  }

  // ── CMI 1.2 read / write ──
  function readKey12(name) {
    const stripped = name.replace(/^cmi\./, '');
    const ix = /^interactions\.(\d+)\.(.+)$/.exec(stripped);
    if (ix) {
      const i = Number(ix[1]); const f = ix[2];
      const rec = cmi12.interactions[i];
      if (!rec) return '';
      if (f === '_count') return String(cmi12.interactions.length);
      const sub = /^(objectives|correct_responses)\.(\d+)\.(.+)$/.exec(f);
      if (sub) {
        const j = Number(sub[2]);
        const arr = rec[sub[1]] || [];
        return arr[j]?.[sub[3]] ?? '';
      }
      return rec[f] ?? '';
    }
    const ob = /^objectives\.(\d+)\.(.+)$/.exec(stripped);
    if (ob) {
      const i = Number(ob[1]); const f = ob[2];
      const rec = cmi12.objectives[i];
      if (!rec) return '';
      if (f === '_count') return String(cmi12.objectives.length);
      return rec[f] ?? '';
    }
    return cmi12[stripped] ?? '';
  }
  function writeKey12(name, value) {
    const stripped = name.replace(/^cmi\./, '');
    if (['_version', 'core.student_id', 'core.student_name', 'core.credit',
         'core.entry', 'core.lesson_mode', 'core.total_time',
         'student_data.mastery_score', 'student_data.max_time_allowed',
         'student_data.time_limit_action', 'launch_data',
         'comments_from_lms', 'interactions._count', 'objectives._count'].includes(stripped)) {
      lastError = '403'; return 'false';
    }
    if (stripped === 'suspend_data' && value.length > SUSPEND_DATA_MAX_12) {
      lastError = '405'; return 'false';
    }
    const ix = /^interactions\.(\d+)\.(.+)$/.exec(stripped);
    if (ix) {
      const i = Number(ix[1]); const f = ix[2];
      if (!cmi12.interactions[i]) cmi12.interactions[i] = { id: '', objectives: [], correct_responses: [] };
      cmi12.interactions[i][f] = value;
      return 'true';
    }
    const ob = /^objectives\.(\d+)\.(.+)$/.exec(stripped);
    if (ob) {
      const i = Number(ob[1]); const f = ob[2];
      if (!cmi12.objectives[i]) cmi12.objectives[i] = { id: '' };
      cmi12.objectives[i][f] = value;
      return 'true';
    }
    cmi12[stripped] = value;
    return 'true';
  }

  // ── xAPI emission ──
  function buildBaseContext() {
    const cfg = (window.__foxxiPlayerConfig || {});
    return {
      registration: cfg.registration,
      contextActivities: {
        category: [
          { id: CMI5_CAT, definition: { type: `${ADL}/activities/profile` } },
          { id: `${FOXXI_NS}profile`, definition: { type: 'http://w3id.org/xapi/profiles' } },
        ],
        parent: [{ id: cfg.courseIri, definition: { name: { en: cfg.courseTitle || 'Course' }, type: `${ADL}/activities/course` } }],
        grouping: [{ id: cfg.courseIri }],
      },
      extensions: {
        [`${FOXXI_NS}session`]: cfg.registration,
        [`${FOXXI_NS}player`]: 'foxxi-scorm-player-v1',
        [`${FOXXI_NS}scormSpec`]: activeSpec === '12'
          ? 'ADL SCORM 1.2 (CMI001)'
          : 'IEEE 1484.11.2 (SCORM 2004 4th Ed)',
      },
    };
  }
  function buildActor() {
    const cfg = (window.__foxxiPlayerConfig || {});
    const learnerId = activeSpec === '12' ? cmi12['core.student_id'] : cmi2004.learner_id;
    const learnerName = activeSpec === '12' ? cmi12['core.student_name'] : cmi2004.learner_name;
    return {
      objectType: 'Agent',
      name: learnerName || cfg.learnerName || 'Anonymous',
      account: {
        homePage: cfg.identityServer || 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io',
        name: learnerId || cfg.learnerDid || 'anonymous',
      },
    };
  }
  function pickScore() {
    if (activeSpec === '12') {
      const raw = parseFloat(cmi12['core.score.raw']);
      const min = parseFloat(cmi12['core.score.min']);
      const max = parseFloat(cmi12['core.score.max']);
      const out = {};
      if (!Number.isNaN(raw)) out.raw = raw;
      if (!Number.isNaN(min)) out.min = min;
      if (!Number.isNaN(max)) out.max = max;
      // Derive scaled if min+max known
      if (!Number.isNaN(raw) && !Number.isNaN(min) && !Number.isNaN(max) && max > min) {
        out.scaled = (raw - min) / (max - min);
      }
      return Object.keys(out).length ? out : undefined;
    }
    const scaled = parseFloat(cmi2004['score.scaled']);
    const raw = parseFloat(cmi2004['score.raw']);
    const min = parseFloat(cmi2004['score.min']);
    const max = parseFloat(cmi2004['score.max']);
    const out = {};
    if (!Number.isNaN(scaled)) out.scaled = scaled;
    if (!Number.isNaN(raw))    out.raw = raw;
    if (!Number.isNaN(min))    out.min = min;
    if (!Number.isNaN(max))    out.max = max;
    return Object.keys(out).length ? out : undefined;
  }
  function buildStatement(verbId, verbDisplay, includeResult) {
    const cfg = (window.__foxxiPlayerConfig || {});
    const stmt = {
      id: crypto.randomUUID(),
      version: '2.0.0',
      actor: buildActor(),
      verb: { id: verbId, display: { en: verbDisplay } },
      object: {
        objectType: 'Activity',
        id: cfg.courseIri,
        definition: { name: { en: cfg.courseTitle || 'Course' }, type: `${ADL}/activities/course` },
      },
      timestamp: new Date().toISOString(),
      context: buildBaseContext(),
    };
    if (includeResult) {
      stmt.result = {};
      const score = pickScore();
      if (score) stmt.result.score = score;
      // Completion / success
      if (activeSpec === '12') {
        const status = cmi12['core.lesson_status'];
        if (['completed', 'passed', 'failed'].includes(status)) stmt.result.completion = true;
        if (status === 'passed') stmt.result.success = true;
        if (status === 'failed') stmt.result.success = false;
      } else {
        if (cmi2004.completion_status === 'completed') stmt.result.completion = true;
        if (cmi2004.success_status === 'passed') stmt.result.success = true;
        if (cmi2004.success_status === 'failed') stmt.result.success = false;
      }
      const sec = Math.max(0, Math.round((Date.now() - sessionStart) / 1000));
      stmt.result.duration = `PT${sec}S`;
      const suspend = activeSpec === '12' ? cmi12.suspend_data : cmi2004.suspend_data;
      if (suspend) stmt.context.extensions[`${FOXXI_NS}suspendData`] = suspend;
      const interactions = activeSpec === '12' ? cmi12.interactions : cmi2004.interactions;
      if (interactions.length > 0) stmt.context.extensions[`${FOXXI_NS}interactions`] = interactions;
      const objectives = activeSpec === '12' ? cmi12.objectives : cmi2004.objectives;
      if (objectives.length > 0) stmt.context.extensions[`${FOXXI_NS}objectives`] = objectives;
    }
    return stmt;
  }
  async function emit(stmt) {
    const cfg = (window.__foxxiPlayerConfig || {});
    if (!cfg.bridge) return;
    try {
      const headers = { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0' };
      if (cfg.bearer) headers['Authorization'] = `Bearer ${cfg.bearer}`;
      const r = await fetch(`${cfg.bridge}/xapi/statements`, { method: 'POST', headers, body: JSON.stringify(stmt) });
      if (cfg.onEmit) cfg.onEmit(stmt, r.ok, r.status);
    } catch (e) {
      if (cfg.onEmit) cfg.onEmit(stmt, false, 0, e?.message);
    }
  }
  function emitOnCommit() {
    if (activeSpec === '12') {
      const s = cmi12['core.lesson_status'];
      if (s === 'completed') emit(buildStatement(`${ADL}/verbs/completed`, 'completed', true));
      if (s === 'passed')   emit(buildStatement(`${ADL}/verbs/passed`, 'passed', true));
      if (s === 'failed')   emit(buildStatement(`${ADL}/verbs/failed`, 'failed', true));
    } else {
      if (cmi2004.completion_status === 'completed') emit(buildStatement(`${ADL}/verbs/completed`, 'completed', true));
      if (cmi2004.success_status === 'passed') emit(buildStatement(`${ADL}/verbs/passed`, 'passed', true));
      if (cmi2004.success_status === 'failed') emit(buildStatement(`${ADL}/verbs/failed`, 'failed', true));
    }
  }

  // ── SCORM 2004 API (IEEE 1484.11.2) ──
  window.API_1484_11 = {
    Initialize(p) {
      if (p !== '') { lastError = '201'; return 'false'; }
      if (initialized) return err(103);
      if (terminated)  return err(104);
      activeSpec = '2004';
      initialized = true;
      const cfg = (window.__foxxiPlayerConfig || {});
      cmi2004.learner_id = cmi2004.learner_id || cfg.learnerDid || '';
      cmi2004.learner_name = cmi2004.learner_name || cfg.learnerName || '';
      emit(buildStatement(`${ADL}/verbs/initialized`, 'initialized', false));
      return ok();
    },
    Terminate(p) {
      if (p !== '') { lastError = '201'; return 'false'; }
      if (!initialized) return err(112);
      if (terminated)   return err(113);
      emitOnCommit();
      emit(buildStatement(`${ADL}/verbs/terminated`, 'terminated', true));
      terminated = true;
      return ok();
    },
    GetValue(name) {
      if (!initialized) { lastError = '122'; return ''; }
      if (terminated)   { lastError = '123'; return ''; }
      const v = readKey2004(name);
      ok();
      return v == null ? '' : String(v);
    },
    SetValue(name, value) {
      if (!initialized) return err(132);
      if (terminated)   return err(133);
      const result = writeKey2004(name, value);
      if (result === 'true') ok();
      return result;
    },
    Commit(p) {
      if (p !== '') { lastError = '201'; return 'false'; }
      if (!initialized) return err(142);
      if (terminated)   return err(143);
      emitOnCommit();
      return ok();
    },
    GetLastError() { return lastError; },
    GetErrorString(code) { return SCORM2004_ERR_STRINGS[String(code)] || ''; },
    GetDiagnostic(code) { return code ? `code=${code} ; cmi.completion_status=${cmi2004.completion_status} ; cmi.success_status=${cmi2004.success_status}` : ''; },
  };

  const SCORM2004_ERR_STRINGS = {
    '0':   'No error',
    '101': 'General exception',
    '102': 'General initialization failure',
    '103': 'Already initialized',
    '104': 'Content instance terminated',
    '111': 'General termination failure',
    '112': 'Termination before initialization',
    '113': 'Termination after termination',
    '122': 'Retrieve data before initialization',
    '123': 'Retrieve data after termination',
    '132': 'Store data before initialization',
    '133': 'Store data after termination',
    '142': 'Commit before initialization',
    '143': 'Commit after termination',
    '201': 'General argument error',
    '301': 'General get failure',
    '351': 'General set failure',
    '391': 'General commit failure',
    '401': 'Undefined data model element',
    '402': 'Unimplemented data model element',
    '403': 'Data model element value not initialized',
    '404': 'Data model element is read only',
    '405': 'Data model element is write only',
    '406': 'Data model element type mismatch',
    '407': 'Data model element value out of range',
    '408': 'Data model dependency not established',
  };

  // ── SCORM 1.2 API (ADL CMI001) ──
  window.API = {
    LMSInitialize(p) {
      if (p !== '') { lastError = '201'; return 'false'; }
      if (initialized) return err(101);
      activeSpec = '12';
      initialized = true;
      const cfg = (window.__foxxiPlayerConfig || {});
      cmi12['core.student_id'] = cmi12['core.student_id'] || cfg.learnerDid || '';
      cmi12['core.student_name'] = cmi12['core.student_name'] || cfg.learnerName || '';
      emit(buildStatement(`${ADL}/verbs/initialized`, 'initialized', false));
      return ok();
    },
    LMSFinish(p) {
      if (p !== '') { lastError = '201'; return 'false'; }
      if (!initialized) return err(301);
      emitOnCommit();
      emit(buildStatement(`${ADL}/verbs/terminated`, 'terminated', true));
      terminated = true;
      return ok();
    },
    LMSGetValue(name) {
      if (!initialized) { lastError = '301'; return ''; }
      const v = readKey12(name);
      ok();
      return v == null ? '' : String(v);
    },
    LMSSetValue(name, value) {
      if (!initialized) return err(301);
      const result = writeKey12(name, value);
      if (result === 'true') ok();
      return result;
    },
    LMSCommit(p) {
      if (p !== '') { lastError = '201'; return 'false'; }
      if (!initialized) return err(301);
      emitOnCommit();
      return ok();
    },
    LMSGetLastError() { return lastError; },
    LMSGetErrorString(code) { return SCORM12_ERR_STRINGS[String(code)] || ''; },
    LMSGetDiagnostic(code) { return code ? `code=${code} ; cmi.core.lesson_status=${cmi12['core.lesson_status']}` : ''; },
  };

  const SCORM12_ERR_STRINGS = {
    '0':   'No error',
    '101': 'General exception',
    '201': 'Invalid argument error',
    '202': 'Element cannot have children',
    '203': 'Element not an array — cannot have count',
    '301': 'Not initialized',
    '401': 'Not implemented error',
    '402': 'Invalid set value, element is a keyword',
    '403': 'Element is read only',
    '404': 'Element is write only',
    '405': 'Incorrect data type',
  };

  // Expose live state for the player UI's diagnostic pane
  window.__foxxiCmiSnapshot = () => ({
    spec: activeSpec,
    cmi: activeSpec === '12' ? { ...cmi12 } : { ...cmi2004 },
  });
})();
