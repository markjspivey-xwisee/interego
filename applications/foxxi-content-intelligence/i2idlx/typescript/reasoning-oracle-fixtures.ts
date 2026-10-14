/**
 * Independent migration diagnostic: compare default RDF/JS and explicit
 * source-compatible native closure with pinned owlrl / rdflib 7.1.4.
 * A mixed simple/typed legacy literal cannot be represented by an RDF/JS set;
 * that fixture must be refused explicitly. Production parity stays strict.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { Store } from 'n3';
import { closure, objects, termKey, RDF, RDFS, OWL, XSD } from './reasoning.js';
import { parseWithLiteralDatatypes, oracleLiteralDatatypes } from './literal-datatypes.js';

interface Summary {
  input: number; closed: number; errorReportTriples: number;
  literalTypes: { value: string; language: string; types: string[] }[];
  schema: string[]; errors: string[];
}
interface Receipt {
  fixture:string; equal:boolean; oracle:Summary; native:Summary; difference?:string;
  compatibility:{status:'matched'|'different'|'refused';native?:Summary;difference?:string;error?:string;expectedRefusal?:boolean};
}
const oracleProgram = String.raw`
import importlib.metadata
import json
import sys
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF, RDFS, OWL
from owlrl import DeductiveClosure, OWLRL_Semantics
from owlrl.Namespaces import ERRNS
assert importlib.metadata.version("rdflib") == "7.1.4"
assert importlib.metadata.version("owlrl") == "7.1.4"
g = Graph().parse(data=sys.stdin.read(), format="turtle")
input_count = len(g)
literals = sorted(set(o for s, p, o in g if isinstance(o, Literal)), key=lambda l: (str(l), l.language or "", str(l.datatype or "")))
DeductiveClosure(OWLRL_Semantics, rdfs_closure=False, axiomatic_triples=False, datatype_axioms=False).expand(g)
types = [{"value": str(l), "language": (l.language or "").lower(), "types": sorted(str(o) for o in g.objects(l, RDF.type))} for l in literals]
schema_predicates = {RDFS.subClassOf, RDFS.subPropertyOf, OWL.equivalentClass, OWL.equivalentProperty}
schema = sorted(" ".join(str(t) for t in (s, p, o)) for s, p, o in g if p in schema_predicates and str(s).startswith("urn:oracle-fixture:"))
error_nodes = set(g.subjects(RDF.type, ERRNS.ErrorMessage))
errors = sorted(str(m) for e in error_nodes for m in g.objects(e, ERRNS.error))
error_report_triples = sum(1 for s, p, o in g if s in error_nodes and ((p == RDF.type and o == ERRNS.ErrorMessage) or p == ERRNS.error))
print(json.dumps({"input": input_count, "closed": len(g), "errorReportTriples": error_report_triples, "literalTypes": types, "schema": schema, "errors": errors}, sort_keys=True))
`;

const prefixes='@prefix : <urn:oracle-fixture:> . @prefix rdf: <'+RDF+'> . @prefix rdfs: <'+RDFS+'> . @prefix owl: <'+OWL+'> . @prefix xsd: <'+XSD+'> . ';
const fixtures:Record<string,string>={
  'plain literal':':s :p "plain label" .',
  'language literal':':s :p "English label"@en .',
  'explicit string literal':':s :p "typed label"^^xsd:string .',
  'plain and explicit string with the same spelling':':s :p "same label", "same label"^^xsd:string .',
  'untyped class cycle':':A rdfs:subClassOf :B . :B rdfs:subClassOf :A .',
  'untyped property cycle':':p rdfs:subPropertyOf :q . :q rdfs:subPropertyOf :p .',
  'declared class and property reflexivity':':Class a owl:Class . :Property a owl:ObjectProperty .',
  'bare reflexive schema declarations':':Class owl:equivalentClass :Class . :Property owl:equivalentProperty :Property . :SelfProperty rdfs:subPropertyOf :SelfProperty .',
  'disjoint class diagnostic':':Assessment rdfs:subClassOf :Process . :Process owl:disjointWith :Person . :x a :Assessment,:Person .',
};
const schemaPredicates=new Set([RDFS+'subClassOf',RDFS+'subPropertyOf',OWL+'equivalentClass',OWL+'equivalentProperty']);
function summarize(input:Store,result:ReturnType<typeof closure>):Summary {
  const literals=[...new Map([...input].filter(q=>q.object.termType==='Literal').map(q=>[termKey(q.object),q.object])).values()];
  return {
    input:input.size,closed:result.graph.size,errorReportTriples:0,
    literalTypes:literals.map(l=>({value:l.value,language:l.termType==='Literal'?l.language.toLowerCase():'',
      types:objects(result.graph,l,RDF+'type').map(o=>o.value).sort()}))
      .sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:a.language.localeCompare(b.language)),
    schema:[...result.graph].filter(q=>schemaPredicates.has(q.predicate.value)&&q.subject.value.startsWith('urn:oracle-fixture:'))
      .map(q=>[q.subject,q.predicate,q.object].map(t=>t.value).join(' ')).sort(),
    errors:result.errors,
  };
}
function difference(native:Summary,oracle:Summary):string|undefined {
  try{
    // OWL-RL appends error-report RDF after inference; native returns those
    // same errors separately. Keep/report raw sizes, compare inference only.
    const {closed:nativeClosed,errorReportTriples:nativeReports,...nativeFacts}=native;
    const {closed:oracleClosed,errorReportTriples:oracleReports,...oracleFacts}=oracle;
    assert.deepEqual({...nativeFacts,closed:nativeClosed-nativeReports},{...oracleFacts,closed:oracleClosed-oracleReports});
    return undefined;
  }
  catch(error){return String(error);}
}
const receipt:Receipt[]=[];
for(const [name,body]of Object.entries(fixtures)) {
  const turtle=prefixes+body;
  const oracle=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-I','-c',oracleProgram],{
    input:turtle,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
  })) as Summary;
  const input=parseWithLiteralDatatypes(turtle).graph;
  const native=summarize(input,closure(input)),defaultDifference=difference(native,oracle);
  let compatibility:Receipt['compatibility'];
  try {
    const result=summarize(input,closure(input,{datatypeOrigins:oracleLiteralDatatypes(input)}));
    const compatibleDifference=difference(result,oracle);
    compatibility={status:compatibleDifference?'different':'matched',native:result,...(compatibleDifference?{difference:compatibleDifference}:{})};
  } catch(error) {
    const expectedRefusal=name==='plain and explicit string with the same spelling'&&/unambiguous source datatype provenance/.test(String(error));
    compatibility={status:'refused',error:String(error),expectedRefusal};
  }
  receipt.push({fixture:name,equal:defaultDifference===undefined,oracle,native,...(defaultDifference?{difference:defaultDifference}:{}),compatibility});
}
process.stdout.write('I2IDLX_REASONING_ORACLE_FIXTURES='+JSON.stringify({
  oracle:{rdflib:'7.1.4',owlrl:'7.1.4'},comparison:{closed:'inference graph before separately represented error-report metadata',errors:'exact messages; no normalization'},fixtures:receipt,
})+'\n');
if(receipt.some(r=>r.compatibility.status==='different'||(r.compatibility.status==='refused'&&!r.compatibility.expectedRefusal)))
  process.exitCode=1;
