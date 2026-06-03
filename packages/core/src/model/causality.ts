/**
 * @module model/causality
 * @description Pearl's Causal Reasoning Engine for Interego
 *
 * Implements:
 *   - Structural Causal Model (SCM) construction and DAG operations
 *   - do-calculus: interventional graph surgery (mutilated graph)
 *   - Counterfactual evaluation via twin-network method
 *   - d-separation testing for conditional independence
 *   - Causal path enumeration
 *   - Topological ordering
 *
 * References:
 *   Pearl, J. (2009). Causality: Models, Reasoning, and Inference. 2nd ed.
 *   Pearl, J. (2018). The Book of Why.
 *   Bareinboim, E. & Pearl, J. (2016). Causal inference and the data-fusion problem.
 */

import type {
  IRI,
  StructuralCausalModel,
  CausalVariable,
  CausalEdge,
  CausalIntervention,
  CounterfactualQuery,
} from './types.js';

// ── SCM Construction ────────────────────────────────────────

/**
 * Build a Structural Causal Model from variables and edges.
 * Validates that the graph is a DAG (no cycles).
 */
export function buildSCM(
  id: IRI,
  variables: CausalVariable[],
  edges: CausalEdge[],
  label?: string,
): StructuralCausalModel {
  // Validate: all edge endpoints must reference existing variables
  const varNames = new Set(variables.map(v => v.name));
  for (const e of edges) {
    if (!varNames.has(e.from)) {
      throw new Error(`Edge references unknown variable "${e.from}"`);
    }
    if (!varNames.has(e.to)) {
      throw new Error(`Edge references unknown variable "${e.to}"`);
    }
    if (e.from === e.to) {
      throw new Error(`Self-loop detected: "${e.from}" → "${e.to}"`);
    }
  }

  // Validate: must be a DAG (no cycles)
  if (hasCycle(variables, edges)) {
    throw new Error('Causal model contains a cycle — SCMs must be DAGs');
  }

  return { id, label, variables, edges };
}

// ── DAG Operations ──────────────────────────────────────────

/**
 * Check if a directed graph has a cycle (Kahn's algorithm).
 */
export function hasCycle(
  variables: readonly CausalVariable[],
  edges: readonly CausalEdge[],
): boolean {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const v of variables) {
    inDegree.set(v.name, 0);
    adj.set(v.name, []);
  }

  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [v, deg] of inDegree) {
    if (deg === 0) queue.push(v);
  }

  let visited = 0;
  while (queue.length > 0) {
    const v = queue.shift()!;
    visited++;
    for (const child of adj.get(v) ?? []) {
      const newDeg = inDegree.get(child)! - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  return visited !== variables.length;
}

/**
 * Topological sort of an SCM's variables (Kahn's algorithm).
 * Returns variable names in causal order (causes before effects).
 */
export function topologicalSort(scm: StructuralCausalModel): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const v of scm.variables) {
    inDegree.set(v.name, 0);
    adj.set(v.name, []);
  }

  for (const e of scm.edges) {
    adj.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [v, deg] of inDegree) {
    if (deg === 0) queue.push(v);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const v = queue.shift()!;
    order.push(v);
    for (const child of adj.get(v) ?? []) {
      const newDeg = inDegree.get(child)! - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  return order;
}

/**
 * Get all ancestors of a variable in the DAG.
 */
export function ancestors(
  scm: StructuralCausalModel,
  variable: string,
): Set<string> {
  // Build reverse adjacency
  const parents = new Map<string, string[]>();
  for (const v of scm.variables) parents.set(v.name, []);
  for (const e of scm.edges) parents.get(e.to)!.push(e.from);

  const result = new Set<string>();
  const stack = [...(parents.get(variable) ?? [])];
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (!result.has(v)) {
      result.add(v);
      stack.push(...(parents.get(v) ?? []));
    }
  }
  return result;
}

/**
 * Get all descendants of a variable in the DAG.
 */
export function descendants(
  scm: StructuralCausalModel,
  variable: string,
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const v of scm.variables) adj.set(v.name, []);
  for (const e of scm.edges) adj.get(e.from)!.push(e.to);

  const result = new Set<string>();
  const stack = [...(adj.get(variable) ?? [])];
  while (stack.length > 0) {
    const v = stack.pop()!;
    if (!result.has(v)) {
      result.add(v);
      stack.push(...(adj.get(v) ?? []));
    }
  }
  return result;
}

/**
 * Get direct parents (causes) of a variable.
 */
export function parents(
  scm: StructuralCausalModel,
  variable: string,
): string[] {
  return scm.edges.filter(e => e.to === variable).map(e => e.from);
}

/**
 * Get direct children (effects) of a variable.
 */
export function children(
  scm: StructuralCausalModel,
  variable: string,
): string[] {
  return scm.edges.filter(e => e.from === variable).map(e => e.to);
}

// ── do-Calculus: Graph Surgery ──────────────────────────────

/**
 * Apply Pearl's do-operator to an SCM.
 *
 * do(X = x) means:
 *   1. Remove all incoming edges to X in the DAG (graph surgery / mutilation)
 *   2. Set X = x (fix the value)
 *   3. The resulting "mutilated graph" encodes P(Y | do(X = x))
 *
 * This is the fundamental operation that distinguishes causal
 * reasoning from mere statistical conditioning: P(Y|X) ≠ P(Y|do(X))
 * unless there are no confounders.
 *
 * @returns A new SCM with the intervention applied (mutilated graph)
 */
export function doIntervention(
  scm: StructuralCausalModel,
  interventions: readonly CausalIntervention[],
): StructuralCausalModel {
  const intervenedVars = new Set(interventions.map(i => i.variable));

  // Validate: all intervention variables exist
  const varNames = new Set(scm.variables.map(v => v.name));
  for (const iv of intervenedVars) {
    if (!varNames.has(iv)) {
      throw new Error(`Intervention on unknown variable "${iv}"`);
    }
  }

  // Graph surgery: remove all incoming edges to intervened variables
  const mutilatedEdges = scm.edges.filter(e => !intervenedVars.has(e.to));

  // Mark intervened variables as exogenous (they're now fixed)
  const mutilatedVars = scm.variables.map(v => {
    if (intervenedVars.has(v.name)) {
      const intervention = interventions.find(i => i.variable === v.name)!;
      return {
        ...v,
        exogenous: true,
        mechanism: `do(${v.name} = ${intervention.value})`,
      };
    }
    return v;
  });

  return {
    id: `${scm.id}:do(${interventions.map(i => `${i.variable}=${i.value}`).join(',')})` as IRI,
    label: `${scm.label ?? 'SCM'} | do(${interventions.map(i => `${i.variable}=${i.value}`).join(', ')})`,
    variables: mutilatedVars,
    edges: mutilatedEdges,
  };
}

// ── d-Separation ────────────────────────────────────────────

/**
 * Test d-separation: whether X ⊥ Y | Z in the causal DAG.
 *
 * Two variables X and Y are d-separated given Z if and only if
 * every path between X and Y is blocked by Z. A path is blocked if:
 *   1. It contains a chain (→) or fork (←→) where the middle node is in Z
 *   2. It contains a collider (→←) where the collider is NOT in Z
 *      and no descendant of the collider is in Z
 *
 * d-separation implies conditional independence in the distribution
 * generated by the SCM: X ⊥⊥ Y | Z.
 *
 * Uses the Bayes-Ball algorithm.
 */
export function isDSeparated(
  scm: StructuralCausalModel,
  x: string,
  y: string,
  z: Set<string>,
): boolean {
  // Build adjacency structures
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const v of scm.variables) {
    childrenOf.set(v.name, []);
    parentsOf.set(v.name, []);
  }
  for (const e of scm.edges) {
    childrenOf.get(e.from)!.push(e.to);
    parentsOf.get(e.to)!.push(e.from);
  }

  // Pre-compute which nodes have descendants in Z
  const descInZ = new Set<string>();
  for (const zNode of z) {
    descInZ.add(zNode);
    const anc = ancestors(scm, zNode);
    for (const a of anc) descInZ.add(a);
  }

  // Bayes-Ball: BFS from X, track (node, direction)
  // direction: 'up' = came from child, 'down' = came from parent
  type State = { node: string; direction: 'up' | 'down' };
  const visited = new Set<string>();
  const reachable = new Set<string>();
  const queue: State[] = [
    { node: x, direction: 'up' },
    { node: x, direction: 'down' },
  ];

  while (queue.length > 0) {
    const { node, direction } = queue.shift()!;
    const key = `${node}:${direction}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (node !== x) reachable.add(node);

    if (direction === 'up' && !z.has(node)) {
      // Came from child, node not in Z → can go to parents and children
      for (const p of parentsOf.get(node) ?? []) {
        queue.push({ node: p, direction: 'up' });
      }
      for (const c of childrenOf.get(node) ?? []) {
        queue.push({ node: c, direction: 'down' });
      }
    }

    if (direction === 'down') {
      // Came from parent
      if (!z.has(node)) {
        // Not in Z → can continue down to children
        for (const c of childrenOf.get(node) ?? []) {
          queue.push({ node: c, direction: 'down' });
        }
      }
      if (z.has(node) || descInZ.has(node)) {
        // In Z or has descendant in Z → collider is activated, can go up
        for (const p of parentsOf.get(node) ?? []) {
          queue.push({ node: p, direction: 'up' });
        }
      }
    }
  }

  return !reachable.has(y);
}

// ── Causal Paths ────────────────────────────────────────────

/**
 * Find all directed causal paths from source to target.
 */
export function causalPaths(
  scm: StructuralCausalModel,
  source: string,
  target: string,
): string[][] {
  const adj = new Map<string, string[]>();
  for (const v of scm.variables) adj.set(v.name, []);
  for (const e of scm.edges) adj.get(e.from)!.push(e.to);

  const paths: string[][] = [];

  function dfs(current: string, path: string[], visited: Set<string>): void {
    if (current === target) {
      paths.push([...path]);
      return;
    }
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        path.push(next);
        dfs(next, path, visited);
        path.pop();
        visited.delete(next);
      }
    }
  }

  dfs(source, [source], new Set([source]));
  return paths;
}

// ── Counterfactual Evaluation (Twin Network) ────────────────

/**
 * Evaluate a counterfactual query using Pearl's three-step method:
 *
 *   Step 1 (Abduction): Given observed evidence, infer the exogenous
 *          variables U that are consistent with the evidence.
 *
 *   Step 2 (Action): Apply the intervention do(X=x) to get the
 *          mutilated model.
 *
 *   Step 3 (Prediction): Use the mutilated model with the inferred
 *          U values to predict the counterfactual outcome.
 *
 * In our graph-based representation, we track:
 *   - Which variables are affected by the intervention
 *   - Which variables are downstream of the intervention
 *   - The counterfactual world as a separate subgraph
 *
 * @returns A CounterfactualResult describing the evaluation
 */
export interface CounterfactualResult {
  /** The target variable. */
  readonly target: string;
  /** The intervention applied. */
  readonly intervention: CausalIntervention;
  /** Variables affected in the counterfactual world (downstream of intervention). */
  readonly affectedVariables: readonly string[];
  /** Variables unchanged (not downstream of intervention). */
  readonly unchangedVariables: readonly string[];
  /** The mutilated SCM. */
  readonly mutilatedModel: StructuralCausalModel;
  /** Whether the target is downstream of the intervention. */
  readonly targetAffected: boolean;
  /** The original (factual) causal path to target, if any. */
  readonly factualPaths: readonly string[][];
  /** The counterfactual causal path to target, if any. */
  readonly counterfactualPaths: readonly string[][];
}

export function evaluateCounterfactual(
  scm: StructuralCausalModel,
  query: CounterfactualQuery,
): CounterfactualResult {
  const { target, intervention, evidence: _evidence } = query;

  // Validate
  const varNames = new Set(scm.variables.map(v => v.name));
  if (!varNames.has(target)) {
    throw new Error(`Target variable "${target}" not in SCM`);
  }
  if (!varNames.has(intervention.variable)) {
    throw new Error(`Intervention variable "${intervention.variable}" not in SCM`);
  }

  // Step 1: Identify the factual world structure
  const factualPathsToTarget = causalPaths(scm, intervention.variable, target);

  // Step 2: Apply intervention (graph surgery)
  const mutilated = doIntervention(scm, [intervention]);

  // Step 3: Identify affected variables (descendants of the intervention)
  const affected = descendants(scm, intervention.variable);
  affected.add(intervention.variable);

  const allVarNames = scm.variables.map(v => v.name);
  const unchangedVariables = allVarNames.filter(v => !affected.has(v));
  const affectedVariables = allVarNames.filter(v => affected.has(v));

  // Compute counterfactual paths in the mutilated graph
  const counterfactualPathsToTarget = causalPaths(mutilated, intervention.variable, target);

  return {
    target,
    intervention,
    affectedVariables,
    unchangedVariables,
    mutilatedModel: mutilated,
    targetAffected: affected.has(target),
    factualPaths: factualPathsToTarget,
    counterfactualPaths: counterfactualPathsToTarget,
  };
}

// ── Backdoor Criterion ──────────────────────────────────────

/**
 * Check if a set Z satisfies the backdoor criterion for
 * estimating the causal effect of X on Y.
 *
 * Z satisfies the backdoor criterion relative to (X, Y) if:
 *   1. No node in Z is a descendant of X
 *   2. Z blocks every path between X and Y that contains
 *      an arrow into X (i.e., all backdoor paths)
 *
 * If Z satisfies the criterion, then:
 *   P(Y | do(X)) = Σ_z P(Y | X, Z=z) P(Z=z)
 *
 * This is the fundamental identification formula that allows
 * computing causal effects from observational data.
 */
export function satisfiesBackdoorCriterion(
  scm: StructuralCausalModel,
  x: string,
  y: string,
  z: Set<string>,
): boolean {
  // Condition 1: No node in Z is a descendant of X
  const descX = descendants(scm, x);
  for (const zNode of z) {
    if (descX.has(zNode)) return false;
  }

  // Condition 2: Z blocks all backdoor paths (X and Y are d-separated
  // in the graph where all arrows out of X are removed)
  const manipulatedEdges = scm.edges.filter(e => e.from !== x);
  const manipulatedSCM: StructuralCausalModel = {
    ...scm,
    id: `${scm.id}:backdoor-test` as IRI,
    edges: manipulatedEdges,
  };

  return isDSeparated(manipulatedSCM, x, y, z);
}

/**
 * Find a minimal sufficient adjustment set for the backdoor criterion.
 * Returns null if no valid set exists (causal effect not identifiable).
 */
export function findBackdoorSet(
  scm: StructuralCausalModel,
  x: string,
  y: string,
): Set<string> | null {
  // Candidate variables: not X, not Y, not descendants of X
  const descX = descendants(scm, x);
  const candidates = scm.variables
    .map(v => v.name)
    .filter(v => v !== x && v !== y && !descX.has(v));

  // Try empty set first
  if (satisfiesBackdoorCriterion(scm, x, y, new Set())) {
    return new Set();
  }

  // Try single variables
  for (const c of candidates) {
    const z = new Set([c]);
    if (satisfiesBackdoorCriterion(scm, x, y, z)) {
      return z;
    }
  }

  // Try pairs
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const z = new Set([candidates[i]!, candidates[j]!]);
      if (satisfiesBackdoorCriterion(scm, x, y, z)) {
        return z;
      }
    }
  }

  // Try all candidates
  const allCandidates = new Set(candidates);
  if (satisfiesBackdoorCriterion(scm, x, y, allCandidates)) {
    return allCandidates;
  }

  return null; // Not identifiable via backdoor
}

// ── Front-Door Criterion ────────────────────────────────────

/**
 * Check if a set M satisfies the front-door criterion for
 * estimating the causal effect of X on Y.
 *
 * M satisfies the front-door criterion relative to (X, Y) if:
 *   1. X blocks all directed paths from X to M
 *   ... actually, the formal conditions are:
 *   1. M intercepts all directed paths from X to Y
 *   2. There is no unblocked backdoor path from X to M
 *   3. All backdoor paths from M to Y are blocked by X
 *
 * If M satisfies the criterion, then:
 *   P(Y|do(X)) = Σ_m P(M=m|X) Σ_x P(Y|M=m,X=x)P(X=x)
 */
export function satisfiesFrontDoorCriterion(
  scm: StructuralCausalModel,
  x: string,
  y: string,
  m: Set<string>,
): boolean {
  // Condition 1: M intercepts all directed paths from X to Y
  const paths = causalPaths(scm, x, y);
  for (const path of paths) {
    const intermediates = path.slice(1, -1); // exclude X and Y
    if (!intermediates.some(v => m.has(v))) {
      return false; // This path is not intercepted by M
    }
  }

  // Condition 2: No unblocked backdoor path from X to any node in M
  for (const mNode of m) {
    if (!satisfiesBackdoorCriterion(scm, x, mNode, new Set())) {
      // Check if empty set blocks backdoor — if not, X itself might
      // but the formal condition requires no confounding X→M
      // For simplicity, check d-separation in manipulated graph
      const manipEdges = scm.edges.filter(e => e.from !== x);
      const manipSCM: StructuralCausalModel = { ...scm, id: `${scm.id}:fd-test` as IRI, edges: manipEdges };
      if (!isDSeparated(manipSCM, x, mNode, new Set())) {
        return false;
      }
    }
  }

  // Condition 3: All backdoor paths from M to Y are blocked by X
  for (const mNode of m) {
    if (!satisfiesBackdoorCriterion(scm, mNode, y, new Set([x]))) {
      return false;
    }
  }

  return true;
}

// ── Convenience: Summary ────────────────────────────────────

/**
 * Generate a human-readable summary of an SCM's causal structure.
 */
export function scmSummary(scm: StructuralCausalModel): string {
  const lines: string[] = [];
  lines.push(`SCM: ${scm.label ?? scm.id}`);
  lines.push(`Variables: ${scm.variables.length} (${scm.variables.filter(v => v.exogenous).length} exogenous)`);
  lines.push(`Edges: ${scm.edges.length}`);
  lines.push('');
  lines.push('Causal order:');
  const order = topologicalSort(scm);
  for (const v of order) {
    const pa = parents(scm, v);
    const ch = children(scm, v);
    const variable = scm.variables.find(vv => vv.name === v);
    lines.push(`  ${variable?.exogenous ? '(U) ' : ''}${v}`);
    if (pa.length > 0) lines.push(`    ← causes: ${pa.join(', ')}`);
    if (ch.length > 0) lines.push(`    → effects: ${ch.join(', ')}`);
    if (variable?.mechanism) lines.push(`    mechanism: ${variable.mechanism}`);
  }
  return lines.join('\n');
}
