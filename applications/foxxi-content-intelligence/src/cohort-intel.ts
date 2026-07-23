/**
 * Demo #8 — Cohort intelligence via concept-overlap analysis.
 *
 * Aggregates Q&A traces across a cohort of learners (pulled from each
 * learner's pod via the substrate's discover()), measures structural
 * overlap on the concepts each learner asked about, and surfaces the
 * concepts the cohort COLLECTIVELY needs reinforcement on.
 *
 * This is a small instance of the PGSL "meet" intuition — find the
 * shared sub-structure across many graphs. For the demo we implement
 * a lightweight set-intersection + frequency count over concept IRIs;
 * the real PGSL lattice (src/pgsl/) does this at the atom level and
 * federates across pods. Same idea, simpler implementation; same
 * affordance surface.
 *
 * The output is what an L&D admin would actually want: "82% of the
 * cohort asked about X, 64% about Y" → reinforcement signal.
 */

import {
  discover,
  fetchGraphContent,
} from '@interego/solid';
import { assertSafeFetchTarget, safeFetch, guardedFetchFn } from './ssrf-guard.js';

export interface CohortQAEntry {
  learnerDid: string;
  question: string;
  seedConceptIds: readonly string[];
  citedSlideIds: readonly string[];
  recordedAt?: string;
}

export interface CohortConceptStat {
  conceptId: string;
  conceptLabel?: string;
  learnerCount: number;
  questionCount: number;
  cohortCoveragePct: number;
}

export interface CohortIntelligence {
  cohortSize: number;
  totalQuestions: number;
  /** Concepts ranked by `learnerCount` desc — the ones the cohort collectively struggled most with. */
  conceptStats: CohortConceptStat[];
  /** Concepts asked about by >= 50% of the cohort. */
  reinforcementCandidates: CohortConceptStat[];
}

/**
 * Compute cohort intelligence from a list of Q&A entries (one per
 * question per learner). Pure function — caller is responsible for
 * gathering the entries from however many pods.
 */
export function summarizeCohort(entries: readonly CohortQAEntry[], conceptLabels?: ReadonlyMap<string, string>): CohortIntelligence {
  const learnerSet = new Set<string>();
  const conceptLearners = new Map<string, Set<string>>();
  const conceptQuestionCount = new Map<string, number>();
  for (const e of entries) {
    learnerSet.add(e.learnerDid);
    for (const cid of e.seedConceptIds) {
      if (!conceptLearners.has(cid)) conceptLearners.set(cid, new Set());
      conceptLearners.get(cid)!.add(e.learnerDid);
      conceptQuestionCount.set(cid, (conceptQuestionCount.get(cid) ?? 0) + 1);
    }
  }
  const cohortSize = learnerSet.size;
  const stats: CohortConceptStat[] = [];
  for (const [conceptId, learners] of conceptLearners.entries()) {
    stats.push({
      conceptId,
      conceptLabel: conceptLabels?.get(conceptId),
      learnerCount: learners.size,
      questionCount: conceptQuestionCount.get(conceptId) ?? 0,
      cohortCoveragePct: cohortSize > 0 ? Math.round((learners.size / cohortSize) * 1000) / 10 : 0,
    });
  }
  stats.sort((a, b) => b.learnerCount - a.learnerCount);
  const reinforcement = stats.filter(s => s.cohortCoveragePct >= 50);
  return {
    cohortSize,
    totalQuestions: entries.length,
    conceptStats: stats,
    reinforcementCandidates: reinforcement,
  };
}

/**
 * Walk a list of learner pods, pull every fxa:LearnerQuestionEvent
 * descriptor, parse the concept IDs from each, return the entries
 * suitable for summarizeCohort().
 */
export async function gatherCohortQA(args: {
  learnerPodUrls: readonly string[];
  windowFrom?: string;
  windowTo?: string;
  fetch?: typeof globalThis.fetch;
}): Promise<CohortQAEntry[]> {
  const fetchFn = args.fetch ?? globalThis.fetch;
  const out: CohortQAEntry[] = [];

  for (const podUrl of args.learnerPodUrls) {
    try {
      await assertSafeFetchTarget(podUrl); // SSRF: caller pod fetched via discover()
      const entries = await discover(podUrl, undefined, { fetch: guardedFetchFn(fetchFn) as never }); // re-guard manifest hop + redirects
      const qaEntries = entries.filter(e =>
        (e.conformsTo ?? []).some(c => c.includes('LearnerQuestionEvent') || c.includes('LearnerQA')),
      );
      const inWindow = qaEntries.filter(e => {
        if (!args.windowFrom && !args.windowTo) return true;
        const t = e.validFrom ? Date.parse(e.validFrom) : 0;
        if (args.windowFrom && t < Date.parse(args.windowFrom)) return false;
        if (args.windowTo && t > Date.parse(args.windowTo)) return false;
        return true;
      });
      for (const entry of inWindow) {
        try {
          // Fetch the graph + extract concept IDs from a bundleJson literal.
          const ttlR = await safeFetch(entry.descriptorUrl, { headers: { Accept: 'text/turtle' } }, fetchFn as never); // 2nd-hop SSRF + redirect-safe
          if (!ttlR.ok) continue;
          const ttl = await ttlR.text();
          const tm = ttl.match(/hydra:target\s+<([^>]+)>/);
          if (!tm) continue;
          await assertSafeFetchTarget(tm[1]!); // 2nd-hop SSRF
          const graph = await fetchGraphContent(tm[1]!, { fetch: guardedFetchFn(fetchFn) as never }); // graph hop: re-guard + redirect-safe
          if (!graph.content) continue;
          const bm = graph.content.match(/<[^>]*#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
          if (!bm) continue;
          const payload = JSON.parse(Buffer.from(bm[1]!.replace(/\s+/g, ''), 'base64').toString('utf8')) as {
            learnerDid?: string;
            question?: string;
            seedConceptIds?: string[];
            citedSlideIds?: string[];
          };
          out.push({
            learnerDid: payload.learnerDid ?? extractLearnerFromPod(podUrl),
            question: payload.question ?? '',
            seedConceptIds: payload.seedConceptIds ?? [],
            citedSlideIds: payload.citedSlideIds ?? [],
            recordedAt: entry.validFrom,
          });
        } catch { /* skip malformed entry */ }
      }
    } catch { /* skip unreachable pod */ }
  }
  return out;
}

function extractLearnerFromPod(podUrl: string): string {
  return podUrl.replace(/\/$/, '').split('/').pop() ?? podUrl;
}
