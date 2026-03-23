#!/usr/bin/env tsx
/**
 * Fact-based benchmark pipeline.
 *
 * Architecture (maps to our primitives):
 *   Stage 1: LLM extracts typed facts from sessions (like PGSL ingestion)
 *   Stage 2: Facet-routed retrieval finds matching facts (like facet filtering)
 *   Stage 3: Structural answer derivation from fact values (like composition)
 *   Stage 4: LLM fallback only when structural derivation fails
 *
 * The LLM is used for EXTRACTION (once per session) and FALLBACK.
 * Retrieval and derivation are purely structural.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env['ANTHROPIC_API_KEY'];
if (!API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: API_KEY });
const MODEL_EXTRACT = 'claude-sonnet-4-20250514';
const MODEL_ANSWER = 'claude-sonnet-4-20250514';
const MODEL_JUDGE = 'claude-sonnet-4-20250514';

// ── Types ────────────────────────────────────────────────────

interface Fact {
  type: 'personal' | 'preference' | 'event' | 'temporal' | 'update' | 'numeric' | 'relationship' | 'assistant';
  entity: string;
  attribute: string;
  value: string;
  timestamp?: string;
  modality: 'asserted' | 'negated' | 'hypothetical' | 'updated';
  supersedes?: string;  // what previous fact this updates
  source_session: number;
}

interface QuestionAnalysis {
  type: 'factual' | 'temporal' | 'counting' | 'comparison' | 'preference' | 'yes_no' | 'update' | 'abstention';
  key_entities: string[];
  temporal_hint?: string;
  requires_computation?: 'count' | 'sum' | 'difference' | 'average' | 'percentage' | 'comparison';
}

// ── Stage 1: Typed Fact Extraction ───────────────────────────

async function extractFacts(sessionText: string, sessionIndex: number): Promise<Fact[]> {
  const resp = await anthropic.messages.create({
    model: MODEL_EXTRACT,
    max_tokens: 4000,
    messages: [{ role: 'user', content: `Extract ALL facts from this conversation session. Output ONLY a JSON array.

Each fact must have:
- type: "personal"|"preference"|"event"|"temporal"|"update"|"numeric"|"relationship"|"assistant"
- entity: the main subject (e.g. "car", "hobby", "GPA")
- attribute: what about it (e.g. "model", "type", "score")
- value: the specific value (e.g. "Toyota Camry", "pottery", "3.85")
- timestamp: ISO date if mentioned, null otherwise
- modality: "asserted" (stated as true), "negated" (stated as false), "updated" (changed from previous)
- supersedes: if this is an update, what it replaces (e.g. "old GPA was 3.5")

Be EXHAUSTIVE. Extract every preference, every number, every date, every event, every relationship, every update. Include implicit facts (e.g. if someone says "my new car" that implies they got a new car).

For numeric values: extract the EXACT number. "$3,750" → value: "3750". "17 fish" → value: "17".
For temporal ordering: extract relative order ("first", "before", "after") as attributes.
For updates/corrections: mark as modality "updated" and note what was superseded.

Session:
${sessionText}

JSON array of facts:` }],
  });

  try {
    const text = resp.content[0].type === 'text' ? resp.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const facts = JSON.parse(jsonMatch[0]) as any[];
    return facts.map(f => ({
      ...f,
      source_session: sessionIndex,
      modality: f.modality || 'asserted',
    }));
  } catch {
    return [];
  }
}

// ── Stage 2: Question Analysis ───────────────────────────────

function analyzeQuestion(question: string): QuestionAnalysis {
  const q = question.toLowerCase();

  // Detect question type
  let type: QuestionAnalysis['type'] = 'factual';
  let requires_computation: QuestionAnalysis['requires_computation'];

  if (/how many|total number|in total|combined/.test(q)) {
    type = 'counting';
    requires_computation = q.includes('total') || q.includes('combined') ? 'sum' : 'count';
  } else if (/how much.*spend|how much.*cost|how much.*earn|how much.*raise/.test(q)) {
    type = 'counting';
    requires_computation = 'sum';
  } else if (/average|mean/.test(q)) {
    type = 'counting';
    requires_computation = 'average';
  } else if (/percentage|percent|%/.test(q)) {
    type = 'counting';
    requires_computation = 'percentage';
  } else if (/how many days|how long.*between|how many years|how old.*when/.test(q)) {
    type = 'temporal';
    requires_computation = 'difference';
  } else if (/which.*first|what.*first|when did|what time|which.*before|which.*earlier/.test(q)) {
    type = 'temporal';
    requires_computation = 'comparison';
  } else if (/do i|is my|am i|have i|did i.*more|higher.*than/.test(q)) {
    type = 'yes_no';
  } else if (/still|anymore|now|currently|changed/.test(q)) {
    type = 'update';
  } else if (/favorite|prefer|like|enjoy|love/.test(q)) {
    type = 'preference';
  } else if (/not mention|didn't|never/.test(q)) {
    type = 'abstention';
  }

  // Extract key entities
  const stopwords = new Set('i me my the a an is was were are do did does have has had what which how when where who whom why their them they this that these those to of in for on with at by from it its'.split(' '));
  const words = question.replace(/[?!.,'"]/g, '').toLowerCase().split(/\s+/);
  const key_entities = words.filter(w => !stopwords.has(w) && w.length > 2);

  return { type, key_entities, requires_computation };
}

// ── Stage 3: Facet-Routed Retrieval ──────────────────────────

function retrieveFacts(facts: Fact[], analysis: QuestionAnalysis): Fact[] {
  // Strategy 1: Entity match (find facts containing question entities)
  const entityMatched = facts.filter(f => {
    const factText = `${f.entity} ${f.attribute} ${f.value} ${f.supersedes || ''}`.toLowerCase();
    return analysis.key_entities.some(e => factText.includes(e));
  });

  // Strategy 2: Type match (route by question type → fact type)
  const typeMap: Record<string, string[]> = {
    temporal: ['temporal', 'event'],
    preference: ['preference'],
    update: ['update'],
    counting: ['numeric', 'event', 'personal'],
    yes_no: ['personal', 'preference', 'update', 'event'],
    factual: ['personal', 'event', 'preference', 'relationship'],
    abstention: [],
    comparison: ['temporal', 'event', 'numeric'],
  };
  const targetTypes = typeMap[analysis.type] || [];
  const typeMatched = facts.filter(f => targetTypes.includes(f.type));

  // Strategy 3: For updates, find latest version of each entity
  const updateMatched: Fact[] = [];
  if (analysis.type === 'update' || analysis.type === 'yes_no') {
    const entityFacts = new Map<string, Fact>();
    for (const f of facts) {
      const key = `${f.entity}:${f.attribute}`;
      const existing = entityFacts.get(key);
      if (!existing || f.modality === 'updated' || (f.timestamp && existing.timestamp && f.timestamp > existing.timestamp)) {
        entityFacts.set(key, f);
      }
    }
    updateMatched.push(...entityFacts.values());
  }

  // Union all strategies (our composition operator)
  const seen = new Set<string>();
  const combined: Fact[] = [];
  for (const f of [...entityMatched, ...typeMatched, ...updateMatched]) {
    const key = `${f.entity}:${f.attribute}:${f.value}:${f.source_session}`;
    if (!seen.has(key)) {
      seen.add(key);
      combined.push(f);
    }
  }

  return combined;
}

// ── Stage 4: Structural Answer Derivation ────────────────────

function deriveAnswer(matched: Fact[], analysis: QuestionAnalysis): string | null {
  if (matched.length === 0) return null;

  switch (analysis.type) {
    case 'preference': {
      const pref = matched.find(f => f.type === 'preference');
      return pref ? pref.value : null;
    }

    case 'counting': {
      if (analysis.requires_computation === 'sum') {
        const nums = matched
          .filter(f => f.type === 'numeric' || /\d/.test(f.value))
          .map(f => {
            const n = parseFloat(f.value.replace(/[$,]/g, ''));
            return isNaN(n) ? 0 : n;
          })
          .filter(n => n > 0);
        if (nums.length >= 2) return String(nums.reduce((a, b) => a + b, 0));
      }
      if (analysis.requires_computation === 'count') {
        const relevant = matched.filter(f =>
          analysis.key_entities.some(e => `${f.entity} ${f.attribute}`.toLowerCase().includes(e))
        );
        if (relevant.length > 0) return String(relevant.length);
      }
      if (analysis.requires_computation === 'average') {
        const nums = matched
          .filter(f => /\d/.test(f.value))
          .map(f => parseFloat(f.value.replace(/[$,]/g, '')))
          .filter(n => !isNaN(n));
        if (nums.length >= 2) return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
      }
      return null;
    }

    case 'temporal': {
      if (analysis.requires_computation === 'comparison') {
        // "Which came first?" — find entities with timestamps, compare
        const withDates = matched.filter(f => f.timestamp);
        if (withDates.length >= 2) {
          withDates.sort((a, b) => (a.timestamp! < b.timestamp! ? -1 : 1));
          return withDates[0]!.entity + ': ' + withDates[0]!.value;
        }
        // Look for ordinal markers
        const first = matched.find(f =>
          f.attribute.includes('first') || f.attribute.includes('order') || f.value.includes('first')
        );
        if (first) return first.value;
      }
      return null;
    }

    case 'yes_no': {
      // Check if the entity/attribute exists as asserted
      const relevant = matched.filter(f =>
        analysis.key_entities.some(e => `${f.entity} ${f.value}`.toLowerCase().includes(e))
      );
      if (relevant.length > 0) {
        const latest = relevant[relevant.length - 1]!;
        if (latest.modality === 'negated') return 'No';
        if (latest.modality === 'asserted' || latest.modality === 'updated') return 'Yes';
      }
      return null;
    }

    case 'update': {
      const updated = matched.filter(f => f.modality === 'updated');
      if (updated.length > 0) return updated[updated.length - 1]!.value;
      return matched.length > 0 ? matched[matched.length - 1]!.value : null;
    }

    default:
      return matched.length > 0 ? matched[0]!.value : null;
  }
}

// ── Stage 5: LLM Fallback (with matched facts as context) ────

async function llmFallback(question: string, matchedFacts: Fact[], allFacts: Fact[]): Promise<string> {
  // Give the LLM the matched facts first, then all facts as backup
  const factsContext = matchedFacts.length > 0
    ? matchedFacts.map(f => `[${f.type}] ${f.entity}: ${f.attribute} = ${f.value}${f.timestamp ? ' ('+f.timestamp+')' : ''}${f.modality !== 'asserted' ? ' ['+f.modality+']' : ''}${f.supersedes ? ' (was: '+f.supersedes+')' : ''}`).join('\n')
    : 'No matched facts';

  const allContext = allFacts
    .map(f => `[S${f.source_session}][${f.type}] ${f.entity}: ${f.attribute} = ${f.value}${f.timestamp ? ' ('+f.timestamp+')' : ''}${f.modality !== 'asserted' ? ' ['+f.modality+']' : ''}${f.supersedes ? ' (was: '+f.supersedes+')' : ''}`)
    .join('\n');

  const resp = await anthropic.messages.create({
    model: MODEL_ANSWER,
    max_tokens: 300,
    messages: [{ role: 'user', content: `Answer this question using ONLY the extracted facts below. Give a SPECIFIC, CONCISE answer.

Most relevant facts:
${factsContext}

All extracted facts:
${allContext.slice(0, 5000)}

Question: ${question}

Rules:
- If the answer is a number, give JUST the number
- If the answer is a name/item, give JUST the name/item
- If computing (sum, difference, count), show the computation briefly then the answer
- For temporal questions, use dates to determine ordering
- For yes/no, answer Yes or No then brief reason
- Never say "I don't know" — always give your best answer from the facts

Answer:` }],
  });

  return resp.content[0].type === 'text' ? resp.content[0].text : '';
}

// ── Judge ────────────────────────────────────────────────────

async function judge(question: string, generated: string, gold: string): Promise<boolean> {
  const resp = await anthropic.messages.create({
    model: MODEL_JUDGE,
    max_tokens: 5,
    messages: [{ role: 'user', content: `Is this answer semantically equivalent to the gold answer? Answer ONLY "yes" or "no".

Question: ${question}
Generated answer: ${generated}
Gold answer: ${gold}

Consider: numbers must match exactly. Names/items must match. Yes/No must match. Approximate phrasings are OK if the core fact is the same.

Correct:` }],
  });
  return (resp.content[0].type === 'text' ? resp.content[0].text : '').toLowerCase().trim().startsWith('yes');
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const dataPath = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf-8')) as any[];

  const LIMIT = parseInt(process.argv[2] || '100');

  // Stratified sample
  const types: Record<string, any[]> = {};
  for (const d of data) { if (!types[d.question_type]) types[d.question_type] = []; types[d.question_type].push(d); }
  const sample: any[] = [];
  const perType = Math.ceil(LIMIT / Object.keys(types).length);
  for (const [, items] of Object.entries(types)) { sample.push(...items.slice(0, perType)); }

  console.log(`\n=== Fact-Based Pipeline (${sample.length}q) ===`);
  console.log(`Extract: ${MODEL_EXTRACT}`);
  console.log(`Answer: ${MODEL_ANSWER}`);
  console.log(`Judge: ${MODEL_JUDGE}`);

  let correct = 0;
  let structural = 0;
  let fallback = 0;
  let total = 0;
  let totalFacts = 0;
  let extractCalls = 0;
  let fallbackCalls = 0;
  const typeResults: Record<string, { total: number; correct: number; structural: number }> = {};

  for (const item of sample) {
    total++;
    if (!typeResults[item.question_type]) typeResults[item.question_type] = { total: 0, correct: 0, structural: 0 };
    typeResults[item.question_type].total++;

    const sessions = item.haystack_sessions.map((s: any) =>
      typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s)
    ) as string[];

    // Stage 1: Extract facts from all sessions
    const allFacts: Fact[] = [];
    for (let i = 0; i < sessions.length; i++) {
      extractCalls++;
      const facts = await extractFacts(sessions[i]!, i);
      allFacts.push(...facts);
    }
    totalFacts += allFacts.length;

    // Stage 2: Analyze question
    const analysis = analyzeQuestion(item.question);

    // Stage 3: Facet-routed retrieval
    const matched = retrieveFacts(allFacts, analysis);

    // Stage 4: Structural derivation
    let answer = deriveAnswer(matched, analysis);
    let usedStructural = false;

    if (answer) {
      usedStructural = true;
    } else {
      // Stage 5: LLM fallback with facts as context
      fallbackCalls++;
      answer = await llmFallback(item.question, matched, allFacts);
    }

    // Judge
    const isCorrect = await judge(item.question, answer, item.answer);
    if (isCorrect) {
      correct++;
      typeResults[item.question_type].correct++;
      if (usedStructural) {
        structural++;
        typeResults[item.question_type].structural++;
      } else {
        fallback++;
      }
    }

    if (total % 10 === 0) {
      console.log(`  ${total}/${sample.length}: ${(100 * correct / total).toFixed(0)}% (structural: ${structural}, fallback: ${fallback})`);
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
  console.log(`  Structural: ${structural} (${(100 * structural / total).toFixed(1)}%)`);
  console.log(`  LLM fallback: ${fallback} (${(100 * fallback / total).toFixed(1)}%)`);
  console.log(`\nFacts extracted: ${totalFacts} (avg ${(totalFacts / total).toFixed(0)}/question)`);
  console.log(`LLM calls: ${extractCalls} extraction + ${fallbackCalls} fallback + ${total} judge = ${extractCalls + fallbackCalls + total} total`);
  console.log(`  vs Supermemory ASMR: ~${total * 19} calls for same questions\n`);

  console.log(`By type:`);
  for (const [type, res] of Object.entries(typeResults)) {
    console.log(`  ${type}: ${res.correct}/${res.total} (${(100 * res.correct / res.total).toFixed(0)}%) [structural: ${res.structural}]`);
  }
}

main().catch(console.error);
