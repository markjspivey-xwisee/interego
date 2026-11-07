import { createHash } from 'node:crypto';
import { turtleIriRef } from '@interego/core/rdf';

export interface DemoExperience {
  verb: string; activity: string; activityName: string; score: number;
  success: boolean; duration: string; timestamp: string;
  context?: { platform: string; instructor: string; registration?: string };
}
const NS = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const iri = (value: string) => {
  const reference = turtleIriRef(value);
  if (!reference) throw new Error('An absolute RDF IRI is required.');
  return reference;
};
const literal = (value: string) => JSON.stringify(value);

/** Informational projection of the explicit synthetic demo input, not an LRS
 * protocol conversion or an equivalence with the historical HD activity class.
 * No demo is executed, uploaded or issued a credential by this pure exporter.
 */
export function demoExperienceRdf(legacyIri: string, actorIri: string, experience: DemoExperience): string {
  const s = experience;
  if (!Number.isFinite(s.score) || typeof s.success !== 'boolean' || !/^PT[0-9]+M$/.test(s.duration)
    || !Number.isFinite(Date.parse(s.timestamp)) || !/^[a-z-]+$/.test(s.verb) || !/^[a-zA-Z0-9-]+$/.test(s.activity)) {
    throw new Error('Invalid synthetic demo experience.');
  }
  const source = JSON.stringify({ legacyIri, actorIri, experience });
  const digest = createHash('sha256').update(source).digest('hex');
  const record = iri(legacyIri + ':record'), original = iri(legacyIri), actor = iri(actorIri);
  const sourceIri = iri('urn:interego:demo:source-json:sha256:' + digest);
  return `@prefix xapi: <${NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix dct: <http://purl.org/dc/terms/> .
${record} a xapi:Statement, prov:Entity ;
  <https://schema.org/about> ${original} ;
  prov:wasDerivedFrom ${sourceIri} ;
  dct:references <https://foxxi-bridge.interego.xwisee.com/ns/xapi/2026.10.1> ;
  xapi:actor ${actor} ;
  xapi:verb <https://w3id.org/xapi/adl/verbs/${s.verb}> ;
  xapi:object <urn:activity:${s.activity}> ;
  xapi:timestamp ${literal(s.timestamp)}^^xsd:dateTime ;
  ${s.context ? `xapi:context [ a xapi:Context ; xapi:platform ${literal(s.context.platform)} ; xapi:instructor ${iri(s.context.instructor)} ] ;` : ''}
  xapi:result [ a xapi:Result ;
    xapi:score [ a xapi:Score ; xapi:raw "${s.score}"^^xsd:double ; xapi:max "100"^^xsd:double ] ;
    xapi:success "${s.success}"^^xsd:boolean ; xapi:duration ${literal(s.duration)} ] .
${actor} a xapi:Agent .
<https://w3id.org/xapi/adl/verbs/${s.verb}> a xapi:Verb .
<urn:activity:${s.activity}> a xapi:Activity .
${sourceIri} a prov:Entity ; rdf:value ${literal(source)}^^rdf:JSON ;
  dct:description "Synthetic demo source; no observed learner event or full xAPI SHACL conformance is claimed." .
`;
}
