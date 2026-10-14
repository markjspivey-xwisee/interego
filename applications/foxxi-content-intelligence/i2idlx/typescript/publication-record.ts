/**
 * Read real signed descriptor receipts from publications.json and check them
 * against the generated publish plan. This records receipt metadata; checking
 * a descriptor's cryptographic signature belongs to the Interego verifier.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT } from './config.js';
import { parseTurtle, values, type Store, type Term } from './rdf.js';
import { IEP } from './generate.js';
import { fetchDocument, loadPublicationPlan, publicationUrl, publicationCliOptions, type FetchDocument } from './publication-io.js';
export interface PublicationReceipt {
  graph:string;graphIri:string|null;descriptor:string;modalStatus:string|null;validFrom:string|null;
  contentHash:string|null;signer:string|null;supersedes:string[];
}
export interface PublicationRecord {owner:string;graphs:PublicationReceipt[];superseded:Record<string,string[]>;problems:string[]}
function one(graph:Store,subject:Term,predicate:string):string|null {
  const objects=values(graph,subject,predicate),terms=new Map(objects.map(t=>[t.termType+':'+t.value+':'+(t.termType==='Literal'?t.language:'')+':'+(t.termType==='Literal'?t.datatype.value:''),t.value] as const));
  if(terms.size>1)throw Error('Descriptor has multiple values for '+predicate);
  return [...terms.values()][0]??null;
}
export async function publicationRecord(root=DEFAULT_ROOT,options:{outputDir?:string;write?:boolean;fetcher?:FetchDocument}={}):Promise<PublicationRecord> {
  const {plan,outputDir}=loadPublicationPlan(root,options.outputDir),fetcher=options.fetcher||fetchDocument;
  const pubs=JSON.parse(readFileSync(join(root,'publications.json'),'utf8')) as {descriptors:Record<string,string>;superseded?:Record<string,string[]>};
  if(!pubs.descriptors||typeof pubs.descriptors!=='object'||Array.isArray(pubs.descriptors))throw Error('publications.json requires explicit descriptor URLs');
  const expected=new Map(plan.graphs.map(g=>[g.graph_iri.split('/').pop()!,g] as const)),record:PublicationReceipt[]=[],problems:string[]=[];
  for(const [slug,url]of Object.entries(pubs.descriptors)) {
    const row:PublicationReceipt={graph:slug,graphIri:null,descriptor:url,modalStatus:null,validFrom:null,contentHash:null,signer:null,supersedes:[]};
    const planRow=expected.get(slug);
    if(!planRow)problems.push(slug+': not in the publish plan');
    try {
      publicationUrl(url);
      const response=await fetcher(url,'text/turtle','i2idlx-record/1.0');
      if(response.status!==200)throw Error('Descriptor HTTP '+response.status);
      if(!['text/turtle','application/x-turtle'].includes(response.contentType))throw Error('Descriptor media type '+response.contentType);
      const graph=parseTurtle(response.body,response.url),candidates=graph.getQuads(null,IEP+'describes',null,null);
      const subjects=new Map(candidates.map(q=>[q.subject.termType+':'+q.subject.value,q.subject] as const));
      if(subjects.size!==1)throw Error('Receipt must contain exactly one descriptor subject');
      const subject=[...subjects.values()][0]!;
      row.graphIri=one(graph,subject,IEP+'describes');
      const modal=one(graph,subject,IEP+'modalStatus');
      row.modalStatus=modal?.split('#').pop()||null;
      row.validFrom=one(graph,subject,IEP+'validFrom');
      row.contentHash=one(graph,subject,IEP+'contentHash');
      row.signer=one(graph,subject,IEP+'signerAddress');
      row.supersedes=[...new Set(values(graph,subject,IEP+'supersedes').map(t=>t.value))].sort();
      if(planRow&&row.graphIri!==planRow.graph_iri)problems.push(slug+': descriptor describes '+row.graphIri+', plan says '+planRow.graph_iri);
      if(planRow&&row.modalStatus!==planRow.modal_status)problems.push(slug+': descriptor modal status '+row.modalStatus+', plan says '+planRow.modal_status);
      if(!row.contentHash)problems.push(slug+': no signed content hash');
      if(!row.signer)problems.push(slug+': no signer address');
    } catch(error) {problems.push(slug+': '+(error instanceof Error?error.message:String(error)));}
    record.push(row);
  }
  const missing=[...expected.keys()].filter(s=>!(s in pubs.descriptors)).sort();
  if(missing.length)problems.push('unpublished: '+missing.join(', '));
  const result:PublicationRecord={owner:plan.owner,graphs:record,superseded:pubs.superseded||{},problems};
  if(options.write!==false)writeFileSync(join(outputDir,'published.json'),JSON.stringify(result,null,2)+'\n');
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=publicationCliOptions(process.argv.slice(2));
    if(args.only.length)throw Error('publication-record does not accept graph selection; every public graph is required');
    const record=await publicationRecord(args.root||DEFAULT_ROOT,{outputDir:args.outputDir});
    process.stdout.write(JSON.stringify(record,null,2)+'\n');if(record.problems.length)process.exitCode=1;
  } catch(error) {process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');process.exitCode=1;}
}
