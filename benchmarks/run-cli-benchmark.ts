#!/usr/bin/env tsx
/**
 * Benchmark using Claude Code CLI (--print mode).
 * Uses the Claude Code subscription instead of API keys.
 *
 * Architecture:
 *   1. Full sessions sent to Claude via CLI
 *   2. Type-specialized prompts for each question category
 *   3. Claude CLI judge evaluates correctness
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] || 'sonnet';

function callClaude(prompt: string, model: string = MODEL): string {
  try {
    // Write prompt to temp file to avoid shell escaping issues
    const tmpFile = resolve(__dirname, '.tmp-prompt.txt');
    writeFileSync(tmpFile, prompt);
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    const result = execSync(
      `claude --print --model ${model} < "${tmpFile.replace(/\\/g, '/')}"`,
      { timeout: 120000, maxBuffer: 1024 * 1024, shell: 'bash', env }
    );
    return result.toString().trim();
  } catch (e) {
    return `ERROR: ${(e as Error).message.slice(0, 100)}`;
  }
}

const PROMPTS: Record<string, string> = {
  'temporal-reasoning': 'Read ALL sessions. Pay attention to DATES and ORDERING. Give ONLY the specific answer.',
  'multi-session': 'Read ALL sessions. COMBINE info. For totals — SUM. For counts — COUNT. Give the FINAL ANSWER FIRST, then explain briefly.',
  'knowledge-update': 'Read ALL sessions. Find the MOST RECENT value. Give ONLY the answer.',
  'single-session-preference': 'Read the session. Describe what kind of response the user would prefer. Start with "The user would prefer..."',
  'single-session-assistant': 'Answer based on what the assistant said. Give ONLY the answer.',
  'single-session-user': 'Answer based on user personal info. Give ONLY the answer.',
};

async function main() {
  const dataPath = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8')) as any[];

  const LIMIT = parseInt(process.argv[3] || '48');

  // Stratified sample
  const types: Record<string, any[]> = {};
  for (const d of data) { if (!types[d.question_type]) types[d.question_type] = []; types[d.question_type].push(d); }
  const sample: any[] = [];
  const perType = Math.ceil(LIMIT / Object.keys(types).length);
  for (const [, items] of Object.entries(types)) { sample.push(...items.slice(0, perType)); }

  console.log(`\n=== CLI Benchmark (${sample.length}q, model: ${MODEL}) ===`);
  console.log(`Using Claude Code CLI subscription (no API key needed)\n`);

  let correct = 0, total = 0;
  const typeResults: Record<string, { total: number; correct: number }> = {};

  for (const item of sample) {
    total++;
    if (!typeResults[item.question_type]) typeResults[item.question_type] = { total: 0, correct: 0 };
    typeResults[item.question_type].total++;

    const sessions: string[] = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s)
    );

    const fullText = sessions.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n');
    const typePrompt = PROMPTS[item.question_type] || 'Answer the question.';

    // Generate answer
    const answerPrompt = `${typePrompt}\n\n${fullText}\n\nQuestion: ${item.question}\n\nAnswer:`;
    const answer = callClaude(answerPrompt);

    // Judge
    const judgePrompt = `Is this answer semantically equivalent to the gold answer? Numbers must match. Core meaning counts. Answer ONLY "yes" or "no".\n\nQuestion: ${item.question}\nGenerated: ${answer.slice(0, 500)}\nGold: ${item.answer}\n\nCorrect:`;
    const judgeResult = callClaude(judgePrompt, 'haiku');
    const isCorrect = judgeResult.toLowerCase().startsWith('yes');

    if (isCorrect) {
      correct++;
      typeResults[item.question_type].correct++;
    }

    if (total % 10 === 0) {
      console.log(`  ${total}/${sample.length}: ${(100 * correct / total).toFixed(0)}%`);
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
  for (const [type, res] of Object.entries(typeResults)) {
    console.log(`  ${type}: ${res.correct}/${res.total} (${(100 * res.correct / res.total).toFixed(0)}%)`);
  }
  console.log(`\nModel: ${MODEL} (via Claude Code CLI subscription)`);
  console.log(`Cost: $0 (included in subscription)`);
}

main().catch(console.error);
