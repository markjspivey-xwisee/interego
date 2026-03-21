/**
 * @module pgsl/rdf
 * @description RDF ecosystem integration for PGSL
 *
 * Maps every PGSL concept to the RDF/OWL/SHACL/SPARQL ecosystem:
 *
 *   RDF:    Atoms and Fragments as typed resources with properties
 *   OWL:    Class hierarchy (pgsl:Node ⊃ pgsl:Atom, pgsl:Fragment)
 *           Property restrictions (level, items, constituents)
 *   SHACL:  Shape constraints on Atoms, Fragments, PullbackSquares
 *   SPARQL: Query patterns for lattice navigation
 *   Turtle: Full serialization of PGSL instances
 *
 * The PGSL namespace extends the Context Graphs namespace:
 *   pgsl: <https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#>
 */

import type {
  Node,
  Atom,
  Fragment,
  PGSLInstance,
} from './types.js';
import { pullbackSquare } from './category.js';

// ── PGSL Namespace ──────────────────────────────────────────

export const PGSL_NS = 'https://markjspivey-xwisee.github.io/context-graphs/ns/pgsl#' as const;

export const PGSLClass = {
  Node:                  `${PGSL_NS}Node`,
  Atom:                  `${PGSL_NS}Atom`,
  Fragment:              `${PGSL_NS}Fragment`,
  PullbackSquare:        `${PGSL_NS}PullbackSquare`,
  ConstituentMorphism:   `${PGSL_NS}ConstituentMorphism`,
  Lattice:               `${PGSL_NS}Lattice`,
} as const;

export const PGSLProp = {
  value:                 `${PGSL_NS}value`,
  level:                 `${PGSL_NS}level`,
  height:                `${PGSL_NS}height`,
  item:                  `${PGSL_NS}item`,
  itemList:              `${PGSL_NS}itemList`,
  leftConstituent:       `${PGSL_NS}leftConstituent`,
  rightConstituent:      `${PGSL_NS}rightConstituent`,
  overlap:               `${PGSL_NS}overlap`,
  apex:                  `${PGSL_NS}apex`,
  constituentOf:         `${PGSL_NS}constituentOf`,
  contains:              `${PGSL_NS}contains`,
  atomCount:             `${PGSL_NS}atomCount`,
  fragmentCount:         `${PGSL_NS}fragmentCount`,
  maxLevel:              `${PGSL_NS}maxLevel`,
} as const;

// ── Turtle Prefixes ─────────────────────────────────────────

export function pgslTurtlePrefixes(): string {
  return [
    `@prefix pgsl: <${PGSL_NS}> .`,
    `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`,
    `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
    `@prefix prov: <http://www.w3.org/ns/prov#> .`,
    `@prefix owl: <http://www.w3.org/2002/07/owl#> .`,
  ].join('\n');
}

// ── Node → Turtle ───────────────────────────────────────────

function atomToTurtle(atom: Atom): string {
  const valueStr = typeof atom.value === 'string'
    ? `"${atom.value}"`
    : `"${atom.value}"^^xsd:${typeof atom.value === 'number' ? (Number.isInteger(atom.value) ? 'integer' : 'double') : 'boolean'}`;

  return [
    `<${atom.uri}> a pgsl:Atom, prov:Entity ;`,
    `    pgsl:value ${valueStr} ;`,
    `    pgsl:level "0"^^xsd:nonNegativeInteger ;`,
    `    prov:wasAttributedTo <${atom.provenance.wasAttributedTo}> ;`,
    `    prov:generatedAtTime "${atom.provenance.generatedAtTime}"^^xsd:dateTime .`,
  ].join('\n');
}

function fragmentToTurtle(fragment: Fragment, pgsl: PGSLInstance): string {
  const lines: string[] = [
    `<${fragment.uri}> a pgsl:Fragment, prov:Entity ;`,
    `    pgsl:level "${fragment.level}"^^xsd:nonNegativeInteger ;`,
    `    pgsl:height "${fragment.height}"^^xsd:nonNegativeInteger ;`,
  ];

  // Items as an RDF list
  lines.push(`    pgsl:itemList ( ${fragment.items.map(i => `<${i}>`).join(' ')} ) ;`);

  // Individual item links (for SPARQL queryability)
  for (const item of fragment.items) {
    lines.push(`    pgsl:item <${item}> ;`);
  }

  // Constituents (for level ≥ 2)
  if (fragment.left) lines.push(`    pgsl:leftConstituent <${fragment.left}> ;`);
  if (fragment.right) lines.push(`    pgsl:rightConstituent <${fragment.right}> ;`);

  // Pullback square (if applicable)
  const pb = pullbackSquare(pgsl, fragment.uri);
  if (pb) {
    lines.push(`    pgsl:overlap <${pb.overlap}> ;`);
  }

  // Provenance
  lines.push(`    prov:wasAttributedTo <${fragment.provenance.wasAttributedTo}> ;`);

  // Close with generatedAtTime
  lines.push(`    prov:generatedAtTime "${fragment.provenance.generatedAtTime}"^^xsd:dateTime .`);

  return lines.join('\n');
}

/**
 * Serialize a single PGSL node to Turtle.
 */
export function nodeToTurtle(node: Node, pgsl: PGSLInstance): string {
  if (node.kind === 'Atom') return atomToTurtle(node);
  return fragmentToTurtle(node as Fragment, pgsl);
}

/**
 * Serialize an entire PGSL instance to Turtle.
 */
export function pgslToTurtle(pgsl: PGSLInstance): string {
  const lines: string[] = [pgslTurtlePrefixes(), ''];

  // Serialize atoms first (level 0)
  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      lines.push(atomToTurtle(node));
      lines.push('');
    }
  }

  // Then fragments by level (bottom-up)
  const maxLvl = Math.max(...[...pgsl.nodes.values()]
    .filter(n => n.kind === 'Fragment')
    .map(n => (n as Fragment).level), 0);

  for (let lvl = 1; lvl <= maxLvl; lvl++) {
    for (const node of pgsl.nodes.values()) {
      if (node.kind === 'Fragment' && (node as Fragment).level === lvl) {
        lines.push(fragmentToTurtle(node as Fragment, pgsl));
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ── OWL Ontology ────────────────────────────────────────────

/**
 * Generate the PGSL OWL ontology as Turtle.
 * Defines the class hierarchy and property restrictions.
 */
export function pgslOwlOntology(): string {
  return `${pgslTurtlePrefixes()}
@prefix sh: <http://www.w3.org/ns/shacl#> .

# ── Classes ──────────────────────────────────────────────────

pgsl:Node a owl:Class ;
    rdfs:label "PGSL Node" ;
    rdfs:comment "A node in the Poly-Granular Sequence Lattice." .

pgsl:Atom a owl:Class ;
    rdfs:subClassOf pgsl:Node, prov:Entity ;
    rdfs:label "Atom" ;
    rdfs:comment "A leaf node containing a single primitive value. Level 0." ;
    owl:disjointWith pgsl:Fragment .

pgsl:Fragment a owl:Class ;
    rdfs:subClassOf pgsl:Node, prov:Entity ;
    rdfs:label "Fragment" ;
    rdfs:comment "A composite node spanning multiple atoms. Level ≥ 1." .

pgsl:PullbackSquare a owl:Class ;
    rdfs:label "Pullback Square" ;
    rdfs:comment "The categorical pullback encoding the overlapping pair construction." .

# ── Properties ───────────────────────────────────────────────

pgsl:value a owl:DatatypeProperty ;
    rdfs:domain pgsl:Atom ;
    rdfs:label "value" ;
    rdfs:comment "The primitive value of an atom." .

pgsl:level a owl:DatatypeProperty ;
    rdfs:domain pgsl:Node ;
    rdfs:range xsd:nonNegativeInteger ;
    rdfs:label "level" ;
    rdfs:comment "The granularity level (number of base atoms spanned)." .

pgsl:height a owl:DatatypeProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:range xsd:nonNegativeInteger ;
    rdfs:label "height" ;
    rdfs:comment "Topological depth from the lattice root." .

pgsl:item a owl:ObjectProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:range pgsl:Node ;
    rdfs:label "item" ;
    rdfs:comment "A node contained in this fragment." .

pgsl:itemList a owl:ObjectProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:label "item list" ;
    rdfs:comment "Ordered sequence of contained nodes (RDF list)." .

pgsl:leftConstituent a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:range pgsl:Fragment ;
    rdfs:label "left constituent" ;
    rdfs:comment "The left fragment in the overlapping pair construction." .

pgsl:rightConstituent a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:range pgsl:Fragment ;
    rdfs:label "right constituent" ;
    rdfs:comment "The right fragment in the overlapping pair construction." .

pgsl:overlap a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:range pgsl:Node ;
    rdfs:label "overlap" ;
    rdfs:comment "The shared sub-fragment (pullback fiber product) of the overlapping pair." .

pgsl:constituentOf a owl:ObjectProperty ;
    rdfs:domain pgsl:Node ;
    rdfs:range pgsl:Fragment ;
    rdfs:label "constituent of" ;
    owl:inverseOf pgsl:item ;
    rdfs:comment "This node is a constituent of the target fragment." .

pgsl:contains a owl:TransitiveProperty ;
    rdfs:domain pgsl:Fragment ;
    rdfs:range pgsl:Node ;
    rdfs:label "contains" ;
    rdfs:comment "Transitive containment — this fragment (transitively) contains the target node." .
`;
}

// ── SHACL Shapes ────────────────────────────────────────────

/**
 * Generate SHACL shapes for validating PGSL structures.
 */
export function pgslShaclShapes(): string {
  return `${pgslTurtlePrefixes()}
@prefix sh: <http://www.w3.org/ns/shacl#> .

# ── Atom Shape ───────────────────────────────────────────────

pgsl:AtomShape a sh:NodeShape ;
    sh:targetClass pgsl:Atom ;
    sh:property [
        sh:path pgsl:value ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:name "value"
    ] ;
    sh:property [
        sh:path pgsl:level ;
        sh:hasValue "0"^^xsd:nonNegativeInteger ;
        sh:name "level must be 0"
    ] ;
    sh:property [
        sh:path prov:wasAttributedTo ;
        sh:minCount 1 ;
        sh:name "provenance attribution"
    ] ;
    sh:property [
        sh:path prov:generatedAtTime ;
        sh:minCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "provenance timestamp"
    ] .

# ── Fragment Shape ───────────────────────────────────────────

pgsl:FragmentShape a sh:NodeShape ;
    sh:targetClass pgsl:Fragment ;
    sh:property [
        sh:path pgsl:level ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
        sh:minInclusive 1 ;
        sh:name "level must be ≥ 1"
    ] ;
    sh:property [
        sh:path pgsl:item ;
        sh:minCount 1 ;
        sh:name "must contain at least one item"
    ] ;
    sh:property [
        sh:path prov:wasAttributedTo ;
        sh:minCount 1 ;
        sh:name "provenance attribution"
    ] ;
    sh:property [
        sh:path prov:generatedAtTime ;
        sh:minCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "provenance timestamp"
    ] .

# ── Pullback Square Shape ────────────────────────────────────

pgsl:PullbackSquareShape a sh:NodeShape ;
    sh:targetClass pgsl:PullbackSquare ;
    sh:property [
        sh:path pgsl:apex ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class pgsl:Fragment ;
        sh:name "apex fragment"
    ] ;
    sh:property [
        sh:path pgsl:leftConstituent ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class pgsl:Fragment ;
        sh:name "left constituent"
    ] ;
    sh:property [
        sh:path pgsl:rightConstituent ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class pgsl:Fragment ;
        sh:name "right constituent"
    ] ;
    sh:property [
        sh:path pgsl:overlap ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class pgsl:Node ;
        sh:name "overlap region"
    ] .
`;
}

// ── SPARQL Patterns ─────────────────────────────────────────

/**
 * SPARQL query: find all fragments at a given level.
 */
export function sparqlFragmentsAtLevel(level: number): string {
  return `PREFIX pgsl: <${PGSL_NS}>
SELECT ?fragment ?height WHERE {
  ?fragment a pgsl:Fragment ;
            pgsl:level "${level}"^^xsd:nonNegativeInteger ;
            pgsl:height ?height .
}`;
}

/**
 * SPARQL query: find all fragments containing a given atom.
 */
export function sparqlFragmentsContaining(atomUri: string): string {
  return `PREFIX pgsl: <${PGSL_NS}>
SELECT ?fragment ?level WHERE {
  ?fragment a pgsl:Fragment ;
            pgsl:item <${atomUri}> ;
            pgsl:level ?level .
} ORDER BY ?level`;
}

/**
 * SPARQL query: get the pullback structure of a fragment.
 */
export function sparqlPullbackOf(fragmentUri: string): string {
  return `PREFIX pgsl: <${PGSL_NS}>
SELECT ?left ?right ?overlap WHERE {
  <${fragmentUri}> pgsl:leftConstituent ?left ;
                   pgsl:rightConstituent ?right ;
                   pgsl:overlap ?overlap .
}`;
}

/**
 * SPARQL query: find all neighbors of a node.
 */
export function sparqlNeighbors(nodeUri: string): string {
  return `PREFIX pgsl: <${PGSL_NS}>
SELECT ?neighbor ?direction ?parent WHERE {
  {
    ?parent pgsl:leftConstituent <${nodeUri}> ;
            pgsl:rightConstituent ?neighbor .
    BIND("right" AS ?direction)
  } UNION {
    ?parent pgsl:rightConstituent <${nodeUri}> ;
            pgsl:leftConstituent ?neighbor .
    BIND("left" AS ?direction)
  }
}`;
}

/**
 * SPARQL query: lattice statistics.
 */
export function sparqlLatticeStats(): string {
  return `PREFIX pgsl: <${PGSL_NS}>
SELECT
  (COUNT(DISTINCT ?atom) AS ?atoms)
  (COUNT(DISTINCT ?fragment) AS ?fragments)
  (MAX(?level) AS ?maxLevel)
WHERE {
  { ?atom a pgsl:Atom }
  UNION
  { ?fragment a pgsl:Fragment ; pgsl:level ?level }
}`;
}
