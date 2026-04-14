/**
 * @module pod-registry
 * @description In-memory registry of known Solid pods for multi-pod federation.
 *
 * Tracks home pod, configured pods, directory-discovered pods, and
 * WebFinger-resolved pods. Manages per-pod subscription lifecycle.
 */

import type { IRI, Subscription } from '@interego/core';

export type DiscoverySource = 'config' | 'directory' | 'webfinger' | 'manual';

export interface KnownPod {
  /** Solid pod URL (normalized with trailing slash). */
  url: string;
  /** Human-readable label. */
  label?: string;
  /** Pod owner's WebID. */
  owner?: IRI;
  /** True for the agent's own pod (publish target). */
  isHome: boolean;
  /** How this pod was discovered. */
  discoveredVia: DiscoverySource;
  /** Active WebSocket subscription (if any). */
  subscription?: Subscription;
  /** ISO 8601 timestamp of last successful contact. */
  lastSeen?: string;
}

/**
 * Normalize a pod URL to ensure trailing slash.
 */
function normalize(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

export class PodRegistry {
  private pods: Map<string, KnownPod> = new Map();

  /**
   * Add or update a pod entry.
   * Does not overwrite isHome=true if already set.
   * Merges new data with existing entry.
   */
  add(pod: KnownPod): void {
    const url = normalize(pod.url);
    const existing = this.pods.get(url);

    if (existing) {
      this.pods.set(url, {
...existing,
        label: pod.label ?? existing.label,
        owner: pod.owner ?? existing.owner,
        isHome: existing.isHome || pod.isHome,
        discoveredVia: pod.discoveredVia,
        // Preserve subscription and lastSeen
        subscription: existing.subscription,
        lastSeen: existing.lastSeen,
      });
    } else {
      this.pods.set(url, {...pod, url });
    }
  }

  /**
   * Remove a pod (unsubscribes first if subscribed).
   * Cannot remove the home pod.
   */
  remove(url: string): boolean {
    const normalized = normalize(url);
    const pod = this.pods.get(normalized);
    if (!pod) return false;
    if (pod.isHome) return false; // Cannot remove home pod

    if (pod.subscription) {
      pod.subscription.unsubscribe();
    }
    return this.pods.delete(normalized);
  }

  /** Get a specific pod entry. */
  get(url: string): KnownPod | undefined {
    return this.pods.get(normalize(url));
  }

  /** Get the home pod. */
  getHome(): KnownPod | undefined {
    for (const pod of this.pods.values()) {
      if (pod.isHome) return pod;
    }
    return undefined;
  }

  /** List all known pods. */
  list(): KnownPod[] {
    return [...this.pods.values()];
  }

  /** Mark a pod as successfully contacted. */
  touch(url: string): void {
    const pod = this.pods.get(normalize(url));
    if (pod) {
      pod.lastSeen = new Date().toISOString();
    }
  }

  /** Set subscription for a pod. */
  setSubscription(url: string, sub: Subscription): void {
    const normalized = normalize(url);
    const pod = this.pods.get(normalized);
    if (pod) {
      pod.subscription = sub;
    } else {
      // Auto-add pod if not known
      this.pods.set(normalized, {
        url: normalized,
        isHome: false,
        discoveredVia: 'manual',
        subscription: sub,
      });
    }
  }

  /** Unsubscribe all pods. */
  unsubscribeAll(): void {
    for (const pod of this.pods.values()) {
      if (pod.subscription) {
        pod.subscription.unsubscribe();
        pod.subscription = undefined;
      }
    }
  }

  /** Number of pods. */
  get size(): number {
    return this.pods.size;
  }
}
