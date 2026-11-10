/**
 * A JSON Schema (draft 2020-12) check for the keywords src/payloads.ts publishes, for tests. A
 * keyword it does not know throws rather than passing unchecked, so a schema never validates
 * here by saying something this check skips. The repository takes no JSON Schema validator as a
 * dependency, and the bridge needs none: its handlers are the authority on a payload, and these
 * tests hold the published schema to them.
 *
 * Strings are measured in code points and patterns are compiled with the `u` flag, as the
 * specification and common validators do.
 */
type Obj = Record<string, unknown>;

const ANNOTATIONS = ['$schema', 'title', 'description'];
const ASSERTIONS = [
  'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'properties', 'required', 'additionalProperties', 'allOf', 'anyOf', 'oneOf', 'not',
];
const KNOWN: ReadonlySet<string> = new Set([...ANNOTATIONS, ...ASSERTIONS]);

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const equal = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (isObj(a) || isObj(b)) {
    if (!isObj(a) || !isObj(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return equal(ka, kb) && ka.every((k) => equal(a[k], b[k]));
  }
  return a === b;
};
const numberAt = (s: Obj, k: string): number | undefined => (typeof s[k] === 'number' ? s[k] : undefined);

/** Every way `value` breaks `schema`, each as `<path>: <why>`; empty when it conforms. */
export function schemaErrors(schema: unknown, value: unknown, path = '$'): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: no value is allowed here`];
  if (!isObj(schema)) throw new Error(`${path}: a schema is an object or a boolean`);
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`${path}: this check does not know the keyword ${k}`);
  const s = schema;
  const out: string[] = [];
  if (s['type'] !== undefined) {
    const types = (Array.isArray(s['type']) ? s['type'] : [s['type']]).map(String);
    const actual = typeOf(value);
    if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) out.push(`${path}: is ${actual}, not ${types.join(' or ')}`);
  }
  if ('const' in s && !equal(s['const'], value)) out.push(`${path}: must be ${JSON.stringify(s['const'])}`);
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => equal(e, value))) out.push(`${path}: must be one of ${JSON.stringify(s['enum'])}`);
  if (typeof value === 'string') {
    const length = [...value].length;
    const min = numberAt(s, 'minLength');
    const max = numberAt(s, 'maxLength');
    if (min !== undefined && length < min) out.push(`${path}: shorter than ${min}`);
    if (max !== undefined && length > max) out.push(`${path}: longer than ${max}`);
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'], 'u').test(value)) out.push(`${path}: does not match ${s['pattern']}`);
  }
  if (typeof value === 'number') {
    const [min, max, xmin, xmax] = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].map((k) => numberAt(s, k));
    if (min !== undefined && value < min) out.push(`${path}: below ${min}`);
    if (max !== undefined && value > max) out.push(`${path}: above ${max}`);
    if (xmin !== undefined && value <= xmin) out.push(`${path}: not above ${xmin}`);
    if (xmax !== undefined && value >= xmax) out.push(`${path}: not below ${xmax}`);
  }
  if (Array.isArray(value)) {
    const min = numberAt(s, 'minItems');
    const max = numberAt(s, 'maxItems');
    if (min !== undefined && value.length < min) out.push(`${path}: fewer than ${min} items`);
    if (max !== undefined && value.length > max) out.push(`${path}: more than ${max} items`);
    if (s['uniqueItems'] === true && value.some((x, i) => value.findIndex((y) => equal(x, y)) !== i)) out.push(`${path}: items repeat`);
    if (s['items'] !== undefined) value.forEach((x, i) => out.push(...schemaErrors(s['items'], x, `${path}[${i}]`)));
  }
  if (isObj(value)) {
    const props = isObj(s['properties']) ? s['properties'] : {};
    if (Array.isArray(s['required'])) for (const k of s['required'].map(String)) if (!(k in value)) out.push(`${path}: ${k} is required`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) out.push(...schemaErrors(props[k], v, `${path}.${k}`));
      else if (s['additionalProperties'] !== undefined) out.push(...schemaErrors(s['additionalProperties'], v, `${path}.${k}`));
    }
  }
  const branches = (k: string): unknown[] => (Array.isArray(s[k]) ? s[k] : []);
  for (const b of branches('allOf')) out.push(...schemaErrors(b, value, path));
  if (Array.isArray(s['anyOf']) && !branches('anyOf').some((b) => schemaErrors(b, value, path).length === 0)) out.push(`${path}: matches none of anyOf`);
  if (Array.isArray(s['oneOf'])) {
    const matched = branches('oneOf').filter((b) => schemaErrors(b, value, path).length === 0).length;
    if (matched !== 1) out.push(`${path}: matches ${matched} of oneOf, not exactly one`);
  }
  if (s['not'] !== undefined && schemaErrors(s['not'], value, path).length === 0) out.push(`${path}: matches what not excludes`);
  return out;
}
