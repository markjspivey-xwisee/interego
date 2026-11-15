/**
 * Foxxi bridge observability — lightweight in-process metrics + per-handler
 * counters. No external observability stack required; the bridge serves
 * a Prometheus-flavored exposition format at GET /metrics so an operator
 * can scrape into Grafana / Azure Monitor / any standard collector.
 *
 * Tracked per handler:
 *   - calls_total            counter
 *   - calls_errors_total     counter
 *   - latency_ms_sum         histogram-ish (sum + count + p95 estimate from a ring buffer)
 *
 * Tracked globally:
 *   - llm_cost_cents_total   counter — best-effort, charged per
 *                            ask_course_question_agentic call using public
 *                            Anthropic pricing tables.
 *   - rate_limit_hits_total  counter
 *   - auth_failures_total    counter
 *
 * No PII; learner DIDs never enter the metrics labels. Cardinality stays
 * bounded by the affordance count.
 */

import { memoryMetricLines, processMemory, type ProcessMemory } from './process-memory.js';

interface HandlerStats {
  calls: number;
  errors: number;
  latencyMs: number[];
  totalLatencyMs: number;
}

const handlerStats = new Map<string, HandlerStats>();
const counters = {
  llmCostCents: 0,
  rateLimitHits: 0,
  authFailures: 0,
  bbsProofsDerived: 0,
  vcsIssued: 0,
};

// Per-1k-token cost in USD cents — public Anthropic pricing as of 2026-05.
// Update if Anthropic re-prices; the bridge's exposed metric just becomes
// approximate.
const MODEL_COST_INPUT_CENTS_PER_1K: Record<string, number> = {
  'claude-opus-4-7': 1.5,    // $15/M input
  'claude-sonnet-4-6': 0.3,  // $3/M input
  'claude-sonnet-4-5': 0.3,
  'claude-haiku-4-5-20251001': 0.025,
};
const MODEL_COST_OUTPUT_CENTS_PER_1K: Record<string, number> = {
  'claude-opus-4-7': 7.5,    // $75/M output
  'claude-sonnet-4-6': 1.5,  // $15/M output
  'claude-sonnet-4-5': 1.5,
  'claude-haiku-4-5-20251001': 0.125,
};

export function recordCall(handler: string, latencyMs: number, isError: boolean): void {
  let stats = handlerStats.get(handler);
  if (!stats) {
    stats = { calls: 0, errors: 0, latencyMs: [], totalLatencyMs: 0 };
    handlerStats.set(handler, stats);
  }
  stats.calls++;
  if (isError) stats.errors++;
  stats.totalLatencyMs += latencyMs;
  stats.latencyMs.push(latencyMs);
  // Keep last 100 samples for p95 estimation; bounded memory.
  if (stats.latencyMs.length > 100) stats.latencyMs.shift();
}

export function recordLlmCost(model: string, inputTokens: number, outputTokens: number): void {
  const inputRate = MODEL_COST_INPUT_CENTS_PER_1K[model] ?? 0;
  const outputRate = MODEL_COST_OUTPUT_CENTS_PER_1K[model] ?? 0;
  const cents = (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
  counters.llmCostCents += cents;
}

export function recordRateLimit(): void { counters.rateLimitHits++; }
export function recordAuthFailure(): void { counters.authFailures++; }
export function recordBbsProof(): void { counters.bbsProofsDerived++; }
export function recordVcIssued(): void { counters.vcsIssued++; }

/** Render Prometheus text-format exposition. */
export function renderMetrics(): string {
  const lines: string[] = [];
  lines.push('# HELP foxxi_bridge_calls_total Total bridge handler invocations');
  lines.push('# TYPE foxxi_bridge_calls_total counter');
  for (const [handler, s] of handlerStats.entries()) {
    lines.push(`foxxi_bridge_calls_total{handler="${handler}"} ${s.calls}`);
  }
  lines.push('');
  lines.push('# HELP foxxi_bridge_errors_total Total bridge handler errors');
  lines.push('# TYPE foxxi_bridge_errors_total counter');
  for (const [handler, s] of handlerStats.entries()) {
    lines.push(`foxxi_bridge_errors_total{handler="${handler}"} ${s.errors}`);
  }
  lines.push('');
  lines.push('# HELP foxxi_bridge_latency_ms_p95 Per-handler p95 latency (last 100 calls, ms)');
  lines.push('# TYPE foxxi_bridge_latency_ms_p95 gauge');
  for (const [handler, s] of handlerStats.entries()) {
    if (s.latencyMs.length === 0) continue;
    const sorted = [...s.latencyMs].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    lines.push(`foxxi_bridge_latency_ms_p95{handler="${handler}"} ${p95}`);
  }
  lines.push('');
  lines.push('# HELP foxxi_bridge_llm_cost_cents_total Approximate cumulative LLM cost in USD cents (public Anthropic pricing)');
  lines.push('# TYPE foxxi_bridge_llm_cost_cents_total counter');
  lines.push(`foxxi_bridge_llm_cost_cents_total ${counters.llmCostCents.toFixed(4)}`);
  lines.push('');
  lines.push('# HELP foxxi_bridge_rate_limit_hits_total Times the per-IP rate limit blocked an LLM call');
  lines.push('# TYPE foxxi_bridge_rate_limit_hits_total counter');
  lines.push(`foxxi_bridge_rate_limit_hits_total ${counters.rateLimitHits}`);
  lines.push('');
  lines.push('# HELP foxxi_bridge_auth_failures_total Failed auth attempts (bad token, wrong signer, etc.)');
  lines.push('# TYPE foxxi_bridge_auth_failures_total counter');
  lines.push(`foxxi_bridge_auth_failures_total ${counters.authFailures}`);
  lines.push('');
  lines.push('# HELP foxxi_bridge_bbs_proofs_derived_total BBS+ selective-disclosure proofs derived');
  lines.push('# TYPE foxxi_bridge_bbs_proofs_derived_total counter');
  lines.push(`foxxi_bridge_bbs_proofs_derived_total ${counters.bbsProofsDerived}`);
  lines.push('');
  lines.push('# HELP foxxi_bridge_vcs_issued_total W3C Verifiable Credentials minted');
  lines.push('# TYPE foxxi_bridge_vcs_issued_total counter');
  lines.push(`foxxi_bridge_vcs_issued_total ${counters.vcsIssued}`);
  lines.push('');
  // What the process holds and what its container is charged for (src/process-memory.ts).
  lines.push(...memoryMetricLines(processMemory()));
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/** JSON shape for the operator dashboard. */
export interface MetricsSnapshot {
  handlers: Array<{ name: string; calls: number; errors: number; p50ms: number; p95ms: number }>;
  llmCostCents: number;
  rateLimitHits: number;
  authFailures: number;
  bbsProofsDerived: number;
  vcsIssued: number;
  /** What the process holds and what its container is charged for, in bytes. */
  memory: ProcessMemory;
}
export function metricsJson(): MetricsSnapshot {
  const handlers: MetricsSnapshot['handlers'] = [];
  for (const [name, s] of handlerStats.entries()) {
    const sorted = [...s.latencyMs].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
    handlers.push({ name, calls: s.calls, errors: s.errors, p50ms: p50, p95ms: p95 });
  }
  handlers.sort((a, b) => b.calls - a.calls);
  return {
    handlers,
    llmCostCents: Math.round(counters.llmCostCents * 10000) / 10000,
    rateLimitHits: counters.rateLimitHits,
    authFailures: counters.authFailures,
    bbsProofsDerived: counters.bbsProofsDerived,
    vcsIssued: counters.vcsIssued,
    memory: processMemory(),
  };
}
