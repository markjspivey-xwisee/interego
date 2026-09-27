/**
 * What a composition has learned: at each of its positions, how learners at each level did after
 * meeting each alternative (fragment-efficacy.ts), side by side, and which one it leans to for
 * them now. For its author, a person or an agent, deciding what to keep, revise or add.
 *
 * ★ THE SAME RULE AS ANY CELL. A cell is shown once it holds EFFICACY_POLICY.publishAt outcomes;
 * below that it says only that there are fewer. So a composition's view is no way around a
 * fragment's.
 *
 * ★ A LEANING IS RESOLUTION'S OWN CHOICE, AS FAR AS IT CAN BE MADE WITHOUT A LEARNER. At a level,
 * the alternatives are ranked as resolution ranks them: those meant for the learner, pitched
 * nearest their level, then in the author's order, a composition counting as pitched anywhere. A
 * composition that comes first is gone into, when it resolves; where it does not, the alternatives
 * after it are tried in rank order up to the first fragment, a composition taken when it resolves
 * and that fragment always (`otherwise`). Outcomes decide nothing at such a level, and the leaning
 * says so (`into`). Otherwise outcomes decide among the fragments pitched alike
 * (chooseByEfficacy), and the leaning is that choice, with its reason. Where alternatives are
 * meant for one kind of learner, a leaning is given for people and for agents apart. What a
 * learner keeps, or a plan implies, can narrow the forms further; no leaning assumes one.
 *
 * ★ A LEANING IS SHOWN ONLY WHERE NO CELL BEHIND IT IS TOO SMALL TO SHOW. Which of two
 * alternatives leads can say what a cell of one learner holds, so the leaning is withheld where any
 * alternative weighed has outcomes but fewer than may be shown.
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

/** Which learners a leaning is for: anyone, where no alternative here is meant for one kind only. */
export type LeaningFor = 'anyone' | 'human' | 'agent';

export type Leaning = { level: CognitiveLevel; for: LeaningFor } & (
  | { chosen: string; why: string }
  | { into: string; otherwise?: string[]; why: string }
  | { withheld: string });

export interface PositionEfficacy {
  position: number;
  competency: string;
  alternatives: AlternativeEfficacy[];
  /** At each level with outcomes: what learners there would be shown, and why; or why that is not said. */
  leansTo: Leaning[];
}

export interface CompositionEfficacy {
  composition: string;
  title: string;
  policy: typeof EFFICACY_POLICY;
  /** What every leaning assumes. */
  leaningAssumes: string;
  positions: PositionEfficacy[];
}

const isComposition = (x: Fragment | Composition): x is Composition => Array.isArray((x as Composition).positions);

export function compositionEfficacy(comp: Composition, tally: {
  counts: (competency: string, fragment: string, level: CognitiveLevel) => EfficacyCounts | undefined;
  view: (competency: string, fragment: string, level: CognitiveLevel) => EfficacyView | undefined;
}, lookup: (iri: string) => Fragment | Composition | undefined): CompositionEfficacy {
  const positions = comp.positions.map((pos, position): PositionEfficacy => {
    const alternatives = pos.paradigm.map((iri): AlternativeEfficacy => {
      const item = lookup(iri);
      if (item && isComposition(item)) return { iri, composition: true, title: item.title, cells: [] };
      const cells: ShownCell[] = [];
      for (const level of LEVELS) {
        const counts = tally.counts(pos.competency, iri, level);
        if (!counts) continue;
        cells.push(counts.n >= EFFICACY_POLICY.publishAt ? tally.view(pos.competency, iri, level)! : { level, n: `fewer than ${EFFICACY_POLICY.publishAt}` });
      }
      return { iri, ...(item?.kind ? { kind: item.kind } : {}), ...(item?.title ? { title: item.title } : {}), cells };
    });

    const items = pos.paradigm.flatMap((iri, k) => { const item = lookup(iri); return item ? [{ iri, k, item }] : []; });
    const audiences: LeaningFor[] = items.some(x => !isComposition(x.item) && x.item.audience) ? ['human', 'agent'] : ['anyone'];
    const leansTo: Leaning[] = [];
    for (const level of LEVELS) {
      for (const who of audiences) {
        // Ranked as resolution ranks them for a learner of this kind at this level.
        const eligible = items.filter(x => isComposition(x.item) || who === 'anyone' || !x.item.audience || x.item.audience === who);
        const distance = (x: (typeof items)[number]): number => (isComposition(x.item) ? 0 : Math.abs(LEVELS.indexOf(x.item.level) - LEVELS.indexOf(level)));
        const ranked = [...eligible].sort((a, b) => distance(a) - distance(b) || a.k - b.k);
        const heard = (x: (typeof items)[number]): boolean => !isComposition(x.item) && !!tally.counts(pos.competency, x.iri, level);
        const lead = ranked[0];
        if (!lead || !ranked.some(heard)) continue;
        if (isComposition(lead.item)) {
          // Resolution weighs no outcomes when a composition leads. It tries the alternatives in rank
          // order: a composition is taken when it resolves, and the first fragment always, so the ones
          // after the lead are tried up to that fragment, in that order.
          const firstFragment = ranked.findIndex(x => !isComposition(x.item));
          const otherwise = ranked.slice(1, firstFragment < 0 ? undefined : firstFragment + 1).map(x => x.iri);
          leansTo.push({
            level, for: who, into: lead.iri, ...(otherwise.length ? { otherwise } : {}),
            why: `"${lead.item.title}" comes first here: learners at this level go into it when it resolves for them, and otherwise the alternatives after it are tried in this order, a composition taken when it resolves and the first fragment always, so outcomes decide nothing at this level`,
          });
          continue;
        }
        const group = ranked.filter(x => !isComposition(x.item) && distance(x) === distance(lead)).map(x => x.iri);
        const counts = group.map(iri => tally.counts(pos.competency, iri, level));
        if (group.length < 2 || counts.every(c => !c)) continue;
        if (counts.some(c => c && c.n < EFFICACY_POLICY.publishAt)) {
          leansTo.push({ level, for: who, withheld: `an alternative has fewer than ${EFFICACY_POLICY.publishAt} outcomes here, so which one leads is not shown yet` });
          continue;
        }
        leansTo.push({ level, for: who, ...chooseByEfficacy(group, iri => tally.counts(pos.competency, iri, level)) });
      }
    }
    return { position, competency: pos.competency, alternatives, leansTo };
  });
  return {
    composition: comp['@id'], title: comp.title, policy: EFFICACY_POLICY,
    leaningAssumes: 'no admission narrowing the forms at a position: one a learner keeps, or a plan implies, can narrow what they are shown',
    positions,
  };
}
