/**
 * The work-redesign engines, pure: the published policy read from wrd.ttl, classification,
 * party and allocation rules, quote verification, the valuation model, outcome grading,
 * envelopes, calibration and earned grants, and the record graphs and descriptors.
 *
 * Every expected number here is worked out by hand from the inputs in the test (closed forms,
 * reference vectors, rule-of-three counts), never read back from the engine and pinned.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  importWallet, signMessageRaw, canonicalJson, sha256Hex, validateAgainstShape, canonicalGraphDigestResult, toTurtle, validate,
} from '@interego/core';
import {
  readPublishedPolicy, readOntologyTurtle, readShapesTurtle, podPolicyLoosens, effectivePolicy, coercePodPolicy, levelIri,
  ALLOCATION_LEVELS, REGIME_SOURCE, WRD_NS, WRD_ONTOLOGY_IRI, wrdTerm,
  type AllocationLevel, type EffectivePolicy, type Regime,
} from '../src/ontology.js';
import {
  classifyTask, coerceAnswers, checkParties, checkAllocation, checkActingUnderGrant, currentAllocationNote, planKindOf, performerOf, namedPartiesOf, coerceChange,
  normaliseForQuote, verifyQuote, verifyTaskQuotes, quoteStatusOf, coerceCapture, coerceRevision, applyTaskChanges, taskTextSha256,
  buildTaskMapPacket, MIN_QUOTE_CHARS,
  type ClassificationAnswers, type TaskForAllocation, type GrantState, type AllocationChange, type Allocation,
} from '../src/work.js';
import {
  coerceValuationInputs, valuePlan, seedFor, prng, sampleTriangular, percentile, npvOf, runsForRuleOfThree, meanRampFactor,
  monthsBetween, checkOutcomeWindow, checkWindowLength, gradeOutcome, calibrationReport, evaluateGrant, meanOrdinalDistance, predictionKind, runKind,
  nonFiniteIn, DEMO_LABEL, DISTINCT_PEOPLE_NOTE, MONTH_DAYS, MAX_INPUT,
  type Tri, type TaskState, type ValuationInputs, type ReviewedRun, type DecisionForCalibration,
} from '../src/valuation.js';
import {
  openEnvelope, verifyStoredEnvelope, bindRelayDelegated, relayPayloadView, NonceLedger, envelopeSha256, didOf, principalKey, principalOfDid, isUserPrincipal, isPersonId,
  entityIri, scopePrefix, graphIriOf, recordIdFor, slugOf,
  buildGraphTurtle, parseRecordGraph, buildDescriptor, normalisePodUrl, RECORD_KINDS, RECORD_STATUSES,
  type SignedEnvelope, type WrdRecord, type PolicyRef, type RecordSigner, type PlatformRef,
} from '../src/records.js';

const must = <T>(v: T | undefined | null, what = 'value'): T => {
  if (v === undefined || v === null) throw new Error(`expected a ${what}`);
  return v;
};

const policy = readPublishedPolicy();
const effective: EffectivePolicy = effectivePolicy(policy, null, null);
const POD = 'https://192.0.2.20/t/';
const NOW = '2026-10-22T09:00:00.000Z';
// Hardhat development keys: public test vectors, never real funds.
const ANA = importWallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'human', 'ana');
const BO = importWallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', 'human', 'bo');
const AGENT = importWallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', 'agent', 'agent');
const PERSON = ANA.address.toLowerCase();
const PERSON2 = BO.address.toLowerCase();
const AGENT_ADDR = AGENT.address.toLowerCase();
const T1 = 'urn:wrd:task:00000000000000a1:00000000000000b1';
const T2 = 'urn:wrd:task:00000000000000a1:00000000000000b2';

const answers = (o: Partial<ClassificationAnswers> = {}): ClassificationAnswers => ({
  sameStepsSameResult: 'always', methodKnown: 'documented', outcomeDependsOnOthers: 'no', situationStable: 'stable',
  checkability: 'before-effect', feedbackLatency: 'minutes', worstCase: 'recoverable', ...o,
});
const ruleIri = (id: string): string => must(policy.rules.get(id as 'R0'), `rule ${id}`).iri;

// ── Published policy ──────────────────────────────────────────────────────────────────────

describe('published policy', () => {
  it('reads routing, permitted levels, rule conditions and the grant policy from wrd.ttl, and throws when the ontology has no routesTo edges', () => {
    expect(must(policy.regimes.get('Evident')).method).toBe('standardise');
    expect(must(policy.regimes.get('Knowable')).method).toBe('expert-analysis');
    expect(must(policy.regimes.get('Emergent')).method).toBe('probe-portfolio');
    expect(must(policy.regimes.get('Turbulent')).method).toBe('stabilise-first');
    expect(must(policy.regimes.get('Turbulent')).permitsChange).toBe(false);
    expect(must(policy.regimes.get('Emergent')).requiresProbe).toBe(true);
    expect(must(policy.regimes.get('Emergent')).pointValuation).toBe(false);
    expect(must(policy.regimes.get('Knowable')).requiresExpertEvidence).toBe(true);
    expect(policy.grantPolicy).toMatchObject({ floor: 0.9, minSamples: 20, minHumanConfirmations: 5, minDistinctConfirmers: 5, minReadyClaimPrecision: 0.9, criticalWorkFailureCeiling: 0.01, contraryReworkShare: 0.2, contraryMinRuns: 5 });
    expect([...policy.rules.keys()].sort()).toEqual(['R0', 'R1', 'R2', 'R3a', 'R3b', 'R4']);
    expect(must(policy.rules.get('R1')).condition).toMatch(/unstable/);
    expect(must(policy.rules.get('R0')).yields).toBeNull();
    expect(policy.regimeSourceIri).toBe(wrdTerm('RuleOnSignedAnswers'));
    expect(policy.ontologySha256).toBe(sha256Hex(readOntologyTurtle()));
    for (const l of ALLOCATION_LEVELS) expect(must(policy.levels.get(l)).iri).toBe(levelIri(l));

    const ttl = readOntologyTurtle();
    const withoutRoutes = ttl.split('\n').filter((line) => !line.includes('wrd:routesTo wrd:')).join('\n');
    expect(() => readPublishedPolicy(withoutRoutes)).toThrow(/zero wrd:routesTo edges/);
    expect(() => readPublishedPolicy(ttl.replace('wrd:defaultGrantPolicy a wrd:GrantPolicy', 'wrd:someOtherPolicy a wrd:GrantPolicy'))).toThrow(/defaultGrantPolicy/);
    expect(() => readPublishedPolicy(ttl.replace('wrd:ruleId "R3b"', 'wrd:ruleId "R9"'))).toThrow(/ruleId/);
    expect(() => readPublishedPolicy(ttl.replace('wrd:levelToken "agent-acts-person-audits"', 'wrd:levelToken "agent-audits"'))).toThrow(/levelToken/);
    expect(() => readPublishedPolicy(ttl.replace('wrd:floor "0.9"^^xsd:decimal', 'wrd:floor "high"'))).toThrow(/floor/);

    // The rule IS the data: make R1 yield Emergent in the published text and the engine follows.
    const r1 = ttl.indexOf('wrd:RuleR1 a wrd:ClassificationRule');
    const edge = ttl.indexOf('wrd:yields wrd:Turbulent', r1);
    expect(r1).toBeGreaterThan(0);
    expect(edge).toBeGreaterThan(r1);
    const edited = `${ttl.slice(0, edge)}wrd:yields wrd:Emergent${ttl.slice(edge + 'wrd:yields wrd:Turbulent'.length)}`;
    const unstable = answers({ situationStable: 'unstable' });
    expect(classifyTask(unstable, policy)).toMatchObject({ placed: true, regime: 'Turbulent' });
    expect(classifyTask(unstable, readPublishedPolicy(edited))).toMatchObject({ placed: true, regime: 'Emergent', method: 'probe-portfolio' });
  });

  it('keeps Knowable without the within-grant level and Evident with it', () => {
    expect(must(policy.regimes.get('Evident')).permittedLevels).toEqual([...ALLOCATION_LEVELS]);
    expect(must(policy.regimes.get('Knowable')).permittedLevels).not.toContain('agent-acts-within-grant');
    expect(must(policy.regimes.get('Knowable')).permittedLevels).toContain('agent-acts-person-audits');
    expect(must(policy.regimes.get('Emergent')).permittedLevels).toEqual(['person', 'person-with-agent-assist', 'agent-drafts-person-decides']);
    expect(must(policy.regimes.get('Turbulent')).permittedLevels).toEqual([]);
    expect(must(policy.levels.get('agent-acts-within-grant'))).toMatchObject({ requiresAgent: true, requiresPerson: false, requiresGrant: true, requiresCheckability: ['before-effect', 'after-effect'] });
  });

  it('the party rules in code agree with the published level flags', () => {
    for (const rule of policy.levels.values()) {
      const both: Allocation = { level: rule.level, personAddress: PERSON, agentAddress: AGENT_ADDR };
      expect(performerOf(both), rule.level).toBe(rule.requiresAgent ? AGENT_ADDR : PERSON);
      const ctx = { isRegisteredPerson: (a: string) => a === PERSON, isRegisteredAgent: (a: string) => a === AGENT_ADDR, atCapture: false };
      const noAgent = checkParties({ level: rule.level, personAddress: PERSON }, ctx);
      expect(noAgent.ok, `${rule.level} without an agent`).toBe(!rule.requiresAgent);
      const noPerson = checkParties({ level: rule.level, agentAddress: AGENT_ADDR }, ctx);
      expect(noPerson.ok, `${rule.level} without a person`).toBe(!rule.requiresPerson);
    }
  });

  it('applies a pod policy that tightens and names the field of one that loosens', () => {
    expect(podPolicyLoosens(policy, { floor: 0.8 })).toBe('floor');
    expect(podPolicyLoosens(policy, { minSamples: 10 })).toBe('minSamples');
    expect(podPolicyLoosens(policy, { minDistinctConfirmers: 4 })).toBe('minDistinctConfirmers');
    expect(podPolicyLoosens(policy, { floor: 0.95, minSamples: 30, maxLevel: 'person' })).toBeNull();
    expect(() => effectivePolicy(policy, { minHumanConfirmations: 1 }, null)).toThrow(/minHumanConfirmations/);

    const tight = effectivePolicy(policy, { maxLevel: 'agent-drafts-person-decides', floor: 0.95, minSamples: 30 }, 'https://192.0.2.20/t/wrd/records/registry-1');
    expect(must(tight.regimes.get('Evident')).permittedLevels).toEqual(['person', 'person-with-agent-assist', 'agent-drafts-person-decides']);
    expect(must(tight.regimes.get('Knowable')).permittedLevels).toEqual(['person', 'person-with-agent-assist', 'agent-drafts-person-decides']);
    expect(tight.grantPolicy).toMatchObject({ floor: 0.95, minSamples: 30, minHumanConfirmations: 5, minDistinctConfirmers: 5 });
    expect(tight.podPolicyHead).toBe('https://192.0.2.20/t/wrd/records/registry-1');
    // The published policy is untouched.
    expect(must(policy.regimes.get('Evident')).permittedLevels).toHaveLength(5);

    expect(coercePodPolicy({ maxLevel: 'agent-acts-person-audits', floor: 1 })).toMatchObject({ ok: true });
    expect(coercePodPolicy({ maxLevel: 'robot' })).toMatchObject({ ok: false });
    expect(coercePodPolicy({ floor: 1.5 })).toMatchObject({ ok: false });
    expect(coercePodPolicy({ minSamples: 2.5 })).toMatchObject({ ok: false });
    expect(coercePodPolicy({ ceiling: 3 })).toMatchObject({ ok: false, why: 'podPolicy.ceiling is not a pod policy field' });
  });

  it('keeps docs wrd.ttl, wrd/shapes.ttl and the extensionless wrd/shapes byte-equal to the sources', () => {
    const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8').split('\r\n').join('\n');
    expect(read('../../../docs/applications/work-redesign/wrd.ttl')).toBe(read('../ontology/wrd.ttl'));
    expect(read('../../../docs/applications/work-redesign/wrd/shapes.ttl')).toBe(read('../ontology/wrd-shapes.ttl'));
    expect(read('../../../docs/applications/work-redesign/wrd/shapes')).toBe(read('../ontology/wrd-shapes.ttl'));
    const html = read('../../../docs/applications/work-redesign/wrd.html');
    expect(html).toContain('href="wrd.ttl"');
    for (const term of ['Decision', 'Prediction', 'LevelAgentActsWithinGrant', 'RuleR3a', 'payloadJson']) expect(html).toContain(`id="${term}"`);
  });
});

// ── Classification ────────────────────────────────────────────────────────────────────────

describe('classification', () => {
  it('places Evident, Knowable, Emergent and Turbulent from evidence answers and names the rule IRIs that fired, with source rule-on-signed-answers', () => {
    const cases: Array<[Partial<ClassificationAnswers>, Regime, string]> = [
      [{}, 'Evident', 'R3b'],
      [{ sameStepsSameResult: 'usually', methodKnown: 'expert-analysis', checkability: 'after-effect', feedbackLatency: 'days' }, 'Knowable', 'R4'],
      [{ sameStepsSameResult: 'rarely', outcomeDependsOnOthers: 'yes', situationStable: 'shifting' }, 'Emergent', 'R2'],
      [{ methodKnown: 'not-knowable' }, 'Emergent', 'R2'],
      [{ outcomeDependsOnOthers: 'partly', sameStepsSameResult: 'rarely' }, 'Emergent', 'R2'],
      [{ sameStepsSameResult: 'unknown', methodKnown: 'unknown', outcomeDependsOnOthers: 'partly', situationStable: 'unstable', checkability: 'not-checkable' }, 'Turbulent', 'R1'],
      // R1 is tried first: an unstable situation is Turbulent even when the outcome depends on others.
      [{ outcomeDependsOnOthers: 'yes', situationStable: 'unstable' }, 'Turbulent', 'R1'],
      // R4 covers partly-dependent work in a shifting situation.
      [{ sameStepsSameResult: 'usually', outcomeDependsOnOthers: 'partly', situationStable: 'shifting' }, 'Knowable', 'R4'],
    ];
    for (const [o, regime, rule] of cases) {
      const r = classifyTask(answers(o), policy);
      expect(r, JSON.stringify(o)).toMatchObject({ placed: true, regime, rulesFired: [ruleIri(rule)] });
      if (r.placed) expect(r.method).toBe(must(policy.regimes.get(regime)).method);
    }
    expect(REGIME_SOURCE).toBe('rule-on-signed-answers');
    expect(ruleIri('R3b')).toBe(wrdTerm('RuleR3b'));
  });

  it('reads Evident as Knowable when the output cannot be checked or feedback is slow', () => {
    for (const o of [{ checkability: 'not-checkable' as const }, { checkability: 'unknown' as const }, { feedbackLatency: 'weeks' as const }, { feedbackLatency: 'months-or-more' as const }, { feedbackLatency: 'unknown' as const }]) {
      const r = classifyTask(answers(o), policy);
      expect(r, JSON.stringify(o)).toMatchObject({ placed: true, regime: 'Knowable', rulesFired: [ruleIri('R3a')] });
      if (r.placed) expect(r.notes.join(' ')).toMatch(/Evident needs a checkable output and fast feedback/);
    }
    // Feedback in days is still fast enough for Evident.
    expect(classifyTask(answers({ feedbackLatency: 'days', checkability: 'after-effect' }), policy)).toMatchObject({ regime: 'Evident' });
    const uncheckable = classifyTask(answers({ checkability: 'not-checkable' }), policy);
    if (uncheckable.placed) expect(uncheckable.notes.join(' ')).toMatch(/agent-acts-person-audits, agent-acts-within-grant are unavailable/);
    const critical = classifyTask(answers({ worstCase: 'critical' }), policy);
    if (critical.placed) expect(critical.notes.join(' ')).toMatch(/300 clean person-reviewed runs/);
  });

  it('places nothing when the answers are unknown, and never defaults a regime', () => {
    const unknown = coerceAnswers({ sameStepsSameResult: 'unknown', methodKnown: 'unknown', outcomeDependsOnOthers: 'unknown', situationStable: 'unknown', checkability: 'unknown', feedbackLatency: 'unknown', worstCase: 'unknown' });
    const r = classifyTask(must(unknown), policy);
    expect(r).toEqual({ placed: false, rulesFired: [ruleIri('R0')], why: expect.stringMatching(/do not place this task in a regime/) });
    expect('regime' in r).toBe(false);
    // Known method but unknown stability: still not placed.
    expect(classifyTask(answers({ sameStepsSameResult: 'usually', situationStable: 'unknown' }), policy)).toMatchObject({ placed: false });
    expect(coerceAnswers({ ...answers(), worstCase: undefined })).toBeNull();
    expect(coerceAnswers({ ...answers(), checkability: 'mostly' })).toBeNull();
    expect(coerceAnswers('Evident')).toBeNull();
    expect(coerceAnswers({ ...answers(), regime: 'Evident' })).toEqual(answers());
  });
});

// ── Parties and allocation ────────────────────────────────────────────────────────────────

const registered = { isRegisteredPerson: (a: string) => a === PERSON || a === PERSON2, isRegisteredAgent: (a: string) => a === AGENT_ADDR };
const task = (o: Partial<TaskForAllocation> = {}): TaskForAllocation => ({
  taskIri: T1, taskKind: 'invoice-matching', current: { level: 'person', personAddress: PERSON },
  descriptionStatus: 'ratified', regime: 'Evident', answers: answers(), classificationStatus: 'ratified', classificationCurrent: true, ...o,
});
const noGrant = (): GrantState => ({ active: false, why: 'no grant' });
const ctxWith = (grantFor: (a: string, k: string) => GrantState = noGrant, pol: EffectivePolicy = effective) => ({ policy: pol, ...registered, grantFor });
const probes = (n: number, timeboxWeeks = 4) => Array.from({ length: n }, (_, i) => ({ hypothesis: `Drafts cut time on dispute ${i}`, amplifyIf: 'cycle time falls a week', dampenIf: 'a supplier complains', timeboxWeeks }));

describe('parties and allocation', () => {
  it('requires a person at person levels, both parties at agent-drafts and agent-acts-audits, and refuses an agent at level person', () => {
    const at = { ...registered, atCapture: true };
    expect(checkParties({ level: 'person', personAddress: PERSON }, at)).toEqual({ ok: true });
    expect(checkParties({ level: 'person' }, at)).toMatchObject({ ok: false, status: 400 });
    expect(checkParties({ level: 'person', personAddress: PERSON, agentAddress: AGENT_ADDR }, at)).toMatchObject({ ok: false, why: 'level person names an agent' });
    expect(checkParties({ level: 'person-with-agent-assist', personAddress: PERSON, agentAddress: AGENT_ADDR }, at)).toEqual({ ok: true });
    expect(checkParties({ level: 'agent-drafts-person-decides', agentAddress: AGENT_ADDR }, at)).toMatchObject({ ok: false, error: expect.stringMatching(/registered person/) });
    expect(checkParties({ level: 'agent-acts-person-audits', personAddress: PERSON }, at)).toMatchObject({ ok: false, error: 'Agent levels need a registered software agent.' });
    // A person cannot stand in for the agent, nor an unregistered key for the person.
    expect(checkParties({ level: 'agent-drafts-person-decides', personAddress: PERSON, agentAddress: PERSON2 }, at)).toMatchObject({ ok: false, why: `${PERSON2} is not a registered software agent` });
    expect(checkParties({ level: 'person', personAddress: '0x000000000000000000000000000000000000dead' }, at)).toMatchObject({ ok: false });
    expect(checkParties({ level: 'person', personAddress: 'ana' }, at)).toMatchObject({ ok: false, why: 'personAddress is neither a 0x address nor an Interego user DID' });
    // A person may be an Interego user DID (relay-attested), kept as spelled; an agent is always a key's address.
    const did = 'did:web:identity.interego.xwisee.com:users:u-pk-0A1b2C3d4E5f';
    const dids = { ...at, isRegisteredPerson: (a: string) => a === PERSON || a === did };
    expect(checkParties({ level: 'person', personAddress: did }, dids)).toEqual({ ok: true });
    expect(checkParties({ level: 'person', personAddress: did.toLowerCase() }, dids)).toMatchObject({ ok: false, why: `${did.toLowerCase()} is not a registered person` });
    expect(checkParties({ level: 'agent-drafts-person-decides', personAddress: PERSON, agentAddress: did }, dids)).toMatchObject({ ok: false, why: 'agentAddress is not a 0x address' });
    expect(performerOf({ level: 'person', personAddress: did })).toBe(did);
    expect(namedPartiesOf({ level: 'person-with-agent-assist', personAddress: did, agentAddress: AGENT.address })).toEqual([did, AGENT_ADDR]);
    expect(coerceChange({ taskIri: T1, proposedLevel: 'person', personAddress: did })).toMatchObject({ personAddress: did });
    expect(coerceChange({ taskIri: T1, proposedLevel: 'person', agentAddress: did })).toBeNull();
    // Within-grant: never at capture; agent only.
    expect(checkParties({ level: 'agent-acts-within-grant', agentAddress: AGENT_ADDR }, at)).toMatchObject({ ok: false, error: 'A within-grant allocation can only come from a decision.' });
    expect(checkParties({ level: 'agent-acts-within-grant', agentAddress: AGENT_ADDR }, { ...at, atCapture: false })).toEqual({ ok: true });
    expect(checkParties({ level: 'agent-acts-within-grant', agentAddress: AGENT_ADDR, personAddress: PERSON }, { ...at, atCapture: false })).toMatchObject({ ok: false });
    expect(namedPartiesOf({ level: 'agent-drafts-person-decides', agentAddress: AGENT.address, personAddress: ANA.address })).toEqual([PERSON, AGENT_ADDR]);
  });

  it('refuses any change to Turbulent work, any Emergent change without 1..5 valid probes, probes on other work, and a mixed plan', () => {
    const turbulent = task({ regime: 'Turbulent', answers: answers({ situationStable: 'unstable' }) });
    expect(checkAllocation({ taskIri: T1, proposedLevel: 'person-with-agent-assist' }, turbulent, ctxWith()))
      .toMatchObject({ ok: false, status: 409, error: 'Turbulent work: act to stabilise first; no allocation change.' });
    const emergent = task({ regime: 'Emergent' });
    const change = (p?: ReturnType<typeof probes>): AllocationChange => ({ taskIri: T1, proposedLevel: 'person-with-agent-assist', ...(p ? { probes: p } : {}) });
    expect(checkAllocation(change(), emergent, ctxWith())).toMatchObject({ ok: false, status: 400, why: 'no probes were given' });
    expect(checkAllocation(change(probes(6)), emergent, ctxWith())).toMatchObject({ ok: false, status: 400, why: '6 probes; at most 5' });
    expect(checkAllocation(change(probes(1, 27)), emergent, ctxWith())).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/timeboxWeeks/) });
    expect(checkAllocation(change([{ hypothesis: 'x', amplifyIf: '', dampenIf: 'y', timeboxWeeks: 2 }]), emergent, ctxWith())).toMatchObject({ ok: false, why: expect.stringMatching(/amplifyIf/) });
    expect(checkAllocation(change(probes(5)), emergent, ctxWith())).toMatchObject({ ok: true, changed: true });
    // Emergent work keeps its permitted levels: no agent acting on it.
    expect(checkAllocation({ taskIri: T1, proposedLevel: 'agent-acts-person-audits', agentAddress: AGENT_ADDR, probes: probes(1) }, emergent, ctxWith())).toMatchObject({ ok: false, status: 409 });
    expect(checkAllocation(change(probes(1)), task(), ctxWith())).toMatchObject({ ok: false, status: 400, error: "Probes are for Emergent work; this task's regime is Evident." });
    const regimeOf = (iri: string): Regime | null => (iri === T1 ? 'Emergent' : 'Evident');
    expect(planKindOf([{ taskIri: T1, proposedLevel: 'person' }], regimeOf)).toBe('probe');
    expect(planKindOf([{ taskIri: T2, proposedLevel: 'person' }], regimeOf)).toBe('valued');
    expect(planKindOf([{ taskIri: T1, proposedLevel: 'person' }, { taskIri: T2, proposedLevel: 'person' }], regimeOf)).toBe('mixed');
    expect(coerceChange({ taskIri: T1, proposedLevel: 'person', probes: [{ hypothesis: 1 }] })).toBeNull();
    expect(coerceChange({ taskIri: T1, proposedLevel: 'robot' })).toBeNull();
    expect(coerceChange({ taskIri: T1, proposedLevel: 'person', personAddress: ANA.address })).toEqual({ taskIri: T1, proposedLevel: 'person', personAddress: PERSON });
  });

  it('blocks changes on a disputed description, a disputed classification, or a classification older than the description', () => {
    const toAssist: AllocationChange = { taskIri: T1, proposedLevel: 'person-with-agent-assist' };
    expect(checkAllocation(toAssist, task({ regime: null, answers: null, classificationStatus: null }), ctxWith()))
      .toMatchObject({ ok: false, status: 409, error: 'Classify every task before proposing an allocation.', resolvedBy: 'wrd.classify_task' });
    expect(checkAllocation(toAssist, task({ descriptionStatus: 'disputed' }), ctxWith())).toMatchObject({ ok: false, status: 409, resolvedBy: 'wrd.revise_task' });
    expect(checkAllocation(toAssist, task({ classificationCurrent: false }), ctxWith())).toMatchObject({ ok: false, status: 409, resolvedBy: 'wrd.classify_task', error: expect.stringMatching(/revised after it was classified/) });
    expect(checkAllocation(toAssist, task({ classificationStatus: 'disputed' }), ctxWith())).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/disputes its classification/) });
    // Leaving a disputed task as it is, is not a change and is fine.
    expect(checkAllocation({ taskIri: T1, proposedLevel: 'person' }, task({ descriptionStatus: 'disputed' }), ctxWith())).toEqual({ ok: true, changed: false, proposed: { level: 'person', personAddress: PERSON } });
    // The current person carries over when the new level needs one.
    expect(checkAllocation(toAssist, task(), ctxWith())).toEqual({ ok: true, changed: true, proposed: { level: 'person-with-agent-assist', personAddress: PERSON } });
  });

  it('requires an active grant, a checkable output, and for critical work 300 clean runs at a 0.01 ceiling', () => {
    const within: AllocationChange = { taskIri: T1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT_ADDR };
    expect(checkAllocation(within, task(), ctxWith())).toMatchObject({ ok: false, status: 409, error: 'No active grant for this agent on this kind of task: no grant', resolvedBy: 'wrd.grant_autonomy' });
    const asked: string[] = [];
    const active = (runsCounted: number, criticalFailures = 0) => (a: string, k: string): GrantState => {
      asked.push(`${a}|${k}`);
      return { active: true, grantIri: 'urn:wrd:grant:x:y', evidenceTaskIris: [T1], runsCounted, criticalFailures };
    };
    expect(checkAllocation(within, task(), ctxWith(active(24)))).toEqual({ ok: true, changed: true, proposed: { level: 'agent-acts-within-grant', agentAddress: AGENT_ADDR } });
    expect(asked).toEqual([`${AGENT_ADDR}|invoice-matching`]);
    // People never qualify: the party rule refuses before any grant is looked up.
    expect(checkAllocation({ ...within, agentAddress: PERSON }, task(), ctxWith(active(500)))).toMatchObject({ ok: false, status: 400 });
    // Knowable work never reaches within-grant, grant or not.
    expect(checkAllocation(within, task({ regime: 'Knowable' }), ctxWith(active(500)))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/^Knowable work permits only: person, person-with-agent-assist, agent-drafts-person-decides, agent-acts-person-audits\.$/) });
    // An acting agent needs a checkable output.
    const audits: AllocationChange = { taskIri: T1, proposedLevel: 'agent-acts-person-audits', agentAddress: AGENT_ADDR };
    expect(checkAllocation(audits, task({ regime: 'Knowable', answers: answers({ checkability: 'not-checkable' }) }), ctxWith())).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/cannot be checked/) });
    expect(checkAllocation(audits, task({ regime: 'Knowable', answers: answers({ checkability: 'after-effect' }) }), ctxWith())).toMatchObject({ ok: true });
    // Critical work: checkable before effect, and ceil(3 / 0.01) = 300 clean runs.
    expect(runsForRuleOfThree(0.01)).toBe(300);
    const critical = task({ answers: answers({ worstCase: 'critical' }) });
    expect(checkAllocation(within, task({ answers: answers({ worstCase: 'critical', checkability: 'after-effect' }) }), ctxWith(active(500)))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/checked before it takes effect/) });
    expect(checkAllocation(within, critical, ctxWith(active(24)))).toMatchObject({ ok: false, status: 409, error: 'Critical work under a grant needs 300 clean person-reviewed runs; this grant rests on 24.', why: expect.stringMatching(/about 13%/) });
    expect(checkAllocation(within, critical, ctxWith(active(300, 1)))).toMatchObject({ ok: false, status: 409 });
    expect(checkAllocation(within, critical, ctxWith(active(300)))).toMatchObject({ ok: true, changed: true });
    // A pod policy that caps the level names the cap.
    const capped = effectivePolicy(policy, { maxLevel: 'agent-acts-person-audits' }, null);
    expect(checkAllocation(within, task(), ctxWith(active(500), capped))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/This pod's policy caps the level at agent-acts-person-audits\./) });
  });

  it('puts an agent on work only once everyone named has ratified its classification; silence is not assent', () => {
    const drafts: AllocationChange = { taskIri: T1, proposedLevel: 'agent-drafts-person-decides', agentAddress: AGENT_ADDR };
    expect(checkAllocation(drafts, task({ classificationStatus: 'classified' }), ctxWith()))
      .toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/ratified how knowable it is; their silence is not assent/), resolvedBy: 'wrd.ratify_task' });
    expect(checkAllocation(drafts, task(), ctxWith())).toMatchObject({ ok: true, changed: true });
    // A change that names no agent does not need it.
    expect(checkAllocation({ taskIri: T1, proposedLevel: 'person-with-agent-assist' }, task({ classificationStatus: 'classified' }), ctxWith())).toMatchObject({ ok: true });
    // ...but an assisting agent is an agent on the work.
    expect(checkAllocation({ taskIri: T1, proposedLevel: 'person-with-agent-assist', agentAddress: AGENT_ADDR }, task({ classificationStatus: 'classified' }), ctxWith())).toMatchObject({ ok: false, status: 409 });
  });

  it('checks a run under a grant against the task as it stands: regime, checkability, worst case, ratification and the grant', () => {
    const grant = (): GrantState => ({ active: true, grantIri: 'urn:wrd:grant:x:y', evidenceTaskIris: [T1], runsCounted: 24, criticalFailures: 0 });
    const ctx = ctxWith(grant);
    const inForce = { level: 'agent-acts-within-grant' as const, agentAddress: AGENT_ADDR };
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce }), ctx)).toEqual({ ok: true, changed: true, proposed: inForce });
    // The review's reproduction: the grant is held on the kind of task, but THIS task is Turbulent, not checkable and critical.
    const turbulent = task({ current: inForce, regime: 'Turbulent', answers: answers({ situationStable: 'unstable', checkability: 'not-checkable', worstCase: 'critical' }) });
    expect(checkActingUnderGrant(AGENT_ADDR, turbulent, ctx)).toMatchObject({ ok: false, status: 409, error: 'Turbulent work: act to stabilise first; no allocation change.' });
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce, regime: 'Knowable' }), ctx)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/^Knowable work permits only/) });
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce, answers: answers({ worstCase: 'critical' }) }), ctx)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/needs 300 clean person-reviewed runs; this grant rests on 24/) });
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce, classificationStatus: 'disputed' }), ctx)).toMatchObject({ ok: false, status: 409 });
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce, descriptionStatus: 'disputed' }), ctx)).toMatchObject({ ok: false, status: 409, resolvedBy: 'wrd.revise_task' });
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce, classificationCurrent: false }), ctx)).toMatchObject({ ok: false, status: 409 });
    expect(checkActingUnderGrant(AGENT_ADDR, task({ current: inForce }), ctxWith())).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/No active grant/) });
    // A suspended allocation (its grant inactive) is not "no change": proposing it again must pass every rule.
    const again: AllocationChange = { taskIri: T1, proposedLevel: 'agent-acts-within-grant', agentAddress: AGENT_ADDR };
    expect(checkAllocation(again, task({ current: inForce }), ctxWith())).toMatchObject({ ok: true, changed: false });
    expect(checkAllocation(again, task({ current: inForce, currentSuspended: true }), ctxWith())).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/No active grant/) });
  });

  it('flags a captured agent level the classification would not allow, as a reported current state', () => {
    const audits = { level: 'agent-acts-person-audits' as const, personAddress: PERSON, agentAddress: AGENT_ADDR };
    expect(currentAllocationNote(audits, 'Knowable', answers({ checkability: 'not-checkable' }), effective)).toMatch(/checkability is not-checkable; that is a reported current state, not an approved one/);
    expect(currentAllocationNote(audits, 'Emergent', answers(), effective)).toMatch(/Emergent work does not permit/);
    expect(currentAllocationNote(audits, 'Evident', answers(), effective)).toBeNull();
    expect(currentAllocationNote({ level: 'person', personAddress: PERSON }, 'Turbulent', answers(), effective)).toBeNull();
    // Put in force by a decision, it is not called a reported state: the classification no longer allows what was approved.
    const decided = currentAllocationNote(audits, 'Emergent', answers(), effective, 'decision');
    expect(decided).toMatch(/^As a decision put it in force, this task is done at agent-acts-person-audits, which Emergent work does not permit; the task's classification no longer allows what that decision approved\. Propose a change\.$/);
    expect(decided).not.toMatch(/As captured|reported current state/);
  });
});

// ── Quotes and capture ────────────────────────────────────────────────────────────────────

const SOP = 'Accounts payable SOP.\n\nStep 1:  Match each invoice to its\tpurchase order and goods receipt.\nThe clerk’s check is “three-way”. Résumé duplicates are escalated. Match each invoice to its purchase order again.';

describe('quotes', () => {
  it('normalises NFC, curly quotes and whitespace, stays case-sensitive, and returns offsets into the normalised document', () => {
    expect(normaliseForQuote('  a \n\tb  ')).toBe('a b');
    expect(normaliseForQuote('‘x’ “y” „z‟')).toBe('\'x\' "y" "z"');
    expect(normaliseForQuote('Résumé')).toBe('Résumé');
    const doc = normaliseForQuote(SOP);
    const quotes = ['Match each invoice to its purchase order', "The clerk's check is \"three-way\"", 'Résumé duplicates are escalated'];
    for (const q of quotes) {
      const v = verifyQuote(doc, q);
      expect(v.status, q).toBe('verified');
      expect(doc.slice(must(v.start), must(v.end))).toBe(normaliseForQuote(q));
      expect(v.quote).toBe(q);
    }
    expect(verifyQuote(doc, 'Match each invoice to its purchase order').occurrences).toBe(2);
    expect(verifyQuote(doc, 'match each invoice to its purchase order')).toMatchObject({ status: 'unverified', why: 'not found in the document' });
  });

  it('marks a fabricated or sub-12-character quote unverified and never repairs it', () => {
    const doc = normaliseForQuote(SOP);
    const fabricated = 'Invoices under $500 are auto-approved without matching';
    expect(verifyQuote(doc, fabricated)).toEqual({ quote: fabricated, status: 'unverified', start: null, end: null, occurrences: 0, why: 'not found in the document' });
    // A near-miss (one word changed) is not "close enough".
    expect(verifyQuote(doc, 'Match every invoice to its purchase order').status).toBe('unverified');
    expect(verifyQuote(doc, 'Step 1:')).toMatchObject({ status: 'unverified', why: `shorter than ${MIN_QUOTE_CHARS} characters` });
    expect(verifyQuote(doc, 'Accounts pay').status).toBe('verified');
    const result = verifyTaskQuotes(SOP, [{ sourceQuotes: ['Match each invoice to its purchase order', fabricated] }, { sourceQuotes: ['Duplicates'] }]);
    expect(result).toMatchObject({ verified: 1, unverified: 2 });
    expect(quoteStatusOf(must(result.perTask[0]))).toBe('partly-verified');
    expect(quoteStatusOf(must(result.perTask[1]))).toBe('unverified');
    expect(quoteStatusOf([])).toBe('none');
  });

  it('coerces a document capture, requires draftedBy and quotes, and keeps manual capture free of document fields', () => {
    const t = { name: 'Match invoices', description: 'Three-way match', currentLevel: 'person', personAddress: ANA.address, taskKind: 'invoice-matching', sourceQuotes: ['Match each invoice to its purchase order'] };
    const docPayload = { workflow: { title: 'Supplier invoices', unitLabel: 'invoice' }, tasks: [t], document: { title: 'AP SOP', sha256: sha256Hex(SOP), storeText: false }, draftedBy: { kind: 'agent', agent: 'my agent', model: 'm-1' } };
    const ok = coerceCapture(docPayload, 'document');
    expect(ok).toMatchObject({ ok: true, value: { tasks: [{ current: { level: 'person', personAddress: PERSON }, sourceQuotes: t.sourceQuotes }], draftedBy: { kind: 'agent' } } });
    expect(coerceCapture({ ...docPayload, draftedBy: undefined }, 'document')).toMatchObject({ ok: false, why: expect.stringMatching(/draftedBy is required/) });
    expect(coerceCapture({ ...docPayload, tasks: [{ ...t, sourceQuotes: undefined }] }, 'document')).toMatchObject({ ok: false, why: expect.stringMatching(/sourceQuotes is required/) });
    expect(coerceCapture({ ...docPayload, document: { ...docPayload.document, sha256: 'ABC' } }, 'document')).toMatchObject({ ok: false });
    expect(coerceCapture({ ...docPayload, tasks: [t, t] }, 'document')).toMatchObject({ ok: false, why: expect.stringMatching(/two tasks are named/) });
    expect(coerceCapture({ workflow: docPayload.workflow, tasks: [t] }, 'manual')).toMatchObject({ ok: false, why: expect.stringMatching(/need a document/) });
    expect(coerceCapture({ workflow: docPayload.workflow, tasks: [{ ...t, sourceQuotes: undefined, taskKind: 'Invoice Matching' }] }, 'manual')).toMatchObject({ ok: false, why: expect.stringMatching(/taskKind/) });
    expect(coerceCapture({ workflow: docPayload.workflow, tasks: [{ ...t, sourceQuotes: undefined, externalTaskTerm: 'not an iri' }] }, 'manual')).toMatchObject({ ok: false, why: expect.stringMatching(/externalTaskTerm/) });
    expect(coerceCapture({ workflow: docPayload.workflow, tasks: [] }, 'manual')).toMatchObject({ ok: false });

    const packet = buildTaskMapPacket({ documentTitle: 'AP SOP', documentText: SOP });
    expect(packet).toMatchObject({ execution: 'client-required', status: 'instructions-only', sampling_performed: false, writes_performed: false, request: { documentSha256: sha256Hex(SOP), documentChars: SOP.length } });
    expect(packet.instructions).toMatch(/sampled no model and wrote nothing/);
    expect(packet.quoteRule.minChars).toBe(12);
    // The template asks only for what the agent can draft; the person who signs adds level, parties and kind. draftedBy is required, or "not-declared".
    expect(packet.draftTemplate.tasks).toEqual([{ name: '', description: '', sourceQuotes: [] }]);
    expect(packet.instructions).toMatch(/The capture refuses a map without draftedBy; "not-declared" is recorded as "not declared"/);
    expect(coerceCapture({ workflow: { title: 'x', unitLabel: 'y' }, tasks: [{ name: 'a', description: 'b', currentLevel: 'person', taskKind: 'invoice-matching', sourceQuotes: ['Match each invoice to its'] }], document: { title: 'd', sha256: sha256Hex(SOP), storeText: false } }, 'document'))
      .toMatchObject({ ok: false, why: expect.stringMatching(/^draftedBy is required/) });
  });

  it('coerces revisions and applies them: a text change without new quotes clears the old ones', () => {
    const head = { descriptorUrl: 'https://192.0.2.20/t/wrd/records/task-1.ttl', graphDigest: `graph-nquads-sha256:${'a'.repeat(64)}` };
    expect(coerceRevision({ op: 'revise', taskIri: T1, ...head, description: 'Adds the accrual step', agentAddress: null })).toMatchObject({ ok: true, value: { op: 'revise', changes: { description: 'Adds the accrual step', agentAddress: null } } });
    expect(coerceRevision({ op: 'revise', taskIri: T1, ...head })).toMatchObject({ ok: false, why: 'a revision changes at least one field' });
    expect(coerceRevision({ op: 'revise', taskIri: T1, descriptorUrl: head.descriptorUrl, graphDigest: 'sha256:x', name: 'n' })).toMatchObject({ ok: false, why: expect.stringMatching(/graphDigest/) });
    expect(coerceRevision({ op: 'retire', taskIri: T1, ...head })).toMatchObject({ ok: false, why: expect.stringMatching(/why is required/) });
    expect(coerceRevision({ op: 'merge', taskIri: T1, ...head })).toMatchObject({ ok: false });
    const before = { name: 'Code the invoice', description: 'GL coding', current: { level: 'person' as const, personAddress: PERSON }, taskKind: 'gl-coding', sourceQuotes: ['Match each invoice to its purchase order'] };
    const r = applyTaskChanges(before, { description: 'GL coding, including accruals for uninvoiced receipts' });
    expect(r).toMatchObject({ textChanged: true, quotesCleared: true });
    expect(r.task.sourceQuotes).toBeUndefined();
    expect(applyTaskChanges(before, { personAddress: PERSON2 })).toMatchObject({ textChanged: false, quotesCleared: false, task: { current: { personAddress: PERSON2 }, sourceQuotes: before.sourceQuotes } });
    expect(taskTextSha256(before.name, before.description)).toBe(sha256Hex(canonicalJson({ name: before.name, description: before.description })));
    expect(taskTextSha256(before.name, before.description)).not.toBe(taskTextSha256(before.name, r.task.description));
  });
});

// ── Valuation ─────────────────────────────────────────────────────────────────────────────

const point = (n: number, basis: Tri['basis'] = 'measured'): Tri => ({ low: n, likely: n, high: n, basis });
const tri = (low: number, likely: number, high: number, basis: Tri['basis'] = 'estimate'): Tri => ({ low, likely, high, basis });
const state = (o: Partial<Record<keyof TaskState, Tri>>): TaskState => ({
  performerHoursPerRun: point(0), oversightHoursPerRun: point(0), agentCostPerRun: point(0),
  minorFailureRate: point(0), minorFailureCost: point(0), criticalFailureRate: point(0), criticalFailureCost: point(0), ...o,
});
/** A proposed state has not run, so its numbers are estimates (a 'measured' one would need a source). */
const est = (n: number): Tri => point(n, 'estimate');
const proposedState = (o: Partial<Record<keyof TaskState, Tri>>): TaskState => ({
  performerHoursPerRun: est(0), oversightHoursPerRun: est(0), agentCostPerRun: est(0),
  minorFailureRate: est(0), minorFailureCost: est(0), criticalFailureRate: est(0), criticalFailureCost: est(0), ...o,
});
/** Worked by hand: 100 invoices a week, value 10 each, 50 an hour. T1 moves from a person (0.2 h) to an agent drafting (0.5 a run) with a person deciding (0.05 h). */
const exactInputs = (o: Partial<ValuationInputs> = {}): ValuationInputs => ({
  currency: 'EUR', unitsPerWeek: { current: point(100) }, valuePerUnit: point(10), hourlyCost: point(50), oneOffCost: point(10_000),
  horizonMonths: 12, rampMonths: 0, annualDiscountRate: 0, criticalFailureCeiling: 0.01,
  freedHours: { [T1]: { disposition: 'absorbed', note: 'cy takes on statement reconciliation' } },
  tasks: {
    [T1]: {
      runsPerUnit: point(1),
      current: state({ performerHoursPerRun: point(0.2), minorFailureRate: point(0.05), minorFailureCost: point(20), criticalFailureRate: point(0.001), criticalFailureCost: point(1000) }),
      proposed: proposedState({ oversightHoursPerRun: est(0.05), agentCostPerRun: est(0.5), minorFailureRate: est(0.04), minorFailureCost: est(20), criticalFailureRate: est(0.001), criticalFailureCost: est(1000) }),
    },
    [T2]: { runsPerUnit: point(1), current: state({ performerHoursPerRun: point(0.1) }) },
  },
  ...o,
});
const planOpts = (o: Partial<Parameters<typeof valuePlan>[1]> = {}): Parameters<typeof valuePlan>[1] => ({
  planIri: 'urn:wrd:plan:00000000000000a1:00000000000000c1', taskOrder: [T1, T2], valuedChanged: new Set([T1]), agentLevelTasks: new Set([T1]),
  taskKindOf: new Map([[T1, 'invoice-matching'], [T2, 'gl-coding']]), reportedAgentCost: new Map(), methodIri: policy.valuationMethodIri, draws: 200, ...o,
});
const flat = (b: { p10: number; p50: number; p90: number }, v: number): void => { expect(b).toEqual({ p10: v, p50: v, p90: v }); };

describe('valuation', () => {
  it('is reproducible: the same plan and inputs give the same seed, bands and hash', () => {
    // xoshiro128** reference vector for state {1, 2, 3, 4}: the generator is exactly the published one.
    const next = prng(`00000001000000020000000300000004${'0'.repeat(32)}`);
    const expected = [11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804];
    expect(expected.map(() => next() * 4294967296)).toEqual(expected);
    expect(() => prng('xyz')).toThrow();

    const inputs = exactInputs({ unitsPerWeek: { current: tri(80, 100, 130) }, valuePerUnit: tri(8, 10, 11) });
    const a = valuePlan(inputs, planOpts({ draws: 1000 }));
    const b = valuePlan(JSON.parse(JSON.stringify(inputs)) as ValuationInputs, planOpts({ draws: 1000 }));
    expect(a.seed).toBe(sha256Hex(canonicalJson({ planIri: planOpts().planIri, inputs })));
    expect(a.seed).toBe(seedFor(planOpts().planIri, inputs));
    expect(sha256Hex(canonicalJson(a))).toBe(sha256Hex(canonicalJson(b)));
    const other = valuePlan(inputs, planOpts({ draws: 1000, planIri: 'urn:wrd:plan:00000000000000a1:00000000000000c2' }));
    expect(other.seed).not.toBe(a.seed);
    expect(other.scenarios.redeployed.weeklyDelta).not.toEqual(a.scenarios.redeployed.weeklyDelta);
    expect(a.draws).toBe(1000);
    expect(a.method).toBe(wrdTerm('valuationMethodV1'));
  });

  it('degenerate ranges reproduce the closed-form NPV, payback month, freed hours and both scenarios', () => {
    // Current week: person 100·0.2·50 = 1000, loss 100·(0.05·20 + 0.001·1000) = 200. Proposed: oversight 100·0.05·50 = 250,
    // agent 100·0.5 = 50, loss 100·(0.04·20 + 1) = 180. Value 1000 both. Redeployed: (1000−180−250−50) − (1000−200−1000) = 720.
    // Freed hours 100·0.2 − 100·0.05 = 15, absorbed, so cash = 720 − 15·50 = −30.
    const r = valuePlan(exactInputs(), planOpts());
    flat(r.scenarios.redeployed.weeklyDelta, 720);
    flat(r.scenarios.cash.weeklyDelta, -30);
    flat(r.freedPersonHours.total, 15);
    expect(r.freedPersonHours.perTask).toEqual([{ taskIri: T1, band: { p10: 15, p50: 15, p90: 15 }, disposition: 'absorbed', note: 'cy takes on statement reconciliation' }]);
    // Monthly 720·52/12 = 3120; 12 months undiscounted minus 10 000 = 27 440; payback in month ceil(10000/3120) = 4.
    flat(r.scenarios.redeployed.npv, 27_440);
    expect(r.scenarios.redeployed.payback).toEqual({ p50Month: 4, probabilityWithinHorizon: 1 });
    expect(r.scenarios.redeployed.probabilityNpvPositive).toBe(1);
    flat(r.scenarios.cash.npv, -30 * 52 - 10_000);
    expect(r.scenarios.cash.payback).toEqual({ p50Month: null, probabilityWithinHorizon: 0 });
    expect(r.scenarios.cash.probabilityNpvPositive).toBe(0);
    // Value-to-cost with every task entered: current (1000−200)/(1000+500) and proposed (1000−180)/(250+50+500).
    expect(r.valueToCost).toEqual({ current: { p10: 0.5333, p50: 0.5333, p90: 0.5333 }, proposed: { p10: 1.025, p50: 1.025, p90: 1.025 }, why: null });

    // npvOf against closed forms: discounting is an annuity, a ramp is a partial sum.
    const i = Math.pow(1.1, 1 / 12) - 1;
    expect(npvOf(720, { horizonMonths: 12, rampMonths: 0, annualDiscountRate: 0.1, oneOffCost: 10_000 }).npv).toBeCloseTo(3120 * (1 - Math.pow(1 + i, -12)) / i - 10_000, 6);
    expect(npvOf(720, { horizonMonths: 12, rampMonths: 3, annualDiscountRate: 0, oneOffCost: 10_000 })).toEqual({ npv: expect.closeTo(3120 * (1 / 3 + 2 / 3 + 1 + 9) - 10_000, 6), paybackMonth: 5 });
    expect(npvOf(-1, { horizonMonths: 6, rampMonths: 0, annualDiscountRate: 0, oneOffCost: 0 }).paybackMonth).toBeNull();
    expect(npvOf(1, { horizonMonths: 6, rampMonths: 0, annualDiscountRate: 0, oneOffCost: 0 }).paybackMonth).toBe(1);
  });

  it('counts freed hours as cash only where the disposition is unfilled', () => {
    for (const disposition of ['absorbed', 'redeployed', 'undecided'] as const) {
      const r = valuePlan(exactInputs({ freedHours: { [T1]: { disposition } } }), planOpts());
      flat(r.scenarios.cash.weeklyDelta, -30);
    }
    const unfilled = valuePlan(exactInputs({ freedHours: { [T1]: { disposition: 'unfilled' } } }), planOpts());
    flat(unfilled.scenarios.cash.weeklyDelta, 720);
    flat(unfilled.scenarios.redeployed.weeklyDelta, 720);
    // Hours a change ADDS always cost, whatever the disposition: 0.3 h proposed against 0.2 h current.
    const base = exactInputs();
    const t1 = must(base.tasks[T1]);
    const adds = valuePlan({ ...base, tasks: { ...base.tasks, [T1]: { ...t1, proposed: state({ ...must(t1.proposed), performerHoursPerRun: point(0.3), oversightHoursPerRun: point(0) }) } } }, planOpts());
    flat(adds.freedPersonHours.total, -10);
    expect(adds.scenarios.cash.weeklyDelta).toEqual(adds.scenarios.redeployed.weeklyDelta);
  });

  it('breakdown at likely values sums to the if-redeployed weekly change, oversight separate', () => {
    const wide = exactInputs({ unitsPerWeek: { current: tri(80, 100, 150) }, hourlyCost: tri(40, 50, 70) });
    const r = valuePlan(wide, planOpts());
    const net = (b: { value: number; loss: number; personCost: number; oversightCost: number; agentCost: number }): number => b.value - b.loss - b.personCost - b.oversightCost - b.agentCost;
    const atLikely = net(r.breakdown.proposed.total) - net(r.breakdown.current.total);
    expect(atLikely).toBeCloseTo(720, 6);
    // The all-likely point valued on its own gives the same number.
    const likelyOnly = valuePlan(exactInputs(), planOpts());
    expect(atLikely).toBeCloseTo(likelyOnly.scenarios.redeployed.weeklyDelta.p50, 6);
    expect(r.breakdown.proposed.total).toMatchObject({ value: 1000, personCost: 500, oversightCost: 250, agentCost: 50, loss: 180 });
    expect(r.breakdown.current.total).toMatchObject({ value: 1000, personCost: 1500, oversightCost: 0, agentCost: 0, loss: 200 });
    expect(r.breakdown.proposed.perTask).toEqual([
      { taskIri: T1, value: 0, loss: 180, personCost: 0, oversightCost: 250, agentCost: 50 },
      { taskIri: T2, value: 0, loss: 0, personCost: 500, oversightCost: 0, agentCost: 0 },
    ]);
  });

  it('orders P10 <= P50 <= P90 and ranks the widest input first in sensitivity with its basis', () => {
    const base = exactInputs();
    const t1 = must(base.tasks[T1]);
    const inputs: ValuationInputs = {
      ...base,
      unitsPerWeek: { current: tri(90, 100, 110, 'measured') }, valuePerUnit: tri(5, 10, 20),
      tasks: { ...base.tasks, [T1]: { ...t1, current: { ...t1.current, performerHoursPerRun: tri(0.1, 0.2, 0.5, 'performer-reported') } } },
    };
    const r = valuePlan(inputs, planOpts({ draws: 2000 }));
    for (const s of [r.scenarios.cash, r.scenarios.redeployed]) {
      expect(s.weeklyDelta.p10).toBeLessThanOrEqual(s.weeklyDelta.p50);
      expect(s.weeklyDelta.p50).toBeLessThanOrEqual(s.weeklyDelta.p90);
      expect(s.npv.p10).toBeLessThanOrEqual(s.npv.p50);
      expect(s.npv.p50).toBeLessThanOrEqual(s.npv.p90);
      expect(s.weeklyDelta.p90 - s.weeklyDelta.p10).toBeGreaterThan(0);
    }
    const top = must(r.scenarios.redeployed.sensitivity[0]);
    // Performer hours 0.1..0.5 move the weekly change by 100·0.4·50 = 2000, i.e. 2000·52 = 104 000 over a year.
    expect(top).toEqual({ input: `tasks[${T1}].current.performerHoursPerRun`, basis: 'performer-reported', npvAtLow: 27_440 - 0.1 * 5000 * 52, npvAtHigh: 27_440 + 0.3 * 5000 * 52, swing: 104_000 });
    // Value per unit cancels when throughput is unchanged: its range moves nothing.
    const value = r.scenarios.redeployed.sensitivity.find((s) => s.input === 'valuePerUnit');
    expect(value?.swing ?? 0).toBe(0);
    expect(r.scenarios.redeployed.sensitivity.length).toBeLessThanOrEqual(8);
    // percentile type 7 by hand.
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.1)).toBe(14);
    expect(percentile([7], 0.9)).toBe(7);
    expect(sampleTriangular({ low: 0, likely: 0, high: 10 }, 0.75)).toBeCloseTo(10 - Math.sqrt(0.25 * 100), 10);
    expect(sampleTriangular({ low: 0, likely: 5, high: 10 }, 0.5)).toBe(5);
    expect(sampleTriangular({ low: 3, likely: 3, high: 3 }, 0.123)).toBe(3);
  });

  it('reports inputs by basis, single-number inputs, estimates among the top three, and unconfirmed agent cost', () => {
    const base = exactInputs();
    const t1 = must(base.tasks[T1]);
    const inputs: ValuationInputs = { ...base, tasks: { ...base.tasks, [T1]: { ...t1, proposed: { ...must(t1.proposed), agentCostPerRun: tri(0.2, 0.5, 3, 'estimate'), oversightHoursPerRun: tri(0.02, 0.05, 0.3, 'estimate') } } } };
    const r = valuePlan(inputs, planOpts());
    // 4 workflow triangles (no proposed throughput) + T1 (runs + 7 current + 7 proposed) + T2 (runs + 7 current) = 27; the 7 proposed are estimates.
    expect(r.inputs.byBasis).toEqual({ measured: 20, document: 0, 'performer-reported': 0, estimate: 7, 'not-applicable': 0 });
    expect(r.inputs.noRange).toHaveLength(25);
    expect(r.inputs.noRange).toContain('valuePerUnit');
    expect(r.inputs.noRange).not.toContain(`tasks[${T1}].proposed.agentCostPerRun`);
    expect(r.inputs.topSensitivityEstimates).toEqual([`tasks[${T1}].proposed.oversightHoursPerRun`, `tasks[${T1}].proposed.agentCostPerRun`]);
    expect(r.inputs.unchangedTasks).toBe('entered');
    expect(r.inputs.unconfirmed).toEqual([{ path: `tasks[${T1}].proposed.agentCostPerRun`, why: 'no person-reviewed run of this kind of task reports a cost yet' }]);
    const reported = valuePlan(inputs, planOpts({ reportedAgentCost: new Map([['invoice-matching', { runs: 12, mean: 0.4123456 }]]) }));
    expect(reported.inputs.unconfirmed).toEqual([]);
    expect(reported.inputs.reportedAgentCost).toEqual([{ taskKind: 'invoice-matching', runs: 12, mean: 0.4123, currency: 'EUR', basis: 'agent-reported on person-reviewed runs' }]);
    // A zero that does not apply is counted apart and is never "no range given".
    const na: Tri = { low: 0, likely: 0, high: 0, basis: 'not-applicable' };
    const withNa = valuePlan({ ...inputs, tasks: { ...inputs.tasks, [T1]: { ...must(inputs.tasks[T1]), current: { ...must(inputs.tasks[T1]).current, oversightHoursPerRun: na, agentCostPerRun: na } } } }, planOpts());
    expect(withNa.inputs.byBasis['not-applicable']).toBe(2);
    expect(withNa.inputs.noRange).toHaveLength(23);
    expect(withNa.inputs.noRange).not.toContain(`tasks[${T1}].current.agentCostPerRun`);
    expect(r.assumptions.join(' ')).toMatch(/count only for tasks whose disposition is 'unfilled'/);
  });

  it('needs unchanged-task inputs only when throughput changes, and then gives a null ratio with a why when they are missing', () => {
    const plan = { taskIris: [T1, T2], valuedChanged: new Set([T1]) };
    const base = exactInputs();
    const withoutT2 = { ...base, tasks: { [T1]: must(base.tasks[T1]) } };
    const ok = coerceValuationInputs(JSON.parse(JSON.stringify(withoutT2)), plan);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      const r = valuePlan(ok.inputs, planOpts());
      expect(r.inputs.unchangedTasks).toBe('not entered: unchanged tasks cancel when throughput is unchanged');
      expect(r.valueToCost).toEqual({ current: null, proposed: null, why: "unchanged tasks were not entered; the ratio needs every task's cost" });
      flat(r.scenarios.redeployed.weeklyDelta, 720); // T2 cancels
    }
    const throughput = { ...withoutT2, unitsPerWeek: { current: point(100), proposed: point(120) } };
    expect(coerceValuationInputs(JSON.parse(JSON.stringify(throughput)), plan)).toEqual({ ok: false, why: `inputs.tasks[${T2}] is required: throughput changes, so unchanged tasks no longer cancel` });
    // With T2 entered and throughput up 20%, value rises 200 and T2's person cost 100: the delta moves accordingly.
    const both = coerceValuationInputs(JSON.parse(JSON.stringify({ ...base, unitsPerWeek: { current: point(100), proposed: point(120) } })), plan);
    expect(both.ok).toBe(true);
    if (both.ok) {
      // proposed at 120: value 1200, loss 216, oversight 300, agent 60, T2 600 → net 24; current net −700 + T2… computed in full:
      const netC = 1000 - 200 - 1000 - 500;
      const netP = 1200 - 216 - 300 - 60 - 600;
      flat(valuePlan(both.inputs, planOpts()).scenarios.redeployed.weeklyDelta, netP - netC);
    }
  });

  it('sizes a pilot by the rule of three (ceiling 0.01 -> 300 runs) and flags a likely rate above the ceiling', () => {
    expect([0.01, 0.03, 0.1, 0.15, 0.05].map(runsForRuleOfThree)).toEqual([300, 100, 30, 20, 60]);
    expect(() => runsForRuleOfThree(0)).toThrow();
    expect(() => runsForRuleOfThree(1)).toThrow();
    const r = valuePlan(exactInputs(), planOpts());
    expect(r.pilot).toEqual([{ taskIri: T1, ceiling: 0.01, confidence: 0.95, runsNeeded: 300, weeksAtLikelyThroughput: 3, likelyRateExceedsCeiling: false }]);
    const base = exactInputs();
    const t1 = must(base.tasks[T1]);
    const risky = valuePlan({ ...base, tasks: { ...base.tasks, [T1]: { ...t1, proposed: { ...must(t1.proposed), criticalFailureRate: tri(0.005, 0.02, 0.04) } } } }, planOpts());
    expect(must(risky.pilot[0]).likelyRateExceedsCeiling).toBe(true);
    // No agent level, no pilot.
    expect(valuePlan(exactInputs(), planOpts({ agentLevelTasks: new Set() })).pilot).toEqual([]);
  });

  it('rejects low > likely, a missing basis, rates outside [0,1], and proposed inputs on an unchanged task', () => {
    const plan = { taskIris: [T1, T2], valuedChanged: new Set([T1]) };
    const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(exactInputs())) as Record<string, unknown>;
    const DROP = Symbol('drop');
    /** A copy of the valid inputs with one value at `path` replaced (or dropped). */
    const set = (path: readonly string[], value: unknown): unknown => {
      const o = raw();
      const parent = path.slice(0, -1).reduce<Record<string, unknown>>((acc, k) => acc[k] as Record<string, unknown>, o);
      const key = must(path[path.length - 1]);
      if (value === DROP) delete parent[key]; else parent[key] = value;
      return o;
    };
    expect(coerceValuationInputs(raw(), plan)).toMatchObject({ ok: true });
    const t2 = (raw()['tasks'] as Record<string, unknown>)[T2];
    const t1Proposed = ((raw()['tasks'] as Record<string, Record<string, unknown>>)[T1] ?? {})['proposed'];
    expect(coerceValuationInputs(set(['valuePerUnit'], { low: 12, likely: 10, high: 14, basis: 'estimate' }), plan)).toEqual({ ok: false, why: 'inputs.valuePerUnit: low <= likely <= high is required' });
    expect(coerceValuationInputs(set(['hourlyCost', 'basis'], DROP), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/hourlyCost\.basis/) });
    expect(coerceValuationInputs(set(['hourlyCost', 'basis'], 'gut feeling'), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/hourlyCost\.basis must be one of measured, document, performer-reported, estimate/) });
    expect(coerceValuationInputs(set(['tasks', T1, 'proposed', 'criticalFailureRate'], { low: 0, likely: 0.5, high: 1.5, basis: 'estimate' }), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/rate and must lie within \[0, 1\]/) });
    expect(coerceValuationInputs(set(['tasks', T2, 'proposed'], t1Proposed), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/does not change, so it has no proposed state/) });
    expect(coerceValuationInputs(set(['tasks', T1, 'proposed'], DROP), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/proposed is required/) });
    expect(coerceValuationInputs(set(['freedHours'], {}), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/freedHours/) });
    expect(coerceValuationInputs(set(['oneOffCost'], { low: -5, likely: 0, high: 0, basis: 'estimate' }), plan)).toMatchObject({ ok: false, why: 'inputs.oneOffCost cannot be negative' });
    expect(coerceValuationInputs(set(['valuePerUnit', 'likely'], Number.NaN), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/finite numbers/) });
    expect(coerceValuationInputs(set(['currency'], 'eur'), plan)).toMatchObject({ ok: false });
    expect(coerceValuationInputs(set(['horizonMonths'], 0), plan)).toMatchObject({ ok: false });
    expect(coerceValuationInputs(set(['tasks', 'urn:wrd:task:x:y'], t2), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/not in the plan/) });
    expect(coerceValuationInputs(set(['discountRate'], 0.1), plan)).toMatchObject({ ok: false, why: 'inputs.discountRate is not a valuation input' });
    expect(coerceValuationInputs(set(['valuePerUnit', 'source'], 'see spreadsheet'), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/source must be an absolute IRI/) });
    expect(coerceValuationInputs(set(['valuePerUnit', 'source'], 'https://192.0.2.20/t/wrd/records/run-costs.ttl'), plan)).toMatchObject({ ok: true });
    // Magnitudes are capped so that every product stays finite.
    expect(coerceValuationInputs(set(['unitsPerWeek', 'current'], { low: 1e200, likely: 1e200, high: 1e200, basis: 'estimate' }), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/values above 1000000000000 are refused/) });
    expect(coerceValuationInputs(set(['unitsPerWeek', 'current'], { low: MAX_INPUT, likely: MAX_INPUT, high: MAX_INPUT, basis: 'estimate' }), plan)).toMatchObject({ ok: true });
    // not-applicable: 0/0/0 inside a task state only.
    const na = { low: 0, likely: 0, high: 0, basis: 'not-applicable' };
    expect(coerceValuationInputs(set(['tasks', T1, 'current', 'agentCostPerRun'], na), plan)).toMatchObject({ ok: true });
    expect(coerceValuationInputs(set(['tasks', T1, 'current', 'agentCostPerRun'], { ...na, high: 1 }), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/not-applicable means 0, 0, 0/) });
    expect(coerceValuationInputs(set(['valuePerUnit'], na), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/only for a task state's own fields/) });
    // A proposed state has not run: 'measured' there needs a source.
    const measuredNoSource = { low: 0.4, likely: 0.5, high: 0.6, basis: 'measured' };
    expect(coerceValuationInputs(set(['tasks', T1, 'proposed', 'agentCostPerRun'], measuredNoSource), plan)).toMatchObject({ ok: false, why: expect.stringMatching(/proposed state has not run yet, so basis measured needs a source/) });
    expect(coerceValuationInputs(set(['tasks', T1, 'proposed', 'agentCostPerRun'], { ...measuredNoSource, source: 'https://192.0.2.20/t/wrd/records/pilot.ttl' }), plan)).toMatchObject({ ok: true });
    expect(coerceValuationInputs(set(['tasks', T1, 'current', 'agentCostPerRun'], measuredNoSource), plan)).toMatchObject({ ok: true });
    // Where a person decides on or audits the agent's work, their time must be costed.
    const overseen = { ...plan, personOversees: new Set([T1]) };
    expect(coerceValuationInputs(raw(), overseen)).toMatchObject({ ok: true });
    expect(coerceValuationInputs(set(['tasks', T1, 'proposed', 'oversightHoursPerRun'], { low: 0, likely: 0, high: 0, basis: 'estimate' }), overseen))
      .toMatchObject({ ok: false, why: expect.stringMatching(/oversightHoursPerRun is 0: a person decides on or audits the agent's work/) });
  });

  it('refuses a result that is not finite, wherever it sits', () => {
    // The review's reproduction (1e200 × 1e200) is now refused at the input; the result is still walked in full.
    expect(nonFiniteIn(valuePlan(exactInputs(), planOpts()))).toBeNull();
    const big = valuePlan(exactInputs({ unitsPerWeek: { current: point(MAX_INPUT) }, valuePerUnit: point(MAX_INPUT) }), planOpts());
    expect(nonFiniteIn(big)).toBeNull();
    expect(nonFiniteIn({ a: [1, { b: Number.POSITIVE_INFINITY }] })).toBe('result.a[1].b');
    expect(nonFiniteIn({ scenarios: { cash: { weeklyDelta: { p10: Number.NaN } } } })).toBe('result.scenarios.cash.weeklyDelta.p10');
    expect(nonFiniteIn({ seed: 'abc', n: 0 })).toBeNull();
  });
});

// ── Outcome grading ───────────────────────────────────────────────────────────────────────

const plusMonths = (iso: string, months: number): string => new Date(Date.parse(iso) + months * MONTH_DAYS * 86_400_000).toISOString();

describe('outcome grading', () => {
  it('grades a measurement taken during a 6-month ramp against the ramp-scaled band: in-band, where the unscaled band says below', () => {
    const countersignedAt = '2026-01-05T09:00:00.000Z';
    const windowEnd = plusMonths(countersignedAt, 2);
    expect(monthsBetween(countersignedAt, windowEnd)).toBeCloseTo(2, 9);
    // Mean of t/6 over [0, 2] = (2²/12)/2 = 1/6.
    expect(meanRampFactor(0, 2, 6)).toBeCloseTo(1 / 6, 12);
    expect(meanRampFactor(0, 4, 2)).toBeCloseTo(0.75, 12);
    expect(meanRampFactor(3, 5, 2)).toBe(1);
    expect(meanRampFactor(0, 1, 0)).toBe(1);
    const band = { p10: 1000, p50: 1500, p90: 2000 };
    const g = gradeOutcome({ band, rampMonths: 6, countersignedAt, windowStart: countersignedAt, windowEnd, measured: 250 });
    expect(g).toEqual({ verdict: 'in-band', adjustedBand: { p10: 166.67, p50: 250, p90: 333.33 }, rampFactor: 0.166667, rampAdjusted: true });
    expect(gradeOutcome({ band, rampMonths: 0, countersignedAt, windowStart: countersignedAt, windowEnd, measured: 250 })).toMatchObject({ verdict: 'below-band', rampFactor: 1, rampAdjusted: false });
    expect(gradeOutcome({ band, rampMonths: 6, countersignedAt, windowStart: countersignedAt, windowEnd, measured: 400 }).verdict).toBe('above-band');
  });

  it('is inconclusive when the measured interval straddles a band edge', () => {
    const at = '2026-01-05T09:00:00.000Z';
    const g = (low: number, high: number, measured: number) => gradeOutcome({ band: { p10: 100, p50: 150, p90: 200 }, rampMonths: 0, countersignedAt: at, windowStart: at, windowEnd: plusMonths(at, 2), measured, interval: { low, high } }).verdict;
    expect(g(180, 220, 200)).toBe('inconclusive');
    expect(g(80, 120, 100)).toBe('inconclusive');
    expect(g(120, 180, 150)).toBe('in-band');
    expect(g(210, 260, 230)).toBe('above-band');
    expect(g(10, 90, 50)).toBe('below-band');
    // Wider than the whole band: says nothing.
    expect(g(50, 250, 150)).toBe('inconclusive');
  });

  it('refuses a window that starts before countersign or has not ended', () => {
    const countersignedAt = '2026-03-01T09:00:00.000Z';
    const now = new Date('2026-05-15T09:00:00.000Z');
    expect(checkOutcomeWindow({ countersignedAt, windowStart: '2026-02-20T00:00:00Z', windowEnd: '2026-04-20T00:00:00Z', now })).toEqual({
      status: 409, why: 'The measurement window starts before the decision was countersigned.',
      detail: 'the window starts 2026-02-20T00:00:00Z; the decision was countersigned 2026-03-01T09:00:00.000Z',
    });
    // The refusal says when the window ends and what time the server read, not the headline again.
    expect(checkOutcomeWindow({ countersignedAt, windowStart: '2026-03-01T09:00:00Z', windowEnd: '2026-06-01T00:00:00Z', now })).toEqual({
      status: 409, why: 'The measurement window has not ended yet.',
      detail: 'the window ends 2026-06-01T00:00:00Z; it is now 2026-05-15T09:00:00.000Z',
    });
    expect(checkOutcomeWindow({ countersignedAt, windowStart: '2026-04-01T00:00:00Z', windowEnd: '2026-04-01T00:00:00Z', now })).toMatchObject({ status: 400 });
    expect(checkOutcomeWindow({ countersignedAt, windowStart: 'last spring', windowEnd: '2026-04-01T00:00:00Z', now })).toMatchObject({ status: 400 });
    expect(checkOutcomeWindow({ countersignedAt, windowStart: '2026-03-01T09:00:00Z', windowEnd: '2026-05-01T00:00:00Z', now })).toBeNull();
  });

  it('holds a kept change to the whole declared window; a change stopped early or reverted may be shorter and says so', () => {
    const w = { windowStart: '2026-03-01T09:00:00.000Z', windowWeeks: 8 };
    expect(checkWindowLength({ ...w, windowEnd: '2026-04-26T09:00:00.000Z', disposition: 'kept' })).toEqual({ ok: true, weeks: 8, shorterThanPlanned: false });
    // One hour, chosen by the grader: refused for a kept change.
    expect(checkWindowLength({ ...w, windowEnd: '2026-03-01T10:00:00.000Z', disposition: 'kept' })).toEqual({
      ok: false, status: 409, why: 'The measurement window is shorter than the plan declared.',
      detail: 'the window is 0.01 weeks; the measurement plan declared 8. Measure the whole window, or record the change as stopped early or reverted, with a note',
    });
    expect(checkWindowLength({ ...w, windowEnd: '2026-03-22T09:00:00.000Z', disposition: 'stopped-early' })).toEqual({ ok: true, weeks: 3, shorterThanPlanned: true });
    expect(checkWindowLength({ ...w, windowEnd: '2026-03-22T09:00:00.000Z', disposition: 'reverted' })).toMatchObject({ ok: true, shorterThanPlanned: true });
  });
});

// ── Envelopes ─────────────────────────────────────────────────────────────────────────────

async function sign(wallet: typeof ANA, payload: Record<string, unknown>): Promise<SignedEnvelope> {
  return { payload, signature: await signMessageRaw(wallet, canonicalJson(payload)) };
}
const payload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ intent: 'wrd:classify-task', podUrl: POD, issuedAt: NOW, nonce: 'nonce-000000000001', taskIri: T1, ...o });

describe('envelopes', () => {
  it('recovers the signer; an altered payload recovers a different address; wrong intent, wrong pod, stale issuedAt or missing signature is refused with 400/401', async () => {
    const now = new Date(NOW);
    const env = await sign(ANA, payload());
    const opened = openEnvelope(env, 'wrd:classify-task', POD, now);
    expect(opened).toMatchObject({ ok: true, signer: PERSON, did: `did:ethr:${PERSON}` });
    // The pod binding is compared normalised.
    expect(openEnvelope(env, 'wrd:classify-task', 'https://192.0.2.20/t', now)).toMatchObject({ ok: true });
    // Altered after signing: still recovers SOME address — not the signer's — so a role check refuses it.
    const altered = openEnvelope({ ...env, payload: { ...env.payload, taskIri: T2 } }, 'wrd:classify-task', POD, now);
    expect(altered.ok).toBe(true);
    if (altered.ok) expect(altered.signer).not.toBe(PERSON);
    expect(openEnvelope(env, 'wrd:countersign-decision', POD, now)).toMatchObject({ ok: false, status: 400, why: 'payload.intent must be wrd:countersign-decision' });
    expect(openEnvelope(env, 'wrd:classify-task', 'https://198.51.100.7/other/', now)).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/does not name the pod/) });
    expect(openEnvelope(env, 'wrd:classify-task', POD, new Date(Date.parse(NOW) + 60 * 60_000))).toMatchObject({ ok: false, status: 401, error: 'The envelope is stale or from the future.' });
    expect(openEnvelope(env, 'wrd:classify-task', POD, new Date(Date.parse(NOW) - 10 * 60_000))).toMatchObject({ ok: false, status: 401 });
    expect(openEnvelope(env, 'wrd:classify-task', POD, new Date(Date.parse(NOW) + 14 * 60_000))).toMatchObject({ ok: true });
    expect(openEnvelope(undefined, 'wrd:classify-task', POD, now)).toMatchObject({ ok: false, status: 401, error: 'A signed envelope is required.' });
    expect(openEnvelope({ payload: env.payload }, 'wrd:classify-task', POD, now)).toMatchObject({ ok: false, status: 400 });
    expect(openEnvelope({ ...env, signature: '0x1234' }, 'wrd:classify-task', POD, now)).toMatchObject({ ok: false, status: 401, error: 'The envelope signature does not verify.' });
    expect(openEnvelope(await sign(ANA, payload({ nonce: 'short' })), 'wrd:classify-task', POD, now)).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/nonce/) });
    expect(openEnvelope(await sign(ANA, payload({ issuedAt: 'today' })), 'wrd:classify-task', POD, now)).toMatchObject({ ok: false, status: 400 });
    // A field naming a signer is ignored: identity comes from the signature alone.
    const claims = await sign(BO, payload({ signer: ANA.address }));
    expect(openEnvelope(claims, 'wrd:classify-task', POD, now)).toMatchObject({ ok: true, signer: PERSON2 });
    expect(normalisePodUrl('HTTPS://192.0.2.20/t?x=1#y')).toBe(POD);
    expect(() => normalisePodUrl('file:///etc/')).toThrow();
  });

  it('accepts a nonce once per signer', () => {
    const ledger = new NonceLedger(17 * 60_000);
    const t0 = new Date(NOW);
    expect(ledger.claim(PERSON, 'nonce-000000000001', t0)).toBe(true);
    expect(ledger.claim(PERSON, 'nonce-000000000001', new Date(t0.getTime() + 60_000))).toBe(false);
    expect(ledger.claim(PERSON.toUpperCase().replace('0X', '0x'), 'nonce-000000000001', t0)).toBe(false);
    expect(ledger.claim(PERSON2, 'nonce-000000000001', t0)).toBe(true);
    // After the window the envelope itself is stale, so the ledger may forget the pair.
    expect(ledger.claim(PERSON, 'nonce-000000000001', new Date(t0.getTime() + 18 * 60_000))).toBe(true);
    // Bounded: beyond its cap the oldest pairs go (the pod's own replay check stands behind them), and expiry stops at the first live entry.
    const small = new NonceLedger(60_000, 3);
    for (const n of ['n-0000000000000001', 'n-0000000000000002', 'n-0000000000000003', 'n-0000000000000004']) expect(small.claim(PERSON, n, t0)).toBe(true);
    expect(small.size).toBe(3);
    expect(small.claim(PERSON, 'n-0000000000000004', t0)).toBe(false);
    expect(small.claim(PERSON, 'n-0000000000000005', new Date(t0.getTime() + 61_000))).toBe(true);
    expect(small.size).toBe(1);
  });

  it('re-verifies a stored envelope weeks later without a freshness window', async () => {
    const env = await sign(BO, payload({ intent: 'wrd:countersign-decision', verdict: 'approve' }));
    const weeksLater = new Date(Date.parse(NOW) + 9 * 7 * 86_400_000);
    expect(openEnvelope(env, 'wrd:countersign-decision', POD, weeksLater)).toMatchObject({ ok: false, status: 401 });
    expect(verifyStoredEnvelope(env, 'wrd:countersign-decision', POD)).toEqual({ ok: true, signer: PERSON2, did: didOf(PERSON2), authority: 'key-held' });
    expect(verifyStoredEnvelope(env, 'wrd:record-outcome', POD)).toMatchObject({ ok: false });
    expect(verifyStoredEnvelope({ ...env, signature: 'nope' }, 'wrd:countersign-decision', POD)).toMatchObject({ ok: false });
    expect(envelopeSha256(env)).toBe(sha256Hex(canonicalJson({ payload: env.payload, signature: env.signature })));
    expect(envelopeSha256({ ...env, payload: { ...env.payload, verdict: 'decline' } })).not.toBe(envelopeSha256(env));
  });

  it('keeps the two kinds of principal apart: a user DID is never lower-cased or read as an address, and an address is always lower-cased', () => {
    const did = 'did:web:identity.interego.xwisee.com:users:u-pk-0A1b2C3d4E5f';
    expect([isUserPrincipal(did), isPersonId(did), isPersonId(PERSON), isUserPrincipal(PERSON), isPersonId('ana')]).toEqual([true, true, true, false, false]);
    expect(isUserPrincipal('did:web:identity.interego.xwisee.com:agents:claude-u-pk-1')).toBe(false);
    expect(principalKey(did)).toBe(did);
    expect(principalKey(ANA.address)).toBe(PERSON);
    expect([didOf(did), didOf(ANA.address)]).toEqual([did, `did:ethr:${PERSON}`]);
    expect([principalOfDid(did), principalOfDid(`did:ethr:${ANA.address}`)]).toEqual([did, PERSON]);
    // The ledger keys by principal: the same nonce from a DID and from its lower-cased spelling (another user) are two principals.
    const ledger = new NonceLedger(60_000);
    const t0 = new Date(NOW);
    expect(ledger.claim(did, 'nonce-000000000001', t0)).toBe(true);
    expect(ledger.claim(did, 'nonce-000000000001', t0)).toBe(false);
    expect(ledger.claim(did.toLowerCase(), 'nonce-000000000001', t0)).toBe(true);
  });

  it('binds a relay-signed request as a key-held envelope is bound, reading the pod from pod_url and the time from the relay timestamp, and re-verifies it stored, offline', async () => {
    // Hardhat development key #3 stands in for the relay's delegation key.
    const relay = importWallet('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', 'agent', 'relay');
    const host = 'identity.interego.xwisee.com';
    const principal = `did:web:${host}:users:u-pk-f2a9c751075a`;
    const agentId = `did:web:${host}:agents:claude-u-pk-f2a9c751075a`;
    // As the relay builds it: the caller's fields (a stale issuedAt of the caller's own among them), then agent_id, subject_pod_url, timestamp.
    const signed: Record<string, unknown> = {
      intent: 'wrd:countersign-decision', verdict: 'approve', issuedAt: '2020-01-01T00:00:00.000Z', pod_url: POD, nonce: 'nonce-000000000009',
      agent_id: agentId, subject_pod_url: 'https://198.51.100.7/mine/', timestamp: NOW,
    };
    const text = JSON.stringify(signed);
    const v = { principal, agentId, relaySigner: relay.address.toLowerCase(), payload: signed, signedPayload: text, signature: await signMessageRaw(relay, `sha256:${sha256Hex(text)}`) };
    const now = new Date(NOW);
    const opened = bindRelayDelegated(v, 'wrd:countersign-decision', POD, now);
    expect(opened).toMatchObject({ ok: true, signer: principal, did: principal, authority: 'relay-delegated', agentId, relaySigner: v.relaySigner });
    if (!opened.ok) throw new Error('expected the relay-signed request to bind');
    expect(opened.payload).toEqual(relayPayloadView(signed));
    expect(opened.payload).toMatchObject({ podUrl: POD, issuedAt: NOW, verdict: 'approve', subject_pod_url: 'https://198.51.100.7/mine/' });
    expect(opened.envelope).toEqual({ payload: opened.payload, signature: v.signature, authority: 'relay-delegated', signedPayload: text, agentId, principal, relaySigner: v.relaySigner });
    // Every check a key-held envelope gets, by the relay's fields.
    expect(bindRelayDelegated(v, 'wrd:record-outcome', POD, now)).toMatchObject({ ok: false, status: 400, why: 'payload.intent must be wrd:record-outcome' });
    expect(bindRelayDelegated(v, 'wrd:countersign-decision', 'https://198.51.100.7/mine/', now)).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/does not name the pod/) });
    const { pod_url: _named, ...unnamed } = signed;
    expect(bindRelayDelegated({ ...v, payload: { ...unnamed, subject_pod_url: POD } }, 'wrd:countersign-decision', POD, now))
      .toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/names no pod_url.*subject_pod_url, your own pod, is never read/) });
    expect(bindRelayDelegated(v, 'wrd:countersign-decision', POD, new Date(Date.parse(NOW) + 16 * 60_000))).toMatchObject({ ok: false, status: 401, why: expect.stringMatching(/relay's timestamp/) });
    expect(bindRelayDelegated({ ...v, payload: { ...signed, timestamp: 'today' } }, 'wrd:countersign-decision', POD, now)).toMatchObject({ ok: false, status: 400 });
    expect(bindRelayDelegated({ ...v, payload: { ...signed, nonce: 'short' } }, 'wrd:countersign-decision', POD, now)).toMatchObject({ ok: false, status: 400, why: expect.stringMatching(/nonce/) });
    // A key-held envelope dressed as a relay-delegated one is opened as what it is: its signer, and nothing it claims is kept.
    const dressed = { ...(await sign(ANA, payload())), authority: 'relay-delegated', principal, agentId, relaySigner: v.relaySigner, signedPayload: text };
    const keyHeld = openEnvelope(dressed, 'wrd:classify-task', POD, now);
    expect(keyHeld).toMatchObject({ ok: true, signer: PERSON, authority: 'key-held' });
    if (keyHeld.ok) expect(Object.keys(keyHeld.envelope).sort()).toEqual(['payload', 'signature']);
    // Stored, weeks later: the relay's signature against the relays trusted now, the agent and the payload it signed; no network.
    const check = { relayAddresses: [relay.address], identityHost: host };
    const stored: SignedEnvelope = opened.envelope;
    expect(verifyStoredEnvelope(stored, 'wrd:countersign-decision', POD, check)).toEqual({ ok: true, signer: principal, did: principal, authority: 'relay-delegated' });
    expect(verifyStoredEnvelope(stored, 'wrd:countersign-decision', POD)).toMatchObject({ ok: false, why: expect.stringMatching(/trusts no relay now/) });
    expect(verifyStoredEnvelope(stored, 'wrd:countersign-decision', POD, { ...check, relayAddresses: [ANA.address] })).toMatchObject({ ok: false, why: expect.stringMatching(/neither a relay this bridge trusts now nor one it lists as retired/) });
    expect(verifyStoredEnvelope(stored, 'wrd:record-outcome', POD, check)).toMatchObject({ ok: false });
    expect(verifyStoredEnvelope({ ...stored, agentId: `did:web:${host}:agents:claude-someone-else` }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: false, why: expect.stringMatching(/does not name the stored agent/) });
    expect(verifyStoredEnvelope({ ...stored, relaySigner: PERSON }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: false, why: expect.stringMatching(/relaySigner stored/) });
    expect(verifyStoredEnvelope({ ...stored, payload: { ...stored.payload, verdict: 'decline' } }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: false, why: expect.stringMatching(/not the relay-signed text/) });
    expect(verifyStoredEnvelope({ ...stored, signedPayload: text.replace('approve', 'decline') }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: false });
    expect(verifyStoredEnvelope({ ...stored, principal: `did:web:elsewhere.example:users:u-pk-f2a9c751075a` }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: false, why: expect.stringMatching(/not a user on/) });
    expect(verifyStoredEnvelope({ ...stored, signedPayload: undefined }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: false });
    // ★ What a later reader trusts for the principal: the bridge's word, which the platform's proof covers (the record's
    // bytes), not the relay's signature, which names only the agent. Offline, another user DID on the host passes here.
    expect(verifyStoredEnvelope({ ...stored, principal: `did:web:${host}:users:u-pk-0000000000ff` }, 'wrd:countersign-decision', POD, check)).toMatchObject({ ok: true, signer: `did:web:${host}:users:u-pk-0000000000ff` });
    // The digest binds the relay's text and who it was for, not only payload and signature.
    expect(envelopeSha256(stored)).not.toBe(sha256Hex(canonicalJson({ payload: stored.payload, signature: stored.signature })));
    expect(envelopeSha256({ ...stored, principal: `did:web:${host}:users:u-pk-0000000000ff` })).not.toBe(envelopeSha256(stored));
  });
});

// ── Calibration and grants ────────────────────────────────────────────────────────────────

const decision = (n: number, o: Partial<DecisionForCalibration> = {}): DecisionForCalibration => ({
  decisionIri: `urn:wrd:decision:00000000000000a1:${String(n).padStart(16, '0')}`, level: 'agent-drafts-person-decides', metric: 'weekly-cash-delta', basis: 'staggered',
  verdict: 'in-band', rampAdjusted: false, disposition: 'kept', measuredBy: `did:ethr:${PERSON2}`, submittedAt: '2026-01-01T00:00:00.000Z', measuredAt: '2026-03-01T00:00:00.000Z', demo: false, shortWindow: false, ...o,
});
const AGENT_DID = didOf(AGENT_ADDR);
function runs(n: number, o: { model?: string; reviewers?: readonly string[]; startAt?: string; plan?: (i: number) => [ReviewedRun['selfAnswer'], ReviewedRun['verdict']]; demo?: boolean } = {}): ReviewedRun[] {
  const reviewers = o.reviewers ?? ['p-eli', 'p-fay', 'p-gus', 'p-hal', 'p-ivy'];
  const start = Date.parse(o.startAt ?? '2026-02-01T00:00:00.000Z');
  return Array.from({ length: n }, (_, i) => {
    const allAccepted: [ReviewedRun['selfAnswer'], ReviewedRun['verdict']] = ['accepted', 'accepted'];
    const [selfAnswer, verdict] = o.plan ? o.plan(i) : allAccepted;
    const ref = reviewers[i % reviewers.length] ?? 'p-none';
    return {
      runIri: `urn:wrd:run:${o.startAt ?? 'a'}:${i}`, taskIri: T1, agentDid: AGENT_DID, taskKind: 'invoice-matching', model: o.model ?? 'scripted-fixture',
      selfAnswer, verdict, reviewerDid: `did:ethr:reviewer-${ref}`, reviewerPersonRef: ref,
      performedAt: new Date(start + i * 3_600_000).toISOString(), reviewedAt: new Date(start + i * 3_600_000 + 1_800_000).toISOString(), demo: o.demo ?? false,
    };
  });
}
const grantInput = (rs: readonly ReviewedRun[], o: Partial<Parameters<typeof evaluateGrant>[0]> = {}): Parameters<typeof evaluateGrant>[0] => ({
  agentDid: AGENT_DID, taskKind: 'invoice-matching', model: 'scripted-fixture', runs: rs, policy: policy.grantPolicy, attestor: 'did:ethr:0xplatform',
  since: null, now: new Date('2026-06-01T00:00:00.000Z'), grantGraphUrl: 'https://192.0.2.20/t/wrd/records/grant-1', ...o,
});
/** 23 ready claims (22 accepted by the person, 1 reworked) and one run the agent itself flagged as reworked. */
const demoPlan = (i: number): [ReviewedRun['selfAnswer'], ReviewedRun['verdict']] => (i === 23 ? ['reworked', 'reworked'] : i === 7 ? ['accepted', 'reworked'] : ['accepted', 'accepted']);

describe('calibration and grants', () => {
  it('scores band verdicts per metric and level, keeps before-after outcomes in their own uncontrolled cells, and excludes inconclusive ones', () => {
    const report = calibrationReport({
      decisions: [
        decision(1), decision(2, { verdict: 'below-band', rampAdjusted: true }), decision(3, { disposition: 'reverted' }),
        decision(4, { basis: 'before-after' }), decision(5, { basis: 'before-after', verdict: 'inconclusive' }),
        decision(6, { basis: 'holdout', metric: 'weekly-delta-if-redeployed' }),
        decision(7, { disposition: 'stopped-early', shortWindow: true, verdict: 'below-band' }),
      ],
      runs: [], probes: [], minSamples: 20, policy: policy.grantPolicy, currentModelOf: () => null,
    });
    expect(report.predictionCells.map((c) => c.kind)).toEqual([
      'prediction:weekly-cash-delta:agent-drafts-person-decides:controlled',
      'prediction:weekly-cash-delta:agent-drafts-person-decides:uncontrolled',
      'prediction:weekly-delta-if-redeployed:agent-drafts-person-decides:controlled',
    ]);
    const controlled = must(report.predictionCells[0]);
    // Judged in-band with 0.8: a hit scores (0.8−1)² + 2·0.1² = 0.06, a below-band miss (0.1−1)² + 0.8² + 0.1² = 1.46.
    // Decision 7 was measured over less than its declared window: kept out of the cell, and counted.
    expect(controlled).toMatchObject({ samples: 3, hitRate: 0.667, meanBrier: 0.5267, meanOrdinalDistance: 0.3333, status: 'Hypothetical', excludedInconclusive: 0, excludedShortWindow: 1, rampAdjusted: 1, dispositions: { kept: 2, reverted: 1, 'stopped-early': 1 }, scriptedLabel: null });
    const uncontrolled = must(report.predictionCells[1]);
    expect(uncontrolled).toMatchObject({ basisClass: 'uncontrolled', samples: 1, excludedInconclusive: 1, hitRate: 1 });
    expect(uncontrolled.label).toMatch(/no comparison group$/);
    expect(report.nominalBandCoverage).toBe(0.8);
    const twenty = calibrationReport({ decisions: Array.from({ length: 20 }, (_, i) => decision(i)), runs: [], probes: [], minSamples: 20, policy: policy.grantPolicy, currentModelOf: () => null });
    expect(must(twenty.predictionCells[0]).status).toBe('Asserted');
    expect(predictionKind('weekly-cash-delta', 'person', 'holdout').kind).toBe('prediction:weekly-cash-delta:person:controlled');
    expect(runKind('gl-coding')).toEqual({ kind: 'agent-run:gl-coding', alternatives: ['accepted', 'reworked', 'critical-failure'], axis: 'competence' });
    expect(meanOrdinalDistance([], ['a', 'b'])).toBeNull();
  });

  it('reports probe signals apart from prediction cells', () => {
    const report = calibrationReport({
      decisions: [], runs: [], minSamples: 20, policy: policy.grantPolicy, currentModelOf: () => null,
      probes: [
        { decisionIri: 'urn:wrd:decision:a:b', taskIri: T1, index: 0, signal: 'amplify', demo: false },
        { decisionIri: 'urn:wrd:decision:a:b', taskIri: T1, index: 1, signal: 'neither', demo: false },
        { decisionIri: 'urn:wrd:decision:a:c', taskIri: T2, index: 0, signal: 'dampen', demo: false },
      ],
    });
    expect(report.predictionCells).toEqual([]);
    expect(report.probeSignals).toEqual({ label: 'not a calibration of predictions: a probe predicts nothing', probes: 3, amplify: 1, dampen: 1, neither: 1, conditionFired: 2, demoSamples: 0, scriptedLabel: null });
  });

  it('labels every cell built on demo records', () => {
    const report = calibrationReport({
      decisions: [decision(1, { demo: true }), decision(2, { basis: 'before-after' })],
      runs: [...runs(3, { demo: true }), ...runs(2, { model: 'other-model' })],
      probes: [{ decisionIri: 'urn:wrd:decision:a:b', taskIri: T1, index: 0, signal: 'amplify', demo: true }],
      minSamples: 20, policy: policy.grantPolicy, currentModelOf: () => 'scripted-fixture',
    });
    expect(report.predictionCells.map((c) => [c.basisClass, c.scriptedLabel])).toEqual([['controlled', DEMO_LABEL], ['uncontrolled', null]]);
    expect(report.agentCells.map((c) => [c.model, c.currentModel, c.scriptedLabel, c.distinctConfirmersNote])).toEqual([
      ['other-model', false, null, DISTINCT_PEOPLE_NOTE], ['scripted-fixture', true, DEMO_LABEL, DISTINCT_PEOPLE_NOTE],
    ]);
    expect(report.probeSignals.scriptedLabel).toBe(DEMO_LABEL);
  });

  it('earns a grant only with 20 reviewed runs on the declared model, 90% of them accepted by a person, >= 5 distinct personRefs, and >= 20 ready claims at precision >= 0.9', () => {
    const earned = evaluateGrant(grantInput(runs(24, { plan: demoPlan })));
    // A person accepted 22 of 24 runs: the kit's competence rating over acceptance outcomes is 22/24 = 0.917.
    expect(earned).toMatchObject({ earned: true, samples: 24, humanConfirmations: 24, distinctConfirmers: 5, rating: 0.917, acceptedShare: 0.9167, readyClaims: 23, readyClaimPrecision: 0.9565, criticalFailures: 0, taskIris: [T1] });
    expect(earned.why).toMatch(/^earned: a person accepted 22 of 24 reviewed runs \(91\.7%\), clearing 90%/);
    expect(earned.runIris).toHaveLength(24);

    expect(evaluateGrant(grantInput(runs(19)))).toMatchObject({ earned: false, why: '19 person-reviewed runs on model scripted-fixture; the policy needs 20.', rating: null });
    expect(evaluateGrant(grantInput(runs(24, { plan: demoPlan }), { model: 'other-model' }))).toMatchObject({ earned: false, samples: 0 });
    const lowAcceptance = evaluateGrant(grantInput(runs(20, { plan: (i) => (i < 3 ? ['accepted', 'reworked'] : ['accepted', 'accepted']) })));
    expect(lowAcceptance).toMatchObject({ earned: false, rating: 0.85, acceptedShare: 0.85, why: 'a person accepted 17 of 20 reviewed runs (85%); the policy needs at least 90%.' });
    expect(lowAcceptance.kitWhy).toMatch(/competence 0.85 is below the floor 0.9/);
    const threePeople = evaluateGrant(grantInput(runs(20, { reviewers: ['p-eli', 'p-fay', 'p-gus'] })));
    expect(threePeople).toMatchObject({ earned: false, distinctConfirmers: 3 });
    expect(threePeople.why).toBe('reviewed by 3 distinct registered reviewers the admin attests are different people; the policy needs 5. This bridge cannot verify that they are different people.');
    // 37 of 40 accepted clears the floor, but of the 23 runs it called ready a person accepted only 20.
    const imprecise = evaluateGrant(grantInput(runs(40, { plan: (i) => (i < 17 ? ['reworked', 'accepted'] : i < 37 ? ['accepted', 'accepted'] : ['accepted', 'reworked']) })));
    expect(imprecise).toMatchObject({ earned: false, acceptedShare: 0.925, readyClaims: 23, readyClaimPrecision: 0.8696, why: 'a person accepted 87% of the 23 runs the agent called ready; the policy needs 90%.' });
    const critical = evaluateGrant(grantInput(runs(25, { plan: (i) => (i === 3 ? ['accepted', 'critical-failure'] : ['accepted', 'accepted']) })));
    expect(critical).toMatchObject({ earned: false, criticalFailures: 1, criticalFailuresOnReadyClaims: 1, why: '1 run(s) the agent called ready were critical failures.' });
  });

  it('does not earn a grant for an agent whose work is reworked, however truthfully it labels its runs; nor on one ready claim', () => {
    // The review's reproduction: 20 runs, 5 reviewers, a person accepted 1; the agent called the other 19 "reworked", correctly.
    const truthful = runs(20, { plan: (i) => (i === 0 ? ['accepted', 'accepted'] : ['reworked', 'reworked']) });
    const e = evaluateGrant(grantInput(truthful));
    expect(e).toMatchObject({ earned: false, acceptedShare: 0.05, rating: 0.05, readyClaims: 1, why: 'a person accepted 1 of 20 reviewed runs (5%); the policy needs at least 90%.' });
    // Its self-assessment is perfectly calibrated — the agent cell shows that, beside how little of its work was accepted.
    const cell = must(calibrationReport({ decisions: [], runs: truthful, probes: [], minSamples: 20, policy: policy.grantPolicy, currentModelOf: () => 'scripted-fixture' }).agentCells[0]);
    expect(cell).toMatchObject({ samples: 20, hitRate: 1, acceptedShare: 0.05, readyClaims: 1, readyClaimPrecision: 1, status: 'Asserted' });
    // All work accepted, but the agent called only 5 runs ready: precision over 5 claims bounds nothing.
    const shy = evaluateGrant(grantInput(runs(20, { plan: (i) => (i < 15 ? ['reworked', 'accepted'] : ['accepted', 'accepted']) })));
    expect(shy).toMatchObject({ earned: false, acceptedShare: 1, readyClaims: 5, readyClaimPrecision: 1 });
    expect(shy.why).toMatch(/^the agent called 5 of its reviewed runs ready; at least 20 ready claims are needed/);
  });

  it('counts two keys with one personRef as one reviewer', () => {
    // Six reviewing keys, but the admin attests p-eli holds two of them and p-fay two: four people.
    const rs = runs(24, { reviewers: ['p-eli', 'p-eli', 'p-fay', 'p-fay', 'p-gus', 'p-hal'] }).map((r, i) => ({ ...r, reviewerDid: `did:ethr:key-${i % 6}` }));
    expect(new Set(rs.map((r) => r.reviewerDid)).size).toBe(6);
    expect(evaluateGrant(grantInput(rs))).toMatchObject({ earned: false, distinctConfirmers: 4, why: expect.stringMatching(/^reviewed by 4 distinct registered reviewers/) });
  });

  it('counts only runs reviewed after a revocation toward re-earning', () => {
    const before = runs(24, { plan: demoPlan });
    const revokedAt = '2026-03-01T00:00:00.000Z';
    expect(evaluateGrant(grantInput(before, { since: revokedAt }))).toMatchObject({ earned: false, samples: 0, countedSince: revokedAt, why: expect.stringMatching(/^0 person-reviewed runs on model scripted-fixture since 2026-03-01/) });
    const after = runs(20, { startAt: '2026-03-02T00:00:00.000Z' });
    expect(evaluateGrant(grantInput([...before, ...after], { since: revokedAt }))).toMatchObject({ earned: true, samples: 20, countedSince: revokedAt });
  });
});

// ── Record graphs and descriptors ─────────────────────────────────────────────────────────

const PLATFORM: PlatformRef = { did: didOf(AGENT_ADDR), address: AGENT_ADDR, keyKind: 'demo' };
const REF: PolicyRef = { ontologyIri: WRD_ONTOLOGY_IRI, ontologySha256: policy.ontologySha256, podPolicyHead: null };
const ENV: SignedEnvelope = { payload: { intent: 'wrd:classify-task', podUrl: POD, issuedAt: NOW, nonce: 'nonce-000000000009', note: 'He said "fine" \\ then left\nnext line “quoted”' }, signature: `0x${'ab'.repeat(65)}` };
const SIGNER: RecordSigner = { did: didOf(PERSON), address: PERSON, personRef: 'p-ana', softwareAgent: false, facetRole: 'Curator', acted: 'classified' };
const WF = entityIri('workflow', POD, 'wf-1');
const PLAN = entityIri('plan', WF, 'plan-1');
const DEC = entityIri('decision', WF, 'dec-1');
const valuation = valuePlan(exactInputs(), planOpts({ draws: 20 }));
const grantEval = evaluateGrant(grantInput(runs(24, { plan: demoPlan })));
const classified = classifyTask(answers(), policy);
const quoteVerdicts = verifyTaskQuotes(SOP, [{ sourceQuotes: ['Match each invoice to its purchase order', 'Invoices under $500 are auto-approved without matching'] }]).perTask[0] ?? [];
const common = { version: 1, signers: [SIGNER], platform: PLATFORM, demo: true as const };

const RECORDS: WrdRecord[] = [
  { ...common, recordKind: 'RoleRegistry', entityIri: entityIri('registry', POD, 'registry'), status: 'registered', payload: {
    members: [
      { address: PERSON, did: didOf(PERSON), roles: ['operator', 'approver'], label: 'Ana "the" operator \\ (demo)', softwareAgent: false, personRef: 'p-ana', principal: null, model: null },
      { address: AGENT_ADDR, did: didOf(AGENT_ADDR), roles: ['agent'], label: 'AP agent (demo)', softwareAgent: true, personRef: null, principal: PERSON, model: 'scripted-fixture' },
    ],
    taskKinds: [{ slug: 'invoice-matching', label: 'Invoice matching', definition: 'Match an invoice to its order and receipt.', retired: false }],
    podPolicy: { floor: 0.95 }, replacedUntrusted: false, change: { envelope: ENV, signer: PERSON },
  } },
  { ...common, recordKind: 'Workflow', entityIri: WF, status: 'captured', payload: {
    title: 'Supplier invoice processing', unitLabel: 'invoice', captureMode: 'document', capturedBy: { did: didOf(PERSON), envelope: ENV },
    taskIris: [T1, T2], retiredTaskIris: [], document: { title: 'AP SOP', sha256: sha256Hex(SOP), chars: SOP.length, textStored: true }, documentText: SOP,
    draftedBy: { kind: 'agent', agent: 'SCRIPTED_CLIENT_DRAFT (offline demo fixture)' },
  } },
  { ...common, recordKind: 'Task', entityIri: T1, status: 'ratified', payload: {
    workflowIri: WF, index: 0, name: 'Match each invoice to its purchase order', description: 'Three-way match “before” payment', textSha256: taskTextSha256('a', 'b'),
    current: { level: 'agent-drafts-person-decides', personAddress: PERSON, agentAddress: AGENT_ADDR }, performer: AGENT_ADDR, namedParties: [PERSON, AGENT_ADDR],
    taskKind: 'invoice-matching', taskKindDefinition: 'Match an invoice to its order and receipt.', externalTaskTerm: 'https://www.onetonline.org/link/summary/43-3031.00',
    quotes: quoteVerdicts, quoteStatus: quoteStatusOf(quoteVerdicts),
    ratifications: [{ party: PERSON, verdict: 'ratify', envelope: ENV, at: NOW }, { party: AGENT_ADDR, verdict: 'ratify', envelope: ENV, at: NOW }],
    owedRatification: [PERSON2],
  }, authorisedBy: { signer: PERSON, nonce: 'nonce-000000000009' } },
  { ...common, recordKind: 'Classification', entityIri: entityIri('classification', WF, T1), status: 'classified', payload: {
    taskIri: T1, taskTextSha256: taskTextSha256('a', 'b'), answers: answers(), regime: classified.placed ? classified.regime : 'Knowable', method: classified.placed ? classified.method : 'expert-analysis',
    regimeSource: 'rule-on-signed-answers', regimeSourceIri: policy.regimeSourceIri, rulesFired: [...classified.rulesFired], notes: classified.placed ? [...classified.notes] : [],
    answeredBy: { did: didOf(PERSON), address: PERSON, personRef: 'p-ana', role: 'operator', envelope: ENV }, ratifications: [], policyRef: REF,
  } },
  { ...common, recordKind: 'Plan', entityIri: PLAN, status: 'proposed', payload: {
    workflowIri: WF, title: 'Agent drafts matching', planKind: 'valued', proposedBy: { did: didOf(PERSON), envelope: ENV },
    tasks: [
      { taskIri: T1, taskKind: 'invoice-matching', regime: 'Evident', current: { level: 'person', personAddress: PERSON }, proposed: { level: 'agent-drafts-person-decides', personAddress: PERSON, agentAddress: AGENT_ADDR }, changed: true },
      { taskIri: T2, taskKind: 'gl-coding', regime: 'Knowable', current: { level: 'person', personAddress: PERSON2 }, proposed: { level: 'person', personAddress: PERSON2 }, changed: false },
    ],
    classificationHeads: { [T1]: 'https://192.0.2.20/t/wrd/records/classification-1.ttl' }, taskTextSha256: { [T1]: taskTextSha256('a', 'b') }, policyRef: REF,
  } },
  { ...common, recordKind: 'Valuation', entityIri: entityIri('valuation', PLAN, 'inputs'), status: 'valued', payload: {
    planIri: PLAN, planDescriptorUrl: 'https://192.0.2.20/t/wrd/records/plan-1.ttl', inputs: exactInputs(), result: valuation, valuedTasks: [T1], unratifiedTasks: [],
    expertEvidence: [], valuationHash: sha256Hex('valuation'), requestedBy: { did: didOf(PERSON), envelope: ENV }, policyRef: REF,
  } },
  { ...common, recordKind: 'Decision', entityIri: DEC, version: 3, status: 'measured', payload: {
    decisionKind: 'valued', planIri: PLAN, valuationIri: entityIri('valuation', PLAN, 'inputs'), valuationHash: sha256Hex('valuation'),
    prediction: { metric: 'weekly-cash-delta', band: valuation.scenarios.cash.weeklyDelta, npv: valuation.scenarios.cash.npv, rampMonths: 2, status: 'measured' },
    freedHours: valuation.freedPersonHours, decisionLevel: 'agent-drafts-person-decides', subjects: [{ address: PERSON2, personRef: 'p-cy' }],
    assignments: [{ taskIri: T1, personAddress: PERSON, state: 'acknowledged' }],
    measurementPlan: { metric: 'weekly-cash-delta', comparisonBasis: 'staggered', windowWeeks: 8 }, comparisonGroup: true,
    submittedBy: { did: didOf(PERSON), personRef: 'p-ana', envelope: ENV }, grantChecks: [],
    preparedBy: [{ role: 'proposed', did: didOf(PERSON), personRef: 'p-ana' }, { role: 'submitted', did: didOf(PERSON), personRef: 'p-ana' }],
    countersign: { verdict: 'approve', did: didOf(PERSON2), personRef: 'p-bo', envelope: ENV, objectionsConsidered: [], unacknowledgedConsidered: [T1], assignmentsAtCountersign: [], at: NOW },
    outcome: { did: didOf(PERSON2), personRef: 'p-eli', envelope: ENV, disposition: 'kept', at: NOW, valued: {
      measured: { weeklyValueDelta: -28.5, comparisonBasis: 'staggered', windowStart: NOW, windowEnd: NOW, method: 'staggered rollout across two teams' },
      metric: 'weekly-cash-delta', verdict: 'in-band', adjustedBand: { p10: -30, p50: -30, p90: -30 }, rampFactor: 1, rampAdjusted: false, basisChanged: false,
      windowWeeks: 8, windowShorterThanPlanned: true, pilotCheck: { runsNeeded: 300, reviewedRuns: 12, criticalFailures: 0, ceilingSupported: false, declared: { runsObserved: 400 } },
    } },
  } },
  { ...common, recordKind: 'Acknowledgement', entityIri: entityIri('acknowledgement', PLAN, `${T1}|${PERSON}`), status: 'objected', payload: {
    planIri: PLAN, taskIri: T1, personAddress: PERSON, verdict: 'object', note: 'I cannot audit 200 codings a week', envelope: ENV,
  } },
  { ...common, recordKind: 'AgentRun', entityIri: entityIri('run', `${AGENT_ADDR}|invoice-matching`, 'run-1'), status: 'reviewed', payload: {
    agentDid: AGENT_DID, agentAddress: AGENT_ADDR, principal: PERSON, model: 'scripted-fixture', runId: 'run-1', taskIri: T1, taskKind: 'invoice-matching', outputSha256: sha256Hex('out'),
    selfAssessment: { answer: 'accepted', probabilities: { accepted: 0.9, reworked: 0.1 } }, underGrant: null, costPerRun: { amount: 0.42, currency: 'EUR' }, runEnvelope: ENV,
    review: { verdict: 'accepted', did: didOf(PERSON2), address: PERSON2, personRef: 'p-fay', envelope: ENV, at: NOW },
  } },
  { ...common, recordKind: 'Grant', entityIri: entityIri('grant', AGENT_ADDR, `${POD}|invoice-matching`), status: 'granted', payload: {
    agentAddress: AGENT_ADDR, agentDid: AGENT_DID, principal: PERSON, model: 'scripted-fixture', taskKind: 'invoice-matching', taskKindDefinition: 'Match an invoice to its order and receipt.',
    policy: policy.grantPolicy, evaluation: grantEval, grantedBy: { did: didOf(PERSON2), personRef: 'p-bo', envelope: ENV }, policyRef: REF,
  } },
  { ...common, recordKind: 'HolderCopy', entityIri: entityIri('holder-copy', PERSON2, `${POD}|n1`), status: 'copied', payload: {
    holder: { address: PERSON2, did: didOf(PERSON2) }, targetPodUrl: 'https://198.51.100.7/cy/',
    copied: [{ originalDescriptorUrl: 'https://192.0.2.20/t/wrd/records/task-1.ttl', copyDescriptorUrl: 'https://198.51.100.7/cy/wrd/held/held-1.ttl', skipped: false }], envelope: ENV,
  } },
];

describe('record graphs', () => {
  it('builds a shape-conforming graph with a non-null canonical digest for every record kind and round-trips its payload', () => {
    expect(RECORDS.map((r) => r.recordKind).sort()).toEqual([...RECORD_KINDS].sort());
    const shapes = readShapesTurtle();
    for (const rec of RECORDS) {
      const ttl = buildGraphTurtle(rec);
      const report = validateAgainstShape(ttl, shapes, { entailment: 'rdfs' });
      expect(report.conforms, `${rec.recordKind}: ${report.results.map((r) => `${r.path ?? ''} ${r.message}`).join('; ')}`).toBe(true);
      expect(canonicalGraphDigestResult(ttl).digest, rec.recordKind).toMatch(/^graph-nquads-sha256:[0-9a-f]{64}$/);
      expect(parseRecordGraph(ttl), rec.recordKind).toEqual(rec);
      expect(ttl).toContain('wrd:demoRecord "true"^^xsd:boolean');
      expect(ttl).not.toMatch(/rdfs:/);
    }
    const decisionTtl = buildGraphTurtle(must(RECORDS.find((r) => r.recordKind === 'Decision')));
    expect(decisionTtl).toContain(`<${DEC}:prediction> a wrd:Prediction`);
    expect(decisionTtl).toContain('wrd:predictionStatus "measured"');
    expect(decisionTtl).toContain('wrd:bandVerdict "in-band"');
    const taskTtl = buildGraphTurtle(must(RECORDS.find((r) => r.recordKind === 'Task')));
    expect(taskTtl).toContain(`wrd:currentLevel <${levelIri('agent-drafts-person-decides')}>`);
    expect(taskTtl).toContain(`wrd:performer <did:ethr:${AGENT_ADDR}>`);
    // A prediction that is not a finite number is never written as one: the kit's dbl() would have written 0.
    const dec = must(RECORDS.find((r) => r.recordKind === 'Decision')) as Extract<WrdRecord, { recordKind: 'Decision' }>;
    const nan = { ...dec, payload: { ...dec.payload, prediction: { ...must(dec.payload.prediction), band: { p10: Number.NaN, p50: 1, p90: 2 } } } };
    expect(() => buildGraphTurtle(nan)).toThrow(/predicted P10 is not a finite number; nothing is published/);
    // A graph that is not a wrd record reads as null, not as a guess.
    expect(parseRecordGraph('@prefix ex: <https://example.test/> . ex:a ex:b ex:c .')).toBeNull();
    expect(parseRecordGraph('not turtle {')).toBeNull();
  });

  it("fails the shapes for a status outside the kind's lifecycle", () => {
    const shapes = readShapesTurtle();
    const taskRec = must(RECORDS.find((r) => r.recordKind === 'Task'));
    const wrong = { ...taskRec, status: 'measured' } as unknown as WrdRecord;
    expect(validateAgainstShape(buildGraphTurtle(wrong), shapes, { entailment: 'rdfs' }).conforms).toBe(false);
    // ...and the reader refuses the record outright.
    expect(parseRecordGraph(buildGraphTurtle(wrong))).toBeNull();
    // A decision that loses its prediction status, or a task naming three parties, fails too.
    const dec = buildGraphTurtle(must(RECORDS.find((r) => r.recordKind === 'Decision'))).replace(/^.*wrd:predictionStatus.*$/m, '');
    expect(validateAgainstShape(dec, shapes, { entailment: 'rdfs' }).conforms).toBe(false);
    const three = { ...taskRec, payload: { ...(taskRec.payload as object), namedParties: [PERSON, PERSON2, AGENT_ADDR] } } as unknown as WrdRecord;
    expect(validateAgainstShape(buildGraphTurtle(three), shapes, { entailment: 'rdfs' }).conforms).toBe(false);
    expect(Object.keys(RECORD_STATUSES).sort()).toEqual([...RECORD_KINDS].sort());
  });

  it('builds a revocation descriptor with one fixed now that validates: validFrom is the grant start, validUntil the revocation', () => {
    const grantedAt = '2026-04-01T09:00:00.000Z';
    const revokedAt = '2026-05-01T09:00:00.000Z';
    const grantEntity = entityIri('grant', AGENT_ADDR, `${POD}|invoice-matching`);
    const graphIri = graphIriOf(grantEntity);
    const recordId = recordIdFor('grant', graphIri, 2, 'nonce-000000000010');
    expect(recordId).toMatch(/^urn:wrd:record:grant-[0-9a-f]{16}$/);
    expect(slugOf(recordId)).toBe(recordId.slice('urn:wrd:record:'.length));
    expect(recordIdFor('grant', graphIri, 2, 'nonce-000000000011')).not.toBe(recordId);
    expect(grantEntity.startsWith(scopePrefix('grant', AGENT_ADDR))).toBe(true);
    const spec = {
      recordId, graphIri, recordKind: 'Grant' as const, now: revokedAt, validFrom: grantedAt, validUntil: revokedAt, modal: 'Retracted' as const,
      supersedes: 'https://192.0.2.20/t/wrd/records/grant-aaaaaaaaaaaaaaaa.ttl', platformDid: PLATFORM.did,
      signers: [{ did: didOf(PERSON2), softwareAgent: false, role: 'Validator' as const }], derivedFrom: [],
    };
    const d = buildDescriptor(spec);
    expect(validate(d).conforms).toBe(true);
    const ttl = toTurtle(d);
    expect(ttl).toMatch(/Retracted/);
    expect(ttl).toContain(grantedAt);
    expect(ttl).toContain(revokedAt);
    expect(ttl).toContain(`<${WRD_NS}Grant>`);
    expect(ttl).toMatch(/Validator/);
    expect(ttl).toContain('grant-aaaaaaaaaaaaaaaa.ttl');
    // validUntil must be after validFrom; and only a Retracted version carries one.
    expect(() => buildDescriptor({ ...spec, validFrom: revokedAt })).toThrow(/does not validate/);
    expect(() => buildDescriptor({ ...spec, validUntil: undefined })).toThrow(/Retracted/);
    expect(() => buildDescriptor({ ...spec, modal: 'Asserted' })).toThrow(/Retracted/);
    // Hypothetical never states ground truth; a declined decision is Counterfactual with groundTruth false.
    const hyp = buildDescriptor({ ...spec, recordKind: 'Decision', modal: 'Hypothetical', confidence: 0.8, validFrom: revokedAt, validUntil: undefined, supersedes: undefined });
    const sem = hyp.facets.find((f) => f.type === 'Semiotic') as { modalStatus?: string; epistemicConfidence?: number; groundTruth?: boolean } | undefined;
    expect(sem).toMatchObject({ modalStatus: 'Hypothetical', epistemicConfidence: 0.8 });
    expect(sem?.groundTruth).toBeUndefined();
    const cf = buildDescriptor({ ...spec, recordKind: 'Decision', modal: 'Counterfactual', validFrom: revokedAt, validUntil: undefined });
    expect(cf.facets.find((f) => f.type === 'Semiotic')).toMatchObject({ modalStatus: 'Counterfactual', groundTruth: false });
    expect(validate(cf).conforms).toBe(true);
    const asserted = buildDescriptor({ ...spec, recordKind: 'Decision', modal: 'Asserted', validFrom: revokedAt, validUntil: undefined });
    expect(asserted.facets.find((f) => f.type === 'Semiotic')).toMatchObject({ modalStatus: 'Asserted', groundTruth: true });
    expect(asserted.facets.filter((f) => f.type === 'Agent')).toHaveLength(2);
  });
});

describe('levels and IRIs', () => {
  it('names every allocation level by a published IRI and keeps record IRIs scoped', () => {
    const levels: AllocationLevel[] = [...ALLOCATION_LEVELS];
    expect(new Set(levels.map(levelIri)).size).toBe(5);
    expect(entityIri('task', WF, '0')).toMatch(/^urn:wrd:task:[0-9a-f]{16}:[0-9a-f]{16}$/);
    expect(entityIri('task', WF, '0')).not.toBe(entityIri('task', WF, '1'));
    expect(entityIri('task', WF, '0').startsWith(scopePrefix('task', WF))).toBe(true);
    expect(graphIriOf(T1)).toBe(`${T1}:graph`);
  });
});
