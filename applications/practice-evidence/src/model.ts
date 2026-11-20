/**
 * The inference seam: how this vertical asks a text model for the other person's line, a judgment
 * or a scenario draft, and what it records about the call.
 *
 * No environment reads here. The bridge entrypoint decides the route (DECISIONS #6) and hands a
 * `TextModel` in; a per-request key (BYOK) is resolved per call by `resolveTextModel` and used once.
 *
 * What this module promises:
 *   · The operator picks the model. There is no fallback model and no silent degradation: a call
 *     that fails, times out, is declined or is cut off is reported, never rerouted.
 *   · The disclosure names the model the PROVIDER says ran (`data.model`), next to the one that was
 *     requested, so a judgment is attributed to what actually produced it.
 *   · Usage is reported only when the provider measured it. Nothing is estimated.
 *   · The API key never appears in a message, a result, a record or a log line.
 *   · A timeout is not retried (its message matches none of the substrate's transient patterns),
 *     and the whole call — retries included — stays inside its budget.
 *
 * Two providers are spoken to: Anthropic's Messages API and OpenAI's Responses API. Which one the
 * bridge's own model is, is the operator's to say, with the model. A per-request key is used with
 * Anthropic's.
 */
import { withTransientRetry } from '@interego/core';

/** Where the key that paid for a call came from (foxxi's spelling, not a new one). */
export type LlmKeySource = 'none' | 'bridge-env' | 'per-request-byok' | 'mcp-client';
/** Which route produced a turn or a judgment. */
export type InferenceRoute = 'bridge-model' | 'scripted' | 'client-packet';

export interface TextMessage { readonly role: 'user' | 'assistant'; readonly content: string }

export interface TextModelRequest {
  readonly system: string;
  readonly messages: readonly TextMessage[];
  readonly maxTokens: number;
  /** Per HTTP attempt. */
  readonly timeoutMs?: number;
  /** The whole call, retries included. */
  readonly budgetMs?: number;
}

export interface TextModelResult {
  readonly text: string;
  /** The model id as the provider returned it. */
  readonly model: string;
  readonly stopReason: string | null;
  readonly stopCategory?: string | null;
  /** Present only when the provider measured both numbers. */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs: number;
}

export interface TextModel {
  readonly provider: string;
  readonly requestedModel: string;
  readonly keySource: LlmKeySource;
  readonly route: InferenceRoute;
  complete(req: TextModelRequest): Promise<TextModelResult>;
}

/** What every generated turn, judgment and draft records about the inference behind it. */
export interface InferenceDisclosure {
  readonly provider: string;
  readonly model: string;
  readonly requestedModel?: string;
  readonly keySource: LlmKeySource;
  readonly route: InferenceRoute;
  readonly promptTemplateHash?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly latencyMs?: number;
  readonly stopReason?: string | null;
  /** The did that declared this disclosure (packet route only: declared, not measured). */
  readonly declaredBy?: string;
}

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_API_VERSION = '2026-10-21';
export const COUNTERPART_TIMEOUTS = { timeoutMs: 90_000, budgetMs: 180_000 } as const;
export const JUDGE_TIMEOUTS = { timeoutMs: 150_000, budgetMs: 300_000 } as const;
export const DRAFT_TIMEOUTS = { timeoutMs: 150_000, budgetMs: 300_000 } as const;

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_BUDGET_MS = 180_000;

/**
 * A model call that did not produce a usable answer. `status` is the provider's HTTP status when
 * there was one. The provider's own words go in `providerMessage` (≤ 200 chars) and never in
 * `.message`: the substrate's retry classifier reads `.message`, and a 400 whose text happened to
 * say ": 512 tokens" would otherwise be retried as a 5xx.
 */
export class TextModelCallFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly providerErrorType: string | null,
    readonly retryAfterSeconds: number | null,
    readonly providerMessage: string | null,
    readonly timedOut: boolean = false,
  ) {
    super(message);
    this.name = 'TextModelCallFailed';
  }
}

/**
 * Raised inside the retry wrapper when the budget cannot cover another attempt. Its message is
 * deliberately not transient, so `withTransientRetry` stops at once; `complete()` then rethrows the
 * upstream failure it carries.
 */
class BudgetSpent extends Error {
  constructor(readonly last: TextModelCallFailed, api: string) {
    super(`${api}: budget spent before another attempt could start`);
    this.name = 'BudgetSpent';
  }
}

function isAbortLike(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function scrubber(apiKey: string): (s: string) => string {
  return (s: string): string => (apiKey.length > 0 ? s.split(apiKey).join('[key]') : s);
}

interface ProviderError { readonly type: string | null; readonly message: string | null }

function providerErrorOf(text: string): ProviderError {
  try {
    const j = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    const type = typeof j.error?.type === 'string' ? j.error.type : null;
    const message = typeof j.error?.message === 'string' ? j.error.message : null;
    return { type, message };
  } catch {
    return { type: null, message: text.length > 0 ? text : null };
  }
}

function retryAfterOf(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (h === null) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(h);
  if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

/**
 * One call to a provider's HTTP API: what both providers below share. It posts `body` once per
 * attempt, retries what the substrate's classifier calls transient (a 5xx, a dropped connection),
 * never a timeout and never a 4xx, and keeps the whole call inside its budget. It answers the
 * parsed JSON of a 2xx, and throws `TextModelCallFailed` for everything else. `api` is the
 * provider API's name as it reads in a failure's message.
 */
async function postToProvider<T>(o: {
  api: string; url: string; headers: Record<string, string>; body: string; apiKey: string;
  fetchImpl: typeof fetch; maxAttempts: number; baseMs: number; started: number; timeoutMs: number; budgetMs: number;
}): Promise<T> {
  const { api, started, timeoutMs, budgetMs, maxAttempts, baseMs } = o;
  const scrub = scrubber(o.apiKey);
  const timeoutFailure = (ms: number): TextModelCallFailed => new TextModelCallFailed(`${api}: no answer within ${ms} ms`, null, 'timeout', null, null, true);
  const overall = AbortSignal.timeout(budgetMs);
  let attemptNo = 0;

  const attempt = async (): Promise<T> => {
    attemptNo += 1;
    if (overall.aborted || Date.now() - started >= budgetMs) throw timeoutFailure(budgetMs);
    let res: Response;
    let text: string;
    try {
      res = await o.fetchImpl(o.url, {
        method: 'POST',
        headers: o.headers,
        body: o.body,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), overall]),
      });
      text = await res.text();
    } catch (e) {
      if (isAbortLike(e)) throw timeoutFailure(overall.aborted ? budgetMs : timeoutMs);
      // A network failure: the substrate classifier decides whether it is transient. The
      // message is scrubbed in case a transport echoed a header.
      if (e instanceof Error) e.message = scrub(e.message);
      throw e;
    }
    if (!res.ok) {
      const pe = providerErrorOf(text);
      const providerMessage = pe.message === null ? null : scrub(pe.message).slice(0, 200);
      const type = pe.type ?? 'unknown';
      if (res.status >= 500) {
        const failure = new TextModelCallFailed(`${api}: HTTP ${res.status} ${type}`, res.status, pe.type, null, providerMessage);
        // Another attempt only if the budget can still cover the backoff that precedes it.
        const nextBackoff = baseMs * Math.pow(2, attemptNo - 1);
        if (attemptNo < maxAttempts && Date.now() - started + nextBackoff >= budgetMs) throw new BudgetSpent(failure, api);
        throw failure;
      }
      throw new TextModelCallFailed(
        `${api} answered ${res.status} (${type})`, res.status, pe.type,
        res.status === 429 ? retryAfterOf(res) : null, providerMessage,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TextModelCallFailed('the provider answered with a body that is not JSON', res.status, null, null, null);
    }
  };

  try {
    return await withTransientRetry(attempt, { maxAttempts, baseMs });
  } catch (e) {
    if (e instanceof BudgetSpent) throw e.last;
    if (e instanceof TextModelCallFailed) throw e;
    const msg = e instanceof Error ? scrub(e.message) : 'unknown failure';
    throw new TextModelCallFailed(`${api}: could not connect (${msg.slice(0, 160)})`, null, 'network', null, null);
  }
}

interface MessagesResponse {
  readonly model?: unknown;
  readonly content?: unknown;
  readonly stop_reason?: unknown;
  readonly stop_details?: { readonly category?: unknown } | null;
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown } | null;
}

/**
 * The Anthropic Messages API over raw fetch. The body is exactly `{model, max_tokens, system,
 * messages}`: no sampling parameters, no thinking, no fallbacks, because the operator chose the
 * model and the record must name what ran.
 */
export function anthropicTextModel(o: {
  apiKey: string; model: string; keySource: 'bridge-env' | 'per-request-byok';
  fetchImpl?: typeof fetch; retryBaseMs?: number; maxAttempts?: number;
}): TextModel {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    provider: 'anthropic',
    requestedModel: o.model,
    keySource: o.keySource,
    route: 'bridge-model',
    async complete(req: TextModelRequest): Promise<TextModelResult> {
      const started = Date.now();
      const data = await postToProvider<MessagesResponse>({
        api: 'Anthropic Messages API', url: ANTHROPIC_MESSAGES_URL, apiKey: o.apiKey, fetchImpl,
        headers: { 'content-type': 'application/json', 'x-api-key': o.apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
        body: JSON.stringify({
          model: o.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        maxAttempts: o.maxAttempts ?? 3, baseMs: o.retryBaseMs ?? 1000,
        started, timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, budgetMs: req.budgetMs ?? DEFAULT_BUDGET_MS,
      });

      if (typeof data.model !== 'string' || data.model.length === 0) {
        throw new TextModelCallFailed('the provider response named no model', null, 'response-shape', null, null);
      }
      const blocks = Array.isArray(data.content) ? data.content as unknown[] : [];
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
          && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text)
        .join('\n');
      const inputTokens = data.usage?.input_tokens;
      const outputTokens = data.usage?.output_tokens;
      const usage = typeof inputTokens === 'number' && typeof outputTokens === 'number'
        ? { inputTokens, outputTokens } : undefined;
      const category = data.stop_details?.category;
      return {
        text,
        model: data.model,
        stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : null,
        stopCategory: typeof category === 'string' ? category : null,
        ...(usage ? { usage } : {}),
        latencyMs: Date.now() - started,
      };
    },
  };
}

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

interface ResponsesResponse {
  readonly model?: unknown;
  readonly status?: unknown;
  readonly incomplete_details?: { readonly reason?: unknown } | null;
  readonly output?: unknown;
  readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown } | null;
}

/**
 * OpenAI's Responses API over raw fetch, as its reference gave it on 2026-11-20. The body is
 * exactly `{model, instructions, input, max_output_tokens, store: false}`: the system text as
 * `instructions`, the conversation as `input`, no sampling or reasoning parameters, no tools and
 * no fallback, for the reason the Anthropic body has none. `store: false` asks the provider not to
 * keep the response for later retrieval, which it otherwise does by default; what a learner said
 * is in it.
 *
 * What is read back: the text of every `output_text` part of every `message` item that is not
 * itself unfinished, in order; the model the provider names; usage when it measured both numbers.
 *
 * A 200 is not an answer. The response says in `status` whether it is one, and text is taken as
 * the model's answer only from a response that is `completed`. Two other endings are reported in
 * the words the handlers already act on, and they record nothing for either:
 *   · `max_tokens` when the response is `incomplete` for `max_output_tokens`. That cap counts the
 *     model's reasoning tokens as well as its answer, so a model that reasons can spend it before
 *     it writes anything.
 *   · `refusal` when the response is `incomplete` for `content_filter` (the category says so), or
 *     when a completed response holds a `refusal` part and no text.
 * Every other state (`failed`, `cancelled`, `in_progress`, `queued`, `incomplete` for any other
 * reason, a status this code does not know, or none) is a failed call, whatever text came with
 * it: `TextModelCallFailed`, type `response-not-completed`, which the handlers answer as the model
 * not having been reached. Found in review of this function's first form (2026-11-20), which
 * returned such text for the caller to record.
 */
export function openAiTextModel(o: {
  apiKey: string; model: string; keySource: 'bridge-env' | 'per-request-byok';
  fetchImpl?: typeof fetch; retryBaseMs?: number; maxAttempts?: number;
}): TextModel {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    provider: 'openai',
    requestedModel: o.model,
    keySource: o.keySource,
    route: 'bridge-model',
    async complete(req: TextModelRequest): Promise<TextModelResult> {
      const started = Date.now();
      const data = await postToProvider<ResponsesResponse>({
        api: 'OpenAI Responses API', url: OPENAI_RESPONSES_URL, apiKey: o.apiKey, fetchImpl,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({
          model: o.model,
          instructions: req.system,
          input: req.messages.map((m) => ({ role: m.role, content: m.content })),
          max_output_tokens: req.maxTokens,
          store: false,
        }),
        maxAttempts: o.maxAttempts ?? 3, baseMs: o.retryBaseMs ?? 1000,
        started, timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, budgetMs: req.budgetMs ?? DEFAULT_BUDGET_MS,
      });

      if (typeof data.model !== 'string' || data.model.length === 0) {
        throw new TextModelCallFailed('the provider response named no model', null, 'response-shape', null, null);
      }
      const parts: { type?: unknown; text?: unknown }[] = [];
      for (const item of Array.isArray(data.output) ? data.output as unknown[] : []) {
        const it = item as { type?: unknown; content?: unknown; status?: unknown } | null;
        if (it === null || typeof it !== 'object' || it.type !== 'message' || !Array.isArray(it.content)) continue;
        // An item says its own state when it has one; one that is not completed is not part of the answer.
        if (it.status !== undefined && it.status !== 'completed') continue;
        for (const part of it.content as unknown[]) if (typeof part === 'object' && part !== null) parts.push(part as { type?: unknown; text?: unknown });
      }
      const text = parts.filter((p): p is { type: 'output_text'; text: string } => p.type === 'output_text' && typeof p.text === 'string').map((p) => p.text).join('\n');
      const declined = parts.some((p) => p.type === 'refusal');
      const status = typeof data.status === 'string' ? data.status : null;
      const why = typeof data.incomplete_details?.reason === 'string' ? data.incomplete_details.reason : null;
      const filtered = status === 'incomplete' && why === 'content_filter';
      const cutOff = status === 'incomplete' && why === 'max_output_tokens';
      if (status !== 'completed' && !filtered && !cutOff) {
        // Its state is named only when it is one of the provider's own words: nothing of the body is echoed.
        const known = ['failed', 'cancelled', 'in_progress', 'queued', 'incomplete'].includes(status ?? '') ? status : 'not one this bridge knows';
        throw new TextModelCallFailed(`OpenAI Responses API: the response is ${status === null ? 'in no stated state' : known}, not completed`, null, 'response-not-completed', null, null);
      }
      const stopReason = cutOff ? 'max_tokens' : filtered || (declined && text.length === 0) ? 'refusal' : 'completed';
      const inputTokens = data.usage?.input_tokens;
      const outputTokens = data.usage?.output_tokens;
      const usage = typeof inputTokens === 'number' && typeof outputTokens === 'number'
        ? { inputTokens, outputTokens } : undefined;
      return {
        text,
        model: data.model,
        stopReason,
        stopCategory: filtered ? 'content_filter' : null,
        ...(usage ? { usage } : {}),
        latencyMs: Date.now() - started,
      };
    },
  };
}

/**
 * A scripted fixture for tests and the offline demo. It is disclosed as exactly that — provider
 * `scripted`, key source `none`, route `scripted` — on every turn and judgment it produces. The
 * bridge entrypoint never constructs one.
 */
export function scriptedTextModel(script: (req: TextModelRequest) => string, o: { model?: string } = {}): TextModel {
  const model = o.model ?? 'scripted-fixture';
  return {
    provider: 'scripted',
    requestedModel: model,
    keySource: 'none',
    route: 'scripted',
    async complete(req: TextModelRequest): Promise<TextModelResult> {
      const started = Date.now();
      const text = script(req);
      return { text, model, stopReason: null, latencyMs: Date.now() - started };
    },
  };
}

/** The disclosure recorded beside a model's output. */
export function disclosureOf(m: TextModel, r: TextModelResult, promptTemplateHash?: string): InferenceDisclosure {
  return {
    provider: m.provider,
    model: r.model,
    requestedModel: m.requestedModel,
    keySource: m.keySource,
    route: m.route,
    ...(promptTemplateHash !== undefined ? { promptTemplateHash } : {}),
    ...(r.usage ? { usage: r.usage } : {}),
    latencyMs: r.latencyMs,
    stopReason: r.stopReason,
  };
}

/** The disclosure of a call that was made but whose output is not recorded (for refusals after a model call). */
export function attemptedDisclosure(m: TextModel, r?: TextModelResult): InferenceDisclosure {
  return {
    provider: m.provider,
    model: r?.model ?? m.requestedModel,
    requestedModel: m.requestedModel,
    keySource: m.keySource,
    route: m.route,
    ...(r?.usage ? { usage: r.usage } : {}),
    ...(r ? { latencyMs: r.latencyMs, stopReason: r.stopReason } : {}),
  };
}

/**
 * Which model this one call uses. A per-request key needs a per-request model: the bridge never
 * picks a model for the caller.
 */
export function resolveTextModel(
  bridgeModel: TextModel | undefined,
  args: Record<string, unknown>,
  byokFetch?: typeof fetch,
): { readonly model: TextModel } | { readonly none: true } | { readonly bad: string } {
  const key = typeof args['llm_api_key'] === 'string' ? args['llm_api_key'].trim() : '';
  const model = typeof args['llm_model'] === 'string' ? args['llm_model'].trim() : '';
  if (key.length > 0 && model.length > 0) {
    return { model: anthropicTextModel({ apiKey: key, model, keySource: 'per-request-byok', ...(byokFetch ? { fetchImpl: byokFetch } : {}) }) };
  }
  if (key.length > 0 || model.length > 0) {
    return { bad: 'pass llm_model with llm_api_key: this bridge never picks a model for you' };
  }
  return bridgeModel ? { model: bridgeModel } : { none: true };
}
