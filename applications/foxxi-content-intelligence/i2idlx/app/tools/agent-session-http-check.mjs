/**
 * Real loopback HTTP integration of the agent-session router and browser transport.
 * Run with Node 22+: node --experimental-strip-types <this file>.
 * The caller verifier and agent/model output below are explicit deterministic fixtures.
 * This does NOT verify a real signature, subscription, model provider or production deployment.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { setTimeout as pause } from 'node:timers/promises';
import { attachAgentSessionRoutes, AGENT_SESSION_PATH } from '../../../src/i2idlx-agent-sessions.ts';
import { createAgentSessionClient } from '../src/agent-session.js';

const FIXTURE_ACTOR = 'did:web:fixture.invalid:agents:http-integration';
const app = express();
app.use(express.json({ limit: '600kb' }));
const server = createServer(app);
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = 'http://127.0.0.1:' + address.port;
const store = attachAgentSessionRoutes(app, {
  baseUrl: base,
  verifyCaller: async (body, write) => {
    assert.equal(write, true);
    if (!body || body.fixture_verified !== true || !body.fixture_payload || body.fixture_actor !== FIXTURE_ACTOR) {
      return { ok: false, status: 401, error: 'Explicit loopback verifier fixture required.' };
    }
    return { ok: true, callerDid: FIXTURE_ACTOR, payload: body.fixture_payload };
  },
});

let created = null, driverToken = null, requestCount = 0;
const statuses = [], streams = [], pendingSamples = [];
const localFetch = async (input, options) => {
  assert.equal(new URL(input).origin, base, 'No external network access is permitted in this check.');
  requestCount++;
  const response = await fetch(input, options);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  if (new URL(input).pathname === AGENT_SESSION_PATH + '/create') created = await response.clone().json();
  return response;
};
const client = createAgentSessionClient({ fetch: localFetch, url: path => base + path, origin: () => base + '/', pollMs: 5, onState: state => statuses.push(state.state) });
async function driver(operation, extra = {}, expectedStatus = 200) {
  assert.ok(created);
  const payload = {
    i2idlx_operation: 'agent-session', bridge_audience: base, session_id: created.session_id,
    operation, ...(driverToken ? { driver_token: driverToken } : {}), ...extra,
  };
  const response = await localFetch(created.driver_url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fixture_verified: true, fixture_actor: FIXTURE_ACTOR, fixture_payload: payload }),
  });
  assert.equal(response.status, expectedStatus);
  const result = await response.json();
  if (operation === 'claim' && response.ok) driverToken = result.driver_token;
  return result;
}
async function nextTurn(previous = null) {
  const deadline = Date.now() + 3000;
  do {
    const result = await driver('next');
    if (result.state === 'running' && result.turn_id !== previous) return result;
    await pause(5);
  } while (Date.now() < deadline);
  assert.fail('The browser did not enqueue a new task before the local deadline.');
}
const update = (turn, extra = {}) => ({ turn_id: turn.turn_id, lease_id: turn.lease_id, revision: turn.revision, ...extra });
const samplePromise = promise => { pendingSamples.push(promise); promise.catch(() => {}); return promise; };
async function observedText(text) {
  const deadline = Date.now() + 3000;
  do { if (streams.includes(text)) return; await pause(5); } while (Date.now() < deadline);
  assert.fail('The browser onText callback did not receive a streamed HTTP snapshot.');
}

let toolExecutions = 0;
try {
  const invitation = await client.connect();
  assert.equal(client.status().state, 'waiting_for_agent');
  assert.equal(client.getSample(), null);
  assert.ok(invitation.includes('i2idlx_operation'));
  assert.ok(!invitation.includes(created.browser_token), 'The private browser capability must not enter the driver invitation.');

  // Unsigned requests and same-actor requests without the paired driver credential fail.
  const unsigned = await localFetch(created.driver_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unsigned.status, 401);
  const claim = await driver('claim', { invite_token: created.invite_token });
  assert.match(claim.driver_token, /^[a-f0-9]{64}$/);
  await driver('next', { driver_token: '0'.repeat(64) }, 403);
  await client.refresh();
  assert.equal(client.status().state, 'connected');
  const sample = client.getSample(); assert.equal(typeof sample, 'function');

  // First embedded question: actual HTTP streaming snapshots arrive in onText.
  const first = samplePromise(sample([{ role: 'user', content: 'Explain assessment using the selected reference.' }], { onText: ({ text }) => streams.push(text) }));
  const turn = await nextTurn();
  assert.equal(turn.task.messages[0].content, 'Explain assessment using the selected reference.');
  const partial = 'Assessment collects evidence';
  const emitted = await driver('emit', update(turn, { text: partial }));
  await observedText(partial);
  const answer = partial + ' about learning [[assessment]].';
  await driver('finish', update(turn, { revision: emitted.revision, text: answer }));
  assert.deepEqual(await first, { text: answer, truncated: false });
  assert.ok(streams.includes(answer));

  // Second question: agent proposes one advertised page tool; the browser runs the
  // real local function once and sends its actual result in a subsequent HTTP task.
  const tools = [{
    name: 'get_concept', description: 'Read the selected public glossary concept.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    execute: async args => {
      toolExecutions++; assert.deepEqual(args, { id: 'formative-assessment' });
      return { id: args.id, definition: 'Fixture source: assessment used during learning to inform improvement.', source: 'urn:fixture:glossary:assessment' };
    },
  }];
  const second = samplePromise(sample([{ role: 'user', content: 'Look up formative assessment, then explain it.' }], { tools, onText: ({ text }) => streams.push(text) }));
  const lookup = await nextTurn(turn.turn_id);
  assert.deepEqual(lookup.task.tools.map(t => t.name), ['get_concept']);
  assert.equal(lookup.task.tools[0].execute, undefined, 'Executable tool functions stay in the browser.');
  await driver('finish', update(lookup, { text: '', tool_calls: [{ id: 'lookup-1', name: 'get_concept', arguments: { id: 'formative-assessment' } }] }));
  const afterTool = await nextTurn(lookup.turn_id);
  assert.equal(toolExecutions, 1);
  const toolResult = afterTool.task.messages.at(-1).content;
  assert.ok(toolResult.includes('Actual page-tool results.'));
  assert.ok(toolResult.includes('Fixture source: assessment used during learning to inform improvement.'));
  assert.ok(toolResult.includes('urn:fixture:glossary:assessment'));
  const grounded = 'It uses assessment during learning to guide improvement [[formative-assessment]].';
  await driver('finish', update(afterTool, { text: grounded }));
  assert.deepEqual(await second, { text: grounded, truncated: false });

  // The original Orchestrate consumer supplies a plain prompt and zero-argument
  // tools without schemas. Its streaming and final text share one cumulative offset.
  let consumed = 0;
  const orchestration = samplePromise(sample('Inspect the next sandbox control.', {
    tools: [{ name: 'read_catalog', description: 'Read this sandbox catalog.', execute: args => {
      toolExecutions++; assert.deepEqual(args, {}); consumed = streams.at(-1).length;
      return { catalog: 'Actual local sandbox catalog fixture' };
    } }],
    onText: ({ text }) => streams.push(text),
  }));
  const catalog = await nextTurn(afterTool.turn_id);
  assert.deepEqual(catalog.task.messages, [{ role: 'user', content: 'Inspect the next sandbox control.' }]);
  assert.deepEqual(catalog.task.tools[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  const preamble = 'Inspecting the sandbox catalog.';
  const catalogStream = await driver('emit', update(catalog, { text: preamble }));
  await observedText(preamble);
  await driver('finish', update(catalog, { revision: catalogStream.revision, text: preamble, tool_calls: [{ id: 'catalog-1', name: 'read_catalog', arguments: {} }] }));
  const afterCatalog = await nextTurn(catalog.turn_id);
  assert.equal(toolExecutions, 2);
  assert.ok(afterCatalog.task.messages.at(-1).content.includes('Actual local sandbox catalog fixture'));
  const handoff = 'The next sandbox step can use the inspected catalog.';
  await driver('finish', update(afterCatalog, { text: handoff }));
  const completed = await orchestration;
  assert.deepEqual(completed, { text: preamble + '\n\n' + handoff, truncated: false });
  assert.equal(completed.text.slice(consumed).trim(), handoff);
  assert.ok(streams.includes(completed.text));

  // Cancellation goes through the actual browser HTTP path and becomes terminal.
  const controller = new AbortController();
  const aborted = samplePromise(sample([{ role: 'user', content: 'A request that I will stop.' }], { signal: controller.signal }));
  const cancelled = await nextTurn(afterCatalog.turn_id);
  controller.abort();
  await assert.rejects(aborted, error => error.code === 'cancelled');
  await driver('finish', update(cancelled, { text: 'A stale answer after cancellation.' }), 409);
  assert.equal(client.status().pending, false);
  assert.ok(statuses.includes('waiting_for_agent') && statuses.includes('connected'));
  await client.disconnect();
  assert.equal(client.status().state, 'disconnected');
  await driver('next', {}, 410);

  console.log(JSON.stringify({
    status: 'passed', transport: 'real loopback HTTP', browserClient: 'actual agent-session.js', router: 'actual attachAgentSessionRoutes',
    verifier: 'deterministic fixture; not cryptographic authentication', model: 'deterministic driver fixture; no subscription or provider called',
    checks: ['explicit pairing', 'unsigned and wrong driver capability refusal', 'streamed onText snapshots', 'final answer', 'advertised tool execution', 'actual tool-result round trip', 'plain orchestration prompts', 'zero-argument page tools', 'cumulative tool-round handoff offsets', 'cancellation', 'late finish refusal', 'disconnect revocation'],
    httpRequests: requestCount, streamedSnapshots: streams.length, executedPageTools: toolExecutions,
  }));
} finally {
  await client.disconnect().catch(() => {});
  await Promise.allSettled(pendingSamples);
  store.dispose();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
