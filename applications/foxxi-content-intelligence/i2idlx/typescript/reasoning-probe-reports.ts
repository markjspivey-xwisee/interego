/**
 * Alpha-renaming for fresh, isolated ERRNS diagnostic nodes only.
 * All input blank labels, other quads, literal messages and counts stay exact.
 */
const RDF_TYPE='NamedNode:'+JSON.stringify('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
const ERROR_TYPE='NamedNode:'+JSON.stringify('http://www.daml.org/2002/03/agents/agent-ont#ErrorMessage');
const ERROR_PREDICATE='NamedNode:'+JSON.stringify('http://www.daml.org/2002/03/agents/agent-ont#error');
const STRING_SUFFIX='@^^http://www.w3.org/2001/XMLSchema#string';
type Triple=[string,string,string];
export interface ReportNodePair {native:string;python:string;message:string}
export interface MatchedReportKeys {native:string[];python:string[];pairs:ReportNodePair[]}
const blankLabel=(key:string):string|null=>key.startsWith('BlankNode:')?JSON.parse(key.slice('BlankNode:'.length)) as string:null;
function reportNodes(keys:string[],inputLabels:ReadonlySet<string>):Map<string,string> {
  const triples=keys.map(key=>JSON.parse(key) as Triple),subjects=new Map<string,Triple[]>();
  for(const triple of triples) {
    const label=blankLabel(triple[0]);
    if(label===null||inputLabels.has(label))continue;
    const outgoing=subjects.get(triple[0])??[];outgoing.push(triple);subjects.set(triple[0],outgoing);
  }
  const nodes=new Map<string,string>();
  for(const [subject,outgoing]of subjects) {
    if(outgoing.length!==2||triples.some(triple=>triple[1]===subject||triple[2]===subject))continue;
    const type=outgoing.find(triple=>triple[1]===RDF_TYPE&&triple[2]===ERROR_TYPE);
    const error=outgoing.find(triple=>triple[1]===ERROR_PREDICATE&&triple[2].startsWith('Literal:')&&triple[2].endsWith(STRING_SUFFIX));
    if(!type||!error)continue;
    // Exact literal spelling/datatype/language is the bijection key. Never
    // canonicalize error text or a non-isolated/caller-provided blank node.
    if(nodes.has(error[2]))throw new Error('Fresh ERRNS diagnostic messages do not identify a bijective node mapping');
    nodes.set(error[2],subject);
  }
  return nodes;
}
export function matchFreshReportNodes(nativeKeys:string[],pythonKeys:string[],inputLabels:ReadonlySet<string>):MatchedReportKeys {
  const nativeNodes=reportNodes(nativeKeys,inputLabels),pythonNodes=reportNodes(pythonKeys,inputLabels);
  const occupied=new Set<string>(inputLabels);
  for(const key of [...nativeKeys,...pythonKeys])for(const term of JSON.parse(key) as Triple) {
    const label=blankLabel(term);if(label!==null)occupied.add(label);
  }
  const nativeMapping=new Map<string,string>(),pythonMapping=new Map<string,string>(),pairs:ReportNodePair[]=[];
  let serial=0;
  for(const message of [...nativeNodes.keys()].filter(message=>pythonNodes.has(message)).sort()) {
    let label:string;do{label='i2idlx-diagnostic-'+serial++;}while(occupied.has(label));
    occupied.add(label);
    const target='BlankNode:'+JSON.stringify(label),native=nativeNodes.get(message)!,python=pythonNodes.get(message)!;
    nativeMapping.set(native,target);pythonMapping.set(python,target);
    pairs.push({native:blankLabel(native)!,python:blankLabel(python)!,message});
  }
  const remap=(keys:string[],mapping:Map<string,string>):string[]=>keys.map(key=>
    JSON.stringify((JSON.parse(key) as Triple).map(term=>mapping.get(term)??term))).sort();
  const native=remap(nativeKeys,nativeMapping),python=remap(pythonKeys,pythonMapping);
  if(new Set(native).size!==new Set(nativeKeys).size||new Set(python).size!==new Set(pythonKeys).size)
    throw new Error('Fresh ERRNS node renaming changed the actual quad count');
  return {native,python,pairs};
}
