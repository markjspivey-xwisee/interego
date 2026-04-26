/**
 * @module p2p/relay
 * @description Two relay implementations:
 *
 *   InMemoryRelay  — for tests + single-process simulation. Holds
 *                    events in a Map; routes to subscribers
 *                    synchronously. NIP-33 replaceable-event
 *                    semantics enforced (newer event with same
 *                    (kind, pubkey, `d` tag) supersedes older).
 *
 *   Production code that wants to talk to a real Nostr relay should
 *   implement the same `P2pRelay` interface against a WebSocket. The
 *   `P2pClient` doesn't care which it talks to.
 */

import type { P2pEvent, P2pFilter, P2pRelay, P2pSubscription } from './types.js';

function tagValue(tags: readonly (readonly string[])[], name: string): string | undefined {
  return tags.find(t => t[0] === name)?.[1];
}

/**
 * Per NIP-01 + NIP-33:
 *  - kinds 30000-39999 are parameterized-replaceable: at most one
 *    event per (pubkey, kind, d-tag-value) is retained; newer wins.
 *  - kinds 10000-19999 are replaceable: at most one per (pubkey, kind).
 *  - kinds 20000-29999 are ephemeral: not retained.
 *  - all other kinds: regular, all retained.
 */
function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

function isParameterizedReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

function matchesFilter(event: P2pEvent, filter: P2pFilter): boolean {
  if (filter.authors && !filter.authors.some(a => a.toLowerCase() === event.pubkey.toLowerCase())) {
    return false;
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  // Tag filters: any key starting with #
  for (const k of Object.keys(filter)) {
    if (!k.startsWith('#')) continue;
    const allowed = (filter as Record<string, readonly string[] | undefined>)[k];
    if (!allowed) continue;
    const tagName = k.slice(1);
    const eventValues = event.tags.filter(t => t[0] === tagName).map(t => t[1] ?? '');
    if (!eventValues.some(v => allowed.includes(v))) return false;
  }
  return true;
}

interface InternalSub {
  readonly id: number;
  readonly filter: P2pFilter;
  readonly cb: (e: P2pEvent) => void;
}

export class InMemoryRelay implements P2pRelay {
  private readonly events: P2pEvent[] = [];
  private readonly subs: InternalSub[] = [];
  private nextSubId = 1;

  /** Number of retained events (excludes ephemerals). */
  size(): number {
    return this.events.length;
  }

  async publish(event: P2pEvent): Promise<{ ok: boolean; reason?: string }> {
    // NIP-33 / NIP-16 replaceability: drop older versions
    if (isReplaceable(event.kind)) {
      this.removeWhere(e => e.kind === event.kind && e.pubkey === event.pubkey);
    } else if (isParameterizedReplaceable(event.kind)) {
      const dValue = tagValue(event.tags, 'd');
      if (dValue !== undefined) {
        this.removeWhere(e =>
          e.kind === event.kind &&
          e.pubkey === event.pubkey &&
          tagValue(e.tags, 'd') === dValue,
        );
      }
    }

    if (!isEphemeral(event.kind)) {
      this.events.push(event);
    }

    // Fan out to live subscribers (sync, microtask-ordered to mimic
    // network arrival without actually scheduling)
    for (const s of this.subs) {
      if (matchesFilter(event, s.filter)) {
        // Use queueMicrotask so callbacks run async like a real relay
        queueMicrotask(() => s.cb(event));
      }
    }

    return { ok: true };
  }

  async query(filter: P2pFilter): Promise<readonly P2pEvent[]> {
    const matched = this.events.filter(e => matchesFilter(e, filter));
    // Newest-first by created_at
    matched.sort((a, b) => b.created_at - a.created_at);
    if (filter.limit !== undefined) return matched.slice(0, filter.limit);
    return matched;
  }

  subscribe(filter: P2pFilter, onEvent: (e: P2pEvent) => void): P2pSubscription {
    const id = this.nextSubId++;
    this.subs.push({ id, filter, cb: onEvent });

    // Replay matching historical events to the new subscriber
    // (Nostr REQ semantics)
    for (const e of this.events) {
      if (matchesFilter(e, filter)) {
        queueMicrotask(() => onEvent(e));
      }
    }

    return {
      close: () => {
        const idx = this.subs.findIndex(s => s.id === id);
        if (idx >= 0) this.subs.splice(idx, 1);
      },
    };
  }

  // Private helpers

  private removeWhere(predicate: (e: P2pEvent) => boolean): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (predicate(this.events[i]!)) this.events.splice(i, 1);
    }
  }
}
