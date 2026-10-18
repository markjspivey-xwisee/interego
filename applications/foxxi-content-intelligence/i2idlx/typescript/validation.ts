/**
 * Native SHACL Core validation and the bounded SHACL-AF TripleRule profile
 * used by I2IDL-X. Unknown constraints/node expressions fail closed.
 *
 * Normative semantics: https://www.w3.org/TR/shacl/
 * Triple rules: https://www.w3.org/TR/shacl-af/#rules
 *
 * This implements the graph's Core constraints, not SHACL-SPARQL/SHACL-JS.
 */
import {Store,DataFactory} from 'n3';
import { progress } from './progress.js';
import type {Term,Quad} from '@rdfjs/types';
import {RDF,RDFS,XSD,termKey,objects,subjects,has,union,rdfList,rdfsClosure,validLexical} from './reasoning.js';

const {namedNode:nn,blankNode:bn,literal,quad}=DataFactory;
const SH='http://www.w3.org/ns/shacl#';
const dedup=(nodes:Term[])=>[...new Map(nodes.map(n=>[termKey(n),n])).values()];
const annotationNames=new Set(['name','description','message','order','group','severity','deactivated','prefixes','declare','prefix','namespace','defaultValue']);
const supportedNames=new Set(['NodeShape','PropertyShape','targetClass','targetNode','targetSubjectsOf','targetObjectsOf','path','property',
 'nodeKind','IRI','BlankNode','Literal','BlankNodeOrIRI','BlankNodeOrLiteral','IRIOrLiteral',
 'minCount','maxCount','minLength','maxLength','pattern','flags','datatype','class','node','hasValue','in',
 'minInclusive','maxInclusive','minExclusive','maxExclusive','equals','disjoint','lessThan','lessThanOrEquals',
 'and','or','not','xone','languageIn','uniqueLang','qualifiedValueShape','qualifiedMinCount','qualifiedMaxCount','qualifiedValueShapesDisjoint',
 'closed','ignoredProperties','inversePath','alternativePath','zeroOrMorePath','oneOrMorePath','zeroOrOnePath',
 'rule','TripleRule','subject','predicate','object','condition','this','filterShape','nodes']);
export interface ValidationResult {
  focusNode:Term; sourceShape:Term; component:string; path?:Term; value?:Term; message:string;
}
export interface ValidationTarget {focusNode:Term;sourceShape:Term}
export interface ValidationReport {
  conforms:boolean; results:ValidationResult[]; targets:ValidationTarget[]; dataGraph:Store; report:Store; graph:Store; text:string;
}
export interface ValidationOptions {ontology?:Store;inference?:'none'|'rdfs'}

function ensureSupported(shapes:Store):void {
  for(const q of shapes) if(q.predicate.value.startsWith(SH)) {
    const local=q.predicate.value.slice(SH.length);
    if(!supportedNames.has(local)&&!annotationNames.has(local))
      throw new Error('Unsupported SHACL feature '+q.predicate.value+'; refusing a partial conformance report');
  }
}
function one(g:Store,s:Term,p:string):Term|undefined {
  const values=objects(g,s,p);
  if(values.length>1) throw new Error('SHACL parameter must have one value: '+s.value+' '+p);
  return values[0];
}
function countValue(g:Store,s:Term,p:string):number|undefined {
  const n=one(g,s,SH+p);if(!n)return undefined;
  if(n.termType!=='Literal'||!/^\+?\d+$/.test(n.value)||!Number.isSafeInteger(Number(n.value)))
    throw new Error('Invalid SHACL count '+p+' on '+s.value);
  return Number(n.value);
}
function truth(g:Store,s:Term,p:string):boolean {
  const n=one(g,s,SH+p);if(!n)return false;
  if(n.termType!=='Literal'||n.datatype.value!==XSD+'boolean'||!['true','false','1','0'].includes(n.value))
    throw new Error('Invalid SHACL boolean '+p+' on '+s.value);
  return ['true','1'].includes(n.value);
}
function nodeKind(n:Term,k:string):boolean {
  const type=n.termType;
  switch(k.slice(SH.length)) {
    case 'IRI':return type==='NamedNode';case 'BlankNode':return type==='BlankNode';case 'Literal':return type==='Literal';
    case 'BlankNodeOrIRI':return type==='BlankNode'||type==='NamedNode';
    case 'BlankNodeOrLiteral':return type==='BlankNode'||type==='Literal';
    case 'IRIOrLiteral':return type==='NamedNode'||type==='Literal';
    default:throw new Error('Unknown SHACL nodeKind '+k);
  }
}
function compare(a:Term,b:Term):number|null {
  if(a.termType!=='Literal'||b.termType!=='Literal')return null;
  const numeric=(n:Term)=>n.termType==='Literal'&&n.datatype.value.startsWith(XSD)&&
    /^(decimal|integer|nonNegativeInteger|nonPositiveInteger|positiveInteger|negativeInteger|long|int|short|byte|unsignedLong|unsignedInt|unsignedShort|unsignedByte|float|double)$/.test(n.datatype.value.slice(XSD.length));
  if(numeric(a)&&numeric(b)) {
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(a.value)||!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(b.value)) {
      const x=Number(a.value),y=Number(b.value);return Number.isFinite(x)&&Number.isFinite(y)?Math.sign(x-y):null;
    }
    const decimal=(v:string):[bigint,number]=>{const [i='0',f='']=v.replace(/^\+/,'').split('.');return [BigInt((i===''?'0':i==='-'?'-0':i)+f),f.length];};
    const [x,sx]=decimal(a.value),[y,sy]=decimal(b.value),scale=Math.max(sx,sy);
    const xx=x*10n**BigInt(scale-sx),yy=y*10n**BigInt(scale-sy);return xx===yy?0:xx<yy?-1:1;
  }
  if(a.datatype.value===XSD+'string'&&b.datatype.value===XSD+'string')return a.value===b.value?0:a.value<b.value?-1:1;
  if(a.datatype.value===XSD+'dateTime'&&b.datatype.value===XSD+'dateTime') {
    const x=Date.parse(a.value),y=Date.parse(b.value);return Number.isFinite(x)&&Number.isFinite(y)?Math.sign(x-y):null;
  }
  return null;
}
export function pathValues(data:Store,shapes:Store,focus:Term,path:Term,seen=new Set<string>()):Term[] {
  if(path.termType==='NamedNode')return dedup(objects(data,focus,path));
  const k=termKey(path);if(seen.has(k))throw new Error('Cyclic SHACL path at '+path.value);
  const next=new Set([...seen,k]);
  const inverse=one(shapes,path,SH+'inversePath');
  if(inverse) {
    if(inverse.termType==='NamedNode')return dedup(subjects(data,inverse,focus));
    // Inversion of a compound path is evaluated by searching graph nodes.
    const candidates=dedup([...data].flatMap(q=>[q.subject,q.object]));
    return candidates.filter(n=>pathValues(data,shapes,n,inverse,next).some(v=>v.equals(focus)));
  }
  const alternatives=one(shapes,path,SH+'alternativePath');
  if(alternatives)return dedup(rdfList(shapes,alternatives).flatMap(p=>pathValues(data,shapes,focus,p,next)));
  for(const [op,min,max] of [['zeroOrMorePath',0,Infinity],['oneOrMorePath',1,Infinity],['zeroOrOnePath',0,1]] as const) {
    const p=one(shapes,path,SH+op);if(!p)continue;
    const result=new Map<string,Term>(),visited=new Set<string>();
    if(min===0)result.set(termKey(focus),focus);
    let frontier=[focus],depth=0;
    while(frontier.length&&depth<max) {
      depth++;const fresh:Term[]=[];
      for(const x of frontier) for(const v of pathValues(data,shapes,x,p,next)) {
        result.set(termKey(v),v);if(!visited.has(termKey(v))){visited.add(termKey(v));fresh.push(v);}
      }
      frontier=fresh;
    }
    return [...result.values()];
  }
  if(has(shapes,path,RDF+'first',objects(shapes,path,RDF+'first')[0]??nn(RDF+'nil'))) {
    let nodes=[focus];
    const sequence=rdfList(shapes,path);
    if(sequence.length<2)throw new Error('SHACL sequence path must contain at least two members');
    for(const p of sequence)nodes=dedup(nodes.flatMap(n=>pathValues(data,shapes,n,p,next)));
    return nodes;
  }
  throw new Error('Unsupported SHACL path '+path.value);
}
function targets(data:Store,shapes:Store,shape:Term):Term[] {
  const out=[...objects(shapes,shape,SH+'targetNode')];
  for(const c of objects(shapes,shape,SH+'targetClass')) {
    const classes=new Map([[termKey(c),c]]);let changed=true;
    while(changed){changed=false;for(const q of data.getQuads(null,nn(RDFS+'subClassOf'),null,null))if(classes.has(termKey(q.object))&&!classes.has(termKey(q.subject))){classes.set(termKey(q.subject),q.subject);changed=true;}}
    for(const cl of classes.values())out.push(...subjects(data,RDF+'type',cl));
  }
  if(has(shapes,shape,RDF+'type',nn(RDFS+'Class')))out.push(...subjects(data,RDF+'type',shape));
  for(const p of objects(shapes,shape,SH+'targetSubjectsOf'))out.push(...data.getQuads(null,p as Quad['predicate'],null,null).map(q=>q.subject));
  for(const p of objects(shapes,shape,SH+'targetObjectsOf'))out.push(...data.getQuads(null,p as Quad['predicate'],null,null).map(q=>q.object));
  return dedup(out);
}
class CoreValidator {
  constructor(readonly data:Store,readonly shapes:Store) {}
  validate(focus:Term,shape:Term,stack=new Set<string>()):ValidationResult[] {
    if(truth(this.shapes,shape,'deactivated'))return [];
    const key=termKey(focus)+'|'+termKey(shape);
    if(stack.has(key))throw new Error('Recursive SHACL shape requires unsupported fixed-point semantics: '+shape.value);
    const next=new Set([...stack,key]),path=one(this.shapes,shape,SH+'path');
    const values=path?pathValues(this.data,this.shapes,focus,path):[focus],out:ValidationResult[]=[];
    const emit=(component:string,message:string,value?:Term)=>out.push({focusNode:focus,sourceShape:shape,component:SH+component+'ConstraintComponent',path,value,message:objects(this.shapes,shape,SH+'message')[0]?.value??message});
    const passes=(n:Term,s:Term)=>this.validate(n,s,next).length===0;
    const min=countValue(this.shapes,shape,'minCount'),max=countValue(this.shapes,shape,'maxCount');
    if(min!==undefined&&values.length<min)emit('MinCount','Expected at least '+min+' values');
    if(max!==undefined&&values.length>max)emit('MaxCount','Expected at most '+max+' values');
    const expected=one(this.shapes,shape,SH+'hasValue');
    if(expected&&!values.some(v=>v.equals(expected)))emit('HasValue','Required value absent',expected);
    const equal=one(this.shapes,shape,SH+'equals');
    if(equal) {
      const other=objects(this.data,focus,equal);
      for(const v of dedup([...values,...other]))if(values.some(x=>x.equals(v))!==other.some(x=>x.equals(v)))emit('Equals','Property values differ',v);
    }
    const disjoint=one(this.shapes,shape,SH+'disjoint');
    if(disjoint)for(const v of values)if(has(this.data,focus,disjoint,v))emit('Disjoint','Properties must have disjoint values',v);
    const qShape=one(this.shapes,shape,SH+'qualifiedValueShape');
    if(qShape) {
      const qmin=countValue(this.shapes,shape,'qualifiedMinCount'),qmax=countValue(this.shapes,shape,'qualifiedMaxCount');
      let siblings:Term[]=[];
      if(truth(this.shapes,shape,'qualifiedValueShapesDisjoint')) {
        const parents=subjects(this.shapes,SH+'property',shape);
        siblings=dedup(parents.flatMap(p=>objects(this.shapes,p,SH+'property').filter(s=>!s.equals(shape)).flatMap(s=>objects(this.shapes,s,SH+'qualifiedValueShape'))));
      }
      const count=values.filter(v=>passes(v,qShape)&&siblings.every(s=>!passes(v,s))).length;
      if(qmin!==undefined&&count<qmin)emit('QualifiedMinCount','Too few qualified values');
      if(qmax!==undefined&&count>qmax)emit('QualifiedMaxCount','Too many qualified values');
    }
    if(truth(this.shapes,shape,'uniqueLang')) {
      const languages=new Set<string>();
      for(const v of values)if(v.termType==='Literal'&&v.language){const l=v.language.toLowerCase();if(languages.has(l))emit('UniqueLang','Duplicate language tag',v);languages.add(l);}
    }
    const kind=one(this.shapes,shape,SH+'nodeKind'),dt=one(this.shapes,shape,SH+'datatype'),cl=one(this.shapes,shape,SH+'class');
    const pattern=one(this.shapes,shape,SH+'pattern'),flags=one(this.shapes,shape,SH+'flags')?.value??'';
    let regex:RegExp|undefined;
    if(pattern) {
      if(/[^ims]/.test(flags)||/\\[iIcC]|\\p\{Is|-\[/.test(pattern.value))throw new Error('Unsupported XPath regex in SHACL pattern '+pattern.value);
      regex=new RegExp(pattern.value,flags);
    }
    const minLen=countValue(this.shapes,shape,'minLength'),maxLen=countValue(this.shapes,shape,'maxLength');
    const allowed=one(this.shapes,shape,SH+'in'),allowedNodes=allowed?rdfList(this.shapes,allowed):undefined;
    const langs=one(this.shapes,shape,SH+'languageIn'),ranges=langs?rdfList(this.shapes,langs).map(x=>x.value.toLowerCase()):undefined;
    for(const v of values) {
      if(kind&&!nodeKind(v,kind.value))emit('NodeKind','Unexpected RDF node kind',v);
      if(dt) {
        if(v.termType!=='Literal'||!v.datatype.equals(dt)||validLexical(v)===false)emit('Datatype','Datatype or lexical form does not conform',v);
        else if(validLexical(v)===null)throw new Error('Unsupported datatype lexical validator '+dt.value);
      }
      if(cl) {
        const types=objects(this.data,v,RDF+'type'),todo=[...types],seen=new Set<string>();let isClass=false;
        while(todo.length){const c=todo.pop()!;if(c.equals(cl)){isClass=true;break;}if(!seen.has(termKey(c))){seen.add(termKey(c));todo.push(...objects(this.data,c,RDFS+'subClassOf'));}}
        if(!isClass)emit('Class','Value is not an instance of required class',v);
      }
      if(regex){regex.lastIndex=0;if(!regex.test(v.value))emit('Pattern','Value does not match pattern',v);}
      const len=[...v.value].length;
      if(minLen!==undefined&&len<minLen)emit('MinLength','Value is too short',v);
      if(maxLen!==undefined&&len>maxLen)emit('MaxLength','Value is too long',v);
      if(allowedNodes&&!allowedNodes.some(a=>a.equals(v)))emit('In','Value is outside allowed list',v);
      if(ranges&&(v.termType!=='Literal'||!v.language||!ranges.some(r=>r==='*'||v.language.toLowerCase()===r||v.language.toLowerCase().startsWith(r+'-'))))emit('LanguageIn','Language tag is outside allowed ranges',v);
      for(const name of ['minInclusive','maxInclusive','minExclusive','maxExclusive']) {
        const bound=one(this.shapes,shape,SH+name);if(!bound)continue;const c=compare(v,bound);
        if(c===null||(name==='minInclusive'&&c<0)||(name==='maxInclusive'&&c>0)||(name==='minExclusive'&&c<=0)||(name==='maxExclusive'&&c>=0))emit(name.charAt(0).toUpperCase()+name.slice(1),'Value violates bound '+name,v);
      }
      for(const name of ['lessThan','lessThanOrEquals']) {
        const other=one(this.shapes,shape,SH+name);if(!other)continue;
        for(const w of objects(this.data,focus,other)){const c=compare(v,w);if(c===null||c>0||(name==='lessThan'&&c===0))emit(name==='lessThan'?'LessThan':'LessThanOrEquals','Property ordering violated',v);}
      }
      for(const ns of objects(this.shapes,shape,SH+'node'))if(!passes(v,ns))emit('Node','Value fails referenced node shape',v);
      const not=one(this.shapes,shape,SH+'not');if(not&&passes(v,not))emit('Not','Value conforms to excluded shape',v);
      for(const op of ['and','or','xone']) {
        const head=one(this.shapes,shape,SH+op);if(!head)continue;
        const members=rdfList(this.shapes,head),count=members.filter(s=>passes(v,s)).length;
        if((op==='and'&&count!==members.length)||(op==='or'&&count===0)||(op==='xone'&&count!==1))emit(op.charAt(0).toUpperCase()+op.slice(1),'Logical constraint '+op+' fails',v);
      }
    }
    if(truth(this.shapes,shape,'closed')) {
      const allowedPreds=new Set(objects(this.shapes,shape,SH+'property').flatMap(p=>objects(this.shapes,p,SH+'path')).filter(p=>p.termType==='NamedNode').map(termKey));
      const ignored=one(this.shapes,shape,SH+'ignoredProperties');if(ignored)for(const p of rdfList(this.shapes,ignored))allowedPreds.add(termKey(p));
      for(const v of values)for(const q of this.data.getQuads(v as Quad['subject'],null,null,null))if(!allowedPreds.has(termKey(q.predicate)))emit('Closed','Predicate is not allowed by closed shape',q.object);
    }
    for(const ps of objects(this.shapes,shape,SH+'property')) {
      if(!one(this.shapes,ps,SH+'path'))throw new Error('Property shape lacks sh:path: '+ps.value);
      for(const v of values)out.push(...this.validate(v,ps,next));
    }
    return out;
  }
}
function reportFor(results:ValidationResult[],targets:ValidationTarget[],dataGraph:Store):ValidationReport {
  const report=new Store(),root=bn(),conforms=results.length===0;
  report.addQuad(quad(root,nn(RDF+'type'),nn(SH+'ValidationReport')));
  report.addQuad(quad(root,nn(SH+'conforms'),literal(conforms?'true':'false',nn(XSD+'boolean'))));
  for(const r of results) {
    const result=bn();
    report.addQuad(quad(root,nn(SH+'result'),result));
    for(const [p,o] of [['type',nn(SH+'ValidationResult')],['focusNode',r.focusNode],['sourceShape',r.sourceShape],
      ['sourceConstraintComponent',nn(r.component)],['resultSeverity',nn(SH+'Violation')],['resultMessage',literal(r.message)]] as [string,Term][])
      report.addQuad(quad(result,nn(p==='type'?RDF+'type':SH+p),o as Quad['object']));
    if(r.path)report.addQuad(quad(result,nn(SH+'resultPath'),r.path as Quad['object']));
    if(r.value)report.addQuad(quad(result,nn(SH+'value'),r.value as Quad['object']));
  }
  return {conforms,results,targets,dataGraph,report,graph:report,text:'Validation Report\nConforms: '+conforms+'\n'+results.map(r=>'Constraint Violation: '+r.component+'; Focus Node: '+r.focusNode.value+'; '+r.message).join('\n')};
}
export async function shaclValidate(data:Store,shapes:Store,options:ValidationOptions={}):Promise<ValidationReport> {
  const started = Date.now();
  progress('validation:shacl', 'start', { dataTriples: data.size, shapeTriples: shapes.size, inference: options.inference ?? 'none' });
  ensureSupported(shapes);
  const merged=union(data,...(options.ontology?[options.ontology]:[])),graph=options.inference==='rdfs'?rdfsClosure(merged):merged;
  const validator=new CoreValidator(graph,shapes),results:ValidationResult[]=[],evaluatedTargets:ValidationTarget[]=[];
  const roots=dedup([
    ...[...shapes].filter(q=>[SH+'targetClass',SH+'targetNode',SH+'targetSubjectsOf',SH+'targetObjectsOf'].includes(q.predicate.value)).map(q=>q.subject),
    ...subjects(shapes,RDF+'type',nn(SH+'NodeShape')).filter(s=>has(shapes,s,RDF+'type',nn(RDFS+'Class')))
  ]);
  progress('validation:shacl', 'targets', { roots: roots.length, inferredTriples: graph.size });
  for(const s of roots) {
    if(truth(shapes,s,'deactivated'))continue;
    for(const n of targets(graph,shapes,s)) {
      evaluatedTargets.push({focusNode:n,sourceShape:s});
      results.push(...validator.validate(n,s));
    }
  }
  progress('validation:shacl', 'end', { results: results.length, seconds: (Date.now() - started) / 1000 });
  return reportFor(results,evaluatedTargets,graph);
}
export function conformsToShape(data:Store,shapes:Store,focus:Term,shape:Term):boolean {
  ensureSupported(shapes);return new CoreValidator(data,shapes).validate(focus,shape).length===0;
}
function nodeExpression(data:Store,shapes:Store,focus:Term,expression:Term):Term[] {
  if(expression.equals(nn(SH+'this')))return [focus];
  if(expression.termType!=='BlankNode')return [expression];
  const path=one(shapes,expression,SH+'path');
  if(path)return pathValues(data,shapes,focus,path);
  const nodes=one(shapes,expression,SH+'nodes'),filter=one(shapes,expression,SH+'filterShape');
  if(nodes&&filter)return nodeExpression(data,shapes,focus,nodes).filter(n=>new CoreValidator(data,shapes).validate(n,filter).length===0);
  throw new Error('Unsupported SHACL-AF node expression '+expression.value);
}
export function shaclRules(data:Store,shapes:Store,options:{maxRounds?:number;maxTriples?:number}={}):Store {
  const started = Date.now();
  progress('validation:shacl-af', 'start', { dataTriples: data.size, shapeTriples: shapes.size });
  ensureSupported(shapes);
  const g=union(data);
  // Keep the guard exact without rescanning N3's indexes after every add.
  let tripleCount=g.size;
  const allRules=[...shapes.getQuads(null,nn(SH+'rule'),null,null)].map(q=>{
    if(!has(shapes,q.object,RDF+'type',nn(SH+'TripleRule')))throw new Error('Only sh:TripleRule is supported');
    return {shape:q.subject,rule:q.object,order:Number(one(shapes,q.object,SH+'order')?.value??0)};
  }).sort((a,b)=>a.order-b.order||termKey(a.rule).localeCompare(termKey(b.rule)));
  let changed=true,round=0;
  while(changed) {
    if(++round>(options.maxRounds??1000))throw new Error('SHACL-AF rules did not reach a fixed point');
    const beforeTriples = tripleCount;
    progress('validation:shacl-af', 'round-start', { round, rules: allRules.length, triples: tripleCount });
    changed=false;
    for(const {shape,rule} of allRules) {
      if(truth(shapes,shape,'deactivated')||truth(shapes,rule,'deactivated'))continue;
      const s=one(shapes,rule,SH+'subject'),p=one(shapes,rule,SH+'predicate'),o=one(shapes,rule,SH+'object');
      if(!s||!p||!o)throw new Error('Malformed TripleRule '+rule.value);
      const validator=new CoreValidator(g,shapes);
      for(const focus of targets(g,shapes,shape))if(objects(shapes,rule,SH+'condition').every(c=>validator.validate(focus,c).length===0))
        for(const ss of nodeExpression(g,shapes,focus,s))for(const pp of nodeExpression(g,shapes,focus,p))for(const oo of nodeExpression(g,shapes,focus,o)) {
          if(!['NamedNode','BlankNode'].includes(ss.termType)||pp.termType!=='NamedNode')throw new Error('TripleRule produced an invalid RDF subject or predicate');
          if(!has(g,ss,pp,oo)){g.addQuad(quad(ss as Quad['subject'],pp as Quad['predicate'],oo as Quad['object']));tripleCount++;changed=true;}
          if(tripleCount>(options.maxTriples??2000000))throw new Error('SHACL-AF rule triple limit exceeded');
        }
    }
    progress('validation:shacl-af', 'round-end', { round, triples: tripleCount, addedTriples: tripleCount - beforeTriples });
  }
  progress('validation:shacl-af', 'end', { rounds: round, triples: tripleCount, seconds: (Date.now() - started) / 1000 });
  return g;
}
