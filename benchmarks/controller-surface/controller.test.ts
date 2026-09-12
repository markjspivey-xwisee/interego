import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bind, validateDecision } from './controller.js';
test('DAG references preserve complete observations and require dependency edges', () => {
  const output = { controls: [{ position: 0, binding: 'immutable-action' }] };
  assert.deepEqual(bind({ control: { $ref: 'r.controls.0' } }, new Map([['r', output]])), { control: output.controls[0] });
  const nodes = [{ id: 'r', tool: 'read', args: '{"resource":"a"}', dependsOn: [] }, { id: 'w', tool: 'invoke', args: '{"control":{"$ref":"r.controls.0"}}', dependsOn: ['r'] }];
  assert.equal(validateDecision({ finish: false, nodes }, 'dag', new Set()).nodes.length, 2);
  assert.throws(() => validateDecision({ finish: false, nodes }, 'react', new Set()), /node limit/);
  assert.throws(() => validateDecision({ finish: false, nodes: [nodes[0], { ...nodes[1], dependsOn: [] }] }, 'dag', new Set()), /dependency/);
});
test('cycles, stale context references and prototype paths cannot execute', () => {
  const nodes = [{ id: 'a', tool: 'read', args: '{}', dependsOn: ['b'] }, { id: 'b', tool: 'read', args: '{}', dependsOn: ['a'] }];
  assert.throws(() => validateDecision({ finish: false, nodes }, 'dag', new Set()), /cyclic/);
  assert.throws(() => bind({ $ref: 'erased.controls.0' }, new Map()), /unresolved/);
  assert.throws(() => bind({ $ref: 'r.constructor' }, new Map([['r', {}]])), /unsafe/);
});
