/**
 * What a composition has learned: at each of its positions, how learners at each level did after
 * meeting each alternative (fragment-efficacy.ts), side by side, and which one it leans to for
 * them now. For its author, a person or an agent, deciding what to keep, revise or add.
 *
 * ★ THE SAME RULE AS ANY CELL. A cell is shown once it holds EFFICACY_POLICY.publishAt outcomes;
 * below that it says only that there are fewer. So a composition's view is no way around a
 * fragment's.
 *
 * ★ A LEANING IS SHOWN ONLY WHERE NO CELL BEHIND IT IS TOO SMALL TO SHOW. At a level, `leansTo`
 * is chooseByEfficacy over the position's fragments, the rule resolution applies among
 * alternatives pitched alike, with its reason. But which of two alternatives leads can say what
 * a cell of one learner holds, so the leaning is withheld at a level where any alternative has
 * outcomes but fewer than may be shown.
 */
import type { CognitiveLevel } from './emergent-content.js';
import type { Composition } from './compositions.js';
import type { Fragment } from './content-fragments.js';
import { EFFICACY_POLICY, chooseByEfficacy, type EfficacyCounts, type EfficacyView } from './fragment-efficacy.js';

const LEVELS: readonly CognitiveLevel[] = ['foundational', 'working', 'applied', 'advanced'];

/** A cell as it may be shown: its view, or only that it has fewer outcomes than may be shown. */
export type ShownCell = EfficacyView | { level: CognitiveLevel; n: string };

export interface AlternativeEfficacy {
  iri: string;
  kind?: string;
  title?: string;
  /** A composition among the alternatives: its own positions answer at its own IRI. */
  composition?: true;
  cells: ShownCell[];
}

export interface PositionEfficacy {
  position: number;
  competency: string;
  alternatives: AlternativeEfficacy[];
  /** At each level with outcomes: what learners there would be shown among these, and why; or why that is withheld. */
  leansTo: Array<{ level: CognitiveLevel; chosen: string; why: string } | { level: CognitiveLevel; withheld: string }>;
}

export interface CompositionEfficacy {
  composition: string;
  title: string;
  policy: typeof EFFICACY_POLICY;
  positions: PositionEfficacy[];
}

export function compositionEfficacy(comp: Composition, tally: {
  counts: (competency: string, fragment: string, level: CognitiveLevel) => EfficacyCounts | undefined;
  view: (competency: string, fragment: string, level: CognitiveLevel) => EfficacyView | undefined;
}, lookup: (iri: string) => Fragment | Composition | undefined): CompositionEfficacy {
  const positions = comp.positions.map((pos, position): PositionEfficacy => {
    const fragments: string[] = [];
    const alternatives = pos.paradigm.map((iri): AlternativeEfficacy => {
      const item = lookup(iri);
      if (item && Array.isArray((item as Composition).positions)) return { iri, composition: true, title: (item as Composition).title, cells: [] };
      fragments.push(iri);
      const f = item as Fragment | undefined;
      const cells: ShownCell[] = [];
      for (const level of LEVELS) {
        const counts = tally.counts(pos.competency, iri, level);
        if (!counts) continue;
        cells.push(counts.n >= EFFICACY_POLICY.publishAt ? tally.view(pos.competency, iri, level)! : { level, n: `fewer than ${EFFICACY_POLICY.publishAt}` });
      }
      return { iri, ...(f?.kind ? { kind: f.kind } : {}), ...(f?.title ? { title: f.title } : {}), cells };
    });
    // Resolution weighs outcomes only among the alternatives pitched nearest a learner's level, so a
    // leaning at a level is among those alone.
    const levelOf = new Map(fragments.flatMap(iri => { const f = lookup(iri) as Fragment | undefined; return f?.level ? [[iri, f.level] as const] : []; }));
    const leansTo: PositionEfficacy['leansTo'] = [];
    for (const level of LEVELS) {
      const distance = (iri: string): number => Math.abs(LEVELS.indexOf(levelOf.get(iri)!) - LEVELS.indexOf(level));
      const pitched = [...levelOf.keys()];
      const nearest = Math.min(...pitched.map(distance));
      const group = pitched.filter(iri => distance(iri) === nearest);
      const counts = group.map(iri => tally.counts(pos.competency, iri, level));
      if (group.length < 2 || counts.every(c => !c)) continue;
      if (counts.some(c => c && c.n < EFFICACY_POLICY.publishAt)) {
        leansTo.push({ level, withheld: `an alternative has fewer than ${EFFICACY_POLICY.publishAt} outcomes here, so which one leads is not shown yet` });
        continue;
      }
      leansTo.push({ level, ...chooseByEfficacy(group, iri => tally.counts(pos.competency, iri, level)) });
    }
    return { position, competency: pos.competency, alternatives, leansTo };
  });
  return { composition: comp['@id'], title: comp.title, policy: EFFICACY_POLICY, positions };
}
