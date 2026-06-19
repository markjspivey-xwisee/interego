/**
 * xAPI 2.0 / IEEE 9274.1.1 Statement validator.
 *
 * A conformant LRS MUST reject (400 Bad Request) any Statement that
 * violates the §4 data model — wrong `objectType` casing, missing
 * inverse-functional identifiers, malformed IRIs, out-of-range scores,
 * `null` values, unknown properties, and so on. The ADL LRS Conformance
 * Test Suite drives several hundred such cases.
 *
 * This module is the single source of validation truth for the Foxxi
 * LRS surface. It is pure (no I/O, no substrate calls) so it can be
 * unit-tested in isolation and reused by the lrs-adapter's outbound
 * projection if needed. It introduces NO ontology terms — it only
 * enforces the published xAPI/IEEE 9274 schema.
 *
 * `validateStatement(stmt)` returns a list of human-readable error
 * strings; an empty list means the Statement is conformant. The caller
 * turns a non-empty list into HTTP 400.
 *
 * Spec references are to IEEE 9274.1.1-2023 §4 (xAPI 2.0).
 */

// ── Primitive validators ─────────────────────────────────────────────
// The enumerated vocabulary + UUID/version patterns are SINGLE-SOURCED from the
// composed xAPI ontology model (src/spec/xapi.model.ts) — so what the LRS enforces
// on write is exactly what the dereferenceable /ns/xapi ontology declares. Values are
// byte-identical to the long-proven constants (ADL 1442/1442); this only relocates
// their definition to the ontology.
import { XAPI_INTERACTION_TYPES, XAPI_PATTERNS } from './spec/xapi.model.js';

const UUID_RE = new RegExp(XAPI_PATTERNS.uuid, 'i');

/** Absolute IRI: has a scheme, no whitespace, scheme-specific part present. */
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

/**
 * ISO 8601 calendar date-time (xAPI §4.1.8 timestamp / stored). The UTC
 * offset, when present, MUST use the extended form `±hh:mm` (a colon) or
 * `Z` — the basic form `±hhmm` is rejected, as the conformance suite
 * requires. The date/time separator may be `T`, `t`, or a space: RFC 3339
 * §5.6 NOTE permits a space for readability, and the ADL conformance suite
 * sends `2008-09-15 15:53:00.601+00:00` as a VALID timestamp the LRS must
 * accept (it then normalizes to UTC on store).
 */
const TIMESTAMP_RE =
  // Seconds (and the fractional part) are OPTIONAL: ISO 8601 / ECMA-262 permit
  // reduced precision (`HH:mm`), and the ADL conformance suite sends
  // `2023-05-04T12:00-05:00` as a VALID timestamp the LRS must accept and
  // normalize to UTC. (`-00:00` is still rejected below; basic-form offsets
  // `±hhmm`/`±hh` are rejected by requiring the `±hh:mm` colon form.)
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/** ISO 8601 duration (xAPI §4.1.5.2 result.duration). At least one component. */
const DURATION_RE =
  /^P(?=[^T]|T.)(\d+(?:\.\d+)?Y)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?W)?(\d+(?:\.\d+)?D)?(T(?=.)(\d+(?:\.\d+)?H)?(\d+(?:\.\d+)?M)?(\d+(?:\.\d+)?S)?)?$/;
/** ISO 8601:2004 §4.4.3.2 — the week designator is exclusive. */
const WEEK_DURATION_RE = /^P\d+(?:\.\d+)?W$/;

/** RFC 5646 language tag (loose — rejects whitespace / empty / junk). */
const LANG_TAG_RE = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;

/** Statement `version` property — a 1.0.x or 2.0.x semantic version. */
const VERSION_RE = new RegExp(XAPI_PATTERNS.version);

const INTERACTION_TYPES = new Set<string>(XAPI_INTERACTION_TYPES);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isIri = (v: unknown): v is string => typeof v === 'string' && IRI_RE.test(v);
const isTimestamp = (v: unknown): boolean =>
  typeof v === 'string' && TIMESTAMP_RE.test(v) && !v.endsWith('-00:00')
  // Normalize a space separator to 'T' before Date.parse so the RFC 3339
  // space form (accepted above) parses on every engine, not just lenient ones.
  && !Number.isNaN(Date.parse(v.replace(' ', 'T')));
const isDuration = (v: unknown): boolean => {
  if (typeof v !== 'string' || v.length < 2 || !DURATION_RE.test(v)) return false;
  // The week designator cannot be combined with any other component.
  if (v.includes('W')) return WEEK_DURATION_RE.test(v);
  return true;
};
const isLangTag = (v: unknown): boolean => typeof v === 'string' && LANG_TAG_RE.test(v);

/** Keys of `obj` that are not in `allowed`. */
function extraKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter(k => !allowed.includes(k));
}

// ── Error accumulator ────────────────────────────────────────────────

class Errs {
  readonly list: string[] = [];
  add(msg: string): void { this.list.push(msg); }
}

// ── Disallowed-null scan (xAPI §4.1: no null except inside extensions) ─

/**
 * xAPI §4.1: "An LRS rejects ... any Statement having a property whose
 * value is set to null", with the sole exception of values inside an
 * `extensions` object. Walk the whole tree; skip `extensions` subtrees.
 */
function findNulls(value: unknown, path: string, out: string[]): void {
  if (value === null) { out.push(path || '(root)'); return; }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findNulls(v, `${path}[${i}]`, out));
    return;
  }
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'extensions') continue; // extension values MAY be null
      findNulls(v, path ? `${path}.${k}` : k, out);
    }
  }
}

// ── Language map ─────────────────────────────────────────────────────

function validateLangMap(v: unknown, label: string, e: Errs): void {
  if (!isObject(v)) { e.add(`${label} must be a language map (object)`); return; }
  for (const [tag, text] of Object.entries(v)) {
    if (!isLangTag(tag)) e.add(`${label}: "${tag}" is not a valid RFC 5646 language tag`);
    if (typeof text !== 'string') e.add(`${label}["${tag}"] must be a string`);
  }
}

// ── Extensions (keys MUST be IRIs) ───────────────────────────────────

function validateExtensions(v: unknown, label: string, e: Errs): void {
  if (!isObject(v)) { e.add(`${label} must be an object`); return; }
  for (const key of Object.keys(v)) {
    if (!isIri(key)) e.add(`${label}: extension key "${key}" is not an IRI`);
  }
}

// ── Inverse-functional identifiers / Agent / Group ───────────────────

const AGENT_KEYS = ['objectType', 'name', 'mbox', 'mbox_sha1sum', 'openid', 'account'] as const;
const GROUP_KEYS = ['objectType', 'name', 'member', 'mbox', 'mbox_sha1sum', 'openid', 'account'] as const;

function validateAccount(v: unknown, label: string, e: Errs): void {
  if (!isObject(v)) { e.add(`${label}.account must be an object`); return; }
  const extra = extraKeys(v, ['homePage', 'name']);
  if (extra.length) e.add(`${label}.account has unexpected properties: ${extra.join(', ')}`);
  if (!isIri(v.homePage)) e.add(`${label}.account.homePage must be an IRI`);
  if (typeof v.name !== 'string') e.add(`${label}.account.name must be a string`);
}

/** Count + validate the inverse-functional identifiers on an actor object. */
function validateIfis(a: Record<string, unknown>, label: string, e: Errs): number {
  let count = 0;
  if ('mbox' in a) {
    count++;
    if (typeof a.mbox !== 'string' || !/^mailto:.+@.+/.test(a.mbox)) {
      e.add(`${label}.mbox must be a "mailto:" IRI`);
    }
  }
  if ('mbox_sha1sum' in a) {
    count++;
    if (typeof a.mbox_sha1sum !== 'string' || !/^[0-9a-f]{40}$/i.test(a.mbox_sha1sum)) {
      e.add(`${label}.mbox_sha1sum must be a 40-character hex SHA-1 string`);
    }
  }
  if ('openid' in a) {
    count++;
    if (!isIri(a.openid)) e.add(`${label}.openid must be a valid URI`);
  }
  if ('account' in a) { count++; validateAccount(a.account, label, e); }
  return count;
}

/**
 * Validate an Agent or Group object. `role` shapes a couple of
 * special cases (authority Groups must be anonymous OAuth pairs).
 */
function validateActor(
  v: unknown,
  label: string,
  e: Errs,
  role: 'actor' | 'authority' | 'member' | 'instructor' | 'team' = 'actor',
): void {
  if (!isObject(v)) { e.add(`${label} must be an object`); return; }
  const ot = v.objectType;
  if (ot !== undefined && ot !== 'Agent' && ot !== 'Group') {
    e.add(`${label}.objectType must be exactly "Agent" or "Group" (got ${JSON.stringify(ot)})`);
    return;
  }
  if (role === 'team' && ot !== 'Group') {
    e.add(`${label} must be a Group (objectType "Group")`);
  }
  if (v.name !== undefined && typeof v.name !== 'string') {
    e.add(`${label}.name must be a string`);
  }

  const isGroup = ot === 'Group';
  const allowed = isGroup ? GROUP_KEYS : AGENT_KEYS;
  const extra = extraKeys(v, allowed);
  if (extra.length) e.add(`${label} has unexpected properties: ${extra.join(', ')}`);

  if (isGroup) {
    const hasMember = 'member' in v;
    if (hasMember) {
      if (!Array.isArray(v.member)) e.add(`${label}.member must be an array of Agents`);
      else v.member.forEach((m, i) => validateActor(m, `${label}.member[${i}]`, e, 'member'));
    }
    const ifiCount = validateIfis(v, label, e);
    if (ifiCount === 0 && !hasMember) {
      e.add(`${label}: a Group must have an inverse-functional identifier or a "member" array`);
    }
    if (ifiCount > 1) e.add(`${label}: a Group must have at most one inverse-functional identifier`);
    if (role === 'authority') {
      // §4.1.9: an authority Group is an anonymous OAuth pair.
      if (ifiCount > 0) e.add(`${label}: an authority Group must be anonymous (no inverse-functional identifier)`);
      if (!Array.isArray(v.member) || v.member.length !== 2) {
        e.add(`${label}: an authority Group must consist of exactly two Agents (OAuth consumer)`);
      }
    }
  } else {
    // Agent: exactly one IFI.
    if ('member' in v) e.add(`${label}: only a Group may have a "member" property`);
    const ifiCount = validateIfis(v, label, e);
    if (ifiCount === 0) e.add(`${label}: an Agent must have exactly one inverse-functional identifier (mbox / mbox_sha1sum / openid / account)`);
    if (ifiCount > 1) e.add(`${label}: an Agent must have exactly one inverse-functional identifier, found ${ifiCount}`);
  }
}

// ── Verb ─────────────────────────────────────────────────────────────

function validateVerb(v: unknown, e: Errs): void {
  if (!isObject(v)) { e.add('verb must be an object'); return; }
  const extra = extraKeys(v, ['id', 'display']);
  if (extra.length) e.add(`verb has unexpected properties: ${extra.join(', ')}`);
  if (!isIri(v.id)) e.add('verb.id must be an IRI');
  if (v.display !== undefined) validateLangMap(v.display, 'verb.display', e);
}

// ── Activity ─────────────────────────────────────────────────────────

const ACTIVITY_DEF_KEYS = [
  'name', 'description', 'type', 'moreInfo', 'extensions', 'interactionType',
  'correctResponsesPattern', 'choices', 'scale', 'source', 'target', 'steps',
] as const;
const INTERACTION_COMPONENT_LISTS = ['choices', 'scale', 'source', 'target', 'steps'] as const;

function validateInteractionComponents(arr: unknown, label: string, e: Errs): void {
  if (!Array.isArray(arr)) { e.add(`${label} must be an array`); return; }
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (!isObject(c)) { e.add(`${label}[${i}] must be an object`); continue; }
    const extra = extraKeys(c, ['id', 'description']);
    if (extra.length) e.add(`${label}[${i}] has unexpected properties: ${extra.join(', ')}`);
    if (typeof c.id !== 'string') e.add(`${label}[${i}].id must be a string`);
    if (c.description !== undefined) validateLangMap(c.description, `${label}[${i}].description`, e);
  }
}

function validateActivity(v: Record<string, unknown>, label: string, e: Errs): void {
  const extra = extraKeys(v, ['objectType', 'id', 'definition']);
  if (extra.length) e.add(`${label} has unexpected properties: ${extra.join(', ')}`);
  if (!isIri(v.id)) e.add(`${label}.id must be an IRI`);
  if (v.definition === undefined) return;
  if (!isObject(v.definition)) { e.add(`${label}.definition must be an object`); return; }
  const def = v.definition;
  const defExtra = extraKeys(def, ACTIVITY_DEF_KEYS);
  if (defExtra.length) e.add(`${label}.definition has unexpected properties: ${defExtra.join(', ')}`);
  if (def.name !== undefined) validateLangMap(def.name, `${label}.definition.name`, e);
  if (def.description !== undefined) validateLangMap(def.description, `${label}.definition.description`, e);
  if (def.type !== undefined && !isIri(def.type)) e.add(`${label}.definition.type must be an IRI`);
  if (def.moreInfo !== undefined && !isIri(def.moreInfo)) e.add(`${label}.definition.moreInfo must be an IRI`);
  if (def.extensions !== undefined) validateExtensions(def.extensions, `${label}.definition.extensions`, e);
  if (def.interactionType !== undefined) {
    if (typeof def.interactionType !== 'string' || !INTERACTION_TYPES.has(def.interactionType)) {
      e.add(`${label}.definition.interactionType must be one of: ${[...INTERACTION_TYPES].join(', ')}`);
    }
  }
  if (def.correctResponsesPattern !== undefined) {
    if (!Array.isArray(def.correctResponsesPattern)
      || !def.correctResponsesPattern.every(s => typeof s === 'string')) {
      e.add(`${label}.definition.correctResponsesPattern must be an array of strings`);
    }
  }
  for (const list of INTERACTION_COMPONENT_LISTS) {
    if (def[list] !== undefined) validateInteractionComponents(def[list], `${label}.definition.${list}`, e);
  }
  // §4.1.4.1: an interactionType is REQUIRED whenever any interaction
  // component list or a correctResponsesPattern is present.
  const usesInteraction = def.correctResponsesPattern !== undefined
    || INTERACTION_COMPONENT_LISTS.some(l => def[l] !== undefined);
  if (usesInteraction && def.interactionType === undefined) {
    e.add(`${label}.definition must specify "interactionType" when correctResponsesPattern or interaction components are present`);
  }
}

// ── Object (Activity | Agent | Group | StatementRef | SubStatement) ──

function validateObject(v: unknown, e: Errs, allowSubStatement: boolean): void {
  if (!isObject(v)) { e.add('object must be an object'); return; }
  const ot = v.objectType ?? 'Activity';
  switch (ot) {
    case 'Activity':
      validateActivity(v, 'object', e);
      break;
    case 'Agent':
    case 'Group':
      validateActor(v, 'object', e);
      break;
    case 'StatementRef': {
      const extra = extraKeys(v, ['objectType', 'id']);
      if (extra.length) e.add(`object (StatementRef) has unexpected properties: ${extra.join(', ')}`);
      if (!isUuid(v.id)) e.add('object.id (StatementRef) must be a UUID');
      break;
    }
    case 'SubStatement':
      if (!allowSubStatement) {
        e.add('object: a SubStatement must not contain a nested SubStatement (§4.1.4.2)');
      } else {
        validateSubStatement(v, e);
      }
      break;
    default:
      e.add(`object.objectType must be Activity, Agent, Group, StatementRef, or SubStatement (got ${JSON.stringify(ot)})`);
  }
}

// ── Result ───────────────────────────────────────────────────────────

function validateScore(v: unknown, e: Errs): void {
  if (!isObject(v)) { e.add('result.score must be an object'); return; }
  const extra = extraKeys(v, ['scaled', 'raw', 'min', 'max']);
  if (extra.length) e.add(`result.score has unexpected properties: ${extra.join(', ')}`);
  const num = (k: string): number | undefined => {
    if (v[k] === undefined) return undefined;
    if (typeof v[k] !== 'number') { e.add(`result.score.${k} must be a number`); return undefined; }
    return v[k] as number;
  };
  const scaled = num('scaled');
  const raw = num('raw');
  const min = num('min');
  const max = num('max');
  if (scaled !== undefined && (scaled < -1 || scaled > 1)) {
    e.add('result.score.scaled must be between -1 and 1 inclusive');
  }
  if (min !== undefined && max !== undefined && min > max) {
    e.add('result.score.min must not be greater than result.score.max');
  }
  if (raw !== undefined) {
    if (min !== undefined && raw < min) e.add('result.score.raw must not be less than result.score.min');
    if (max !== undefined && raw > max) e.add('result.score.raw must not be greater than result.score.max');
  }
}

const RESULT_KEYS = ['score', 'success', 'completion', 'response', 'duration', 'extensions'] as const;

function validateResult(v: unknown, e: Errs): void {
  if (!isObject(v)) { e.add('result must be an object'); return; }
  const extra = extraKeys(v, RESULT_KEYS);
  if (extra.length) e.add(`result has unexpected properties: ${extra.join(', ')}`);
  if (v.score !== undefined) validateScore(v.score, e);
  if (v.success !== undefined && typeof v.success !== 'boolean') e.add('result.success must be a boolean');
  if (v.completion !== undefined && typeof v.completion !== 'boolean') e.add('result.completion must be a boolean');
  if (v.response !== undefined && typeof v.response !== 'string') e.add('result.response must be a string');
  if (v.duration !== undefined && !isDuration(v.duration)) e.add('result.duration must be an ISO 8601 duration');
  if (v.extensions !== undefined) validateExtensions(v.extensions, 'result.extensions', e);
}

// ── Context ──────────────────────────────────────────────────────────

const CONTEXT_KEYS = [
  'registration', 'instructor', 'team', 'contextActivities', 'revision',
  'platform', 'language', 'statement', 'extensions', 'contextAgents', 'contextGroups',
] as const;
const CONTEXT_ACTIVITY_KEYS = ['parent', 'grouping', 'category', 'other'] as const;

function validateContextActivities(v: unknown, e: Errs): void {
  if (!isObject(v)) { e.add('context.contextActivities must be an object'); return; }
  const extra = extraKeys(v, CONTEXT_ACTIVITY_KEYS);
  if (extra.length) e.add(`context.contextActivities has unexpected properties: ${extra.join(', ')}`);
  for (const key of CONTEXT_ACTIVITY_KEYS) {
    if (v[key] === undefined) continue;
    const val = v[key];
    const items = Array.isArray(val) ? val : [val];
    items.forEach((act, i) => {
      if (!isObject(act)) { e.add(`context.contextActivities.${key}[${i}] must be an Activity object`); return; }
      if (act.objectType !== undefined && act.objectType !== 'Activity') {
        e.add(`context.contextActivities.${key}[${i}].objectType must be "Activity"`);
      }
      validateActivity(act, `context.contextActivities.${key}[${i}]`, e);
    });
  }
}

function validateContext(v: unknown, objectIsActivity: boolean, e: Errs): void {
  if (!isObject(v)) { e.add('context must be an object'); return; }
  const extra = extraKeys(v, CONTEXT_KEYS);
  if (extra.length) e.add(`context has unexpected properties: ${extra.join(', ')}`);
  if (v.registration !== undefined && !isUuid(v.registration)) e.add('context.registration must be a UUID');
  if (v.instructor !== undefined) validateActor(v.instructor, 'context.instructor', e, 'instructor');
  if (v.team !== undefined) validateActor(v.team, 'context.team', e, 'team');
  if (v.contextActivities !== undefined) validateContextActivities(v.contextActivities, e);
  if (v.revision !== undefined) {
    if (typeof v.revision !== 'string') e.add('context.revision must be a string');
    if (!objectIsActivity) e.add('context.revision is only permitted when the Statement object is an Activity (§4.1.6)');
  }
  if (v.platform !== undefined) {
    if (typeof v.platform !== 'string') e.add('context.platform must be a string');
    if (!objectIsActivity) e.add('context.platform is only permitted when the Statement object is an Activity (§4.1.6)');
  }
  if (v.language !== undefined && !isLangTag(v.language)) e.add('context.language must be an RFC 5646 language tag');
  if (v.statement !== undefined) {
    if (!isObject(v.statement) || v.statement.objectType !== 'StatementRef' || !isUuid(v.statement.id)) {
      e.add('context.statement must be a StatementRef with a UUID id');
    }
  }
  if (v.extensions !== undefined) validateExtensions(v.extensions, 'context.extensions', e);
  if (v.contextAgents !== undefined) validateContextAgents(v.contextAgents, e);
  if (v.contextGroups !== undefined) validateContextGroups(v.contextGroups, e);
}

/** xAPI 2.0 §4.1.6.3: context.contextAgents entries. */
function validateContextAgents(v: unknown, e: Errs): void {
  if (!Array.isArray(v)) { e.add('context.contextAgents must be an array'); return; }
  v.forEach((item, i) => {
    const label = `context.contextAgents[${i}]`;
    if (!isObject(item)) { e.add(`${label} must be an object`); return; }
    const extra = extraKeys(item, ['objectType', 'agent', 'relevantTypes']);
    if (extra.length) e.add(`${label} has unexpected properties: ${extra.join(', ')}`);
    if (item.objectType !== 'contextAgent') e.add(`${label}.objectType must be the string "contextAgent"`);
    if (item.agent === undefined) e.add(`${label}.agent is required`);
    else {
      validateActor(item.agent, `${label}.agent`, e);
      if (isObject(item.agent) && item.agent.objectType === 'Group') {
        e.add(`${label}.agent must be an Agent, not a Group`);
      }
    }
    if (item.relevantTypes !== undefined
      && (!Array.isArray(item.relevantTypes) || item.relevantTypes.length === 0
        || !item.relevantTypes.every(isIri))) {
      e.add(`${label}.relevantTypes must be a non-empty array of IRIs`);
    }
  });
}

/** xAPI 2.0 §4.1.6.4: context.contextGroups entries. */
function validateContextGroups(v: unknown, e: Errs): void {
  if (!Array.isArray(v)) { e.add('context.contextGroups must be an array'); return; }
  v.forEach((item, i) => {
    const label = `context.contextGroups[${i}]`;
    if (!isObject(item)) { e.add(`${label} must be an object`); return; }
    const extra = extraKeys(item, ['objectType', 'group', 'relevantTypes']);
    if (extra.length) e.add(`${label} has unexpected properties: ${extra.join(', ')}`);
    if (item.objectType !== 'contextGroup') e.add(`${label}.objectType must be the string "contextGroup"`);
    if (item.group === undefined) e.add(`${label}.group is required`);
    else {
      if (isObject(item.group) && item.group.objectType !== 'Group') {
        e.add(`${label}.group must be a Group (objectType "Group")`);
      }
      validateActor(item.group, `${label}.group`, e, 'team');
    }
    if (item.relevantTypes !== undefined
      && (!Array.isArray(item.relevantTypes) || item.relevantTypes.length === 0
        || !item.relevantTypes.every(isIri))) {
      e.add(`${label}.relevantTypes must be a non-empty array of IRIs`);
    }
  });
}

// ── Attachments ──────────────────────────────────────────────────────

const ATTACHMENT_KEYS = ['usageType', 'display', 'description', 'contentType', 'length', 'sha2', 'fileUrl'] as const;

function validateAttachments(v: unknown, e: Errs): void {
  if (!Array.isArray(v)) { e.add('attachments must be an array'); return; }
  v.forEach((att, i) => {
    if (!isObject(att)) { e.add(`attachments[${i}] must be an object`); return; }
    const extra = extraKeys(att, ATTACHMENT_KEYS);
    if (extra.length) e.add(`attachments[${i}] has unexpected properties: ${extra.join(', ')}`);
    if (!isIri(att.usageType)) e.add(`attachments[${i}].usageType must be an IRI`);
    validateLangMap(att.display, `attachments[${i}].display`, e);
    if (att.description !== undefined) validateLangMap(att.description, `attachments[${i}].description`, e);
    if (typeof att.contentType !== 'string') e.add(`attachments[${i}].contentType must be a string (internet media type)`);
    if (typeof att.length !== 'number' || !Number.isInteger(att.length)) {
      e.add(`attachments[${i}].length must be an integer`);
    }
    if (typeof att.sha2 !== 'string') e.add(`attachments[${i}].sha2 must be a string`);
    if (att.fileUrl !== undefined && !isIri(att.fileUrl)) e.add(`attachments[${i}].fileUrl must be an IRI`);
  });
}

// ── SubStatement ─────────────────────────────────────────────────────

const SUBSTATEMENT_KEYS = ['objectType', 'actor', 'verb', 'object', 'result', 'context', 'timestamp', 'attachments'] as const;

function validateSubStatement(v: Record<string, unknown>, e: Errs): void {
  const extra = extraKeys(v, SUBSTATEMENT_KEYS);
  if (extra.length) e.add(`object (SubStatement) has unexpected properties: ${extra.join(', ')}`);
  // §4.1.4.2: a SubStatement MUST NOT have id / stored / version / authority.
  for (const banned of ['id', 'stored', 'version', 'authority']) {
    if (banned in v) e.add(`object (SubStatement) must not have a "${banned}" property`);
  }
  if (!v.actor) e.add('object (SubStatement).actor is required');
  else validateActor(v.actor, 'object (SubStatement).actor', e);
  if (!v.verb) e.add('object (SubStatement).verb is required');
  else validateVerb(v.verb, e);
  if (!v.object) e.add('object (SubStatement).object is required');
  else validateObject(v.object, e, /* allowSubStatement */ false);
  if (v.result !== undefined) validateResult(v.result, e);
  if (v.context !== undefined) {
    const subObjIsActivity = isObject(v.object) && (v.object.objectType ?? 'Activity') === 'Activity';
    validateContext(v.context, subObjIsActivity, e);
  }
  if (v.timestamp !== undefined && !isTimestamp(v.timestamp)) e.add('object (SubStatement).timestamp must be an ISO 8601 timestamp');
  if (v.attachments !== undefined) validateAttachments(v.attachments, e);
}

// ── Top-level Statement ──────────────────────────────────────────────

const STATEMENT_KEYS = [
  'id', 'actor', 'verb', 'object', 'result', 'context',
  'timestamp', 'stored', 'authority', 'version', 'attachments',
] as const;

const VOIDED_VERB = 'http://adlnet.gov/expapi/verbs/voided';

/**
 * Validate a single xAPI 2.0 Statement.
 *
 * Returns a (possibly empty) list of error strings. An empty list means
 * the Statement is conformant and the LRS MUST store it; a non-empty
 * list means the LRS MUST respond 400 Bad Request.
 */
export function validateStatement(stmt: unknown): string[] {
  const e = new Errs();
  if (!isObject(stmt)) { return ['statement must be a JSON object']; }

  // 1. No `null` anywhere outside extensions (§4.1).
  const nulls: string[] = [];
  findNulls(stmt, '', nulls);
  for (const p of nulls) e.add(`property "${p}" must not be null`);

  // 2. No unknown top-level properties.
  const extra = extraKeys(stmt, STATEMENT_KEYS);
  if (extra.length) e.add(`statement has unexpected properties: ${extra.join(', ')}`);

  // 3. Required triad.
  if (!('actor' in stmt)) e.add('statement.actor is required');
  else validateActor(stmt.actor, 'actor', e);
  if (!('verb' in stmt)) e.add('statement.verb is required');
  else validateVerb(stmt.verb, e);
  if (!('object' in stmt)) e.add('statement.object is required');
  else validateObject(stmt.object, e, /* allowSubStatement */ true);

  // 4. Optional top-level properties.
  if (stmt.id !== undefined && !isUuid(stmt.id)) e.add('statement.id must be a UUID');
  if (stmt.timestamp !== undefined && !isTimestamp(stmt.timestamp)) e.add('statement.timestamp must be an ISO 8601 timestamp');
  if (stmt.stored !== undefined && !isTimestamp(stmt.stored)) e.add('statement.stored must be an ISO 8601 timestamp');
  if (stmt.version !== undefined) {
    if (typeof stmt.version !== 'string' || !VERSION_RE.test(stmt.version)) {
      e.add('statement.version must be a supported xAPI version (1.0.x or 2.0.x)');
    }
  }
  if (stmt.authority !== undefined) validateActor(stmt.authority, 'authority', e, 'authority');

  const objectIsActivity = isObject(stmt.object) && (stmt.object.objectType ?? 'Activity') === 'Activity';
  if (stmt.result !== undefined) validateResult(stmt.result, e);
  if (stmt.context !== undefined) validateContext(stmt.context, objectIsActivity, e);
  if (stmt.attachments !== undefined) validateAttachments(stmt.attachments, e);

  // 5. Voiding statements (§4.1.7): the voided verb requires a
  //    StatementRef object — you can only void a Statement.
  const verbId = isObject(stmt.verb) ? stmt.verb.id : undefined;
  if (verbId === VOIDED_VERB) {
    const objType = isObject(stmt.object) ? stmt.object.objectType : undefined;
    if (objType !== 'StatementRef') {
      e.add('a voiding Statement (verb "voided") must have a StatementRef object (§4.1.7)');
    }
  }

  return e.list;
}

/** Convenience: true when the Statement is fully conformant. */
export function isValidStatement(stmt: unknown): boolean {
  return validateStatement(stmt).length === 0;
}

/**
 * Validate a standalone Agent / Group object — used by the Agents
 * Resource and the document resources to reject a structurally invalid
 * `agent` query parameter. Returns a list of error strings.
 */
export function validateAgentObject(agent: unknown): string[] {
  const e = new Errs();
  validateActor(agent, 'agent', e);
  return e.list;
}
