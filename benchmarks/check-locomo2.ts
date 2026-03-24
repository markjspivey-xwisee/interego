import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

const d = JSON.parse(readFileSync(resolve(__dirname, 'locomo/data/locomo10.json'), 'utf-8'));
const first = d[0];
const qaKeys = Object.keys(first.qa);
console.log('QA entries:', qaKeys.length);
for (const k of qaKeys.slice(0, 5)) {
  const q = first.qa[k];
  console.log(`\n${k}:`);
  console.log(`  Q: ${q.question?.slice(0, 100)}`);
  console.log(`  A: ${q.answer?.slice(0, 100)}`);
  console.log(`  Type: ${q.question_type || q.type || q.category || 'unknown'}`);
}

// Sessions
const conv = first.conversation;
const sessionKeys = Object.keys(conv).filter((k: string) => k.startsWith('session_') && !k.includes('date'));
console.log(`\nSessions: ${sessionKeys.length}`);
for (const sk of sessionKeys.slice(0, 2)) {
  const session = conv[sk];
  console.log(`  ${sk}: ${Array.isArray(session) ? session.length + ' turns' : typeof session}`);
  if (Array.isArray(session) && session.length > 0) {
    console.log(`    First: ${JSON.stringify(session[0]).slice(0, 100)}`);
  }
}
