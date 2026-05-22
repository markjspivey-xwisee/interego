/**
 * Foxxi sample outcome corpus — a realistic body of historical
 * intervention outcomes for the calibration demo.
 *
 * Each spec is one (Knowable regime × cause × intervention) cell: how
 * many comparable situations closed, improved, or did not move — and,
 * for the ones that did not, what the cause turned out to be on
 * re-contextualization. These are the numbers a real L&D / performance
 * function accumulates over a year or two of honest follow-up.
 *
 * The shape of the corpus is the point: instruction chosen for a
 * Knowledge & Skill cause closes the gap far less often than the
 * environmental fixes do — and most of its misses were really incentive
 * problems. The same Knowledge & Skill cause, routed instead to an
 * in-the-flow job aid, closes far more reliably. The system only knows
 * this because it recorded its own outcomes.
 *
 * Calibration tracks the Knowable regime — the one regime that names a
 * cause, and therefore the one regime whose cause analysis can be right
 * or wrong. Every spec is `regime: 'Knowable', method: 'gap-analysis'`.
 *
 * Pure data — type-only imports — so the bridge seed, the CLI demo and
 * the microsite can all consume it.
 */

import type { OutcomeSpec } from './performance-calibration.js';

/** The tenant's own accumulated outcomes (Acme Training Co). */
export const SAMPLE_OUTCOMES: OutcomeSpec[] = [
  // Instruction for a knowledge/skill cause — the humbling headline.
  // It closes the gap less than half the time, and the misses were
  // mostly incentive problems wearing a skill-gap costume.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'knowledgeSkill', intervention: 'instruction',
    closed: 92, improved: 38, noChange: 68, worsened: 12, source: 'acme',
    reDiagnosis: { incentives: 31, information: 22, motives: 16, instrumentation: 11 },
  },
  // The SAME cause, routed to an in-the-flow job aid instead — closes
  // far more reliably. The recommendation, not the cause, was the lever.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'knowledgeSkill', intervention: 'performance-support',
    closed: 21, improved: 4, noChange: 3, worsened: 0, source: 'acme',
    reDiagnosis: { information: 2, incentives: 1 },
  },
  // A genuine information gap, met with a job aid — closes well.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'information', intervention: 'performance-support',
    closed: 49, improved: 9, noChange: 6, worsened: 0, source: 'acme',
    reDiagnosis: { knowledgeSkill: 4, instrumentation: 2 },
  },
  // A broken tool, fixed — the strongest track record on record.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'instrumentation', intervention: 'environmental-fix',
    closed: 33, improved: 3, noChange: 2, worsened: 0, source: 'acme',
    reDiagnosis: { incentives: 2 },
  },
  // A misaligned incentive, realigned — closes reliably.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'incentives', intervention: 'environmental-fix',
    closed: 34, improved: 7, noChange: 4, worsened: 0, source: 'acme',
    reDiagnosis: { motives: 3, capacity: 1 },
  },
  // A motivation cause, met with coaching — a mixed record.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'motives', intervention: 'coaching',
    closed: 19, improved: 8, noChange: 5, worsened: 1, source: 'acme',
    reDiagnosis: { incentives: 4, capacity: 2 },
  },
  // A capacity cause, met with a job-design fix.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'capacity', intervention: 'environmental-fix',
    closed: 9, improved: 2, noChange: 3, worsened: 0, source: 'acme',
    reDiagnosis: { motives: 2, incentives: 1 },
  },
  // A thin cell — practice for a decayed skill. Too few outcomes for the
  // tenant alone to Assert a rate; federation is what makes it speak.
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'knowledgeSkill', intervention: 'practice',
    closed: 3, improved: 1, noChange: 1, worsened: 0, source: 'acme',
  },
];

/**
 * A federation peer's published calibration evidence (Peer Academy).
 * Composed with the tenant's, it deepens the shared finding — and the
 * thin `practice` cell, Hypothetical for either org alone, becomes
 * Asserted once their evidence is pooled.
 */
export const SAMPLE_PEER_OUTCOMES: OutcomeSpec[] = [
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'knowledgeSkill', intervention: 'instruction',
    closed: 14, improved: 6, noChange: 9, worsened: 2, source: 'peer-academy',
    reDiagnosis: { incentives: 6, information: 3, motives: 2 },
  },
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'knowledgeSkill', intervention: 'practice',
    closed: 8, improved: 2, noChange: 1, worsened: 0, source: 'peer-academy',
  },
  {
    regime: 'Knowable', method: 'gap-analysis', causeFactor: 'information', intervention: 'performance-support',
    closed: 12, improved: 1, noChange: 1, worsened: 0, source: 'peer-academy',
  },
];
