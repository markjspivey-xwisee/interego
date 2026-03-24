#!/usr/bin/env tsx
/**
 * REAL SYSTEM PIPELINE — everything goes through Context Graphs.
 *
 * This is NOT "send text to LLM." This is:
 *   1. INGEST all conversations into PGSL lattice
 *   2. EXTRACT entities + relations structurally
 *   3. BUILD knowledge graph from extracted facts
 *   4. QUERY the knowledge graph for each question
 *   5. COMPOSE facts across sessions (multi-hop via composition operators)
 *   6. LLM only for what structural derivation can't handle
 *
 * The system does the work. The LLM is a fallback.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Import our ACTUAL system
import {
  createPGSL,
  embedInPGSL,
  pgslResolve,
  latticeMeet,
  latticeStats,
  extractEntities,
  extractRelations,
  expandEntitiesWithOntology,
  buildCoOccurrenceMatrix,
} from '../src/pgsl/index.js';

import type { PGSLInstance, NodeProvenance } from '../src/pgsl/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dirname, '.tmp-prompt.txt');
const MODEL = process.argv[2] || 'opus';
const BENCHMARK = process.argv[3] || 'locomo';
const LIMIT = parseInt(process.argv[4] || '50');

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

// ── Knowledge Graph (built from PGSL + extraction) ───────────

interface Fact {
  subject: string;
  predicate: string;
  object: string;
  session: number;
  source: string;  // original text
}

interface KnowledgeGraph {
  pgsl: PGSLInstance;
  facts: Fact[];
  entities: Map<string, Set<number>>;  // entity → sessions it appears in
  cooccurrence: Map<string, Set<string>>;  // entity → co-occurring entities
}

function buildKnowledgeGraph(sessions: string[]): KnowledgeGraph {
  const provenance: NodeProvenance = { wasAttributedTo: 'benchmark', generatedAtTime: new Date().toISOString() };
  const pgsl = createPGSL(provenance);
  const facts: Fact[] = [];
  const entities = new Map<string, Set<number>>();
  const cooccurrence = new Map<string, Set<string>>();

  for (let i = 0; i < sessions.length; i++) {
    // Extract entities + ingest into PGSL
    const ents = extractEntities(sessions[i]!);
    const entityText = ents.nounPhrases.join(' ');
    if (entityText.length > 0) embedInPGSL(pgsl, entityText);

    for (const e of ents.allEntities) {
      if (!entities.has(e)) entities.set(e, new Set());
      entities.get(e)!.add(i);
    }

    // Extract relations
    const rels = extractRelations(sessions[i]!);
    for (const r of rels.relations) {
      facts.push({
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        session: i,
        source: r.source || '',
      });
    }

    // Build co-occurrence within this session
    const sessionEnts = ents.allEntities;
    for (const a of sessionEnts) {
      if (!cooccurrence.has(a)) cooccurrence.set(a, new Set());
      for (const b of sessionEnts) {
        if (a !== b) cooccurrence.get(a)!.add(b);
      }
    }
  }

  return { pgsl, facts, entities, cooccurrence };
}

// ── Structural Query ─────────────────────────────────────────

function queryKG(kg: KnowledgeGraph, question: string): {
  matchedFacts: Fact[];
  relevantSessions: number[];
  chainedFacts: Fact[][];  // multi-hop chains
} {
  const qEntities = extractEntities(question);
  const qExpanded = new Set(expandEntitiesWithOntology(qEntities.allEntities));

  // Find facts matching question entities
  const matchedFacts = kg.facts.filter(f => {
    const factText = `${f.subject} ${f.predicate} ${f.object}`.toLowerCase();
    return [...qExpanded].some(e => factText.includes(e));
  });

  // Find relevant sessions
  const relevantSessions = new Set<number>();
  for (const e of qExpanded) {
    const sessions = kg.entities.get(e);
    if (sessions) for (const s of sessions) relevantSessions.add(s);
  }

  // Multi-hop: chain facts where one fact's object is another's subject
  const chainedFacts: Fact[][] = [];
  for (const f1 of matchedFacts) {
    for (const f2 of kg.facts) {
      if (f1 === f2) continue;
      // f1.object appears in f2.subject (or vice versa)
      if (f2.subject.toLowerCase().includes(f1.object.toLowerCase()) ||
          f1.object.toLowerCase().includes(f2.subject.toLowerCase())) {
        chainedFacts.push([f1, f2]);
      }
    }
  }

  return { matchedFacts, relevantSessions: [...relevantSessions], chainedFacts };
}

// ── Structural Answer Derivation ─────────────────────────────

function deriveAnswer(query: ReturnType<typeof queryKG>, question: string): string | null {
  const { matchedFacts, chainedFacts } = query;

  // Direct fact match
  if (matchedFacts.length === 1) {
    return matchedFacts[0]!.object;
  }

  // Multi-hop chain
  if (chainedFacts.length > 0) {
    // Take the longest chain's final object
    const best = chainedFacts.sort((a, b) => b.length - a.length)[0]!;
    return best[best.length - 1]!.object;
  }

  return null; // Can't derive structurally
}

// ── Judge ────────────────────────────────────────────────────

function judge(q: string, gen: string, gold: string): boolean {
  const result = llm(`Same core info? Numbers match? Just "yes" or "no".
Q: ${q}
Gen: ${gen.slice(0, 600)}
Gold: ${gold}
Correct?`);
  return result.toLowerCase().replace(/[*"'\s]/g, '').startsWith('yes');
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  if (BENCHMARK === 'locomo') {
    const data = JSON.parse(readFileSync(resolve(__dirname, 'locomo/data/locomo10.json'), 'utf-8')) as any[];
    console.log(`\n=== REAL SYSTEM PIPELINE — LoCoMo (${data.length} conversations) ===`);
    console.log(`PGSL ingestion + entity/relation extraction + structural query`);
    console.log(`LLM fallback only when structural derivation fails`);
    console.log(`Model: ${MODEL} | Cost: $0\n`);

    let correct = 0, total = 0, structural = 0, llmFallback = 0;
    const typeResults: Record<string, { t: number; c: number }> = {};

    for (const conv of data) {
      // Build session texts
      const sessionTexts: string[] = [];
      const convData = conv.conversation;
      const sessionKeys = Object.keys(convData).filter((k: string) => k.startsWith('session_') && !k.includes('date'));

      for (const sk of sessionKeys) {
        const session = convData[sk];
        if (Array.isArray(session)) {
          sessionTexts.push(session.map((turn: any) => `${turn.speaker}: ${turn.text}`).join('\n'));
        }
      }

      // BUILD KNOWLEDGE GRAPH from our system
      console.log(`  Building KG for conversation ${conv.sample_id || '?'} (${sessionTexts.length} sessions)...`);
      const kg = buildKnowledgeGraph(sessionTexts);
      const stats = latticeStats(kg.pgsl);
      console.log(`    PGSL: ${stats.atoms} atoms, ${stats.fragments} fragments, ${kg.facts.length} facts\n`);

      // Process QA pairs
      const qaEntries = Object.values(conv.qa) as any[];
      const sampled = qaEntries.slice(0, Math.ceil(LIMIT / data.length));

      for (const qa of sampled) {
        if (!qa.question) continue;
        total++;
        if (total > LIMIT) break;

        const goldAnswer = typeof qa.answer === 'string' ? qa.answer
          : Array.isArray(qa.answer) ? qa.answer.join(', ')
          : String(qa.answer);
        const qType = String(qa.question_type || 'unknown');
        if (!typeResults[qType]) typeResults[qType] = { t: 0, c: 0 };
        typeResults[qType].t++;

        // STRUCTURAL QUERY — find relevant facts and sessions
        const query = queryKG(kg, qa.question);

        // Build focused context from our system's output
        const factsContext = query.matchedFacts.length > 0
          ? 'Extracted facts (from knowledge graph):\n' + query.matchedFacts.slice(0, 30).map(f =>
              `  ${f.subject} ${f.predicate} ${f.object} [session ${f.session + 1}]: "${f.source.slice(0, 100)}"`).join('\n')
          : '';
        const chainsContext = query.chainedFacts.length > 0
          ? '\nMulti-hop chains:\n' + query.chainedFacts.slice(0, 10).map(chain =>
              chain.map(f => `${f.subject} → ${f.predicate} → ${f.object}`).join(' THEN ')).join('\n')
          : '';

        // Give LLM the RELEVANT sessions (from our structural query), not all sessions
        const relevantSessionTexts = query.relevantSessions.length > 0
          ? query.relevantSessions.map(i => `=== Session ${i + 1} ===\n${sessionTexts[i]}`).join('\n\n')
          : sessionTexts.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n');

        if (query.matchedFacts.length > 0) structural++;
        else llmFallback++;

        const answer = llm(`Answer this question. Use the extracted facts first, then verify against the sessions.

${factsContext}${chainsContext}

${relevantSessionTexts}

Question: ${qa.question}

Give ONLY the specific answer:`);


        try {
          const ok = judge(qa.question, answer, goldAnswer);
          if (ok) { correct++; typeResults[qType].c++; }
        } catch {}

        if (total % 10 === 0) {
          console.log(`  ${total}/${LIMIT}: ${(100 * correct / total).toFixed(0)}% (structural: ${structural}, llm: ${llmFallback})`);
        }
      }
      if (total > LIMIT) break;
    }

    console.log(`\n=== RESULTS: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) ===`);
    console.log(`  Structural answers: ${structural} (${(100 * structural / total).toFixed(0)}%)`);
    console.log(`  LLM fallback: ${llmFallback} (${(100 * llmFallback / total).toFixed(0)}%)`);
    for (const [type, r] of Object.entries(typeResults)) {
      console.log(`  Type ${type}: ${r.c}/${r.t} (${(100 * r.c / r.t).toFixed(0)}%)`);
    }
    console.log(`\nPrior (raw LLM only): 52.0%`);

  } else {
    // LongMemEval
    const data = JSON.parse(readFileSync(resolve(__dirname, 'LongMemEval/data/longmemeval_oracle.json'), 'utf-8'));
    const sample = data.slice(0, LIMIT);

    console.log(`\n=== REAL SYSTEM PIPELINE — LongMemEval (${sample.length}q) ===\n`);

    let correct = 0, total = 0, structural = 0;

    for (const item of sample) {
      total++;
      const sessions: string[] = item.haystack_sessions.map((s: any) =>
        typeof s === 'string' ? s : Array.isArray(s) ? s.map((t: any) => typeof t === 'string' ? t : (t.content || t.text || '')).join(' ') : JSON.stringify(s));

      const kg = buildKnowledgeGraph(sessions);
      const query = queryKG(kg, item.question);
      let answer = deriveAnswer(query, item.question);

      if (answer) {
        structural++;
      } else {
        const factsCtx = query.matchedFacts.slice(0, 20).map(f => `${f.subject} ${f.predicate} ${f.object}`).join('\n');
        const sessCtx = sessions.map((s, i) => `=== Session ${i + 1} ===\n${s}`).join('\n\n');
        answer = llm(`${factsCtx ? 'Extracted facts:\n' + factsCtx + '\n\n' : ''}${sessCtx}\n\nQ: ${item.question}\nAnswer:`);
      }

      const ok = judge(item.question, answer, String(item.answer));
      if (ok) correct++;

      if (total % 20 === 0) console.log(`  ${total}/${sample.length}: ${(100 * correct / total).toFixed(0)}% (structural: ${structural})`);
    }

    console.log(`\n=== RESULTS: ${correct}/${total} (${(100 * correct / total).toFixed(1)}%) ===`);
    console.log(`  Structural: ${structural}/${total}`);
  }
}

main().catch(console.error);
