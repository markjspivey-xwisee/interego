/**
 * The inference seam, against a fetch double: what is sent, what is read back, what is retried,
 * what is not, how long a call may take, and that the key never leaks — and how each failure
 * reaches a caller of the handlers, with nothing recorded. No network.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importWallet, sha256 } from '@interego/core';
import {
  anthropicTextModel, disclosureOf, resolveTextModel, scriptedTextModel, TextModelCallFailed,
  ANTHROPIC_API_VERSION, ANTHROPIC_MESSAGES_URL, type TextModel, type TextModelRequest,
} from '../src/model.js';
import { createPevHandlers, type PevDeps } from '../bridge/handlers.js';
import { demoScenarioInput, inMemoryPod } from '../demo/run.js';
import { PEV_ACTION } from '../src/ontology.js';
import { signEnvelope } from '../src/records.js';

const KEY = 'sk-test-SECRET-0123456789';
const REQ: TextModelRequest = { system: 'You speak as Sam.', messages: [{ role: 'user', content: 'Hello.' }], maxTokens: 200 };

interface Call { readonly url: string; readonly init: RequestInit; readonly body: Record<string, unknown> }
type Answer = Response | 'never' | Error;

/** A fetch double. 'never' honours the abort signal the way a real fetch does. */
function fakeProvider(answer: (n: number) => Answer): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const a = answer(calls.length);
    if (a instanceof Error) throw a;
    if (a === 'never') {
      return new Promise<Response>((_resolve, reject) => {
        const s = init?.signal;
        if (!s) return;
        if (s.aborted) { reject(s.reason); return; }
        s.addEventListener('abort', () => reject(s.reason), { once: true });
      });
    }
    return a;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (over: Record<string, unknown> = {}): Response => new Response(JSON.stringify({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-20261001',
  content: [{ type: 'text', text: 'Fine.' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 }, ...over,
}), { status: 200, headers: { 'content-type': 'application/json' } });

const providerError = (status: number, type: string, message: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', ...headers } });

async function failure(p: Promise<unknown>): Promise<TextModelCallFailed> {
  try { await p; } catch (e) {
    if (e instanceof TextModelCallFailed) return e;
    throw new Error(`expected TextModelCallFailed, got ${String(e)}`);
  }
  throw new Error('expected the call to fail');
}

describe('the Anthropic Messages request', () => {
  it('POSTs exactly model, max_tokens, system and messages, with the key, the API version and a JSON type', async () => {
    const { fetchImpl, calls } = fakeProvider(() => ok());
    await anthropicTextModel({ apiKey: KEY, model: 'claude-test', keySource: 'bridge-env', fetchImpl }).complete(REQ);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(c.init.method).toBe('POST');
    const headers = new Headers(c.init.headers);
    expect(headers.get('x-api-key')).toBe(KEY);
    expect(headers.get('anthropic-version')).toBe(ANTHROPIC_API_VERSION);
    expect(headers.get('content-type')).toBe('application/json');
    expect(Object.keys(c.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'system']);
    expect(c.body).toEqual({ model: 'claude-test', max_tokens: 200, system: 'You speak as Sam.', messages: [{ role: 'user', content: 'Hello.' }] });
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config', 'fallbacks']) expect(c.body).not.toHaveProperty(k);
  });

  it('reads text blocks only, the model the provider returned, measured usage and the stop details', async () => {
    const { fetchImpl } = fakeProvider(() => ok({
      content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' }],
      stop_reason: 'refusal', stop_details: { category: 'cyber' },
    }));
    const m = anthropicTextModel({ apiKey: KEY, model: 'claude-test', keySource: 'bridge-env', fetchImpl });
    const r = await m.complete(REQ);
    expect(r.text).toBe('First.\nSecond.');
    expect(r.model).toBe('claude-test-20261001');
    expect(m.requestedModel).toBe('claude-test');
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(r.stopReason).toBe('refusal');
    expect(r.stopCategory).toBe('cyber');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const d = disclosureOf(m, r, 'h'.repeat(64));
    expect(d).toMatchObject({ provider: 'anthropic', model: 'claude-test-20261001', requestedModel: 'claude-test', keySource: 'bridge-env', route: 'bridge-model', promptTemplateHash: 'h'.repeat(64) });
  });

  it('reports no usage when the provider did not measure it', async () => {
    const { fetchImpl } = fakeProvider(() => ok({ usage: { input_tokens: 5 } }));
    const r = await anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl }).complete(REQ);
    expect(r.usage).toBeUndefined();
  });

  it('throws when the provider names no model, so nothing is attributed to a guess', async () => {
    const { fetchImpl } = fakeProvider(() => ok({ model: undefined }));
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl }).complete(REQ));
    expect(e.message).toBe('the provider response named no model');
  });
});

describe('failures, retries and budgets', () => {
  it('does not retry a 4xx, and keeps the provider\'s words out of the message the retry classifier reads', async () => {
    for (const [status, type] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'], [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large']] as const) {
      const { fetchImpl, calls } = fakeProvider(() => providerError(status, type, 'prompt is too long: 512 tokens over the limit'));
      const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl, retryBaseMs: 1 }).complete(REQ));
      expect(calls, `HTTP ${status}`).toHaveLength(1);
      expect(e.status).toBe(status);
      expect(e.providerErrorType).toBe(type);
      expect(e.providerMessage).toContain(': 512 tokens');
      expect(e.message).toBe(`Anthropic Messages API answered ${status} (${type})`);
      expect(e.message).not.toContain('512');
      expect(e.timedOut).toBe(false);
    }
  });

  it('retries a 5xx and succeeds, and gives up after the attempts it was allowed', async () => {
    const flaky = fakeProvider((n) => (n === 1 ? providerError(500, 'api_error', 'boom') : ok()));
    const r = await anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl: flaky.fetchImpl, retryBaseMs: 1 }).complete(REQ);
    expect(r.text).toBe('Fine.');
    expect(flaky.calls).toHaveLength(2);
    const overloaded = fakeProvider(() => providerError(529, 'overloaded_error', 'busy'));
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl: overloaded.fetchImpl, retryBaseMs: 1 }).complete(REQ));
    expect(e.status).toBe(529);
    expect(overloaded.calls).toHaveLength(3);
  });

  it('does not retry a 429, and passes on when to try again', async () => {
    const { fetchImpl, calls } = fakeProvider(() => providerError(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }));
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl, retryBaseMs: 1 }).complete(REQ));
    expect(calls).toHaveLength(1);
    expect(e.status).toBe(429);
    expect(e.retryAfterSeconds).toBe(7);
  });

  it('retries a transient network failure, then reports it without the key', async () => {
    const { fetchImpl, calls } = fakeProvider(() => new TypeError(`fetch failed while sending ${KEY}`));
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl, retryBaseMs: 1 }).complete(REQ));
    expect(calls).toHaveLength(3);
    expect(e.providerErrorType).toBe('network');
    expect(e.message).not.toContain(KEY);
  });

  it('times out an attempt that never answers, once, without retrying it', async () => {
    const { fetchImpl, calls } = fakeProvider(() => 'never');
    const started = Date.now();
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl, retryBaseMs: 1 }).complete({ ...REQ, timeoutMs: 50 }));
    expect(e.timedOut).toBe(true);
    expect(e.message).toBe('Anthropic Messages API: no answer within 50 ms');
    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps the whole call, retries included, inside its budget', async () => {
    const slowBackoff = fakeProvider(() => providerError(500, 'api_error', 'boom'));
    const t0 = Date.now();
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl: slowBackoff.fetchImpl }).complete({ ...REQ, timeoutMs: 1000, budgetMs: 80 }));
    expect(e.status).toBe(500);
    expect(slowBackoff.calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(500);
    const quickBackoff = fakeProvider(() => providerError(500, 'api_error', 'boom'));
    const t1 = Date.now();
    await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl: quickBackoff.fetchImpl, retryBaseMs: 30 }).complete({ ...REQ, timeoutMs: 1000, budgetMs: 80 }));
    expect(quickBackoff.calls).toHaveLength(2);
    expect(Date.now() - t1).toBeLessThan(500);
    const hanging = fakeProvider(() => 'never');
    const e2 = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'bridge-env', fetchImpl: hanging.fetchImpl }).complete({ ...REQ, timeoutMs: 1000, budgetMs: 60 }));
    expect(e2.timedOut).toBe(true);
    expect(e2.message).toBe('Anthropic Messages API: no answer within 60 ms');
  });

  it('never puts the key in a message, a provider message or a result', async () => {
    const echoing = fakeProvider(() => providerError(401, 'authentication_error', `invalid x-api-key ${KEY}`));
    const e = await failure(anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'per-request-byok', fetchImpl: echoing.fetchImpl }).complete(REQ));
    expect(`${e.message} ${e.providerMessage ?? ''} ${e.stack ?? ''}`).not.toContain(KEY);
    const fine = fakeProvider(() => ok());
    const m = anthropicTextModel({ apiKey: KEY, model: 'm', keySource: 'per-request-byok', fetchImpl: fine.fetchImpl });
    const r = await m.complete(REQ);
    expect(JSON.stringify(r) + JSON.stringify(disclosureOf(m, r)) + JSON.stringify(m)).not.toContain(KEY);
  });
});

describe('the scripted fixture and route resolution', () => {
  it('discloses a scripted fixture as exactly that', async () => {
    const m = scriptedTextModel((req) => `echo: ${req.messages.length}`);
    const r = await m.complete(REQ);
    expect(r.text).toBe('echo: 1');
    expect(r.usage).toBeUndefined();
    expect(disclosureOf(m, r, 'p'.repeat(64))).toMatchObject({ provider: 'scripted', model: 'scripted-fixture', requestedModel: 'scripted-fixture', keySource: 'none', route: 'scripted', promptTemplateHash: 'p'.repeat(64) });
    expect(scriptedTextModel(() => '', { model: 'demo-judge' }).requestedModel).toBe('demo-judge');
  });

  it('uses a per-request key only with a per-request model, and otherwise the bridge model or none', async () => {
    const { fetchImpl, calls } = fakeProvider(() => ok());
    const byok = resolveTextModel(undefined, { llm_api_key: KEY, llm_model: 'claude-test' }, fetchImpl);
    expect('model' in byok).toBe(true);
    if (!('model' in byok)) return;
    expect(byok.model.keySource).toBe('per-request-byok');
    expect(byok.model.requestedModel).toBe('claude-test');
    await byok.model.complete(REQ);
    expect(calls).toHaveLength(1);
    expect(resolveTextModel(undefined, { llm_api_key: KEY }, fetchImpl)).toEqual({ bad: 'pass llm_model with llm_api_key: this bridge never picks a model for you' });
    expect('bad' in resolveTextModel(undefined, { llm_model: 'claude-test' })).toBe(true);
    expect(resolveTextModel(undefined, {})).toEqual({ none: true });
    const bridge = scriptedTextModel(() => 'x');
    expect(resolveTextModel(bridge, { llm_api_key: '  ' })).toEqual({ model: bridge });
  });
});

describe('the environment stays at the entrypoint', () => {
  it('no engine, handler, pod helper, UI module or demo reads the process environment', () => {
    const vertical = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = [
      ...readdirSync(join(vertical, 'src')).filter((f) => f.endsWith('.ts')).map((f) => join(vertical, 'src', f)),
      ...['bridge/handlers.ts', 'bridge/pod-helpers.ts', 'bridge/ui.ts', 'demo/run.ts'].map((f) => join(vertical, f)).filter((f) => existsSync(f)),
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);
    const needle = ['process', 'env'].join('.');
    expect(files.filter((f) => readFileSync(f, 'utf8').includes(needle))).toEqual([]);
  });
});

describe('a model failure reaches the caller as a status, and nothing is recorded', () => {
  const POD = 'https://pod.example.test/model-seam/';
  const pod = inMemoryPod();
  const w = (name: string): ReturnType<typeof importWallet> => importWallet(`0x${sha256(`pev-model-seam:${name}`)}`, 'human', name);
  const platform = w('platform');
  const admin = w('admin');
  const author = w('author');
  const learner = w('learner');
  let n = 0;
  const base: PevDeps = { platformWallet: platform, platformKeyKind: 'demo-fixture', adminAddresses: [admin.address], fetchFn: pod.fetchFn, defaultPodUrl: POD };
  const sign = async (who: ReturnType<typeof importWallet>, action: string, payload: Record<string, unknown>): Promise<{ payload: Record<string, unknown>; signature: string }> =>
    signEnvelope(who, { v: 1, action, issuedAt: new Date().toISOString(), nonce: `model-seam-nonce-${String(++n).padStart(6, '0')}`, podUrl: POD, ...payload });
  let attemptIri = '';
  const snapshot = (): string => JSON.stringify([...pod.store].sort());

  async function say(deps: Partial<PevDeps>, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const h = createPevHandlers({ ...base, ...deps });
    const envelope = await sign(learner, PEV_ACTION.say, { attemptIri, turnIndex: 1, text: 'Can we talk about Thursday?' });
    return await h['pev.say']!({ envelope, ...extra }) as Record<string, unknown>;
  }
  const bridgeModel = (answer: (n: number) => Response | 'never'): TextModel =>
    anthropicTextModel({ apiKey: KEY, model: 'claude-test', keySource: 'bridge-env', fetchImpl: fakeProvider(answer).fetchImpl, retryBaseMs: 1 });
  function refusedWith(r: Record<string, unknown>, status: number, code: string): void {
    expect(r['kind'], JSON.stringify(r).slice(0, 300)).toBe('refusal');
    expect([r['iep:refusalStatus'], r['iep:refusalReason']]).toEqual([status, code]);
    expect((r['disclosure'] as Record<string, unknown>)['requestedModel']).toBe('claude-test');
    expect(JSON.stringify(r)).not.toContain(KEY);
  }

  it('sets up an attempt in conversation on an in-memory pod', async () => {
    const h = createPevHandlers(base);
    for (const [who, role] of [[author, 'author']] as const) {
      const r = await h['pev.register_role']!({ envelope: await sign(admin, PEV_ACTION.registerRole, { address: who.address, role, change: 'add' }) }) as Record<string, unknown>;
      expect(r['recorded']).toBe(true);
    }
    const sc = await h['pev.author_scenario']!({ envelope: await sign(author, PEV_ACTION.authorScenario, {
      scenario: demoScenarioInput('missed-deadline'), status: 'published', draftAssistance: { used: false },
    }) }) as Record<string, unknown>;
    const st = await h['pev.start_attempt']!({ envelope: await sign(learner, PEV_ACTION.startAttempt, {
      scenarioIri: sc['scenarioIri'], scenarioVersion: 1, coached: false,
    }) }) as Record<string, unknown>;
    expect(st['state']).toBe('in-conversation');
    attemptIri = String(st['attemptIri']);
  }, 60_000);

  it('maps a per-request key\'s 404 to 400, and the bridge model\'s 404 to 503 for the operator', async () => {
    const before = snapshot();
    const byok = fakeProvider(() => providerError(404, 'not_found_error', 'model: claude-tset'));
    const r = await say({ byokFetch: byok.fetchImpl }, { llm_api_key: KEY, llm_model: 'claude-test' });
    refusedWith(r, 400, 'byok-request-not-accepted');
    expect(r['providerErrorType']).toBe('not_found_error');
    refusedWith(await say({ model: bridgeModel(() => providerError(404, 'not_found_error', 'model: claude-tset')) }), 503, 'bridge-model-misconfigured');
    expect(snapshot()).toBe(before);
  }, 60_000);

  it('maps billing, rate limits, refusals and cut-off answers, recording nothing', async () => {
    const before = snapshot();
    refusedWith(await say({ model: bridgeModel(() => providerError(402, 'billing_error', 'no credit')) }), 503, 'model-billing');
    const limited = await say({ model: bridgeModel(() => providerError(429, 'rate_limit_error', 'slow down', { 'retry-after': '9' })) });
    refusedWith(limited, 503, 'model-rate-limited');
    expect(limited['retryAfterSeconds']).toBe(9);
    refusedWith(await say({ model: bridgeModel(() => providerError(401, 'authentication_error', 'bad key')) }), 503, 'bridge-model-key-not-accepted');
    const declined = await say({ model: bridgeModel(() => ok({ stop_reason: 'refusal', stop_details: { category: 'cyber' } })) });
    refusedWith(declined, 502, 'model-declined');
    expect(declined['category']).toBe('cyber');
    refusedWith(await say({ model: bridgeModel(() => ok({ stop_reason: 'max_tokens' })) }), 502, 'model-output-cut-off');
    refusedWith(await say({ model: bridgeModel(() => providerError(500, 'api_error', 'boom')) }), 502, 'model-unreachable');
    expect(snapshot()).toBe(before);
  }, 60_000);

  it('maps a timeout to 502 with the limit, and an empty line with no end signal to 502', async () => {
    const before = snapshot();
    const t = await say({ model: bridgeModel(() => 'never'), modelTimeouts: { counterpart: { timeoutMs: 50, budgetMs: 200 } } });
    refusedWith(t, 502, 'model-unreachable');
    expect([t['timedOut'], t['timeoutMs']]).toEqual([true, 50]);
    const empty = await say({ model: bridgeModel(() => ok({ content: [{ type: 'text', text: '   ' }] })) });
    refusedWith(empty, 502, 'model-output-empty');
    expect((empty['disclosure'] as Record<string, unknown>)['model']).toBe('claude-test-20261001');
    expect(snapshot()).toBe(before);
  }, 60_000);
});
