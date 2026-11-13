/**
 * Foxxi's own xAPI Profile published its rule locations without the `$` a JSONPath starts with, so
 * the specification's algorithm refused every ruled template in it. Found on the live Profile
 * Server the day it shipped: /validate_templates answered "a JSONPath starts at $".
 */
import { describe, it, expect } from 'vitest';
import { asJsonPath, buildFoxxiProfileDoc, validateAgainstProfileTemplates } from '../src/xapi-profile.js';
import { apply_jsonpath, follows_rules, rule_failure, type Json } from '../src/xapi-profile-server/processor.js';

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
    expect(validateAgainstProfileTemplates(good as Record<string, unknown>).violations).toEqual([]);

    const { registration: _dropped, ...rest } = (good as { context: Record<string, Json> }).context;
    const bad = { ...(good as object), context: rest } as Json;
    expect(follows_rules(bad, t as unknown as Json)).toBe(false);
    expect(rule_failure(bad, t.rules![0] as unknown as Json)).not.toBeNull();
    expect(validateAgainstProfileTemplates(bad as Record<string, unknown>).violations.length).toBeGreaterThan(0);
  });
});
