/**
 * Precedents: what earlier tasks actually touched, as evidence for where a new task belongs.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every navigation outcome records the files a task really changed. Until 2026-09-21 those
 * files fed calibration only — a hit rate per confidence bucket — and the next navigation
 * started from nothing but the tree and the model. Yet the pod holds every outcome this
 * delegate has ever published, across redeploys and across the bridges that publish as it
 * (the deployed one, CI's, a developer's), and a repository's tasks repeat: the same
 * subsystem, the same words, the same files. A precedent is an outcome's (task, observed
 * files) pair. A navigation consults the ones whose task resembles its own and mixes their
 * files into the model's candidate distribution. Policy stays in code — the similarity is
 * lexical, the weight is a function of it, both are written on the judgment — so a reader can
 * see exactly what memory contributed, and calibration keeps scoring the result.
 *
 * Nothing here calls the model; these are the pure functions the tests exercise.
 */

export interface Precedent {
  /** The task the earlier navigation was judged for. */
  readonly task: string;
  /** The files that task actually changed (repository-relative). */
  readonly files: readonly string[];
  readonly source: 'live' | 'backtest';
  readonly at: string;
  /** The outcome's graph IRI, for provenance on the judgment that consults it. */
  readonly outcomeIri: string;
}

export interface MatchedPrecedent extends Precedent {
  readonly similarity: number;
}

/** Precedents below this similarity are not consulted. */
export const PRECEDENT_MIN_SIMILARITY = 0.15;
/** At most this many precedents contribute to one judgment. */
export const PRECEDENT_MAX_APPLIED = 5;
/** The share of the candidate distribution precedents may take: this times the strongest similarity. */
export const PRECEDENT_WEIGHT = 0.5;
/** At most this many precedent files are added to a candidate set the directory pass left them out of. */
export const PRECEDENT_MAX_INJECTED = 12;

// Words that say nothing about WHERE a change belongs. Commit subjects are full of them.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'its', 'are', 'was',
  'were', 'not', 'but', 'has', 'have', 'had', 'does', 'did', 'add', 'adds', 'added', 'fix', 'fixes', 'fixed',
  'use', 'uses', 'used', 'make', 'makes', 'made', 'now', 'one', 'two', 'all', 'any', 'each', 'per', 'out',
  'over', 'under', 'only', 'also', 'more', 'less', 'new', 'old', 'own', 'same', 'other', 'which', 'what',
  'where', 'how', 'why', 'who', 'you', 'your', 'our', 'can', 'could', 'should', 'would', 'will', 'must',
  'may', 'been', 'being', 'after', 'before', 'because', 'about', 'again', 'still', 'never', 'always',
  'every', 'some', 'such', 'both', 'until', 'while', 'between', 'through', 'without', 'within', 'it',
]);

/** The content words of a task: lower-cased, camelCase and identifiers split, short and stop words dropped. */
export function taskTokens(task: string): Set<string> {
  const spaced = task.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const out = new Set<string>();
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw) || /^[0-9]+$/.test(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Jaccard similarity of two tasks' content words, 0 when either has none. */
export function taskSimilarity(a: string, b: string): number {
  const ta = taskTokens(a);
  const tb = taskTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both += 1;
  const union = ta.size + tb.size - both;
  return union === 0 ? 0 : Math.round((both / union) * 1000) / 1000;
}

/** The precedents worth consulting for a task: similar enough, strongest first, newest among equals, at most PRECEDENT_MAX_APPLIED. */
export function matchPrecedents(task: string, precedents: readonly Precedent[], opts: { readonly minSimilarity?: number; readonly max?: number } = {}): MatchedPrecedent[] {
  const min = opts.minSimilarity ?? PRECEDENT_MIN_SIMILARITY;
  return precedents
    .filter((p) => p.files.length > 0)
    .map((p) => ({ ...p, similarity: taskSimilarity(task, p.task) }))
    .filter((p) => p.similarity >= min)
    .sort((a, b) => b.similarity - a.similarity || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, opts.max ?? PRECEDENT_MAX_APPLIED);
}

export const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Each precedent spreads its similarity over its files; the sum per path, normalised to 1. */
export function precedentWeights(matched: readonly MatchedPrecedent[]): Map<string, number> {
  const raw = new Map<string, number>();
  for (const m of matched) {
    const share = m.similarity / m.files.length;
    for (const f of m.files) {
      const key = normalizePath(f);
      raw.set(key, (raw.get(key) ?? 0) + share);
    }
  }
  let total = 0;
  for (const v of raw.values()) total += v;
  const out = new Map<string, number>();
  if (total > 0) for (const [k, v] of raw) out.set(k, v / total);
  return out;
}

export interface PrecedentMix {
  /** The candidate distribution after mixing, keyed as the input was. */
  readonly probabilities: Record<string, number>;
  /** The share that came from precedents; 0 when none of their files was a candidate. */
  readonly weight: number;
  /** The precedent paths that were among the candidates, and so contributed. */
  readonly contributed: readonly string[];
}

/**
 * Mix the model's distribution over candidates with the precedents' distribution over paths:
 * p' = (1 − λ) p + λ q, with λ = PRECEDENT_WEIGHT × the strongest similarity. Precedent mass
 * on paths that are not candidates is dropped and q re-normalised over the ones that are; when
 * none is, the distribution comes back unchanged with weight 0. A sure model keeps its answer
 * (0.9 against a 0.4 share stays on top); an unsure one (the measured case, hit@1 below one in
 * four) is where the precedent decides.
 */
export function mixWithPrecedents(probabilities: Readonly<Record<string, number>>, pathOf: (key: string) => string | undefined, matched: readonly MatchedPrecedent[], weight = PRECEDENT_WEIGHT): PrecedentMix {
  const q = precedentWeights(matched);
  const byKey = new Map<string, number>();
  let present = 0;
  for (const key of Object.keys(probabilities)) {
    const path = pathOf(key);
    const mass = path === undefined ? undefined : q.get(normalizePath(path));
    if (mass !== undefined && mass > 0) {
      byKey.set(key, mass);
      present += mass;
    }
  }
  if (present === 0 || matched.length === 0) return { probabilities: { ...probabilities }, weight: 0, contributed: [] };
  const strongest = Math.max(...matched.map((m) => m.similarity));
  const lambda = Math.min(1, Math.max(0, weight * Math.min(1, strongest)));
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(probabilities)) {
    out[key] = Math.round(((1 - lambda) * p + lambda * ((byKey.get(key) ?? 0) / present)) * 1e6) / 1e6;
  }
  const contributed = [...byKey.keys()].map((k) => pathOf(k) as string);
  return { probabilities: out, weight: Math.round(lambda * 1000) / 1000, contributed };
}
