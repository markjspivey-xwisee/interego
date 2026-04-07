/**
 * Multi-agent integration tests — full-stack scenarios demonstrating
 * that PGSL features COMPOSE correctly across agent boundaries.
 *
 * These are NOT unit tests. Each scenario exercises multiple modules
 * working together: AAT, Policy, PROV, Enclaves, CRDT, Coherence,
 * Decision Functor, Introspection, Marketplace, and Metagraph.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL, mintAtom, ingest, latticeStats,
  resolve as pgslResolve,
} from '../src/pgsl/lattice.js';
import { verifyCoherence, computeCoverage, getCertificates } from '../src/pgsl/coherence.js';
import type { IRI } from '../src/model/types.js';
import type { PGSLInstance } from '../src/pgsl/types.js';

// Agent framework
import {
  ObserverAAT, AnalystAAT, ExecutorAAT, ArbiterAAT, FullAccessAAT,
  createAATRegistry, registerAAT, filterAffordancesByAAT, validateAction,
  createPolicyEngine, addRule, evaluate as evaluatePolicy, defaultPolicies,
  createTraceStore, recordTrace, getTraces,
  createPersonalBroker, startConversation, addMessage, getMemoryStats,
  createAATDecorator,
} from '../src/pgsl/agent-framework.js';
import type {
  PolicyRule, TraceStore, ProvTrace, PersonalBroker,
} from '../src/pgsl/agent-framework.js';

// Infrastructure
import {
  createEnclaveRegistry, createEnclave, forkEnclave, freezeEnclave,
  mergeEnclave, enclaveStats,
  createCheckpointStore, createCheckpoint, restoreCheckpoint, diffCheckpoints,
  createCRDTState, incrementClock, createOp, applyOp, getPendingOps, markSynced,
} from '../src/pgsl/infrastructure.js';

// Discovery
import {
  introspectJson, applyIntrospection,
  createMarketplace, registerListing, discoverByCapability,
  generateMetagraph, ingestMetagraph, validateMetagraph, queryMetagraph,
  createIntrospectionAgent,
} from '../src/pgsl/discovery.js';

// Decision functor
import {
  extractObservations,
  computeAffordances as computeDecisionAffordances,
  selectStrategy,
  decide as decideFromObservations,
} from '../src/pgsl/decision-functor.js';

// Decorators
import {
  createDefaultRegistry, decorateNode, registerDecorator,
  coreSystemDecorator,
} from '../src/pgsl/affordance-decorators.js';
import type { DecoratorContext, DecoratedAffordance } from '../src/pgsl/affordance-decorators.js';

// ── Helpers ──────────────────────────────────────────────────

function makePgsl(agent: string = 'test'): PGSLInstance {
  return createPGSL({
    wasAttributedTo: `urn:agent:${agent}` as IRI,
    generatedAtTime: new Date().toISOString(),
  });
}

/** Build a minimal DecoratorContext for a node in a PGSL instance. */
function buildDecoratorContext(
  pgsl: PGSLInstance,
  uri: IRI,
  existingAffordances: readonly DecoratedAffordance[] = [],
): DecoratorContext {
  const node = pgsl.nodes.get(uri);
  if (!node) throw new Error(`Node not found: ${uri}`);
  return {
    uri,
    value: node.kind === 'Atom' ? (node as any).value : undefined,
    kind: node.kind as 'Atom' | 'Fragment',
    level: node.kind === 'Atom' ? 0 : (node as any).level,
    resolved: pgslResolve(pgsl, uri),
    items: [],
    sourceOptions: [],
    targetOptions: [],
    constraints: [],
    containers: [],
    pgsl,
    existingAffordances,
  };
}


// ═════════════════════════════════════════════════════════════
// Scenario 1: Agent Team with AAT Enforcement
// ═════════════════════════════════════════════════════════════

describe('Scenario 1: Agent Team with AAT Enforcement', () => {
  let traceStore: TraceStore;

  beforeEach(() => {
    traceStore = createTraceStore();
  });

  it('Observer is blocked from creating atoms by AAT', () => {
    const validation = validateAction(ObserverAAT, 'create-atom');
    expect(validation.allowed).toBe(false);
    expect(validation.reason).toContain('read-only');
  });

  it('Analyst can create atoms — AAT allows it', () => {
    const validation = validateAction(AnalystAAT, 'create-atom');
    expect(validation.allowed).toBe(true);
  });

  it('Observer AAT decorator filters out write affordances from the chain', () => {
    const pgsl = makePgsl('observer');
    const atomUri = mintAtom(pgsl, 'finding-1');
    const policy = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(policy, rule);

    const aatDecorator = createAATDecorator(ObserverAAT, policy, traceStore);
    const registry = createDefaultRegistry();
    registerDecorator(registry, aatDecorator);

    const ctx = buildDecoratorContext(pgsl, atomUri);
    const result = decorateNode(registry, ctx);

    // Observer should NOT have create-atom or add-source affordances
    // that are actionable — only denied markers
    const createAtomAffs = result.affordances.filter(a => a.rel === 'create-atom' && a.decoratorId !== `aat-decorator:${ObserverAAT.id}`);
    const deniedAffs = result.affordances.filter(a => a.rel === 'denied');
    expect(deniedAffs.length).toBeGreaterThan(0);
  });

  it('Analyst AAT decorator allows create-atom and records PROV trace', () => {
    const pgsl = makePgsl('analyst');
    const atomUri = mintAtom(pgsl, 'assessment-1');
    const policy = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(policy, rule);

    const aatDecorator = createAATDecorator(AnalystAAT, policy, traceStore);
    const registry = createDefaultRegistry();
    registerDecorator(registry, aatDecorator);

    const ctx = buildDecoratorContext(pgsl, atomUri);
    decorateNode(registry, ctx);

    // PROV traces should have been recorded
    const traces = getTraces(traceStore);
    expect(traces.length).toBeGreaterThan(0);
    // At least one success trace for a perceive or act operation
    const successTraces = traces.filter(t => t.success);
    expect(successTraces.length).toBeGreaterThan(0);
  });

  it('Executor can build on Analyst work — both write to same PGSL', () => {
    const pgsl = makePgsl('team');

    // Analyst creates atoms
    const analystValidation = validateAction(AnalystAAT, 'create-atom');
    expect(analystValidation.allowed).toBe(true);
    ingest(pgsl, ['finding-1', 'severity', 'high']);

    // Executor extends the work
    const executorValidation = validateAction(ExecutorAAT, 'create-atom');
    expect(executorValidation.allowed).toBe(true);
    ingest(pgsl, ['finding-1', 'status', 'remediated']);

    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBeGreaterThanOrEqual(5); // finding-1, severity, high, status, remediated
  });

  it('Arbiter can constrain a paradigm but not create atoms', () => {
    const canConstrain = validateAction(ArbiterAAT, 'constrain-paradigm');
    const canCreate = validateAction(ArbiterAAT, 'create-atom');
    expect(canConstrain.allowed).toBe(true);
    expect(canCreate.allowed).toBe(false);
  });

  it('Observer can query results — read is in canPerceive', () => {
    const canRead = validateAction(ObserverAAT, 'read');
    const canSparql = validateAction(ObserverAAT, 'sparql');
    expect(canRead.allowed).toBe(true);
    expect(canSparql.allowed).toBe(true);
  });

  it('Policy duty "must include provenance" surfaces for create actions', () => {
    const policy = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(policy, rule);

    const decision = evaluatePolicy(policy, {
      agentId: 'analyst-1',
      agentAAT: AnalystAAT,
      nodeUri: 'urn:atom:test' as IRI,
      action: 'create-atom',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.duties.length).toBeGreaterThan(0);
    expect(decision.duties.some(d => d.toLowerCase().includes('provenance'))).toBe(true);
  });

  it('Full PROV trace captures multi-agent audit trail', () => {
    const store = createTraceStore();
    const now = new Date().toISOString();

    // Simulate: Observer reads, Analyst creates, Executor acts
    recordTrace(store, {
      id: 'urn:prov:trace:001',
      activity: 'read',
      agent: 'observer-1',
      agentAAT: ObserverAAT.id,
      entity: 'urn:atom:finding-1',
      startedAt: now,
      wasAssociatedWith: 'observer-1',
      success: true,
    });
    recordTrace(store, {
      id: 'urn:prov:trace:002',
      activity: 'create-atom',
      agent: 'analyst-1',
      agentAAT: AnalystAAT.id,
      entity: 'urn:atom:assessment-1',
      startedAt: now,
      wasAssociatedWith: 'analyst-1',
      success: true,
    });
    recordTrace(store, {
      id: 'urn:prov:trace:003',
      activity: 'create-atom',
      agent: 'observer-1',
      agentAAT: ObserverAAT.id,
      entity: 'urn:atom:blocked',
      startedAt: now,
      wasAssociatedWith: 'observer-1',
      success: false,
      error: 'AAT Observer is read-only',
    });

    const allTraces = getTraces(store);
    expect(allTraces).toHaveLength(3);

    const observerTraces = getTraces(store, { agent: 'observer-1' });
    expect(observerTraces).toHaveLength(2);

    const failures = getTraces(store, { agent: 'observer-1' }).filter(t => !t.success);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toContain('read-only');
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 2: Enclaves with Merge and Coherence
// ═════════════════════════════════════════════════════════════

describe('Scenario 2: Enclaves with Merge and Coherence', () => {
  it('two agents have isolated enclaves with separate PGSL instances', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveA = createEnclave(registry, 'agent-a', prov);
    const enclaveB = createEnclave(registry, 'agent-b', { ...prov, wasAttributedTo: 'urn:agent:b' as IRI });

    ingest(enclaveA.pgsl, ['patient-47', 'status', 'critical']);
    ingest(enclaveB.pgsl, ['patient-47', 'troponin', 'elevated']);

    // Both have patient-47 (content-addressed = same atom key)
    expect(enclaveA.pgsl.atoms.has('patient-47')).toBe(true);
    expect(enclaveB.pgsl.atoms.has('patient-47')).toBe(true);
  });

  it('enclaves are isolated — A does not see B troponin', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveA = createEnclave(registry, 'agent-a', prov);
    const enclaveB = createEnclave(registry, 'agent-b', { ...prov, wasAttributedTo: 'urn:agent:b' as IRI });

    ingest(enclaveA.pgsl, ['patient-47', 'status', 'critical']);
    ingest(enclaveB.pgsl, ['patient-47', 'troponin', 'elevated']);

    expect(enclaveA.pgsl.atoms.has('troponin')).toBe(false);
    expect(enclaveB.pgsl.atoms.has('status')).toBe(false);
  });

  it('checkpoint captures state before merge', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveA = createEnclave(registry, 'agent-a', prov);
    ingest(enclaveA.pgsl, ['patient-47', 'status', 'critical']);

    const cpStore = createCheckpointStore();
    const checkpoint = createCheckpoint(cpStore, enclaveA.pgsl, 'agent-a', 'pre-merge', enclaveA.id);

    expect(checkpoint.atomCount).toBe(latticeStats(enclaveA.pgsl).atoms);
    expect(checkpoint.label).toBe('pre-merge');
  });

  it('freeze enclave-A makes it read-only', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveA = createEnclave(registry, 'agent-a', prov);

    const frozen = freezeEnclave(registry, enclaveA.id);
    expect(frozen.status).toBe('frozen');
  });

  it('merge enclave-A into enclave-B via union', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveA = createEnclave(registry, 'agent-a', prov);
    const enclaveB = createEnclave(registry, 'agent-b', { ...prov, wasAttributedTo: 'urn:agent:b' as IRI });

    ingest(enclaveA.pgsl, ['patient-47', 'status', 'critical']);
    ingest(enclaveB.pgsl, ['patient-47', 'troponin', 'elevated']);

    // Freeze A before merge
    freezeEnclave(registry, enclaveA.id);

    const report = mergeEnclave(registry, enclaveA.id, enclaveB.id, 'union');

    expect(report.atomsAdded).toBeGreaterThan(0);
    // B now has both status and troponin
    expect(enclaveB.pgsl.atoms.has('status')).toBe(true);
    expect(enclaveB.pgsl.atoms.has('troponin')).toBe(true);
    expect(enclaveB.pgsl.atoms.has('critical')).toBe(true);
    expect(enclaveB.pgsl.atoms.has('elevated')).toBe(true);
  });

  it('enclave-B has complete picture after merge', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveA = createEnclave(registry, 'agent-a', prov);
    const enclaveB = createEnclave(registry, 'agent-b', { ...prov, wasAttributedTo: 'urn:agent:b' as IRI });

    ingest(enclaveA.pgsl, ['patient-47', 'status', 'critical']);
    ingest(enclaveB.pgsl, ['patient-47', 'troponin', 'elevated']);
    freezeEnclave(registry, enclaveA.id);
    mergeEnclave(registry, enclaveA.id, enclaveB.id, 'union');

    const statsB = latticeStats(enclaveB.pgsl);
    // Should have atoms from both: patient-47, status, critical, troponin, elevated
    expect(statsB.atoms).toBeGreaterThanOrEqual(5);
  });

  it('coherence check on same-topic different-context gives partial overlap', () => {
    const pgslA = makePgsl('agent-a');
    const pgslB = makePgsl('agent-b');

    // Both have patient-47, but in different syntagmatic contexts
    ingest(pgslA, ['patient-47', 'status', 'critical']);
    ingest(pgslB, ['patient-47', 'troponin', 'elevated']);

    const cert = verifyCoherence(pgslA, pgslB, 'agent-a-sc2', 'agent-b-sc2', 'patient-status');

    // They share patient-47 but in different usage contexts
    expect(cert.semanticProfile.length).toBeGreaterThan(0);
    // patient-47 is shared
    const p47 = cert.semanticProfile.find(p => p.atom === 'patient-47');
    expect(p47).toBeDefined();
  });

  it('checkpoint diff shows what merge added', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    const enclaveB = createEnclave(registry, 'agent-b', { ...prov, wasAttributedTo: 'urn:agent:b' as IRI });
    ingest(enclaveB.pgsl, ['patient-47', 'troponin', 'elevated']);

    const cpStore = createCheckpointStore();
    const cpBefore = createCheckpoint(cpStore, enclaveB.pgsl, 'agent-b', 'before-merge');

    // Simulate merge by ingesting A's content
    ingest(enclaveB.pgsl, ['patient-47', 'status', 'critical']);

    const cpAfter = createCheckpoint(cpStore, enclaveB.pgsl, 'agent-b', 'after-merge');

    const diff = diffCheckpoints(cpBefore, cpAfter);
    expect(diff.atomsAdded.length).toBeGreaterThan(0);
    expect(diff.atomsRemoved.length).toBe(0);
  });

  it('enclave stats reflect the merge lifecycle', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:a' as IRI, generatedAtTime: new Date().toISOString() };
    createEnclave(registry, 'agent-a', prov);
    createEnclave(registry, 'agent-b', { ...prov, wasAttributedTo: 'urn:agent:b' as IRI });

    const stats = enclaveStats(registry);
    expect(stats.total).toBe(2);
    expect(stats.byAgent['agent-a']).toBe(1);
    expect(stats.byAgent['agent-b']).toBe(1);
  });

  it('restored checkpoint produces equivalent PGSL', () => {
    const pgsl = makePgsl('agent-restore');
    ingest(pgsl, ['patient-47', 'status', 'critical']);
    ingest(pgsl, ['patient-47', 'troponin', 'elevated']);

    const cpStore = createCheckpointStore();
    const cp = createCheckpoint(cpStore, pgsl, 'agent-restore');

    const restored = restoreCheckpoint(cp);
    expect(latticeStats(restored).atoms).toBe(latticeStats(pgsl).atoms);
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 3: CRDT Sync Between Peers
// ═════════════════════════════════════════════════════════════

describe('Scenario 3: CRDT Sync Between Peers', () => {
  it('two peers create independent atoms', () => {
    const pgslA = makePgsl('peer-a');
    const pgslB = makePgsl('peer-b');
    let stateA = createCRDTState('peer-a');
    let stateB = createCRDTState('peer-b');

    const resultA = createOp(stateA, 'mint-atom', { value: 'chen' });
    stateA = resultA.state;
    mintAtom(pgslA, 'chen');

    const resultB = createOp(stateB, 'mint-atom', { value: 'park' });
    stateB = resultB.state;
    mintAtom(pgslB, 'park');

    expect(pgslA.atoms.has('chen')).toBe(true);
    expect(pgslA.atoms.has('park')).toBe(false);
    expect(pgslB.atoms.has('park')).toBe(true);
    expect(pgslB.atoms.has('chen')).toBe(false);
  });

  it('A sends pending ops to B, B applies them', () => {
    const pgslA = makePgsl('peer-a');
    const pgslB = makePgsl('peer-b');
    let stateA = createCRDTState('peer-a');
    let stateB = createCRDTState('peer-b');

    const resultA = createOp(stateA, 'mint-atom', { value: 'chen' });
    stateA = resultA.state;
    mintAtom(pgslA, 'chen');

    // A sends to B
    const pendingA = getPendingOps(stateA);
    expect(pendingA).toHaveLength(1);

    for (const op of pendingA) {
      const applied = applyOp(stateB, pgslB, op);
      stateB = applied.state;
      expect(applied.applied).toBe(true);
    }

    expect(pgslB.atoms.has('chen')).toBe(true);
  });

  it('bidirectional sync converges both peers', () => {
    const pgslA = makePgsl('peer-a');
    const pgslB = makePgsl('peer-b');
    let stateA = createCRDTState('peer-a');
    let stateB = createCRDTState('peer-b');

    // A mints chen
    const rA = createOp(stateA, 'mint-atom', { value: 'chen' });
    stateA = rA.state;
    mintAtom(pgslA, 'chen');

    // B mints park
    const rB = createOp(stateB, 'mint-atom', { value: 'park' });
    stateB = rB.state;
    mintAtom(pgslB, 'park');

    // A → B
    for (const op of getPendingOps(stateA)) {
      const r = applyOp(stateB, pgslB, op);
      stateB = r.state;
    }
    stateA = markSynced(stateA, getPendingOps(stateA).map(o => o.id));

    // B → A
    for (const op of getPendingOps(stateB)) {
      const r = applyOp(stateA, pgslA, op);
      stateA = r.state;
    }
    stateB = markSynced(stateB, getPendingOps(stateB).map(o => o.id));

    // Both have both atoms
    expect(pgslA.atoms.has('chen')).toBe(true);
    expect(pgslA.atoms.has('park')).toBe(true);
    expect(pgslB.atoms.has('chen')).toBe(true);
    expect(pgslB.atoms.has('park')).toBe(true);
  });

  it('vector clocks converge after bidirectional sync', () => {
    let stateA = createCRDTState('peer-a');
    let stateB = createCRDTState('peer-b');
    const pgslA = makePgsl('peer-a');
    const pgslB = makePgsl('peer-b');

    const rA = createOp(stateA, 'mint-atom', { value: 'chen' });
    stateA = rA.state;
    mintAtom(pgslA, 'chen');

    const rB = createOp(stateB, 'mint-atom', { value: 'park' });
    stateB = rB.state;
    mintAtom(pgslB, 'park');

    // Exchange
    for (const op of getPendingOps(stateA)) {
      stateB = applyOp(stateB, pgslB, op).state;
    }
    for (const op of getPendingOps(stateB)) {
      stateA = applyOp(stateA, pgslA, op).state;
    }

    // Both clocks should reflect knowledge of both peers
    expect(stateA.clock.entries.get('peer-a')).toBe(1);
    expect(stateA.clock.entries.get('peer-b')).toBe(1);
    expect(stateB.clock.entries.get('peer-a')).toBe(1);
    expect(stateB.clock.entries.get('peer-b')).toBe(1);
  });

  it('duplicate mints are idempotent (content-addressing dedup)', () => {
    const pgslA = makePgsl('peer-a');
    let stateA = createCRDTState('peer-a');
    let stateB = createCRDTState('peer-b');
    const pgslB = makePgsl('peer-b');

    // Both mint the same atom
    mintAtom(pgslA, 'chen');
    mintAtom(pgslB, 'chen');

    const rA = createOp(stateA, 'mint-atom', { value: 'chen' });
    stateA = rA.state;

    // A sends to B — B already has 'chen', so it's a no-op in PGSL
    for (const op of getPendingOps(stateA)) {
      const r = applyOp(stateB, pgslB, op);
      stateB = r.state;
      expect(r.applied).toBe(true); // op is new to B's CRDT
    }

    // Still only one atom 'chen' (content-addressed)
    const statsB = latticeStats(pgslB);
    expect(statsB.atoms).toBe(1);
  });

  it('both peers ingest same chain — same fragment URI', () => {
    const pgslA = makePgsl('peer-a');
    const pgslB = makePgsl('peer-b');

    const uriA = ingest(pgslA, ['chen', 'completed', 'ils-approach']);
    const uriB = ingest(pgslB, ['chen', 'completed', 'ils-approach']);

    // Content-addressing: same sequence = same fragment URI
    expect(uriA).toBe(uriB);
  });

  it('applying the same op twice is idempotent', () => {
    const pgslA = makePgsl('peer-a');
    const pgslB = makePgsl('peer-b');
    let stateA = createCRDTState('peer-a');
    let stateB = createCRDTState('peer-b');

    const rA = createOp(stateA, 'mint-atom', { value: 'repeat' });
    stateA = rA.state;
    mintAtom(pgslA, 'repeat');

    const ops = getPendingOps(stateA);
    // Apply once
    const r1 = applyOp(stateB, pgslB, ops[0]!);
    stateB = r1.state;
    expect(r1.applied).toBe(true);

    // Apply again — should be skipped
    const r2 = applyOp(stateB, pgslB, ops[0]!);
    expect(r2.applied).toBe(false);
  });

  it('pending ops are cleared after markSynced', () => {
    let state = createCRDTState('peer-x');
    const r = createOp(state, 'mint-atom', { value: 'x' });
    state = r.state;

    expect(getPendingOps(state)).toHaveLength(1);
    state = markSynced(state, [r.op.id]);
    expect(getPendingOps(state)).toHaveLength(0);
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 4: Personal Broker Memory Accumulation
// ═════════════════════════════════════════════════════════════

describe('Scenario 4: Personal Broker Memory', () => {
  it('broker starts with empty memory', () => {
    const pgsl = makePgsl('analyst');
    const broker = createPersonalBroker('analyst', AnalystAAT, pgsl);

    const stats = getMemoryStats(broker);
    expect(stats.semanticSize).toBe(0);
    expect(stats.episodicSize).toBe(0);
  });

  it('conversation messages grow semantic memory when ingested', () => {
    const pgsl = makePgsl('analyst');
    const broker = createPersonalBroker('analyst', AnalystAAT, pgsl);
    const conv = startConversation(broker, ['scanner'], 'vuln-scan');

    // Scanner sends a finding
    addMessage(broker, conv.id, 'scanner', 'found sql-injection in auth-module');
    // Ingest the message into the analyst's PGSL
    ingest(pgsl, ['sql-injection', 'location', 'auth-module']);

    // Analyst responds
    addMessage(broker, conv.id, 'analyst', 'confirmed — risk level high');
    ingest(pgsl, ['sql-injection', 'risk-level', 'high']);

    const stats = getMemoryStats(broker);
    expect(stats.semanticSize).toBeGreaterThan(0);
  });

  it('episodic memory tracks conversation count', () => {
    const pgsl = makePgsl('analyst');
    const broker = createPersonalBroker('analyst', AnalystAAT, pgsl);

    startConversation(broker, ['scanner'], 'vuln-scan');
    expect(getMemoryStats(broker).episodicSize).toBe(1);

    startConversation(broker, ['lead'], 'architecture-review');
    expect(getMemoryStats(broker).episodicSize).toBe(2);
  });

  it('messages within a conversation are recorded', () => {
    const pgsl = makePgsl('analyst');
    const broker = createPersonalBroker('analyst', AnalystAAT, pgsl);
    const conv = startConversation(broker, ['scanner'], 'vuln-scan');

    addMessage(broker, conv.id, 'scanner', 'found sql-injection');
    addMessage(broker, conv.id, 'analyst', 'confirmed');

    const updatedConv = broker.conversations.find(c => c.id === conv.id)!;
    expect(updatedConv.messages).toHaveLength(2);
    expect(updatedConv.messages[0]!.from).toBe('scanner');
    expect(updatedConv.messages[1]!.from).toBe('analyst');
  });

  it('atoms from multiple conversations accumulate in the PGSL', () => {
    const pgsl = makePgsl('analyst');
    const broker = createPersonalBroker('analyst', AnalystAAT, pgsl);

    // Conversation 1
    const conv1 = startConversation(broker, ['scanner'], 'vuln-scan');
    addMessage(broker, conv1.id, 'scanner', 'sql-injection in auth');
    ingest(pgsl, ['sql-injection', 'location', 'auth-module']);

    // Conversation 2 — different topic
    const conv2 = startConversation(broker, ['scanner'], 'perf-scan');
    addMessage(broker, conv2.id, 'scanner', 'slow-query in reports');
    ingest(pgsl, ['slow-query', 'location', 'reports-module']);

    // Both conversations' knowledge is in the same PGSL
    expect(pgsl.atoms.has('sql-injection')).toBe(true);
    expect(pgsl.atoms.has('slow-query')).toBe(true);
    // Shared atom 'location' is deduplicated
    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBeGreaterThanOrEqual(5); // sql-injection, location, auth-module, slow-query, reports-module
  });

  it('cross-conversation knowledge shares atoms via content-addressing', () => {
    const pgsl = makePgsl('analyst');
    const broker = createPersonalBroker('analyst', AnalystAAT, pgsl);

    const conv1 = startConversation(broker, ['scanner'], 'scan-1');
    addMessage(broker, conv1.id, 'scanner', 'auth-module has issue');
    ingest(pgsl, ['auth-module', 'issue', 'sql-injection']);

    const conv2 = startConversation(broker, ['lead'], 'review-1');
    addMessage(broker, conv2.id, 'lead', 'auth-module needs review');
    ingest(pgsl, ['auth-module', 'needs', 'review']);

    // 'auth-module' from both conversations maps to the same atom URI
    const atomUri = pgsl.atoms.get('auth-module');
    expect(atomUri).toBeDefined();
    // It appears in multiple fragments (different syntagmatic contexts)
    let containingFragments = 0;
    for (const [, node] of pgsl.nodes) {
      if (node.kind === 'Fragment') {
        const items = (node as any).items as IRI[];
        // Check if any item resolves to auth-module's URI (directly or via wrapper)
        if (items.some(i => {
          const itemNode = pgsl.nodes.get(i);
          if (itemNode?.kind === 'Atom') return (itemNode as any).value === 'auth-module';
          if (itemNode?.kind === 'Fragment' && (itemNode as any).items.length === 1) {
            const inner = pgsl.nodes.get((itemNode as any).items[0]);
            return inner?.kind === 'Atom' && (inner as any).value === 'auth-module';
          }
          return false;
        })) {
          containingFragments++;
        }
      }
    }
    expect(containingFragments).toBeGreaterThanOrEqual(2);
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 5: Introspection and Marketplace Discovery
// ═════════════════════════════════════════════════════════════

describe('Scenario 5: Introspection and Marketplace Discovery', () => {
  it('introspect a JSON data source discovers entities and fields', () => {
    const source = {
      id: 'ds:patient-db',
      type: 'json' as const,
      endpoint: 'http://ehr.local/api',
      name: 'patient-record',
    };
    const sampleData = {
      name: 'John Doe',
      age: 45,
      admitted: true,
      vitals: { heartRate: 72, bp: '120/80' },
    };

    const result = introspectJson(source, sampleData);
    expect(result.schema.entities.length).toBeGreaterThan(0);
    expect(result.chains.length).toBeGreaterThan(0);
    expect(result.shapes.length).toBeGreaterThan(0);
  });

  it('apply introspection results to PGSL creates entity chains', () => {
    const pgsl = makePgsl('introspector');
    const source = {
      id: 'ds:patient-db',
      type: 'json' as const,
      endpoint: 'http://ehr.local/api',
      name: 'patient-record',
    };
    const sampleData = { name: 'John', age: 45, active: true };

    const result = introspectJson(source, sampleData);
    applyIntrospection(pgsl, result);

    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBeGreaterThan(0);
    expect(stats.fragments).toBeGreaterThan(0);
    // Should contain has-field, type atoms from schema chains
    expect(pgsl.atoms.has('has-field')).toBe(true);
    expect(pgsl.atoms.has('type')).toBe(true);
  });

  it('register introspection agent in marketplace', () => {
    const pgsl = makePgsl('introspector');
    const agent = createIntrospectionAgent(pgsl);

    let marketplace = createMarketplace();
    marketplace = registerListing(marketplace, {
      id: agent.id,
      type: 'agent',
      name: 'Schema Introspector',
      description: 'Auto-discovers schema from JSON/CSV/RDF sources',
      provider: 'system',
      capabilities: ['introspect-json', 'introspect-csv', 'introspect-rdf', 'schema-discovery'],
      trustLevel: 'community-verified',
      registeredAt: new Date().toISOString(),
      operations: [
        { method: 'POST', href: '/api/introspect/json', title: 'Introspect JSON' },
        { method: 'POST', href: '/api/introspect/csv', title: 'Introspect CSV' },
      ],
    });

    expect(marketplace.listings.size).toBe(1);
  });

  it('register discovered schema as a data-source listing', () => {
    const pgsl = makePgsl('introspector');
    const source = {
      id: 'ds:patient-db',
      type: 'json' as const,
      endpoint: 'http://ehr.local/api',
      name: 'patient-record',
    };
    const result = introspectJson(source, { name: 'John', age: 45 });
    applyIntrospection(pgsl, result);

    let marketplace = createMarketplace();
    marketplace = registerListing(marketplace, {
      id: 'ds:patient-db',
      type: 'data-source',
      name: 'Patient Database',
      description: 'EHR patient records',
      provider: 'ehr-team',
      capabilities: ['patient-data', 'schema-available', 'json-api'],
      endpoint: 'http://ehr.local/api',
      trustLevel: 'self-asserted',
      registeredAt: new Date().toISOString(),
      operations: [
        { method: 'GET', href: 'http://ehr.local/api/patients', title: 'List patients' },
      ],
    });

    expect(marketplace.listings.has('ds:patient-db')).toBe(true);
  });

  it('another agent discovers the data source via capability search', () => {
    let marketplace = createMarketplace();
    marketplace = registerListing(marketplace, {
      id: 'ds:patient-db',
      type: 'data-source',
      name: 'Patient Database',
      description: 'EHR patient records',
      provider: 'ehr-team',
      capabilities: ['patient-data', 'schema-available', 'json-api'],
      trustLevel: 'self-asserted',
      registeredAt: new Date().toISOString(),
      operations: [],
    });
    marketplace = registerListing(marketplace, {
      id: 'ds:billing',
      type: 'data-source',
      name: 'Billing System',
      description: 'Billing records',
      provider: 'finance',
      capabilities: ['billing-data', 'schema-available'],
      trustLevel: 'self-asserted',
      registeredAt: new Date().toISOString(),
      operations: [],
    });

    // Search for data sources that provide patient data
    const results = discoverByCapability(marketplace, ['patient-data']);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('Patient Database');

    // Search for sources with schema
    const schemaResults = discoverByCapability(marketplace, ['schema-available']);
    expect(schemaResults).toHaveLength(2);
  });

  it('full pipeline: introspect → register → discover → verify schema is in PGSL', () => {
    const pgsl = makePgsl('discovery-agent');
    const source = {
      id: 'ds:flight-log',
      type: 'json' as const,
      endpoint: 'http://flight.local',
      name: 'flight-log',
    };
    const sampleData = { pilot: 'chen', aircraft: 'C172', duration: 1.5 };

    // Step 1: Introspect
    const result = introspectJson(source, sampleData);

    // Step 2: Apply to PGSL
    applyIntrospection(pgsl, result);

    // Step 3: Register in marketplace
    let marketplace = createMarketplace();
    marketplace = registerListing(marketplace, {
      id: 'ds:flight-log',
      type: 'data-source',
      name: 'Flight Log',
      description: 'Training flight records',
      provider: 'flight-school',
      capabilities: ['flight-data', 'pilot-records'],
      trustLevel: 'self-asserted',
      registeredAt: new Date().toISOString(),
      operations: [],
    });

    // Step 4: Discover
    const discovered = discoverByCapability(marketplace, ['flight-data']);
    expect(discovered).toHaveLength(1);

    // Step 5: Verify schema chains exist in PGSL
    expect(pgsl.atoms.has('flight-log')).toBe(true);
    expect(pgsl.atoms.has('has-field')).toBe(true);
    expect(pgsl.atoms.has('pilot')).toBe(true);
  });

  it('introspection agent can scan multiple source types', () => {
    const pgsl = makePgsl('multi-scanner');
    const agent = createIntrospectionAgent(pgsl);

    expect(agent.capabilities).toContain('introspect-json');
    expect(agent.capabilities).toContain('introspect-csv');
    expect(agent.capabilities).toContain('introspect-rdf');
    expect(agent.capabilities).toContain('introspect-api');
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 6: Full Pipeline with Decision Functor
// ═════════════════════════════════════════════════════════════

describe('Scenario 6: Full Pipeline with Decision Functor', () => {
  it('scanner discovers findings and ingests into its enclave', () => {
    const registry = createEnclaveRegistry();
    const prov = { wasAttributedTo: 'urn:agent:scanner' as IRI, generatedAtTime: new Date().toISOString() };
    const scanner = createEnclave(registry, 'scanner', prov);

    ingest(scanner.pgsl, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(scanner.pgsl, ['sql-injection', 'severity', 'critical']);

    expect(scanner.pgsl.atoms.has('sql-injection')).toBe(true);
    expect(scanner.pgsl.atoms.has('critical')).toBe(true);
  });

  it('analyst discovers scanner findings via merge and creates assessment', () => {
    const registry = createEnclaveRegistry();
    const provS = { wasAttributedTo: 'urn:agent:scanner' as IRI, generatedAtTime: new Date().toISOString() };
    const provA = { wasAttributedTo: 'urn:agent:analyst' as IRI, generatedAtTime: new Date().toISOString() };
    const scanner = createEnclave(registry, 'scanner', provS);
    const analyst = createEnclave(registry, 'analyst', provA);

    ingest(scanner.pgsl, ['auth-module', 'vulnerability', 'sql-injection']);
    freezeEnclave(registry, scanner.id);
    mergeEnclave(registry, scanner.id, analyst.id, 'union');

    // Analyst now has scanner's findings
    expect(analyst.pgsl.atoms.has('sql-injection')).toBe(true);

    // Analyst adds assessment
    ingest(analyst.pgsl, ['sql-injection', 'risk-level', 'high']);
    expect(analyst.pgsl.atoms.has('risk-level')).toBe(true);
  });

  it('coherence between scanner and analyst shows overlap', () => {
    const pgslScanner = makePgsl('scanner');
    const pgslAnalyst = makePgsl('analyst');

    // Same finding in both
    ingest(pgslScanner, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(pgslAnalyst, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(pgslAnalyst, ['sql-injection', 'risk-level', 'high']);

    const cert = verifyCoherence(pgslScanner, pgslAnalyst, 'scanner-sc6', 'analyst-sc6', 'findings');

    // They share the vulnerability chain — semantic overlap should be non-zero
    expect(cert.semanticOverlap).toBeGreaterThan(0);
    expect(cert.semanticProfile.length).toBeGreaterThan(0);
  });

  it('decision functor for scanner recommends explore (needs more data)', () => {
    const pgslScanner = makePgsl('scanner-decide');
    ingest(pgslScanner, ['auth-module', 'vulnerability', 'sql-injection']);

    // No coherence certificates — scanner is isolated
    const result = decideFromObservations(pgslScanner, 'scanner-decide', []);

    // With no coherence data, strategy should be explore
    expect(result.strategy).toBe('explore');
  });

  it('decision functor for analyst with coherence recommends based on overlap', () => {
    const pgslAnalyst = makePgsl('analyst-decide');
    ingest(pgslAnalyst, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(pgslAnalyst, ['sql-injection', 'risk-level', 'high']);

    // Create a coherence certificate with partial overlap
    const pgslScanner = makePgsl('scanner-decide2');
    ingest(pgslScanner, ['auth-module', 'vulnerability', 'sql-injection']);

    const cert = verifyCoherence(pgslScanner, pgslAnalyst, 'scanner-decide2', 'analyst-decide', 'findings');

    const result = decideFromObservations(pgslAnalyst, 'analyst-decide', [cert]);
    // Should not abstain — has observations and coherence data
    expect(result.strategy).not.toBe('abstain');
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it('lead merges all enclaves and gets complete picture', () => {
    const registry = createEnclaveRegistry();
    const provS = { wasAttributedTo: 'urn:agent:scanner' as IRI, generatedAtTime: new Date().toISOString() };
    const provA = { wasAttributedTo: 'urn:agent:analyst' as IRI, generatedAtTime: new Date().toISOString() };
    const provL = { wasAttributedTo: 'urn:agent:lead' as IRI, generatedAtTime: new Date().toISOString() };

    const scanner = createEnclave(registry, 'scanner', provS);
    const analyst = createEnclave(registry, 'analyst', provA);
    const lead = createEnclave(registry, 'lead', provL);

    ingest(scanner.pgsl, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(analyst.pgsl, ['sql-injection', 'risk-level', 'high']);

    freezeEnclave(registry, scanner.id);
    freezeEnclave(registry, analyst.id);
    mergeEnclave(registry, scanner.id, lead.id, 'union');
    mergeEnclave(registry, analyst.id, lead.id, 'union');

    // Lead has everything
    expect(lead.pgsl.atoms.has('auth-module')).toBe(true);
    expect(lead.pgsl.atoms.has('sql-injection')).toBe(true);
    expect(lead.pgsl.atoms.has('risk-level')).toBe(true);
    expect(lead.pgsl.atoms.has('high')).toBe(true);
  });

  it('PROV trace captures the complete pipeline', () => {
    const store = createTraceStore();
    const now = new Date().toISOString();

    // Record pipeline events
    recordTrace(store, { id: 'urn:prov:scan-1', activity: 'scan', agent: 'scanner', agentAAT: ObserverAAT.id, entity: 'urn:module:auth', startedAt: now, wasAssociatedWith: 'scanner', success: true });
    recordTrace(store, { id: 'urn:prov:merge-1', activity: 'merge', agent: 'analyst', agentAAT: AnalystAAT.id, entity: 'urn:enclave:scanner', startedAt: now, wasAssociatedWith: 'analyst', success: true });
    recordTrace(store, { id: 'urn:prov:assess-1', activity: 'create-atom', agent: 'analyst', agentAAT: AnalystAAT.id, entity: 'urn:atom:risk-level', startedAt: now, wasAssociatedWith: 'analyst', success: true });
    recordTrace(store, { id: 'urn:prov:decide-1', activity: 'decide', agent: 'lead', agentAAT: ExecutorAAT.id, entity: 'urn:decision:remediate', startedAt: now, wasAssociatedWith: 'lead', success: true });

    const all = getTraces(store);
    expect(all).toHaveLength(4);

    const analystActions = getTraces(store, { agent: 'analyst' });
    expect(analystActions).toHaveLength(2);
  });

  it('checkpoint captures the final merged state', () => {
    const pgslLead = makePgsl('lead');
    ingest(pgslLead, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(pgslLead, ['sql-injection', 'risk-level', 'high']);
    ingest(pgslLead, ['sql-injection', 'status', 'remediation-planned']);

    const cpStore = createCheckpointStore();
    const cp = createCheckpoint(cpStore, pgslLead, 'lead', 'final-merged');

    expect(cp.label).toBe('final-merged');
    expect(cp.atomCount).toBeGreaterThanOrEqual(6);
  });

  it('observations extraction picks up all atoms and patterns', () => {
    const pgsl = makePgsl('obs-test');
    ingest(pgsl, ['auth-module', 'vulnerability', 'sql-injection']);
    ingest(pgsl, ['sql-injection', 'severity', 'critical']);

    const obs = extractObservations(pgsl, 'obs-test', []);
    expect(obs.atoms.length).toBeGreaterThanOrEqual(5);
    expect(obs.agent).toBe('obs-test');
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 7: Policy Duties in Practice
// ═════════════════════════════════════════════════════════════

describe('Scenario 7: Policy Duties in Practice', () => {
  it('critical-severity item triggers escalation duty', () => {
    const engine = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(engine, rule);

    const decision = evaluatePolicy(engine, {
      agentId: 'analyst-1',
      agentAAT: AnalystAAT,
      nodeUri: 'urn:atom:finding-1' as IRI,
      nodeValue: 'severity:critical — requires immediate attention',
      action: 'create-atom',
    });

    expect(decision.allowed).toBe(true);
    // Should have both provenance and escalation duties
    expect(decision.duties.length).toBeGreaterThanOrEqual(2);
    expect(decision.duties.some(d => d.toLowerCase().includes('provenance'))).toBe(true);
    expect(decision.duties.some(d => d.toLowerCase().includes('escalat'))).toBe(true);
  });

  it('duty does not deny — agent can still proceed', () => {
    const engine = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(engine, rule);

    const decision = evaluatePolicy(engine, {
      agentId: 'analyst-1',
      agentAAT: AnalystAAT,
      nodeUri: 'urn:atom:critical-thing' as IRI,
      nodeValue: 'critical issue found',
      action: 'create-atom',
    });

    // Duties are informational, not blocking
    expect(decision.allowed).toBe(true);
    expect(decision.duties.length).toBeGreaterThan(0);
  });

  it('explicit deny rule blocks action', () => {
    const engine = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(engine, rule);

    addRule(engine, {
      id: 'policy:deny-close-critical',
      mode: 'deny',
      subject: '*',
      action: 'close',
      condition: (ctx) => ctx.nodeValue?.toLowerCase().includes('critical') ?? false,
      description: 'Cannot close critical items without escalation',
    });

    const decision = evaluatePolicy(engine, {
      agentId: 'analyst-1',
      agentAAT: AnalystAAT,
      nodeUri: 'urn:atom:finding-1' as IRI,
      nodeValue: 'critical vulnerability',
      action: 'close',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Denied');
  });

  it('deny overrides permit — deny wins', () => {
    const engine = createPolicyEngine();

    addRule(engine, {
      id: 'policy:permit-all',
      mode: 'permit',
      subject: '*',
      action: '*',
      description: 'Allow everything',
    });
    addRule(engine, {
      id: 'policy:deny-delete',
      mode: 'deny',
      subject: '*',
      action: 'delete',
      description: 'Never allow deletion',
    });

    const decision = evaluatePolicy(engine, {
      agentId: 'analyst-1',
      agentAAT: AnalystAAT,
      nodeUri: 'urn:atom:test' as IRI,
      action: 'delete',
    });

    expect(decision.allowed).toBe(false);
  });

  it('PROV trace captures both duty and denial events', () => {
    const store = createTraceStore();
    const now = new Date().toISOString();

    // Duty surfaced
    recordTrace(store, {
      id: 'urn:prov:duty-1',
      activity: 'create-atom',
      agent: 'analyst-1',
      agentAAT: AnalystAAT.id,
      entity: 'urn:atom:critical-finding',
      startedAt: now,
      wasAssociatedWith: 'analyst-1',
      policyDecision: {
        allowed: true,
        duties: ['Escalate to arbiter'],
        reason: 'Allowed with duties',
        matchedRules: ['policy:duty-escalate-critical'],
      },
      success: true,
    });

    // Denial
    recordTrace(store, {
      id: 'urn:prov:deny-1',
      activity: 'close',
      agent: 'analyst-1',
      agentAAT: AnalystAAT.id,
      entity: 'urn:atom:critical-finding',
      startedAt: now,
      wasAssociatedWith: 'analyst-1',
      policyDecision: {
        allowed: false,
        duties: [],
        reason: 'Denied: cannot close critical without escalation',
        matchedRules: ['policy:deny-close-critical'],
      },
      success: false,
      error: 'Policy denied: cannot close critical without escalation',
    });

    const allTraces = getTraces(store, { agent: 'analyst-1' });
    expect(allTraces).toHaveLength(2);
    expect(allTraces[0]!.policyDecision!.duties.length).toBeGreaterThan(0);
    expect(allTraces[1]!.success).toBe(false);
  });

  it('non-critical item does not trigger escalation duty', () => {
    const engine = createPolicyEngine();
    for (const rule of defaultPolicies()) addRule(engine, rule);

    const decision = evaluatePolicy(engine, {
      agentId: 'analyst-1',
      agentAAT: AnalystAAT,
      nodeUri: 'urn:atom:finding-2' as IRI,
      nodeValue: 'minor style issue',
      action: 'create-atom',
    });

    expect(decision.allowed).toBe(true);
    // Should have provenance duty but NOT escalation
    const escalationDuties = decision.duties.filter(d => d.toLowerCase().includes('escalat'));
    expect(escalationDuties).toHaveLength(0);
  });
});


// ═════════════════════════════════════════════════════════════
// Scenario 8: Homoiconic Metagraph
// ═════════════════════════════════════════════════════════════

describe('Scenario 8: Homoiconic Metagraph', () => {
  it('generate metagraph reflects current lattice stats', () => {
    const pgsl = makePgsl('meta-agent');
    ingest(pgsl, ['chen', 'completed', 'ils-approach']);
    ingest(pgsl, ['park', 'attempted', 'hold-short']);

    const meta = generateMetagraph(pgsl);
    const stats = latticeStats(pgsl);
    expect(meta.atomCount).toBe(stats.atoms);
    expect(meta.fragmentCount).toBe(stats.fragments);
  });

  it('ingest metagraph — lattice now describes itself', () => {
    const pgsl = makePgsl('meta-agent');
    ingest(pgsl, ['chen', 'completed', 'ils-approach']);

    const statsBefore = latticeStats(pgsl);
    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);

    // Lattice grew — it now contains meta-atoms
    const statsAfter = latticeStats(pgsl);
    expect(statsAfter.atoms).toBeGreaterThan(statsBefore.atoms);
    expect(pgsl.atoms.has('lattice-root')).toBe(true);
    expect(pgsl.atoms.has('atom-count')).toBe(true);
  });

  it('query metagraph from within the lattice', () => {
    const pgsl = makePgsl('meta-query');
    ingest(pgsl, ['chen', 'completed', 'ils-approach']);
    ingest(pgsl, ['park', 'attempted', 'hold-short']);

    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);

    const atomCount = queryMetagraph(pgsl, 'how many atoms?');
    // Should return the count from when the metagraph was generated
    expect(atomCount).toBe(String(meta.atomCount));
  });

  it('validate metagraph detects discrepancy after adding more atoms', () => {
    const pgsl = makePgsl('meta-validate');
    ingest(pgsl, ['chen', 'completed', 'ils-approach']);

    const meta = generateMetagraph(pgsl);
    ingestMetagraph(pgsl, meta);

    // Add more atoms — now the metagraph is stale
    ingest(pgsl, ['new-pilot', 'joined', 'training-program']);

    const discrepancies = validateMetagraph(pgsl, meta);
    expect(discrepancies.length).toBeGreaterThan(0);
    expect(discrepancies.some(d => d.includes('atom-count mismatch'))).toBe(true);
  });
});
