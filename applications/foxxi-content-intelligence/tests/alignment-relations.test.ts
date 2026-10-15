import { describe, expect, it } from 'vitest';
import {
  resolveAlignment, serializeAlignment, type AlignmentRelation,
} from '../src/framework-alignment.js';

const HELD = 'urn:test:alignment:held';
const MID = 'urn:test:alignment:middle';
const REQUIRED = 'urn:test:alignment:required';
const edge = (from: string, to: string, relation: AlignmentRelation) => serializeAlignment({
  ownItemIri: from, ownItemLabel: from, otherItemIri: to,
  otherFrameworkIri: 'urn:test:alignment:framework', relation,
  declaredAt: '2026-10-15T00:00:00Z',
});
const resolve = (alignments: ReturnType<typeof edge>[], reverse = false) => resolveAlignment({
  heldCompetencyIri: reverse ? REQUIRED : HELD,
  requiredCompetencyIri: reverse ? HELD : REQUIRED,
  alignments,
});

describe('a prerequisite or ordering relation does not satisfy competency equivalence', () => {
  it.each<AlignmentRelation>(['precedes', 'isPrerequisiteOf', 'broadens', 'narrows'])(
    'does not treat %s as a competency alignment in either direction', (relation) => {
      const alignments = [edge(HELD, REQUIRED, relation)];
      expect(resolve(alignments)).toMatchObject({ satisfied: false, via: 'unknown', chain: [] });
      expect(resolve(alignments, true)).toMatchObject({ satisfied: false, via: 'unknown', chain: [] });
    },
  );

  it('cannot reach the requirement through a prerequisite after a valid alignment', () => {
    expect(resolve([
      edge(HELD, MID, 'isEquivalentTo'),
      edge(MID, REQUIRED, 'isPrerequisiteOf'),
    ])).toMatchObject({ satisfied: false, via: 'unknown', chain: [] });
  });

  it('keeps transitive alignment and equivalence paths in both directions', () => {
    const first = edge(HELD, MID, 'isAlignedTo');
    const second = edge(MID, REQUIRED, 'isEquivalentTo');
    expect(resolve([first, second])).toMatchObject({
      satisfied: true, via: 'aligned', chain: [first, second],
    });
    expect(resolve([first, second], true)).toMatchObject({
      satisfied: true, via: 'aligned', chain: [second, first],
    });
  });

  it('a matching IRI remains a direct computational match', () => {
    expect(resolveAlignment({
      heldCompetencyIri: HELD, requiredCompetencyIri: HELD, alignments: [],
    })).toMatchObject({ satisfied: true, via: 'direct', chain: [] });
  });
});
