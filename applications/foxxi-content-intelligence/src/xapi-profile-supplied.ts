/**
 * Check a statement against the statement templates of a profile the caller supplies.
 *
 * ★ WHY. `POST /xapi/profile/validate` checked a statement against Foxxi's own profile and no
 * other, so someone who authored an xAPI Profile for their own domain could have its statements
 * kept by this LRS but not checked by it. This is the same rule interpretation, over the
 * templates in a profile document sent with the request. Nothing is stored and nothing is
 * fetched: the profile is whatever the request carries, and the answer says so.
 *
 * What is read from the profile (ADL xAPI Profiles, statement templates): each template's
 * determining properties (verb, objectActivityType, the four context*ActivityType lists,
 * attachmentUsageType) and its rules (location, presence, any, all, none). A statement follows
 * the profile when it carries every determining property of at least one template and breaks
 * none of that template's rules, with every part of that template evaluated. A template that
 * shows no violation but has a part this reader does not evaluate is reported apart, as
 * partially checked: it is neither a match nor a violation.
 *
 * Not read, and reported as not checked rather than passed or failed: a rule that has a
 * `selector`, a rule whose location uses a JSONPath form outside the ones selectLocation reads,
 * objectStatementRefTemplate and contextStatementRefTemplate, and patterns (a pattern is a
 * property of a sequence of statements, not of one).
 */

const MAX_TEMPLATES = 500;
const MAX_RULES = 200;

export interface SuppliedProfileViolation { template: string; location: string; message: string }
export interface SuppliedProfileResult {
  /** The profile's own `id`, as the document states it. It is not dereferenced or verified. */
  profile: string | null;
  verb: string;
  /** The verb is one of the profile's Verb concepts, or the verb of one of its templates. */
  verbDeclared: boolean;
  /** At least one template has this statement's verb. If false, nothing was checked. */
  applicable: boolean;
  /** Templates the statement follows, with every part of them evaluated. */
  matchedTemplates: string[];
  /** Templates with no violation found, but with a part that was not evaluated (see notChecked).
   *  Following one of these is not established, so it does not make the statement conformant. */
  partiallyCheckedTemplates: string[];
  /** Why the closest template is not followed; empty when one is, or when none applies. */
  violations: SuppliedProfileViolation[];
  /** Parts of the applicable templates this check does not evaluate. */
  notChecked: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === 'string');
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Say why a document cannot be used as a profile here, or null when it can. */
export function whyNotAProfile(profile: unknown): string | null {
  if (!isObject(profile)) return 'profile must be a JSON object: the xAPI Profile document';
  if (!Array.isArray(profile.templates) || profile.templates.length === 0) return 'profile.templates must be a non-empty array of statement templates';
  if (profile.templates.length > MAX_TEMPLATES) return `profile.templates has more than ${MAX_TEMPLATES} templates`;
  for (const t of profile.templates) {
    if (!isObject(t) || typeof t.id !== 'string') return 'every statement template must be an object with an id';
    if (t.rules !== undefined && (!Array.isArray(t.rules) || t.rules.length > MAX_RULES)) return `template ${t.id}: rules must be an array of at most ${MAX_RULES}`;
    for (const r of (t.rules as unknown[] | undefined) ?? []) if (!isObject(r) || (typeof r.location !== 'string' && typeof r.selector !== 'string')) return `template ${t.id}: every rule must have a location`;
  }
  return null;
}

/** The activity types a statement carries at one place, as the determining properties read them. */
function activityTypes(stmt: Json, where: 'object' | 'grouping' | 'parent' | 'other' | 'category'): string[] {
  const typeOf = (a: unknown): string | undefined => isObject(a) && isObject(a.definition) && typeof a.definition.type === 'string' ? a.definition.type : undefined;
  if (where === 'object') { const t = typeOf(stmt.object); return t ? [t] : []; }
  const ctx = isObject(stmt.context) && isObject(stmt.context.contextActivities) ? stmt.context.contextActivities : {};
  const list = (ctx as Json)[where];
  return (Array.isArray(list) ? list : list === undefined ? [] : [list]).map(typeOf).filter((t): t is string => !!t);
}

function attachmentUsageTypes(stmt: Json): string[] {
  return (Array.isArray(stmt.attachments) ? stmt.attachments : []).map(a => isObject(a) ? a.usageType : undefined).filter((t): t is string => typeof t === 'string');
}

/** What a template asks for that the statement does not carry, among its determining properties. */
function determiningMisses(stmt: Json, t: Json): SuppliedProfileViolation[] {
  const id = t.id as string, out: SuppliedProfileViolation[] = [];
  const need = (property: string, wanted: string[], have: string[], location: string): void => {
    for (const w of wanted) if (!have.includes(w)) out.push({ template: id, location, message: `${property} ${w} is not carried by the statement` });
  };
  need('objectActivityType', strings(t.objectActivityType), activityTypes(stmt, 'object'), 'object.definition.type');
  need('contextGroupingActivityType', strings(t.contextGroupingActivityType), activityTypes(stmt, 'grouping'), 'context.contextActivities.grouping[*].definition.type');
  need('contextParentActivityType', strings(t.contextParentActivityType), activityTypes(stmt, 'parent'), 'context.contextActivities.parent[*].definition.type');
  need('contextOtherActivityType', strings(t.contextOtherActivityType), activityTypes(stmt, 'other'), 'context.contextActivities.other[*].definition.type');
  need('contextCategoryActivityType', strings(t.contextCategoryActivityType), activityTypes(stmt, 'category'), 'context.contextActivities.category[*].definition.type');
  need('attachmentUsageType', strings(t.attachmentUsageType), attachmentUsageTypes(stmt), 'attachments[*].usageType');
  return out;
}

/**
 * The values a rule's location selects in a statement, or null when the expression uses a form
 * this reader does not evaluate. Read: `$`, dotted names, ['quoted'] or ["quoted"] names, [*],
 * numeric indices [0], unions of names or indices ([0,1], ['a','b']) and alternatives joined by
 * `|`. Not read (null, so the rule is reported as not checked and never judged from a wrong
 * selection): recursive descent `..`, filters `?(…)`, script expressions and slices.
 */
export function selectLocation(root: unknown, location: string): unknown[] | null {
  const out: unknown[] = [];
  for (const alternative of location.split('|').map(a => a.trim())) {
    if (!alternative.startsWith('$') || alternative.includes('..') || /[?()]/.test(alternative)) return null;
    let current: unknown[] = [root], rest = alternative.slice(1);
    while (rest.length) {
      let keys: Array<string | number> | '*';
      const dotted = /^\.([A-Za-z_][\w-]*)/.exec(rest), wildcard = /^(?:\.\*|\[\s*\*\s*\])/.exec(rest), bracket = /^\[([^\]]*)\]/.exec(rest);
      if (wildcard) { keys = '*'; rest = rest.slice(wildcard[0].length); }
      else if (dotted) { keys = [dotted[1]!]; rest = rest.slice(dotted[0].length); }
      else if (bracket) {
        const parts = bracket[1]!.match(/'[^']*'|"[^"]*"|[^,]+/g)?.map(x => x.trim()) ?? [];
        if (!parts.length) return null;
        keys = [];
        for (const part of parts) {
          if (/^-?\d+$/.test(part)) keys.push(Number(part));
          else if (/^'[^']*'$|^"[^"]*"$/.test(part)) keys.push(part.slice(1, -1));
          else return null;
        }
        rest = rest.slice(bracket[0].length);
      } else return null;
      const next: unknown[] = [];
      for (const value of current) {
        if (value === null || typeof value !== 'object') continue;
        if (keys === '*') { next.push(...(Array.isArray(value) ? value : Object.values(value as Json))); continue; }
        for (const key of keys) {
          const found = typeof key === 'number'
            ? (Array.isArray(value) ? value[key < 0 ? value.length + key : key] : undefined)
            : (Array.isArray(value) ? undefined : (value as Json)[key]);
          if (found !== undefined) next.push(found);
        }
      }
      current = next;
    }
    out.push(...current);
  }
  return out;
}

function ruleViolations(stmt: Json, t: Json, notChecked: Set<string>): SuppliedProfileViolation[] {
  const id = t.id as string, out: SuppliedProfileViolation[] = [];
  for (const rule of ((t.rules as Json[] | undefined) ?? [])) {
    // A selector replaces the values the location selects, so nothing about this rule can be
    // judged from the location alone: the whole rule is reported, not half of it evaluated.
    if (typeof rule.selector === 'string') { notChecked.add(`${id}: a rule with a selector (${rule.selector})`); continue; }
    const location = rule.location as string;
    const selected = selectLocation(stmt, location);
    if (selected === null) { notChecked.add(`${id}: a rule whose location uses a JSONPath form not evaluated here (${location})`); continue; }
    const values = selected.filter(v => v !== undefined && v !== null);
    const present = values.length > 0;
    if (rule.presence === 'included' && !present) { out.push({ template: id, location, message: 'required location is absent' }); continue; }
    if (rule.presence === 'excluded') { if (present) out.push({ template: id, location, message: 'location must be absent' }); continue; }
    // `recommended` makes the value checks apply only when there is a value. With no presence
    // stated, `any` and `all` still need a value to hold: an absent location does not satisfy them.
    if (!present && rule.presence === 'recommended') continue;
    const any = Array.isArray(rule.any) ? rule.any : null, all = Array.isArray(rule.all) ? rule.all : null, none = Array.isArray(rule.none) ? rule.none : null;
    if (!present) {
      if (any) out.push({ template: id, location, message: `location is absent, so no value is one of ${JSON.stringify(any)}` });
      if (all) out.push({ template: id, location, message: `location is absent, so there is no value to be one of ${JSON.stringify(all)}` });
      continue;
    }
    if (any && !values.some(v => any.some(a => same(a, v)))) out.push({ template: id, location, message: `no value is one of ${JSON.stringify(any)}` });
    if (all && !values.every(v => all.some(a => same(a, v)))) out.push({ template: id, location, message: `a value is not one of ${JSON.stringify(all)}` });
    if (none && values.some(v => none.some(a => same(a, v)))) out.push({ template: id, location, message: `a value is one of ${JSON.stringify(none)}, which the rule excludes` });
  }
  return out;
}

/** Check one statement against a supplied profile's templates. `whyNotAProfile(profile)` must be null. */
export function validateAgainstSuppliedProfile(stmt: Json, profile: Json): SuppliedProfileResult {
  const templates = profile.templates as Json[];
  const verb = isObject(stmt.verb) && typeof stmt.verb.id === 'string' ? stmt.verb.id : '';
  const concepts = Array.isArray(profile.concepts) ? profile.concepts.filter(isObject) : [];
  const verbDeclared = !!verb && (concepts.some(c => c.type === 'Verb' && c.id === verb) || templates.some(t => t.verb === verb));
  // The verb is what selects a template; a template naming no verb applies to any.
  const applicable = templates.filter(t => t.verb === undefined || t.verb === verb);
  const notChecked = new Set<string>();
  const judged = applicable.map(t => {
    // What is not evaluated is kept per template: it decides whether a clean result is a match.
    const unread = new Set<string>();
    for (const ref of ['objectStatementRefTemplate', 'contextStatementRefTemplate']) if (t[ref] !== undefined) unread.add(`${t.id as string}: ${ref}`);
    const violations = [...determiningMisses(stmt, t), ...ruleViolations(stmt, t, unread)];
    for (const note of unread) notChecked.add(note);
    return { id: t.id as string, violations, whole: unread.size === 0 };
  });
  const clean = judged.filter(j => j.violations.length === 0);
  const followed = clean.filter(j => j.whole).map(j => j.id), partial = clean.filter(j => !j.whole).map(j => j.id);
  const closest = judged.length && !clean.length ? judged.reduce((a, b) => b.violations.length < a.violations.length ? b : a).violations : [];
  // Patterns are about an order of statements. Saying so does not take away a template match.
  if (Array.isArray(profile.patterns) && profile.patterns.length) notChecked.add('patterns: an order of statements cannot be judged from one statement');
  return {
    profile: typeof profile.id === 'string' ? profile.id : null, verb, verbDeclared,
    applicable: applicable.length > 0, matchedTemplates: followed, partiallyCheckedTemplates: partial, violations: closest, notChecked: [...notChecked],
  };
}
