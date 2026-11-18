/**
 * The xapi-x rules (../../xapix/README.md, section 7) as code: a rule set beside the profile
 * lint, with the same finding shape, so the two lists are read as one.
 *
 * ★ THE JUDGE IS STILL ../xapi-profile-server/processor.ts. Whether a statement follows a template
 * is `validates`' answer, here as there. These rules read only what the specification leaves
 * unread: the decorations.
 *
 *   lintXapixStatements   X1 to X8, over statements, given the profiles that declare their keys
 *   lintXapixProfile      X9 and X10, over a profile and its examples
 *
 * X11 (no two templates share their determining properties) is the profile lint's own
 * `same-determining-properties`, and is not repeated here.
 *
 * What is not checkable from what a lint holds is said in the rule's comment, not guessed at.
 */
import { validates, type Json } from '../xapi-profile-server/processor.js';
import { lintProfile, type LintFinding, type ProfileExamples } from '../xapi-profile-server/lint.js';
import { schemaFailure } from '../xapi-profile-server/extension-schema.js';
import { IEP_DECORATIONS, IEP_NS, XAPIX_NS, xapix } from './namespace.js';
import { PROJECTION_TYPE, isDigest } from './statement.js';

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
const isDecoration = (key: string): boolean => key.startsWith(IEP_NS) || key.startsWith(XAPIX_NS);
const isIri = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The adapter has stated `projectionLossy` on every projection since this day; before it, absent meant not stated. */
export const LOSSY_ALWAYS_STATED_SINCE = '2026-11-15T00:00:00.000Z';

export interface XapixStatementOptions {
  /** Verbs that say an outcome, beyond the ones the profiles show to be (see `outcomeVerbsOf`). */
  readonly outcomeVerbs?: Iterable<string>;
}

interface Declared { type: string; schema?: unknown }

function declarations(profiles: readonly Json[]): Map<string, Declared> {
  const out = new Map<string, Declared>();
  for (const profile of profiles) for (const concept of list(profile.concepts)) {
    if (!isObject(concept) || typeof concept.id !== 'string' || concept.deprecated === true) continue;
    let schema: unknown;
    try { schema = typeof concept.inlineSchema === 'string' ? JSON.parse(concept.inlineSchema) : undefined; } catch { schema = undefined; }
    out.set(concept.id, { type: String(concept.type ?? ''), ...(schema !== undefined ? { schema } : {}) });
  }
  return out;
}

/**
 * The verbs a profile shows to be outcome verbs: a template with that verb requires
 * `result.success`, `result.completion` or a member of `result.score`. Profiles 1.0 has no
 * property that marks a verb as an outcome and xapi-x adds none, so this reads what a profile
 * already says about its statements.
 */
export function outcomeVerbsOf(profiles: readonly Json[]): Set<string> {
  const out = new Set<string>();
  for (const profile of profiles) for (const template of list(profile.templates)) {
    if (!isObject(template) || typeof template.verb !== 'string' || template.deprecated === true) continue;
    const asksForOutcome = list(template.rules).some(rule => isObject(rule) && rule.presence === 'included'
      && /^\$\.result\.(success|completion|score)\b/.test(String(rule.location ?? '')));
    if (asksForOutcome) out.add(template.verb);
  }
  return out;
}

/** A value against a parsed schema: the profile server's reader, which the decorations share. */
export { schemaFailure };

const extensionsAt = (statement: Json, member: 'result' | 'context'): Json => {
  const holder = statement[member];
  return isObject(holder) && isObject(holder.extensions) ? holder.extensions : {};
};

/** A key that reads as a position in a sequence: the kind of counter section 6 says proves nothing. */
const READS_AS_A_POSITION = /(^|[^a-z])(seq|sequence|sequence ?(number|index|no)|ordinal|position|counter|step ?(number|index))$/i;
const localName = (key: string): string => (key.split(/[#/]/).filter(Boolean).pop() ?? key).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

/**
 * X1 to X8 over statements. `profiles` are the documents that declare the keys the statements
 * carry: the xapi-x profile, and the domain profile the statements name.
 */
export function lintXapixStatements(statements: readonly Json[], profiles: readonly Json[], options: XapixStatementOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const declared = declarations(profiles);
  const outcomeVerbs = new Set([...outcomeVerbsOf(profiles), ...(options.outcomeVerbs ?? [])]);
  for (const [index, statement] of statements.entries()) {
    const at = `statement:${typeof statement.id === 'string' ? statement.id : index}`;
    const say = (code: string, path: string, message: string, fix: string) => { findings.push({ code, at, path: `statements[${index}]${path ? `.${path}` : ''}`, message, fix }); };
    const result = extensionsAt(statement, 'result'), context = extensionsAt(statement, 'context');

    // X1: declared, and where its type says. X2: a value the declaration allows.
    for (const [member, extensions, wanted] of [['result', result, 'ResultExtension'], ['context', context, 'ContextExtension']] as const) {
      for (const [key, value] of Object.entries(extensions)) {
        if (!isDecoration(key)) continue;
        const path = `${member}.extensions['${key}']`;
        const d = declared.get(key);
        if (!d) { say('xapix-undeclared', path, `${key} is not declared by any profile given.`, 'Declare the key in a profile, or name the profile that declares it.'); continue; }
        if (d.type !== wanted) say('xapix-misplaced', path, `${key} is declared as a ${d.type} and sits in ${member}.`, `Move it to ${d.type === 'ResultExtension' ? 'result' : 'context'}.extensions.`);
        const failure = schemaFailure(value, d.schema);
        if (failure) say('xapix-value', path, `The value ${failure}.`, 'Write a value the key\'s inlineSchema allows.');
      }
    }

    // X3: a source descriptor and a modal status come together.
    const source = result[IEP_DECORATIONS.sourceDescriptor], modal = result[IEP_DECORATIONS.modalStatus];
    if ((source === undefined) !== (modal === undefined))
      say('xapix-source-and-status', 'result.extensions', source === undefined ? 'It states a modal status and names no source descriptor.' : 'It names a source descriptor and states no modal status.', 'State both, or neither.');

    // X4: nothing a plain LRS would count, on a statement that is not asserted.
    if (modal !== undefined && modal !== 'Asserted') {
      const r = isObject(statement.result) ? statement.result : {};
      for (const member of ['success', 'completion', 'score'] as const)
        if (r[member] !== undefined) say('xapix-outcome-not-asserted', `result.${member}`, `The statement is ${String(modal)} and carries result.${member}, which a plain LRS counts.`, `Remove result.${member}: a statement that is not asserted reports no outcome.`);
      const verb = isObject(statement.verb) ? statement.verb.id : undefined;
      if (typeof verb === 'string' && outcomeVerbs.has(verb)) say('xapix-outcome-not-asserted', 'verb.id', `The statement is ${String(modal)} and uses ${verb}, a verb that says an outcome.`, 'Use a verb that says what was proposed or considered.');
    }

    // X5 and X6: what the lossy flag says.
    const narratives = result[IEP_DECORATIONS.coherentNarratives], lossy = result[IEP_DECORATIONS.projectionLossy];
    if (Array.isArray(narratives) && narratives.length > 1 && lossy !== true)
      say('xapix-lossy', `result.extensions['${IEP_DECORATIONS.projectionLossy}']`, 'It keeps more than one narrative and does not say the projection is lossy.', 'State projectionLossy: true.');
    if (modal !== undefined && modal !== 'Asserted' && lossy === false)
      say('xapix-lossy', `result.extensions['${IEP_DECORATIONS.projectionLossy}']`, `It is ${String(modal)}, which a statement cannot say outside an extension, and it says the projection lost nothing.`, 'State projectionLossy: true.');
    const written = typeof statement.timestamp === 'string' ? Date.parse(statement.timestamp) : NaN;
    if (source !== undefined && lossy === undefined && !(written < Date.parse(LOSSY_ALWAYS_STATED_SINCE)))
      say('xapix-lossy', `result.extensions['${IEP_DECORATIONS.projectionLossy}']`, 'It is a projection and does not say whether it lost anything.', 'State projectionLossy: true or false.');

    // X7: what it supersedes. Whether a superseded statement was wrong, and so should also have
    // been voided, is not something a statement says: only its emitter knows a revision from a correction.
    const superseded = context[xapix('supersedesStatement')];
    if (superseded !== undefined) {
      const path = `context.extensions['${xapix('supersedesStatement')}']`;
      const ids = list(superseded);
      if (!Array.isArray(superseded) || ids.length === 0 || !ids.every(id => typeof id === 'string' && UUID.test(id))) say('xapix-supersedes', path, 'It is not a list of statement ids.', 'Write an array of the UUIDs of the statements this one replaces.');
      else {
        if (typeof statement.id === 'string' && ids.some(id => String(id).toLowerCase() === (statement.id as string).toLowerCase())) say('xapix-supersedes', path, 'The statement says it supersedes itself.', 'Name only earlier statements.');
        const ref = isObject(statement.context) && isObject(statement.context.statement) ? statement.context.statement.id : undefined;
        if (ref === undefined) say('xapix-supersedes', 'context.statement', 'It supersedes statements and gives a plain LRS no reference to any of them.', 'Set context.statement to a StatementRef to the most recent statement it supersedes.');
        else if (!ids.includes(ref)) say('xapix-supersedes', 'context.statement', 'context.statement refers to a statement that is not among the ones it supersedes.', 'Refer to one of the superseded statements.');
      }
    }

    // X8: no bare number standing for a place in a sequence, under any namespace.
    for (const [member, extensions] of [['result', result], ['context', context]] as const) for (const [key, value] of Object.entries(extensions))
      if (typeof value === 'number' && READS_AS_A_POSITION.test(localName(key))) say('xapix-bare-position', `${member}.extensions['${key}']`, `${key} gives the statement a place in a sequence as a bare number, which is the emitter's claim and shows nothing.`, 'Name the statement before it (previous) and its digest (previousDigest), or leave order to timestamp and stored.');

    // The ordering keys say what their declarations say they are.
    const previous = context[xapix('previous')], previousDigest = context[xapix('previousDigest')];
    if (previousDigest !== undefined && previous === undefined) say('xapix-chain', `context.extensions['${xapix('previousDigest')}']`, 'It carries the digest of a statement it does not name.', 'State previous with previousDigest.');
    if (previous !== undefined && previous === statement.id) say('xapix-chain', `context.extensions['${xapix('previous')}']`, 'The statement names itself as the one before it.', 'Name the statement emitted immediately before.');
    for (const key of ['previousDigest', 'descriptorDigest'] as const) { const v = context[xapix(key)]; if (v !== undefined && !isDigest(v)) say('xapix-value', `context.extensions['${xapix(key)}']`, 'It is not "sha256:" and 64 hex characters.', 'Write the digest in that form.'); }

    // A statement that names its source descriptor needs no controls: the descriptor carries its own.
    if (context[xapix('controls')] !== undefined && source !== undefined) say('xapix-controls', `context.extensions['${xapix('controls')}']`, 'It links to controls and also names a source descriptor, which carries its own affordances.', 'Drop the controls link: a consumer follows the descriptor.');
  }
  return findings;
}

// ── Over a profile ───────────────────────────────────────────────────────────────────────────

export interface XapixProfileOptions {
  /** Whether an IRI is a concept of the pinned I2IDL release or of `i2x:`. Absent: targets are checked for shape only. */
  readonly designIdea?: (iri: string) => boolean;
  /** Whether an IRI dereferences to an affordance. Absent: targets are checked for shape only. */
  readonly affordance?: (iri: string) => boolean;
  /** Passed to the profile lint when the stripped profile is linted. */
  readonly external?: (iri: string) => string | undefined;
}

const targets = (value: unknown): Array<string | undefined> => list(value).map(v => isObject(v) && isIri(v['@id']) ? v['@id'] : undefined);

/** The profile with every `xapix:` property removed: what a plain processor reads. */
export function withoutDecorations(doc: Json): Json {
  const strip = (part: unknown): unknown => isObject(part) ? Object.fromEntries(Object.entries(part).filter(([k]) => !k.startsWith(XAPIX_NS))) : part;
  const out = strip(doc) as Json;
  for (const key of ['concepts', 'templates', 'patterns']) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(strip);
  return out;
}

/** The statement with every decoration removed: no `iep:` or `xapix:` extension, no projection category. */
export function statementWithoutDecorations(statement: Json): Json {
  const out: Json = { ...statement };
  for (const member of ['result', 'context'] as const) {
    const holder = out[member];
    if (!isObject(holder)) continue;
    const next: Json = { ...holder };
    if (isObject(next.extensions)) {
      const kept = Object.fromEntries(Object.entries(next.extensions).filter(([k]) => !isDecoration(k)));
      if (Object.keys(kept).length > 0) next.extensions = kept; else delete next.extensions;
    }
    if (member === 'context' && isObject(next.contextActivities) && next.contextActivities.category !== undefined) {
      const kept = list(next.contextActivities.category).filter(c => !(isObject(c) && (c.id === PROJECTION_TYPE || (isObject(c.definition) && c.definition.type === PROJECTION_TYPE))));
      const activities: Json = { ...next.contextActivities };
      if (kept.length > 0) activities.category = kept; else delete activities.category;
      if (Object.keys(activities).length > 0) next.contextActivities = activities; else delete next.contextActivities;
    }
    if (Object.keys(next).length > 0) out[member] = next; else delete out[member];
  }
  return out;
}

/**
 * Whether following the template depends on a decoration: a rule or a determining property names
 * one. A property that asks nothing of a statement, such as `xapix:offers`, does not count.
 */
const DECIDES_A_MATCH = ['rules', 'verb', 'objectActivityType', 'contextGroupingActivityType', 'contextParentActivityType', 'contextOtherActivityType', 'contextCategoryActivityType', 'attachmentUsageType'];
const asksForADecoration = (template: Json): boolean => {
  const read = JSON.stringify(DECIDES_A_MATCH.map(k => template[k] ?? null));
  return read.includes(IEP_NS) || read.includes(XAPIX_NS);
};

/** X9 and X10 over a profile and the examples kept beside it. */
export function lintXapixProfile(doc: Json, examples: ProfileExamples = { statements: [], sequences: [] }, options: XapixProfileOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  const say = (code: string, at: string, path: string, message: string, fix: string) => { findings.push({ code, at, path, message, fix }); };

  // X9: every evidence link names a design idea, and every offer an affordance.
  for (const [key, property, resolve, what] of [['concepts', 'evidences', options.designIdea, 'a concept of the pinned I2IDL release or of i2x:'], ['templates', 'offers', options.affordance, 'an affordance']] as const) {
    for (const [i, part] of list(doc[key]).entries()) {
      if (!isObject(part) || part[xapix(property)] === undefined) continue;
      const path = `${key}[${i}]['${xapix(property)}']`, id = String(part.id);
      for (const target of targets(part[xapix(property)])) {
        if (target === undefined) say('xapix-link-shape', id, path, `A target of ${property} is not written as { "@id": "<IRI>" }.`, 'Write each target as an object with an "@id" that is an IRI.');
        else if (resolve && !resolve(target)) say('xapix-link-target', id, path, `${target} is not ${what}.`, property === 'evidences' ? 'Name a concept that exists in the pinned glossary release, or an i2x: concept.' : 'Name an affordance that dereferences.');
      }
    }
  }
  // An evidence link is on a concept and an offer on a template: the other way round says nothing a reader looks for.
  for (const [key, property] of [['templates', 'evidences'], ['concepts', 'offers'], ['patterns', 'evidences'], ['patterns', 'offers']] as const)
    for (const [i, part] of list(doc[key]).entries()) if (isObject(part) && part[xapix(property)] !== undefined)
      say('xapix-link-shape', String(part.id), `${key}[${i}]['${xapix(property)}']`, `${property} is on a ${key === 'templates' ? 'template' : key === 'concepts' ? 'concept' : 'pattern'}.`, property === 'evidences' ? 'Put evidences on a concept.' : 'Put offers on a statement template.');

  // X10: without its decorations the profile is still a profile…
  const structural = (d: Json) => JSON.stringify(lintProfile(d, undefined, { external: options.external }).filter(f => !['template-example', 'pattern-example'].includes(f.code)));
  if (structural(withoutDecorations(doc)) !== structural(doc))
    say('xapix-not-a-superset', 'profile', '', 'With its xapix: properties removed, the profile lints differently, so a plain processor does not read the same profile.', 'Keep every decoration to a property a plain processor can ignore.');
  // …and each example still follows every template that asks for no decoration.
  const plain = list(doc.templates).filter(isObject).filter(t => t.deprecated !== true && !asksForADecoration(t));
  for (const [i, example] of examples.statements.entries()) {
    if (!isObject(example.statement)) continue;
    let before: string[], after: string[];
    // `validates` names a template a statement matches whether or not it follows its rules, so the ones with a finding are taken out.
    const followed = (statement: Json): string[] => { const r = validates(statement, plain); return r.templates.filter(t => !r.findings.some(f => f.template === t)); };
    try { before = followed(example.statement); after = followed(statementWithoutDecorations(example.statement)); } catch { continue; }
    const lost = before.filter(t => !after.includes(t));
    if (lost.length) say('xapix-not-a-superset', `example:${example.id}`, `examples.statements[${i}]`, `With its decorations removed the statement no longer follows ${lost.join(', ')}, which asks for no decoration.`, 'A template that depends on a decoration says so in a rule or a determining property; one that does not must not.');
  }
  return findings;
}
