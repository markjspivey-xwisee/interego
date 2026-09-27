/**
 * What has worked where: for each competency, each fragment offered at it, and each level of
 * learner it was pitched to, how the learners who met it went on to do.
 *
 * ★ EMERGENT, NOT DECLARED. Nobody says which explanation of a competency works. Every play adds
 * an outcome, and once a fragment's record at a competency and level holds EFFICACY_POLICY.assertAt
 * outcomes, its efficacy there is Asserted rather than Hypothetical: the same flip the performance
 * practice's calibration makes for an intervention. Resolution (compositions.ts) prefers what has
 * worked for learners at the same level, and still gives an alternative that has not been tried
 * enough its turn, so a new explanation can earn its place (chooseByEfficacy).
 *
 * ★ AN OUTCOME IS A COUNT, NOT A PERSON. A tally holds how many learners met a fragment at a
 * competency and level and how many then succeeded, with nobody in it. What is published about a
 * cell waits for EFFICACY_POLICY.publishAt outcomes, so a cell of one cannot be read as one
 * learner's result. That includes the reason a resolution gives for its choice, which the learner
 * sees and the step's record keeps.
 *
 * ★ EACH LEARNER COUNTS ONCE PER CELL. Replaying a composition to push one fragment up or down
 * would steer what everyone after is shown, so an outcome comes with a token: an HMAC, under a key
 * only the bridge holds, of the learner and the cell together. The same learner in the same cell
 * gives the same token and is counted once; the token names nobody, and differs from cell to cell,
 * so a learner's outcomes cannot be linked across fragments either. A cell stops growing once it
 * has heard from EFFICACY_POLICY.learnersPerCell learners, which is evidence enough.
 *
 * ★ A TEACHING FRAGMENT IS CREDITED WITH THE CHECK THAT FOLLOWS IT. An explanation has no answer
 * of its own; what it is for shows in how the learner does on the next graded step at the same
 * competency in the same play. That step's outcome is credited to it (composition-play.ts).
 *
 * ★ THE STORED TALLY IS SEALED. Pod resources are world-readable, and a cell under
 * EFFICACY_POLICY.publishAt outcomes must not be readable anywhere. So the tally is kept as the
 * substrate's envelope, sealed by the bridge's own key to itself (sealTally), and a tally is
 * taken back only if that key sealed it (openTally): anyone can wrap a key to a public key, but
 * only its holder can wrap one from it.
 */
import { createHmac } from 'node:crypto';
import { createEncryptedEnvelope, envelopeFromJson, envelopeToJson, openEncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';
import type { CognitiveLevel } from './emergent-content.js';
import { competencyIdOf } from './competency-identity.js';
import { contentRefOf } from './content-fragments.js';

/** When a cell's efficacy is Asserted, when it may be published, and the confidence level of its lower bound. */
export const EFFICACY_POLICY = { assertAt: 12, publishAt: 5, z: 1.96, learnersPerCell: 1000 } as const;

const LEVELS: readonly CognitiveLevel[] = ['foundational', 'working', 'applied', 'advanced'];

/** The Wilson score lower bound of a success rate: what the rate is at least, at the policy's confidence. */
export function wilsonLowerBound(successes: number, n: number, z: number = EFFICACY_POLICY.z): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export interface EfficacyCounts { n: number; successes: number }

export interface EfficacyView extends EfficacyCounts {
  competency: string;
  fragment: string;
  level: CognitiveLevel;
  lowerBound: number;
  modalStatus: 'Asserted' | 'Hypothetical';
}

/** One outcome: at this competency and level, a learner who met this fragment went on to succeed or not. */
export interface Outcome { competency: string; fragment: string; level: CognitiveLevel; success: boolean }

const keyOf = (competency: string, fragment: string, level: string): string | undefined => {
  const c = competencyIdOf(competency) ?? undefined;
  const f = contentRefOf(fragment);
  if (!c || !f || f.type !== 'fragment' || !LEVELS.includes(level as CognitiveLevel)) return undefined;
  return `${c}\n${f.hash}\n${level}`;
};

/** A learner's token for an outcome's cell: an HMAC of the learner and the cell under the bridge's key. Undefined for an outcome that names no cell. */
export function outcomeToken(key: string, learner: string, o: Outcome): string | undefined {
  const cell = keyOf(o.competency, o.fragment, o.level);
  return cell ? createHmac('sha256', key).update(`${learner}\n${cell}`).digest('hex') : undefined;
}

interface Cell extends EfficacyCounts { heard: string[] }

/** The tally of outcomes, by competency, fragment and level. */
export class EfficacyTally {
  private readonly cells = new Map<string, Cell>();

  /** Count an outcome, once for each learner token in each cell. */
  record(o: Outcome, token: string): 'counted' | 'already-counted' | 'full' | 'not-a-cell' {
    const key = keyOf(o.competency, o.fragment, o.level);
    if (!key || !/^[0-9a-f]{64}$/.test(token)) return 'not-a-cell';
    const c = this.cells.get(key) ?? { n: 0, successes: 0, heard: [] };
    if (c.heard.includes(token)) return 'already-counted';
    if (c.heard.length >= EFFICACY_POLICY.learnersPerCell) return 'full';
    this.cells.set(key, { n: c.n + 1, successes: c.successes + (o.success ? 1 : 0), heard: [...c.heard, token] });
    return 'counted';
  }

  counts(competency: string, fragment: string, level: CognitiveLevel): EfficacyCounts | undefined {
    const key = keyOf(competency, fragment, level);
    const c = key ? this.cells.get(key) : undefined;
    return c ? { n: c.n, successes: c.successes } : undefined;
  }

  view(competency: string, fragment: string, level: CognitiveLevel): EfficacyView | undefined {
    const c = this.counts(competency, fragment, level);
    if (!c) return undefined;
    return {
      competency, fragment, level, ...c, lowerBound: Number(wilsonLowerBound(c.successes, c.n).toFixed(4)),
      modalStatus: c.n >= EFFICACY_POLICY.assertAt ? 'Asserted' : 'Hypothetical',
    };
  }

  /** Every cell for one fragment, as keys the caller can turn back into IRIs: [competency id, level, counts]. */
  cellsOf(fragment: string): Array<{ competencyId: string; level: CognitiveLevel; counts: EfficacyCounts }> {
    const f = contentRefOf(fragment);
    if (!f || f.type !== 'fragment') return [];
    const out: Array<{ competencyId: string; level: CognitiveLevel; counts: EfficacyCounts }> = [];
    for (const [key, counts] of this.cells) {
      const [competencyId, hash, level] = key.split('\n');
      if (hash === f.hash) out.push({ competencyId: competencyId!, level: level as CognitiveLevel, counts: { n: counts.n, successes: counts.successes } });
    }
    return out;
  }

  get size(): number { return this.cells.size; }

  /** The tally as plain data, for durable storage: counts and the tokens heard, nobody named. */
  toJSON(): Record<string, Cell> { return Object.fromEntries(this.cells); }

  /** A tally from stored data; entries that are not a well-formed cell are left out. */
  static from(data: unknown): EfficacyTally {
    const t = new EfficacyTally();
    if (!data || typeof data !== 'object') return t;
    for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
      const parts = key.split('\n');
      const cell = v as Partial<Cell>;
      if (parts.length !== 3 || !/^[0-9a-f]{64}$/.test(parts[1]!) || !LEVELS.includes(parts[2] as CognitiveLevel)) continue;
      if (!Number.isSafeInteger(cell?.n) || !Number.isSafeInteger(cell?.successes)) continue;
      if (cell.n! < 1 || cell.successes! < 0 || cell.successes! > cell.n!) continue;
      const heard = Array.isArray(cell.heard) ? [...new Set(cell.heard.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))] : [];
      // Each count is one learner heard: a cell whose counts and tokens disagree is not trusted.
      if (heard.length !== cell.n || heard.length > EFFICACY_POLICY.learnersPerCell) continue;
      t.cells.set(key, { n: cell.n!, successes: cell.successes!, heard });
    }
    return t;
  }
}

/**
 * Of several alternatives, the one to show: the most promising by what learners like this one did
 * with each, optimistic about what has not been tried much (upper confidence bound, UCB1). One not
 * tried at all here comes first, so every alternative is heard; after that, a better record wins,
 * and one with little evidence still gets an occasional turn. Deterministic: the same counts give
 * the same choice, and the author's order breaks ties.
 */
export function chooseByEfficacy(candidates: readonly string[], countsOf: (fragment: string) => EfficacyCounts | undefined):
  { chosen: string; why: string } {
  const withCounts = candidates.map((iri, order) => ({ iri, order, counts: countsOf(iri) ?? { n: 0, successes: 0 } }));
  const untried = withCounts.find(c => c.counts.n === 0);
  if (untried) return { chosen: untried.iri, why: 'no outcome here yet for learners at this level, so it gets its turn' };
  const total = withCounts.reduce((s, c) => s + c.counts.n, 0);
  const score = (c: EfficacyCounts): number => c.successes / c.n + Math.sqrt((2 * Math.log(total)) / c.n);
  const best = withCounts.reduce((a, c) => (score(c.counts) > score(a.counts) + 1e-12 ? c : a));
  const { n, successes } = best.counts;
  const status = n >= EFFICACY_POLICY.assertAt ? 'Asserted' : 'Hypothetical';
  // The reason is shown to the learner and recorded with the step, so it quotes a cell's counts
  // only once the cell may be published.
  const record = n >= EFFICACY_POLICY.publishAt
    ? `${successes} of ${n} went on to succeed (lower bound ${wilsonLowerBound(successes, n).toFixed(2)}, ${status})`
    : `fewer than ${EFFICACY_POLICY.publishAt} outcomes so far, too few to show (${status})`;
  return { chosen: best.iri, why: `the most promising here for learners at this level: ${record}` };
}

/** A tally sealed for keeping on a pod: readable only with `key`, which seals it to itself. */
export function sealTally(tally: EfficacyTally, key: EncryptionKeyPair): string {
  return envelopeToJson(createEncryptedEnvelope(JSON.stringify(tally), [key.publicKey], key));
}

/** The tally a sealed one holds, or undefined when `key` did not seal it or cannot open it. */
export function openTally(sealed: string, key: EncryptionKeyPair): EfficacyTally | undefined {
  try {
    const envelope = envelopeFromJson(sealed);
    const own = envelope.wrappedKeys.filter(w => w.recipientPublicKey === key.publicKey && w.senderPublicKey === key.publicKey);
    if (own.length === 0) return undefined;
    const plain = openEncryptedEnvelope({ ...envelope, wrappedKeys: own }, key);
    return plain === null ? undefined : EfficacyTally.from(JSON.parse(plain));
  } catch { return undefined; }
}
