/**
 * Exact small-graph parity against unchanged layer.closure, including retained
 * post-saturation diagnostic RDF and the layer's filtered returned errors.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DEFAULT_ROOT } from './config.js';
import { parseWithLiteralDatatypes } from './literal-datatypes.js';
import { sourceLiteralRecords, applyOracleLiteralNormalizations, type OracleLiteralNormalization } from './reasoning-probe-input.js';
import { matchFreshReportNodes } from './reasoning-probe-reports.js';
import { closure, subjects, objects, termKey, RDF, OWL, XSD } from './reasoning.js';
import { DataFactory } from 'n3';

const python="\nimport importlib.metadata\nimport importlib.util\nimport json\nimport pathlib\nimport sys\nfrom rdflib import Graph, Literal, BNode\nfrom rdflib.namespace import RDF\nassert importlib.metadata.version(\"rdflib\") == \"7.1.4\"\nassert importlib.metadata.version(\"owlrl\") == \"7.1.4\"\ndocument = json.load(sys.stdin)\ng = Graph().parse(data=document[\"turtle\"], format=\"turtle\")\ninput_count = len(g)\nnormalizations = []\nfor record in document[\"literals\"]:\n    term = Literal(record[\"value\"], lang=record[\"language\"] or None, datatype=record[\"datatype\"], normalize=True)\n    normalizations.append({**record,\"normalized\":str(term),\"normalizedLanguage\":term.language or \"\",\"normalizedDatatype\":str(term.datatype) if term.datatype else None})\ndef key(term):\n    if isinstance(term, Literal):\n        dt = str(term.datatype) if term.datatype else (\"http://www.w3.org/1999/02/22-rdf-syntax-ns#langString\" if term.language else \"http://www.w3.org/2001/XMLSchema#string\")\n        return \"Literal:\" + json.dumps(str(term),ensure_ascii=False,separators=(\",\",\":\")) + \"@\" + (term.language or \"\").lower() + \"^^\" + dt\n    return (\"BlankNode:\" if isinstance(term,BNode) else \"NamedNode:\") + json.dumps(str(term),ensure_ascii=False,separators=(\",\",\":\"))\ndef keys(graph):\n    return sorted(json.dumps([key(s),key(p),key(o)],ensure_ascii=False,separators=(\",\",\":\")) for s,p,o in graph)\ninput_keys = keys(g)\nspec = importlib.util.spec_from_file_location(\"i2idlx_layer_footprint_oracle\",pathlib.Path(sys.argv[1])/\"src\"/\"layer.py\")\nlayer = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(layer)\nclosed, errors = layer.closure(g)\nfrom owlrl.Namespaces import ERRNS\nnodes = set(closed.subjects(RDF.type,ERRNS.ErrorMessage))\nreports = sorted(str(message) for node in nodes for message in closed.objects(node,ERRNS.error))\nfootprint = sum(1 for s,p,o in closed if s in nodes)\nprint(json.dumps({\"input\":input_count,\"inputKeys\":input_keys,\"closed\":len(closed),\"keys\":keys(closed),\n    \"normalizations\":normalizations,\"errors\":errors,\"rawReports\":reports,\"reportTriples\":footprint},ensure_ascii=False,separators=(\",\",\":\")))\n";
const ERRNS='http://www.daml.org/2002/03/agents/agent-ont#';
const root=resolve(process.argv[2]??DEFAULT_ROOT);
const prefix='@prefix : <urn:footprint-oracle:> . @prefix owl: <'+OWL+'> . @prefix xsd: <'+XSD+'> . ';
const fixtures:Record<string,string>={
  'measured double zero':':s :p "0.0E0"^^xsd:double .',
  'repeated positive zero':':a :p "0"^^xsd:double . :b :p "0.0E0"^^xsd:double .',
  'signed zeros and exact datatypes':':a :p "0.0"^^xsd:double . :b :p "-0.0"^^xsd:double . :c :p "0.0"^^xsd:float .',
  'plain string zero':':s :p "0.0" .',
  'explicit string zero':':s :p "0.0"^^xsd:string .',
  'valid nonzero numeric':':s :p "1.0"^^xsd:double .',
  'real invalid lexical value':':s :p "bad"^^xsd:integer .',
  'disjoint class report':':A owl:disjointWith :B . :x a :A,:B .',
  'Nothing report and additional layer error':':x a owl:Nothing .',
};
interface Oracle {input:number;inputKeys:string[];closed:number;keys:string[];errors:string[];rawReports:string[];reportTriples:number;normalizations:OracleLiteralNormalization[]}
const receipts:unknown[]=[];
for(const [fixture,body]of Object.entries(fixtures)) {
  const turtle=prefix+body,input=parseWithLiteralDatatypes(turtle).graph,literals=sourceLiteralRecords(input);
  const sourceKeys=[...input].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort();
  const oracle=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-I','-c',python,root],{
    input:JSON.stringify({turtle,literals}),encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
  })) as Oracle;
  const normalized=applyOracleLiteralNormalizations(input,oracle.normalizations);
  const inputKeys=[...normalized.graph].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort();
  assert.deepEqual(inputKeys,oracle.inputKeys);assert.equal(normalized.graph.size,oracle.input);
  const native=closure(normalized.graph,{datatypeOrigins:normalized.datatypeOrigins});
  const nativeKeys=[...native.graph].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey)));
  const matched=matchFreshReportNodes(nativeKeys,oracle.keys,new Set());
  assert.deepEqual(matched.native,matched.python);assert.equal(native.graph.size,oracle.closed);
  assert.deepEqual(native.errors,oracle.errors);
  const nodes=subjects(native.graph,RDF+'type',DataFactory.namedNode(ERRNS+'ErrorMessage'));
  const messages=nodes.flatMap(node=>objects(native.graph,node,ERRNS+'error').map(term=>term.value)).sort();
  const reportTriples=[...native.graph].filter(q=>nodes.some(node=>node.equals(q.subject))).length;
  assert.deepEqual(messages,oracle.rawReports);assert.equal(reportTriples,oracle.reportTriples);
  for(const node of nodes)assert.equal(native.graph.countQuads(node,null,null,null),2);
  assert.deepEqual([...input].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort(),sourceKeys);
  receipts.push({fixture,input:oracle.input,pythonClosed:oracle.closed,nativeClosed:native.graph.size,
    filteredErrors:native.errors,rawReports:messages,reportTriples,diagnosticNodePairs:matched.pairs,equal:true});
}
process.stdout.write('I2IDLX_REASONING_FOOTPRINT_ORACLE_FIXTURES='+JSON.stringify({oracle:{rdflib:'7.1.4',owlrl:'7.1.4'},comparison:'exact closed quads with a bijection only for fresh isolated diagnostic nodes',fixtures:receipts})+'\n');
