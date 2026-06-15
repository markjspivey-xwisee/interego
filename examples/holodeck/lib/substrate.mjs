// Substrate observer — read activity from every agent's pod.
//
// The holodeck is a control room over a real federated substrate.
// This module reads what's actually been published — across all
// minted agent pods — so the dashboard can show:
//   - recent descriptors per agent
//   - a federation-wide activity stream (chronological merge)
//   - per-pod descriptor counts
//
// Read-only. The dashboard NEVER writes through this module; writes
// go through the per-agent MCP shim, signed by the agent's wallet.

import { unsignedToolCall } from './relay.mjs';

const _cache = new Map(); // podUrl -> { at, entries }
const CACHE_TTL_MS = 4_000;

export async function listPodEntries({ podUrl, limit = 25 }) {
  const k = `${podUrl}::${limit}`;
  const cached = _cache.get(k);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;
  const j = await unsignedToolCall({
    toolName: 'discover_context',
    args: { pod_url: podUrl, limit, sort: 'newest-first' },
  });
  const entries = Array.isArray(j.entries) ? j.entries : [];
  _cache.set(k, { at: Date.now(), entries });
  return entries;
}

export async function federationActivity({ identities, perPod = 12 }) {
  const buckets = await Promise.all(identities.map(async ({ label, podUrl, did }) => {
    const entries = await listPodEntries({ podUrl, limit: perPod });
    return entries.map(e => ({
      agent_label: label, agent_did: did, pod_url: podUrl,
      descriptorUrl: e.descriptorUrl,
      describes: Array.isArray(e.describes) ? e.describes[0] : e.describes,
      modalStatus: e.modalStatus,
      validFrom: e.validFrom,
      cid: e.cid,
    }));
  }));
  const flat = buckets.flat();
  flat.sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
  return flat;
}

export function clearCache() { _cache.clear(); }
