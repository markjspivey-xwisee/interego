import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, Parser, DataFactory } from 'n3';
import type { Term, NamedNode, BlankNode, Quad } from '@rdfjs/types';
import { QueryEngine } from '@comunica/query-sparql';
import { parseJsonLd } from './rdf.js';
const {namedNode}=DataFactory;
type Subject=NamedNode|BlankNode;
const RDF='http://www.w3.org/1999/02/22-rdf-syntax-ns#',SKOS='http://www.w3.org/2004/02/skos/core#';
const IEP='https://markjspivey-xwisee.github.io/interego/ns/iep#',HYDRA='http://www.w3.org/ns/hydra/core#',DCAT='http://www.w3.org/ns/dcat#';
const tick=String.fromCharCode(96),fence=tick.repeat(3),code=(s:string):string=>tick+s+tick;
interface Config {relayNsRoot:string;owner:string;slugs:Record<string,string>;i2idl:{localClone:string;graphPath:string}}
interface Affordance {action:string;target:string;method:string;readOnly:boolean}
interface Receipt {status:number|null;headers:Headers;body:string;error?:string}
export interface WalkOptions {distDir?:string;live?:boolean}
function json<T>(p:string):T{return JSON.parse(readFileSync(p,'utf8')) as T;}
function os(g:Store,s:Term|undefined,p:string):Term[]{return s?g.getQuads(s as Subject,namedNode(p),null,null).map(q=>q.object):[];}
function val(g:Store,s:Term|undefined,p:string):Term|undefined{return os(g,s,p)[0];}
function lex(t:Term|undefined):string{return t?.value??'None';}
function parse(src:string,base:string):Store{return new Store(new Parser({format:'text/turtle',baseIRI:base}).parse(src));}
async function request(url:string,accept='*/*',method='GET',body?:string,follow=true,media?:string):Promise<Receipt>{
  try{const r=await fetch(url,{method,body,redirect:follow?'follow':'manual',headers:{Accept:accept,'User-Agent':'i2idlx-agent-walk-ts/0.1',...(media?{'Content-Type':media}:{})},signal:AbortSignal.timeout(30000)});
    return{status:r.status,headers:r.headers,body:r.ok?await r.text():''};}
  catch(e){return{status:null,headers:new Headers(),body:'',error:e instanceof Error?e.message:String(e)};}
}
function status(r:Receipt):string{return r.status===null?'network error ('+r.error+')':'**'+r.status+'**';}
function localOnly(query:string):void{if(/\bSERVICE\s+(?:SILENT\s+)?(?:<|\?)/i.test(query))throw new Error('Walkthrough cannot execute remote SERVICE clauses');}
async function select(engine:QueryEngine,query:string,g:Store):Promise<Record<string,string>[]>{
  localOnly(query);const stream=await engine.queryBindings(query,{sources:[g]}),out:Record<string,string>[]=[];
  for await(const b of stream){const row:Record<string,string>={};for(const[k,v]of b)row[k.value]=v.value;out.push(row);}return out;
}
async function construct(engine:QueryEngine,query:string,g:Store):Promise<Store>{
  localOnly(query);const stream=await engine.queryQuads(query,{sources:[g]}),out=new Store();for await(const q of stream)out.addQuad(q as Quad);return out;
}
/** Fresh local query evidence by default; public HTTP reads only with live:true. No writes. */
export async function agentWalk(root:string,options:WalkOptions={}):Promise<string>{
  const ROOT=resolve(root),DIST=resolve(options.distDir??join(ROOT,'dist-ts')),cfg=json<Config>(join(ROOT,'config.json')),live=options.live??false;
  const BASE=cfg.relayNsRoot+'/'+cfg.owner,NS=BASE+'/'+cfg.slugs.ontology+'#',CAT_IRI=BASE+'/'+cfg.slugs.catalog,CAT=CAT_IRI+'#';
  const load=(key:string):Store=>parse(readFileSync(join(DIST,cfg.slugs[key]+'.ttl'),'utf8'),BASE+'/'+cfg.slugs[key]);
  let cat=load('catalog'),catReceipt:Receipt|undefined;
  if(live){catReceipt=await request(CAT_IRI,'text/turtle');if(catReceipt.status===200)cat=parse(catReceipt.body,CAT_IRI);}
  const enact=load('enactments'),deco=load('decorations'),engine=new QueryEngine();
  const clone=process.env.I2IDL_CLONE||cfg.i2idl.localClone,clonePath=isAbsolute(clone)?clone:resolve(ROOT,clone);
  const glossary=await parseJsonLd(json<unknown>(join(clonePath,cfg.i2idl.graphPath)));
  const out=['# Agent walkthrough (native TypeScript)','', 'Mode: **'+(live?'live':'local')+'**','Generated: '+new Date().toISOString(),'',
    live?'Reported HTTP statuses are actual read-only request results; failures are retained.':
      'Stored queries executed against the pinned public glossary and newly built graphs. HTTP requests were not executed; no HTTP success is implied.',''];
  const limits=val(cat,namedNode(CAT+'sparql-service'),NS+'serviceLimits'),lim:Record<string,string>={};
  for(const key of ['maxQueryLength','rateLimitPerMinute','maxResultRows','executionTimeout'])lim[key]=lex(val(cat,limits,NS+key));
  const titled=cat.getQuads(null,namedNode(RDF+'type'),namedNode(IEP+'Affordance'),null).filter(q=>val(cat,q.subject,HYDRA+'title')).length;
  out.push('## 1. Read the catalog','',live?code('GET '+CAT_IRI)+' → '+status(catReceipt!)+'; '+(catReceipt!.status===200?'read live catalog.':'used newly built local catalog fallback.'):
    'Parsed newly built local catalog: **'+titled+' titled controls**. No HTTP call.','Published limits: '+code(JSON.stringify(lim))+'.','');
  const port=namedNode(CAT+'port-sparql-post'),target=lex(val(cat,port,HYDRA+'target')),method=lex(val(cat,port,HYDRA+'method'));
  const media=lex(val(cat,port,DCAT+'mediaType')),action=lex(val(cat,port,IEP+'action'));
  const query=lex(val(cat,namedNode(CAT+'q-concept-search'),NS+'sparql')).replace(/\$text/g,'"record store"');let rows:Record<string,string>[];
  out.push('## 2. Find a concept with a stored query','',code('cat:q-concept-search')+' with '+code('$text')+' bound to '+code('"record store"')+'.',
    'Port: '+code(method+' '+target)+'; Content-Type '+code(media)+'; action '+code(action)+'.','');
  if(live){
    if(!['GET','POST'].includes(method)||val(cat,port,IEP+'readOnlyHint')?.value!=='true')throw new Error('Query port is not declared read-only GET/POST');
    const r=await request(target,media,method,method==='POST'?query:undefined,true,media);out.push(code(method+' '+target)+' → '+status(r),'');
    const body=r.status===200?JSON.parse(r.body) as {results?:{bindings:Record<string,{value:string}>[]}}:{};
    rows=(body.results?.bindings??[]).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v.value])));
  }else{rows=await select(engine,query,glossary);out.push('Local stored query executed: **'+rows.length+' rows**. No HTTP call.','');}
  out.push(fence+'json',JSON.stringify(rows,null,1),fence,'');const found=rows[0]?.concept;
  out.push('## 3. Follow the decorated neighborhood control','');
  if(found){
    const control=namedNode(BASE+'/'+cfg.slugs.decorations+'#'+found.split('/').at(-1)+'--neighborhood'),nb=val(deco,control,HYDRA+'target');if(!nb)throw new Error('No neighborhood target for '+found);
    out.push('Actual decorator target for '+code(found)+': '+code(nb.value)+'.','');let neighborhood:Store;
    if(live){const r=await request(nb.value,'text/turtle');neighborhood=r.status===200?parse(r.body,nb.value):new Store();
      out.push(code('GET '+nb.value.slice(0,110)+'…')+' → '+status(r)+', '+neighborhood.size+' triples.','');}
    else{const q=lex(val(cat,namedNode(CAT+'q-concept-neighborhood'),NS+'sparql')).replace(/\$concept\b/g,'<'+found+'>');
      neighborhood=await construct(engine,q,glossary);out.push('Local neighborhood query executed: **'+neighborhood.size+' triples**. Target HTTP was not followed.','');}
    const labels=[...new Set(neighborhood.getQuads(null,namedNode(SKOS+'prefLabel'),null,null).map(q=>q.object.value))].sort();out.push('Labels: '+labels.join(', '),'');
  }else out.push('No concept matched; neighborhood and enactment invocation skipped.','');
  const acts=found?enact.getQuads(namedNode(found),null,null,null).filter(q=>q.predicate.value.startsWith(NS)).map(q=>[q.predicate.value.slice(NS.length),q.object.value] as [string,string]):[];
  out.push('## 4. Ask how the concept is enacted','');
  for(const[prop,act]of acts){if(live){const r=await request(act,'*/*','GET',undefined,false);out.push('- '+code(prop)+' → '+code(act)+' — '+code('GET')+' → '+status(r)+' '+code('Location: '+(r.headers.get('location')??'None')));}
    else out.push('- '+code(prop)+' → '+code(act)+' (newly built graph; redirect not requested).');}out.push('');
  const manifest=json<Affordance[]>(join(ROOT,'evidence','foxxi-affordances.json')),aff=acts.length?manifest.find(r=>r.action===acts[0]![1]):undefined;
  out.push('## 5. Invoke the enacting affordance','');
  if(aff){out.push('Manifest control: '+code(aff.action)+' → '+code(aff.method+' '+aff.target)+'; read-only '+aff.readOnly+'.','');
    if(live&&aff.readOnly&&aff.method==='GET'){const r=await request(aff.target,'application/json');let about:unknown;try{about=JSON.parse(r.body);}catch{about={raw:r.body.slice(0,400)};}
      out.push(code(aff.method+' '+aff.target)+' → '+status(r),'',fence+'json',JSON.stringify(about,null,1).slice(0,1500),fence,'');}
    else out.push(live?'Control is not a read-only GET; not invoked.':'Invocation was not performed in local mode.','');}
  else out.push('No matching enacting affordance selected.','');
  const qnode=namedNode(CAT+'q-classify'),over=os(cat,qnode,NS+'runsOver').sort((a,b)=>a.value.localeCompare(b.value)),union=new Store();
  out.push('## 6. Type your own data through the semantic layer','',
    'The stored query names its input ports. This run adds the fictional '+code('examples/industry-context.ttl')+' sample organization and executes actual SPARQL, without a reasoner.','');
  for(const p of over){const t=lex(val(cat,p,HYDRA+'target')),m=lex(val(cat,p,DCAT+'mediaType'));let g:Store;
    if(live){const r=await request(t,m);g=r.status===200?parse(r.body,t):new Store();out.push('- '+code(p.value.split('#').at(-1)!)+': '+code('GET '+t)+' (Accept: '+m+') → '+status(r)+', '+g.size.toLocaleString('en-US')+' triples');}
    else{const entry=Object.entries(cfg.slugs).find(([,slug])=>BASE+'/'+slug===t.split(/[?#]/)[0]);if(!entry)throw new Error('Port has no newly built local graph '+t);
      g=load(entry[0]);out.push('- '+code(p.value.split('#').at(-1)!)+': loaded **'+g.size.toLocaleString('en-US')+' local triples**; HTTP not executed.');}
    union.addQuads(g.getQuads(null,null,null,null));}
  const mine=parse(readFileSync(join(ROOT,'examples','industry-context.ttl'),'utf8'),'https://example.org/academy/');union.addQuads(mine.getQuads(null,null,null,null));
  const typed=over.length?await construct(engine,lex(val(cat,qnode,NS+'sparql')),union):new Store(),mineSubjects=new Set(mine.getQuads(null,null,null,null).map(q=>q.subject.value));
  const nTyped=typed.getQuads(null,namedNode(RDF+'type'),null,null).filter(q=>mineSubjects.has(q.subject.value)).length;
  const lrs=typed.getQuads(namedNode('https://example.org/academy/lrs-main'),namedNode(RDF+'type'),null,null).map(q=>q.object.value).sort();
  out.push('','Result: **'+nTyped+' typings** of the '+mineSubjects.size+' sample resources. Sample LRS classes:','',...lrs.map(x=>'- '+code(x)),'');
  out.push('## 7. Record usage (not executed)','', 'No record writes. The example statement uses the existing conceptIds extension:', '',
    fence+'json',JSON.stringify(json<{context:unknown}>(join(ROOT,'examples','usage-statement.json')).context,null,1),fence,'',
    '## 8. Propose a crosswalk (not executed)','', 'No mappings, reviews, consent, achievements or credentials were written. Shape graph: '+code(BASE+'/'+cfg.slugs.shapes)+'.','');
  const report=out.join('\n')+'\n';mkdirSync(DIST,{recursive:true});writeFileSync(join(DIST,'agent-walkthrough.md'),report);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),root=args.shift();if(!root)throw new Error('Usage: tsx agent-walk.ts ROOT [--dist DIR] [--live]');
  const options:WalkOptions={};while(args.length){const flag=args.shift();if(flag==='--live')options.live=true;else if(flag==='--dist')options.distDir=args.shift();else throw new Error('Unknown option '+flag);}
  console.log(await agentWalk(root,options));
}
