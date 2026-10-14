/**
 * Read-only closure diagnostic over one shared input with fixed blank labels.
 * Runs the unchanged Python layer.closure and explicit native compatibility.
 * Full production parity gates are unaffected; this only identifies real quads.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from 'n3';
import type { Term } from '@rdfjs/types';
import { DEFAULT_ROOT } from './config.js';
import { generate } from './generate.js';
import { parseWithLiteralDatatypes, addQuadsWithLiteralDatatypes, oracleLiteralDatatypes } from './literal-datatypes.js';
import { closure, union, termKey } from './reasoning.js';
import { safeIri } from './rdf.js';

const pythonProgram=String.raw`
import importlib.metadata
import importlib.util
import json
import pathlib
import sys
import time
from rdflib import BNode, Graph, Literal, URIRef
assert importlib.metadata.version("rdflib") == "7.1.4"
assert importlib.metadata.version("owlrl") == "7.1.4"
root, nt_file, labels_file, output_file = map(pathlib.Path, sys.argv[1:5])
labels = json.loads(labels_file.read_text())
context = {label:BNode(label) for label in labels}
g = Graph().parse(nt_file, format="nt", bnode_context=context)
input_count = len(g)
def literal_key(t):
    dt = str(t.datatype) if t.datatype else ("http://www.w3.org/1999/02/22-rdf-syntax-ns#langString" if t.language else "http://www.w3.org/2001/XMLSchema#string")
    return "Literal:" + json.dumps(str(t), ensure_ascii=False, separators=(",",":")) + "@" + (t.language or "").lower() + "^^" + dt
def term_key(t):
    if isinstance(t, Literal): return literal_key(t)
    return ("BlankNode:" if isinstance(t, BNode) else "NamedNode:") + json.dumps(str(t), ensure_ascii=False, separators=(",",":"))
input_keys = sorted(json.dumps([term_key(s),term_key(p),term_key(o)], ensure_ascii=False, separators=(",",":")) for s,p,o in g)
spec = importlib.util.spec_from_file_location("i2idlx_layer_oracle", root / "src" / "layer.py")
layer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layer)
started = time.monotonic()
closed, errors = layer.closure(g)
keys = sorted(json.dumps([term_key(s),term_key(p),term_key(o)], ensure_ascii=False, separators=(",",":")) for s,p,o in closed)
receipt={"input":input_count,"closed":len(closed),"errors":errors,"seconds":time.monotonic()-started,"inputKeys":input_keys,"keys":keys}
output_file.write_text(json.dumps(receipt, ensure_ascii=False, separators=(",",":")))
print(json.dumps({k:v for k,v in receipt.items() if k not in ("keys","inputKeys")}, sort_keys=True))
`;
interface Oracle { input:number;closed:number;errors:string[];seconds:number;inputKeys:string[];keys:string[] }
const tripleKey=(terms:Term[])=>JSON.stringify(terms.map(termKey));
export async function probeReasoning(root=DEFAULT_ROOT):Promise<void> {
  root=resolve(root);
  const output=join(root,'.cache','reasoning-probe');await mkdir(output,{recursive:true});
  const build=await generate(root,{outputDir:join(output,'generated')});
  const load=async(file:string)=>parseWithLiteralDatatypes(await readFile(file,'utf8'),'Turtle',pathToFileURL(file).href).graph;
  const upper=new Store();
  for(const file of (await readdir(join(root,'evidence','upper'))).filter(f=>f.endsWith('.ttl')).sort())
    addQuadsWithLiteralDatatypes(upper,await load(join(root,'evidence','upper',file)));
  for(const file of ['xapi-ontology.ttl','xapi-profile-ontology.ttl','iep.ttl','interego-interego.ttl','interego-hypragent.ttl','interego-hyprcat.ttl','interego-harness.ttl'])
    addQuadsWithLiteralDatatypes(upper,await load(join(root,'evidence',file)));
  const fx=build.cfg.foxxiNs,archive=process.env.FOXXI_NS_ARCHIVE??(isAbsolute(fx.archive)?fx.archive:resolve(root,fx.archive));
  for(const module of fx.modules)addQuadsWithLiteralDatatypes(upper,await load(join(archive,module,fx.version+'.ttl')));
  const sample=await load(join(root,'examples','industry-context.ttl')),deployment=await load(join(root,'examples','foxxi-deployment.ttl'));
  const names=['ontology','alignments','referents','enactments','mappings','releases','changes'];
  const input=union(upper,...names.slice(0,3).map(k=>build.graphs[k]!),build.glossary,...names.slice(3).map(k=>build.graphs[k]!),sample,deployment);
  const origins=oracleLiteralDatatypes(input),labels=new Set<string>();
  const nt=(t:Term):string=>{
    if(t.termType==='NamedNode')return safeIri(t.value);
    if(t.termType==='BlankNode'){labels.add(t.value);return '_:'+t.value;}
    if(t.termType!=='Literal')throw new Error('Shared oracle input has unsupported term '+t.termType);
    const lexical=JSON.stringify(t.value);
    if(t.language)return lexical+'@'+t.language;
    const key=termKey(t);
    if(!origins.has(key))throw new Error('Shared input literal has no source datatype: '+key);
    const datatype=origins.get(key);
    return lexical+(datatype?'^^'+safeIri(datatype):'');
  };
  const text=[...input].map(q=>{
    assert.notEqual(q.subject.termType,'Literal','Initial shared input must be ordinary RDF');
    return [nt(q.subject),nt(q.predicate),nt(q.object)].join(' ')+' .';
  }).join('\n')+'\n';
  const ntFile=join(output,'shared-input.nt'),labelsFile=join(output,'shared-blank-labels.json'),oracleFile=join(output,'python-closure.json');
  await writeFile(ntFile,text);await writeFile(labelsFile,JSON.stringify([...labels].sort()));
  const pythonOutput=execFileSync(process.env.PYTHON??'python3',['-I','-c',pythonProgram,root,ntFile,labelsFile,oracleFile],{
    encoding:'utf8',timeout:300000,maxBuffer:1024*1024,
  });
  process.stdout.write('I2IDLX_SHARED_INPUT_PYTHON='+pythonOutput.trim()+'\n');
  const oracle=JSON.parse(await readFile(oracleFile,'utf8')) as Oracle;
  const nativeInputKeys=new Set([...input].map(q=>tripleKey([q.subject,q.predicate,q.object]))),oracleInputKeys=new Set(oracle.inputKeys);
  const inputReport={nativeCount:input.size,pythonCount:oracle.input,
    missingFromNative:oracle.inputKeys.filter(k=>!nativeInputKeys.has(k)).map(k=>JSON.parse(k)),
    extraInNative:[...nativeInputKeys].filter(k=>!oracleInputKeys.has(k)).sort().map(k=>JSON.parse(k))};
  await writeFile(join(output,'input-difference.json'),JSON.stringify(inputReport,null,2)+'\n');
  process.stdout.write('I2IDLX_REASONING_INPUT_DIFF='+JSON.stringify({...inputReport,missingFromNative:inputReport.missingFromNative.slice(0,80),extraInNative:inputReport.extraInNative.slice(0,80)})+'\n');
  if(oracle.input!==input.size||inputReport.missingFromNative.length||inputReport.extraInNative.length) {
    process.stdout.write('Input representations differ; no native rule-gap comparison accepted.\n');
    process.exitCode=1;return;
  }
  const started=Date.now(),native=closure(input,{datatypeOrigins:origins});
  const nativeKeys=new Set([...native.graph].map(q=>tripleKey([q.subject,q.predicate,q.object]))),oracleKeys=new Set(oracle.keys);
  const missing=oracle.keys.filter(k=>!nativeKeys.has(k)),extra=[...nativeKeys].filter(k=>!oracleKeys.has(k)).sort();
  const report={input:input.size,python:{closed:oracle.closed,errors:oracle.errors,seconds:oracle.seconds},
    native:{closed:native.graph.size,errors:native.errors,seconds:(Date.now()-started)/1000},
    missing:missing.map(k=>JSON.parse(k)),extra:extra.map(k=>JSON.parse(k))};
  await writeFile(join(output,'reasoning-difference.json'),JSON.stringify(report,null,2)+'\n');
  process.stdout.write('I2IDLX_REASONING_SHARED_INPUT_DIFF='+JSON.stringify({...report,missing:report.missing.slice(0,80),extra:report.extra.slice(0,80)})+'\n');
  if(missing.length||extra.length||JSON.stringify(oracle.errors)!==JSON.stringify(native.errors))
    process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await probeReasoning(process.argv[2]);
