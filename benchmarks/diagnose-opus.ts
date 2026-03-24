#!/usr/bin/env tsx
/**
 * Diagnose every failure from the Opus 48q run.
 * Uses CLI subscription (opus model).
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dirname, '.tmp-prompt.txt');
const MODEL = 'opus';

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

function ft(sessions: string[]) { return sessions.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n'); }

// Same strategies as run-ultimate-cli.ts
function answerTemporal(sessions: string[], q: string): string {
  const dates = llm(`List EVERY date, time, duration in these conversations.\nFormat: "Event: date/time"\n\n${ft(sessions)}\n\nAll temporal facts:`);
  return llm(`Using these facts, answer. ONLY the specific answer.\n\nTemporal facts:\n${dates}\n\nQ: ${q}\nA:`);
}

function answerMulti(sessions: string[], q: string): string {
  const exts: string[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const r = llm(`Extract EVERY fact relevant to: "${q}"\nList each item/number.\n\nSession:\n${sessions[i]}\n\nRelevant:`);
    exts.push(`Session ${i + 1}:\n${r}`);
  }
  const agg = llm(`Combine. List items, then FINAL ANSWER: [answer]\n\n${exts.join('\n\n')}\n\nQ: ${q}\nFINAL ANSWER:`);
  const m = agg.match(/FINAL ANSWER:\s*(.+)/i);
  return m ? m[1]!.trim() : agg.split('\n').pop()?.trim() || agg;
}

function answerUpdate(sessions: string[], q: string): string {
  return llm(`Read ALL sessions. MOST RECENT value only. ONE answer.\n\n${ft(sessions)}\n\nQ: ${q}\nCurrent answer:`);
}

function answerPreference(sessions: string[], q: string): string {
  return llm(`MUST start with "The user would prefer". Describe TYPE of response.\n\nExample: "The user would prefer recommendations for indie rock, similar to Radiohead."\n\n${ft(sessions)}\n\nQ: ${q}\nAnswer:`);
}

function answerGeneric(sessions: string[], q: string): string {
  return llm(`Read ENTIRE session. Answer IS there. Never say "not mentioned". ONLY the answer.\n\n${ft(sessions)}\n\nQ: ${q}\nAnswer:`);
}

const ROUTER: Record<string, (s: string[], q: string) => string> = {
  'temporal-reasoning': answerTemporal,
  'multi-session': answerMulti,
  'knowledge-update': answerUpdate,
  'single-session-preference': answerPreference,
  'single-session-assistant': answerGeneric,
  'single-session-user': answerGeneric,
};

const data = JSON.parse(readFileSync(resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json'), 'utf-8'));
const types: Record<string, any[]> = {};
for (const d of data) { if (!types[d.question_type]) types[d.question_type] = []; types[d.question_type].push(d); }
const sample: any[] = [];
for (const [, items] of Object.entries(types)) sample.push(...items.slice(0, 8));

let correct = 0, total = 0;

for (const item of sample) {
  total++;
  const sessions: string[] = item.haystack_sessions.map((s: any) =>
    typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));

  const handler = ROUTER[item.question_type] || answerGeneric;
  const answer = handler(sessions, item.question);

  const prefExtra = item.question_type === 'single-session-preference' ? '\nFor preferences: same direction = correct.' : '';
  const verdict = llm(`Same core info? Numbers match?${prefExtra} Just "yes" or "no".\nQ: ${item.question}\nGen: ${answer.slice(0, 600)}\nGold: ${item.answer}\nCorrect?`);
  const ok = verdict.toLowerCase().replace(/[*"'\s]/g, '').startsWith('yes');

  if (ok) { correct++; }
  else {
    console.log(`FAIL [${item.question_type}]`);
    console.log(`  Q: ${item.question.slice(0, 70)}`);
    console.log(`  Gold: ${String(item.answer).slice(0, 70)}`);
    console.log(`  Ours: ${answer.slice(0, 70)}`);
    console.log(`  Judge: ${verdict.slice(0, 50)}`);
    console.log();
  }

  if (total % 12 === 0) console.log(`Progress: ${total}/48 — ${(100 * correct / total).toFixed(0)}%\n`);
}

console.log(`\nFINAL: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
