/** Validate a provider-issued account link without accepting a browser account claim. */
import type { LocalIdentityLinkContext, LocalIdentityLinkedReceipt, LocalIdentityLinkOwner } from './local-identity-types.js';
import { IDENTITY_ERROR, IDENTITY_NONCE, identityObject, identityOrigin, identityText } from './local-identity-protocol.js';

export const IDENTITY_LINK_HANDOFF = /^interego-link:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const COMPLETION = /^interego-link-result:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
function owner(value: unknown, provider: string): LocalIdentityLinkOwner {
  const raw = identityObject(value, ['userId', 'did', 'webId', 'podUrl', 'displayName']);
  const userId = identityText(raw['userId'], 128);
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error(IDENTITY_ERROR);
  const did = identityText(raw['did'], 512); const webId = identityText(raw['webId'], 2048);
  if (did !== `did:web:${new URL(provider).hostname}:users:${userId}` || webId !== `${provider}/users/${userId}/profile#me`) throw new Error(IDENTITY_ERROR);
  const podUrl = identityText(raw['podUrl'], 2048); const pod = new URL(podUrl);
  // The provider's exact pod is display data, never an outbound request or navigation target.
  if (!['http:', 'https:'].includes(pod.protocol) || pod.href !== podUrl || pod.username || pod.password || pod.search || pod.hash || !pod.pathname.endsWith(`/${userId}/`)) throw new Error(IDENTITY_ERROR);
  const displayName = raw['displayName'];
  if (typeof displayName !== 'string' || displayName.length > 160 || /[\u0000-\u001f\u007f]/.test(displayName)) throw new Error(IDENTITY_ERROR);
  return { userId, did, webId, podUrl, displayName };
}
function expiry(value: unknown, now: number): string {
  const text = identityText(value, 64); const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text || time <= now || time > now + 125_000) throw new Error(IDENTITY_ERROR);
  return text;
}
export function localIdentityLinkContext(value: unknown, provider: string, credentialDid: string, now: number, allowLoopback = false): LocalIdentityLinkContext {
  identityOrigin(provider, allowLoopback);
  const raw = identityObject(value, ['version', 'purpose', 'issuer', 'identityOrigin', 'pendingId', 'owner', 'credentialDid', 'nonce', 'message', 'expiresAt', 'challengeExpiresAt', 'completionCode']);
  if (raw['version'] !== 1 || raw['purpose'] !== 'link' || raw['issuer'] !== provider || raw['identityOrigin'] !== provider || raw['credentialDid'] !== credentialDid) throw new Error(IDENTITY_ERROR);
  const pendingId = identityText(raw['pendingId'], 43); const nonce = identityText(raw['nonce'], 43);
  if (![pendingId, nonce].every(text => IDENTITY_NONCE.test(text))) throw new Error(IDENTITY_ERROR);
  const account = owner(raw['owner'], provider); const expiresAt = expiry(raw['expiresAt'], now); const challengeExpiresAt = expiry(raw['challengeExpiresAt'], now);
  const message = `Interego local identity link v1\nHost: ${new URL(provider).host}\nAccount: ${account.did}\nPod: ${account.podUrl}\nCredential: ${credentialDid}\nRequest: ${pendingId}\nNonce: ${nonce}\nExpires: ${expiresAt}`;
  if (raw['message'] !== message) throw new Error(IDENTITY_ERROR);
  const completionCode = identityText(raw['completionCode'], 256); if (!COMPLETION.test(completionCode)) throw new Error(IDENTITY_ERROR);
  return { version: 1, purpose: 'link', issuer: provider, identityOrigin: provider, pendingId, owner: account, credentialDid, nonce, message, expiresAt, challengeExpiresAt, completionCode };
}
export function localIdentityLinkedReceipt(value: unknown, context: LocalIdentityLinkContext): LocalIdentityLinkedReceipt {
  const raw = identityObject(value, ['linked', 'identityOrigin', 'owner', 'credentialDid']);
  if (raw['linked'] !== true || raw['identityOrigin'] !== context.identityOrigin || raw['credentialDid'] !== context.credentialDid) throw new Error(IDENTITY_ERROR);
  const account = owner(raw['owner'], context.identityOrigin);
  if (JSON.stringify(account) !== JSON.stringify(context.owner)) throw new Error(IDENTITY_ERROR);
  return { linked: true, identityOrigin: context.identityOrigin, owner: account, credentialDid: context.credentialDid };
}
