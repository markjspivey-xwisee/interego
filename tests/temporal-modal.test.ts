/**
 * Temporal modal operator tests.
 *
 * Covers: validUntil expiration → Counterfactual; validUntilEvent
 * triggering; sinceEvent gating; validWhile shape failure →
 * Hypothetical; alwaysValid bypass; eventuallyValid → 'pending'.
 */

import { describe, it, expect } from 'vitest';
import type { IRI, ContextDescriptorData } from '@interego/core';
import {
  effectiveModal,
  temporalAnnotations,
  temporalNow,
} from '@interego/core';

const SUBJECT = 'urn:agent:alice' as IRI;

function descWith(temporalExtras: Record<string, unknown>, modal: 'Asserted' | 'Hypothetical' | 'Counterfactual' = 'Asserted'): ContextDescriptorData {
  return {
    id: 'urn:cg:test' as IRI,
    describes: [SUBJECT],
    facets: [
      {
        type: 'Temporal',
        validFrom: '2026-04-01T00:00:00Z',
        ...temporalExtras,
      } as ContextDescriptorData['facets'][number],
      {
        type: 'Semiotic',
        modalStatus: modal,
        groundTruth: modal === 'Asserted',
        epistemicConfidence: 0.9,
      },
    ],
  };
}

describe('temporal modal operators', () => {
  it('validUntil in the past → Counterfactual', () => {
    const d = descWith({ validUntil: '2026-04-10T00:00:00Z' });
    const ctx = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctx)).toBe('Counterfactual');
  });

  it('validUntil in the future → preserves base modal', () => {
    const d = descWith({ validUntil: '2026-04-30T00:00:00Z' });
    const ctx = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctx)).toBe('Asserted');
  });

  it('validFrom in the future → Counterfactual (not yet started)', () => {
    const d = descWith({ validFrom: '2026-05-01T00:00:00Z' });
    const ctx = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctx)).toBe('Counterfactual');
  });

  it('validUntilEvent observed → Counterfactual', () => {
    const d = descWith({ validUntilEvent: 'urn:event:contract-signed' as IRI });
    const ctxBefore = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctxBefore)).toBe('Asserted');
    const ctxAfter = {
      now: '2026-04-15T00:00:00Z',
      observedEvents: new Set(['urn:event:contract-signed' as IRI]),
    };
    expect(effectiveModal(d, ctxAfter)).toBe('Counterfactual');
  });

  it('sinceEvent not yet observed → Counterfactual', () => {
    const d = descWith({ sinceEvent: 'urn:event:registration' as IRI });
    const ctxBefore = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctxBefore)).toBe('Counterfactual');
    const ctxAfter = {
      now: '2026-04-15T00:00:00Z',
      observedEvents: new Set(['urn:event:registration' as IRI]),
    };
    expect(effectiveModal(d, ctxAfter)).toBe('Asserted');
  });

  it('validWhile shape unsatisfied → Hypothetical', () => {
    const d = descWith({ validWhile: 'urn:shape:agent-active' as IRI });
    const ctxOK = {
      now: '2026-04-15T00:00:00Z',
      observedEvents: new Set<IRI>(),
      shapeSatisfied: () => true,
    };
    expect(effectiveModal(d, ctxOK)).toBe('Asserted');
    const ctxFail = {
      now: '2026-04-15T00:00:00Z',
      observedEvents: new Set<IRI>(),
      shapeSatisfied: () => false,
    };
    expect(effectiveModal(d, ctxFail)).toBe('Hypothetical');
  });

  it('alwaysValid bypasses temporal gating', () => {
    const d = descWith({
      alwaysValid: true,
      validUntil: '2020-01-01T00:00:00Z', // way in the past
    });
    const ctx = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctx)).toBe('Asserted');
  });

  it('eventuallyValid + Hypothetical → "pending"', () => {
    const d = descWith({ eventuallyValid: true }, 'Hypothetical');
    const ctx = { now: '2026-04-15T00:00:00Z', observedEvents: new Set<IRI>() };
    expect(effectiveModal(d, ctx)).toBe('pending');
  });

  it('temporalNow returns current ISO + observed events', () => {
    const ctx = temporalNow(['urn:e:1' as IRI, 'urn:e:2' as IRI]);
    expect(typeof ctx.now).toBe('string');
    expect(ctx.observedEvents.size).toBe(2);
  });

  it('temporalAnnotations extracts the temporal-extension fields', () => {
    const d = descWith({
      validUntilEvent: 'urn:event:e' as IRI,
      sinceEvent: 'urn:event:s' as IRI,
      alwaysValid: true,
    });
    const ann = temporalAnnotations(d);
    expect(ann.validUntilEvent).toBe('urn:event:e');
    expect(ann.sinceEvent).toBe('urn:event:s');
    expect(ann.alwaysValid).toBe(true);
  });
});
