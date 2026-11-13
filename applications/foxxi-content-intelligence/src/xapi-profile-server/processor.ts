/**
 * An xAPI Profile Processor: the two algorithms of the xAPI Profiles specification, Part Three
 * (Communication and Processing), section 2, with every function it lists.
 *
 * ★ WHY IT IS WRITTEN FROM THE PSEUDOCODE. The specification gives `validates`, `follows_rules`,
 * `matches_determining_properties`, `follows_rule`, `apply_jsonpath`, `follows` and `matches` as
 * pseudocode, and says a library exposing all of them is an xAPI Profile Processor. Each function
 * here follows its pseudocode branch for branch, including the places where the result is not
 * what one would guess: with no `presence` stated an absent location fails `any` but not `all`;
 * a template whose determining properties a statement does not carry is not a failure, it simply
 * does not match; and pattern matching is greedy with no backtracking.
 *
 * What it adds to the pseudocode is the reason for each answer (the specification's web APIs
 * return "descriptive comments"), and bounds, because a profile is someone else's document.
 *
 * It keeps nothing and fetches nothing. A statement a StatementRef names is looked up through the
 * function the caller passes, and is skipped when it is not available, as the algorithm says.
 */

export type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const sameValue = (a: unknown, b: unknown): boolean => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** The value a selector that found nothing puts in place of a location's value. */
export const UNMATCHABLE: unique symbol = Symbol('unmatchable');

export class JsonPathError extends Error {}

// ── apply_jsonpath ───────────────────────────────────────────────────────────────────────

type Step = { keys: Array<string | number> | '*'; deep: boolean };

/** Split on `|` outside quotes and brackets. */
function alternatives(path: string): string[] {
  const out: string[] = []; let buf = '', quote = '', depth = 0;
  for (const ch of path) {
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === '|' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf.trim());
  return out;
}

function steps(expression: string): Step[] {
  if (!expression.startsWith('$')) throw new JsonPathError(`a JSONPath starts at $: ${expression}`);
  const out: Step[] = []; let rest = expression.slice(1);
  while (rest.length) {
    let deep = false;
    if (rest.startsWith('..')) { deep = true; rest = rest.slice(2); if (!rest.length) throw new JsonPathError(`nothing follows .. in ${expression}`); }
    else if (rest.startsWith('.')) rest = rest.slice(1);
    else if (!rest.startsWith('[')) throw new JsonPathError(`unexpected text in ${expression}`);
    if (rest.startsWith('*')) { out.push({ keys: '*', deep }); rest = rest.slice(1); continue; }
    if (rest.startsWith('[')) {
      const close = (() => { let quote = ''; for (let i = 1; i < rest.length; i++) { const ch = rest[i]!; if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === ']') return i; } return -1; })();
      if (close < 0) throw new JsonPathError(`unclosed [ in ${expression}`);
      const inside = rest.slice(1, close).trim();
      rest = rest.slice(close + 1);
      // The specification forbids filter and script expressions; a slice is not among the legal values.
      if (/^\?|^\(/.test(inside)) throw new JsonPathError(`filter and script expressions must not be used: ${expression}`);
      const parts = inside.match(/'[^']*'|"[^"]*"|[^,]+/g)?.map(p => p.trim()).filter(Boolean) ?? [];
      if (!parts.length) throw new JsonPathError(`empty [] in ${expression}`);
      if (parts.length === 1 && parts[0] === '*') { out.push({ keys: '*', deep }); continue; }
      const keys: Array<string | number> = [];
      for (const part of parts) {
        if (/^\d+$/.test(part)) keys.push(Number(part));
        else if (/^'[^']*'$|^"[^"]*"$/.test(part)) keys.push(part.slice(1, -1));
        else throw new JsonPathError(`only strings, non-negative integers, * and unions of them are legal in []: ${expression}`);
      }
      out.push({ keys, deep });
      continue;
    }
    const name = /^[^.[\]|\s]+/.exec(rest);
    if (!name) throw new JsonPathError(`unexpected text in ${expression}`);
    out.push({ keys: [name[0]], deep }); rest = rest.slice(name[0].length);
  }
  return out;
}

function children(value: unknown): unknown[] {
  return Array.isArray(value) ? value : isObject(value) ? Object.values(value) : [];
}
function descendantsAndSelf(value: unknown, out: unknown[] = []): unknown[] {
  out.push(value);
  for (const child of children(value)) descendantsAndSelf(child, out);
  return out;
}
function select(value: unknown, keys: Step['keys']): unknown[] {
  if (keys === '*') return children(value);
  const out: unknown[] = [];
  for (const key of keys) {
    const found = typeof key === 'number' ? (Array.isArray(value) ? value[key] : undefined) : (isObject(value) ? value[key] : undefined);
    if (found !== undefined) out.push(found);
  }
  return out;
}

/**
 * The values a JSONPath finds, each as one member of the returned array (a found array is one
 * value, not spread). JSONPath as the specification constrains it: child names, non-negative
 * indices, `*`, unions of those, recursive descent, and expressions joined by `|`. A filter, a
 * script expression or anything else throws JsonPathError.
 */
export function apply_jsonpath(root: unknown, path: string): unknown[] {
  const out: unknown[] = [];
  for (const expression of alternatives(path)) {
    let current: unknown[] = [root];
    for (const step of steps(expression)) {
      const next: unknown[] = [];
      for (const value of current) for (const from of step.deep ? descendantsAndSelf(value) : [value]) next.push(...select(from, step.keys));
      current = next;
    }
    out.push(...current);
  }
  return out;
}

// ── validates ────────────────────────────────────────────────────────────────────────────

export interface TemplateFinding { template: string; reason: string; location?: string }
export interface ValidatesResult {
  outcome: 'success' | 'invalid' | 'unmatched';
  /** success: every template that matched. invalid: the matched templates with a rule unfollowed. */
  templates: string[];
  /** Why each failing template failed; empty unless the outcome is invalid. */
  findings: TemplateFinding[];
  /** StatementRef checks skipped because the statement referred to was not available. */
  skipped: string[];
}
export interface ValidatesOptions {
  /** A statement by id, for the StatementRef templates. Absent or returning undefined: not available. */
  statementById?: (id: string) => Json | undefined;
}

const list = (v: unknown): unknown[] => Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

/** contextActivities with singleton objects replaced by arrays of one, as the rules require. */
export function normalized(statement: Json): Json {
  const context = statement.context;
  if (!isObject(context) || !isObject(context.contextActivities)) return statement;
  const activities: Json = {};
  for (const [key, value] of Object.entries(context.contextActivities)) activities[key] = Array.isArray(value) ? value : [value];
  return { ...statement, context: { ...context, contextActivities: activities } };
}

function activityTypesAt(statement: Json, where: string): string[] {
  const typeOf = (a: unknown): string | undefined => isObject(a) && isObject(a.definition) && typeof a.definition.type === 'string' ? a.definition.type : undefined;
  if (where === 'object') { const t = typeOf(statement.object); return t ? [t] : []; }
  const context = isObject(statement.context) && isObject(statement.context.contextActivities) ? statement.context.contextActivities : {};
  return list(context[where]).map(typeOf).filter((t): t is string => !!t);
}

/** Every determining property the template states is carried by the statement. */
export function matches_determining_properties(statement: Json, template: Json): boolean {
  if (template.verb !== undefined && !(isObject(statement.verb) && statement.verb.id === template.verb)) return false;
  const carries = (wanted: string[], have: string[]): boolean => wanted.every(w => have.includes(w));
  if (!carries(strings(template.objectActivityType), activityTypesAt(statement, 'object'))) return false;
  for (const [property, where] of [['contextGroupingActivityType', 'grouping'], ['contextParentActivityType', 'parent'],
    ['contextOtherActivityType', 'other'], ['contextCategoryActivityType', 'category']] as const) {
    if (!carries(strings(template[property]), activityTypesAt(statement, where))) return false;
  }
  const usage = list(statement.attachments).map(a => isObject(a) ? a.usageType : undefined).filter((t): t is string => typeof t === 'string');
  return carries(strings(template.attachmentUsageType), usage);
}

/** One rule, as the pseudocode decides it. Returns why it is not followed, or null when it is. */
export function rule_failure(statement: Json, rule: Json): string | null {
  let strict = true;
  let values: unknown[] = apply_jsonpath(statement, String(rule.location));
  if (typeof rule.selector === 'string') {
    const originals = values; values = [];
    for (const value of originals) {
      const selection = apply_jsonpath(value, rule.selector);
      if (selection.length === 0) values.push(UNMATCHABLE); else values = values.concat(selection);
    }
  }
  const matchable = values.filter(v => v !== UNMATCHABLE);
  const includes = (set: unknown[], value: unknown): boolean => set.some(s => sameValue(s, value));
  if (rule.presence === 'included') {
    if (values.includes(UNMATCHABLE)) return 'presence is included, and the selector found nothing in a located value';
    if (values.length === 0) return 'presence is included, and the location has no value';
  }
  if (rule.presence === 'excluded' && matchable.length > 0) return 'presence is excluded, and the location has a value';
  if (rule.presence === 'recommended') strict = false;
  const applies = strict || values.length > 0;
  if (Array.isArray(rule.any) && applies && !matchable.some(v => includes(rule.any as unknown[], v))) return `no value is one of ${JSON.stringify(rule.any)}`;
  if (Array.isArray(rule.all) && applies) {
    if (values.includes(UNMATCHABLE)) return 'all is stated, and the selector found nothing in a located value';
    const outside = matchable.find(v => !includes(rule.all as unknown[], v));
    if (outside !== undefined) return `${JSON.stringify(outside)} is not one of ${JSON.stringify(rule.all)}`;
  }
  if (Array.isArray(rule.none) && applies) {
    const banned = matchable.find(v => includes(rule.none as unknown[], v));
    if (banned !== undefined) return `${JSON.stringify(banned)} is one of ${JSON.stringify(rule.none)}, which none excludes`;
  }
  return null;
}
/** The pseudocode's follows_rule: whether one rule is followed. */
export function follows_rule(statement: Json, rule: Json): boolean { return rule_failure(statement, rule) === null; }

interface Run { templates: readonly Json[]; options: ValidatesOptions; depth: number; skipped: Set<string> }

function rules_failure(statement: Json, template: Json, run: Run): TemplateFinding | null {
  const id = String(template.id);
  for (const [property, refOf] of [
    ['objectStatementRefTemplate', (s: Json) => isObject(s.object) && s.object.objectType === 'StatementRef' ? s.object.id : undefined],
    ['contextStatementRefTemplate', (s: Json) => isObject(s.context) && isObject(s.context.statement) && s.context.statement.objectType === 'StatementRef' ? s.context.statement.id : undefined],
  ] as const) {
    const wanted = strings(template[property]);
    if (template[property] === undefined) continue;
    const ref = refOf(statement);
    if (typeof ref !== 'string') return { template: id, reason: `${property} is stated, and the statement has no StatementRef there` };
    // A statement referring to a statement referring to … is followed a bounded number of times.
    const other = run.depth < 8 ? run.options.statementById?.(ref) : undefined;
    if (!other) { run.skipped.add(`${id}: ${property} (statement ${ref} is not available to this check)`); continue; }
    const result = validatesIn(normalized(other), { ...run, depth: run.depth + 1 });
    if (!result.templates.some(t => wanted.includes(t))) return { template: id, reason: `${property}: the statement referred to follows none of ${JSON.stringify(wanted)}` };
  }
  for (const rule of list(template.rules)) {
    if (!isObject(rule)) continue;
    const why = rule_failure(statement, rule);
    if (why !== null) return { template: id, reason: why, location: typeof rule.selector === 'string' ? `${String(rule.location)} » ${rule.selector}` : String(rule.location) };
  }
  return null;
}
/** The pseudocode's follows_rules: whether a statement follows every rule of a template. */
export function follows_rules(statement: Json, template: Json, templates: readonly Json[] = [template], options: ValidatesOptions = {}): boolean {
  return rules_failure(normalized(statement), template, { templates, options, depth: 0, skipped: new Set() }) === null;
}

function validatesIn(statement: Json, run: Run): ValidatesResult {
  const matching: string[] = [], failing: TemplateFinding[] = [];
  for (const template of run.templates) {
    if (!matches_determining_properties(statement, template)) continue;
    const failure = rules_failure(statement, template, run);
    if (failure) failing.push(failure); else matching.push(String(template.id));
  }
  if (failing.length) return { outcome: 'invalid', templates: failing.map(f => f.template), findings: failing, skipped: [...run.skipped] };
  return { outcome: matching.length ? 'success' : 'unmatched', templates: matching, findings: [], skipped: [...run.skipped] };
}

/**
 * Validate one statement against a profile's statement templates (specification 2.1).
 * success: one or more templates matched and all their rules are followed.
 * invalid: a matched template has a rule unfollowed. unmatched: no template matched.
 */
export function validates(statement: Json, templates: readonly Json[], options: ValidatesOptions = {}): ValidatesResult {
  return validatesIn(normalized(statement), { templates, options, depth: 0, skipped: new Set() });
}

// ── follows / matches ────────────────────────────────────────────────────────────────────

export type MatchOutcome = 'success' | 'partial' | 'failure';
/** A statement with the templates `validates` found for it, as `follows` annotates it. */
export interface Judged { statement: Json; templates: string[] }
export interface Elements { templates: ReadonlySet<string>; patterns: ReadonlyMap<string, Json> }

class PatternBudget { constructor(public steps: number) {} spend(): void { if (--this.steps < 0) throw new Error('the pattern took too many steps to match'); } }

function matchesIn(statements: readonly Judged[], element: string, of: Elements, budget: PatternBudget, depth: number): [MatchOutcome, readonly Judged[]] {
  budget.spend();
  if (depth > 64) throw new Error('the pattern nests too deeply, or refers to itself');
  const next = (s: readonly Judged[], e: unknown): [MatchOutcome, readonly Judged[]] => matchesIn(s, String(e), of, budget, depth + 1);
  if (of.templates.has(element)) {
    if (statements.length === 0) return ['partial', []];
    return statements[0]!.templates.includes(element) ? ['success', statements.slice(1)] : ['failure', statements];
  }
  const pattern = of.patterns.get(element);
  if (!pattern) throw new Error(`${element} is neither a statement template nor a pattern of this profile`);
  if (Array.isArray(pattern.sequence)) {
    let remaining = statements;
    for (const part of pattern.sequence) {
      const [outcome, rest] = next(remaining, part);
      if (outcome === 'failure') return ['failure', statements];
      if (outcome === 'partial') return ['partial', []];
      remaining = rest;
    }
    return ['success', remaining];
  }
  if (Array.isArray(pattern.alternates)) {
    let outcome: MatchOutcome = 'failure', remaining = statements;
    for (const part of pattern.alternates) {
      const [maybe, rest] = next(statements, part);
      if (maybe === 'success') { outcome = 'success'; if (rest.length < remaining.length) remaining = rest; }
      if (maybe === 'partial' && outcome === 'failure') outcome = 'partial';
    }
    return outcome === 'partial' ? ['partial', []] : [outcome, remaining];
  }
  if (pattern.oneOrMore !== undefined) {
    let outcome: MatchOutcome = 'failure', last = statements;
    for (;;) {
      const [more, rest] = next(last, pattern.oneOrMore);
      if (more === 'success') outcome = 'success';
      else if (outcome === 'failure' && more === 'partial') return ['partial', []];
      else return more === 'partial' && last.length > 0 ? ['partial', last] : [outcome, last];
      if (rest.length === last.length) return ['success', rest];
      last = rest;
    }
  }
  if (pattern.zeroOrMore !== undefined) {
    let last = statements;
    for (;;) {
      const [more, rest] = next(last, pattern.zeroOrMore);
      if (more === 'failure') return ['success', last];
      if (more === 'partial' && rest.length > 0) return ['partial', rest];
      if (rest.length === last.length) return ['success', rest];
      last = rest;
    }
  }
  if (pattern.optional !== undefined) {
    if (statements.length === 0) return ['success', []];
    const [outcome, rest] = next(statements, pattern.optional);
    return outcome === 'success' || outcome === 'partial' ? [outcome, rest] : ['success', statements];
  }
  throw new Error(`pattern ${element} has none of sequence, alternates, optional, oneOrMore, zeroOrMore`);
}

/** The templates and patterns of a profile, by id, as `matches` needs them. */
export function elementsOf(templates: readonly Json[], patterns: readonly Json[]): Elements {
  return { templates: new Set(templates.map(t => String(t.id))), patterns: new Map(patterns.map(p => [String(p.id), p])) };
}

/**
 * Match judged statements against one element, a template or a pattern, by its id
 * (specification 2.2). Greedy, with no backtracking. Returns the outcome and what remains.
 */
export function matches(statements: readonly Judged[], element: string, of: Elements): [MatchOutcome, readonly Judged[]] {
  return matchesIn(statements, element, of, new PatternBudget(200_000), 0);
}

export interface FollowsResult {
  follows: boolean;
  /** The primary pattern the statements follow from first to last, when they follow one. */
  pattern?: string;
  /** Why not: a statement no template validates, or how far each primary pattern got. */
  reasons: string[];
}

/** Statements in the order patterns are checked in: by timestamp, then by place in the array. */
export function inOrder(statements: readonly Json[]): Json[] {
  const time = (s: Json): number => { const t = typeof s.timestamp === 'string' ? Date.parse(s.timestamp) : NaN; return Number.isNaN(t) ? Infinity : t; };
  return statements.map((statement, index) => ({ statement, index })).sort((a, b) => (time(a.statement) - time(b.statement)) || (a.index - b.index)).map(x => x.statement);
}

/**
 * Whether a series of statements sharing a registration follows a profile (specification 2.2):
 * every statement validates against the templates, and one primary pattern matches them all.
 * Only primary patterns are checked, as the profile structure says.
 */
export function follows(statements: readonly Json[], templates: readonly Json[], patterns: readonly Json[], options: ValidatesOptions = {}): FollowsResult {
  const byId = new Map(statements.filter(s => typeof s.id === 'string').map(s => [s.id as string, s]));
  const lookup: ValidatesOptions = { statementById: id => byId.get(id) ?? options.statementById?.(id) };
  const judged: Judged[] = [];
  for (const [index, statement] of inOrder(statements).entries()) {
    const result = validates(statement, templates, lookup);
    if (result.outcome !== 'success') {
      const which = typeof statement.id === 'string' ? statement.id : `at position ${index}`;
      return { follows: false, reasons: [result.outcome === 'unmatched'
        ? `statement ${which} matches no statement template of the profile`
        : `statement ${which} does not follow ${result.findings.map(f => `${f.template} (${f.location ? f.location + ': ' : ''}${f.reason})`).join('; ')}`] };
    }
    judged.push({ statement, templates: result.templates });
  }
  const primary = patterns.filter(p => p.primary === true);
  if (!primary.length) return { follows: false, reasons: ['the profile has no primary pattern, and only primary patterns are checked'] };
  const of = elementsOf(templates, patterns), reasons: string[] = [];
  for (const pattern of primary) {
    const id = String(pattern.id);
    let outcome: MatchOutcome, remaining: readonly Judged[];
    try { [outcome, remaining] = matches(judged, id, of); } catch (e) { reasons.push(`${id}: ${(e as Error).message}`); continue; }
    if (outcome === 'success' && remaining.length === 0) return { follows: true, pattern: id, reasons: [] };
    const at = judged.length - remaining.length;
    reasons.push(outcome === 'success' ? `${id}: matched the first ${at} statement(s), and statement ${at + 1} of ${judged.length} is not part of it`
      : outcome === 'partial' ? `${id}: the statements end before the pattern does`
      : `${id}: does not match from the first statement`);
  }
  return { follows: false, reasons };
}
