#!/usr/bin/env tsx
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY']! });
const data = JSON.parse(readFileSync(resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json'), 'utf-8'));

const hardQs = [
  'How many projects have I led or am currently leading?',
  'How many plants did I acquire in the last month?',
  'What was the amount I was pre-approved for when I got my mortgage from Wells Fargo?',
  'Where did I redeem a $5 coupon on coffee creamer?',
];

async function llm(model: string, prompt: string) {
  const r = await anthropic.messages.create({ model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] });
  return r.content[0].type === 'text' ? r.content[0].text : '';
}

async function main() {
  for (const hq of hardQs) {
    const item = data.find((d: any) => d.question.startsWith(hq.slice(0, 30)));
    if (!item) { console.log('NOT FOUND: ' + hq); continue; }

    const sessions: string[] = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));
    const ft = sessions.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n');

    console.log(`Q: ${hq.slice(0, 60)}`);
    console.log(`Gold: ${String(item.answer).slice(0, 60)}`);

    const opus = await llm('claude-opus-4-20250514', `Read ALL sessions word by word. Answer with JUST the specific answer — a number, name, or place. Nothing else.\n\n${ft}\n\nQ: ${item.question}\nA:`);
    console.log(`Opus: ${opus.slice(0, 100)}`);

    const sonnet = await llm('claude-sonnet-4-20250514', `Read ALL sessions word by word. Answer with JUST the specific answer — a number, name, or place. Nothing else.\n\n${ft}\n\nQ: ${item.question}\nA:`);
    console.log(`Sonnet: ${sonnet.slice(0, 100)}`);
    console.log('---');
  }
}
main();
