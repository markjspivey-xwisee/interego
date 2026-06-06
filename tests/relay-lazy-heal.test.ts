/**
 * Regression tests for the relay's deferred-bootstrap + lazy pod-init
 * self-heal path (deploy/mcp-relay/lazy-pod-init.ts).
 *
 * The behavior under test is the two-layer safety net that catches the
 * case where /oauth/verify's deferred bootstrap fails AND the first
 * pod-aware tool call still has to land cleanly:
 *
 *   Layer 1: `bootstrappedPods` Set fast-path — second call for the
 *            same podUrl is O(1) Set.has, zero HTTP.
 *   Layer 2: HEAD <pod>/agents probe — 200 means another replica
 *            already bootstrapped; record + skip. Anything else falls
 *            through to the mutex-guarded bootstrap.
 *   Mutex:   `withPodMutex` serialises lazy init against /oauth/verify's
 *            background bootstrap on the SAME per-pod key. On bootstrap
 *            failure the Set is NOT populated so the next call re-runs.
 *
 * A regression that (a) populates `bootstrappedPods` on failure (poisons
 * the cache), (b) treats a 5xx HEAD response as 200, or (c) drops a
 * pod-aware tool from `POD_AWARE_TOOLS` would only be caught by a
 * manual run of scripts/verify-lazy-init.mjs against deployed infra.
 * This vitest gives us a fast in-process gate.
 */

import { describe, it, expect } from 'vitest';
import type { FetchFn, IRI } from '@interego/core';
import {
  createLazyPodInit,
  POD_AWARE_TOOLS,
  type LazyPodInitDeps,
} from '../deploy/mcp-relay/lazy-pod-init.js';

// ── Helpers ─────────────────────────────────────────────────

function makeFetch(
  routes: Record<string, () => { status: number } | Promise<{ status: number }>>,
  log: Array<{ url: string; method: string }>,
): FetchFn {
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    log.push({ url, method });
    const handler = routes[url];
    const r = handler ? await handler() : { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: '',
      headers: { get: (_n: string) => null },
      text: async () => '',
      json: async () => ({}),
    };
  };
}

function makeWithPodMutex(): LazyPodInitDeps['withPodMutex'] {
  // Tests don't need real serialisation — single-threaded vitest gives
  // us ordering for free, and we only need the mutex hook to verify
  // the helper actually goes through it on the bootstrap path.
  return async <T>(_podUrl: string, fn: () => Promise<T>): Promise<T> => fn();
}

const AUTH_CTX = {
  podUrl: 'https://pod.example/u-pk-abc/',
  agentId: 'did:web:relay.example:agents:chatgpt-u-pk-abc' as string,
  ownerWebId: 'https://pod.example/u-pk-abc/profile/card#me' as string,
  userId: 'u-pk-abc',
};

// ── Tests ───────────────────────────────────────────────────

describe('relay lazy pod-init self-heal', () => {
  it('Set fast-path: second call with podUrl in bootstrappedPods makes zero HTTP calls', async () => {
    const fetchLog: Array<{ url: string; method: string }> = [];
    let bootstrapCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: makeFetch({
        [`${AUTH_CTX.podUrl}agents`]: () => ({ status: 200 }),
      }, fetchLog),
      withPodMutex: makeWithPodMutex(),
      bootstrapPod: async () => { bootstrapCalls++; },
    });

    // Prime the Set as if a prior call (or /oauth/verify's
    // .then(bootstrappedPods.add)) had already succeeded.
    lazy.bootstrappedPods.add(AUTH_CTX.podUrl);

    await lazy.ensurePodInitialized(AUTH_CTX);

    expect(fetchLog).toEqual([]);
    expect(bootstrapCalls).toBe(0);
  });

  it('HEAD 200 path: caller skips bootstrap and writes to the Set', async () => {
    const fetchLog: Array<{ url: string; method: string }> = [];
    let bootstrapCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: makeFetch({
        [`${AUTH_CTX.podUrl}agents`]: () => ({ status: 200 }),
      }, fetchLog),
      withPodMutex: makeWithPodMutex(),
      bootstrapPod: async () => { bootstrapCalls++; },
    });

    await lazy.ensurePodInitialized(AUTH_CTX);

    expect(fetchLog).toEqual([
      { url: `${AUTH_CTX.podUrl}agents`, method: 'HEAD' },
    ]);
    expect(bootstrapCalls).toBe(0);
    expect(lazy.bootstrappedPods.has(AUTH_CTX.podUrl)).toBe(true);

    // Second call should be the Set fast-path.
    await lazy.ensurePodInitialized(AUTH_CTX);
    expect(fetchLog.length).toBe(1);
  });

  it('HEAD 404 path: takes mutex, runs bootstrap, populates Set on success', async () => {
    const fetchLog: Array<{ url: string; method: string }> = [];
    let bootstrapCalls = 0;
    let mutexCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: makeFetch({
        [`${AUTH_CTX.podUrl}agents`]: () => ({ status: 404 }),
      }, fetchLog),
      withPodMutex: async (podUrl, fn) => {
        mutexCalls++;
        expect(podUrl).toBe(AUTH_CTX.podUrl);
        return fn();
      },
      bootstrapPod: async params => {
        bootstrapCalls++;
        expect(params.podUrl).toBe(AUTH_CTX.podUrl);
        expect(params.ownerWebId).toBe(AUTH_CTX.ownerWebId as unknown as IRI);
        expect(params.surfaceAgentIri).toBe(AUTH_CTX.agentId as unknown as IRI);
      },
    });

    await lazy.ensurePodInitialized(AUTH_CTX);

    expect(mutexCalls).toBe(1);
    expect(bootstrapCalls).toBe(1);
    expect(lazy.bootstrappedPods.has(AUTH_CTX.podUrl)).toBe(true);
  });

  it('HEAD 5xx is NOT treated as 200 — falls through to bootstrap, Set not populated yet', async () => {
    // A regression that mistakenly accepted any 2xx-or-5xx as
    // "initialized" would skip bootstrap on a degraded CSS and leave
    // the user with a half-init pod forever. Lock the behavior in.
    const fetchLog: Array<{ url: string; method: string }> = [];
    let bootstrapCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: makeFetch({
        [`${AUTH_CTX.podUrl}agents`]: () => ({ status: 503 }),
      }, fetchLog),
      withPodMutex: makeWithPodMutex(),
      bootstrapPod: async () => { bootstrapCalls++; },
    });

    await lazy.ensurePodInitialized(AUTH_CTX);

    expect(bootstrapCalls).toBe(1);
    expect(lazy.bootstrappedPods.has(AUTH_CTX.podUrl)).toBe(true);
  });

  it('bootstrap throws -> Set NOT populated, next call re-runs bootstrap', async () => {
    const fetchLog: Array<{ url: string; method: string }> = [];
    let bootstrapCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: makeFetch({
        [`${AUTH_CTX.podUrl}agents`]: () => ({ status: 404 }),
      }, fetchLog),
      withPodMutex: makeWithPodMutex(),
      bootstrapPod: async () => {
        bootstrapCalls++;
        throw new Error('CSS down');
      },
    });

    await expect(lazy.ensurePodInitialized(AUTH_CTX)).rejects.toThrow('CSS down');
    expect(lazy.bootstrappedPods.has(AUTH_CTX.podUrl)).toBe(false);

    await expect(lazy.ensurePodInitialized(AUTH_CTX)).rejects.toThrow('CSS down');
    expect(bootstrapCalls).toBe(2);
  });

  it('no-op when podUrl is missing', async () => {
    const fetchLog: Array<{ url: string; method: string }> = [];
    let bootstrapCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: makeFetch({}, fetchLog),
      withPodMutex: makeWithPodMutex(),
      bootstrapPod: async () => { bootstrapCalls++; },
    });

    await lazy.ensurePodInitialized({
      agentId: AUTH_CTX.agentId,
      ownerWebId: AUTH_CTX.ownerWebId,
      userId: AUTH_CTX.userId,
    });

    expect(fetchLog).toEqual([]);
    expect(bootstrapCalls).toBe(0);
  });

  it('HEAD network error falls through to bootstrap', async () => {
    let bootstrapCalls = 0;
    const lazy = createLazyPodInit({
      solidFetch: async () => { throw new Error('ECONNREFUSED'); },
      withPodMutex: makeWithPodMutex(),
      bootstrapPod: async () => { bootstrapCalls++; },
    });

    await lazy.ensurePodInitialized(AUTH_CTX);

    expect(bootstrapCalls).toBe(1);
    expect(lazy.bootstrappedPods.has(AUTH_CTX.podUrl)).toBe(true);
  });
});

describe('POD_AWARE_TOOLS membership invariants', () => {
  // A regression that drops a pod-aware tool from this Set would have
  // that tool stop awaiting ensurePodInitialized, so its first call
  // against an unbootstrapped pod would return a misleading empty
  // result (read) or a 401 (write) instead of self-healing.
  const MUST_BE_POD_AWARE = [
    // Writes — first-line auth reads /agents
    'publish_context', 'register_agent', 'revoke_agent', 'publish_directory',
    // Reads that materialize over /agents or /profile/card
    'discover_context', 'discover_all', 'get_descriptor',
    'get_pod_status', 'list_known_pods', 'verify_agent',
    'subscribe_to_pod', 'unsubscribe_from_pod',
    'add_pod', 'remove_pod', 'discover_directory', 'resolve_webfinger',
  ];

  for (const tool of MUST_BE_POD_AWARE) {
    it(`includes ${tool}`, () => {
      expect(POD_AWARE_TOOLS.has(tool)).toBe(true);
    });
  }

  it('does NOT include pure lattice / kernel-verb tools', () => {
    // These operate on the PGSL lattice or are pure substrate verbs —
    // they don't read /agents or /profile/card and would needlessly
    // pay HEAD-probe latency on every call if added.
    const MUST_NOT_BE_POD_AWARE = ['mint', 'dereference', 'compose', 'act', 'restrict', 'extend', 'promote', 'decompose', 'ping'];
    for (const tool of MUST_NOT_BE_POD_AWARE) {
      expect(POD_AWARE_TOOLS.has(tool)).toBe(false);
    }
  });
});
