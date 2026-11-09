/**
 * A scored scenario's stakes, and the answers that leave them out.
 *
 * The stakes are what turn levels into a result: each criterion's weight, each level's value, the
 * pass rule (its minimum percent and required levels), and everything computed from them (points,
 * the maximum, the percent, whether the pass rule is met, which requirements are unmet). A judge
 * who knew them could steer a level toward or away from the pass mark, so the judge's own request
 * never carries them (`rubricForJudge` in practice.ts). The bridge makes the same cut on answers:
 * a signed request from this bridge's own web app, or from a key registered on the workspace,
 * reads the stakes; an answer to a chat assistant the Interego relay signed for, to a key that
 * holds no role there, or to a request nobody signed carries the rubric's criteria and levels by
 * name, the levels chosen and the quotes, and none of the stakes. Who is asking is decided in the
 * handlers (`showsStakes`); these functions only cut.
 *
 * Such an answer also carries the rubric's and the scenario's hashes keyed (`maskAnswerHashes`):
 * each is a sha256 over the whole rubric, stakes included, and the rest of the rubric is in the
 * answer, so only a few small integers are unknown and a bare hash would confirm a guess offline.
 * The key covers the scenario and the version a hash belongs to as well as the hash, so the same
 * rubric keys differently in any other scenario or version: a scenario an author's chat saves with
 * stakes it chose shows a keyed value no other scenario's matches, its right guess included.
 *
 * Pure: no I/O.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Assessment, JudgmentResult, Rubric, ScenarioSpec } from './practice.js';
import type { ReviewResult } from './records.js';

/** What every answer that left a scored scenario's stakes out says, at its top level. */
export const STAKES_WITHHELD = 'This answer leaves out a scored scenario\'s stakes: each criterion\'s weight, each level\'s points, the pass rule, '
  + 'and any points, percent or pass result worked out from them; its rubric and scenario fingerprints are keyed to their own scenario version, '
  + 'so they match no other scenario\'s or version\'s and cannot be checked against a guess. Practice Evidence leaves the stakes out of every answer to a chat assistant the Interego connector signs for, to a key '
  + 'no admin registered on this workspace (or registered as an agent), and to a request nobody signed; people see them in the Practice Evidence '
  + 'web app, signed in with Interego or with an address an admin registered.';

/** The keyed stand-ins for a hash (`full`, 64 hex) and for a 16-hex prefix of one (`prefix`), in one scope. */
export interface Keyer { readonly full: (hex: string) => string; readonly prefix: (hex16: string) => string }

/**
 * The keyed stand-ins for rubric and scenario hashes. Each is an HMAC-SHA256 under a key only the
 * bridge holds, over the hash and the scope it is shown in:
 *   · `version`: one scenario version (its IRI and number), for every answer about a scenario, an
 *     attempt or a judgment. The same rubric keys differently in any other scenario or version, so
 *     no answer about a scenario a caller saved can be compared with one about another.
 *   · `cells`: calibration cells, which group judgments by a rubric's content across scenarios;
 *     no caller chooses what a cell shows, and its values match no scenario's.
 *   · `loose()`: a salt of its own each time it is called, for a hash an answer does not tie to a
 *     scenario version (none should): it is equal to nothing outside that one answer.
 */
export interface HashMask {
  readonly version: (scenarioIri: string, version: number) => Keyer;
  readonly cells: Keyer;
  readonly loose: () => Keyer;
}

export function hashMask(key: Buffer): HashMask {
  const keyer = (scope: readonly unknown[]): Keyer => {
    const mac = (label: string, v: string): string =>
      createHmac('sha256', key).update(JSON.stringify([label, ...scope, v]), 'utf8').digest('hex');
    return { full: (hex) => mac('hash', hex), prefix: (hex16) => mac('prefix', hex16).slice(0, 16) };
  };
  return {
    version: (scenarioIri, version) => keyer(['scenario-version', scenarioIri, version]),
    cells: keyer(['calibration-cells']),
    loose: () => keyer(['loose', randomBytes(16).toString('hex')]),
  };
}

/** The scenario version an answer is about, or `cells` for calibration, or null when the answer names it itself. */
export type HashScope = { readonly scenarioIri: string; readonly version: number } | 'cells' | null;

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }

const HEX64 = /^[0-9a-f]{64}$/;
/** Keys whose value is a rubric's or a scenario's hash. */
const HASH_KEYS: ReadonlySet<string> = new Set(['rubricHash', 'scenarioHash']);
/**
 * Keys whose value is signed or exported bytes, left as they are: a record's descriptor and graph
 * (export_record gives a scored attempt's graphs only to a reader of the stakes) and a statement
 * (project_attempt gives a scored one only to such a reader). A feedback-only rubric's hash in
 * them carries no stake.
 */
const SIGNED_KEYS: ReadonlySet<string> = new Set(['graphTrig', 'descriptorTurtle', 'statement']);
const RUBRIC_IRI = /urn:pev:rubric:([0-9a-f]{64})/g;
/** A calibration decision kind, `pev/<first 16 hex of the rubric hash>/<criterion>`. */
const KIND_PREFIX = /\bpev\/([0-9a-f]{16})\//g;

type Version = { readonly scenarioIri: string; readonly version: number };
const isVersionNumber = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
/** The scenario version an object names: `scenarioIri` with `version` (or `scenarioVersion`). */
function namedVersion(o: unknown): Version | null {
  if (!isRecord(o) || typeof o['scenarioIri'] !== 'string') return null;
  const v = isVersionNumber(o['version']) ? o['version'] : o['scenarioVersion'];
  return isVersionNumber(v) ? { scenarioIri: o['scenarioIri'], version: v } : null;
}

/**
 * The scenario version the hashes in `o` belong to: the one it names, or the one its `scenario`
 * names (an attempt view), or, for an object that holds a hash and its own `version` (a scenario's
 * list of versions), the scenario it sits under at that version; otherwise the one it sits under.
 */
function versionIn(o: Record<string, unknown>, under: Version | null): Version | null {
  const own = namedVersion(o) ?? namedVersion(o['scenario']);
  if (own !== null) return own;
  if (under !== null && isVersionNumber(o['version']) && [...HASH_KEYS].some((k) => k in o)) return { scenarioIri: under.scenarioIri, version: o['version'] };
  return under;
}

/**
 * A calibration cell (calibration.ts `CalibrationCellView`), wherever an answer holds one (the
 * calibration read, a scenario's results): it groups judgments by a rubric's content across
 * scenarios, so its hashes are keyed for cells (`HashMask.cells`), as calibration's are.
 */
const isCalibrationCell = (o: Record<string, unknown>): boolean =>
  (o['grouping'] === 'rubric-version' || o['grouping'] === 'criterion-content') && typeof o['criterionContentHash'] === 'string' && typeof o['judgeId'] === 'string';

/**
 * An answer with every rubric and scenario hash keyed: the value of a `rubricHash` or
 * `scenarioHash`, the hash inside a rubric IRI (`urn:pev:rubric:<hash>`, its criteria's and levels'
 * IRIs too), and the hash prefix inside a calibration kind (`pev/<16 hex>/`), wherever they sit,
 * apart from signed bytes (`SIGNED_KEYS`). Each is keyed for the scenario version it belongs to
 * (`versionIn`, starting from `scope`), for calibration cells (`scope` `cells`, or inside a cell
 * wherever it sits), or, where nothing names its version, with a salt of this answer's own
 * (`loose`).
 */
export function maskAnswerHashes(v: unknown, m: HashMask, scope: HashScope = null): unknown {
  let loose: Keyer | null = null;
  const keyerFor = (at: Version | 'cells' | null): Keyer => {
    if (at === 'cells') return m.cells;
    if (at !== null) return m.version(at.scenarioIri, at.version);
    return (loose ??= m.loose());
  };
  const walk = (x: unknown, at: Version | 'cells' | null, key?: string): unknown => {
    if (typeof x === 'string') {
      if (key !== undefined && HASH_KEYS.has(key) && HEX64.test(x)) return keyerFor(at).full(x);
      return x.replace(RUBRIC_IRI, (_, h: string) => `urn:pev:rubric:${keyerFor(at).full(h)}`)
        .replace(KIND_PREFIX, (_, p: string) => `pev/${keyerFor(at).prefix(p)}/`);
    }
    if (Array.isArray(x)) return x.map((y) => walk(y, at));
    if (isRecord(x)) {
      const here = at === 'cells' || isCalibrationCell(x) ? 'cells' : versionIn(x, at);
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, SIGNED_KEYS.has(k) ? y : walk(y, here, k)]));
    }
    return x;
  };
  return walk(v, scope);
}

/** A rubric as an answer without the stakes carries it: criteria and levels, in words. */
export interface RubricWithoutStakes {
  readonly criteria: readonly {
    readonly id: string; readonly title: string; readonly description: string;
    readonly levels: readonly { readonly id: string; readonly label: string; readonly descriptor: string }[];
  }[];
}

export function rubricWithoutStakes(r: Rubric): RubricWithoutStakes {
  return {
    criteria: r.criteria.map((c) => ({
      id: c.id, title: c.title, description: c.description,
      levels: c.levels.map((l) => ({ id: l.id, label: l.label, descriptor: l.descriptor })),
    })),
  };
}

/** The levels an assessment counted, each with its place in its criterion (0 = lowest). */
export interface AssessmentWithoutStakes {
  readonly use: Assessment['use']; readonly provisional: boolean;
  readonly levels: readonly { readonly criterionId: string; readonly levelId: string; readonly levelIndex: number }[];
  readonly computedBy: 'platform';
}

/**
 * An assessment without the stakes: the levels it counted and nothing computed from a weight, a
 * value or the pass rule. A feedback-only assessment holds nothing else and is returned as it is.
 */
export function assessmentWithoutStakes(a: Assessment, r: Rubric): AssessmentWithoutStakes {
  if (a.use === 'feedback-only') return a;
  const indexOf = (criterionId: string, levelId: string): number =>
    r.criteria.find((c) => c.id === criterionId)?.levels.findIndex((l) => l.id === levelId) ?? -1;
  return {
    use: a.use, provisional: a.provisional,
    levels: a.perCriterion.map((p) => ({ criterionId: p.criterionId, levelId: p.levelId, levelIndex: indexOf(p.criterionId, p.levelId) })),
    computedBy: a.computedBy,
  };
}

export type JudgmentWithoutStakes = Omit<JudgmentResult, 'provisional'> & { readonly provisional: AssessmentWithoutStakes };

/** A judgment with its levels, quotes and rationale, and its provisional result reduced to the levels it counted. */
export function judgmentWithoutStakes(j: JudgmentResult, r: Rubric): JudgmentWithoutStakes {
  return { ...j, provisional: assessmentWithoutStakes(j.provisional, r) };
}

export type ReviewWithoutStakes = Omit<ReviewResult, 'assessment'> & { readonly assessment: AssessmentWithoutStakes };

/** A review with the reviewer's levels and reasons, and its result reduced to those levels. */
export function reviewWithoutStakes(v: ReviewResult, r: Rubric): ReviewWithoutStakes {
  return { ...v, assessment: assessmentWithoutStakes(v.assessment, r) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  A scenario sent without its stakes
// ═════════════════════════════════════════════════════════════════════════════════════════════

const given = (v: unknown): boolean => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

/** True when a scenario as sent names any stake: a criterion's weight, a level's value, or a pass rule. */
export function sentStakes(raw: unknown): boolean {
  if (!isRecord(raw) || !isRecord(raw['rubric'])) return false;
  const r = raw['rubric'];
  if (given(r['passRule'])) return true;
  const criteria = Array.isArray(r['criteria']) ? r['criteria'] as unknown[] : [];
  return criteria.some((c) => isRecord(c) && (given(c['weight'])
    || (Array.isArray(c['levels']) && (c['levels'] as unknown[]).some((l) => isRecord(l) && given(l['value'])))));
}

/** True when a scenario as sent is scored (`assessmentUse: pass-gate`) and names no stake. */
export function scoredWithoutStakes(raw: unknown): boolean {
  return isRecord(raw) && typeof raw['assessmentUse'] === 'string' && raw['assessmentUse'].trim() === 'pass-gate' && !sentStakes(raw);
}

/**
 * The criteria and levels of a scenario as sent, by id and in order, are exactly those of `head`:
 * the only case in which `head`'s stakes can be put back on it unchanged.
 */
export function sameRubricShape(raw: unknown, head: Rubric): boolean {
  if (!isRecord(raw) || !isRecord(raw['rubric'])) return false;
  const criteria = Array.isArray(raw['rubric']['criteria']) ? raw['rubric']['criteria'] as unknown[] : [];
  const id = (x: unknown): string => (isRecord(x) && typeof x['id'] === 'string' ? x['id'].trim() : '');
  return criteria.length === head.criteria.length && criteria.every((c, i) => {
    const h = head.criteria[i]!;
    const levels = isRecord(c) && Array.isArray(c['levels']) ? c['levels'] as unknown[] : [];
    return id(c) === h.id && levels.length === h.levels.length && levels.every((l, j) => id(l) === h.levels[j]!.id);
  });
}

/**
 * A scenario as sent, with `head`'s stakes put back: each criterion's weight and each level's value
 * by id, and the pass rule; the reason a pass mark fits too when none was sent. Only for a scenario
 * `sameRubricShape` holds for: everything else in it is the sender's.
 */
export function withStakesOf(raw: Record<string, unknown>, head: ScenarioSpec): Record<string, unknown> {
  const rubric = raw['rubric'] as Record<string, unknown>;
  const criteria = (rubric['criteria'] as Record<string, unknown>[]).map((c, i) => {
    const h = head.rubric.criteria[i]!;
    return { ...c, weight: h.weight, levels: (c['levels'] as Record<string, unknown>[]).map((l, j) => ({ ...l, value: h.levels[j]!.value })) };
  });
  return {
    ...raw, rubric: { ...rubric, criteria, passRule: head.rubric.passRule },
    ...(given(raw['passGateWhy']) || head.passGateWhy === null ? {} : { passGateWhy: head.passGateWhy }),
  };
}
