// Calibration profile reader + the Tier-3 replan helper for the demo.
//
// The substrate's calibrate() function returns a CalibrationNote that
// names a better-performing sibling intervention when one exists
// (closureRate ≥15pts ahead, same regime × cause). Until rev 195,
// that signal was advisory; calibrationDrivenReplan turns it into an
// autonomous re-route. This module wraps both for the demo controller.

import { readCalibrationProfile } from './tools.mjs';

/**
 * Read the live calibration profile (per-tenant + federated).
 * Returns a small slice useful for the controller's replan logic.
 */
export async function snapshotCalibration() {
  const j = await readCalibrationProfile();
  // The bridge wraps everything in a JSON-LD envelope; the actual
  // profile is at j.body.profile OR j.profile depending on version.
  const profile = j?.body?.profile ?? j?.profile ?? j;
  return {
    cells: Array.isArray(profile?.cells) ? profile.cells : (Array.isArray(profile?.tenant?.cells) ? profile.tenant.cells : []),
    totalSamples: profile?.totalSamples ?? profile?.tenant?.totalSamples ?? 0,
    raw: profile,
  };
}

/**
 * Look up the cell relevant to this plan: (regime, cause, intervention).
 * Returns null when there's no matching cell yet — i.e. untested.
 */
export function findCell(snapshot, { regime, cause, intervention }) {
  return snapshot.cells.find(c =>
    c.regime === regime
    && c.causeFactor === cause
    && c.intervention === intervention,
  ) ?? null;
}

/**
 * The Tier-3 replan, applied to a plain JS plan object (not Foxxi's
 * full InterventionPlan type — the demo doesn't need every field).
 *
 * If a sibling intervention has out-performed the current selection
 * by ≥15pts in an Asserted cell, returns a NEW plan with the
 * alternative swapped in and `replanned: true`. Otherwise returns the
 * input plan unchanged with `replanned: false`.
 */
export function calibrationDrivenReplan({ plan, snapshot }) {
  if (!plan?.selectedIntervention || !plan?.regime || !plan?.cause) {
    return { plan, replanned: false, reasoning: 'plan missing fields' };
  }
  // Siblings: same regime × cause, different intervention, Asserted, samples > 0.
  const siblings = snapshot.cells.filter(c =>
    c.regime === plan.regime
    && c.causeFactor === plan.cause
    && c.intervention !== plan.selectedIntervention
    && c.modalStatus === 'Asserted'
    && c.samples > 0,
  );
  const best = siblings.sort((a, b) => b.closureRate - a.closureRate)[0];
  const current = findCell(snapshot, { regime: plan.regime, cause: plan.cause, intervention: plan.selectedIntervention });
  const currentRate = current?.closureRate ?? 0;
  if (!best || best.closureRate <= currentRate + 0.15) {
    return {
      plan,
      replanned: false,
      reasoning:
        `No alternative ≥15pts ahead — current ${plan.selectedIntervention} has `
        + `${Math.round(currentRate * 100)}% over ${current?.samples ?? 0} samples; `
        + `best sibling ${best ? `${best.intervention} at ${Math.round(best.closureRate * 100)}%` : '<none>'}. Plan stands.`,
    };
  }
  return {
    plan: {
      ...plan,
      selectedIntervention: best.intervention,
      replacedIntervention: plan.selectedIntervention,
      replanEvidence: { closureRate: best.closureRate, samples: best.samples },
    },
    replanned: true,
    swappedOut: plan.selectedIntervention,
    swappedIn: best.intervention,
    evidence: { closureRate: best.closureRate, samples: best.samples },
    reasoning:
      `Replan: ${plan.selectedIntervention} → ${best.intervention}. `
      + `Sibling closes ${Math.round(best.closureRate * 100)}% on ${best.samples} samples — `
      + `≥15pts ahead of current. Downward causation: the whole pressing on the part.`,
  };
}
