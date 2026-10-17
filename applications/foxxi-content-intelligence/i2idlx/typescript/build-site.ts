import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser, Store, DataFactory } from 'n3';
import type { Term, NamedNode, BlankNode } from '@rdfjs/types';
import * as semantic from './semantic.js';
import { parseJsonLd } from './rdf.js';
import { cw } from './generate.js';
import { compareText, KINDS as CHANGE_KINDS } from './history.js';

const { namedNode } = DataFactory;
type Subject = NamedNode | BlankNode;
interface Config {
  version: string; owner: string; relayNsRoot: string; slugs: Record<string, string>;
  i2idl: { localClone: string; graphPath: string; release: string };
  foxxiManifest: string; appArtifactUrl?: string;
}
interface PublishedGraph { graph: string; modalStatus: string; contentHash: string; descriptor: string }
interface Category { id: string; group: string; label: string; cls: string; broader?: string; mode?: string; referent?: readonly string[]; expressible?: readonly string[] }
interface ReasoningRecord {
  labels: Record<string, string>; terms: number; owlrl: { input: number; closed: number; consistent?: boolean };
  hermit?: Record<string, { sample?: { consistent?: boolean } }>;
  clash: { rejectedBy: string[] }; disjoint: unknown[]; disjointCheck: { pairs: number };
  rules: { explicit: number }; classify: { sampleTypings: number; typings: number };
}
interface AppMeta { counts: { mappings: number; unesco: number }; upstream: { roadmap: string; roadmapName: string; priorities: { n: number; title: string; anchor: string }[] } }
export interface SiteOptions { distDir?: string; outputDir?: string; appDir?: string; workbenchUrl?: string }
const RDF='http://www.w3.org/1999/02/22-rdf-syntax-ns#', RDFS='http://www.w3.org/2000/01/rdf-schema#';
const OWL='http://www.w3.org/2002/07/owl#', SKOS='http://www.w3.org/2004/02/skos/core#';
const IEP='https://markjspivey-xwisee.github.io/interego/ns/iep#', IEH='https://markjspivey-xwisee.github.io/interego/ns/harness#';
const HYPRAGENT='https://markjspivey-xwisee.github.io/interego/ns/hypragent#', HYDRA='http://www.w3.org/ns/hydra/core#';
const DCAT='http://www.w3.org/ns/dcat#', PROV='http://www.w3.org/ns/prov#', ODRL='http://www.w3.org/ns/odrl/2/', DCT='http://purl.org/dc/terms/';
const GSNS='https://glossarystudio.app/ns/', ACTION_ROOT='https://relay.interego.xwisee.com/ns/iep/action/', ENDPOINT='https://id.i2idl.org/sparql';
const DISPLAY = [
  ['catalog','Agent catalog','HyprCat entry point: ports, templates, stored queries and policies.'],
  ['ontology','Ontology','The i2x: vocabulary: kinds, interpretants, enactment, governance and agent terms.'],
  ['shapes','Shapes','SHACL contracts the relay enforces before a record is written.'],
  ['rules','Rules','SHACL-AF TripleRules: kinds, modality, definition provenance, ratified triples.'],
  ['enactments','Enactments','Concept-to-capability links, held as proposals.'],
  ['mappings','Mapping proposals','SKOS crosswalks to external vocabularies, held for review.'],
  ['releases','Release feed','Every I2IDL version since v0.0.54, chained.'],
  ['changes','Change history',"Every change between releases as PROV activities and typed events (I2IDL's roadmap, priority 4)."],
  ['alignments','Alignments',"Referent categories, I2IDL's records, Interego and Foxxi aligned to upper ontologies and peer vocabularies."],
  ['referents','Referents','What each I2IDL concept classifies: one referent category per concept, with the reason.'],
] as const;
const VOCABS = [
  ['http://vocabularies.unesco.org/thesaurus/','UNESCO Thesaurus'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/xapi#','xAPI (Foxxi)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/scorm-cam#','SCORM CAM (Foxxi)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/scorm-rte#','SCORM RTE (Foxxi)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/cmi5#','cmi5 (Foxxi)'],
  ['https://w3id.org/xapi/profiles/ontology#','xAPI Profiles'], ['https://w3id.org/xapi/ontology#','xAPI (ADL)'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#','IEEE LER'],
  ['https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#','ADL TLA'], ['https://schema.org/','schema.org'],
  ['https://www.w3.org/2018/credentials#','W3C VC'], ['https://markjspivey-xwisee.github.io/interego/ns/','Interego'],
] as const;
function os(g:Store,s:Term|undefined,p:string):Term[] { return s ? g.getQuads(s as Subject,namedNode(p),null,null).map(q=>q.object):[]; }
function value(g:Store,s:Term|undefined,p:string):Term|undefined { return os(g,s,p)[0]; }
function subjects(g:Store,p:string,o:Term):Subject[] { return [...new Map(g.getQuads(null,namedNode(p),o,null).map(q=>[q.subject.value,q.subject])).values()] as Subject[]; }
function text(g:Store,s:Term|undefined,...preds:string[]):string|undefined {
  for(const p of preds){const vals=os(g,s,p);if(vals.length)return (vals.find(v=>v.termType==='Literal'&&(!v.language||v.language==='en'))??vals[0])!.value;}return undefined;
}
function lexical(t:Term|undefined):string { return t?.value??'None'; }
function boolean(t:Term|undefined):boolean { return t?.termType==='Literal'&&(t.value==='true'||t.value==='1'); }
function esc(v:unknown):string {return String(v==null?'None':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');}
function ext(href:string,html:string,cls=''):string {return '<a'+(cls?' class="'+cls+'"':'')+' href="'+esc(href)+'" target="_blank" rel="noopener">'+html+'</a>';}
function wbr(v:unknown):string {const t=esc(v),i=t.indexOf('://'),scheme=i<0?'':t.slice(0,i+3),rest=i<0?t:t.slice(i+3);return scheme+rest.replace(/\//g,'/<wbr>').replace(/\?/g,'<wbr>?').replace(/#/g,'<wbr>#').replace(/\+/g,'+<wbr>').replace(/&amp;/g,'<wbr>&amp;');}
function codeInline(v:string):string {return esc(v).replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>');}
function jsonScript(v:unknown):string {return JSON.stringify(v).replace(/<\//g,'<\\/').replace(/<!--/g,'<\\!--');}
function number(n:number):string {return n.toLocaleString('en-US');}
function matches(s:string,p:RegExp):string[] {return [...s.matchAll(p)].map(m=>m[1]!);}
function add(m:Map<string,number>,k:string,n=1):void {m.set(k,(m.get(k)??0)+n);}
function byText<T>(f:(v:T)=>string):(a:T,b:T)=>number {return(a,b)=>compareText(f(a),f(b));}
function readJson<T>(p:string):T {return JSON.parse(readFileSync(p,'utf8')) as T;}
function recursiveFiles(dir:string):string[] {return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(e.name.startsWith('.')||e.name==='__pycache__'||e.name==='node_modules')return[];const p=join(dir,e.name);return e.isDirectory()?recursiveFiles(p):e.isFile()&&!e.name.endsWith('.pyc')?[p]:[];});}
export interface OriginDeclarations { groups:{id:string}[]; origins:{id:string}[] }
/** Include origin groups as well as leaves so linked group terms receive anchors. */
export function originVocabularyDeclarations(source:OriginDeclarations):string {
  return [...source.groups,...source.origins].map(origin=>'i2x:origin-'+origin.id+' a skos:Concept .').join('\n');
}
/** Catalog-only action identities link to their control, while ontology terms keep their own anchors. */
export function catalogActionTargets(catalog:Store,ontology:Store,catalogIri:string,namespace:string):Map<string,string> {
  const targets=new Map<string,string>();
  for(const control of os(catalog,namedNode(catalogIri),IEP+'affordance')){
    const action=value(catalog,control,IEP+'action');
    if(action?.termType==='NamedNode'&&action.value.startsWith(namespace)&&
      catalog.countQuads(action,namedNode(RDF+'type'),namedNode(namespace+'ActionIdentity'),null)>0&&
      ontology.countQuads(action,null,null,null)===0&&!targets.has(action.value))targets.set(action.value,control.value.slice((catalogIri+'#').length));
  }
  return targets;
}
/** Render the reference from built RDF and verification records; never runs Python. */
export async function buildSite(root:string,options:SiteOptions={}):Promise<{output:string;terms:number;controls:number;queries:number}> {
  const ROOT=resolve(root),cfg=readJson<Config>(join(ROOT,'config.json'));
  const clone=process.env.I2IDL_CLONE||cfg.i2idl.localClone;cfg.i2idl.localClone=isAbsolute(clone)?clone:resolve(ROOT,clone);
  const DIST=resolve(options.distDir??join(ROOT,'dist-ts')),OUTDIR=resolve(options.outputDir??join(ROOT,'site-ts'));
  const APP=resolve(options.appDir??join(ROOT,'app','build-ts')),OUT=join(OUTDIR,'index.html');
  const BASE=cfg.relayNsRoot+'/'+cfg.owner,SLUG=cfg.slugs,IRI=Object.fromEntries(Object.entries(SLUG).map(([k,v])=>[k,BASE+'/'+v]));
  const NS=IRI.ontology!+'#',CAT=IRI.catalog!+'#',EN=IRI.enactments!+'#',MP=IRI.mappings!+'#';
  const prefixes=Object.entries({
    i2x:NS,cat:CAT,en:EN,mp:MP,i2idl:'https://id.i2idl.org/concepts/','i2idl-type':'https://id.i2idl.org/collections/type/',
    'i2idl-field':'https://id.i2idl.org/collections/field/',gs:GSNS,'iep':IEP,'ieh':IEH,ie:'https://markjspivey-xwisee.github.io/interego/ns/interego#',
    hyprcat:'https://markjspivey-xwisee.github.io/interego/ns/hyprcat#','hypragent':HYPRAGENT,foxxi:'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#',
    ler:'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#',tla:'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#',
    'foxxi-xapi':'https://foxxi-bridge.interego.xwisee.com/ns/xapi#','foxxi-scorm-cam':'https://foxxi-bridge.interego.xwisee.com/ns/scorm-cam#',
    'foxxi-scorm-rte':'https://foxxi-bridge.interego.xwisee.com/ns/scorm-rte#','foxxi-cmi5':'https://foxxi-bridge.interego.xwisee.com/ns/cmi5#',
    xapi:'https://w3id.org/xapi/ontology#','xapi-prof':'https://w3id.org/xapi/profiles/ontology#',fxa:ACTION_ROOT+'foxxi/',rla:ACTION_ROOT+'relay/',
    hydra:HYDRA,skos:SKOS,schema:'https://schema.org/',dct:DCT,prov:PROV,dcat:DCAT,odrl:ODRL,prof:'http://www.w3.org/ns/dx/prof/',
    sh:'http://www.w3.org/ns/shacl#',owl:OWL,rdfs:RDFS,rdf:RDF,xsd:'http://www.w3.org/2001/XMLSchema#',cred:'https://www.w3.org/2018/credentials#',
  }).sort((a,b)=>b[1].length-a[1].length);
  const qname=(iri:string):string=>{const p=prefixes.find(([,ns])=>iri.startsWith(ns)&&iri.length>ns.length);return p?p[0]+':'+iri.slice(p[1].length):iri;};
  const declaredGs=new Set<string>();
  const anchor=(iri:string):string|undefined=>iri.startsWith(NS)?iri.slice(NS.length):declaredGs.has(iri)?'gs-'+iri.slice(GSNS.length):undefined;
  const term=(n:Term|undefined):string=>{
    if(n?.termType==='NamedNode'){const a=anchor(n.value);if(a)return'<a class="qn" href="#'+esc(a)+'">'+esc(qname(n.value))+'</a>';
      if(n.value.startsWith('https://id.i2idl.org/collections/'))return'<code class="qn">'+esc(qname(n.value))+'</code>';return ext(n.value,esc(qname(n.value)),'qn');}
    return n?.termType==='Literal'?esc(n.value):'…';
  };
  const collection=(g:Store,start:Term):Term[]=>{
    const out:Term[]=[],seen=new Set<string>();let n:Term|undefined=start;
    while(n&&n.value!==RDF+'nil'){if(seen.has(n.value))throw new Error('Cyclic RDF collection '+n.value);seen.add(n.value);
      const first=value(g,n,RDF+'first');if(!first)throw new Error('Incomplete RDF collection '+n.value);out.push(first);n=value(g,n,RDF+'rest');}return out;
  };
  const expr=(g:Store,n:Term|undefined):string=>{
    if(n?.termType==='NamedNode'||n?.termType==='Literal')return term(n);
    if(n&&value(g,n,RDF+'first'))return collection(g,n).map(x=>expr(g,x)).join(' ∘ ');
    const inter=value(g,n,OWL+'intersectionOf');if(inter)return collection(g,inter).map(x=>expr(g,x)).join(' ⊓ ');
    if(os(g,n,RDF+'type').some(t=>t.value===OWL+'Restriction')){const p=value(g,n,OWL+'onProperty');
      for(const[kw,pred]of[['value','hasValue'],['some','someValuesFrom'],['only','allValuesFrom']]){const v=value(g,n,OWL+pred);if(v)return'('+term(p)+' '+kw+' '+expr(g,v)+')';}}return'…';
  };
  const load=(k:string):[Store,string]=>{const s=readFileSync(join(DIST,SLUG[k]!+'.ttl'),'utf8');return[new Store(new Parser({format:'text/turtle',baseIRI:IRI[k]}).parse(s)),s];};
  const[onto]=load('ontology'),[cat]=load('catalog'),[enact]=load('enactments'),[maps]=load('mappings');
  const actionTargets=catalogActionTargets(cat,onto,IRI.catalog!,NS);
  const[rels]=load('releases'),[chg]=load('changes'),[refs]=load('referents');load('alignments');
  const sem=readJson<ReasoningRecord>(join(DIST,'semantic-layer.json')),pub=readJson<{graphs:PublishedGraph[]}>(join(DIST,'published.json'));
  readJson<unknown>(join(DIST,'publish-plan.json'));
  const report=readFileSync(join(DIST,'verification-report.md'),'utf8'),walk=readFileSync(join(DIST,'agent-walkthrough.md'),'utf8');
  const gl=await parseJsonLd(readJson<unknown>(join(cfg.i2idl.localClone,cfg.i2idl.graphPath)));
  const labels=new Map(gl.getQuads(null,namedNode(SKOS+'prefLabel'),null,null).map(q=>[q.subject.value,q.object.value]));
  const nConcepts=subjects(gl,RDF+'type',namedNode(SKOS+'Concept')).length;
  const conceptLabel=(iri:string):string=>labels.get(iri)??iri.split('/').at(-1)!;
  const conceptLink=(n:Term|string|undefined):string=>{const iri=typeof n==='string'?n:lexical(n);return ext(iri,esc(conceptLabel(iri)));};
  const actionName=(iri:string):string=>iri.startsWith(ACTION_ROOT)?iri.slice(ACTION_ROOT.length):qname(iri);
  const actionLink=(n:Term|string|undefined):string=>{const iri=typeof n==='string'?n:lexical(n),a=actionTargets.get(iri)??anchor(iri);return a?'<a class="qn" href="#'+esc(a)+'">'+esc(iri.startsWith(NS)?iri.slice(NS.length):actionName(iri))+'</a>':ext(iri,esc(actionName(iri)),'qn');};
  const sections:[string,string][]=[],sectionOf=new Map<string,string>(),order:string[]=[];let current:string|undefined;
  const ontologySource=readFileSync(join(ROOT,'src','i2idlx.ttl.tmpl'),'utf8')
    .replace('{{CHANGE_KINDS}}',CHANGE_KINDS.map(([code])=>'i2x:change-'+code+' a skos:Concept .').join('\n'))
    .replace('{{ORIGINS}}',originVocabularyDeclarations(readJson<OriginDeclarations>(join(ROOT,'src','origins.json'))))
    .replace('{{REFERENT_CATEGORIES}}',semantic.CATEGORIES.map(c=>'i2x:'+c.cls+' a owl:Class .\ni2x:category-'+c.id+' a skos:Concept .').join('\n'));
  for(const line of ontologySource.split(/\r?\n/)){const s=/^#\s+([A-Z])\.\s+(.+?)\s*$/.exec(line);if(s){current=s[1];sections.push([current!,s[2]!.replace(/\.$/,'')]);continue;}
    const m=/^(i2x|gs):([A-Za-z0-9_-]+)[\s;.]/.exec(line);if(m&&current){const iri=(m[1]==='i2x'?NS:GSNS)+m[2];if(!sectionOf.has(iri)){sectionOf.set(iri,m[1]==='gs'?'H':current);order.push(iri);}}}
  for(const iri of order)if(iri.startsWith(GSNS))declaredGs.add(iri);
  const bySlug=new Map(pub.graphs.map(r=>[r.graph,r])),graphRows:string[]=[];
  for(const[key,title,blurb]of DISPLAY){const rec=bySlug.get(SLUG[key]!)!;if(!rec)throw new Error('Missing published graph '+key);
    const[g]=load(key),status=rec.modalStatus,hash=rec.contentHash.split(':').slice(1).join(':');
    const links=[ext(IRI[key]!,'Page'),ext(IRI[key]!+'?format=turtle','Turtle'),ext(IRI[key]!+'?format=jsonld','JSON-LD'),ext(IRI[key]!+'?format=markdown','Markdown')].join(' · ');
    graphRows.push('<tr><td><div class="cell-title">'+esc(title)+'</div><code class="iri">'+wbr(IRI[key])+'</code><div class="muted small">'+esc(blurb)+
      '</div></td><td><span class="chip '+status.toLowerCase()+'">'+esc(status)+'</span></td><td class="num">'+number(g.size)+'</td><td class="links">'+links+
      '</td><td>'+ext(rec.descriptor,'Signed descriptor')+'<div class="hash" title="'+esc(rec.contentHash)+'">sha256 <code>'+esc(hash.slice(0,12))+
      '…</code> <button class="btn btn-tiny" type="button" data-copy="'+esc(rec.contentHash)+'">Copy hash</button></div></td></tr>');}
  const decoN=Number(/(\d+) concrete affordances materialized/.exec(report)?.[1]);if(!Number.isFinite(decoN))throw new Error('Missing decoration count in report');
  const decoMb=statSync(join(DIST,SLUG.decorations!+'.ttl')).size/1e6;
  graphRows.push('<tr class="local"><td><div class="cell-title">Decorations</div><code class="iri">'+esc(SLUG.decorations)+
    '.ttl</code><div class="muted small">Five followable controls per concept, materialized from the decorator registry.</div></td><td><span class="chip local">Local</span></td>'+
    '<td class="num">'+number(decoN)+' controls</td><td colspan="2" class="muted">In the package ('+decoMb.toFixed(1)+
    ' MB). Not published: an agent can derive it from the catalog templates.</td></tr>');

  const controls=os(cat,namedNode(IRI.catalog!),IEP+'affordance').map(n=>n.value.slice(CAT.length));
  if(controls.length===0)throw new Error('Catalog has no affordance listing');
  const groups=['Reads on the live glossary','REST API reads','Semantic layer (graphs on Interego)','Per-concept templates','Governed writes through Interego','Foxxi capabilities','Human-routed'];
  const grouped=new Map(groups.map(g=>[g,[] as string[]]));let nFollowable=0,nTemplates=0;
  for(const local of controls){const s=namedNode(CAT+local),action=value(cat,s,IEP+'action');
    const method=value(cat,s,HYDRA+'method')?.value??'POST',target=value(cat,s,HYDRA+'target'),tmplNode=value(cat,s,NS+'targetTemplate');
    const template=tmplNode?lexical(value(cat,tmplNode,HYDRA+'template')):undefined,media=value(cat,s,DCAT+'mediaType');
    const readOnly=boolean(value(cat,s,IEP+'readOnlyHint')),cap=value(cat,s,NS+'requiresCapability'),routed=boolean(value(cat,s,IEP+'externallyRouted'));
    const label=text(cat,s,RDFS+'label'),desc=text(cat,s,HYDRA+'description')??text(cat,s,HYDRA+'title')??'';
    const group=routed?'Human-routed':local.startsWith('port-rest-')?'REST API reads':['port-vocabulary','port-alignments','port-referents'].includes(local)?'Semantic layer (graphs on Interego)':
      lexical(action).startsWith(ACTION_ROOT+'foxxi/')?'Foxxi capabilities':template?'Per-concept templates':!readOnly?'Governed writes through Interego':'Reads on the live glossary';
    let where:string;if(target){nFollowable++;where='<code class="iri">'+wbr(target.value)+'</code>';}else{nTemplates++;where='<code class="iri tpl">'+wbr(template)+'</code> <span class="tag">template</span>';}
    grouped.get(group)!.push('<tr id="'+esc(local)+'"><td><div class="cell-title">'+esc(label)+'</div><div class="muted small">'+esc(desc)+
      '</div></td><td>'+actionLink(action)+'</td><td><span class="method '+method.toLowerCase()+'">'+esc(method)+'</span></td><td>'+where+
      '</td><td><code>'+wbr(media?.value??'')+'</code></td><td>'+(cap?term(cap):'<span class="muted">—</span>')+'</td></tr>');}
  const controlRows=groups.flatMap(g=>grouped.get(g)!.length?['<tr class="group"><th colspan="6">'+esc(g)+'</th></tr>',...grouped.get(g)!]:[]);
  const nControls=nFollowable+nTemplates;
  const samples:Record<string,Record<string,string>>={
    'concept-neighborhood':{concept:'<https://id.i2idl.org/concepts/learning-record-store-lrs>'},
    'concept-search':{text:'"record store"'},'definition-evidence':{concept:'<https://id.i2idl.org/concepts/data-privacy>'},
    'collection-members':{collection:'<https://id.i2idl.org/collections/curated/competency-and-assessment>'},
    'field-intersection':{fieldA:'<https://id.i2idl.org/collections/field/learning-engineering>',fieldB:'<https://id.i2idl.org/collections/field/learning-sciences>'},
    'concepts-by-type':{type:'<https://id.i2idl.org/collections/type/standard>'},'multi-field-concepts':{},'provenance-profile':{},
    'release-check':{version:JSON.stringify(cfg.i2idl.release)},classify:{},'concept-referents':{concept:'<https://id.i2idl.org/concepts/formative-assessment>'},
  };
  const queryCards:string[]=[];
  for(const local of subjects(cat,RDF+'type',namedNode(NS+'StoredQuery')).map(s=>s.value.slice(CAT.length)).sort(compareText)){
    const name=local.slice(2),s=namedNode(CAT+local),sparql=lexical(value(cat,s,NS+'sparql'));
    const params=[...new Set(os(cat,s,NS+'parameter').map(p=>p.value))].sort((a,b)=>sparql.indexOf('$'+a)-sparql.indexOf('$'+b));
    let bound=sparql;if(!samples[name])throw new Error('No sample bindings for query '+name);
    for(const[k,v]of Object.entries(samples[name]!))bound=bound.replace(new RegExp('\\$'+k.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&')+'\\b','g'),()=>v);
    const over=os(cat,s,NS+'runsOver').map(x=>x.value.split('#').at(-1)!).sort(compareText);
    const actionHtml=over.length?'<span class="note">Runs client-side over '+over.map(o=>'<a href="#'+esc(o)+'"><code>'+esc(o)+'</code></a>').join(', ')+
      ' plus your own data (<code>i2x:runsOver</code>): follow those ports, load the results with your data into any SPARQL 1.1 engine, run it there.</span>':
      '<a class="btn btn-primary run" href="'+esc(ENDPOINT+'?query='+encodeURIComponent(bound))+'" target="_blank" rel="noopener">Run on the live endpoint</a>';
    const inputs=params.map(p=>'<div class="param"><label for="p-'+esc(name)+'-'+esc(p)+'">$'+esc(p)+'</label><input id="p-'+esc(name)+'-'+esc(p)+
      '" data-param="'+esc(p)+'" value="'+esc(samples[name]![p]??'')+'" spellcheck="false" autocomplete="off"></div>').join('');
    queryCards.push('<article class="query" id="'+esc(local)+'" data-name="'+esc(name)+'"><div class="query-head"><h3>'+esc(text(cat,s,RDFS+'label'))+
      '</h3><span class="method">'+esc(value(cat,s,NS+'queryForm')?.value)+'</span></div><p class="muted">'+codeInline(text(cat,s,DCT+'description')??'')+
      '</p>'+(params.length?'<div class="params">'+inputs+'</div>':'')+'<pre><code id="code-'+esc(name)+'">'+esc(bound.trimEnd())+
      '</code></pre><div class="row-actions"><button class="btn" type="button" data-copy-from="code-'+esc(name)+'">Copy query</button>'+actionHtml+
      '</div><script type="application/json" class="q-src">'+jsonScript(sparql)+'</script></article>');}
  const kinds=[
    [OWL+'Class','Class'],[OWL+'ObjectProperty','Object property'],[OWL+'DatatypeProperty','Datatype property'],[OWL+'AnnotationProperty','Annotation property'],
    [SKOS+'ConceptScheme','Concept scheme'],[SKOS+'Concept','Concept'],[NS+'ActionIdentity','Action identity'],[HYPRAGENT+'Capability','Capability'],
    [IEH+'DecoratorRegistry','Decorator registry'],[IEH+'AffordanceDecorator','Decorator'],[ODRL+'Action','ODRL action'],
  ];
  const predLabels=new Map([
    [RDFS+'subClassOf','Subclass of'],[RDFS+'subPropertyOf','Subproperty of'],[RDFS+'domain','Domain'],[RDFS+'range','Range'],
    [OWL+'equivalentClass','Equivalent to'],[OWL+'propertyChainAxiom','Property chain'],[NS+'kindForTypeCollection','Type collections'],
    [NS+'asProperty','Materializes as'],[SKOS+'inScheme','In scheme'],[SKOS+'closeMatch','Close match'],[SKOS+'broadMatch','Broad match'],
    [NS+'answersInterrogative','Answers'],[NS+'hasDecorator','Decorators'],[SKOS+'hasTopConcept','Concepts'],[IEH+'decoratorId','Decorator id'],
    [IEH+'decoratorName','Name'],[IEH+'priority','Priority'],[IEH+'domain','Vertical'],[NS+'selects','Applies to'],
    [RDFS+'isDefinedBy','Defined by'],[RDFS+'seeAlso','See also'],[SKOS+'example','Example'],
  ]);
  const skip=new Set([RDF+'type',RDFS+'label',SKOS+'prefLabel',RDFS+'comment',SKOS+'definition',SKOS+'topConceptOf']);
  const vocabHtml:string[]=[];let nTerms=0;
  for(const[letter,title]of sections){const arts:string[]=[];
    for(const iri of order.filter(i=>sectionOf.get(i)===letter)){
      const s=namedNode(iri),types=new Set(os(onto,s,RDF+'type').map(t=>t.value));let kind=kinds.find(([t])=>types.has(t!))?.[1]??'Term';
      if(types.has(OWL+'FunctionalProperty'))kind+=' · functional';
      const label=text(onto,s,RDFS+'label',SKOS+'prefLabel'),comment=text(onto,s,RDFS+'comment',SKOS+'definition'),facts=new Map<string,Term[]>();
      for(const q of onto.getQuads(s,null,null,null))if(!skip.has(q.predicate.value)){const p=q.predicate.value;if(!facts.has(p))facts.set(p,[]);facts.get(p)!.push(q.object);}
      const dl=[...facts].sort(byText(([p])=>predLabels.get(p)??'~'+qname(p))).map(([p,objs])=>
        '<div><dt>'+esc(predLabels.get(p)??qname(p))+'</dt><dd>'+objs.sort(byText(o=>qname(o.value))).map(o=>expr(onto,o)).join(', ')+'</dd></div>').join('');
      const search=[qname(iri),label??'',comment??'',kind].filter(Boolean).join(' ').toLowerCase();
      arts.push('<article class="term" id="'+esc(anchor(iri))+'" data-search="'+esc(search)+'"><div class="term-head"><code class="term-qn">'+
        esc(qname(iri))+'</code><span class="kind">'+esc(kind)+'</span></div>'+(label?'<h4>'+esc(label)+'</h4>':'')+
        (comment?'<p>'+esc(comment)+'</p>':'')+(dl?'<dl class="facts">'+dl+'</dl>':'')+'</article>');nTerms++;}
    let extra='';if(letter==='G'){const pairs=onto.getQuads(null,namedNode(NS+'answersInterrogative'),null,null).sort((a,b)=>
      compareText(qname(a.object.value),qname(b.object.value))||compareText(qname(a.subject.value),qname(b.subject.value)));
      extra='<div class="table-wrap narrow"><table><thead><tr><th>Property</th><th>Answers</th></tr></thead><tbody>'+
        pairs.map(q=>'<tr><td>'+term(q.subject)+'</td><td>'+term(q.object)+'</td></tr>').join('')+'</tbody></table></div>';}
    vocabHtml.push('<div class="vocab-section" data-letter="'+letter+'"><h3><span class="letter">'+letter+'</span> '+esc(title)+'</h3>'+extra+arts.join('')+'</div>');}

  const enactRows:string[]=[],rolesSeen=new Map<string,number>(),roleCaps=new Map<string,[string,string][]>();
  for(const local of subjects(enact,RDF+'type',namedNode(NS+'Enactment')).map(s=>s.value.slice(EN.length)).sort(compareText)){
    const s=namedNode(EN+local),concept=value(enact,s,NS+'enactedConcept'),action=value(enact,s,NS+'viaAction'),role=value(enact,s,NS+'enactmentRole');
    const roleLabel=text(onto,role,SKOS+'prefLabel')??qname(lexical(role));add(rolesSeen,roleLabel);
    const conf=Number(value(enact,s,NS+'confidence')?.value),rationale=text(enact,s,NS+'rationale')??'';
    const search=(conceptLabel(lexical(concept))+' '+actionName(lexical(action))+' '+roleLabel+' '+rationale).toLowerCase();
    enactRows.push('<tr data-role="'+esc(roleLabel)+'" data-search="'+esc(search)+'"><td>'+conceptLink(concept)+'</td><td>'+esc(roleLabel)+
      '</td><td>'+actionLink(action)+'</td><td class="num">'+conf.toFixed(2)+'</td><td class="small">'+esc(rationale)+'</td></tr>');}
  const roleNotes=new Map<string,string>(),foxxiRows=readJson<{action:string;title:string}[]>(join(ROOT,'evidence','foxxi-affordances.json'));
  for(const[cid,akey,conf,why]of cw.ROLE_CAPABILITIES)roleNotes.set(JSON.stringify(['https://id.i2idl.org/concepts/'+cid,ACTION_ROOT+akey]),conf.toFixed(2)+' — '+why);
  const foxxiByKey=new Map(foxxiRows.map(row=>[row.action.split('/ns/iep/action/').at(-1)!,row]));
  for(const[tag,[cid]]of Object.entries(cw.ROLE_TAGS)){
    const keys=[...foxxiByKey.keys()].filter(k=>foxxiByKey.get(k)!.title.startsWith(tag)).sort(compareText);
    for(const key of keys)roleNotes.set(JSON.stringify(['https://id.i2idl.org/concepts/'+cid,ACTION_ROOT+key]),'derived: '+tag+' in manifest title');
  }
  for(const q of enact.getQuads(null,namedNode(NS+'roleCapability'),null,null)){
    const concept=q.subject.value;if(!roleCaps.has(concept))roleCaps.set(concept,[]);
    roleCaps.get(concept)!.push([q.object.value,roleNotes.get(JSON.stringify([concept,q.object.value]))??'Declared role capability']);}
  const roleHtml=[...roleCaps].map(([concept,acts])=>{
    const chips=acts.map(([a,n])=>'<span class="cap" title="'+esc(n)+'">'+actionLink(a)+'</span>').join(' ');
    return'<div class="role"><div class="cell-title">'+conceptLink(concept)+' <span class="muted">'+acts.length+'</span></div>'+chips+
      (acts.every(([,n])=>n.startsWith('derived'))?'<div class="muted small">Derived from the role tags in Foxxi\'s own manifest.</div>':'')+'</div>';});
  const nRoleCaps=[...roleCaps.values()].reduce((n,x)=>n+x.length,0);
  const mapRows:string[]=[],vocabCounts=new Map<string,number>(),methodCounts=new Map<string,number>(),proposalOf=new Map<string,[string,string,string]>();
  let nSuperseded=0;
  for(const local of subjects(maps,RDF+'type',namedNode(NS+'MappingProposal')).map(s=>s.value.slice(MP.length)).sort(compareText)){
    const s=namedNode(MP+local),subj=value(maps,s,NS+'proposedSubject'),pred=value(maps,s,NS+'proposedPredicate'),obj=value(maps,s,NS+'proposedObject');
    const status=lexical(value(maps,s,NS+'reviewStatus')).split('-').at(-1)!;
    if(status!=='superseded')proposalOf.set(JSON.stringify([lexical(subj),lexical(obj)]),[local,lexical(pred).split('#').at(-1)!,status]);
    if(status==='superseded'){nSuperseded++;continue;}if(status==='adopted')continue;
    const i2idlSays=os(maps,s,NS+'i2idlPredicate').map(o=>o.value.split('#').at(-1)!).sort(compareText);
    const vocab=VOCABS.find(([ns])=>lexical(obj).startsWith(ns))?.[1];if(!vocab)throw new Error('Unknown proposal vocabulary '+lexical(obj));
    add(vocabCounts,vocab);const method=text(onto,value(maps,s,NS+'mappingMethod'),SKOS+'prefLabel')??'';add(methodCounts,method);
    const conf=Number(value(maps,s,NS+'confidence')?.value),rationale=text(maps,s,NS+'rationale')??'';
    const search=(conceptLabel(lexical(subj))+' '+qname(lexical(obj))+' '+vocab+' '+rationale).toLowerCase();
    mapRows.push('<tr data-vocab="'+esc(vocab)+'" data-search="'+esc(search)+'"><td>'+conceptLink(subj)+'</td><td><code>'+
      esc(lexical(pred).split('#').at(-1))+'</code>'+(i2idlSays.length?'<div class="muted small">I2IDL asserts <code>'+esc(i2idlSays.join(', '))+'</code></div>':'')+
      '</td><td>'+ext(lexical(obj),esc(qname(lexical(obj))),'qn')+'<div class="muted small">'+esc(vocab)+'</div></td><td>'+esc(method)+
      '</td><td class="num">'+conf.toFixed(2)+'</td><td class="small">'+esc(rationale)+'</td></tr>');}
  const nAdopted=[...proposalOf.values()].filter(v=>v[2]==='adopted').length,ownRowRecords:[string,string][]=[];
  for(const p of ['exactMatch','closeMatch','relatedMatch','broadMatch','narrowMatch'])for(const q of gl.getQuads(null,namedNode(SKOS+p),null,null)){
    const prop=proposalOf.get(JSON.stringify([q.subject.value,q.object.value])),note=!prop?'':prop[2]==='adopted'?
      'adopted: I2IDL-X proposed the same (<code>'+esc(prop[0])+'</code>)':'I2IDL-X proposes <code>'+esc(prop[1])+'</code> (<code>'+esc(prop[0])+'</code>), open';
    ownRowRecords.push([conceptLabel(q.subject.value),'<tr><td>'+conceptLink(q.subject)+'</td><td><code>'+p+'</code></td><td>'+
      ext(q.object.value,esc(qname(q.object.value)),'qn')+'</td><td class="small">'+note+'</td></tr>']);}
  const ownRows=ownRowRecords.sort((a,b)=>compareText(a[0],b[0])||compareText(a[1],b[1])).map(([,r])=>r);
  const releaseRows:string[]=[];
  const releaseNodes=subjects(rels,RDF+'type',namedNode(NS+'GlossaryRelease')).sort((a,b)=>{
    const av=lexical(value(rels,a,NS+'releaseVersion')).replace(/^v/,'').split('.').map(Number),bv=lexical(value(rels,b,NS+'releaseVersion')).replace(/^v/,'').split('.').map(Number);
    for(let i=0;i<Math.min(av.length,bv.length);i++)if(av[i]!==bv[i])return bv[i]!-av[i]!;return bv.length-av.length;});
  for(const s of releaseNodes){const version=lexical(value(rels,s,NS+'releaseVersion')),commit=lexical(value(rels,s,NS+'releaseCommit'));
    const when=lexical(value(rels,s,PROV+'generatedAtTime')).slice(0,10),changes:string[]=[];
    const added=os(rels,s,NS+'addedConcept').sort(byText(c=>conceptLabel(c.value))),removed=os(rels,s,NS+'removedConcept').sort(byText(c=>conceptLabel(c.value)));
    const revised=os(rels,s,NS+'revisedDefinitionOf').sort(byText(c=>conceptLabel(c.value)));
    if(added.length)changes.push('<strong>Added '+added.length+':</strong> '+added.map(c=>conceptLink(c)).join(', '));
    if(removed.length)changes.push('<strong>Removed '+removed.length+':</strong> '+removed.map(c=>esc(conceptLabel(c.value))).join(', '));
    if(revised.length)changes.push('<strong>Revised '+revised.length+':</strong> '+revised.map(c=>conceptLink(c)).join(', '));
    const cmp=value(rels,s,RDFS+'seeAlso'),cmpHtml=cmp?' · '+ext(cmp.value,'diff'):'';
    releaseRows.push('<tr><td><strong>'+esc(version)+'</strong></td><td class="num">'+esc(when)+'</td><td>'+
      ext('https://github.com/blakeplock/i2idl-linked-data/commit/'+commit,'<code>'+esc(commit.slice(0,7))+'</code>')+cmpHtml+
      '</td><td class="num">'+Number(value(rels,s,NS+'conceptCount')?.value)+'</td><td class="num">'+Number(value(rels,s,NS+'relatedPairCount')?.value)+
      '</td><td class="num">'+Number(value(rels,s,NS+'broaderPairCount')?.value)+'</td><td class="small">'+
      (changes.join('<br>')||'<span class=muted>No concept changes</span>')+'</td></tr>');}
  const originRows:string[]=[];
  for(const o of readJson<{origins:{id:string}[]}>(join(ROOT,'src','origins.json')).origins){
    const node=subjects(onto,SKOS+'inScheme',namedNode(NS+'Origins')).find(n=>value(onto,n,SKOS+'notation')?.value===o.id);if(!node)throw new Error('Missing origin '+o.id);
    const held=os(onto,node,NS+'heldIn').map(h=>h.value).sort(compareText);
    originRows.push('<tr><td><span class="origin o-'+esc(o.id)+'">'+esc(text(onto,node,SKOS+'prefLabel'))+'</span></td><td class="small">'+
      esc(text(onto,node,SKOS+'definition'))+'</td><td class="small">'+esc(text(onto,node,SKOS+'scopeNote'))+'</td><td class="small">'+
      (held.map(h=>ext(h,wbr(h.replace('https://','')))).join('<br>')||'<span class=muted>—</span>')+'</td></tr>');}
  const kindLabels=new Map(subjects(onto,SKOS+'inScheme',namedNode(NS+'ChangeKinds')).map(k=>[k.value,text(onto,k,SKOS+'prefLabel')??'?']));
  const changeRows:string[]=[],changeNodes=subjects(chg,RDF+'type',namedNode(NS+'ReleaseChange'));let nChangeFacts=0;
  for(const rc of [...changeNodes].sort((a,b)=>compareText(lexical(value(chg,b,PROV+'endedAtTime')),lexical(value(chg,a,PROV+'endedAtTime'))))){
    const counts=new Map<string,number>();for(const ev of subjects(chg,NS+'partOfChange',rc))add(counts,kindLabels.get(lexical(value(chg,ev,NS+'changeKind')))??'?',Number(value(chg,ev,NS+'changeCount')?.value));
    const n=Number(value(chg,rc,NS+'changeCount')?.value);nChangeFacts+=n;
    changeRows.push('<tr><td><strong>'+esc(text(chg,rc,RDFS+'label'))+'</strong></td><td class="num">'+esc(lexical(value(chg,rc,PROV+'endedAtTime')).slice(0,10))+
      '</td><td class="num">'+number(n)+'</td><td class="small">'+([...counts].sort((a,b)=>b[1]-a[1]).map(([k,v])=>number(v)+' '+esc(k)).join(', ')||
      '<span class=muted>No change to the published graph</span>')+'</td></tr>');}

  const sPrefixes=semantic.PREFIXES as Readonly<Record<string,string>>,scol=new Map(semantic.VOCABS.map(v=>[v.prefix,v.column])),sshort=new Map(semantic.VOCABS.map(v=>[v.prefix,v.short]));
  const categories=semantic.CATEGORIES as readonly Category[],scat=new Map(categories.map(c=>[c.id,c]));
  const expand=(curie:string):string=>{const i=curie.indexOf(':');return sPrefixes[curie.slice(0,i)]!+curie.slice(i+1);};
  const sTerm=(curie:string,dim=false,tag=false):string=>{const i=curie.indexOf(':'),pfx=curie.slice(0,i);
    const label=sem.labels[curie]||curie.slice(i+1).replace(/([a-z])([A-Z])/g,'$1 $2');return'<a class="'+(dim?'sterm dim':'sterm')+'" href="'+esc(expand(curie))+
      '" target="_blank" rel="noopener" title="'+esc(curie)+'">'+(tag?'<span class="tv">'+esc(sshort.get(pfx)??pfx)+'</span>':'')+esc(label)+'</a>';};
  const chainFor=(id:string):string[]=>{const out=[id];while(scat.get(out.at(-1)!)?.broader){const b=scat.get(out.at(-1)!)!.broader!;if(out.includes(b))throw new Error('Cyclic category '+id);out.push(b);}return out;};
  const nInCategory=new Map<string,number>();for(const q of refs.getQuads(null,namedNode(NS+'referentCategory'),null,null))add(nInCategory,q.object.value.split('category-').at(-1)!);
  const semRows:string[]=[];let lastGroup:string|undefined;
  for(const c of categories){
    if(c.group!==lastGroup){semRows.push('<tr class="group"><th colspan="'+(semantic.COLUMNS.length+1)+'">'+esc(c.group)+'</th></tr>');lastGroup=c.group;}
    const cells=semantic.COLUMNS.map(([col])=>{const terms:[string,boolean][]=[];
      for(const k of chainFor(c.id))for(const tt of scat.get(k)?.referent??[])if(scol.get(tt.split(':')[0]!)===col&&!terms.some(([x])=>x===tt))terms.push([tt,k!==c.id]);
      if(col==='peer')for(const tt of c.expressible??[])if(!terms.some(([x])=>x===tt))terms.push([tt,true]);
      return'<td>'+terms.map(([tt,dim])=>sTerm(tt,dim,col==='schema'||col==='peer')).join(' ')+'</td>';});
    const depth=chainFor(c.id).length-1,mode=c.mode==='subject'?' <span class="tag">subject only</span>':c.mode==='none'?' <span class="tag">no single category</span>':'';
    semRows.push('<tr><td style="padding-left:'+(12+depth*14)+'px"><div class="cell-title">'+esc(c.label)+mode+'</div><div class="muted small">'+
      (nInCategory.get(c.id)??0)+' concepts · <code>i2x:'+esc(c.cls)+'</code></div></td>'+cells.join('')+'</tr>');}
  const reasonItems=[
    "OWL 2 RL closure over the upper ontologies, I2IDL-X, I2IDL's whole release and a sample organization: "+number(sem.owlrl.input)+' → '+number(sem.owlrl.closed)+
      ' triples, '+(sem.owlrl.consistent===false?'NOT consistent.':'consistent.'),
    ...Object.entries(sem.hermit??{}).map(([g,r])=>"HermiT (OWL 2 DL), "+esc(g)+" + I2IDL's release + I2IDL-X + the sample: "+(r.sample?.consistent?'consistent':'NOT consistent')+'.'),
    'A thing classified as both a formative assessment and a classroom teacher is rejected under '+sem.clash.rejectedBy.join(', ')+', by OWL 2 RL and HermiT alike.',
    sem.disjoint.length+' of '+sem.disjointCheck.pairs+' pairs of referent categories can never share a member; one individual per pair, OWL 2 RL rejects exactly those pairs.',
    'The SHACL-AF referent rules (TripleRules, no OWL) reach the same referent classes as OWL 2 RL for all '+sem.rules.explicit+' explicitly classified resources.',
    'q-classify (plain SPARQL) concludes nothing OWL 2 RL does not and finds every referent class it finds: '+sem.classify.sampleTypings+' typings of the sample organization and '+
      (sem.classify.typings-sem.classify.sampleTypings)+' of the I2IDL services I2IDL-X classifies.',
    'All '+sem.terms+" aligned terms exist in pinned snapshots of their publishers' files.",
  ];
  const nAssigned=[...nInCategory.values()].reduce((a,b)=>a+b,0),nByDef=refs.getQuads(null,namedNode(NS+'assignmentBasis'),null,null).filter(q=>q.object.value==='definition').length;
  const appMeta=readJson<{meta:AppMeta}>(join(APP,'data.json')).meta,upstream=appMeta.upstream,nUnesco=vocabCounts.get('UNESCO Thesaurus')??0;
  if(mapRows.length!==appMeta.counts.mappings||nUnesco!==appMeta.counts.unesco)throw new Error('Open proposals '+mapRows.length+'/'+nUnesco+' disagree with workbench '+appMeta.counts.mappings+'/'+appMeta.counts.unesco);
  const priorities:Record<number,string>={
    1:'Your own '+ownRows.length+' crosswalks, shown as yours; '+nAdopted+' of them assert what an I2IDL-X proposal proposed, which is marked adopted. '+mapRows.length+' open proposals, '+
      nUnesco+' of them to the UNESCO Thesaurus drawn from citations your editors already made; a mapping triple from a proposal appears only after ratification. <a href="#mappings">Mappings</a>',
    2:'Your three example routes answered as stored queries against your own SPARQL service, inside your published limits, behind a HyprCat catalog of '+nControls+' controls. <a href="#queries">Stored queries</a>',
    3:'Your two provenance wordings, computed for every definition from your own evidence relations, and published as SHACL rules any engine can rerun. <a href="#SourceGroundedDefinition">Rules</a>',
    4:'Every change since the first public release as PROV: '+changeRows.length+' release changes, '+number(nChangeFacts)+' fact-level changes, reconciling exactly with '+esc(cfg.i2idl.release)+'. <a href="#history">Change history</a>',
  };
  const checkGroups:{title:string;items:[string,string][]}[]=[];let group:(typeof checkGroups)[number]|undefined;
  for(const line of report.split(/\r?\n/)){if(line.startsWith('## ')){group={title:line.slice(3).trim(),items:[]};checkGroups.push(group);}
    else if(line.startsWith('- ')&&group){const m=/^- (PASS|FAIL|INFO) — (.*)/.exec(line);group.items.push(m?[m[1]!,m[2]!]:['NOTE',line.slice(2)]);}}
  const nPass=checkGroups.reduce((n,g)=>n+g.items.filter(([k])=>k==='PASS').length,0),nFail=checkGroups.reduce((n,g)=>n+g.items.filter(([k])=>k==='FAIL').length,0);
  const checksHtml=checkGroups.filter(g=>g.items.length&&g.title!=='Summary').map(g=>'<div class="check-group"><h3>'+esc(g.title)+'</h3><ul class="checklist">'+
    g.items.map(([k,t])=>'<li class="'+k.toLowerCase()+'"><span class="mark">'+esc(k)+'</span><span>'+codeInline(t)+'</span></li>').join('')+'</ul></div>').join('');
  const codes=matches(walk,/→ \*\*(\d{3})\*\*/g),found=/"label": "([^"]+)"/.exec(walk),nTrip=/\*\*200\*\*, (\d+) triples/.exec(walk),enactedBy=/- \x60(\w+)\x60 → \x60([^\x60]+)\x60/.exec(walk);
  const walkChain:string[]=[];
  if(codes.length>=5){const steps:[string,string][]=[
    ['Read the catalog',codes[0]!],['Search “record store” → '+(found?.[1]??'a concept'),codes[1]!],
    ['Follow its neighborhood control ('+(nTrip?.[1]??'?')+' triples)',codes[2]!],
    ['Follow '+(enactedBy?.[1]??'an enactment')+' → '+(enactedBy?actionName(enactedBy[2]!):''),codes[3]!],['Invoke it: GET /xapi/about on Foxxi',codes[4]!],
  ];
    const semWalk=/## 6\. Type your own data.*?Result: \*\*(\d+) typings\*\*/s.exec(walk);
    if(semWalk){const portCodes=matches(walk,/\x60port-[a-z]+\x60: \x60GET [^\x60]+\x60 \(Accept: [^)]+\) → \*\*(\d{3})\*\*/g);
      steps.push(['Follow the semantic-layer ports and run q-classify locally: '+semWalk[1]+' typings of a sample organization',portCodes.sort(compareText).at(-1)??'?']);}
    walkChain.push(...steps.map(([t,c])=>'<li><span class="status s'+c[0]+'">'+esc(c)+'</span> '+esc(t)+'</li>'));}

  if(!walkChain.length&&/^Mode: \*\*local\*\*/m.test(walk)){
    const rows=/Local stored query executed: \*\*(\d+) rows\*\*/.exec(walk)?.[1]??'?';
    const triples=/Local neighborhood query executed: \*\*(\d+) triples\*\*/.exec(walk)?.[1]??'?';
    const typings=/Result: \*\*(\d+) typings\*\*/.exec(walk)?.[1]??'?';
    walkChain.push('<li>Local pinned catalog parsed</li>','<li>Local stored search: '+esc(rows)+' rows</li>',
      '<li>Local neighborhood: '+esc(triples)+' triples</li>','<li>Local sample classification: '+esc(typings)+' typings</li>',
      '<li>Live HTTP requests were not executed in this build</li>');
  }
  const release=cfg.i2idl.release,commitShort=/commit \x60([0-9a-f]+)\x60/.exec(report)?.[1]?.slice(0,7)??'';
  const searchQ=lexical(value(cat,namedNode(CAT+'q-concept-search'),NS+'sparql')).replace(/\$text/g,'"record store"').trimEnd();
  const actExample=JSON.stringify({descriptor_url:IRI.catalog,action_iri:NS+'act-query-glossary-post',payload:searchQ},null,2);
  const invokeExample=JSON.stringify({descriptor_url:IRI.catalog,action_iri:NS+'act-get-scheme',payload:{}},null,2);
  const followExample=JSON.stringify({descriptor_url:cfg.foxxiManifest,action_iri:ACTION_ROOT+'foxxi/discover-lrs',payload:{}},null,2);
  const curlExample="curl -H 'Accept: text/turtle' "+IRI.catalog+"\n\ncurl -X POST "+ENDPOINT+" \\\n  -H 'Content-Type: application/sparql-query' \\\n  --data-binary @query.rq";
  const jsonld={
    '@context':{dcat:DCAT,dct:DCT,prov:PROV,'iep':IEP},'@type':'dcat:Catalog','dct:title':'I2IDL-X',
    'dct:description':'Interego/Foxxi agentic superset of the I2IDL Digital Learning Glossary.','dct:creator':'Mark Spivey (Foxxi Mediums Inc.)',
    'dct:license':{'@id':'https://creativecommons.org/licenses/by/4.0/'},'prov:wasDerivedFrom':{'@id':'https://id.i2idl.org/scheme'},
    'dcat:dataset':DISPLAY.map(([key,title])=>({
      '@id':IRI[key],'@type':'dcat:Dataset','dct:title':title,'iep:modalStatus':{'@id':IEP+bySlug.get(SLUG[key]!)!.modalStatus},
      'dcat:distribution':[['turtle','text/turtle'],['jsonld','application/ld+json'],['markdown','text/markdown']].map(([f,mt])=>({
        '@type':'dcat:Distribution','dcat:accessURL':{'@id':IRI[key]+'?format='+f},'dcat:mediaType':mt,
      })),
    })),
  };
  const toc:[string,string,number|null][]=[
    ['graphs','Graphs',DISPLAY.length],['whose',"What's whose",originRows.length],['for-i2idl','For I2IDL',Object.keys(priorities).length],
    ['agents','Use it as an agent',null],['semantic','Semantic layer',categories.length],['controls','Controls',nControls],['queries','Stored queries',queryCards.length],
    ['vocabulary','Vocabulary',nTerms],['enactments','Enactments',enactRows.length],['mappings','Mappings',mapRows.length],['releases','Releases',releaseRows.length],
    ['history','Change history',changeRows.length],['checks','Checks',nPass],
  ];
  const termIds=matches(vocabHtml.join(''),/<article class="term" id="([^"]+)"/g);
  for(const[id]of toc)if(termIds.includes(id))throw new Error('Anchor collision: '+id);
  // Hosted downloads expose public build products only; source and private pod content are not served.
  const publicFiles=recursiveFiles(DIST).filter(p=>/\.(ttl|trig|json|jsonld|md)$/.test(p));
  const manifest=publicFiles.map(p=>'/i2idlx/dist/'+p.slice(DIST.length+1).replace(/\\/g,'/')).sort(compareText);
  const pkgMb=publicFiles.reduce((n,p)=>n+statSync(p).size,0)/1e6;
  const roleOptions=[...rolesSeen].sort(byText(([r])=>r)).map(([r,n])=>'<option value="'+esc(r)+'">'+esc(r)+' ('+n+')</option>').join('');
  const vocabOptions=VOCABS.filter(([,v])=>vocabCounts.has(v)).map(([,v])=>'<option value="'+esc(v)+'">'+esc(v)+' ('+vocabCounts.get(v)+')</option>').join('');
  const methodSummary=[...methodCounts].sort((a,b)=>b[1]-a[1]).map(([m,n])=>n+' '+m).join(', ');
  const sourceDir=dirname(fileURLToPath(import.meta.url)),css=readFileSync(join(sourceDir,'reference.css'),'utf8');
  const js=readFileSync(join(sourceDir,'reference-client.js'),'utf8').replaceAll('__ENDPOINT__',ENDPOINT).replaceAll('__PACKAGE__','i2idlx-'+cfg.version+'.zip')
    .replaceAll('__JSZIP__','https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
  const appUrl=options.workbenchUrl??'/i2idlx/';
  const workbenchEntry='<div class="entry"><span class="label">Workbench for people</span><span>Interpretant: search, entries, map, compare, review, packs, insights, Ask AI and Orchestrate — a team of AI agents working the workbench in front of you — over the glossary and these graphs.</span>'+
    ext(appUrl,'Open Interpretant','btn btn-primary')+'</div>';
  const slots:(string|number)[]=[
    css,jsonScript(jsonld),jsonScript(manifest),esc(NS),nConcepts,esc(cfg.version),esc(release),esc(commitShort),esc(cfg.owner),
    wbr(IRI.catalog),ext(IRI.catalog!,'Open','btn'),nConcepts,nControls,queryCards.length,enactRows.length,mapRows.length,releaseRows.length,categories.length,sem.terms,
    nPass,nPass+nFail,manifest.length,pkgMb.toFixed(1),workbenchEntry,
    toc.map(([i,t,n])=>'<li><a href="#'+i+'">'+esc(t)+'<span class="n">'+(n??'')+'</span></a></li>').join(''),
    DISPLAY.length,esc(cfg.owner),graphRows.join(''),originRows.join(''),ext(upstream.roadmap,'its '+esc(upstream.roadmapName)+' at '+esc(commitShort)),
    upstream.priorities.map(p=>'<tr><td><div class="cell-title">'+p.n+'. '+esc(p.title)+'</div>'+ext(upstream.roadmap+'#'+p.anchor,esc(upstream.roadmapName),'small')+
      '</td><td class="small">'+(priorities[p.n]??'')+'</td></tr>').join(''),
    ext(appUrl+'#for-i2idl',"The workbench's For I2IDL view")+' walks through all of it and exports an editorial packet.',
    esc(actExample),esc(invokeExample),esc(followExample),esc(curlExample),walkChain.join(''),nAssigned,categories.length,nAssigned-nByDef,nByDef,
    ext(IRI.referents!,'i2idlx-referents'),ext(IRI.alignments!,'i2idlx-alignments'),
    semantic.COLUMNS.map(([,lbl])=>'<th>'+esc(lbl)+'</th>').join(''),semRows.join(''),
    reasonItems.map(x=>'<li class="pass"><span class="mark">PASS</span><span>'+x+'</span></li>').join(''),
    nControls,nFollowable,nTemplates,controlRows.join(''),queryCards.join(''),esc(IRI.ontology),esc(IRI.ontology),vocabHtml.join(''),
    roleOptions,enactRows.join(''),nRoleCaps,roleHtml.join(''),esc(methodSummary),nSuperseded,nAdopted,vocabOptions,mapRows.join(''),esc(release),ownRows.length,ownRows.join(''),
    ext('https://github.com/blakeplock/i2idl-linked-data','blakeplock/i2idl-linked-data'),releaseRows.join(''),ext(IRI.changes!,'i2idlx-changes'),number(nChangeFacts),
    changeRows.join(''),nPass,nFail,checksHtml,esc(cfg.version),ext('https://www.i2idl.org/glossary','i2idl.org/glossary'),esc(BASE),js,
  ];
  const template=readFileSync(join(sourceDir,'reference-template.html'),'utf8');
  const page=template.replace(/@@I2IDLX_SLOT_(\d+)@@/g,(_,i:string)=>{const v=slots[Number(i)];if(v==null)throw new Error('Missing reference slot '+i);return String(v);});
  const ids=new Set(matches(page,/\sid="([^"]+)"/g)),dangling=[...new Set(matches(page,/href="#([^"]+)"/g))].filter(h=>!ids.has(h)).sort(compareText);
  if(dangling.length)throw new Error('In-page links with no target: '+dangling.join(', '));
  if(/@@I2IDLX_SLOT_\d+@@/.test(page))throw new Error('Unresolved reference page slot');
  mkdirSync(OUTDIR,{recursive:true});writeFileSync(OUT,page);
  process.stdout.write(OUT+': '+number(Buffer.byteLength(page))+' bytes; '+nTerms+' terms, '+nControls+' controls, '+queryCards.length+' queries, '+enactRows.length+
    ' enactments, '+nRoleCaps+' role capabilities, '+mapRows.length+' mappings, '+releaseRows.length+' releases, '+nPass+' checks pass, '+nFail+
    ' fail; walkthrough chain '+walkChain.length+' steps\n');
  return{output:OUT,terms:nTerms,controls:nControls,queries:queryCards.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),root=args.shift();if(!root)throw new Error('Usage: tsx build-site.ts ROOT [--dist DIR] [--out DIR] [--app DIR] [--workbench-url URL]');
  const options:SiteOptions={};while(args.length){const key=args.shift(),v=args.shift();if(!v)throw new Error('Missing value for '+key);
    if(key==='--dist')options.distDir=v;else if(key==='--out')options.outputDir=v;else if(key==='--app')options.appDir=v;else if(key==='--workbench-url')options.workbenchUrl=v;
    else throw new Error('Unknown option '+key);}await buildSite(root,options);
}
