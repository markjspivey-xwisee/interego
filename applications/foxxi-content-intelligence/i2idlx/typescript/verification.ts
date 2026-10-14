/** Fresh native build verification; Python is never imported or invoked. */
import {Store,Parser,DataFactory} from 'n3';
import type {Term,Literal} from '@rdfjs/types';
import {QueryEngine} from '@comunica/query-sparql';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import type {BuildResult} from './generate.js';
import {reconcile,KIND_CODES} from './history.js';
import {closure,objects,subjects,has,union,rdfList,RDF,RDFS,OWL,termKey,reasonerJar,hermit,wideningRisks} from './reasoning.js';
import {shaclValidate,shaclRules} from './validation.js';

const {namedNode:nn,quad}=DataFactory;
const SKOS='http://www.w3.org/2004/02/skos/core#',GS='https://glossarystudio.app/ns/',DCT='http://purl.org/dc/terms/',SH='http://www.w3.org/ns/shacl#';
const CONCEPT_BASE='https://id.i2idl.org/concepts/',EXNS='https://example.org/academy/',DEPLOY='https://example.org/foxxi-deployment/';
const EXPECT:Record<string,string[]>={
 'academy':['obo:BFO_0000027','cco:ont00000564','gist:Organization','dul:Organization','prov:Organization','schema:EducationalOrganization','org:Organization'],
 'teacher-1':['obo:BFO_0000030','cco:ont00001262','gist:Person','dul:Person','gufo:Object','prov:Person','schema:Person'],
 'lrs-main':['obo:IAO_0000010','obo:BFO_0000031','gist:System','dul:InformationObject','schema:SoftwareApplication'],
 'statements-api':['obo:IAO_0000010','schema:WebAPI'],
 'quiz-2026-10-01':['obo:BFO_0000015','cco:ont00000636','gist:Determination','dul:Action','gufo:Event','prov:Activity'],
 'mentoring-07':['obo:BFO_0000015','cco:ont00000234','dul:Action','gufo:Event','schema:Action'],
 'course-le101':['obo:IAO_0000104','cco:ont00000974','dul:Plan','prov:Plan','schema:Course','ceterms:LearningOpportunity'],
 'badge-le101':['obo:IAO_0000310','cco:ont00002002','schema:EducationalOccupationalCredential','ler:Credential','cred:VerifiableCredential'],
 'skill-t1-digital':['obo:BFO_0000016','cco:ont00001379','gist:IntellectualProperty','dul:Quality','gufo:IntrinsicMode'],
 'statement-42':['obo:IAO_0000027','cco:ont00000853','dul:InformationObject','foxxi-xapi:Statement'],
 'campus-north':['obo:BFO_0000040','cco:ont00000995','gist:PhysicalIdentifiableItem','dul:PhysicalArtifact'],
 'ai-use-policy':['obo:IAO_0000033','cco:ont00000965','gist:Requirement','dul:Norm'],
 'le-team':['obo:BFO_0000027','cco:ont00000300','dul:Collective','gufo:Collection'],
 'reading-2026':['obo:IAO_0000027','cco:ont00001163','gist:Magnitude','dul:SocialObjectAttribute','gufo:QualityValue'],
 'spaced-plan':['obo:IAO_0000104','gist:TaskTemplate','dul:Method','prov:Plan'],
 'statement-43':['i2x:DataReferent','obo:IAO_0000027'],
 'lrs-transactional':['i2x:ApplicationReferent','obo:IAO_0000010','schema:SoftwareApplication'],
};
const DEPLOY_EXPECT:Record<string,[string[],string[]]>={
 'ana':[['dul:Person','gist:Person','obo:BFO_0000030','prov:Agent','foxxi-xapi:Agent'],['obo:IAO_0000027','obo:IAO_0000030']],
 'team-7':[['dul:Agent','dul:Collective','obo:BFO_0000027','foxxi-xapi:Group'],['obo:IAO_0000027','obo:IAO_0000030']],
 'tutor-bot':[['prov:Agent','dul:Agent','schema:SoftwareApplication'],['obo:IAO_0000027']],
 'certificate-1':[['obo:IAO_0000030','schema:CreativeWork','foxxi-xapi:Attachment'],['obo:IAO_0000027']],
 'au-1':[['schema:LearningResource','foxxi-cmi5:AssignableUnit'],[]],
 'statement-1':[['obo:IAO_0000027','foxxi-xapi:Statement'],[]],
};
const VOCAB_OF:[string,string][]=[
 ['http://purl.obolibrary.org/obo/BFO_','BFO'],['http://purl.obolibrary.org/obo/IAO_','IAO'],
 ['https://www.commoncoreontologies.org/','CCO'],['https://w3id.org/semanticarts/ns/ontology/gist/','gist'],
 ['http://www.ontologydesignpatterns.org/ont/dul/DUL.owl#','DUL'],['http://purl.org/nemo/gufo#','gUFO'],
 ['http://www.w3.org/ns/prov#','PROV-O'],['https://schema.org/','schema.org'],
];
const parse=(s:string,baseIRI?:string)=>new Store(new Parser({format:'Turtle',baseIRI}).parse(s));
const setEq=(a:Iterable<string>,b:Iterable<string>)=>JSON.stringify([...new Set(a)].sort())===JSON.stringify([...new Set(b)].sort());
const unique=(nodes:Term[])=>[...new Map(nodes.map(n=>[termKey(n),n])).values()];
const value=(g:Store,s:Term,p:string)=>objects(g,s,p)[0]?.value;
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');

const NEGATIVES = [{"body":"@prefix i2x: <{NS}> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<urn:x:internal> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/verb> ; i2x:proposedPredicate skos:exactMatch ;\n  i2x:proposedObject <https://id.i2idl.org/concepts/activity> ; i2x:rationale \"an internal relation smuggled in as a crosswalk\" ;\n  i2x:confidence \"0.9\"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-ai-drafted .\n<urn:x:lexical> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/verb> ; i2x:proposedPredicate skos:exactMatch ;\n  i2x:proposedObject <https://w3id.org/xapi/ontology#Verb> ; i2x:rationale \"label similarity only, then ratified\" ;\n  i2x:confidence \"0.9\"^^xsd:decimal ; i2x:reviewStatus i2x:status-ratified ; i2x:mappingMethod i2x:method-lexical .\n<urn:x:pred> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/verb> ; i2x:proposedPredicate skos:related ;\n  i2x:proposedObject <https://w3id.org/xapi/ontology#Verb> ; i2x:rationale \"uses an internal SKOS relation\" ;\n  i2x:confidence \"1.5\"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-ai-drafted .\n<urn:x:uncited> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/unesco-curriculum> ; i2x:proposedPredicate skos:exactMatch ;\n  i2x:proposedObject <http://vocabularies.unesco.org/thesaurus/concept49> ; i2x:rationale \"claims a citation but names no definition\" ;\n  i2x:confidence \"0.9\"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-evidence-cited .\n","exact":false,"want":["urn:x:internal","urn:x:lexical","urn:x:pred","urn:x:uncited"]},{"body":"@prefix i2x: <{NS}> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n@prefix dct: <http://purl.org/dc/terms/> . @prefix prov: <http://www.w3.org/ns/prov#> . @prefix c: <https://id.i2idl.org/concepts/> .\n<urn:x:new-verb> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-1> ;\n  i2x:rationale \"the proposal that replaces old-verb\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} dct:replaces <urn:x:old-verb> .\n<urn:x:old-verb> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-0> ;\n  i2x:rationale \"superseded, properly\" ; i2x:reviewStatus i2x:status-superseded ; {_mp_fields}\n  dct:isReplacedBy <urn:x:new-verb> ; prov:invalidatedAtTime \"2026-10-13T00:00:00Z\"^^xsd:dateTime .\n<urn:x:orphan> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-0> ;\n  i2x:rationale \"superseded, but names no replacement\" ; i2x:reviewStatus i2x:status-superseded ; {_mp_fields}\n  prov:invalidatedAtTime \"2026-10-13T00:00:00Z\"^^xsd:dateTime .\n<urn:x:elsewhere> a i2x:MappingProposal ; i2x:proposedSubject c:activity ; i2x:proposedObject <urn:x:target-0> ;\n  i2x:rationale \"replaced by a proposal about another concept\" ; i2x:reviewStatus i2x:status-superseded ; {_mp_fields}\n  dct:isReplacedBy <urn:x:new-for-elsewhere> ; prov:invalidatedAtTime \"2026-10-13T00:00:00Z\"^^xsd:dateTime .\n<urn:x:new-for-elsewhere> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-1> ;\n  i2x:rationale \"replaces a proposal about another concept\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} dct:replaces <urn:x:elsewhere> .\n<urn:x:undated> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-2> ;\n  i2x:rationale \"superseded without saying when\" ; i2x:reviewStatus i2x:status-superseded ; {_mp_fields} dct:isReplacedBy <urn:x:new-for-undated> .\n<urn:x:new-for-undated> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-1> ;\n  i2x:rationale \"replaces the undated proposal\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} dct:replaces <urn:x:undated> .\n<urn:x:still-open> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-3> ;\n  i2x:rationale \"names a replacement but is still open\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} dct:isReplacedBy <urn:x:new-for-open> .\n<urn:x:new-for-open> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-1> ;\n  i2x:rationale \"replaces the proposal still open\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} dct:replaces <urn:x:still-open> .\n<urn:x:claims-phantom> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-4> ;\n  i2x:rationale \"claims to replace a proposal that is not there\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} dct:replaces <urn:x:phantom> .\n","exact":true,"want":["urn:x:orphan","urn:x:elsewhere","urn:x:new-for-elsewhere","urn:x:undated","urn:x:still-open","urn:x:claims-phantom"]},{"body":"@prefix i2x: <{NS}> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n@prefix c: <https://id.i2idl.org/concepts/> .\n<urn:x:adopted> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-5> ;\n  i2x:rationale \"adopted: I2IDL asserts the same mapping\" ; i2x:reviewStatus i2x:status-adopted ; {_mp_fields} i2x:i2idlPredicate skos:closeMatch .\n<urn:x:adopted-unsaid> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-6> ;\n  i2x:rationale \"adopted, but does not say how I2IDL maps it\" ; i2x:reviewStatus i2x:status-adopted ; {_mp_fields} .\n<urn:x:adopted-other> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-7> ;\n  i2x:rationale \"adopted, though I2IDL asserts another property\" ; i2x:reviewStatus i2x:status-adopted ; {_mp_fields} i2x:i2idlPredicate skos:exactMatch .\n<urn:x:differs> a i2x:MappingProposal ; i2x:proposedSubject c:verb ; i2x:proposedObject <urn:x:target-8> ;\n  i2x:rationale \"open: I2IDL asserts another property\" ; i2x:reviewStatus i2x:status-proposed ; {_mp_fields} i2x:i2idlPredicate skos:exactMatch .\n","exact":true,"want":["urn:x:adopted-unsaid","urn:x:adopted-other"]},{"body":"@prefix i2x: <{NS}> . @prefix prov: <http://www.w3.org/ns/prov#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<urn:x:rc> a i2x:ReleaseChange ; prov:used <urn:x:r1> ; prov:generated <urn:x:r2> ; prov:endedAtTime \"2026-10-08T00:00:00Z\"^^xsd:dateTime ; i2x:changeCount 3 .\n<urn:x:nothing> a i2x:ChangeEvent ; i2x:partOfChange <urn:x:rc> ; i2x:changeKind i2x:change-concept-added ; i2x:changeCount 1 .\n<urn:x:zero> a i2x:ChangeEvent ; i2x:partOfChange <urn:x:rc> ; i2x:changeKind i2x:change-concept-added ; i2x:changeCount 0 ;\n  i2x:changedConcept <https://id.i2idl.org/concepts/verb> .\n<urn:x:kind> a i2x:ChangeEvent ; i2x:partOfChange <urn:x:rc> ; i2x:changeKind i2x:change-something-else ; i2x:changeCount 1 ;\n  i2x:changedConcept <https://example.org/not-i2idl> .\n","exact":false,"want":["urn:x:nothing","urn:x:zero","urn:x:kind"]},{"body":"@prefix i2x: <{NS}> . @prefix i2idl: <{CONCEPT_BASE}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<urn:x:thing-iri> i2x:isClassifiedBy <https://example.org/not-a-concept> .\n<urn:x:thing-literal> i2x:isClassifiedBy \"learning record store\" .\ni2idl:verb i2x:referentCategory i2x:category-process , i2x:category-information ; i2x:assignmentBasis \"type\" ;\n    i2x:categoryRationale \"two categories for one concept leave its referents ambiguous\"@en .\ni2idl:activity i2x:referentCategory i2x:category-vibes ; i2x:assignmentBasis \"type\" ;\n    i2x:categoryRationale \"a category outside the referent categories\"@en .\ni2idl:actor i2x:referentCategory i2x:category-person ; i2x:assignmentBasis \"gut feeling\" ;\n    i2x:categoryRationale \"a basis other than I2IDL's type or the definition\"@en .\n<https://example.org/my-term> i2x:referentCategory i2x:category-person ; i2x:assignmentBasis \"type\" ;\n    i2x:categoryRationale \"a category for a term I2IDL does not publish\"@en .\n<urn:x:q-both> a i2x:StoredQuery ; rdfs:label \"both\" ; i2x:sparql \"ASK {{}}\" ; i2x:queryForm \"ASK\" ;\n    i2x:runsAgainst <urn:x:port-a> ; i2x:runsOver <urn:x:port-b> .\n<urn:x:q-neither> a i2x:StoredQuery ; rdfs:label \"neither\" ; i2x:sparql \"ASK {{}}\" ; i2x:queryForm \"ASK\" .\n","exact":false,"want":["urn:x:thing-iri","urn:x:thing-literal","https://id.i2idl.org/concepts/verb","https://id.i2idl.org/concepts/activity","https://id.i2idl.org/concepts/actor","https://example.org/my-term","urn:x:q-both","urn:x:q-neither"]}];

export interface BuildVerification {
  inferred:Store;expanded:Store;closed:Store;semantic:Record<string,unknown>;report:string;failures:string[];
}
export async function validateBuild(build:BuildResult,options:{skipHermit?:boolean}={}):Promise<BuildVerification> {
  const {root,cfg,graphs,NS,IRI,metadata,layer}=build,gl=build.glossary;
  const onto=graphs.ontology!,shapes=graphs.shapes!,rules=graphs.rules!,catalog=graphs.catalog!,enact=graphs.enactments!,mappings=graphs.mappings!,releases=graphs.releases!,changes=graphs.changes!,alignments=graphs.alignments!,referents=graphs.referents!;
  const lines:string[]=[],failures:string[]=[];
  const log=(s='')=>{lines.push(s);process.stdout.write(s+'\n');};
  const check=(ok:boolean,what:string)=>{log('- '+(ok?'PASS':'FAIL')+' — '+what);if(!ok)failures.push(what);};
  const loadTurtle=async(file:string)=>parse(await readFile(file,'utf8'),pathToFileURL(resolve(file)).href);
  const dist=build.outputDir??resolve(root,'dist');await mkdir(dist,{recursive:true});
  log('# I2IDL-X native TypeScript build and verification report');log();
  log('- I2IDL release: '+metadata.release+' ('+metadata.commit+')');
  log('- Namespace: '+NS);log();
  for(const [key,text]of Object.entries(build.outputs)){const graph=parse(text);check(graph.size>0,key+' parses: '+graph.size+' triples');}
  const originData=build.origins as {origins:{id:string}[];groups:{id:string}[]};
  const originScheme=nn(NS+'Origins'),originNodes=subjects(onto,SKOS+'inScheme',originScheme);
  const notations=new Map(originNodes.map(n=>[value(onto,n,SKOS+'notation'),n]));
  const wantOrigins=originData.origins.map(o=>o.id);
  check(setEq([...notations.keys()].filter((x):x is string=>x!==undefined),[...wantOrigins,...originData.groups.map(o=>o.id)]),"the ontology's origin scheme contains the workbench's origins and groups");
  check(wantOrigins.every(id=>{const n=notations.get(id)!;return !!value(onto,n,SKOS+'definition')&&!!value(onto,n,SKOS+'scopeNote');}),'every origin has a definition and scope note');
  const held=new Set([...onto.getQuads(null,nn(NS+'heldIn'),null,null)].map(q=>q.object.value));
  check(Object.keys(build.outputs).every(k=>held.has(IRI[k]!)),'every published graph is held by an origin');
  const original=notations.get('i2idl');
  check(!!original&&value(onto,original,SKOS+'prefLabel')==='I2IDL'&&objects(onto,original,NS+'heldIn').every(o=>o.value.startsWith('https://id.i2idl.org/')),"only I2IDL's own services are held by its origin");
  log();
  const upstream=await shaclValidate(gl,shapes,{inference:'none'});
  check(upstream.conforms,'upstream contract conforms ('+upstream.results.length+' violations)');
  if(!upstream.conforms)await writeFile(resolve(dist,'upstream-violations.txt'),upstream.text);
  const lim=subjects(catalog,RDF+'type',nn(NS+'ServiceLimits'))[0];
  const docInt=(pattern:RegExp)=>{const m=pattern.exec(metadata.limitsText);return m?Number(m[1]!.replace(/,/g,'')):null;};
  const documented:Record<string,string|number|null>={
    maxQueryLength:docInt(/query length: .([\d,]+). characters/),
    maxRequestBytes:(docInt(/POST request body: .(\d+) KB./)??0)*1024||null,
    executionTimeout:((n:number|null)=>n?'PT'+n+'S':null)(docInt(/execution guard: .(\d+). seconds/)),
    maxResultRows:docInt(/.SELECT. result size: .([\d,]+). rows/),
    maxResultQuads:docInt(/.DESCRIBE. result size: .([\d,]+). quads/),
    rateLimitPerMinute:docInt(/rate limit: .(\d+). requests per minute/),
  };
  check(!!metadata.limitsDoc&&!!lim&&Object.entries(documented).every(([k,v])=>String(v)===value(catalog,lim,NS+k)),"catalog SPARQL limits match I2IDL's documented limits");
  log();
  const baseUnion=union(gl,enact,mappings),expanded=shaclRules(baseUnion,rules),inferred=new Store();
  for(const q of expanded)if(!has(baseUnion,q.subject,q.predicate,q.object))inferred.addQuad(q);
  const kindNames=['NotionConcept','EnactableConcept','SystemConcept','StandardConcept','FrameworkConcept','ActorConcept','NormativeConcept','DomainConcept'];
  const kindCounts=Object.fromEntries(kindNames.map(k=>[k,subjects(inferred,RDF+'type',nn(NS+k)).length]));
  const nGlossary=subjects(inferred,RDF+'type',nn(NS+'GlossaryConcept')).length;
  check(nGlossary===build.concepts.size,'every concept gets GlossaryConcept typing ('+nGlossary+')');
  check(Object.values(kindCounts).reduce((a,b)=>a+b,0)===build.concepts.size,'every concept gets one agentic kind');
  const nGrounded=subjects(inferred,RDF+'type',nn(NS+'SourceGroundedDefinition')).length;
  const nSynth=subjects(inferred,RDF+'type',nn(NS+'SynthesizedDefinition')).length;
  const nDefs=subjects(gl,RDF+'type',nn(GS+'Definition')).length;
  check(nGrounded+nSynth===nDefs,'definition provenance partitions all definitions');
  check(inferred.getQuads(null,nn(NS+'editorialModality'),null,null).length===build.concepts.size,'editorial modality derived for every concept');
  const roleProps=onto.getQuads(null,nn(NS+'asProperty'),null,null).map(q=>q.object);
  // Enactment links are already in baseUnion. A rule must not invent unratified mapping links.
  check(roleProps.every(p=>inferred.getQuads(null,p as never,null,null).length===0),'enactment rules add no already materialized plain links');
  check(['exactMatch','closeMatch','relatedMatch','broadMatch','narrowMatch'].every(p=>inferred.getQuads(null,nn(SKOS+p),null,null).length===0),'unratified proposals materialize no mapping links');
  for(const key of ['catalog','enactments','mappings','releases','changes','alignments','referents']){
    const report=await shaclValidate(graphs[key]!,shapes,{ontology:onto,inference:'rdfs'});
    check(report.conforms,key+' conforms to superset shapes');
    if(!report.conforms)await writeFile(resolve(dist,key+'-violations.txt'),report.text);
  }
  const mpFields='i2x:confidence "0.8"^^xsd:decimal ; i2x:mappingMethod i2x:method-ai-drafted ; i2x:proposedPredicate skos:closeMatch ;';
  for(let i=0;i<NEGATIVES.length;i++) {
    const fixture=NEGATIVES[i]!;
    const body=fixture.body.replaceAll('{NS}',NS).replaceAll('{CONCEPT_BASE}',CONCEPT_BASE).replaceAll('{_mp_fields}',mpFields).replaceAll('{{','{').replaceAll('}}','}');
    const report=await shaclValidate(parse(body),shapes,{ontology:onto,inference:'rdfs'}),focus=new Set(report.results.map(r=>r.focusNode.value));
    check(!report.conforms&&fixture.want.every(w=>focus.has(w))&&(!fixture.exact||setEq(focus,fixture.want)),'negative SHACL fixture '+(i+1)+' rejects precisely the required malformed records');
  }
  log();
  for(const [name,[replayed,actual]]of Object.entries(reconcile(build.history)))check(replayed===actual,'history '+name+' reconciles ('+replayed+')');
  const eventCount=build.history.reduce((n,r)=>n+r.events.length,0);
  const changeCount=subjects(changes,RDF+'type',nn(NS+'ChangeEvent')).reduce((n,s)=>n+Number(value(changes,s,NS+'changeCount')),0);
  check(eventCount===changeCount,'all '+eventCount+' fact-level history events are preserved');
  check(['concept-added','definition-revised','source-revised','relationship-added','membership-added','evidence-reclassified','external-mapping-added'].every(k=>KIND_CODES.includes(k)),'all roadmap history event types have a change kind');
  const fx=cfg.foxxiNs,archive=process.env.FOXXI_NS_ARCHIVE??(isAbsolute(fx.archive)?fx.archive:resolve(root,fx.archive));
  const foxxiGraphs:Store[]=[];
  let archiveSums=new Map<string,string>();
  try{archiveSums=new Map((await readFile(resolve(archive,'SHA256SUMS'),'utf8')).split(/\r?\n/).filter(Boolean).map(s=>{const [h,...p]=s.trim().split(/\s+/);return [p.join(' '),h!];}));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const module of fx.modules) {
    const file=resolve(archive,module,fx.version+'.ttl'),bytes=await readFile(file);
    const graph=parse(bytes.toString('utf8'),pathToFileURL(file).href);foxxiGraphs.push(graph);
    check(sha(bytes)===fx.sha256[module]&&(!archiveSums.size||archiveSums.get(module+'/'+fx.version+'.ttl')===sha(bytes)),module+' released ontology is byte-for-byte pinned');
    check(setEq([...graph.getQuads(null,nn(OWL+'versionIRI'),null,null)].map(q=>q.object.value),[fx.base+'/'+module+'/'+fx.version]),module+' declares pinned version IRI');
  }
  check(setEq(Object.keys(fx.sha256),fx.modules),'Foxxi pins exactly the released modules');
  const upper=new Store();
  for(const file of (await readdir(resolve(root,'evidence/upper'))).filter(f=>f.endsWith('.ttl')).sort())for(const q of await loadTurtle(resolve(root,'evidence/upper',file)))upper.addQuad(q);
  for(const file of ['xapi-ontology.ttl','xapi-profile-ontology.ttl','iep.ttl','interego-interego.ttl','interego-hypragent.ttl','interego-hyprcat.ttl','interego-harness.ttl'])
    for(const q of await loadTurtle(resolve(root,'evidence',file)))upper.addQuad(q);
  for(const g of foxxiGraphs)for(const q of g)upper.addQuad(q);
  const peers=JSON.parse(await readFile(resolve(root,'evidence/peer-terms.json'),'utf8')) as {terms:Record<string,{label?:string}>};
  const knownTerms=new Set([...upper].filter(q=>q.subject.termType==='NamedNode').map(q=>q.subject.value).concat(Object.keys(peers.terms)));
  const ownTerms=new Set([...onto].filter(q=>q.subject.termType==='NamedNode').map(q=>q.subject.value));
  const sem=layer.sem,usedTerms=new Set<string>();
  for(const c of sem.CATEGORIES)for(const t of [...(c.referent??[]),...(c.concept??[]),...(c.expressible??[])])usedTerms.add(t);
  for(const [s,ts]of [...sem.RECORDS,...sem.INTEREGO]){usedTerms.add(s);for(const t of ts)usedTerms.add(t);}
  for(const [s,ts,,ps]of sem.FOXXI){usedTerms.add(s);for(const t of [...ts,...ps])usedTerms.add(t);}
  for(const [s,,o]of sem.PROPERTIES){usedTerms.add(s);usedTerms.add(o);}
  for(const [,ts]of sem.INDIVIDUALS)for(const t of ts)usedTerms.add(t);
  const unknown=[...usedTerms].filter(t=>!knownTerms.has(layer.expand(t))&&!ownTerms.has(layer.expand(t))&&!t.startsWith('gs:'));
  check(unknown.length===0,'all '+usedTerms.size+' aligned terms exist in publisher snapshots'+(unknown.length?' — '+unknown.slice(0,8).join(', '):''));
  const byVocabulary:Record<string,number>={};for(const t of usedTerms)byVocabulary[t.split(':')[0]!]=(byVocabulary[t.split(':')[0]!]??0)+1;
  const upperManifest=JSON.parse(await readFile(resolve(root,'evidence/upper/manifest.json'),'utf8')) as {sources:{key:string;missing?:boolean;sha256?:string}[]};
  check(upperManifest.sources.every(s=>!s.missing),'every upper-ontology snapshot is present');
  const assignment=layer.assignments(),assignmentEntries=Object.entries(assignment);
  const categoryIds=new Set(sem.CATEGORIES.map(c=>c.id));
  check(setEq(Object.keys(assignment),Object.keys(build.conceptIds))&&assignmentEntries.every(([,a])=>categoryIds.has(a[0])),'every concept has exactly one known referent category');
  const categories:Record<string,number>={},nDef=assignmentEntries.filter(([,a])=>a[2]==='definition').length;
  for(const [,a]of assignmentEntries)categories[a[0]]=(categories[a[0]]??0)+1;
  check(Object.keys(sem.CONCEPT_CATEGORY).every(cid=>cid in build.conceptIds),'every per-concept category names a released concept');
  const columns=[['obo:'],['cco:'],['gist:'],['dul:'],['gufo:'],['prov:'],['schema:','org:','dct:']];
  check(sem.CATEGORIES.filter(c=>(c.mode??'classify')==='classify').every(c=>columns.filter(ps=>layer.referentClasses(c.id).some(t=>ps.some(p=>t.startsWith(p)))).length>=2),'every classifying category aligns to at least two upper ontologies');
  const bridges=layer.classBridges(metadata.mappingClassTargets).length;
  const sample=await loadTurtle(resolve(root,'examples/industry-context.ttl')),clash=await loadTurtle(resolve(root,'examples/industry-context-clash.ttl')),deployment=await loadTurtle(resolve(root,'examples/foxxi-deployment.ttl'));
  const reasonIn=union(upper,onto,alignments,referents,gl,enact,mappings,releases,changes,sample,deployment);
  const start=Date.now(),reasoned=closure(reasonIn),rlSeconds=(Date.now()-start)/1000,closed=reasoned.graph;
  check(reasoned.errors.length===0,'native OWL RL closure is consistent ('+reasonIn.size+' → '+closed.size+' triples)');
  check(reasoned.coverage.unsupported.length===0,'every encountered literal lexical validator is supported'+(reasoned.coverage.unsupported.length?' — '+reasoned.coverage.unsupported.join('; '):''));
  const pfx=Object.entries(layer.prefixes).sort((a,b)=>b[1].length-a[1].length);
  const short=(iri:string)=>{for(const [p,ns]of pfx)if(iri.startsWith(ns))return p+':'+iri.slice(ns.length);return iri;};
  const typesOf=(g:Store,n:Term)=>new Set(objects(g,n,RDF+'type').filter(o=>o.termType==='NamedNode').map(o=>short(o.value)));
  const recordChecks:[string,Term[],string[]][]=[
    ['concepts',[...build.concepts].map(nn),['obo:IAO_0000030','cco:ont00000958','gist:KnowledgeConcept','dul:Concept','obo:BFO_0000031']],
    ['definitions',subjects(gl,RDF+'type',nn(GS+'Definition')),['obo:IAO_0000300','gist:Text','dul:InformationObject']],
    ['evidence records',subjects(gl,RDF+'type',nn(GS+'Evidence')),['obo:IAO_0000030','gist:Content','dul:InformationObject']],
    ['sources',subjects(gl,RDF+'type',nn(DCT+'BibliographicResource')),['obo:IAO_0000310','cco:ont00002039','schema:CreativeWork']],
    ['collections',subjects(gl,RDF+'type',nn(SKOS+'Collection')),['dul:Collection','gist:Collection','schema:DefinedTermSet']],
    ['release changes',subjects(changes,RDF+'type',nn(NS+'ReleaseChange')),['obo:BFO_0000015','cco:ont00000005','gist:Event','schema:UpdateAction']],
  ];
  const records:Record<string,{count:number;typed:number;as:string[]}>={};
  for(const [name,nodes,want]of recordChecks){const n=nodes.filter(n=>want.every(w=>typesOf(closed,n).has(w))).length;records[name]={count:nodes.length,typed:n,as:want};check(n===nodes.length&&n>0,'all '+nodes.length+' '+name+' infer expected upper types');}
  check(['gist:ControlledVocabulary','i2x:InformationReferent','obo:IAO_0000030'].every(w=>typesOf(closed,nn('https://id.i2idl.org/scheme')).has(w)),'I2IDL scheme is a controlled vocabulary and information referent');
  const conceptLevel:Record<string,number>={};
  for(const [cid,[cat]]of assignmentEntries)for(const want of layer.conceptClasses(cat)){conceptLevel[want]??=0;if(typesOf(closed,nn(CONCEPT_BASE+cid)).has(want))conceptLevel[want]++;}
  check(Object.entries(conceptLevel).every(([w,n])=>n===assignmentEntries.filter(([,a])=>layer.conceptClasses(a[0]).includes(w)).length),'concept-level classifications agree with category inheritance');
  const sampleTypes:Record<string,string[]>={},missing:string[]=[];
  for(const [ind,want]of Object.entries(EXPECT)){const have=typesOf(closed,nn(EXNS+ind));sampleTypes[ind]=[...have].sort();for(const w of want)if(!have.has(w))missing.push(ind+' ⊄ '+w);}
  check(missing.length===0,'all '+Object.keys(EXPECT).length+' sample individuals infer expected classifications'+(missing.length?' — '+missing.slice(0,6).join('; '):''));
  const deployWrong:string[]=[];
  for(const [ind,[want,never]]of Object.entries(DEPLOY_EXPECT)){const have=typesOf(closed,nn(DEPLOY+ind));for(const w of want)if(!have.has(w))deployWrong.push(ind+' ⊄ '+w);for(const w of never)if(have.has(w))deployWrong.push(ind+' ⊆ '+w);}
  check(deployWrong.length===0,'Foxxi deployment retains agent, attachment and data distinctions'+(deployWrong.length?' — '+deployWrong.slice(0,6).join('; '):''));
  const rulesIn=union(sample,referents),ruled=shaclRules(rulesIn,rules);
  const refTypes=(g:Store,n:Term)=>objects(g,n,RDF+'type').filter(o=>o.value.startsWith(NS)&&o.value.endsWith('Referent')).map(o=>o.value);
  const explicit=unique([...rulesIn.getQuads(null,nn(NS+'isClassifiedBy'),null,null)].map(q=>q.subject));
  const disagree=explicit.filter(n=>!setEq(refTypes(ruled,n),refTypes(closed,n)));
  const nRuleTypes=explicit.reduce((n,s)=>n+refTypes(ruled,s).length,0);
  check(explicit.length>0&&disagree.length===0,'SHACL-AF referent rules agree with OWL RL on '+explicit.length+' explicitly classified resources');
  const clashReasoned=closure(union(upper,onto,alignments,referents,clash));
  const clashBy=[...new Set(([['BFO','obo/BFO_'],['DUL','dul/DUL.owl'],['gUFO','nemo/gufo']] as const).filter(([,ns])=>clashReasoned.errors.some(e=>e.includes(ns))).map(([k])=>k))].sort();
  check(clashBy.length===3,'assessment/person sample clash is rejected in BFO, DUL and gUFO');
  const hermitResults:Record<string,Record<string,unknown>>={},widening:{risks:string[];properties:number}={risks:[],properties:0};
  if(!options.skipHermit) {
    let jar:string|undefined,jarError:string|undefined;
    try{const jarConfig={...cfg.reasoner,jar:process.env.I2IDLX_REASONER_JAR??(isAbsolute(cfg.reasoner.jar)?cfg.reasoner.jar:resolve(root,cfg.reasoner.jar))};jar=await reasonerJar(jarConfig);}
    catch(error){jarError=String(error);}
    check(!!jar,'HermiT jar is exactly the SHA-256-pinned ROBOT 1.9.11'+(jarError?' — '+jarError:''));
    const groups:Record<string,string[]>={
      'BFO 2020 · IAO · CCO':['bfo','iao','cco'],'gist':['gist'],'DUL':['dul'],'gUFO':['gufo'],
      'PROV-O · schema.org · peers':['prov','schema','org','dct','dcat','lrmi','esco','elm','asn'],
    };
    for(const [name,files]of Object.entries(groups))for(const which of ['sample','clash']) {
      const input=union(onto,alignments,referents,...foxxiGraphs,...(which==='sample'?[gl,enact,mappings,releases,changes,sample,deployment]:[clash]));
      for(const f of files)for(const q of await loadTurtle(resolve(root,'evidence/upper',f+'.ttl')))input.addQuad(q);
      const risks=wideningRisks(input);widening.risks.push(...risks.risks.map(r=>name+' '+which+': '+r));widening.properties=Math.max(widening.properties,risks.properties);
      hermitResults[name]??={};
      try{if(!jar)throw new Error(jarError);const result=await hermit(input,resolve(dist,'.reasoning',name.split(' ')[0]!.toLowerCase()+'-'+which),jar);hermitResults[name]![which]={...result,seconds:Math.round(result.seconds*10)/10,triples:input.size};}
      catch(error){hermitResults[name][which]={error:String(error).slice(0,300)};}
    }
    check(widening.risks.length===0,"HermiT's input widening hides no class-axiom inconsistency");
    for(const [name,result]of Object.entries(hermitResults))check((result.sample as {consistent?:boolean}).consistent===true,'HermiT confirms '+name+' sample consistency');
    const clashDl=Object.keys(hermitResults).filter(g=>(hermitResults[g]!.clash as {consistent?:boolean}).consistent===false);
    const translate:Record<string,string>={'BFO 2020 · IAO · CCO':'BFO','DUL':'DUL','gUFO':'gUFO'};
    check(clashDl.length===clashBy.length&&setEq(clashDl.map(g=>translate[g]).filter((x):x is string=>!!x),clashBy),'HermiT and OWL RL agree on exactly which upper ontologies reject the clash');
  } else log('- INFO — HermiT explicitly skipped; this is a partial developer verification, not the public full-build gate');
    const catClasses=Object.fromEntries(sem.CATEGORIES.map(c=>[c.id,nn(NS+c.cls)]));
  const supers=Object.fromEntries(Object.entries(catClasses).map(([cid,c])=>[cid,unique([c,...objects(closed,c,RDFS+'subClassOf').filter(n=>n.termType==='NamedNode')]).sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0)]));
  const pairKey=(a:Term,b:Term)=>[termKey(a),termKey(b)].sort().join('|'),disjointAxioms=new Set([...closed.getQuads(null,nn(OWL+'disjointWith'),null,null)].map(q=>pairKey(q.subject,q.object)));
  for(const node of subjects(closed,RDF+'type',nn(OWL+'AllDisjointClasses')))for(const head of objects(closed,node,OWL+'members')){const ms=rdfList(closed,head);for(let i=0;i<ms.length;i++)for(let j=i+1;j<ms.length;j++)disjointAxioms.add(pairKey(ms[i]!,ms[j]!));}
  const vocabOf=(iri:string)=>VOCAB_OF.find(([ns])=>iri.startsWith(ns))?.[1]??short(iri).split(':')[0]!;
  const disjoint:Record<string,Record<string,string[]>>={},ids=sem.CATEGORIES.map(c=>c.id);
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    const witness:Record<string,string[]>={};
    for(const a of supers[ids[i]!]!)for(const b of supers[ids[j]!]!)if(disjointAxioms.has(pairKey(a,b))&&!(vocabOf(a.value)in witness))witness[vocabOf(a.value)]=[short(a.value),short(b.value)];
    if(Object.keys(witness).length)disjoint[ids[i]!+'|'+ids[j]!]=witness;
  }
  const pairsIn=union(upper,onto,alignments),PAIR='urn:i2idlx:pair:';
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){const x=nn(PAIR+ids[i]!+'--'+ids[j]!);pairsIn.addQuad(quad(x,nn(RDF+'type'),catClasses[ids[i]!]!));pairsIn.addQuad(quad(x,nn(RDF+'type'),catClasses[ids[j]!]!));}
  const pairStart=Date.now(),pairResult=closure(pairsIn),pairSeconds=(Date.now()-pairStart)/1000,rlDisjoint:Record<string,Set<string>>={},odd:string[]=[];
  for(const e of pairResult.errors){const m=/^Disjoint classes (\S+) and (\S+) have a common individual urn:i2idlx:pair:(\S+)$/.exec(e);if(m){const k=m[3]!.replace('--','|');rlDisjoint[k]??=new Set();rlDisjoint[k].add(vocabOf(m[1]!));}else odd.push(e);}
  const same=setEq(Object.keys(rlDisjoint),Object.keys(disjoint))&&Object.entries(rlDisjoint).every(([k,v])=>setEq(v,Object.keys(disjoint[k]??{})));
  check(same&&odd.length===0,'all '+(ids.length*(ids.length-1)/2)+' category pairs are checked independently against the disjointness table');
  check(setEq(Object.keys(disjoint['assessment|person']??{}),clashBy),'disjointness table explains the representative sample clash');
  const wantLabels=new Set([...usedTerms,...Object.values(disjoint).flatMap(w=>Object.values(w).flat()),...sem.CATEGORIES.map(c=>'i2x:'+c.cls)]);
  const labels:Record<string,string>={};
  for(const curie of [...wantLabels].sort()){
    const iri=nn(layer.expand(curie));let found:string|undefined;
    for(const g of [upper,onto]){
      const candidates=[...objects(g,iri,SKOS+'prefLabel'),...objects(g,iri,RDFS+'label')].filter((n):n is Literal=>n.termType==='Literal').sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0);
      const en=candidates.filter(l=>l.language.toLowerCase().startsWith('en')),plain=candidates.filter(l=>!l.language&&!l.value.endsWith('{it}'));
      if(en.length||plain.length||candidates.length){found=(en[0]??plain[0]??candidates[0])!.value;break;}
    }
    found??=peers.terms[iri.value]?.label;if(found)labels[curie]=found;
  }
  check(Object.keys(labels).length>=.95*wantLabels.size,'at least 95% of aligned labels come from publisher snapshots');
  const querySamples:Record<string,Record<string,string>>={
    'concept-neighborhood':{concept:'<'+CONCEPT_BASE+'learning-record-store-lrs>'},'concept-search':{text:'"record store"'},
    'definition-evidence':{concept:'<'+CONCEPT_BASE+'data-privacy>'},
    'collection-members':{collection:'<https://id.i2idl.org/collections/curated/competency-and-assessment>'},
    'field-intersection':{fieldA:'<https://id.i2idl.org/collections/field/learning-engineering>',fieldB:'<https://id.i2idl.org/collections/field/learning-sciences>'},
    'concepts-by-type':{type:'<https://id.i2idl.org/collections/type/standard>'},'multi-field-concepts':{},'provenance-profile':{},
    'release-check':{version:JSON.stringify(metadata.release)},'classify':{},'concept-referents':{concept:'<'+CONCEPT_BASE+'formative-assessment>'},
  };
  const engine=new QueryEngine(),overGraph=union(onto,alignments,referents,sample);
  const queryResults:Record<string,Store|Record<string,Term>[]>={},queryCounts:Record<string,number|boolean>={};
  const ports=new Set(['port-vocabulary','port-alignments','port-referents']);
  for(const [slug,[meta,body]]of Object.entries(build.stored)) {
    if(!(slug in querySamples))throw new Error('Stored query lacks verification sample: '+slug);
    let q=body;for(const [k,v]of Object.entries(querySamples[slug]!))q=q.replaceAll('$'+k,v);
    const over=(meta.runsOver??'').split(/\s+/).filter(Boolean);
    if(!over.every(p=>ports.has(p)))throw new Error(slug+' uses unknown port');
    const graph=over.length?overGraph:gl,context={sources:[graph]};
    let n:number|boolean;
    if(meta.form==='ASK')n=await engine.queryBoolean(q,context);
    else if(meta.form==='CONSTRUCT'||meta.form==='DESCRIBE'){const stream=await engine.queryQuads(q,context);const result=new Store(await stream.toArray());queryResults[slug]=result;n=result.size;}
    else {const stream=await engine.queryBindings(q,context);const rows=(await stream.toArray()).map(b=>Object.fromEntries([...b].map(([k,v])=>[k.value,v])));queryResults[slug]=rows;n=rows.length;}
    queryCounts[slug]=n;check(n!==false&&n!==0&&body.length<=12000,slug+' ('+meta.form+') returns '+n+' results');
  }
  const provenanceRows=queryResults['provenance-profile'] as Record<string,Term>[];
  const provCounts:Record<string,number>={};for(const r of provenanceRows){if(!r.provenance||!r.definitions)throw new Error('Provenance query returned unexpected bindings');provCounts[r.provenance.value]=Number(r.definitions.value);}
  check(provCounts['source-grounded']===nGrounded&&(provCounts.synthesized??0)===nSynth,'stored query and TripleRule definition provenance agree');
  const qc=queryResults.classify as Store,qTypes=qc.getQuads(null,nn(RDF+'type'),null,null);
  const unsound=qTypes.filter(q=>!has(closed,q.subject,RDF+'type',q.object));
  const sampleTypings=qTypes.filter(q=>q.subject.value.startsWith(EXNS)).length,missed:string[]=[];
  for(const ind of Object.keys(EXPECT))for(const t of refTypes(closed,nn(EXNS+ind)))if(!has(qc,nn(EXNS+ind),RDF+'type',nn(t)))missed.push(ind+' ⊄ '+short(t));
  check(unsound.length===0,'q-classify entails only OWL RL-supported typings');
  check(missed.length===0,'q-classify finds every sample referent class');
  const upperHit=new Set(qTypes.map(q=>short(q.object.value).split(':')[0]));
  check(['obo','cco','gist','dul','gufo','prov','schema'].every(p=>upperHit.has(p)),'q-classify spans all seven upper-ontology families');
  const byResource=Object.fromEntries(unique(qTypes.map(q=>q.subject)).sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0).map(s=>[short(s.value),objects(qc,s,RDF+'type').map(o=>short(o.value)).sort()]));
  const refRuleShape=[...rules].filter(q=>q.subject.termType==='NamedNode'&&q.subject.value.endsWith('#ReferentRules')&&q.predicate.value===SH+'rule').length;
  const semantic:Record<string,unknown>={
    terms:usedTerms.size,byVocabulary,categories,byBasis:{type:assignmentEntries.length-nDef,definition:nDef},bridges,
    owlrl:{input:reasonIn.size,closed:closed.size,seconds:Math.round(rlSeconds*10)/10,errors:reasoned.errors},
    records,conceptLevel,sample:sampleTypes,expected:EXPECT,clash:{owlrl:clashReasoned.errors,rejectedBy:clashBy},
    hermit:hermitResults,reasoner:cfg.reasoner.name,
    rules:{count:refRuleShape,explicit:explicit.length,typings:nRuleTypes,agree:disagree.length===0},
    disjoint,disjointCheck:{pairs:ids.length*(ids.length-1)/2,seconds:Math.round(pairSeconds*10)/10,agree:same&&odd.length===0},
    labels,classify:{typings:qTypes.length,sampleTypings,sound:unsound.length===0,complete:missed.length===0,byResource},
  };
  await writeFile(resolve(dist,'semantic-layer.json'),JSON.stringify(semantic,null,2)+'\n');
  await writeFile(resolve(dist,'native-verification.json'),JSON.stringify({engine:reasoned.coverage,partial:!!options.skipHermit,queryCounts,failures},null,2)+'\n');
  const report=lines.join('\n')+'\n';
  await writeFile(resolve(dist,'native-build-report.md'),report);
  if(failures.length)throw new Error('I2IDL-X native verification failed '+failures.length+' gates: '+failures.slice(0,6).join('; '));
  return {inferred,expanded,closed,semantic,report,failures};
}
