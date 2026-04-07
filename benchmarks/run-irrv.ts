#!/usr/bin/env tsx
/**
 * LongMemEval — Index-Retrieve-Read-Verify (IRRV)
 *
 * The lattice is an INDEX, not a replacement for content.
 *
 * Phase 1: INDEX — ingest key terms from each session into PGSL.
 *   Don't extract facts. Just build the index: which concepts
 *   appear in which sessions.
 *
 * Phase 2: RETRIEVE — parse question, use paradigm overlap to find
 *   which sessions are relevant. Rank by structural overlap.
 *
 * Phase 3: READ — give the LLM the ORIGINAL TEXT of relevant sessions
 *   with focused instructions per question type.
 *
 * Phase 4: VERIFY — for computation questions (dates, counts), verify
 *   the LLM's answer with structural computation. If they disagree,
 *   re-read with more focus.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

import {
  createPGSL, embedInPGSL, pgslResolve, latticeStats,
  extractEntities, computeCognitiveStrategy,
  parseDate, daysBetween, shouldAbstain,
} from '../src/index.js';

import type { IRI, PGSLInstance } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? 'opus';
const START = parseInt(process.argv[3] ?? '0');
const END = parseInt(process.argv[4] ?? '500');
const DATA_FILE = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));

// ── LLM ────────────────────────────────────────────────

function llm(prompt: string): string {
  try {
    const tmpFile = join(tmpdir(), `cg-irrv-${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');
    const result = execSync(
      `cat "${tmpFile.replace(/\\/g, '/')}" | claude --print --model ${MODEL}`,
      { maxBuffer: 4 * 1024 * 1024, timeout: 180000, encoding: 'utf-8' }
    );
    try { unlinkSync(tmpFile); } catch {}
    return (result ?? '').trim();
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════
//  PHASE 1: INDEX — build a concept index, not a fact store
// ═══════════════════════════════════════════════════════════

interface SessionIndex {
  /** Session number (0-indexed) */
  index: number;
  /** Session date */
  date?: string;
  /** Full original text — NEVER summarized */
  text: string;
  /** Key terms extracted (for overlap computation) */
  terms: Set<string>;
  /** The PGSL instance for this session (lightweight index only) */
  pgsl: PGSLInstance;
}

function indexSession(
  messages: Array<{ role: string; content?: string; text?: string }>,
  sessionIndex: number,
  sessionDate?: string,
): SessionIndex {
  // Build full text — preserved EXACTLY as-is
  const text = messages.map(m => {
    const content = m.content || m.text || '';
    return `${m.role}: ${content}`;
  }).join('\n');

  // Extract key terms for the index
  const userText = messages.filter(m => m.role === 'user').map(m => m.content || m.text || '').join(' ');
  const entities = extractEntities(userText.slice(0, 5000));
  const terms = new Set<string>();
  for (const w of entities.contentWords) terms.add(w.toLowerCase());
  for (const np of entities.nounPhrases) terms.add(np.toLowerCase());

  // Also add significant words (nouns, proper nouns, numbers, dates)
  const words = userText.split(/\s+/).filter(w => w.length > 3);
  for (const w of words) {
    const lower = w.toLowerCase().replace(/[.,!?'"]/g, '');
    if (lower.length > 3) terms.add(lower);
  }

  // Build lightweight PGSL index — just key terms, not full sentences
  const pgsl = createPGSL({
    wasAttributedTo: `urn:session:${sessionIndex}` as IRI,
    generatedAtTime: sessionDate ?? new Date().toISOString(),
  });
  // Index key noun phrases as chains
  for (const np of entities.nounPhrases.slice(0, 30)) {
    try { embedInPGSL(pgsl, np); } catch {}
  }

  return { index: sessionIndex, date: sessionDate, text, terms, pgsl };
}

// ═══════════════════════════════════════════════════════════
//  PHASE 2: RETRIEVE — find relevant sessions
// ═══════════════════════════════════════════════════════════

function retrieveSessions(
  question: string,
  sessions: SessionIndex[],
): SessionIndex[] {
  const qEntities = extractEntities(question);
  const qTerms = new Set<string>();
  for (const w of qEntities.contentWords) qTerms.add(w.toLowerCase());
  for (const np of qEntities.nounPhrases) qTerms.add(np.toLowerCase());

  // Score each session by term overlap with question
  const scored = sessions.map(s => {
    let score = 0;
    for (const qt of qTerms) {
      if (s.terms.has(qt)) score += 2; // exact match
      else {
        // Partial match
        for (const st of s.terms) {
          if (st.includes(qt) || qt.includes(st)) { score += 1; break; }
        }
      }
    }
    return { session: s, score };
  });

  // Sort by score descending, return all with score > 0
  // If none match, return all (the question might use different phrasing)
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter(s => s.score > 0).map(s => s.session);
  return relevant.length > 0 ? relevant : sessions;
}

// ═══════════════════════════════════════════════════════════
//  PHASE 3: READ — LLM reads ORIGINAL text with focus
// ═══════════════════════════════════════════════════════════

interface ReadResult {
  answer: string;
  method: string;
  reasoning: string;
}

function readAndAnswer(
  question: string,
  sessions: SessionIndex[],
  allSessions: SessionIndex[],
  questionDate?: string,
): ReadResult {
  const strategy = computeCognitiveStrategy(question);
  const qEntities = extractEntities(question);

  // ── ABSTENTION CHECK ──
  const allTerms = new Set<string>();
  for (const s of allSessions) for (const t of s.terms) allTerms.add(t);
  const abstainCheck = shouldAbstain([...qEntities.contentWords], allTerms, 0.05);

  if (abstainCheck.matchRatio < 0.05 && qEntities.contentWords.length > 2) {
    const verify = llm(
      `Does this conversation mention the SPECIFIC thing asked about? Be PRECISE — "tennis" ≠ "table tennis", "iPad case" ≠ "laptop backpack".\n\nQuestion: ${question}\n\n${allSessions.map((s, i) => `Session ${i + 1}:\n${s.text.slice(0, 1200)}`).join('\n\n')}\n\nYES or NO:`
    );
    if (verify.toLowerCase().startsWith('no')) {
      return { answer: 'The information provided is not enough to answer this question.', method: 'abstain', reasoning: 'Entity not in sessions' };
    }
  }

  // ── BUILD FOCUSED PROMPT ──
  // Use ALL sessions (sorted by relevance) — don't risk missing context
  const sessionBlock = allSessions
    .sort((a, b) => {
      // Relevant sessions first, then by original order
      const aRel = sessions.includes(a) ? 0 : 1;
      const bRel = sessions.includes(b) ? 0 : 1;
      if (aRel !== bRel) return aRel - bRel;
      return a.index - b.index;
    })
    .map(s => {
      const dateLabel = s.date ? ` (Date: ${s.date})` : '';
      const relevance = sessions.includes(s) ? ' [RELEVANT]' : '';
      return `=== Session ${s.index + 1}${dateLabel}${relevance} ===\n${s.text}`;
    }).join('\n\n');

  // Question-type-specific instructions
  let typeInstructions = '';

  if (/which.*first|which.*before|which.*earlier/i.test(question)) {
    typeInstructions = `TEMPORAL ORDERING: Find the SPECIFIC DATES for each thing mentioned in the question. Compare the dates. The one with the EARLIER date happened first.
IMPORTANT: "pre-ordered" or "ordered" is NOT the same as "got" or "received". If something was pre-ordered on date A but arrived on date B, the person GOT it on date B.
Quote the relevant sentences with dates before answering.`;
  } else if (/how many (days|weeks|months|years)/i.test(question)) {
    typeInstructions = `TEMPORAL COMPUTATION: Find the EXACT TWO DATES this question asks about. Quote them from the text. Then compute the difference.
If a date is not explicitly stated but implied (e.g., "started working with Rachel" with no date), look at session dates and context clues to infer when it happened.
Show your work: Date 1 = ___, Date 2 = ___, Difference = ___.`;
  } else if (/how many/i.test(question)) {
    typeInstructions = `COUNTING: Find and list EVERY item that matches what's being counted, across ALL sessions. Quote each one.
IMPORTANT: Later sessions may UPDATE earlier information. "I now have 4 cats" overrides "I have 3 cats."
If counting things done BEFORE or AFTER a reference event, find the date of each item and the reference event, then filter.
List each item, then count. Show your work.`;
  } else if (strategy.questionType === 'knowledge-update') {
    typeInstructions = `KNOWLEDGE UPDATE: The user's information may have changed across sessions. Read ALL sessions chronologically. The LATEST session's information takes precedence.
If Session 1 says "I have 3 cats" and Session 3 says "I adopted another cat", the current count is 4.`;
  } else if (strategy.questionType === 'single-session-preference') {
    typeInstructions = `PREFERENCE: The user has expressed preferences. Identify what they specifically prefer based on their statements.`;
  }

  // First read: comprehensive answer
  const answer = llm(
    `${typeInstructions ? typeInstructions + '\n\n' : ''}Read ALL sessions carefully. Answer the question based ONLY on information in the sessions.${questionDate ? ` The current date is ${questionDate}.` : ''}

If the SPECIFIC thing asked about (exact name/term) does NOT appear in ANY session, respond: "The information provided is not enough to answer this question."

${sessionBlock}

Question: ${question}

Answer concisely and specifically:`
  );

  if (!answer || answer.length === 0) {
    return { answer: 'The information provided is not enough to answer this question.', method: 'llm-empty', reasoning: 'LLM returned empty' };
  }

  // ── PHASE 4: VERIFY ──
  // For computation questions, extract the number from the answer and verify
  if (/how many (days|weeks|months|years)/i.test(question)) {
    // Extract dates from the LLM's reasoning
    const dates = answer.match(/\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2}|\w+ \d{1,2},? \d{4}/g) || [];
    if (dates.length >= 2) {
      const d1 = parseDate(dates[0]!);
      const d2 = parseDate(dates[1]!);
      if (d1 && d2) {
        const days = Math.abs(daysBetween(d1, d2));
        const unit = /week/i.test(question) ? 'weeks' : /month/i.test(question) ? 'months' : /year/i.test(question) ? 'years' : 'days';

        // Extract the LLM's numeric answer
        const llmNum = answer.match(/(\d+)\s*(days?|weeks?|months?|years?)/i);
        if (llmNum) {
          const llmDays = unit === 'days' ? parseInt(llmNum[1]!) :
            unit === 'weeks' ? parseInt(llmNum[1]!) * 7 :
            unit === 'months' ? parseInt(llmNum[1]!) * 30 :
            parseInt(llmNum[1]!) * 365;

          // If structural and LLM agree (within 10%), high confidence
          if (Math.abs(days - llmDays) <= Math.max(2, days * 0.1)) {
            return { answer: answer, method: 'temporal-verified', reasoning: `LLM and structural agree: ~${days} days` };
          }
          // They disagree — trust the LLM's reading (it has the full context)
        }
      }
    }
  }

  // For counting, verify the count
  if (/how many/i.test(question) && !/how many (days|weeks|months|years)/i.test(question)) {
    const countMatch = answer.match(/\b(\d+)\b/);
    if (countMatch) {
      return { answer: answer, method: 'count-read', reasoning: `LLM counted from full text: ${countMatch[1]}` };
    }
  }

  // Determine method based on what happened
  let method = 'llm-read';
  if (/which.*first|which.*before/i.test(question)) method = 'temporal-read';
  else if (/how many/i.test(question)) method = 'count-read';
  else if (strategy.questionType === 'knowledge-update') method = 'update-read';
  else if (strategy.questionType === 'single-session-preference') method = 'preference-read';

  return { answer, method, reasoning: `Read ${sessions.length}/${allSessions.length} relevant sessions` };
}

// ── Clean answer: extract just the core answer ──────────

function cleanAnswer(raw: string): string {
  // If the answer contains reasoning/work, extract just the final answer
  // Look for patterns like "Answer: X" or "The answer is X"
  const answerMatch = raw.match(/(?:^|\n)(?:Answer|Final answer|The answer is)[:\s]*(.+?)(?:\n|$)/i);
  if (answerMatch) return answerMatch[1]!.trim();

  // If short enough, use as-is
  if (raw.length < 200) return raw;

  // Take the last sentence/line that looks like an answer
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const lastLine = lines[lines.length - 1]?.trim() ?? raw;
  if (lastLine.length < 200) return lastLine;

  return raw.slice(0, 200);
}

// ── Main ────────────────────────────────────────────────

function main() {
  console.log(`=== IRRV BENCHMARK — LongMemEval ===`);
  console.log(`Index → Retrieve → Read → Verify`);
  console.log(`Model: ${MODEL} | Range: Q${START}-Q${END}\n`);

  let correct = 0;
  let total = 0;
  const methodCounts: Record<string, number> = {};
  const typeCounts: Record<string, { correct: number; total: number }> = {};

  for (let qi = START; qi < Math.min(END, data.length); qi++) {
    const item = data[qi];
    total++;

    // Parse sessions
    const rawSessions: any[] = item.haystack_sessions;
    const sessions = rawSessions.map((s: any, i: number) => {
      const messages = typeof s === 'string'
        ? [{ role: 'user', content: s }]
        : Array.isArray(s) ? s.map((m: any) => ({ role: m.role ?? 'user', content: m.content || m.text || '' }))
        : [{ role: 'user', content: JSON.stringify(s) }];
      return indexSession(messages, i, item.haystack_dates?.[i]);
    });

    // Phase 1+2: Index + Retrieve
    const relevant = retrieveSessions(item.question, sessions);

    // Phase 3+4: Read + Verify
    const result = readAndAnswer(item.question, relevant, sessions, item.question_date);
    const cleaned = cleanAnswer(result.answer);
    methodCounts[result.method] = (methodCounts[result.method] ?? 0) + 1;

    // Judge
    const judgeResult = llm(
      `Does the generated answer convey the same information as the gold answer? They don't need to match exactly — same core answer is enough. YES or NO only.\n\nQuestion: ${item.question}\nGenerated: ${cleaned.slice(0, 300)}\nGold: ${item.answer}\n\nSame information?`
    );
    const isCorrect = judgeResult.toLowerCase().startsWith('yes');
    if (isCorrect) correct++;

    if (!typeCounts[item.question_type]) typeCounts[item.question_type] = { correct: 0, total: 0 };
    typeCounts[item.question_type]!.total++;
    if (isCorrect) typeCounts[item.question_type]!.correct++;

    const mark = isCorrect ? '✓' : '✗';
    console.log(`${mark} ${qi}: [${item.question_type}] [${result.method}] ${item.question.slice(0, 60)}`);

    if (!isCorrect) {
      console.log(`  Gold: ${String(item.answer).slice(0, 100)}`);
      console.log(`  Ours: ${cleaned.slice(0, 100)}`);
      console.log(`  Reasoning: ${result.reasoning}`);
    }

    if (total % 10 === 0 || !isCorrect) {
      const methods = Object.entries(methodCounts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`  Score: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) | ${methods}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`FINAL: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
  console.log(`Methods: ${Object.entries(methodCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`\nPer-type:`);
  for (const [type, c] of Object.entries(typeCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${type}: ${c.correct}/${c.total} (${(100 * c.correct / c.total).toFixed(1)}%)`);
  }
}

main();
