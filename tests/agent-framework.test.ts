import { describe, it, expect, beforeEach } from 'vitest';
import {
  addMessage,
  addRule,
  AnalystAAT,
  ArbiterAAT,
  ArchivistAAT,
  createAATDecorator,
  createAATRegistry,
  createPersonalBroker,
  createPolicyEngine,
  createTraceStore,
  defaultPolicies,
  evaluatePolicy,
  ExecutorAAT,
  filterAffordancesByAAT,
  FullAccessAAT,
  getAAT,
  getMemoryStats,
  getTraces,
  ObserverAAT,
  recordTrace,
  registerAAT,
  removeRule,
  setPresence,
  startConversation,
  traceToTurtle,
  validateAction,
  wrapWithTracing,
} from '@interego/core';
import {
  createPGSL,
} from '@interego/pgsl';
import type {
  AbstractAgentType,
  DecoratedAffordance,
  PolicyContext,
  PolicyRule,
  ProvTrace,
} from '@interego/core';
import type {
  IRI,
} from '@interego/core';

// ── Test helpers ──────────────────────────────────────────────

function makePgsl() {
  return createPGSL({
    wasAttributedTo: 'test-agent' as IRI,
    generatedAtTime: new Date().toISOString(),
  });
}

function mockAffordance(rel: string, method = 'POST'): DecoratedAffordance {
  return {
    rel,
    title: rel,
    method,
    href: '/api/test',
    decoratorId: 'test',
    decoratorName: 'test',
    trustLevel: 'system',
    confidence: 1,
  };
}

function makePolicyContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    agentId: 'agent:alice',
    agentAAT: ObserverAAT,
    nodeUri: 'urn:test:node1' as IRI,
    action: 'read',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ProvTrace> = {}): ProvTrace {
  return {
    id: 'urn:prov:trace:abc123',
    activity: 'create-atom',
    agent: 'agent:alice',
    agentAAT: 'aat:analyst',
    entity: 'urn:test:node1',
    startedAt: '2026-04-05T10:00:00.000Z',
    wasAssociatedWith: 'agent:alice',
    success: true,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════
// 1. Abstract Agent Types (AAT)
// ══════════════════════════════════════════════════════════════

describe('Abstract Agent Types', () => {
  describe('built-in AATs', () => {
    it('ObserverAAT can perceive but not act', () => {
      expect(ObserverAAT.canPerceive.length).toBeGreaterThan(0);
      expect(ObserverAAT.canAct).toEqual([]);
      expect(ObserverAAT.canPerceive).toContain('read');
      expect(ObserverAAT.canPerceive).toContain('sparql');
    });

    it('AnalystAAT can perceive and create', () => {
      expect(AnalystAAT.canPerceive.length).toBeGreaterThan(0);
      expect(AnalystAAT.canAct.length).toBeGreaterThan(0);
      expect(AnalystAAT.canAct).toContain('create-atom');
      expect(AnalystAAT.canAct).toContain('add-source');
    });

    it('ExecutorAAT can act on decisions', () => {
      expect(ExecutorAAT.canAct).toContain('create-atom');
      expect(ExecutorAAT.canAct).toContain('promote');
      expect(ExecutorAAT.canAct).toContain('constrain-paradigm');
    });

    it('ArbiterAAT can approve but not create', () => {
      expect(ArbiterAAT.canAct).toContain('constrain-paradigm');
      expect(ArbiterAAT.canAct).toContain('verify-coherence');
      expect(ArbiterAAT.canAct).not.toContain('create-atom');
    });

    it('ArchivistAAT can persist', () => {
      expect(ArchivistAAT.canAct).toContain('promote');
      expect(ArchivistAAT.canAct).toContain('wrap-group');
      expect(ArchivistAAT.canPerceive).toContain('discover-remote');
    });

    it('FullAccessAAT has wildcard access', () => {
      expect(FullAccessAAT.canPerceive).toContain('*');
      expect(FullAccessAAT.canAct).toContain('*');
    });

    it('all built-in AATs have required fields', () => {
      for (const aat of [ObserverAAT, AnalystAAT, ExecutorAAT, ArbiterAAT, ArchivistAAT, FullAccessAAT]) {
        expect(aat.id).toBeTruthy();
        expect(aat.name).toBeTruthy();
        expect(aat.description).toBeTruthy();
        expect(aat.mustPreserve).toContain('provenance');
      }
    });
  });

  describe('AATRegistry', () => {
    it('createAATRegistry starts with built-in types', () => {
      const registry = createAATRegistry();
      expect(registry.aats.size).toBe(6);
    });

    it('registerAAT adds a custom AAT to the registry', () => {
      const registry = createAATRegistry();
      const custom: AbstractAgentType = {
        id: 'aat:custom',
        name: 'Custom',
        description: 'Custom agent',
        canPerceive: ['read'],
        canAct: ['create-atom'],
        mustPreserve: ['provenance'],
      };
      registerAAT(registry, custom);
      expect(registry.aats.size).toBe(7);
    });

    it('getAAT retrieves by ID', () => {
      const registry = createAATRegistry();
      const observer = getAAT(registry, 'aat:observer');
      expect(observer).toBeDefined();
      expect(observer!.name).toBe('Observer');
    });

    it('getAAT returns undefined for unknown ID', () => {
      const registry = createAATRegistry();
      expect(getAAT(registry, 'aat:nonexistent')).toBeUndefined();
    });
  });

  describe('filterAffordancesByAAT', () => {
    const readAff = mockAffordance('read', 'GET');
    const sparqlAff = mockAffordance('sparql', 'POST');
    const chainViewAff = mockAffordance('chain-view', 'GET');
    const createAtomAff = mockAffordance('create-atom', 'POST');
    const addSourceAff = mockAffordance('add-source', 'POST');
    const promoteAff = mockAffordance('promote', 'POST');
    const allAffs = [readAff, sparqlAff, chainViewAff, createAtomAff, addSourceAff, promoteAff];

    it('Observer filters out write affordances', () => {
      const result = filterAffordancesByAAT(allAffs, ObserverAAT);
      const rels = result.map(a => a.rel);
      expect(rels).not.toContain('create-atom');
      expect(rels).not.toContain('add-source');
      expect(rels).not.toContain('promote');
    });

    it('Observer keeps read affordances', () => {
      const result = filterAffordancesByAAT(allAffs, ObserverAAT);
      const rels = result.map(a => a.rel);
      expect(rels).toContain('read');
      expect(rels).toContain('sparql');
      expect(rels).toContain('chain-view');
    });

    it('Analyst keeps its allowed act affordances', () => {
      const result = filterAffordancesByAAT(allAffs, AnalystAAT);
      const rels = result.map(a => a.rel);
      expect(rels).toContain('create-atom');
      expect(rels).toContain('add-source');
      // Analyst cannot promote
      expect(rels).not.toContain('promote');
    });

    it('Executor keeps write affordances it can act on', () => {
      const result = filterAffordancesByAAT(allAffs, ExecutorAAT);
      const rels = result.map(a => a.rel);
      expect(rels).toContain('create-atom');
      expect(rels).toContain('promote');
    });

    it('FullAccess (wildcard) keeps everything', () => {
      const result = filterAffordancesByAAT(allAffs, FullAccessAAT);
      expect(result.length).toBe(allAffs.length);
    });

    it('empty canPerceive and canAct filters everything', () => {
      const emptyAAT: AbstractAgentType = {
        id: 'aat:empty',
        name: 'Empty',
        description: 'No access',
        canPerceive: [],
        canAct: [],
        mustPreserve: [],
      };
      const result = filterAffordancesByAAT(allAffs, emptyAAT);
      expect(result.length).toBe(0);
    });
  });

  describe('validateAction', () => {
    it('Observer cannot create-atom', () => {
      const result = validateAction(ObserverAAT, 'create-atom');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('Observer');
    });

    it('Observer is read-only — reason says so', () => {
      const result = validateAction(ObserverAAT, 'promote');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });

    it('Analyst can create-atom', () => {
      const result = validateAction(AnalystAAT, 'create-atom');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('FullAccess can do anything', () => {
      expect(validateAction(FullAccessAAT, 'create-atom').allowed).toBe(true);
      expect(validateAction(FullAccessAAT, 'delete').allowed).toBe(true);
      expect(validateAction(FullAccessAAT, 'read').allowed).toBe(true);
    });

    it('returns reason string when denied', () => {
      const result = validateAction(ArbiterAAT, 'create-atom');
      expect(result.allowed).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result.reason!.length).toBeGreaterThan(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 2. Deontic Policy Engine
// ══════════════════════════════════════════════════════════════

describe('Deontic Policy Engine', () => {
  describe('createPolicyEngine + addRule + removeRule', () => {
    it('starts with no rules', () => {
      const engine = createPolicyEngine();
      expect(engine.rules.length).toBe(0);
    });

    it('can add permit rule', () => {
      const engine = createPolicyEngine();
      addRule(engine, {
        id: 'r1',
        mode: 'permit',
        subject: '*',
        action: 'read',
        description: 'Everyone can read',
      });
      expect(engine.rules.length).toBe(1);
      expect(engine.rules[0]!.mode).toBe('permit');
    });

    it('can add deny and duty rules', () => {
      const engine = createPolicyEngine();
      addRule(engine, {
        id: 'r-deny',
        mode: 'deny',
        subject: '*',
        action: 'delete',
        description: 'No delete',
      });
      addRule(engine, {
        id: 'r-duty',
        mode: 'duty',
        subject: '*',
        action: '*',
        description: 'Must log',
      });
      expect(engine.rules.length).toBe(2);
      expect(engine.rules.map(r => r.mode)).toEqual(['deny', 'duty']);
    });

    it('can remove rules by ID', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'r1', mode: 'permit', subject: '*', action: 'read', description: 'read ok' });
      addRule(engine, { id: 'r2', mode: 'deny', subject: '*', action: 'delete', description: 'no delete' });
      removeRule(engine, 'r1');
      expect(engine.rules.length).toBe(1);
      expect(engine.rules[0]!.id).toBe('r2');
    });
  });

  describe('evaluate', () => {
    it('default (no rules) is allowed', () => {
      const engine = createPolicyEngine();
      const decision = evaluatePolicy(engine, makePolicyContext());
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toContain('default');
    });

    it('permit rule matches -> allowed', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'p1', mode: 'permit', subject: '*', action: 'read', description: 'read ok' });
      const decision = evaluatePolicy(engine, makePolicyContext({ action: 'read' }));
      expect(decision.allowed).toBe(true);
      expect(decision.matchedRules).toContain('p1');
    });

    it('deny rule matches -> denied', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'd1', mode: 'deny', subject: '*', action: 'delete', description: 'no delete' });
      const decision = evaluatePolicy(engine, makePolicyContext({ action: 'delete' }));
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Denied');
    });

    it('deny overrides permit (same action)', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'p1', mode: 'permit', subject: '*', action: 'delete', description: 'allow delete' });
      addRule(engine, { id: 'd1', mode: 'deny', subject: '*', action: 'delete', description: 'no delete' });
      const decision = evaluatePolicy(engine, makePolicyContext({ action: 'delete' }));
      expect(decision.allowed).toBe(false);
      expect(decision.matchedRules).toContain('p1');
      expect(decision.matchedRules).toContain('d1');
    });

    it('duty accumulates alongside permit', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'p1', mode: 'permit', subject: '*', action: 'create-atom', description: 'allow create' });
      addRule(engine, { id: 'duty1', mode: 'duty', subject: '*', action: 'create-atom', description: 'must log provenance' });
      const decision = evaluatePolicy(engine, makePolicyContext({ action: 'create-atom' }));
      expect(decision.allowed).toBe(true);
      expect(decision.duties).toContain('must log provenance');
    });

    it('subject matching: specific agent ID', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'p1', mode: 'deny', subject: 'agent:bob', action: '*', description: 'bob denied' });
      // Alice should not match
      const aliceDecision = evaluatePolicy(engine, makePolicyContext({ agentId: 'agent:alice', action: 'read' }));
      expect(aliceDecision.allowed).toBe(true);
      // Bob should match
      const bobDecision = evaluatePolicy(engine, makePolicyContext({ agentId: 'agent:bob', action: 'read' }));
      expect(bobDecision.allowed).toBe(false);
    });

    it('subject matching: wildcard * matches all', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'p1', mode: 'deny', subject: '*', action: 'delete', description: 'no delete for anyone' });
      const decision = evaluatePolicy(engine, makePolicyContext({ agentId: 'agent:unknown', action: 'delete' }));
      expect(decision.allowed).toBe(false);
    });

    it('action matching: specific rel', () => {
      const engine = createPolicyEngine();
      addRule(engine, { id: 'p1', mode: 'deny', subject: '*', action: 'delete', description: 'no delete' });
      // read should not match the deny rule
      const readDecision = evaluatePolicy(engine, makePolicyContext({ action: 'read' }));
      expect(readDecision.allowed).toBe(true);
    });

    it('target matching: specific URI', () => {
      const engine = createPolicyEngine();
      addRule(engine, {
        id: 'p1', mode: 'deny', subject: '*', action: '*',
        target: 'urn:test:protected',
        description: 'protected node',
      });
      const protectedDecision = evaluatePolicy(engine, makePolicyContext({ nodeUri: 'urn:test:protected' as IRI }));
      expect(protectedDecision.allowed).toBe(false);
      const otherDecision = evaluatePolicy(engine, makePolicyContext({ nodeUri: 'urn:test:other' as IRI }));
      expect(otherDecision.allowed).toBe(true);
    });

    it('condition function evaluated', () => {
      const engine = createPolicyEngine();
      addRule(engine, {
        id: 'c1', mode: 'deny', subject: '*', action: '*',
        condition: (ctx) => ctx.nodeValue?.includes('sensitive') ?? false,
        description: 'deny on sensitive content',
      });
      const normalDecision = evaluatePolicy(engine, makePolicyContext({ nodeValue: 'normal data' } as any));
      expect(normalDecision.allowed).toBe(true);
      const sensitiveDecision = evaluatePolicy(engine, makePolicyContext({ nodeValue: 'sensitive data' } as any));
      expect(sensitiveDecision.allowed).toBe(false);
    });
  });

  describe('defaultPolicies', () => {
    it('returns non-empty array', () => {
      const policies = defaultPolicies();
      expect(policies.length).toBeGreaterThan(0);
    });

    it('includes deny-delete rule', () => {
      const policies = defaultPolicies();
      const denyDelete = policies.find(p => p.id === 'policy:deny-delete');
      expect(denyDelete).toBeDefined();
      expect(denyDelete!.mode).toBe('deny');
      expect(denyDelete!.action).toBe('delete');
    });

    it('includes duty-provenance rule', () => {
      const policies = defaultPolicies();
      const dutyProv = policies.find(p => p.id === 'policy:duty-provenance');
      expect(dutyProv).toBeDefined();
      expect(dutyProv!.mode).toBe('duty');
      expect(dutyProv!.action).toBe('create-atom');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 3. PROV Action Tracing
// ══════════════════════════════════════════════════════════════

describe('PROV Action Tracing', () => {
  describe('TraceStore', () => {
    it('createTraceStore starts empty', () => {
      const store = createTraceStore();
      expect(store.traces.length).toBe(0);
    });

    it('recordTrace appends immutably', () => {
      const store = createTraceStore();
      const trace1 = makeTrace({ id: 'urn:prov:trace:001' });
      const trace2 = makeTrace({ id: 'urn:prov:trace:002', agent: 'agent:bob' });
      recordTrace(store, trace1);
      recordTrace(store, trace2);
      expect(store.traces.length).toBe(2);
      expect(store.traces[0]!.id).toBe('urn:prov:trace:001');
      expect(store.traces[1]!.id).toBe('urn:prov:trace:002');
    });

    it('getTraces returns all when no filter', () => {
      const store = createTraceStore();
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:a' }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:b' }));
      const result = getTraces(store);
      expect(result.length).toBe(2);
    });

    it('getTraces with agent filter', () => {
      const store = createTraceStore();
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:a', agent: 'agent:alice' }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:b', agent: 'agent:bob' }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:c', agent: 'agent:alice' }));
      const result = getTraces(store, { agent: 'agent:alice' });
      expect(result.length).toBe(2);
      expect(result.every(t => t.agent === 'agent:alice')).toBe(true);
    });

    it('getTraces with activity filter', () => {
      const store = createTraceStore();
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:a', activity: 'create-atom' }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:b', activity: 'read' }));
      const result = getTraces(store, { activity: 'read' });
      expect(result.length).toBe(1);
      expect(result[0]!.activity).toBe('read');
    });

    it('getTraces with time range filter', () => {
      const store = createTraceStore();
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:a', startedAt: '2026-04-01T00:00:00Z' }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:b', startedAt: '2026-04-05T00:00:00Z' }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:c', startedAt: '2026-04-10T00:00:00Z' }));

      const result = getTraces(store, {
        startAfter: '2026-04-03T00:00:00Z',
        startBefore: '2026-04-07T00:00:00Z',
      });
      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe('urn:prov:trace:b');
    });

    it('getTraces with successOnly filter', () => {
      const store = createTraceStore();
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:a', success: true }));
      recordTrace(store, makeTrace({ id: 'urn:prov:trace:b', success: false, error: 'fail' }));
      const result = getTraces(store, { successOnly: true });
      expect(result.length).toBe(1);
      expect(result[0]!.success).toBe(true);
    });
  });

  describe('traceToTurtle', () => {
    it('produces valid Turtle with PROV-O prefixes', () => {
      const trace = makeTrace();
      const turtle = traceToTurtle(trace);
      expect(turtle).toContain('@prefix prov:');
      expect(turtle).toContain('@prefix xsd:');
      expect(turtle).toContain('@prefix cg:');
    });

    it('contains prov:Activity, prov:wasAssociatedWith, prov:used', () => {
      const trace = makeTrace();
      const turtle = traceToTurtle(trace);
      expect(turtle).toContain('a prov:Activity');
      expect(turtle).toContain('prov:wasAssociatedWith');
      expect(turtle).toContain('prov:used');
    });

    it('contains timestamps', () => {
      const trace = makeTrace({ startedAt: '2026-04-05T10:00:00.000Z', endedAt: '2026-04-05T10:00:01.000Z' });
      const turtle = traceToTurtle(trace);
      expect(turtle).toContain('prov:startedAtTime');
      expect(turtle).toContain('2026-04-05T10:00:00.000Z');
      expect(turtle).toContain('prov:endedAtTime');
      expect(turtle).toContain('2026-04-05T10:00:01.000Z');
    });
  });

  describe('wrapWithTracing', () => {
    it('returns TracedAffordance with affordance and execute', () => {
      const aff = mockAffordance('create-atom');
      const decision = { allowed: true, duties: [], reason: 'ok', matchedRules: [] };
      const traced = wrapWithTracing(aff, 'agent:alice', AnalystAAT, decision);
      expect(traced.affordance).toBe(aff);
      expect(typeof traced.execute).toBe('function');
    });

    it('execute() produces a ProvTrace with timing and agent data', () => {
      const aff = mockAffordance('create-atom');
      const decision = { allowed: true, duties: [], reason: 'ok', matchedRules: [] };
      const traced = wrapWithTracing(aff, 'agent:alice', AnalystAAT, decision);
      const trace = traced.execute();
      expect(trace.agent).toBe('agent:alice');
      expect(trace.agentAAT).toBe('aat:analyst');
      expect(trace.activity).toBe('create-atom');
      expect(trace.success).toBe(true);
      expect(trace.startedAt).toBeTruthy();
      expect(trace.endedAt).toBeTruthy();
      expect(trace.id).toMatch(/^urn:prov:trace:/);
    });

    it('execute() includes the policy decision', () => {
      const aff = mockAffordance('read', 'GET');
      const decision = { allowed: true, duties: ['must log'], reason: 'permitted', matchedRules: ['r1'] };
      const traced = wrapWithTracing(aff, 'agent:bob', ObserverAAT, decision);
      const trace = traced.execute();
      expect(trace.policyDecision).toEqual(decision);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Personal Broker
// ══════════════════════════════════════════════════════════════

describe('Personal Broker', () => {
  it('createPersonalBroker initializes with agent, AAT, empty conversations', () => {
    const pgsl = makePgsl();
    const broker = createPersonalBroker('agent:alice', AnalystAAT, pgsl);
    expect(broker.agentId).toBe('agent:alice');
    expect(broker.aat).toBe(AnalystAAT);
    expect(broker.pgsl).toBe(pgsl);
    expect(broker.conversations.length).toBe(0);
    expect(broker.presence).toBe('online');
  });

  it('startConversation creates new conversation', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    const conv = startConversation(broker, ['agent:bob'], 'Testing');
    expect(conv.id).toMatch(/^conv:/);
    expect(conv.participants).toContain('agent:alice');
    expect(conv.participants).toContain('agent:bob');
    expect(conv.topic).toBe('Testing');
    expect(conv.messages.length).toBe(0);
  });

  it('startConversation adds broker agentId if absent', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    const conv = startConversation(broker, ['agent:bob']);
    expect(conv.participants).toContain('agent:alice');
  });

  it('addMessage appends to conversation', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    const conv = startConversation(broker, ['agent:bob']);
    const msg = addMessage(broker, conv.id, 'agent:bob', 'Hello!');
    expect(msg).toBeDefined();
    expect(msg!.from).toBe('agent:bob');
    expect(msg!.content).toBe('Hello!');
    expect(msg!.timestamp).toBeTruthy();
    // Check it was actually appended to the conversation
    expect(broker.conversations[0]!.messages.length).toBe(1);
  });

  it('addMessage returns undefined for unknown conversation', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    const msg = addMessage(broker, 'conv:nonexistent', 'agent:bob', 'Hello');
    expect(msg).toBeUndefined();
  });

  it('getMemoryStats returns counts', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    startConversation(broker, ['agent:bob']);
    const stats = getMemoryStats(broker);
    expect(stats.semanticSize).toBe(0); // empty PGSL
    expect(stats.episodicSize).toBe(1); // one conversation
    expect(stats.proceduralSize).toBe(0);
  });

  it('setPresence updates status', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    expect(broker.presence).toBe('online');
    setPresence(broker, 'busy');
    expect(broker.presence).toBe('busy');
    setPresence(broker, 'offline');
    expect(broker.presence).toBe('offline');
  });

  it('multiple conversations tracked', () => {
    const broker = createPersonalBroker('agent:alice', AnalystAAT, makePgsl());
    const conv1 = startConversation(broker, ['agent:bob'], 'Topic A');
    const conv2 = startConversation(broker, ['agent:carol'], 'Topic B');
    expect(broker.conversations.length).toBe(2);
    expect(broker.conversations[0]!.topic).toBe('Topic A');
    expect(broker.conversations[1]!.topic).toBe('Topic B');
    // Messages go to correct conversation
    addMessage(broker, conv2.id, 'agent:carol', 'Hi from conv2');
    expect(broker.conversations[0]!.messages.length).toBe(0);
    expect(broker.conversations[1]!.messages.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. AAT Decorator
// ══════════════════════════════════════════════════════════════

describe('AAT Decorator', () => {
  function makeDecoratorContext(
    existingAffordances: DecoratedAffordance[],
  ) {
    const pgsl = makePgsl();
    return {
      uri: 'urn:test:node1' as IRI,
      kind: 'Atom' as const,
      level: 0,
      resolved: 'test node',
      sourceOptions: [],
      targetOptions: [],
      constraints: [],
      containers: [],
      pgsl,
      existingAffordances,
    };
  }

  it('createAATDecorator returns valid decorator', () => {
    const decorator = createAATDecorator(ObserverAAT, createPolicyEngine(), createTraceStore());
    expect(decorator.id).toContain('aat-decorator:');
    expect(decorator.trustLevel).toBe('system');
    expect(decorator.priority).toBe(1);
    expect(typeof decorator.decorate).toBe('function');
  });

  it('Observer decorator filters out write affordances', () => {
    const traceStore = createTraceStore();
    const decorator = createAATDecorator(ObserverAAT, createPolicyEngine(), traceStore);
    const ctx = makeDecoratorContext([
      mockAffordance('read', 'GET'),
      mockAffordance('create-atom', 'POST'),
      mockAffordance('sparql', 'POST'),
    ]);
    const result = decorator.decorate(ctx);
    const actionRels = result.affordances
      .filter(a => a.rel !== 'denied' && a.rel !== 'duty')
      .map(a => a.rel);
    expect(actionRels).toContain('read');
    expect(actionRels).toContain('sparql');
    expect(actionRels).not.toContain('create-atom');
  });

  it('Analyst decorator keeps create affordances', () => {
    const decorator = createAATDecorator(AnalystAAT, createPolicyEngine(), createTraceStore());
    const ctx = makeDecoratorContext([
      mockAffordance('read', 'GET'),
      mockAffordance('create-atom', 'POST'),
      mockAffordance('add-source', 'POST'),
    ]);
    const result = decorator.decorate(ctx);
    const actionRels = result.affordances
      .filter(a => a.rel !== 'denied' && a.rel !== 'duty')
      .map(a => a.rel);
    expect(actionRels).toContain('create-atom');
    expect(actionRels).toContain('add-source');
  });

  it('policy deny removes affordance and adds denied marker with rationale', () => {
    const engine = createPolicyEngine();
    addRule(engine, {
      id: 'd1', mode: 'deny', subject: '*', action: 'create-atom',
      description: 'no atom creation allowed',
    });
    const decorator = createAATDecorator(AnalystAAT, engine, createTraceStore());
    const ctx = makeDecoratorContext([
      mockAffordance('read', 'GET'),
      mockAffordance('create-atom', 'POST'),
    ]);
    const result = decorator.decorate(ctx);
    const allowed = result.affordances.filter(a => a.rel !== 'denied' && a.rel !== 'duty');
    const allowedRels = allowed.map(a => a.rel);
    // create-atom should be denied by policy
    expect(allowedRels).not.toContain('create-atom');
    expect(allowedRels).toContain('read');
  });

  it('policy duty adds informational duty affordance', () => {
    const engine = createPolicyEngine();
    addRule(engine, { id: 'p1', mode: 'permit', subject: '*', action: 'create-atom', description: 'allow create' });
    addRule(engine, { id: 'duty1', mode: 'duty', subject: '*', action: 'create-atom', description: 'must include provenance' });
    const decorator = createAATDecorator(AnalystAAT, engine, createTraceStore());
    const ctx = makeDecoratorContext([mockAffordance('create-atom', 'POST')]);
    const result = decorator.decorate(ctx);
    const duties = result.affordances.filter(a => a.rel === 'duty');
    expect(duties.length).toBeGreaterThan(0);
    expect(duties[0]!.title).toContain('must include provenance');
  });

  it('traces recorded for allowed affordances', () => {
    const traceStore = createTraceStore();
    const decorator = createAATDecorator(AnalystAAT, createPolicyEngine(), traceStore);
    const ctx = makeDecoratorContext([
      mockAffordance('read', 'GET'),
      mockAffordance('create-atom', 'POST'),
    ]);
    decorator.decorate(ctx);
    const traces = getTraces(traceStore);
    expect(traces.length).toBeGreaterThan(0);
    // Should have traces for the evaluated affordances
    const activities = traces.map(t => t.activity);
    expect(activities.some(a => a.includes('read'))).toBe(true);
    expect(activities.some(a => a.includes('create-atom'))).toBe(true);
  });

  it('traces recorded for denied affordances too', () => {
    const traceStore = createTraceStore();
    const engine = createPolicyEngine();
    addRule(engine, { id: 'd1', mode: 'deny', subject: '*', action: 'create-atom', description: 'no create' });
    const decorator = createAATDecorator(AnalystAAT, engine, traceStore);
    const ctx = makeDecoratorContext([mockAffordance('create-atom', 'POST')]);
    decorator.decorate(ctx);
    const traces = getTraces(traceStore);
    const deniedTraces = traces.filter(t => !t.success);
    expect(deniedTraces.length).toBeGreaterThan(0);
    expect(deniedTraces[0]!.error).toBeTruthy();
  });

  it('decorator has correct metadata', () => {
    const decorator = createAATDecorator(ObserverAAT, createPolicyEngine(), createTraceStore());
    expect(decorator.priority).toBe(1);
    expect(decorator.trustLevel).toBe('system');
    expect(decorator.domain).toBe('agent-framework');
    expect(decorator.name).toContain('Observer');
  });
});
