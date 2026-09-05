import { describe, expect, it } from 'vitest';
import { applyEffects, evaluateGuard, type Json } from '../deploy/mcp-relay/application-lab-runtime.js';

describe('signed-domain effects own every inserted value', () => {
  it('cannot mutate a payload through a later effect', () => {
    const payload = { record: { nested: { value: 1 } } };
    const result = applyEffects({}, [
      { op: 'set', path: '$state.copy', value: '$payload.record' },
      { op: 'set', path: '$state.copy.nested.value', value: 2 },
    ], { payload });
    expect(result).toEqual({ copy: { nested: { value: 2 } } });
    expect(payload.record.nested.value).toBe(1);
  });

  it.each(['set', 'appendUnique', 'updateAllWhere'])('%s returns no payload aliases', op => {
    const payload = { record: { value: 1 } };
    const state: Record<string, Json> = { rows: [{ id: 0 }] };
    const effect: Record<string, Json> = op === 'set'
      ? { op, path: '$state.copy', value: '$payload.record' }
      : op === 'appendUnique'
        ? { op, path: '$state.rows', value: { id: 1, copy: '$payload.record' } }
        : { op, path: '$state.rows', where: { itemPath: 'id', eq: 0 }, set: { copy: '$payload.record' } };
    const result = applyEffects(state, [effect], { payload });
    const record = op === 'set' ? result : (result.rows as Record<string, Json>[])[op === 'appendUnique' ? 1 : 0]!;
    (record.copy as Record<string, Json>).value = 9;
    expect(payload.record.value).toBe(1);
    expect(state).toEqual({ rows: [{ id: 0 }] });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('refuses unsafe path segment %s', segment => {
    const key = 'interegoSimulationPurityProbe';
    try {
      expect(() => applyEffects({}, [{ op: 'set', path: `$state.${segment}.${key}`, value: true }], {}))
        .toThrow(/unsafe effect path/);
      expect(Object.prototype).not.toHaveProperty(key);
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it('refuses a missing reference instead of inserting non-JSON state', () => {
    expect(() => applyEffects({}, [{ op: 'set', path: '$state.copy', value: '$payload.missing' }], { payload: {} }))
      .toThrow(/canonical JSON/);
  });

  it('does not traverse inherited objects under otherwise ordinary path names', () => {
    const inherited = { value: 1 };
    const key = 'interegoSimulationInheritedProbe';
    Object.defineProperty(Object.prototype, key, { value: inherited, configurable: true, writable: true });
    try {
      const result = applyEffects({}, [{ op: 'set', path: `$state.${key}.value`, value: 2 }], {});
      expect(inherited.value).toBe(1);
      expect(Object.hasOwn(result, key)).toBe(true);
      expect(result[key]).toEqual({ value: 2 });
      expect(() => applyEffects({}, [{ op: 'set', path: '$state.copy', value: `$payload.${key}` }], { payload: {} }))
        .toThrow(/canonical JSON/);
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it.each([{ rows: [] }, { rows: [{}] }, { rows: [null] }])('does not turn an unsupported predicate into absence for $rows', ({ rows }) => {
    expect(evaluateGuard({ op: 'none', path: '$state.rows', where: { op: 'invented' } }, { state: { rows } }).supported)
      .toBe(false);
    expect(() => applyEffects({ rows }, [{
      op: 'updateAllWhere', path: '$state.rows', where: { op: 'invented' }, set: { approved: true },
    }], {})).toThrow(/unsupported/);
  });
});
