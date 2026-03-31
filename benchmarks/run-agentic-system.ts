/**
 * Agentic Benchmark Pipeline
 *
 * The system IS the agent. Each step uses real system affordances:
 *
 * OBSERVE: ingest sessions into PGSL lattice
 * ORIENT:  computeCognitiveStrategy → classify question, detect computation needs
 * DECIDE:  select affordances (structural retrieval, date math, counting, LLM comprehension)
 * ACT:     execute each affordance, compose results
 *
 * The LLM is ONE tool the agent uses, not the whole agent.
 * Structural computation (dates, counting, ordering) is done in CODE.
 * The PGSL lattice provides retrieval and structural overlap.
 * The affordance engine routes to the right strategy.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// System imports
import {
  createPGSL,
  embedInPGSL,
  pgslResolve,
  latticeStats,
  latticeMeet,
  computeCognitiveStrategy,
  extractEntities,
  parseDate,
  daysBetween,
  countUnique,
  shouldAbstain,
  extractNumbers,
} from '../src/index.js';
import type { IRI, PGSLInstance, CognitiveStrategy } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────

const MODEL = process.argv[2] ?? 'opus';
const START = parseInt(process.argv[3] ?? '0');
const DATA_FILE = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');

const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));

// ── LLM via CLI subscription ────────────────────────────────

function llm(prompt: string): string {
  try {
    const tmpFile = join(tmpdir(), `cg-prompt-${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');
    const result = execSync(
      `cat "${tmpFile.replace(/\\/g, '/')}" | claude --print --model ${MODEL}`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 120000, env: { ...process.env, CLAUDECODE: '' }, encoding: 'utf-8' }
    );
    try { unlinkSync(tmpFile); } catch {}
    return (result ?? '').trim();
  } catch {
    return '';
  }
}

// ── OODA Agent ──────────────────────────────────────────────

interface AgentResult {
  answer: string;
  method: 'structural' | 'llm' | 'hybrid';
  strategy: CognitiveStrategy;
  pgslAtoms: number;
  pgslFragments: number;
}

function runAgent(question: string, sessions: string[], questionDate?: string): AgentResult {
  // ── OBSERVE: ingest sessions into PGSL ──
  const pgsl = createPGSL({ wasAttributedTo: 'benchmark-agent' as IRI, generatedAtTime: new Date().toISOString() });

  for (const session of sessions) {
    // Extract key sentences (not the whole session — too large)
    const sentences = session.split(/[.!?]+/).filter(s => s.trim().length > 10).slice(0, 50);
    for (const sent of sentences) {
      try { embedInPGSL(pgsl, sent.trim()); } catch {}
    }
  }

  const stats = latticeStats(pgsl);

  // ── ORIENT: classify question, detect what's needed ──
  const strategy = computeCognitiveStrategy(question);
  const qEntities = extractEntities(question);

  // Check if we should abstain (question entities not in sessions)
  const sessionText = sessions.join(' ');
  const sessionEntities = new Set(sessionText.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const abstainCheck = shouldAbstain([...qEntities.contentWords], sessionEntities, 0.2);

  // ── DECIDE: select affordances ──

  // 1. Try structural computation first (dates, counting)
  let structuralAnswer: string | null = null;

  if (strategy.requiresComputation && strategy.computationType === 'date-arithmetic') {
    // Extract dates from sessions and compute
    const dates: Array<{ date: Date; context: string }> = [];
    for (const session of sessions) {
      const dateMatches = session.match(/\d{4}\/\d{2}\/\d{2}|\w+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4}/g) || [];
      for (const dm of dateMatches) {
        const parsed = parseDate(dm);
        if (parsed) {
          const idx = session.indexOf(dm);
          const context = session.slice(Math.max(0, idx - 50), Math.min(session.length, idx + dm.length + 50));
          dates.push({ date: parsed, context });
        }
      }
    }

    if (dates.length >= 2) {
      // Use LLM to extract specific dates for the question entities, then compute in code
      const dateExtraction = llm(
        `Extract the specific dates for the events mentioned in this question. Return ONLY dates in YYYY-MM-DD format, one per line, labeled.\n\nQuestion: ${question}\n\nSessions:\n${sessions.map((s, i) => `Session ${i + 1} (${data[0]?.haystack_dates?.[i] ?? 'unknown'}):\n${s.slice(0, 3000)}`).join('\n\n')}\n\nDates:`
      );

      // Parse extracted dates and compute
      const extractedDates = dateExtraction.match(/\d{4}-\d{2}-\d{2}/g) || [];
      if (extractedDates.length >= 2) {
        const d1 = parseDate(extractedDates[0]!);
        const d2 = parseDate(extractedDates[1]!);
        if (d1 && d2) {
          const days = daysBetween(d1, d2);
          structuralAnswer = `${days} days`;
          // Check if question asks for weeks
          if (question.toLowerCase().includes('week')) {
            structuralAnswer = `${Math.round(days / 7 * 10) / 10} weeks`;
          }
          if (question.toLowerCase().includes('month')) {
            structuralAnswer = `${Math.round(days / 30.44 * 10) / 10} months`;
          }
        }
      }
    }
  }

  if (strategy.requiresComputation && strategy.computationType === 'counting') {
    // Two-pass counting: extract per session, then aggregate in code
    const itemsPerSession: string[][] = [];
    for (let i = 0; i < sessions.length; i++) {
      const items = llm(
        `List EVERY item that matches this question. One per line, no explanations.\n\nQuestion: ${question}\n\nSession ${i + 1}:\n${sessions[i]!.slice(0, 4000)}\n\nItems (one per line):`
      );
      itemsPerSession.push(items.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('No ')));
    }

    // Structural dedup and count
    const allItems = itemsPerSession.flat();
    const unique = countUnique(allItems);
    if (unique.count > 0) {
      structuralAnswer = `${unique.count}`;
    }
  }

  // 2. If abstention detected, check with LLM
  if (abstainCheck.abstain && abstainCheck.matchRatio < 0.15) {
    const verifyAbstain = llm(
      `Does the conversation history contain information about: "${qEntities.contentWords.join(', ')}"? Answer YES or NO only.\n\n${sessions.map((s, i) => `Session ${i + 1}:\n${s.slice(0, 2000)}`).join('\n\n')}`
    );
    if (verifyAbstain.toLowerCase().includes('no')) {
      return {
        answer: 'The information provided is not enough to answer this question.',
        method: 'structural',
        strategy,
        pgslAtoms: stats.atoms,
        pgslFragments: stats.fragments,
      };
    }
  }

  // 3. Build structural scaffolding from PGSL + affordance analysis
  const scaffolding: string[] = [];

  // Question analysis from the affordance engine
  scaffolding.push(`STRUCTURAL ANALYSIS (from system):`);
  scaffolding.push(`  Question type: ${strategy.questionType}`);
  scaffolding.push(`  Strategy: ${strategy.strategy}`);
  if (strategy.requiresComputation) scaffolding.push(`  Computation needed: ${strategy.computationType}`);
  scaffolding.push(`  Key entities: ${qEntities.contentWords.join(', ')}`);
  if (qEntities.nounPhrases.length > 0) scaffolding.push(`  Noun phrases: ${qEntities.nounPhrases.join(', ')}`);

  // PGSL structural overlap — find which sessions share entities with the question
  const sessionRelevance: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const sessionWords = new Set(sessions[i]!.toLowerCase().split(/\s+/));
    const overlap = qEntities.contentWords.filter(w => sessionWords.has(w.toLowerCase()));
    if (overlap.length > 0) {
      sessionRelevance.push(`  Session ${i + 1}: matches [${overlap.join(', ')}]`);
    }
  }
  if (sessionRelevance.length > 0) {
    scaffolding.push(`  Session relevance:`);
    scaffolding.push(...sessionRelevance);
  }

  // Abstention signal
  if (abstainCheck.matchRatio < 0.3) {
    scaffolding.push(`  WARNING: Low entity match (${(abstainCheck.matchRatio * 100).toFixed(0)}%). Some question entities not found in sessions: [${abstainCheck.missingEntities.join(', ')}]`);
    scaffolding.push(`  If the information truly isn't in the sessions, say "The information provided is not enough."`);
  }

  // Structural computation hint
  if (structuralAnswer) {
    scaffolding.push(`  Structural computation result: ${structuralAnswer}`);
    scaffolding.push(`  (Verify this against the sessions — structural computation may have errors)`);
  }

  // Strategy-specific guidance
  if (strategy.strategy === 'temporal-twopass') {
    scaffolding.push(`  TEMPORAL: Find specific dates/times for each event, then compare.`);
  } else if (strategy.strategy === 'multi-session-aggregate') {
    scaffolding.push(`  MULTI-SESSION: Check EVERY session for relevant items. Count carefully.`);
  }

  const scaffoldBlock = scaffolding.join('\n');

  // 4. LLM comprehension WITH structural scaffolding
  const fullText = sessions.map((s, i) => {
    const date = questionDate ? '' : ''; // dates come from session content
    return `=== Session ${i + 1} ===\n${s}`;
  }).join('\n\n');

  const prompt = `${scaffoldBlock}\n\nRead ALL sessions carefully. ${questionDate ? `The current date is ${questionDate}.` : ''} Use the structural analysis above to guide your reading. Answer the question. Be SPECIFIC and CONCISE. Give ONLY the answer.\n\n${fullText}\n\nQuestion: ${question}\n\nAnswer:`;
  const llmAnswer = llm(prompt);

  // ── ACT: compose results ──

  // If structural computation produced an answer, prefer it for numeric questions
  if (structuralAnswer && strategy.requiresComputation) {
    // Verify structural answer against LLM answer
    const structNum = parseFloat(structuralAnswer);
    const llmNums = extractNumbers(llmAnswer);
    const llmNum = llmNums.length > 0 ? llmNums[0]!.value : NaN;

    if (!isNaN(structNum) && !isNaN(llmNum) && structNum === llmNum) {
      // Both agree — high confidence
      return { answer: structuralAnswer, method: 'hybrid', strategy, pgslAtoms: stats.atoms, pgslFragments: stats.fragments };
    } else if (!isNaN(structNum)) {
      // Structural has a number, LLM might disagree — use LLM (it reads the full text)
      return { answer: llmAnswer, method: 'hybrid', strategy, pgslAtoms: stats.atoms, pgslFragments: stats.fragments };
    }
  }

  return { answer: llmAnswer, method: 'llm', strategy, pgslAtoms: stats.atoms, pgslFragments: stats.fragments };
}

// ── Main ────────────────────────────────────────────────────

function main() {
  console.log(`=== AGENTIC SYSTEM BENCHMARK — LongMemEval ===`);
  console.log(`OODA loop: OBSERVE (PGSL) → ORIENT (affordance) → DECIDE (structural/LLM) → ACT (compose)`);
  console.log(`Model: ${MODEL} | Start: Q${START} | Cost: $0 (subscription)\n`);

  let correct = 0;
  let total = 0;
  let structural = 0;
  let hybrid = 0;
  let llmOnly = 0;

  for (let qi = START; qi < data.length; qi++) {
    const item = data[qi];
    total++;

    const sessions: string[] = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));

    const result = runAgent(item.question, sessions, item.question_date);

    if (result.method === 'structural') structural++;
    else if (result.method === 'hybrid') hybrid++;
    else llmOnly++;

    // Judge
    const judgeResult = llm(
      `Is this answer correct? Answer ONLY yes or no.\nQ: ${item.question}\nGenerated: ${result.answer.slice(0, 300)}\nGold: ${item.answer}\nCorrect:`
    );
    const isCorrect = judgeResult.toLowerCase().startsWith('yes');
    if (isCorrect) correct++;

    const mark = isCorrect ? '✓' : '✗';
    console.log(`${mark} ${qi}: [${item.question_type}] [${result.method}] ${item.question.slice(0, 60)}`);

    if (!isCorrect) {
      console.log(`  Gold: ${String(item.answer).slice(0, 80)}`);
      console.log(`  Ours: ${result.answer.slice(0, 80)}`);
      console.log(`  Strategy: ${result.strategy.strategy} | Computation: ${result.strategy.computationType ?? 'none'}`);
      console.log(`  PGSL: ${result.pgslAtoms} atoms, ${result.pgslFragments} fragments`);
      console.log(`\n  Score: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
      console.log(`  Methods: structural=${structural} hybrid=${hybrid} llm=${llmOnly}`);
      console.log(`  Resume: npx tsx benchmarks/run-agentic-system.ts ${MODEL} ${qi + 1}`);
      break;
    }

    if (total % 20 === 0) {
      console.log(`  Score: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) | struct=${structural} hybrid=${hybrid} llm=${llmOnly}`);
    }
  }
}

main();
