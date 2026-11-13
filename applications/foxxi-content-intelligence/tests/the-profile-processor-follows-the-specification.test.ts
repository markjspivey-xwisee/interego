/**
 * The xAPI Profile Processor is written from the specification's pseudocode (Part Three, 2.1 and
 * 2.2). These cases pin the branches where the specified answer is not the obvious one.
 */
import { describe, it, expect } from 'vitest';
import {
  apply_jsonpath, JsonPathError, validates, follows, follows_rule, follows_rules, matches, matches_determining_properties,
  elementsOf, inOrder, type Json, type Judged,
} from '../src/xapi-profile-server/processor.js';

const P = 'https://example.org/profiles/drill';
const T = (name: string, more: Json = {}): Json => ({ id: `${P}/templates/${name}`, type: 'StatementTemplate', verb: `${P}/verbs/${name}`, ...more });
const S = (verb: string, more: Json = {}): Json => ({ actor: { mbox: 'mailto:fictional@example.org' }, verb: { id: `${P}/verbs/${verb}` }, object: { id: `${P}/things/x` }, ...more });

describe('apply_jsonpath', () => {
  const doc = { a: { b: [1, 2, 3], c: { d: 'x' } }, list: [{ id: 'p0', n: 1 }, { id: 'p1', n: 2 }], 'odd key': 7 };
  it('returns each found value as one member, an array included', () => {
    expect(apply_jsonpath(doc, '$.a.b')).toEqual([[1, 2, 3]]);
    expect(apply_jsonpath(doc, '$.a.b[*]')).toEqual([1, 2, 3]);
    expect(apply_jsonpath(doc, '$.a.b[0,2]')).toEqual([1, 3]);
    expect(apply_jsonpath(doc, "$['odd key']")).toEqual([7]);
    expect(apply_jsonpath(doc, "$.a['b','c']")).toEqual([[1, 2, 3], { d: 'x' }]);
    expect(apply_jsonpath(doc, '$.list[*].id')).toEqual(['p0', 'p1']);
    expect(apply_jsonpath(doc, '$.list[1].id | $.a.c.d')).toEqual(['p1', 'x']);
    expect(apply_jsonpath(doc, '$..id')).toEqual(['p0', 'p1']);
    expect(apply_jsonpath(doc, '$.missing.deeper')).toEqual([]);
    // A name is not looked up in each member of an array: that takes [*].
    expect(apply_jsonpath(doc, '$.list.id')).toEqual([]);
  });
  it('refuses what the specification makes illegal', () => {
    for (const path of ['$.list[?(@.n>1)]', '$.list[(@.length-1)]', '$.list[0:1]', '$.list[-1]', 'list.id'])
      expect(() => apply_jsonpath(doc, path), path).toThrow(JsonPathError);
  });
});

describe('validates', () => {
  it('matches by every determining property, and a template that does not match is not a failure', () => {
    const typed = T('scored', { objectActivityType: `${P}/types/criterion`, contextParentActivityType: [`${P}/types/call`] });
    const plain = S('scored');
    expect(matches_determining_properties(plain, typed)).toBe(false);
    expect(validates(plain, [typed])).toMatchObject({ outcome: 'unmatched', templates: [] });
    const fitting = S('scored', { object: { id: 'x', definition: { type: `${P}/types/criterion` } },
      // A singleton parent, not an array: contextActivities are normalized before the check.
      context: { contextActivities: { parent: { id: 'c', definition: { type: `${P}/types/call` } } } } });
    expect(validates(fitting, [typed])).toMatchObject({ outcome: 'success', templates: [typed.id] });
  });

  it('is invalid when any matched template has a rule unfollowed, even beside one that is followed', () => {
    const loose = T('scored'), strict = { ...T('scored'), id: `${P}/templates/strict`, rules: [{ location: '$.result.score.raw', presence: 'included' }] };
    const r = validates(S('scored'), [loose, strict]);
    expect(r.outcome).toBe('invalid');
    expect(r.templates).toEqual([strict.id]);
    expect(r.findings[0]).toMatchObject({ template: strict.id, location: '$.result.score.raw' });
  });

  it('decides presence, any, all and none as the pseudocode does', () => {
    const rule = (r: Json) => (s: Json) => follows_rule(s, r);
    const absent = S('x'), yes = S('x', { result: { success: true } }), no = S('x', { result: { success: false } });
    // No presence stated: an absent location fails any, and passes all and none.
    expect(rule({ location: '$.result.success', any: [true] })(absent)).toBe(false);
    expect(rule({ location: '$.result.success', all: [true] })(absent)).toBe(true);
    expect(rule({ location: '$.result.success', none: [true] })(absent)).toBe(true);
    // recommended: the value checks apply only when there is a value.
    expect(rule({ location: '$.result.success', presence: 'recommended', any: [true] })(absent)).toBe(true);
    expect(rule({ location: '$.result.success', presence: 'recommended', any: [true] })(no)).toBe(false);
    expect(rule({ location: '$.result.success', presence: 'included' })(absent)).toBe(false);
    expect(rule({ location: '$.result.success', presence: 'excluded' })(yes)).toBe(false);
    expect(rule({ location: '$.result.success', presence: 'excluded' })(absent)).toBe(true);
    expect(rule({ location: '$.result.success', all: [true] })(no)).toBe(false);
    expect(rule({ location: '$.result.success', none: [false] })(no)).toBe(false);
    expect(rule({ location: '$.result.success', any: [true, false] })(no)).toBe(true);
  });

  it('applies a selector to each located value, and an empty selection is unmatchable', () => {
    const s = S('x', { context: { contextActivities: { grouping: [{ id: 'g1', definition: { type: 'T' } }, { id: 'g2' }] } } });
    const located = { location: '$.context.contextActivities.grouping[*]', selector: '$.definition.type' };
    // g2 has no type: unmatchable. included and all fail on it; any does not.
    expect(follows_rule(s, { ...located, presence: 'included' })).toBe(false);
    expect(follows_rule(s, { ...located, all: ['T'] })).toBe(false);
    expect(follows_rule(s, { ...located, any: ['T'] })).toBe(true);
    // excluded is broken only by a matchable value.
    const none = S('x', { context: { contextActivities: { grouping: [{ id: 'g2' }] } } });
    expect(follows_rule(none, { ...located, presence: 'excluded' })).toBe(true);
    expect(follows_rule(s, { ...located, presence: 'excluded' })).toBe(false);
  });

  it('checks a StatementRef template when the statement referred to is available, and skips it when not', () => {
    const base = T('answered'), commented = T('commented', { objectStatementRefTemplate: [base.id] });
    const first = { ...S('answered'), id: '11111111-1111-4111-8111-111111111111' };
    const about = (id: string) => S('commented', { object: { objectType: 'StatementRef', id } });
    const all = [base, commented], lookup = { statementById: (id: string) => id === first.id ? first : undefined };
    expect(validates(about(first.id as string), all, lookup).outcome).toBe('success');
    // Not available: the check is skipped and reported, as the algorithm says.
    const skipped = validates(about(first.id as string), all);
    expect(skipped.outcome).toBe('success');
    expect(skipped.skipped[0]).toContain('objectStatementRefTemplate');
    // Available, and it follows another template: invalid.
    const other = { ...S('commented', { object: { objectType: 'StatementRef', id: 'z' } }), id: '22222222-2222-4222-8222-222222222222' };
    expect(validates(about(other.id as string), all, { statementById: id => id === other.id ? other : undefined }).outcome).toBe('invalid');
    // The object is not a StatementRef at all: invalid.
    expect(validates(S('commented'), all).outcome).toBe('invalid');
    expect(follows_rules(S('commented'), commented, all)).toBe(false);
  });
});

describe('matches and follows', () => {
  const a = T('a'), b = T('b'), c = T('c'), templates = [a, b, c];
  const pat = (name: string, body: Json): Json => ({ id: `${P}/patterns/${name}`, type: 'Pattern', ...body });
  const judged = (...names: string[]): Judged[] => names.map(n => ({ statement: S(n), templates: [`${P}/templates/${n}`] }));
  const of = (patterns: Json[]) => elementsOf(templates, patterns);

  it('gives the outcomes of the specification\'s table', () => {
    const seq = pat('seq', { sequence: [a.id, b.id] });
    expect(matches(judged('a', 'b'), seq.id as string, of([seq]))).toEqual(['success', []]);
    expect(matches(judged('a', 'b', 'c'), seq.id as string, of([seq]))[0]).toBe('success');
    expect(matches(judged('a', 'b', 'c'), seq.id as string, of([seq]))[1]).toHaveLength(1);
    expect(matches(judged('a'), seq.id as string, of([seq]))).toEqual(['partial', []]);
    const from = judged('b', 'a');
    expect(matches(from, seq.id as string, of([seq]))).toEqual(['failure', from]);
  });

  it('matches repetition greedily, with no backtracking', () => {
    const many = pat('many', { oneOrMore: a.id }), any = pat('any', { zeroOrMore: a.id });
    const whole = pat('whole', { sequence: [many.id, b.id] }), opt = pat('opt', { optional: b.id });
    const ps = [many, any, whole, opt];
    expect(matches(judged('a', 'a', 'a', 'b'), whole.id as string, of(ps))).toEqual(['success', []]);
    expect(matches(judged('b'), many.id as string, of(ps))[0]).toBe('failure');
    expect(matches(judged('b'), any.id as string, of(ps))[0]).toBe('success');
    expect(matches(judged('b'), any.id as string, of(ps))[1]).toHaveLength(1);
    expect(matches([], opt.id as string, of(ps))).toEqual(['success', []]);
    expect(matches(judged('c'), opt.id as string, of(ps))[1]).toHaveLength(1);
    // Greedy: oneOrMore(a) takes every a, so a sequence wanting one more a after it cannot match.
    const greedy = pat('greedy', { sequence: [many.id, a.id] });
    expect(matches(judged('a', 'a'), greedy.id as string, of([...ps, greedy]))[0]).not.toBe('success');
  });

  it('takes the alternate that consumes the most', () => {
    const short = pat('short', { sequence: [a.id] }), long = pat('long', { sequence: [a.id, b.id] });
    const alt = pat('alt', { alternates: [short.id, long.id] });
    expect(matches(judged('a', 'b'), alt.id as string, of([short, long, alt]))).toEqual(['success', []]);
  });

  it('follows a profile when every statement validates and a primary pattern matches them all', () => {
    const run = pat('run', { primary: true, sequence: [a.id, pat('x', {}).id] });
    const bs = { id: `${P}/patterns/x`, type: 'Pattern', oneOrMore: b.id };
    const patterns = [run, bs];
    const at = (verb: string, t: string) => S(verb, { timestamp: t });
    // Given out of order: patterns are checked in timestamp order.
    const ok = follows([at('b', '2026-01-01T00:00:02Z'), at('a', '2026-01-01T00:00:01Z'), at('b', '2026-01-01T00:00:03Z')], templates, patterns);
    expect(ok).toMatchObject({ follows: true, pattern: run.id });
    const extra = follows([at('a', '2026-01-01T00:00:01Z'), at('b', '2026-01-01T00:00:02Z'), at('c', '2026-01-01T00:00:03Z')], templates, patterns);
    expect(extra.follows).toBe(false);
    expect(extra.reasons[0]).toContain('statement 3 of 3');
    const cut = follows([at('a', '2026-01-01T00:00:01Z')], templates, patterns);
    expect(cut.reasons[0]).toContain('end before the pattern does');
    const stranger = follows([at('a', '2026-01-01T00:00:01Z'), S('unknown', { id: 'u-1', timestamp: '2026-01-01T00:00:02Z' })], templates, patterns);
    expect(stranger.reasons[0]).toContain('u-1 matches no statement template');
    // A pattern that is not primary is not checked.
    expect(follows([at('b', '2026-01-01T00:00:01Z')], templates, [bs]).reasons[0]).toContain('no primary pattern');
  });

  it('orders by timestamp, then by place in the array', () => {
    const s = (id: string, t?: string) => ({ id, ...(t ? { timestamp: t } : {}) });
    expect(inOrder([s('late', '2026-01-02T00:00:00Z'), s('same-1', '2026-01-01T00:00:00Z'), s('same-2', '2026-01-01T00:00:00Z'), s('undated')]).map(x => x.id))
      .toEqual(['same-1', 'same-2', 'late', 'undated']);
  });

  it('stops on a pattern that refers to itself', () => {
    const loop = pat('loop', { primary: true, sequence: [`${P}/patterns/loop`] });
    expect(follows([S('a')], templates, [loop]).follows).toBe(false);
  });
});
