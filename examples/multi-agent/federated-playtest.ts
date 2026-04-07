#!/usr/bin/env tsx
/**
 * Federated Multi-Agent Playtest
 *
 * Spins up 3 REAL agents, each with:
 *   - DID from the identity server
 *   - Bearer token for authentication
 *   - Solid pod on the CSS
 *   - Isolated PGSL enclave
 *   - AAT behavioral contract
 *   - Marketplace registration
 *
 * Agents interact through the ACTUAL HTTP APIs:
 *   - Publish to their pods
 *   - Discover each other via federation
 *   - Verify coherence across separate lattices
 *   - CRDT sync to merge findings
 *   - Decision functor determines strategy
 *   - Full PROV trace across the federation
 *
 * Requires: CSS (localhost:3456), Identity (localhost:8090), Browser (localhost:5000)
 */

import {
  createPGSL, embedInPGSL, mintAtom, ingest, latticeStats,
  pgslResolve, ingestWithProfile,
  ContextDescriptor, validate, publish, discover, toTurtle,
  verifyCoherence, computeCoverage, getCertificates,
  createWallet, signDescriptor, createDelegation,
  union, intersection,
} from '@foxxi/context-graphs';

import {
  ObserverAAT, AnalystAAT, ExecutorAAT, FullAccessAAT,
  createPolicyEngine, addRule, defaultPolicies, evaluate as evaluatePolicy,
  createTraceStore, recordTrace, getTraces, traceToTurtle,
  createPersonalBroker, startConversation, addMessage, getMemoryStats,
  createAATDecorator,
} from '../../src/pgsl/agent-framework.js';

import {
  createEnclaveRegistry, createEnclave, freezeEnclave, mergeEnclave,
  createCheckpointStore, createCheckpoint, diffCheckpoints,
  createCRDTState, createOp, applyOp, getPendingOps, markSynced, crdtStats,
} from '../../src/pgsl/infrastructure.js';

import {
  createMarketplace, registerListing, discoverByCapability, marketplaceStats,
  generateMetagraph, ingestMetagraph,
} from '../../src/pgsl/discovery.js';

import {
  extractObservations,
  computeAffordances as computeDecisionAffordances,
  selectStrategy,
  decide as decideFromObservations,
} from '../../src/pgsl/decision-functor.js';

import type { IRI, PGSLInstance, FetchFn } from '@foxxi/context-graphs';

// ── Config ─────────────────────────────────────────────

const CSS_URL = 'http://localhost:3456';
const IDENTITY_URL = 'http://localhost:8090';
const BROWSER_URL = 'http://localhost:5000';

const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return { ok: resp.ok, status: resp.status, statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(), json: () => resp.json() };
};

// ── Logging ────────────────────────────────────────────

const C: Record<string, string> = {
  scanner: '\x1b[31m', analyst: '\x1b[33m', lead: '\x1b[32m',
  system: '\x1b[90m', fed: '\x1b[36m', cohere: '\x1b[35m',
  decide: '\x1b[34m', prov: '\x1b[90m', r: '\x1b[0m', h: '\x1b[1;37m',
};

function log(agent: string, msg: string) {
  console.log(`${C[agent] ?? C.system}[${agent}]${C.r} ${msg}`);
}

function banner(text: string) {
  console.log(`\n${C.h}${'═'.repeat(64)}${C.r}`);
  console.log(`${C.h}  ${text}${C.r}`);
  console.log(`${C.h}${'═'.repeat(64)}${C.r}`);
}

// ── Agent Identity ─────────────────────────────────────

interface AgentIdentity {
  name: string;
  userId: string;
  agentId: string;
  token: string;
  did: string;
  webId: string;
  podUrl: string;
  wallet: any;
  aat: any;
  enclave: any;
  pgsl: PGSLInstance;
  broker: any;
  crdtState: any;
  traceStore: any;
}

async function registerAgent(name: string, userId: string, agentId: string, aat: any): Promise<AgentIdentity> {
  // 1. Register with identity server
  const regResp = await fetch(`${IDENTITY_URL}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, userId, agentId, agentName: `${name} Agent`, scope: 'ReadWrite' }),
  });

  let did: string, webId: string, token: string;
  if (regResp.ok) {
    const regData = await regResp.json();
    did = regData.did;
    webId = regData.webId;
    token = regData.token;
    log(name, `Registered: DID=${did}`);
  } else {
    // User might already exist — get a token
    const tokenResp = await fetch(`${IDENTITY_URL}/tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, agentId }),
    });
    const tokenData = await tokenResp.json();
    token = tokenData.token;
    did = `did:web:localhost:8090:users:${userId}`;
    webId = `${IDENTITY_URL}/users/${userId}/profile#me`;
    log(name, `Already registered, got token: DID=${did}`);
  }

  // 2. Create pod on CSS
  const podUrl = `${CSS_URL}/${userId}/`;
  await fetch(podUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle', 'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' },
    body: '',
  }).catch(() => {});
  log(name, `Pod: ${podUrl}`);

  // 3. Create wallet (real ECDSA)
  const wallet = await createWallet('agent', name);
  log(name, `Wallet: ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`);

  // 4. Create PGSL instance (the agent's isolated lattice)
  const pgsl = createPGSL({
    wasAttributedTo: did as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  // 5. Create enclave
  const enclaveRegistry = createEnclaveRegistry();
  const enclave = createEnclave(enclaveRegistry, agentId, pgsl.defaultProvenance, did);

  // 6. Create personal broker
  const broker = createPersonalBroker(agentId, aat, pgsl);

  // 7. Create CRDT state
  const crdtState = createCRDTState(agentId);

  // 8. Create trace store
  const traceStore = createTraceStore();

  return {
    name, userId, agentId, token, did, webId, podUrl,
    wallet, aat, enclave, pgsl, broker, crdtState, traceStore,
  };
}

// ═══════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log(`${C.h}`);
  console.log('  Federated Multi-Agent Playtest');
  console.log('  3 real agents × DIDs × Solid pods × ECDSA wallets');
  console.log(`${C.r}`);

  // ── Phase 1: Register Agents ──────────────────────────

  banner('Phase 1: Register Agents with Identity Server');

  const scanner = await registerAgent('scanner', 'scanner-user', 'scanner-agent', ObserverAAT);
  const analyst = await registerAgent('analyst', 'analyst-user', 'analyst-agent', AnalystAAT);
  const lead = await registerAgent('lead', 'lead-user', 'lead-agent', ExecutorAAT);

  // Register in marketplace
  const marketplace = createMarketplace();
  registerListing(marketplace, {
    id: scanner.agentId, type: 'agent', name: 'Scanner',
    description: 'Security scanner — discovers vulnerabilities',
    provider: scanner.did, capabilities: ['scan', 'observe', 'report'],
    trustLevel: 'self-asserted', registeredAt: new Date().toISOString(),
    operations: [{ method: 'GET', href: `${scanner.podUrl}context-graphs/`, title: 'View findings' }],
  });
  registerListing(marketplace, {
    id: analyst.agentId, type: 'agent', name: 'Analyst',
    description: 'Risk analyst — assesses findings',
    provider: analyst.did, capabilities: ['analyze', 'assess', 'recommend'],
    trustLevel: 'self-asserted', registeredAt: new Date().toISOString(),
    operations: [{ method: 'GET', href: `${analyst.podUrl}context-graphs/`, title: 'View assessments' }],
  });
  registerListing(marketplace, {
    id: lead.agentId, type: 'agent', name: 'Lead',
    description: 'Team lead — makes decisions, merges findings',
    provider: lead.did, capabilities: ['decide', 'merge', 'approve'],
    trustLevel: 'self-asserted', registeredAt: new Date().toISOString(),
    operations: [{ method: 'GET', href: `${lead.podUrl}context-graphs/`, title: 'View decisions' }],
  });

  const mStats = marketplaceStats(marketplace);
  log('system', `Marketplace: ${mStats.total} agents registered`);

  // ── Phase 2: Scanner Works in Isolation ───────────────

  banner('Phase 2: Scanner — Discovers Findings (Observer AAT)');

  // Scanner ingests findings into its own PGSL (enclave)
  embedInPGSL(scanner.pgsl, 'auth-module sql-injection severity critical');
  embedInPGSL(scanner.pgsl, 'session-handler hardcoded-secret severity medium');
  embedInPGSL(scanner.pgsl, 'payment-gateway unencrypted-credentials severity critical');
  embedInPGSL(scanner.pgsl, 'api-endpoint missing-rate-limit severity low');

  // Record PROV traces
  recordTrace(scanner.traceStore, {
    id: `urn:prov:${Date.now()}:1`, activity: 'scan', agent: scanner.agentId,
    agentAAT: scanner.aat.id, entity: 'auth-module', startedAt: new Date().toISOString(),
    wasAssociatedWith: scanner.did, success: true,
  });

  // Create CRDT ops for sync
  scanner.crdtState = createOp(scanner.crdtState, 'mint-atom', { value: 'sql-injection' }).state;
  scanner.crdtState = createOp(scanner.crdtState, 'mint-atom', { value: 'hardcoded-secret' }).state;
  scanner.crdtState = createOp(scanner.crdtState, 'mint-atom', { value: 'unencrypted-credentials' }).state;

  const scannerStats = latticeStats(scanner.pgsl);
  log('scanner', `Lattice: ${scannerStats.atoms} atoms, ${scannerStats.fragments} fragments`);
  log('scanner', `CRDT: ${getPendingOps(scanner.crdtState).length} pending ops`);

  // Publish to pod
  const scannerDesc = ContextDescriptor.create(`urn:cg:scanner:findings-${Date.now()}` as IRI)
    .describes('urn:graph:scanner:security-findings' as IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({ wasGeneratedBy: { agent: scanner.did as IRI }, wasAttributedTo: scanner.did as IRI, generatedAtTime: new Date().toISOString() })
    .agent(scanner.did as IRI, 'Scanner')
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.90 })
    .trust({ trustLevel: 'SelfAsserted', issuer: scanner.did as IRI })
    .federation({ origin: scanner.podUrl as IRI, storageEndpoint: scanner.podUrl as IRI, syncProtocol: 'SolidNotifications' })
    .version(1).build();

  const scannerGraph = `<urn:finding:1> <urn:severity> "critical" . <urn:finding:1> <urn:module> "auth-module" .`;
  const scanPub = await publish(scannerDesc, scannerGraph, scanner.podUrl, { fetch: solidFetch });
  log('scanner', `Published to pod: ${scanPub.descriptorUrl}`);

  // Sign the descriptor
  const scannerSigned = await signDescriptor(scannerDesc.id, toTurtle(scannerDesc), scanner.wallet);
  log('scanner', `Signed: ${scannerSigned.signature.slice(0, 20)}...`);

  // ── Phase 3: Analyst Discovers and Assesses ───────────

  banner('Phase 3: Analyst — Discovers Scanner\'s Work, Creates Assessments');

  // Analyst discovers from scanner's pod
  const scannerEntries = await discover(scanner.podUrl, undefined, { fetch: solidFetch });
  log('analyst', `Discovered ${scannerEntries.length} descriptor(s) on scanner pod`);
  for (const e of scannerEntries) {
    log('analyst', `  → ${e.describes[0]} | ${e.facetTypes.join(', ')}`);
  }

  // Analyst ingests findings and adds assessments
  embedInPGSL(analyst.pgsl, 'auth-module sql-injection risk-level critical');
  embedInPGSL(analyst.pgsl, 'auth-module sql-injection recommendation parameterize-queries');
  embedInPGSL(analyst.pgsl, 'session-handler hardcoded-secret risk-level medium');
  embedInPGSL(analyst.pgsl, 'session-handler hardcoded-secret recommendation rotate-secrets');
  embedInPGSL(analyst.pgsl, 'payment-gateway unencrypted-credentials risk-level critical');
  embedInPGSL(analyst.pgsl, 'payment-gateway unencrypted-credentials recommendation encrypt-at-rest');

  // Create CRDT ops
  analyst.crdtState = createOp(analyst.crdtState, 'mint-atom', { value: 'risk-level' }).state;
  analyst.crdtState = createOp(analyst.crdtState, 'mint-atom', { value: 'recommendation' }).state;

  const analystStats = latticeStats(analyst.pgsl);
  log('analyst', `Lattice: ${analystStats.atoms} atoms, ${analystStats.fragments} fragments`);

  // Publish assessments to analyst pod
  const analystDesc = ContextDescriptor.create(`urn:cg:analyst:assessments-${Date.now()}` as IRI)
    .describes('urn:graph:analyst:risk-assessments' as IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({ wasGeneratedBy: { agent: analyst.did as IRI }, wasAttributedTo: analyst.did as IRI, generatedAtTime: new Date().toISOString(), sources: [scannerDesc.id] })
    .agent(analyst.did as IRI, 'Analyst')
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.85 })
    .trust({ trustLevel: 'ThirdPartyAttested', issuer: analyst.did as IRI })
    .federation({ origin: analyst.podUrl as IRI, storageEndpoint: analyst.podUrl as IRI, syncProtocol: 'SolidNotifications' })
    .version(1).build();

  const analystGraph = `<urn:assessment:1> <urn:risk-level> "critical" . <urn:assessment:1> <urn:recommendation> "parameterize-queries" .`;
  const analystPub = await publish(analystDesc, analystGraph, analyst.podUrl, { fetch: solidFetch });
  log('analyst', `Published to pod: ${analystPub.descriptorUrl}`);

  const analystSigned = await signDescriptor(analystDesc.id, toTurtle(analystDesc), analyst.wallet);
  log('analyst', `Signed: ${analystSigned.signature.slice(0, 20)}...`);

  // ── Phase 4: Coherence Verification ───────────────────

  banner('Phase 4: Coherence — Do Scanner and Analyst Agree?');

  const certSA = verifyCoherence(scanner.pgsl, analyst.pgsl, scanner.agentId, analyst.agentId, 'security-findings');
  log('cohere', `Scanner ↔ Analyst: ${certSA.status} (${(certSA.semanticOverlap * 100).toFixed(0)}% overlap)`);

  if (certSA.semanticProfile.length > 0) {
    log('cohere', 'Per-atom analysis:');
    for (const p of certSA.semanticProfile.slice(0, 5)) {
      const bar = '█'.repeat(Math.round(p.overlap * 10)) + '░'.repeat(10 - Math.round(p.overlap * 10));
      log('cohere', `  "${p.atom}" [${bar}] ${(p.overlap * 100).toFixed(0)}%`);
    }
  }
  if (certSA.sharedStructure) log('cohere', `Shared: ${certSA.sharedStructure}`);
  if (certSA.obstruction) log('cohere', `Obstruction: ${certSA.obstruction.description}`);

  // ── Phase 5: CRDT Sync ────────────────────────────────

  banner('Phase 5: CRDT Sync — Scanner ↔ Analyst');

  // Scanner sends ops to analyst
  const scannerOps = getPendingOps(scanner.crdtState);
  log('fed', `Scanner has ${scannerOps.length} pending ops → sending to Analyst`);
  for (const op of scannerOps) {
    const result = applyOp(analyst.crdtState, analyst.pgsl, op);
    analyst.crdtState = result.state;
  }
  scanner.crdtState = markSynced(scanner.crdtState, scannerOps.map(o => o.id));

  // Analyst sends ops to scanner
  const analystOps = getPendingOps(analyst.crdtState);
  log('fed', `Analyst has ${analystOps.length} pending ops → sending to Scanner`);
  for (const op of analystOps) {
    const result = applyOp(scanner.crdtState, scanner.pgsl, op);
    scanner.crdtState = result.state;
  }
  analyst.crdtState = markSynced(analyst.crdtState, analystOps.map(o => o.id));

  log('fed', `After sync — Scanner: ${crdtStats(scanner.crdtState).appliedCount} applied, Analyst: ${crdtStats(analyst.crdtState).appliedCount} applied`);

  // ── Phase 6: Lead Merges and Decides ──────────────────

  banner('Phase 6: Lead — Discovers All, Merges, Decides');

  // Lead discovers both pods
  const scanEntries = await discover(scanner.podUrl, undefined, { fetch: solidFetch });
  const analystEntries = await discover(analyst.podUrl, undefined, { fetch: solidFetch });
  log('lead', `Discovered: Scanner=${scanEntries.length}, Analyst=${analystEntries.length}`);

  // Lead ingests key findings into own lattice
  embedInPGSL(lead.pgsl, 'auth-module sql-injection severity critical risk-level critical recommendation parameterize-queries');
  embedInPGSL(lead.pgsl, 'session-handler hardcoded-secret severity medium risk-level medium recommendation rotate-secrets');
  embedInPGSL(lead.pgsl, 'payment-gateway unencrypted-credentials severity critical risk-level critical recommendation encrypt-at-rest');
  embedInPGSL(lead.pgsl, 'remediation-plan sprint-3 priority critical');

  const leadStats = latticeStats(lead.pgsl);
  log('lead', `Lattice: ${leadStats.atoms} atoms, ${leadStats.fragments} fragments`);

  // Compose descriptors
  const combinedDesc = union(scannerDesc, analystDesc);
  log('lead', `Composed: ${combinedDesc.facets.length} facets (union of Scanner + Analyst)`);

  const overlapDesc = intersection(scannerDesc, analystDesc);
  const temporalFacet = overlapDesc.facets.find(f => f.type === 'Temporal');
  if (temporalFacet?.type === 'Temporal') {
    log('lead', `Temporal intersection: ${temporalFacet.validFrom} → ${temporalFacet.validUntil ?? 'open'}`);
  }

  // Publish lead's decision
  const leadDesc = ContextDescriptor.create(`urn:cg:lead:decision-${Date.now()}` as IRI)
    .describes('urn:graph:lead:remediation-plan' as IRI)
    .temporal({ validFrom: new Date().toISOString() })
    .provenance({ wasGeneratedBy: { agent: lead.did as IRI }, wasAttributedTo: lead.did as IRI, generatedAtTime: new Date().toISOString(), sources: [scannerDesc.id, analystDesc.id] })
    .agent(lead.did as IRI, 'Lead')
    .semiotic({ modalStatus: 'Asserted', epistemicConfidence: 0.95 })
    .trust({ trustLevel: 'CryptographicallyVerified', issuer: lead.did as IRI })
    .federation({ origin: lead.podUrl as IRI, storageEndpoint: lead.podUrl as IRI, syncProtocol: 'SolidNotifications' })
    .version(1).build();

  const leadGraph = `<urn:plan:1> <urn:priority> "critical" . <urn:plan:1> <urn:action> "parameterize-queries" .`;
  const leadPub = await publish(leadDesc, leadGraph, lead.podUrl, { fetch: solidFetch });
  log('lead', `Published remediation plan: ${leadPub.descriptorUrl}`);

  const leadSigned = await signDescriptor(leadDesc.id, toTurtle(leadDesc), lead.wallet);
  log('lead', `Signed: ${leadSigned.signature.slice(0, 20)}...`);

  // ── Phase 7: Full Coherence + Decision Functor ────────

  banner('Phase 7: Full Coherence + Decision Functor');

  // All pairwise coherence
  const certSL = verifyCoherence(scanner.pgsl, lead.pgsl, scanner.agentId, lead.agentId, 'security');
  const certAL = verifyCoherence(analyst.pgsl, lead.pgsl, analyst.agentId, lead.agentId, 'security');

  log('cohere', `Scanner ↔ Analyst: ${certSA.status} (${(certSA.semanticOverlap * 100).toFixed(0)}%)`);
  log('cohere', `Scanner ↔ Lead: ${certSL.status} (${(certSL.semanticOverlap * 100).toFixed(0)}%)`);
  log('cohere', `Analyst ↔ Lead: ${certAL.status} (${(certAL.semanticOverlap * 100).toFixed(0)}%)`);

  const coverage = computeCoverage([scanner.agentId, analyst.agentId, lead.agentId]);
  log('cohere', `Coverage: ${(coverage.coverage * 100).toFixed(0)}% (${coverage.verified} verified, ${coverage.divergent} divergent, ${coverage.unexamined} unexamined)`);

  // Decision functor for each agent
  const certs = getCertificates();
  for (const agent of [scanner, analyst, lead]) {
    const decision = decideFromObservations(agent.pgsl, agent.agentId, certs);
    log('decide', `${agent.name}: strategy=${decision.strategy}, ${decision.decisions.length} decisions, ${(decision.coverage * 100).toFixed(0)}% coverage`);
    if (decision.decisions[0]) {
      log('decide', `  Top: ${decision.decisions[0].affordance.type} — ${decision.decisions[0].affordance.description} (${(decision.decisions[0].confidence * 100).toFixed(0)}%)`);
    }
  }

  // ── Phase 8: Push to Browser + Metagraph ──────────────

  banner('Phase 8: Push to Browser + Metagraph');

  // Push results to browser
  await fetch(`${BROWSER_URL}/api/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  // Push all agents' knowledge to the browser
  for (const agent of [scanner, analyst, lead]) {
    for (const [value] of agent.pgsl.atoms) {
      await fetch(`${BROWSER_URL}/api/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value, granularity: 'word' }),
      });
    }
    // Ingest key chains
    for (const [, node] of agent.pgsl.nodes) {
      if (node.kind === 'Fragment' && node.level === 2) {
        const resolved = pgslResolve(agent.pgsl, node.uri);
        await fetch(`${BROWSER_URL}/api/ingest`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: resolved, granularity: 'word' }),
        });
      }
    }
  }

  // Register pods in browser
  for (const agent of [scanner, analyst, lead]) {
    await fetch(`${BROWSER_URL}/api/pods/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: agent.podUrl }),
    });
  }

  // Discover pods
  for (const agent of [scanner, analyst, lead]) {
    await fetch(`${BROWSER_URL}/api/pods/discover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: agent.podUrl }),
    });
  }

  // Generate metagraph for each agent
  for (const agent of [scanner, analyst, lead]) {
    const meta = generateMetagraph(agent.pgsl);
    ingestMetagraph(agent.pgsl, meta);
    log('system', `${agent.name} metagraph: ${meta.atomCount} atoms, ${meta.fragmentCount} fragments, max L${meta.maxLevel}`);
  }

  // PROV summary
  const allTraces = [
    ...getTraces(scanner.traceStore),
  ];
  log('prov', `Total PROV traces: ${allTraces.length}`);

  // ── Final Summary ─────────────────────────────────────

  const browserStats = await (await fetch(`${BROWSER_URL}/api/stats`)).json();
  const podResp = await (await fetch(`${BROWSER_URL}/api/pods`)).json();

  banner('Summary');
  console.log('');
  console.log('  Agents:');
  for (const agent of [scanner, analyst, lead]) {
    const stats = latticeStats(agent.pgsl);
    console.log(`    ${agent.name}: DID=${agent.did.slice(0, 30)}... | ${stats.atoms} atoms | AAT=${agent.aat.name}`);
  }
  console.log('');
  console.log('  Federation:');
  console.log(`    Pods: ${podResp.totalPods} | Descriptors: ${podResp.totalDescriptors}`);
  console.log(`    Browser lattice: ${browserStats.atoms} atoms, ${browserStats.fragments} fragments`);
  console.log('');
  console.log('  Coherence:');
  console.log(`    Coverage: ${(coverage.coverage * 100).toFixed(0)}% | Verified: ${coverage.verified} | Divergent: ${coverage.divergent}`);
  console.log('');
  console.log('  Trust Chain:');
  console.log(`    Scanner (SelfAsserted, 0.90) → Analyst (ThirdPartyAttested, 0.85) → Lead (CryptoVerified, 0.95)`);
  console.log('');
  console.log('  Marketplace: ' + mStats.total + ' agents');
  console.log('  PROV Traces: ' + allTraces.length);
  console.log('  Wallets: ' + [scanner, analyst, lead].map(a => a.wallet.address.slice(0, 8)).join(', '));
  console.log('');
  console.log('  Browse: http://localhost:5000/');
  console.log('  Observatory: http://localhost:5000/observatory');
  console.log('  Identity: http://localhost:8090/health');
  console.log('');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
