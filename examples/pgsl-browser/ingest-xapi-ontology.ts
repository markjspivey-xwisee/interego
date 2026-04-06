#!/usr/bin/env tsx
/**
 * Ingest xAPI 2.0 Reference Ontology into PGSL — Structured RDF Triples
 *
 * Each ontology statement is ingested as a structured triple:
 *   ((subject),(predicate),(object))
 *
 * This preserves the graph structure in the lattice:
 *   - Each triple becomes a fragment with 3 nested sub-fragments
 *   - Shared subjects/predicates/objects are content-addressed
 *   - "xapi:Statement" appearing as subject in 11 triples → 1 atom, reused
 *   - The predicate "rdfs:subClassOf" → shared atom across all subclass triples
 *   - OWL restrictions, SHACL shapes all preserve their internal structure
 */

const BASE = process.env['BASE'] ?? 'http://localhost:5000';

async function ingestStructured(content: string): Promise<void> {
  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, granularity: 'structured' }),
  });
  if (!r.ok) console.error('FAIL:', content.slice(0, 60));
}

/** Build a structured triple: ((s1,s2,...),(p1,p2,...),(o1,o2,...)) */
function triple(subject: string, predicate: string, object: string): string {
  const s = subject.split(/\s+/).join(',');
  const p = predicate.split(/\s+/).join(',');
  const o = object.split(/\s+/).join(',');
  return `((${s}),(${p}),(${o}))`;
}

/** Build a structured quad: ((s),(p),(o),(annotation)) */
function quad(subject: string, predicate: string, object: string, annotation: string): string {
  const s = subject.split(/\s+/).join(',');
  const p = predicate.split(/\s+/).join(',');
  const o = object.split(/\s+/).join(',');
  const a = annotation.split(/\s+/).join(',');
  return `((${s}),(${p}),(${o}),(${a}))`;
}

// ═══════════════════════════════════════════════════════════
// xAPI 2.0 Reference Ontology — Class Hierarchy
// ═══════════════════════════════════════════════════════════

const classes = [
  triple('xapi:Statement', 'rdf:type', 'owl:Class'),
  triple('xapi:Actor', 'rdf:type', 'owl:Class'),
  triple('xapi:Agent', 'rdfs:subClassOf', 'xapi:Actor'),
  triple('xapi:Group', 'rdfs:subClassOf', 'xapi:Actor'),
  triple('xapi:IdentifiedGroup', 'rdfs:subClassOf', 'xapi:Group'),
  triple('xapi:AnonymousGroup', 'rdfs:subClassOf', 'xapi:Group'),
  triple('xapi:Verb', 'rdf:type', 'owl:Class'),
  triple('xapi:Object', 'rdf:type', 'owl:Class'),
  triple('xapi:Activity', 'rdfs:subClassOf', 'xapi:Object'),
  triple('xapi:StatementRef', 'rdfs:subClassOf', 'xapi:Object'),
  triple('xapi:SubStatement', 'rdfs:subClassOf', 'xapi:Object'),
  triple('xapi:Result', 'rdf:type', 'owl:Class'),
  triple('xapi:Score', 'rdf:type', 'owl:Class'),
  triple('xapi:Context', 'rdf:type', 'owl:Class'),
  triple('xapi:ContextActivities', 'rdf:type', 'owl:Class'),
  triple('xapi:ActivityDefinition', 'rdf:type', 'owl:Class'),
  triple('xapi:InteractionComponent', 'rdf:type', 'owl:Class'),
  triple('xapi:Attachment', 'rdf:type', 'owl:Class'),
  triple('xapi:Extensions', 'rdf:type', 'owl:Class'),
  triple('xapi:Account', 'rdf:type', 'owl:Class'),
  triple('xapi:LanguageMap', 'rdf:type', 'owl:Class'),
];

// ═══════════════════════════════════════════════════════════
// Properties — with domain and range as structured quads
// ═══════════════════════════════════════════════════════════

const statementProps = [
  quad('xapi:actor', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Actor'),
  quad('xapi:verb', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Verb'),
  quad('xapi:object', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Object'),
  quad('xapi:result', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Result'),
  quad('xapi:context', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Context'),
  quad('xapi:timestamp', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Statement rdfs:range xsd:dateTime'),
  quad('xapi:stored', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Statement rdfs:range xsd:dateTime'),
  quad('xapi:authority', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Agent'),
  quad('xapi:version', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Statement rdfs:range xsd:string'),
  quad('xapi:attachments', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Statement rdfs:range xapi:Attachment'),
  quad('xapi:statementId', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Statement rdfs:range xsd:string'),
];

const actorProps = [
  quad('xapi:objectType', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Actor rdfs:range xsd:string'),
  quad('xapi:mbox', 'rdf:type', 'owl:InverseFunctionalProperty', 'rdfs:domain xapi:Agent rdfs:range xsd:anyURI'),
  quad('xapi:mbox_sha1sum', 'rdf:type', 'owl:InverseFunctionalProperty', 'rdfs:domain xapi:Agent rdfs:range xsd:string'),
  quad('xapi:openid', 'rdf:type', 'owl:InverseFunctionalProperty', 'rdfs:domain xapi:Agent rdfs:range xsd:anyURI'),
  quad('xapi:account', 'rdf:type', 'owl:InverseFunctionalProperty', 'rdfs:domain xapi:Agent rdfs:range xapi:Account'),
  quad('xapi:name', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Agent rdfs:range xsd:string'),
  quad('xapi:member', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Group rdfs:range xapi:Agent'),
  quad('xapi:homePage', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Account rdfs:range xsd:anyURI'),
  quad('xapi:accountName', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Account rdfs:range xsd:string'),
];

const verbProps = [
  quad('xapi:verbId', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Verb rdfs:range xsd:anyURI'),
  quad('xapi:display', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Verb rdfs:range xapi:LanguageMap'),
];

const objectProps = [
  quad('xapi:activityId', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Activity rdfs:range xsd:anyURI'),
  quad('xapi:definition', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Activity rdfs:range xapi:ActivityDefinition'),
  quad('xapi:activityName', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:LanguageMap'),
  quad('xapi:description', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:LanguageMap'),
  quad('xapi:activityType', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xsd:anyURI'),
  quad('xapi:moreInfo', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xsd:anyURI'),
  quad('xapi:interactionType', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xsd:string'),
  quad('xapi:correctResponsesPattern', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xsd:string'),
  quad('xapi:choices', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:InteractionComponent'),
  quad('xapi:interactionScale', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:InteractionComponent'),
  quad('xapi:source', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:InteractionComponent'),
  quad('xapi:target', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:InteractionComponent'),
  quad('xapi:steps', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:InteractionComponent'),
  quad('xapi:activityExtensions', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ActivityDefinition rdfs:range xapi:Extensions'),
  quad('xapi:componentId', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:InteractionComponent rdfs:range xsd:string'),
  quad('xapi:componentDescription', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:InteractionComponent rdfs:range xapi:LanguageMap'),
  quad('xapi:statementRefId', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:StatementRef rdfs:range xsd:string'),
];

const resultProps = [
  quad('xapi:score', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Result rdfs:range xapi:Score'),
  quad('xapi:success', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Result rdfs:range xsd:boolean'),
  quad('xapi:completion', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Result rdfs:range xsd:boolean'),
  quad('xapi:response', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Result rdfs:range xsd:string'),
  quad('xapi:duration', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Result rdfs:range xsd:duration'),
  quad('xapi:resultExtensions', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Result rdfs:range xapi:Extensions'),
  quad('xapi:scaled', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Score rdfs:range xsd:decimal'),
  quad('xapi:raw', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Score rdfs:range xsd:decimal'),
  quad('xapi:min', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Score rdfs:range xsd:decimal'),
  quad('xapi:max', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Score rdfs:range xsd:decimal'),
];

const contextProps = [
  quad('xapi:registration', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Context rdfs:range xsd:string'),
  quad('xapi:instructor', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Context rdfs:range xapi:Agent'),
  quad('xapi:team', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Context rdfs:range xapi:Group'),
  quad('xapi:contextActivities', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Context rdfs:range xapi:ContextActivities'),
  quad('xapi:revision', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Context rdfs:range xsd:string'),
  quad('xapi:platform', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Context rdfs:range xsd:string'),
  quad('xapi:language', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Context rdfs:range xsd:string'),
  quad('xapi:contextStatement', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Context rdfs:range xapi:StatementRef'),
  quad('xapi:contextExtensions', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Context rdfs:range xapi:Extensions'),
  quad('xapi:parent', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ContextActivities rdfs:range xapi:Activity'),
  quad('xapi:grouping', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ContextActivities rdfs:range xapi:Activity'),
  quad('xapi:category', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ContextActivities rdfs:range xapi:Activity'),
  quad('xapi:other', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:ContextActivities rdfs:range xapi:Activity'),
];

const attachmentProps = [
  quad('xapi:usageType', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Attachment rdfs:range xsd:anyURI'),
  quad('xapi:attachmentDisplay', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Attachment rdfs:range xapi:LanguageMap'),
  quad('xapi:attachmentDescription', 'rdf:type', 'owl:ObjectProperty', 'rdfs:domain xapi:Attachment rdfs:range xapi:LanguageMap'),
  quad('xapi:contentType', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Attachment rdfs:range xsd:string'),
  quad('xapi:length', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Attachment rdfs:range xsd:integer'),
  quad('xapi:sha2', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Attachment rdfs:range xsd:string'),
  quad('xapi:fileUrl', 'rdf:type', 'owl:DatatypeProperty', 'rdfs:domain xapi:Attachment rdfs:range xsd:anyURI'),
];

// ═══════════════════════════════════════════════════════════
// OWL Constraints — Cardinality & Restrictions
// ═══════════════════════════════════════════════════════════

const owlConstraints = [
  // Statement — required/optional cardinality
  triple('xapi:Statement', 'owl:minCardinality', 'xapi:actor 1'),
  triple('xapi:Statement', 'owl:minCardinality', 'xapi:verb 1'),
  triple('xapi:Statement', 'owl:minCardinality', 'xapi:object 1'),
  triple('xapi:Statement', 'owl:maxCardinality', 'xapi:actor 1'),
  triple('xapi:Statement', 'owl:maxCardinality', 'xapi:verb 1'),
  triple('xapi:Statement', 'owl:maxCardinality', 'xapi:object 1'),
  triple('xapi:Statement', 'owl:maxCardinality', 'xapi:result 1'),
  triple('xapi:Statement', 'owl:maxCardinality', 'xapi:context 1'),
  triple('xapi:Statement', 'owl:maxCardinality', 'xapi:authority 1'),

  // Agent IFI — exactly one inverse functional identifier
  triple('xapi:Agent', 'owl:exactlyOneOf', 'xapi:mbox xapi:mbox_sha1sum xapi:openid xapi:account'),
  triple('xapi:Agent', 'owl:maxCardinality', 'xapi:mbox 1'),
  triple('xapi:Agent', 'owl:maxCardinality', 'xapi:mbox_sha1sum 1'),
  triple('xapi:Agent', 'owl:maxCardinality', 'xapi:openid 1'),
  triple('xapi:Agent', 'owl:maxCardinality', 'xapi:account 1'),

  // Verb/Activity — required id
  triple('xapi:Verb', 'owl:minCardinality', 'xapi:verbId 1'),
  triple('xapi:Verb', 'owl:maxCardinality', 'xapi:verbId 1'),
  triple('xapi:Activity', 'owl:minCardinality', 'xapi:activityId 1'),
  triple('xapi:Activity', 'owl:maxCardinality', 'xapi:activityId 1'),

  // Score — range restrictions
  triple('xapi:Score', 'owl:restriction', 'xapi:scaled minInclusive -1 maxInclusive 1'),
  triple('xapi:Score', 'owl:restriction', 'xapi:raw requires xapi:min xapi:max'),
  triple('xapi:Score', 'owl:restriction', 'xapi:min lessThanOrEquals xapi:max'),

  // Account — required properties
  triple('xapi:Account', 'owl:minCardinality', 'xapi:homePage 1'),
  triple('xapi:Account', 'owl:minCardinality', 'xapi:accountName 1'),

  // Group constraints
  triple('xapi:AnonymousGroup', 'owl:minCardinality', 'xapi:member 1'),
  triple('xapi:IdentifiedGroup', 'owl:exactlyOneOf', 'xapi:mbox xapi:mbox_sha1sum xapi:openid xapi:account'),

  // SubStatement — nesting restrictions
  triple('xapi:SubStatement', 'owl:restriction', 'xapi:object owl:complementOf xapi:SubStatement'),
  triple('xapi:SubStatement', 'owl:restriction', 'no xapi:statementId xapi:stored xapi:version xapi:authority'),
];

// ═══════════════════════════════════════════════════════════
// SHACL Shapes — Validation Rules
// ═══════════════════════════════════════════════════════════

const shaclShapes = [
  // StatementShape
  quad('shacl:StatementShape', 'sh:targetClass', 'xapi:Statement', 'sh:closed false'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:actor sh:minCount 1 sh:maxCount 1'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:verb sh:minCount 1 sh:maxCount 1'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:object sh:minCount 1 sh:maxCount 1'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:result sh:maxCount 1'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:context sh:maxCount 1'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:timestamp sh:datatype xsd:dateTime'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:statementId sh:pattern uuid'),
  triple('shacl:StatementShape', 'sh:property', 'xapi:authority sh:maxCount 1'),

  // AgentShape
  quad('shacl:AgentShape', 'sh:targetClass', 'xapi:Agent', 'sh:closed false'),
  triple('shacl:AgentShape', 'sh:property', 'xapi:mbox sh:pattern mailto: sh:maxCount 1'),
  triple('shacl:AgentShape', 'sh:property', 'xapi:mbox_sha1sum sh:pattern hex40 sh:maxCount 1'),
  triple('shacl:AgentShape', 'sh:property', 'xapi:openid sh:datatype xsd:anyURI sh:maxCount 1'),
  triple('shacl:AgentShape', 'sh:property', 'xapi:account sh:class xapi:Account sh:maxCount 1'),
  triple('shacl:AgentShape', 'sh:sparql', 'exactlyOneIFI xapi:mbox xapi:mbox_sha1sum xapi:openid xapi:account'),

  // ScoreShape
  quad('shacl:ScoreShape', 'sh:targetClass', 'xapi:Score', 'sh:closed false'),
  triple('shacl:ScoreShape', 'sh:property', 'xapi:scaled sh:datatype xsd:decimal sh:minInclusive -1 sh:maxInclusive 1'),
  triple('shacl:ScoreShape', 'sh:property', 'xapi:raw sh:datatype xsd:decimal'),
  triple('shacl:ScoreShape', 'sh:property', 'xapi:min sh:datatype xsd:decimal'),
  triple('shacl:ScoreShape', 'sh:property', 'xapi:max sh:datatype xsd:decimal'),
  triple('shacl:ScoreShape', 'sh:sparql', 'raw-implies-min-max present'),
  triple('shacl:ScoreShape', 'sh:sparql', 'min-leq-max ordering'),
  triple('shacl:ScoreShape', 'sh:sparql', 'min-leq-raw-leq-max ordering'),

  // ActivityShape
  quad('shacl:ActivityShape', 'sh:targetClass', 'xapi:Activity', 'sh:closed false'),
  triple('shacl:ActivityShape', 'sh:property', 'xapi:activityId sh:minCount 1 sh:datatype xsd:anyURI'),
  triple('shacl:ActivityShape', 'sh:property', 'xapi:definition sh:class xapi:ActivityDefinition'),

  // VerbShape
  quad('shacl:VerbShape', 'sh:targetClass', 'xapi:Verb', 'sh:closed false'),
  triple('shacl:VerbShape', 'sh:property', 'xapi:verbId sh:minCount 1 sh:datatype xsd:anyURI'),
  triple('shacl:VerbShape', 'sh:property', 'xapi:display sh:class xapi:LanguageMap'),

  // ContextShape
  quad('shacl:ContextShape', 'sh:targetClass', 'xapi:Context', 'sh:closed false'),
  triple('shacl:ContextShape', 'sh:property', 'xapi:instructor sh:class xapi:Agent'),
  triple('shacl:ContextShape', 'sh:property', 'xapi:team sh:class xapi:Group'),
  triple('shacl:ContextShape', 'sh:property', 'xapi:contextActivities sh:class xapi:ContextActivities'),
  triple('shacl:ContextShape', 'sh:property', 'xapi:registration sh:datatype xsd:string sh:pattern uuid'),

  // AttachmentShape
  quad('shacl:AttachmentShape', 'sh:targetClass', 'xapi:Attachment', 'sh:closed false'),
  triple('shacl:AttachmentShape', 'sh:property', 'xapi:usageType sh:minCount 1 sh:datatype xsd:anyURI'),
  triple('shacl:AttachmentShape', 'sh:property', 'xapi:contentType sh:minCount 1 sh:datatype xsd:string'),
  triple('shacl:AttachmentShape', 'sh:property', 'xapi:length sh:minCount 1 sh:datatype xsd:integer'),
  triple('shacl:AttachmentShape', 'sh:property', 'xapi:sha2 sh:minCount 1 sh:datatype xsd:string'),

  // GroupShape
  quad('shacl:GroupShape', 'sh:targetClass', 'xapi:Group', 'sh:closed false'),
  triple('shacl:GroupShape', 'sh:property', 'xapi:member sh:class xapi:Agent'),
  triple('shacl:AnonymousGroupShape', 'sh:property', 'xapi:member sh:minCount 1'),

  // AccountShape
  quad('shacl:AccountShape', 'sh:targetClass', 'xapi:Account', 'sh:closed false'),
  triple('shacl:AccountShape', 'sh:property', 'xapi:homePage sh:minCount 1 sh:datatype xsd:anyURI'),
  triple('shacl:AccountShape', 'sh:property', 'xapi:accountName sh:minCount 1 sh:datatype xsd:string'),
];

// ═══════════════════════════════════════════════════════════
// ADL Verb Registry
// ═══════════════════════════════════════════════════════════

const verbs = [
  triple('adl:completed', 'rdf:type', 'xapi:Verb'),
  triple('adl:completed', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/completed'),
  triple('adl:attempted', 'rdf:type', 'xapi:Verb'),
  triple('adl:attempted', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/attempted'),
  triple('adl:passed', 'rdf:type', 'xapi:Verb'),
  triple('adl:passed', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/passed'),
  triple('adl:failed', 'rdf:type', 'xapi:Verb'),
  triple('adl:failed', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/failed'),
  triple('adl:experienced', 'rdf:type', 'xapi:Verb'),
  triple('adl:experienced', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/experienced'),
  triple('adl:answered', 'rdf:type', 'xapi:Verb'),
  triple('adl:answered', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/answered'),
  triple('adl:interacted', 'rdf:type', 'xapi:Verb'),
  triple('adl:interacted', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/interacted'),
  triple('adl:launched', 'rdf:type', 'xapi:Verb'),
  triple('adl:launched', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/launched'),
  triple('adl:shared', 'rdf:type', 'xapi:Verb'),
  triple('adl:shared', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/shared'),
  triple('adl:voided', 'rdf:type', 'xapi:Verb'),
  triple('adl:voided', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/voided'),
  triple('adl:registered', 'rdf:type', 'xapi:Verb'),
  triple('adl:registered', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/registered'),
  triple('adl:progressed', 'rdf:type', 'xapi:Verb'),
  triple('adl:progressed', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/progressed'),
  triple('adl:initialized', 'rdf:type', 'xapi:Verb'),
  triple('adl:initialized', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/initialized'),
  triple('adl:terminated', 'rdf:type', 'xapi:Verb'),
  triple('adl:terminated', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/terminated'),
  triple('adl:suspended', 'rdf:type', 'xapi:Verb'),
  triple('adl:suspended', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/suspended'),
  triple('adl:resumed', 'rdf:type', 'xapi:Verb'),
  triple('adl:resumed', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/resumed'),
  triple('adl:commented', 'rdf:type', 'xapi:Verb'),
  triple('adl:commented', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/commented'),
  triple('adl:mastered', 'rdf:type', 'xapi:Verb'),
  triple('adl:mastered', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/mastered'),
  triple('adl:scored', 'rdf:type', 'xapi:Verb'),
  triple('adl:scored', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/scored'),
  triple('adl:preferred', 'rdf:type', 'xapi:Verb'),
  triple('adl:preferred', 'xapi:verbId', 'http://adlnet.gov/expapi/verbs/preferred'),
];

// ═══════════════════════════════════════════════════════════
// Interaction Types
// ═══════════════════════════════════════════════════════════

const interactionTypes = [
  triple('xapi:true-false', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:true-false', 'rdfs:comment', 'boolean single choice response'),
  triple('xapi:choice', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:choice', 'rdfs:comment', 'select from multiple choices'),
  triple('xapi:fill-in', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:fill-in', 'rdfs:comment', 'short free text response'),
  triple('xapi:long-fill-in', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:long-fill-in', 'rdfs:comment', 'extended text response'),
  triple('xapi:matching', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:matching', 'rdfs:comment', 'match source items to target items'),
  triple('xapi:performance', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:performance', 'rdfs:comment', 'ordered steps to complete'),
  triple('xapi:sequencing', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:sequencing', 'rdfs:comment', 'order items in correct sequence'),
  triple('xapi:likert', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:likert', 'rdfs:comment', 'scale rating single choice'),
  triple('xapi:numeric', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:numeric', 'rdfs:comment', 'numeric value response'),
  triple('xapi:other', 'rdf:type', 'xapi:InteractionType'),
  triple('xapi:other', 'rdfs:comment', 'uncategorized interaction type'),
];

// ═══════════════════════════════════════════════════════════
// cmi5 Profile Extension
// ═══════════════════════════════════════════════════════════

const cmi5 = [
  triple('cmi5:Profile', 'rdfs:subClassOf', 'xapi:Profile'),
  triple('cmi5:launched', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:launched', 'rdfs:comment', 'assignable unit session started by LMS'),
  triple('cmi5:initialized', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:initialized', 'rdfs:comment', 'assignable unit ready for learner'),
  triple('cmi5:completed', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:completed', 'rdfs:comment', 'assignable unit content completed'),
  triple('cmi5:passed', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:passed', 'rdfs:comment', 'assignable unit met mastery criteria'),
  triple('cmi5:failed', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:failed', 'rdfs:comment', 'assignable unit did not meet mastery'),
  triple('cmi5:abandoned', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:abandoned', 'rdfs:comment', 'session timeout no termination'),
  triple('cmi5:waived', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:waived', 'rdfs:comment', 'requirement waived by LMS'),
  triple('cmi5:terminated', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:terminated', 'rdfs:comment', 'session ended normally'),
  triple('cmi5:satisfied', 'rdf:type', 'xapi:Verb'),
  triple('cmi5:satisfied', 'rdfs:comment', 'met moveOn criteria'),
  triple('cmi5:AssignableUnit', 'rdf:type', 'owl:Class'),
  triple('cmi5:AssignableUnit', 'rdfs:comment', 'smallest content object in course'),
  triple('cmi5:Block', 'rdf:type', 'owl:Class'),
  triple('cmi5:Block', 'rdfs:comment', 'container grouping of assignable units'),
  triple('cmi5:Course', 'rdf:type', 'owl:Class'),
  triple('cmi5:Course', 'rdfs:comment', 'top level container of blocks'),
  triple('cmi5:moveOn', 'rdf:type', 'owl:DatatypeProperty'),
  triple('cmi5:moveOn', 'rdfs:range', 'Completed Passed CompletedAndPassed CompletedOrPassed NotApplicable'),
  triple('cmi5:launchMode', 'rdf:type', 'owl:DatatypeProperty'),
  triple('cmi5:launchMode', 'rdfs:range', 'Normal Browse Review'),
  triple('cmi5:masteryScore', 'rdf:type', 'owl:DatatypeProperty'),
  triple('cmi5:masteryScore', 'rdfs:comment', 'scaled score threshold for passing'),
];

// ═══════════════════════════════════════════════════════════
// Ingest everything
// ═══════════════════════════════════════════════════════════

async function main() {
  // Wipe first
  await fetch(`${BASE}/api/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const sections = [
    { name: 'Classes', items: classes },
    { name: 'Statement Properties', items: statementProps },
    { name: 'Actor Properties', items: actorProps },
    { name: 'Verb Properties', items: verbProps },
    { name: 'Object/Activity Properties', items: objectProps },
    { name: 'Result Properties', items: resultProps },
    { name: 'Context Properties', items: contextProps },
    { name: 'Attachment Properties', items: attachmentProps },
    { name: 'OWL Constraints', items: owlConstraints },
    { name: 'SHACL Shapes', items: shaclShapes },
    { name: 'ADL Verbs', items: verbs },
    { name: 'Interaction Types', items: interactionTypes },
    { name: 'cmi5 Profile', items: cmi5 },
  ];

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  console.log(`Ingesting ${total} structured xAPI ontology triples into PGSL...`);
  console.log('');

  let count = 0;
  for (const section of sections) {
    process.stdout.write(`  ${section.name} (${section.items.length})...`);
    for (const item of section.items) {
      await ingestStructured(item);
      count++;
    }
    console.log(' done');
  }

  console.log('');
  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  console.log(`Lattice: ${stats.atoms} atoms, ${stats.fragments} fragments, max level L${stats.maxLevel}`);
  console.log(`Triples ingested: ${count}`);
  console.log('');
  console.log('Structure preserved:');
  console.log('  - Each triple is a fragment: ((subject),(predicate),(object))');
  console.log('  - Shared terms are content-addressed atoms (e.g., "rdf:type" appears once)');
  console.log('  - Property quads include annotations: ((s),(p),(o),(domain/range))');
  console.log('');
  console.log('Open http://localhost:5000/ to browse');
}

main().catch(err => { console.error(err); process.exit(1); });
