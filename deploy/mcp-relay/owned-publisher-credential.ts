/** Complete a missing proof for an existing own-session publisher, without
 * creating, restoring or rewriting any registry authority. */
import {
  createDelegationCredential, createSignedDelegationCredential, delegationCredentialToJsonLd, parseDelegationCredential,
  type AuthorizedAgentData, type DelegationSigner, type DelegationVerifier, type FetchFn, type IRI,
} from '@interego/core';
import { readAgentRegistry } from '@interego/solid';
import { verifyPrincipalDelegation } from './principal-delegation.js';

export class OwnedPublisherCredentialError extends Error {
  constructor(readonly code: 'publisher_authority_changed' | 'publisher_credential_unavailable' | 'publisher_credential_invalid') {
    super(code); this.name = 'OwnedPublisherCredentialError';
  }
}
const fail = (code: OwnedPublisherCredentialError['code']): never => { throw new OwnedPublisherCredentialError(code); };
const writable = (agent: AuthorizedAgentData | undefined, owner: IRI, now: string): agent is AuthorizedAgentData =>
  !!agent && !agent.revoked && ['ReadWrite', 'PublishOnly'].includes(agent.scope)
  && agent.delegatedBy === owner && Number.isFinite(Date.parse(agent.validFrom)) && Date.parse(agent.validFrom) <= Date.parse(now)
  && (!agent.validUntil || Number.isFinite(Date.parse(agent.validUntil)) && Date.parse(agent.validUntil) >= Date.parse(now));

export async function ensureOwnedPublisherCredential({
  podUrl, agentId, ownerWebId, identityBaseUrl, fetch, signer, verifier, now = Date.now,
}: {
  podUrl: string; agentId: IRI; ownerWebId: IRI; identityBaseUrl: string;
  fetch: FetchFn; signer: () => Promise<DelegationSigner>; verifier: DelegationVerifier; now?: () => number;
}): Promise<{ created: boolean }> {
  const profile = await readAgentRegistry(podUrl, { fetch });
  const agent = profile?.authorizedAgents.find(row => row.agentId === agentId);
  const instant = new Date(now()).toISOString();
  // Other delegation shapes retain their existing publication semantics. In
  // particular, a canonical principal may already have a valid legacy-alias or
  // sub-delegated credential; this helper must not rewrite or refuse that grant.
  if (!profile || profile.webId !== ownerWebId || !writable(agent, ownerWebId, instant)) return { created: false };
  const fingerprint = JSON.stringify(agent);
  const credentialUrl = podUrl + 'credentials/' + encodeURIComponent(agentId) + '.jsonld';
  let response = await fetch(credentialUrl, { method: 'GET', headers: { Accept: 'application/ld+json' } });
  let created = false;
  if (response.ok) return { created: false }; // Existing bytes are never repaired or replaced here.
  if (response.status === 404) {
    const credential = await createSignedDelegationCredential(profile, agent, podUrl as IRI, await signer());
    // A concurrent credential creator wins. Never replace a valid, invalid,
    // expired, unsigned or unreadable credential as a side effect of publishing.
    try {
      response = await fetch(credentialUrl, { method: 'PUT',
        headers: { 'Content-Type': 'application/ld+json', 'If-None-Match': '*' },
        body: delegationCredentialToJsonLd(credential) });
      created = response.ok;
    } catch {
      // A lost acknowledgement is settled by the reads below, never a PUT retry.
    }
  } else fail('publisher_credential_unavailable');

  // Re-read current authority after the write/race. An orphan VC has no registry
  // authority, and a concurrent owner narrowing/revocation is never undone.
  const after = await readAgentRegistry(podUrl, { fetch });
  const current = after?.authorizedAgents.find(row => row.agentId === agentId);
  if (!after || after.webId !== ownerWebId || !writable(current, ownerWebId, new Date(now()).toISOString())
    || JSON.stringify(current) !== fingerprint) fail('publisher_authority_changed');
  let verified;
  try {
    const observed = await fetch(credentialUrl, { method: 'GET', headers: { Accept: 'application/ld+json' } });
    if (!observed.ok) fail('publisher_credential_invalid');
    const bytes = await observed.text(), credential = parseDelegationCredential(bytes);
    const expected = createDelegationCredential(profile, agent, podUrl as IRI);
    if (credential.id !== credentialUrl || credential.issuer !== ownerWebId
      || credential.credentialSubject.id !== agentId || credential.credentialSubject.pod !== podUrl
      || credential.credentialSubject.delegatedBy !== ownerWebId || credential.expirationDate !== agent.validUntil
      || JSON.stringify(credential.credentialSubject.scope) !== JSON.stringify(expected.credentialSubject.scope)) fail('publisher_credential_invalid');
    // The cryptographic walk verifies precisely these observed credential bytes,
    // while still re-reading the current registry authority from the real store.
    const proofFetch: FetchFn = (url, init) => url === credentialUrl && (init?.method ?? 'GET') === 'GET'
      ? Promise.resolve(new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/ld+json' } }))
      : fetch(url, init);
    verified = await verifyPrincipalDelegation(agentId, podUrl, { identityBaseUrl, fetch: proofFetch, verifier });
  }
  catch { fail('publisher_credential_invalid'); }
  if (!verified.valid || verified.trustLevel !== 'CryptographicallyVerified' || verified.owner !== ownerWebId
    || verified.agent !== agentId || verified.scope !== agent.scope || verified.delegationSubject.basis !== 'exact') fail('publisher_credential_invalid');
  return { created };
}
