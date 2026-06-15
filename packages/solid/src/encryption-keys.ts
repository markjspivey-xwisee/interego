/**
 * encryption-keys.ts — per-agent X25519 public-key publication + resolution.
 *
 * Self-sovereign, domain-neutral: an agent publishes its X25519 ENCRYPTION
 * public key to its OWN pod (the private key never leaves the owner), and any
 * peer/service resolves it by following the agent's pod — so a writer can
 * encrypt canonical data TO the owning agent, not just to itself. This is the
 * substrate counterpart of the design intent in crypto/encryption.ts: "each pod
 * has an X25519 key pair (public in profile, private held by owner)."
 *
 * Conventional resource: <pod>keys/encryption.json
 *   { "algorithm": "X25519-XSalsa20-Poly1305", "publicKey": "<base64>" }
 *
 * Resolution is best-effort + fail-safe (returns null on any miss) so callers
 * can fall back to encrypting for themselves alone — non-breaking.
 */
import { getDefaultFetch, type FetchFn } from '@interego/core/http';

export const AGENT_ENCRYPTION_KEY_PATH = 'keys/encryption.json';
const X25519_ALG = 'X25519-XSalsa20-Poly1305';

function withSlash(u: string): string { return u.endsWith('/') ? u : `${u}/`; }

/** Pod root from a WebID / profile-card URL / pod-root URL. */
function podRootOf(agent: string): string {
  const noFrag = agent.includes('#') ? agent.slice(0, agent.indexOf('#')) : agent;
  const stripped = noFrag.replace(/profile\/card$/, '').replace(/profile$/, '');
  return withSlash(stripped);
}

export interface AgentEncryptionKey {
  readonly algorithm: string;
  readonly publicKey: string;
  readonly publishedAt?: string;
}

/**
 * Publish an agent's X25519 PUBLIC key to its own pod. Requires a
 * write-authorized fetch. Idempotent (overwrites). The private key stays with
 * the owner — only the public key is published.
 */
export async function publishAgentEncryptionKey(
  agentPod: string,
  publicKeyBase64: string,
  opts: { fetch?: FetchFn; publishedAt?: string } = {},
): Promise<{ url: string }> {
  const fetchFn = opts.fetch ?? getDefaultFetch();
  const url = `${podRootOf(agentPod)}${AGENT_ENCRYPTION_KEY_PATH}`;
  const body = JSON.stringify({
    algorithm: X25519_ALG,
    publicKey: publicKeyBase64,
    ...(opts.publishedAt ? { publishedAt: opts.publishedAt } : {}),
  });
  const r = await fetchFn(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
  if (!r.ok && r.status !== 412) {
    throw new Error(`publishAgentEncryptionKey PUT <${url}> -> ${r.status} ${r.statusText}`);
  }
  return { url };
}

/**
 * Resolve an agent's published X25519 public key by following its pod. Returns
 * the base64 key, or null if the agent hasn't published one / it's unreadable.
 * Fail-safe so a writer falls back to self-only encryption (non-breaking).
 */
export async function resolveAgentEncryptionKey(
  agentPod: string,
  opts: { fetch?: FetchFn } = {},
): Promise<string | null> {
  const fetchFn = opts.fetch ?? getDefaultFetch();
  const url = `${podRootOf(agentPod)}${AGENT_ENCRYPTION_KEY_PATH}`;
  try {
    const r = await fetchFn(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const parsed = JSON.parse(await r.text()) as AgentEncryptionKey;
    return parsed && typeof parsed.publicKey === 'string' && parsed.publicKey ? parsed.publicKey : null;
  } catch {
    return null;
  }
}
