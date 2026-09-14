/**
 * Optional client-side interpreter for data-only, read-only procedures.
 * The host supplies its authenticated Interego MCP transport. No LLM, network,
 * endpoint construction, evaluation of document code, or write capability lives here.
 */
export const SCHEMA = 'interego.read-procedure/v1';
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const OPS = new Set(['read', 'check', 'select', 'pick', 'project', 'follow', 'expect', 'output']);

function fail(message) { throw new Error(message); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function validateJson(value, depth = 0) {
  if (depth > 40) fail('Document nesting limit exceeded');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) validateJson(item, depth + 1); return; }
  if (!plain(value)) fail('Only JSON data is supported');
  for (const [key, item] of Object.entries(value)) {
    if (BAD_KEYS.has(key)) fail('Unsafe object key');
    validateJson(item, depth + 1);
  }
}
function pointer(root, path) {
  if (path === '') return root;
  if (typeof path !== 'string' || !path.startsWith('/')) fail('Expected a JSON Pointer');
  let value = root;
  for (const raw of path.slice(1).split('/')) {
    if (/~(?![01])/u.test(raw)) fail('Invalid JSON Pointer escape');
    const key = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (BAD_KEYS.has(key) || value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      fail(`Missing declared binding: ${path}`);
    }
    value = value[key];
  }
  return value;
}
function resolve(value, state) {
  if (plain(value) && Object.hasOwn(value, '$ref')) {
    if (Object.keys(value).length !== 1) fail('A binding must contain only $ref');
    return pointer(state, value.$ref);
  }
  if (Array.isArray(value)) return value.map(item => resolve(item, state));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, state)]));
  return value;
}
function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (plain(a) && plain(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}
function condition(test, state) {
  if (!plain(test)) fail('Invalid condition');
  if (test.op === 'eq') return equal(resolve(test.left, state), resolve(test.right, state));
  if (test.op === 'nonempty') {
    const value = resolve(test.value, state);
    return (typeof value === 'string' || Array.isArray(value)) && value.length > 0;
  }
  if (test.op === 'all') {
    const values = resolve(test.values, state);
    return Array.isArray(values) && values.length > 0 && values.every(item => condition(test.test, { ...state, item }));
  }
  if (test.op === 'and') return Array.isArray(test.tests) && test.tests.length > 0 && test.tests.every(t => condition(t, state));
  fail('Unsupported condition');
}

export function validateProcedure(procedure) {
  validateJson(procedure);
  if (procedure.schema !== SCHEMA || typeof procedure.id !== 'string' || !procedure.id) fail('Invalid procedure identity');
  if (!Array.isArray(procedure.steps) || !procedure.steps.length || procedure.steps.length > 64) fail('Expected 1–64 steps');
  const ids = new Set();
  for (const step of procedure.steps) {
    if (!plain(step) || !/^[a-z][a-z0-9-]{0,63}$/u.test(step.id) || ids.has(step.id) || !OPS.has(step.op)) fail('Invalid or duplicate step');
    ids.add(step.id);
    if (step.op === 'read' && !['get_current_head', 'get_descriptor', 'dereference'].includes(step.tool)) fail('Read capability refused');
    if (step.op === 'follow' && Object.hasOwn(step, 'payload')) fail('This runner follows GET controls with empty payload only');
  }
  if (procedure.steps.at(-1).op !== 'output') fail('The final step must be output');
  return procedure;
}

export function unpackMcp(result) {
  if (!plain(result) || result.isError === true) fail('MCP returned an error');
  if (plain(result.structuredContent)) return result.structuredContent;
  const blocks = result.content?.filter(b => b.type === 'text');
  if (blocks?.length !== 1) fail('No unambiguous structured MCP result');
  const data = JSON.parse(blocks[0].text);
  if (!plain(data)) fail('MCP result must be an object');
  return data;
}

/**
 * onEvent must persist privately and finish before each dispatch. A transport
 * exception stops the run; this interpreter never retries an unknown outcome.
 * A needs-decision result is terminal. After review, start again with explicit
 * inputs; do not edit a cursor or reuse stale read results to bypass checks.
 */
export async function runProcedure(procedure, input, { call, onEvent, project, now = () => Date.now(), maxCalls = 16 }) {
  validateProcedure(procedure);
  validateJson(input);
  if (typeof call !== 'function' || typeof onEvent !== 'function') fail('Transport and durable recorder are required');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 64) fail('Invalid call budget');
  const state = { input: JSON.parse(JSON.stringify(input)), steps: {} };
  const selected = new Map();
  const started = now();
  const metrics = { interegoCalls: 0, failedCalls: 0, automaticSteps: 0, modelInvocations: 0, modelHandoffs: 0, toolElapsedMs: 0 };
  let current;
  const event = async data => onEvent({ procedureId: procedure.id, atMs: now(), ...data });
  const invoke = async (tool, args) => {
    if (metrics.interegoCalls >= maxCalls) fail('Call budget exhausted');
    const number = metrics.interegoCalls + 1;
    await event({ type: 'intent', step: current.id, number, tool, args });
    metrics.interegoCalls++;
    const at = now();
    let raw;
    try { raw = await call(tool, args); }
    catch (error) {
      metrics.failedCalls++;
      metrics.toolElapsedMs += Math.max(0, now() - at);
      await event({ type: 'transport-error', step: current.id, number, message: String(error?.message ?? error) });
      fail('Transport failed; no automatic retry');
    }
    metrics.toolElapsedMs += Math.max(0, now() - at);
    await event({ type: 'outcome', step: current.id, number, raw });
    try { return unpackMcp(raw); }
    catch (error) { metrics.failedCalls++; throw error; }
  };
  const finish = async (status, data) => {
    if (status === 'needs-decision') metrics.modelHandoffs++;
    const result = { schema: 'interego.read-procedure.result/v1', procedureId: procedure.id,
      status, ...data, metrics: { ...metrics, elapsedMs: Math.max(0, now() - started),
        providerInferenceCalls: null, tokens: null, monetaryCost: null } };
    await event({ type: 'result', result });
    return result;
  };
  for (current of procedure.steps) {
    try {
      await event({ type: 'step', step: current.id, operation: current.op });
      if (current.op === 'read') {
        const args = resolve(current.args, state);
        if (!plain(args)) fail('Read arguments must be an object');
        state.steps[current.id] = await invoke(current.tool, args);
        if (current.tool === 'dereference' && state.steps[current.id].status !== 'ok') {
          metrics.failedCalls++;
          fail('Linked resource is unavailable; resolve access or availability before continuing');
        }
      } else if (current.op === 'project') {
        if (typeof project !== 'function') fail('The host has no installed representation projector');
        state.steps[current.id] = await project(current.format, resolve(current.from, state));
      } else if (current.op === 'check') {
        if (!condition(current.test, state)) return finish('blocked', { step: current.id, reason: current.reason ?? 'Required check failed' });
      } else if (current.op === 'expect') {
        if (!condition(current.test, state)) return finish('needs-decision', {
          step: current.id, reason: current.reason ?? 'Expectation changed', observation: resolve(current.observation, state),
          restart: 'Review the observation and start a new run with explicit inputs. All discovery and checks run again.' });
      } else if (current.op === 'select' || current.op === 'pick') {
        if (!plain(current.from) || typeof current.from.$ref !== 'string') fail('Controls must come from a discovered read result');
        const source = current.from.$ref.split('/');
        const sourceStep = procedure.steps.find(s => s.id === source[2]);
        if (source[1] !== 'steps' || !['read', 'follow', 'project'].includes(sourceStep?.op)) fail('Selection must come from discovered data');
        const candidates = resolve(current.from, state);
        if (!Array.isArray(candidates)) fail('Control collection is missing');
        const matches = candidates.filter(item => condition(current.test, { ...state, item }));
        if (matches.length !== 1) fail('Control selection is missing or ambiguous');
        const control = matches[0];
        if (current.op === 'pick') {
          state.steps[current.id] = control;
          metrics.automaticSteps++;
          continue;
        }
        if (control.method !== 'GET' || control.executable !== true || typeof control.descriptorUrl !== 'string'
            || !control.descriptorUrl || typeof control.action !== 'string' || !control.action
            || !Array.isArray(control.fields) || control.fields.length !== 0) fail('Only executable, input-free GET controls are allowed');
        state.steps[current.id] = control;
        selected.set(current.id, control);
      } else if (current.op === 'follow') {
        const control = selected.get(current.control);
        if (!control) fail('The action must come from a previously selected discovered control');
        const response = await invoke('act', { descriptor_url: control.descriptorUrl, action_iri: control.action, payload: {} });
        if (response.status !== 200) { metrics.failedCalls++; fail('Read control did not return HTTP 200'); }
        if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/iu.test(response.contentType ?? '')) fail('Read control returned a non-JSON representation');
        const body = JSON.parse(response.body);
        validateJson(body);
        state.steps[current.id] = body;
      } else if (current.op === 'output') {
        metrics.automaticSteps++;
        return finish('completed', { output: resolve(current.value, state) });
      }
      metrics.automaticSteps++;
    } catch (error) {
      return finish('needs-decision', { step: current.id, reason: String(error?.message ?? error),
        restart: 'Review the failure and restart discovery. No automatic retry occurred.' });
    }
  }
  fail('No output reached');
}
