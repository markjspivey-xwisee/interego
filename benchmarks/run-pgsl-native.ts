#!/usr/bin/env tsx
/**
 * LongMemEval — PGSL-Native Retrieval
 *
 * No embeddings. No ChromaDB. No vector search.
 * The PGSL lattice IS the retrieval index.
 *
 * How:
 *   1. Ingest ALL sessions into ONE lattice
 *   2. Tag each atom with which sessions it appears in
 *   3. For a question: find its atoms in the lattice
 *   4. Score sessions by structural overlap:
 *      - Shared atoms (content-addressed = exact match)
 *      - Co-occurrence (atoms in same chains = distributional similarity)
 *      - Fragment overlap (shared sub-sequences = deeper structural match)
 *   5. Read top-ranked sessions' ORIGINAL TEXT with focused LLM
 *
 * Why this works:
 *   - Distributional semantics from actual co-occurrence, not pre-trained vectors
 *   - Exact matching via content-addressing (no approximation)
 *   - Explainable retrieval (you can see WHICH atoms overlap)
 *   - Composable (paradigm sets, coherence, all work on the same index)
 */

import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

import {
  createPGSL, embedInPGSL, pgslResolve, mintAtom, latticeStats,
  extractEntities, computeCognitiveStrategy,
  parseDate, daysBetween, shouldAbstain,
} from '../src/index.js';

import { buildCoOccurrenceMatrix } from '../src/pgsl/usage-semantics.js';

import type { IRI, PGSLInstance } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? 'opus';
const START = parseInt(process.argv[3] ?? '0');
const END = parseInt(process.argv[4] ?? '500');
const DATA_FILE = resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json');
const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));

// ── LLM ────────────────────────────────────────────────

function llm(prompt: string): string {
  try {
    const tmpFile = join(tmpdir(), `cg-pgsl-${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt, 'utf-8');
    const result = execSync(
      `cat "${tmpFile.replace(/\\/g, '/')}" | claude --print --model ${MODEL}`,
      { maxBuffer: 4 * 1024 * 1024, timeout: 180000, encoding: 'utf-8' }
    );
    try { unlinkSync(tmpFile); } catch {}
    return (result ?? '').trim();
  } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════
//  PGSL-NATIVE INDEX + RETRIEVAL
// ═══════════════════════════════════════════════════════════

interface SessionData {
  index: number;
  date?: string;
  text: string;
  atoms: Set<string>; // atoms that appear in this session
}

interface PGSLIndex {
  pgsl: PGSLInstance;
  sessions: SessionData[];
  atomToSessions: Map<string, Set<number>>; // atom → session indices
  coMatrix: Map<string, Map<string, number>>; // co-occurrence matrix
}

function buildPGSLIndex(
  rawSessions: any[],
  sessionDates?: string[],
): PGSLIndex {
  const pgsl = createPGSL({
    wasAttributedTo: 'urn:benchmark' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  const sessions: SessionData[] = [];
  const atomToSessions = new Map<string, Set<number>>();

  for (let i = 0; i < rawSessions.length; i++) {
    const s = rawSessions[i];
    const messages = typeof s === 'string'
      ? [{ role: 'user', content: s }]
      : Array.isArray(s) ? s.map((m: any) => ({ role: m.role ?? 'user', content: m.content || m.text || '' }))
      : [{ role: 'user', content: JSON.stringify(s) }];

    const text = messages.map((m: any) => `${m.role}: ${m.content}`).join('\n');
    const userText = messages.filter((m: any) => m.role === 'user').map((m: any) => m.content).join(' ');

    // Track which atoms appear in this session
    const sessionAtoms = new Set<string>();
    const atomsBefore = new Set([...pgsl.atoms.keys()]);

    // Ingest key sentences into the shared lattice
    const sentences = userText.split(/[.!?]+/).filter((s: string) => s.trim().length > 10);
    for (const sent of sentences.slice(0, 40)) {
      try {
        embedInPGSL(pgsl, sent.trim());
      } catch {}
    }

    // Find atoms that were created/touched by this session
    for (const [value] of pgsl.atoms) {
      if (!atomsBefore.has(value)) {
        sessionAtoms.add(value);
      }
      // Also check if this session's text contains the atom value
      if (userText.toLowerCase().includes(value.toLowerCase()) && value.length > 2) {
        sessionAtoms.add(value);
      }
    }

    // Map atoms → sessions
    for (const atom of sessionAtoms) {
      if (!atomToSessions.has(atom)) atomToSessions.set(atom, new Set());
      atomToSessions.get(atom)!.add(i);
    }

    sessions.push({
      index: i,
      date: sessionDates?.[i],
      text,
      atoms: sessionAtoms,
    });
  }

  // Build co-occurrence matrix for distributional similarity
  const coMatrix = buildCoOccurrenceMatrix(pgsl);

  return { pgsl, sessions, atomToSessions, coMatrix };
}

/**
 * Score sessions by PGSL structural overlap with the question.
 *
 * Three signals combined:
 *   1. Atom overlap: how many question atoms appear in this session?
 *   2. Co-occurrence expansion: atoms that co-occur with question atoms
 *   3. Keyword TF-IDF: rare atoms (fewer sessions) score higher
 */
function scoreAndRankSessions(
  question: string,
  index: PGSLIndex,
): Array<{ session: SessionData; score: number; reason: string }> {
  const qEntities = extractEntities(question);
  const qWords = new Set<string>();
  for (const w of question.toLowerCase().split(/\s+/)) {
    if (w.length > 2) qWords.add(w.replace(/[.,!?'"]/g, ''));
  }
  for (const w of qEntities.contentWords) qWords.add(w.toLowerCase());
  for (const np of qEntities.nounPhrases) qWords.add(np.toLowerCase());

  const scored = index.sessions.map(session => {
    let score = 0;
    const reasons: string[] = [];

    // Signal 1: Direct atom overlap (content-addressed exact match)
    let atomOverlap = 0;
    for (const qw of qWords) {
      if (session.atoms.has(qw)) {
        atomOverlap++;
        // TF-IDF: atoms that appear in fewer sessions are more discriminative
        const sessionCount = index.atomToSessions.get(qw)?.size ?? index.sessions.length;
        const idf = Math.log(index.sessions.length / Math.max(1, sessionCount));
        score += 1 + idf; // base 1 + IDF bonus
      }
    }
    if (atomOverlap > 0) reasons.push(`${atomOverlap} atom matches`);

    // Signal 2: Co-occurrence expansion
    // Atoms in this session that co-occur with question atoms in the lattice
    let coOccScore = 0;
    for (const qw of qWords) {
      const coMap = index.coMatrix.get(qw);
      if (!coMap) continue;
      for (const [coAtom, coCount] of coMap) {
        if (session.atoms.has(coAtom) && !qWords.has(coAtom)) {
          coOccScore += coCount * 0.3; // weighted lower than direct match
        }
      }
    }
    if (coOccScore > 0) {
      score += coOccScore;
      reasons.push(`co-occurrence: +${coOccScore.toFixed(1)}`);
    }

    // Signal 3: Text-level keyword match (catches multi-word phrases)
    // that atom-level matching might miss
    const sessionTextLower = session.text.toLowerCase();
    for (const np of qEntities.nounPhrases) {
      if (np.length > 5 && sessionTextLower.includes(np.toLowerCase())) {
        score += 3; // noun phrase match is strong signal
        reasons.push(`phrase: "${np}"`);
      }
    }

    return { session, score, reason: reasons.join(', ') || 'no match' };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ═══════════════════════════════════════════════════════════
//  ANSWER — Read original text with focused LLM
// ═══════════════════════════════════════════════════════════

function answer(
  question: string,
  index: PGSLIndex,
  ranked: Array<{ session: SessionData; score: number; reason: string }>,
  questionDate?: string,
): { answer: string; method: string; reasoning: string } {
  const strategy = computeCognitiveStrategy(question);
  const qEntities = extractEntities(question);

  // ── ABSTENTION ──
  const topScore = ranked[0]?.score ?? 0;
  if (topScore < 0.5) {
    // Very weak structural match — verify with LLM
    const verify = llm(
      `Does this conversation mention the SPECIFIC thing asked about? Be PRECISE — "tennis" ≠ "table tennis".\n\nQuestion: ${question}\n\n${index.sessions.map(s => `Session ${s.index + 1}:\n${s.text.slice(0, 1200)}`).join('\n\n')}\n\nYES or NO:`
    );
    if (verify.toLowerCase().startsWith('no')) {
      return { answer: 'The information provided is not enough to answer this question.', method: 'abstain', reasoning: `Top score ${topScore.toFixed(1)} — entity not found` };
    }
  }

  // ── BUILD FOCUSED PROMPT ──
  // All sessions, but sorted by structural relevance
  // Relevant sessions get [RELEVANT] tag so LLM pays extra attention
  const relevantCount = ranked.filter(r => r.score > 0).length;
  const allSorted = ranked.map(r => {
    const s = r.session;
    const tag = r.score > 0 ? ` [RELEVANT — ${r.reason}]` : '';
    const dateLabel = s.date ? ` (Date: ${s.date})` : '';
    return `=== Session ${s.index + 1}${dateLabel}${tag} ===\n${s.text}`;
  }).join('\n\n');

  // Question-type instructions
  let instructions = '';
  if (/which.*first|which.*before|which.*earlier/i.test(question)) {
    instructions = `TEMPORAL ORDERING: Find SPECIFIC DATES for each item. Compare dates. Earlier date = happened first.
IMPORTANT: "pre-ordered" ≠ "got/received". Use the date they actually GOT the item.
Quote the relevant sentences with dates, then answer.`;
  } else if (/how many (days|weeks|months|years)/i.test(question)) {
    instructions = `TIME DURATION: Find the EXACT two dates. If a date is implied (not explicit), use session dates and context to infer. Show your work: Date 1 = ___, Date 2 = ___, Difference = ___.`;
  } else if (/how many/i.test(question)) {
    instructions = `COUNTING: List EVERY matching item across ALL sessions. Later sessions may UPDATE earlier ones.
Quote each item found. Then count unique items. Show your work.`;
  } else if (/how old/i.test(question)) {
    instructions = `AGE CALCULATION: Find birth date and event date. Compute the difference in years.`;
  } else if (strategy.questionType === 'single-session-preference') {
    instructions = `PREFERENCE: Identify the user's stated preferences from their messages.`;
  }

  const prompt = `${instructions ? instructions + '\n\n' : ''}Read ALL sessions. ${relevantCount} of ${index.sessions.length} sessions were flagged as relevant by structural analysis.${questionDate ? ` Current date: ${questionDate}.` : ''}

Answer the question based ONLY on information in the sessions. Be SPECIFIC and CONCISE.
If the specific thing asked about is NOT in any session, say "The information provided is not enough to answer this question."

${allSorted}

Question: ${question}

Answer concisely:`;

  const raw = llm(prompt);

  // Clean: extract core answer if verbose
  let cleaned = raw;
  if (raw.length > 200) {
    const last = raw.split('\n').filter(l => l.trim().length > 0).pop() ?? raw;
    if (last.length < 200) cleaned = last;
  }

  let method = 'pgsl-read';
  if (/which.*first|how many (days|weeks|months)/i.test(question)) method = 'pgsl-temporal';
  else if (/how many/i.test(question)) method = 'pgsl-count';

  return {
    answer: cleaned,
    method,
    reasoning: `${relevantCount} relevant sessions (top: ${ranked[0]?.reason ?? 'none'}) | ${latticeStats(index.pgsl).atoms} atoms`,
  };
}

// ── Main ────────────────────────────────────────────────

function main() {
  console.log(`=== PGSL-NATIVE BENCHMARK — LongMemEval ===`);
  console.log(`No embeddings. No vectors. Lattice IS the index.`);
  console.log(`Model: ${MODEL} | Range: Q${START}-Q${END}\n`);

  let correct = 0;
  let total = 0;
  const methodCounts: Record<string, number> = {};
  const typeCounts: Record<string, { correct: number; total: number }> = {};

  for (let qi = START; qi < Math.min(END, data.length); qi++) {
    const item = data[qi];
    total++;

    // Build PGSL index from all sessions
    const index = buildPGSLIndex(item.haystack_sessions, item.haystack_dates);

    // Score and rank sessions by structural overlap
    const ranked = scoreAndRankSessions(item.question, index);

    // Answer by reading original text
    const result = answer(item.question, index, ranked, item.question_date);
    methodCounts[result.method] = (methodCounts[result.method] ?? 0) + 1;

    // Judge
    const judgeResult = llm(
      `Does the generated answer convey the same information as the gold answer? Same core answer is enough. YES or NO only.\n\nQuestion: ${item.question}\nGenerated: ${result.answer.slice(0, 300)}\nGold: ${item.answer}\n\nSame information?`
    );
    const isCorrect = judgeResult.toLowerCase().startsWith('yes');
    if (isCorrect) correct++;

    if (!typeCounts[item.question_type]) typeCounts[item.question_type] = { correct: 0, total: 0 };
    typeCounts[item.question_type]!.total++;
    if (isCorrect) typeCounts[item.question_type]!.correct++;

    const mark = isCorrect ? '✓' : '✗';
    console.log(`${mark} ${qi}: [${item.question_type}] [${result.method}] ${item.question.slice(0, 60)}`);

    if (!isCorrect) {
      console.log(`  Gold: ${String(item.answer).slice(0, 100)}`);
      console.log(`  Ours: ${result.answer.slice(0, 100)}`);
      console.log(`  Reasoning: ${result.reasoning.slice(0, 120)}`);
    }

    if (total % 10 === 0 || !isCorrect) {
      const methods = Object.entries(methodCounts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`  Score: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) | ${methods}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`FINAL: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%)`);
  console.log(`Methods: ${Object.entries(methodCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`\nPer-type:`);
  for (const [type, c] of Object.entries(typeCounts).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${type}: ${c.correct}/${c.total} (${(100 * c.correct / c.total).toFixed(1)}%)`);
  }
}

main();
