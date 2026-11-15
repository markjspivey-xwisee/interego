/**
 * Check the statements of one registration against the patterns of a profile the caller supplies.
 *
 * ★ WHY. The single-statement check (xapi-profile-supplied.ts) can say which template a
 * statement follows, and has to report a profile's patterns as not checked: a pattern is about
 * an order of statements. Someone whose profile says "initialized, then five scored criteria in
 * a fixed order, then completed" could not ask this LRS whether an attempt did that. This reads
 * the patterns, on demand, over statements sent with the request. Nothing is stored, nothing is
 * fetched, and nothing is refused on ingest: a statement that breaks a pattern is still kept.
 *
 * What is read (ADL xAPI Profiles, patterns): every `primary` pattern, with `sequence`,
 * `alternates`, `optional`, `oneOrMore` and `zeroOrMore`, each naming patterns or statement
 * templates of the same profile. The statements follow a pattern when the whole run of them, in
 * order, is one the pattern allows, each statement standing where a template it follows stands.
 *
 * Three answers, as in the single-statement check. A pattern is `followed` when the run fits
 * using only templates evaluated whole. It is `not-fully-checked` when the run fits only if a
 * partially checked template, or a template this profile does not define, is taken as followed:
 * that settles nothing, so it is not conformance. Otherwise it is `not-followed`, and the answer
 * says how far the run got.
 *
 * Order is by `timestamp`, as the specification has it, when every statement carries one;
 * statements with equal timestamps keep the order they were sent in. Without timestamps the
 * order sent is used. Either way the answer says which.
 *
 * Not read, and reported rather than passed: subregistrations, and whatever the template check
 * itself does not evaluate (selectors, some JSONPath forms, statement-reference templates).
 */
import { validateAgainstSuppliedProfile, whyNotAProfile } from './xapi-profile-supplied.js';

export const MAX_PATTERN_STATEMENTS = 1000;
const MAX_PATTERNS = 500;
const SUBREGISTRATION = 'https://w3id.org/xapi/profiles/extensions/subregistration';
const OPERATORS = ['sequence', 'alternates', 'optional', 'oneOrMore', 'zeroOrMore'] as const;
type Operator = typeof OPERATORS[number];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** An operand names a pattern or template by IRI: a string, or the `{ "@id": … }` JSON-LD form. */
const iriOf = (v: unknown): string | null => typeof v === 'string' ? v
  : isObject(v) && typeof v['@id'] === 'string' ? v['@id'] : isObject(v) && typeof v.id === 'string' ? v.id : null;

/**
 * A timestamp as an instant that keeps every fractional digit. A Date holds milliseconds, so
 * two statements a tenth of a millisecond apart would read as equal and fall back to the order
 * sent. `ms` is the instant to the millisecond; `finer` is the digits after the third, with
 * trailing zeros dropped, which compare as text because they all start at the same place.
 */
interface Instant { ms: number; finer: string }
function instantOf(timestamp: unknown): Instant | null {
  if (typeof timestamp !== 'string') return null;
  const fraction = /^([^.]*T[^.]*)\.(\d+)(.*)$/.exec(timestamp);
  const ms = Date.parse(fraction ? `${fraction[1]}.${fraction[2]!.slice(0, 3)}${fraction[3]}` : timestamp);
  return Number.isNaN(ms) ? null : { ms, finer: fraction ? fraction[2]!.slice(3).replace(/0+$/, '') : '' };
}

interface Pattern { id: string; primary: boolean; operator: Operator; operands: string[] }

/** The profile's patterns in a form the matcher reads, or a string saying why they cannot be read. */
function readPatterns(profile: Json): Pattern[] | string {
  if (profile.patterns === undefined) return [];
  if (!Array.isArray(profile.patterns)) return 'profile.patterns must be an array of patterns';
  if (profile.patterns.length > MAX_PATTERNS) return `profile.patterns has more than ${MAX_PATTERNS} patterns`;
  const out: Pattern[] = [];
  for (const p of profile.patterns) {
    if (!isObject(p) || typeof p.id !== 'string') return 'every pattern must be an object with an id';
    const used = OPERATORS.filter(o => p[o] !== undefined);
    if (used.length !== 1) return `pattern ${p.id}: exactly one of ${OPERATORS.join(', ')} is expected, found ${used.length}`;
    const operator = used[0]!, raw = p[operator];
    const listed = operator === 'sequence' || operator === 'alternates';
    if (listed && (!Array.isArray(raw) || raw.length === 0)) return `pattern ${p.id}: ${operator} must be a non-empty array`;
    const operands = (listed ? raw as unknown[] : [raw]).map(iriOf);
    if (operands.some(o => o === null)) return `pattern ${p.id}: ${operator} must name patterns or templates by IRI`;
    if (out.some(q => q.id === p.id)) return `pattern ${p.id} is defined more than once`;
    out.push({ id: p.id, primary: p.primary === true, operator, operands: operands as string[] });
  }
  // A pattern that contains itself has no finite reading, and the specification forbids it.
  const byId = new Map(out.map(p => [p.id, p])), done = new Set<string>(), open = new Set<string>();
  const cyclic = (id: string): boolean => {
    const p = byId.get(id);
    if (!p || done.has(id)) return false;
    if (open.has(id)) return true;
    open.add(id);
    const found = p.operands.some(cyclic);
    open.delete(id); done.add(id);
    return found;
  };
  for (const p of out) if (cyclic(p.id)) return `pattern ${p.id} contains itself, directly or through another pattern`;
  return out;
}

/** Say why a profile's patterns cannot be checked here, or null when they can. */
export function whyNotPatterns(profile: unknown): string | null {
  const why = whyNotAProfile(profile);
  if (why) return why;
  const read = readPatterns(profile as Json);
  return typeof read === 'string' ? read : null;
}

/** Say why a body's `statements` cannot be checked as one registration, or null when they can. */
export function whyNotARegistration(statements: unknown): string | null {
  if (!Array.isArray(statements) || statements.length === 0) return '`statements` must be a non-empty array: the statements of one registration';
  if (statements.length > MAX_PATTERN_STATEMENTS) return `\`statements\` has more than ${MAX_PATTERN_STATEMENTS} statements`;
  if (!statements.every(isObject)) return 'every entry of `statements` must be a statement object';
  const registrations = new Set(statements.map(s => isObject(s.context) && typeof s.context.registration === 'string' ? s.context.registration.toLowerCase() : null));
  if (registrations.size > 1) return registrations.has(null)
    ? 'some statements carry a registration and some do not: a pattern is judged within one registration'
    : `statements carry ${registrations.size} registrations: a pattern is judged within one`;
  return null;
}

export interface PatternStatement {
  /** Position in the order the pattern was judged in. */
  index: number;
  /** Position in the `statements` array as sent. */
  sent: number;
  id: string | null;
  verb: string;
  matchedTemplates: string[];
  partiallyCheckedTemplates: string[];
}
export interface PatternVerdict {
  pattern: string;
  verdict: 'followed' | 'not-fully-checked' | 'not-followed';
  /** How many statements, from the first, the pattern accounts for on its best reading. Equal to
   *  the number of statements unless the pattern is not followed. */
  statementsRead: number;
  /** On `not-followed`: the first statement the pattern has no place for, or 'end' when the
   *  statements ran out before the pattern was complete. */
  stoppedAt?: number | 'end';
}
export interface SuppliedPatternResult {
  profile: string | null;
  registration: string | null;
  orderedBy: 'timestamp' | 'as-sent';
  statements: PatternStatement[];
  /** One entry per primary pattern. Empty when the profile has none: nothing was checked. */
  patterns: PatternVerdict[];
  verdict: 'conformant' | 'not-fully-checked' | 'non-conformant' | 'no-primary-pattern';
  conforms: boolean;
  notChecked: string[];
}

/** Check ordered statements against a profile's primary patterns. `whyNotPatterns(profile)` and
 *  `whyNotARegistration(statements)` must both be null. */
export function validatePatternsAgainstSuppliedProfile(sentStatements: Json[], profile: Json): SuppliedPatternResult {
  const patterns = readPatterns(profile) as Pattern[];
  const byId = new Map(patterns.map(p => [p.id, p]));
  const templateIds = new Set((profile.templates as Json[]).map(t => t.id as string));
  const notChecked = new Set<string>();

  const times = sentStatements.map(s => instantOf(s.timestamp));
  const timed = times.every(t => t !== null);
  const order = sentStatements.map((_, i) => i);
  if (timed) {
    const before = (a: Instant, b: Instant): number => a.ms - b.ms || (a.finer < b.finer ? -1 : a.finer > b.finer ? 1 : 0);
    order.sort((a, b) => before(times[a]!, times[b]!) || a - b);
    if (new Set(times.map(t => `${t!.ms} ${t!.finer}`)).size < times.length) notChecked.add('order: statements with equal timestamps were read in the order sent');
  } else notChecked.add('order: not every statement has a readable timestamp, so the order sent was used');

  const statements: PatternStatement[] = order.map((sent, index) => {
    const s = sentStatements[sent]!;
    const r = validateAgainstSuppliedProfile(s, profile);
    for (const note of r.notChecked) if (!note.startsWith('patterns:')) notChecked.add(note);
    if (isObject(s.context) && isObject(s.context.extensions) && s.context.extensions[SUBREGISTRATION] !== undefined) notChecked.add('subregistrations: the statements were read as one run, not one run per subregistration');
    return { index, sent, id: typeof s.id === 'string' ? s.id : null, verb: r.verb, matchedTemplates: r.matchedTemplates, partiallyCheckedTemplates: r.partiallyCheckedTemplates };
  });
  const n = statements.length;

  /**
   * Does the whole run fit `root`? `lenient` also lets a statement stand for a template it only
   * partially checks against, and lets any statement stand for a template the profile lacks.
   * Returns the furthest statement index any reading reached, for saying where it stopped.
   */
  const run = (root: Pattern, lenient: boolean): { fits: boolean; furthest: number } => {
    let furthest = 0;
    const memo = new Map<string, Set<number>>();
    // The positions a reading of `id` can end at, having started at `from`.
    const ends = (id: string, from: number): Set<number> => {
      const key = `${from} ${id}`, known = memo.get(key);
      if (known) return known;
      const out = new Set<number>(), p = byId.get(id);
      if (!p) {
        const s = statements[from];
        const stands = !!s && (templateIds.has(id)
          ? s.matchedTemplates.includes(id) || (lenient && s.partiallyCheckedTemplates.includes(id))
          : lenient);
        if (stands) { out.add(from + 1); furthest = Math.max(furthest, from + 1); }
      } else if (p.operator === 'sequence') {
        let at = new Set([from]);
        for (const operand of p.operands) { const next = new Set<number>(); for (const a of at) for (const e of ends(operand, a)) next.add(e); at = next; }
        for (const e of at) out.add(e);
      } else if (p.operator === 'alternates') {
        for (const operand of p.operands) for (const e of ends(operand, from)) out.add(e);
      } else {
        const operand = p.operands[0]!;
        if (p.operator !== 'oneOrMore') out.add(from);
        let frontier = [...ends(operand, from)];
        if (p.operator !== 'optional') while (frontier.length) {
          // Each end is expanded once: two readings that end at the same place go on the same way,
          // and expanding every copy multiplies the work at each repeat.
          const fresh = [...new Set(frontier)].filter(e => !out.has(e));
          for (const e of fresh) out.add(e);
          // A repeat that read nothing (e === from) cannot read more by repeating.
          frontier = fresh.filter(e => e !== from).flatMap(e => [...ends(operand, e)]);
        } else for (const e of frontier) out.add(e);
      }
      memo.set(key, out);
      return out;
    };
    return { fits: ends(root.id, 0).has(n), furthest };
  };

  for (const p of patterns) for (const operand of p.operands) if (!byId.has(operand) && !templateIds.has(operand)) notChecked.add(`${p.id}: refers to ${operand}, which this profile does not define`);

  const verdicts: PatternVerdict[] = patterns.filter(p => p.primary).map(p => {
    const strict = run(p, false);
    if (strict.fits) return { pattern: p.id, verdict: 'followed', statementsRead: n };
    const lenient = run(p, true);
    if (lenient.fits) return { pattern: p.id, verdict: 'not-fully-checked', statementsRead: n };
    return { pattern: p.id, verdict: 'not-followed', statementsRead: lenient.furthest, stoppedAt: lenient.furthest < n ? lenient.furthest : 'end' };
  });
  const verdict = !verdicts.length ? 'no-primary-pattern'
    : verdicts.some(v => v.verdict === 'followed') ? 'conformant'
      : verdicts.some(v => v.verdict === 'not-fully-checked') ? 'not-fully-checked' : 'non-conformant';
  if (!verdicts.length) notChecked.add('patterns: the profile has no primary pattern, so no order of statements was checked');
  const first = sentStatements[0]!;
  return {
    profile: typeof profile.id === 'string' ? profile.id : null,
    registration: isObject(first.context) && typeof first.context.registration === 'string' ? first.context.registration : null,
    orderedBy: timed ? 'timestamp' : 'as-sent', statements, patterns: verdicts, verdict, conforms: verdict === 'conformant', notChecked: [...notChecked],
  };
}

/**
 * The answer `POST /xapi/profile/validate` gives a request that carries a `profile`: one statement
 * (`instance` or `statement`) against its templates, or the `statements` of one registration
 * against its patterns. Kept here, apart from the bridge, so the response contract can be pinned
 * by a test without starting a bridge.
 */
export function answerSuppliedProfileRequest(body: Json): { status: number; body: Json } {
  const refuse = (error: string) => ({ status: 400, body: { ok: false, error } });
  const one = body.instance ?? body.statement;
  if (body.statements !== undefined) {
    if (one !== undefined) return refuse('send either one statement as `instance` (checked against templates) or the statements of one registration as `statements` (checked against patterns), not both');
    const why = whyNotPatterns(body.profile) ?? whyNotARegistration(body.statements);
    if (why) return refuse(why);
    return { status: 200, body: { ok: true, profileSource: 'supplied', checked: 'patterns', ...validatePatternsAgainstSuppliedProfile(body.statements as Json[], body.profile as Json) } };
  }
  const why = whyNotAProfile(body.profile);
  if (why) return refuse(why);
  if (!isObject(one)) return refuse('send the statement as `instance` (or `statement`) beside `profile`, or the statements of one registration as `statements`');
  const s = validateAgainstSuppliedProfile(one, body.profile as Json);
  // A template with no violation found but a part not evaluated settles nothing: the verdict
  // says so, and `conforms` stays false, since conformance was not established.
  const verdict = !s.applicable ? (s.verbDeclared ? 'no-applicable-template' : 'unknown-verb')
    : s.matchedTemplates.length ? 'conformant' : s.partiallyCheckedTemplates.length ? 'not-fully-checked' : 'non-conformant';
  return { status: 200, body: { ok: true, profileSource: 'supplied', ...s, verdict, conforms: s.matchedTemplates.length > 0 } };
}
