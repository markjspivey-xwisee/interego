/**
 * buildConceptNavGraph — the pure half of foxxi.explore_concept_map.
 *
 * ★ WHY THIS FILE EXISTS. foxxi.explore_concept_map answered EVERY call with
 * { concepts: [], edges: [] }. A consumer reads that as "this course has no concept
 * map", which is a different and wrong answer from "this endpoint does nothing".
 * The fix must not reintroduce the same shape one layer down, so the case a
 * reviewer must be able to find here is case 4: an unknown focus_concept_id
 * returns { error }, NEVER an empty graph.
 *
 * No test double anywhere. The handler's only real dependency is a live pod fetch
 * (autoFetchCourse), and a double for it would replace the very thing under test —
 * so the traversal is exercised against a real FoxxiAgenticPayload literal, and the
 * handler side is pinned separately in declared-but-unimplemented.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { buildConceptNavGraph, type ConceptNavGraph } from '../src/course-graph.js';
import { conceptSpans, highlightedConceptIds } from '../dashboard-app/src/lib/concept-spans.js';
import type { FoxxiAgenticPayload } from '../src/agentic-rag.js';

// grip ─┐
//       ├─▶ putting ──▶ scoring ◀── handicap (modifier-of)
// stance┘
const PAYLOAD: FoxxiAgenticPayload = {
  packageMeta: {
    course_id: 'golf-fundamentals',
    course_label: 'Golf Fundamentals',
    title: 'Golf Fundamentals',
    federation_iri_base: 'https://css.example.test/acme-training/courses/golf-fundamentals',
  },
  concepts: [
    { id: 'putting', label: 'Putting', confidence: 1, tier: 1, taught_in_slides: ['s1', 's2'] },
    { id: 'grip', label: 'Grip', confidence: 0.9, tier: 1, taught_in_slides: ['s1'] },
    { id: 'stance', label: 'Stance', confidence: 0.8, tier: 2, taught_in_slides: ['s2'] },
    { id: 'handicap', label: 'Handicap', confidence: 0.7, tier: 2, taught_in_slides: ['s3'] },
    { id: 'scoring', label: 'Scoring', confidence: 0.95, tier: 1, taught_in_slides: ['s3'] },
  ],
  slides: [
    { id: 's1', title: 'Holding the club', sequence_index: 0 },
    { id: 's2', title: 'Where to stand', sequence_index: 1 },
    { id: 's3', title: 'Keeping score', sequence_index: 2 },
  ],
  prereq_edges: [
    { from: 'grip', to: 'putting', confidence: 0.5 },
    { from: 'stance', to: 'putting', confidence: 0.5 },
    { from: 'putting', to: 'scoring', confidence: 0.5 },
  ],
  modifier_pairs: [{ modifier: 'handicap', target: 'scoring' }],
};

const asGraph = (r: ConceptNavGraph | { error: string }): ConceptNavGraph => {
  if ('error' in r) throw new Error(`expected a graph, got error: ${r.error}`);
  return r;
};
const ids = (r: ConceptNavGraph): string[] => r.concepts.map(c => c.id);

describe('buildConceptNavGraph', () => {
  it('returns the whole graph when no focus is given', () => {
    const g = asGraph(buildConceptNavGraph(PAYLOAD));
    expect(ids(g).sort()).toEqual(['grip', 'handicap', 'putting', 'scoring', 'stance']);
    expect(g.edges).toHaveLength(4);
    expect(g.truncated).toBe(false);
    // depth is meaningless without a focus and must not be invented.
    expect(g.concepts.every(c => c.depth === undefined)).toBe(true);
    expect(g.courseId).toBe('golf-fundamentals');
    expect(g.courseIri).toBe('https://css.example.test/acme-training/courses/golf-fundamentals#package');
  });

  it('follows prerequisite edges UP AND DOWN from a focus', () => {
    // The affordance says "follow prerequisite edges up AND down". A directed
    // from→to walk reaches `scoring` but not `grip`/`stance`, and answers half
    // the question that was asked.
    const g = asGraph(buildConceptNavGraph(PAYLOAD, { focusConceptId: 'putting', maxDepth: 1 }));
    expect(ids(g)).toContain('grip');
    expect(ids(g)).toContain('stance');
    expect(ids(g)).toContain('scoring');
    expect(ids(g), 'handicap is 2 hops away and maxDepth was 1').not.toContain('handicap');
    expect(g.concepts.find(c => c.id === 'putting')!.depth).toBe(0);
    expect(g.concepts.find(c => c.id === 'grip')!.depth).toBe(1);
    expect(g.truncated).toBe(true);
    expect(g.maxDepth).toBe(1);
    expect(g.focusConceptId).toBe('putting');
  });

  it('honours the depth limit rather than walking the whole component', () => {
    const g = asGraph(buildConceptNavGraph(PAYLOAD, { focusConceptId: 'putting', maxDepth: 2 }));
    expect(ids(g)).toContain('handicap');
    expect(g.concepts.find(c => c.id === 'handicap')!.depth).toBe(2);
    expect(g.truncated).toBe(false); // all 5 reached
  });

  it('an unknown focus is an ERROR, not an empty graph', () => {
    // ★ The defect this whole capability was: { concepts: [], edges: [] } reads as
    // "this course has no concept map". An error that names the id and the real
    // concept count cannot be misread that way.
    const r = buildConceptNavGraph(PAYLOAD, { focusConceptId: 'nope' });
    expect('error' in r).toBe(true);
    expect(r).not.toHaveProperty('concepts');
    const msg = (r as { error: string }).error;
    expect(msg).toContain('nope');
    expect(msg).toContain('golf-fundamentals');
    expect(msg, 'the caller must learn the course DOES have concepts').toContain('5 concept');
  });

  it('carries taughtInSlides through, and every id resolves in slides[]', () => {
    const g = asGraph(buildConceptNavGraph(PAYLOAD));
    const slideIds = new Set(g.slides.map(s => s.id));
    expect(slideIds.size).toBe(3);
    const putting = g.concepts.find(c => c.id === 'putting')!;
    expect([...putting.taughtInSlides]).toEqual(['s1', 's2']);
    for (const c of g.concepts) {
      for (const sid of c.taughtInSlides) expect(slideIds.has(sid), `${c.id} cites unknown slide ${sid}`).toBe(true);
    }
  });

  it('restricts edges to the returned node set', () => {
    const g = asGraph(buildConceptNavGraph(PAYLOAD, { focusConceptId: 'putting', maxDepth: 1 }));
    const present = new Set(ids(g));
    for (const e of g.edges) {
      expect(present.has(e.from), `edge names excluded node ${e.from}`).toBe(true);
      expect(present.has(e.to), `edge names excluded node ${e.to}`).toBe(true);
    }
    // handicap was excluded, so its modifier-of edge must be gone too.
    expect(g.edges.some(e => e.from === 'handicap')).toBe(false);
  });

  it('does not throw when a course published no prerequisite edges', () => {
    const { prereq_edges: _dropped, ...noPrereq } = PAYLOAD;
    const g = asGraph(buildConceptNavGraph(noPrereq as FoxxiAgenticPayload));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.kind).toBe('modifier-of');
  });
});

/**
 * ★ THE TRANSCRIPT SCAN THAT NO TEST COULD REACH.
 *
 * `conceptSpans` was inlined in `dashboard-app/src/components/SlideNavigator.tsx`, inside a
 * React component this repo never renders. Its plain-text advance was
 * `text.indexOf(' ', i) + 1` — consume to the next SPACE — which means a concept match was
 * only ever ATTEMPTED at index 0 or immediately after a space. Every concept behind any
 * other delimiter went unhighlighted: `(backpropagation)`, a line break, a hyphen. The fix
 * was measured by hand and then had nothing holding it, so the scan was extracted to
 * `dashboard-app/src/lib/concept-spans.ts` and the component now renders its output.
 *
 * The table is the point. Reverting the advance to `indexOf(' ', i) + 1` turns cases 2, 3
 * and 4 red while case 1 stays green — which is exactly why case 1 alone would have been
 * worthless, and exactly what the old inline code shipped.
 */
describe('conceptSpans — a concept is highlighted behind any delimiter, not just a space', () => {
  const CONCEPTS = [
    { id: 'c-backprop', label: 'backpropagation' },
    { id: 'c-grad', label: 'gradient' },
  ];
  const ids = (text: string): string[] =>
    highlightedConceptIds(conceptSpans(text, CONCEPTS));

  it.each([
    // [case, transcript, expected concept ids, why this row exists]
    ['1 plain space — green under BOTH the old rule and the new one, so it is the control',
      'we use backpropagation here', ['c-backprop']],
    ['2 parenthesis — the old rule consumed "use (backpropagation)" whole and matched nothing',
      'we use (backpropagation) here', ['c-backprop']],
    ['3 newline — a transcript wraps, and a wrapped concept vanished',
      'we use\nbackpropagation here', ['c-backprop']],
    ['4 hyphen — no space anywhere, so the old rule ran to end-of-string',
      'a-backpropagation-b', ['c-backprop']],
    ['5 two concepts behind different delimiters, both found, in order',
      '[gradient]/backpropagation', ['c-grad', 'c-backprop']],
  ])('%s', (_case, text, expected) => {
    expect(ids(text)).toEqual(expected);
  });

  it('does not over-match: a trailing alpha char is still not a word boundary', () => {
    // The control for the case above. An advance rule that matched everywhere would make
    // the five rows pass while destroying the word-boundary contract, so this pins the
    // other side: `backpropagationX` is one word and is NOT the concept.
    expect(ids('backpropagationX is not a match')).toEqual([]);
    expect(ids('Xbackpropagation is not a match')).toEqual([]);
  });

  it('reassembles the original text exactly, span for span', () => {
    // The scan partitions the transcript; it must never drop or duplicate a character. An
    // off-by-one in either branch of the advance shows up here and nowhere else — the id
    // assertions above would happily pass while the rendered transcript lost a bracket.
    const text = 'we use (backpropagation) and\ngradient-descent, twice: backpropagation.';
    const spans = conceptSpans(text, CONCEPTS);
    expect(spans.map(s => s.text).join('')).toBe(text);
    expect(spans.map(s => s.start)).toEqual(
      spans.reduce<number[]>((acc, s) => [...acc, acc.length === 0 ? 0 : acc[acc.length - 1]!
        + spans[acc.length - 1]!.text.length], []),
    );
  });

  it('prefers the longest label when two concepts start at the same index', () => {
    const overlapping = [
      { id: 'c-short', label: 'gradient' },
      { id: 'c-long', label: 'gradient descent' },
    ];
    expect(highlightedConceptIds(conceptSpans('the gradient descent step', overlapping)))
      .toEqual(['c-long']);
  });

  it('ignores labels shorter than three characters', () => {
    // Below three characters nearly every transcript matches and the highlighting stops
    // carrying information. Pinned so the threshold is a decision, not an accident.
    expect(highlightedConceptIds(conceptSpans('a b ai c', [{ id: 'c-ai', label: 'ai' }])))
      .toEqual([]);
  });
});
