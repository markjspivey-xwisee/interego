/**
 * @module crypto/dp-accountant
 * @description Cumulative differential-privacy accountants — tighter
 * bounds than the naive sequential ε-summation that `EpsilonBudget`
 * uses today.
 *
 * **The problem.** Under basic sequential composition, running k
 * mechanisms each ε-DP gives the joint mechanism k·ε-DP. This is
 * tight in the worst case but pessimistic in most practical cases:
 * running many small-ε queries quickly exhausts a per-cohort cap
 * even though the actual cumulative privacy loss is much smaller.
 *
 * **The fix.** The DP literature has tighter accountants. This
 * module ships two that compose cleanly with the existing
 * substrate's per-query ε reporting:
 *
 *   1. **Advanced composition** (Dwork-Rothblum-Vadhan 2010).
 *      Under k-fold composition of ε-DP mechanisms applied to the
 *      same dataset, the joint mechanism is (ε', δ)-DP with:
 *
 *        ε' = √(2 k ln(1/δ)) · ε + k · ε · (e^ε − 1)
 *
 *      For small ε this is roughly ε' ≈ √k · ε rather than k · ε.
 *      Substantial savings when k is large.
 *
 *   2. **Rényi DP / RDP** (Mironov 2017). Track privacy as Rényi
 *      divergence at order α; composition is additive on the Rényi
 *      parameter; convert to (ε, δ)-DP at end-of-session. Tighter
 *      than advanced composition in most regimes and the standard
 *      for modern DP accounting.
 *
 *      For the Laplace mechanism with parameter b (so sensitivity-Δ
 *      → ε = Δ/b under pure DP), Mironov 2017 gives an RDP bound:
 *        ρ_α ≤ (1 / (α − 1)) · log( α / (2α − 1) · e^{(α − 1) ε}
 *                                  + (α − 1) / (2α − 1) · e^{−α ε} )
 *      for α > 1. We implement this directly.
 *
 *      The conversion (α, ρ_α)-RDP → (ε, δ)-DP is:
 *        ε = ρ_α + log(1/δ) / (α − 1)
 *      The auditor picks the α that minimizes this for a target δ.
 *
 * **How this composes with the rest of the substrate.** Both
 * accountants implement a tracker interface compatible with the
 * existing `EpsilonBudget.consume(...)` signature. The existing
 * aggregate primitives (`buildAttestedHomomorphicSum`,
 * `buildAttestedHomomorphicDistribution`, `buildAttestedHomomorphicSumV5`,
 * `buildAttestedHomomorphicSumV6`) accept an `epsilonBudget?:
 * EpsilonBudget` slot today; that slot is widened in a follow-up
 * to accept any `PrivacyAccountant`. Until that wiring lands, these
 * accountants are usable directly by the caller (compute the
 * tighter ε' at end of a query session; verify against the cohort
 * cap).
 *
 * No new crypto primitives, no new ontology terms. Substrate-pure
 * math layer.
 */

// ─────────────────────────────────────────────────────────────────────
//  Common interface
// ─────────────────────────────────────────────────────────────────────

export interface PrivacyConsumption {
  readonly queryDescription: string;
  readonly epsilon: number;
  readonly consumedAt: string;
}

/**
 * Shared interface across the substrate's privacy accountants. The
 * existing `EpsilonBudget` already conforms to this surface; the new
 * accountants below match.
 */
export interface PrivacyAccountant {
  consume(args: { queryDescription: string; epsilon: number }): void;
  /** Whether a hypothetical query of this ε would fit under the cap. */
  canAfford(epsilon: number): boolean;
  /** Cumulative ε spent so far, in whatever metric the accountant uses. */
  readonly spent: number;
  /** Maximum permitted cumulative ε under the accountant's metric. */
  readonly maxEpsilon: number;
  /** Consumption log, oldest first. */
  readonly log: readonly PrivacyConsumption[];
}

// ─────────────────────────────────────────────────────────────────────
//  AdvancedCompositionAccountant
// ─────────────────────────────────────────────────────────────────────

/**
 * Advanced composition (Dwork-Rothblum-Vadhan 2010). Tracks the
 * naive sum of per-query ε's; on demand, computes the tightened
 * ε' under k-fold composition at a chosen δ.
 *
 * Mathematical form: for k queries each ε_i-DP and a target failure
 * probability δ, the joint mechanism is (ε', δ)-DP with
 *
 *   ε' = √(2 k ln(1/δ)) · ε_max + k · ε_max · (e^{ε_max} − 1)
 *
 * where ε_max = max ε_i. For uniform-ε queries this is the standard
 * formula; for heterogeneous ε's it's a conservative upper bound
 * (the literature has tighter heterogeneous formulas but the
 * uniform-ε max form is the standard one to ship first).
 *
 * The accountant rejects a query if its naive ε would push the
 * cumulative-naive sum past `maxNaiveEpsilon`. The TIGHTENED ε' is
 * computed via `tightenedEpsilon(delta)` and compared against the
 * caller's target (ε', δ)-DP guarantee.
 */
export class AdvancedCompositionAccountant implements PrivacyAccountant {
  readonly maxEpsilon: number;
  private _spent = 0;
  private _maxPerQuery = 0;
  private _queryCount = 0;
  private _log: PrivacyConsumption[] = [];

  constructor(args: { maxNaiveEpsilon: number }) {
    if (!(args.maxNaiveEpsilon > 0)) throw new Error('AdvancedCompositionAccountant: maxNaiveEpsilon must be > 0');
    this.maxEpsilon = args.maxNaiveEpsilon;
  }

  get spent(): number { return this._spent; }
  get log(): readonly PrivacyConsumption[] { return this._log; }
  get queryCount(): number { return this._queryCount; }
  get maxPerQuery(): number { return this._maxPerQuery; }

  consume(args: { queryDescription: string; epsilon: number }): void {
    if (!(args.epsilon > 0)) throw new Error('AdvancedCompositionAccountant.consume: epsilon must be > 0');
    if (this._spent + args.epsilon > this.maxEpsilon) {
      throw new Error(`AdvancedCompositionAccountant: query "${args.queryDescription}" with ε=${args.epsilon} would push cumulative naive-ε to ${this._spent + args.epsilon} (cap ${this.maxEpsilon}). Aborting.`);
    }
    this._spent += args.epsilon;
    this._queryCount += 1;
    if (args.epsilon > this._maxPerQuery) this._maxPerQuery = args.epsilon;
    this._log.push({
      queryDescription: args.queryDescription,
      epsilon: args.epsilon,
      consumedAt: new Date().toISOString(),
    });
  }

  canAfford(epsilon: number): boolean {
    return epsilon > 0 && this._spent + epsilon <= this.maxEpsilon;
  }

  /**
   * The Dwork-Rothblum-Vadhan tightened ε' at this δ, assuming each
   * past query used ε_max = max past per-query ε. Conservative upper
   * bound for heterogeneous ε's. Returns 0 if no queries have run yet.
   */
  tightenedEpsilon(delta: number): number {
    if (!(delta > 0 && delta < 1)) throw new Error('AdvancedCompositionAccountant.tightenedEpsilon: delta must be in (0, 1)');
    if (this._queryCount === 0) return 0;
    const k = this._queryCount;
    const eps = this._maxPerQuery;
    const term1 = Math.sqrt(2 * k * Math.log(1 / delta)) * eps;
    const term2 = k * eps * (Math.exp(eps) - 1);
    return term1 + term2;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  RenyiAccountant
// ─────────────────────────────────────────────────────────────────────

/**
 * Rényi-DP accountant (Mironov 2017). Tracks the cumulative Rényi
 * divergence at a fixed order α; converts to (ε, δ)-DP at end of
 * session via `convertToEpsilonDelta(delta)`.
 *
 * For an ε-DP mechanism (e.g., Laplace), the Rényi divergence at
 * order α is bounded by:
 *   ρ_α ≤ (1/(α−1)) · log( α/(2α−1) · e^{(α−1)ε} + (α−1)/(2α−1) · e^{−α ε} )
 *
 * Conversion: (α, Σρ_α)-RDP → (ε, δ)-DP with
 *   ε = Σρ_α + log(1/δ) / (α − 1)
 *
 * The caller picks α (typical choices: 2, 4, 8, 16, 32, 64); the
 * conversion's ε depends on α + δ, and tighter α's give tighter ε's
 * for some δ ranges. Sweep over α offline if needed.
 *
 * For the substrate's Laplace-mechanism queries (each ε-DP at the
 * declared per-query ε), the consume() arithmetic uses the bound
 * above.
 */
export class RenyiAccountant implements PrivacyAccountant {
  readonly alpha: number;
  /** Maximum cumulative Rényi divergence at this α the caller will allow. */
  readonly maxRho: number;
  private _spentRho = 0;
  private _spentNaive = 0;
  private _log: PrivacyConsumption[] = [];

  constructor(args: { alpha: number; maxRho: number }) {
    if (!(args.alpha > 1)) throw new Error('RenyiAccountant: alpha must be > 1');
    if (!(args.maxRho > 0)) throw new Error('RenyiAccountant: maxRho must be > 0');
    this.alpha = args.alpha;
    this.maxRho = args.maxRho;
  }

  /** Returns the cumulative ε (naive sum) — kept for the PrivacyAccountant interface. */
  get spent(): number { return this._spentNaive; }
  get spentRho(): number { return this._spentRho; }
  get maxEpsilon(): number {
    // Best-case ε estimate (δ=1e-6); the canonical conversion via
    // convertToEpsilonDelta is the real audit number.
    return this._spentRho + Math.log(1 / 1e-6) / (this.alpha - 1);
  }
  get log(): readonly PrivacyConsumption[] { return this._log; }

  /**
   * Compute the Rényi divergence at order α for an ε-DP mechanism.
   * Bound from Mironov 2017 §3 for pure DP.
   */
  static rhoForEpsilonDP(alpha: number, epsilon: number): number {
    const a1 = alpha - 1;
    const e1 = Math.exp(a1 * epsilon);
    const e2 = Math.exp(-alpha * epsilon);
    const w1 = alpha / (2 * alpha - 1);
    const w2 = a1 / (2 * alpha - 1);
    return (1 / a1) * Math.log(w1 * e1 + w2 * e2);
  }

  consume(args: { queryDescription: string; epsilon: number }): void {
    if (!(args.epsilon > 0)) throw new Error('RenyiAccountant.consume: epsilon must be > 0');
    const rho = RenyiAccountant.rhoForEpsilonDP(this.alpha, args.epsilon);
    if (this._spentRho + rho > this.maxRho) {
      throw new Error(`RenyiAccountant: query "${args.queryDescription}" at ε=${args.epsilon} adds ρ_${this.alpha}=${rho.toFixed(6)}, pushing cumulative ρ to ${(this._spentRho + rho).toFixed(6)} (cap ${this.maxRho}). Aborting.`);
    }
    this._spentRho += rho;
    this._spentNaive += args.epsilon;
    this._log.push({
      queryDescription: args.queryDescription,
      epsilon: args.epsilon,
      consumedAt: new Date().toISOString(),
    });
  }

  canAfford(epsilon: number): boolean {
    if (!(epsilon > 0)) return false;
    return this._spentRho + RenyiAccountant.rhoForEpsilonDP(this.alpha, epsilon) <= this.maxRho;
  }

  /**
   * Convert the cumulative Rényi-DP to (ε, δ)-DP at this δ. Use this
   * at session close-out: confirm ε is below the operator's declared
   * (ε, δ) target before publishing the audit-log.
   */
  convertToEpsilonDelta(delta: number): { epsilon: number; delta: number } {
    if (!(delta > 0 && delta < 1)) throw new Error('RenyiAccountant.convertToEpsilonDelta: delta must be in (0, 1)');
    const epsilon = this._spentRho + Math.log(1 / delta) / (this.alpha - 1);
    return { epsilon, delta };
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Helper: sweep α to find the tightest (ε, δ) conversion
// ─────────────────────────────────────────────────────────────────────

/**
 * Run k separate Rényi accountants in parallel at common α values,
 * consume each query in all of them, then pick the α that gives the
 * tightest ε at the target δ. Returns the best (ε, alpha) pair plus
 * the accountant snapshots for transparency.
 *
 * Useful when the caller doesn't want to pick α a priori — the
 * tightest ε for a given query mix + δ varies with α and is best
 * found empirically.
 *
 * Default α grid: [2, 4, 8, 16, 32, 64] — covers the typical range.
 */
export function sweepRenyiBestEpsilon(args: {
  perQueryEpsilons: readonly number[];
  delta: number;
  alphas?: readonly number[];
}): { bestEpsilon: number; bestAlpha: number; bestRho: number; sweep: { alpha: number; rho: number; epsilon: number }[] } {
  if (!(args.delta > 0 && args.delta < 1)) throw new Error('sweepRenyiBestEpsilon: delta must be in (0, 1)');
  const alphas = args.alphas ?? [2, 4, 8, 16, 32, 64];
  const sweep: { alpha: number; rho: number; epsilon: number }[] = [];
  for (const alpha of alphas) {
    let rho = 0;
    for (const eps of args.perQueryEpsilons) {
      rho += RenyiAccountant.rhoForEpsilonDP(alpha, eps);
    }
    const epsilon = rho + Math.log(1 / args.delta) / (alpha - 1);
    sweep.push({ alpha, rho, epsilon });
  }
  let best = sweep[0]!;
  for (const s of sweep) if (s.epsilon < best.epsilon) best = s;
  return { bestEpsilon: best.epsilon, bestAlpha: best.alpha, bestRho: best.rho, sweep };
}
