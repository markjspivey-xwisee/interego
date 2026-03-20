/**
 * @module validation/validator
 * @description Validation logic for Context Graphs 1.0
 *
 * Implements the SHACL shape constraints from §6 as programmatic
 * validation (no external SHACL engine dependency). This provides
 * a zero-dependency validation path suitable for edge/browser
 * environments. For full SHACL validation with a conformant engine,
 * use the shapes from shacl-shapes.ts.
 */

import type {
  ContextDescriptorData,
  ContextFacetData,
  TemporalFacetData,
  ProvenanceFacetData,
  SemioticFacetData,
  TrustFacetData,
  AccessControlFacetData,
  ValidationResult,
  ValidationViolation,
  ComposedDescriptorData,
} from '../model/types.js';

// ── Validation helpers ───────────────────────────────────────

function violation(path: string, message: string): ValidationViolation {
  return { path, message, severity: 'violation' };
}

function isValidDateTime(dt: string): boolean {
  const d = new Date(dt);
  return !isNaN(d.getTime());
}

function isValidDuration(dur: string): boolean {
  return /^P(\d+Y)?(\d+M)?(\d+D)?(T(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(dur);
}

// ── Facet validators ─────────────────────────────────────────

function validateTemporalFacet(
  f: TemporalFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];

  if (f.validFrom && !isValidDateTime(f.validFrom)) {
    v.push(violation(`${path}/validFrom`, `Invalid xsd:dateTime: "${f.validFrom}"`));
  }
  if (f.validUntil && !isValidDateTime(f.validUntil)) {
    v.push(violation(`${path}/validUntil`, `Invalid xsd:dateTime: "${f.validUntil}"`));
  }
  if (f.validFrom && f.validUntil) {
    if (new Date(f.validUntil) <= new Date(f.validFrom)) {
      v.push(violation(
        `${path}`,
        `validUntil (${f.validUntil}) MUST be after validFrom (${f.validFrom})`
      ));
    }
  }
  if (f.temporalResolution && !isValidDuration(f.temporalResolution)) {
    v.push(violation(
      `${path}/temporalResolution`,
      `Invalid xsd:duration: "${f.temporalResolution}"`
    ));
  }

  return v;
}

function validateProvenanceFacet(
  f: ProvenanceFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];

  if (f.generatedAtTime && !isValidDateTime(f.generatedAtTime)) {
    v.push(violation(`${path}/generatedAtTime`, `Invalid xsd:dateTime: "${f.generatedAtTime}"`));
  }
  if (f.wasGeneratedBy) {
    if (f.wasGeneratedBy.startedAt && !isValidDateTime(f.wasGeneratedBy.startedAt)) {
      v.push(violation(`${path}/wasGeneratedBy/startedAt`, `Invalid xsd:dateTime`));
    }
    if (f.wasGeneratedBy.endedAt && !isValidDateTime(f.wasGeneratedBy.endedAt)) {
      v.push(violation(`${path}/wasGeneratedBy/endedAt`, `Invalid xsd:dateTime`));
    }
  }

  return v;
}

const VALID_MODAL_STATUSES = new Set([
  'Asserted', 'Hypothetical', 'Counterfactual', 'Quoted', 'Retracted',
]);

function validateSemioticFacet(
  f: SemioticFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];

  if (f.modalStatus && !VALID_MODAL_STATUSES.has(f.modalStatus)) {
    v.push(violation(
      `${path}/modalStatus`,
      `Invalid modal status "${f.modalStatus}". ` +
      `Must be one of: ${[...VALID_MODAL_STATUSES].join(', ')}`
    ));
  }

  if (f.epistemicConfidence !== undefined) {
    if (f.epistemicConfidence < 0 || f.epistemicConfidence > 1) {
      v.push(violation(
        `${path}/epistemicConfidence`,
        `epistemicConfidence must be in [0.0, 1.0], got ${f.epistemicConfidence}`
      ));
    }
  }

  return v;
}

const VALID_TRUST_LEVELS = new Set([
  'SelfAsserted', 'ThirdPartyAttested', 'CryptographicallyVerified',
]);

function validateTrustFacet(
  f: TrustFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];

  if (f.trustLevel && !VALID_TRUST_LEVELS.has(f.trustLevel)) {
    v.push(violation(
      `${path}/trustLevel`,
      `Invalid trust level "${f.trustLevel}". ` +
      `Must be one of: ${[...VALID_TRUST_LEVELS].join(', ')}`
    ));
  }

  return v;
}

function validateAccessControlFacet(
  f: AccessControlFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];
  const validModes = new Set(['Read', 'Write', 'Append', 'Control']);

  for (let i = 0; i < f.authorizations.length; i++) {
    const auth = f.authorizations[i]!;
    if (!auth.agent && !auth.agentClass) {
      v.push(violation(
        `${path}/authorizations[${i}]`,
        'Authorization must specify at least agent or agentClass'
      ));
    }
    if (auth.mode.length === 0) {
      v.push(violation(
        `${path}/authorizations[${i}]/mode`,
        'Authorization must specify at least one acl:mode'
      ));
    }
    for (const m of auth.mode) {
      if (!validModes.has(m)) {
        v.push(violation(
          `${path}/authorizations[${i}]/mode`,
          `Invalid ACL mode "${m}". Must be one of: ${[...validModes].join(', ')}`
        ));
      }
    }
  }

  return v;
}

function validateFacet(
  f: ContextFacetData,
  index: number
): ValidationViolation[] {
  const path = `facets[${index}]`;

  switch (f.type) {
    case 'Temporal':      return validateTemporalFacet(f, path);
    case 'Provenance':    return validateProvenanceFacet(f, path);
    case 'Semiotic':      return validateSemioticFacet(f, path);
    case 'Trust':         return validateTrustFacet(f, path);
    case 'AccessControl': return validateAccessControlFacet(f, path);
    default:
      return [];
  }
}

// ── Main Validator ───────────────────────────────────────────

/**
 * Validate a ContextDescriptorData against the SHACL shapes from §6.
 *
 * This implements the constraints programmatically for zero-dependency
 * usage. For full SHACL conformance, use the shapes from
 * `getShaclShapesTurtle()` with a SHACL engine.
 */
export function validate(descriptor: ContextDescriptorData): ValidationResult {
  const violations: ValidationViolation[] = [];

  // §6: ContextDescriptorShape — MUST have at least one facet
  if (!descriptor.facets || descriptor.facets.length === 0) {
    violations.push(violation(
      'facets',
      'A ContextDescriptor MUST have at least one facet (cg:hasFacet minCount 1)'
    ));
  }

  // §6: ContextDescriptorShape — MUST describe at least one Named Graph
  if (!descriptor.describes || descriptor.describes.length === 0) {
    violations.push(violation(
      'describes',
      'A ContextDescriptor MUST describe at least one Named Graph (cg:describes minCount 1)'
    ));
  }

  // Validate ID is present
  if (!descriptor.id) {
    violations.push(violation('id', 'ContextDescriptor MUST have an IRI identifier'));
  }

  // Version must be non-negative integer
  if (descriptor.version !== undefined) {
    if (!Number.isInteger(descriptor.version) || descriptor.version < 0) {
      violations.push(violation(
        'version',
        `version must be a non-negative integer, got ${descriptor.version}`
      ));
    }
  }

  // Administrative validity: validUntil > validFrom
  if (descriptor.validFrom && descriptor.validUntil) {
    if (!isValidDateTime(descriptor.validFrom)) {
      violations.push(violation('validFrom', `Invalid xsd:dateTime: "${descriptor.validFrom}"`));
    }
    if (!isValidDateTime(descriptor.validUntil)) {
      violations.push(violation('validUntil', `Invalid xsd:dateTime: "${descriptor.validUntil}"`));
    }
    if (isValidDateTime(descriptor.validFrom) && isValidDateTime(descriptor.validUntil)) {
      if (new Date(descriptor.validUntil) <= new Date(descriptor.validFrom)) {
        violations.push(violation(
          'validFrom/validUntil',
          'validUntil MUST be after validFrom when both are present'
        ));
      }
    }
  }

  // §6: ComposedDescriptorShape
  if ('compositionOp' in descriptor) {
    const comp = descriptor as ComposedDescriptorData;
    const validOps = new Set(['union', 'intersection', 'restriction', 'override']);
    if (!validOps.has(comp.compositionOp)) {
      violations.push(violation(
        'compositionOp',
        `Invalid composition operator "${comp.compositionOp}"`
      ));
    }
    if (!comp.operands || comp.operands.length === 0) {
      violations.push(violation(
        'operands',
        'ComposedDescriptor MUST have at least one operand'
      ));
    }
  }

  // Validate each facet
  for (let i = 0; i < (descriptor.facets?.length ?? 0); i++) {
    violations.push(...validateFacet(descriptor.facets[i]!, i));
  }

  return {
    conforms: violations.filter(v => v.severity === 'violation').length === 0,
    violations,
  };
}

/**
 * Validate and throw if non-conformant.
 */
export function assertValid(descriptor: ContextDescriptorData): void {
  const result = validate(descriptor);
  if (!result.conforms) {
    const messages = result.violations
      .filter(v => v.severity === 'violation')
      .map(v => `  [${v.path}] ${v.message}`)
      .join('\n');
    throw new Error(`Context Descriptor validation failed:\n${messages}`);
  }
}
