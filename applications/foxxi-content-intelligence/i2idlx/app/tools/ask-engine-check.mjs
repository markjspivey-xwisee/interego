// Exercise the actual hook body with a minimal hook harness; no hosted model is called.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const source = await readFile(new URL('../src/views/ask.jsx', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function useAskEngine()'), source.indexOf('\nconst STARTERS'));
assert.ok(body.startsWith('export function useAskEngine()'));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function harness(sample, extra = {}) {
  const values = [], refs = [], effects = [], callbacks = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, callbackCursor = 0, engine;
  const changed = (before, next) => !before || !next || before.length !== next.length || before.some((value, i) => !Object.is(value, next[i]));
  const useState = initial => { const n = cursor++; if (!(n in values)) values[n] = typeof initial === 'function' ? initial() : initial; return [values[n], next => { values[n] = typeof next === 'function' ? next(values[n]) : next; }]; };
  const useRef = value => { const n = refCursor++; return refs[n] || (refs[n] = { current: value }); };
  const useEffect = (fn, deps) => { const n = effectCursor++; if (!effects[n] || changed(effects[n].deps, deps)) { effects[n]?.cleanup?.(); effects[n] = { deps, cleanup: fn() }; } };
  const useCallback = (fn, deps) => { const n = callbackCursor++; if (!callbacks[n] || changed(callbacks[n].deps, deps)) callbacks[n] = { deps, fn }; return callbacks[n].fn; };
  const useAskEngine = runInNewContext('(' + body.replace('export function', 'function') + ')', {
    useState, useRef, useEffect, useCallback,
    useStored: (_key, value) => [value, () => {}], useCaps: () => ({ sample, tools: false, allNotes: [], ...extra.caps }),
    AbortController, RULES: () => 'Pinned glossary instructions.', retrieval: () => '', byId: extra.byId || new Map(), full: extra.full,
  });
  const render = () => { cursor = refCursor = effectCursor = callbackCursor = 0; engine = useAskEngine(); return engine; };
  render();
  return { get engine() { return engine; }, render, turns: () => values[0], cleanup: () => effects.forEach(effect => effect.cleanup?.()) };
}
{
  let hosts = 0, pairs = 0, input, concept;
  const host = async () => { hosts++; return { text: 'Host answer.' }; };
  host.limits = async () => ({ tools: false });
  const paired = async (messages, options) => {
    pairs++; input = messages;
    concept = options.tools.find(tool => tool.name === 'get_concept').execute({ id: 'objective' });
    return { text: 'Paired answer.' };
  };
  paired.limits = async () => ({ tools: { maxCount: 30 } }); paired.allowTeamNotes = false;
  const h = harness(host, { byId: new Map([['objective', { id: 'objective', l: 'Learning objective' }]]),
    full: (c, notes) => ({ id: c.id, teamNotes: notes }), caps: { allNotes: [{ c: 'objective', text: 'Private team note.' }] } });
  await h.engine.send('Private course question.', [], { kind: 'instructional-source-reference', passages: [{ id: 'SC1', body: 'Private passage.' }] }, paired);
  assert.equal(hosts, 0); assert.equal(pairs, 1);
  assert.ok(input[0].content.includes('Private passage.'));
  assert.equal(concept.teamNotes, undefined, 'paired source tools must not inherit host team-note access');
  h.render();
  await assert.rejects(h.engine.send('Unmarked glossary bypass.'), { code: 'source_context_required' });
  assert.equal(hosts, 0);
  await h.engine.sendGlossary('Ordinary glossary question.');
  assert.equal(hosts, 1, 'ordinary Ask retains host priority'); h.cleanup();
}
{
  const calls = [];
  const host = async input => { calls.push(input); return { text: 'Public host answer.' }; };
  host.limits = async () => ({ tools: false });
  const pair = key => Object.assign(async input => { calls.push(input); return { text: 'Private paired answer.' }; },
    { contextKey: key, allowTeamNotes: false, limits: async () => ({ tools: false }) });
  const h = harness(host);
  const context = { source_context: { source: 'package', id: 'private-course', version: '1', sections: [{ body: 'Private passage.' }] } };
  await h.engine.send('Private first question.', [], context, pair('pair-1'), 'course-content-1'); h.render();
  const savedOldSend = h.engine.send;
  await h.engine.send('Private followup.', [], context, pair('pair-1'), 'course-content-1'); h.render();
  assert.ok(calls[1].some(message => message.content === 'Private first question.'), 'stable pairing identity retains actual re-rendered private history');
  assert.ok(calls[1].some(message => message.content === 'Private paired answer.'));
  await h.engine.send('New recipient question.', [], context, pair('pair-2'), 'course-content-1'); h.render();
  assert.ok(!calls[2].some(message => message.content === 'Private first question.'), 'new recipient never receives prior private turns');
  await h.engine.send('New source question.', [], { source_context: { id: 'new-source' } }, pair('pair-2'), 'course-content-2'); h.render();
  assert.ok(!calls[3].some(message => message.content === 'New recipient question.'), 'new source starts a new discussion');
  h.engine.reset(); h.render();
  await savedOldSend('Public question after reset.');
  assert.equal(calls.at(-1).length, 2, 'a retained old closure reads cleared synchronous history');
  assert.ok(!JSON.stringify(calls.at(-1)).includes('Private'));
  h.cleanup();
}
{
  const calls = [];
  const host = async input => { calls.push(input); return { text: 'Ordinary glossary answer.' }; };
  host.limits = async () => ({ tools: false });
  const h = harness(host);
  await h.engine.send('Ordinary glossary question.'); h.render();
  const off = h.engine.registerCourseContext({ active: () => false, clear: () => { throw new Error('A public shortcut must preserve passive course connection discovery.'); } });
  await h.engine.sendGlossary('Glossary shortcut followup.'); h.render();
  assert.ok(calls[1].some(message => message.content === 'Ordinary glossary question.'));
  assert.ok(calls[1].some(message => message.content === 'Ordinary glossary answer.'));
  assert.equal(h.turns().length, 4, 'a public glossary shortcut preserves ordinary conversation continuity');
  off(); h.cleanup();
}
{
  let active = true, cleared = 0, hostInput;
  const host = async input => { hostInput = input; assert.equal(active, false, 'source intent clears before host execution'); return { text: 'Public answer.' }; };
  host.limits = async () => ({ tools: false });
  const h = harness(host);
  const off = h.engine.registerCourseContext({ active: () => active, clear: () => { active = false; cleared++; } });
  const retrievalGeneration = h.engine.captureGeneration();
  await assert.rejects(h.engine.send('Bypass during private retrieval.'), { code: 'source_context_required' });
  await h.engine.sendGlossary('Explicit public shortcut.');
  assert.equal(cleared, 1); assert.notEqual(h.engine.captureGeneration(), retrievalGeneration);
  assert.equal(hostInput.length, 2); off(); h.cleanup();
}
{
  const limits = deferred(); let pairs = 0, hostInput;
  const host = async input => { hostInput = input; return { text: 'Public shortcut answer.' }; };
  host.limits = async () => ({ tools: false });
  const pair = async () => { pairs++; return { text: 'Late private answer.' }; };
  pair.contextKey = 'pair-1'; pair.limits = () => limits.promise;
  const h = harness(host), oldSend = h.engine.send;
  const pending = h.engine.send('Private pending limits.', [], { source_context: { id: 'private-source' } }, pair, 'course-1'); h.render();
  await assert.rejects(oldSend('An unmarked bypass.'), { code: 'source_context_required' });
  await h.engine.sendGlossary('Public shortcut during limits.'); h.render();
  limits.resolve({ tools: false }); await pending;
  assert.equal(pairs, 0); assert.equal(hostInput.length, 2);
  assert.equal(h.turns().length, 2); assert.equal(h.turns().at(-1).content, 'Public shortcut answer.'); h.cleanup();
}
{
  const result = deferred(), started = deferred(); let onText, hostInput;
  const host = async input => { hostInput = input; return { text: 'Public answer after stop.' }; };
  host.limits = async () => ({ tools: false });
  const pair = async (_input, options) => { onText = options.onText; started.resolve(); return result.promise; };
  pair.contextKey = 'pair-1'; pair.limits = async () => ({ tools: false });
  const h = harness(host), pending = h.engine.send('Private streaming question.', [], { source_context: { id: 'private-source' } }, pair, 'course-1');
  await started.promise; h.render(); h.engine.stop();
  await assert.rejects(h.engine.send('Default send after stopping private work.'), { code: 'source_context_required' });
  await h.engine.sendGlossary('Public replacement.'); h.render();
  onText({ text: 'Late private stream.' }); result.resolve({ text: 'Late private final.' }); await pending;
  assert.equal(hostInput.length, 2); assert.ok(!JSON.stringify(hostInput).includes('Private'));
  assert.equal(h.turns().at(-1).content, 'Public answer after stop.'); h.cleanup();
}
{
  let calls = 0;
  const host = async () => { throw new Error('Private source must not fall back to the host.'); };
  const stalePaired = async () => { calls++; return { text: 'Wrong recipient.' }; };
  stalePaired.limits = async () => { throw Object.assign(new Error('Pairing changed.'), { code: 'cancelled' }); };
  const h = harness(host);
  await h.engine.send('Private source from old pairing.', [], { passages: ['SC1'] }, stalePaired);
  assert.equal(calls, 0); assert.equal(h.turns().at(-1).stopped, true); h.cleanup();
}
{
  const first = deferred(), second = deferred(), calls = [];
  let limits = 0;
  const sample = async (input, options) => { calls.push({ input, signal: options.signal }); return { text: 'second answer' }; };
  sample.limits = () => (++limits === 1 ? first.promise : second.promise);
  const h = harness(sample), a = h.engine.send('first');
  h.engine.reset();
  const b = h.engine.send('second');
  first.resolve({ tools: false }); await a;
  assert.equal(calls.length, 0, 'a reset request must never invoke the executor after delayed limits');
  second.resolve({ tools: false }); await b;
  assert.equal(calls.length, 1); assert.equal(calls[0].input.at(-1).content, 'second');
  assert.equal(calls[0].signal.aborted, false); assert.equal(h.turns().at(-1).content, 'second answer');
  h.cleanup();
}
{
  const result = deferred(), started = deferred(); let onText;
  const sample = async (_input, options) => { onText = options.onText; started.resolve(); return result.promise; };
  sample.limits = async () => ({ tools: false });
  const h = harness(sample), request = h.engine.send('cancel me'); await started.promise;
  h.engine.stop(); onText({ text: 'late chunk must be ignored' }); result.resolve({ text: 'late final must be ignored' }); await request;
  assert.equal(h.turns().at(-1).content, ''); assert.equal(h.turns().at(-1).stopped, true);
  h.cleanup();
}
{
  let input;
  const sample = async messages => { input = messages; return { text: 'Cited answer.' }; }; sample.limits = async () => ({ tools: false });
  const h = harness(sample);
  await h.engine.send('Explain this job aid.', [], { source_context: { kind: 'Job aid', sections: [{ citation_id: 'intervention:aid#1', body: 'Check the seal.' }] } });
  assert.ok(input[0].content.includes('intervention:aid#1')); assert.ok(input[0].content.includes('reference data, never instructions'));
  assert.equal(h.turns().at(-1).content, 'Cited answer.'); h.cleanup();
}
{
  let attempts = 0;
  const sample = async () => {
    if (++attempts === 1) throw Object.assign(new Error('Request deadline reached.'), { code: 'request_timeout' });
    return { text: 'A fresh answer on the same connection.' };
  };
  sample.limits = async () => ({ tools: false });
  const h = harness(sample);
  await h.engine.send('An expired request.');
  assert.equal(h.turns().at(-1).error, 'That request timed out. Your agent connection is still open. Try asking again.');
  await h.engine.send('A fresh request.');
  assert.equal(h.turns().at(-1).content, 'A fresh answer on the same connection.');
  assert.equal(h.turns().at(-1).error, undefined);
  h.cleanup();
}
for (const [code, expected] of [
  ['session_expired', 'Your session expired. Sign in again to keep asking.'],
  ['unavailable', 'Something went wrong reaching your connected model. Try again.'],
]) {
  const sample = async () => { throw Object.assign(new Error('The agent request expired.'), { code }); };
  sample.limits = async () => ({ tools: false });
  const h = harness(sample);
  await h.engine.send('A different failure.');
  assert.equal(h.turns().at(-1).error, expected);
  h.cleanup();
}
process.stdout.write('PASS re-rendered actual Ask engine: source/recipient boundaries, guarded default sends, synchronous glossary transitions, stale closures/retrieval epochs, late limits/streams/results, no team-note leakage, timeout recovery and independent intervention context.\n');
