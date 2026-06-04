import { describe, it, expect, beforeEach } from 'vitest';
import {
  domainShapesToTurtle,
  PGSL_NS,
  PGSLClass,
  PGSLProp,
  validateAllPGSL,
  validateCorePGSL,
  validateDomainShapes,
  validateStructuralPGSL,
} from '@interego/pgsl';
import {
  createPGSL,
  ingest,
} from '@interego/pgsl';
import type {
  PGSLInstance,
} from '@interego/pgsl';
import type {
  ShaclShapeDefinition,
} from '@interego/pgsl';
import type {
  IRI,
} from '@interego/core';

describe('PGSL SHACL Validation', () => {
  let pgsl: PGSLInstance;

  beforeEach(() => {
    pgsl = createPGSL({
      wasAttributedTo: 'urn:test:agent' as IRI,
      generatedAtTime: '2026-01-01T00:00:00Z',
    });
    ingest(pgsl, ['the', 'cat', 'sat']);
  });

  describe('Layer 1: Core PGSL SHACL', () => {
    it('valid lattice conforms', () => {
      const result = validateCorePGSL(pgsl);
      expect(result.conforms).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('detects atom without provenance', () => {
      // Create a corrupted atom (we'll manipulate the internal state)
      const corruptedPgsl = createPGSL({
        wasAttributedTo: '' as IRI,
        generatedAtTime: '2026-01-01T00:00:00Z',
      });
      ingest(corruptedPgsl, ['test']);
      // The atom was created with empty wasAttributedTo
      const result = validateCorePGSL(corruptedPgsl);
      // Empty string is falsy
      expect(result.violations.some(v => v.path === 'prov:wasAttributedTo')).toBe(true);
    });
  });

  describe('Layer 2: Structural PGSL SHACL', () => {
    it('valid lattice conforms', () => {
      const result = validateStructuralPGSL(pgsl);
      expect(result.conforms).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('detects canonicity — no duplicate atoms', () => {
      // A properly constructed PGSL won't have duplicates,
      // so this should pass
      const result = validateStructuralPGSL(pgsl);
      const canonViolations = result.violations.filter(v => v.shape === 'pgsl:CanonicalityShape');
      expect(canonViolations.length).toBe(0);
    });

    it('validates level consistency', () => {
      const result = validateStructuralPGSL(pgsl);
      const levelViolations = result.violations.filter(v => v.shape === 'pgsl:LevelConsistencyShape');
      expect(levelViolations.length).toBe(0);
    });

    it('validates constituent integrity', () => {
      const result = validateStructuralPGSL(pgsl);
      const constViolations = result.violations.filter(v => v.shape === 'pgsl:ConstituentIntegrityShape');
      expect(constViolations.length).toBe(0);
    });

    it('validates acyclicity', () => {
      const result = validateStructuralPGSL(pgsl);
      const cycleViolations = result.violations.filter(v => v.shape === 'pgsl:AcyclicityShape');
      expect(cycleViolations.length).toBe(0);
    });
  });

  describe('Layer 3: Domain SHACL', () => {
    it('validates custom shape — minCount', () => {
      const shapes: ShaclShapeDefinition[] = [{
        name: 'AtomMustHaveValue',
        targetClass: PGSLClass.Atom,
        properties: [{
          path: PGSLProp.value,
          minCount: 1,
          message: 'Every atom must have a value',
        }],
      }];
      const result = validateDomainShapes(pgsl, shapes);
      expect(result.conforms).toBe(true);
    });

    it('validates custom shape — maxCount violation', () => {
      const shapes: ShaclShapeDefinition[] = [{
        name: 'FragmentMaxItems',
        targetClass: PGSLClass.Fragment,
        properties: [{
          path: PGSLProp.item,
          maxCount: 1,
          message: 'Fragment must have at most 1 item',
        }],
      }];
      const result = validateDomainShapes(pgsl, shapes);
      // Fragments at level 2+ have more than 1 item
      expect(result.conforms).toBe(false);
      expect(result.violations.some(v => v.shape === 'FragmentMaxItems')).toBe(true);
    });

    it('validates custom shape — hasValue', () => {
      const shapes: ShaclShapeDefinition[] = [{
        name: 'AtomLevelZero',
        targetClass: PGSLClass.Atom,
        properties: [{
          path: PGSLProp.level,
          hasValue: '0',
        }],
      }];
      const result = validateDomainShapes(pgsl, shapes);
      expect(result.conforms).toBe(true);
    });
  });

  describe('All Layers Combined', () => {
    it('valid lattice passes all layers', () => {
      const result = validateAllPGSL(pgsl);
      expect(result.conforms).toBe(true);
    });

    it('valid lattice passes with domain shapes', () => {
      const shapes: ShaclShapeDefinition[] = [{
        name: 'BasicAtomCheck',
        targetClass: PGSLClass.Atom,
        properties: [{
          path: PGSLProp.value,
          minCount: 1,
        }],
      }];
      const result = validateAllPGSL(pgsl, shapes);
      expect(result.conforms).toBe(true);
    });
  });

  describe('Turtle Export', () => {
    it('exports domain shapes as valid Turtle', () => {
      const shapes: ShaclShapeDefinition[] = [{
        name: 'TestShape',
        targetClass: PGSLClass.Atom,
        properties: [{
          path: PGSLProp.value,
          minCount: 1,
          maxCount: 1,
          message: 'Must have exactly one value',
        }],
      }];
      const turtle = domainShapesToTurtle(shapes);
      expect(turtle).toContain('sh:NodeShape');
      expect(turtle).toContain('sh:targetClass');
      expect(turtle).toContain('sh:minCount 1');
      expect(turtle).toContain('sh:maxCount 1');
    });
  });
});
