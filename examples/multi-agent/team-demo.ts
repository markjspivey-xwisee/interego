#!/usr/bin/env tsx
/**
 * Interego 1.0 — Team of Agents Collaboration Demo
 *
 * Three AI agents collaborate on a security audit across decentralized pods.
 * Each agent has different trust levels, access scopes, and expertise.
 * The system provides what a raw LLM cannot:
 *
 *   - Typed context with compositional semantics
 *   - Trust verification and delegation chains
 *   - Access control on context (who sees what)
 *   - Provenance tracking (who said what, when, how confident)
 *   - Structural deduplication via PGSL (shared knowledge = shared atoms)
 *   - Federation across pods (each agent has their own pod)
 *   - Semiotic framing (asserted vs hypothetical vs retracted)
 *   - Temporal validity (context expires, gets superseded)
 *   - Algebraic composition (union/intersection/restriction of contexts)
 *
 * No mocks. Real HTTP. Real Solid pods. Real RDF. Real crypto.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ContextDescriptor,
  toTurtle,
  toJsonLdString,
  validate,
  union,
  intersection,
  restriction,
  override,
  publish,
  discover,
  createPGSL,
  embedInPGSL,
  latticeStats,
  latticeMeet,
  pgslResolve,
  sparqlQueryPGSL,
  sparqlFragmentsContaining,
  validateAllPGSL,
} from '@interego/core';

import type {
  IRI,
  ContextDescriptorData,
  FetchFn,
} from '@interego/core';

// ── Configuration ───────────────────────────────────────────

const CSS_PORT = 3456;
const BASE_URL = `http://localhost:${CSS_PORT}/`;
const SCANNER_POD = `${BASE_URL}scanner/`;
const ANALYST_POD = `${BASE_URL}analyst/`;
const LEAD_POD = `${BASE_URL}lead/`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_CONFIG = resolve(__dirname, 'css-config.json');
const CSS_BIN = resolve(__dirname, 'node_modules/.bin/community-solid-server');

// ── Utility ─────────────────────────────────────────────────

const COLORS = {
  Scanner:  '\x1b[31m',  // red
  Analyst:  '\x1b[33m',  // yellow
  Lead:     '\x1b[32m',  // green
  System:   '\x1b[90m',  // gray
  PGSL:     '\x1b[36m',  // cyan
  Reset:    '\x1b[0m',
};

function log(agent: string, msg: string): void {
  const color = (COLORS as any)[agent] ?? COLORS.System;
  console.log(`${color}[${agent}]${COLORS.Reset} ${msg}`);
}

function banner(text: string): void {
  console.log('');
  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${text}`);
  console.log(`${'─'.repeat(60)}`);
}

const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: { get: (name: string) => resp.headers.get(name) },
    text: () => resp.text(),
    json: () => resp.json(),
  };
};

// ── CSS Lifecycle ───────────────────────────────────────────

function startCSS(): Promise<ChildProcess> {
  return new Promise((resolveP, reject) => {
    log('System', `Starting Community Solid Server on port ${CSS_PORT}...`);
    const proc = spawn(CSS_BIN, ['-c', CSS_CONFIG, '-p', String(CSS_PORT), '-l', 'warn', '--baseUrl', BASE_URL], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    });
    let started = false;
    const check = (text: string) => {
      if (!started && text.includes('Listening')) {
        started = true;
        log('System', `CSS running at ${BASE_URL}`);
        resolveP(proc);
      }
    };
    proc.stdout!.on('data', (d: Buffer) => check(d.toString()));
    proc.stderr!.on('data', (d: Buffer) => check(d.toString()));
    proc.on('error', (e) => { if (!started) reject(e); });

    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const r = await fetch(BASE_URL);
        if (r.ok || r.status < 500) { clearInterval(poll); if (!started) { started = true; log('System', `CSS running at ${BASE_URL}`); resolveP(proc); } }
      } catch {}
    }, 500);
    setTimeout(() => { clearInterval(poll); if (!started) reject(new Error('CSS timeout')); }, 30_000);
  });
}

async function ensurePod(url: string): Promise<void> {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle', 'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' },
    body: '',
  });
  if (!resp.ok && resp.status !== 409) {
    const existing = await fetch(url);
    if (!existing.ok) throw new Error(`Failed to create pod at ${url}: ${resp.status}`);
  }
}

// ═════════════════════════════════════════════════════════════
//  AGENT 1 — Scanner (automated vulnerability scan)
// ═════════════════════════════════════════════════════════════

async function agentScanner(): Promise<ContextDescriptorData> {
  log('Scanner', 'Running automated security scan...');

  const scanResults = `
@prefix sec: <https://example.org/security#>.
@prefix schema: <https://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<urn:scan:finding-001> a sec:Vulnerability ;
    schema:name "SQL Injection in User Service" ;
    sec:severity "Critical" ;
    sec:cvss "9.8"^^xsd:decimal ;
    sec:affectedComponent <urn:arch:user-service> ;
    sec:vector "Network" ;
    sec:remediation "Parameterize all SQL queries in /api/users endpoint".

<urn:scan:finding-002> a sec:Vulnerability ;
    schema:name "Outdated Redis Version" ;
    sec:severity "High" ;
    sec:cvss "7.5"^^xsd:decimal ;
    sec:affectedComponent <urn:arch:redis-session-store> ;
    sec:vector "Network" ;
    sec:remediation "Upgrade Redis from 6.2 to 7.2".

<urn:scan:finding-003> a sec:Vulnerability ;
    schema:name "Missing Rate Limiting on API Gateway" ;
    sec:severity "Medium" ;
    sec:cvss "5.3"^^xsd:decimal ;
    sec:affectedComponent <urn:arch:api-gateway> ;
    sec:vector "Network" ;
    sec:remediation "Add rate limiting middleware (100 req/min per IP)".

<urn:scan:finding-004> a sec:Informational ;
    schema:name "TLS 1.2 Still Enabled" ;
    sec:severity "Low" ;
    sec:affectedComponent <urn:arch:api-gateway> ;
    sec:remediation "Consider disabling TLS 1.2, enforce TLS 1.3 only".
`.trim();

  // Scanner's context: automated tool output, high confidence on detection, asserted
  const descriptor = ContextDescriptor.create('urn:cg:scanner:scan-2026-03-15' as IRI)
.describes('urn:graph:scanner:vulnerability-report' as IRI)
.temporal({
      validFrom: '2026-03-15T02:00:00Z',
      validUntil: '2026-04-15T02:00:00Z',  // Scan valid for 30 days
      temporalResolution: 'P1D',
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:agent:scanner:nessus-integration' as IRI,
        startedAt: '2026-03-15T02:00:00Z',
        endedAt: '2026-03-15T02:15:33Z',
      },
      wasAttributedTo: 'did:web:scanner.security.internal' as IRI,
      generatedAtTime: '2026-03-15T02:15:33Z',
    })
.agent('did:web:scanner.security.internal' as IRI, 'Scanner')
.semiotic({
      modalStatus: 'Asserted',      // Machine-generated, high confidence
      epistemicConfidence: 0.95,
      groundTruth: false,            // Not verified by human yet
    })
.trust({
      trustLevel: 'ThirdPartyAttested',  // Nessus attestation
      issuer: 'did:web:scanner.security.internal' as IRI,
    })
.accessControl([{
      agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI,
      mode: ['Read'],
    }])
.federation({
      origin: SCANNER_POD as IRI,
      storageEndpoint: SCANNER_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  const vResult = validate(descriptor);
  log('Scanner', `Scan descriptor valid: ${vResult.conforms} (${descriptor.facets.length} facets)`);
  log('Scanner', `  Trust: ThirdPartyAttested | Confidence: 0.95 | Access: ReadOnly`);
  log('Scanner', `  Found 4 vulnerabilities: 1 Critical, 1 High, 1 Medium, 1 Low`);

  const pubResult = await publish(descriptor, scanResults, SCANNER_POD, { fetch: solidFetch });
  log('Scanner', `Published to ${pubResult.descriptorUrl}`);

  return descriptor;
}

// ═════════════════════════════════════════════════════════════
//  AGENT 2 — Analyst (human-assisted triage & analysis)
// ═════════════════════════════════════════════════════════════

async function agentAnalyst(scannerDesc: ContextDescriptorData): Promise<ContextDescriptorData> {
  log('Analyst', 'Discovering scanner results...');

  // Discover what's on the scanner's pod
  const entries = await discover(SCANNER_POD, undefined, { fetch: solidFetch });
  log('Analyst', `Found ${entries.length} descriptor(s) on scanner pod`);
  for (const e of entries) {
    log('Analyst', `  → ${e.facetTypes.join(', ')} | describes: ${e.describes[0]}`);
  }

  // Fetch the actual scan data
  if (entries[0]) {
    const resp = await fetch(entries[0].descriptorUrl, { headers: { 'Accept': 'text/turtle' } });
    const turtle = await resp.text();
    log('Analyst', `Fetched ${turtle.length} bytes of scanner context`);
  }

  // Analyst triages: confirms finding-001, downgrades finding-002, adds new finding
  log('Analyst', 'Triaging scan results...');
  log('Analyst', '  finding-001 (SQLi): CONFIRMED — verified manually');
  log('Analyst', '  finding-002 (Redis): DOWNGRADED — internal network only, Medium');
  log('Analyst', '  finding-003 (Rate limit): CONFIRMED');
  log('Analyst', '  finding-004 (TLS 1.2): ACCEPTED — low priority');
  log('Analyst', '  NEW: finding-005 — Hardcoded API key in auth-service config');

  const analysisResults = `
@prefix sec: <https://example.org/security#>.
@prefix schema: <https://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<urn:analysis:finding-001> a sec:VerifiedVulnerability ;
    schema:name "SQL Injection in User Service" ;
    sec:severity "Critical" ;
    sec:cvss "9.8"^^xsd:decimal ;
    sec:status "Confirmed" ;
    sec:verifiedBy "did:web:analyst.security.internal" ;
    sec:exploitDifficulty "Low" ;
    sec:businessImpact "Data breach — all user PII at risk" ;
    sec:priorityRank 1.

<urn:analysis:finding-002-revised> a sec:VerifiedVulnerability ;
    schema:name "Outdated Redis Version" ;
    sec:severity "Medium" ;
    sec:cvss "5.0"^^xsd:decimal ;
    sec:status "Downgraded" ;
    sec:reason "Internal network only, no external exposure" ;
    sec:priorityRank 3.

<urn:analysis:finding-005> a sec:VerifiedVulnerability ;
    schema:name "Hardcoded API Key in Auth Service" ;
    sec:severity "High" ;
    sec:cvss "8.1"^^xsd:decimal ;
    sec:status "New — discovered during code review" ;
    sec:affectedComponent <urn:arch:auth-service> ;
    sec:remediation "Rotate key, move to HashiCorp Vault" ;
    sec:priorityRank 2.
`.trim();

  const descriptor = ContextDescriptor.create('urn:cg:analyst:triage-2026-03-16' as IRI)
.describes('urn:graph:analyst:triage-report' as IRI)
.temporal({
      validFrom: '2026-03-16T09:00:00Z',
      validUntil: '2026-04-30T23:59:59Z',
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:agent:claude-code:analyst-instance' as IRI,
        startedAt: '2026-03-16T09:00:00Z',
        endedAt: '2026-03-16T11:45:00Z',
      },
      wasAttributedTo: 'did:web:analyst.security.internal' as IRI,
      generatedAtTime: '2026-03-16T11:45:00Z',
    })
.agent('did:web:analyst.security.internal' as IRI, 'Analyst')
.semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 0.88,      // Slightly lower — human judgment involved
      groundTruth: true,              // Verified by human
    })
.trust({
      trustLevel: 'CryptographicallyVerified',  // Analyst's verification signature
      issuer: 'did:web:analyst.security.internal' as IRI,
    })
.accessControl([{
      agent: 'did:web:analyst.security.internal' as IRI,
      mode: ['Read', 'Write'],
    }])
.federation({
      origin: ANALYST_POD as IRI,
      storageEndpoint: ANALYST_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  const vResult = validate(descriptor);
  log('Analyst', `Analysis descriptor valid: ${vResult.conforms}`);
  log('Analyst', `  Trust: CryptographicallyVerified | Ground truth: YES`);

  const pubResult = await publish(descriptor, analysisResults, ANALYST_POD, { fetch: solidFetch });
  log('Analyst', `Published to ${pubResult.descriptorUrl}`);

  return descriptor;
}

// ═════════════════════════════════════════════════════════════
//  AGENT 3 — Security Lead (composes, decides, publishes plan)
// ═════════════════════════════════════════════════════════════

async function agentLead(
  scannerDesc: ContextDescriptorData,
  analystDesc: ContextDescriptorData,
): Promise<void> {
  log('Lead', 'Discovering all available security context...');

  // Discover from BOTH pods
  const scanEntries = await discover(SCANNER_POD, undefined, { fetch: solidFetch });
  const analystEntries = await discover(ANALYST_POD, undefined, { fetch: solidFetch });
  log('Lead', `Scanner pod: ${scanEntries.length} descriptor(s)`);
  log('Lead', `Analyst pod: ${analystEntries.length} descriptor(s)`);

  // ── COMPOSITION: Algebraic context operations ──

  banner('Composition: Scanner ∪ Analyst (union)');
  const combined = union(scannerDesc, analystDesc);
  log('Lead', `Union has ${combined.facets.length} facets`);
  log('Lead', `  Temporal: ${combined.facets.filter(f => f.type === 'Temporal').length} facet(s) — full time range`);
  log('Lead', `  Trust: ${combined.facets.filter(f => f.type === 'Trust').length} facet(s) — both trust levels preserved`);
  log('Lead', `  Access: ${combined.facets.filter(f => f.type === 'AccessControl').length} facet(s) — broadest permissions`);

  banner('Composition: Scanner ∩ Analyst (intersection)');
  const overlap = intersection(scannerDesc, analystDesc);
  log('Lead', `Intersection has ${overlap.facets.length} facets`);
  const temporalFacets = overlap.facets.filter(f => f.type === 'Temporal');
  if (temporalFacets.length > 0 && temporalFacets[0]!.type === 'Temporal') {
    log('Lead', `  Temporal overlap: ${temporalFacets[0]!.validFrom} → ${temporalFacets[0]!.validUntil}`);
  }
  const semioticFacets = overlap.facets.filter(f => f.type === 'Semiotic');
  log('Lead', `  Both agents asserted: ${semioticFacets.every(f => f.type === 'Semiotic' && f.modalStatus === 'Asserted')}`);

  banner('Composition: Analyst overrides Scanner');
  const authoritative = override(analystDesc, scannerDesc);
  log('Lead', `Override: Analyst's context takes precedence on conflicts`);
  log('Lead', `  Trust level → CryptographicallyVerified (analyst's, not scanner's)`);
  log('Lead', `  Ground truth → true (analyst verified)`);
  log('Lead', `  Result has ${authoritative.facets.length} facets`);

  // ── PGSL: Structural overlap detection ──

  banner('PGSL: Structural Knowledge Overlap');
  const pgsl = createPGSL({
    wasAttributedTo: 'urn:agent:lead:pgsl' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  // Ingest key findings from both agents
  const scannerFindings = [
    'SQL Injection in User Service critical severity',
    'Outdated Redis Version high severity',
    'Missing Rate Limiting on API Gateway medium',
    'TLS 1.2 Still Enabled low severity',
  ];
  const analystFindings = [
    'SQL Injection in User Service critical confirmed',
    'Outdated Redis Version medium downgraded internal only',
    'Hardcoded API Key in Auth Service high severity',
  ];

  log('PGSL', 'Ingesting scanner findings...');
  for (const f of scannerFindings) embedInPGSL(pgsl, f);

  log('PGSL', 'Ingesting analyst findings...');
  for (const f of analystFindings) embedInPGSL(pgsl, f);

  const stats = latticeStats(pgsl);
  log('PGSL', `Lattice: ${stats.atoms} atoms, ${stats.fragments} fragments, max level ${stats.maxLevel}`);

  // Find structural overlap — atoms shared between scanner and analyst
  const sharedAtoms: string[] = [];
  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      const val = String((node as any).value).toLowerCase();
      const inScanner = scannerFindings.some(f => f.toLowerCase().includes(val));
      const inAnalyst = analystFindings.some(f => f.toLowerCase().includes(val));
      if (inScanner && inAnalyst && val.length > 3) {
        sharedAtoms.push(val);
      }
    }
  }
  log('PGSL', `Shared atoms (structural overlap): ${[...new Set(sharedAtoms)].slice(0, 10).join(', ')}`);
  log('PGSL', `These atoms exist ONCE in the lattice — content-addressed dedup`);

  // SPARQL query: how many fragments contain "SQL"?
  const sqlAtom = [...pgsl.atoms.entries()].find(([k]) => k.toLowerCase() === 'sql');
  if (sqlAtom) {
    const query = sparqlFragmentsContaining(sqlAtom[1]);
    const result = sparqlQueryPGSL(pgsl, query);
    log('PGSL', `SPARQL: ${result.bindings.length} fragments contain "SQL" (shared across both agents)`);
  }

  // SHACL validation of the lattice
  const shaclResult = validateAllPGSL(pgsl);
  log('PGSL', `SHACL validation: ${shaclResult.conforms ? 'CONFORMS' : `${shaclResult.violations.length} violations`}`);

  // ── Lead publishes the remediation plan ──

  banner('Lead: Publishing Remediation Plan');

  const remediationPlan = `
@prefix sec: <https://example.org/security#>.
@prefix schema: <https://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<urn:plan:sprint-2026-03> a sec:RemediationPlan ;
    schema:name "Security Sprint — March 2026" ;
    sec:basedOn <urn:graph:scanner:vulnerability-report>, <urn:graph:analyst:triage-report> ;
    sec:totalFindings 5 ;
    sec:criticalCount 1 ;
    sec:highCount 1 ;
    sec:mediumCount 2 ;
    sec:lowCount 1.

<urn:plan:task-001> a sec:RemediationTask ;
    schema:name "Fix SQL Injection" ;
    sec:addresses <urn:analysis:finding-001> ;
    sec:priority 1 ;
    sec:assignee "backend-team" ;
    sec:deadline "2026-03-20"^^xsd:date ;
    sec:status "In Progress".

<urn:plan:task-002> a sec:RemediationTask ;
    schema:name "Rotate Hardcoded API Key" ;
    sec:addresses <urn:analysis:finding-005> ;
    sec:priority 2 ;
    sec:assignee "devops-team" ;
    sec:deadline "2026-03-22"^^xsd:date ;
    sec:status "Planned".

<urn:plan:task-003> a sec:RemediationTask ;
    schema:name "Add Rate Limiting + Upgrade Redis" ;
    sec:addresses <urn:scan:finding-003>, <urn:analysis:finding-002-revised> ;
    sec:priority 3 ;
    sec:assignee "platform-team" ;
    sec:deadline "2026-03-29"^^xsd:date ;
    sec:status "Planned".
`.trim();

  // Lead's context: authoritative, supersedes both inputs, highest trust
  const leadDescriptor = ContextDescriptor.create('urn:cg:lead:remediation-2026-03' as IRI)
.describes('urn:graph:lead:remediation-plan' as IRI)
.temporal({
      validFrom: '2026-03-16T14:00:00Z',
      validUntil: '2026-03-31T23:59:59Z',
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:agent:claude-code:lead-instance' as IRI,
        startedAt: '2026-03-16T14:00:00Z',
        endedAt: '2026-03-16T14:30:00Z',
      },
      wasAttributedTo: 'did:web:lead.security.internal' as IRI,
      generatedAtTime: '2026-03-16T14:30:00Z',
      sources: [
        'urn:cg:scanner:scan-2026-03-15' as IRI,
        'urn:cg:analyst:triage-2026-03-16' as IRI,
      ],
    })
.agent('did:web:lead.security.internal' as IRI, 'Lead')
.semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 0.98,
      groundTruth: true,
    })
.trust({
      trustLevel: 'CryptographicallyVerified',
      issuer: 'did:web:lead.security.internal' as IRI,
    })
.accessControl([{
      agent: 'did:web:lead.security.internal' as IRI,
      mode: ['Read', 'Write', 'Append', 'Control'],
    }])
.federation({
      origin: LEAD_POD as IRI,
      storageEndpoint: LEAD_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  const vResult = validate(leadDescriptor);
  log('Lead', `Remediation plan valid: ${vResult.conforms}`);
  log('Lead', `  Sources: scanner + analyst (provenance chain)`);
  log('Lead', `  Trust: CryptographicallyVerified | Confidence: 0.98`);

  const pubResult = await publish(leadDescriptor, remediationPlan, LEAD_POD, { fetch: solidFetch });
  log('Lead', `Published to ${pubResult.descriptorUrl}`);

  // ── Final: Federation view across all pods ──

  banner('Federation: Cross-Pod Discovery');
  for (const [name, podUrl] of [['Scanner', SCANNER_POD], ['Analyst', ANALYST_POD], ['Lead', LEAD_POD]]) {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    log('Lead', `${name} pod (${podUrl}):`);
    for (const e of entries) {
      log('Lead', `  → ${e.describes[0]} | facets: ${e.facetTypes.join(', ')}`);
    }
  }

  // ── Final: Show the trust chain ──
  banner('Trust Chain');
  log('Lead', 'Scanner → ThirdPartyAttested (Nessus) → confidence 0.95');
  log('Lead', '  ↓ Analyst discovers, triages, verifies');
  log('Lead', 'Analyst → CryptographicallyVerified → confidence 0.88, ground truth YES');
  log('Lead', '  ↓ Lead composes both (union + override), creates plan');
  log('Lead', 'Lead → CryptographicallyVerified → confidence 0.98, ground truth YES');
  log('Lead', '');
  log('Lead', 'Each step has: typed context, provenance, temporal validity,');
  log('Lead', 'trust level, semiotic frame, access control, and federation metadata.');
  log('Lead', 'All stored on decentralized Solid pods with content-addressed PGSL lattice.');
  log('Lead', '');
  log('Lead', 'A raw LLM can read text. This system provides INFRASTRUCTURE for');
  log('Lead', 'composable, verifiable, federated context across autonomous agents.');
}

// ═════════════════════════════════════════════════════════════
//  Main
// ═════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Interego 1.0 — Team Security Audit Demo');
  console.log('  3 agents, 3 pods, typed context, real federation');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let cssProc: ChildProcess | null = null;

  try {
    cssProc = await startCSS();
    console.log('');

    log('System', 'Creating pod containers...');
    await ensurePod(SCANNER_POD);
    await ensurePod(ANALYST_POD);
    await ensurePod(LEAD_POD);
    log('System', `Pods ready: scanner/ analyst/ lead/`);

    banner('Phase 1: Scanner runs automated vulnerability scan');
    const scannerDesc = await agentScanner();

    banner('Phase 2: Analyst discovers scan, triages & verifies');
    const analystDesc = await agentAnalyst(scannerDesc);

    banner('Phase 3: Lead composes all context, builds remediation plan');
    await agentLead(scannerDesc, analystDesc);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Demo complete. All operations used real HTTP against');
    console.log('  live Solid pods with typed, composable context.');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

  } finally {
    if (process.argv.includes('--keep-alive') && cssProc) {
      log('System', 'CSS kept running at ' + BASE_URL + ' (--keep-alive)');
      log('System', 'Start the observatory: CSS_URL=' + BASE_URL + ' KNOWN_PODS=' + SCANNER_POD + ',' + ANALYST_POD + ',' + LEAD_POD + ' npx tsx examples/pgsl-browser/server.ts');
      log('System', 'Press Ctrl+C to stop.');
      // Keep process alive
      await new Promise(() => {});
    } else if (cssProc) {
      log('System', 'Shutting down CSS...');
      cssProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
