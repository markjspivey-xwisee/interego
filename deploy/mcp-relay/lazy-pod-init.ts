// Lazy pod-init helper extracted from server.ts so the two-layer
// self-heal (Set fast-path + HEAD probe + mutex-guarded bootstrap)
// is unit-testable without spinning the full relay.
//
// The behavior here is exactly the inlined version that lived in
// server.ts; only the wiring (solidFetch / withPodMutex / bootstrapPod)
// is now injected so tests can pass fakes.

import type { FetchFn, IRI } from '@interego/core';

export interface LazyPodInitAuthContext {
  podUrl?: string;
  agentId: string;
  ownerWebId: string;
  userId: string;
  identityToken?: string;
}

export interface LazyPodInitDeps {
  solidFetch: FetchFn;
  withPodMutex: <T>(podUrl: string, fn: () => Promise<T>) => Promise<T>;
  bootstrapPod: (params: {
    podUrl: string;
    ownerWebId: IRI;
    surfaceAgentIri: IRI;
    userName: string;
    agentLabel: string;
    userId: string;
    identityWebId: string;
  }) => Promise<void>;
}

export interface LazyPodInit {
  bootstrappedPods: Set<string>;
  ensurePodInitialized: (authContext: LazyPodInitAuthContext) => Promise<void>;
}

// Tools that materially depend on `<pod>/agents` and/or
// `<pod>/profile/card` existing before they run. Anything that reads
// the agent registry or writes a descriptor needs the pod warmed; pure
// lattice / kernel-verb tools (mint, dereference of urn:pgsl:*, ...)
// don't and are fired as best-effort warm-ups elsewhere.
export const POD_AWARE_TOOLS: ReadonlySet<string> = new Set<string>([
  // Writes — first-line auth reads /agents
  'publish_context', 'register_agent', 'revoke_agent', 'publish_directory',
  // Reads that materialize over /agents or /profile/card
  'discover_context', 'discover_all', 'get_descriptor',
  'get_pod_status', 'list_known_pods', 'verify_agent',
  'subscribe_to_pod', 'unsubscribe_from_pod',
  'add_pod', 'remove_pod', 'discover_directory', 'resolve_webfinger',
]);

export function createLazyPodInit(deps: LazyPodInitDeps): LazyPodInit {
  const bootstrappedPods = new Set<string>();

  async function ensurePodInitialized(authContext: LazyPodInitAuthContext): Promise<void> {
    const podUrl = authContext.podUrl;
    if (!podUrl) return;
    // Layer 1: in-process fast-path.
    if (bootstrappedPods.has(podUrl)) return;

    // Layer 2: HEAD probe. 200 → already initialized elsewhere; record
    // + skip. Anything else (404, 5xx, network throw) falls through to
    // the mutex-guarded bootstrap — bootstrap itself is idempotent.
    try {
      const head = await deps.solidFetch(`${podUrl}agents`, { method: 'HEAD' });
      if (head.status === 200) {
        bootstrappedPods.add(podUrl);
        return;
      }
    } catch {
      // Network blip — fall through.
    }

    await deps.withPodMutex(podUrl, async () => {
      // Double-checked locking under the mutex.
      if (bootstrappedPods.has(podUrl)) return;
      const bareAgentSlug = authContext.agentId.startsWith('did:web:')
        ? (authContext.agentId.split(':').pop() ?? authContext.agentId)
        : authContext.agentId;
      await deps.bootstrapPod({
        podUrl,
        ownerWebId: authContext.ownerWebId as IRI,
        surfaceAgentIri: authContext.agentId as IRI,
        userName: authContext.userId,
        agentLabel: `Surface agent ${bareAgentSlug}`,
        userId: authContext.userId,
        identityWebId: authContext.ownerWebId,
      });
      bootstrappedPods.add(podUrl);
      // On throw: Set NOT populated; next call re-runs.
    });
  }

  return {
    bootstrappedPods,
    ensurePodInitialized,
  };
}
