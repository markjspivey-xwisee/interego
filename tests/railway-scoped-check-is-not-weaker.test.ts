/**
 * The deploy gate is now SCOPED to the service being deployed. This is the test that the
 * scoping did not quietly become an exemption.
 *
 * ── WHAT CHANGED, AND THE RISK IT CARRIES ────────────────────────────────────
 *
 * `.github/workflows/deploy-railway.yml` used to end a SINGLE-service deploy with
 * `railway-pins.mjs --check`, a FLEET-WIDE audit. Measured on 2026-08-09: a `discord`
 * rollout went red because `css` was 46 commits behind, and the step — whose own comment
 * said "★ Expect it to be red whenever master has moved past the tag just deployed" — had
 * been dismissed twice in one session as "the documented always-red step". Underneath
 * that dismissal the relay was three commits of its own bundled code behind master and
 * fifteen services were pinned to images never built at master at all.
 *
 * So the deploy path now runs `tools/railway-deploy-check.ts <service>`, which calls
 * `hasDisagreement([row])` on the ONE row for the service just deployed, and the fleet
 * audit moved to `.github/workflows/railway-fleet-audit.yml` on a schedule.
 *
 * ★ THE RISK. "Ask the same question about less" is one refactor away from "ask a weaker
 * question". Specifically: if `hasDisagreement` ever gains a rule that looks ACROSS rows —
 * two services pinned to different shas, a quorum, a fleet-level count — then the fleet
 * audit would see it and the per-service check never could, and the deploy gate would go
 * green on a fleet that is red. Nothing in either file would look wrong.
 *
 * ── THE PROPERTY THIS PINS ───────────────────────────────────────────────────
 *
 *     hasDisagreement(rows) === rows.some(r => hasDisagreement([r]))
 *
 * The fleet verdict is exactly the disjunction of the per-service verdicts. While that
 * holds, scoping cannot hide anything: a fleet that disagrees has at least one service
 * that disagrees on its own, and that service's own deploy is gated on it. The day
 * somebody adds a cross-row rule, this fails and says why — which is the only warning
 * either file will get.
 */
import { describe, expect, it } from 'vitest';
import { hasDisagreement } from '../tools/railway-pins.mjs';
import type { PinRow } from '../tools/railway-pins.mjs';
import { singletonViolations } from '../tools/railway-services.mjs';

/**
 * A row that agrees on every axis hasDisagreement reads. Spelled out rather than built by
 * a helper with defaults: the point of a control is that it is visibly clean, and a
 * default that drifts turns every "expect false" below into a pass for the wrong reason.
 */
function cleanRow(service: string): PinRow {
  return {
    service,
    serviceId: `id-${service}`,
    image: `ghcr.io/markjspivey-xwisee/interego-${service}:${'a'.repeat(40)}`,
    repo: `ghcr.io/markjspivey-xwisee/interego-${service}`,
    tag: 'a'.repeat(40),
    tagKind: 'sha',
    agreement: 'ok',
    freshness: 'current',
    behind: 0,
    deployAgreement: 'ok',
    limitVerdict: 'none',
    // css is the fleet's declared singleton, so a row for it must carry compliant
    // settings or it is dirty for a reason this test is not about.
    numReplicas: service === 'css' ? 1 : null,
    overlapSeconds: service === 'css' ? 0 : null,
    drainingSeconds: null,
  };
}

/** Every way a single row is allowed to be wrong, one per axis hasDisagreement reads. */
const DIRTY: Record<string, Partial<PinRow>> = {
  'repo MISMATCH': { agreement: 'MISMATCH' },
  'service MISSING from Railway': { agreement: 'MISSING' },
  'service UNTRACKED by the repo': { agreement: 'UNTRACKED' },
  'row ERROR': { agreement: 'ERROR' },
  'pin BEHIND master': { freshness: 'BEHIND', behind: 46 },
  'pin DIVERGED from master': { freshness: 'DIVERGED' },
  'pin is an UNKNOWN-COMMIT': { freshness: 'UNKNOWN-COMMIT' },
  'pin written but never shipped': { deployAgreement: 'STALE-DEPLOY' },
  'deploy axis UNVERIFIED': { deployAgreement: 'UNVERIFIED' },
  'cap BELOW-FLOOR': { limitVerdict: 'BELOW-FLOOR' },
  'floor UNKNOWN': { limitVerdict: 'UNKNOWN-FLOOR' },
  'limits UNPARSED': { limitVerdict: 'UNPARSED' },
  'limits ERROR': { limitVerdict: 'ERROR' },
};

describe('the scoped deploy check is the fleet check, restricted — not a weaker one', () => {
  it('agrees with itself on a wholly clean fleet (the control)', () => {
    const rows = ['relay', 'css', 'discord'].map(cleanRow);
    expect(hasDisagreement(rows)).toBe(false);
    for (const r of rows) expect(hasDisagreement([r])).toBe(false);
  });

  // ★ THE LOAD-BEARING ONE. Every axis, checked in isolation, must be visible to a
  // one-row call. An axis that only fires with company would be invisible to the deploy
  // gate for the service that actually has it.
  it.each(Object.entries(DIRTY))('%s makes BOTH the fleet and that one service red', (_name, patch) => {
    const dirty: PinRow = { ...cleanRow('relay'), ...patch };
    const fleet = [dirty, cleanRow('discord'), cleanRow('css')];

    expect(hasDisagreement([dirty])).toBe(true);
    expect(hasDisagreement(fleet)).toBe(true);
    // …and the CLEAN neighbours stay green, which is the whole reason for scoping: a
    // discord rollout must not fail because relay is wrong.
    expect(hasDisagreement([cleanRow('discord')])).toBe(false);
  });

  it('the singleton invariant is visible one row at a time', () => {
    // Unset numReplicas on the declared singleton. This axis lives in
    // singletonViolations() rather than in the row's own fields, so it is the one most
    // likely to have needed the whole fleet to be present.
    const css: PinRow = { ...cleanRow('css'), numReplicas: null, overlapSeconds: null };
    expect(singletonViolations([css]).length).toBeGreaterThan(0);
    expect(hasDisagreement([css])).toBe(true);
    expect(hasDisagreement([css, cleanRow('relay')])).toBe(true);
    // A non-singleton service with the same unset settings is NOT a violation — proving
    // the rule keys on the declaration, not on the value being null.
    expect(hasDisagreement([{ ...cleanRow('relay'), numReplicas: null }])).toBe(false);
  });

  /**
   * ★ THE INVARIANT ITSELF, over a power set rather than a hand-picked case or two. Every
   * subset of a mixed fleet must satisfy the disjunction law. A cross-row rule added to
   * hasDisagreement — "these two disagree with EACH OTHER" — passes a single-row test and
   * a whole-fleet test and fails here, because it needs two rows present to fire and the
   * law demands one of them fire alone.
   */
  it('fleet verdict === OR of the per-service verdicts, for every subset', () => {
    const universe: PinRow[] = [
      cleanRow('relay'),
      { ...cleanRow('discord'), freshness: 'BEHIND', behind: 3 },
      cleanRow('css'),
      { ...cleanRow('identity'), deployAgreement: 'STALE-DEPLOY' },
      { ...cleanRow('bridge'), limitVerdict: 'BELOW-FLOOR' },
      { ...cleanRow('css-gate'), agreement: 'MISMATCH' },
    ];

    let checked = 0;
    for (let mask = 0; mask < (1 << universe.length); mask++) {
      const subset = universe.filter((_, i) => (mask & (1 << i)) !== 0);
      const fleetVerdict = hasDisagreement(subset);
      const orOfEach = subset.some((r) => hasDisagreement([r]));
      expect(
        fleetVerdict,
        `subset [${subset.map((r) => r.service).join(', ')}]: fleet says ${fleetVerdict}, `
        + `OR-of-each says ${orOfEach}. A cross-row rule was added to hasDisagreement, so the `
        + `SCOPED deploy gate (tools/railway-deploy-check.ts) can no longer see everything the `
        + `fleet audit sees. Either make the new rule row-local, or stop scoping the gate.`,
      ).toBe(orOfEach);
      checked++;
    }
    expect(checked).toBe(64);
  });

  it('an empty fleet is not a pass by accident', () => {
    // collectPins synthesises a MISSING row for every tracked service Railway omits, so
    // an empty array should be unreachable — but hasDisagreement([]) is false, and a
    // scoped caller that failed to find its row must not fall into that. That is why
    // railway-deploy-check.ts exits 1 on a missing row instead of calling the predicate.
    expect(hasDisagreement([])).toBe(false);
  });
});
