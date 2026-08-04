/**
 * The TLA+ spec's theorems, evaluated — because nothing had ever evaluated them.
 *
 * ── ★ WHAT WAS WRONG ─────────────────────────────────────────────────────────
 *
 * `spec/proofs/modal-lattice.tla` states four THEOREMs about the modal lattice and about
 * `iep:supersedes`, and closed with "All theorems are TYPED CHECKED by TLA+ syntax". No
 * TLA+ tool has ever been run on that file — not SANY, not TLC, not TLAPS — and two defects
 * were living behind the claim:
 *
 *   ★★ `TC(R)`, the transitive closure, was written
 *        `{ <<a, c>> : a \in Descriptors, c \in Descriptors, b \in Descriptors }`
 *      with no constraint relating a, b or c to R. `b` was bound and never used, which is
 *      the tell: the witness was declared and the condition it was meant to witness was
 *      never written. So TC(R) is the COMPLETE relation for any R, and `SupersedesAcyclic`
 *      — "no d with <<d,d>> in TC(supersedes)" — is FALSE for every non-empty Descriptors,
 *      including at Init where supersedes = {}. THEOREM SupersessionPartialOrder asserted
 *      something the module's own definitions refute.
 *
 *    ★ `DenyOverridesPermit` defined a recursive `fold` inside a bare LET with no
 *      RECURSIVE declaration, which TLA+ does not accept. The module would not have parsed.
 *
 * ── WHY THIS FILE, AND WHY IT IS NOT A TLC SUBSTITUTE ────────────────────────
 *
 * The item this closes was "the modal lattice is never machine-checked", and the reason it
 * stayed open is real: there is no JVM here, and a `tla2tools` workflow written blind and
 * merged unexecuted is the same unverified-formal-content problem in a new place.
 *
 * So this checks the part that does not need a JVM, and it checks it against the thing that
 * matters most: `ModalAlgebra` in `@interego/core` is the RUNTIME implementation of exactly
 * these operations, the domain is three values, and "exhaustive over the whole domain" is
 * therefore not a sampling strategy — it is a proof for this carrier. A law that holds for
 * all 3, 9 or 27 tuples holds, full stop.
 *
 * ★ AND THE REGISTRY IS THE POINT, NOT THE CASES. `THEOREMS` below is cross-checked against
 * the `.tla` file in both directions: a theorem stated in the spec with nothing executing it
 * fails, and a check naming a theorem the spec no longer states fails. That is what stops
 * this file from becoming the next thing that was true when it was written.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModalAlgebra } from '@interego/core';
import type { ModalValue } from '@interego/core';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = resolve(REPO, 'spec/proofs/modal-lattice.tla');
const specText = readFileSync(SPEC, 'utf8');

/**
 * The spec's carrier set. Named in the spec's own CONSTANTS block; the ordering
 * Counterfactual < Hypothetical < Asserted is `Rank` there and `RANK` in derivation.ts.
 */
const MODALS: readonly ModalValue[] = ['Counterfactual', 'Hypothetical', 'Asserted'];

/** Every pair / triple over the carrier. Three values, so this is the whole domain. */
const pairs = MODALS.flatMap(a => MODALS.map(b => [a, b] as const));
const triples = MODALS.flatMap(a => MODALS.flatMap(b => MODALS.map(c => [a, b, c] as const)));

/** Bounded Descriptors, matching the spec's own suggested model size for TC. */
const D = ['d1', 'd2', 'd3'] as const;
type Rel = ReadonlySet<string>;
const pairKey = (a: string, b: string): string => `${a}>${b}`;

/** Every relation on D — 2^9 = 512 of them, so "all relations" is literal here. */
function allRelations(): Rel[] {
  const cells = D.flatMap(a => D.map(b => pairKey(a, b)));
  const out: Rel[] = [];
  for (let mask = 0; mask < (1 << cells.length); mask++) {
    const s = new Set<string>();
    cells.forEach((c, i) => { if (mask & (1 << i)) s.add(c); });
    out.push(s);
  }
  return out;
}

/**
 * The spec's `TC` as CORRECTED: a fixed point over steps that require a witness `b` with
 * <<a,b>> and <<b,c>> both in R.
 */
function tcCorrected(r: Rel): Rel {
  let cur = new Set(r);
  for (;;) {
    const next = new Set(cur);
    for (const a of D) for (const b of D) for (const c of D) {
      if (cur.has(pairKey(a, b)) && cur.has(pairKey(b, c))) next.add(pairKey(a, c));
    }
    if (next.size === cur.size) return cur;
    cur = next;
  }
}

/**
 * The spec's `TC` AS IT WAS: `{ <<a,c>> : a \in D, c \in D, b \in D }` — a set constructor
 * over three bound variables with nothing relating them to R, i.e. the full cartesian
 * product unioned with R. Kept so the defect is pinned rather than described.
 */
function tcAsShipped(r: Rel): Rel {
  const out = new Set(r);
  for (const a of D) for (const c of D) out.add(pairKey(a, c));
  return out;
}

const acyclic = (tc: (r: Rel) => Rel) => (r: Rel): boolean =>
  D.every(d => !tc(r).has(pairKey(d, d)));

/**
 * ★ THE REGISTRY. One entry per THEOREM in the `.tla`, cross-checked against the file
 * itself below. The predicate is the theorem, evaluated over the whole bounded domain.
 */
const THEOREMS: Record<string, () => void> = {
  /** meet is commutative, associative, idempotent — the CRDT laws. */
  ModalLatticeIsCRDT() {
    for (const [a, b] of pairs) {
      expect(ModalAlgebra.meet(a, b), `meet(${a},${b}) != meet(${b},${a})`)
        .toBe(ModalAlgebra.meet(b, a));
    }
    for (const [a, b, c] of triples) {
      expect(ModalAlgebra.meet(ModalAlgebra.meet(a, b), c), `meet assoc at ${a},${b},${c}`)
        .toBe(ModalAlgebra.meet(a, ModalAlgebra.meet(b, c)));
    }
    for (const a of MODALS) expect(ModalAlgebra.meet(a, a)).toBe(a);
  },

  /** Both operations' lattice laws, plus distributivity in both directions. */
  ModalLatticeLaws() {
    for (const [a, b] of pairs) {
      expect(ModalAlgebra.join(a, b)).toBe(ModalAlgebra.join(b, a));
    }
    for (const [a, b, c] of triples) {
      expect(ModalAlgebra.join(ModalAlgebra.join(a, b), c))
        .toBe(ModalAlgebra.join(a, ModalAlgebra.join(b, c)));
      // MeetDistributesOverJoin
      expect(
        ModalAlgebra.meet(a, ModalAlgebra.join(b, c)),
        `meet/join distribution at ${a},${b},${c}`,
      ).toBe(ModalAlgebra.join(ModalAlgebra.meet(a, b), ModalAlgebra.meet(a, c)));
      // JoinDistributesOverMeet
      expect(
        ModalAlgebra.join(a, ModalAlgebra.meet(b, c)),
        `join/meet distribution at ${a},${b},${c}`,
      ).toBe(ModalAlgebra.meet(ModalAlgebra.join(a, b), ModalAlgebra.join(a, c)));
    }
    for (const a of MODALS) expect(ModalAlgebra.join(a, a)).toBe(a);
    // DoubleNegationOnTwoValued, and the intuitionistic exception the spec calls out:
    // Not(Hypothetical) = Hypothetical, so double negation is NOT identity in general.
    expect(ModalAlgebra.not(ModalAlgebra.not('Asserted'))).toBe('Asserted');
    expect(ModalAlgebra.not(ModalAlgebra.not('Counterfactual'))).toBe('Counterfactual');
    expect(ModalAlgebra.not('Hypothetical')).toBe('Hypothetical');
  },

  /**
   * Irreflexive + acyclic under the CORRECTED closure. Evaluated over all 512 relations on
   * three descriptors: the theorem is conditional on the relation being irreflexive and
   * cycle-free, which is what the spec's Init establishes and what SafetyInvariants must
   * preserve — so the check is "irreflexive and acyclic agree", not "every relation is
   * acyclic", which is false and is not what the spec claims.
   */
  SupersessionPartialOrder() {
    const isAcyclic = acyclic(tcCorrected);
    // At Init, supersedes = {}: irreflexive and acyclic, which is the state the shipped TC
    // made impossible.
    expect(isAcyclic(new Set())).toBe(true);
    let sawCyclic = false;
    for (const r of allRelations()) {
      const selfLoop = D.some(d => r.has(pairKey(d, d)));
      if (selfLoop) {
        // A self-loop is a cycle of length one; the closure must see it.
        expect(isAcyclic(r), 'a relation with a self-loop was reported acyclic').toBe(false);
        sawCyclic = true;
        continue;
      }
      // The closure is a superset of the relation and is itself transitive — the two
      // properties `TC` has to have for SupersedesTransitive to mean anything.
      const tc = tcCorrected(r);
      for (const p of r) expect(tc.has(p)).toBe(true);
      for (const a of D) for (const b of D) for (const c of D) {
        if (tc.has(pairKey(a, b)) && tc.has(pairKey(b, c))) {
          expect(tc.has(pairKey(a, c)), `TC not transitive at ${a},${b},${c}`).toBe(true);
        }
      }
      if (!isAcyclic(r)) sawCyclic = true;
    }
    // ★ THE CONTROL. Without it, `isAcyclic` returning `true` unconditionally passes every
    // assertion above that matters, and the theorem is checked by a function that cannot
    // fail. A 2-cycle must be caught.
    expect(sawCyclic, 'no relation in the whole 512 was found cyclic — the closure is inert')
      .toBe(true);
    expect(isAcyclic(new Set([pairKey('d1', 'd2'), pairKey('d2', 'd1')]))).toBe(false);
  },

  /**
   * Deny (Counterfactual) survives any fold order. Over every subset of the carrier, and
   * every permutation of it, because "independent of the iteration order" is the actual
   * claim and a single fold order cannot express it.
   */
  DenyAlwaysWins() {
    const subsets: ModalValue[][] = [];
    for (let mask = 1; mask < 8; mask++) {
      subsets.push(MODALS.filter((_, i) => mask & (1 << i)));
    }
    const permutations = <T>(xs: readonly T[]): T[][] => xs.length <= 1
      ? [[...xs]]
      : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)])
        .map(rest => [x, ...rest]));
    for (const s of subsets) {
      for (const order of permutations(s)) {
        const folded = order.reduce<ModalValue>(
          (acc, m) => ModalAlgebra.meet(acc, m), 'Asserted',
        );
        if (s.includes('Counterfactual')) {
          expect(folded, `deny lost under order ${order.join(',')}`).toBe('Counterfactual');
        } else {
          // The control: without it, a `meet` that always returns Counterfactual passes
          // every assertion above.
          expect(folded, `no deny present, yet the fold denied: ${order.join(',')}`)
            .not.toBe('Counterfactual');
        }
      }
    }
  },
};

describe('spec/proofs/modal-lattice.tla — every theorem it states is evaluated', () => {
  /** `THEOREM Name ==` at the start of a line. */
  const stated = [...specText.matchAll(/^THEOREM\s+([A-Za-z][A-Za-z0-9_]*)\s*==/gm)]
    .map(m => m[1] as string);

  it('★ states at least one theorem this gate can find', () => {
    // A spec whose theorems this regex stops matching is a spec nothing checks, and the
    // two directions below would both pass vacuously.
    expect(stated.length, `no THEOREM matched in ${SPEC}`).toBeGreaterThan(0);
  });

  it('★★ has no theorem without an executable counterpart', () => {
    // The direction that matters: the spec grows a claim, and nothing runs it. That is how
    // SupersessionPartialOrder came to assert something the module's own TC refuted.
    const orphans = stated.filter(t => !(t in THEOREMS));
    expect(orphans, `theorems stated in the .tla with nothing evaluating them: ${orphans.join(', ')}`)
      .toEqual([]);
  });

  it('★ has no executable counterpart for a theorem the spec no longer states', () => {
    // The other direction, so a renamed or deleted theorem cannot leave a check here
    // silently passing about nothing.
    const stale = Object.keys(THEOREMS).filter(t => !stated.includes(t));
    expect(stale, `checks naming theorems absent from the .tla: ${stale.join(', ')}`).toEqual([]);
  });

  for (const [name, check] of Object.entries(THEOREMS)) {
    it(`★ ${name} holds exhaustively over the bounded domain`, check);
  }
});

describe('the two defects that survived because nothing ran', () => {
  it('★★ the shipped TC made SupersedesAcyclic false in the INITIAL state', () => {
    // The defect, pinned as arithmetic rather than described in a comment. `supersedes = {}`
    // is exactly Init; the shipped closure reports a self-loop on every descriptor anyway,
    // so SafetyInvariants was violated before a single step was taken.
    expect(acyclic(tcAsShipped)(new Set())).toBe(false);
    expect(acyclic(tcCorrected)(new Set())).toBe(true);
  });

  it('★ the corrected TC is in the file, with the witness the old one omitted', () => {
    const tc = /RECURSIVE TC\(_\)[\s\S]*?IN IF Step = R THEN R ELSE TC\(Step\)/.exec(specText);
    expect(tc, 'TC is no longer defined where this check looks for it').not.toBeNull();
    expect(tc?.[0], 'TC lost the existential witness again — this is the original defect')
      .toMatch(/\\E\s+b\s+\\in\s+Descriptors\s*:\s*<<a,\s*b>>\s*\\in\s*R/);
  });

  it('★ the LET-recursive Fold is declared RECURSIVE', () => {
    // Without the declaration TLA+ does not accept the definition, so the module could not
    // be parsed — which is why nothing had ever reported the TC defect.
    const deny = /DenyOverridesPermit ==[\s\S]*?IN Fold\(modals\) = Counterfactual/.exec(specText);
    expect(deny, 'DenyOverridesPermit is no longer defined where this check looks').not.toBeNull();
    expect(deny?.[0]).toMatch(/LET RECURSIVE Fold\(_\)/);
  });
});

describe('the spec does not claim a verification that did not happen', () => {
  const README = resolve(REPO, 'spec/proofs/README.md');
  const readmeText = readFileSync(README, 'utf8');

  it('★★ neither file says the theorems are type-checked, because no TLA+ tool has ever parsed them', () => {
    // ★ THE CLAIM THAT HID THE TWO DEFECTS. "All theorems are TYPED CHECKED by TLA+ syntax"
    // sat in the .tla's status block and "TYPE-CHECKED by TLA+ syntax" in the README, and
    // both were false: the module would not parse. A reader who believed either had no
    // reason to look at TC. This fails if the sentence comes back without a tool run behind
    // it — and when TLC really does run, the honest replacement names the tool and the
    // command, which this pattern does not match.
    for (const [file, text] of [[SPEC, specText], [README, readmeText]] as const) {
      // ★ QUOTED SPANS ARE STRIPPED FIRST, and this is not a loophole for convenience — it
      // is the same distinction `tools/docs-drift-lint.mjs` had to make. Both files now
      // QUOTE the false sentence in order to say it was false, and a scan that cannot tell a
      // corrective note from the claim it corrects fails on the correction. The rule is not
      // "never write the words"; it is "never assert them". Restoring the claim in the
      // assertive voice — outside quotes, which is how it was written — fails here.
      const asserted = text.replace(/"[^"]*"/g, '');
      expect(asserted, `${file} claims the spec is type-checked; no TLA+ tool has ever parsed it`)
        .not.toMatch(/(?:TYPED?[- ]CHECKED|type[- ]checked)\s+by\s+TLA\+\s+syntax/i);
    }
  });

  it('★ both files say plainly that nothing has parsed them', () => {
    // The positive half: deleting the false claim is not the same as stating the true one,
    // and a reader who finds neither will assume the usual.
    expect(specText).toMatch(/NO TLA\+ TOOL HAS EVER PARSED IT/);
    expect(readmeText).toMatch(/Nothing, by any TLA\+ tool/);
  });
});
