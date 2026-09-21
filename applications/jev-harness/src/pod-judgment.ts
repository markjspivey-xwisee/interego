/**
 * A judgment read back from the pod.
 *
 * CI's bridge makes the judgments for a pull request and is gone when the run ends; the
 * judgments live on as descriptors on the pod, published by the delegate. When the pull
 * request closes, another bridge has to score them, so it reads the judgment's payload back
 * and rebuilds enough of the judgment to record an outcome: the candidates and advice of a
 * navigation, the tests of a selection, the verdict of a review, the failures of a triage,
 * and the base fields every outcome copies. The parser mirrors `payloadBody` in
 * descriptor.ts, term for term.
 */

import { Parser, type Quad, type Term } from 'n3';
import type { JudgmentKind, RepoRef } from './judgments/common.js';
import type { NavigationJudgment, NavigationAdvice, Candidate } from './judgments/navigate.js';
import type { TestSelectionJudgment, SelectedTest } from './judgments/select-tests.js';
import { REVIEW_POLICY, type ReviewVerdictJudgment, type Hazard, type Verdict } from './judgments/review-gate.js';
import type { FailureTriageJudgment, TriagedFailure, CauseClass, TriageGroup } from './judgments/triage.js';
import type { AnyJudgment } from './judgments/outcome.js';

const dec = new TextDecoder();
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const KIND_BY_CLASS: Readonly<Record<string, JudgmentKind>> = {
  Navigation: 'navigation', TestSelection: 'test-selection', FailureTriage: 'failure-triage', ReviewVerdict: 'review-verdict', Outcome: 'outcome',
};

export interface PodJudgmentMeta {
  readonly graphIri: string;
  readonly descriptorUrl: string;
  readonly validFrom?: string;
}

/** A judgment rebuilt from the pod, remembering the descriptor it was read from. */
export type PodJudgment = AnyJudgment & { readonly podDescriptorUrl: string };

export type PodJudgmentResult =
  | { readonly kind: 'judgment'; readonly judgment: PodJudgment }
  | { readonly kind: 'outcome' }
  | { readonly kind: 'none' };

type Props = Map<string, Term[]>;

const localName = (iri: string): string => iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'), iri.lastIndexOf(':')) + 1);

function propsOf(quads: readonly Quad[]): Map<string, Props> {
  const out = new Map<string, Props>();
  for (const q of quads) {
    const key = q.subject.termType === 'BlankNode' ? `_:${q.subject.value}` : q.subject.value;
    let p = out.get(key);
    if (!p) { p = new Map(); out.set(key, p); }
    const name = q.predicate.value === RDF_TYPE ? 'type' : localName(q.predicate.value);
    const list = p.get(name) ?? [];
    list.push(q.object);
    p.set(name, list);
  }
  return out;
}

const str = (p: Props | undefined, name: string): string | undefined => { const t = p?.get(name)?.[0]; return t?.termType === 'Literal' ? t.value : t?.value; };
const strs = (p: Props | undefined, name: string): string[] => (p?.get(name) ?? []).map((t) => t.value);
const num = (p: Props | undefined, name: string): number | undefined => { const v = str(p, name); return v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v); };
const bool = (p: Props | undefined, name: string): boolean => str(p, name) === 'true';

/**
 * Rebuild the judgment a pod descriptor's graph content holds. `content` is the TriG (or
 * Turtle) the relay returns for the descriptor; `none` when it holds no harness judgment,
 * `outcome` when the head is already the outcome that scored it.
 */
export function judgmentFromContent(content: string | Uint8Array, meta: PodJudgmentMeta): PodJudgmentResult {
  const text = typeof content === 'string' ? content : dec.decode(content);
  let quads: Quad[];
  try {
    quads = new Parser({ format: 'TriG', baseIRI: meta.descriptorUrl }).parse(text);
  } catch {
    return { kind: 'none' };
  }
  const bySubject = propsOf(quads);
  let subject: string | undefined;
  let kind: JudgmentKind | undefined;
  for (const [s, p] of bySubject) {
    for (const t of p.get('type') ?? []) {
      const k = KIND_BY_CLASS[localName(t.value)];
      if (k && t.value.includes('jev-harness')) { subject = s; kind = k; break; }
    }
    if (subject) break;
  }
  if (!subject || !kind) return { kind: 'none' };
  if (kind === 'outcome') return { kind: 'outcome' };
  const p = bySubject.get(subject)!;
  const bn = (t: Term): Props | undefined => (t.termType === 'BlankNode' ? bySubject.get(`_:${t.value}`) : undefined);
  const repository: RepoRef = { name: str(p, 'repository') ?? 'unknown', root: '', commit: str(p, 'commit') ?? null };
  const base = {
    id: localName(subject),
    graphIri: meta.graphIri,
    createdAt: str(p, 'created') ?? meta.validFrom ?? new Date(0).toISOString(),
    model: str(p, 'model') ?? 'unknown',
    confidence: num(p, 'confidence') ?? 0,
    repository,
    usage: { requests: 0, input_tokens: 0, output_tokens: 0, latencyMs: 0 },
    podDescriptorUrl: meta.descriptorUrl,
  };

  if (kind === 'navigation') {
    const candidates = (p.get('candidate') ?? []).map(bn).filter((c): c is Props => c !== undefined);
    const of = (role: string): Candidate[] => candidates.filter((c) => str(c, 'role') === role).map((c) => ({ path: str(c, 'path') ?? '', probability: num(c, 'probability') ?? 0 }));
    const files = of('change');
    const tests = of('test');
    const docs = of('document');
    const covered = num(p, 'covered') ?? 0;
    const j: NavigationJudgment & { podDescriptorUrl: string } = {
      ...base, kind, task: str(p, 'task') ?? '', ...(str(p, 'scope') ? { scope: str(p, 'scope')! } : {}),
      files, tests, docs, covered, noTestProbability: Math.max(0, 1 - covered),
      advice: (str(p, 'advice') ?? 'widen-search') as NavigationAdvice, passes: [], filesConsidered: files.length + tests.length + docs.length,
      ...(num(p, 'directoryProbability') !== undefined ? { directoryProbability: num(p, 'directoryProbability')! } : {}),
    };
    return { kind: 'judgment', judgment: j };
  }
  if (kind === 'test-selection') {
    const tests: SelectedTest[] = (p.get('selectedTest') ?? []).map(bn).filter((c): c is Props => c !== undefined).map((c) => ({
      path: str(c, 'path') ?? '', selectedBy: (str(c, 'selectedBy') ?? 'semantic') as SelectedTest['selectedBy'],
      ...(num(c, 'probability') !== undefined ? { probability: num(c, 'probability')! } : {}),
    }));
    const j: TestSelectionJudgment & { podDescriptorUrl: string } = {
      ...base, kind, changedFiles: strs(p, 'changedFile'), mode: str(p, 'mode') === 'full' ? 'full' : 'subset', reasons: strs(p, 'reason'), tests, covered: {},
      ...(str(p, 'task') ? { task: str(p, 'task')! } : {}),
    };
    return { kind: 'judgment', judgment: j };
  }
  if (kind === 'review-verdict') {
    const hazards: Hazard[] = (p.get('hazard') ?? []).map(bn).filter((c): c is Props => c !== undefined).map((c) => ({
      name: str(c, 'hazardName') ?? '', description: '', probability: num(c, 'probability') ?? 0, threshold: REVIEW_POLICY.hazardThreshold, fired: bool(c, 'fired'),
    }));
    const risk = str(p, 'risk');
    const j: ReviewVerdictJudgment & { podDescriptorUrl: string } = {
      ...base, kind, verdict: (str(p, 'verdict') ?? 'needs-human-review') as Verdict, checks: strs(p, 'check'), hazards,
      descriptionMatch: num(p, 'descriptionMatch') ?? null, risk: risk ? { choice: risk, probabilities: {}, confidence: 0 } : null,
      changedFiles: strs(p, 'changedFile'), reasons: strs(p, 'reason'), policy: str(p, 'policy') ?? '',
      ...(str(p, 'changeTitle') ? { title: str(p, 'changeTitle')! } : {}),
    };
    return { kind: 'judgment', judgment: j };
  }
  // failure-triage: the payload carries each failure's class and confidence, not the whole
  // distribution, so the Brier score of an outcome recorded from the pod is an approximation
  // over {class: confidence}; the agreement counts are exact.
  const failures: TriagedFailure[] = (p.get('failure') ?? []).map(bn).filter((c): c is Props => c !== undefined).map((c) => {
    const causeClass = (str(c, 'causeClass') ?? 'unclear') as CauseClass;
    const confidence = num(c, 'confidence') ?? 0;
    return {
      id: str(c, 'identifier') ?? '', causeClass, probabilities: { [causeClass]: confidence }, confidence, action: str(c, 'action') ?? '',
      excerpt: str(c, 'excerpt') ?? '', ...(str(c, 'path') ? { file: str(c, 'path')! } : {}), ...(str(c, 'testName') ? { name: str(c, 'testName')! } : {}),
    };
  });
  const groups: TriageGroup[] = [];
  for (const f of failures) {
    const g = groups.find((x) => x.causeClass === f.causeClass);
    if (g) groups[groups.indexOf(g)] = { ...g, count: g.count + 1, failures: [...g.failures, f.id] };
    else groups.push({ causeClass: f.causeClass, count: 1, action: f.action, failures: [f.id] });
  }
  const j: FailureTriageJudgment & { podDescriptorUrl: string } = { ...base, kind: 'failure-triage', failures, groups, parsedFailures: failures.length, changedFiles: strs(p, 'changedFile') };
  return { kind: 'judgment', judgment: j };
}
