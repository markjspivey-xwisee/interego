/**
 * A profile that declares what an extension's value is holds a statement to it.
 *
 * The specification's algorithm reads templates and never a concept, so a profile can say "the
 * tide is a number" and a statement saying the tide is "high" still follows it. Found on the
 * deployed bridge on 2026-11-17: /validate_templates answered 204 for exactly that statement.
 *
 * Here: the same statement is refused, by the server and by the lint over an example; what the
 * reader does not read is named and never passed off as checked; and a pattern that could stall
 * the server is not run.
 */
import { describe, it, expect } from 'vitest';
import { ProfileServer } from '../src/xapi-profile-server/service.js';
import { lintProfile } from '../src/xapi-profile-server/lint.js';
import { checkValue, extensionValues, isPlainPattern, schemaFailure } from '../src/xapi-profile-server/extension-schema.js';
import { schemaFailure as xapixSchemaFailure } from '../src/xapix/lint.js';
import { builtInKept, builtInProfiles } from '../src/xapi-profile-server/built-in.js';
import type { Json as PJson } from '../src/xapi-profile-server/processor.js';
import type { Json } from '../src/xapi-profile-server/rdf.js';

type Obj = { [key: string]: Json };
const P = 'https://bridge.example/xapi/profiles/p/tidepool', V = `${P}/v/1`;
const lang = (en: string) => ({ en });
const TIDE = `${P}/ext/tide`, DEPTH = `${P}/ext/depth`, NOTE = `${P}/ext/note`, ELSEWHERE = `${P}/ext/elsewhere`;
const pool = `${P}/activity-types/pool`;
const doc = (tideSchema: string | null = '{"type":"number","minimum":0}'): Obj => ({
  '@context': 'https://w3id.org/xapi/profiles/context', id: P, type: 'Profile', conformsTo: 'https://w3id.org/xapi/profiles#1.0',
  prefLabel: lang('Tidepool survey'), definition: lang('A made-up profile about counting crabs.'),
  author: { type: 'Organization', name: 'Fictional Shoreline Society' },
  versions: [{ id: V, generatedAtTime: '2026-11-17T00:00:00.000Z' }],
  concepts: [
    { id: `${P}/verbs/counted`, type: 'Verb', inScheme: V, prefLabel: lang('counted'), definition: lang('A surveyor counted the crabs in a pool.') },
    { id: pool, type: 'ActivityType', inScheme: V, prefLabel: lang('pool'), definition: lang('A tide pool that is surveyed.') },
    { id: TIDE, type: 'ContextExtension', inScheme: V, prefLabel: lang('tide'), definition: lang('Tide height in metres.'), ...(tideSchema === null ? {} : { inlineSchema: tideSchema }) },
    { id: DEPTH, type: 'ActivityExtension', inScheme: V, prefLabel: lang('depth'), definition: lang('Depth of the pool in centimetres.'), inlineSchema: '{"type":"integer"}' },
    { id: NOTE, type: 'ResultExtension', inScheme: V, prefLabel: lang('note'), definition: lang('A note.'), inlineSchema: '{"type":"string","contentEncoding":"base64"}' },
    { id: ELSEWHERE, type: 'ResultExtension', inScheme: V, prefLabel: lang('elsewhere'), definition: lang('Described elsewhere.'), schema: 'https://example.org/schemas/elsewhere.json' },
  ],
  templates: [{ id: `${P}/templates/count`, type: 'StatementTemplate', inScheme: V, prefLabel: lang('count'), definition: lang('One count.'),
    verb: `${P}/verbs/counted`, objectActivityType: pool, rules: [{ location: `$.context.extensions['${TIDE}']`, presence: 'included' }] }],
  patterns: [{ id: `${P}/patterns/survey`, type: 'Pattern', inScheme: V, primary: true, prefLabel: lang('survey'), definition: lang('One or more counts.'), oneOrMore: `${P}/templates/count` }],
});
const counted = (tide: Json, more: { result?: Obj; depth?: Json } = {}): PJson => ({
  actor: { mbox: 'mailto:fictional-surveyor@example.org' }, verb: { id: `${P}/verbs/counted` },
  object: { id: `${P}/pools/north`, definition: { type: pool, ...(more.depth === undefined ? {} : { extensions: { [DEPTH]: more.depth } }) } },
  context: { extensions: { [TIDE]: tide } }, ...(more.result ? { result: more.result } : {}),
});
const serverOf = (profile: Obj) => new ProfileServer({ builtIn: () => [profile], persist: async () => ({ persisted: true }), hydrate: async () => [], isOperator: () => false });

describe('the server holds a statement to the schema its profile declares', () => {
  const server = serverOf(doc());

  it('accepts a value the schema allows', async () => {
    expect(await server.validateTemplates(counted(0.4), V)).toMatchObject({ comments: [], templates: [`${P}/templates/count`] });
  });

  it('★ refuses the statement the deployed bridge accepted: the tide as text', async () => {
    const r = await server.validateTemplates(counted('high'), V);
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toContain(TIDE);
    expect(r.comments[0]).toContain(`$.context.extensions['${TIDE}']`);
    expect(r.comments[0]).toContain('the value is a string, and the schema asks for number');
  });

  it('reads more of the schema than its type', async () => {
    expect((await server.validateTemplates(counted(-1), V)).comments[0]).toContain('the value is less than 0');
  });

  it('reads an extension on the object activity too', async () => {
    expect((await server.validateTemplates(counted(0.4, { depth: 30 }), V)).comments).toEqual([]);
    expect((await server.validateTemplates(counted(0.4, { depth: 30.5 }), V)).comments[0]).toContain(`$.object.definition.extensions['${DEPTH}']`);
  });

  it('reports a broken rule and a wrong value together', async () => {
    const noTide = { ...counted(0.4, { depth: 'deep' }), context: {} };
    expect((await server.validateTemplates(noTide, V)).comments).toHaveLength(2);
  });

  it('leaves alone an extension the profile does not declare: it is another profile\'s', async () => {
    const withStranger = counted(0.4, { result: { extensions: { 'https://elsewhere.example/ext/anything': { any: 'thing' } } } });
    expect(await server.validateTemplates(withStranger, V)).toMatchObject({ comments: [], skipped: [] });
  });

  it('names what it did not read, and does not fail a value on it', async () => {
    const r = await server.validateTemplates(counted(0.4, { result: { extensions: { [NOTE]: 'aGk=', [ELSEWHERE]: 1 } } }), V);
    expect(r.comments).toEqual([]);
    expect(r.skipped).toEqual([`${NOTE}: the keyword "contentEncoding"`, `${ELSEWHERE}: its schema is at https://example.org/schemas/elsewhere.json, which this server does not fetch`]);
  });

  it('refuses a run whose statements each follow a template and one carries a wrong value', async () => {
    expect(await server.validatePatterns([counted(0.4), counted(0.5)], V)).toEqual({ comments: [], pattern: `${P}/patterns/survey` });
    const r = await server.validatePatterns([counted(0.4), counted('high')], V);
    expect(r.pattern).toBeUndefined();
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]).toMatch(/^statement at position 1: /);
  });

  it('a profile that declares no schema judges as the algorithm alone does', async () => {
    expect((await serverOf(doc(null)).validateTemplates(counted('high'), V)).comments).toEqual([]);
  });
});

describe('the lint holds an example to the same schema', () => {
  const example = (tide: Json) => ({ statements: [{ id: 'a-count', follows: [`${P}/templates/count`], statement: counted(tide) }],
    sequences: [{ id: 'a-visit', pattern: `${P}/patterns/survey`, statements: ['a-count'] }] });

  it('has nothing to say when the example agrees with the schema', () => {
    expect(lintProfile(doc(), example(0.4))).toEqual([]);
  });

  it('★ says so when the example does not, and does not count it as the template\'s example', () => {
    const codes = lintProfile(doc(), example('high')).map(f => f.code);
    expect(codes).toContain('example-extension-value');
    expect(codes).toContain('template-example');
  });
});

describe('the part of JSON Schema that is read', () => {
  const fails = (value: unknown, schema: unknown) => checkValue(value, schema).failure;

  it.each([
    [1, { type: 'integer' }, null], [1.5, { type: 'integer' }, 'is a number, and the schema asks for integer'],
    [null, { type: ['string', 'null'] }, null], [3, { type: ['string', 'null'] }, 'is a number, and the schema asks for string or null'],
    ['b', { enum: ['a', 'b'] }, null], ['c', { enum: ['a', 'b'] }, 'is not one of ["a","b"]'],
    [{ a: 1 }, { const: { a: 1 } }, null], [2, { const: 1 }, 'is not 1'],
    [1, { maximum: 1 }, null], [1, { exclusiveMaximum: 1 }, 'is not less than 1'], [0, { exclusiveMinimum: 0 }, 'is not more than 0'],
    ['ab', { minLength: 2, maxLength: 2 }, null], ['abc', { maxLength: 2 }, 'is 3 characters long, and the schema asks for at most 2'],
    ['urn:x:y', { format: 'iri' }, null], ['not an iri', { format: 'iri' }, 'is not an IRI'],
    [['a'], { type: 'array', items: { type: 'string' }, minItems: 1 }, null], [['a', 2], { items: { type: 'string' } }, 'item 1 is a number, and the schema asks for string'],
    [[], { minItems: 1 }, 'has 0 items, and the schema asks for at least 1'], [[1, 2], { maxItems: 1 }, 'has 2 items, and the schema asks for at most 1'],
    [{ n: 1 }, { required: ['n'], properties: { n: { type: 'number' } } }, null], [{}, { required: ['n'] }, 'has no "n", which the schema requires'],
    [{ n: 'x' }, { properties: { n: { type: 'number' } } }, '"n" is a string, and the schema asks for number'],
    [{ b: 2, a: 1 }, { const: { a: 1, b: 2 } }, null], [{ b: [2, 1], a: 1 }, { enum: [{ a: 1, b: [1, 2] }] }, 'is not one of [{"a":1,"b":[1,2]}]'],
    [{}, { required: ['constructor'] }, 'has no "constructor", which the schema requires'], [{}, { properties: { constructor: { type: 'string' }, toString: { type: 'number' } } }, null],
    ['anything', true, null], ['anything', false, 'is not allowed: the schema allows no value'],
  ] as Array<[unknown, unknown, string | null]>)('%j against %j', (value, schema, expected) => {
    expect(fails(value, schema)).toBe(expected);
  });

  it('names a keyword it does not read, wherever it sits, and an annotation is not one', () => {
    expect(checkValue([{ a: 1 }], { title: 'things', items: { properties: { a: { multipleOf: 2 } } }, uniqueItems: true }).unchecked.sort())
      .toEqual(['the keyword "multipleOf"', 'the keyword "uniqueItems"']);
    expect(checkValue('x', { format: 'email' }).unchecked).toEqual(['the format "email"']);
  });

  it('does not follow a schema down without end', () => {
    let schema: Record<string, unknown> = { type: 'number' };
    let value: unknown = 'not a number';
    for (let i = 0; i < 40; i++) { schema = { items: schema }; value = [value]; }
    const r = checkValue(value, schema);
    expect(r.failure).toBeNull();
    expect(r.unchecked).toEqual(['a schema nested more than 16 deep']);
  });
});

describe('a pattern is run only when it cannot run away', () => {
  it.each(['^[0-9a-f]{8}-[0-9a-f]{4}$', '^sha256:[a-f0-9]{64}$', '^[a-f0-9]{64}$', '^ab{1,3}$', '^colou?r$', '^[+*()?]{2}$', 'yes|no'])('runs %s', pattern => {
    expect(isPlainPattern(pattern)).toBe(true);
  });
  it.each(['^(a+)+$', 'a*', 'a+', '(a|aa){2}', 'a{2,}', 'a{1,5000}', '(.)\\1', '[unclosed', 'x'.repeat(600), '^a?b{1,3}$', 'a?a?', '^' + 'a{0,100}'.repeat(20) + 'b$'])('does not run %s', pattern => {
    expect(isPlainPattern(pattern)).toBe(false);
  });

  it('holds a value to a plain pattern', () => {
    expect(checkValue('abc', { pattern: '^[a-f0-9]{64}$' }).failure).toBe('does not match ^[a-f0-9]{64}$');
    expect(checkValue('a'.repeat(64), { pattern: '^[a-f0-9]{64}$' })).toEqual({ failure: null, unchecked: [] });
  });

  it('★ answers at once for the pattern and value that would stall it, and says the pattern was not run', () => {
    const started = Date.now();
    const r = checkValue('a'.repeat(40) + '!', { pattern: '^(a+)+$' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(r).toEqual({ failure: null, unchecked: ['the pattern ^(a+)+$, which this server does not run'] });
  });

  it('★ answers at once for bounded repetitions that overlap, which a review of this change found still stalled it', () => {
    const started = Date.now();
    const r = checkValue('a'.repeat(100) + '!', { pattern: '^' + 'a{0,100}'.repeat(20) + 'b$' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(r.failure).toBeNull();
    expect(r.unchecked).toHaveLength(1);
    // And the one varying count that is allowed, at its largest, against the longest value that is read.
    const worst = Date.now();
    expect(checkValue('a'.repeat(4096), { pattern: '^[ab]{0,1000}c$' }).failure).toBe('does not match ^[ab]{0,1000}c$');
    expect(Date.now() - worst).toBeLessThan(500);
  });

  it('does not run even a plain pattern over a very long value', () => {
    expect(checkValue('a'.repeat(5000), { pattern: '^[a-f]{2}$' }).unchecked).toHaveLength(1);
  });
});

describe('what is already published is still read the same way', () => {
  it('the xapi-x lint reads values with the same function', () => {
    expect(xapixSchemaFailure).toBe(schemaFailure);
    expect(xapixSchemaFailure('x', { type: 'boolean' })).toBe('is a string, and the schema asks for boolean');
  });

  it('★ every pattern a built-in profile declares is one that is run', () => {
    const patterns: string[] = [];
    const walk = (schema: unknown): void => {
      if (Array.isArray(schema)) { schema.forEach(walk); return; }
      if (!schema || typeof schema !== 'object') return;
      for (const [key, value] of Object.entries(schema)) { if (key === 'pattern' && typeof value === 'string') patterns.push(value); else walk(value); }
    };
    for (const profile of builtInProfiles() as Obj[]) for (const concept of (profile.concepts ?? []) as Obj[])
      if (typeof concept.inlineSchema === 'string') walk(JSON.parse(concept.inlineSchema));
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.filter(p => !isPlainPattern(p))).toEqual([]);
  });

  it('★ every example a built-in profile is kept with agrees with the schemas that profile declares', () => {
    const profiles = builtInProfiles() as Obj[];
    let read = 0;
    for (const kept of builtInKept()) {
      const profile = profiles.find(p => p.id === kept.profile || (p.versions as Obj[] | undefined)?.some(v => v.id === kept.profile));
      expect(profile, kept.profile).toBeDefined();
      for (const example of kept.examples.statements) {
        read++;
        expect(extensionValues(example.statement, (profile!.concepts ?? []) as unknown as PJson[]).findings, `${kept.profile} ${example.id}`).toEqual([]);
      }
    }
    expect(read).toBeGreaterThan(0);
  });
});
