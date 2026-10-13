/**
 * A SKOS alignment read as OWL, the way merge tools read one, over the axioms of the two ontologies
 * it joins — and what that reading entails.
 *
 * A structural reasoner for the fragment the Foxxi xAPI ontology and ADL's xAPI ontology are written
 * in: named subclass axioms, equivalence, unions, disjointness, and the domains and ranges of
 * properties. Neither ontology has a property restriction, so what one named class entails about
 * another is the closure of the stated axioms plus case analysis over unions, which this does to the
 * depth the two ontologies need (a union of unions is as deep as they go). The test that uses it pins
 * its answers to HermiT's on the same inputs, both for the alignment and for the one it replaced.
 */
import type { Quad } from 'n3';
import { OWL, RDFS, RDF_TYPE, SKOS } from './ns-graph.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** What a terminology says about named classes. */
export interface Tbox {
  /** [sub, super] — an equivalence is two of these. */
  readonly sub: ReadonlyArray<readonly [string, string]>;
  /** [class, its members]: the class is the union of the members. */
  readonly unions: ReadonlyArray<readonly [string, readonly string[]]>;
  /** Sets of pairwise-disjoint classes. */
  readonly disjoint: ReadonlyArray<readonly string[]>;
}

export const mergeTboxes = (...ts: Tbox[]): Tbox => ({
  sub: ts.flatMap(t => t.sub), unions: ts.flatMap(t => t.unions), disjoint: ts.flatMap(t => t.disjoint),
});

/** The entailments of a Tbox between named classes. */
export class Reading {
  private readonly edges = new Map<string, Set<string>>();
  private readonly memo = new Map<string, Set<string>>();
  private readonly t: Tbox;

  constructor(t: Tbox) {
    this.t = t;
    for (const [a, b] of t.sub) this.add(a, b);
    for (const [u, ms] of t.unions) for (const m of ms) this.add(m, u);
    // A union is under whatever all of its satisfiable members are under; repeat until nothing new.
    for (let changed = true; changed;) {
      changed = false;
      for (const [u, ms] of t.unions) {
        const live = ms.filter(m => !this.unsatisfiable([m]));
        if (live.length === 0) continue;
        const [first, ...rest] = live.map(m => this.supers(m));
        for (const x of first!) if (x !== u && rest.every(s => s.has(x)) && this.add(u, x)) changed = true;
      }
    }
  }

  private add(a: string, b: string): boolean {
    if (a === b) return false;
    let s = this.edges.get(a);
    if (!s) this.edges.set(a, (s = new Set()));
    if (s.has(b)) return false;
    s.add(b);
    this.memo.clear();
    return true;
  }

  /** Every class the class is subsumed by, itself and its equivalents included (stated closure). */
  supers(c: string): Set<string> {
    const hit = this.memo.get(c);
    if (hit) return hit;
    const out = new Set<string>([c]);
    const stack = [c];
    while (stack.length) for (const n of this.edges.get(stack.pop()!) ?? []) if (!out.has(n)) { out.add(n); stack.push(n); }
    this.memo.set(c, out);
    return out;
  }

  private closed(classes: readonly string[]): Set<string> {
    const s = new Set<string>();
    for (const c of classes) for (const x of this.supers(c)) s.add(x);
    return s;
  }

  private clash(s: Set<string>): boolean {
    return this.t.disjoint.some(d => d.filter(x => s.has(x)).length >= 2);
  }

  /** Whether the intersection of the classes is empty: two disjoint classes above it, or a union
   *  above it each of whose members would be. */
  unsatisfiable(classes: readonly string[], depth = 2): boolean {
    const s = this.closed(classes);
    if (this.clash(s)) return true;
    if (depth === 0) return false;
    return this.t.unions.some(([u, ms]) => s.has(u) && ms.every(m => this.unsatisfiable([...s, m], depth - 1)));
  }

  /** The classes in `ns` the class is subsumed by, other than itself. */
  supersIn(c: string, ns: string): string[] {
    return [...this.supers(c)].filter(x => x !== c && x.startsWith(ns)).sort();
  }
}

// ── reading a published ontology ───────────────────────────────────────────────────────────

const items = (q: readonly Quad[], head: string): Array<Quad['object']> => {
  const out: Array<Quad['object']> = [];
  for (let n = head; n !== `${RDF}nil`;) {
    out.push(q.find(t => t.subject.value === n && t.predicate.value === `${RDF}first`)!.object);
    n = q.find(t => t.subject.value === n && t.predicate.value === `${RDF}rest`)!.object.value;
  }
  return out;
};
const list = (q: readonly Quad[], head: string): string[] => items(q, head).map(t => t.value);
const one = (q: readonly Quad[], s: string, p: string): Quad | undefined => q.find(t => t.subject.value === s && t.predicate.value === p);
const typed = (q: readonly Quad[], s: string, type: string): boolean => q.some(t => t.subject.value === s && t.predicate.value === RDF_TYPE && t.object.value === type);

/** The class axioms of an ontology document between named classes. */
export function tboxOf(q: readonly Quad[]): Tbox {
  const sub: Array<[string, string]> = [];
  const unions: Array<[string, string[]]> = [];
  const disjoint: string[][] = [];
  for (const t of q) {
    const s = t.subject.value, o = t.object.value;
    if (t.subject.termType !== 'NamedNode') continue;
    if (t.predicate.value === `${RDFS}subClassOf` && t.object.termType === 'NamedNode') sub.push([s, o]);
    if (t.predicate.value === `${OWL}equivalentClass` && typed(q, s, `${OWL}Class`)) {
      if (t.object.termType === 'NamedNode') sub.push([s, o], [o, s]);
      else { const u = one(q, o, `${OWL}unionOf`); if (u) unions.push([s, list(q, u.object.value)]); }
    }
    if (t.predicate.value === `${OWL}disjointUnionOf`) { const ms = list(q, o); unions.push([s, ms]); disjoint.push(ms); }
    if (t.predicate.value === `${OWL}disjointWith`) disjoint.push([s, o]);
  }
  for (const ax of q.filter(t => t.predicate.value === RDF_TYPE && t.object.value === `${OWL}AllDisjointClasses`)) {
    disjoint.push(list(q, one(q, ax.subject.value, `${OWL}members`)!.object.value));
  }
  return { sub, unions, disjoint };
}

/** A class expression's named classes: the class, or the members of a union. */
export function namedIn(q: readonly Quad[], node: Quad['object']): string[] {
  if (node.termType === 'NamedNode') return [node.value];
  const u = one(q, node.value, `${OWL}unionOf`);
  return u ? list(q, u.object.value) : [];
}

// ── value spaces ───────────────────────────────────────────────────────────────────────────

/** The disjoint value spaces of the datatypes in play (OWL 2 Structural Specification §4; RDF 1.1
 *  Concepts §3.3 for rdf:langString, whose values are pairs of a string and a language tag). */
const SPACE: Readonly<Record<string, string>> = {
  [`${XSD}string`]: 'string', [`${XSD}normalizedString`]: 'string', [`${XSD}token`]: 'string', [`${XSD}language`]: 'string',
  [`${XSD}Name`]: 'string', [`${XSD}NCName`]: 'string', [`${XSD}NMTOKEN`]: 'string',
  [`${RDF}langString`]: 'langString', [`${XSD}anyURI`]: 'anyURI', [`${XSD}boolean`]: 'boolean',
  [`${XSD}dateTime`]: 'dateTime', [`${XSD}dateTimeStamp`]: 'dateTime',
  [`${XSD}decimal`]: 'real', [`${XSD}integer`]: 'real', [`${XSD}nonNegativeInteger`]: 'real', [`${XSD}positiveInteger`]: 'real',
  [`${XSD}nonPositiveInteger`]: 'real', [`${XSD}negativeInteger`]: 'real', [`${XSD}long`]: 'real', [`${XSD}int`]: 'real',
  [`${XSD}short`]: 'real', [`${XSD}byte`]: 'real', [`${OWL}real`]: 'real', [`${OWL}rational`]: 'real',
  [`${XSD}double`]: 'double', [`${XSD}float`]: 'float', [`${XSD}duration`]: 'duration', [`${XSD}date`]: 'date',
};
const EVERY_SPACE = [...new Set(Object.values(SPACE))];

/** The value spaces a data range admits: a datatype, a datatype the document defines (by its base,
 *  or the union of its bases), a union of data ranges, or an enumeration of literals. */
export function valueSpaces(q: readonly Quad[], node: Quad['object'] | string): string[] {
  const v = typeof node === 'string' ? node : node.value;
  if (v === `${RDFS}Literal`) return EVERY_SPACE;
  if (SPACE[v]) return [SPACE[v]!];
  const def = one(q, v, `${OWL}equivalentClass`)?.object;
  if (def) return valueSpaces(q, def);
  const base = one(q, v, `${OWL}onDatatype`);
  if (base) return valueSpaces(q, base.object);
  const u = one(q, v, `${OWL}unionOf`);
  if (u) return [...new Set(list(q, u.object.value).flatMap(m => valueSpaces(q, m)))];
  const e = one(q, v, `${OWL}oneOf`);
  if (e) {
    return [...new Set(items(q, e.object.value).map(t => t.termType === 'Literal' ? SPACE[t.datatype.value] ?? `other ${t.datatype.value}` : 'an individual'))];
  }
  throw new Error(`no value space known for ${v}`);
}

/** The value spaces common to several data ranges (several ranges of one property intersect). */
export const commonSpaces = (ranges: readonly string[][]): string[] =>
  ranges.length === 0 ? EVERY_SPACE : ranges.reduce((a, b) => a.filter(x => b.includes(x)));

// ── the alignment ──────────────────────────────────────────────────────────────────────────

export const MATCH = { exact: `${SKOS}exactMatch`, broad: `${SKOS}broadMatch`, narrow: `${SKOS}narrowMatch`, close: `${SKOS}closeMatch`, related: `${SKOS}relatedMatch` } as const;

/** The logical reading of a document's SKOS mappings between classes: exactMatch as equivalence,
 *  broadMatch as subsumption under the target, narrowMatch the converse, the rest as nothing. */
export function bridgeOf(q: readonly Quad[], from: string, to: string): Tbox {
  const sub: Array<[string, string]> = [];
  for (const t of q) {
    const s = t.subject.value, o = t.object.value;
    if (!s.startsWith(from) || !o.startsWith(to) || !typed(q, s, `${OWL}Class`)) continue;
    if (t.predicate.value === MATCH.exact) sub.push([s, o], [o, s]);
    if (t.predicate.value === MATCH.broad) sub.push([s, o]);
    if (t.predicate.value === MATCH.narrow) sub.push([o, s]);
  }
  return { sub, unions: [], disjoint: [] };
}

/** The ontology an alignment points into, as far as reading the alignment needs it. */
export interface Counterpart {
  readonly ns: string;
  /** Its classes. */
  readonly classes: readonly string[];
  readonly tbox: Tbox;
  /** A property's domains (several intersect). */
  domain(property: string): readonly string[];
  /** A property's ranges — classes or datatypes (several intersect). */
  range(property: string): readonly string[];
}

/** What reading an alignment as OWL entails, against reading each ontology alone. IRIs throughout. */
export interface Verdict {
  /** Classes with no possible instance once the alignment is read as OWL. */
  readonly unsatisfiable: { readonly from: string[]; readonly to: string[] };
  /** Subsumptions between two classes of one ontology that it does not entail alone (conservativity). */
  readonly newSubsumptions: { readonly from: string[]; readonly to: string[] };
  /** Superclasses outside both namespaces that a class of the aligned ontology gains. */
  readonly gainedOutside: string[];
  /** Uses the aligned ontology allows — a property on a class of its domain, with a value in its range. */
  readonly uses: number;
  /** Uses that become impossible. */
  readonly inconsistentUses: string[];
  /** Uses whose subject or value gains a class of the aligned ontology. */
  readonly usesThatGain: string[];
}

const subsumptionsGained = (merged: Reading, alone: Reading, classes: readonly string[], ns: string): string[] =>
  classes.filter(c => !merged.unsatisfiable([c]))
    .flatMap(c => merged.supersIn(c, ns).filter(d => !alone.supers(c).has(d)).map(d => `${c} ⊑ ${d}`));

/**
 * Read an ontology document's SKOS alignment into another ontology as OWL — exactMatch as
 * equivalence, broadMatch as subsumption, closeMatch and relatedMatch as nothing — and report, with
 * the conservativity principle of ontology alignment (Jiménez-Ruiz et al.; Solimando et al., ISWC
 * 2014) as the standard: unsatisfiable classes; subsumptions within either ontology that it does not
 * entail alone; and, for every use the aligned ontology allows, whether it stays possible and whether
 * it gains a class of the aligned ontology.
 */
export function readAsOwl(q: readonly Quad[], from: string, to: Counterpart): Verdict {
  const mine = tboxOf(q);
  const merged = new Reading(mergeTboxes(mine, to.tbox, bridgeOf(q, from, to.ns)));
  const aloneMine = new Reading(mine), aloneTheirs = new Reading(to.tbox);
  const myClasses = [...new Set(q.filter(t => t.predicate.value === RDF_TYPE && t.object.value === `${OWL}Class` && t.subject.value.startsWith(from)).map(t => t.subject.value))].sort();

  const gainedOutside = myClasses.filter(c => !merged.unsatisfiable([c])).flatMap(c =>
    [...merged.supers(c)].filter(d => d !== c && !d.startsWith(from) && !d.startsWith(to.ns) && !aloneMine.supers(c).has(d)).map(d => `${c} ⊑ ${d}`)).sort();

  let uses = 0;
  const inconsistentUses: string[] = [], usesThatGain: string[] = [];
  const gains = (label: string, classes: string[], baseline: string): void => {
    const before = aloneMine.supers(baseline);
    const gained = [...new Set(classes.flatMap(c => [...merged.supers(c)]))].filter(d => d.startsWith(from) && !before.has(d)).sort();
    if (gained.length) usesThatGain.push(`${label} gains ${gained.join(', ')}`);
  };
  const properties = q.filter(t => t.predicate.value === RDF_TYPE && t.subject.value.startsWith(from)
    && (t.object.value === `${OWL}ObjectProperty` || t.object.value === `${OWL}DatatypeProperty`));
  for (const { subject: { value: p }, object: { value: kind } } of properties) {
    const dom = one(q, p, `${RDFS}domain`), rng = one(q, p, `${RDFS}range`);
    const read = q.filter(t => t.subject.value === p && (t.predicate.value === MATCH.exact || t.predicate.value === MATCH.broad) && t.object.value.startsWith(to.ns)).map(t => t.object.value);
    const theirDomain = read.flatMap(r => to.domain(r)), theirRange = read.flatMap(r => to.range(r));
    const allowed = kind === `${OWL}DatatypeProperty` ? commonSpaces(theirRange.map(r => valueSpaces(q, r))) : [];
    for (const c of dom ? namedIn(q, dom.object) : [`${OWL}Thing`]) {
      // A use is a node of the class with the property, valued in the range: impossible if either
      // end is, as a reasoner finds the class C ⊓ ∃p.R empty when C or R is.
      const subject = [c, ...theirDomain];
      if (kind === `${OWL}ObjectProperty`) {
        for (const r of rng ? namedIn(q, rng.object) : [`${OWL}Thing`]) {
          uses++;
          const label = `${p} on ${c} → ${r}`, value = [r, ...theirRange];
          if (merged.unsatisfiable(subject) || merged.unsatisfiable(value)) { inconsistentUses.push(label); continue; }
          gains(label, subject, c);
          gains(`${label} (the value)`, value, r);
        }
      } else {
        for (const space of rng ? valueSpaces(q, rng.object) : ['any']) {
          uses++;
          const label = `${p} on ${c} = a ${space} value`;
          if (merged.unsatisfiable(subject) || (space !== 'any' && !allowed.includes(space))) { inconsistentUses.push(label); continue; }
          gains(label, subject, c);
        }
      }
    }
  }
  return {
    unsatisfiable: {
      from: myClasses.filter(c => merged.unsatisfiable([c])),
      to: to.classes.filter(c => merged.unsatisfiable([c])).sort(),
    },
    newSubsumptions: {
      from: subsumptionsGained(merged, aloneMine, myClasses, from),
      to: subsumptionsGained(merged, aloneTheirs, [...to.classes].sort(), to.ns),
    },
    gainedOutside, uses, inconsistentUses: inconsistentUses.sort(), usesThatGain: usesThatGain.sort(),
  };
}
