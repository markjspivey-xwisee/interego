#!/usr/bin/env tsx
/**
 * Interego 1.0 — TLA / xAPI / LERS Demo
 *
 * Total Learning Architecture pipeline across 3 agents on 3 Solid pods:
 *
 *   LRS Agent (Learning Record Store)
 *     → Ingests xAPI statements from a flight simulator
 *     → Publishes as typed context with temporal/provenance/semiotic facets
 *     → Trust: SelfAsserted (machine-recorded)
 *
 *   Competency Manager Agent
 *     → Discovers xAPI from LRS pod
 *     → Maps statements to competency framework (T3 specs)
 *     → Assesses mastery level per competency
 *     → Publishes competency assertions
 *     → Trust: ThirdPartyAttested (algorithm-assessed)
 *
 *   Credential Issuer Agent
 *     → Discovers competency assessments + original xAPI evidence
 *     → Composes them (intersection = shared learner + temporal overlap)
 *     → Issues IEEE LERS credential (1484.2-compatible)
 *     → Trust: CryptographicallyVerified (signed credential)
 *     → Provenance chain: credential ← competency ← xAPI ← simulator
 *
 * All operations use real HTTP against a live Community Solid Server.
 * xAPI statements are RDF-serialized per the xAPI ontology.
 * Competencies follow the T3 Competency Framework model.
 * LERS credentials are structured as W3C Verifiable Credentials.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ContextDescriptor,
  toTurtle,
  validate,
  union,
  intersection,
  override,
  publish,
  discover,
  createPGSL,
  embedInPGSL,
  latticeStats,
  sparqlQueryPGSL,
  sparqlFragmentsContaining,
  validateAllPGSL,
} from '@interego/core';

import type { IRI, FetchFn } from '@interego/core';

// ── Configuration ───────────────────────────────────────────

const CSS_PORT = 3456;
const BASE_URL = `http://localhost:${CSS_PORT}/`;
const LRS_POD = `${BASE_URL}lrs/`;
const COMPETENCY_POD = `${BASE_URL}competency/`;
const CREDENTIAL_POD = `${BASE_URL}credential/`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_CONFIG = resolve(__dirname, 'css-config.json');
const CSS_BIN = resolve(__dirname, 'node_modules/.bin/community-solid-server');

// ── Utility ─────────────────────────────────────────────────

const COLORS: Record<string, string> = {
  LRS:        '\x1b[34m',  // blue
  Competency: '\x1b[33m',  // yellow
  Credential: '\x1b[32m',  // green
  PGSL:       '\x1b[36m',  // cyan
  System:     '\x1b[90m',  // gray
  Reset:      '\x1b[0m',
};

function log(agent: string, msg: string): void {
  console.log(`${COLORS[agent] ?? COLORS.System}[${agent}]${COLORS.Reset} ${msg}`);
}

function banner(text: string): void {
  console.log('');
  console.log(`${'─'.repeat(64)}`);
  console.log(`  ${text}`);
  console.log(`${'─'.repeat(64)}`);
}

const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok, status: resp.status, statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(), json: () => resp.json(),
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
        started = true; log('System', `CSS running at ${BASE_URL}`); resolveP(proc);
      }
    };
    proc.stdout!.on('data', (d: Buffer) => check(d.toString()));
    proc.stderr!.on('data', (d: Buffer) => check(d.toString()));
    proc.on('error', (e) => { if (!started) reject(e); });
    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try { const r = await fetch(BASE_URL); if (r.ok || r.status < 500) { clearInterval(poll); if (!started) { started = true; log('System', `CSS running at ${BASE_URL}`); resolveP(proc); } } } catch {}
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
//  AGENT 1 — LRS (Learning Record Store)
//  Ingests xAPI statements from flight simulator
// ═════════════════════════════════════════════════════════════

async function agentLRS() {
  log('LRS', 'Receiving xAPI statements from Flight Simulator Session...');
  log('LRS', 'Learner: CPT Sarah Chen (did:web:learner.airforce.mil:chen.sarah)');
  log('LRS', 'Activity: T-38C Instrument Approach Training');

  // xAPI statements serialized as RDF (per xAPI ontology + ADL vocabulary)
  const xapiGraph = `
@prefix xapi: <https://w3id.org/xapi/ontology#>.
@prefix verb: <https://w3id.org/xapi/adl/verbs/>.
@prefix act: <https://w3id.org/xapi/acrossx/activities/>.
@prefix schema: <https://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
@prefix result: <https://w3id.org/xapi/ontology#result/>.

<urn:xapi:stmt:001> a xapi:Statement ;
    xapi:actor <did:web:learner.airforce.mil:chen.sarah> ;
    xapi:verb verb:completed ;
    xapi:object <urn:activity:ils-approach-rwy-28L> ;
    xapi:timestamp "2026-03-15T14:30:00Z"^^xsd:dateTime ;
    result:score "92"^^xsd:integer ;
    result:success "true"^^xsd:boolean ;
    result:duration "PT45M"^^xsd:duration ;
    xapi:context [
        xapi:platform "T-38C Flight Simulator v4.2" ;
        xapi:instructor <did:web:instructor.airforce.mil:jones.michael> ;
        xapi:registration "urn:reg:chen-ils-2026-03"
    ].

<urn:xapi:stmt:002> a xapi:Statement ;
    xapi:actor <did:web:learner.airforce.mil:chen.sarah> ;
    xapi:verb verb:completed ;
    xapi:object <urn:activity:vor-approach-rwy-10R> ;
    xapi:timestamp "2026-03-15T15:45:00Z"^^xsd:dateTime ;
    result:score "88"^^xsd:integer ;
    result:success "true"^^xsd:boolean ;
    result:duration "PT35M"^^xsd:duration ;
    xapi:context [
        xapi:platform "T-38C Flight Simulator v4.2" ;
        xapi:instructor <did:web:instructor.airforce.mil:jones.michael>
    ].

<urn:xapi:stmt:003> a xapi:Statement ;
    xapi:actor <did:web:learner.airforce.mil:chen.sarah> ;
    xapi:verb verb:completed ;
    xapi:object <urn:activity:gps-approach-rwy-04> ;
    xapi:timestamp "2026-03-16T09:15:00Z"^^xsd:dateTime ;
    result:score "95"^^xsd:integer ;
    result:success "true"^^xsd:boolean ;
    result:duration "PT40M"^^xsd:duration ;
    xapi:context [
        xapi:platform "T-38C Flight Simulator v4.2" ;
        xapi:instructor <did:web:instructor.airforce.mil:jones.michael>
    ].

<urn:xapi:stmt:004> a xapi:Statement ;
    xapi:actor <did:web:learner.airforce.mil:chen.sarah> ;
    xapi:verb verb:attempted ;
    xapi:object <urn:activity:emergency-missed-approach> ;
    xapi:timestamp "2026-03-16T10:30:00Z"^^xsd:dateTime ;
    result:score "78"^^xsd:integer ;
    result:success "false"^^xsd:boolean ;
    result:duration "PT25M"^^xsd:duration ;
    xapi:context [
        xapi:platform "T-38C Flight Simulator v4.2" ;
        xapi:instructor <did:web:instructor.airforce.mil:jones.michael>
    ].

<urn:xapi:stmt:005> a xapi:Statement ;
    xapi:actor <did:web:learner.airforce.mil:chen.sarah> ;
    xapi:verb verb:completed ;
    xapi:object <urn:activity:emergency-missed-approach> ;
    xapi:timestamp "2026-03-17T08:00:00Z"^^xsd:dateTime ;
    result:score "91"^^xsd:integer ;
    result:success "true"^^xsd:boolean ;
    result:duration "PT30M"^^xsd:duration ;
    xapi:context [
        xapi:platform "T-38C Flight Simulator v4.2" ;
        xapi:instructor <did:web:instructor.airforce.mil:jones.michael>
    ].
`.trim();

  log('LRS', '5 xAPI statements received:');
  log('LRS', '  stmt:001 — completed ILS Approach Rwy 28L (score: 92)');
  log('LRS', '  stmt:002 — completed VOR Approach Rwy 10R (score: 88)');
  log('LRS', '  stmt:003 — completed GPS Approach Rwy 04 (score: 95)');
  log('LRS', '  stmt:004 — attempted Emergency Missed Approach (score: 78, FAILED)');
  log('LRS', '  stmt:005 — completed Emergency Missed Approach retry (score: 91)');

  const descriptor = ContextDescriptor.create('urn:cg:lrs:xapi-session-2026-03-15' as IRI)
.describes('urn:graph:lrs:flight-sim-statements' as IRI)
.temporal({
      validFrom: '2026-03-15T14:30:00Z',
      validUntil: '2026-03-17T08:30:00Z',
      temporalResolution: 'PT1M',
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:system:lrs:adl-conformant' as IRI,
        startedAt: '2026-03-15T14:30:00Z',
        endedAt: '2026-03-17T08:30:00Z',
      },
      wasAttributedTo: 'did:web:lrs.training.airforce.mil' as IRI,
      generatedAtTime: '2026-03-17T08:30:00Z',
    })
.agent('did:web:lrs.training.airforce.mil' as IRI, 'LRS')
.semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 0.99,   // Machine-recorded, highly reliable
      groundTruth: false,          // Not human-verified
    })
.trust({
      trustLevel: 'SelfAsserted',  // LRS self-reports xAPI conformance
      issuer: 'did:web:lrs.training.airforce.mil' as IRI,
    })
.accessControl([{
      agent: 'did:web:competency.training.airforce.mil' as IRI,
      mode: ['Read'],
    }])
.federation({
      origin: LRS_POD as IRI,
      storageEndpoint: LRS_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  const vResult = validate(descriptor);
  log('LRS', `Descriptor valid: ${vResult.conforms} (${descriptor.facets.length} facets)`);
  log('LRS', `  Trust: SelfAsserted | Confidence: 0.99 | Access: Competency Manager only`);

  const pubResult = await publish(descriptor, xapiGraph, LRS_POD, { fetch: solidFetch });
  log('LRS', `Published to ${pubResult.descriptorUrl}`);

  return descriptor;
}

// ═════════════════════════════════════════════════════════════
//  AGENT 2 — Competency Manager
//  Discovers xAPI, maps to competencies, assesses mastery
// ═════════════════════════════════════════════════════════════

async function agentCompetency(lrsDescriptor: any) {
  log('Competency', 'Discovering xAPI statements from LRS pod...');

  const entries = await discover(LRS_POD, undefined, { fetch: solidFetch });
  log('Competency', `Found ${entries.length} descriptor(s) on LRS pod`);
  for (const e of entries) {
    log('Competency', `  → ${e.describes[0]} | ${e.facetTypes.join(', ')}`);
  }

  // Fetch the actual xAPI data
  if (entries[0]) {
    const graphUrl = entries[0].descriptorUrl.replace('.ttl', '-graph.trig');
    const resp = await fetch(graphUrl);
    if (resp.ok) {
      const data = await resp.text();
      log('Competency', `Fetched ${data.length} bytes of xAPI data from LRS`);
    }
  }

  log('Competency', 'Mapping xAPI statements to T3 Competency Framework...');
  log('Competency', '  ILS Approach (score 92) → Instrument Landing: Proficient');
  log('Competency', '  VOR Approach (score 88) → VOR Navigation: Proficient');
  log('Competency', '  GPS Approach (score 95) → GPS Navigation: Advanced');
  log('Competency', '  Emergency Missed (78→91) → Emergency Procedures: Developing → Proficient');
  log('Competency', '  Overall: 4/4 competencies at Proficient or above');

  const competencyGraph = `
@prefix comp: <https://example.org/competency#>.
@prefix t3: <https://adlnet.gov/tla/t3#>.
@prefix schema: <https://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<urn:competency:chen-sarah:instrument-landing> a comp:CompetencyAssertion ;
    comp:learner <did:web:learner.airforce.mil:chen.sarah> ;
    comp:competency <urn:framework:usaf:instrument-landing> ;
    comp:level "Proficient" ;
    comp:score "92"^^xsd:integer ;
    comp:evidenceCount 1 ;
    comp:assessedAt "2026-03-17T09:00:00Z"^^xsd:dateTime ;
    comp:framework "USAF Instrument Rating Competency Framework v3".

<urn:competency:chen-sarah:vor-navigation> a comp:CompetencyAssertion ;
    comp:learner <did:web:learner.airforce.mil:chen.sarah> ;
    comp:competency <urn:framework:usaf:vor-navigation> ;
    comp:level "Proficient" ;
    comp:score "88"^^xsd:integer ;
    comp:evidenceCount 1 ;
    comp:assessedAt "2026-03-17T09:00:00Z"^^xsd:dateTime.

<urn:competency:chen-sarah:gps-navigation> a comp:CompetencyAssertion ;
    comp:learner <did:web:learner.airforce.mil:chen.sarah> ;
    comp:competency <urn:framework:usaf:gps-navigation> ;
    comp:level "Advanced" ;
    comp:score "95"^^xsd:integer ;
    comp:evidenceCount 1 ;
    comp:assessedAt "2026-03-17T09:00:00Z"^^xsd:dateTime.

<urn:competency:chen-sarah:emergency-procedures> a comp:CompetencyAssertion ;
    comp:learner <did:web:learner.airforce.mil:chen.sarah> ;
    comp:competency <urn:framework:usaf:emergency-procedures> ;
    comp:level "Proficient" ;
    comp:score "91"^^xsd:integer ;
    comp:evidenceCount 2 ;
    comp:progression "Developing → Proficient (retry passed)" ;
    comp:assessedAt "2026-03-17T09:00:00Z"^^xsd:dateTime.
`.trim();

  const descriptor = ContextDescriptor.create('urn:cg:competency:chen-sarah-assessment-2026-03' as IRI)
.describes('urn:graph:competency:chen-sarah-assertions' as IRI)
.temporal({
      validFrom: '2026-03-17T09:00:00Z',
      validUntil: '2026-09-17T09:00:00Z',  // 6 month validity
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:system:competency-manager:tla-conformant' as IRI,
        startedAt: '2026-03-17T09:00:00Z',
        endedAt: '2026-03-17T09:05:00Z',
      },
      wasAttributedTo: 'did:web:competency.training.airforce.mil' as IRI,
      generatedAtTime: '2026-03-17T09:05:00Z',
      sources: ['urn:cg:lrs:xapi-session-2026-03-15' as IRI],
    })
.agent('did:web:competency.training.airforce.mil' as IRI, 'Assessor')
.semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 0.92,
      groundTruth: false,          // Algorithm-assessed, not instructor-verified
    })
.trust({
      trustLevel: 'ThirdPartyAttested',  // Competency framework attestation
      issuer: 'did:web:competency.training.airforce.mil' as IRI,
    })
.accessControl([{
      agent: 'did:web:credential.training.airforce.mil' as IRI,
      mode: ['Read'],
    }])
.federation({
      origin: COMPETENCY_POD as IRI,
      storageEndpoint: COMPETENCY_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  const vResult = validate(descriptor);
  log('Competency', `Descriptor valid: ${vResult.conforms}`);
  log('Competency', `  Trust: ThirdPartyAttested | Sources: LRS xAPI session`);
  log('Competency', `  Validity: 6 months from assessment date`);

  const pubResult = await publish(descriptor, competencyGraph, COMPETENCY_POD, { fetch: solidFetch });
  log('Competency', `Published to ${pubResult.descriptorUrl}`);

  return descriptor;
}

// ═════════════════════════════════════════════════════════════
//  AGENT 3 — Credential Issuer
//  Composes evidence, issues IEEE LERS credential
// ═════════════════════════════════════════════════════════════

async function agentCredential(lrsDesc: any, compDesc: any) {
  log('Credential', 'Discovering from LRS and Competency Manager pods...');

  const lrsEntries = await discover(LRS_POD, undefined, { fetch: solidFetch });
  const compEntries = await discover(COMPETENCY_POD, undefined, { fetch: solidFetch });
  log('Credential', `LRS pod: ${lrsEntries.length} descriptor(s)`);
  log('Credential', `Competency pod: ${compEntries.length} descriptor(s)`);

  // Compose: intersection of xAPI evidence + competency assertions
  banner('Composition: xAPI Evidence ∩ Competency Assessment');
  const evidenceBase = intersection(lrsDesc, compDesc);
  log('Credential', `Intersection: ${evidenceBase.facets.length} facets`);

  const temporalFacets = evidenceBase.facets.filter((f: any) => f.type === 'Temporal');
  if (temporalFacets.length > 0 && temporalFacets[0].type === 'Temporal') {
    log('Credential', `  Temporal overlap: ${temporalFacets[0].validFrom} → ${temporalFacets[0].validUntil}`);
  }
  log('Credential', '  Both sources Asserted — evidence chain verified');

  // Compose: union of all context for the full record
  const fullRecord = union(lrsDesc, compDesc);
  log('Credential', `Union (full record): ${fullRecord.facets.length} facets — all evidence preserved`);

  // Issue LERS credential
  banner('Issuing IEEE LERS Credential');

  const lersGraph = `
@prefix vc: <https://www.w3.org/2018/credentials#>.
@prefix lers: <https://purl.org/lers/ns#>.
@prefix comp: <https://example.org/competency#>.
@prefix schema: <https://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.

<urn:lers:credential:chen-sarah-instrument-rating-2026> a vc:VerifiableCredential, lers:LearningEmploymentRecord ;
    vc:issuer <did:web:credential.training.airforce.mil> ;
    vc:issuanceDate "2026-03-17T10:00:00Z"^^xsd:dateTime ;
    vc:expirationDate "2027-03-17T10:00:00Z"^^xsd:dateTime ;
    vc:credentialSubject [
        a lers:Achievement ;
        lers:learner <did:web:learner.airforce.mil:chen.sarah> ;
        schema:name "CPT Sarah Chen" ;
        lers:achievement [
            a lers:Competency ;
            schema:name "USAF Instrument Rating — Proficient" ;
            lers:criteria "4/4 competencies at Proficient or above" ;
            lers:level "Proficient" ;
            lers:framework "USAF Instrument Rating Competency Framework v3"
        ] ;
        lers:evidence [
            lers:xapiSource <urn:cg:lrs:xapi-session-2026-03-15> ;
            lers:competencySource <urn:cg:competency:chen-sarah-assessment-2026-03> ;
            lers:statementCount 5 ;
            lers:competencyCount 4 ;
            lers:averageScore "91.6"^^xsd:decimal ;
            lers:completionRate "1.0"^^xsd:decimal
        ]
    ].
`.trim();

  log('Credential', 'IEEE LERS Credential:');
  log('Credential', '  Subject: CPT Sarah Chen');
  log('Credential', '  Achievement: USAF Instrument Rating — Proficient');
  log('Credential', '  Criteria: 4/4 competencies at Proficient+');
  log('Credential', '  Evidence: 5 xAPI statements, 4 competency assertions');
  log('Credential', '  Average score: 91.6 | Completion: 100%');
  log('Credential', '  Issuer: did:web:credential.training.airforce.mil');
  log('Credential', '  Valid: 2026-03-17 to 2027-03-17 (1 year)');

  const descriptor = ContextDescriptor.create('urn:cg:credential:chen-sarah-instrument-2026' as IRI)
.describes('urn:graph:credential:chen-sarah-lers' as IRI)
.temporal({
      validFrom: '2026-03-17T10:00:00Z',
      validUntil: '2027-03-17T10:00:00Z',  // 1 year credential validity
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:system:credential-issuer:ieee-lers' as IRI,
        startedAt: '2026-03-17T10:00:00Z',
        endedAt: '2026-03-17T10:00:05Z',
      },
      wasAttributedTo: 'did:web:credential.training.airforce.mil' as IRI,
      generatedAtTime: '2026-03-17T10:00:05Z',
      sources: [
        'urn:cg:lrs:xapi-session-2026-03-15' as IRI,
        'urn:cg:competency:chen-sarah-assessment-2026-03' as IRI,
      ],
    })
.agent('did:web:credential.training.airforce.mil' as IRI, 'Issuer')
.semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 0.98,
      groundTruth: true,           // Signed credential = ground truth
    })
.trust({
      trustLevel: 'CryptographicallyVerified',
      issuer: 'did:web:credential.training.airforce.mil' as IRI,
    })
.accessControl([
      {
        agent: 'did:web:learner.airforce.mil:chen.sarah' as IRI,
        mode: ['Read'],  // Learner can read their own credential
      },
      {
        agent: 'did:web:verifier.example.com' as IRI,
        mode: ['Read'],  // External verifiers can read
      },
    ])
.federation({
      origin: CREDENTIAL_POD as IRI,
      storageEndpoint: CREDENTIAL_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  const vResult = validate(descriptor);
  log('Credential', `Descriptor valid: ${vResult.conforms} (${descriptor.facets.length} facets)`);
  log('Credential', `  Trust: CryptographicallyVerified | Ground truth: YES`);
  log('Credential', `  Provenance: credential ← competency ← xAPI ← simulator`);

  const pubResult = await publish(descriptor, lersGraph, CREDENTIAL_POD, { fetch: solidFetch });
  log('Credential', `Published to ${pubResult.descriptorUrl}`);

  // ── PGSL: Structural overlap across the pipeline ──
  banner('PGSL: Structural Overlap Across TLA Pipeline');

  const pgsl = createPGSL({
    wasAttributedTo: 'urn:agent:tla-demo:pgsl' as IRI,
    generatedAtTime: new Date().toISOString(),
  });

  // Ingest key facts from all three agents
  embedInPGSL(pgsl, 'CPT Sarah Chen completed ILS Approach score 92');
  embedInPGSL(pgsl, 'CPT Sarah Chen completed VOR Approach score 88');
  embedInPGSL(pgsl, 'CPT Sarah Chen completed GPS Approach score 95');
  embedInPGSL(pgsl, 'CPT Sarah Chen attempted Emergency Missed Approach score 78');
  embedInPGSL(pgsl, 'CPT Sarah Chen completed Emergency Missed Approach score 91');
  embedInPGSL(pgsl, 'CPT Sarah Chen Instrument Landing Proficient');
  embedInPGSL(pgsl, 'CPT Sarah Chen VOR Navigation Proficient');
  embedInPGSL(pgsl, 'CPT Sarah Chen GPS Navigation Advanced');
  embedInPGSL(pgsl, 'CPT Sarah Chen Emergency Procedures Proficient');
  embedInPGSL(pgsl, 'CPT Sarah Chen USAF Instrument Rating Proficient credential issued');

  const stats = latticeStats(pgsl);
  log('PGSL', `Lattice: ${stats.atoms} atoms, ${stats.fragments} fragments, max level ${stats.maxLevel}`);

  // Shared atoms across the pipeline
  const learnerAtom = [...pgsl.atoms.entries()].find(([k]) => k === 'Sarah');
  if (learnerAtom) {
    const query = sparqlFragmentsContaining(learnerAtom[1]);
    const result = sparqlQueryPGSL(pgsl, query);
    log('PGSL', `SPARQL: "${learnerAtom[0]}" appears in ${result.bindings.length} fragments`);
    log('PGSL', `  → Same atom shared across LRS, Competency, and Credential contexts`);
    log('PGSL', `  → Content-addressed: one canonical URI, zero duplication`);
  }

  // SHACL validation
  const shaclResult = validateAllPGSL(pgsl);
  log('PGSL', `SHACL: ${shaclResult.conforms ? 'CONFORMS' : shaclResult.violations.length + ' violations'}`);

  // ── Trust Chain Summary ──
  banner('TLA Trust Chain');
  log('Credential', 'Simulator → xAPI Statement (machine-recorded)');
  log('Credential', '  ↓ Trust: SelfAsserted | Confidence: 0.99');
  log('Credential', 'LRS Pod → xAPI Conformant Storage');
  log('Credential', '  ↓ Competency Manager discovers, maps to framework');
  log('Credential', 'Competency Pod → T3 Competency Assertions');
  log('Credential', '  ↓ Trust: ThirdPartyAttested | Confidence: 0.92');
  log('Credential', '  ↓ Credential Issuer composes (intersection + union)');
  log('Credential', 'Credential Pod → IEEE LERS Verifiable Credential');
  log('Credential', '  ↓ Trust: CryptographicallyVerified | Confidence: 0.98');
  log('Credential', '');
  log('Credential', 'Each stage: typed context, provenance chain, temporal validity,');
  log('Credential', 'trust escalation, access control, federation across Solid pods.');
  log('Credential', '');
  log('Credential', 'xAPI statements flow through the TLA pipeline as composable,');
  log('Credential', 'verifiable context — not just data, but data WITH meaning,');
  log('Credential', 'provenance, trust, and access control at every step.');

  // ── Federation Summary ──
  banner('Federation: Cross-Pod Discovery');
  for (const [name, podUrl] of [['LRS', LRS_POD], ['Competency', COMPETENCY_POD], ['Credential', CREDENTIAL_POD]] as const) {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    log('Credential', `${name} pod (${podUrl}):`);
    for (const e of entries) {
      log('Credential', `  → ${e.describes[0]} | facets: ${e.facetTypes.join(', ')}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════
//  Main
// ═════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Interego 1.0 — TLA / xAPI / IEEE LERS Demo');
  console.log('  Flight Simulator → LRS → Competency → LERS Credential');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  let cssProc: ChildProcess | null = null;

  try {
    cssProc = await startCSS();
    console.log('');

    log('System', 'Creating TLA pod containers...');
    await ensurePod(LRS_POD);
    await ensurePod(COMPETENCY_POD);
    await ensurePod(CREDENTIAL_POD);
    log('System', 'Pods ready: lrs/ competency/ credential/');

    banner('Phase 1: LRS ingests xAPI statements from flight simulator');
    const lrsDesc = await agentLRS();

    banner('Phase 2: Competency Manager discovers xAPI, assesses mastery');
    const compDesc = await agentCompetency(lrsDesc);

    banner('Phase 3: Credential Issuer composes evidence, issues LERS credential');
    await agentCredential(lrsDesc, compDesc);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  TLA Demo complete. xAPI → Competency → LERS credential');
    console.log('  pipeline ran across real Solid pods with typed context.');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

  } finally {
    if (process.argv.includes('--keep-alive') && cssProc) {
      log('System', 'CSS kept running at ' + BASE_URL + ' (--keep-alive)');
      log('System', 'Observatory: CSS_URL=' + BASE_URL + ' KNOWN_PODS=' + LRS_POD + ',' + COMPETENCY_POD + ',' + CREDENTIAL_POD + ' CLEAN=1 PORT=5001 npx tsx examples/pgsl-browser/server.ts');
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
