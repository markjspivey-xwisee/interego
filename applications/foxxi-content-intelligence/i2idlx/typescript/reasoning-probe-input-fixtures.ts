/**
 * Runtime diagnostic fixtures against actual pinned RDFLib literal conversion.
 * This file is called only after the independent oracle has been installed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseWithLiteralDatatypes } from './literal-datatypes.js';
import { sourceLiteralRecords, applyOracleLiteralNormalizations, type OracleLiteralNormalization } from './reasoning-probe-input.js';
import { termKey } from './reasoning.js';

const python="\nimport importlib.metadata\nimport json\nimport sys\nfrom rdflib import Graph, Literal, BNode\nassert importlib.metadata.version(\"rdflib\") == \"7.1.4\"\ndocument = json.load(sys.stdin)\nnormalizations = []\nfor record in document[\"literals\"]:\n    term = Literal(record[\"value\"], lang=record[\"language\"] or None, datatype=record[\"datatype\"], normalize=True)\n    normalizations.append({**record,\"normalized\":str(term),\"normalizedLanguage\":term.language or \"\",\"normalizedDatatype\":str(term.datatype) if term.datatype else None})\ngraph = Graph().parse(data=document[\"text\"], format=\"nt\", bnode_context={document[\"label\"]:BNode(document[\"label\"])})\ndef key(term):\n    if isinstance(term, Literal):\n        dt = str(term.datatype) if term.datatype else (\"http://www.w3.org/1999/02/22-rdf-syntax-ns#langString\" if term.language else \"http://www.w3.org/2001/XMLSchema#string\")\n        return \"Literal:\" + json.dumps(str(term),ensure_ascii=False,separators=(\",\",\":\")) + \"@\" + (term.language or \"\").lower() + \"^^\" + dt\n    return (\"BlankNode:\" if isinstance(term,BNode) else \"NamedNode:\") + json.dumps(str(term),ensure_ascii=False,separators=(\",\",\":\"))\nkeys = sorted(json.dumps([key(s),key(p),key(o)],ensure_ascii=False,separators=(\",\",\":\")) for s,p,o in graph)\nprint(json.dumps({\"normalizations\":normalizations,\"input\":len(graph),\"keys\":keys},ensure_ascii=False,separators=(\",\",\":\")))\n";
const XSD='http://www.w3.org/2001/XMLSchema#';
const lines=[
  '_:fixed <urn:normalization:p> "-1.0E0"^^<'+XSD+'double> .',
  '_:fixed <urn:normalization:p> "0.0E0"^^<'+XSD+'double> .',
  '_:fixed <urn:normalization:p> "1.0E0"^^<'+XSD+'double> .',
  '_:fixed <urn:normalization:p> "2024-02-04T11:18:50Z"^^<'+XSD+'dateTime> .',
  '_:fixed <urn:normalization:p> "2024-02-04T11:18:50.1234567Z"^^<'+XSD+'dateTime> .',
  '_:fixed <urn:normalization:p> "001"^^<'+XSD+'integer> .',
  '_:fixed <urn:normalization:p> "1"^^<'+XSD+'boolean> .',
  '_:fixed <urn:normalization:p> "plain" .',
  '_:fixed <urn:normalization:p> "English"@en .',
  '_:fixed <urn:normalization:p> "explicit"^^<'+XSD+'string> .',
];
for(const collision of [false,true]) {
  const text=[...lines,...(collision?['_:fixed <urn:normalization:p> "1.0"^^<'+XSD+'double> .']:[])].join('\n')+'\n';
  const input=parseWithLiteralDatatypes(text,'N-Quads').graph;
  const original=[...input].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort();
  const literals=sourceLiteralRecords(input),label=[...input][0]!.subject.value;
  const sharedText=text.replaceAll('_:fixed','_:'+label);
  const receipt=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-I','-c',python],{
    input:JSON.stringify({text:sharedText,literals,label}),encoding:'utf8',timeout:30000,maxBuffer:1024*1024,
  })) as {normalizations:OracleLiteralNormalization[];input:number;keys:string[]};
  const normalized=applyOracleLiteralNormalizations(input,receipt.normalizations);
  const native=[...normalized.graph].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort();
  assert.deepEqual(native,receipt.keys);assert.equal(normalized.graph.size,receipt.input);
  assert.deepEqual([...input].map(q=>JSON.stringify([q.subject,q.predicate,q.object].map(termKey))).sort(),original);
  assert.equal(normalized.originalTriples-normalized.normalizedTriples,collision?1:0);
  for(const source of ['plain','English','explicit']) {
    const record=receipt.normalizations.find(record=>record.value===source)!;
    assert.equal(record.normalized,source);
    assert.equal(record.normalizedDatatype,source==='explicit'?XSD+'string':null);
  }
  process.stdout.write('I2IDLX_ORACLE_INPUT_NORMALIZATION_FIXTURE='+JSON.stringify({
    fixture:collision?'normalization collision':'measured doubles and dateTimes',
    sourceInput:input.size,normalizedInput:normalized.graph.size,pythonInput:receipt.input,
    changedLiteralForms:normalized.changedLiteralForms,equal:true,
    changes:receipt.normalizations.filter(record=>record.value!==record.normalized),
  })+'\n');
}
