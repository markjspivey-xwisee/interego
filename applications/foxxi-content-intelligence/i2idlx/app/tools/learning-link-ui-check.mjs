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

function fixture() {
  const values = [], refs = [], effects = [], pendingEffects = [], calls = [], modelCalls = [];
  let stateCursor = 0, refCursor = 0, effectCursor = 0, dirty = false, controller, generation = 0, history = [];
  const provider = { status: 'active', missing: false, refusal: null };
  const link = () => ({ id: linkId, connector_id: 'c'.repeat(32), provider_label: 'Fixture learning provider', status: provider.status });
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const client = createLearningClient({ origin: () => 'https://workbench.example', fetch: async (path, init) => {
    if (path === '/i2idlx/learning/session') return response({ enabled: true, authenticated: true,
      account: { id: 'did:example:alice', userId: 'alice', webId: 'https://identity.example/alice' },
      csrf: 'private-fixture-csrf', expires_at: expires, sign_in_url: '/i2idlx/learning/oauth/start' });
    assert.equal(path, '/i2idlx/api/learning');
    const args = JSON.parse(init.body); calls.push(args);
    if (args.operation === 'my-links') return response({ links: provider.missing ? [] : [link()] });
    if (provider.refusal) return response({ code: provider.refusal }, 403);
    if (args.operation === 'courses') return response({ link_id: linkId, courses: [{ id: courseId, title: courseTitle, version: 3 }],
      prerequisites: { status: 'unavailable' }, curriculum: { status: 'unavailable' } });
    if (args.operation === 'progress') return response({ link_id: linkId, as_of: expires, records: [{ course_id: courseId,
      title: courseTitle, version: 3, completion: 'COMPLETED', success: 'PASSED', score: 73, total_seconds: 90,
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
    learningContextRequest: async args => {
      if (provider.refusal) throw Object.assign(new Error('Fixture refusal'), { code: provider.refusal, status: 403 });
      return { source: { provider: 'scorm-cloud', course_id: courseId, version: 3, source_version: 'course-version:3' },
        access: { link_id: linkId, sharing: { content: args.share_content, progress: args.share_progress } },
        interventionContext: { source_context: { sections: [{ body: 'Private safety passage BLUE27.' }] } },
        citations: [{ id: 'SC1', title: 'Private safety source' }], missing_context: [], authorization_ticket: 'e'.repeat(64) };
    },
    AbortController, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  });
  function render() {
    for (let count = 0; count < 30; count++) {
      dirty = false; stateCursor = refCursor = effectCursor = 0;
      controller = hook(engine);
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
    history: () => history, cleanup: () => effects.forEach(effect => effect.cleanup?.()) };
}

async function selectedFixture() {
  const h = fixture(); await h.settle(); await h.click('Show my enrolled courses');
  h.all().find(node => node.props['aria-label'] === 'Your enrolled course').props.onChange({ target: { value: JSON.stringify([courseId, 3]) } }); h.render();
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
