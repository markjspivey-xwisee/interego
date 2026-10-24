/**
 * Native I2IDL-X graph generation. Data comes from the pinned canonical
 * glossary, audited evidence snapshots, and declarative templates.
 * Foxxi's shared Graph serializers are the sole output serializers.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_ROOT, loadConfig, namespaceIris, type BuildConfig } from './config.js';
import { Store, RDF, RDFS, OWL, SKOS, DCT, PROV, XSD, GS, SH, value, subjects,
  parseTurtle, parseJsonLd, lit, longLit, safeIri, serializeTurtle, serializeJsonLd, serializeNTriples } from './rdf.js';
import { Layer, tbox, foxxi_ns } from './layer.js';
import * as history from './history.js';

export const CONCEPT_BASE = 'https://id.i2idl.org/concepts/';
export const SCHEME = 'https://id.i2idl.org/scheme';
export const ACTION_ROOT = 'https://relay.interego.xwisee.com/ns/iep/action/';
export const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
export const HYDRA = 'http://www.w3.org/ns/hydra/core#';
export const DRAFTER = '"Claude (Anthropic), drafting for Mark Spivey / Foxxi Mediums Inc."';
export type EnactmentRow = [string, string, string, number, string];
export type MappingRow = [string, string, string, number, string, string];
export interface Crosswalk {
  ENACTMENTS: EnactmentRow[]; MAPPINGS: MappingRow[];
  ROLE_CAPABILITIES: [string,string,number,string][];
  ROLE_TAGS: Record<string,[string,number,string]>;
  SUPERSEDED: Record<string,[string,string]>;
  EXEMPLARS: [string,string][]; SPECS: [string,string][];
  VERIFIED_EXTERNAL: string[]; ST: string; AI: string; EC: string;
}
export const cw: Crosswalk = JSON.parse(readFileSync(new URL('./crosswalk-data.json', import.meta.url), 'utf8'));
const headers: Record<string,string> = JSON.parse(readFileSync(new URL('./headers-data.json', import.meta.url), 'utf8'));
export const local = (text: string): string => text.replace(/[^A-Za-z0-9-]+/g, '-');
export function mappingIds(rows: MappingRow[] = cw.MAPPINGS): string[] {
  const seen: Record<string,number> = {};
  return rows.map(row => 'm-' + local(row[0]) + '-' + (seen[row[0]] = (seen[row[0]] || 0) + 1));
}
export function activeMappings(): MappingRow[] {
  return cw.MAPPINGS.filter((_, i) => !(mappingIds()[i]! in cw.SUPERSEDED));
}
export const qn = (iri: string): string => {
  for (const [prefix, base] of [['i2idl:', CONCEPT_BASE], ['fxa:', ACTION_ROOT + 'foxxi/'], ['rla:', ACTION_ROOT + 'relay/']]) {
    if (iri.startsWith(base!) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(iri.slice(base!.length))) return prefix + iri.slice(base!.length);
  }
  return safeIri(iri);
};
export function renderTokens(text: string, tokens: Record<string,string>): string {
  for (const [key, val] of Object.entries(tokens)) text = text.replaceAll('{{' + key + '}}', val);
  const left = text.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (left) throw new Error('Unrendered tokens: ' + left.join(', '));
  return text;
}
function git(clone: string, args: string[]): string {
  return execFileSync('git', args, {cwd: clone, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024});
}
export interface BuildResult {
  root: string; outputDir: string; cfg: BuildConfig; IRI: Record<string,string>; NS: string;
  outputs: Record<string,string>; graphs: Record<string,Store>; glossary: Store; rawGlossary: string;
  concepts: Set<string>; conceptIds: Record<string,string>; layer: Layer;
  history: ReturnType<typeof history.releases>; stored: Record<string,[Record<string,string>,string]>;
  origins: Record<string,unknown>; externalTerms: Set<string>; knownActions: Set<string>;
  render: (text: string) => string; nowFor: (key: string) => string;
  metadata: {release: string; commit: string; commitDate: string; glossaryBytes: number; roleCapabilities: number;
    adopted: string[]; differs: [string,string,string[]][]; mappingClassTargets: Set<string>; limitsDoc: string|null; limitsText: string};
}
export async function generate(root = DEFAULT_ROOT, options: {outputDir?: string; write?: boolean} = {}): Promise<BuildResult> {
  root = resolve(root);
  const cfg = loadConfig(root), {IRI, NS} = namespaceIris(cfg);
  const src = join(root, 'src'), evidence = join(root, 'evidence');
  const outputDir = resolve(options.outputDir || process.env.I2IDLX_DIST || join(root, 'dist-ts'));
  const clone = cfg.i2idl.localClone, gpath = cfg.i2idl.graphPath;
  const commit = git(clone, ['log', '-1', '--format=%H', '--', gpath]).trim();
  const commitDate = git(clone, ['log', '-1', '--format=%cI', '--', gpath]).trim();
  const rawGlossary = git(clone, ['show', commit + ':' + gpath]);
  const glossaryBytes = Buffer.byteLength(rawGlossary, 'utf8');
  const glossary = await parseJsonLd(JSON.parse(rawGlossary));
  const release = value(glossary, SCHEME, GS + 'publicationVersion');
  if (release !== cfg.i2idl.release) throw new Error('Clone release ' + release + ' differs from pin ' + cfg.i2idl.release);
  const concepts = new Set(subjects(glossary, RDF + 'type', SKOS + 'Concept'));
  const conceptIds = Object.fromEntries([...concepts].map(c => [value(glossary,c,DCT+'identifier')!,c]));
  if (Object.keys(conceptIds).length !== concepts.size || 'undefined' in conceptIds) throw new Error('Canonical concept identifiers must exist and be unique');
  const relatedPairs = glossary.getQuads(null, SKOS+'related', null,null).length / 2;
  const broaderPairs = glossary.getQuads(null, SKOS+'broader', null,null).length;
  const today = new Date().toISOString().slice(0,10);
  const now = process.env.I2IDLX_NOW || new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const nowFor = (key: string): string => process.env['I2IDLX_NOW_' + key.toUpperCase()] || now;
  const tokens: Record<string,string> = {
    NS, ONTO: IRI.ontology!, SHAPES: IRI.shapes!, RULES: IRI.rules!, CATALOG: IRI.catalog!,
    ENACT: IRI.enactments!, MAPPINGS: IRI.mappings!, DECOR: IRI.decorations!, RELEASES: IRI.releases!,
    CHANGES: IRI.changes!, ALIGNMENTS: IRI.alignments!, REFERENTS: IRI.referents!,
    VERSION: cfg.version, BUILT: process.env.I2IDLX_BUILT_DATE || today, MODIFIED: process.env.I2IDLX_MODIFIED || today,
    COMMIT: commit, I2IDL_RELEASE: release!, GRAPH_BYTES: String(glossaryBytes),
    N_CONCEPTS: String(concepts.size), N_RELATED: String(relatedPairs), N_BROADER: String(broaderPairs),
  };
  const render = (text: string): string => renderTokens(text,tokens);
  const template = (name: string): string => readFileSync(join(src,name),'utf8');
  const foxxi: {action?:string;title:string}[] = JSON.parse(readFileSync(join(evidence,'foxxi-affordances.json'),'utf8'));
  const foxxiByKey = Object.fromEntries(foxxi.filter(row=>row.action).map(row=>[row.action!.split('/ns/iep/action/').pop()!,row]));
  const ops = JSON.parse(readFileSync(join(evidence,'relay-operations.json'),'utf8'));
  const knownActions = new Set<string>([...Object.keys(foxxiByKey), ...ops['hydra:member'].map((m: {action:string})=>m.action.split('/ns/iep/action/').pop()!)]);
  const actionIri = (key:string):string => { if(!knownActions.has(key)) throw new Error('Unknown action '+key);return ACTION_ROOT+key; };
  const conceptIri = (cid:string):string => { if(!(cid in conceptIds)) throw new Error('Unknown concept '+cid+' in '+release);return conceptIds[cid]!; };
  const externalTerms = new Set(cw.VERIFIED_EXTERNAL);
  const unesco = JSON.parse(readFileSync(join(evidence,'unesco-thesaurus.json'),'utf8'));
  for (const iri of Object.keys(unesco.terms)) externalTerms.add(iri);
  for (const file of ['xapi-ontology.ttl','xapi-profile-ontology.ttl','iep.ttl']) {
    const g = parseTurtle(readFileSync(join(evidence,file),'utf8'));
    for (const q of g.getQuads(null,null,null,null)) if(q.subject.termType==='NamedNode') externalTerms.add(q.subject.value);
  }
  const foxxiNs = foxxi_ns(root), foxxiGraphs: Record<string,Store> = {};
  for (const [module, path] of Object.entries(foxxiNs.files)) {
    const graph = parseTurtle(readFileSync(path as string,'utf8')); foxxiGraphs[module]=graph;
    for (const q of graph.getQuads(null,null,null,null)) if(q.subject.termType==='NamedNode'&&q.subject.value.startsWith(foxxiNs.ns[module]!)) externalTerms.add(q.subject.value);
  }
  const deprecated = new Set<string>();
  for (const g of Object.values(foxxiGraphs)) for(const q of g.getQuads(null,OWL+'deprecated',null,null)) {
    if(q.object.termType === 'Literal' && q.object.datatype.value === XSD+'boolean' && ['true','1'].includes(q.object.value)) deprecated.add(q.subject.value);
  }
  const changeKinds = 'i2x:ChangeKinds skos:hasTopConcept ' + history.KIND_CODES.map(c=>'i2x:change-'+c).join(' , ') + ' .\n' +
    history.KINDS.map(([code,label,definition])=>`i2x:change-${code} a skos:Concept ; skos:inScheme i2x:ChangeKinds ; skos:topConceptOf i2x:ChangeKinds ;\n    skos:prefLabel ${lit(label)}@en ; skos:definition ${lit(definition)}@en .`).join('\n');
  const collections = new Set(subjects(glossary,RDF+'type',SKOS+'Collection'));
  let originsText = template('origins.json');
  for (const facet of ['type','field']) originsText=originsText.replaceAll('{n'+facet[0]!.toUpperCase()+facet.slice(1)+'s}',String([...collections].filter(c=>c.includes('/collections/'+facet+'/')).length));
  originsText=originsText.replaceAll('{nCurated}',String([...collections].filter(c=>c.includes('/collections/curated/')).length));
  originsText=originsText.replaceAll('{nSources}',String(new Set(glossary.getQuads(null,null,null,null).map(q=>q.subject.value).filter(c=>c.startsWith('https://id.i2idl.org/sources/'))).size));
  const origins = JSON.parse(originsText);
  const heldTokens: Record<string,string> = Object.fromEntries(Object.entries(IRI).map(([k,v])=>['{'+k+'}',v]));
  heldTokens['{foxxiManifest}']=cfg.foxxiManifest;
  const heldIn = (items:string[]):string[] => items.map(h=>{
    const iri=heldTokens[h]||h;if(!/^https:\/\/[^\s<>"{}]+$/.test(iri))throw Error('Unresolved origin location '+h);return iri;
  });
  type Origin = {id:string;broader?:string;label:string;definition?:string;what:string;scope?:string;trust:string;heldIn?:string[]};
  type Group = {label:string;definition:string;heldIn?:string[]};
  const originGroups: Record<string,Group> = Object.fromEntries(origins.groups.map((g:Origin)=>[g.id,g]));
  const tops: string[]=[];
  for(const o of origins.origins as Origin[]) {const top=o.broader||o.id;if(top!==o.id&&!(top in originGroups))throw Error('Unknown origin group '+top);if(!tops.includes(top))tops.push(top);}
  const originBlocks=['i2x:Origins skos:hasTopConcept '+tops.map(t=>'i2x:origin-'+t).join(' , ')+' .'];
  for(const [id,g]of Object.entries(originGroups)) {
    const members=(origins.origins as Origin[]).filter(o=>o.broader===id).map(o=>o.id);
    originBlocks.push(`i2x:origin-${id} a skos:Concept ; skos:inScheme i2x:Origins ; skos:topConceptOf i2x:Origins ;\n    skos:notation ${lit(id)} ; skos:prefLabel ${lit(g.label)}@en ;\n    skos:definition ${lit(g.definition)}@en ;\n    skos:narrower ${members.map(m=>'i2x:origin-'+m).join(' , ')}${heldIn(g.heldIn||[]).map(h=>';\n    i2x:heldIn '+safeIri(h)).join('')} .`);
  }
  for(const o of origins.origins as Origin[]) {
    const place=o.broader?'skos:broader i2x:origin-'+o.broader:'skos:topConceptOf i2x:Origins';
    const held=heldIn(o.heldIn||[]);
    originBlocks.push(`i2x:origin-${o.id} a skos:Concept ; skos:inScheme i2x:Origins ; ${place} ;\n    skos:notation ${lit(o.id)} ; skos:prefLabel ${lit(o.label)}@en ;\n    skos:definition ${lit(o.definition||o.what)}@en ;\n    skos:scopeNote ${lit(o.scope||o.trust)}@en${held.length?' ;\n    i2x:heldIn '+held.map(safeIri).join(' , '):''} .`);
  }
  const layerConcepts=Object.fromEntries([...concepts].map(c=>[value(glossary,c,DCT+'identifier')!,{iri:c,type:(value(glossary,c,GS+'typeCollection')||'None').split('/').pop()!}]));
  const layer=new Layer(root,NS,IRI,layerConcepts,activeMappings(),release!,commit);
  const ontoTtl=render(template('i2idlx.ttl.tmpl').replace('{{CHANGE_KINDS}}',changeKinds)
    .replace('{{REFERENT_CATEGORIES}}',layer.ontology_section()).replace('{{ORIGINS}}',originBlocks.join('\n'))
    .replace('{{ORIGINS_LABEL}}',origins.scheme.label.replaceAll('"','\\"')).replace('{{ORIGINS_DEFINITION}}',origins.scheme.definition.replaceAll('"','\\"')));
  const onto=parseTurtle(ontoTtl);
  const shapesTtl=render(template('i2idlx-shapes.ttl.tmpl').replace('{{CHANGE_KIND_LIST}}',history.KIND_CODES.map(c=>'i2x:change-'+c).join(' '))
    .replace('{{REFERENT_CATEGORY_LIST}}',layer.sem.CATEGORIES.map(c=>'i2x:category-'+c.id).join(' ')));
  const kindRules=onto.getQuads(null,NS+'kindForTypeCollection',null,null).sort((a,b)=>compare(a.subject.value,b.subject.value)||compare(a.object.value,b.object.value)).map(q=>
    `    sh:rule [ a sh:TripleRule ; sh:order 3 ;\n        rdfs:comment ${lit('Type collection '+q.object.value.split('/').pop()+' ⇒ '+compactKind(q.subject.value,NS))}@en ;\n        sh:condition [ a sh:NodeShape ; sh:property [ sh:path gs:typeCollection ; sh:hasValue ${safeIri(q.object.value)} ] ] ;\n        sh:subject sh:this ; sh:predicate rdf:type ; sh:object ${safeIri(q.subject.value)} ]`);
  const mappingRules=['exactMatch','closeMatch','relatedMatch','broadMatch','narrowMatch'].map(pred=>
    `    sh:rule [ a sh:TripleRule ; sh:order 4 ;\n        rdfs:comment "Ratified ${pred} proposal ⇒ the mapping triple."@en ;\n        sh:condition [ a sh:NodeShape ; sh:property [ sh:path i2x:reviewStatus ; sh:hasValue i2x:status-ratified ] ] ,\n                     [ a sh:NodeShape ; sh:property [ sh:path i2x:proposedPredicate ; sh:hasValue skos:${pred} ] ] ;\n        sh:subject [ sh:path i2x:proposedSubject ] ; sh:predicate skos:${pred} ; sh:object [ sh:path i2x:proposedObject ] ]`);
  const enactRules=onto.getQuads(null,NS+'asProperty',null,null).sort((a,b)=>compare(a.subject.value,b.subject.value)||compare(a.object.value,b.object.value)).map(q=>
    `    sh:rule [ a sh:TripleRule ; sh:order 4 ;\n        rdfs:comment ${lit('Enactment with role '+q.subject.value.split('#').pop()+', not rejected ⇒ the plain link.')}@en ;\n        sh:condition [ a sh:NodeShape ; sh:property [ sh:path i2x:enactmentRole ; sh:hasValue ${safeIri(q.subject.value)} ] ] ,\n                     [ a sh:NodeShape ; sh:not [ a sh:NodeShape ; sh:property [ sh:path i2x:reviewStatus ; sh:hasValue i2x:status-rejected ] ] ] ;\n        sh:subject [ sh:path i2x:enactedConcept ] ; sh:predicate ${safeIri(q.object.value)} ; sh:object [ sh:path i2x:viaAction ] ]`);
  const refRules=[`    sh:rule [ a sh:TripleRule ; sh:order 5 ;\n        rdfs:comment "Classified by an I2IDL concept that has a referent category ⇒ i2x:Referent."@en ;\n        sh:condition [ a sh:NodeShape ; sh:property [ sh:path i2x:isClassifiedBy ; sh:qualifiedMinCount 1 ;\n            sh:qualifiedValueShape [ a sh:NodeShape ; sh:property [ sh:path i2x:referentCategory ; sh:minCount 1 ] ] ] ] ;\n        sh:subject sh:this ; sh:predicate rdf:type ; sh:object i2x:Referent ]`];
  const refConditions: string[]=[];
  for(const cat of layer.sem.CATEGORIES) {
    const cond='i2xr:classified-as-'+cat.id;
    refConditions.push(`${cond} a sh:NodeShape ;\n    rdfs:label ${lit('Classified by a concept in the category '+cat.label)}@en ;\n    sh:property [ sh:path i2x:isClassifiedBy ; sh:qualifiedMinCount 1 ;\n        sh:qualifiedValueShape [ a sh:NodeShape ; sh:property [ sh:path i2x:referentCategory ; sh:hasValue i2x:category-${cat.id} ] ] ] .`);
    for(const key of [cat.id,...layer.ancestors(cat.id)]) refRules.push(`    sh:rule [ a sh:TripleRule ; sh:order 5 ; sh:condition ${cond} ;\n        rdfs:comment ${lit('Category '+cat.label+' ⇒ i2x:'+layer.cat[key]!.cls+'.')}@en ;\n        sh:subject sh:this ; sh:predicate rdf:type ; sh:object i2x:${layer.cat[key]!.cls} ]`);
  }
  const rulesTtl=render(template('i2idlx-rules.ttl.tmpl').replace('{{REFERENT_RULES}}',refRules.join(' ;\n'))
    .replace('{{REFERENT_CONDITIONS}}',refConditions.join('\n')).replace('{{KIND_RULES}}',kindRules.join(' ;\n'))
    .replace('{{MAPPING_RULES}}',mappingRules.join(' ;\n')).replace('{{ENACTMENT_RULES}}',enactRules.join(' ;\n')));


  const stored: Record<string,[Record<string,string>,string]>={}, storedBlocks: string[]=[];
  const storedDir=join(src,'queries','stored');
  for(const file of readdirSync(storedDir).filter(f=>f.endsWith('.rq')).sort()) {
    const text=readFileSync(join(storedDir,file),'utf8'), meta: Record<string,string>={};
    for(const match of text.matchAll(/^# (\w+): ?(.*)$/gm)) meta[match[1]!]=match[2]!;
    const body=render(text.split(/\r?\n/).filter(l=>!l.startsWith('# ')).join('\n').trim()+'\n');
    const slug=file.slice(0,-3).replace(/^\d+-/,'');stored[slug]=[meta,body];
    const params=(meta.params||'').split(/\s+/).filter(Boolean), over=(meta.runsOver||'').split(/\s+/).filter(Boolean);
    const where=over.length?'    i2x:runsOver '+over.map(p=>'cat:'+p).join(' , ')+' ;\n':'    i2x:runsAgainst cat:port-sparql-get , cat:port-sparql-post ;\n';
    storedBlocks.push(`cat:q-${slug} a i2x:StoredQuery ;\n    rdfs:label ${lit(meta.label!)}@en ;\n    dct:description ${lit(meta.description!)}@en ;\n    i2x:queryForm ${lit(meta.form!)} ;\n${params.map(p=>'    i2x:parameter '+lit(p)+' ;\n').join('')}${where}    i2x:sparql ${longLit(body)} .\n`);
  }
  for(const [cid,target]of cw.EXEMPLARS) storedBlocks.push(`${safeIri(conceptIri(cid))} i2x:exemplifiedBy ${safeIri(target.replaceAll('{CATALOG}',IRI.catalog!).replaceAll('{ENACT}',IRI.enactments!))} .`);
  for(const [cid,target]of cw.SPECS) storedBlocks.push(`${safeIri(conceptIri(cid))} i2x:specification ${safeIri(target)} .`);
  let limitsDoc: string|null=null, limitsText='';
  for(const path of ['docs/SPARQL.md','README.md']) {
    let text='';try{text=git(clone,['show',commit+':'+path]);}catch{continue;}
    if(text.includes('## SPARQL service limits')) {limitsDoc=path;limitsText=text.split('## SPARQL service limits')[1]!.split('\n## ')[0]!;break;}
  }
  const catalogTtl=render((template('i2idlx-catalog.ttl.tmpl')+'\n'+template('i2idlx-rest-api.ttl.tmpl')).replace('{{STORED_QUERIES}}',storedBlocks.join('\n')).replace('{{LIMITS_DOC}}',limitsDoc||'README.md'));
  const prefixes: Record<string,string>={i2x:NS,en:IRI.enactments+'#',mp:IRI.mappings+'#',i2idl:CONCEPT_BASE,
    fxa:ACTION_ROOT+'foxxi/',rla:ACTION_ROOT+'relay/','iep': IEP,skos:SKOS,dct:DCT,prov:PROV,owl:OWL,rdfs:RDFS,xsd:XSD};
  const headerPrefixes=Object.entries(prefixes).map(([p,n])=>'@prefix '+p+': '+safeIri(n)+' .').join('\n')+'\n';
  const header=(key:string,extra:Record<string,string>={}):string=>renderTokens(headers[key]!,{
    ...tokens,...Object.fromEntries(Object.entries(IRI).map(([k,v])=>[k.toUpperCase(),v])),
    DRAFTER,NOW:nowFor(key),FOXXI_MANIFEST:cfg.foxxiManifest,FOXXI_VERSION:foxxiNs.version,
    UNESCO_SCHEME:unesco.scheme.iri,FOXXI_IRIS:foxxiNs.modules.map(m=>safeIri(foxxiNs.iris[m]!)).join(' , '),...extra,
  });
  const roleProps=Object.fromEntries(onto.getQuads(null,NS+'asProperty',null,null).map(q=>[q.subject.value.split('role-').pop()!,q.object.value]));
  const roleAlias=new Set(['operationalizes','realizes','implements','measures','records','credentials','enforces','explains']);
  const enactLines=[headerPrefixes,header('enactments')], seenEn=new Set<string>();
  for(const [cid,role,key,confidence,why]of cw.ENACTMENTS) {
    const c=conceptIri(cid),a=actionIri(key);
    if(!roleAlias.has(role)||!(role in roleProps))throw Error('Unknown enactment role '+role);
    const node='en:e-'+local(cid)+'--'+local(key);
    if(seenEn.has(node))throw Error('Duplicate enactment '+node);seenEn.add(node);
    const prop=roleProps[role]!.split('#').pop()!;
    enactLines.push(`${node} a i2x:Enactment ;\n    i2x:enactedConcept ${qn(c)} ; i2x:viaAction ${qn(a)} ; i2x:enactmentRole i2x:role-${role} ;\n    i2x:rationale ${lit(why)}@en ;\n    i2x:confidence "${confidence.toFixed(2)}"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-ai-drafted .\n${qn(c)} i2x:${prop} ${qn(a)} .\n`);
  }
  let roleCapabilities=0;
  for(const [cid,key]of cw.ROLE_CAPABILITIES) {enactLines.push(qn(conceptIri(cid))+' i2x:roleCapability '+qn(actionIri(key))+' .');roleCapabilities++;}
  for(const [tag,[cid]]of Object.entries(cw.ROLE_TAGS)) {
    const tagged=Object.keys(foxxiByKey).filter(k=>foxxiByKey[k]!.title.startsWith(tag)).sort();
    for(const key of tagged) {enactLines.push(qn(conceptIri(cid))+' i2x:roleCapability '+qn(actionIri(key))+' .');roleCapabilities++;}
  }
  const enactTtl=enactLines.join('\n')+'\n';
  const mapIds=mappingIds().map(i=>'mp:'+i), mapLines=[headerPrefixes,header('mappings')];
  const rowById=Object.fromEntries(mapIds.map((id,i)=>[id,cw.MAPPINGS[i]!]));
  const replacedBy=Object.fromEntries(Object.entries(cw.SUPERSEDED).map(([old,[newId,date]])=>['mp:'+old,['mp:'+newId,date] as [string,string]]));
  const replaces=Object.fromEntries(Object.entries(replacedBy).map(([old,[newId]])=>[newId,old]));
  for(const [old,[newId]]of Object.entries(replacedBy)) {
    if(!(old in rowById)||!(newId in rowById)||rowById[old]![0]!==rowById[newId]![0]||newId in replacedBy)throw Error('Invalid supersession '+old+' → '+newId);
  }
  const openKeys=activeMappings().map(r=>JSON.stringify(r.slice(0,3)));
  if(new Set(openKeys).size!==openKeys.length)throw Error('Duplicate open mapping proposal');
  const upstreamMaps=new Map<string,Set<string>>();
  const matchProps=['exactMatch','closeMatch','relatedMatch','broadMatch','narrowMatch'];
  for(const pred of matchProps) for(const q of glossary.getQuads(null,SKOS+pred,null,null)) {
    const key=JSON.stringify([q.subject.value,q.object.value]);let set=upstreamMaps.get(key);if(!set){set=new Set();upstreamMaps.set(key,set);}set.add(pred);
  }
  const adopted: string[]=[],differs: [string,string,string[]][]=[];
  for(let i=0;i<cw.MAPPINGS.length;i++) {
    const [cid,pred,target,confidence,method,why]=cw.MAPPINGS[i]!,node=mapIds[i]!;
    if(!externalTerms.has(target))throw Error('External target does not resolve: '+target);
    if(!matchProps.includes(pred)||![cw.ST,cw.AI,cw.EC].includes(method))throw Error('Invalid mapping '+node);
    if(deprecated.has(target))throw Error('Deprecated external target '+target);
    let cited='';
    if(method===cw.EC) {
      const cites=unesco.terms[target]?.citedBy.filter((c:{concept:string})=>c.concept===cid);
      if(!cites?.length)throw Error('No canonical evidence citation for '+node);
      cited=`    i2x:citedIn ${safeIri(cites[0].definition)} ; rdfs:seeAlso ${safeIri(unesco.terms[target].page)} ;\n`;
    }
    const asserted=[...(upstreamMaps.get(JSON.stringify([conceptIri(cid),target]))||[])].sort();
    const status=node in replacedBy?'superseded':asserted.includes(pred)?'adopted':'proposed';
    if(status==='adopted')adopted.push(node);else if(asserted.length&&status==='proposed')differs.push([node,pred,asserted]);
    const upstream=asserted.length?'    i2x:i2idlPredicate '+asserted.map(a=>'skos:'+a).join(' , ')+' ;\n':'';
    let lineage='';
    if(node in replacedBy)lineage+=`    dct:isReplacedBy ${replacedBy[node]![0]} ; prov:invalidatedAtTime "${replacedBy[node]![1]}"^^xsd:dateTime ;\n`;
    if(node in replaces)lineage+='    dct:replaces '+replaces[node]+' ;\n';
    mapLines.push(`${node} a i2x:MappingProposal ;\n    i2x:proposedSubject ${qn(conceptIri(cid))} ; i2x:proposedPredicate skos:${pred} ; i2x:proposedObject ${safeIri(target)} ;\n    i2x:rationale ${lit(why)}@en ;\n${cited}${lineage}${upstream}    i2x:confidence "${confidence.toFixed(2)}"^^xsd:decimal ; i2x:reviewStatus i2x:status-${status} ;\n    i2x:mappingMethod i2x:method-${method} .\n`);
  }
  const mappingsTtl=mapLines.join('\n')+'\n';


  const byVersion=new Map<string,{commit:string;date:string;commits:number;snap:FeedSnapshot}>();
  for(const line of git(clone,['log','--reverse','--format=%H %cI','--',gpath]).trim().split('\n').filter(Boolean)) {
    const space=line.indexOf(' '),hash=line.slice(0,space),when=line.slice(space+1);
    const snap=feedSnapshot(JSON.parse(git(clone,['show',hash+':'+gpath])));
    const old=byVersion.get(snap.version);byVersion.set(snap.version,{commit:hash,date:when,commits:(old?.commits||0)+1,snap});
  }
  const REL=IRI.releases+'#',relLines=[headerPrefixes,header('releases')];
  let prev: [string,FeedSnapshot]|undefined;
  for(const [version,entry]of byVersion) {
    const s=entry.snap,node=safeIri(REL+version);
    const parts=[node+' a i2x:GlossaryRelease ;',
      '    i2x:releaseVersion '+lit(version)+' ; i2x:releaseCommit '+lit(entry.commit)+' ;',
      '    prov:generatedAtTime '+lit(entry.date)+'^^xsd:dateTime ;',
      `    i2x:conceptCount ${Object.keys(s.defs).length} ; i2x:relatedPairCount ${s.related} ; i2x:broaderPairCount ${s.broader} ;`,
      '    rdfs:comment '+lit(entry.commits+' upstream commit(s) carried this version label; '+s.fieldMembers+' field memberships.')+'@en'];
    if(prev) {
      const [pv,ps]=prev;
      const added=Object.keys(s.defs).filter(c=>!(c in ps.defs)).sort(),removed=Object.keys(ps.defs).filter(c=>!(c in s.defs)).sort();
      const revised=Object.keys(s.defs).filter(c=>c in ps.defs&&!jsonEqual(s.defs[c],ps.defs[c])).sort();
      parts[parts.length-1]+=' ;';parts.push('    prov:wasRevisionOf '+safeIri(REL+pv)+' ;');
      parts.push('    rdfs:seeAlso '+safeIri('https://github.com/blakeplock/i2idl-linked-data/compare/'+byVersion.get(pv)!.commit.slice(0,12)+'...'+entry.commit.slice(0,12)));
      for(const [pred,items]of [['addedConcept',added],['removedConcept',removed],['revisedDefinitionOf',revised]] as const)if(items.length) {
        parts[parts.length-1]+=' ;';parts.push('    i2x:'+pred+' '+items.map(qn).join(' , '));
      }
    }
    relLines.push(parts.join('\n')+' .\n');prev=[version,s];
  }
  const releasesTtl=relLines.join('\n');
  const hrels=history.releases(clone,gpath);
  if(JSON.stringify(hrels.map(r=>r.version))!==JSON.stringify([...byVersion.keys()]))throw Error('Release feed and history disagree');
  if(!hrels.length)throw Error('Canonical glossary has no release history');
  const CH=IRI.changes+'#';
  const groups=new Map<string,{release:string;kind:string;events:history.HistoryEvent[]}>();
  const scalar=new Set(['label-changed','definition-revised','explanation-revised','type-changed','field-changed','status-changed']);
  for(const r of hrels.slice(1))for(const event of r.events) {
    const k=event.kind;
    let key: unknown[];
    if(scalar.has(k)||k.startsWith('alt-label'))key=[k,event.concept];
    else if(k.startsWith('relationship-'))key=[k,event.property];
    else if(k.startsWith('membership-')||k.startsWith('collection-'))key=[k,event.collection];
    else if(k.startsWith('source-')||['evidence-added','evidence-removed'].includes(k))key=[k,event.source];
    else if(['evidence-classified','evidence-reclassified'].includes(k))key=[k,event.source,event.prior||'',event.new];
    else if('target'in event)key=[k,event.concept,event.target];
    else key=[k];
    const groupKey=JSON.stringify([r.version,...key]);let group=groups.get(groupKey);
    if(!group){group={release:r.version,kind:k,events:[]};groups.set(groupKey,group);}group.events.push(event);
  }
  const base=hrels[0]!.version;
  const changeComment=lit("Implements, as a derived projection, the change dataset I2IDL's roadmap proposes (priority 4). Change kinds are i2x:ChangeKinds. Set-valued changes name the concepts, collection or source they touched; the exact before and after values live in the two release snapshots (each release records its commit). The baseline "+base+" is the first commit of "+gpath+"; earlier states are not in the public record.");
  const changeLines=[headerPrefixes+'@prefix ch: '+safeIri(CH)+' .\n',header('changes',{BASELINE:base,REL,CHANGE_COMMENT:changeComment})];
  const vslug=(v:string):string=>local(v.replaceAll('.','-'));
  const tail=(iri:string):string=>iri.includes('/collections/')?iri.split('/collections/').pop()!.replaceAll('/','-'):iri.split('/').pop()!;
  for(const r of hrels.slice(1)) {
    const mine=[...groups.values()].filter(g=>g.release===r.version),n=r.events.length;
    const note=n?'':' ;\n    rdfs:comment '+lit('No change to the published graph; the version label moved with other repository changes.')+'@en';
    changeLines.push(`ch:${vslug(r.version)} a i2x:ReleaseChange ;\n    rdfs:label ${lit(r.previous+' → '+r.version)}@en ;\n    prov:used ${safeIri(REL+r.previous)} ; prov:generated ${safeIri(REL+r.version)} ;\n    prov:endedAtTime "${r.date}"^^xsd:dateTime ;\n    i2x:changeCount ${n}${note} .\n`);
    mine.sort((a,b)=>history.KIND_CODES.indexOf(a.kind)-history.KIND_CODES.indexOf(b.kind)||compare(history.pyEventRepr(a.events[0]!),history.pyEventRepr(b.events[0]!)));
    for(const group of mine) {
      const e0=group.events[0]!,kind=group.kind,parts=[kind],lines=[
        '    i2x:partOfChange ch:'+vslug(r.version)+' ; i2x:changeKind i2x:change-'+kind,
        '    i2x:changeCount '+group.events.length];
      const touched=[...new Set(group.events.flatMap(history.touched))].sort();
      if('property'in e0){parts.push(e0.property!.split(':')[1]!);lines.push('    i2x:viaProperty '+e0.property);}
      if('collection'in e0){parts.push(tail(e0.collection!));lines.push('    i2x:changedCollection '+safeIri(e0.collection!));}
      if(e0.source){parts.push(tail(String(e0.source)));lines.push('    i2x:changedSource '+safeIri(String(e0.source)));}
      if('target'in e0) {
        const target=String(e0.target);
        parts.push(tail(e0.concept!),target.replace(/[\/#]+$/,'').replaceAll('#','/').split('/').pop()!);
        lines.push('    i2x:changedTarget '+safeIri(target));
        if(kind.startsWith('external-mapping')) {
          for(const which of ['prior','new'] as const)if(e0[which])lines.push('    i2x:'+(which==='prior'?'priorValue':'newValue')+' '+String(e0[which]).split(/\s+/).join(' , '));
          if(kind==='external-mapping-revised'&&!e0.new)lines.push('    rdfs:comment '+lit('Withdrawn.')+'@en');
        } else {
          lines.push('    i2x:'+(kind==='association-removed'?'priorValue':'newValue')+' '+lit(String(e0.new||e0.prior)));
          if(e0.status)lines.push('    rdfs:comment '+lit('Review status at I2IDL: '+e0.status+'.')+'@en');
          else if(e0.fields)lines.push('    rdfs:comment '+lit('Changed '+Object.keys(e0.fields).join(', ')+'.')+'@en');
        }
      } else if(['evidence-classified','evidence-reclassified'].includes(kind)) {
        parts.push(String(e0.prior||''),String(e0.new));
        if(e0.prior)lines.push('    i2x:priorValue '+lit(String(e0.prior)));
        lines.push('    i2x:newValue '+lit(String(e0.new)));
      } else if(scalar.has(kind)) {
        parts.push(tail(e0.concept!));
        for(const which of ['prior','new'] as const) {
          const val=e0[which];
          if(val!==undefined&&val!==null)lines.push('    i2x:'+(which==='prior'?'priorValue':'newValue')+' '+(String(val).startsWith('https://')?safeIri(String(val)):lit(String(val))));
        }
      } else if(kind.startsWith('alt-label')) {
        parts.push(tail(e0.concept!));
        lines.push('    i2x:'+(kind.endsWith('added')?'newValue':'priorValue')+' '+group.events.map(e=>lit(String(e.new||e.prior))).join(' , '));
      } else if(e0.fields) {
        const fields=e0.fields;lines.push('    rdfs:comment '+lit('Changed '+Object.keys(fields).join(', ')+'.')+'@en');
        if(Object.keys(fields).length===1) {
          const [before,after]=Object.values(fields)[0]!;
          if(typeof before==='string'&&typeof after==='string'&&before.length+after.length<400)lines.push('    i2x:priorValue '+lit(before),'    i2x:newValue '+lit(after));
        }
      }
      if(touched.length)lines.push('    i2x:changedConcept '+touched.map(qn).join(' ,\n        '));
      const node='ch:'+vslug(r.version)+'--'+parts.filter(Boolean).map(local).join('--');
      changeLines.push(node+' a i2x:ChangeEvent ;\n'+lines.join(' ;\n')+' .\n');
    }
  }
  const changesTtl=changeLines.join('\n');
  const upperTbox=tbox(root),upperClasses=new Set<string>([
    ...subjects(upperTbox,RDF+'type',OWL+'Class'),...subjects(upperTbox,RDF+'type',RDFS+'Class')]);
  const mappingClassTargets=new Set(activeMappings().map(r=>r[2]).filter(target=>upperClasses.has(target)));
  const alignmentsTtl=layer.alignments_ttl(nowFor('alignments'),mappingClassTargets,IRI.mappings!);
  const referentsTtl=layer.referents_ttl(nowFor('referents'));
  const sources: Record<string,string>={ontology:ontoTtl,shapes:shapesTtl,rules:rulesTtl,catalog:catalogTtl,
    enactments:enactTtl,mappings:mappingsTtl,releases:releasesTtl,changes:changesTtl,alignments:alignmentsTtl,referents:referentsTtl};
  const graphs: Record<string,Store>={},outputs: Record<string,string>={};
  const allPrefixes={...prefixes,...layer.prefixes,rdf:RDF,sh:SH,gs:GS,cat:IRI.catalog+'#',i2xr:IRI.rules+'#',ch:CH};
  for(const [key,text]of Object.entries(sources)) {
    const graph=parseTurtle(text);graphs[key]=graph;outputs[key]=await serializeTurtle(graph,allPrefixes);
  }
  const result: BuildResult={root,outputDir,cfg,IRI,NS,outputs,graphs,glossary,rawGlossary,concepts,conceptIds,layer,history:hrels,
    stored,origins,externalTerms,knownActions,render,nowFor,
    metadata:{release:release!,commit,commitDate,glossaryBytes,roleCapabilities,adopted,differs,mappingClassTargets,limitsDoc,limitsText}};
  if(options.write!==false)writeGraphs(result);
  return result;
}
function compare(a: string,b: string): number { return a<b?-1:a>b?1:0; }
function compactKind(iri: string,ns: string): string { return iri.startsWith(ns)?'i2x:'+iri.slice(ns.length):qn(iri); }
interface FeedSnapshot {defs: Record<string,unknown>; related: number; broader: number; fieldMembers: number; version: string}
export function feedSnapshot(doc: {'@graph'?:Record<string,unknown>[]}): FeedSnapshot {
  const out:FeedSnapshot={defs:{},related:0,broader:0,fieldMembers:0,version:'?'};
  const count=(value:unknown):number=>Array.isArray(value)?value.length:value?1:0;
  const byId=new Map((doc['@graph']||[]).map(node=>[String(node['@id']),node]));
  for(const node of doc['@graph']||[]) {
    const ts=Array.isArray(node['@type'])?node['@type']:[node['@type']];
    if(ts.includes('skos:ConceptScheme'))out.version=String(node['gs:publicationVersion']||'?');
    if(ts.includes('skos:Concept')) {
      const active=node['gs:activeDefinition'];
      const definitionId=active&&typeof active==='object'?(active as Record<string,unknown>)['@id']:active;
      out.defs[String(node['@id'])]=node['skos:definition']??byId.get(String(definitionId))?.['rdf:value']??'';
      out.related+=count(node['skos:related']);out.broader+=count(node['skos:broader']);
    }
    if(ts.includes('skos:Collection')&&node['gs:facet']==='field')out.fieldMembers+=count(node['skos:member']);
  }
  out.related=Math.floor(out.related/2);return out;
}
/** Python equality of ordinary JSON structures disregards dictionary insertion order. */
function jsonEqual(a:unknown,b:unknown):boolean {
  if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>jsonEqual(v,b[i]));
  const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>,keys=Object.keys(aa);
  return keys.length===Object.keys(bb).length&&keys.every(k=>k in bb&&jsonEqual(aa[k],bb[k]));
}
export function writeGraphs(result: BuildResult): void {
  mkdirSync(result.outputDir,{recursive:true});
  for(const [key,text]of Object.entries(result.outputs))writeFileSync(join(result.outputDir,result.cfg.slugs[key]+'.ttl'),text);
  writeFileSync(join(result.outputDir,'i2idlx.context.jsonld'),JSON.stringify(companionContext(result.NS),null,2)+'\n');
  writeFileSync(join(result.outputDir,'publish-plan.json'),JSON.stringify(publishPlan(result),null,2)+'\n');
  // One RDF graph, many media types, using the same Foxxi serializer model.
  for(const [key,graph]of Object.entries(result.graphs)) {
    writeFileSync(join(result.outputDir,result.cfg.slugs[key]+'.jsonld'),JSON.stringify(serializeJsonLd(graph),null,2)+'\n');
    writeFileSync(join(result.outputDir,result.cfg.slugs[key]+'.nt'),serializeNTriples(graph));
  }
}

export function companionContext(NS: string): Record<string,unknown> {
return {
    "@context": {
        "@version": 1.1,
        "i2x": NS, "i2idl": CONCEPT_BASE, "iep": IEP, "ieh": "https://markjspivey-xwisee.github.io/interego/ns/harness#",
        "hyprcat": "https://markjspivey-xwisee.github.io/interego/ns/hyprcat#",
        "hypragent": "https://markjspivey-xwisee.github.io/interego/ns/hypragent#",
        "ie": "https://markjspivey-xwisee.github.io/interego/ns/interego#",
        "foxxi": "https://foxxi-bridge.interego.xwisee.com/ns/foxxi#", "xapi": "https://w3id.org/xapi/ontology#",
        "foxxi-xapi": "https://foxxi-bridge.interego.xwisee.com/ns/xapi#",
        "skos": SKOS, "dct": DCT, "prov": PROV, "hydra": HYDRA, "xsd": XSD,
        "Enactment": "i2x:Enactment", "MappingProposal": "i2x:MappingProposal", "RatificationVote": "i2x:RatificationVote",
        "UsageRecord": "i2x:UsageRecord", "CourseConceptAlignment": "i2x:CourseConceptAlignment",
        "ReleaseChange": "i2x:ReleaseChange", "ChangeEvent": "i2x:ChangeEvent",
        "partOfChange": {"@id": "i2x:partOfChange", "@type": "@id"},
        "changeKind": {"@id": "i2x:changeKind", "@type": "@id"},
        "changeCount": {"@id": "i2x:changeCount", "@type": "xsd:integer"},
        "changedConcept": {"@id": "i2x:changedConcept", "@type": "@id", "@container": "@set"},
        "changedCollection": {"@id": "i2x:changedCollection", "@type": "@id"},
        "changedSource": {"@id": "i2x:changedSource", "@type": "@id"},
        "changedTarget": {"@id": "i2x:changedTarget", "@type": "@id"},
        "citedIn": {"@id": "i2x:citedIn", "@type": "@id"},
        "enactedConcept": {"@id": "i2x:enactedConcept", "@type": "@id"},
        "viaAction": {"@id": "i2x:viaAction", "@type": "@id"},
        "enactmentRole": {"@id": "i2x:enactmentRole", "@type": "@id"},
        "proposedSubject": {"@id": "i2x:proposedSubject", "@type": "@id"},
        "proposedPredicate": {"@id": "i2x:proposedPredicate", "@type": "@id"},
        "proposedObject": {"@id": "i2x:proposedObject", "@type": "@id"},
        "reviewStatus": {"@id": "i2x:reviewStatus", "@type": "@id"},
        "mappingMethod": {"@id": "i2x:mappingMethod", "@type": "@id"},
        "i2idlPredicate": {"@id": "i2x:i2idlPredicate", "@type": "@id"},
        "rationale": "i2x:rationale",
        "confidence": {"@id": "i2x:confidence", "@type": "xsd:decimal"},
        "votesOn": {"@id": "i2x:votesOn", "@type": "@id"},
        "vote": {"@id": "i2x:vote", "@type": "@id"},
        "aboutConcept": {"@id": "i2x:aboutConcept", "@type": "@id", "@container": "@set"},
        "statement": {"@id": "i2x:statement", "@type": "@id"},
        "usageVerb": {"@id": "i2x:usageVerb", "@type": "@id"},
        "usageActivity": {"@id": "i2x:usageActivity", "@type": "@id"},
        "courseConcept": {"@id": "i2x:courseConcept", "@type": "@id"},
        "alignedTo": {"@id": "i2x:alignedTo", "@type": "@id"},
        "alignmentPredicate": {"@id": "i2x:alignmentPredicate", "@type": "@id"},
        "enactedBy": {"@id": "i2x:enactedBy", "@type": "@id", "@container": "@set"},
        "generatedAtTime": {"@id": "prov:generatedAtTime", "@type": "xsd:dateTime"},
        "attributedTo": {"@id": "prov:wasAttributedTo", "@type": "@id"},
        "Referent": "i2x:Referent",
        "isClassifiedBy": {"@id": "i2x:isClassifiedBy", "@type": "@id", "@container": "@set"},
        "classifies": {"@id": "i2x:classifies", "@type": "@id", "@container": "@set"},
        "referentCategory": {"@id": "i2x:referentCategory", "@type": "@id"},
        "categoryRationale": {"@id": "i2x:categoryRationale", "@language": "en"},
        "assignmentBasis": "i2x:assignmentBasis",
        "exemplifiedBy": {"@id": "i2x:exemplifiedBy", "@type": "@id"},
        "subject": {"@id": "dct:subject", "@type": "@id", "@container": "@set"},
    }
};
}

export function publishPlan(result: BuildResult): Record<string,unknown> {
  const order: [string,string,number,string[]][]=[
    ['shapes','Asserted',0.95,[]],['ontology','Asserted',0.9,[]],['rules','Asserted',0.9,[]],
    ['catalog','Asserted',0.9,[result.IRI.shapes!]],['enactments','Hypothetical',0.7,[result.IRI.shapes!]],
    ['mappings','Hypothetical',0.7,[result.IRI.shapes!]],['releases','Asserted',0.95,[result.IRI.shapes!]],
    ['changes','Asserted',0.95,[result.IRI.shapes!]],['alignments','Hypothetical',0.7,[result.IRI.shapes!]],
    ['referents','Hypothetical',0.7,[result.IRI.shapes!]],
  ];
  return {owner:result.cfg.owner,relayNsRoot:result.cfg.relayNsRoot,
    graphs:order.map(([key,modal,confidence,shapes],i)=>{
      const bytes=Buffer.byteLength(result.outputs[key]!,'utf8');
      return {order:i+1,graph_iri:result.IRI[key],file:result.cfg.slugs[key]+'.ttl',bytes,
        approxTokens:pythonRound(bytes/3.6),modal_status:modal,confidence,visibility:'public',
        conforms_to_shapes:shapes,note:'public is required for /ns dereference; there is no unpublish'};
    }),localOnly:[result.cfg.slugs.decorations+'.ttl']};
}
function pythonRound(value: number): number {
  const floor=Math.floor(value),fraction=value-floor;
  return fraction===0.5?(floor%2===0?floor:floor+1):Math.round(value);
}
