/**
 * Native finite OWL-RL/RDF saturation for the I2IDL-X build.
 *
 * Rule identifiers follow W3C OWL 2 Profiles, section 4.3:
 * https://www.w3.org/TR/owl2-profiles/#Reasoning_in_OWL_2_RL_and_RDF_Graphs_using_Rules
 *
 * This is deliberately not advertised as a complete OWL 2 DL reasoner.
 * Literal value equality (dt-eq/dt-diff) and custom datatype facet entailment
 * are outside this engine, as they are outside the retained Python oracle.
 * Java HermiT performs the independent DL consistency check.
 */
import { Store, DataFactory, Writer } from 'n3';
import type { Term, Quad, Literal } from '@rdfjs/types';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const { namedNode: nn, literal, quad } = DataFactory;
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const termKey = (t: Term): string => t.termType + ':' + JSON.stringify(t.value) +
  (t.termType === 'Literal' ? '@' + t.language + '^^' + t.datatype.value : '');
export function objects(g: Store, s: Term, p: string | Term): Term[] {
  return g.getQuads(s as Quad['subject'], typeof p === 'string' ? nn(p) : p as Quad['predicate'], null, null).map(q => q.object);
}
export function subjects(g: Store, p: string | Term, o: Term): Term[] {
  return g.getQuads(null, typeof p === 'string' ? nn(p) : p as Quad['predicate'], o as Quad['object'], null).map(q => q.subject);
}
export function has(g: Store, s: Term, p: string | Term, o: Term): boolean {
  return g.countQuads(s as Quad['subject'], typeof p === 'string' ? nn(p) : p as Quad['predicate'], o as Quad['object'], null) > 0;
}
export function union(...graphs: Store[]): Store {
  const out = new Store();
  for (const g of graphs) for (const q of g) out.addQuad(quad(q.subject, q.predicate, q.object));
  return out;
}
export function rdfList(g: Store, head: Term): Term[] {
  const out: Term[] = [], seen = new Set<string>();
  let n = head;
  while (!n.equals(nn(RDF + 'nil'))) {
    if (seen.has(termKey(n))) throw new Error('Cyclic RDF list at ' + n.value);
    seen.add(termKey(n));
    const first = objects(g, n, RDF + 'first'), rest = objects(g, n, RDF + 'rest');
    if (first.length !== 1 || rest.length !== 1) throw new Error('Malformed RDF list at ' + n.value);
    out.push(first[0]); n = rest[0];
  }
  return out;
}

const integerBounds: Record<string, [bigint | null, bigint | null]> = {
  integer: [null, null], nonNegativeInteger: [0n, null], nonPositiveInteger: [null, 0n],
  positiveInteger: [1n, null], negativeInteger: [null, -1n],
  long: [-9223372036854775808n, 9223372036854775807n], int: [-2147483648n, 2147483647n],
  short: [-32768n, 32767n], byte: [-128n, 127n], unsignedLong: [0n, 18446744073709551615n],
  unsignedInt: [0n, 4294967295n], unsignedShort: [0n, 65535n], unsignedByte: [0n, 255n],
};
const subsumptions: Record<string, string[]> = {
  integer: ['decimal'], long: ['integer','decimal'], int: ['long','integer','decimal'],
  short: ['int','long','integer','decimal'], byte: ['short','int','long','integer','decimal'],
  nonNegativeInteger: ['integer','decimal'], nonPositiveInteger: ['integer','decimal'],
  positiveInteger: ['nonNegativeInteger','integer','decimal'], negativeInteger: ['nonPositiveInteger','integer','decimal'],
  unsignedLong: ['nonNegativeInteger','integer','decimal'],
  unsignedInt: ['unsignedLong','nonNegativeInteger','integer','decimal'],
  unsignedShort: ['unsignedInt','unsignedLong','nonNegativeInteger','integer','decimal'],
  unsignedByte: ['unsignedShort','unsignedInt','unsignedLong','nonNegativeInteger','integer','decimal'],
  normalizedString: ['string'], token: ['normalizedString','string'], language: ['token','normalizedString','string'],
  Name: ['token','normalizedString','string'], NCName: ['Name','token','normalizedString','string'],
  NMTOKEN: ['Name','token','normalizedString','string'], dateTimeStamp: ['dateTime'],
};
export const OWL2_DATATYPES = new Set([
  ...Object.keys(integerBounds), 'decimal','double','float','string','normalizedString','token','language','Name',
  'NCName','NMTOKEN','boolean','hexBinary','base64Binary','anyURI','dateTime','dateTimeStamp',
].map(x => XSD + x).concat([OWL+'real', OWL+'rational', RDF+'PlainLiteral', RDF+'XMLLiteral', RDFS+'Literal']));
const rlDatatypes = new Set([...OWL2_DATATYPES].filter(x => x !== OWL+'real' && x !== OWL+'rational')
  .concat([XSD+'date', XSD+'time', RDF+'HTML', RDF+'langString']));
export function validLexical(l: Literal): boolean | null {
  const dt = l.datatype.value, v = l.value, local = dt.slice(XSD.length);
  if (dt === RDF + 'langString') return l.language.length > 0;
  if (dt === RDFS+'Literal' || dt === RDF+'PlainLiteral') return true;
  if (!dt.startsWith(XSD)) return null;
  if (local in integerBounds) {
    if (!/^[+-]?\d+$/.test(v.trim())) return false;
    const n = BigInt(v.trim()), [lo, hi] = integerBounds[local];
    return (lo === null || n >= lo) && (hi === null || n <= hi);
  }
  if (local === 'decimal') return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim());
  if (local === 'double' || local === 'float') return /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|INF|-INF|NaN)$/.test(v.trim());
  if (local === 'boolean') return ['true','false','1','0'].includes(v.trim());
  if (local === 'string' || local === 'anyURI') return true;
  if (local === 'normalizedString') return !/[\r\n\t]/.test(v);
  if (local === 'token') return !/[\r\n\t]|^ | $|  /.test(v);
  if (local === 'language') return /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(v);
  if (local === 'Name') return /^[:_\p{L}][:_\p{L}\p{N}.\-\u00b7]*$/u.test(v);
  if (local === 'NCName') return /^[_\p{L}][_\p{L}\p{N}.\-\u00b7]*$/u.test(v);
  if (local === 'NMTOKEN') return /^[:_\p{L}\p{N}.\-\u00b7]+$/u.test(v);
  if (local === 'hexBinary') return /^(?:[0-9a-fA-F]{2})*$/.test(v.replace(/\s+/g,''));
  if (local === 'base64Binary') return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.replace(/\s+/g,''));
  // Calendar validity is checked separately; arbitrary precision years remain unsupported.
  if (['dateTime','dateTimeStamp','date','time'].includes(local)) {
    const datetime = /^(-?\d{4,})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)?$/;
    const date = /^(-?\d{4,})-(\d\d)-(\d\d)(Z|[+-]\d\d:\d\d)?$/;
    const time = /^(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)?$/;
    const m = (local === 'date' ? date : local === 'time' ? time : datetime).exec(v);
    if (!m || (local === 'dateTimeStamp' && !m[7])) return false;
    if (local !== 'time') {
      const year = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
      if (Math.abs(year) > 9999) return null;
      if (year === 0 || mo < 1 || mo > 12 || day < 1) return false;
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      if (day > [31,leap?29:28,31,30,31,30,31,31,30,31,30,31][mo-1]) return false;
    }
    if (local !== 'date') {
      const offset = local === 'time' ? 0 : 3, hour = Number(m[1+offset]), min = Number(m[2+offset]), sec = Number(m[3+offset]);
      if (hour > 24 || min > 59 || sec > 59 || (hour === 24 && (min !== 0 || sec !== 0))) return false;
    }
    const zone = m[m.length-1];
    if (zone && zone !== 'Z') {
      const zh = Number(zone.slice(1,3)), zm = Number(zone.slice(4,6));
      if (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)) return false;
    }
    return true;
  }
  return null;
}

export interface ClosureResult {
  graph: Store; errors: string[]; rounds: number;
  coverage: { mode: 'native-owlrl-oracle-compatible'; unsupported: string[]; completeDatatypeEntailment: false };
}
export function closure(data: Store, options: { maxRounds?: number; maxTriples?: number; strictDatatypes?: boolean } = {}): ClosureResult {
  const g = union(data), errors = new Set<string>(), unsupported = new Set<string>();
  const T = RDF+'type', SC = RDFS+'subClassOf', SP = RDFS+'subPropertyOf', SA = OWL+'sameAs';
  let changed = false;
  const add = (s: Term, p: Term|string, o: Term) => {
    const pred = typeof p === 'string' ? nn(p) : p;
    if (!has(g,s,pred,o)) {
      g.addQuad(quad(s as Quad['subject'], pred as Quad['predicate'], o as Quad['object'])); changed = true;
      if (g.size > (options.maxTriples ?? 2000000)) throw new Error('OWL saturation triple limit exceeded; no partial result accepted');
    }
  };
  const typed = (n: Term, c: string|Term) => has(g,n,T,typeof c === 'string'?nn(c):c);
  add(nn(OWL+'Thing'),T,nn(OWL+'Class')); add(nn(OWL+'Nothing'),T,nn(OWL+'Class'));
  const annotations = ['label','comment','seeAlso','isDefinedBy'].map(x=>RDFS+x)
    .concat(['versionInfo','deprecated','priorVersion','backwardCompatibleWith','incompatibleWith'].map(x=>OWL+x));
  for (const p of annotations) add(nn(p),T,nn(OWL+'AnnotationProperty'));
  for (const d of rlDatatypes) add(nn(d),T,nn(RDFS+'Datatype'));
  const usedDt = new Set<string>();
  for (const q of [...g]) if (q.object.termType === 'Literal' && rlDatatypes.has(q.object.datatype.value)) {
    const l=q.object, dt=l.datatype.value; usedDt.add(dt); add(l,T,nn(dt));
    const ok=validLexical(l);
    if (ok === false) errors.add("Lexical value of the literal '" + l.value + "' does not match its datatype (" + dt + ')');
    if (ok === null) unsupported.add('Lexical validator unavailable: '+dt);
    for (const parent of subsumptions[dt.slice(XSD.length)] ?? []) { add(l,T,nn(XSD+parent)); usedDt.add(XSD+parent); }
  }
  const topTypes=['anyURI','base64Binary','boolean','dateTime','decimal','double','float','hexBinary','string'].map(x=>XSD+x)
    .concat([RDF+'PlainLiteral',RDF+'XMLLiteral']);
  for (let i=0;i<topTypes.length;i++) for(let j=i+1;j<topTypes.length;j++) {
    if (topTypes[i]===XSD+'string' && topTypes[j]===RDF+'PlainLiteral') continue;
    if (usedDt.has(topTypes[i]) && usedDt.has(topTypes[j])) add(nn(topTypes[i]),OWL+'disjointWith',nn(topTypes[j]));
  }
  if (options.strictDatatypes && unsupported.size) throw new Error([...unsupported].join('; '));
  let rounds=0;
  do {
    changed=false; rounds++;
    if(rounds>(options.maxRounds??1000)) throw new Error('OWL saturation did not reach a fixed point; no partial result accepted');
    for (const q of [...g]) {
      const s:Term=q.subject,p:Term=q.predicate,o:Term=q.object,pv=p.value;
      for (const n of [s,p,o]) add(n,SA,n);
      if (pv===SA && !s.equals(o)) {
        add(o,SA,s);
        for(const z of objects(g,o,SA)) add(s,SA,z);
        for(const t of g.getQuads(s as Quad['subject'],null,null,null)) add(o,t.predicate,t.object);
        for(const t of g.getQuads(null,s as Quad['predicate'],null,null)) add(t.subject,o,t.object);
        for(const t of g.getQuads(null,null,o as Quad['object'],null)) add(t.subject,t.predicate,s);
      }
      if (pv===T) {
        if (o.value===OWL+'Class') {
          add(s,SC,s); add(s,OWL+'equivalentClass',s); add(s,SC,nn(OWL+'Thing')); add(nn(OWL+'Nothing'),SC,s);
        }
        if ([OWL+'ObjectProperty',OWL+'DatatypeProperty',RDF+'Property'].includes(o.value)) {
          add(s,SP,s); add(s,OWL+'equivalentProperty',s);
        }
        if ([OWL+'FunctionalProperty',OWL+'InverseFunctionalProperty',OWL+'SymmetricProperty',OWL+'TransitiveProperty'].includes(o.value)) {
          for(const t of g.getQuads(null,s as Quad['predicate'],null,null)) {
            if(o.value===OWL+'FunctionalProperty') for(const v of objects(g,t.subject,s)) add(t.object,SA,v);
            if(o.value===OWL+'InverseFunctionalProperty') for(const v of subjects(g,s,t.object)) add(t.subject,SA,v);
            if(o.value===OWL+'SymmetricProperty') add(t.object,s,t.subject);
            if(o.value===OWL+'TransitiveProperty') for(const v of objects(g,t.object,s)) add(t.subject,s,v);
          }
        }
        if(subsumptions[o.value.slice(XSD.length)] && o.value.startsWith(XSD))
          for(const d of subsumptions[o.value.slice(XSD.length)]) add(s,T,nn(XSD+d));
      }
      if(pv===SC) {
        for(const n of subjects(g,T,s)) add(n,T,o);
        for(const z of objects(g,o,SC)) add(s,SC,z);
        if(has(g,o,SC,s)) add(s,OWL+'equivalentClass',o);
      }
      if(pv===OWL+'equivalentClass') { add(s,SC,o); add(o,SC,s); }
      if(pv===SP) {
        for(const t of g.getQuads(null,s as Quad['predicate'],null,null)) add(t.subject,o,t.object);
        for(const z of objects(g,o,SP)) add(s,SP,z);
        if(has(g,o,SP,s)) add(s,OWL+'equivalentProperty',o);
      }
      if(pv===OWL+'equivalentProperty') { add(s,SP,o); add(o,SP,s); }
      if(pv===RDFS+'domain'||pv===RDFS+'range') {
        for(const t of g.getQuads(null,s as Quad['predicate'],null,null)) add(pv===RDFS+'domain'?t.subject:t.object,T,o);
        for(const c of objects(g,o,SC)) add(s,p,c);
        for(const pp of subjects(g,SP,s)) add(pp,p,o);
      }
      if(pv===OWL+'inverseOf') {
        for(const t of g.getQuads(null,s as Quad['predicate'],null,null)) add(t.object,o,t.subject);
        for(const t of g.getQuads(null,o as Quad['predicate'],null,null)) add(t.object,s,t.subject);
      }
      if(pv===OWL+'propertyChainAxiom') {
        const chain=rdfList(g,o);
        if(chain.length) {
          let paths: [Term,Term][]=g.getQuads(null,chain[0] as Quad['predicate'],null,null).map(t=>[t.subject,t.object]);
          for(const pi of chain.slice(1)) paths=paths.flatMap(([a,b])=>objects(g,b,pi).map(c=>[a,c] as [Term,Term]));
          for(const [a,b] of paths) add(a,s,b);
        }
      }
      if(pv===OWL+'intersectionOf'||pv===OWL+'unionOf') {
        const classes=rdfList(g,o);
        if(pv===OWL+'intersectionOf') {
          for(const c of classes) add(s,SC,c);
          if(classes.length) for(const x of subjects(g,T,classes[0])) if(classes.every(c=>typed(x,c))) add(x,T,s);
        } else for(const c of classes) add(c,SC,s);
      }
      if(pv===OWL+'oneOf') for(const n of rdfList(g,o)) add(n,T,s);
      if([OWL+'someValuesFrom',OWL+'allValuesFrom',OWL+'hasValue'].includes(pv)) {
        for(const pp of objects(g,s,OWL+'onProperty')) {
          if(pv===OWL+'someValuesFrom') for(const t of g.getQuads(null,pp as Quad['predicate'],null,null))
            if(o.value===OWL+'Thing'||typed(t.object,o)) add(t.subject,T,s);
          if(pv===OWL+'allValuesFrom') for(const u of subjects(g,T,s)) for(const v of objects(g,u,pp)) add(v,T,o);
          if(pv===OWL+'hasValue') {
            for(const u of subjects(g,T,s)) add(u,pp,o);
            for(const u of subjects(g,pp,o)) add(u,T,s);
          }
          // Schema rules for restrictions (scm-hv, scm-svf1/2, scm-avf1/2).
          for(const c2 of subjects(g,OWL+'onProperty',pp)) for(const y2 of objects(g,c2,p))
            if(pv!==OWL+'hasValue'&&has(g,o,SC,y2)) add(s,SC,c2);
          for(const c2 of subjects(g,p,o)) for(const p2 of objects(g,c2,OWL+'onProperty')) if(has(g,pp,SP,p2))
            add(pv===OWL+'allValuesFrom'?c2:s,SC,pv===OWL+'allValuesFrom'?s:c2);
        }
      }
      if(pv===OWL+'maxCardinality'||pv===OWL+'maxQualifiedCardinality') {
        const n=o.termType==='Literal'?Number(o.value):NaN;
        if(n===1) for(const pp of objects(g,s,OWL+'onProperty')) for(const u of subjects(g,T,s)) {
          const cs=pv===OWL+'maxQualifiedCardinality'?objects(g,s,OWL+'onClass'):[nn(OWL+'Thing')];
          for(const c of cs) {
            const vals=objects(g,u,pp).filter(v=>c.value===OWL+'Thing'||typed(v,c));
            for(const a of vals) for(const b of vals) add(a,SA,b);
          }
        }
      }
      if(pv===OWL+'hasKey') {
        const props=rdfList(g,o), members=subjects(g,T,s);
        if(props.length) for(let i=0;i<members.length;i++) for(let j=i+1;j<members.length;j++)
          if(props.every(pp=>objects(g,members[i],pp).some(v=>has(g,members[j],pp,v)))) add(members[i],SA,members[j]);
      }
    }
  } while(changed);
  // Contradictions are checked only after saturation, never treated as a reason to stop early.
  const errorDisjoint=(a:Term,b:Term) => {
    for(const x of subjects(g,T,a)) if(typed(x,b)) errors.add('Disjoint classes '+a.value+' and '+b.value+' have a common individual '+x.value);
  };
  for(const q of g) {
    const s:Term=q.subject,p=q.predicate.value,o:Term=q.object;
    if(p===OWL+'disjointWith') errorDisjoint(s,o);
    if(p===OWL+'complementOf') for(const x of subjects(g,T,s)) if(typed(x,o))
      errors.add('Violation of complementarity for classes '+s.value+' and '+o.value+' on element '+x.value);
    if(p===SA && (has(g,s,OWL+'differentFrom',o)||has(g,o,OWL+'differentFrom',s)))
      errors.add("'sameAs' and 'differentFrom' cannot be used on the same subject-object pair: ("+s.value+', '+o.value+')');
    if(p===T && o.value===OWL+'Nothing') errors.add(s.value+' is owl:Nothing');
    if(p===T && [OWL+'AllDisjointClasses',OWL+'AllDisjointProperties',OWL+'AllDifferent'].includes(o.value)) {
      for(const head of [...objects(g,s,OWL+'members'),...objects(g,s,OWL+'distinctMembers')]) {
        const items=rdfList(g,head);
        for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) {
          if(o.value===OWL+'AllDisjointClasses') errorDisjoint(items[i],items[j]);
          if(o.value===OWL+'AllDifferent'&&has(g,items[i],SA,items[j])) errors.add("'sameAs' and 'AllDifferent' cannot be used on the same subject-object pair: ("+items[i].value+', '+items[j].value+')');
          if(o.value===OWL+'AllDisjointProperties') for(const t of g.getQuads(null,items[i] as Quad['predicate'],null,null))
            if(has(g,t.subject,items[j],t.object)) errors.add('Disjoint properties in an AllDisjointProperties: '+items[i].value+', '+items[j].value);
        }
      }
    }
    if(p===T && [OWL+'IrreflexiveProperty',OWL+'AsymmetricProperty'].includes(o.value))
      for(const t of g.getQuads(null,s as Quad['predicate'],null,null)) {
        if(o.value===OWL+'IrreflexiveProperty'&&t.subject.equals(t.object)) errors.add('Irreflexive property used on '+t.subject.value+' with '+s.value);
        if(o.value===OWL+'AsymmetricProperty'&&has(g,t.object,s,t.subject)) errors.add('Erroneous usage of asymmetric property '+s.value+' on '+t.subject.value+' and '+t.object.value);
      }
    if(p===OWL+'propertyDisjointWith') for(const t of g.getQuads(null,s as Quad['predicate'],null,null))
      if(has(g,t.subject,o,t.object)) errors.add('Erroneous usage of disjoint properties '+s.value+' and '+o.value+' on '+t.subject.value+' and '+t.object.value);
    if(p===OWL+'sourceIndividual') for(const pp of objects(g,s,OWL+'assertionProperty'))
      for(const v of [...objects(g,s,OWL+'targetIndividual'),...objects(g,s,OWL+'targetValue')])
        if(has(g,o,pp,v)) errors.add('Negative property assertion violated for: ('+o.value+', '+pp.value+', '+v.value+')');
    if((p===OWL+'maxCardinality'||p===OWL+'maxQualifiedCardinality')&&o.value==='0')
      for(const pp of objects(g,s,OWL+'onProperty')) for(const u of subjects(g,T,s)) for(const v of objects(g,u,pp)) {
        const cs=p===OWL+'maxQualifiedCardinality'?objects(g,s,OWL+'onClass'):[nn(OWL+'Thing')];
        if(cs.some(c=>c.value===OWL+'Thing'||typed(v,c))) errors.add('Erroneous usage of maximum cardinality with '+s.value+' and '+v.value);
      }
  }
  // Generalized blank-node predicate triples may participate in rules; never publish them.
  for(const q of [...g]) if(q.predicate.termType!=='NamedNode') g.removeQuad(q);
  return { graph:g,errors:[...errors].sort(),rounds,coverage:{mode:'native-owlrl-oracle-compatible',unsupported:[...unsupported].sort(),completeDatatypeEntailment:false} };
}

export function rdfsClosure(data: Store): Store {
  const g=union(data);
  let changed=true;
  const add=(s:Term,p:string,o:Term)=>{if(!has(g,s,p,o)){g.addQuad(quad(s as Quad['subject'],nn(p),o as Quad['object']));changed=true;}};
  while(changed) {
    changed=false;
    for(const q of [...g]) {
      if(q.predicate.value===RDFS+'subClassOf') {
        for(const z of objects(g,q.object,RDFS+'subClassOf')) add(q.subject,RDFS+'subClassOf',z);
        for(const x of subjects(g,RDF+'type',q.subject)) add(x,RDF+'type',q.object);
      }
      if(q.predicate.value===RDFS+'subPropertyOf') {
        for(const z of objects(g,q.object,RDFS+'subPropertyOf')) add(q.subject,RDFS+'subPropertyOf',z);
        for(const t of g.getQuads(null,q.subject as Quad['predicate'],null,null)) add(t.subject,q.object.value,t.object);
      }
      if(q.predicate.value===RDFS+'domain'||q.predicate.value===RDFS+'range')
        for(const t of g.getQuads(null,q.subject as Quad['predicate'],null,null)) add(q.predicate.value===RDFS+'domain'?t.subject:t.object,RDF+'type',q.object);
    }
  }
  return g;
}

const dataRangePreds=new Set(['allValuesFrom','someValuesFrom','onDataRange','onDatatype'].map(x=>OWL+x).concat([RDFS+'range']));
const structurePreds=new Set([RDF+'first',...['length','minLength','maxLength','pattern','langRange','minInclusive','minExclusive','maxInclusive','maxExclusive','totalDigits','fractionDigits'].map(x=>XSD+x)]);
const offMap=(t:Term)=>t.termType==='NamedNode'&&t.value.startsWith(XSD)&&!OWL2_DATATYPES.has(t.value);
const rewritesLiteral=(t:Term)=>t.termType==='Literal'&&!t.language&&!OWL2_DATATYPES.has(t.datatype.value);
function blankClosure(g:Store,n:Term):Term[] {
  const seen=new Map<string,Term>(),todo=[n];
  while(todo.length) {const x=todo.pop()!;if(x.termType==='BlankNode'&&!seen.has(termKey(x))){seen.set(termKey(x),x);todo.push(...g.getQuads(x,null,null,null).map(q=>q.object));}}
  return [...seen.values()];
}
export function patternRestrictions(g:Store): Map<string,{node:Term;base:Term;nodes:Set<string>}> {
  const out=new Map<string,{node:Term;base:Term;nodes:Set<string>}>();
  for(const q of g.getQuads(null,nn(OWL+'withRestrictions'),null,null)) {
    const bases=objects(g,q.subject,OWL+'onDatatype'),facets=rdfList(g,q.object);
    if(bases.length===1&&facets.length&&facets.every(f=>g.getQuads(f as Quad['subject'],null,null,null).every(t=>t.predicate.value===XSD+'pattern'))) {
      const nodes=new Set([termKey(q.subject),...facets.map(termKey)]);let cell:Term=q.object;
      while(!cell.equals(nn(RDF+'nil'))){nodes.add(termKey(cell));cell=objects(g,cell,RDF+'rest')[0];}
      out.set(termKey(q.subject),{node:q.subject,base:bases[0],nodes});
    }
  }
  return out;
}
export function dlReady(g:Store):Store {
  const out=new Store(),patterns=patternRestrictions(g),skip=new Set([...patterns.values()].flatMap(p=>[...p.nodes]));
  for(const q of g) {
    if(q.predicate.value===OWL+'imports'||skip.has(termKey(q.subject))) continue;
    let o:Term=patterns.get(termKey(q.object))?.base??q.object;
    if(o.termType==='Literal') {
      if(q.subject.termType!=='BlankNode') continue;
      if(rewritesLiteral(o)) o=literal(o.value);
    } else if((dataRangePreds.has(q.predicate.value)||q.predicate.value===RDF+'first')&&offMap(o)) o=nn(RDFS+'Literal');
    out.addQuad(quad(q.subject,q.predicate,o as Quad['object']));
  }
  return out;
}
export function wideningRisks(g:Store):{risks:string[];properties:number} {
  const patterns=patternRestrictions(g);
  function widened(n:Term,through=new Set<string>()):boolean {
    if(through.has(termKey(n))) return false;
    if(patterns.has(termKey(n))||offMap(n)) return true;
    if(n.termType==='NamedNode') return has(g,n,RDF+'type',nn(RDFS+'Datatype'))&&!through.has(termKey(n))&&
      objects(g,n,OWL+'equivalentClass').some(d=>widened(d,new Set([...through,termKey(n)])));
    const nextThrough=new Set([...through,termKey(n)]);
    return blankClosure(g,n).some(x=>patterns.has(termKey(x))||g.getQuads(x as Quad['subject'],null,null,null).some(q=>
      q.predicate.value!==RDF+'rest'&&(((dataRangePreds.has(q.predicate.value)||q.predicate.value===RDF+'first')&&(offMap(q.object)||widened(q.object,nextThrough)))||rewritesLiteral(q.object))));
  }
  const onProp=g.getQuads(null,nn(OWL+'onProperty'),null,null),widenedProps=new Map<string,Term>();
  for(const q of g.getQuads(null,nn(RDFS+'range'),null,null)) if(widened(q.object)) widenedProps.set(termKey(q.subject),q.subject);
  for(const q of onProp) if(['someValuesFrom','allValuesFrom','onDataRange'].some(p=>objects(g,q.subject,OWL+p).some(f=>widened(f))))
    widenedProps.set(termKey(q.object),q.object);
  const w=new Map(widenedProps);
  let changed=true;
  while(changed) {
    changed=false;
    for(const q of g) if(q.predicate.value===RDFS+'subPropertyOf'&&w.has(termKey(q.object))&&!w.has(termKey(q.subject))) {w.set(termKey(q.subject),q.subject);changed=true;}
    else if(q.predicate.value===OWL+'equivalentProperty'&&(w.has(termKey(q.subject))||w.has(termKey(q.object))))
      for(const n of [q.subject,q.object]) if(!w.has(termKey(n))){w.set(termKey(n),n);changed=true;}
  }
  const used=new Set(onProp.map(q=>termKey(q.object))),risks:string[]=[];
  for(const [k,p] of [...w].sort((a,b)=>a[1].value.localeCompare(b[1].value))) if(used.has(k)) risks.push('a class expression uses '+p.value+', whose data range is widened');
  if(used.has(termKey(nn(OWL+'topDataProperty')))) risks.push('a class expression restricts owl:topDataProperty, so every data property');
  const annotationSet=new Set(subjects(g,RDF+'type',nn(OWL+'AnnotationProperty')).map(termKey));
  for(const p of ['label','comment','seeAlso','isDefinedBy'].map(x=>RDFS+x).concat(['versionInfo','deprecated','priorVersion','backwardCompatibleWith','incompatibleWith'].map(x=>OWL+x))) annotationSet.add(termKey(nn(p)));
  for(const q of g) if(q.subject.termType==='BlankNode'&&q.object.termType==='Literal') {
    if(w.has(termKey(q.predicate))) risks.push('HermiT reads a value of '+q.predicate.value+', whose data range is widened: '+q.object.value);
    else if(rewritesLiteral(q.object)&&!annotationSet.has(termKey(q.predicate))&&!structurePreds.has(q.predicate.value))
      risks.push('HermiT reads '+q.object.value+', made plain, as '+q.predicate.value);
  }
  return {risks,properties:widenedProps.size};
}
export const ROBOT_1_9_11_SHA256='53cd275c8e4c0dad1fc2c1c34174876795cd7d6b6926e1444adcbb0cb3c7ab26';
export async function reasonerJar(config:{jar:string;sha256:string;url?:string}):Promise<string> {
  if(config.sha256!==ROBOT_1_9_11_SHA256) throw new Error('Reasoner pin differs from reviewed ROBOT 1.9.11');
  const file=resolve(config.jar),bytes=await readFile(file),actual=createHash('sha256').update(bytes).digest('hex');
  if(actual!==config.sha256) throw new Error(file+' has SHA-256 '+actual+', not '+config.sha256);
  return file;
}
export interface HermitResult {consistent:boolean|null;seconds:number;detail:string}
export async function hermit(g:Store,workdir:string,jar:string,memoryMb=3000,timeoutSeconds=900):Promise<HermitResult> {
  const risks=wideningRisks(g);
  if(risks.risks.length) throw new Error('Unsafe DL widening: '+risks.risks.slice(0,3).join('; '));
  const bytes=await readFile(jar);
  if(createHash('sha256').update(bytes).digest('hex')!==ROBOT_1_9_11_SHA256) throw new Error('HermiT jar is not the pinned ROBOT 1.9.11');
  await mkdir(workdir,{recursive:true});
  const file=resolve(workdir,'reasoning-input.nt'),dl=dlReady(g);
  const text=await new Promise<string>((res,rej)=>{const writer=new Writer({format:'N-Triples'});writer.addQuads([...dl]);writer.end((err,result)=>err?rej(err):res(result));});
  await writeFile(file,text,'utf8');
  const start=Date.now(),java=process.env.I2IDLX_JAVA??'java';
  return new Promise((res,rej)=>{
    const child=spawn(java,['-Xmx'+memoryMb+'M','-cp',resolve(jar),'org.semanticweb.HermiT.cli.CommandLine','-k',pathToFileURL(file).href],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',expired=false,finished=false;
    const timer=setTimeout(()=>{expired=true;child.kill('SIGKILL');},timeoutSeconds*1000);
    child.stdout.on('data',b=>{output+=b.toString();});child.stderr.on('data',b=>{output+=b.toString();});
    child.on('error',e=>{if(!finished){finished=true;clearTimeout(timer);rej(e);}});
    child.on('close',code=>{
      if(finished)return;finished=true;clearTimeout(timer);
      const seconds=(Date.now()-start)/1000;
      if(expired)res({consistent:null,seconds,detail:'no answer within '+timeoutSeconds+' s'});
      else if(output.includes('InconsistentOntologyException'))res({consistent:false,seconds,detail:'inconsistent'});
      else if(code===0&&output.includes('owl#Thing is satisfiable'))res({consistent:true,seconds,detail:'consistent'});
      else rej(new Error('HermiT: '+output.split(/\r?\n/).filter(x=>x.trim()&&!x.startsWith('Picked up JAVA_TOOL_OPTIONS')).slice(0,3).join(' | ').slice(0,300)));
    });
  });
}
