#!/usr/bin/env tsx
/**
 * Eval Suite for PGSL-Native Benchmark
 *
 * Runs a FIXED set of representative questions, measures accuracy
 * per question type, tracks regressions across changes.
 *
 * Usage:
 *   npx tsx benchmarks/eval.ts [model] [runs]
 *   npx tsx benchmarks/eval.ts opus 3    # 3 runs for variance measurement
 *
 * The eval set includes questions from each type that cover:
 *   - Known easy cases (should always pass)
 *   - Known hard cases (the ones we've been debugging)
 *   - Edge cases (abstention, knowledge-update, same-day)
 *
 * Output: per-type accuracy, per-question pass rate across runs,
 *   regression detection, variance measurement.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? 'opus';
const RUNS = parseInt(process.argv[3] ?? '1');
const DATA_FILE = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
const EVAL_RESULTS_FILE = resolve(__dirname, 'eval-history.json');

// ── Eval Set: representative questions from each type ──

const EVAL_SET: Array<{ qi: number; type: string; difficulty: string; description: string }> = [
  // TEMPORAL — easy (explicit dates)
  { qi: 0, type: 'temporal', difficulty: 'easy', description: 'first issue after car service' },
  { qi: 4, type: 'temporal', difficulty: 'easy', description: 'days before team meeting' },
  { qi: 10, type: 'temporal', difficulty: 'easy', description: 'which shoes cleaned' },

  // TEMPORAL — medium (relative dates)
  { qi: 3, type: 'temporal', difficulty: 'medium', description: 'Samsung vs Dell (pre-ordered ≠ got)' },
  { qi: 7, type: 'temporal', difficulty: 'medium', description: 'tomatoes vs marigolds (Feb 20 vs Mar 3)' },
  { qi: 19, type: 'temporal', difficulty: 'medium', description: 'Airbnb months ago' },
  { qi: 23, type: 'temporal', difficulty: 'medium', description: 'Crown vs GoT (a month ago)' },
  { qi: 28, type: 'temporal', difficulty: 'medium', description: 'road trip vs prime lens (a month ago)' },

  // TEMPORAL — hard (abstention, inference)
  { qi: 34, type: 'temporal', difficulty: 'hard', description: 'how old when moved to US' },
  { qi: 46, type: 'temporal', difficulty: 'hard', description: 'jam seller (wrong gender in question)' },
  { qi: 54, type: 'temporal', difficulty: 'hard', description: 'fence vs cows (cows not mentioned — abstain)' },
  { qi: 55, type: 'temporal', difficulty: 'hard', description: 'working before current job (wrong assumption)' },
  { qi: 57, type: 'temporal', difficulty: 'hard', description: 'iPad vs iPhone (iPad not mentioned — abstain)' },

  // COUNTING — easy
  { qi: 15, type: 'counting', difficulty: 'medium', description: 'charity events before Run for Cure' },
  { qi: 61, type: 'counting', difficulty: 'easy', description: 'projects led or leading' },
  { qi: 68, type: 'counting', difficulty: 'easy', description: 'different doctors visited' },

  // COUNTING — hard
  { qi: 60, type: 'counting', difficulty: 'hard', description: 'clothing items to pick up/return' },
  { qi: 70, type: 'counting', difficulty: 'hard', description: 'citrus fruits used' },
  { qi: 71, type: 'counting', difficulty: 'hard', description: 'movie festivals attended' },
  { qi: 77, type: 'counting', difficulty: 'hard', description: 'babies born to friends/family' },
  { qi: 93, type: 'counting', difficulty: 'hard', description: 'fish in aquariums (knowledge update)' },
  { qi: 99, type: 'counting', difficulty: 'hard', description: 'musical instruments (knowledge update)' },

  // SUM
  { qi: 63, type: 'sum', difficulty: 'medium', description: 'days on camping trips' },
  { qi: 66, type: 'sum', difficulty: 'medium', description: 'money on bike expenses' },

  // PREFERENCE
  { qi: 200, type: 'preference', difficulty: 'medium', description: 'video editing resources (Premiere Pro)' },
  { qi: 201, type: 'preference', difficulty: 'medium', description: 'camera accessories (Sony)' },
  { qi: 205, type: 'preference', difficulty: 'medium', description: 'show recommendation (stand-up comedy)' },
  { qi: 203, type: 'preference', difficulty: 'hard', description: 'hotel in Miami (from Seattle session)' },

  // KNOWLEDGE UPDATE
  { qi: 133, type: 'knowledge-update', difficulty: 'medium', description: 'first knowledge-update question' },

  // SINGLE SESSION
  { qi: 230, type: 'single-session', difficulty: 'easy', description: 'first single-session-assistant' },
  { qi: 300, type: 'single-session', difficulty: 'easy', description: 'first single-session-user' },
];

// ── LLM ──

function llm(prompt: string): string {
  try {
    const tmpFile = join(tmpdir(), `cg-eval-${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');
    const result = execSync(
      `cat "${tmpFile.replace(/\\/g, '/')}" | claude --print --model ${MODEL}`,
      { maxBuffer: 4 * 1024 * 1024, timeout: 180000, encoding: 'utf-8' }
    );
    try { unlinkSync(tmpFile); } catch {}
    return (result ?? '').trim();
  } catch { return ''; }
}

// ── Run one question (import the answer function from run-pgsl-native) ──

async function runQuestion(qi: number): Promise<{ correct: boolean; method: string; answer: string; gold: string }> {
  // Shell out to the runner so each question is an isolated subprocess.
  // (Don't import the runner — its main() executes at import time using
  // eval.ts's argv, which would run the wrong question range.)
  const result = execSync(
    `cd "${resolve(__dirname, '..')}" && npx tsx benchmarks/run-pgsl-native.ts ${MODEL} ${qi} ${qi + 1}`,
    { maxBuffer: 4 * 1024 * 1024, timeout: 300000, encoding: 'utf-8' }
  );

  const passed = result.includes(`✓ ${qi}:`);

  const goldMatch = result.match(/Gold: (.+)/);
  const oursMatch = result.match(/Ours: (.+)/);
  const methodMatch = result.match(/\[([^\]]+)\]/g);

  return {
    correct: passed,
    method: methodMatch?.[1]?.replace(/[\[\]]/g, '') ?? 'unknown',
    answer: oursMatch?.[1] ?? (passed ? 'correct' : 'unknown'),
    gold: data[qi]?.answer ?? '',
  };
}

// ── Main ──

// Cutoff: every entry written after this date is expected to carry the
// `cleanCriteria: true` flag. Older entries pre-date the 2026-05-03
// study-notes cleanup and are intentionally unflagged so the historical
// record stays distinguishable from cleaned baselines. See
// benchmarks/README.md "Integrity stance — no cross-run learning".
const CLEAN_CRITERIA_CUTOFF_ISO = '2026-05-03T00:00:00Z';

function auditHistoryIntegrity(): void {
  if (!existsSync(EVAL_RESULTS_FILE)) return;
  let history: unknown;
  try { history = JSON.parse(readFileSync(EVAL_RESULTS_FILE, 'utf-8')); }
  catch { return; }
  if (!Array.isArray(history)) return;
  const cutoffMs = new Date(CLEAN_CRITERIA_CUTOFF_ISO).getTime();
  const offenders: string[] = [];
  for (const entry of history) {
    if (typeof entry !== 'object' || entry === null) continue;
    const ts = (entry as { timestamp?: string }).timestamp;
    if (!ts) continue;
    const t = new Date(ts).getTime();
    if (Number.isFinite(t) && t >= cutoffMs && (entry as { cleanCriteria?: boolean }).cleanCriteria !== true) {
      offenders.push(ts);
    }
  }
  if (offenders.length > 0) {
    console.warn('');
    console.warn('⚠ WARNING — eval-history.json integrity check');
    console.warn(`  ${offenders.length} entry/entries written after the ${CLEAN_CRITERIA_CUTOFF_ISO} cold-start cutoff`);
    console.warn(`  are missing "cleanCriteria: true". This means either (a) the entry was`);
    console.warn(`  written by an older version of eval.ts (rerun with the current pipeline) or`);
    console.warn(`  (b) the file was edited by hand and the flag was dropped. Double-check before`);
    console.warn(`  comparing those entries against cleaned baselines.`);
    console.warn(`  Offending timestamps: ${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ', …' : ''}`);
    console.warn('');
  }
}

async function main() {
  console.log(`=== EVAL SUITE ===`);
  console.log(`Model: ${MODEL} | Runs: ${RUNS} | Questions: ${EVAL_SET.length}`);
  console.log('');
  auditHistoryIntegrity();

  const results: Array<{
    qi: number;
    type: string;
    difficulty: string;
    description: string;
    passRate: number;
    runs: boolean[];
  }> = [];

  for (const evalQ of EVAL_SET) {
    const runs: boolean[] = [];
    process.stdout.write(`  Q${evalQ.qi} [${evalQ.type}/${evalQ.difficulty}] ${evalQ.description}... `);

    for (let r = 0; r < RUNS; r++) {
      try {
        const result = await runQuestion(evalQ.qi);
        runs.push(result.correct);
      } catch {
        runs.push(false);
      }
    }

    const passRate = runs.filter(r => r).length / runs.length;
    const status = passRate === 1 ? '✓' : passRate === 0 ? '✗' : `~${(passRate * 100).toFixed(0)}%`;
    console.log(status);

    results.push({ qi: evalQ.qi, type: evalQ.type, difficulty: evalQ.difficulty, description: evalQ.description, passRate, runs });
  }

  // ── Summary ──
  console.log('');
  console.log('=== SUMMARY ===');

  // Per-type accuracy
  const types = [...new Set(results.map(r => r.type))];
  for (const type of types) {
    const typeResults = results.filter(r => r.type === type);
    const avgPassRate = typeResults.reduce((sum, r) => sum + r.passRate, 0) / typeResults.length;
    const allPass = typeResults.every(r => r.passRate === 1);
    const status = allPass ? '✓ 100%' : `${(avgPassRate * 100).toFixed(0)}%`;
    console.log(`  ${type}: ${status} (${typeResults.length} questions)`);
  }

  // Overall
  const overallPassRate = results.reduce((sum, r) => sum + r.passRate, 0) / results.length;
  console.log(`\n  OVERALL: ${(overallPassRate * 100).toFixed(1)}%`);

  // Per-difficulty
  console.log('');
  for (const diff of ['easy', 'medium', 'hard']) {
    const diffResults = results.filter(r => r.difficulty === diff);
    if (diffResults.length === 0) continue;
    const avgPassRate = diffResults.reduce((sum, r) => sum + r.passRate, 0) / diffResults.length;
    console.log(`  ${diff}: ${(avgPassRate * 100).toFixed(0)}% (${diffResults.length} questions)`);
  }

  // Failures
  const failures = results.filter(r => r.passRate < 1);
  if (failures.length > 0) {
    console.log(`\n  FAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`    Q${f.qi} [${f.type}/${f.difficulty}] ${f.description}: ${(f.passRate * 100).toFixed(0)}%`);
    }
  }

  // Variance (if multiple runs)
  if (RUNS > 1) {
    const variable = results.filter(r => r.passRate > 0 && r.passRate < 1);
    if (variable.length > 0) {
      console.log(`\n  NON-DETERMINISTIC (${variable.length}):`);
      for (const v of variable) {
        console.log(`    Q${v.qi}: ${v.runs.map(r => r ? '✓' : '✗').join('')} (${(v.passRate * 100).toFixed(0)}%)`);
      }
    }
  }

  // Save history
  const history = existsSync(EVAL_RESULTS_FILE) ? JSON.parse(readFileSync(EVAL_RESULTS_FILE, 'utf-8')) : [];
  history.push({
    timestamp: new Date().toISOString(),
    model: MODEL,
    runs: RUNS,
    overall: overallPassRate,
    perType: Object.fromEntries(types.map(t => {
      const tr = results.filter(r => r.type === t);
      return [t, tr.reduce((s, r) => s + r.passRate, 0) / tr.length];
    })),
    failures: failures.map(f => f.qi),
    results: results.map(r => ({ qi: r.qi, passRate: r.passRate })),
    // Marks runs that used the cold-start agent (no prompt-level study
    // notes from prior benchmark runs). See benchmarks/README.md
    // "Integrity stance — no cross-run learning". Older entries
    // without this flag predate the 2026-05-03 cleanup.
    cleanCriteria: true,
  });
  writeFileSync(EVAL_RESULTS_FILE, JSON.stringify(history, null, 2));
  console.log(`\n  History saved to ${EVAL_RESULTS_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
