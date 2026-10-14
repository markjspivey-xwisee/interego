/**
 * Local per-concept decoration projection.
 * The invariant SPARQL control definitions live in src/queries/build;
 * the shared Foxxi Graph serializer emits the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, union, construct, RDF, OWL, DCT, PROV, RDFS, nn, literal, serializeTurtle } from './rdf.js';
import { type BuildResult, CONCEPT_BASE, IEP, HYDRA, ACTION_ROOT } from './generate.js';

export interface DecorationResult {graph: Store; inherited: Store; affordances: number; turtle: string; file: string}
export async function materializeDecorations(build: BuildResult, inferred: Store): Promise<DecorationResult> {
  const text=readFileSync(join(build.root,'src','queries','build','decorations.rq'),'utf8');
  const graph=await construct(build.render(text),union(build.glossary,build.graphs.catalog!));
  for(const q of inferred.getQuads(null,null,null,null)) {
    if([RDF+'type',build.NS+'editorialModality'].includes(q.predicate.value) &&
      (q.subject.value.startsWith(CONCEPT_BASE)||q.subject.value.startsWith('https://id.i2idl.org/definitions/')))graph.addQuad(q);
  }
  for(const q of build.graphs.enactments!.getQuads(null,null,null,null)) {
    if(q.predicate.value.startsWith(build.NS)&&q.subject.value.startsWith(CONCEPT_BASE))graph.addQuad(q);
  }
  // Use the canonical declarations of enactedBy's sub-properties; inheritance
  // is reachability through skos:broader, excluding the same direct capability.
  const inherited=await construct(
    'PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX i2x: '+safeNamespace(build.NS)+'\n'+
    'CONSTRUCT { ?c i2x:inheritedEnactedBy ?a } WHERE { '+
    '?c skos:broader+ ?b . ?b ?p ?a . ?p rdfs:subPropertyOf+ i2x:enactedBy . '+
    'FILTER NOT EXISTS { ?c ?p2 ?a . ?p2 rdfs:subPropertyOf+ i2x:enactedBy } }',
    union(build.glossary,build.graphs.enactments!,build.graphs.ontology!));
  graph.addQuads(inherited.getQuads(null,null,null,null));
  const decor=nn(build.IRI.decorations!);
  graph.addQuad(decor,nn(RDF+'type'),nn(OWL+'Ontology'));
  graph.addQuad(decor,nn(DCT+'title'),literal('I2IDL-X decorations (materialized)','en'));
  graph.addQuad(decor,nn(PROV+'wasDerivedFrom'),nn(build.IRI.catalog!));
  graph.addQuad(decor,nn(PROV+'wasDerivedFrom'),nn('https://github.com/blakeplock/i2idl-linked-data/blob/'+build.metadata.commit+'/public/glossary.jsonld'));
  const prefixes={i2x:build.NS,cat:build.IRI.catalog+'#',dec:build.IRI.decorations+'#','iep': IEP,
    ieh:'https://markjspivey-xwisee.github.io/interego/ns/harness#',hydra:HYDRA,
    dcat:'http://www.w3.org/ns/dcat#',prov:PROV,i2idl:CONCEPT_BASE,fxa:ACTION_ROOT+'foxxi/',rla:ACTION_ROOT+'relay/',
    rdf:RDF,owl:OWL,dct:DCT,rdfs:RDFS};
  const turtle=await serializeTurtle(graph,prefixes),file=build.cfg.slugs.decorations+'.ttl';
  const affordances=new Set(graph.getQuads(null,RDF+'type',IEP+'Affordance',null).map(q=>q.subject.value)).size;
  return {graph,inherited,affordances,turtle,file};
}
export function writeDecorations(build: BuildResult,result: DecorationResult): void {
  writeFileSync(join(build.outputDir,result.file),result.turtle);
}
// Uses the same checked Turtle IRI helper as graph rendering.
import { safeIri } from './rdf.js';
const safeNamespace = safeIri;
