#!/usr/bin/env tsx
/**
 * Diagnose ALL failures on LongMemEval.
 * For each wrong answer: log the question, gold, generated, and failure reason.
 * Categorize failures to find systematic fixes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env['ANTHROPIC_API_KEY'];
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

const PROMPTS: Record<string, string> = {
  'temporal-reasoning': `You are answering a question about timing, dates, or ordering of events from a user's conversation history.

INSTRUCTIONS:
- Read ALL sessions completely
- Pay careful attention to dates, times, day names, and temporal phrases like "first", "before", "after"
- For "how many days between X and Y" — find exact dates for both events, then calculate the difference
- For "which came first" — find dates for both, compare
- For "what time" — find the specific time mentioned
- For "how old was I when" — find the user's birth year/age and the event date
- Give ONLY the specific answer (number, date, time, or event name)
- If the answer is a number of days, just say the number followed by "days"`,

  'multi-session': `You are answering a question that requires combining information from MULTIPLE conversation sessions.

INSTRUCTIONS:
- Read ALL sessions completely — the answer spans multiple sessions
- For "how many total" or "how many in total" — find EVERY instance across ALL sessions, list them, then count
- For "how much total" or "total amount" — find EVERY amount across ALL sessions, list them, then sum
- For percentage questions — find the numbers needed, then calculate
- For average questions — find all values, then compute the average
- For comparison questions — find both values, then compare
- CRITICAL: State the final answer as a single number or short phrase on its own line at the END
- Before the final answer, show your work: list each item/number found in each session`,

  'knowledge-update': `You are answering a question about the user's CURRENT state, which may have been updated over time.

INSTRUCTIONS:
- Read ALL sessions completely
- Look for information that was UPDATED or CORRECTED later in the conversation
- If there are contradictions between sessions, use the MOST RECENT information
- For "do I still" or "am I still" — check if the status changed
- For "how many now" — check if the count was updated
- Give ONLY the current/latest answer`,

  'single-session-preference': `You are describing the user's preferences based on their conversation.

INSTRUCTIONS:
- Read the session carefully for clues about the user's preferences, expertise, and interests
- Your answer should describe WHAT KIND of response the user would prefer in the future
- Start with "The user would prefer..."
- Include: preferred tools/brands, expertise level, style preferences, specific interests mentioned
- Example: "The user would prefer responses that focus on advanced Python techniques, specifically pandas and scikit-learn, with code examples rather than theoretical explanations."`,

  'single-session-assistant': `You are answering a question about what the AI assistant said or recommended.

INSTRUCTIONS:
- Read the session carefully
- Focus on what the ASSISTANT said, suggested, recommended, or provided
- Give ONLY the specific answer — the exact recommendation, suggestion, or information the assistant gave`,

  'single-session-user': `You are answering a question about the user's personal information, habits, or experiences.

INSTRUCTIONS:
- Read the session carefully
- Focus on what the USER said about themselves — personal details, habits, experiences, possessions, relationships
- Give ONLY the specific answer
- If the user mentioned a specific number, name, or detail, include it exactly`,
};

interface Failure {
  question_type: string;
  question: string;
  gold: string;
  generated: string;
  failure_category: string;
}

async function main() {
  const dataPath = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8')) as any[];

  const LIMIT = parseInt(process.argv[2] || '200');

  // Stratified sample
  const types: Record<string, any[]> = {};
  for (const d of data) { if (!types[d.question_type]) types[d.question_type] = []; types[d.question_type].push(d); }
  const sample: any[] = [];
  const perType = Math.ceil(LIMIT / Object.keys(types).length);
  for (const [, items] of Object.entries(types)) { sample.push(...items.slice(0, perType)); }

  console.log(`\n=== Failure Diagnosis (${sample.length}q) ===\n`);

  let correct = 0, total = 0;
  const failures: Failure[] = [];
  const typeResults: Record<string, { total: number; correct: number }> = {};

  for (const item of sample) {
    total++;
    if (!typeResults[item.question_type]) typeResults[item.question_type] = { total: 0, correct: 0 };
    typeResults[item.question_type].total++;

    const sessions: string[] = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s)
    );

    const fullText = sessions.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n');
    const typePrompt = PROMPTS[item.question_type] || 'Answer the question based on the sessions.';

    try {
      const resp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: `${typePrompt}\n\nCONVERSATION HISTORY:\n${fullText}\n\nQuestion: ${item.question}\n\nAnswer:` }],
      });
      const answer = resp.content[0].type === 'text' ? resp.content[0].text : '';

      // Judge
      const judgeResp = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 20,
        messages: [{ role: 'user', content: `Does the generated answer convey the same core information as the gold answer? For numbers, they must be equal. For yes/no, they must agree. For descriptions, the key facts must match. Answer "yes" or "no", then briefly why.\n\nQuestion: ${item.question}\nGenerated: ${answer.slice(0, 600)}\nGold: ${item.answer}\n\nVerdict:` }],
      });
      const verdict = judgeResp.content[0].type === 'text' ? judgeResp.content[0].text : '';
      const isCorrect = verdict.toLowerCase().startsWith('yes');

      if (isCorrect) {
        correct++;
        typeResults[item.question_type].correct++;
      } else {
        // Categorize the failure
        let category = 'unknown';
        const goldStr = String(item.answer).toLowerCase();
        const ansStr = answer.toLowerCase();

        if (ansStr.includes('not mention') || ansStr.includes('not provided') || ansStr.includes('no information') || ansStr.includes('not specified') || ansStr.includes('does not')) {
          category = 'abstention (said not found but answer exists)';
        } else if (/^\d/.test(goldStr) && /^\d/.test(ansStr.trim())) {
          category = 'wrong number';
        } else if (goldStr.startsWith('yes') || goldStr.startsWith('no')) {
          category = 'wrong yes/no';
        } else if (item.question_type === 'single-session-preference') {
          category = 'preference format mismatch';
        } else {
          category = 'wrong fact';
        }

        failures.push({
          question_type: item.question_type,
          question: item.question,
          gold: String(item.answer).slice(0, 200),
          generated: answer.slice(0, 200),
          failure_category: category,
        });
      }
    } catch (e) {
      failures.push({
        question_type: item.question_type,
        question: item.question,
        gold: String(item.answer).slice(0, 200),
        generated: `ERROR: ${(e as Error).message.slice(0, 100)}`,
        failure_category: 'error',
      });
    }

    if (total % 20 === 0) {
      console.log(`  ${total}/${sample.length}: ${(100 * correct / total).toFixed(0)}%`);
    }
  }

  console.log(`\n=== RESULTS: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) ===\n`);

  for (const [type, res] of Object.entries(typeResults)) {
    console.log(`  ${type}: ${res.correct}/${res.total} (${(100 * res.correct / res.total).toFixed(0)}%)`);
  }

  // Failure category breakdown
  const categories: Record<string, number> = {};
  for (const f of failures) {
    categories[f.failure_category] = (categories[f.failure_category] || 0) + 1;
  }
  console.log(`\n=== FAILURE CATEGORIES ===`);
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  // Write detailed failures to file
  const failureReport = failures.map(f =>
    `[${f.question_type}] ${f.failure_category}\n  Q: ${f.question}\n  Gold: ${f.gold}\n  Ours: ${f.generated}\n`
  ).join('\n');

  writeFileSync(resolve(__dirname, 'failure-report.txt'), failureReport);
  console.log(`\nDetailed failures written to benchmarks/failure-report.txt`);
}

main().catch(console.error);
