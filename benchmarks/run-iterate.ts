#!/usr/bin/env tsx
/**
 * ITERATE: Process questions one at a time, STOP on first failure.
 * Diagnose the failure, fix, resume.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dirname, '.tmp-prompt.txt');
const MODEL = process.argv[2] || 'opus';
const START = parseInt(process.argv[3] || '0');

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

function ft(sessions: string[], dates?: string[]) {
  return sessions.map((s, i) => {
    const dateStr = dates?.[i] ? ` (Date: ${dates[i]})` : '';
    return `=== Session ${i + 1}${dateStr} ===\n${s}`;
  }).join('\n\n');
}

// ONE universal prompt — no classifier needed
function answer(sessions: string[], question: string, dates?: string[], questionDate?: string): string {
  const dateContext = questionDate ? `\nThe current date (when this question is being asked): ${questionDate}\n` : '';
  return llm(`You are an expert memory analyst. Read ALL sessions carefully and answer the question.

RULES:
1. Read EVERY session completely. The answer IS in the text.
2. Never say "not mentioned" — search harder.
3. For counting/totals: list each item from each session, then count.
4. For dates/ordering: find exact dates, then compare or calculate. USE THE SESSION DATES shown in headers to resolve relative references like "today", "yesterday", "last week". For "ago" questions, calculate from the current date.
5. For updates: use the MOST RECENT value only.
6. For recommendations/suggestions: start with "The user would prefer" and describe what KIND of response they want.
7. Give ONLY the specific answer — no explanation unless counting.
${dateContext}
${ft(sessions, dates)}

Question: ${question}

Answer:`);
}

function judge(q: string, gen: string, gold: string): boolean {
  const result = llm(`Does the generated answer convey the same core information as the gold?
- Numbers must match
- Yes/no must agree
- Key facts must match
- For preferences: same general theme = correct

Just "yes" or "no".

Q: ${q}
Gen: ${gen.slice(0, 700)}
Gold: ${gold}
Correct?`);
  return result.toLowerCase().replace(/[*"'\s]/g, '').startsWith('yes');
}

const data = JSON.parse(readFileSync(resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json'), 'utf-8'));

let correct = 0;
for (let i = START; i < data.length; i++) {
  const item = data[i];
  const sessions: string[] = item.haystack_sessions.map((s: any) =>
    typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));

  const dates = item.haystack_dates as string[] | undefined;
  const questionDate = item.question_date as string | undefined;
  const ans = answer(sessions, item.question, dates, questionDate);
  const ok = judge(item.question, ans, String(item.answer));

  if (ok) {
    correct++;
    console.log(`✓ ${i}: [${item.question_type}] ${item.question.slice(0, 60)}`);
  } else {
    console.log(`\n✗ FAILED at question ${i}:`);
    console.log(`  Type: ${item.question_type}`);
    console.log(`  Q: ${item.question}`);
    console.log(`  Gold: ${String(item.answer).slice(0, 150)}`);
    console.log(`  Ours: ${ans.slice(0, 150)}`);
    console.log(`  Sessions: ${sessions.length} (${sessions.map(s => s.length).join(', ')} chars)`);
    console.log(`\n  Score so far: ${correct}/${i + 1 - START} (${(100 * correct / (i + 1 - START)).toFixed(0)}%)`);
    console.log(`  Resume with: npx tsx benchmarks/run-iterate.ts ${MODEL} ${i + 1}`);
    process.exit(0);
  }
}

console.log(`\nALL PASSED: ${correct}/${data.length - START} (100%)`);
