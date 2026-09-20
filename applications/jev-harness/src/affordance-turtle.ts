/**
 * Serializes affordance declarations to the same Turtle the monorepo's shared helper emits
 * (applications/_shared/affordance-mcp/index.ts: affordanceToTurtle + affordancesManifestTurtle),
 * so a generic Interego agent reads this vertical's manifest exactly as it reads Foxxi's.
 * One addition: iep:inputShape names the SHACL input shape a follower validates against.
 */

import type { Affordance, AffordanceInput } from './affordance-types.js';
import { escapeTurtleLiteral } from './descriptor.js';
import { iriRef } from './turtle.js';

export const AFFORDANCE_TURTLE_PREFIXES = `@prefix iep:    <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix ieh:   <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat:  <http://www.w3.org/ns/dcat#> .
@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sh:    <http://www.w3.org/ns/shacl#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
@prefix dct:   <http://purl.org/dc/terms/> .`;

const NL = '\n';
const lit = (s: string): string => `"${escapeTurtleLiteral(s)}"`;

function valueConstraints(input: AffordanceInput, indent: string): string {
  const lines: string[] = [];
  if (input.enum && input.enum.length > 0) lines.push(`${indent}sh:in ( ${input.enum.map(lit).join(' ')} )`);
  if (input.minimum !== undefined) lines.push(`${indent}sh:minInclusive ${input.minimum}`);
  if (input.maximum !== undefined) lines.push(`${indent}sh:maxInclusive ${input.maximum}`);
  if (input.minItems !== undefined) lines.push(`${indent}sh:minCount ${input.minItems}`);
  const dt = xsdFor(input);
  if (dt) lines.push(`${indent}sh:datatype ${dt}`);
  return lines.length > 0 ? ` ;${NL}${lines.join(` ;${NL}`)}` : '';
}

function xsdFor(input: AffordanceInput): string | undefined {
  const t = input.type === 'array' ? input.itemType : input.type;
  switch (t) {
    case 'string': return 'xsd:string';
    case 'integer': return 'xsd:integer';
    case 'number': return 'xsd:double';
    case 'boolean': return 'xsd:boolean';
    default: return undefined;
  }
}

function annotationsBlock(a: Affordance): string {
  const ann = a.annotations;
  if (!ann) return '';
  const lines: string[] = [];
  if (ann.readOnlyHint !== undefined) lines.push(`    iep:readOnlyHint ${ann.readOnlyHint}`);
  if (ann.destructiveHint !== undefined) lines.push(`    iep:destructiveHint ${ann.destructiveHint}`);
  if (ann.idempotentHint !== undefined) lines.push(`    iep:idempotentHint ${ann.idempotentHint}`);
  if (ann.openWorldHint !== undefined) lines.push(`    iep:openWorldHint ${ann.openWorldHint}`);
  return lines.length > 0 ? `${lines.join(` ;${NL}`)} ;${NL}` : '';
}

function readsBlock(a: Affordance): string {
  if (!a.reads || a.reads.length === 0) return '';
  const nodes = a.reads.map((r) => `        [
            a dcat:Dataset ;
            rdfs:label ${lit(r.label)} ;
            dct:identifier ${lit(r.store)} ;
            dct:description ${lit(`populated by ${r.populatedBy}`)}
        ]`);
  return `    iep:reads${NL}${nodes.join(' ,' + NL)} ;${NL}`;
}

export function affordanceToTurtle(a: Affordance, deploymentUrl: string): string {
  const target = a.targetTemplate.replace('{base}', deploymentUrl.replace(/\/$/, ''));
  const inputProps = a.inputs.map((input) => `        [
            a hydra:SupportedProperty ;
            hydra:property [ a rdf:Property ; rdfs:label ${lit(input.name)} ] ;
            hydra:required ${input.required ? 'true' : 'false'} ;
            rdfs:comment ${lit(input.description)}${valueConstraints(input, '            ')}
        ]`).join(' ,\n');
  const expects = `    hydra:expects [
        a hydra:Class ;
        rdfs:label ${lit(`${a.toolName}-input`)}${inputProps.trim() ? ` ;${NL}        hydra:supportedProperty${NL}${inputProps}` : ''}
    ] ;`;
  const action = iriRef(a.action);
  const targetRef = iriRef(target);
  const lines = [
    `${action} a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;`,
    `    iep:action ${action} ;`,
    `    hydra:method ${lit(a.method)} ;`,
    `    hydra:title ${lit(a.title)} ;`,
    `    rdfs:comment ${lit(a.description)} ;`,
    `    hydra:target ${targetRef} ;`,
    `    dcat:accessURL ${targetRef} ;`,
    a.mediaType ? `    dcat:mediaType ${lit(a.mediaType)} ;` : '',
    a.returns ? `    hydra:returns ${iriRef(a.returns)} ;` : '',
    a.inputShape ? `    iep:inputShape ${iriRef(a.inputShape)} ;` : '',
    expects,
    annotationsBlock(a) + readsBlock(a) + (typeof a.externallyRouted === 'boolean' ? `    iep:externallyRouted ${a.externallyRouted} ;${NL}` : '') + '    iep:encrypted false .',
  ].filter((l) => l !== '');
  return lines.join(NL);
}

export function affordancesManifestTurtle(
  manifestIri: string,
  affordances: readonly Affordance[],
  deploymentUrl: string,
  options?: { verticalLabel?: string; rdfsComment?: string },
): string {
  const manifest = `${iriRef(manifestIri)} a hydra:Collection ;
    rdfs:label ${lit(options?.verticalLabel ?? 'Vertical capability manifest')} ;
${options?.rdfsComment ? `    rdfs:comment ${lit(options.rdfsComment)} ;${NL}` : ''}${affordances.map((a) => `    iep:affordance ${iriRef(a.action)}`).join(` ;${NL}`)} .`;
  return `${AFFORDANCE_TURTLE_PREFIXES}${NL}${NL}${manifest}${NL}${NL}${affordances.map((a) => affordanceToTurtle(a, deploymentUrl)).join(NL + NL)}${NL}`;
}
