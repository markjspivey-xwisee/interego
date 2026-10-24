/** One fixed, read-only volume measurement between a collector and its parent. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const REQUEST = 'pgsl-collector-headroom-request';
const RESPONSE = 'pgsl-collector-headroom-response';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_WAIT_MS = 10_000;

function failure() {
  const error = new Error('refusing rebuild: fresh verified volume headroom is unavailable');
  error.name = 'CollectorHeadroomIpcError';
  return error;
}

function keys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validSample(value, startedAt, now) {
  return keys(value, ['capacityBytes', 'usedBytes', 'sampledAt'])
    && [value.capacityBytes, value.usedBytes, value.sampledAt, startedAt, now].every(Number.isSafeInteger)
    && value.capacityBytes > 0 && value.usedBytes >= 0 && value.usedBytes <= value.capacityBytes
    && value.sampledAt >= startedAt && value.sampledAt <= now && now - value.sampledAt <= MAX_WAIT_MS;
}

function waitBudget(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw failure();
  return timeoutMs;
}

/**
 * No environment fallback: an IPC failure must prevent the optional rebuild.
 * @returns {Promise<{capacityBytes: number, usedBytes: number, sampledAt: number}>}
 */
export function requestFreshCollectorHeadroom({ channel = process, now = Date.now, timeoutMs = MAX_WAIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let wait;
    try { wait = waitBudget(timeoutMs); } catch { reject(failure()); return; }
    if (typeof channel.send !== 'function' || channel.connected !== true) { reject(failure()); return; }
    const requestId = randomUUID(), startedAt = now(), deadline = performance.now() + wait;
    let settled = false, timer;
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeListener('message', onMessage);
      channel.removeListener('disconnect', onUnavailable);
      channel.removeListener('error', onUnavailable);
      // Adding a message listener references a child's IPC channel. After this
      // exchange it must not keep an otherwise finished collector alive.
      channel.channel?.unref?.();
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (value) resolve(value); else reject(failure());
    };
    const onUnavailable = () => finish();
    const onMessage = (message) => {
      if (message?.kind !== RESPONSE || message.requestId !== requestId) return;
      if (performance.now() >= deadline || !keys(message, message.ok === true
        ? ['kind', 'requestId', 'ok', 'headroom'] : ['kind', 'requestId', 'ok'])
        || message.ok !== true || !validSample(message.headroom, startedAt, now())) { finish(); return; }
      finish({ ...message.headroom });
    };
    channel.on('message', onMessage);
    channel.on('disconnect', onUnavailable);
    channel.on('error', onUnavailable);
    timer = setTimeout(onUnavailable, wait);
    try { channel.send({ kind: REQUEST, requestId }, error => { if (error) finish(); }); }
    catch { finish(); }
  });
}

/**
 * The measurement closes over the already resolved project/environment/service.
 * No selector, query, token, or platform error crosses this IPC channel. A
 * collector process has at most one optional rebuild and one accepted request.
 */
export function attachCollectorHeadroomProvider(child, measure, { now = Date.now, timeoutMs = MAX_WAIT_MS } = {}) {
  const wait = waitBudget(timeoutMs);
  let closed = false, accepted = false, timer;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    child.removeListener('message', onMessage);
    for (const event of ['exit', 'close', 'disconnect', 'error']) child.removeListener(event, close);
  };
  const onMessage = (message) => {
    if (closed || accepted || !keys(message, ['kind', 'requestId']) || message.kind !== REQUEST
      || typeof message.requestId !== 'string' || !UUID.test(message.requestId)) return;
    accepted = true;
    const requestId = message.requestId, startedAt = now(), deadline = performance.now() + wait;
    let answered = false;
    const respond = (headroom) => {
      if (closed || answered) return;
      answered = true;
      clearTimeout(timer);
      if (child.connected !== true) { close(); return; }
      const ok = performance.now() < deadline && validSample(headroom, startedAt, now());
      const reply = ok ? { kind: RESPONSE, requestId, ok: true, headroom: { ...headroom } }
        : { kind: RESPONSE, requestId, ok: false };
      try { child.send(reply, () => {}); } catch { /* Never expose platform or channel errors. */ }
      close();
    };
    timer = setTimeout(() => respond(), wait);
    timer.unref?.();
    Promise.resolve().then(() => { if (!closed) return measure(); }).then(respond, () => respond());
  };
  child.on('message', onMessage);
  for (const event of ['exit', 'close', 'disconnect', 'error']) child.on(event, close);
  return close;
}
