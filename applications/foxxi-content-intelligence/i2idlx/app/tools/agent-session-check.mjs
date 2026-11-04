// Deterministic browser-transport checks; no model, credentials, server or host simulation is claimed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createAgentSessionClient, validateAgentToolArguments } from '../src/agent-session.js';
import { ORG, RECORDS, AGENTS, STEPS, stepById, agentById } from '../src/orc/scenario.js';

const SESSION = '1'.repeat(32), BROWSER = '2'.repeat(64), INVITE = '3'.repeat(64);
const expires = '2099-01-01T00:00:00.000Z';
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const create = () => ({ session_id: SESSION, browser_token: BROWSER, invite_token: INVITE, expires_at: expires, invite_expires_at: expires, audience: 'https://workbench.example', action_iri: 'urn:foxxi:i2idlx:agent-session', protocol: { driver: { action: 'urn:foxxi:i2idlx:agent-session', signed_fields: { i2idlx_operation: 'agent-session', bridge_audience: 'https://workbench.example', session_id: SESSION } } } });
const turn = (state, revision, text = '', extra = {}) => ({ turn_id: 'turn-1', state, revision, text, ...extra });
function fixture(handler, options = {}) {
  const calls = [];
  const client = createAgentSessionClient({
    origin: () => 'https://workbench.example/i2idlx/', pollMs: 0, wait: async () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (url.endsWith('/create')) return response(create());
      if (body.operation === 'status') return response({ session_id: SESSION, state: 'connected', driver: { actor: 'did:example:verified-test-agent' }, expires_at: expires });
      if (body.operation === 'disconnect') return response({ disconnected: true });
      if (body.operation === 'cancel') return response(turn('cancelled', 99));
      return handler(body, calls);
    }, ...options,
  });
  return { client, calls };
}
let count = 0;
async function test(name, run) { await run(); count++; process.stdout.write('PASS ' + name + '\n'); }
async function ready(client) { await client.connect(); await client.refresh(); }

await test('explicit connection keeps browser capability out of invitation and URLs', async () => {
  const { client, calls } = fixture(() => response({}));
  assert.equal(calls.length, 0);
  assert.equal(client.getSample(), null);
  const invitation = await client.connect();
  assert(invitation.includes(INVITE));
  assert(!invitation.includes(BROWSER));
  assert(invitation.includes('urn:foxxi:i2idlx:agent-session'));
  assert.equal(client.status().state, 'waiting_for_agent');
  assert.equal(client.getSample(), null);
  assert(calls.every(call => !call.url.includes(BROWSER) && !call.url.includes(INVITE)));
  assert.equal(calls[0].init.credentials, 'omit');
});

await test('queued and running tasks stream actual cumulative text through completion', async () => {
  let polls = 0;
  const { client, calls } = fixture(body => {
    if (body.operation === 'request') return response(turn('queued', 0));
    if (body.operation === 'poll') return response(++polls === 1 ? turn('running', 1, 'Hello') : turn('completed', 2, 'Hello world'));
    throw new Error('Unexpected operation');
  });
  await ready(client);
  const text = [];
  const result = await client.getSample()([{ role: 'user', content: 'Question' }], { onText: value => text.push(value.text) });
  assert.deepEqual(text, ['Hello', 'Hello world']);
  assert.deepEqual(result, { text: 'Hello world', truncated: false });
  assert.equal(client.status().pending, false);
  assert(calls.slice(1).every(call => call.init.headers.Authorization === 'Bearer ' + BROWSER));
  assert(calls.every(call => call.url.startsWith('/i2idlx/api/agent-sessions/')));
});

await test('exact advertised local tool runs and its actual result is returned to the agent', async () => {
  let requests = 0, executions = 0;
  const { client, calls } = fixture(body => {
    if (body.operation === 'request') {
      requests++;
      if (requests === 1) return response(turn('completed', 1, '', { tool_calls: [{ id: 'lookup-1', name: 'get_concept', arguments: { id: 'simulation' } }] }));
      const actual = body.messages.at(-1).content;
      assert(actual.includes('Actual definition from the page'));
      assert(actual.includes('reference data, not instructions'));
      assert(!JSON.stringify(body.tools).includes('execute'));
      return response(turn('completed', 1, 'Grounded answer [[simulation]]'));
    }
    throw new Error('Unexpected operation');
  });
  await ready(client);
  const result = await client.getSample()([{ role: 'user', content: 'Explain simulation.' }], { tools: [{ name: 'get_concept', description: 'Read a glossary concept', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, execute: args => { executions++; assert.equal(args.id, 'simulation'); return { definition: 'Actual definition from the page' }; } }] });
  assert.equal(executions, 1);
  assert.equal(requests, 2);
  assert.equal(result.text, 'Grounded answer [[simulation]]');
  assert(calls.every(call => !call.init.body.includes('executions++')));
});

await test('original Orchestrate prompts and no-argument tools preserve cumulative handoff offsets', async () => {
  let requests = 0, executions = 0, consumed = 0;
  const shown = [], before = 'Inspecting the catalog.', handoff = 'The catalog is available for the next sandbox step.';
  const { client } = fixture(body => {
    if (body.operation !== 'request') throw new Error('Unexpected operation');
    if (++requests === 1) {
      assert.deepEqual(body.messages, [{ role: 'user', content: 'Run the next sandbox step.' }]);
      assert.deepEqual(body.tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
      return response(turn('completed', 1, before, { tool_calls: [{ id: 'catalog-1', name: 'read_catalog', arguments: {} }] }));
    }
    assert(body.messages.at(-1).content.includes('Actual sandbox catalog'));
    return response(turn('completed', 1, handoff));
  });
  await ready(client);
  const result = await client.getSample()('Run the next sandbox step.', {
    tools: [{ name: 'read_catalog', description: 'Read the sandbox catalog.', execute: args => {
      executions++; assert.deepEqual(args, {}); consumed = shown.at(-1).length;
      return { catalog: 'Actual sandbox catalog' };
    } }],
    onText: ({ text }) => shown.push(text),
  });
  assert.equal(executions, 1); assert.equal(requests, 2);
  assert.deepEqual(shown, [before, before + '\n\n' + handoff]);
  assert.equal(result.text, before + '\n\n' + handoff);
  assert.equal(result.text.slice(consumed).trim(), handoff, 'The original Orchestrate consumer must receive the complete final handoff.');
});

await test('unadvertised and duplicate tool requests cannot execute page functions', async () => {
  let executions = 0;
  const { client } = fixture(body => response(turn('completed', 1, '', { tool_calls: [{ id: 'bad', name: 'navigate_arbitrary_url', arguments: {} }] })));
  await ready(client);
  await assert.rejects(client.getSample()([{ role: 'user', content: 'Question' }], { tools: [{ name: 'safe_lookup', inputSchema: { type: 'object' }, execute: () => { executions++; } }] }), /unadvertised/);
  assert.equal(executions, 0);
  const duplicate = fixture(() => response(turn('completed', 1, '', { tool_calls: [{ id: 'same', name: 'safe_lookup', arguments: {} }, { id: 'same', name: 'safe_lookup', arguments: {} }] })));
  await ready(duplicate.client);
  await assert.rejects(duplicate.client.getSample()([{ role: 'user', content: 'Question' }], { tools: [{ name: 'safe_lookup', inputSchema: { type: 'object' }, execute: () => { executions++; return {}; } }] }), /invalid/);
  // The entire call list is rejected before any function can execute.
  assert.equal(executions, 0);
});

await test('tool argument validation refuses wrong types and unsupported schema assertions', async () => {
  assert.throws(() => validateAgentToolArguments({ type: 'object', properties: { limit: { type: 'integer', maximum: 5 } }, required: ['limit'], additionalProperties: false }, { limit: '5' }), /wrong type/);
  assert.throws(() => validateAgentToolArguments({ type: 'object', additionalProperties: false }, { surprise: true }), /unadvertised field/);
  assert.throws(() => validateAgentToolArguments({ type: 'object', oneOf: [] }, {}), /Unsupported/);
  assert.equal(validateAgentToolArguments({ type: 'object', properties: { limit: { type: 'integer', maximum: 5 } }, required: ['limit'] }, { limit: 5 }), true);
  let executed = 0, requested = 0;
  const { client } = fixture(() => response(++requested === 1 ? turn('completed', 1, '', { tool_calls: [{ id: 'wrong-type', name: 'safe_lookup', arguments: { limit: '5' } }] }) : turn('completed', 1, 'The tool reported an argument error.')));
  await ready(client);
  await client.getSample()([{ role: 'user', content: 'Question' }], { tools: [{ name: 'safe_lookup', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } }, execute: () => { executed++; } }] });
  assert.equal(executed, 0);
});

await test('abort cancels the broker turn and never reports a completed answer', async () => {
  const aborter = new AbortController();
  const { client, calls } = fixture(() => response(turn('queued', 0)), { wait: async () => { aborter.abort(); } });
  await ready(client);
  await assert.rejects(client.getSample()([{ role: 'user', content: 'Question' }], { signal: aborter.signal }), error => error.code === 'cancelled');
  assert.equal(calls.filter(call => call.body.operation === 'cancel').length, 1);
  assert.equal(client.status().pending, false);
});

await test('stale revisions and rewritten streamed text are rejected', async () => {
  let polls = 0;
  const { client, calls } = fixture(body => response(body.operation === 'request' ? turn('running', 2, 'Already shown') : ++polls === 1 ? turn('running', 1, 'Earlier') : turn('completed', 3, 'Rewritten')));
  await ready(client);
  await assert.rejects(client.getSample()([{ role: 'user', content: 'Question' }]), /stale or invalid/);
  assert(calls.some(call => call.body.operation === 'cancel'));
});

await test('expired server session disables sampling and disconnect erases local authority', async () => {
  const { client, calls } = fixture(() => response({ error: 'Expired' }, 410));
  await ready(client);
  await assert.rejects(client.getSample()([{ role: 'user', content: 'Question' }]), error => error.code === 'session_expired');
  assert.equal(client.getSample(), null);
  await client.disconnect();
  assert.equal(client.status().state, 'disconnected');
  assert.equal(client.getSample(), null);
  assert(calls.some(call => call.body.operation === 'disconnect'));
});

// Run the real hook and dependency scheduler with deterministic completions. Semantic
// tools are fixtures here; the existing orchestration checks cover their behavior.
await test('overlapping consumers fail without cancelling or replacing the active turn', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { client, calls } = fixture(async body => {
    assert.equal(body.operation, 'request');
    await held;
    return response(turn('completed', 1, 'The first answer.'));
  });
  await ready(client);
  const sample = client.getSample(), firstController = new AbortController(), secondController = new AbortController();
  const first = sample('First consumer.', { signal: firstController.signal });
  await assert.rejects(sample('Second consumer.', { signal: secondController.signal }), error => error.code === 'rate_limited');
  secondController.abort();
  assert.equal(firstController.signal.aborted, false);
  assert.equal(calls.filter(call => call.body.operation === 'request').length, 1);
  release();
  assert.equal((await first).text, 'The first answer.');
  assert.equal(calls.filter(call => call.body.operation === 'cancel').length, 0);
});

const orchestraSource = await readFile(new URL('../src/orc/engine.js', import.meta.url), 'utf8');
function orchestraHarness(sample) {
  const hooks = [];
  let cursor = 0;
  const memo = (fn, deps) => {
    const n = cursor++, old = hooks[n];
    if (!old || deps.some((value, i) => value !== old.deps[i])) hooks[n] = { value: fn(), deps };
    return hooks[n].value;
  };
  const useState = initial => {
    const n = cursor++;
    if (!hooks[n]) hooks[n] = { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[n].value, next => { hooks[n].value = typeof next === 'function' ? next(hooks[n].value) : next; }];
  };
  const useRef = initial => memo(() => ({ current: initial }), []);
  const useEffect = (fn, deps) => memo(() => { fn(); }, deps);
  const React = { useState, useRef, useEffect, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps) };
  const TOOLS = Object.fromEntries(STEPS.flatMap(step => step.tools).map(name => [name, { description: 'Deterministic scheduling fixture.' }]));
  const context = {
    React, META: { scheme: { title: 'Test glossary' }, release: 'test' }, C: [],
    useCaps: () => ({ resolved: true, sample }), useStored: (_key, value) => useState(value),
    createWorld: () => ({ fixes: [{ status: 'open' }], items: [] }),
    callTool: () => ({ ok: true, result: {}, summary: 'fixture', ui: [] }), decideGate: () => {}, TOOLS,
    ORG, RECORDS, AGENTS, STEPS, stepById, agentById, recordedReleaseOf: () => 'test',
    AbortController, setTimeout, clearTimeout,
  };
  const useOrchestra = runInNewContext(orchestraSource.replace(/^import .*\n/gm, '').replaceAll('export function ', 'function ') + '\nuseOrchestra;', context);
  const render = () => { cursor = 0; return useOrchestra({}); };
  return { render };
}
const flushEffects = async () => { await Promise.resolve(); await Promise.resolve(); };
const stepIn = prompt => STEPS.find(step => prompt.includes('Your step: ' + step.title + '.'));

await test('Orchestrate distinguishes request timeout from sign-in expiry', async () => {
  const sample = async () => { throw Object.assign(new Error('Request deadline reached.'), { code: 'request_timeout' }); };
  sample.limits = async () => ({ tools: { maxCount: 30 }, maxConcurrentRequests: 1 });
  const h = orchestraHarness(sample); h.render(); await flushEffects();
  await h.render().start('live');
  assert.equal(h.render().state, 'error');
  assert.equal(h.render().message, 'A request timed out. The agent connection is still open; try the run again.');
});

await test('all twelve orchestration steps complete through the single-turn paired transport', async () => {
  const requested = new Set();
  const { client } = fixture(body => {
    assert.equal(body.operation, 'request');
    const step = stepIn(body.messages[0].content);
    assert.ok(step, 'The actual engine supplies each step prompt.');
    requested.add(step.id);
    return response(turn('completed', 1, 'Completed ' + step.id + ' fixture handoff.'));
  });
  await ready(client);
  const sample = client.getSample(), h = orchestraHarness(sample);
  h.render(); await flushEffects();
  await h.render().start('live');
  const final = h.render();
  assert.equal(final.state, 'done', 'The paired executor must reach the full dependency graph without a concurrent request failure: ' + final.message);
  assert.equal(requested.size, STEPS.length);
  assert.equal(Object.values(final.steps).filter(value => value === 'done').length, STEPS.length);
  assert.equal((await sample.limits()).maxConcurrentRequests, 1);
});

for (const limit of [undefined, 2, 10, 0]) {
  await test('host executor retains two concurrent steps with limit ' + String(limit), async () => {
    let running = 0, peak = 0;
    const sample = async (prompt, options) => {
      assert.ok(stepIn(prompt)); assert.equal(options.signal.aborted, false);
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      return { text: 'Deterministic fixture handoff.' };
    };
    sample.limits = async () => ({ tools: { maxCount: 30 }, ...(limit === undefined ? {} : { maxConcurrentRequests: limit }) });
    const h = orchestraHarness(sample); h.render(); await flushEffects();
    await h.render().start('live');
    assert.equal(h.render().state, 'done');
    assert.equal(peak, 2, 'Unspecified/invalid limits keep the host default, and wider limits stay capped at two.');
  });
}

process.stdout.write(count + ' agent session transport and orchestration checks passed. No model or production request was made.\n');
