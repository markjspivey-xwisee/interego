// Deterministic browser-transport checks; no model, credentials, server or host simulation is claimed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createAgentSessionClient, validateAgentToolArguments } from '../src/agent-session.js';
import { ORG, RECORDS, AGENTS, STEPS, stepById, agentById } from '../src/orc/scenario.js';
import { workflowReport } from '../src/orc/report.js';

const SESSION = '1'.repeat(32), BROWSER = '2'.repeat(64), INVITE = '3'.repeat(64);
const expires = '2099-01-01T00:00:00.000Z';
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const create = () => ({ session_id: SESSION, browser_token: BROWSER, invite_token: INVITE, expires_at: expires, invite_expires_at: expires, audience: 'https://workbench.example', action_iri: 'urn:foxxi:i2idlx:agent-session', protocol: { driver: { action: 'urn:foxxi:i2idlx:agent-session', signed_fields: { i2idlx_operation: 'agent-session', bridge_audience: 'https://workbench.example', session_id: SESSION } } } });
const connected = extra => ({ session_id: SESSION, state: 'connected', driver: { actor: 'did:example:verified-test-agent' }, expires_at: expires, ...extra });
const turn = (state, revision, text = '', extra = {}) => ({ turn_id: 'turn-1', state, revision, text, ...extra });
function fixture(handler, options = {}) {
  const calls = [];
  const { createResponse = () => response(create()), statusResponse = () => response(connected()), ...clientOptions } = options;
  const client = createAgentSessionClient({
    origin: () => 'https://workbench.example/i2idlx/', pollMs: 0, wait: async () => {},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, init, body });
      if (url.endsWith('/create')) return createResponse();
      if (body.operation === 'status') return statusResponse();
      if (body.operation === 'disconnect') return response({ disconnected: true });
      if (body.operation === 'cancel') return response(turn('cancelled', 99));
      return handler(body, calls);
    }, ...clientOptions,
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
  assert.doesNotMatch(invitation, /start_monitoring/);
  assert.match(invitation, /Call signed next now and continue polling across idle responses/);
  assert.equal(client.status().state, 'waiting_for_agent');
  assert.equal(client.getSample(), null);
  assert(calls.every(call => !call.url.includes(BROWSER) && !call.url.includes(INVITE)));
  assert.equal(calls[0].init.credentials, 'omit');
});

await test('advertised automatic monitoring gates sampling until ready and offers a fresh pairing after failure', async () => {
  let monitoring = 'starting';
  const advertised = () => {
    const created = create();
    created.protocol.driver.routine_start = true;
    return created;
  };
  const { client, calls } = fixture(body => {
    if (body.operation === 'invite') return response({ ...advertised(), state: 'waiting_for_agent', driver: null, invite_token: '4'.repeat(64) });
    assert.equal(body.operation, 'request');
    return response(turn('completed', 1, 'The active monitor answered.'));
  }, { createResponse: () => response(advertised()), statusResponse: () => response(connected({ monitoring })) });
  const invitation = await client.connect();
  const claim = JSON.parse(invitation.match(/Claim call template: (.+)/)[1]);
  assert.equal(claim.payload.start_monitoring, true);
  assert.match(invitation, /monitoring=starting.*automatically/);
  assert.match(invitation, /Automatic monitoring is not configured for this agent.*remove start_monitoring.*same invitation.*signed next in this same turn/);
  assert(!invitation.includes(BROWSER));
  await client.refresh();
  assert.equal(client.status().state, 'connected');
  assert.equal(client.status().monitoring, 'starting');
  assert.equal(client.getSample(), null);
  assert.equal(calls.filter(call => call.body.operation === 'request').length, 0);
  monitoring = 'ready'; await client.refresh();
  const sample = client.getSample();
  assert.equal(typeof sample, 'function');
  assert.equal((await sample('Question')).text, 'The active monitor answered.');
  monitoring = 'unavailable'; await client.refresh();
  assert.equal(client.status().monitoring, 'unavailable');
  assert.equal(client.getSample(), null);
  await assert.rejects(sample('Another question'), /Create a new connection request/);
  assert.equal(calls.filter(call => call.body.operation === 'request').length, 1);
  const renewed = await client.renewInvitation();
  assert(renewed.includes('4'.repeat(64)));
  assert.equal(client.status().state, 'waiting_for_agent');
  assert.equal(client.status().monitoring, null);
  assert.equal(client.status().driverActor, null);
  assert.equal(client.getSample(), null);
});

await test('old readiness and expiry responses cannot change a replacement pairing', async () => {
  for (const staleReply of [response(connected({ monitoring: 'ready' })), response({ error: 'Expired old request' }, 410)]) {
    let holdStatus = false, release;
    const { client } = fixture(body => {
      assert.equal(body.operation, 'invite');
      return response({ ...create(), state: 'waiting_for_agent', driver: null, invite_token: '4'.repeat(64) });
    }, { statusResponse: () => holdStatus ? new Promise(resolve => { release = resolve; }) : response(connected({ monitoring: 'ready' })) });
    await ready(client);
    assert.equal(typeof client.getSample(), 'function');
    holdStatus = true;
    const oldRefresh = client.refresh();
    await client.renewInvitation();
    release(staleReply); await oldRefresh;
    assert.equal(client.status().state, 'waiting_for_agent');
    assert.equal(client.status().monitoring, null);
    assert.equal(client.getSample(), null);
  }
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
  const { client } = fixture(() => response(turn('completed', 1, '', { tool_calls: [{ id: 'bad', name: 'navigate_arbitrary_url', arguments: {} }] })));
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
const worldSource = await readFile(new URL('../src/orc/world.js', import.meta.url), 'utf8');
// Run the actual sandbox summary and decision tools. Only semantic inference is
// bounded here; this suite tests lifecycle/transport, not ontology correctness.
const worldRuntime = runInNewContext(worldSource.replace(/^import .*\n/gm, '').replaceAll('export ', '') + '\n({ createWorld, callTool, decideGate, TOOLS });', {
  META: { base: 'https://workbench.example/ns/test/i2idlx' }, PORTS: [], QUERIES: [], MAPPINGS: [],
  SEM: { labels: {}, prefixes: {} }, COLUMNS: [], byId: new Map(), byIri: new Map(),
  classify: () => ({ resources: [], typings: 17, clashes: 0 }),
  ORG, RECORDS, agentById,
});
function orchestraHarness(sample, trace = {}, seedWorld = () => {}) {
  const hooks = [];
  let cursor = 0;
  let worldRef;
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
  const useRef = initial => { const ref = memo(() => ({ current: initial }), []); worldRef ||= ref; return ref; };
  const useEffect = (fn, deps) => memo(() => { fn(); }, deps);
  const React = { useState, useRef, useEffect, useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps) };
  const summaryCalls = [];
  const context = {
    React, META: { scheme: { title: 'Test glossary' }, release: 'test' }, CANONICAL_C: Array(8).fill({}), AUTHORED_C: [{}],
    useCaps: () => ({ resolved: true, sample }), useStored: (_key, value) => useState(value),
    createWorld: () => { const world = worldRuntime.createWorld(); world.fixes.push({ status: 'open' }); seedWorld(world); return world; },
    callTool: (...args) => {
      const out = worldRuntime.callTool(...args);
      if (args[1] === 'run_summary') summaryCalls.push(out);
      return out;
    },
    decideGate: worldRuntime.decideGate, TOOLS: worldRuntime.TOOLS, workflowReport,
    ORG, RECORDS, AGENTS, STEPS, stepById, agentById, recordedReleaseOf: () => 'test',
    AbortController, setTimeout, clearTimeout,
  };
  const useOrchestra = runInNewContext(orchestraSource.replace(/^import .*\n/gm, '').replaceAll('export function ', 'function ') + '\nuseOrchestra;', context);
  const render = () => { cursor = 0; return useOrchestra(trace); };
  const stageCall = () => worldRef.current.staged.push({ id: 'call-fixture', port: 'port-publish-classified', title: 'Fixture sandbox graph', status: 'staged' });
  const openGate = () => {
    stageCall();
    const out = worldRuntime.callTool(worldRef.current, 'request_approval', { summary: 'Decide on the actual staged fixture.' }, 'conductor', ['request_approval']);
    assert.equal(out.ok, true);
  };
  return { render, world: () => worldRef.current, summaryCalls, stageCall, openGate };
}
const flushEffects = async () => { await Promise.resolve(); await Promise.resolve(); };
const stepIn = prompt => STEPS.find(step => prompt.includes('Your step: ' + step.title + '.'));
const until = async predicate => {
  const deadline = performance.now() + 2000;
  for (;;) {
    if (predicate()) return;
    if (performance.now() >= deadline) throw new Error('The orchestration lifecycle did not reach its expected checkpoint.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

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
  let h;
  const { client } = fixture(body => {
    assert.equal(body.operation, 'request');
    assert(body.messages[0].content.includes('8 canonical concepts'));
    assert(body.messages[0].content.includes('1 separately authored Hypothetical'));
    const step = stepIn(body.messages[0].content);
    assert.ok(step, 'The actual engine supplies each step prompt.');
    requested.add(step.id);
    if (step.id === 'stage') { h.openGate(); h.render().decide('approved'); }
    return response(turn('completed', 1, 'Completed ' + step.id + ' fixture handoff.'));
  });
  await ready(client);
  const sample = client.getSample(); h = orchestraHarness(sample);
  h.render(); await flushEffects();
  await h.render().start('live');
  const final = h.render();
  assert.equal(final.state, 'done', 'The paired executor must reach the full dependency graph without a concurrent request failure: ' + final.message);
  assert.equal(requested.size, STEPS.length - 1, 'The final step reads the page summary without another paired request.');
  assert.equal(requested.has('close'), false);
  assert.equal(h.summaryCalls.length, 1);
  assert.equal(Object.values(final.steps).filter(value => value === 'done').length, STEPS.length);
  assert.equal((await sample.limits()).maxConcurrentRequests, 1);
});

for (const limit of [undefined, 2, 10, 0]) {
  await test('host executor retains two concurrent steps with limit ' + String(limit), async () => {
    let running = 0, peak = 0;
    let h;
    const sample = async (prompt, options) => {
      assert.ok(stepIn(prompt)); assert.equal(options.signal.aborted, false);
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running--;
      if (stepIn(prompt).id === 'stage') { h.openGate(); h.render().decide('approved'); }
      return { text: 'Deterministic fixture handoff.' };
    };
    sample.limits = async () => ({ tools: { maxCount: 30 }, ...(limit === undefined ? {} : { maxConcurrentRequests: limit }) });
    h = orchestraHarness(sample); h.render(); await flushEffects();
    await h.render().start('live');
    assert.equal(h.render().state, 'done');
    assert.equal(peak, 2, 'Unspecified/invalid limits keep the host default, and wider limits stay capped at two.');
  });
}

for (const [decision, unavailableCode] of [['approved', 'session_expired'], ['declined', 'unavailable']]) {
  await test('the actual pending gate closes once after ' + decision + ' with an unavailable post-gate model', async () => {
    let h, unavailable = false, postGateSamples = 0;
    const sampled = [];
    const sample = async (prompt, options) => {
      if (unavailable) { postGateSamples++; throw Object.assign(new Error('The connected driver is no longer serving.'), { code: unavailableCode }); }
      const step = stepIn(prompt); sampled.push(step.id);
      if (step.id === 'stage') {
        h.stageCall();
        await options.tools.find(tool => tool.name === 'request_approval').execute({ summary: 'Review this staged sandbox graph.' });
      }
      return { text: 'Actual engine scheduling fixture handoff.' };
    };
    sample.limits = async () => ({ tools: { maxCount: 30 }, maxConcurrentRequests: 1 });
    h = orchestraHarness(sample); h.render(); await flushEffects();
    const running = h.render().start('live');
    await until(() => h.render().state === 'gate');
    assert.equal(h.world().gate.status, 'pending');
    assert.equal(h.summaryCalls.length, 0);
    assert.equal(h.render().steps.close, undefined);
    h.render().decide('not-a-decision');
    assert.equal(h.world().gate.status, 'pending');
    h.world().records.get('lrs-prod').status = 'classified';
    h.world().records.get('sepsis-sim').status = 'classified';
    h.world().gaps.set('med-safety-check', { nearest: [], peers: [] });
    h.world().clashesSeen = 1; h.world().fixedClashes = 1;
    h.world().packs.push({ name: 'Fixture onboarding', items: ['one', 'two'] });
    unavailable = true;
    h.render().decide(decision);
    h.render().decide(decision === 'approved' ? 'declined' : 'approved');
    await running;
    const final = h.render();
    assert.equal(final.state, 'done');
    assert.equal(final.steps.close, 'done');
    assert.equal(postGateSamples, 0);
    assert.equal(sampled.length, STEPS.length - 1);
    assert.equal(h.summaryCalls.length, 1);
    const call = final.log.find(row => row.tool === 'run_summary');
    const report = final.log.find(row => row.type === 'say' && row.step === 'close');
    assert.equal(call.execution, 'workflow'); assert.equal(call.status, 'ok');
    assert.equal(call.result.humanDecision, decision);
    assert.equal(call.result.staged[0].status, decision);
    assert.equal(call.result.records.length, RECORDS.length);
    assert.equal(call.result.records.filter(row => row.status === 'classified').length, 2);
    assert.equal(report.execution, 'workflow');
    assert.equal(report.summary, call.result, 'The report retains the actual page-tool result.');
    assert.match(report.text, new RegExp('You ' + decision));
    assert.match(report.text, /2 of 10 records/);
    assert.match(report.text, /1 glossary gap flagged locally/);
    assert.match(report.text, /17 inferred type assignments recorded/);
    assert.match(report.text, /No staged call was sent or published/);
    assert.equal(final.log.filter(row => row.type === 'decision').length, 1);
    assert.equal(final.log.find(row => row.type === 'step' && row.step === 'close').execution, 'workflow');
    h.render().decide(decision);
    assert.equal(h.summaryCalls.length, 1);
    assert.equal(h.render().log.filter(row => row.type === 'say' && row.step === 'close').length, 1);
  });
}

await test('stopping at the pending gate produces neither a report nor an approval', async () => {
  let h;
  const sample = async (prompt, options) => {
    if (stepIn(prompt).id === 'stage') {
      h.stageCall();
      await options.tools.find(tool => tool.name === 'request_approval').execute({ summary: 'Waiting for the human.' });
    }
    return { text: 'Fixture handoff.' };
  };
  sample.limits = async () => ({ tools: { maxCount: 30 }, maxConcurrentRequests: 1 });
  h = orchestraHarness(sample); h.render(); await flushEffects();
  const running = h.render().start('live');
  await until(() => h.render().state === 'gate');
  h.render().stop(); await running;
  assert.equal(h.render().state, 'stopped');
  assert.equal(h.world().gate.status, 'pending');
  assert.equal(h.summaryCalls.length, 0);
  assert.equal(h.render().log.some(row => row.step === 'close'), false);
  const raced = h.render().start('live');
  await until(() => h.render().state === 'gate');
  h.render().decide('approved'); h.render().stop(); await raced;
  assert.equal(h.render().state, 'stopped');
  assert.equal(h.summaryCalls.length, 0, 'Stopping immediately after a decision must still prevent completion.');
  assert.equal(h.render().log.some(row => row.step === 'close'), false);
});

await test('recorded decline preserves the historical close skip and generates no replacement report', async () => {
  let samples = 0;
  const sample = async () => { samples++; throw new Error('Recorded history cannot sample a model.'); };
  sample.limits = async () => ({ tools: { maxCount: 30 }, maxConcurrentRequests: 1 });
  const trace = { recordedAt: '2026-10-01T00:00:00.000Z', events: [
    { k: 'call', id: 'recorded-approval', agent: 'conductor', step: 'stage', tool: 'request_approval', input: { summary: 'Historical approval request.' } },
    { k: 'decision' },
    { k: 'say', agent: 'conductor', step: 'close', text: 'Historical report that assumed approval.', handoff: true },
  ] };
  const before = JSON.stringify(trace);
  const h = orchestraHarness(sample, trace, world => world.staged.push({ id: 'historical-call', status: 'staged' }));
  h.render(); await flushEffects(); h.render().setSpeed(4);
  const running = h.render().start('recorded');
  await until(() => h.render().state === 'gate');
  h.render().decide('declined'); await running;
  assert.equal(h.render().state, 'done');
  assert.equal(h.render().steps.close, 'skipped');
  assert.equal(samples, 0); assert.equal(h.summaryCalls.length, 0);
  assert.equal(h.render().log.some(row => row.execution === 'workflow'), false);
  assert.equal(h.render().log.some(row => row.type === 'say' && row.step === 'close'), false);
  assert.equal(JSON.stringify(trace), before);
});

process.stdout.write(count + ' agent session transport and orchestration checks passed. No model or production request was made.\n');
