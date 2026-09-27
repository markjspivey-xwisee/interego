/**
 * Work recorded against this deployment's own competency counts toward that competency, the one
 * content names and resolution reads a learner's record by, in whatever form the term names it: its
 * URL under this deployment's base, the legacy urn, or an own IRI once wrapped as a term. Another
 * host's `/ns/foxxi/competency/<slug>` is another authority's term and stays a competency of its
 * own, as any other authority's term does (competency-authority-collision.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COMPETENCY_ID_BASE, competencyIri, competencyIriForTerm, competencyOfTerm, ownCompetencyIri, sameCompetency,
} from '../applications/foxxi-content-intelligence/src/competency-identity.js';
import { competencyRef, fragmentFrom, type Fragment } from '../applications/foxxi-content-intelligence/src/content-fragments.js';
import { compositionFrom, resolveComposition, type Composition } from '../applications/foxxi-content-intelligence/src/compositions.js';
import { assembleEnterpriseLearnerRecord, performanceCompetency, workAt } from '../applications/foxxi-content-intelligence/src/learner-record.js';
import type { StoredStatement } from '../applications/foxxi-content-intelligence/src/statement-store.js';

const slug = 'refund-authority';
const OWN = competencyIri(slug);
const URN = `urn:foxxi:competency:${slug}`;
const ELSEWHERE = `https://elsewhere.example/ns/foxxi/competency/${slug}`;
const CONTEXT_KIND = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#contextKind';
const LRS = 'https://foxxi-bridge.interego.xwisee.com';

function perf(id: string, type: string, success = true, name = 'a refund decided'): StoredStatement {
  return {
    id, stored: '2026-09-27T00:00:00Z', voided: false,
    statement: {
      id,
      actor: { objectType: 'Agent', account: { homePage: LRS, name: 'did:web:x:agents:probe' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed' },
      object: { objectType: 'Activity', id: `urn:task:${id}`, definition: { name: { en: name }, type } },
      result: { success },
      context: { extensions: { [CONTEXT_KIND]: 'production' } },
      timestamp: '2026-09-27T00:00:00Z',
    },
  } as unknown as StoredStatement;
}
const assemble = (statements: readonly StoredStatement[]) => assembleEnterpriseLearnerRecord({
  learnerDid: 'did:web:x:agents:probe', learnerPodUrl: 'https://gate.example/probe/', tenantDid: 'did:web:x:tenant', lrsEndpoint: LRS, statements,
  fetch: (async () => { throw new Error('no network in this test'); }) as unknown as typeof globalThis.fetch,
});

// A position at the competency that any demonstration at all lets a learner skip.
const lesson = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [slug], title: 'Who approves', body: 'Agents refund up to $250.' });
const course = compositionFrom({ title: 'Refunds', competency: slug, positions: [{ competency: slug, demonstratedAt: 1, paradigm: [lesson['@id']] }] });
const store = new Map<string, Fragment | Composition>([lesson, course].map(x => [x['@id'], x]));
const resolveFor = (record: Awaited<ReturnType<typeof assemble>>) =>
  resolveComposition({ composition: course, learner: { id: 'did:web:x:agents:probe', kind: 'agent' }, record: record.competencies, lookup: i => store.get(i) });

describe('this deployment\'s own competency is itself', () => {
  it('in its URL form, its legacy urn, and an own IRI once wrapped as a term; nowhere else', () => {
    expect(ownCompetencyIri(OWN)).toBe(OWN);
    expect(ownCompetencyIri(URN)).toBe(OWN);
    expect(ownCompetencyIri(competencyIriForTerm(OWN))).toBe(OWN);
    expect(ownCompetencyIri(ELSEWHERE)).toBeNull();
    expect(ownCompetencyIri(`${COMPETENCY_ID_BASE}/${slug}/more`)).toBeNull();
    expect(ownCompetencyIri(`${COMPETENCY_ID_BASE}/${slug}#part`)).toBeNull();
    expect(ownCompetencyIri('https://skills.example/ns#RefundAuthority')).toBeNull();
    // The same competency content names it by, where another host's stays whole.
    expect(competencyOfTerm(OWN)).toBe(competencyRef(slug, 'competency'));
    expect(competencyOfTerm(ELSEWHERE)).toBe(competencyIriForTerm(ELSEWHERE));
  });

  it('counts work recorded against it toward the competency resolution reads, so a learner who has shown it skips it', async () => {
    const record = await assemble([perf('p1', OWN)]);
    expect(record.competencies.map(c => c.id)).toEqual([OWN]);
    expect(sameCompetency(record.competencies[0]!.aboutCompetency, competencyRef(slug, 'competency'))).toBe(true);
    const resolution = resolveFor(record);
    expect(resolution.skipped).toHaveLength(1);
    expect(resolution.steps).toHaveLength(0);
  });

  it('counts its legacy urn the same way', async () => {
    const record = await assemble([perf('p1', URN)]);
    expect(record.competencies.map(c => c.id)).toEqual([OWN]);
    expect(resolveFor(record).skipped).toHaveLength(1);
  });

  it('keeps another host\'s competency of the same name apart, as another authority\'s', async () => {
    const record = await assemble([perf('p1', ELSEWHERE)]);
    expect(record.competencies.map(c => c.id)).toEqual([competencyIriForTerm(ELSEWHERE)]);
    expect(sameCompetency(record.competencies[0]!.aboutCompetency, competencyRef(slug, 'competency'))).toBe(false);
    const resolution = resolveFor(record);
    expect(resolution.skipped).toHaveLength(0);
    expect(resolution.steps).toHaveLength(1);
  });

  it('pools every form that names it, and a task named in words with its id, into one competency', async () => {
    const record = await assemble([perf('p1', OWN), perf('p2', URN), perf('p3', `${LRS}/ns/foxxi#ProductionTask`, true, 'Refund Authority'), perf('p4', ELSEWHERE)]);
    const own = record.competencies.filter(c => c.id === OWN);
    expect(own).toHaveLength(1);   // one assertion under one id
    expect(own[0]!.evidence.filter(e => e.includes('statementId='))).toHaveLength(3);
    expect(record.competencies.map(c => c.id).sort()).toEqual([OWN, competencyIriForTerm(ELSEWHERE)].sort());
  });

  it('is what the bridge tells a performer to type their work with', () => {
    // The hint names this deployment's own competency, not a URL under whatever host the bridge
    // runs on, which may not be the base its competencies are named under.
    const src = readFileSync(new URL('../applications/foxxi-content-intelligence/bridge/server.ts', import.meta.url), 'utf8');
    const hints = [...src.matchAll(/hint: `Use an absolute IRI you own, e\.g\. \$\{([^}]*)\}/g)].map(m => m[1]);
    expect(hints).toHaveLength(2);
    for (const h of hints) expect(h).toMatch(/^competencyIri\(/);
  });

  it('reads the work at it in every form that names it', () => {
    const statements = [perf('p1', OWN, false), perf('p2', URN, false), perf('p3', ELSEWHERE, false)];
    const key = performanceCompetency({ taskType: URN, taskName: 'a refund decided', success: false })!.key;
    expect(key).toBe(OWN);
    expect(workAt(statements, key, LRS, 10).map(w => w.record.id).sort()).toEqual(['p1', 'p2']);
  });
});
