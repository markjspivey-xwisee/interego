/**
 * Foxxi's own xAPI Profile published its rule locations without the `$` a JSONPath starts with, so
 * the specification's algorithm refused every ruled template in it. Found on the live Profile
 * Server the day it shipped: /validate_templates answered "a JSONPath starts at $".
 */
import { describe, it, expect } from 'vitest';
import { asJsonPath, buildFoxxiProfileDoc, validateAgainstProfileTemplates } from '../src/xapi-profile.js';
import { apply_jsonpath, follows_rules, rule_failure, validates, type Json } from '../src/xapi-profile-server/processor.js';

const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-22T00:00:00.000Z' }) as { id: string; templates: Array<{ id: string; verb?: string; objectActivityType?: string; rules?: Array<{ location: string; selector?: string }> }> };

describe('Foxxi\'s own profile', () => {
  it('states every rule location as a JSONPath the specification\'s algorithm evaluates', () => {
    const locations = doc.templates.flatMap(t => (t.rules ?? []).map(r => r.location));
    expect(locations.length).toBeGreaterThan(40);
    for (const location of locations) {
      expect(location.startsWith('$.'), location).toBe(true);
      expect(() => apply_jsonpath({}, location), location).not.toThrow();
    }
    expect(asJsonPath('context.extensions["https://example.org/ns#k"]')).toBe("$.context.extensions['https://example.org/ns#k']");
    expect(asJsonPath('$.already')).toBe('$.already');
  });

  it('gives the same answer from both validators for one template, followed and not', () => {
    const t = doc.templates.find(x => x.id.endsWith('/templates/fragment-experienced'))!;
    const ns = t.objectActivityType!.replace(/activities\/fragment$/, '');
    const good: Json = {
      actor: { mbox: 'mailto:fictional-learner@example.org' }, verb: { id: t.verb! },
      object: { id: 'https://example.org/fragments/made-up', definition: { type: t.objectActivityType! } },
      context: {
        registration: '11111111-1111-4111-8111-111111111111',
        contextActivities: { parent: [{ id: 'https://example.org/compositions/made-up', definition: { type: `${ns}activities/composition` } }] },
        extensions: { [`${ns}competency`]: 'https://example.org/competencies/made-up', [`${ns}compositionPosition`]: 1, [`${ns}alternativesOffered`]: 2 },
      },
    };
    expect(follows_rules(good, t as unknown as Json)).toBe(true);
    // And it matches that template alone: the catch-all `experienced` template used to match it
    // too, and its rule (a course or a performance) made every fragment statement invalid.
    expect(validates(good, doc.templates as unknown as Json[])).toMatchObject({ outcome: 'success', templates: [t.id] });
    expect(validateAgainstProfileTemplates(good as Record<string, unknown>).violations).toEqual([]);

    const { registration: _dropped, ...rest } = (good as { context: Record<string, Json> }).context;
    const bad = { ...(good as object), context: rest } as Json;
    expect(follows_rules(bad, t as unknown as Json)).toBe(false);
    expect(rule_failure(bad, t.rules![0] as unknown as Json)).not.toBeNull();
    expect(validateAgainstProfileTemplates(bad as Record<string, unknown>).violations.length).toBeGreaterThan(0);
  });

  it('matches one template for each kind of thing experienced', () => {
    const experienced = (type: string): Json => ({ actor: { mbox: 'mailto:fictional-learner@example.org' }, verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' },
      object: { id: 'https://example.org/things/made-up', definition: { type } } });
    const outcome = (type: string) => validates(experienced(type), doc.templates as unknown as Json[]);
    expect(outcome('http://adlnet.gov/expapi/activities/course')).toMatchObject({ outcome: 'success', templates: [`${doc.id}/templates/experienced-activity`] });
    expect(outcome('http://adlnet.gov/expapi/activities/performance')).toMatchObject({ outcome: 'success', templates: [`${doc.id}/templates/experienced-performance`] });
    // A type no template names is unmatched, not vacuously followed.
    expect(outcome('https://example.org/types/unheard-of').outcome).toBe('unmatched');
  });

  it('matches a cmi5 launch, whose category is an activity id and carries no type', () => {
    const launch = (type: string, category = true): Json => ({ actor: { mbox: 'mailto:fictional-learner@example.org' }, verb: { id: 'http://adlnet.gov/expapi/verbs/launched' },
      object: { id: 'https://example.org/au/made-up', definition: { type } },
      context: { registration: '11111111-1111-4111-8111-111111111111', ...(category ? { contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] } } : {}) } });
    for (const type of ['http://adlnet.gov/expapi/activities/course', 'http://adlnet.gov/expapi/activities/lesson'])
      expect(validates(launch(type), doc.templates as unknown as Json[]).outcome, type).toBe('success');
    // Without the category it is found and refused, where before it was not found at all.
    const bare = validates(launch('http://adlnet.gov/expapi/activities/lesson', false), doc.templates as unknown as Json[]);
    expect(bare.outcome).toBe('invalid');
    expect(bare.findings[0]!.location).toBe('$.context.contextActivities.category[*].id');
  });

  it('states no context activity type that is really an activity id', () => {
    const typeProperties = ['contextCategoryActivityType', 'contextGroupingActivityType', 'contextParentActivityType', 'contextOtherActivityType'] as const;
    const stated = doc.templates.flatMap(t => typeProperties.flatMap(p => ((t as unknown as Record<string, string[] | undefined>)[p] ?? [])));
    expect(stated.filter(iri => /\/categories\//.test(iri))).toEqual([]);
  });
});
