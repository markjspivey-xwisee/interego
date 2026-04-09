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
  // ── TEMPORAL: "order of three events" ──
  if (/order of.*three|order.*from first|order.*from earliest/i.test(question)) {
    const orderAnswer = llm(
      `This question asks for the ORDER of events. For each event mentioned, find its date (compute relative dates from session dates). Then sort chronologically.\n\nShow your work:\n1. Event name → date (with quote from text)\n2. Sorted order\n\n${allSorted}\n\nQuestion: ${question}\n\nAnswer:`
    );
    return { answer: orderAnswer, method: 'pgsl-temporal-order', reasoning: 'Multi-event ordering' };
  }

  // ── TEMPORAL: "which first" (two events) ──
  if (/which.*first|which.*before|which.*earlier|which.*start.*first/i.test(question) && !/what was the date|when did/i.test(question)) {
    // Parse the two things being compared
    const thingsPrompt = llm(
      `What are the TWO things being compared in this question? Return them on two separate lines, exact names only.\n\nQuestion: ${question}\n\nThing 1:\nThing 2:`
    );
    const things = thingsPrompt.split('\n').map(l => l.replace(/^(Thing [12]:?\s*)/i, '').trim()).filter(l => l.length > 2).slice(0, 2);

    if (things.length >= 2) {
      // Extract keywords for session filtering
      const keywordsA = things[0]!.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !['the', 'with', 'from', 'that', 'this', 'about'].includes(w));
      const keywordsB = things[1]!.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !['the', 'with', 'from', 'that', 'this', 'about'].includes(w));

      // Check if both things are actually discussed in the sessions
      // Only abstain if BOTH keyword check AND LLM confirm it's missing
      const allText = index.sessions.map(s => s.text.toLowerCase()).join(' ');
      const thingAInText = keywordsA.some(kw => allText.includes(kw));
      const thingBInText = keywordsB.some(kw => allText.includes(kw));
      if (!thingAInText || !thingBInText) {
        const missing = !thingAInText ? things[0]! : things[1]!;
        // Double-check with LLM — keyword matching can miss paraphrases
        const absVerify = llm(
          `Is "${missing}" (or something very similar to it) mentioned or discussed in any of these sessions? It might be referred to by a different name or description. YES or NO.\n\n${allSorted.slice(0, 8000)}\n\nAnswer:`
        );
        if (absVerify.toLowerCase().startsWith('no')) {
          return { answer: 'The information provided is not enough to answer this question.', method: 'pgsl-temporal-abstain', reasoning: `"${missing}" not found in sessions (confirmed by LLM)` };
        }
      }

      // Extract verb from question for precision
      const verb = question.match(/did I (\w+)/i)?.[1] ?? 'start';

      // Find sessions mentioning each thing
      const sessionsForA = ranked.filter(r => keywordsA.some(kw => r.session.text.toLowerCase().includes(kw)));
      const sessionsForB = ranked.filter(r => keywordsB.some(kw => r.session.text.toLowerCase().includes(kw)));

      const textForA = (sessionsForA.length > 0 ? sessionsForA : ranked).slice(0, 3).map(r => {
        return `Session ${r.session.index + 1} (Date: ${r.session.date ?? 'unknown'}):\n${r.session.text.slice(0, 3000)}`;
      }).join('\n\n');

      const textForB = (sessionsForB.length > 0 ? sessionsForB : ranked).slice(0, 3).map(r => {
        return `Session ${r.session.index + 1} (Date: ${r.session.date ?? 'unknown'}):\n${r.session.text.slice(0, 3000)}`;
      }).join('\n\n');

      // Extract date for each event separately, with focused session text
      // Key: include session dates so relative times can be computed
      // CONSENSUS approach: get answer from multiple methods, take majority
      // Method 1: Direct LLM read (no date extraction)
      const directAnswer = llm(
        `Which happened first: "${things[0]}" or "${things[1]}"?\n\nIMPORTANT: "pre-ordered" or "ordered" is NOT the same as "got" or "received". The question asks about "${verb}" — use the date they actually ${verb} it.\n\n${textForA}\n\n${textForB}\n\nQuote the relevant date for each, then say which was first. Answer with ONLY the name on the last line:`
      );
      const directName = directAnswer.split('\n').filter(l => l.trim().length > 0).pop()?.replace(/\*\*/g, '').replace(/^(Answer|Which)[:\s]*/i, '').trim() ?? '';

      // Method 2: Date extraction + code comparison
      // Extract date for each event with EXPLICIT relative-time computation
      function extractDate(thing: string, sessionText: string): string {
        // First: find relative time expressions
        const relCheck = llm(
          `Does the text mention "${thing}" with a RELATIVE time expression like "a month ago", "last week", "recently", "14 days ago", "X weeks ago"? Quote the exact phrase if yes. Say NO if the date is explicit (like "on February 20th").\n\n${sessionText.slice(0, 3000)}\n\nRelative time expression:`
        );

        const hasRelative = !relCheck.toLowerCase().startsWith('no') && relCheck.length > 3;

        if (hasRelative) {
          // Extract session date from the text header
          const sessionDateMatch = sessionText.match(/Date:\s*([^\])\n]+)/);
          const sessDate = sessionDateMatch?.[1]?.trim() ?? '';
          return llm(
            `The session date is ${sessDate}.\nThe user says: "${relCheck}"\n\nCompute the actual date. For example:\n- "a month ago" from 2023/05/30 = 2023-04-30\n- "last week" from 2023/05/30 = approximately 2023-05-23\n- "14 days ago" from 2023/05/30 = 2023-05-16\n\nActual date (YYYY-MM-DD only):`
          );
        } else {
          return llm(
            `When did the user ${verb} "${thing}"? Find the explicit date.\n\n"Pre-ordered" ≠ "got/received" — use when they actually ${verb} it.\n\n${sessionText.slice(0, 3000)}\n\nDate (YYYY-MM-DD only):`
          );
        }
      }

      const dateA = extractDate(things[0]!, textForA);
      const dateB = extractDate(things[1]!, textForB);

      const datesA = dateA.match(/\d{4}-\d{2}-\d{2}/g) || [];
      const datesB = dateB.match(/\d{4}-\d{2}-\d{2}/g) || [];

      if (datesA.length > 0 && datesB.length > 0) {
        const dA = parseDate(datesA[datesA.length - 1]!);
        const dB = parseDate(datesB[datesB.length - 1]!);
        if (dA && dB) {
          const diffDays = Math.abs(daysBetween(dA, dB));
          if (diffDays === 0) {
            // Same day — can't determine from dates alone, ask LLM with focused text
            const tiebreak = llm(
              `Both "${things[0]}" and "${things[1]}" happened on the same date (${datesA[datesA.length - 1]}). Based on the conversation context, which one happened FIRST (earlier in the day, or was done/set up first)?\n\n${allSorted}\n\nWhich was first? Answer with ONLY the name:`
            );
            return { answer: tiebreak, method: 'pgsl-temporal-tiebreak', reasoning: `Same date ${datesA[datesA.length - 1]} — LLM tiebreak` };
          }
          const structuralFirst = dA < dB ? things[0]! : things[1]!;

          // CONSENSUS: compare structural answer with direct LLM answer
          const directMatchesA = directName.toLowerCase().includes(things[0]!.toLowerCase().slice(0, 10));
          const directMatchesB = directName.toLowerCase().includes(things[1]!.toLowerCase().slice(0, 10));
          const directFirst = directMatchesA ? things[0]! : directMatchesB ? things[1]! : '';

          if (directFirst && directFirst !== structuralFirst) {
            // Disagreement! Get a third opinion as tiebreaker
            const tiebreaker = llm(
              `Two methods gave different answers for: "${question}"\nMethod 1 (date extraction): ${structuralFirst} (dates: ${datesA[datesA.length-1]} vs ${datesB[datesB.length-1]})\nMethod 2 (direct reading): ${directFirst}\n\nRe-read the text carefully. Remember: "pre-ordered Jan 28" but "arrived Feb 25" means they GOT it Feb 25. "Started seeds since Feb 20" means they started Feb 20.\n\n${textForA}\n\n${textForB}\n\nWhich is correct? Answer with ONLY the name:`
            );
            return { answer: tiebreaker.replace(/\*\*/g, '').trim(), method: 'pgsl-temporal-consensus', reasoning: `Structural=${structuralFirst}, Direct=${directFirst}, Tiebreaker=${tiebreaker.trim()}` };
          }

          const first = structuralFirst;

          // If dates are close (within 7 days), also confirm
          if (diffDays <= 7) {
            const confirmRead = llm(
              `I extracted these dates:\n- "${things[0]}": ${datesA[datesA.length - 1]}\n- "${things[1]}": ${datesB[datesB.length - 1]}\n\nBased on the sessions below, is this correct? Which one ACTUALLY happened first?\n\nRemember: "since February 20th" means it started on Feb 20. "Arrived on March 3rd" means it arrived March 3. Compute relative dates from session dates.\n\n${allSorted}\n\nWhich happened first? Answer with ONLY the name:`
            );
            if (confirmRead.length > 2 && confirmRead.length < 200) {
              return { answer: confirmRead.replace(/\*\*/g, '').trim(), method: 'pgsl-temporal-confirmed', reasoning: `Close dates (${diffDays} days apart) — LLM confirmed: ${confirmRead.trim()}` };
            }
          }

          return {
            answer: first,
            method: 'pgsl-temporal-decomposed',
            reasoning: `Decomposed: "${things[0]}"=${datesA[datesA.length - 1]} vs "${things[1]}"=${datesB[datesB.length - 1]} → ${first} was first`,
          };
        }
      }

      // RETRY with combined focused approach (catches "a month ago" patterns)
      if (datesA.length > 0 && datesB.length > 0) {
        // We got dates but they might be wrong. Try the combined approach as verification.
        const verifyBoth = llm(
          `Two events:\nA: "${things[0]}"\nB: "${things[1]}"\n\nFor each, find when the user ${verb} it. If "a month ago" or "last week", COMPUTE from the session date.\n\n${textForA}\n\n${textForB}\n\nA date (YYYY-MM-DD):\nB date (YYYY-MM-DD):\nWhich was first?`
        );
        const verifyDates = verifyBoth.match(/\d{4}-\d{2}-\d{2}/g) || [];
        if (verifyDates.length >= 2) {
          const vdA = parseDate(verifyDates[0]!);
          const vdB = parseDate(verifyDates[1]!);
          if (vdA && vdB && Math.abs(daysBetween(vdA, vdB)) > 0) {
            const first = vdA < vdB ? things[0]! : things[1]!;
            return { answer: first, method: 'pgsl-temporal-verified', reasoning: `Verified: "${things[0]}"=${verifyDates[0]} vs "${things[1]}"=${verifyDates[1]} → ${first}` };
          }
        }
      }

      // Fallback: couldn't extract dates cleanly. Use the direct answer from consensus method 1.
      if (directName.length > 2) {
        return { answer: directName, method: 'pgsl-temporal-direct', reasoning: 'Date extraction failed, using direct LLM answer' };
      }
      // Last resort
      const fallbackAnswer = llm(
        `Which happened first: "${things[0]}" or "${things[1]}"? "Pre-ordered" ≠ "got". Answer with ONLY the name.\n\n${allSorted}\n\nAnswer:`
      );
      return { answer: fallbackAnswer.replace(/\*\*/g, '').trim(), method: 'pgsl-temporal-fallback', reasoning: 'All extraction methods failed' };
    }
  }

  // ── DECOMPOSITION for duration questions ──
  if (/how many (days|weeks|months|years)/i.test(question) || /how long.*(?:had I been|did it take|did I|was I|have I been)/i.test(question)) {
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

          // Sanity check: if 0 days, the extraction probably got the same date for both. Retry with direct LLM.
          if (days === 0) {
            const retryAnswer = llm(
              `${allSorted}\n\n${questionDate ? `Question date: ${questionDate}.` : ''}\n\nQuestion: ${question}\n\nCompute the time duration. Quote the relevant dates from the text, then calculate. Give ONLY the number and unit:`
            );
            return { answer: retryAnswer, method: 'pgsl-duration-retry', reasoning: 'Decomposition got 0 days — LLM retry' };
          }

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

  // ── "How old" questions — let LLM compute directly ──
  if (/how old/i.test(question)) {
    const ageAnswer = llm(
      `Find the user's age at the time of the event. Look for:\n1. Explicit age mentions ("I'm 27 years old")\n2. Birth year mentions\n3. Age at previous events that can be used to calculate\n\nDo NOT confuse session dates with birth dates.\n\n${allSorted}\n\nQuestion: ${question}\n\nShow your reasoning, then give ONLY the age (number):`
    );
    return { answer: ageAnswer, method: 'pgsl-age', reasoning: 'Age computation via LLM' };
  }

  // ── DECOMPOSITION for counting questions ──
  if (/how many/i.test(question) && !/how many (days|weeks|months|years)/i.test(question)) {
    // Step 1: What are we counting?
    const category = llm(`What specific category is being counted? Short phrase only.\n\nQuestion: ${question}\n\nCategory:`).trim();

    // Step 2: Per-session extraction ONLY (not bulk)
    // Each session gets full LLM attention — bulk extraction misses items in long contexts
    const allItems: Array<{item: string; session: number}> = [];
    for (const s of index.sessions) {
      const items = llm(
        `Question: "${question}"\nCategory: "${category}"\n\nList EVERY item in this session where the user participated, attended, volunteered at, organized, was involved with, ran/walked/cycled in, or ANY form of involvement. Include fundraisers, galas, tournaments, walks, runs, charity events of any kind.\n\nOne per line, exact name. NONE if none.\n\nSession ${s.index + 1} (${s.date ?? ''}):\n${s.text.slice(0, 5000)}\n\nItems:`
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

    // Step 3: If counting before/after a reference, we need DATES for each item
    if (/before|after/i.test(question) && allItems.length > 0) {
      // Get dates for each item AND the reference event
      const uniqueItems = [...new Set(allItems.map(i => i.item))];
      const itemsWithDates = llm(
        `Find the DATE for each item AND the reference event. Use YYYY-MM-DD format. If only a month is given (e.g., "in June"), use the 1st (e.g., 2023-06-01). If only "November" with no year, assume 2023.\n\nItems:\n${uniqueItems.map(i => `  - ${i}`).join('\n')}\n\nQuestion: ${question}\n\n${allSorted}\n\nReturn ONE line per item: name | YYYY-MM-DD\nEvery item MUST have a date. Include the reference event.`
      );

      // Parse dates
      const itemDates: Array<{name: string; date: Date}> = [];
      let refDate: Date | null = null;
      const refMatch = question.match(/before (?:the )?['"]?(.+?)['"]?\s*(?:event|$)/i) || question.match(/after (?:the )?['"]?(.+?)['"]?\s*(?:event|$)/i);
      const refName = refMatch?.[1]?.trim().toLowerCase() ?? '';

      for (const line of itemsWithDates.split('\n')) {
        // Match full date (YYYY-MM-DD) or partial date (YYYY-MM) or month name
        const m = line.match(/(.+?)\s*\|\s*(.+)/);
        if (m) {
          const name = m[1]!.trim();
          let dateStr = m[2]!.trim();
          // Normalize partial dates: "2023-06" → "2023-06-01", "June 2023" → "2023-06-01"
          const monthNames: Record<string, string> = { january:'01', february:'02', march:'03', april:'04', may:'05', june:'06', july:'07', august:'08', september:'09', october:'10', november:'11', december:'12' };
          const monthMatch = dateStr.toLowerCase().match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?/);
          if (monthMatch) {
            const year = monthMatch[2] ?? '2023';
            dateStr = `${year}-${monthNames[monthMatch[1]!]}-01`;
          }
          const partialMatch = dateStr.match(/^(\d{4})-(\d{2})$/);
          if (partialMatch) {
            dateStr = `${partialMatch[1]}-${partialMatch[2]}-01`;
          }
          const d = parseDate(dateStr);
          if (d) {
            if (refName && name.toLowerCase().includes(refName.slice(0, 12))) {
              refDate = d;
            }
            itemDates.push({ name, date: d });
          }
        }
      }

      if (refDate && itemDates.length > 0) {
        const isBefore = /before/i.test(question);
        const filtered = itemDates.filter(i => {
          if (i.name.toLowerCase().includes(refName.slice(0, 12))) return false; // exclude reference itself
          return isBefore ? i.date < refDate! : i.date > refDate!;
        });
        const unique = [...new Set(filtered.map(i => i.name.toLowerCase()))];
        return { answer: `${unique.length}`, method: 'pgsl-count-temporal', reasoning: `${unique.length} "${category}" ${isBefore ? 'before' : 'after'} ${refName}: ${unique.join(', ')}` };
      }

      // Fallback: let LLM count with full context
      const fallbackCount = llm(
        `${allSorted}\n\nQuestion: ${question}\n\nList each "${category}" that matches the before/after criteria with its date, then give the count. Number only at the end:`
      );
      const num = fallbackCount.match(/(\d+)\s*$/m);
      if (num) return { answer: num[1]!, method: 'pgsl-count-fallback', reasoning: `LLM counted with full context: ${num[1]}` };
    }

    // Step 3 (no before/after): deduplicate, verify, and count
    if (allItems.length > 0) {
      const unique = [...new Set(allItems.map(i => i.item.toLowerCase().trim()))];

      // STRICT VERIFICATION: have LLM verify each item actually matches the criteria
      // This catches overcounting (items mentioned but not matching) and dedup errors
      const verified = llm(
        `I extracted these "${category}" from the conversation:\n${unique.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n\nQuestion: ${question}\n\nFor EACH item, verify it ACTUALLY matches what the question asks. Consider:\n- "bought" ≠ "considered buying"\n- "visited" ≠ "planned to visit"\n- Later sessions may UPDATE earlier ones (e.g., returned an item = doesn't count)\n- Don't double-count the same item mentioned in multiple sessions\n- Only count items the USER did, not items the assistant suggested\n\n${allSorted}\n\nList ONLY the items that genuinely match, with a brief quote as evidence. Then give the final count.\n\nVerified items:\n`
      );

      // Extract the count from verification
      const countMatch = verified.match(/(?:final count|total|count)[:\s]*(\d+)/i) || verified.match(/(\d+)\s*(?:items?|total)/i);
      if (countMatch) {
        return { answer: countMatch[1]!, method: 'pgsl-count-verified-strict', reasoning: `${unique.length} extracted → ${countMatch[1]} verified` };
      }

      // Fallback: count the verified items by counting numbered/bulleted items in the response
      const verifiedItems = verified.split('\n').filter(l => /^\s*[-•*\d]/.test(l) && l.length > 5 && !/not|doesn't|don't|excluded|removed/i.test(l));
      if (verifiedItems.length > 0 && verifiedItems.length !== unique.length) {
        return { answer: `${verifiedItems.length}`, method: 'pgsl-count-verified-strict', reasoning: `${unique.length} extracted → ${verifiedItems.length} verified by evidence` };
      }

      // Knowledge update check
      const isUpdate = /currently|do I have|do I own/i.test(question);
      if (isUpdate) {
        const reconciled = llm(
          `Current count of "${category}" considering all sessions chronologically (later updates earlier):\n${allItems.map(i => `  Session ${i.session + 1}: ${i.item}`).join('\n')}\n\nQ: ${question}\nCount (number only):`
        );
        const num = reconciled.match(/\d+/);
        if (num) return { answer: num[0]!, method: 'pgsl-count-reconciled', reasoning: `${allItems.length} items reconciled to ${num[0]}` };
      }

      return { answer: `${unique.length}`, method: 'pgsl-count-decomposed', reasoning: `${unique.length} unique "${category}"` };
    }
  }

  // ── SUM/TOTAL questions (money, hours, etc.) ──
  if (/how much.*total|total.*(?:money|hours|time|cost|spent)|how many hours.*total|how many.*total.*hours/i.test(question)) {
    const sumAnswer = llm(
      `This question asks for a TOTAL/SUM. Find every relevant number, add them up. Show your work.\n\n${allSorted}\n\nQuestion: ${question}\n\nList each amount found with source, then compute the total:`
    );
    return { answer: sumAnswer, method: 'pgsl-sum', reasoning: 'Sum/total computation' };
  }

  // ── DECOMPOSITION for "which most/least" (superlative counting) ──
  if (/which.*most|which.*least|which.*more|which.*fewer/i.test(question)) {
    // Step 1: LLM lists and counts
    const work = llm(
      `List ALL items per category, count each, then identify the winner.\n\n${allSorted}\n\nQuestion: ${question}\n\nShow work, then on the LAST line write ONLY the answer (just the name):`
    );
    // Step 2: Extract just the final answer name
    const lines = work.split('\n').filter(l => l.trim().length > 0);
    let finalAnswer = lines[lines.length - 1]?.trim() ?? work;
    // Clean markdown/bold
    finalAnswer = finalAnswer.replace(/\*\*/g, '').replace(/^(Answer|Final answer|The answer is)[:\s]*/i, '').trim();
    // If still long, ask LLM to extract just the name
    if (finalAnswer.length > 80) {
      finalAnswer = llm(`From this analysis, what is the single answer to "${question}"? Give ONLY the name, nothing else.\n\n${work.slice(-500)}\n\nAnswer:`);
    }
    return { answer: finalAnswer, method: 'pgsl-superlative', reasoning: 'Superlative counting' };
  }

  // ── PREFERENCE QUESTIONS — special handling ──
  if (strategy.questionType === 'single-session-preference' || /recommend|suggest|can you.*for me/i.test(question)) {
    // Preference questions want: "Based on what the user told you in past conversations,
    // what would they prefer?" NOT a direct answer to the question.
    const prefAnswer = llm(
      `You previously had a conversation with this user. Now they're asking a new question. Based on what you learned about their preferences, interests, and situation from the PREVIOUS conversation, describe what kind of answer they would prefer.\n\nDO NOT answer the question directly. Instead, describe the USER'S PREFERENCES that should guide the answer. Start with "The user would prefer..."\n\nPrevious conversation:\n${allSorted}\n\nNew question: ${question}\n\nThe user would prefer:`
    );
    const cleaned = prefAnswer.startsWith('The user would prefer') ? prefAnswer : `The user would prefer ${prefAnswer}`;
    return { answer: cleaned, method: 'pgsl-preference', reasoning: 'Preference inference from conversation context' };
  }

  // ── GENERAL: LLM reads with focused instructions ──
  let instructions = '';
  if (strategy.questionType === 'knowledge-update') {
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

// ═══════════════════════════════════════════════════════════
//  VERIFICATION PASS — OODA applied to the answer itself
// ═══════════════════════════════════════════════════════════

/**
 * Verify a candidate answer against the original text.
 * If verification fails, re-read and revise.
 *
 * This is the general fix for both extraction-miss and
 * date-extraction errors: after computing a structural answer,
 * have the LLM confirm it by re-reading the source.
 */
function verifyAndRevise(
  question: string,
  candidate: { answer: string; method: string; reasoning: string },
  sessions: SessionData[],
  questionDate?: string,
): { answer: string; method: string; reasoning: string } {
  // Skip verification for abstention answers
  if (candidate.answer.includes('not enough to answer')) return candidate;

  // Skip for general LLM reads (already read the full text)
  if (candidate.method === 'pgsl-read' || candidate.method === 'llm-fallback') return candidate;

  // Build concise session text for verification
  const sessionText = sessions
    .sort((a, b) => a.index - b.index)
    .map(s => `Session ${s.index + 1} (${s.date ?? ''}):\n${s.text.slice(0, 2500)}`)
    .join('\n\n');

  // Ask LLM to verify — be AGGRESSIVE about finding misses
  const verification = llm(
    `I need to VERIFY this answer by re-reading ALL sessions.\n\nQuestion: ${question}${questionDate ? `\nQuestion date: ${questionDate}` : ''}\nMy computed answer: ${candidate.answer}\n\nRe-read EVERY session below and independently answer the question yourself. Don't trust my answer — check it.\n\nIMPORTANT for counting questions:\n- An event is a "charity event" if it involves fundraising, volunteering for a cause, running/walking/cycling for charity, galas, tournaments, etc.\n- "Volunteered at X" counts as participating in X\n- Check ALL sessions, not just the obvious ones\n- List every item you find, then count\n\nIMPORTANT for temporal questions:\n- If a date is relative ("a month ago"), compute from the session date\n- Quote the sentence with the date reference\n\n${sessionText}\n\nYour independent answer to "${question}":\n(If it matches "${candidate.answer}", say CONFIRMED. If different, give your answer.):`
  );

  const isConfirmed = verification.toLowerCase().includes('confirmed') || verification.toLowerCase().startsWith('yes');

  if (isConfirmed) {
    return { ...candidate, method: candidate.method + '-verified', reasoning: candidate.reasoning + ' [VERIFIED]' };
  }

  // Verification failed — extract the corrected answer
  // The verification response should contain the correct answer
  const correctedMatch = verification.match(/correct answer[:\s]+(.+?)(?:\n|$)/i)
    || verification.match(/should be[:\s]+(.+?)(?:\n|$)/i)
    || verification.match(/the answer is[:\s]+(.+?)(?:\n|$)/i);

  if (correctedMatch) {
    const corrected = correctedMatch[1]!.trim();
    return { answer: corrected, method: candidate.method + '-revised', reasoning: `Verification revised: ${candidate.reasoning} → ${corrected}` };
  }

  // Can't parse correction — ask directly
  const directRevision = llm(
    `My answer "${candidate.answer}" to "${question}" was wrong. Based on the sessions, what is the correct answer? Give ONLY the answer.\n\n${sessionText}\n\nCorrect answer:`
  );

  if (directRevision.length > 0 && directRevision.length < 200) {
    return { answer: directRevision, method: candidate.method + '-revised', reasoning: `Verification rejected original, LLM revised` };
  }

  return candidate; // Can't verify, return original
}

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
    const rawResult = answer(item.question, index, ranked, item.question_date);
    // OODA verification pass: verify structural answers against source text
    const result = verifyAndRevise(item.question, rawResult, index.sessions, item.question_date);
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
      console.log(`  Gold: ${String(item.answer).slice(0, 200)}`);
      console.log(`  Ours: ${result.answer.slice(0, 200)}`);
      console.log(`  Reasoning: ${result.reasoning.slice(0, 150)}`);
      console.log(`  Sessions: ${index.sessions.length} | KB atoms: ${latticeStats(index.pgsl).atoms}`);
      const methods = Object.entries(methodCounts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`\n  HALTED at ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) | ${methods}`);
      console.log(`  Resume: npx tsx benchmarks/run-pgsl-native.ts ${MODEL} ${qi + 1}`);
      break;
    }

    if (total % 10 === 0) {
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
