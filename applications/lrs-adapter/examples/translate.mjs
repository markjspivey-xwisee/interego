// LRS Adapter — round-trip xAPI Statement ↔ iep:ContextDescriptor translation.
//
// VERTICAL APPLICATION OF INTEREGO — NOT part of the protocol; not a
// reference implementation of the protocol. Boundary translator only.
// See applications/lrs-adapter/README.md for the framing.
//
// What this script demonstrates:
//
//   1. INGEST: a real-shape xAPI Statement (TLA-style with completion +
//      score + duration) is translated into a iep:ContextDescriptor with
//      seven-facet shape + lrs:StatementIngestion audit record.
//   2. PROJECT (lossless): a born-in-Interego descriptor with iep:modalStatus
//      Asserted is projected to xAPI, with full passthrough fields where
//      they exist.
//   3. PROJECT (lossy + skipped): two harder cases — a Hypothetical
//      descriptor (skipped, with audit note) and a multi-narrative
//      descriptor (projected as the first narrative + extensions for the
//      rest, with explicit lossy=true).

import { randomUUID } from 'node:crypto';

const HR = '─'.repeat(72);
const sep = (label) => console.log(`\n${HR}\n  ${label}\n${HR}`);

console.log(`
╔════════════════════════════════════════════════════════════════════════╗
║  LRS Adapter — xAPI ↔ Interego boundary translation                   ║
║  Boundary adapter (NOT the protocol, NOT a vertical with a framework) ║
╚════════════════════════════════════════════════════════════════════════╝`);

// ── Source LRS endpoint descriptor (provenance anchor) ──────────────

const lrsEndpoint = {
  iri: 'urn:iep:lrs:acme-watershed',
  endpointUrl: 'https://acme.lrs.example/xapi/',
  xapiVersion: '2.0.0',
  authMethod: 'oauth2',
};

// ── Helper: shallow Turtle pretty-printer ────────────────────────────

const turtleBlock = (label, body) =>
  console.log(`\n  ${label}\n${body.split('\n').map(l => '    ' + l).join('\n')}`);
const jsonBlock = (label, obj) =>
  console.log(`\n  ${label}\n${JSON.stringify(obj, null, 2).split('\n').map(l => '    ' + l).join('\n')}`);

// ────────────────────────────────────────────────────────────────────
//  1. INGEST — xAPI Statement → iep:ContextDescriptor
// ────────────────────────────────────────────────────────────────────

sep('1. INGEST — xAPI Statement → iep:ContextDescriptor');

const sourceStatement = {
  id: randomUUID(),
  actor: {
    objectType: 'Agent',
    name: 'Mark Spivey',
    account: { homePage: 'https://acme.example', name: 'mark.spivey' },
  },
  verb: {
    id: 'http://adlnet.gov/expapi/verbs/completed',
    display: { 'en-US': 'completed' },
  },
  object: {
    objectType: 'Activity',
    id: 'https://courses.acme.example/customer-service-101/module-3',
    definition: {
      name: { 'en-US': 'Customer Service 101 — Module 3: Handling Frustration' },
      type: 'http://adlnet.gov/expapi/activities/lesson',
    },
  },
  result: {
    completion: true,
    success: true,
    score: { scaled: 0.86, raw: 86, min: 0, max: 100 },
    duration: 'PT22M14S',
    response: 'Identified second-contact escalation cue in 4 of 5 scenarios.',
  },
  context: {
    registration: randomUUID(),
    contextActivities: {
      parent: [{ id: 'https://courses.acme.example/customer-service-101' }],
    },
    instructor: { name: 'Dr. Patel', mbox: 'mailto:patel@acme.example' },
  },
  timestamp: '2026-04-15T14:32:00Z',
  stored:    '2026-04-15T14:32:01Z',
  authority: { account: { homePage: 'https://acme.lrs.example', name: 'acme-lrs' } },
  version:   '2.0.0',
};

jsonBlock('Source xAPI Statement (from acme-watershed LRS):', sourceStatement);

// Ingest — produce a iep:ContextDescriptor with seven-facet shape +
// lrs:StatementIngestion audit record

const descriptorIri = `urn:iep:lrs-statement:${sourceStatement.id}`;
const ingestionIri  = `urn:iep:lrs-ingestion:${sourceStatement.id}`;

turtleBlock('Ingested iep:ContextDescriptor (Turtle):', `
<${descriptorIri}> a iep:ContextDescriptor ;
    iep:temporal     [ a iep:TemporalFacet ;
                      iep:validFrom  "${sourceStatement.timestamp}"^^xsd:dateTime ;
                      iep:recordedAt "${sourceStatement.stored}"^^xsd:dateTime ] ;
    iep:provenance   [ a iep:ProvenanceFacet ;
                      prov:wasGeneratedBy <${sourceStatement.object.id}> ;
                      prov:wasAttributedTo <urn:agent:${sourceStatement.actor.account.name}> ] ;
    iep:agent        [ a iep:AgentFacet ;
                      iep:assertingAgent <urn:agent:${sourceStatement.actor.account.name}> ] ;
    iep:semiotic     [ a iep:SemioticFacet ;
                      iep:content """${sourceStatement.verb.display['en-US']}: ${sourceStatement.object.definition.name['en-US']}\\nResponse: ${sourceStatement.result.response}""" ;
                      iep:modalStatus iep:Asserted ] ;     # Statements are committed claims by definition
    iep:trust        [ a iep:TrustFacet ;
                      iep:issuer <${sourceStatement.authority.account.homePage}> ;
                      iep:trustLevel iep:ThirdPartyAttested ] ;     # LRS is a third-party authority
    iep:federation   [ a iep:FederationFacet ;
                      iep:origin <${lrsEndpoint.endpointUrl}> ] ;
    # passthrough — preserve original xAPI fields for round-trip fidelity
    lrs:xapiVerb    <${sourceStatement.verb.id}> ;
    lrs:xapiResult  """${JSON.stringify(sourceStatement.result)}""" ;
    lrs:xapiContext """${JSON.stringify(sourceStatement.context)}""" .

<${ingestionIri}> a lrs:StatementIngestion ;
    lrs:ingestedFromEndpoint <${lrsEndpoint.iri}> ;
    lrs:sourceStatementId    "${sourceStatement.id}" ;
    lrs:ingestedDescriptor   <${descriptorIri}> ;
    lrs:projectionLossy      false ;     # ingest direction is generally faithful
    iep:temporal [ a iep:TemporalFacet ; iep:validFrom "${new Date().toISOString()}"^^xsd:dateTime ] .`);

console.log(`
  Ingest direction is generally faithful — every xAPI field has somewhere
  to live in the seven-facet shape, plus passthrough properties preserve
  the original verb / result / context blocks for round-trip fidelity.
  Modal status defaults to iep:Asserted because Statements are committed
  claims by definition.`);

// ────────────────────────────────────────────────────────────────────
//  2. PROJECT — iep:ContextDescriptor (born-in-Interego, Asserted) → xAPI
// ────────────────────────────────────────────────────────────────────

sep('2. PROJECT (lossless-ish) — Asserted descriptor → xAPI Statement');

const internalDescriptor = {
  iri: 'urn:iep:descriptor:performance-feedback:q1-2026',
  modalStatus: 'iep:Asserted',
  agent: 'urn:agent:mark.spivey',
  verb: 'http://adlnet.gov/expapi/verbs/received',
  object: 'urn:iep:performance-review:q1-2026',
  objectName: 'Q1 2026 Performance Review',
  content: 'Manager noted strong performance in customer-service-tone capability area; cited 3 specific second-contact resolutions.',
  issuer: 'https://hr.acme.example',
  timestamp: '2026-04-20T16:00:00Z',
};

const projectionIri = `urn:iep:lrs-projection:${randomUUID()}`;
const projectedStatementId = randomUUID();

const projectedStatement = {
  id: projectedStatementId,
  actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'mark.spivey' } },
  verb:  { id: internalDescriptor.verb, display: { 'en-US': 'received' } },
  object: {
    objectType: 'Activity',
    id: internalDescriptor.object,
    definition: { name: { 'en-US': internalDescriptor.objectName } },
  },
  result: {
    response: internalDescriptor.content,
    extensions: {
      'urn:iep:source-descriptor': internalDescriptor.iri,
      'urn:iep:modal-status': internalDescriptor.modalStatus,
    },
  },
  timestamp: internalDescriptor.timestamp,
  authority: { account: { homePage: internalDescriptor.issuer, name: 'lrs-adapter' } },
  version: '2.0.0',
};

jsonBlock('Projected xAPI Statement (lossless-ish):', projectedStatement);

turtleBlock('Audit record:', `
<${projectionIri}> a lrs:StatementProjection ;
    lrs:projectedDescriptor   <${internalDescriptor.iri}> ;
    lrs:projectedToEndpoint   <${lrsEndpoint.iri}> ;
    lrs:projectedStatementId  "${projectedStatementId}" ;
    lrs:projectionLossy       false ;
    lrs:lossNote """Source descriptor was Asserted with single narrative; xAPI shape adequate for full content.""" .`);

console.log(`
  This direction is "lossless-ish" because every field had somewhere to
  go AND the source had no Hypothetical / multi-narrative / supersedes
  features that xAPI cannot represent. The result.extensions block carries
  the source descriptor IRI so a downstream consumer with Interego access
  can pull the richer descriptor if they need it.`);

// ────────────────────────────────────────────────────────────────────
//  3a. PROJECT — Hypothetical descriptor (SKIPPED with audit note)
// ────────────────────────────────────────────────────────────────────

sep('3a. PROJECT (skipped) — Hypothetical descriptor → NO Statement issued');

const hypotheticalDescriptor = {
  iri: 'urn:iep:fragment:tone-probe:bob-variant:42',
  modalStatus: 'iep:Hypothetical',
  content: 'Observation: explicit-acknowledgment scaffold may have produced user-relief in this scenario.',
};

const skipIri = `urn:iep:lrs-skip:${randomUUID()}`;

turtleBlock('No Statement projected. Skip audit record:', `
<${skipIri}> a lrs:StatementProjection ;
    lrs:projectedDescriptor <${hypotheticalDescriptor.iri}> ;
    lrs:projectedToEndpoint <${lrsEndpoint.iri}> ;
    lrs:projectionLossy     true ;
    lrs:xapiSkipReason """Source descriptor has iep:modalStatus iep:Hypothetical. xAPI Statements are committed claims by spec — projecting a Hypothetical descriptor as a Statement would over-claim. Skipped on purpose; this audit row exists so the LRS-anchored team can see what was withheld.""" .`);

console.log(`
  Hypothetical / Counterfactual descriptors are SKIPPED. The audit row
  records that they existed, and why they were withheld, so an auditor
  can see what the LRS isn't seeing.`);

// ────────────────────────────────────────────────────────────────────
//  3b. PROJECT — multi-narrative descriptor (LOSSY)
// ────────────────────────────────────────────────────────────────────

sep('3b. PROJECT (lossy) — multi-narrative synthesis → single Statement + extensions');

const synthesisDescriptor = {
  iri: 'urn:iep:synthesis:tone-probe-week-1',
  modalStatus: 'iep:Hypothetical',  // would normally be skipped, but say org wants it for dashboards anyway
  emergentPattern: 'Explicit-acknowledgment pattern produced user-relief in 2 of 2 second-contact scenarios.',
  coherentNarratives: [
    'Reading 1: explicit-acknowledgment scaffold creates space for the user to feel heard.',
    "Reading 2: it's not the words — it's the SIGNAL that the agent paid attention to context.",
    'Reading 3: noise; sample of 10 too small to distinguish from random variation.',
  ],
  supersedes: 'urn:iep:synthesis:tone-probe-week-0-draft',
  timestamp: '2026-04-22T10:00:00Z',
};

const lossyProjectionIri = `urn:iep:lrs-projection:${randomUUID()}`;
const lossyStatementId = randomUUID();

// Suppose the org has explicitly opted to project Hypothetical syntheses
// to their LRS dashboard anyway — the adapter accommodates this with a
// loud audit trail.

const lossyStatement = {
  id: lossyStatementId,
  actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'observer-ravi' } },
  verb:  { id: 'http://adlnet.gov/expapi/verbs/observed', display: { 'en-US': 'observed' } },
  object: {
    objectType: 'Activity',
    id: synthesisDescriptor.iri,
    definition: { name: { 'en-US': 'Sensemaking synthesis: tone probe week 1' } },
  },
  result: {
    response: synthesisDescriptor.emergentPattern + ' [Reading 1] ' + synthesisDescriptor.coherentNarratives[0],
    extensions: {
      'urn:iep:source-descriptor':    synthesisDescriptor.iri,
      'urn:iep:modal-status':         synthesisDescriptor.modalStatus,
      'urn:iep:coherent-narratives':  synthesisDescriptor.coherentNarratives,
      'urn:iep:supersedes-chain':     [synthesisDescriptor.supersedes],
      'urn:iep:projection-lossy':     true,
    },
  },
  timestamp: synthesisDescriptor.timestamp,
  authority: { account: { homePage: 'https://acme.example', name: 'lrs-adapter' } },
  version: '2.0.0',
};

jsonBlock('Projected xAPI Statement (lossy — extensions carry the rest):', lossyStatement);

turtleBlock('Audit record (loud about what was lost):', `
<${lossyProjectionIri}> a lrs:StatementProjection ;
    lrs:projectedDescriptor   <${synthesisDescriptor.iri}> ;
    lrs:projectedToEndpoint   <${lrsEndpoint.iri}> ;
    lrs:projectedStatementId  "${lossyStatementId}" ;
    lrs:projectionLossy       true ;
    lrs:lossNote """Source descriptor had iep:modalStatus iep:Hypothetical — projected anyway at org's explicit request for dashboard purposes. Modal status preserved as result.extensions but xAPI consumers will read this as a committed claim unless they look at the extensions.""" ;
    lrs:lossNote """Source descriptor had 3 coherent narratives. First narrative emitted in result.response; remaining 2 preserved in result.extensions[urn:iep:coherent-narratives]. Standard LRS dashboards will only show Reading 1.""" ;
    lrs:lossNote """Source descriptor had iep:supersedes chain. Preserved in result.extensions[urn:iep:supersedes-chain] but xAPI's voiding mechanism is not equivalent.""" .`);

console.log(`
  This is the worst case the adapter handles: a complexity-informed
  descriptor projected to xAPI for org-side dashboard reasons. The
  Statement looks committed to standard LRS consumers; the lossy=true
  flag + multiple lossNote rows make the over-claim visible to any
  auditor who walks the audit trail.`);

// ────────────────────────────────────────────────────────────────────
//  Closing
// ────────────────────────────────────────────────────────────────────

sep('translation complete');

console.log(`
  Three cases demonstrated:
    1. Ingest    (xAPI → Interego): faithful with passthrough
    2. Project   (Asserted → xAPI):       lossless-ish
    3a. Project  (Hypothetical → xAPI):   SKIPPED with audit row
    3b. Project  (multi-narrative → xAPI): LOSSY with loud audit trail

  The key invariant: every translation step is recorded as an
  lrs:StatementProjection / lrs:StatementIngestion audit row, with
  projectionLossy + lossNote making honest about what was dropped.
  This is the right place for xAPI shape — at the edge, not in core.

  This adapter is consumed by applications/learner-performer-companion/,
  which uses ingest direction to bring the user's xAPI history into
  their pod for grounded chat with the Interego agent.
`);
