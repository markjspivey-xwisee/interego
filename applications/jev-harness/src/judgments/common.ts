import { randomBytes } from 'node:crypto';
import type { SystemOneResult } from '../jev-client.js';

export type JudgmentKind = 'navigation' | 'test-selection' | 'failure-triage' | 'review-verdict' | 'outcome';

export interface RepoRef {
  readonly name: string;
  readonly root: string;
  readonly commit: string | null;
}

export interface UsageSummary {
  readonly requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly latencyMs: number;
}

export interface JudgmentBase {
  readonly kind: JudgmentKind;
  readonly id: string;
  /** urn:graph:jev-harness:<kind>:<id> — the named graph the judgment is published as. */
  readonly graphIri: string;
  readonly createdAt: string;
  readonly model: string;
  /** The model's confidence for the judgment as a whole; becomes iep:epistemicConfidence. */
  readonly confidence: number;
  readonly repository: RepoRef;
  readonly usage: UsageSummary;
}

export function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function graphIriFor(kind: JudgmentKind, id: string): string {
  return `urn:graph:jev-harness:${kind}:${id}`;
}

export function emptyUsage(): UsageSummary {
  return { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 };
}

export function addUsage(sum: UsageSummary, r: SystemOneResult): UsageSummary {
  return {
    requests: sum.requests + 1,
    input_tokens: sum.input_tokens + r.usage.input_tokens,
    output_tokens: sum.output_tokens + r.usage.output_tokens,
    latencyMs: sum.latencyMs + r.latencyMs,
  };
}

export function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
