/** Shared, read-only I/O for signed publication receipts and content negotiation. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, namespaceIris } from './config.js';
export interface PublicationGraph {
  graph_iri: string; file: string; modal_status: 'Asserted'|'Hypothetical';
  visibility: 'public'; confidence: number;
}
export interface PublicationPlan {owner:string;relayNsRoot:string;graphs:PublicationGraph[];localOnly?:string[]}
export interface HttpDocument {url:string;status:number;contentType:string;body:string}
export type FetchDocument = (url:string,accept:string,userAgent:string)=>Promise<HttpDocument>;
export const PUBLIC_GRAPH_KEYS = ['shapes','ontology','rules','catalog','enactments','mappings','releases','changes','alignments','referents'] as const;
const HYPOTHETICAL=new Set<string>(['enactments','mappings','alignments','referents']);
export function publicationUrl(value: string): URL {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('Publication URL must be an HTTPS document without credentials or fragment');
  return url;
}
export function loadPublicationPlan(root:string,outputDir?:string): {plan:PublicationPlan;outputDir:string} {
  root=resolve(root);const cfg=loadConfig(root),dir=resolve(outputDir||process.env.I2IDLX_DIST||join(root,'dist-ts'));
  const plan=JSON.parse(readFileSync(join(dir,'publish-plan.json'),'utf8')) as PublicationPlan;
  if(plan.owner!==cfg.owner||plan.relayNsRoot!==cfg.relayNsRoot||!Array.isArray(plan.graphs)||plan.graphs.length!==PUBLIC_GRAPH_KEYS.length)throw Error('Publish plan must name the configured owner and all ten public graphs');
  const {IRI}=namespaceIris(cfg),expected=new Map<string,typeof PUBLIC_GRAPH_KEYS[number]>(PUBLIC_GRAPH_KEYS.map(k=>[IRI[k]!,k] as const)),seen=new Set<string>();
  for(const row of plan.graphs) {
    const key=expected.get(row.graph_iri);
    if(!key||seen.has(row.graph_iri))throw Error('Unexpected or duplicate published graph '+row.graph_iri);
    publicationUrl(row.graph_iri);
    if(row.file!==cfg.slugs[key]+'.ttl'||row.visibility!=='public'||row.modal_status!==(HYPOTHETICAL.has(key)?'Hypothetical':'Asserted')||
      !Number.isFinite(row.confidence)||row.confidence<0||row.confidence>1)throw Error('Invalid public graph metadata '+row.graph_iri);
    seen.add(row.graph_iri);
  }
  return {plan,outputDir:dir};
}
/** Native fetch, including redirects and streamed size limits. No credentials are sent. */
export const fetchDocument: FetchDocument = async (value,accept,userAgent) => {
  let url=publicationUrl(value);const signal=AbortSignal.timeout(60000);
  for(let redirect=0;redirect<=5;redirect++) {
    const response=await fetch(url,{headers:{Accept:accept,'User-Agent':userAgent},redirect:'manual',signal});
    if([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');
      if(!location)throw Error('Redirect without Location: '+url.href);
      await response.body?.cancel();url=publicationUrl(new URL(location,url).href);continue;
    }
    const limit=32*1024*1024;
    if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel();throw Error('Publication response exceeds 32 MiB');}
    const chunks:Uint8Array[]=[];let size=0;
    if(response.body) {
      const reader=response.body.getReader();
      try {
        while(true) {const {done,value:chunk}=await reader.read();if(done)break;
          size+=chunk.length;if(size>limit){await reader.cancel();throw Error('Publication response exceeds 32 MiB');}chunks.push(chunk);}
      } finally {reader.releaseLock();}
    }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return {url:url.href,status:response.status,contentType:(response.headers.get('content-type')||'').split(';')[0]!.trim().toLowerCase(),body:new TextDecoder().decode(bytes)};
  }
  throw Error('Publication redirects exceeded five hops');
};
export function publicationCliOptions(args:string[]): {root?:string;outputDir?:string;only:string[]} {
  const out:{root?:string;outputDir?:string;only:string[]}={only:[]};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--dist') {const dir=args[++i];if(!dir)throw Error('--dist needs a directory');out.outputDir=resolve(dir);}
    else if(args[i]!.startsWith('--'))throw Error('Unknown option '+args[i]);
    else if(out.root===undefined)out.root=args[i];else out.only.push(args[i]!);
  }
  return out;
}
