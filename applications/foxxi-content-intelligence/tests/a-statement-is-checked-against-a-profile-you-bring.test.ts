/**
 * The LRS checked a statement against Foxxi's own xAPI Profile only. A statement can now be
 * checked against the templates of a profile sent with it, and what is not evaluated is named.
 */
import { describe, it, expect } from 'vitest';
import { validateAgainstSuppliedProfile, whyNotAProfile } from '../src/xapi-profile-supplied.js';

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
    expect(r.notChecked.some(n => n.includes('objectStatementRefTemplate'))).toBe(true);
    expect(r.notChecked.some(n => n.startsWith('patterns'))).toBe(true);
  });

  it('refuses a document that is not a usable profile', () => {
    expect(whyNotAProfile(profile)).toBeNull();
    expect(whyNotAProfile('https://example.org/profile')).toMatch(/JSON object/);
    expect(whyNotAProfile({ id: P })).toMatch(/templates/);
    expect(whyNotAProfile({ templates: [{ verb: 'x' }] })).toMatch(/id/);
    expect(whyNotAProfile({ templates: Array.from({ length: 501 }, (_, i) => ({ id: `t${i}` })) })).toMatch(/more than 500/);
  });
});
