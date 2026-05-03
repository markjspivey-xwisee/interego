#!/usr/bin/env tsx
/**
 * Walk the LongMemEval regression set (or the full 500 in qi order)
 * one question at a time and HALT on the first wrong answer.
 *
 * Reports the streak length, the first failing question, and the
 * answer pair for inspection. Doesn't write to eval-history.json
 * (the run is structurally biased — we stop early — and shouldn't
 * pollute the per-run statistics).
 *
 * Usage:
 *   npx tsx benchmarks/run-until-wrong.ts                # opus, eval set
 *   npx tsx benchmarks/run-until-wrong.ts haiku          # different model
 *   npx tsx benchmarks/run-until-wrong.ts opus --full    # walk all 500
 *   npx tsx benchmarks/run-until-wrong.ts opus --start 100  # start at qi=100
 *
 * Designed for the "see how far we get" question — short-circuits the
 * full eval cost when there's any regression to surface.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
const MODEL = (args.find(a => !a.startsWith('--')) ?? 'opus');
const FULL = args.includes('--full');
const START_INDEX = (() => {
  const i = args.indexOf('--start');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1]!, 10) : 0;
})();

const DATA_FILE = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8')) as Array<{ question_id: string; question_type: string; question: string; answer: string }>;

// ── Eval set (mirrors eval.ts so streaks are comparable to history) ──

interface EvalQ { qi: number; type: string; difficulty: string; description: string }

const EVAL_SET: EvalQ[] = [
  { qi: 0, type: 'temporal', difficulty: 'easy', description: 'first issue after car service' },
  { qi: 4, type: 'temporal', difficulty: 'easy', description: 'days before team meeting' },
  { qi: 10, type: 'temporal', difficulty: 'easy', description: 'which shoes cleaned' },
  { qi: 3, type: 'temporal', difficulty: 'medium', description: 'Samsung vs Dell (pre-ordered ≠ got)' },
  { qi: 7, type: 'temporal', difficulty: 'medium', description: 'tomatoes vs marigolds (Feb 20 vs Mar 3)' },
  { qi: 19, type: 'temporal', difficulty: 'medium', description: 'Airbnb months ago' },
  { qi: 23, type: 'temporal', difficulty: 'medium', description: 'Crown vs GoT (a month ago)' },
  { qi: 28, type: 'temporal', difficulty: 'medium', description: 'road trip vs prime lens (a month ago)' },
  { qi: 34, type: 'temporal', difficulty: 'hard', description: 'how old when moved to US' },
  { qi: 46, type: 'temporal', difficulty: 'hard', description: 'jam seller (wrong gender in question)' },
  { qi: 54, type: 'temporal', difficulty: 'hard', description: 'fence vs cows (cows not mentioned — abstain)' },
  { qi: 55, type: 'temporal', difficulty: 'hard', description: 'working before current job (wrong assumption)' },
  { qi: 57, type: 'temporal', difficulty: 'hard', description: 'iPad vs iPhone (iPad not mentioned — abstain)' },
  { qi: 15, type: 'counting', difficulty: 'medium', description: 'charity events before Run for Cure' },
  { qi: 61, type: 'counting', difficulty: 'easy', description: 'projects led or leading' },
  { qi: 68, type: 'counting', difficulty: 'easy', description: 'different doctors visited' },
  { qi: 60, type: 'counting', difficulty: 'hard', description: 'clothing items to pick up/return' },
  { qi: 70, type: 'counting', difficulty: 'hard', description: 'citrus fruits used' },
  { qi: 71, type: 'counting', difficulty: 'hard', description: 'movie festivals attended' },
  { qi: 77, type: 'counting', difficulty: 'hard', description: 'babies born to friends/family' },
  { qi: 93, type: 'counting', difficulty: 'hard', description: 'fish in aquariums (knowledge update)' },
  { qi: 99, type: 'counting', difficulty: 'hard', description: 'musical instruments (knowledge update)' },
  { qi: 63, type: 'sum', difficulty: 'medium', description: 'days on camping trips' },
  { qi: 66, type: 'sum', difficulty: 'medium', description: 'money on bike expenses' },
  { qi: 200, type: 'preference', difficulty: 'medium', description: 'video editing resources (Premiere Pro)' },
  { qi: 201, type: 'preference', difficulty: 'medium', description: 'camera accessories (Sony)' },
  { qi: 205, type: 'preference', difficulty: 'medium', description: 'show recommendation (stand-up comedy)' },
  { qi: 203, type: 'preference', difficulty: 'hard', description: 'hotel in Miami (from Seattle session)' },
  { qi: 133, type: 'knowledge-update', difficulty: 'medium', description: 'first knowledge-update question' },
  { qi: 230, type: 'single-session', difficulty: 'easy', description: 'first single-session-assistant' },
  { qi: 300, type: 'single-session', difficulty: 'easy', description: 'first single-session-user' },
];

const QUEUE: EvalQ[] = FULL
  ? data.slice(START_INDEX).map((d, i) => ({
      qi: START_INDEX + i,
      type: d.question_type ?? 'unknown',
      difficulty: 'unknown',
      description: (d.question ?? '').slice(0, 60),
    }))
  : EVAL_SET.filter(q => q.qi >= START_INDEX);

// ── Per-question runner (subprocess for isolation, matches eval.ts) ──

interface QResult { passed: boolean; gold: string; ours: string; method: string; raw: string }

function runQuestion(qi: number): QResult {
  let raw = '';
  try {
    raw = execSync(
      `cd "${resolve(__dirname, '..')}" && npx tsx benchmarks/run-pgsl-native.ts ${MODEL} ${qi} ${qi + 1}`,
      { maxBuffer: 4 * 1024 * 1024, timeout: 300000, encoding: 'utf-8' },
    );
  } catch (e) {
    raw = (e as { stdout?: string }).stdout ?? `[error: ${(e as Error).message}]`;
  }
  const passed = raw.includes(`✓ ${qi}:`);
  const goldMatch = raw.match(/Gold: (.+)/);
  const oursMatch = raw.match(/Ours: (.+)/);
  const methodMatch = raw.match(/\[((?:structural|hybrid|llm)[^\]]*)\]/);
  return {
    passed,
    gold: goldMatch?.[1]?.trim() ?? data[qi]?.answer ?? '<unknown>',
    ours: oursMatch?.[1]?.trim() ?? '<no answer>',
    method: methodMatch?.[1] ?? 'unknown',
    raw,
  };
}

// ── Main ──────────────────────────────────────────────────────

console.log(`=== run-until-wrong ===`);
console.log(`Model:  ${MODEL}`);
console.log(`Mode:   ${FULL ? 'FULL (all 500 qids in order)' : `eval set (${EVAL_SET.length} curated questions)`}`);
console.log(`Start:  qi=${START_INDEX}`);
console.log(`Queue:  ${QUEUE.length} questions`);
console.log('');

const startedAt = Date.now();
let streak = 0;
const passedTrail: EvalQ[] = [];

for (const q of QUEUE) {
  const elapsedAtStart = ((Date.now() - startedAt) / 1000).toFixed(0);
  process.stdout.write(`  [+${elapsedAtStart.padStart(4, ' ')}s] Q${String(q.qi).padStart(3, ' ')} [${q.type}/${q.difficulty}] ${q.description.slice(0, 60).padEnd(60, ' ')}... `);

  const result = runQuestion(q.qi);
  if (result.passed) {
    streak++;
    passedTrail.push(q);
    console.log(`✓ (streak ${streak})`);
    continue;
  }

  // ── Halt on first failure ─────────────────────────────────────
  console.log('✗');
  console.log('');
  console.log('=== HALTED ===');
  console.log(`Streak:        ${streak}/${QUEUE.length} questions correct in a row`);
  console.log(`Failed at:     Q${q.qi} [${q.type}/${q.difficulty}] ${q.description}`);
  console.log(`Gold answer:   ${result.gold}`);
  console.log(`Our answer:    ${result.ours}`);
  console.log(`Method tried:  ${result.method}`);
  console.log(`Total elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log('');
  if (passedTrail.length > 0) {
    console.log('Streak detail (passed before the halt):');
    const byType = new Map<string, number>();
    for (const p of passedTrail) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
    for (const [type, n] of byType.entries()) console.log(`  ${type}: ${n}`);
  }
  process.exit(1);
}

// All passed.
console.log('');
console.log('=== ALL PASSED ===');
console.log(`Streak: ${streak}/${QUEUE.length} (clean sweep)`);
console.log(`Total elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
process.exit(0);
