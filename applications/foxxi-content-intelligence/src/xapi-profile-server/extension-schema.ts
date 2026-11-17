/**
 * An extension's value against the schema its concept declares.
 *
 * ★ WHY THIS IS NOT IN ./processor.ts. The specification's algorithm (Part Three, section 2) never
 * reads a concept: a statement follows a profile by its templates' determining properties and
 * rules alone. So a profile can declare that an extension is a number, and a statement carrying
 * text there still follows it. The processor stays the pseudocode, branch for branch; this is what
 * the server checks beside it, and it says so in its answer rather than calling it the algorithm.
 *
 * ★ WHAT IS READ, AND WHAT IS SAID WHEN IT IS NOT. A schema here is someone else's document, read
 * on a route anyone may call. This reads a bounded part of JSON Schema and no more:
 *
 *   type (one or a list), enum, const, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   minLength, maxLength, format: iri, pattern (plain ones, see below), items, minItems, maxItems,
 *   properties, required
 *
 * A keyword outside that list is not guessed at: it is named in `unchecked`, so a caller is told
 * the value was not held to it. The same for a schema given as an IRI (`schema`), which is not
 * fetched.
 *
 * ★ A PATTERN IS RUN ONLY WHEN IT CANNOT RUN AWAY. A regular expression from a stranger's profile,
 * applied to a stranger's statement, is the textbook way to stall a server. A pattern is run when
 * it has no group, no `*`, no `+`, no backreference, no open-ended `{n,}` and at most one
 * repetition of a varying count (`?` or `{n,m}`), and the value is short: exact counts do not
 * backtrack, and one varying count is bounded by itself. Any other pattern is named in `unchecked`.
 */
import type { Json } from './processor.js';

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const isIri = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(v);
/** JSON equality: an object's members in any order, an array's in the order given. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => has(b, k) && same(a[k], b[k]));
}
/** A member the JSON document has, not one every object inherits (`constructor`, `toString`). */
const has = (o: Json, name: string): boolean => Object.prototype.hasOwnProperty.call(o, name);

/** Keywords that describe a schema and ask nothing of a value. */
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
const READ = new Set(['type', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
  'format', 'pattern', 'items', 'minItems', 'maxItems', 'properties', 'required']);

const MAX_PATTERN_LENGTH = 512, MAX_PATTERNED_VALUE = 4096, MAX_DEPTH = 16;

/** Whether a pattern is one this server runs: nothing in it repeats without a bound. */
export function isPlainPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  // Read with escapes and classes taken out, so `\(` and `[+*]` do not count against it.
  let bare = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') { if (/[1-9k]/.test(pattern[i + 1] ?? '')) return false; i++; continue; }
    if (ch === '[') {
      let j = i + 1;
      for (; j < pattern.length && pattern[j] !== ']'; j++) if (pattern[j] === '\\') j++;
      if (j >= pattern.length) return false;
      i = j; continue;
    }
    bare += ch;
  }
  if (/[()*+]/.test(bare)) return false;
  // A repetition of a varying count (`?`, `{n,m}`) is where backtracking starts, and several of
  // them over the same characters multiply: twenty `a{0,100}` in a row do not finish. One is
  // allowed, which is bounded by its own count; exact counts (`{8}`) never backtrack.
  let varying = (bare.match(/\?/g) ?? []).length;
  for (const bound of bare.matchAll(/\{(\d*)(,?)(\d*)\}/g)) {
    const [, low, comma, high] = bound;
    if (comma && high === '') return false;
    if (Number(high || low) > 1000) return false;
    if (comma) varying++;
  }
  if (varying > 1) return false;
  try { new RegExp(pattern); return true; } catch { return false; }
}

export interface SchemaCheck {
  /** Why the value is not one the schema allows, or null when nothing read says so. */
  failure: string | null;
  /** What the schema asks that was not read, and so not held against the value. */
  unchecked: string[];
}

const kindOf = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const article = (kind: string): string => kind === 'object' ? 'an object' : kind === 'array' ? 'an array' : kind === 'null' ? 'null' : `a ${kind}`;
const isType = (value: unknown, type: unknown): boolean => type === kindOf(value) || (type === 'integer' && typeof value === 'number' && Number.isInteger(value));

function check(value: unknown, schema: unknown, unchecked: Set<string>, depth: number): string | null {
  if (schema === false) return 'is not allowed: the schema allows no value';
  if (!isObject(schema)) return null;
  if (depth > MAX_DEPTH) { unchecked.add('a schema nested more than 16 deep'); return null; }
  for (const key of Object.keys(schema)) if (!READ.has(key) && !ANNOTATIONS.has(key)) unchecked.add(`the keyword "${key}"`);

  if (Array.isArray(schema.enum) && !schema.enum.some(e => same(e, value))) return `is not one of ${JSON.stringify(schema.enum)}`;
  if (has(schema, 'const') && !same(schema.const, value)) return `is not ${JSON.stringify(schema.const)}`;
  const types = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  if (types.length && !types.some(t => isType(value, t))) return `is ${article(kindOf(value))}, and the schema asks for ${types.join(' or ')}`;

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `is less than ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `is more than ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return `is not more than ${schema.exclusiveMinimum}`;
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return `is not less than ${schema.exclusiveMaximum}`;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) return `is ${length} characters long, and the schema asks for at least ${schema.minLength}`;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return `is ${length} characters long, and the schema asks for at most ${schema.maxLength}`;
    if (schema.format === 'iri') { if (!isIri(value)) return 'is not an IRI'; }
    else if (schema.format !== undefined) unchecked.add(`the format ${JSON.stringify(schema.format)}`);
    if (typeof schema.pattern === 'string') {
      if (!isPlainPattern(schema.pattern)) unchecked.add(`the pattern ${schema.pattern.slice(0, 80)}, which this server does not run`);
      else if (value.length > MAX_PATTERNED_VALUE) unchecked.add(`the pattern ${schema.pattern.slice(0, 80)}, on a value longer than ${MAX_PATTERNED_VALUE} characters`);
      else if (!new RegExp(schema.pattern).test(value)) return `does not match ${schema.pattern}`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `has ${value.length} items, and the schema asks for at least ${schema.minItems}`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `has ${value.length} items, and the schema asks for at most ${schema.maxItems}`;
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) unchecked.add('"items" given as a list');
      else for (const [i, item] of value.entries()) { const inner = check(item, schema.items, unchecked, depth + 1); if (inner) return `item ${i} ${inner}`; }
    }
  }
  if (isObject(value)) {
    for (const name of Array.isArray(schema.required) ? schema.required : []) if (typeof name === 'string' && !has(value, name)) return `has no "${name}", which the schema requires`;
    if (isObject(schema.properties)) for (const [name, inner] of Object.entries(schema.properties)) {
      if (!has(value, name)) continue;
      const why = check(value[name], inner, unchecked, depth + 1);
      if (why) return `"${name}" ${why}`;
    }
  }
  return null;
}

/** One value against one schema (a parsed JSON Schema: an object, or true or false). */
export function checkValue(value: unknown, schema: unknown): SchemaCheck {
  const unchecked = new Set<string>();
  const failure = check(value, schema, unchecked, 0);
  return { failure, unchecked: [...unchecked] };
}

/** `checkValue`'s failure alone: the sentence that follows "The value …", or null. */
export function schemaFailure(value: unknown, schema: unknown): string | null { return checkValue(value, schema).failure; }

const EXTENSION_TYPES = ['ContextExtension', 'ResultExtension', 'ActivityExtension'];

export interface ExtensionFinding { extension: string; location: string; reason: string }
export interface ExtensionsResult {
  /** A declared extension whose value its schema does not allow. */
  findings: ExtensionFinding[];
  /** What was not held against a value, and why. */
  unchecked: string[];
}

/** Every place a statement carries extensions, with where it is. */
function extensionsIn(statement: Json): Array<{ location: string; extensions: Json }> {
  const out: Array<{ location: string; extensions: Json }> = [];
  const add = (location: string, holder: unknown) => { if (isObject(holder) && isObject(holder.extensions)) out.push({ location: `${location}.extensions`, extensions: holder.extensions }); };
  add('$.result', statement.result);
  add('$.context', statement.context);
  if (isObject(statement.object)) add('$.object.definition', statement.object.definition);
  const activities = isObject(statement.context) && isObject(statement.context.contextActivities) ? statement.context.contextActivities : {};
  for (const [where, value] of Object.entries(activities))
    for (const [i, activity] of (Array.isArray(value) ? value : [value]).entries())
      if (isObject(activity)) add(`$.context.contextActivities.${where}[${i}].definition`, activity.definition);
  return out;
}

/**
 * The extensions of one statement against the concepts of one profile. An extension the profile
 * does not declare is another profile's, and is left alone; so is a deprecated concept's.
 */
export function extensionValues(statement: Json, concepts: readonly Json[]): ExtensionsResult {
  const declared = new Map<string, Json>();
  for (const concept of concepts)
    if (isObject(concept) && typeof concept.id === 'string' && EXTENSION_TYPES.includes(String(concept.type)) && concept.deprecated !== true) declared.set(concept.id, concept);
  const findings: ExtensionFinding[] = [], unchecked = new Set<string>();
  if (declared.size === 0) return { findings, unchecked: [] };
  for (const { location, extensions } of extensionsIn(statement)) {
    for (const [key, value] of Object.entries(extensions)) {
      const concept = declared.get(key);
      if (!concept) continue;
      if (typeof concept.inlineSchema !== 'string') {
        if (typeof concept.schema === 'string') unchecked.add(`${key}: its schema is at ${concept.schema}, which this server does not fetch`);
        continue;
      }
      let schema: unknown;
      try { schema = JSON.parse(concept.inlineSchema); } catch { unchecked.add(`${key}: its inlineSchema is not JSON`); continue; }
      const result = checkValue(value, schema);
      for (const what of result.unchecked) unchecked.add(`${key}: ${what}`);
      if (result.failure) findings.push({ extension: key, location: `${location}['${key}']`, reason: `the value ${result.failure}` });
    }
  }
  return { findings, unchecked: [...unchecked] };
}
