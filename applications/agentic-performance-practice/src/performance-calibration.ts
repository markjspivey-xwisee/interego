/**
 * Foxxi Performance Calibration — the reflexive loop.
 *
 * The Performance Architecture refuses to assume content is the answer:
 * it contextualizes a situation, reads the regime, and only then picks a
 * method. But that still leaves one assumption standing — that the
 * contextualization was *itself* correct. A Knowable-regime situation
 * labelled a knowledge/skill cause, routed to instruction, might close
 * the gap — or might not, because the real cause was an incentive all
 * along.
 *
 * This module closes the loop on the system's own judgment. Every
 * intervention produces an evaluation verdict (closed / improved /
 * no-change / worsened). Distilled, a verdict is evidence about whether
 * the original contextualization was right. Accumulated across many
 * situations, that evidence becomes a CalibrationProfile: for each
 * (regime × cause × intervention) cell, how often that recommendation
 * actually closed the gap, and — when it did not — what the cause turned
 * out to be on re-contextualization.
 *
 * `calibrate()` then annotates a *fresh* plan with its own track record:
 * "instruction for a knowledge/skill cause has closed 44% of 210
 * comparable situations; in 39% of the misses the cause was
 * re-diagnosed as incentives." The system holds its own advice to the
 * evidentiary standard it holds content to.
 *
 * Composing the substrate:
 *   · Modal status — a cell is Hypothetical until it has enough samples
 *     to Assert a rate; the system never over-claims from thin evidence.
 *   · iep:supersedes — a new profile supersedes the prior one.
 *   · Federation — profiles are unioned across organizations
 *     (`composeCalibrationProfiles`): one org's evidence calibrates
 *     another's. The union is the substrate's composition algebra.
 *   · Aggregate privacy — a cell is an aggregate count, never a record;
 *     `federationView()` withholds cells below a k-anonymity threshold
 *     so nothing crossing an org boundary can re-identify a learner.
 *
 * Layer: L3 vertical. Composes the substrate; no L1/L2/L3 ontology
 * change. Domain terms are `foxxi:`-namespaced (see foxxi-vocab.ts).
 */

import type { WorkRegime } from './agent-disposition.js';
import type {
  Diagnosis, InterventionPlan, InterventionOption, InterventionEvaluation,
  InterventionType, PerformanceMethod,
} from './performance-architecture.js';

// ── The cause keys ──────────────────────────────────────────────────

/** A performance-factor key — the six causes, plus a sentinel for work
 *  whose regime never names a cause (Evident / Emergent / Turbulent). */
export type CauseKey =
  | 'information' | 'instrumentation' | 'incentives'
  | 'knowledgeSkill' | 'capacity' | 'motives'
  | 'not-applicable';

const CAUSE_PREFIX: Array<[RegExp, CauseKey]> = [
  [/^Information/, 'information'],
  [/^Instrumentation/, 'instrumentation'],
  [/^Incentives/, 'incentives'],
  [/^Knowledge & Skill/, 'knowledgeSkill'],
  [/^Capacity/, 'capacity'],
  [/^Motives/, 'motives'],
];

/** Read the dominant cause a diagnosis named, as a stable key. */
export function dominantCause(diagnosis: Pick<Diagnosis, 'rootCauses'>): CauseKey {
  for (const c of diagnosis.rootCauses) {
    for (const [re, key] of CAUSE_PREFIX) if (re.test(c)) return key;
  }
  return 'not-applicable';
}

export const CAUSE_LABEL: Record<CauseKey, string> = {
  information: 'Information',
  instrumentation: 'Instrumentation',
  incentives: 'Incentives',
  knowledgeSkill: 'Knowledge & Skill',
  capacity: 'Capacity',
  motives: 'Motives',
  'not-applicable': 'not a cause-analysed regime',
};

// ── An outcome record ───────────────────────────────────────────────

export type OutcomeVerdict = 'closed' | 'improved' | 'no-change' | 'worsened';

/**
 * One distilled intervention outcome — the evidence atom. It says: in
 * this regime, having named this cause and chosen this intervention,
 * the situation reached this verdict; and, if the intervention did not
 * work and the situation was re-contextualized, what the cause turned
 * out to actually be.
 */
export interface OutcomeRecord {
  regime: WorkRegime;
  method: PerformanceMethod;
  causeFactor: CauseKey;
  intervention: InterventionType;
  verdict: OutcomeVerdict;
  /** If, on re-contextualizing after an ineffective intervention, the
   *  cause turned out to be different — the cause it actually was. This
   *  is the evidence that the original contextualization mis-fired. */
  reDiagnosedCause?: CauseKey;
  /** Where this evidence came from — a pod / org id. */
  source?: string;
}

/**
 * Distil a completed intervention into an outcome record. Returns null
 * for a `too-early` verdict — that is not yet evidence.
 */
export function recordOutcome(
  diagnosis: Diagnosis, plan: InterventionPlan, evaluation: InterventionEvaluation,
  opts: { reDiagnosedCause?: CauseKey; source?: string } = {},
): OutcomeRecord | null {
  if (evaluation.verdict === 'too-early') return null;
  // An unclassified situation produced no regime and no analysed cause —
  // there is nothing to record against a calibration track.
  if (diagnosis.domain === undefined) return null;
  // Only a DERIVED regime accrues to the calibration profile. Caller-framed
  // regimes (asserted / default-gap-intent) are excluded from the reflexive
  // loop — symmetric with calibrate(), so a gap-framed outcome can neither
  // consume nor pollute the calibrated track record.
  if (diagnosis.regimeSource === 'asserted' || diagnosis.regimeSource === 'default-gap-intent') return null;
  return {
    regime: diagnosis.domain,
    method: diagnosis.method,
    causeFactor: dominantCause(diagnosis),
    intervention: plan.selected[0]?.type ?? 'no-intervention',
    verdict: evaluation.verdict,
    ...(opts.reDiagnosedCause ? { reDiagnosedCause: opts.reDiagnosedCause } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  };
}

/**
 * A compact specification of a body of outcomes for one cell — the
 * tallies, rather than a record each. `expandOutcomeCorpus` turns specs
 * into the individual records `buildCalibrationProfile` consumes, so a
 * realistic historical corpus can be expressed without thousands of
 * literal records.
 */
export interface OutcomeSpec {
  regime: WorkRegime;
  method: PerformanceMethod;
  causeFactor: CauseKey;
  intervention: InterventionType;
  closed: number;
  improved: number;
  noChange: number;
  worsened?: number;
  /** Re-contextualized causes among the ineffective outcomes — counts.
   *  Should sum to (noChange + worsened). */
  reDiagnosis?: Partial<Record<CauseKey, number>>;
  source?: string;
}

/** Expand compact outcome specs into the individual records a profile is built from. */
export function expandOutcomeCorpus(specs: readonly OutcomeSpec[]): OutcomeRecord[] {
  const out: OutcomeRecord[] = [];
  for (const s of specs) {
    const base = {
      regime: s.regime, method: s.method, causeFactor: s.causeFactor, intervention: s.intervention,
      ...(s.source ? { source: s.source } : {}),
    };
    for (let i = 0; i < s.closed; i++) out.push({ ...base, verdict: 'closed' });
    for (let i = 0; i < s.improved; i++) out.push({ ...base, verdict: 'improved' });
    // Distribute the re-diagnosis causes across the ineffective outcomes.
    const ineffective: OutcomeVerdict[] = [
      ...Array<OutcomeVerdict>(s.noChange).fill('no-change'),
      ...Array<OutcomeVerdict>(s.worsened ?? 0).fill('worsened'),
    ];
    const reCauses: CauseKey[] = [];
    for (const [cause, n] of Object.entries(s.reDiagnosis ?? {})) {
      for (let i = 0; i < (n ?? 0); i++) reCauses.push(cause as CauseKey);
    }
    ineffective.forEach((verdict, i) => {
      out.push({ ...base, verdict, ...(reCauses[i] ? { reDiagnosedCause: reCauses[i] } : {}) });
    });
  }
  return out;
}

// ── A calibration cell + profile ────────────────────────────────────

/** The track record of one (regime × cause × intervention) recommendation. */
export interface CalibrationCell {
  regime: WorkRegime;
  causeFactor: CauseKey;
  intervention: InterventionType;
  samples: number;
  closed: number;
  improved: number;
  /** no-change + worsened. */
  ineffective: number;
  /** closed / samples. */
  closureRate: number;
  /** (closed + improved) / samples. */
  effectiveRate: number;
  /** Hypothetical until `samples >= assertThreshold` — the system does
   *  not Assert a rate it cannot stand behind. */
  modalStatus: 'Hypothetical' | 'Asserted';
  /** Among the ineffective outcomes, the cause re-contextualization most
   *  often found instead — the system's most informative miss. */
  commonReDiagnosis?: { cause: CauseKey; share: number };
}

export interface CalibrationProfile {
  cells: CalibrationCell[];
  totalSamples: number;
  /** Distinct contributing sources (pods / orgs). */
  sources: number;
  /** A cell needs this many samples before its rate is Asserted. */
  assertThreshold: number;
  /** A cell needs this many samples before it may cross an org boundary
   *  (k-anonymity — a calibration cell is an aggregate, never a record). */
  federationKThreshold: number;
  generatedAt: string;
}

const DEFAULT_ASSERT_THRESHOLD = 12;
const DEFAULT_FEDERATION_K = 8;

const cellKey = (regime: string, cause: string, intervention: string): string =>
  `${regime}|${cause}|${intervention}`;

/**
 * Build a calibration profile from a set of outcome records — group
 * them into (regime × cause × intervention) cells and compute each
 * cell's rates and modal status.
 */
export function buildCalibrationProfile(
  records: readonly OutcomeRecord[],
  opts: { assertThreshold?: number; federationKThreshold?: number; generatedAt?: string } = {},
): CalibrationProfile {
  const assertThreshold = opts.assertThreshold ?? DEFAULT_ASSERT_THRESHOLD;
  const federationKThreshold = opts.federationKThreshold ?? DEFAULT_FEDERATION_K;

  const groups = new Map<string, OutcomeRecord[]>();
  const sources = new Set<string>();
  for (const r of records) {
    const k = cellKey(r.regime, r.causeFactor, r.intervention);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    if (r.source) sources.add(r.source);
  }

  const cells: CalibrationCell[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const samples = group.length;
    const closed = group.filter(r => r.verdict === 'closed').length;
    const improved = group.filter(r => r.verdict === 'improved').length;
    const ineffective = samples - closed - improved;

    // The most informative miss: among ineffective outcomes that were
    // re-contextualized, the cause found most often instead.
    const reDiag = new Map<CauseKey, number>();
    for (const r of group) {
      if ((r.verdict === 'no-change' || r.verdict === 'worsened') && r.reDiagnosedCause) {
        reDiag.set(r.reDiagnosedCause, (reDiag.get(r.reDiagnosedCause) ?? 0) + 1);
      }
    }
    let commonReDiagnosis: CalibrationCell['commonReDiagnosis'];
    if (reDiag.size > 0 && ineffective > 0) {
      const [cause, n] = [...reDiag.entries()].sort((a, b) => b[1] - a[1])[0]!;
      commonReDiagnosis = { cause, share: n / ineffective };
    }

    cells.push({
      regime: first.regime,
      causeFactor: first.causeFactor,
      intervention: first.intervention,
      samples, closed, improved, ineffective,
      closureRate: closed / samples,
      effectiveRate: (closed + improved) / samples,
      modalStatus: samples >= assertThreshold ? 'Asserted' : 'Hypothetical',
      ...(commonReDiagnosis ? { commonReDiagnosis } : {}),
    });
  }
  cells.sort((a, b) => b.samples - a.samples);

  return {
    cells,
    totalSamples: records.length,
    sources: Math.max(sources.size, records.length > 0 ? 1 : 0),
    assertThreshold,
    federationKThreshold,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
  };
}

// ── The calibration note — a plan's own track record ────────────────

export type CalibrationVerdict =
  | 'well-supported'    // an Asserted cell with a strong closure rate
  | 'mixed'            // an Asserted cell with a middling rate
  | 'poorly-supported' // an Asserted cell with a weak closure rate
  | 'tentative'        // a cell exists but is still Hypothetical
  | 'untested';        // no comparable outcomes on record

export interface CalibrationNote {
  /** The cell this plan's primary recommendation maps to, if any. */
  cell?: CalibrationCell;
  verdict: CalibrationVerdict;
  /**
   * Downward causation. When the accumulated profile (the whole) shows a
   * sibling intervention out-performing the one the plan selected for
   * the SAME cause, the better-supported alternative — the whole
   * pressing back on the part. Advisory: the diagnosis is case-specific,
   * the profile is aggregate; the contextualized decision still rules.
   */
  alternative?: { intervention: InterventionType; closureRate: number; samples: number };
  /** Plain-language account a human or agent can act on. */
  message: string;
}

const STRONG_CLOSURE = 0.6;
const WEAK_CLOSURE = 0.45;

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Annotate a fresh plan with its own track record. Looks up the cell
 * for (the diagnosis's regime, the dominant cause, the plan's primary
 * intervention) and reports — honestly — how often that recommendation
 * has actually closed the gap.
 */
export function calibrate(
  diagnosis: Diagnosis, plan: InterventionPlan, profile: CalibrationProfile,
): CalibrationNote {
  // Calibration authority belongs ONLY to a DERIVED regime — one the system
  // read from trajectory signal. Caller-FRAMED regimes carry none: an
  // 'asserted' situation.domain, and a 'default-gap-intent' Knowable reached
  // purely from caller-supplied gap evidence (exemplary / factor evidence),
  // are both excluded from the reflexive loop — symmetric with recordOutcome().
  // Otherwise a caller could gap-frame a situation and have it ride a borrowed
  // calibrated reputation: the gap-first backdoor. (methodology owner: johnny)
  if (diagnosis.regimeSource === 'asserted' || diagnosis.regimeSource === 'default-gap-intent') {
    const how = diagnosis.regimeSource === 'asserted'
      ? 'ASSERTED by the caller'
      : 'reached from caller-supplied gap-intent evidence (exemplary / factor evidence), not read from trajectory signal';
    return {
      verdict: 'untested',
      message: `The ${diagnosis.domain} regime here was ${how}. Only a DERIVED regime (read from trajectory signal) carries calibration authority — caller-framed classifications are excluded from the reflexive loop. Supply trajectories so the regime is read from evidence to earn a calibrated read.`,
    };
  }
  // Calibration tracks cause→intervention recommendations — and only the
  // Knowable regime names a cause. Evident applies a known practice;
  // Emergent and Turbulent never name a cause to be right or wrong about.
  if (diagnosis.method !== 'gap-analysis') {
    return {
      verdict: 'untested',
      message: `Calibration tracks the Knowable regime's cause→intervention recommendations. The `
        + `${diagnosis.domain} regime does not name a cause — there is no cause analysis here to `
        + `hold to its track record.`,
    };
  }
  const cause = dominantCause(diagnosis);
  const intervention = plan.selected[0]?.type ?? 'no-intervention';
  const cell = profile.cells.find(c =>
    c.regime === diagnosis.domain && c.causeFactor === cause && c.intervention === intervention);

  // Downward causation: does a sibling intervention for the SAME cause
  // out-perform the one the plan selected? The accumulated profile (the
  // whole) pressing back on the recommendation (the part).
  const siblings = profile.cells.filter(c =>
    c.regime === diagnosis.domain && c.causeFactor === cause
    && c.intervention !== intervention && c.modalStatus === 'Asserted' && c.samples > 0);
  const best = siblings.sort((a, b) => b.closureRate - a.closureRate)[0];
  const alternative = (best && best.closureRate > (cell?.closureRate ?? 0) + 0.15)
    ? { intervention: best.intervention, closureRate: best.closureRate, samples: best.samples }
    : undefined;
  const altNote = alternative
    ? ` For the same cause, ${alternative.intervention} has closed ${pct(alternative.closureRate)} of `
      + `${alternative.samples} comparable situation(s) — the evidence favours it over ${intervention}.`
    : '';
  const alt = alternative ? { alternative } : {};

  if (!cell) {
    return {
      verdict: 'untested', ...alt,
      message: `No comparable outcomes on record yet: ${intervention} for a ${CAUSE_LABEL[cause]} `
        + `cause in the ${diagnosis.domain} regime is untested.${altNote} Record its outcome so the `
        + `next plan is calibrated.`,
    };
  }

  const reDiag = cell.commonReDiagnosis
    ? ` When it did not close, the cause was re-contextualized as ${CAUSE_LABEL[cell.commonReDiagnosis.cause]} `
      + `in ${pct(cell.commonReDiagnosis.share)} of the misses.`
    : '';
  const base = `${intervention} for a ${CAUSE_LABEL[cause]} cause in the ${diagnosis.domain} regime `
    + `has closed the gap in ${pct(cell.closureRate)} of ${cell.samples} comparable situation(s)`;

  if (cell.modalStatus === 'Hypothetical') {
    return {
      cell, ...alt, verdict: 'tentative',
      message: `${base} — but with only ${cell.samples} on record this rate is Hypothetical, not yet `
        + `enough to Assert.${reDiag}${altNote} Proceed, and record the outcome.`,
    };
  }
  if (cell.closureRate >= STRONG_CLOSURE) {
    return {
      cell, ...alt, verdict: 'well-supported',
      message: `${base}. This recommendation is well-supported by the evidence.${reDiag}${altNote}`,
    };
  }
  if (cell.closureRate < WEAK_CLOSURE) {
    return {
      cell, ...alt, verdict: 'poorly-supported',
      message: `${base} — a weak track record.${reDiag}${altNote} Before committing, re-check the `
        + `cause: the evidence says this recommendation often misses.`,
    };
  }
  return {
    cell, ...alt, verdict: 'mixed',
    message: `${base} — a mixed track record.${reDiag}${altNote} Verify the cause analysis before committing.`,
  };
}

// ── Tier-3: close the calibration loop autonomously ───────────────
//
// `calibrate()` reports an `alternative` when a sibling intervention
// for the SAME cause out-performs the plan's selected intervention by
// ≥15pts (closureRate). Until this helper existed, that signal was
// purely advisory — a CalibrationNote with `alternative` would surface
// the better option but no code automatically applied it. That is the
// single gap between "evidence-driven, human-or-agent-mediated" and
// "full autonomous closure" — and it's the gap this function closes.
//
// Semantics:
//   - When the note carries no `alternative`, return the input plan
//     unchanged. No evidence to re-route on.
//   - When it does, build a new InterventionPlan whose `selected` is
//     a one-element array of the alternative intervention, with the
//     plan's existing paradigm preserved (so the rejected options
//     stay auditable) and the `summary` rewritten to declare the
//     replan as a calibration-driven swap. The OLD selected
//     intervention becomes a ruled-out paradigm entry with
//     ruledOutBecause naming the calibration evidence.
//   - The function is PURE — it does not write outcomes or publish
//     anything. The caller decides whether to record the replan
//     itself as an OutcomeRecord (intervention='instruction',
//     causeFactor='instrumentation', verdict='closed' since the
//     evidence says the alternative closes more often). Recording the
//     replan turns the substrate's self-adaptation into a first-class
//     observation the next calibrate() pass can learn from — a
//     reflexive second-order loop.
export interface CalibrationDrivenReplan {
  /** The plan to act on next. May be byte-identical to the input. */
  plan: InterventionPlan;
  /** True iff the plan changed (alternative was applied). */
  replanned: boolean;
  /** When replanned, the intervention that was swapped out. */
  swappedOut?: InterventionType;
  /** When replanned, the intervention that was swapped in. */
  swappedIn?: InterventionType;
  /** Evidence the swap was made on (alternative.closureRate, samples). */
  evidence?: { closureRate: number; samples: number };
  /** Human-readable account of the decision. */
  reasoning: string;
}

export function calibrationDrivenReplan(
  plan: InterventionPlan,
  note: CalibrationNote,
): CalibrationDrivenReplan {
  if (!note.alternative) {
    return {
      plan,
      replanned: false,
      reasoning:
        'No alternative on record — the calibration profile has no sibling intervention out-performing the '
        + 'current selection by ≥15pts for the same cause. The plan stands.',
    };
  }
  const oldSelected = plan.selected[0];
  // Defensive: if the plan has no current selected intervention, just
  // tack on the alternative as the new one — there's nothing to swap
  // out.
  if (!oldSelected) {
    const newOption: InterventionOption = {
      type: note.alternative.intervention,
      selected: true,
      rationale:
        `Calibration profile evidence: ${note.alternative.intervention} has closed `
        + `${Math.round(note.alternative.closureRate * 100)}% of `
        + `${note.alternative.samples} comparable situations; the plan had no prior selected intervention to re-route from.`,
    };
    return {
      plan: { ...plan, selected: [newOption], paradigm: [...plan.paradigm, newOption], summary: `${plan.summary} | calibration-driven: selected ${note.alternative.intervention}` },
      replanned: true,
      swappedIn: note.alternative.intervention,
      evidence: { closureRate: note.alternative.closureRate, samples: note.alternative.samples },
      reasoning:
        `Plan had no selected intervention; calibration evidence supplied ${note.alternative.intervention} `
        + `(${Math.round(note.alternative.closureRate * 100)}% of ${note.alternative.samples} samples).`,
    };
  }
  // Standard case: swap. The old selected becomes ruled-out with the
  // calibration evidence as the reason; the alternative becomes the
  // sole selected entry.
  const swappedOut = oldSelected.type;
  const swappedIn = note.alternative.intervention;
  const newSelected: InterventionOption = {
    type: swappedIn,
    selected: true,
    rationale:
      `Calibration-driven swap. The accumulated calibration profile (regime × cause × intervention) `
      + `shows ${swappedIn} closing ${Math.round(note.alternative.closureRate * 100)}% of `
      + `${note.alternative.samples} comparable situations — ≥15pts better than the prior selection for the `
      + `same cause. Downward causation: the whole pressing back on the part.`,
  };
  const oldAsRuledOut: InterventionOption = {
    ...oldSelected,
    selected: false,
    ruledOutBecause:
      `Calibration profile evidence — a sibling intervention (${swappedIn}) out-performs by ≥15pts on `
      + `${note.alternative.samples} comparable situations.`,
  };
  // Preserve the paradigm; replace the old selected with its
  // ruled-out form and prepend the new selected so callers iterating
  // `selected` get the calibration choice first.
  const paradigm = plan.paradigm.map(opt =>
    opt.type === swappedOut ? oldAsRuledOut : opt,
  );
  // If the new intervention wasn't in the paradigm yet (it was a
  // sibling cell, not necessarily a paradigm option), add it.
  if (!paradigm.some(opt => opt.type === swappedIn)) {
    paradigm.push(newSelected);
  } else {
    // It IS in the paradigm; mark it selected in-place.
    for (let i = 0; i < paradigm.length; i++) {
      if (paradigm[i]!.type === swappedIn) {
        paradigm[i] = { ...paradigm[i]!, selected: true, ruledOutBecause: undefined };
      }
    }
  }
  return {
    plan: {
      ...plan,
      selected: [newSelected],
      paradigm,
      summary: `${plan.summary} | calibration-driven replan: ${swappedOut} → ${swappedIn}`,
    },
    replanned: true,
    swappedOut,
    swappedIn,
    evidence: { closureRate: note.alternative.closureRate, samples: note.alternative.samples },
    reasoning:
      `Plan re-routed from ${swappedOut} to ${swappedIn} because the calibration profile shows the latter `
      + `closing ${Math.round(note.alternative.closureRate * 100)}% of `
      + `${note.alternative.samples} comparable situations for the same cause — ≥15pts ahead. `
      + `The replan itself should be recorded as an OutcomeRecord so the next calibrate() pass observes the system `
      + `adapting itself (reflexive second-order loop).`,
  };
}

// ── Federation — composing calibration across organizations ─────────

/**
 * Union calibration profiles across organizations. Cells with the same
 * (regime × cause × intervention) key merge — their counts add, their
 * rates and modal status recompute over the combined evidence. This is
 * the substrate's composition algebra: one org's hard-won evidence
 * calibrates another's, and a cell that was Hypothetical for each org
 * alone can become Asserted once their evidence is pooled.
 */
export function composeCalibrationProfiles(
  profiles: readonly CalibrationProfile[],
): CalibrationProfile {
  if (profiles.length === 0) {
    return buildCalibrationProfile([]);
  }
  const assertThreshold = Math.min(...profiles.map(p => p.assertThreshold));
  const federationKThreshold = Math.max(...profiles.map(p => p.federationKThreshold));

  // Re-expand each cell into its verdict tallies and merge.
  interface Tally {
    regime: WorkRegime; causeFactor: CauseKey; intervention: InterventionType;
    closed: number; improved: number; ineffective: number;
    reDiag: Map<CauseKey, number>;
  }
  const merged = new Map<string, Tally>();
  for (const profile of profiles) {
    for (const c of profile.cells) {
      const k = cellKey(c.regime, c.causeFactor, c.intervention);
      let t = merged.get(k);
      if (!t) {
        t = {
          regime: c.regime, causeFactor: c.causeFactor, intervention: c.intervention,
          closed: 0, improved: 0, ineffective: 0, reDiag: new Map(),
        };
        merged.set(k, t);
      }
      t.closed += c.closed;
      t.improved += c.improved;
      t.ineffective += c.ineffective;
      if (c.commonReDiagnosis) {
        // Carry the re-diagnosis as a count over this cell's ineffective set.
        const n = Math.round(c.commonReDiagnosis.share * c.ineffective);
        t.reDiag.set(c.commonReDiagnosis.cause, (t.reDiag.get(c.commonReDiagnosis.cause) ?? 0) + n);
      }
    }
  }

  const cells: CalibrationCell[] = [];
  let totalSamples = 0;
  for (const t of merged.values()) {
    const samples = t.closed + t.improved + t.ineffective;
    totalSamples += samples;
    let commonReDiagnosis: CalibrationCell['commonReDiagnosis'];
    if (t.reDiag.size > 0 && t.ineffective > 0) {
      const [cause, n] = [...t.reDiag.entries()].sort((a, b) => b[1] - a[1])[0]!;
      commonReDiagnosis = { cause, share: Math.min(1, n / t.ineffective) };
    }
    cells.push({
      regime: t.regime, causeFactor: t.causeFactor, intervention: t.intervention,
      samples, closed: t.closed, improved: t.improved, ineffective: t.ineffective,
      closureRate: samples > 0 ? t.closed / samples : 0,
      effectiveRate: samples > 0 ? (t.closed + t.improved) / samples : 0,
      modalStatus: samples >= assertThreshold ? 'Asserted' : 'Hypothetical',
      ...(commonReDiagnosis ? { commonReDiagnosis } : {}),
    });
  }
  cells.sort((a, b) => b.samples - a.samples);

  return {
    cells,
    totalSamples,
    sources: profiles.reduce((n, p) => n + p.sources, 0),
    assertThreshold,
    federationKThreshold,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The view of a profile that may safely cross an org boundary. A
 * calibration cell is already an aggregate, but a cell with very few
 * samples could still narrow toward one learner — so cells below the
 * k-anonymity threshold are withheld. This is the aggregate-privacy
 * discipline applied to calibration evidence.
 */
export function federationView(profile: CalibrationProfile): CalibrationProfile {
  const cells = profile.cells.filter(c => c.samples >= profile.federationKThreshold);
  return {
    ...profile,
    cells,
    totalSamples: cells.reduce((n, c) => n + c.samples, 0),
    generatedAt: new Date().toISOString(),
  };
}

// ── Headline read ───────────────────────────────────────────────────

export interface CalibrationReadout {
  totalSamples: number;
  sources: number;
  /** The intervention with the weakest Asserted closure rate — the
   *  system's most honest finding about its own recommendations. */
  weakest?: { intervention: InterventionType; cause: CauseKey; closureRate: number; samples: number };
  /** The strongest Asserted cell. */
  strongest?: { intervention: InterventionType; cause: CauseKey; closureRate: number; samples: number };
  /** How often, across all cells, instruction was the recommendation. */
  instructionShare: number;
  readout: string;
}

/** A management read of a calibration profile. */
export function calibrationReadout(profile: CalibrationProfile): CalibrationReadout {
  const asserted = profile.cells.filter(c => c.modalStatus === 'Asserted');
  const byClosure = [...asserted].sort((a, b) => a.closureRate - b.closureRate);
  const weakest = byClosure[0];
  const strongest = byClosure[byClosure.length - 1];
  const instructionSamples = profile.cells
    .filter(c => c.intervention === 'instruction')
    .reduce((n, c) => n + c.samples, 0);
  const instructionShare = profile.totalSamples > 0 ? instructionSamples / profile.totalSamples : 0;

  const pick = (c: CalibrationCell | undefined) => c
    ? { intervention: c.intervention, cause: c.causeFactor, closureRate: c.closureRate, samples: c.samples }
    : undefined;

  const readout = asserted.length === 0
    ? `${profile.totalSamples} outcome(s) on record across ${profile.sources} source(s) — not yet `
      + `enough in any cell to Assert a rate.`
    : `${profile.totalSamples} outcome(s) across ${profile.sources} source(s). `
      + (weakest
        ? `Weakest recommendation: ${weakest.intervention} for a ${CAUSE_LABEL[weakest.causeFactor]} `
          + `cause closes only ${pct(weakest.closureRate)} of the time. `
        : '')
      + (strongest && strongest !== weakest
        ? `Strongest: ${strongest.intervention} for ${CAUSE_LABEL[strongest.causeFactor]} at `
          + `${pct(strongest.closureRate)}.`
        : '');

  return {
    totalSamples: profile.totalSamples,
    sources: profile.sources,
    ...(weakest ? { weakest: pick(weakest)! } : {}),
    ...(strongest ? { strongest: pick(strongest)! } : {}),
    instructionShare,
    readout,
  };
}
