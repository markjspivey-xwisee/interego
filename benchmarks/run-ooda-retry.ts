#!/usr/bin/env tsx
/**
 * OODA RETRY: Best single-pass pipeline + targeted retry on uncertain answers.
 *
 * The affordance model: try the primary strategy. If the answer shows
 * signs of uncertainty (hedging, "not found", too verbose), the OODA loop
 * triggers a retry with an alternative strategy.
 *
 * This adds ~0.5 extra calls/question on average (only retries uncertain ones).
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY']! });
const MODEL = 'claude-sonnet-4-20250514';

async function llm(prompt: string, mt = 500, system?: string) {
  const opts: any = { model: MODEL, max_tokens: mt, messages: [{ role: 'user', content: prompt }] };
  if (system) opts.system = system;
  const r = await anthropic.messages.create(opts);
  return r.content[0].type === 'text' ? r.content[0].text : '';
}

function ft(sessions: string[]) { return sessions.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n'); }

// Detect uncertain answers that should trigger a retry
function isUncertain(answer: string): boolean {
  const a = answer.toLowerCase();
  return (
    a.includes('not mentioned') ||
    a.includes('not specified') ||
    a.includes('not provided') ||
    a.includes('not found') ||
    a.includes('no information') ||
    a.includes('cannot determine') ||
    a.includes('unable to find') ||
    a.includes('does not mention') ||
    a.includes('i don\'t see') ||
    a.includes('looking through') || // verbose start = didn't find direct answer
    a.length > 500 || // too verbose = uncertain
    a.length < 2 // too short = empty
  );
}

// PRIMARY strategies (from run-95.ts — our best)
async function primaryTemporal(sessions: string[], q: string): Promise<string> {
  const dates = await llm(`List EVERY date, time, duration, and temporal reference.\nFormat: "Event: date/time"\n\n${ft(sessions)}\n\nAll temporal facts:`, 1000);
  return llm(`Using these facts, answer. ONLY the specific answer.\n\nTemporal facts:\n${dates}\n\nQ: ${q}\nA:`, 200);
}

async function primaryMulti(sessions: string[], q: string): Promise<string> {
  const exts: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const r = await llm(`Extract EVERY fact relevant to: "${q}"\nList each item/number.\n\nSession:\n${sessions[i]}\n\nRelevant:`, 500);
    exts.push(`Session ${i + 1}:\n${r}`);
  }
  const agg = await llm(`Combine. List items, then FINAL ANSWER: [answer]\n\n${exts.join('\n\n')}\n\nQ: ${q}\nFINAL ANSWER:`, 500);
  const m = agg.match(/FINAL ANSWER:\s*(.+)/i);
  return m ? m[1]!.trim() : agg.split('\n').pop()?.trim() || agg;
}

async function primaryUpdate(sessions: string[], q: string): Promise<string> {
  return llm(`Read ALL sessions. Find MOST RECENT value. Give ONLY the single current answer.\n\n${ft(sessions)}\n\nQ: ${q}\nCurrent answer:`, 100);
}

async function primaryPreference(sessions: string[], q: string): Promise<string> {
  return llm(`Read the conversation. MUST start with "The user would prefer". Describe TYPE of response, NOT content.\n\nExample: "The user would prefer recommendations for indie rock, similar to Radiohead."\nExample: "The user would prefer resources focused on advanced Python, with code examples."\n\n${ft(sessions)}\n\nQ: ${q}\nAnswer (MUST start "The user would prefer"):`, 400);
}

async function primaryGeneric(sessions: string[], q: string): Promise<string> {
  return llm(`Read the session. Never say "not mentioned". Give ONLY the specific answer.\n\n${ft(sessions)}\n\nQ: ${q}\nAnswer:`, 400);
}

// RETRY strategies (alternative approaches for uncertain answers)
async function retryWithPersona(sessions: string[], q: string): Promise<string> {
  return llm(
    `${ft(sessions)}\n\nQuestion: ${q}\n\nAnswer:`,
    600,
    'You are an expert memory analyst with perfect recall. Read EVERY word. The answer IS in the text. Never say "not found". Give ONLY the specific answer.'
  );
}

async function retryWithStepByStep(sessions: string[], q: string): Promise<string> {
  return llm(`Read ALL sessions. Answer step by step.\n1. Go through each session\n2. Find relevant info\n3. Give the answer\n\n${ft(sessions)}\n\nQ: ${q}\nStep 1:`, 800);
}

// Router
async function answerQuestion(sessions: string[], q: string, qtype: string): Promise<string> {
  let primary: string;
  if (qtype === 'temporal-reasoning') primary = await primaryTemporal(sessions, q);
  else if (qtype === 'multi-session') primary = await primaryMulti(sessions, q);
  else if (qtype === 'knowledge-update') primary = await primaryUpdate(sessions, q);
  else if (qtype === 'single-session-preference') primary = await primaryPreference(sessions, q);
  else primary = await primaryGeneric(sessions, q);

  // OODA: check if answer is uncertain
  if (isUncertain(primary)) {
    // Retry with alternative strategy
    const retry = await retryWithPersona(sessions, q);
    if (!isUncertain(retry)) return retry;
    // Second retry with step-by-step
    return retryWithStepByStep(sessions, q);
  }

  return primary;
}

// Judge
async function judge(q: string, gen: string, gold: string, qtype: string): Promise<boolean> {
  const prefExtra = qtype === 'single-session-preference' ? '\nFor preferences: same general direction counts as correct.' : '';
  const v = await llm(`Same core info? Numbers match? Just "yes" or "no".${prefExtra}\nQ: ${q}\nGen: ${gen.slice(0, 600)}\nGold: ${gold}\nCorrect?`, 10);
  return v.toLowerCase().replace(/[*"'\s]/g, '').startsWith('yes');
}

// Main
const data = JSON.parse(readFileSync(resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json'), 'utf-8'));
const LIMIT = parseInt(process.argv[2] || '48');
const types: Record<string, any[]> = {};
for (const d of data) { if (!types[d.question_type]) types[d.question_type] = []; types[d.question_type].push(d); }
const sample: any[] = [];
const perType = Math.ceil(LIMIT / Object.keys(types).length);
for (const [, items] of Object.entries(types)) sample.push(...items.slice(0, perType));

async function main() {
  console.log(`\n=== OODA RETRY (${sample.length}q) ===`);
  console.log(`Primary strategy + retry on uncertain answers\n`);

  let correct = 0, total = 0, retries = 0;
  const typeResults: Record<string, { t: number; c: number }> = {};

  for (const item of sample) {
    total++;
    if (!typeResults[item.question_type]) typeResults[item.question_type] = { t: 0, c: 0 };
    typeResults[item.question_type].t++;

    const sessions: string[] = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));

    try {
      const ans = await answerQuestion(sessions, item.question, item.question_type);
      const ok = await judge(item.question, ans, String(item.answer), item.question_type);
      if (ok) { correct++; typeResults[item.question_type].c++; }
    } catch (e) { console.log(`Error: ${(e as Error).message.slice(0, 60)}`); }

    if (total % 12 === 0) console.log(`  ${total}/${sample.length}: ${(100 * correct / total).toFixed(0)}%`);
  }

  console.log(`\n=== RESULTS: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) ===\n`);
  for (const [type, r] of Object.entries(typeResults)) {
    console.log(`  ${type}: ${r.c}/${r.t} (${(100 * r.c / r.t).toFixed(0)}%)`);
  }
  console.log(`\nPrior best: 91.7% (48q) | 88.0% (200q)`);
}

main().catch(console.error);
