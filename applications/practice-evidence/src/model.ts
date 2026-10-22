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
  constructor(readonly last: TextModelCallFailed) {
    super('Anthropic Messages API: budget spent before another attempt could start');
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

function timeoutFailure(ms: number): TextModelCallFailed {
  return new TextModelCallFailed(`Anthropic Messages API: no answer within ${ms} ms`, null, 'timeout', null, null, true);
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
  const scrub = scrubber(o.apiKey);
  const maxAttempts = o.maxAttempts ?? 3;
  const baseMs = o.retryBaseMs ?? 1000;
  return {
    provider: 'anthropic',
    requestedModel: o.model,
    keySource: o.keySource,
    route: 'bridge-model',
    async complete(req: TextModelRequest): Promise<TextModelResult> {
      const started = Date.now();
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const budgetMs = req.budgetMs ?? DEFAULT_BUDGET_MS;
      const overall = AbortSignal.timeout(budgetMs);
      const body = JSON.stringify({
        model: o.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      let attemptNo = 0;

      const attempt = async (): Promise<MessagesResponse> => {
        attemptNo += 1;
        if (overall.aborted || Date.now() - started >= budgetMs) throw timeoutFailure(budgetMs);
        let res: Response;
        let text: string;
        try {
          res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': o.apiKey,
              'anthropic-version': ANTHROPIC_API_VERSION,
            },
            body,
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
            const failure = new TextModelCallFailed(`Anthropic Messages API: HTTP ${res.status} ${type}`, res.status, pe.type, null, providerMessage);
            // Another attempt only if the budget can still cover the backoff that precedes it.
            const nextBackoff = baseMs * Math.pow(2, attemptNo - 1);
            if (attemptNo < maxAttempts && Date.now() - started + nextBackoff >= budgetMs) throw new BudgetSpent(failure);
            throw failure;
          }
          throw new TextModelCallFailed(
            `Anthropic Messages API answered ${res.status} (${type})`, res.status, pe.type,
            res.status === 429 ? retryAfterOf(res) : null, providerMessage,
          );
        }
        try {
          return JSON.parse(text) as MessagesResponse;
        } catch {
          throw new TextModelCallFailed('the provider answered with a body that is not JSON', res.status, null, null, null);
        }
      };

      let data: MessagesResponse;
      try {
        data = await withTransientRetry(attempt, { maxAttempts, baseMs });
      } catch (e) {
        if (e instanceof BudgetSpent) throw e.last;
        if (e instanceof TextModelCallFailed) throw e;
        const msg = e instanceof Error ? scrub(e.message) : 'unknown failure';
        throw new TextModelCallFailed(`Anthropic Messages API: could not connect (${msg.slice(0, 160)})`, null, 'network', null, null);
      }

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
