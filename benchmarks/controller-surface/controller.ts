/** Controller protocol. Only the model chooses nodes; this module binds their data. */
export type Controller = 'react' | 'dag';
export interface Node { id: string; tool: 'discover' | 'read' | 'invoke' | 'remember' | 'recall'; args: string; dependsOn: string[] }
export interface Decision { finish: boolean; nodes: Node[] }
export interface Observation { id: string; tool: string; result: unknown }
export const BUDGET = Object.freeze({ decisions: 12, tools: 24, nodesPerPlan: 12, decisionBytes: 24000 });
export const decisionSchema = {
  type: 'object', additionalProperties: false, required: ['finish', 'nodes'],
  properties: {
    finish: { type: 'boolean' },
    nodes: { type: 'array', maxItems: BUDGET.nodesPerPlan, items: {
      type: 'object', additionalProperties: false, required: ['id', 'tool', 'args', 'dependsOn'],
      properties: {
        id: { type: 'string' }, tool: { type: 'string', enum: ['discover', 'read', 'invoke', 'remember', 'recall'] },
        args: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } },
      },
    } },
  },
};

export function promptFor(controller: Controller, handle: string, observations: Observation[], remaining: { decisions: number; tools: number }): string {
  return `You control a small resource workflow. Return only the specified JSON decision, with no tool use outside this protocol and no explanation.
Task: complete exactly THREE task moves, choosing the smallest currently legal position on each move. Preserve all existing and concurrent moves. Verify the final state by a fresh read after your last write. Other actors may change resources. Never reset. The resource handle is ${JSON.stringify(handle)}.
Authoritative progress and history are available from read. You may be continuing an already partially completed task. Do not infer progress from missing conversation history.
Tools, identical in every interface condition:
discover({handle}) -> {resource}; read({resource}) -> {state, taskProgress:{completedMoves}, history, controls, verified}. Controls are legal moves sorted by ascending position, each with operation, position and an opaque binding. invoke({control}) follows the complete advertised control exactly; it returns status, committed and possibly state, but no fresh controls. A non-2xx result stops the plan and is an observation to use in your next decision. Refresh before retrying stale actions. remember({key,value}) and recall({key}) provide durable task-local storage, available equally to all controllers.
Each node has id, tool, args (a JSON-encoded object), and dependsOn (node IDs). Arguments can contain {"$ref":"nodeId.path.to.value"} to copy a prior tool result exactly, including array indexes. References may use visible prior observations or completed nodes of this plan. Declare dependencies on every node of this plan referenced by arguments. Independent ready read/storage nodes can run together; writes run sequentially. There is no implicit reasoning inside binders.
${controller === 'react' ? 'Controller: ReAct. Reason about observations and choose at most ONE tool node per decision. You may plan ahead internally, but receive a new observation before choosing the next tool.' : 'Controller: Plan-Act DAG. Generate up to TWELVE tool nodes with dependencies. Deterministic binders execute the plan without further model decisions until it ends, fails, or the controller is replaced. You can submit partial plans and replan using observations.'}
finish=true means finish after these nodes execute successfully; finish=true with zero nodes means finish now. A failed node or a handoff cancels remaining nodes and prevents finish. Completion is judged independently from authoritative state and final verification, not your claim.
Remaining budget: ${remaining.decisions} model decisions and ${remaining.tools} tool calls. Same total limits in both controllers. Return compact JSON; args must itself be valid JSON.
Visible observations:
${JSON.stringify(observations)}`;
}

export function validateDecision(raw: unknown, controller: Controller, prior: Set<string>): Decision {
  if (Buffer.byteLength(JSON.stringify(raw)) > BUDGET.decisionBytes) throw new Error('decision byte budget exceeded');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('decision must be an object');
  const d = raw as Decision;
  if (Object.keys(d).sort().join(',') !== 'finish,nodes' || typeof d.finish !== 'boolean' || !Array.isArray(d.nodes)) throw new Error('invalid decision shape');
  if (d.nodes.length > (controller === 'react' ? 1 : BUDGET.nodesPerPlan)) throw new Error('controller node limit exceeded');
  if (!d.finish && d.nodes.length === 0) throw new Error('empty unfinished decision');
  const ids = new Set(prior);
  for (const n of d.nodes) {
    if (!n || Object.keys(n).sort().join(',') !== 'args,dependsOn,id,tool' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(n.id) || ids.has(n.id)
      || !['discover', 'read', 'invoke', 'remember', 'recall'].includes(n.tool) || typeof n.args !== 'string' || !Array.isArray(n.dependsOn)
      || n.dependsOn.some(id => typeof id !== 'string')) throw new Error('invalid or duplicate plan node');
    const args = JSON.parse(n.args);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
    ids.add(n.id);
  }
  const planIds = new Set(d.nodes.map(n => n.id));
  for (const n of d.nodes) {
    if (n.dependsOn.some(id => !ids.has(id) || id === n.id)) throw new Error('unknown or self dependency');
    for (const ref of references(JSON.parse(n.args))) {
      if (!ids.has(ref) || (planIds.has(ref) && !n.dependsOn.includes(ref))) throw new Error('undeclared data dependency');
    }
  }
  const done = new Set(prior); const pending = [...d.nodes];
  while (pending.length) {
    const index = pending.findIndex(n => n.dependsOn.every(id => done.has(id)));
    if (index < 0) throw new Error('cyclic plan');
    done.add(pending.splice(index, 1)[0]!.id);
  }
  return d;
}

function references(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (!Array.isArray(value) && '$ref' in value) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string') throw new Error('invalid reference');
    return [value.$ref.split('.')[0]!];
  }
  return Object.values(value).flatMap(references);
}

export function bind(value: unknown, outputs: Map<string, unknown>): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => bind(v, outputs));
  if ('$ref' in value) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string') throw new Error('invalid reference');
    const [node, ...path] = value.$ref.split('.');
    if (!outputs.has(node!)) throw new Error('unresolved reference');
    let result = outputs.get(node!);
    for (const key of path) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || result === null || typeof result !== 'object' || !Object.hasOwn(result, key)) throw new Error('missing or unsafe reference path');
      result = (result as Record<string, unknown>)[key];
    }
    return structuredClone(result);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, outputs)]));
}
