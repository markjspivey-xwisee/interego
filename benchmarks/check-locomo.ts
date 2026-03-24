import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const d = JSON.parse(readFileSync(resolve(__dirname, 'locomo/data/locomo10.json'), 'utf-8'));
console.log('Type:', typeof d, Array.isArray(d) ? 'array' : 'not array');
if (Array.isArray(d)) {
  console.log('Length:', d.length);
  const first = d[0];
  console.log('Keys:', Object.keys(first));
  if (first.conversation) console.log('conversation sample:', JSON.stringify(first.conversation).slice(0, 200));
  if (first.questions) console.log('questions:', first.questions.length, JSON.stringify(first.questions[0]).slice(0, 200));
  if (first.qa_pairs) console.log('qa_pairs:', first.qa_pairs.length);
} else {
  const keys = Object.keys(d);
  console.log('Keys:', keys.length, 'first:', keys[0]);
  const first = d[keys[0]!];
  console.log('Entry keys:', Object.keys(first));
}
