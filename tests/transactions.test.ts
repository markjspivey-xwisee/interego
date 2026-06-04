/**
 * Federated transaction tests — saga pattern.
 */

import { describe, it, expect } from 'vitest';
import type {
  IRI,
} from '@interego/core';
import {
  createTransaction,
  executeTransaction,
  transactionStatus,
} from '@interego/transactions';

const COORDINATOR = 'urn:agent:alice' as IRI;

function fakeStep(id: string, action: () => Promise<void>, compensation: () => Promise<void>, order: number) {
  return {
    id: `urn:step:${id}` as IRI,
    targetPod: `https://pod.example/${id}/`,
    forwardAction: action,
    compensatingAction: compensation,
    description: `step ${id}`,
    order,
  };
}

describe('saga transactions — happy path', () => {
  it('all steps succeed → Committed', async () => {
    const trace: string[] = [];
    const txn = createTransaction({
      id: 'urn:txn:1' as IRI,
      coordinator: COORDINATOR,
      steps: [
        fakeStep('a', async () => { trace.push('a-fwd'); }, async () => { trace.push('a-comp'); }, 1),
        fakeStep('b', async () => { trace.push('b-fwd'); }, async () => { trace.push('b-comp'); }, 2),
        fakeStep('c', async () => { trace.push('c-fwd'); }, async () => { trace.push('c-comp'); }, 3),
      ],
    });
    const result = await executeTransaction(txn);
    expect(result.state).toBe('Committed');
    expect(result.committedSteps).toHaveLength(3);
    expect(result.compensatedSteps).toHaveLength(0);
    expect(trace).toEqual(['a-fwd', 'b-fwd', 'c-fwd']);
  });
});

describe('saga transactions — failure + compensation', () => {
  it('mid-transaction failure → reverse-compensate completed steps', async () => {
    const trace: string[] = [];
    const txn = createTransaction({
      id: 'urn:txn:2' as IRI,
      coordinator: COORDINATOR,
      steps: [
        fakeStep('a', async () => { trace.push('a-fwd'); }, async () => { trace.push('a-comp'); }, 1),
        fakeStep('b', async () => { trace.push('b-fwd'); }, async () => { trace.push('b-comp'); }, 2),
        fakeStep('c', async () => { throw new Error('c failed'); }, async () => { trace.push('c-comp'); }, 3),
        fakeStep('d', async () => { trace.push('d-fwd'); }, async () => { trace.push('d-comp'); }, 4),
      ],
    });
    const result = await executeTransaction(txn);
    expect(result.state).toBe('Aborted');
    expect(result.committedSteps).toHaveLength(2);
    expect(result.compensatedSteps).toHaveLength(2);
    expect(result.failedStep).toBe('urn:step:c');
    // Trace should show: a-fwd, b-fwd, c attempted (no fwd recorded
    // because it threw), then b-comp, a-comp (reverse order).
    expect(trace).toEqual(['a-fwd', 'b-fwd', 'b-comp', 'a-comp']);
  });

  it('compensation failure → PartialAbort', async () => {
    const txn = createTransaction({
      id: 'urn:txn:3' as IRI,
      coordinator: COORDINATOR,
      steps: [
        fakeStep('a', async () => {}, async () => {}, 1),
        fakeStep('b', async () => {}, async () => { throw new Error('compensation broke'); }, 2),
        fakeStep('c', async () => { throw new Error('c failed'); }, async () => {}, 3),
      ],
    });
    const result = await executeTransaction(txn);
    expect(result.state).toBe('PartialAbort');
    expect(result.partialAbortDetails).toBeDefined();
    expect(result.partialAbortDetails!.length).toBe(1);
    expect(result.partialAbortDetails![0].step).toBe('urn:step:b');
  });

  it('first step fails → no compensations needed; just Aborted', async () => {
    const txn = createTransaction({
      id: 'urn:txn:4' as IRI,
      coordinator: COORDINATOR,
      steps: [
        fakeStep('a', async () => { throw new Error('boom'); }, async () => {}, 1),
        fakeStep('b', async () => {}, async () => {}, 2),
      ],
    });
    const result = await executeTransaction(txn);
    expect(result.state).toBe('Aborted');
    expect(result.committedSteps).toHaveLength(0);
    expect(result.compensatedSteps).toHaveLength(0);
  });
});

describe('transactionStatus', () => {
  it('reports per-step state after execution', async () => {
    const txn = createTransaction({
      id: 'urn:txn:s' as IRI,
      coordinator: COORDINATOR,
      steps: [
        fakeStep('a', async () => {}, async () => {}, 1),
        fakeStep('b', async () => { throw new Error('boom'); }, async () => {}, 2),
      ],
    });
    await executeTransaction(txn);
    const s = transactionStatus(txn);
    expect(s.state).toBe('Aborted');
    expect(s.steps[0].state).toBe('Compensated');
    expect(s.steps[1].state).toBe('Failed');
    expect(s.steps[1].error).toBe('boom');
  });
});
