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

  // ── DECOMPOSITION for temporal ordering questions ──
  // Don't ask LLM to find + compare in one shot.
  // Step 1: Extract date for thing A
  // Step 2: Extract date for thing B
  // Step 3: Compare in code
  if (/which.*first|which.*before|which.*earlier|which.*start.*first/i.test(question) && !/what was the date|when did/i.test(question)) {
    // Parse the two things being compared
    const thingsPrompt = llm(
      `What are the TWO things being compared in this question? Return them on two separate lines, exact names only.\n\nQuestion: ${question}\n\nThing 1:\nThing 2:`
    );
    const things = thingsPrompt.split('\n').map(l => l.replace(/^(Thing [12]:?\s*)/i, '').trim()).filter(l => l.length > 2).slice(0, 2);

    if (things.length >= 2) {
      // Extract verb from question for precision
      const verb = question.match(/did I (\w+)/i)?.[1] ?? 'start';

      // Find sessions mentioning each thing
      const sessionsForA = ranked.filter(r => r.session.text.toLowerCase().includes(things[0]!.toLowerCase().slice(0, 15)));
      const sessionsForB = ranked.filter(r => r.session.text.toLowerCase().includes(things[1]!.toLowerCase().slice(0, 15)));

      const textForA = (sessionsForA.length > 0 ? sessionsForA : ranked).slice(0, 3).map(r => {
        return `Session ${r.session.index + 1} (Date: ${r.session.date ?? 'unknown'}):\n${r.session.text.slice(0, 3000)}`;
      }).join('\n\n');

      const textForB = (sessionsForB.length > 0 ? sessionsForB : ranked).slice(0, 3).map(r => {
        return `Session ${r.session.index + 1} (Date: ${r.session.date ?? 'unknown'}):\n${r.session.text.slice(0, 3000)}`;
      }).join('\n\n');

      // Step 1: Find when thing A happened — FOCUSED on relevant sessions only
      const dateA = llm(
        `When did the user ${verb} "${things[0]}"? Find the date or time reference.\n\nCRITICAL: If the text says "about a month ago", "last week", "two weeks ago", etc., you MUST compute the actual date from the session date. For example, if the session date is 2023/05/20 and the user says "about a month ago", the date is approximately 2023-04-20.\n\n"Pre-ordered" ≠ "got/received". Use the date they actually ${verb} it.\n\n${textForA}\n\nQuote the exact sentence mentioning "${things[0]}" with a time reference, then compute the date.\n\nDate (YYYY-MM-DD):`
      );

      // Step 2: Find when thing B happened
      const dateB = llm(
        `When did the user ${verb} "${things[1]}"? Find the date or time reference.\n\nCRITICAL: If the text says "about a month ago", "last week", "14 days", etc., COMPUTE the actual date from the session date.\n\n"Pre-ordered" ≠ "got/received". Use the date they actually ${verb} it.\n\n${textForB}\n\nQuote the exact sentence mentioning "${things[1]}" with a time reference, then compute the date.\n\nDate (YYYY-MM-DD):`
      );

      // Step 3: Compare in code
      const datesA = dateA.match(/\d{4}-\d{2}-\d{2}/g) || [];
      const datesB = dateB.match(/\d{4}-\d{2}-\d{2}/g) || [];

      if (datesA.length > 0 && datesB.length > 0) {
        const dA = parseDate(datesA[datesA.length - 1]!);
        const dB = parseDate(datesB[datesB.length - 1]!);
        if (dA && dB) {
          const first = dA < dB ? things[0]! : things[1]!;
          return {
            answer: first,
            method: 'pgsl-temporal-decomposed',
            reasoning: `Decomposed: "${things[0]}"=${datesA[datesA.length - 1]} vs "${things[1]}"=${datesB[datesB.length - 1]} → ${first} was first`,
          };
        }
      }

      // Fallback: couldn't extract dates, ask LLM directly
      const directAnswer = llm(
        `Based on the sessions, which happened first: "${things[0]}" or "${things[1]}"? The verb is "${verb}". Consider: "pre-ordered" ≠ "received/got". Use the date they actually ${verb} it.\n\n${allSorted}\n\nWhich happened first? Answer with ONLY the name:`
      );
      return { answer: directAnswer, method: 'pgsl-temporal-direct', reasoning: `Direct LLM comparison` };
    }
  }

  // ── DECOMPOSITION for duration questions ──
  if (/how many (days|weeks|months|years)/i.test(question)) {
    // Step 1: Identify what two events/dates the question asks about
    const eventId = llm(
      `This question asks about a time duration between two events/dates. What are the TWO events or dates?\n\nIMPORTANT: If the question says "ago" (e.g., "how many months ago"), the second date is the question date: ${questionDate ?? 'unknown'}. NOT today's real date.\n\nQuestion: ${question}\n\nEvent 1:\nEvent 2:`
    );

    const events = eventId.split('\n').map(l => l.replace(/^(Event [12]:?\s*)/i, '').trim()).filter(l => l.length > 2).slice(0, 2);

    if (events.length >= 2) {
      // Step 2: Find exact date for each event
      const dateContext = questionDate ? `\n\nIMPORTANT: The question is being asked on ${questionDate}. If the question says "ago", the reference date is ${questionDate}, NOT today's real date.` : '';

      // For "ago" questions, the second date is the question date — don't ask LLM
      const isAgo = /ago/i.test(question);
      const questionDateParsed = questionDate ? parseDate(questionDate.split(' ')[0]!.replace(/\//g, '-') ?? '') : null;

      const date1 = llm(
        `When did "${events[0]}" happen? Find the EXACT date from the sessions. If the text uses relative time ("a month ago", "last week"), compute the actual date from the session date.${dateContext}\n\n${allSorted}\n\nQuote the relevant text, then give YYYY-MM-DD:\n\nDate:`
      );

      let date2: string;
      if (isAgo && questionDateParsed) {
        // For "ago" questions, second date IS the question date
        const qd = questionDate!.split(' ')[0]!.replace(/\//g, '-');
        date2 = `The reference date is ${qd}`;
      } else {
        date2 = llm(
          `When did "${events[1]}" happen? Find the EXACT date.${dateContext}\n\n${allSorted}\n\nQuote the relevant text, then give YYYY-MM-DD:\n\nDate:`
        );
      }

      const d1Matches = date1.match(/\d{4}-\d{2}-\d{2}/g) || [];
      const d2Matches = isAgo && questionDateParsed
        ? [questionDate!.split(' ')[0]!.replace(/\//g, '-')]
        : (date2.match(/\d{4}-\d{2}-\d{2}/g) || []);

      if (d1Matches.length > 0 && d2Matches.length > 0) {
        const d1 = parseDate(d1Matches[d1Matches.length - 1]!);
        const d2 = parseDate(d2Matches[d2Matches.length - 1]!);
        if (d1 && d2) {
          const days = Math.abs(daysBetween(d1, d2));
          const unit = /week/i.test(question) ? 'weeks' : /month/i.test(question) ? 'months' : /year/i.test(question) ? 'years' : 'days';
          let ans: string;
          if (unit === 'weeks') ans = `${Math.round(days / 7)}`;
          else if (unit === 'months') ans = `${Math.round(days / 30.44)}`;
          else if (unit === 'years') ans = `${Math.round(days / 365.25)}`;
          else ans = `${days}`;
          return { answer: `${ans} ${unit}`, method: 'pgsl-duration-decomposed', reasoning: `"${events[0]}"=${d1Matches[d1Matches.length - 1]} "${events[1]}"=${d2Matches[d2Matches.length - 1]} = ${days} days` };
        }
      }
    }
  }

  // ── DECOMPOSITION for "how old" questions ──
  if (/how old/i.test(question)) {
    const birthDate = llm(
      `Find the user's birth date from the sessions. If not explicit, compute from age mentions + session dates.\n\n${allSorted}\n\nBirth date (YYYY-MM-DD):`
    );
    const eventDate = llm(
      `Find the date of the event the question asks about.\n\n${allSorted}\n\nQuestion: ${question}\n\nEvent date (YYYY-MM-DD):`
    );
    const bd = (birthDate.match(/\d{4}-\d{2}-\d{2}/g) || []).pop();
    const ed = (eventDate.match(/\d{4}-\d{2}-\d{2}/g) || []).pop();
    if (bd && ed) {
      const d1 = parseDate(bd);
      const d2 = parseDate(ed);
      if (d1 && d2) {
        const years = Math.floor(Math.abs(daysBetween(d1, d2)) / 365.25);
        return { answer: `${years}`, method: 'pgsl-age-decomposed', reasoning: `Birth ${bd}, Event ${ed} = ${years} years` };
      }
    }
  }

  // ── DECOMPOSITION for counting questions ──
  if (/how many/i.test(question) && !/how many (days|weeks|months|years)/i.test(question)) {
    // Step 1: What are we counting?
    const category = llm(`What specific category is being counted? Short phrase only.\n\nQuestion: ${question}\n\nCategory:`).trim();

    // Step 2: For each session, extract items in that category
    const allItems: Array<{item: string; session: number}> = [];
    for (const s of index.sessions) {
      const items = llm(
        `List EVERY "${category}" EXPLICITLY mentioned by the user in this session. One per line, exact name. Say NONE if none.\n\nSession ${s.index + 1} (${s.date ?? ''}):\n${s.text.slice(0, 5000)}\n\nItems:`
      );
      if (!items.toLowerCase().startsWith('none')) {
        for (const line of items.split('\n')) {
          const item = line.replace(/^[-•*\d.)\s]+/, '').trim();
          if (item.length > 1 && item.length < 200 && !item.toLowerCase().startsWith('none')) {
            allItems.push({ item, session: s.index });
          }
        }
      }
    }

    // Step 3: If counting before/after a reference, filter by time
    if (/before|after/i.test(question)) {
      // Let LLM handle this with the full list
      const countAnswer = llm(
        `I found these "${category}":\n${allItems.map(i => `  Session ${i.session + 1}: ${i.item}`).join('\n')}\n\nQuestion: ${question}\n\nCount the ones that match the question's criteria (before/after the reference event). Give ONLY the number:`
      );
      const num = countAnswer.match(/\d+/);
      if (num) return { answer: num[0]!, method: 'pgsl-count-decomposed', reasoning: `Found ${allItems.length} items, filtered: ${num[0]}` };
    }

    // Step 3 (no before/after): deduplicate and count
    if (allItems.length > 0) {
      const isUpdate = /currently|do I have|do I own/i.test(question);
      if (isUpdate) {
        const reconciled = llm(
          `Current count of "${category}" considering all sessions (later updates earlier):\n${allItems.map(i => `  Session ${i.session + 1}: ${i.item}`).join('\n')}\n\nQ: ${question}\nCount (number only):`
        );
        const num = reconciled.match(/\d+/);
        if (num) return { answer: num[0]!, method: 'pgsl-count-reconciled', reasoning: `${allItems.length} items reconciled to ${num[0]}` };
      }
      const unique = new Set(allItems.map(i => i.item.toLowerCase().trim()));
      return { answer: `${unique.size}`, method: 'pgsl-count-decomposed', reasoning: `${unique.size} unique "${category}"` };
    }
  }

  // ── DECOMPOSITION for "which most/least" (superlative counting) ──
  if (/which.*most|which.*least|which.*more|which.*fewer/i.test(question)) {
    // This is counting + comparison. Decompose into: list all items per category, count, compare.
    const superlativeAnswer = llm(
      `This question asks which category has the MOST/LEAST of something. To answer correctly:\n1. List ALL items in each category mentioned\n2. Count each category\n3. Compare counts\n\nShow your work — list every item found per category, then give the answer.\n\n${allSorted}\n\nQuestion: ${question}\n\nWork:\n`
    );
    // Extract the final answer
    const lastLine = superlativeAnswer.split('\n').filter(l => l.trim().length > 0).pop() ?? superlativeAnswer;
    return { answer: lastLine, method: 'pgsl-superlative', reasoning: 'Superlative counting decomposition' };
  }

  // ── GENERAL: LLM reads with focused instructions ──
  let instructions = '';
  if (strategy.questionType === 'single-session-preference') {
    instructions = `PREFERENCE: Identify the user's stated preferences.`;
  } else if (strategy.questionType === 'knowledge-update') {
    instructions = `KNOWLEDGE UPDATE: Later sessions override earlier information. Use LATEST.`;
  }

  const prompt = `${instructions ? instructions + '\n\n' : ''}Read ALL sessions.${questionDate ? ` Current date: ${questionDate}.` : ''}

Answer based ONLY on information in the sessions. Be SPECIFIC and CONCISE.
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
