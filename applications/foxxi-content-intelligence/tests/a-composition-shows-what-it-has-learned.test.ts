/**
 * A composition shows its author, a person or an agent, what it has learned: at each position, how
 * learners at each level did after each alternative, and which one it leans to for them now. A cell
 * is shown only once it may be, and a leaning only where no cell behind it is too small to show.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compositionEfficacy } from '../src/composition-efficacy.js';
import { compositionFrom, type Composition } from '../src/compositions.js';
import { fragmentFrom, type Fragment } from '../src/content-fragments.js';
import { EFFICACY_POLICY, EfficacyTally } from '../src/fragment-efficacy.js';
import type { CognitiveLevel } from '../src/emergent-content.js';

const c = 'refund-authority';
const told = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'Told', body: 'Agents refund up to $250.' });
const shown = fragmentFrom({ kind: 'worked-example', level: 'foundational', competencies: [c], title: 'Shown', body: 'A $600 request goes to the team lead.' });
const deeper = fragmentFrom({ kind: 'concept', level: 'advanced', competencies: [c], title: 'Deeper', body: 'The threshold caps what one person can approve alone.' });
const only = fragmentFrom({ kind: 'assessment-item', competencies: [c], title: 'Check', body: 'Check.', questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B' }] });
const nested = compositionFrom({ title: 'A longer way', competency: c, positions: [{ competency: c, paradigm: [told['@id']] }] });
const course = compositionFrom({ title: 'Refunds', competency: c, positions: [
  { competency: c, paradigm: [told['@id'], shown['@id'], deeper['@id'], nested['@id']] },
  { competency: c, paradigm: [only['@id']] },
] });
const store = new Map<string, Fragment | Composition>([told, shown, deeper, only, nested, course].map(x => [x['@id'], x]));
const competency = course.positions[0]!.competency;
let learner = 0;
const tally = new EfficacyTally();
/** Outcomes at a cell, each from a learner of its own. */
const heard = (f: Fragment, level: CognitiveLevel, successes: number, failures: number) => {
  for (const success of [...Array(successes).fill(true), ...Array(failures).fill(false)]) {
    tally.record({ competency, fragment: f['@id'], level, success }, createHash('sha256').update(String(++learner)).digest('hex'));
  }
};
heard(told, 'foundational', 3, 3);      // 6 outcomes: shown
heard(shown, 'foundational', 5, 0);     // 5 outcomes: shown, and leading
heard(told, 'working', 4, 1);           // 5
heard(shown, 'working', 1, 1);          // 2: too few to show, so no leaning at working either
heard(deeper, 'advanced', 1, 0);        // 1, alone among its level's alternatives
const view = compositionEfficacy(course, tally, iri => store.get(iri));
const first = view.positions[0]!;
const alternative = (f: Fragment | Composition) => first.alternatives.find(a => a.iri === f['@id'])!;

describe('a composition shows what it has learned', () => {
  it('shows a cell once it may be, and below that only that it has fewer', () => {
    expect(view).toMatchObject({ composition: course['@id'], title: 'Refunds', policy: EFFICACY_POLICY });
    expect(alternative(told)).toMatchObject({ kind: 'concept', title: 'Told' });
    expect(alternative(told).cells).toEqual([
      expect.objectContaining({ level: 'foundational', n: 6, successes: 3, modalStatus: 'Hypothetical' }),
      expect.objectContaining({ level: 'working', n: 5, successes: 4 }),
    ]);
    expect(alternative(shown).cells).toEqual([
      expect.objectContaining({ level: 'foundational', n: 5, successes: 5 }),
      { level: 'working', n: `fewer than ${EFFICACY_POLICY.publishAt}` },
    ]);
    expect(alternative(deeper).cells).toEqual([{ level: 'advanced', n: `fewer than ${EFFICACY_POLICY.publishAt}` }]);
    expect(JSON.stringify(view)).not.toMatch(/"successes":1\b/);   // no small cell's result anywhere
  });

  it('leans, at a level, to what learners there would be shown, and says why', () => {
    expect(first.leansTo.find(l => l.level === 'foundational')).toEqual({ level: 'foundational', for: 'anyone', chosen: shown['@id'], why: expect.stringMatching(/^the most promising here for learners at this level: 5 of 5 went on to succeed/) });
    expect(view.leaningAssumes).toMatch(/no admission narrowing the forms/);
  });

  it('withholds a leaning where any alternative has outcomes too few to show', () => {
    const plainly = compositionFrom({ title: 'No nesting', competency: c, positions: [{ competency: c, paradigm: [told['@id'], shown['@id'], deeper['@id']] }] });
    const leaning = compositionEfficacy(plainly, tally, iri => store.get(iri)).positions[0]!.leansTo.find(l => l.level === 'working');
    expect(leaning).toEqual({ level: 'working', for: 'anyone', withheld: expect.stringMatching(/fewer than 5 outcomes here/) });
  });

  it('says learners go into a nested composition that comes first, where outcomes decide nothing', () => {
    const first = compositionFrom({ title: 'Nested first', competency: c, positions: [{ competency: c, paradigm: [nested['@id'], told['@id'], shown['@id']] }] });
    const leaning = compositionEfficacy(first, tally, iri => store.get(iri)).positions[0]!.leansTo.find(l => l.level === 'foundational');
    expect(leaning).toEqual({ level: 'foundational', for: 'anyone', into: nested['@id'], why: expect.stringMatching(/^"A longer way" comes first here/) });
    // A composition is pitched at every level, so for working learners it is nearer than the foundational fragments.
    expect(view.positions[0]!.leansTo.find(l => l.level === 'working')).toMatchObject({ into: nested['@id'] });
  });

  it('leans for people and for agents apart where an alternative is meant for one of them', () => {
    const forAgents = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'For agents', body: 'Route refunds over $250 to a lead.', audience: 'agent' });
    const plain = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'Plain', body: 'Refunds over $250 need a lead.' });
    store.set(forAgents['@id'], forAgents);
    store.set(plain['@id'], plain);
    heard(plain, 'foundational', 4, 1);       // 5: the better of the two anyone may be shown
    heard(forAgents, 'foundational', 5, 0);   // 5, and better still, but for agents only
    const split = compositionFrom({ title: 'Split', competency: c, positions: [{ competency: c, paradigm: [told['@id'], plain['@id'], forAgents['@id']] }] });
    const leansTo = compositionEfficacy(split, tally, iri => store.get(iri)).positions[0]!.leansTo.filter(l => l.level === 'foundational');
    expect(leansTo).toEqual([
      expect.objectContaining({ for: 'human', chosen: plain['@id'] }),
      expect.objectContaining({ for: 'agent', chosen: forAgents['@id'] }),
    ]);
  });

  it('leans only among what resolution would weigh for learners at that level', () => {
    // At foundational, the advanced alternative is not weighed (it has no outcome there, and would
    // otherwise be given its turn); at advanced and applied it alone is nearest, so nothing is weighed.
    expect(first.leansTo.map(l => l.level)).toEqual(['foundational', 'working']);
  });

  it('names a nested composition as one, to be read at its own IRI, and leans nowhere with one alternative', () => {
    expect(alternative(nested)).toEqual({ iri: nested['@id'], composition: true, title: 'A longer way', cells: [] });
    expect(view.positions[1]).toMatchObject({ position: 1, leansTo: [] });
  });
});

describe('the bridge shows it at the composition\'s own IRI', () => {
  it('only for a composition it holds, and never from a tally it has not read', () => {
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const at = src.indexOf("app.get('/ns/foxxi/composition/:hash/efficacy'");
    const route = src.slice(at, src.indexOf('\n});', at));
    expect(route).toMatch(/if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(hash\)\)/);
    expect(route).toMatch(/if \(!item \|\| !isCompositionItem\(item\)\) \{ res\.status\(404\)/);
    expect(route).toMatch(/if \(!\(await ensureEfficacy\(\)\)\) \{ res\.status\(503\)/);
    expect(route.indexOf('ensureEfficacy()')).toBeLessThan(route.indexOf('compositionEfficacy('));
    expect(route).toMatch(/compositionEfficacy\(item, fragmentEfficacy, iri => contentStore\.get\(iri\)\)/);
  });
});
