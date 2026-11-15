/**
 * A profile's patterns were reported as not checked: one statement cannot show an order. The
 * statements of one registration can now be sent together and read against the primary patterns
 * of a profile sent with them. On demand only; nothing here refuses a statement the LRS keeps.
 */
import { describe, it, expect } from 'vitest';
import {
  answerSuppliedProfileRequest, validatePatternsAgainstSuppliedProfile, whyNotARegistration, whyNotPatterns,
} from '../src/xapi-profile-patterns.js';

const P = 'https://example.org/profiles/phone-roleplay';
const T = (name: string) => `${P}/templates/${name}`;
const CRITERIA = ['empathy', 'discovery', 'accuracy', 'resolution', 'professionalism'];
const REG = '00000000-0000-4000-8000-000000000001';

const simple = (name: string) => ({ id: T(name), type: 'StatementTemplate', verb: `${P}/verbs/${name}` });
const profile = {
  id: P, type: 'Profile',
  templates: [
    simple('initialized'), simple('consented'), simple('completed'), simple('terminated'),
    ...CRITERIA.map(c => ({ id: T(`scored-${c}`), type: 'StatementTemplate', verb: `${P}/verbs/scored`,
      rules: [{ location: `$.object.definition.extensions['${P}/ext/criterion']`, any: [c] }] })),
  ],
  patterns: [
    { id: `${P}/patterns/rubric`, type: 'Pattern', sequence: CRITERIA.map(c => T(`scored-${c}`)) },
    { id: `${P}/patterns/attempt`, type: 'Pattern', primary: true,
      sequence: [T('initialized'), T('consented'), `${P}/patterns/rubric`, T('completed'), T('terminated')] },
  ],
};

let clock = 0;
const statement = (verb: string, criterion?: string) => ({
  id: `00000000-0000-4000-8000-0000000001${String(clock).padStart(2, '0')}`,
  actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
  verb: { id: `${P}/verbs/${verb}` },
  object: { id: `${P}/things/${criterion ?? verb}`, definition: criterion ? { extensions: { [`${P}/ext/criterion`]: criterion } } : {} },
  context: { registration: REG },
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, clock++)).toISOString(),
});
const attempt = () => [statement('initialized'), statement('consented'), ...CRITERIA.map(c => statement('scored', c)), statement('completed'), statement('terminated')];
const check = (statements: Array<Record<string, unknown>>, p: Record<string, unknown> = profile) => validatePatternsAgainstSuppliedProfile(statements, p);

describe('a registration is checked against the patterns of a profile you bring', () => {
  it('follows the primary pattern when the whole attempt is in the order it asks for', () => {
    const r = check(attempt());
    expect(r).toMatchObject({ profile: P, registration: REG, orderedBy: 'timestamp', verdict: 'conformant', conforms: true, notChecked: [] });
    expect(r.patterns).toEqual([{ pattern: `${P}/patterns/attempt`, verdict: 'followed', statementsRead: 9 }]);
    expect(r.statements.map(s => s.matchedTemplates[0])).toEqual([T('initialized'), T('consented'), ...CRITERIA.map(c => T(`scored-${c}`)), T('completed'), T('terminated')]);
  });

  it('says where the run stops when two criteria are out of order', () => {
    const a = attempt();
    // Swap what the third and fourth statements score, keeping their timestamps.
    [a[2]!.object, a[3]!.object] = [a[3]!.object, a[2]!.object];
    const r = check(a);
    expect(r).toMatchObject({ verdict: 'non-conformant', conforms: false });
    expect(r.patterns).toEqual([{ pattern: `${P}/patterns/attempt`, verdict: 'not-followed', statementsRead: 2, stoppedAt: 2 }]);
    // Every statement still follows a template: the order is what is wrong.
    expect(r.statements.every(s => s.matchedTemplates.length === 1)).toBe(true);
  });

  it('tells a missing statement from one too many', () => {
    const short = check(attempt().slice(0, 8));
    expect(short.patterns[0]).toEqual({ pattern: `${P}/patterns/attempt`, verdict: 'not-followed', statementsRead: 8, stoppedAt: 'end' });
    const long = check([...attempt(), statement('terminated')]);
    expect(long.patterns[0]).toMatchObject({ verdict: 'not-followed', statementsRead: 9, stoppedAt: 9 });
    const stray = attempt(); stray.splice(4, 0, { ...statement('consented'), timestamp: stray[3]!.timestamp });
    expect(check(stray.map((s, i) => ({ ...s, timestamp: new Date(Date.UTC(2027, 0, 1, 0, 0, i)).toISOString() }))).patterns[0]).toMatchObject({ verdict: 'not-followed', stoppedAt: 4 });
  });

  it('reads the statements in timestamp order whatever order they are sent in, and says so', () => {
    const a = attempt();
    const r = check([...a].reverse());
    expect(r).toMatchObject({ orderedBy: 'timestamp', verdict: 'conformant' });
    expect(r.statements.map(s => s.sent)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0]);
    // Equal timestamps keep the order sent, and the answer names that.
    const tied = check(a.map(s => ({ ...s, timestamp: '2026-01-01T12:00:00.000Z' })));
    expect(tied.verdict).toBe('conformant');
    expect(tied.notChecked.some(n => n.startsWith('order:') && n.includes('equal timestamps'))).toBe(true);
    // Without timestamps the order sent is all there is.
    const bare = check([...a].reverse().map(({ timestamp: _t, ...s }) => s));
    expect(bare).toMatchObject({ orderedBy: 'as-sent', verdict: 'non-conformant' });
    expect(bare.notChecked.some(n => n.startsWith('order:'))).toBe(true);
  });

  it('orders by the whole timestamp, past the millisecond', () => {
    const a = attempt();
    // Nine instants a tenth of a millisecond apart, sent backwards: all within one millisecond.
    const fine = a.map((s, i) => ({ ...s, timestamp: `2026-01-01T12:00:00.000${i + 1}Z` }));
    const r = check([...fine].reverse());
    expect(r).toMatchObject({ orderedBy: 'timestamp', verdict: 'conformant', notChecked: [] });
    // Trailing zeros and an offset do not make two spellings of one instant differ.
    const same = check(a.map((s, i) => ({ ...s, timestamp: i % 2 ? '2026-01-01T12:00:00.1000Z' : '2026-01-01T13:00:00.1+01:00' })));
    expect(same.verdict).toBe('conformant');
    expect(same.notChecked.some(n => n.includes('equal timestamps'))).toBe(true);
  });

  it('reads a long run through a repeat whose readings overlap without stalling', () => {
    const many = (count: number) => Array.from({ length: count }, () => T('a'));
    const overlapping = { id: P, templates: [simple('a')], patterns: [
      { id: `${P}/patterns/top`, primary: true, oneOrMore: `${P}/patterns/either` },
      { id: `${P}/patterns/either`, alternates: [`${P}/patterns/nine`, `${P}/patterns/ten`] },
      { id: `${P}/patterns/nine`, sequence: many(9) }, { id: `${P}/patterns/ten`, sequence: many(10) },
    ] };
    const started = Date.now();
    const r = check(Array.from({ length: 1000 }, () => statement('a')), overlapping);
    expect(r.verdict).toBe('conformant');
    // 1000 is 100 tens. Seventeen is neither nines nor tens.
    expect(check(Array.from({ length: 17 }, () => statement('a')), overlapping).verdict).toBe('non-conformant');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reads alternates, optional, oneOrMore and zeroOrMore', () => {
    const lettered = (patterns: unknown[]) => ({ id: P, templates: ['a', 'b', 'c'].map(simple), patterns });
    const run = (letters: string, patterns: unknown[]) => check([...letters].map(l => statement(l)), lettered(patterns)).verdict === 'conformant';
    const top = (body: Record<string, unknown>) => ({ id: `${P}/patterns/top`, primary: true, ...body });
    // a, then b or c any number of times, then an optional a.
    const patterns = [
      top({ sequence: [T('a'), `${P}/patterns/many`, `${P}/patterns/maybe`] }),
      { id: `${P}/patterns/many`, zeroOrMore: `${P}/patterns/either` },
      { id: `${P}/patterns/either`, alternates: [T('b'), T('c')] },
      { id: `${P}/patterns/maybe`, optional: { '@id': T('a') } },
    ];
    for (const yes of ['a', 'aa', 'ab', 'abcbca', 'acccc']) expect(run(yes, patterns), yes).toBe(true);
    for (const no of ['b', 'aaa', 'aba' + 'b', 'ba']) expect(run(no, patterns), no).toBe(false);
    const plus = [top({ oneOrMore: T('a') })];
    expect(run('a', plus)).toBe(true); expect(run('aaaa', plus)).toBe(true); expect(run('ab', plus)).toBe(false);
    // A repeat of something that may read nothing still ends.
    const idle = [top({ oneOrMore: `${P}/patterns/maybe` }), { id: `${P}/patterns/maybe`, optional: T('a') }];
    expect(run('aaa', idle)).toBe(true); expect(run('ab', idle)).toBe(false);
  });

  it('is satisfied when any one primary pattern is followed, and checks only primary ones', () => {
    const two = { ...profile, patterns: [...profile.patterns, { id: `${P}/patterns/abandoned`, primary: true, sequence: [T('initialized'), T('terminated')] }] };
    const r = check(attempt(), two);
    expect(r.verdict).toBe('conformant');
    expect(r.patterns.map(p => p.verdict)).toEqual(['followed', 'not-followed']);
    expect(check([statement('initialized'), statement('terminated')], two).patterns.map(p => p.verdict)).toEqual(['not-followed', 'followed']);
    const none = check(attempt(), { ...profile, patterns: [profile.patterns[0]!] });
    expect(none).toMatchObject({ verdict: 'no-primary-pattern', conforms: false, patterns: [] });
    expect(none.notChecked.some(n => n.includes('no primary pattern'))).toBe(true);
  });

  it('does not call a run conformant when it fits only through a template checked in part', () => {
    const partly = { ...profile, templates: profile.templates.map(t => t.id === T('consented')
      ? { ...t, rules: [{ location: '$.result', selector: '$.x', presence: 'included' }] } : t) };
    const r = check(attempt(), partly);
    expect(r).toMatchObject({ verdict: 'not-fully-checked', conforms: false });
    expect(r.patterns[0]).toMatchObject({ verdict: 'not-fully-checked' });
    expect(r.statements[1]).toMatchObject({ matchedTemplates: [], partiallyCheckedTemplates: [T('consented')] });
    expect(r.notChecked.some(n => n.includes('selector'))).toBe(true);
    // A run that is wrong whichever way the partial template falls is still wrong.
    expect(check(attempt().slice(0, 5), partly).verdict).toBe('non-conformant');
    // A pattern naming a template the profile lacks is not evaluated there, and says so.
    const foreign = { ...profile, patterns: [{ id: `${P}/patterns/f`, primary: true, sequence: [T('initialized'), 'https://example.org/elsewhere/template'] }] };
    const f = check([statement('initialized'), statement('consented')], foreign);
    expect(f.verdict).toBe('not-fully-checked');
    expect(f.notChecked.some(n => n.includes('does not define'))).toBe(true);
  });

  it('names a subregistration instead of reading across it silently', () => {
    const a = attempt().map(s => ({ ...s, context: { ...s.context, extensions: { 'https://w3id.org/xapi/profiles/extensions/subregistration': [{ profile: P, subregistration: REG }] } } }));
    expect(check(a).notChecked.some(n => n.startsWith('subregistrations'))).toBe(true);
  });

  it('refuses patterns and statement sets it cannot read', () => {
    expect(whyNotPatterns(profile)).toBeNull();
    expect(whyNotPatterns({ ...profile, patterns: [{ id: 'p', sequence: ['a'], alternates: ['b'] }] })).toMatch(/exactly one/);
    expect(whyNotPatterns({ ...profile, patterns: [{ id: 'p' }] })).toMatch(/exactly one/);
    expect(whyNotPatterns({ ...profile, patterns: [{ id: 'p', sequence: [] }] })).toMatch(/non-empty/);
    expect(whyNotPatterns({ ...profile, patterns: [{ id: 'p', optional: 7 }] })).toMatch(/by IRI/);
    expect(whyNotPatterns({ ...profile, patterns: [{ id: 'p', optional: 'q' }, { id: 'q', oneOrMore: 'p' }] })).toMatch(/contains itself/);
    expect(whyNotPatterns({ ...profile, patterns: [{ id: 'p', optional: 'a' }, { id: 'p', optional: 'b' }] })).toMatch(/more than once/);
    expect(whyNotARegistration(attempt())).toBeNull();
    expect(whyNotARegistration([])).toMatch(/non-empty/);
    expect(whyNotARegistration(Array.from({ length: 1001 }, () => ({})))).toMatch(/more than 1000/);
    const other = { ...statement('completed'), context: { registration: '00000000-0000-4000-8000-000000000002' } };
    expect(whyNotARegistration([...attempt(), other])).toMatch(/2 registrations/);
    expect(whyNotARegistration([...attempt(), { ...other, context: {} }])).toMatch(/some do not/);
  });

  it('answers the request the way the endpoint sends it', () => {
    const ok = answerSuppliedProfileRequest({ profile, statements: attempt() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, profileSource: 'supplied', checked: 'patterns', verdict: 'conformant', conforms: true });
    expect(answerSuppliedProfileRequest({ profile, statements: attempt(), instance: statement('completed') })).toMatchObject({ status: 400, body: { ok: false } });
    expect(answerSuppliedProfileRequest({ statements: attempt() })).toMatchObject({ status: 400, body: { ok: false, error: expect.stringMatching(/profile/) } });
    expect(answerSuppliedProfileRequest({ profile, statements: [] })).toMatchObject({ status: 400 });
    // One statement, as before: a template verdict, with the patterns named as not checked.
    const one = answerSuppliedProfileRequest({ profile, instance: statement('completed') });
    expect(one).toMatchObject({ status: 200, body: { ok: true, profileSource: 'supplied', verdict: 'conformant', conforms: true, matchedTemplates: [T('completed')] } });
    expect((one.body.notChecked as string[]).some(n => n.startsWith('patterns:'))).toBe(true);
    expect(answerSuppliedProfileRequest({ profile })).toMatchObject({ status: 400 });
    // A template with only a selector rule: not a match, and not conformance.
    const selectorOnly = { id: P, templates: [{ id: T('s'), verb: `${P}/verbs/completed`, rules: [{ location: '$.result', selector: '$.x', presence: 'included' }] }] };
    expect(answerSuppliedProfileRequest({ profile: selectorOnly, statement: statement('completed') }).body)
      .toMatchObject({ verdict: 'not-fully-checked', conforms: false, matchedTemplates: [], partiallyCheckedTemplates: [T('s')] });
    expect(answerSuppliedProfileRequest({ profile: selectorOnly, statement: statement('consented') }).body).toMatchObject({ verdict: 'unknown-verb', conforms: false });
  });
});
