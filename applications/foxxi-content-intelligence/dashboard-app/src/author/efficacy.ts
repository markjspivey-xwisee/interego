/**
 * What a composition has learned, as GET <composition>/efficacy answers (src/composition-efficacy.ts),
 * and what the author tools say about it. For its author, a person or an agent, deciding what to
 * keep, revise or add.
 *
 * A cell is shown only once it holds enough outcomes that it cannot be read as one learner's
 * result; below that it says only that there are fewer. A leaning is withheld where a cell behind
 * it is too small to show. The page says what it was given and nothing more.
 */

export type Level = 'foundational' | 'working' | 'applied' | 'advanced';

/** A cell as it may be shown: its counts, or only that there are fewer than may be shown. */
export type ShownCell =
  | { level: Level; n: number; successes: number; lowerBound: number; modalStatus: 'Asserted' | 'Hypothetical'; competency: string; fragment: string }
  | { level: Level; n: string };

export interface AlternativeEfficacy { iri: string; kind?: string; title?: string; composition?: true; cells: ShownCell[] }

export type Leaning = { level: Level; for: 'anyone' | 'human' | 'agent' } & (
  | { chosen: string; why: string }
  | { into: string; otherwise?: string[]; why: string }
  | { withheld: string });

export interface PositionEfficacy { position: number; competency: string; alternatives: AlternativeEfficacy[]; leansTo: Leaning[] }

export interface CompositionEfficacy {
  composition: string;
  title: string;
  policy: { assertAt: number; publishAt: number; z: number; learnersPerCell: number };
  leaningAssumes: string;
  positions: PositionEfficacy[];
}

/** A cell as a person reads it. */
export function cellLine(cell: ShownCell): string {
  if (typeof cell.n === 'string') return `${cell.level}: ${cell.n} outcomes, too few to show`;
  const c = cell as Extract<ShownCell, { lowerBound: number }>;
  const rate = `${c.successes} of ${c.n} went on to succeed`;
  const bound = `at least ${Math.round(c.lowerBound * 100)}%`;
  return `${c.level}: ${rate}, ${bound}${c.modalStatus === 'Asserted' ? '' : ' (still hypothetical)'}`;
}

/** Who a leaning is for, as a person reads it. */
export function forLine(f: Leaning['for']): string {
  return f === 'anyone' ? 'any learner' : f === 'human' ? 'people' : 'agents';
}

/** A leaning as a person reads it, naming alternatives by the titles the view gives them. */
export function leaningLine(l: Leaning, nameOf: (iri: string) => string): string {
  const who = `At ${l.level}, for ${forLine(l.for)}`;
  if ('withheld' in l) return `${who}: not said, ${l.withheld}`;
  if ('into' in l) {
    const otherwise = l.otherwise?.length ? `, otherwise ${l.otherwise.map(nameOf).join(', then ')}` : '';
    return `${who}: goes into ${nameOf(l.into)}${otherwise}. ${l.why}`;
  }
  return `${who}: ${nameOf(l.chosen)}. ${l.why}`;
}

/** Whether anything has been learned here yet: a cell with outcomes, shown or not. */
export function hasOutcomes(view: CompositionEfficacy): boolean {
  return view.positions.some(p => p.alternatives.some(a => a.cells.length > 0));
}
