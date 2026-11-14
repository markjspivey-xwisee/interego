/**
 * Territories, factions, pacts, agents and interventions as Interego descriptors.
 * The descriptor is the substrate's (facets, supersedes, causal intervention).
 * The named graph beside it is this vertical's own triples (cpw:).
 */
import {
  ContextDescriptor, canonicalJson, escapeTurtleLiteral, toTurtle,
  type ContextDescriptorData, type IRI,
} from '@interego/core';
import { CPW, holderOf, type WorldPack } from './pack.js';

const iri = (value: string): IRI => value as IRI;
const lit = (value: string): string => `"${escapeTurtleLiteral(value)}"`;

export interface GraphBundle {
  readonly id: string;
  readonly data: ContextDescriptorData;
  readonly turtle: string;
  readonly graph: string;
  readonly canonical: string;
}

function bundle(data: ContextDescriptorData, graph: string): GraphBundle {
  return { id: data.id, data, turtle: toTurtle(data, { extraPrefixes: { cpw: CPW } }), graph, canonical: canonicalJson(data) };
}

function prefix(): string {
  return `@prefix cpw: <${CPW}> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
}

export function factionGraph(input: {
  readonly pack: WorldPack; readonly base: string; readonly factionId: string; readonly name: string;
  readonly podUrl: string; readonly did: string; readonly at: string;
}): GraphBundle {
  const id = iri(`${input.base}descriptors/faction/${input.factionId}/v/1`);
  const graphIri = `${input.base}graphs/faction/${input.factionId}`;
  const data = ContextDescriptor.create(id)
    .describes(iri(graphIri))
    .version(1)
    .conformsTo(iri(CPW.slice(0, -1)))
    .generatedBy(iri(input.did), { endedAt: input.at, activityId: iri(`${input.base}activities/faction/${input.factionId}`) })
    .selfAsserted(iri(input.did))
    .fromSolid(iri(input.podUrl), iri(input.podUrl), input.at)
    .build();
  const graph = `${prefix()}<${graphIri}> a cpw:Faction ; cpw:name ${lit(input.name)} ; cpw:pack <${input.pack.id}> .\n`;
  return bundle(data, graph);
}

export function territoryGraph(input: {
  readonly pack: WorldPack; readonly base: string; readonly territoryId: string; readonly name: string;
  readonly control: Readonly<Record<string, number>>; readonly version: number; readonly supersedes?: string; readonly at: string;
  readonly writerDid: string;
}): GraphBundle {
  const id = iri(`${input.base}descriptors/territory/${input.territoryId}/v/${input.version}`);
  const graphIri = `${input.base}graphs/territory/${input.territoryId}`;
  const order = input.pack.factions.map(f => f.id);
  const held = holderOf(input.control, order);
  let builder = ContextDescriptor.create(id)
    .describes(iri(graphIri))
    .version(input.version)
    .conformsTo(iri(CPW.slice(0, -1)))
    .generatedBy(iri(input.writerDid), { endedAt: input.at })
    .selfAsserted(iri(input.writerDid))
    .fromSolid(iri(`${input.base}factions/${held}/`), iri(`${input.base}factions/${held}/`), input.at);
  if (input.supersedes) builder = builder.supersedes(iri(input.supersedes));
  const shares = order.map(fid => `cpw:controlShare [ cpw:faction <${input.base}factions/${fid}/> ; cpw:share "${input.control[fid] ?? 0}"^^xsd:decimal ]`).join(' ;\n  ');
  const graph = `${prefix()}<${graphIri}> a cpw:Territory ; cpw:name ${lit(input.name)} ; cpw:heldBy <${input.base}factions/${held}/> ;\n  ${shares} .\n`;
  return bundle(builder.build(), graph);
}

export function pactGraph(input: {
  readonly base: string; readonly a: string; readonly b: string; readonly version: number; readonly at: string;
  readonly writerDid: string; readonly ended?: boolean; readonly supersedes?: string;
}): GraphBundle {
  const key = [input.a, input.b].sort().join('--');
  const id = iri(`${input.base}descriptors/pact/${key}/v/${input.version}`);
  const graphIri = `${input.base}graphs/pact/${key}`;
  let builder = ContextDescriptor.create(id)
    .describes(iri(graphIri), iri(`${input.base}graphs/faction/${input.a}`), iri(`${input.base}graphs/faction/${input.b}`))
    .version(input.version)
    .generatedBy(iri(input.writerDid), { endedAt: input.at })
    .selfAsserted(iri(input.writerDid))
    .federation({
      origin: iri(`${input.base}factions/${input.a}/`),
      replicaOf: iri(`${input.base}graphs/faction/${input.b}`),
      storageEndpoint: iri(`${input.base}factions/${input.a}/`),
      syncProtocol: 'SolidNotifications',
      lastSynced: input.at,
    });
  if (input.supersedes) builder = builder.supersedes(iri(input.supersedes));
  if (input.ended) builder = builder.semiotic({ modalStatus: 'Counterfactual', groundTruth: false });
  const graph = `${prefix()}<${graphIri}> a cpw:Pact ; cpw:party <${input.base}factions/${input.a}/> ; cpw:party <${input.base}factions/${input.b}/> ; cpw:matched ${input.ended ? 'false' : 'true'} .\n`;
  return bundle(builder.build(), graph);
}

export function agentGraph(input: {
  readonly base: string; readonly agentId: string; readonly name: string; readonly did: string; readonly podUrl: string;
  readonly controllerDid: string | undefined; readonly version: number; readonly supersedes?: string; readonly at: string;
  readonly lessons: readonly { readonly text: string; readonly causeId: string; readonly matched: boolean }[];
}): GraphBundle {
  const id = iri(`${input.base}descriptors/agent/${input.agentId}/v/${input.version}`);
  const graphIri = `${input.base}graphs/agent/${input.agentId}`;
  let builder = ContextDescriptor.create(id)
    .describes(iri(graphIri))
    .version(input.version)
    .generatedBy(iri(input.did), { endedAt: input.at, ...(input.controllerDid ? { onBehalfOf: iri(input.controllerDid) } : {}) })
    .selfAsserted(iri(input.did))
    .fromSolid(iri(input.podUrl), iri(input.podUrl), input.at);
  if (input.supersedes) builder = builder.supersedes(iri(input.supersedes));
  const lessons = input.lessons.map(lesson => `cpw:lesson [ a cpw:Lesson ; cpw:text ${lit(lesson.text)} ; cpw:cause ${lit(lesson.causeId)} ; cpw:matched ${lesson.matched} ]`).join(' ;\n  ');
  const controller = input.controllerDid ? ` ; cpw:controlledBy <${input.controllerDid}>` : '';
  const graph = `${prefix()}<${graphIri}> a cpw:Agent ; cpw:name ${lit(input.name)}${controller}${lessons ? ` ;\n  ${lessons}` : ''} .\n`;
  return bundle(builder.build(), graph);
}

export function interventionGraph(input: {
  readonly base: string; readonly missionId: string; readonly observationId: string; readonly causeId: string;
  readonly interventionId: string; readonly agentDid: string; readonly consultantDid: string; readonly at: string;
  readonly delta: number;
}): GraphBundle {
  const id = iri(`${input.base}descriptors/intervention/${input.missionId}`);
  const graphIri = `${input.base}graphs/intervention/${input.missionId}`;
  const data = ContextDescriptor.create(id)
    .describes(iri(graphIri))
    .version(1)
    .generatedBy(iri(input.agentDid), { onBehalfOf: iri(input.consultantDid), endedAt: input.at })
    .selfAsserted(iri(input.agentDid))
    .intervention([{ variable: input.causeId, value: input.interventionId }], iri(input.observationId))
    .build();
  const graph = `${prefix()}<${graphIri}> a cpw:Lesson ; cpw:cause ${lit(input.causeId)} ; cpw:matched ${input.delta !== 0} ; cpw:text ${lit(String(input.delta))} .\n`;
  return bundle(data, graph);
}

export function observationGraph(input: {
  readonly base: string; readonly registration: string; readonly agentDid: string; readonly at: string;
}): GraphBundle {
  const id = iri(`${input.base}descriptors/observation/${input.registration}`);
  const graphIri = `${input.base}graphs/observation/${input.registration}`;
  const data = ContextDescriptor.create(id)
    .describes(iri(graphIri))
    .version(1)
    .generatedBy(iri(input.agentDid), { endedAt: input.at })
    .observation()
    .selfAsserted(iri(input.agentDid))
    .build();
  const graph = `${prefix()}<${graphIri}> cpw:text ${lit(input.registration)} .\n`;
  return bundle(data, graph);
}
