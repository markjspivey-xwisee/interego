/**
 * @module transactions
 * @description Federated saga-pattern transactions per
 *   `spec/FEDERATED-TRANSACTIONS.md`. Coordinator-managed multi-pod
 *   atomic writes with explicit compensation on failure.
 *
 *   Reference runtime — single coordinator, multiple participant
 *   pods, in-memory step tracking. Production deployments would
 *   persist transaction state to the coordinator's pod for crash
 *   recovery + replay.
 */

import type { IRI } from '@interego/core';

export type TxnState = 'Pending' | 'Committed' | 'Aborted' | 'PartialAbort';
export type StepState = 'NotStarted' | 'InProgress' | 'Committed' | 'Failed' | 'Compensated' | 'CompensationFailed';
export type IsolationLevel = 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';

export interface TransactionStep {
  readonly id: IRI;
  readonly targetPod: string;
  readonly forwardAction: () => Promise<void>;
  readonly compensatingAction: () => Promise<void>;
  readonly description: string;
  readonly order: number;
  state: StepState; // mutable in this reference impl
  error?: string;
}

export interface Transaction {
  readonly id: IRI;
  readonly coordinator: IRI;
  readonly isolation: IsolationLevel;
  readonly steps: TransactionStep[];
  state: TxnState; // mutable
  beganAt?: string;
  endedAt?: string;
}

export function createTransaction(args: {
  id: IRI;
  coordinator: IRI;
  steps: Omit<TransactionStep, 'state'>[];
  isolation?: IsolationLevel;
}): Transaction {
  const steps = [...args.steps]
    .sort((a, b) => a.order - b.order)
    .map(s => ({ ...s, state: 'NotStarted' as StepState }));
  return {
    id: args.id,
    coordinator: args.coordinator,
    isolation: args.isolation ?? 'ReadCommitted',
    steps,
    state: 'Pending',
  };
}

export interface TxnResult {
  readonly state: TxnState;
  readonly committedSteps: readonly IRI[];
  readonly compensatedSteps: readonly IRI[];
  readonly failedStep?: IRI;
  readonly partialAbortDetails?: readonly { step: IRI; reason: string }[];
  readonly durationMs: number;
}

/**
 * Execute a saga transaction. Steps run in order; on the first
 * failure, compensate completed steps in reverse. If any
 * compensation also fails → PartialAbort (manual reconciliation
 * needed; details recorded for audit).
 */
export async function executeTransaction(txn: Transaction): Promise<TxnResult> {
  const start = Date.now();
  txn.beganAt = new Date(start).toISOString();
  txn.state = 'Pending';

  const committed: IRI[] = [];
  let failedStep: IRI | undefined;

  for (const step of txn.steps) {
    step.state = 'InProgress';
    try {
      await step.forwardAction();
      step.state = 'Committed';
      committed.push(step.id);
    } catch (err) {
      step.state = 'Failed';
      step.error = (err as Error).message;
      failedStep = step.id;
      break;
    }
  }

  if (!failedStep) {
    // All steps committed.
    txn.state = 'Committed';
    txn.endedAt = new Date().toISOString();
    return {
      state: 'Committed',
      committedSteps: committed,
      compensatedSteps: [],
      durationMs: Date.now() - start,
    };
  }

  // Compensate in reverse order.
  const compensated: IRI[] = [];
  const partialAbortDetails: { step: IRI; reason: string }[] = [];
  for (const step of [...committed].reverse().map(id => txn.steps.find(s => s.id === id)!)) {
    try {
      await step.compensatingAction();
      step.state = 'Compensated';
      compensated.push(step.id);
    } catch (err) {
      step.state = 'CompensationFailed';
      partialAbortDetails.push({ step: step.id, reason: (err as Error).message });
    }
  }

  txn.endedAt = new Date().toISOString();
  if (partialAbortDetails.length > 0) {
    txn.state = 'PartialAbort';
    return {
      state: 'PartialAbort',
      committedSteps: committed,
      compensatedSteps: compensated,
      failedStep,
      partialAbortDetails,
      durationMs: Date.now() - start,
    };
  }
  txn.state = 'Aborted';
  return {
    state: 'Aborted',
    committedSteps: committed,
    compensatedSteps: compensated,
    failedStep,
    durationMs: Date.now() - start,
  };
}

/** Snapshot of where each step is right now (audit / debugging). */
export function transactionStatus(txn: Transaction): {
  id: IRI;
  state: TxnState;
  steps: { id: IRI; state: StepState; error?: string; targetPod: string; description: string }[];
} {
  return {
    id: txn.id,
    state: txn.state,
    steps: txn.steps.map(s => ({
      id: s.id,
      state: s.state,
      error: s.error,
      targetPod: s.targetPod,
      description: s.description,
    })),
  };
}
