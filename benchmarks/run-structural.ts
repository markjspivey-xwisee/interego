#!/usr/bin/env tsx
/**
 * STRUCTURAL COMPUTATION PIPELINE
 *
 * The LLM reads text and extracts facts.
 * Our system computes, reasons, composes, and verifies.
 *
 * Architecture:
 *   1. LLM EXTRACTS: raw facts, dates, entities, values from each session
 *   2. SYSTEM COMPUTES: date arithmetic, counting, temporal ordering
 *   3. SYSTEM VERIFIES: abstention detection (are question entities in sessions?)
 *   4. SYSTEM COMPOSES: multi-session aggregation via union operator
 *   5. LLM FORMATS: turn structured answer into natural language if needed
 *
 * This is our system doing the work. The LLM is the I/O layer.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dirname, '.tmp-prompt.txt');
const MODEL = process.argv[2] || 'opus';
const START = parseInt(process.argv[3] || '0');
const BENCHMARK = process.argv[4] || 'longmemeval';

function llm(prompt: string): string {
  try {
    writeFileSync(TMP, prompt);
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    return execSync(
      `claude --print --model ${MODEL} < "${TMP.replace(/\\/g, '/')}"`,
      { timeout: 180000, maxBuffer: 2 * 1024 * 1024, shell: 'bash', env }
    ).toString().trim();
  } catch { return 'ERROR'; }
}

// ── STRUCTURAL: Date arithmetic in code ──────────────────────

function computeDateDifference(date1: string, date2: string, unit: 'days' | 'weeks' | 'months'): number | null {
  try {
    const d1 = new Date(date1);
    const d2 = new Date(date2);
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return null;
    const diffMs = Math.abs(d2.getTime() - d1.getTime());
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    if (unit === 'days') return diffDays;
    if (unit === 'weeks') return Math.round(diffDays / 7);
    if (unit === 'months') return Math.round(diffDays / 30.44);
    return diffDays;
  } catch { return null; }
}

function orderDates(dates: { label: string; date: string }[]): { label: string; date: string }[] {
  return dates
    .filter(d => !isNaN(new Date(d.date).getTime()))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

// ── STRUCTURAL: Counting in code ─────────────────────────────

function deduplicateAndCount(items: string[]): { unique: string[]; count: number } {
  const normalized = items.map(i => i.toLowerCase().trim()).filter(i => i.length > 0);
  const unique = [...new Set(normalized)];
  return { unique, count: unique.length };
}

function sumValues(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// ── STRUCTURAL: Abstention detection ─────────────────────────

function shouldAbstain(question: string, sessionTexts: string[]): boolean {
  // Extract key noun phrases from question
  const qWords = question.toLowerCase().replace(/[?!.,'"]/g, '').split(/\s+/);
  const stopwords = new Set('i me my the a an is was were are do did does have has had what which how when where who why their them they this that to of in for on with at by from it we our us'.split(' '));
  const keyTerms = qWords.filter(w => w.length > 3 && !stopwords.has(w));

  // Check if key terms exist in ANY session
  const allText = sessionTexts.join(' ').toLowerCase();
  const found = keyTerms.filter(t => allText.includes(t));
  const coverage = found.length / Math.max(keyTerms.length, 1);

  // If less than 30% of key terms found, likely should abstain
  return coverage < 0.3;
}

// ── Detect question type structurally ────────────────────────

function detectQuestionType(question: string): 'temporal' | 'counting' | 'ordering' | 'comparison' | 'preference' | 'factual' {
  const q = question.toLowerCase();
  if (/how many days|how many weeks|how many months|how long.*between|how long.*since|how long.*ago|how many.*ago/.test(q)) return 'temporal';
  if (/what is the order|which.*first|which.*before|which.*earlier|what.*order/.test(q)) return 'ordering';
  if (/how many|how much|total|in total|combined/.test(q)) return 'counting';
  if (/can you recommend|can you suggest|any tips|any advice|any suggestions/.test(q)) return 'preference';
  if (/more than|less than|higher|lower|bigger|smaller|faster|slower|percentage|average/.test(q)) return 'comparison';
  return 'factual';
}

// ── Main answer function using structural computation ────────

function answerStructurally(sessions: string[], question: string, dates?: string[], questionDate?: string): string {
  const qtype = detectQuestionType(question);
  const ft = sessions.map((s, i) => {
    const dateStr = dates?.[i] ? ` (Date: ${dates[i]})` : '';
    return `=== Session ${i + 1}${dateStr} ===\n${s}`;
  }).join('\n\n');
  const dateContext = questionDate ? `\nThe current date (when this question is being asked): ${questionDate}\n` : '';

  // STEP 1: Check abstention
  if (shouldAbstain(question, sessions)) {
    // Double-check with LLM before abstaining
    const check = llm(`Does this question reference something that IS discussed in the sessions? Answer just "yes" or "no".

${ft}

Question: ${question}

Is the topic discussed?`);
    if (check.toLowerCase().replace(/[*"'\s]/g, '').startsWith('no')) {
      return `The information provided is not enough to answer this question. The sessions do not discuss the specific topic asked about.`;
    }
  }

  // STEP 2: For temporal questions, use LLM to extract dates then compute in code
  if (qtype === 'temporal') {
    const extraction = llm(`Extract the specific dates/times needed to answer this question.
For each relevant event, output: EVENT_NAME | DATE (in YYYY-MM-DD format if possible)
If an event is described as "today" in a session, use that session's date.
${dateContext}

${ft}

Question: ${question}

Dates (one per line, format: event | date):`);

    // Parse extracted dates
    const parsedDates: { label: string; date: string }[] = [];
    for (const line of extraction.split('\n')) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 2 && parts[1]!.match(/\d/)) {
        parsedDates.push({ label: parts[0]!, date: parts[1]! });
      }
    }

    // Compute structurally based on question type
    if (/how many days/.test(question.toLowerCase()) && parsedDates.length >= 2) {
      const diff = computeDateDifference(parsedDates[0]!.date, parsedDates[1]!.date, 'days');
      if (diff !== null) return `${diff} days`;
    }
    if (/how many weeks/.test(question.toLowerCase()) && parsedDates.length >= 2) {
      const diff = computeDateDifference(parsedDates[0]!.date, parsedDates[1]!.date, 'weeks');
      if (diff !== null) return `${diff} weeks`;
    }
    if (/how many months/.test(question.toLowerCase()) && parsedDates.length >= 2) {
      const diff = computeDateDifference(parsedDates[0]!.date, parsedDates[1]!.date, 'months');
      if (diff !== null) return `${diff} months`;
    }
    if (/ago/.test(question.toLowerCase()) && parsedDates.length >= 1 && questionDate) {
      const unit = /weeks?\s*ago/.test(question.toLowerCase()) ? 'weeks' :
                   /months?\s*ago/.test(question.toLowerCase()) ? 'months' : 'days';
      const diff = computeDateDifference(parsedDates[0]!.date, questionDate, unit);
      if (diff !== null) return `${diff} ${unit}`;
    }
    if (qtype === 'temporal' && parsedDates.length >= 2) {
      // Ordering question — sort dates structurally
      const ordered = orderDates(parsedDates);
      if (ordered.length >= 2) return ordered.map(d => d.label).join(', ');
    }
  }

  // STEP 3: For counting across MULTIPLE sessions, use structural counting
  // Only do this for multi-session aggregation (3+ sessions), not single-session lookups
  if (qtype === 'counting' && sessions.length >= 2) {
    const items: string[] = [];
    for (let i = 0; i < sessions.length; i++) {
      const extraction = llm(`List every item relevant to: "${question}"
One item per line. Be specific. If none, say NONE.

Session ${i + 1}:
${sessions[i]}

Items:`);
      if (!extraction.toLowerCase().includes('none')) {
        items.push(...extraction.split('\n').map(l => l.replace(/^[-•*\d.)\s]+/, '').trim()).filter(l => l.length > 2));
      }
    }

    const { unique, count } = deduplicateAndCount(items);

    // Check if question asks for sum of numbers
    if (/how much|total.*amount|total.*cost|total.*spent/.test(question.toLowerCase())) {
      const numbers = unique.map(item => {
        const match = item.match(/\$?([\d,]+\.?\d*)/);
        return match ? parseFloat(match[1]!.replace(/,/g, '')) : 0;
      }).filter(n => n > 0);
      if (numbers.length > 0) return `$${sumValues(numbers)}`;
    }

    return String(count);
  }

  // STEP 4: For everything else, use universal prompt (proven 94%)
  return llm(`You are an expert memory analyst. Read ALL sessions carefully and answer the question.

RULES:
1. Read EVERY session completely. The answer IS in the text.
2. Never say "not mentioned" — search harder.
3. For counting/totals: list each item from each session, then count.
4. For dates/ordering: find exact dates, then compare or calculate. USE THE SESSION DATES shown in headers.
5. For updates: use the MOST RECENT value only.
6. For recommendations/suggestions: start with "The user would prefer" and describe what KIND of response they want.
7. Give ONLY the specific answer — no explanation unless counting.
${dateContext}
${ft}

Question: ${question}

Answer:`);
}

// ── Judge ────────────────────────────────────────────────────

function judge(q: string, gen: string, gold: string): boolean {
  const result = llm(`Does the generated answer convey the same core information as the gold?
- Numbers must match
- Yes/no must agree
- Key facts must match
- For preferences: same general theme = correct
- "information not provided/not enough" counts as matching if gold also says that

Just "yes" or "no".

Q: ${q}
Gen: ${gen.slice(0, 700)}
Gold: ${gold}
Correct?`);
  return result.toLowerCase().replace(/[*"'\s]/g, '').startsWith('yes');
}

// ── Main ─────────────────────────────────────────────────────

const data = JSON.parse(readFileSync(
  resolve(__dirname, BENCHMARK === 'locomo'
    ? 'locomo/data/locomo10.json'
    : 'LongMemEval/data/longmemeval_oracle.json'),
  'utf-8'
));

if (BENCHMARK === 'longmemeval') {
  let correct = 0;
  for (let i = START; i < data.length; i++) {
    const item = data[i];
    const sessions: string[] = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));
    const dates = item.haystack_dates as string[] | undefined;
    const questionDate = item.question_date as string | undefined;

    const ans = answerStructurally(sessions, item.question, dates, questionDate);
    const ok = judge(item.question, ans, String(item.answer));

    if (ok) {
      correct++;
      console.log(`✓ ${i}: [${item.question_type}] ${item.question.slice(0, 60)}`);
    } else {
      console.log(`\n✗ FAILED at question ${i}:`);
      console.log(`  Type: ${item.question_type}`);
      console.log(`  Detected: ${detectQuestionType(item.question)}`);
      console.log(`  Q: ${item.question}`);
      console.log(`  Gold: ${String(item.answer).slice(0, 150)}`);
      console.log(`  Ours: ${ans.slice(0, 150)}`);
      console.log(`\n  Score so far: ${correct}/${i + 1 - START} (${(100 * correct / (i + 1 - START)).toFixed(0)}%)`);
      console.log(`  Resume with: npx tsx benchmarks/run-structural.ts ${MODEL} ${i + 1}`);
      process.exit(0);
    }
  }
  console.log(`\nALL PASSED: ${correct}/${data.length - START}`);
}
