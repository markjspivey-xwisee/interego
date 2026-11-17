/**
 * Keeping profile records on a pod, and saying afterwards whether a record is there.
 *
 * `ProfileServer` asks `confirm` when a write was not acknowledged. Three answers: the store has
 * the record, the store was read and does not, or the store could not be read. The third leaves
 * the write in doubt and its profile reserved until the store can be read, so it must be given
 * only when the record may be there. A write this process never sent is not there.
 *
 * The parts are handed in, so this is the bridge's decision without the bridge.
 */

import type { ProfileServer, ProfileRecord } from './service.js';

type Options = ConstructorParameters<typeof ProfileServer>[0];
type Persist = NonNullable<Options['persist']>;
type Confirm = NonNullable<Options['confirm']>;

export interface ProfilePodStoreParts {
  /** The pod the records go to; empty when none is configured. */
  readonly pod: string;
  /** Whether this process has the key it writes the lattice with. With none, it writes nothing. */
  readonly hasKey: () => boolean;
  /** Throws when the address is one this process does not fetch (a loopback or private one). */
  readonly guard: (url: string) => Promise<void>;
  /** Send the record to the pod. */
  readonly write: Persist;
  /** The records in the pod's own copy, or null when that could not be read. */
  readonly readBack: () => Promise<readonly ProfileRecord[] | null>;
}

export interface ProfilePodStore {
  readonly persist: Persist;
  readonly confirm: Confirm;
}

export function profilePodStore(parts: ProfilePodStoreParts): ProfilePodStore {
  /** Ids of records whose write was refused before it was sent; each is read once by `confirm`. */
  const neverSent = new Set<string>();
  return {
    persist: async (record, held) => {
      if (!parts.pod) return { persisted: false };
      // Refused here, before anything is composed or sent, and remembered as never sent. Only
      // that makes it "not kept" in `confirm`: a refusal at read-back time says nothing about
      // the write, which may have gone out while the address was still one this process fetched.
      try { await parts.guard(parts.pod); }
      catch { if (record.id) neverSent.add(record.id); return { persisted: false }; }
      return parts.write(record, held);
    },
    confirm: async record => {
      if (!parts.pod) return false;
      // With no key nothing is written, and the pod's copy cannot be read either: answering
      // "could not be read" would leave every write in doubt for good.
      if (!parts.hasKey()) return false;
      if (record.id && neverSent.delete(record.id)) return false;
      const onPod = await parts.readBack();
      return onPod === null ? undefined : onPod.some(r => r?.id === record.id);
    },
  };
}
