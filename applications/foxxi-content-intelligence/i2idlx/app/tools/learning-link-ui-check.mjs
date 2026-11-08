// Render the actual learning hook/panel with synthetic provider replies. No browser or live model.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createLearningClient, createLearningLauncher, selectedLearningPacket } from '../src/learning-client.js';

const source = (await readFile(new URL('../src/learning-context.jsx', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export function useLearningContext', 'function useLearningContext');
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
const expires = '2099-01-01T00:00:00.000Z', linkId = 'a'.repeat(32), courseId = 'alice-course';
const courseTitle = 'Alice enrolled safety';
const changed = (before, next) => !before || !next || before.length !== next.length || before.some((value, i) => !Object.is(value, next[i]));
const text = node => Array.isArray(node) ? node.map(text).join('') : node == null || typeof node === 'boolean' ? '' : typeof node === 'object' ? text(node.props.children) : String(node);
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !node || typeof node !== 'object' ? [] : [node, ...nodes(node.props.children)];

function fixture({ signedOut = false } = {}) {
  const values = [], refs = [], effects = [], pendingEffects = [], calls = [], modelCalls = [];
  const intervals = new Map(), visibilityListeners = new Set(); let timerSerial = 0;
  const document = { visibilityState: 'visible', addEventListener: (_event, listener) => visibilityListeners.add(listener), removeEventListener: (_event, listener) => visibilityListeners.delete(listener) };
  let stateCursor = 0, refCursor = 0, effectCursor = 0, dirty = false, controller, generation = 0, history = [];
  const provider = { status: 'active', missing: false, refusal: null, contentStatus: 'readable', reviewStatus: 'available', reviewSubmission: 'completed', progressCompletion: 'COMPLETED', connectors: [], map: null, readinessMap: null,
    notificationAvailable: false, notificationEnabled: false, notificationReceivedAt: null };
  const reviewStatus = () => ({ status: provider.reviewStatus, count: provider.reviewStatus === 'available' ? 1 : 0,
    reason: provider.reviewStatus === 'available' ? 'Released completed provider result' : 'The owner has not released this review.' });
  const reviewResult = () => ({ ...reviewStatus(), observed_at: expires, records: provider.reviewStatus === 'available' ? [{
    citation_id: 'QUIZ1', activity_id: 'quiz-sco', interaction_id: 'record-code', question_label: 'Which code should you record?',
    learner_response: 'B', learner_response_label: 'GREEN-12', result: 'incorrect', observed_at: expires,
    ...(provider.reviewSubmission ? { submission: provider.reviewSubmission } : {}),
    locations: [{ id: 'incident', label: 'Incident recording', source_file: 'incident.html' }] }] : [] });
  const readiness = () => ({ course_id: courseId, version: 3, checked_at: expires,
    enrollment: { status: 'verified', observed_at: expires }, content: { status: provider.contentStatus }, quiz_review: reviewStatus(),
    launch: { kind: 'course', reason: 'No verified multi-SCO target is available.' },
    learning_map: provider.readinessMap || { status: 'unavailable', provider_prerequisites: 'unavailable', objectives: [], prerequisites: [] },
    retention: { mode: 'virtual', cached_bytes: 0, course_text_retained: false } });
  const link = () => ({ id: linkId, connector_id: 'c'.repeat(32), provider_label: 'Fixture learning provider', status: provider.status });
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const client = createLearningClient({ origin: () => 'https://workbench.example', fetch: async (path, init) => {
    if (path === '/i2idlx/learning/session') return response({ enabled: true, authenticated: !signedOut,
      account: signedOut ? null : { id: 'did:example:alice', userId: 'alice', webId: 'https://identity.example/alice' },
      csrf: signedOut ? null : 'private-fixture-csrf', expires_at: signedOut ? null : expires, sign_in_url: '/i2idlx/learning/oauth/start' });
    assert.equal(path, '/i2idlx/api/learning');
    const args = JSON.parse(init.body); calls.push(args);
    if (args.operation === 'my-links') return response({ links: provider.missing ? [] : [link()] });
    if (provider.refusal) return response({ code: provider.refusal }, 403);
    if (args.operation === 'courses') return response({ link_id: linkId, courses: [{ id: courseId, title: courseTitle, version: 3 }],
      prerequisites: { status: 'unavailable' }, curriculum: { status: 'unavailable' } });
    if (args.operation === 'course-readiness') return response({ link_id: linkId, course_id: courseId, version: 3, readiness: readiness() });
    if (args.operation === 'quiz-review') return response({ link_id: linkId, course_id: courseId, version: 3, quiz_review: reviewResult() });
    if (args.operation === 'owned-connectors') return response({ connectors: provider.connectors });
    if (args.operation === 'create-connector') {
      const connector = { id: 'c'.repeat(32), label: args.label, status: 'active', policy: args.policy, join_code: 'd'.repeat(48) };
      provider.connectors = [connector]; return response({ connector });
    }
    if (args.operation === 'set-review-policy') {
      provider.connectors = provider.connectors.map(connector => ({ ...connector, policy: { ...connector.policy, allowAiReview: args.allowAiReview } }));
      return response({ connector: provider.connectors[0] });
    }
    if (args.operation === 'set-notification-policy') {
      provider.notificationAvailable = args.allowProgressNotifications;
      provider.connectors = provider.connectors.map(connector => ({ ...connector, policy: { ...connector.policy, allowProgressNotifications: args.allowProgressNotifications } }));
      return response({ connector: provider.connectors[0] });
    }
    if (['progress-notification-status', 'enable-progress-notifications', 'disable-progress-notifications'].includes(args.operation)) {
      if (args.operation !== 'progress-notification-status') {
        assert.equal(args.confirmed, true); assert.equal(provider.notificationAvailable, true);
        provider.notificationEnabled = args.operation === 'enable-progress-notifications';
      }
      return response({ link_id: linkId, course_id: courseId, version: 3,
        notifications: { available: provider.notificationAvailable, enabled: provider.notificationEnabled,
          ...(provider.notificationReceivedAt ? { last_received_at: provider.notificationReceivedAt } : {}),
          notice: 'Synthetic authenticated provider signal only; refresh reads current progress.' } });
    }
    if (args.operation === 'owned-courses') return response({ courses: [{ id: courseId, title: courseTitle, version: 3 }, { id: 'pre-course', title: 'Preparation', version: 1 }] });
    if (args.operation === 'get-course-map') return response({ course_map: provider.map });
    if (args.operation === 'preview-course-map') return response({ map: args.map, sha256: 'a'.repeat(64), valid: true });
    if (args.operation === 'save-course-map') {
      provider.map = { map: args.map, provenance: { kind: 'connector-owner-authored', owner: 'did:example:alice', connector_id: args.connector_id,
        saved_at: expires, revision: 'b'.repeat(32), sha256: 'a'.repeat(64) } };
      return response({ course_map: provider.map });
    }
    if (args.operation === 'delete-course-map') { provider.map = null; return response({ course_map: null, deleted: true }); }
    if (args.operation === 'progress') return response({ link_id: linkId, as_of: expires, records: [{ course_id: courseId,
      title: courseTitle, version: 3, completion: provider.progressCompletion, success: 'PASSED', score: 73, total_seconds: 90,
      source: 'SCORM Cloud', observed_at: expires }] });
    throw Error('Unimplemented fixture operation: ' + args.operation);
  } });
  const engine = { ctx: [], busy: false, captureGeneration: () => generation,
    reset() { generation++; history = []; },
    async send(question, _ids, packet) { modelCalls.push(packet); history.push(question, 'Private fixture answer.'); }, stop() {} };
  const agent = { state: 'connected', connectionId: 'fixture-agent', monitoring: 'ready' };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const i = stateCursor++;
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
      return [values[i], next => {
        const value = typeof next === 'function' ? next(values[i]) : next;
        if (!Object.is(value, values[i])) { values[i] = value; dirty = true; }
      }];
    },
    useRef(initial) { const i = refCursor++; return refs[i] || (refs[i] = { current: initial }); },
    useEffect(fn, deps) {
      const i = effectCursor++;
      if (!effects[i] || changed(effects[i].deps, deps)) pendingEffects.push(() => {
        effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() };
      });
    },
  };
  const hook = runInNewContext(compiled + '\nuseLearningContext;', {
    React, createLearningClient: () => client, createLearningLauncher, selectedLearningPacket,
    workbenchConnectionStatus: () => ({ agent }), subscribeAgentSession: listener => { listener(agent); return () => {}; },
    userCourseSample: () => () => {},
    crypto: { randomUUID: () => 'fixture-request-' + calls.length },
    learningContextRequest: async args => {
      if (provider.refusal) throw Object.assign(new Error('Fixture refusal'), { code: provider.refusal, status: 403 });
      return { source: { provider: 'scorm-cloud', course_id: courseId, version: 3, source_version: 'course-version:3' },
        access: { link_id: linkId, sharing: { content: args.share_content, progress: args.share_progress, review: args.share_review === true } },
        interventionContext: { source_context: { sections: [...(args.share_content ? [{ body: 'Private safety passage BLUE27.' }] : []),
          ...(args.share_progress ? [{ body: 'Own progress score 73.' }] : [])] }, ...(args.share_review ? { quiz_review: reviewResult() } : {}) },
        citations: [{ id: 'SC1', title: 'Private safety source' }], missing_context: [], authorization_ticket: 'e'.repeat(64) };
    },
    AbortController, TextEncoder, document, setTimeout: () => 0, clearTimeout() {},
    setInterval(fn, ms) { const id = ++timerSerial; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); },
  });
  function render() {
    for (let count = 0; count < 30; count++) {
      dirty = false; stateCursor = refCursor = effectCursor = 0;
      controller = hook(engine);
      for (const node of nodes(controller.panel)) {
        if (node.props.ref && typeof node.props.ref === 'object') node.props.ref.current ||= { value: '' };
        else if (typeof node.props.ref === 'function') node.props.ref({ value: '' });
      }
      pendingEffects.splice(0).forEach(effect => effect());
      if (!dirty) return;
    }
    throw Error('Hook did not settle after rendering.');
  }
  async function settle() {
    for (let count = 0; count < 30; count++) {
      await new Promise(resolve => setImmediate(resolve)); render();
      if (!controller.loading) return;
    }
    throw Error('Fixture request did not settle.');
  }
  const all = () => nodes(controller.panel);
  const button = name => {
    const found = all().find(node => node.type === 'button' && text(node) === name);
    assert.ok(found, 'Expected button: ' + name); return found;
  };
  async function click(name) { const node = button(name); assert.ok(!node.props.disabled, 'Button is disabled: ' + name); node.props.onClick(); render(); await settle(); }
  render();
  return { provider, render, settle, click, button, all, get controller() { return controller; }, calls, modelCalls,
    setVisibility(value) { document.visibilityState = value; for (const listener of visibilityListeners) listener(); },
    async pollNotifications() { const timer = [...intervals.values()].find(value => value.ms === 30_000); if (timer) { await timer.fn(); render(); await settle(); } },
    history: () => history, cleanup: () => effects.forEach(effect => effect.cleanup?.()) };
}

{
  const h = fixture({ signedOut: true }); await h.settle();
  try {
    assert.ok(text(h.controller.panel).includes('Connect your Interego learning account'));
    assert.equal(h.calls.length, 0); assert.equal(h.modelCalls.length, 0);
    process.stdout.write('PASS signed-out account with null identity renders the guided sign-in without a private request\n');
  } finally { h.cleanup(); }
}

{
  const h = fixture(); await h.settle();
  try {
    h.provider.connectors = [{ id: 'c'.repeat(32), label: 'Synthetic managed connection', status: 'active', policy: { allowAiContent: true, allowAiProgress: true, allowAiReview: true } }];
    await h.click('I manage courses'); await h.click('Show connections I manage'); await h.click('Load courses for this connection');
    change(h, 'Learning map course ' + 'c'.repeat(32), JSON.stringify([courseId, 3])); await h.settle();
    const suffix = 'c'.repeat(32);
    change(h, 'Learning map title ' + suffix, 'Owner supplied safety learning map');
    await h.click('Add instructional section'); change(h, 'Section name 0 ' + suffix, 'Incident recording'); change(h, 'Published section file 0 ' + suffix, 'incident.html');
    const section = JSON.parse(field(h, 'Learning map JSON ' + suffix).props.value).instructional_locations[0].id;
    await h.click('Add learning objective'); change(h, 'Objective label 0 ' + suffix, 'Record the incident correctly'); change(h, 'Objective section 0 ' + suffix, section);
    await h.click('Add prerequisite'); change(h, 'Prerequisite course 0 ' + suffix, JSON.stringify(['pre-course', 1])); change(h, 'Prerequisite relation 0 ' + suffix, 'required');
    change(h, 'Include course sequence ' + suffix, true); await h.click('Add course to sequence'); change(h, 'Sequence course 0 ' + suffix, JSON.stringify(['pre-course', 1]));
    await h.click('Add course to sequence'); change(h, 'Sequence course 1 ' + suffix, JSON.stringify([courseId, 3])); await h.click('Move course 2 up');
    change(h, 'Release completed or terminal quiz results ' + suffix, true); await h.click('Add released question mapping');
    change(h, 'Released question label 0 ' + suffix, 'Which code should you record?'); change(h, 'Released question section 0 ' + suffix, section);
    change(h, 'Review activity ID 0 ' + suffix, 'quiz-sco'); change(h, 'Review interaction ID 0 ' + suffix, 'record-code');
    await h.click('Add response label for question 1'); change(h, 'Response code 0 0 ' + suffix, 'B'); change(h, 'Response label 0 0 ' + suffix, 'GREEN-12');
    await h.click('Validate map preview'); change(h, 'Confirm learning map change ' + suffix, true); await h.click('Save this owner-supplied map');
    const saved = h.provider.map.map;
    assert.equal(saved.title, 'Owner supplied safety learning map'); assert.equal(saved.objectives[0].location_ids[0], section);
    assert.equal(saved.prerequisites[0].relation, 'required'); assert.deepEqual(saved.curriculum.sequence.map(item => item.course_id), [courseId, 'pre-course']);
    assert.equal(saved.review_items[0].response_labels[0].label, 'GREEN-12'); assert.equal(h.modelCalls.length, 0);
    assert.ok(text(h.controller.panel).includes('Advanced: edit map JSON'));
    for (const invalidDraft of [
      { ...saved, review_items: [null] },
      { ...saved, review_items: [{ ...saved.review_items[0], response_labels: {} }] },
      { ...saved, curriculum: { label: 'Invalid sequence', sequence: [null] } },
      { ...saved, instructional_locations: [{ ...saved.instructional_locations[0], label: { invalid: true } }] },
    ]) {
      change(h, 'Learning map JSON ' + suffix, JSON.stringify(invalidDraft));
      assert.ok(text(h.controller.panel).includes('The advanced draft cannot be shown in guided fields.'));
      assert.equal(h.button('Save this owner-supplied map').props.disabled, true);
    }
    await h.click('Reload saved map');
    assert.ok(h.all().some(node => node.props['data-testid'] === 'learning-map-guided-' + suffix));
    await h.click('I’m learning'); assert.ok(!h.all().some(node => node.props['aria-label'] === 'Review activity ID 0 ' + suffix));
    process.stdout.write('PASS guided map fields build objectives, prerequisite choice, curriculum order and released question mappings without editing JSON\n');
  } finally { h.cleanup(); }
}

async function selectedFixture() {
  const h = fixture(); await h.settle(); await h.click('Show my enrolled courses');
  h.all().find(node => node.props['aria-label'] === 'Your enrolled course').props.onChange({ target: { value: JSON.stringify([courseId, 3]) } }); h.render();
  await h.click('Check course readiness');
  h.all().find(node => node.props['aria-label'] === 'Share selected enrolled course passages with AI').props.onChange({ target: { checked: true } }); h.render();
  await h.click('Check my progress'); await h.controller.send('What is the safety code?'); h.render();
  assert.ok(h.all().some(node => node.props['data-testid'] === 'learner-progress'));
  assert.ok(h.all().some(node => node.props['data-testid'] === 'learner-citations'));
  assert.equal(h.modelCalls.length, 1); assert.equal(h.controller.blocked, false);
  return h;
}
async function assertClearedAndBlocked(h) {
  for (const id of ['learner-courses', 'learner-progress', 'learner-citations', 'learner-sharing']) {
    assert.ok(!h.all().some(node => node.props['data-testid'] === id), 'Stale private UI remains: ' + id);
  }
  assert.ok(!text(h.controller.panel).includes(courseTitle));
  assert.equal(h.controller.selected, null); assert.equal(h.controller.activeRef.current, true); assert.equal(h.controller.blocked, true);
  assert.equal(h.history().length, 0);
  await h.controller.send('A follow-up must not silently become a glossary question.'); h.render();
  assert.equal(h.modelCalls.length, 1, 'Ended private context must not reach a model or public fallback.');
}

{
  const h = await selectedFixture();
  try {
    await h.click('Refresh learning account');
    for (const id of ['learner-courses', 'learner-progress', 'learner-citations', 'learner-sharing']) {
      assert.ok(h.all().some(node => node.props['data-testid'] === id), 'Active refresh removed valid private UI: ' + id);
    }
    assert.equal(h.controller.selected.title, courseTitle); assert.equal(h.controller.blocked, false);
    assert.equal(h.history().length, 2);
    await h.controller.send('A still-authorized private follow-up.'); h.render();
    assert.equal(h.modelCalls.length, 2);
    process.stdout.write('PASS still-active refresh preserves the verified course and sharing context\n');
  } finally { h.cleanup(); }
}
for (const status of ['revoked', 'approved', 'pending-admin', 'missing']) {
  const h = await selectedFixture();
  try {
    if (status === 'missing') h.provider.missing = true; else h.provider.status = status;
    await h.click('Refresh learning account'); await assertClearedAndBlocked(h);
    process.stdout.write('PASS refreshed ' + status + ' link clears private UI and keeps source intent blocked\n');
  } finally { h.cleanup(); }
}
for (const refusal of ['learning_connection_revoked', 'learning_link_revoked', 'learning_link_not_found', 'learning_access_revoked']) {
  const h = await selectedFixture();
  try {
    h.provider.refusal = refusal;
    if (['learning_connection_revoked', 'learning_access_revoked'].includes(refusal)) { await h.controller.send('Try a stale private question.'); h.render(); }
    else await h.click('Check my progress');
    await assertClearedAndBlocked(h);
    assert.ok(!h.all().some(node => node.type === 'button' && text(node) === 'Show my enrolled courses'), 'Known invalid link must not be offered from cache.');
    process.stdout.write('PASS ' + refusal + ' clears cached enrollment UI before refresh\n');
  } finally { h.cleanup(); }
}

function field(h, name) {
  const found = h.all().find(node => node.props['aria-label'] === name);
  assert.ok(found, 'Expected field: ' + name); return found;
}
function change(h, name, value) { const node = field(h, name); assert.ok(!node.props.disabled, 'Disabled field: ' + name);
  node.props.onChange({ target: typeof value === 'boolean' ? { checked: value } : { value } }); h.render(); }

{
  const h = fixture(); await h.settle();
  try {
    assert.ok(text(h.controller.panel).includes('Your active learning account link is ready. Choose Show my enrolled courses.'));
    assert.ok(!text(h.controller.panel).includes('Actual SCORM Cloud registration ID'));
    assert.ok(!h.all().some(node => node.props['aria-label'] === 'Managed SCORM Cloud secret'));
    await h.click('I manage courses');
    assert.ok(h.all().some(node => node.props['aria-label'] === 'Managed SCORM Cloud secret'));
    assert.ok(!h.all().some(node => node.props['aria-label'] === 'Learning provider connection code'));
    await h.click('I’m learning');
    assert.ok(!h.all().some(node => node.props['aria-label'] === 'Managed SCORM Cloud secret'));
    process.stdout.write('PASS guided learner and owner journeys keep provider credentials and registration controls out of the learner view\n');
  } finally { h.cleanup(); }
}

{
  const h = fixture(); await h.settle();
  try {
    const steps = () => text(h.all().find(node => node.props['data-testid'] === 'learning-journey-steps'));
    await h.click('Show my enrolled courses');
    assert.ok(steps().includes('Learning account link is active.'));
    assert.ok(!steps().includes('Request a provider link'));
    change(h, 'Your enrolled course', JSON.stringify([courseId, 3]));
    assert.ok(steps().includes('Selected course: ' + courseTitle + '. Check course readiness.'));
    assert.equal(field(h, 'Share selected enrolled course passages with AI').props.disabled, true);
    assert.equal(field(h, 'Share my released quiz review with AI').props.disabled, true);
    assert.ok(text(h.controller.panel).includes('Content readability, released review and lesson-link support have not been confirmed'));
    await h.click('Check course readiness');
    assert.ok(steps().includes('Readiness checked '));
    assert.ok(!steps().includes('Choose one of your enrolled courses and check its readiness.'));
    assert.equal(field(h, 'Share selected enrolled course passages with AI').props.disabled, false);
    assert.equal(field(h, 'Share my released quiz review with AI').props.checked, false);
    h.provider.contentStatus = 'unavailable'; h.provider.reviewStatus = 'not-released';
    await h.click('Check course readiness'); await h.click('Check my progress');
    assert.equal(field(h, 'Share selected enrolled course passages with AI').props.disabled, true);
    assert.equal(field(h, 'Share my released quiz review with AI').props.disabled, true);
    assert.ok(text(h.controller.panel).includes('Completion: COMPLETED'));
    await h.controller.send('Do not infer released review from this score.'); h.render();
    assert.equal(h.modelCalls.length, 0);
    process.stdout.write('PASS readiness is unknown until checked and a completion/score never enables unreleased question review\n');
  } finally { h.cleanup(); }
}

{
  const h = fixture(); await h.settle();
  try {
    await h.click('Show my enrolled courses'); change(h, 'Your enrolled course', JSON.stringify([courseId, 3]));
    const choices = () => nodes(field(h, 'Your enrolled course')).filter(node => node.type === 'option').map(node => node.props.value);
    const beforeChoices = choices();
    h.provider.readinessMap = { status: 'owner-supplied', revision: 'a'.repeat(32), sha256: 'b'.repeat(64), saved_at: expires,
      provider_prerequisites: 'unavailable', objectives: [], prerequisites: [], curriculum: { label: 'Owner-supplied suggested order',
        sequence: [{ course_id: 'unenrolled-course', version: 0, label: 'Orientation practice' },
          { course_id: courseId, version: 3, label: 'Practice quiz and review' }] } };
    const ownerPanel = () => h.all().find(node => node.props['data-testid'] === 'learner-owner-map');
    await h.click('Check course readiness');
    assert.ok(text(ownerPanel()).includes('Orientation practice · Version 0'));
    assert.ok(text(ownerPanel()).includes('Practice quiz and review · Version 3'));
    assert.ok(!text(ownerPanel()).includes(courseTitle), 'An explicit owner label takes precedence over an enrolled catalog title.');
    assert.ok(text(ownerPanel()).includes('This is an owner-supplied sequence, not a provider-confirmed required curriculum.'));
    assert.deepEqual(choices(), beforeChoices, 'Owner-supplied references do not add enrolled course choices.');
    h.provider.readinessMap.curriculum.sequence = [{ course_id: courseId, version: 3 }]; await h.click('Check course readiness');
    assert.ok(text(ownerPanel()).includes(courseTitle + ' · Version 3'));
    h.provider.readinessMap.curriculum.sequence = [{ course_id: courseId, version: 2 }]; await h.click('Check course readiness');
    assert.ok(text(ownerPanel()).includes('Course title not supplied · Version 2'));
    assert.ok(!text(ownerPanel()).includes(courseTitle), 'A different course version cannot supply the fallback title.');
    const beforeCalls = h.calls.length;
    change(h, 'Your enrolled course', JSON.stringify(['unenrolled-course', 0]));
    assert.equal(h.controller.selected, null);
    await h.controller.send('Ask about the unenrolled owner reference.'); h.render();
    assert.equal(h.calls.length, beforeCalls); assert.equal(h.modelCalls.length, 0);
    assert.ok(!h.all().some(node => node.type === 'button' && text(node) === 'Open course'));
    process.stdout.write('PASS owner curriculum labels survive without enrollment and catalog fallback requires the exact course version\n');
  } finally { h.cleanup(); }
}

{
  const h = await selectedFixture();
  try {
    await h.click('Check my released quiz review');
    assert.ok(text(h.controller.panel).includes('Your recorded response: GREEN-12'));
    assert.ok(text(h.controller.panel).includes('Recorded result: incorrect'));
    assert.ok(text(h.controller.panel).includes('Provider reports this activity completed. This does not establish overall course completion.'));
    assert.equal(field(h, 'Share my released quiz review with AI').props.checked, false);
    assert.equal(h.modelCalls.length, 1, 'Viewing released results must not send them to AI.');
    change(h, 'Share selected enrolled course passages with AI', false);
    change(h, 'Share my released quiz review with AI', true);
    assert.equal(h.history().length, 0, 'Changing sharing scope clears the prior private conversation.');
    await h.controller.send('Help me understand my released result.'); h.render();
    assert.equal(h.modelCalls.length, 2);
    const shared = JSON.stringify(h.modelCalls.at(-1));
    assert.ok(shared.includes('GREEN-12') && shared.includes('incorrect'));
    assert.ok(!shared.includes('BLUE27') && !shared.includes('Own progress score'));
    h.provider.reviewStatus = 'not-authorized'; await h.click('Check course readiness');
    assert.equal(field(h, 'Share my released quiz review with AI').props.checked, false);
    assert.equal(field(h, 'Share my released quiz review with AI').props.disabled, true);
    assert.equal(h.history().length, 0);
    assert.ok(!h.all().some(node => node.props['data-testid'] === 'learner-citations'));
    process.stdout.write('PASS released review uses a separate unchecked AI opt-in, exact own result scope and immediate policy-change clearing\n');
  } finally { h.cleanup(); }
}

{
  const h = await selectedFixture();
  try {
    h.provider.reviewSubmission = 'terminal-lesson-status'; h.provider.progressCompletion = 'INCOMPLETE';
    await h.click('Check my progress'); await h.click('Check my released quiz review');
    assert.ok(text(h.controller.panel).includes('Completion: INCOMPLETE'));
    assert.ok(text(h.controller.panel).includes('Provider reports a terminal lesson status. This does not establish overall course completion.'));
    assert.ok(!text(h.controller.panel).includes('Provider reports this activity completed.'));
    assert.equal(field(h, 'Share my released quiz review with AI').props.checked, false);
    assert.equal(h.modelCalls.length, 1, 'Viewing terminal results must not implicitly share them.');
    h.provider.reviewSubmission = null; await h.click('Check my released quiz review');
    assert.ok(text(h.controller.panel).includes('Completion basis not supplied. Overall course completion is not established here.'));
    assert.ok(!text(h.controller.panel).includes('Provider reports this activity completed.'));
    assert.ok(!text(h.controller.panel).includes('Provider reports a terminal lesson status.'));
    process.stdout.write('PASS terminal and unspecified review bases never imply activity submission or overall course completion\n');
  } finally { h.cleanup(); }
}

{
  const h = fixture(); await h.settle();
  try {
    await h.click('I manage courses');
    assert.equal(field(h, 'Authorize released quiz review sharing').props.checked, false);
    field(h, 'Managed learning connection name').props.ref.current.value = 'Synthetic managed learning';
    field(h, 'Managed SCORM Cloud application ID').props.ref.current.value = 'fixture-app';
    field(h, 'Managed SCORM Cloud secret').props.ref.current.value = 'fixture-secret';
    change(h, 'Allow encrypted learning credential storage', true);
    await h.click('Create my managed learning connection');
    assert.equal(h.calls.find(call => call.operation === 'create-connector').policy.allowAiReview, false);
    assert.equal(h.calls.find(call => call.operation === 'create-connector').policy.allowProgressNotifications, false);
    assert.equal(field(h, 'Managed SCORM Cloud secret').props.ref.current.value, '');
    assert.equal(h.button('Enable released quiz review sharing').props.disabled, true);
    change(h, 'Authorize quiz review sharing ' + 'c'.repeat(32), true);
    await h.click('Enable released quiz review sharing');
    assert.deepEqual(h.calls.at(-1), { operation: 'set-review-policy', connector_id: 'c'.repeat(32), allowAiReview: true, confirmed: true });
    assert.equal(h.button('Permit enrolled progress updates').props.disabled, true);
    change(h, 'Authorize progress notifications ' + 'c'.repeat(32), true);
    await h.click('Permit enrolled progress updates');
    assert.deepEqual(h.calls.at(-1), { operation: 'set-notification-policy', connector_id: 'c'.repeat(32), allowProgressNotifications: true, confirmed: true });
    await h.click('Load courses for this connection');
    change(h, 'Learning map course ' + 'c'.repeat(32), JSON.stringify([courseId, 3])); await h.settle();
    const editorName = 'Learning map JSON ' + 'c'.repeat(32), confirmation = 'Confirm learning map change ' + 'c'.repeat(32);
    const map = JSON.parse(field(h, editorName).props.value);
    assert.equal(map.course_id, courseId); assert.equal(map.version, 3); assert.equal(map.release_quiz_review, false);
    map.release_quiz_review = true;
    map.instructional_locations = [{ id: 'incident', label: 'Incident recording', source_file: 'incident.html' }];
    map.review_items = [{ activity_id: 'quiz-sco', interaction_id: 'record-code', question_label: 'Which code should you record?', location_ids: ['incident'] }];
    change(h, editorName, JSON.stringify(map));
    assert.equal(h.button('Save this owner-supplied map').props.disabled, true);
    await h.click('Validate map preview');
    assert.equal(h.button('Save this owner-supplied map').props.disabled, true);
    change(h, confirmation, true); await h.click('Save this owner-supplied map');
    assert.equal(h.calls.at(-1).expected_revision, null);
    assert.ok(h.provider.map && h.provider.map.map.release_quiz_review);
    change(h, editorName, JSON.stringify({ ...map, title: 'Edited after preview' }));
    assert.equal(h.button('Save this owner-supplied map').props.disabled, true, 'Editing invalidates the previous preview and confirmation.');
    change(h, confirmation, true); await h.click('Delete saved map and review release');
    assert.equal(h.calls.at(-1).expected_revision, 'b'.repeat(32)); assert.equal(h.provider.map, null);
    assert.equal(h.modelCalls.length, 0);
    assert.ok(text(h.controller.panel).includes('cannot erase messages already shared'));
    process.stdout.write('PASS owner review policy and learning-map preview/save/delete require explicit confirmation and exact saved revisions\n');
  } finally { h.cleanup(); }
}

{
  const h = await selectedFixture();
  try {
    assert.ok(!h.calls.some(call => call.operation === 'enable-progress-notifications'));
    assert.ok(!h.all().some(node => node.type === 'button' && text(node) === 'Enable progress updates'));
    await h.click('Check progress update status');
    assert.ok(!h.all().some(node => node.type === 'button' && text(node) === 'Enable progress updates'));
    h.provider.notificationAvailable = true;
    await h.click('Check progress update status');
    assert.equal(field(h, 'Confirm progress update notifications').props.checked, false);
    assert.equal(h.button('Enable progress updates').props.disabled, true);
    change(h, 'Confirm progress update notifications', true); await h.click('Enable progress updates');
    assert.deepEqual(h.calls.at(-1), { operation: 'enable-progress-notifications', link_id: linkId, course_id: courseId, version: 3, confirmed: true });
    assert.equal(h.provider.notificationEnabled, true); assert.equal(h.controller.selected, null); assert.equal(h.history().length, 0);
    assert.equal(h.modelCalls.length, 1, 'A progress signal setup must not share context with AI.');
    change(h, 'Your enrolled course', JSON.stringify([courseId, 3]));
    await h.click('Check progress update status');
    const progressChecks = h.calls.filter(call => call.operation === 'progress').length;
    h.provider.notificationReceivedAt = '2026-11-08T20:00:00.000Z'; await h.pollNotifications();
    assert.ok(text(h.controller.panel).includes('New progress is available — Refresh my progress.'));
    assert.equal(h.calls.filter(call => call.operation === 'progress').length, progressChecks, 'A signal must not fetch or share new progress facts automatically.');
    const statusChecks = h.calls.filter(call => call.operation === 'progress-notification-status').length;
    h.setVisibility('hidden'); h.provider.notificationReceivedAt = '2026-11-08T20:01:00.000Z'; await h.pollNotifications();
    assert.equal(h.calls.filter(call => call.operation === 'progress-notification-status').length, statusChecks, 'Hidden pages must not poll.');
    h.setVisibility('visible'); await h.pollNotifications(); await h.click('Refresh my progress');
    assert.equal(h.calls.filter(call => call.operation === 'progress').length, progressChecks + 1);
    assert.equal(h.modelCalls.length, 1);
    await h.click('Disable progress updates');
    assert.equal(h.provider.notificationEnabled, false); assert.equal(h.controller.selected, null);
    assert.equal(h.modelCalls.length, 1);
    change(h, 'Your enrolled course', JSON.stringify([courseId, 3])); await h.click('Check progress update status');
    change(h, 'Confirm progress update notifications', true); await h.click('Enable progress updates');
    change(h, 'Your enrolled course', JSON.stringify([courseId, 3])); await h.click('Check progress update status');
    h.provider.notificationAvailable = false; h.provider.notificationEnabled = false; await h.pollNotifications();
    assert.equal(h.controller.selected, null);
    const stoppedChecks = h.calls.filter(call => call.operation === 'progress-notification-status').length; await h.pollNotifications();
    assert.equal(h.calls.filter(call => call.operation === 'progress-notification-status').length, stoppedChecks);
    assert.equal(h.modelCalls.length, 1);
    process.stdout.write('PASS progress updates require separate consent, poll only visible selected scope, refresh facts explicitly and stop on revoked policy\n');
  } finally { h.cleanup(); }
}
