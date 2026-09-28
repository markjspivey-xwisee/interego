/**
 * A unit of production work can carry how it went (PERF_EXT.workTrajectory), kept in its own
 * statement on the performer's pod, and the work at one competency reads back newest first, one
 * unit per task, by the same rule the learner record counts it. The bridge answers a failed unit,
 * unasked, with what the work there implies, read from the performer's own record.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { StoredStatement } from '../src/statement-store.js';
import {
  AUTHORED_VERB, PERF_EXT, PERFORMED_VERB, WORK_STEP_LIMITS, WorkStepError, assembleEnterpriseLearnerRecord, labelCompetencyIri, performanceCompetency, trajectoryAt, workAt, workStepsFrom, workStepsOf,
} from '../src/learner-record.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { competencyIri, competencyOfTerm } from '../src/competency-identity.js';
import { competencyRef } from '../src/content-fragments.js';
import { projectMeshEntry } from '../src/mesh-event-projector.js';

const good = { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'ran', objectId: 'urn:x:tests', objectName: ' the tests ', result: { success: false, quality: -0.5, note: 'two failed' }, extra: 'dropped' };

describe('a unit of work keeps how it went', () => {
  it('takes a trajectory as { steps }, keeping what a step is and nothing else', () => {
    expect(workStepsFrom(undefined)).toBeUndefined();
    expect(workStepsFrom(null)).toBeUndefined();
    expect(workStepsFrom({ steps: [good, { modalStatus: 'Counterfactual', granularity: 'task', verb: 'considered', objectId: 'urn:x:plan-b', objectName: 'plan B', supersedesId: 's0', recordedAt: '2026-09-27T10:00:00Z' }] })).toEqual([
      { modalStatus: 'Asserted', granularity: 'tool-call', verb: 'ran', objectId: 'urn:x:tests', objectName: 'the tests', result: { success: false, quality: -0.5, note: 'two failed' } },
      { modalStatus: 'Counterfactual', granularity: 'task', verb: 'considered', objectId: 'urn:x:plan-b', objectName: 'plan B', supersedesId: 's0', recordedAt: '2026-09-27T10:00:00Z' },
    ]);
  });

  it('refuses a malformed one, naming the step', () => {
    const refused = (raw: unknown, message: RegExp) => expect(() => workStepsFrom(raw)).toThrow(message);
    refused([good], /must be \{ steps: \[\.\.\.\] \}/);
    refused({ steps: [] }, /at least one step/);
    refused({ steps: Array.from({ length: WORK_STEP_LIMITS.steps + 1 }, () => good) }, new RegExp(`at most ${WORK_STEP_LIMITS.steps} steps`));
    refused({ steps: [good, { ...good, modalStatus: 'Done' }] }, /trajectory step 2: modalStatus/);
    refused({ steps: [{ ...good, granularity: 'epic' }] }, /granularity must be task, subtask or tool-call/);
    refused({ steps: [{ ...good, objectId: ' ' }] }, /objectId must be a non-empty string/);
    refused({ steps: [{ ...good, verb: 'x'.repeat(WORK_STEP_LIMITS.text + 1) }] }, /verb is longer than/);
    refused({ steps: [{ ...good, recordedAt: 'yesterday' }] }, /recordedAt must be a date and time/);
    refused({ steps: [{ ...good, result: { success: 'no' } }] }, /result\.success must be true or false/);
    refused({ steps: [{ ...good, result: { quality: 2 } }] }, /result\.quality must be a number from -1 to 1/);
    expect(() => workStepsFrom({ steps: ['x'] })).toThrow(WorkStepError);
  });

  it('reads a kept one back as it was kept, and nothing from one it could not have kept', () => {
    expect(workStepsOf([good])).toEqual(workStepsFrom({ steps: [good] }));
    expect(workStepsOf([{ ...good, granularity: 'epic' }])).toBeUndefined();
    expect(workStepsOf({ steps: [good] })).toBeUndefined();
  });
});

describe('work at a competency reads back by the rule the learner record counts it', () => {
  const production = (id: string, over: { type?: string; name?: string; task?: string; success?: boolean; at: string; steps?: unknown; verb?: string; voided?: boolean }): StoredStatement => ({
    id, stored: over.at, voided: over.voided ?? false,
    statement: {
      id, verb: { id: over.verb ?? PERFORMED_VERB }, timestamp: over.at,
      actor: { objectType: 'Agent', account: { homePage: 'https://bridge.example', name: 'did:web:p.example' } },
      object: { objectType: 'Activity', id: over.task ?? `urn:task:${id}`, definition: { name: { en: over.name ?? 'Refund a disputed order' }, type: over.type ?? `${FOXXI_NS}ProductionTask` } },
      ...(over.success === undefined ? {} : { result: { success: over.success } }),
      context: { extensions: { [PERF_EXT.contextKind]: 'production', ...(over.steps ? { [PERF_EXT.workTrajectory]: over.steps } : {}) } },
    },
  });
  const term = 'https://skills.example/ns#RefundAuthority';

  it('names a competency by a domain type\'s term, or else by the task its performer named when an outcome was asserted', () => {
    // Keyed by the competency the term names: another authority's term kept whole.
    expect(performanceCompetency({ taskType: term, taskName: 'anything', success: undefined })).toEqual({ key: competencyOfTerm(term), label: 'RefundAuthority', termIri: term });
    expect(performanceCompetency({ taskType: `${FOXXI_NS}ProductionTask`, taskName: 'Refund a disputed order', success: false })).toEqual({ key: 'label:refund a disputed order', label: 'Refund a disputed order' });
    expect(performanceCompetency({ taskType: `${FOXXI_NS}ProductionTask`, taskName: 'Refund a disputed order', success: undefined })).toBeNull();
  });

  it('reads the latest units at it, newest first, one per task, with the trajectory each kept', () => {
    const statements = [
      production('b', { at: '2026-09-25T10:00:00Z', success: false, task: 'urn:task:1', steps: [good] }),   // a correction: the latest report of task 1 stands,
      production('a', { at: '2026-09-20T10:00:00Z', success: true, task: 'urn:task:1' }),   // whichever order they are read in
      production('c', { at: '2026-09-26T10:00:00Z', success: false, steps: [{ ...good, granularity: 'epic' }] }),   // a trajectory it could not have kept
      production('d', { at: '2026-09-27T10:00:00Z', success: false, name: 'refund a DISPUTED order' }),   // the same named task
      production('e', { at: '2026-09-27T11:00:00Z', success: false, name: 'Close the ticket' }),   // another competency
      production('f', { at: '2026-09-27T12:00:00Z', success: false, voided: true }),
      production('g', { at: '2026-09-27T13:00:00Z', success: false, verb: AUTHORED_VERB }),   // making something is not work at a competency
      production('h', { at: '2026-09-24T10:00:00Z', type: term }),
    ];
    const work = workAt(statements, 'label:refund a disputed order', 'https://bridge.example', 10);
    expect(work.map(w => w.record.id)).toEqual(['d', 'c', 'b']);
    expect(work.map(w => w.steps)).toEqual([undefined, undefined, workStepsFrom({ steps: [good] })]);
    expect(workAt(statements, 'label:refund a disputed order', 'https://bridge.example', 2).map(w => w.record.id)).toEqual(['d', 'c']);
    expect(workAt(statements, competencyOfTerm(term), 'https://bridge.example', 10).map(w => w.record.id)).toEqual(['h']);
  });

  it('names a task\'s competency as the record mints it, which content authored at that slug names too', async () => {
    expect(labelCompetencyIri('Refund a DISPUTED order')).toBe(competencyIri('refund-a-disputed-order'));
    expect(competencyRef('refund-a-disputed-order', 'competency')).toBe(labelCompetencyIri('Refund a disputed order'));
    const record = await assembleEnterpriseLearnerRecord({
      learnerDid: 'did:web:p.example', learnerPodUrl: 'https://pod.example/p/', tenantDid: 'did:web:tenant.example', lrsEndpoint: 'https://bridge.example',
      statements: [production('d', { at: '2026-09-27T10:00:00Z', success: false, name: 'Refund a DISPUTED order' })], subjectKind: 'agent',
      fetch: (async () => { throw new Error('no pod here'); }) as never,
    });
    expect(record.competencies.map(c => c.id)).toEqual([labelCompetencyIri('Refund a DISPUTED order')]);
  });

  it('agrees with the learner record on which competency each unit counts toward', async () => {
    const statements = [
      production('a', { at: '2026-09-20T10:00:00Z', success: true }),
      production('h', { at: '2026-09-24T10:00:00Z', type: term }),
      production('n', { at: '2026-09-24T11:00:00Z' }),   // no type and no outcome: no competency
    ];
    const record = await assembleEnterpriseLearnerRecord({
      learnerDid: 'did:web:p.example', learnerPodUrl: 'https://pod.example/p/', tenantDid: 'did:web:tenant.example', lrsEndpoint: 'https://bridge.example',
      statements, subjectKind: 'agent', fetch: (async () => { throw new Error('no pod here'); }) as never,
    });
    // The record says on what basis it holds each ("Demonstrated: …"); the name after it is the competency's.
    expect(record.competencies.map(c => c.label.replace(/^[A-Za-z]+: /, '')).sort()).toEqual(['Refund a disputed order', 'RefundAuthority']);
  });
});

describe('the bridge answers a failed unit with what the work there implies', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("app.post('/agent/record-performance'"), src.indexOf('\n});', src.indexOf("app.post('/agent/record-performance'")));
  const helper = src.slice(src.indexOf('async function workOfferFor('), src.indexOf('\n}\n', src.indexOf('async function workOfferFor(')));

  it('keeps the trajectory with the work, refusing a malformed one before anything is written', () => {
    expect(route).toMatch(/try \{ workSteps = workStepsFrom\(p\.trajectory\); \}\s+catch \(e\) \{ if \(e instanceof WorkStepError\) \{ res\.status\(400\)\.json\(\{ error: e\.message \}\); return; \} throw e; \}/);
    expect(route.indexOf('workStepsFrom(p.trajectory)')).toBeLessThan(route.indexOf('await storeStatementDurably('));
    expect(route).toMatch(/\.\.\.\(workSteps \? \{ \[PERF_EXT\.workTrajectory\]: workSteps \} : \{\}\),/);
  });

  it('answers only a failure, for the performer themselves, and the record stands whatever it finds', () => {
    expect(route).toMatch(/if \(p\.success === false\) \{\s+try \{\s+workOffer = await workOfferFor\(\{ id: callerDid, kind: p\.actor_kind === 'human' \? 'human' : 'agent' \}, subjectPod, \{ taskType: activityType, taskName \}\);/);
    expect(route).toMatch(/workOffer = \{ offered: false, because: 'your recorded work could not be read, so no offer is made' \};/);
    expect(route).toMatch(/\.\.\.\(workOffer \? \(workOffer\.offered \? \{ offer: workOffer\.offer \} : \{ offerWithheld: workOffer\.because \}\) : \{\}\),/);
  });

  it('reads the regime from trajectories the performer recorded apart from the work, cut to its competency', () => {
    expect(helper).toMatch(/const elsewhere = trajectoriesRecordedApart\(performer\.id, subjectPod\)\s+\.map\(t => trajectoryAt\(t, named\.key\)\)\s+\.filter\(\(t\): t is AgentTrajectory => t !== null\);/);
    expect(helper).toMatch(/standing: admissionFor\(kept\.standing, competency\), elsewhere, base: bridgeBaseUrl \}\);/);
    // Where a performer's trajectories are kept: recorded with the tool, against this tenant or their
    // own pod, and published to their pod as the mesh sweep keeps it. A read makes no partition.
    const apart = src.slice(src.indexOf('function trajectoriesRecordedApart('), src.indexOf('\n}\n', src.indexOf('function trajectoriesRecordedApart(')));
    expect(apart).toContain('const where: Array<[TenantId, string]> = [[tenantIdOf(tenantPodUrl), did], [tenantIdOf(pod), did], [lensTenantFor(label), label]];');
    expect(apart).toContain('agentTrajectoriesByTenant.has(tenant) ? agentTrajectoriesByTenant.for(tenant).get(key) : undefined');
    // The tool takes the type of what a step acted on, so its task names a typed competency.
    const tool = src.slice(src.indexOf("'foxxi.record_agent_trajectory': async"), src.indexOf("'foxxi.get_agent_trajectory': async"));
    expect(tool).toContain("...(typeof s.object_type === 'string' && s.object_type.trim() ? { objectType: s.object_type.trim() } : {}),");
  });

  it('keeps with a step the performer published what its statement names the work by, so the step is read at the competency the statement counts toward', () => {
    const DOMAIN = 'https://ops.example/ns/work#RefundDecision';
    /** A published descriptor's step, and the competency its own statement counts toward, by the record's rule. */
    const projected = (entry: Record<string, unknown>) => {
      const ev = projectMeshEntry({ descriptorUrl: 'https://pod.example/p/context-graphs/1790000000000.ttl', describes: ['urn:graph:refund-1790000000000'], modalStatus: 'Asserted', ...entry } as never, 'https://pod.example/p/')!;
      const object = ev.statement.object as { definition: { type: string; name: { en: string } } };
      const success = (ev.statement.result as { success?: boolean } | undefined)?.success;
      const key = performanceCompetency({ taskType: object.definition.type, taskName: object.definition.name.en, success })?.key;
      const run = { steps: [{ ...ev.step, id: ev.step.id! }] };
      return { step: ev.step, key, read: key ? trajectoryAt(run, key) : null };
    };
    // A domain type names the competency.
    const typed = projected({ conformsTo: ['https://w3id.org/interego/ns/iep#TemporalFacet', DOMAIN] });
    expect(typed.step.objectType).toBe(DOMAIN);
    expect(typed.key).toBe(competencyOfTerm(DOMAIN));
    expect(typed.read?.steps).toHaveLength(1);
    // With no domain type, the named task does once an outcome was published, and the step keeps
    // that outcome, so it names the same competency (Codex, on #554).
    const named = projected({ conformsTo: ['https://w3id.org/interego/ns/iep#TemporalFacet'], success: false });
    expect(named.step.result).toEqual({ success: false });
    expect(named.key).toMatch(/^label:/);
    expect(named.read?.steps).toHaveLength(1);
    // Without an outcome, neither the statement nor the step names one.
    const bare = projected({ conformsTo: ['https://w3id.org/interego/ns/iep#TemporalFacet'] });
    expect(bare.key).toBeUndefined();
    expect(bare.step.result).toBeUndefined();
  });

  it('reads a trajectory back with the type each step was recorded with (Codex, on #554)', () => {
    const getter = src.slice(src.indexOf("'foxxi.get_agent_trajectory': async"), src.indexOf('\n  },', src.indexOf("'foxxi.get_agent_trajectory': async")));
    expect(getter).toContain('object: { id: s.objectId, name: s.objectName, ...(s.objectType ? { type: s.objectType } : {}) },');
  });

  it('reads the performer\'s own record and what they keep, and makes no offer it could repeat', () => {
    expect(helper).toMatch(/const kept = await learnerAdmissions\(performer\.id\);\s+if \(!kept\.ok\) return \{ offered: false,/);
    expect(helper).toMatch(/workAt\(await learnerStatementsFor\(subjectPod, performer\.id\), named\.key, bridgeBaseUrl, WORK_OFFER_WINDOW\)/);
    expect(helper).toMatch(/standing: admissionFor\(kept\.standing, competency\)/);
    // A kept offer must constrain the competency content and the record name, not the words as written.
    expect(helper).toMatch(/competency = named\.termIri \? competencyRef\(named\.termIri, 'activity_type'\) : labelCompetencyIri\(named\.label\);/);
  });
});
