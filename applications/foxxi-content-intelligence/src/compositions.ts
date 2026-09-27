/**
 * A composition: a path of positions, each holding the alternatives that could fill it.
 *
 * Lesson, module, course and curriculum are not four types here. They are one composition at
 * different sizes, because a position's alternatives may be fragments (content-fragments.ts) or
 * other compositions, by reference. A fragment used in three courses is one fragment with three
 * memberships, and a module used in two curricula is one module.
 *
 * ★ A COMPOSITION IS A RECIPE, NOT A RECORD. It says what a learner could be shown at each
 * position. What one learner is shown is its resolution (resolveComposition), made from that
 * learner's own record at the time they need it:
 *
 *   restriction  A position whose competency the learner has DEMONSTRATED (an Asserted
 *                competency on their record, from performance or a credential, at the
 *                position's rank) is skipped. A training-only inference is Hypothetical and
 *                does not count; that is the learner record's rule, and it holds here.
 *   admission    Where the caller says which forms suit a competency, only fragments of those
 *                kinds are admitted, with the caller's reason in the trace. Deciding that is a
 *                theory of performance, which lives above this standards vertical: the
 *                performance practice turns a plan into an admission. An emergent situation
 *                admits probes and reflection, so a lesson cannot be chosen there, and a
 *                situation that needs an environmental fix admits no content at all.
 *   choice       Among the admitted alternatives, the one pitched at the learner's level
 *                (their proficiency on the record, demonstrated or not), then the author's
 *                order. Choosing by what has worked for other learners comes with the outcome
 *                record.
 *
 * Every step, skip and unmet position is traced in words, so a learner, an author or an agent can
 * see why the resolution came out as it did.
 *
 * ★ ITS IDENTITY IS ITS CONTENT, as for a fragment: the IRI hashes the title, the competency and
 * each position's competency, rank and alternatives (by their own content hashes). A revision is
 * a new composition that names the old one in `supersedes`. The fragments it shares with the old
 * one are the same fragments, so what learners did with them still counts.
 *
 * Layer: L3 vertical. `foxxi:` terms only; no protocol-ontology change.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '@interego/core';
import { competencyIdOf, sameCompetency } from './competency-identity.js';
import {
  compositionIri, competencyRef, ContentError, contentRefOf, FRAGMENT_KINDS, fragmentIsIntact, fragmentKind, sameContent,
  type Fragment, type FragmentKind,
} from './content-fragments.js';
import type { CognitiveLevel } from './emergent-content.js';
import { chooseByEfficacy, type EfficacyCounts } from './fragment-efficacy.js';
import type { ElrCompetency } from './learner-record.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Size limits on a composition: how deeply compositions may nest, and how many positions one
 * resolution may come to. A composition can reach the same module from many positions, so what it
 * resolves to can grow faster than what it lists; the last limit keeps that finite.
 */
export const COMPOSITION_LIMITS = { title: 200, positions: 100, paradigm: 12, depth: 8, resolved: 2000 } as const;

/** The proficiency rank that counts a position as demonstrated unless it says otherwise: Competent. */
export const DEFAULT_DEMONSTRATED_RANK = 3;

export interface Position {
  /** The competency this position develops (a competency IRI). */
  competency: string;
  /** The proficiency rank (1 Novice … 5 Expert) at which the position counts as demonstrated. */
  demonstratedAt?: number;
  /** The alternatives that can fill it: fragment or composition IRIs, in the author's order. */
  paradigm: string[];
}

export interface Composition {
  /** `<authority>/ns/foxxi/composition/<sha256 of the content>`. */
  '@id': string;
  title: string;
  /** The competency the whole develops. */
  competency: string;
  positions: Position[];
  /** The composition this one revises. */
  supersedes?: string;
}

/** The hashes a composition's identity is taken over: competencies by id, alternatives by content. */
function compositionContent(c: Omit<Composition, '@id'>): Record<string, unknown> {
  const key = (iri: string): string => competencyIdOf(iri) ?? iri;
  const ref = (iri: string): string => { const r = contentRefOf(iri); return r ? `${r.type}:${r.hash}` : iri; };
  return {
    title: c.title, competency: key(c.competency),
    positions: c.positions.map(p => ({ competency: key(p.competency), ...(p.demonstratedAt !== undefined ? { demonstratedAt: p.demonstratedAt } : {}), paradigm: p.paradigm.map(ref) })),
    ...(c.supersedes ? { supersedes: ref(c.supersedes) } : {}),
  };
}

/**
 * A composition from what an author sent: `{ title, competency, positions: [{ competency,
 * demonstratedAt?, paradigm: [fragment or composition IRIs] }], supersedes? }`. Checked, and its
 * IRI computed. Whether each alternative exists is the caller's to check, since that needs a store.
 */
export function compositionFrom(raw: unknown): Composition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError('a composition must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || !r.title.trim()) throw new ContentError('title must be a non-empty string');
  if (r.title.length > COMPOSITION_LIMITS.title) throw new ContentError(`title is longer than ${COMPOSITION_LIMITS.title} characters`);
  const competency = competencyRef(r.competency, 'competency');
  if (!Array.isArray(r.positions) || r.positions.length === 0) throw new ContentError('a composition has at least one position: positions: [{ competency, paradigm: [ … ] }]');
  if (r.positions.length > COMPOSITION_LIMITS.positions) throw new ContentError(`a composition has at most ${COMPOSITION_LIMITS.positions} positions`);
  const positions = r.positions.map((p, i): Position => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ContentError(`positions[${i}] must be an object`);
    const pr = p as Record<string, unknown>;
    const at = pr.demonstratedAt;
    if (at !== undefined && (!Number.isInteger(at) || (at as number) < 1 || (at as number) > 5)) {
      throw new ContentError(`positions[${i}].demonstratedAt is a proficiency rank from 1 (Novice) to 5 (Expert)`);
    }
    if (!Array.isArray(pr.paradigm) || pr.paradigm.length === 0) throw new ContentError(`positions[${i}].paradigm lists the fragments or compositions that can fill it`);
    if (pr.paradigm.length > COMPOSITION_LIMITS.paradigm) throw new ContentError(`positions[${i}].paradigm offers at most ${COMPOSITION_LIMITS.paradigm} alternatives`);
    const seen = new Set<string>();
    const paradigm = pr.paradigm.map((iri, k) => {
      const ref = contentRefOf(iri);
      if (!ref) throw new ContentError(`positions[${i}].paradigm[${k}] is not a fragment or composition IRI`);
      const key = `${ref.type}:${ref.hash}`;
      if (seen.has(key)) throw new ContentError(`positions[${i}].paradigm names the same ${ref.type} twice`);
      seen.add(key);
      return iri as string;
    });
    return { competency: competencyRef(pr.competency, `positions[${i}].competency`), ...(at !== undefined ? { demonstratedAt: at as number } : {}), paradigm };
  });
  let supersedes: string | undefined;
  if (r.supersedes !== undefined) {
    const ref = contentRefOf(r.supersedes);
    if (!ref || ref.type !== 'composition') throw new ContentError('supersedes names the composition this one revises, by its IRI');
    supersedes = r.supersedes as string;
  }
  const content: Omit<Composition, '@id'> = { title: r.title.trim(), competency, positions, ...(supersedes ? { supersedes } : {}) };
  return { '@id': compositionIri(sha256(canonicalJson(compositionContent(content)))), ...content };
}

/** Whether a composition is what its IRI says it is. */
export function compositionIsIntact(c: Composition): boolean {
  const ref = contentRefOf(c['@id']);
  if (!ref || ref.type !== 'composition') return false;
  const { '@id': _id, ...content } = c;
  return sha256(canonicalJson(compositionContent(content))) === ref.hash;
}

// ── Resolution ─────────────────────────────────────────────────────

/** What resolution reads from the learner's record: the competencies on it. */
export type RecordedCompetency = Pick<ElrCompetency, 'aboutCompetency' | 'modalStatus' | 'basis' | 'proficiencyRank' | 'proficiencyLabel'>;

/** Which forms suit a competency, and why. Empty `kinds` means no content does. */
export interface Admission {
  kinds: readonly FragmentKind[];
  /** Why, in words the trace shows: "the plan for this Emergent work selected probe and coaching". */
  because: string;
}

/** An admission as a caller sends it, `{ kinds: [fragment kinds], because }`, checked, since it decides what a learner is shown. */
export function admissionFrom(raw: unknown): Admission {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ContentError('an admission is { kinds: [fragment kinds], because }');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.kinds) || r.kinds.length > FRAGMENT_KINDS.length) throw new ContentError(`admission.kinds lists at most ${FRAGMENT_KINDS.length} fragment kinds`);
  const kinds = [...new Set(r.kinds.map((k, i) => {
    if (typeof k !== 'string' || !fragmentKind(k)) throw new ContentError(`admission.kinds[${i}] is not a fragment kind (${FRAGMENT_KINDS.map(d => d.kind).join(', ')})`);
    return k as FragmentKind;
  }))];
  if (typeof r.because !== 'string' || !r.because.trim() || r.because.length > 500) throw new ContentError('admission.because says why, in at most 500 characters');
  return { kinds, because: r.because.trim() };
}

export interface ResolveInput {
  composition: Composition;
  learner: { id: string; kind: 'human' | 'agent' };
  /** The learner's competencies, from their own record. */
  record?: readonly RecordedCompetency[];
  /** Which forms suit a competency, when something has decided that. */
  /**
   * Which forms suit a competency. Undefined says nothing, and a position then takes what its
   * composition's competency admits; null says nothing is to limit this competency (an admission
   * withdrawn here), which the composition's does not override.
   */
  admission?: (competency: string) => Admission | null | undefined;
  /** Dereference an alternative. Returns undefined when it cannot be found. */
  lookup: (iri: string) => Fragment | Composition | undefined;
  /** How learners at a level did after meeting a fragment at a competency (fragment-efficacy.ts). */
  efficacy?: (competency: string, fragment: string, level: CognitiveLevel) => EfficacyCounts | undefined;
}

export interface ResolvedStep {
  fragment: Fragment;
  competency: string;
  /** The compositions from the root to the one holding this position. */
  path: string[];
  position: number;
  /** The alternatives the position offered. */
  alternatives: string[];
  chosenBecause: string;
  /** The level the learner was pitched at, which their outcome is counted under. */
  pitchedAt: CognitiveLevel;
}

export interface PositionNote {
  competency: string;
  path: string[];
  position: number;
  because: string;
}

export interface Resolution {
  composition: string;
  learner: string;
  steps: ResolvedStep[];
  /** Positions dropped because the learner has demonstrated them. */
  skipped: PositionNote[];
  /** Positions nothing admissible could fill. */
  unmet: PositionNote[];
  /** Content refused anywhere in the resolution for not hashing to its IRI (at most 20, distinct). */
  refused: string[];
  /** True when more content was refused than `refused` lists. */
  moreRefused: boolean;
  trace: string[];
}

/** The level to pitch at for a learner's proficiency rank; no record starts at the foundation. */
function levelFor(rank: number | undefined): CognitiveLevel {
  if (rank === undefined || rank <= 1) return 'foundational';
  if (rank === 2) return 'working';
  if (rank === 3) return 'applied';
  return 'advanced';
}
const LEVEL_INDEX: Record<CognitiveLevel, number> = { foundational: 0, working: 1, applied: 2, advanced: 3 };

const isComposition = (x: Fragment | Composition): x is Composition => Array.isArray((x as Composition).positions);

/** The learner's strongest entry on the record for a competency; demonstrated only when Asserted. */
function standing(record: readonly RecordedCompetency[], competency: string): { demonstrated?: RecordedCompetency; inferred?: RecordedCompetency } {
  const mine = record.filter(c => sameCompetency(c.aboutCompetency, competency));
  const best = (xs: RecordedCompetency[]): RecordedCompetency | undefined => xs.reduce<RecordedCompetency | undefined>((a, c) => (!a || c.proficiencyRank > a.proficiencyRank ? c : a), undefined);
  const demonstrated = best(mine.filter(c => c.modalStatus === 'Asserted'));
  const inferred = best(mine.filter(c => c.modalStatus !== 'Asserted'));
  return { ...(demonstrated ? { demonstrated } : {}), ...(inferred ? { inferred } : {}) };
}

/**
 * Resolve a composition for one learner: which fragment they are shown at each position, which
 * positions they skip and why, and which positions nothing admissible could fill.
 */
export function resolveComposition(input: ResolveInput): Resolution {
  const record = input.record ?? [];
  const root = input.composition;
  if (!compositionIsIntact(root)) throw new ContentError(`"${root.title}" does not match its IRI: its content was changed`);

  // What one composition resolves to, with paths relative to it. Kept per composition and depth,
  // because trying a nested alternative before falling back must not repeat work exponentially.
  // `refused` lists content refused anywhere inside it for not hashing to its IRI; it travels up
  // with the branch whether the branch is taken or fallen back from.
  // `moreRefused` says the list stopped short: it is kept to REFUSALS_KEPT so that neither it nor
  // the trace lines drawn from it can grow with the size of the tree.
  interface Branch { steps: ResolvedStep[]; skipped: PositionNote[]; unmet: PositionNote[]; trace: string[]; refused: string[]; moreRefused: boolean }
  const memo = new Map<string, Branch>();
  const push = <T>(into: T[], from: readonly T[]): void => { for (const x of from) into.push(x); };
  const noteRefusal = (b: Branch, why: string): void => {
    if (b.refused.includes(why)) return;
    if (b.refused.length < REFUSALS_KEPT) b.refused.push(why);
    else b.moreRefused = true;
  };
  const brief = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);
  const under = (prefix: string[], b: Branch): Branch => ({
    steps: b.steps.map(s => ({ ...s, path: [...prefix, ...s.path] })),
    skipped: b.skipped.map(n => ({ ...n, path: [...prefix, ...n.path] })),
    unmet: b.unmet.map(n => ({ ...n, path: [...prefix, ...n.path] })),
    trace: b.trace,
    refused: b.refused,
    moreRefused: b.moreRefused,
  });
  const checkSize = (b: Branch): void => {
    if (b.steps.length + b.skipped.length + b.unmet.length > COMPOSITION_LIMITS.resolved) {
      throw new ContentError(`"${root.title}" resolves to more than ${COMPOSITION_LIMITS.resolved} positions`);
    }
  };

  const walk = (comp: Composition, ancestors: string[]): Branch => {
    const hash = contentRefOf(comp['@id'])?.hash;
    if (ancestors.length >= COMPOSITION_LIMITS.depth) throw new ContentError(`compositions nest more than ${COMPOSITION_LIMITS.depth} deep under "${root.title}"`);
    if (ancestors.some(p => contentRefOf(p)?.hash === hash)) throw new ContentError(`"${comp.title}" contains itself`);
    const key = `${hash}@${ancestors.length}`;
    const known = memo.get(key);
    if (known) return known;
    const out: Branch = { steps: [], skipped: [], unmet: [], trace: [], refused: [], moreRefused: false };
    const self = [comp['@id']];
    comp.positions.forEach((pos, i) => {
      const at = `"${comp.title}" position ${i + 1}`;
      const note = (because: string): PositionNote => ({ competency: pos.competency, path: self, position: i, because });

      // Restriction: skip what the learner has demonstrated.
      const { demonstrated, inferred } = standing(record, pos.competency);
      const needed = pos.demonstratedAt ?? DEFAULT_DEMONSTRATED_RANK;
      if (demonstrated && demonstrated.proficiencyRank >= needed) {
        const because = `already demonstrated at ${demonstrated.proficiencyLabel} (${demonstrated.basis}), which meets rank ${needed}`;
        out.skipped.push(note(because));
        out.trace.push(`${at}: skipped, ${because}`);
        return;
      }
      if (inferred && (!demonstrated || inferred.proficiencyRank > demonstrated.proficiencyRank)) {
        out.trace.push(`${at}: the record infers ${inferred.proficiencyLabel} from training alone; an inference is not a demonstration, so the position stays`);
      }

      // Admission: only content that is what its IRI says, in a form that suits this competency,
      // meant for this learner. What is said about the position's own competency comes first,
      // including that nothing limits it; only when nothing is said there does the composition's apply.
      const own = input.admission?.(pos.competency);
      const withdrawn = own === null;
      const admission = withdrawn ? undefined : (own ?? input.admission?.(comp.competency) ?? undefined);
      const admitted: Array<Fragment | Composition> = [];
      const refused: string[] = [];
      for (const iri of pos.paradigm) {
        const item = input.lookup(iri);
        if (!item) { refused.push(`${iri} could not be found`); continue; }
        if (!sameContent(item['@id'], iri) || !(isComposition(item) ? compositionIsIntact(item) : fragmentIsIntact(item))) {
          const because = `${iri} was served with content that does not hash to it, so it was not used`;
          refused.push(because);
          noteRefusal(out, because);
          out.trace.push(`${at}: ${because}`);
          continue;
        }
        if (isComposition(item)) { admitted.push(item); continue; }
        if (item.audience && item.audience !== input.learner.kind) { refused.push(`a ${item.kind} for ${item.audience}s only`); continue; }
        if (admission && !admission.kinds.includes(item.kind)) { refused.push(`a ${item.kind} is not admitted: ${admission.because}`); continue; }
        admitted.push(item);
      }
      if (!admitted.length) {
        const because = admission && !admission.kinds.length
          ? `no content is admitted here: ${admission.because}`
          : `no alternative could be used: ${refused.join('; ')}`;
        out.unmet.push(note(because));
        out.trace.push(`${at}: unmet, ${because}`);
        return;
      }
      if (!admission) {
        out.trace.push(withdrawn
          ? `${at}: the admission for this competency was withdrawn, so every form was admitted`
          : `${at}: nothing said which forms suit this competency, so every form was admitted`);
      }

      // Choice: pitched at the learner's level, then the author's order. A composition has no level
      // of its own (its positions are resolved at this learner's level in turn), but it is chosen
      // only if it resolves; one that leaves positions unmet falls back to the next alternative.
      const want = levelFor(Math.max(demonstrated?.proficiencyRank ?? 0, inferred?.proficiencyRank ?? 0) || undefined);
      const distance = (x: Fragment | Composition): number => (isComposition(x) ? 0 : Math.abs(LEVEL_INDEX[x.level] - LEVEL_INDEX[want]));
      const ranked = admitted.map((x, k) => ({ x, k })).sort((a, b) => distance(a.x) - distance(b.x) || a.k - b.k).map(r => r.x);
      // Among the fragments pitched nearest this learner, what has worked for learners at this level
      // decides, and one with no outcome here yet gets its turn (fragment-efficacy.ts).
      let byEfficacy: { chosen: string; why: string } | undefined;
      const lead = ranked[0];
      if (input.efficacy && lead && !isComposition(lead)) {
        const group = ranked.filter((x): x is Fragment => !isComposition(x) && distance(x) === distance(lead));
        if (group.length > 1) {
          byEfficacy = chooseByEfficacy(group.map(g => g['@id']), iri => input.efficacy!(pos.competency, iri, want));
          const at = ranked.findIndex(x => x['@id'] === byEfficacy!.chosen);
          if (at > 0) ranked.unshift(...ranked.splice(at, 1));
        }
      }
      // A branch that falls short says why: the first of its unmet reasons, briefly, and any content
      // refused inside it for not hashing to its IRI. A branch's text is summarized rather than
      // copied, because copying it up through every level would grow with the number of paths.
      const fellShort: string[] = [];
      const tried: Array<{ item: Composition; branch: Branch; summary: string }> = [];
      let chosen: { item: Fragment | Composition; branch?: Branch } | undefined;
      let partial: { item: Composition; branch: Branch } | undefined;
      for (const item of ranked) {
        if (!isComposition(item)) { chosen = { item }; break; }
        const branch = walk(item, [...ancestors, comp['@id']]);
        if (!branch.unmet.length) { chosen = { item, branch }; break; }
        const n = branch.unmet.length;
        const summary = `"${item.title}" left ${n} of its position(s) unmet: ${brief(branch.unmet[0]!.because)}${n > 1 ? ` (and ${n - 1} more)` : ''}`
          + (branch.refused.length ? `; inside it, ${branch.refused.length}${branch.moreRefused ? ' or more' : ''} alternative(s) did not hash to their IRIs` : '');
        fellShort.push(summary);
        tried.push({ item, branch, summary });
        if (!partial && branch.steps.length) partial = { item, branch };
      }
      chosen ??= partial;
      for (const t of tried) {
        if (t.item === chosen?.item) continue;
        out.trace.push(`${at}: tried ${t.summary}`);
        for (const r of t.branch.refused) { noteRefusal(out, r); out.trace.push(`${at}: inside "${t.item.title}", ${r}`); }
        if (t.branch.moreRefused) { out.moreRefused = true; out.trace.push(`${at}: inside "${t.item.title}", more content did not hash to its IRI than is listed here`); }
      }
      if (!chosen) {
        const because = `no alternative could be used: ${[...refused, ...fellShort].join('; ')}`;
        out.unmet.push(note(because));
        out.trace.push(`${at}: unmet, ${because}`);
        return;
      }
      const passedOver = [...refused, ...fellShort];
      const pick = chosen.item;
      const why = fellShort.length
        ? `the first alternative that could be used (${passedOver.join('; ')})`
        : admitted.length === 1
          ? (pos.paradigm.length === 1 ? 'the only alternative' : `the only admissible alternative (${refused.join('; ')})`)
          : isComposition(pick) ? 'a composition, which resolves its own positions at this learner\'s level'
            : byEfficacy?.chosen === pick['@id'] ? `pitched at ${pick.level} for a learner at ${want}; ${byEfficacy.why}`
              : `pitched at ${pick.level}, nearest the ${want} level this learner is at`;
      if (isComposition(pick)) {
        out.trace.push(`${at}: into "${pick.title}", ${why}`);
        const inner = under(self, chosen.branch!);
        push(out.steps, inner.steps); push(out.skipped, inner.skipped); push(out.unmet, inner.unmet); push(out.trace, inner.trace);
        for (const r of inner.refused) noteRefusal(out, r);
        if (inner.moreRefused) out.moreRefused = true;
        checkSize(out);
        return;
      }
      out.steps.push({ fragment: pick, competency: pos.competency, path: self, position: i, alternatives: pos.paradigm, chosenBecause: why, pitchedAt: want });
      out.trace.push(`${at}: ${pick.kind}${pick.title ? ` "${pick.title}"` : ''}, ${why}`);
    });
    checkSize(out);
    memo.set(key, out);
    return out;
  };
  const whole = walk(root, []);
  const trace = [`resolving "${root.title}" for ${input.learner.kind} ${input.learner.id}`];
  push(trace, whole.trace);
  if (whole.moreRefused) trace.push(`more content did not hash to its IRI than the ${whole.refused.length} refusals listed`);
  trace.push(`resolved: ${whole.steps.length} step(s), ${whole.skipped.length} skipped as demonstrated, ${whole.unmet.length} unmet`);
  return { composition: root['@id'], learner: input.learner.id, steps: whole.steps, skipped: whole.skipped, unmet: whole.unmet, refused: whole.refused, moreRefused: whole.moreRefused, trace };
}

/** How many distinct refusals a resolution lists before it stops adding them. */
const REFUSALS_KEPT = 20;
