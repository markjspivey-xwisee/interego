/**
 * What a profile has to get right before it is published, as findings its writer can act on.
 *
 * ★ THE JUDGE IS ./processor.ts. Whether an example statement follows a template is decided by
 * `validates`, and whether an example run follows a pattern by `follows` and `matches`: the same
 * functions a hosted version is later validated with. Nothing here matches a statement itself. A
 * lint that judged by its own reading could pass a profile the server then refuses statements
 * for, which is the failure a lint exists to prevent.
 *
 * A finding names the term, where in the document it is, what is wrong and what to change. No
 * findings means: every part is labelled, defined and in this version; everything a template names
 * is declared or known; every extension says what its value is; no two templates are told apart by
 * nothing; every template and every primary pattern has an example that the specification's own
 * algorithm accepts; and every rule is a JSONPath that algorithm will read.
 *
 * Examples are not part of xAPI Profiles 1.0, which has no place for them. They are kept beside
 * the document and published with the version.
 */
import { apply_jsonpath, elementsOf, follows, inOrder, matches, validates, type Json, type Judged } from './processor.js';

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const isIri = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(v);

/** A statement offered as an example of one or more templates: the ones `validates` must say it follows, and no others. */
export interface ExampleStatement { id: string; follows: string[]; statement: Json }
/** A run of statements offered as an example of a pattern. A member is a statement, or the id of an example statement. */
export interface ExampleSequence { id: string; pattern: string; statements: Array<Json | string> }
export interface ProfileExamples { statements: ExampleStatement[]; sequences: ExampleSequence[] }
/** A term another publisher defines, which this profile's templates name and its writer vouches for. */
export interface ExternalTerm { id: string; type: string }

export interface LintFinding {
  /** What kind of problem, stable enough to filter on. */
  code: string;
  /** The IRI of the concept, template or pattern, or `profile`, or `example:<id>`. */
  at: string;
  /** Where in the draft: `templates[3].rules[1].location`. */
  path: string;
  message: string;
  /** What to change. */
  fix: string;
}

export interface LintOptions {
  /** The version being written. Defaults to the first entry of `versions`. */
  readonly version?: string;
  /** The type of a term defined outside this document, when it is known: hosted here in another profile, or vouched for. */
  readonly external?: (iri: string) => string | undefined;
}

export const CONCEPT_TYPES = ['Verb', 'ActivityType', 'AttachmentUsageType', 'ContextExtension', 'ResultExtension', 'ActivityExtension',
  'StateResource', 'AgentProfileResource', 'ActivityProfileResource', 'Activity'] as const;
const PROFILE_CONTEXT = 'https://w3id.org/xapi/profiles/context';
const EXTENSION_TYPES = ['ContextExtension', 'ResultExtension', 'ActivityExtension'];
const PATTERN_KINDS = ['sequence', 'alternates', 'optional', 'oneOrMore', 'zeroOrMore'] as const;
const ACTIVITY_TYPE_PROPERTIES = ['objectActivityType', 'contextGroupingActivityType', 'contextParentActivityType', 'contextOtherActivityType', 'contextCategoryActivityType'] as const;
const DETERMINING = ['verb', ...ACTIVITY_TYPE_PROPERTIES, 'attachmentUsageType'] as const;

const hasText = (v: unknown): boolean => isObject(v) && Object.values(v).some(x => typeof x === 'string' && x.trim() !== '');

/** Which kind of extension a rule's path reads, from where it sits in a statement. */
function extensionsNamed(path: string): Array<{ iri: string; type: string }> {
  const out: Array<{ iri: string; type: string }> = [];
  // `$["context"]["extensions"][…]` reads the same place as `$.context.extensions[…]`: put a quoted
  // plain name back in dot form first, so what is found does not depend on which the writer chose.
  const dotted = path.replace(/\[\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)")\s*\]/g, (_m, single?: string, double?: string) => `.${single ?? double}`);
  for (const m of dotted.matchAll(/([A-Za-z]+)\.extensions\s*\[\s*(?:'([^']+)'|"([^"]+)")\s*\]/g)) {
    const iri = m[2] ?? m[3]!;
    out.push({ iri, type: m[1] === 'context' ? 'ContextExtension' : m[1] === 'result' ? 'ResultExtension' : 'ActivityExtension' });
  }
  return out;
}

/** The determining properties of a template as one comparable string. */
function determiningKey(template: Json): string {
  return JSON.stringify(DETERMINING.map(p => p === 'verb' ? (typeof template.verb === 'string' ? template.verb : null) : [...new Set(strings(template[p]))].sort()));
}

export function emptyExamples(): ProfileExamples { return { statements: [], sequences: [] }; }

/**
 * Lint a profile document and the examples kept beside it. Pure: it reads nothing but its arguments.
 */
export function lintProfile(doc: unknown, examples: ProfileExamples = emptyExamples(), options: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const say = (code: string, at: string, path: string, message: string, fix: string) => { findings.push({ code, at, path, message, fix }); };
  if (!isObject(doc)) { say('profile-shape', 'profile', '', 'A profile is a JSON object.', 'Send the profile as a JSON object.'); return findings; }

  // ── The profile itself ──
  const versions = list(doc.versions).filter(isObject);
  const version = options.version ?? (typeof versions[0]?.id === 'string' ? versions[0].id : undefined);
  if (!isIri(doc.id)) say('profile-id', 'profile', 'id', 'The profile has no id that is an IRI.', 'Give the profile an "id": the IRI it is known by.');
  if (!list(doc.type).includes('Profile')) say('profile-type', 'profile', 'type', 'The profile does not say it is one.', 'Set "type": "Profile".');
  // The server reads a profile with the xAPI Profiles context whatever the document says. A document
  // that names another, or none, would mean one thing as JSON-LD and another as the triples served.
  // An entry of the array has to BE the context IRI: equality with a whole entry, not a search inside a string.
  if (!list(doc['@context']).some(entry => entry === PROFILE_CONTEXT)) say('profile-context', 'profile', '@context', doc['@context'] === undefined ? 'The document has no @context, so it is not read as JSON-LD.' : 'The @context does not include the xAPI Profiles context, so its terms are not read as the ones the specification defines.', `Set "@context": "${PROFILE_CONTEXT}", or an array that includes it.`);
  if (doc.conformsTo !== 'https://w3id.org/xapi/profiles#1.0') say('profile-conforms-to', 'profile', 'conformsTo', 'The profile does not say which specification it conforms to.', 'Set "conformsTo": "https://w3id.org/xapi/profiles#1.0".');
  if (!hasText(doc.prefLabel)) say('label', 'profile', 'prefLabel', 'The profile has no label.', 'Give it a "prefLabel": a language map such as { "en": "…" }.');
  if (!hasText(doc.definition)) say('definition', 'profile', 'definition', 'The profile has no definition.', 'Give it a "definition": a language map saying what the profile is for.');
  if (!isObject(doc.author) || typeof doc.author.name !== 'string' || !['Organization', 'Person'].includes(String(doc.author.type)))
    say('profile-author', 'profile', 'author', 'The profile does not say who wrote it.', 'Give it an "author": { "type": "Organization" or "Person", "name": "…" }.');
  if (!isIri(version)) say('profile-version', 'profile', 'versions', 'The profile names no version.', 'Give it "versions": [{ "id": "<the IRI of this version>" }].');
  else if (version === doc.id) say('profile-version', 'profile', 'versions[0].id', 'The version has the profile\'s own IRI.', 'Give the version an IRI of its own, such as "<profile>/v/1".');

  // ── Every part: an id of its own, a label, a definition, and in this version ──
  const parts = (['concepts', 'templates', 'patterns'] as const).flatMap(key => {
    if (doc[key] !== undefined && !Array.isArray(doc[key])) say('profile-shape', 'profile', key, `"${key}" is not an array.`, `Make "${key}" an array of objects.`);
    return list(doc[key]).map((part, index) => ({ key, index, part }));
  });
  const seen = new Map<string, string>();
  const concepts: Json[] = [], templates: Json[] = [], patterns: Json[] = [];
  const where = new Map<Json, string>();
  for (const { key, index, part } of parts) {
    const path = `${key}[${index}]`;
    if (!isObject(part)) { say('profile-shape', 'profile', path, 'This entry is not an object.', 'Replace it with an object, or remove it.'); continue; }
    if (!isIri(part.id)) { say('term-id', 'profile', `${path}.id`, 'This entry has no id that is an IRI.', 'Give it an "id".'); continue; }
    const id = part.id;
    if (seen.has(id)) { say('duplicate-id', id, `${path}.id`, `The id is already used at ${seen.get(id)}.`, 'Give each concept, template and pattern an IRI of its own.'); continue; }
    seen.set(id, path); where.set(part, path);
    (key === 'concepts' ? concepts : key === 'templates' ? templates : patterns).push(part);
    const type = String(part.type ?? '');
    const wanted = key === 'concepts' ? CONCEPT_TYPES as readonly string[] : [key === 'templates' ? 'StatementTemplate' : 'Pattern'];
    if (!wanted.includes(type)) say('term-type', id, `${path}.type`, `"type" is ${JSON.stringify(part.type ?? null)}.`, `Set "type" to ${wanted.length === 1 ? `"${wanted[0]}"` : `one of ${wanted.join(', ')}`}.`);
    // An Activity concept is described by its activityDefinition, which carries its own name and description.
    if (type !== 'Activity') {
      if (!hasText(part.prefLabel)) say('label', id, `${path}.prefLabel`, 'It has no label.', 'Give it a "prefLabel": a language map such as { "en": "…" }.');
      if (!hasText(part.definition)) say('definition', id, `${path}.definition`, 'It has no definition.', 'Give it a "definition": a language map saying what it means and when it is used.');
    } else if (!isObject(part.activityDefinition)) say('definition', id, `${path}.activityDefinition`, 'The Activity has no activityDefinition.', 'Give it an "activityDefinition" as an xAPI Activity Definition.');
    if (version !== undefined && part.inScheme !== version) say('in-scheme', id, `${path}.inScheme`, `"inScheme" is ${JSON.stringify(part.inScheme ?? null)}, and the version being written is ${version}.`, `Set "inScheme" to "${version}".`);
  }
  const live = <T extends Json>(all: T[]): T[] => all.filter(p => p.deprecated !== true);
  const conceptType = new Map(concepts.map(c => [String(c.id), String(c.type ?? '')]));

  // ── Extensions say what their value is ──
  for (const concept of concepts) {
    const id = String(concept.id), path = where.get(concept)!;
    const both = concept.schema !== undefined && concept.inlineSchema !== undefined;
    if (both) say('schema-both', id, path, 'It has both "schema" and "inlineSchema".', 'Keep one: "inlineSchema" for a JSON Schema written here, "schema" for the IRI of one.');
    if (concept.inlineSchema !== undefined) {
      let parsed: unknown;
      try { parsed = typeof concept.inlineSchema === 'string' ? JSON.parse(concept.inlineSchema) : undefined; } catch { parsed = undefined; }
      if (!isObject(parsed) && typeof parsed !== 'boolean') say('schema-unreadable', id, `${path}.inlineSchema`, '"inlineSchema" is not a JSON Schema written as a string of JSON.', 'Set it to a string of JSON, such as "{\\"type\\":\\"string\\"}".');
    }
    if (concept.schema !== undefined && !isIri(concept.schema)) say('schema-unreadable', id, `${path}.schema`, '"schema" is not an IRI.', 'Set "schema" to the IRI of a JSON Schema, or use "inlineSchema".');
    if (EXTENSION_TYPES.includes(String(concept.type)) && concept.deprecated !== true && concept.schema === undefined && concept.inlineSchema === undefined)
      say('extension-schema', id, path, 'The extension does not say what its value is.', 'Add an "inlineSchema" (a JSON Schema as a string, such as "{\\"type\\":\\"string\\"}") or a "schema" IRI.');
  }

  // ── What a template names is declared or known ──
  const known = (iri: string, type: string): 'yes' | 'unknown' | string => {
    const here = conceptType.get(iri);
    if (here !== undefined) return here === type ? 'yes' : here;
    const elsewhere = options.external?.(iri);
    if (elsewhere === undefined) return 'unknown';
    return elsewhere === type || elsewhere === '' ? 'yes' : elsewhere;
  };
  const named = (template: Json, iri: string, type: string, path: string, what: string) => {
    const k = known(iri, type);
    if (k === 'yes') return;
    if (k === 'unknown') say('undeclared-term', String(template.id), path, `The ${what} ${iri} is not declared in this profile and is not a known term of another.`,
      `Declare it under "concepts" with "type": "${type}", or, if another publisher defines it, list it under the draft's external terms.`);
    else say('term-kind', String(template.id), path, `${iri} is named as a ${type} and is declared as a ${k}.`, `Name a ${type} here, or declare the term as one.`);
  };
  const templateIds = new Set(templates.map(t => String(t.id)));
  for (const template of templates) {
    if (template.deprecated === true) continue;
    const id = String(template.id), path = where.get(template)!;
    if (template.verb !== undefined) { if (isIri(template.verb)) named(template, template.verb, 'Verb', `${path}.verb`, 'verb'); else say('term-id', id, `${path}.verb`, '"verb" is not an IRI.', 'Set "verb" to the IRI of a verb.'); }
    for (const property of ACTIVITY_TYPE_PROPERTIES) for (const iri of strings(template[property])) named(template, iri, 'ActivityType', `${path}.${property}`, 'activity type');
    for (const iri of strings(template.attachmentUsageType)) named(template, iri, 'AttachmentUsageType', `${path}.attachmentUsageType`, 'attachment usage type');
    for (const property of ['objectStatementRefTemplate', 'contextStatementRefTemplate'] as const)
      for (const ref of strings(template[property])) if (!templateIds.has(ref)) say('unknown-reference', id, `${path}.${property}`, `${ref} is not a statement template of this profile.`, 'Name a template of this profile, or remove the reference.');
    if (template.objectStatementRefTemplate !== undefined && template.objectActivityType !== undefined)
      say('template-shape', id, path, 'It states both objectActivityType and objectStatementRefTemplate, and an object is one or the other.', 'Keep one of the two.');

    // ── Rules are JSONPath the algorithm reads ──
    if (template.rules !== undefined && !Array.isArray(template.rules)) say('rule-shape', id, `${path}.rules`, '"rules" is not an array.', 'Make "rules" an array of rule objects.');
    for (const [r, rule] of list(template.rules).entries()) {
      const at = `${path}.rules[${r}]`;
      if (!isObject(rule)) { say('rule-shape', id, at, 'The rule is not an object.', 'Replace it with { "location": "$.…", "presence": "included" } or similar.'); continue; }
      for (const key of ['location', 'selector'] as const) {
        const value = rule[key];
        if (value === undefined && key === 'selector') continue;
        if (typeof value !== 'string') { say('rule-jsonpath', id, `${at}.${key}`, `The rule has no "${key}".`, 'Give it a JSONPath that starts at $, such as "$.result.score.raw".'); continue; }
        try { apply_jsonpath({}, value); }
        catch (e) { say('rule-jsonpath', id, `${at}.${key}`, `"${value}" is not a JSONPath the specification allows: ${(e as Error).message}.`, 'Use child names, [\'quoted keys\'], non-negative indices, * and .. only, starting at $. Filters and script expressions are not allowed.'); continue; }
        for (const ext of extensionsNamed(value)) named(template, ext.iri, ext.type, `${at}.${key}`, 'extension');
      }
      if (rule.presence !== undefined && !['included', 'excluded', 'recommended'].includes(String(rule.presence)))
        say('rule-shape', id, `${at}.presence`, `"presence" is ${JSON.stringify(rule.presence)}.`, 'Set it to "included", "excluded" or "recommended".');
      for (const key of ['any', 'all', 'none'] as const) if (rule[key] !== undefined && !Array.isArray(rule[key])) say('rule-shape', id, `${at}.${key}`, `"${key}" is not an array.`, `Make "${key}" an array of values.`);
      if (rule.presence === undefined && rule.any === undefined && rule.all === undefined && rule.none === undefined)
        say('rule-shape', id, at, 'The rule asks for nothing: it has none of presence, any, all and none.', 'State at least one of them, or remove the rule.');
    }
  }

  // ── No two templates are told apart by nothing ──
  const byKey = new Map<string, string>();
  for (const template of live(templates)) {
    const key = determiningKey(template), first = byKey.get(key);
    if (first === undefined) { byKey.set(key, String(template.id)); continue; }
    say('same-determining-properties', String(template.id), where.get(template)!, `It has the same determining properties as ${first}, so every statement that matches one matches the other and has to follow the rules of both.`,
      'Give one of them a determining property the other lacks (a verb, an object activity type, a context activity type or an attachment usage type), or merge the two.');
  }

  // ── Patterns ──
  const patternById = new Map(patterns.map(p => [String(p.id), p]));
  const deprecated = new Set([...templates, ...patterns].filter(p => p.deprecated === true).map(p => String(p.id)));
  for (const pattern of live(patterns)) {
    const id = String(pattern.id), path = where.get(pattern)!;
    const kinds = PATTERN_KINDS.filter(k => pattern[k] !== undefined);
    if (kinds.length !== 1) { say('pattern-shape', id, path, `It states ${kinds.length === 0 ? 'none' : kinds.join(' and ')} of sequence, alternates, optional, oneOrMore and zeroOrMore.`, 'State exactly one of them.'); continue; }
    const kind = kinds[0]!;
    const members = kind === 'sequence' || kind === 'alternates' ? pattern[kind] : [pattern[kind]];
    if (!Array.isArray(members) || members.length === 0 || !members.every(m => typeof m === 'string')) { say('pattern-shape', id, `${path}.${kind}`, `"${kind}" does not name ${kind === 'sequence' || kind === 'alternates' ? 'an array of templates and patterns' : 'a template or a pattern'} by IRI.`, 'Name each member by the IRI of a template or pattern of this profile.'); continue; }
    for (const member of members as string[]) {
      if (!templateIds.has(member) && !patternById.has(member)) say('unknown-reference', id, `${path}.${kind}`, `${member} is neither a statement template nor a pattern of this profile.`, 'Name a template or pattern of this profile, or add the missing one.');
      else if (deprecated.has(member)) say('deprecated-reference', id, `${path}.${kind}`, `${member} is deprecated, and this pattern still uses it.`, 'Take it out of this pattern, or deprecate the pattern too.');
    }
    if (pattern.primary !== undefined && typeof pattern.primary !== 'boolean') say('pattern-shape', id, `${path}.primary`, '"primary" is not true or false.', 'Set "primary" to true for a pattern statements are checked against, false otherwise.');
  }
  const membersOf = (p: Json): string[] => PATTERN_KINDS.flatMap(k => strings(p[k]));
  for (const pattern of live(patterns)) {
    const start = String(pattern.id), stack = [...membersOf(pattern)], visited = new Set<string>();
    while (stack.length) {
      const next = stack.pop()!;
      if (next === start) { say('pattern-cycle', start, where.get(pattern)!, 'The pattern contains itself, directly or through another pattern.', 'A pattern is made of templates and of other patterns that do not lead back to it.'); break; }
      if (visited.has(next)) continue;
      visited.add(next);
      const inner = patternById.get(next);
      if (inner) stack.push(...membersOf(inner));
    }
  }

  // ── Every template has an example the algorithm says follows it, and only what the example claims ──
  // Past this point the processor runs over the document. It needs unique ids and readable rules.
  if (findings.some(f => ['profile-shape', 'term-id', 'duplicate-id', 'rule-jsonpath', 'rule-shape', 'pattern-shape', 'pattern-cycle', 'unknown-reference'].includes(f.code))) {
    return findings;
  }
  const liveTemplates = live(templates), livePatterns = live(patterns);
  const liveIds = new Set(liveTemplates.map(t => String(t.id)));
  const exampleById = new Map(examples.statements.map(e => [e.id, e]));
  const statementById = (id: string): Json | undefined => examples.statements.find(e => e.statement.id === id)?.statement;
  const followed = new Set<string>();
  for (const [i, example] of examples.statements.entries()) {
    const at = `example:${example.id}`, path = `examples.statements[${i}]`;
    if (!isObject(example.statement)) { say('example-shape', at, `${path}.statement`, 'The example has no statement.', 'Give it "statement": one xAPI Statement.'); continue; }
    const claimed = [...new Set(strings(example.follows))];
    if (claimed.length === 0) { say('example-shape', at, `${path}.follows`, 'The example does not say which template it is an example of.', 'Set "follows" to the IRIs of the templates the statement should follow.'); continue; }
    const strangers = claimed.filter(c => !liveIds.has(c));
    if (strangers.length) { say('example-unknown-template', at, `${path}.follows`, `${strangers.join(', ')} ${strangers.length === 1 ? 'is' : 'are'} not ${strangers.some(s => deprecated.has(s)) ? 'a current' : 'a'} statement template of this profile.`, 'Name templates of this profile that are not deprecated, or remove the example.'); continue; }
    let result;
    try { result = validates(example.statement, liveTemplates, { statementById }); }
    catch (e) { say('example-does-not-follow', at, path, `The statement could not be checked: ${(e as Error).message}.`, 'Correct the statement or the rule it trips on.'); continue; }
    if (result.outcome === 'unmatched') { say('example-does-not-follow', at, path, `The statement matches no template: it does not carry the determining properties of ${claimed.join(', ')}.`, 'Give the statement the verb, object activity type, context activity types and attachment usage types the template states.'); continue; }
    if (result.outcome === 'invalid') {
      for (const f of result.findings) say('example-does-not-follow', at, path, `The statement matches ${f.template} and does not follow it${f.location ? ` at ${f.location}` : ''}: ${f.reason}.`,
        claimed.includes(f.template) ? 'Change the statement to follow the rule, or the rule to say what you mean.' : `The statement also matches ${f.template}, which the example does not claim. Tell the two templates apart with a determining property, or make the statement follow both and claim both.`);
      continue;
    }
    const extra = result.templates.filter(t => !claimed.includes(t)), missing = claimed.filter(c => !result.templates.includes(c));
    if (extra.length) say('example-follows-another', at, `${path}.follows`, `The statement also follows ${extra.join(', ')}, which the example does not claim.`,
      'If a statement of this kind is meant to follow both, add the other to "follows". If it is not, give one template a determining property the other lacks.');
    if (missing.length) say('example-does-not-follow', at, path, `The statement does not match ${missing.join(', ')}: it lacks a determining property the template states.`, 'Give the statement what the template states, or take the template out of "follows".');
    if (!extra.length && !missing.length) for (const t of result.templates) followed.add(t);
  }
  for (const template of liveTemplates) {
    if (!followed.has(String(template.id))) say('template-example', String(template.id), where.get(template)!, 'No example statement follows this template.',
      'Add an example statement whose "follows" names this template and that the template\'s rules accept.');
  }

  // ── Every primary pattern has an example run the algorithm accepts ──
  const of = elementsOf(liveTemplates, livePatterns);
  const matched = new Set<string>();
  for (const [i, sequence] of examples.sequences.entries()) {
    const at = `example:${sequence.id}`, path = `examples.sequences[${i}]`;
    const pattern = patternById.get(sequence.pattern);
    if (!pattern || pattern.deprecated === true) { say('example-unknown-pattern', at, `${path}.pattern`, `${sequence.pattern} is not a current pattern of this profile.`, 'Name a pattern of this profile, or remove the example.'); continue; }
    const statements: Json[] = [];
    let unresolved: string | undefined;
    for (const member of list(sequence.statements)) {
      if (typeof member === 'string') { const found = exampleById.get(member); if (found) statements.push(found.statement); else unresolved = member; }
      else if (isObject(member)) statements.push(member);
    }
    if (unresolved !== undefined) { say('example-shape', at, `${path}.statements`, `"${unresolved}" is not the id of an example statement.`, 'Name an example statement by its id, or put the statement itself there.'); continue; }
    if (statements.length === 0) { say('example-shape', at, `${path}.statements`, 'The example run has no statements.', 'Give it the statements of one registration, in order.'); continue; }
    try {
      const whole = follows(statements, liveTemplates, livePatterns, { statementById });
      if (!whole.follows) { say('sequence-does-not-follow', at, path, `The run does not follow the profile: ${whole.reasons.join('; ')}.`, 'Change the run, or the pattern, until every statement follows a template and one primary pattern takes the whole run.'); continue; }
      const judged: Judged[] = inOrder(statements).map(statement => ({ statement, templates: validates(statement, liveTemplates, { statementById }).templates }));
      const [outcome, left] = matches(judged, sequence.pattern, of);
      if (outcome !== 'success' || left.length > 0) {
        say('sequence-does-not-follow', at, path, outcome === 'success' ? `${sequence.pattern} takes the first ${judged.length - left.length} of ${judged.length} statements and not the rest.`
          : outcome === 'partial' ? `The run ends before ${sequence.pattern} does.` : `${sequence.pattern} does not match the run from its first statement.`,
        'Change the run to be one complete pass through this pattern.');
        continue;
      }
      matched.add(sequence.pattern);
    } catch (e) { say('sequence-does-not-follow', at, path, `The run could not be checked: ${(e as Error).message}.`, 'Correct the pattern it trips on.'); }
  }
  for (const pattern of livePatterns) {
    if (pattern.primary === true && !matched.has(String(pattern.id))) say('pattern-example', String(pattern.id), where.get(pattern)!, 'No example run follows this primary pattern.',
      'Add an example sequence with "pattern" set to this pattern and the statements of one registration that it accepts.');
  }
  return findings;
}
