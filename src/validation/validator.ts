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
  CausalFacetData,
  ProjectionFacetData,
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

const VALID_CAUSAL_ROLES = new Set([
  'Observation', 'Intervention', 'Counterfactual',
]);

function validateCausalFacet(
  f: CausalFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];

  if (!f.causalRole) {
    v.push(violation(`${path}/causalRole`, 'Causal facet MUST specify a causalRole'));
  } else if (!VALID_CAUSAL_ROLES.has(f.causalRole)) {
    v.push(violation(
      `${path}/causalRole`,
      `Invalid causal role "${f.causalRole}". Must be one of: ${[...VALID_CAUSAL_ROLES].join(', ')}`
    ));
  }

  // Interventions required for Intervention and Counterfactual roles
  if (f.causalRole === 'Intervention') {
    if (!f.interventions || f.interventions.length === 0) {
      v.push(violation(
        `${path}/interventions`,
        'Intervention role requires at least one intervention (do-operator application)'
      ));
    }
    if (!f.parentObservation) {
      v.push(violation(
        `${path}/parentObservation`,
        'Intervention must reference the parent observational descriptor'
      ));
    }
  }

  if (f.causalRole === 'Counterfactual') {
    if (!f.counterfactualQuery) {
      v.push(violation(
        `${path}/counterfactualQuery`,
        'Counterfactual role requires a counterfactual query'
      ));
    }
    if (!f.parentObservation) {
      v.push(violation(
        `${path}/parentObservation`,
        'Counterfactual must reference the parent observational descriptor'
      ));
    }
  }

  if (f.causalConfidence !== undefined) {
    if (f.causalConfidence < 0 || f.causalConfidence > 1) {
      v.push(violation(
        `${path}/causalConfidence`,
        `causalConfidence must be in [0.0, 1.0], got ${f.causalConfidence}`
      ));
    }
  }

  // Validate inline SCM if provided
  if (f.causalModelData) {
    const scm = f.causalModelData;
    if (!scm.variables || scm.variables.length === 0) {
      v.push(violation(`${path}/causalModelData/variables`, 'SCM must have at least one variable'));
    }
    const varNames = new Set(scm.variables.map(vv => vv.name));
    for (let i = 0; i < scm.edges.length; i++) {
      const e = scm.edges[i]!;
      if (!varNames.has(e.from)) {
        v.push(violation(`${path}/causalModelData/edges[${i}]/from`, `Edge references unknown variable "${e.from}"`));
      }
      if (!varNames.has(e.to)) {
        v.push(violation(`${path}/causalModelData/edges[${i}]/to`, `Edge references unknown variable "${e.to}"`));
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
    case 'Causal':        return validateCausalFacet(f, path);
    case 'Projection':    return validateProjectionFacet(f, path);
    default:
      return [];
  }
}

const VALID_BINDING_STRENGTHS = new Set(['Exact', 'Strong', 'Approximate', 'Weak']);
const VALID_MAPPING_TYPES = new Set(['class', 'property']);
const VALID_MAPPING_RELATIONSHIPS = new Set(['exact', 'broader', 'narrower', 'related']);

function validateProjectionFacet(
  f: ProjectionFacetData,
  path: string
): ValidationViolation[] {
  const v: ValidationViolation[] = [];

  if (f.bindings) {
    for (let i = 0; i < f.bindings.length; i++) {
      const b = f.bindings[i]!;
      if (!b.source) v.push(violation(`${path}/bindings[${i}]/source`, 'Binding must have a source IRI'));
      if (!b.target) v.push(violation(`${path}/bindings[${i}]/target`, 'Binding must have a target IRI'));
      if (!VALID_BINDING_STRENGTHS.has(b.strength)) {
        v.push(violation(`${path}/bindings[${i}]/strength`, `Invalid binding strength "${b.strength}". Must be one of: ${[...VALID_BINDING_STRENGTHS].join(', ')}`));
      }
      if (b.confidence !== undefined && (b.confidence < 0 || b.confidence > 1)) {
        v.push(violation(`${path}/bindings[${i}]/confidence`, `confidence must be in [0.0, 1.0], got ${b.confidence}`));
      }
    }
  }

  if (f.vocabularyMappings) {
    for (let i = 0; i < f.vocabularyMappings.length; i++) {
      const m = f.vocabularyMappings[i]!;
      if (!m.source) v.push(violation(`${path}/vocabularyMappings[${i}]/source`, 'Mapping must have a source IRI'));
      if (!m.target) v.push(violation(`${path}/vocabularyMappings[${i}]/target`, 'Mapping must have a target IRI'));
      if (!VALID_MAPPING_TYPES.has(m.mappingType)) {
        v.push(violation(`${path}/vocabularyMappings[${i}]/mappingType`, `Invalid mapping type "${m.mappingType}"`));
      }
      if (!VALID_MAPPING_RELATIONSHIPS.has(m.relationship)) {
        v.push(violation(`${path}/vocabularyMappings[${i}]/relationship`, `Invalid relationship "${m.relationship}"`));
      }
    }
  }

  return v;
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
