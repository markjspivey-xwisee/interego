/**
 * @module pgsl/shacl
 * @description Three-layer SHACL validation for PGSL lattices.
 *
 * Layer 1 — Core: validates fundamental PGSL node constraints
 *           (atom value, level, fragment items, provenance)
 * Layer 2 — Structural: validates lattice invariants
 *           (level consistency, constituent integrity, canonicity, acyclicity)
 * Layer 3 — Domain: validates user-defined shapes
 *           (custom property constraints, SPARQL-based rules)
 *
 * Follows the same programmatic validation pattern as
 * src/validation/validator.ts — zero external dependencies.
 */

import type { IRI } from '../model/types.js';
import type { PGSLInstance, Atom, Fragment } from './types.js';
import { pullbackSquare } from './category.js';
import { PGSL_NS } from './rdf.js';
import { materializeTriples, matchPattern, executeSparqlString } from './sparql-engine.js';

// ── Types ──────────────────────────────────────────────────

export interface ShaclViolation {
  readonly node: string;
  readonly shape: string;
  readonly path?: string;
  readonly message: string;
  readonly severity: 'violation' | 'warning' | 'info';
}

export interface ShaclValidationResult {
  readonly conforms: boolean;
  readonly violations: readonly ShaclViolation[];
}

export interface ShaclPropertyConstraint {
  readonly path: string;
  readonly minCount?: number;
  readonly maxCount?: number;
  readonly datatype?: string;
  readonly class?: string;
  readonly hasValue?: string;
  readonly minInclusive?: number;
  readonly maxInclusive?: number;
  readonly in?: readonly string[];
  readonly pattern?: string;
  readonly message?: string;
}

export interface ShaclShapeDefinition {
  readonly name: string;
  readonly targetClass: string;
  readonly properties: readonly ShaclPropertyConstraint[];
  readonly sparqlConstraints?: readonly string[];
}

// ── Layer 1: Core PGSL SHACL ───────────────────────────────

/**
 * Validate core PGSL node constraints.
 * Checks: atom value/level/provenance, fragment items/level/provenance.
 */
export function validateCorePGSL(pgsl: PGSLInstance): ShaclValidationResult {
  const violations: ShaclViolation[] = [];

  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      const atom = node as Atom;

      // Value must exist and be a primitive
      if (atom.value === undefined || atom.value === null) {
        violations.push({
          node: atom.uri,
          shape: 'pgsl:AtomShape',
          path: 'pgsl:value',
          message: 'Atom must have exactly one value',
          severity: 'violation',
        });
      }
      const vtype = typeof atom.value;
      if (vtype !== 'string' && vtype !== 'number' && vtype !== 'boolean') {
        violations.push({
          node: atom.uri,
          shape: 'pgsl:AtomShape',
          path: 'pgsl:value',
          message: `Atom value must be string, number, or boolean; got ${vtype}`,
          severity: 'violation',
        });
      }

      // Level must be 0
      if (atom.level !== 0) {
        violations.push({
          node: atom.uri,
          shape: 'pgsl:AtomShape',
          path: 'pgsl:level',
          message: `Atom level must be 0; got ${atom.level}`,
          severity: 'violation',
        });
      }

      // Provenance
      if (!atom.provenance?.wasAttributedTo) {
        violations.push({
          node: atom.uri,
          shape: 'pgsl:AtomShape',
          path: 'prov:wasAttributedTo',
          message: 'Atom must have provenance attribution',
          severity: 'violation',
        });
      }
      if (!atom.provenance?.generatedAtTime) {
        violations.push({
          node: atom.uri,
          shape: 'pgsl:AtomShape',
          path: 'prov:generatedAtTime',
          message: 'Atom must have provenance timestamp',
          severity: 'violation',
        });
      }
    } else {
      const frag = node as Fragment;

      // Level must be >= 1
      if (frag.level < 1) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:FragmentShape',
          path: 'pgsl:level',
          message: `Fragment level must be >= 1; got ${frag.level}`,
          severity: 'violation',
        });
      }

      // Must have at least one item
      if (!frag.items || frag.items.length === 0) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:FragmentShape',
          path: 'pgsl:item',
          message: 'Fragment must contain at least one item',
          severity: 'violation',
        });
      }

      // All items must exist in repository
      for (const itemUri of frag.items) {
        if (!pgsl.nodes.has(itemUri)) {
          violations.push({
            node: frag.uri,
            shape: 'pgsl:FragmentShape',
            path: 'pgsl:item',
            message: `Fragment item ${itemUri} does not exist in repository`,
            severity: 'violation',
          });
        }
      }

      // Provenance
      if (!frag.provenance?.wasAttributedTo) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:FragmentShape',
          path: 'prov:wasAttributedTo',
          message: 'Fragment must have provenance attribution',
          severity: 'violation',
        });
      }
      if (!frag.provenance?.generatedAtTime) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:FragmentShape',
          path: 'prov:generatedAtTime',
          message: 'Fragment must have provenance timestamp',
          severity: 'violation',
        });
      }
    }
  }

  return { conforms: violations.length === 0, violations };
}

// ── Layer 2: Structural PGSL SHACL ─────────────────────────

/**
 * Validate structural lattice invariants.
 * Checks: level consistency, constituent integrity, overlap validity,
 * canonicity, acyclicity.
 */
export function validateStructuralPGSL(pgsl: PGSLInstance): ShaclValidationResult {
  const violations: ShaclViolation[] = [];

  // Track seen values/sequences for canonicity checks
  const seenAtomValues = new Map<string, IRI>();
  const seenFragmentSequences = new Map<string, IRI>();

  for (const node of pgsl.nodes.values()) {
    if (node.kind === 'Atom') {
      const atom = node as Atom;
      // Canonicity: no two atoms share the same value
      const key = String(atom.value);
      const existing = seenAtomValues.get(key);
      if (existing && existing !== atom.uri) {
        violations.push({
          node: atom.uri,
          shape: 'pgsl:CanonicalityShape',
          message: `Duplicate atom value "${atom.value}" — also at ${existing}`,
          severity: 'violation',
        });
      }
      seenAtomValues.set(key, atom.uri);
    } else {
      const frag = node as Fragment;

      // Level consistency: fragment at level k has exactly k items
      if (frag.items.length !== frag.level) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:LevelConsistencyShape',
          path: 'pgsl:level',
          message: `Fragment has ${frag.items.length} items but level ${frag.level}`,
          severity: 'violation',
        });
      }

      // Constituent integrity: for level >= 2, left and right must exist at level k-1
      if (frag.level >= 2) {
        if (!frag.left) {
          violations.push({
            node: frag.uri,
            shape: 'pgsl:ConstituentIntegrityShape',
            path: 'pgsl:leftConstituent',
            message: `Fragment at level ${frag.level} must have leftConstituent`,
            severity: 'violation',
          });
        } else {
          const leftNode = pgsl.nodes.get(frag.left);
          if (!leftNode) {
            violations.push({
              node: frag.uri,
              shape: 'pgsl:ConstituentIntegrityShape',
              path: 'pgsl:leftConstituent',
              message: `Left constituent ${frag.left} not found in repository`,
              severity: 'violation',
            });
          } else if (leftNode.kind !== 'Fragment' || (leftNode as Fragment).level !== frag.level - 1) {
            violations.push({
              node: frag.uri,
              shape: 'pgsl:ConstituentIntegrityShape',
              path: 'pgsl:leftConstituent',
              message: `Left constituent must be at level ${frag.level - 1}`,
              severity: 'violation',
            });
          }
        }

        if (!frag.right) {
          violations.push({
            node: frag.uri,
            shape: 'pgsl:ConstituentIntegrityShape',
            path: 'pgsl:rightConstituent',
            message: `Fragment at level ${frag.level} must have rightConstituent`,
            severity: 'violation',
          });
        } else {
          const rightNode = pgsl.nodes.get(frag.right);
          if (!rightNode) {
            violations.push({
              node: frag.uri,
              shape: 'pgsl:ConstituentIntegrityShape',
              path: 'pgsl:rightConstituent',
              message: `Right constituent ${frag.right} not found in repository`,
              severity: 'violation',
            });
          } else if (rightNode.kind !== 'Fragment' || (rightNode as Fragment).level !== frag.level - 1) {
            violations.push({
              node: frag.uri,
              shape: 'pgsl:ConstituentIntegrityShape',
              path: 'pgsl:rightConstituent',
              message: `Right constituent must be at level ${frag.level - 1}`,
              severity: 'violation',
            });
          }
        }
      }

      // Overlap validity: pullback overlap must match shared boundary
      if (frag.level >= 2 && frag.left && frag.right) {
        const pb = pullbackSquare(pgsl, frag.uri);
        if (pb) {
          const overlapNode = pgsl.nodes.get(pb.overlap);
          if (!overlapNode) {
            violations.push({
              node: frag.uri,
              shape: 'pgsl:OverlapValidityShape',
              path: 'pgsl:overlap',
              message: `Overlap node ${pb.overlap} not found in repository`,
              severity: 'violation',
            });
          }
        }
      }

      // Canonicity: no two fragments share the same item sequence
      const seqKey = frag.items.join('|');
      const existing = seenFragmentSequences.get(seqKey);
      if (existing && existing !== frag.uri) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:CanonicalityShape',
          message: `Duplicate fragment sequence — also at ${existing}`,
          severity: 'violation',
        });
      }
      seenFragmentSequences.set(seqKey, frag.uri);

      // Acyclicity: no fragment appears in its own transitive items
      if (hasTransitiveCycle(pgsl, frag.uri, frag.uri, new Set())) {
        violations.push({
          node: frag.uri,
          shape: 'pgsl:AcyclicityShape',
          message: 'Fragment appears in its own transitive items (cycle detected)',
          severity: 'violation',
        });
      }
    }
  }

  return { conforms: violations.length === 0, violations };
}

function hasTransitiveCycle(pgsl: PGSLInstance, target: IRI, current: IRI, visited: Set<IRI>): boolean {
  if (visited.has(current)) return false;
  visited.add(current);

  const node = pgsl.nodes.get(current);
  if (!node || node.kind === 'Atom') return false;
  const frag = node as Fragment;

  for (const item of frag.items) {
    if (item === target) return true;
    if (hasTransitiveCycle(pgsl, target, item, visited)) return true;
  }
  return false;
}

// ── Layer 3: Domain/User/App SHACL ─────────────────────────

/**
 * Validate user-defined domain shapes against the PGSL triple store.
 */
export function validateDomainShapes(
  pgsl: PGSLInstance,
  shapes: ShaclShapeDefinition[],
): ShaclValidationResult {
  const store = materializeTriples(pgsl);
  const violations: ShaclViolation[] = [];

  for (const shape of shapes) {
    // Find all instances of the target class
    const instances = matchPattern(store, undefined, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', shape.targetClass);

    for (const instance of instances) {
      const nodeUri = instance.subject;

      for (const constraint of shape.properties) {
        const triples = matchPattern(store, nodeUri, constraint.path, undefined);
        const count = triples.length;

        // minCount
        if (constraint.minCount !== undefined && count < constraint.minCount) {
          violations.push({
            node: nodeUri,
            shape: shape.name,
            path: constraint.path,
            message: constraint.message ?? `Expected minCount ${constraint.minCount}, found ${count}`,
            severity: 'violation',
          });
        }

        // maxCount
        if (constraint.maxCount !== undefined && count > constraint.maxCount) {
          violations.push({
            node: nodeUri,
            shape: shape.name,
            path: constraint.path,
            message: constraint.message ?? `Expected maxCount ${constraint.maxCount}, found ${count}`,
            severity: 'violation',
          });
        }

        // hasValue
        if (constraint.hasValue !== undefined) {
          const hasIt = triples.some(t => t.object === constraint.hasValue || stripVal(t.object) === constraint.hasValue);
          if (!hasIt && count > 0) {
            violations.push({
              node: nodeUri,
              shape: shape.name,
              path: constraint.path,
              message: constraint.message ?? `Expected value ${constraint.hasValue}`,
              severity: 'violation',
            });
          }
        }

        // in (enumeration)
        if (constraint.in !== undefined) {
          for (const triple of triples) {
            const val = stripVal(triple.object);
            if (!constraint.in.includes(val) && !constraint.in.includes(triple.object)) {
              violations.push({
                node: nodeUri,
                shape: shape.name,
                path: constraint.path,
                message: constraint.message ?? `Value "${val}" not in allowed values [${constraint.in.join(', ')}]`,
                severity: 'violation',
              });
            }
          }
        }

        // pattern (regex)
        if (constraint.pattern !== undefined) {
          for (const triple of triples) {
            const val = stripVal(triple.object);
            if (!new RegExp(constraint.pattern).test(val)) {
              violations.push({
                node: nodeUri,
                shape: shape.name,
                path: constraint.path,
                message: constraint.message ?? `Value "${val}" does not match pattern /${constraint.pattern}/`,
                severity: 'violation',
              });
            }
          }
        }

        // minInclusive / maxInclusive
        if (constraint.minInclusive !== undefined || constraint.maxInclusive !== undefined) {
          for (const triple of triples) {
            const num = parseFloat(stripVal(triple.object));
            if (!isNaN(num)) {
              if (constraint.minInclusive !== undefined && num < constraint.minInclusive) {
                violations.push({
                  node: nodeUri,
                  shape: shape.name,
                  path: constraint.path,
                  message: constraint.message ?? `Value ${num} < minInclusive ${constraint.minInclusive}`,
                  severity: 'violation',
                });
              }
              if (constraint.maxInclusive !== undefined && num > constraint.maxInclusive) {
                violations.push({
                  node: nodeUri,
                  shape: shape.name,
                  path: constraint.path,
                  message: constraint.message ?? `Value ${num} > maxInclusive ${constraint.maxInclusive}`,
                  severity: 'violation',
                });
              }
            }
          }
        }

        // class constraint
        if (constraint.class !== undefined) {
          for (const triple of triples) {
            const typeTriples = matchPattern(store, triple.object, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', constraint.class);
            if (typeTriples.length === 0) {
              violations.push({
                node: nodeUri,
                shape: shape.name,
                path: constraint.path,
                message: constraint.message ?? `Object ${triple.object} is not of class ${constraint.class}`,
                severity: 'violation',
              });
            }
          }
        }
      }

      // SPARQL-based constraints
      if (shape.sparqlConstraints) {
        for (const sparql of shape.sparqlConstraints) {
          // Replace $this with the node URI
          const instantiated = sparql.replace(/\$this/g, `<${nodeUri}>`);
          const result = executeSparqlString(store, instantiated);
          // SPARQL constraint: if ASK returns false, it's a violation
          if (result.boolean === false) {
            violations.push({
              node: nodeUri,
              shape: shape.name,
              message: `SPARQL constraint failed: ${sparql.substring(0, 80)}...`,
              severity: 'violation',
            });
          }
        }
      }
    }
  }

  return { conforms: violations.length === 0, violations };
}

function stripVal(s: string): string {
  if (s.startsWith('"')) {
    const endQuote = s.indexOf('"', 1);
    if (endQuote > 0) return s.substring(1, endQuote);
  }
  return s;
}

// ── Turtle Export for Domain Shapes ────────────────────────

/**
 * Serialize user-defined domain shapes as SHACL Turtle
 * for interop with external SHACL engines.
 */
export function domainShapesToTurtle(shapes: ShaclShapeDefinition[]): string {
  const lines: string[] = [
    `@prefix sh: <http://www.w3.org/ns/shacl#> .`,
    `@prefix pgsl: <${PGSL_NS}> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
    '',
  ];

  for (const shape of shapes) {
    lines.push(`<urn:shape:${shape.name}> a sh:NodeShape ;`);
    lines.push(`    sh:targetClass <${shape.targetClass}> ;`);

    for (let i = 0; i < shape.properties.length; i++) {
      const prop = shape.properties[i]!;
      const isLast = i === shape.properties.length - 1 && !shape.sparqlConstraints?.length;
      lines.push(`    sh:property [`);
      lines.push(`        sh:path <${prop.path}> ;`);
      if (prop.minCount !== undefined) lines.push(`        sh:minCount ${prop.minCount} ;`);
      if (prop.maxCount !== undefined) lines.push(`        sh:maxCount ${prop.maxCount} ;`);
      if (prop.datatype) lines.push(`        sh:datatype <${prop.datatype}> ;`);
      if (prop.class) lines.push(`        sh:class <${prop.class}> ;`);
      if (prop.hasValue !== undefined) lines.push(`        sh:hasValue "${prop.hasValue}" ;`);
      if (prop.minInclusive !== undefined) lines.push(`        sh:minInclusive ${prop.minInclusive} ;`);
      if (prop.maxInclusive !== undefined) lines.push(`        sh:maxInclusive ${prop.maxInclusive} ;`);
      if (prop.pattern) lines.push(`        sh:pattern "${prop.pattern}" ;`);
      if (prop.in) {
        lines.push(`        sh:in ( ${prop.in.map(v => `"${v}"`).join(' ')} ) ;`);
      }
      if (prop.message) lines.push(`        sh:message "${prop.message}" ;`);
      lines.push(`    ]${isLast ? ' .' : ' ;'}`);
    }

    if (!shape.properties.length) {
      lines[lines.length - 1] = lines[lines.length - 1]!.replace(';', '.');
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ── Convenience: validate all layers ───────────────────────

/**
 * Run all three SHACL validation layers.
 */
export function validateAllPGSL(
  pgsl: PGSLInstance,
  domainShapes?: ShaclShapeDefinition[],
): ShaclValidationResult {
  const core = validateCorePGSL(pgsl);
  const structural = validateStructuralPGSL(pgsl);
  const domain = domainShapes ? validateDomainShapes(pgsl, domainShapes) : { conforms: true, violations: [] as ShaclViolation[] };

  const allViolations = [...core.violations, ...structural.violations, ...domain.violations];
  return {
    conforms: allViolations.length === 0,
    violations: allViolations,
  };
}
