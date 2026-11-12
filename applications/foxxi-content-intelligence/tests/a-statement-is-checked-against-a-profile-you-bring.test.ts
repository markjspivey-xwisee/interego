/**
 * The LRS checked a statement against Foxxi's own xAPI Profile only. A statement can now be
 * checked against the templates of a profile sent with it, and what is not evaluated is named.
 */
import { describe, it, expect } from 'vitest';
import { selectLocation, validateAgainstSuppliedProfile, whyNotAProfile } from '../src/xapi-profile-supplied.js';

const P = 'https://example.org/profiles/phone-roleplay';
const profile = {
  id: P, type: 'Profile',
  concepts: [{ id: `${P}/verbs/scored`, type: 'Verb' }, { id: `${P}/verbs/unused`, type: 'Verb' }],
  templates: [
    {
      id: `${P}/templates/criterion-greeting`, type: 'StatementTemplate',
      verb: `${P}/verbs/scored`, objectActivityType: `${P}/activity-types/criterion`,
      contextParentActivityType: [`${P}/activity-types/call`],
      rules: [
        { location: '$.context.registration', presence: 'included' },
        { location: '$.result.score.raw', presence: 'included' },
        { location: `$.object.definition.extensions['${P}/ext/criterion']`, any: ['greeting'] },
        { location: '$.result.extensions.draft', presence: 'excluded' },
        { location: '$.context.platform', none: ['test-rig'] },
      ],
    },
    {
      id: `${P}/templates/criterion-closing`, type: 'StatementTemplate',
      verb: `${P}/verbs/scored`, objectActivityType: `${P}/activity-types/criterion`,
      rules: [{ location: `$.object.definition.extensions['${P}/ext/criterion']`, presence: 'included', all: ['closing'] }],
    },
  ],
  patterns: [{ id: `${P}/patterns/rubric`, sequence: [`${P}/templates/criterion-greeting`, `${P}/templates/criterion-closing`] }],
};
const statement = (criterion: string, extra: Record<string, unknown> = {}) => ({
  actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
  verb: { id: `${P}/verbs/scored` },
  object: { id: `${P}/criteria/${criterion}`, definition: { type: `${P}/activity-types/criterion`, extensions: { [`${P}/ext/criterion`]: criterion } } },
  result: { score: { raw: 4 } },
  context: { registration: '00000000-0000-4000-8000-000000000001',
    contextActivities: { parent: [{ id: `${P}/calls/1`, definition: { type: `${P}/activity-types/call` } }] } },
  ...extra,
});

describe('a statement is checked against a profile you bring', () => {
  it('follows the template whose determining properties and rules it meets', () => {
    const r = validateAgainstSuppliedProfile(statement('greeting'), profile);
    expect(r).toMatchObject({ profile: P, verbDeclared: true, applicable: true, violations: [] });
    expect(r.matchedTemplates).toEqual([`${P}/templates/criterion-greeting`]);
    expect(validateAgainstSuppliedProfile(statement('closing'), profile).matchedTemplates).toEqual([`${P}/templates/criterion-closing`]);
  });

  it('says which rule of the closest template is broken', () => {
    const noScore = statement('greeting', { result: {} });
    const r = validateAgainstSuppliedProfile(noScore, profile);
    expect(r.matchedTemplates).toEqual([]);
    expect(r.violations.map(v => v.location)).toContain('$.result.score.raw');
    const draft = validateAgainstSuppliedProfile(statement('greeting', { result: { score: { raw: 4 }, extensions: { draft: true } } }), profile);
    expect(draft.violations.some(v => v.message === 'location must be absent')).toBe(true);
    const rig = validateAgainstSuppliedProfile(statement('greeting', { context: { ...statement('greeting').context, platform: 'test-rig' } }), profile);
    expect(rig.violations.some(v => /excludes/.test(v.message))).toBe(true);
  });

  it('holds a statement to a template\'s context activity types, not only its verb', () => {
    const noParent = statement('greeting', { context: { registration: '00000000-0000-4000-8000-000000000001' } });
    const r = validateAgainstSuppliedProfile(noParent, profile);
    expect(r.matchedTemplates).toEqual([]);
    expect(r.violations.some(v => v.message.startsWith('contextParentActivityType'))).toBe(true);
  });

  it('tells an unknown verb from a declared verb no template uses', () => {
    const unknown = validateAgainstSuppliedProfile({ ...statement('greeting'), verb: { id: 'https://example.org/other' } }, profile);
    expect(unknown).toMatchObject({ verbDeclared: false, applicable: false, matchedTemplates: [] });
    const unused = validateAgainstSuppliedProfile({ ...statement('greeting'), verb: { id: `${P}/verbs/unused` } }, profile);
    expect(unused).toMatchObject({ verbDeclared: true, applicable: false });
  });

  it('names what it does not evaluate instead of passing it', () => {
    const withSelector = { ...profile, templates: [{ ...profile.templates[1]!, objectStatementRefTemplate: [`${P}/templates/x`],
      rules: [{ location: '$.object.definition.extensions', selector: '$.x', presence: 'included' }] }] };
    const r = validateAgainstSuppliedProfile(statement('closing'), withSelector);
    expect(r.notChecked.some(n => n.includes('selector'))).toBe(true);
    // The rule with a selector is not judged at all: its location alone selects other values.
    const selecting = { ...profile, templates: [{ id: `${P}/templates/s`, verb: `${P}/verbs/scored`,
      rules: [{ location: '$.result.extensions', selector: '$.x', all: ['expected'] }] }] };
    const selected = validateAgainstSuppliedProfile(statement('closing', { result: { extensions: { x: 'expected' } } }), selecting);
    expect(selected.violations).toEqual([]);
    expect(selected.notChecked.some(n => n.includes('selector'))).toBe(true);
    const filtered = { ...profile, templates: [{ id: `${P}/templates/f`, verb: `${P}/verbs/scored`,
      rules: [{ location: '$.context.contextActivities.parent[?(@.id)]', presence: 'included' }] }] };
    const f = validateAgainstSuppliedProfile(statement('closing'), filtered);
    expect(f.violations).toEqual([]);
    expect(f.notChecked.some(n => n.includes('JSONPath form'))).toBe(true);
    expect(r.notChecked.some(n => n.includes('objectStatementRefTemplate'))).toBe(true);
    expect(r.notChecked.some(n => n.startsWith('patterns'))).toBe(true);
  });

  it('does not let an absent location satisfy any or all', () => {
    const asking = (rule: Record<string, unknown>) => ({ ...profile, patterns: [], templates: [{ id: `${P}/templates/a`, verb: `${P}/verbs/scored`, rules: [rule] }] });
    const without = statement('greeting', { result: {} });
    expect(validateAgainstSuppliedProfile(without, asking({ location: '$.result.success', any: [true] })).matchedTemplates).toEqual([]);
    expect(validateAgainstSuppliedProfile(without, asking({ location: '$.result.success', all: [true] })).matchedTemplates).toEqual([]);
    // recommended makes the value check apply only when there is a value; none is met by absence.
    expect(validateAgainstSuppliedProfile(without, asking({ location: '$.result.success', presence: 'recommended', any: [true] })).matchedTemplates).toHaveLength(1);
    expect(validateAgainstSuppliedProfile(without, asking({ location: '$.result.success', none: [false] })).matchedTemplates).toHaveLength(1);
    expect(validateAgainstSuppliedProfile(statement('greeting', { result: { success: true } }), asking({ location: '$.result.success', any: [true] })).matchedTemplates).toHaveLength(1);
  });

  it('reads indices, unions and alternatives in a location, and declines what it cannot', () => {
    const s = { context: { contextActivities: { parent: [{ id: 'p0' }, { id: 'p1' }], grouping: [{ id: 'g0' }] } }, result: { score: { raw: 4, max: 5 } } };
    expect(selectLocation(s, '$.context.contextActivities.parent[0].id')).toEqual(['p0']);
    expect(selectLocation(s, '$.context.contextActivities.parent[-1].id')).toEqual(['p1']);
    expect(selectLocation(s, '$.context.contextActivities.parent[*].id')).toEqual(['p0', 'p1']);
    expect(selectLocation(s, "$.result.score['raw','max']")).toEqual([4, 5]);
    expect(selectLocation(s, '$.context.contextActivities.parent[0,1].id')).toEqual(['p0', 'p1']);
    expect(selectLocation(s, '$.context.contextActivities.parent[*].id | $.context.contextActivities.grouping[*].id')).toEqual(['p0', 'p1', 'g0']);
    expect(selectLocation(s, '$.result.missing')).toEqual([]);
    for (const unread of ['$..id', '$.context.contextActivities.parent[?(@.id)]', '$.context.contextActivities.parent[0:1]', 'result.score.raw'])
      expect(selectLocation(s, unread), unread).toBeNull();
  });

  it('refuses a document that is not a usable profile', () => {
    expect(whyNotAProfile(profile)).toBeNull();
    expect(whyNotAProfile('https://example.org/profile')).toMatch(/JSON object/);
    expect(whyNotAProfile({ id: P })).toMatch(/templates/);
    expect(whyNotAProfile({ templates: [{ verb: 'x' }] })).toMatch(/id/);
    expect(whyNotAProfile({ templates: Array.from({ length: 501 }, (_, i) => ({ id: `t${i}` })) })).toMatch(/more than 500/);
  });
});
