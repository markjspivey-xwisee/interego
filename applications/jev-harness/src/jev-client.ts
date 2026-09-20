/**
 * TypeSafe System One client — the one place the harness talks to Jev.
 *
 * Contract per https://docs.typesafe.ai/api.md: POST /v1/systemone with { state, model,
 * questions }, one typed answer per question id. Retries 429 / 529 with backoff as the API
 * reference asks. Output tokens are free; input tokens are what a request costs, so every
 * caller passes the smallest state that answers its question (docs.typesafe.ai
 * model-jaggedness: accuracy falls as irrelevant state grows).
 *
 * `JevClient` is an interface so every judgment module is testable with a `FakeJevClient`
 * that answers deterministically and never touches the network.
 */

import { execFileSync } from 'node:child_process';

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: unknown;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}
export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: unknown;
  readonly criteria: Record<string, string | null>;
}
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: unknown;
  readonly criteria: readonly string[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer { readonly type: 'noul'; readonly noul: number }
export interface ChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}
export interface ScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly legend: Record<string, string>;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface Usage { readonly input_tokens: number; readonly output_tokens: number }

export interface SystemOneResult {
  readonly model: string;
  readonly answers: Record<string, Answer>;
  readonly usage: Usage;
  readonly latencyMs: number;
}

export interface JevClient {
  /** The model name requests are sent with (an alias or a versioned id). */
  readonly model: string;
  systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResult>;
}

/** Limits published on https://docs.typesafe.ai/models.md for jev-1.13. */
export const JEV_LIMITS = {
  /** state plus every question, per request */
  totalTokens: 64_000,
  /** state plus the single longest question */
  stateTokens: 32_000,
  /** options per Choice question (semantic_find cookbook) */
  choiceOptions: 255,
} as const;

/** Rough token estimate: the docs quote budgets in tokens, we plan in characters. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 3.5);
}

export interface HttpJevClientOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export class JevError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'JevError';
  }
}

export class HttpJevClient implements JevClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: HttpJevClientOptions = {}) {
    const key = opts.apiKey ?? resolveApiKey();
    if (!key) {
      throw new JevError(
        'TYPESAFE_API_KEY is not set. Export it (https://console.typesafe.ai) or pass apiKey.',
      );
    }
    this.apiKey = key;
    this.model = opts.model ?? process.env['JEV_MODEL'] ?? 'jev-latest';
    this.url = `${(opts.baseUrl ?? 'https://api.typesafe.ai').replace(/\/$/, '')}/v1/systemone`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  async systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResult> {
    const body = JSON.stringify({ state, model: this.model, questions });
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
          attempt += 1;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new JevError(`TypeSafe request failed: ${(err as Error).message}`);
      }
      clearTimeout(timer);
      if (res.status === 429 || res.status === 529) {
        if (attempt < this.maxRetries) {
          attempt += 1;
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
          continue;
        }
      }
      const text = await res.text();
      if (!res.ok) {
        throw new JevError(`TypeSafe responded ${res.status}`, res.status, text.slice(0, 2000));
      }
      const parsed = JSON.parse(text) as { model: string; answers: Record<string, Answer>; usage: Usage };
      return { model: parsed.model, answers: parsed.answers, usage: parsed.usage, latencyMs: Date.now() - started };
    }
  }
}

/**
 * A deterministic stand-in for tests. The answerer sees the same state and questions the
 * real model would and returns answers keyed by question id; anything it leaves out gets a
 * neutral default so a test only has to script the answers it is about.
 */
export class FakeJevClient implements JevClient {
  readonly model = 'jev-fake';
  readonly calls: Array<{ state: unknown; questions: Record<string, Question> }> = [];
  constructor(
    private readonly answerer: (state: unknown, questions: Record<string, Question>) => Partial<Record<string, Answer>>,
  ) {}

  async systemOne(state: unknown, questions: Record<string, Question>): Promise<SystemOneResult> {
    this.calls.push({ state, questions });
    const scripted = this.answerer(state, questions);
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      answers[id] = scripted[id] ?? neutralAnswer(q);
    }
    return { model: this.model, answers, usage: { input_tokens: estimateTokens({ state, questions }), output_tokens: 0 }, latencyMs: 0 };
  }
}

export function neutralAnswer(q: Question): Answer {
  if (q.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria);
    const p = keys.length > 0 ? 1 / keys.length : 1;
    const probabilities: Record<string, number> = {};
    for (const k of keys) probabilities[k] = p;
    return { type: 'choice', choice: keys[0] ?? '', probabilities, confidence: 0 };
  }
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  q.criteria.forEach((level, i) => { legend[String(i)] = level; probabilities[String(i)] = 1 / q.criteria.length; });
  return { type: 'score', score: (q.criteria.length - 1) / 2, legend, probabilities, confidence: 0 };
}

/** Build a Choice answer for tests: probability mass on `choice`, the rest spread evenly. */
export function choiceAnswer(options: readonly string[], choice: string, p = 0.9): ChoiceAnswer {
  const rest = options.length > 1 ? (1 - p) / (options.length - 1) : 0;
  const probabilities: Record<string, number> = {};
  for (const o of options) probabilities[o] = o === choice ? p : rest;
  return { type: 'choice', choice, probabilities, confidence: p };
}

export function topK(probabilities: Record<string, number>, k: number): Array<{ key: string; p: number }> {
  return Object.entries(probabilities)
    .map(([key, p]) => ({ key, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

/** The API key: the environment, else (Windows only) the user-scope variable the process may
 *  not have inherited. The value is never logged. */
export function resolveApiKey(): string | undefined {
  const fromEnv = process.env['TYPESAFE_API_KEY'];
  if (fromEnv) return fromEnv;
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY','User')"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    ).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export function jevFromEnv(opts: Omit<HttpJevClientOptions, 'apiKey'> = {}): JevClient {
  return new HttpJevClient(opts);
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
