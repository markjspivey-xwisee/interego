import type { EventEmitter } from 'node:events';
import type { Serializable } from 'node:child_process';

export interface CollectorHeadroom {
  capacityBytes: number;
  usedBytes: number;
  sampledAt: number;
}

export type CollectorIpcChannel = Pick<EventEmitter, 'on' | 'removeListener'> & {
  connected?: boolean;
  send?: (message: Serializable, callback?: (error: Error | null) => void) => unknown;
  channel?: { unref(): void } | null;
};

export function requestFreshCollectorHeadroom(options?: {
  channel?: CollectorIpcChannel;
  now?: () => number;
  timeoutMs?: number;
}): Promise<CollectorHeadroom>;

export function attachCollectorHeadroomProvider(child: CollectorIpcChannel,
  measure: () => CollectorHeadroom | Promise<CollectorHeadroom>, options?: {
    now?: () => number;
    timeoutMs?: number;
  }): () => void;
