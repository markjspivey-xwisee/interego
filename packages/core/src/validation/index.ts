export { validate, assertValid } from './validator.js';
export { getShaclShapesTurtle, SHACL_SHAPES_TURTLE } from './shacl-shapes.js';
export { evaluateNodeExpression, type NodeExpressionContext } from './node-expression.js';
export { runSparql, SparqlRefusedError, type Binding, type SparqlQueryResult } from './sparql-query.js';
export {
  validateAgainstShape,
  nodeConformsToShape,
  evaluateExpression,
  renderPathTerm,
  runShaclRules,
  ShaclRuleError,
  type ShaclReport,
  type ShaclResult,
  type ShaclRuleRun,
  type ShaclSeverity,
  type ValidateAgainstShapeOptions,
} from './shacl-engine.js';
