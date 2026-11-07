/* Public account-link result validation. These metadata URLs are never fetch or navigation targets. */
import { relayOrigin } from './native-origin.mjs';

export const LINK_CODE = /^interego-link:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
const failure = 'The account-link response could not be verified. Start again from your identity dashboard.';

export function identityProviderOrigin(value) {
  try { return relayOrigin(value); } catch { throw new Error('Enter the identity provider’s HTTPS address without a path.'); }
}
export function dashboardSender(sender, runtime, providers) {
  if (sender?.id !== runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) throw new Error('Open your identity dashboard in the main browser tab.');
  let u;
  try { u = new URL(sender.url); } catch { throw new Error('Open your identity dashboard to link this computer.'); }
  if (u.pathname !== '/dashboard' || u.hash || u.username || u.password || !providers.includes(identityProviderOrigin(u.origin))) throw new Error('Account linking is not enabled for this identity provider.');
  // Dashboard login may use a provider-owned query token. Never inspect, forward or retain it.
  return new URL('/dashboard', u.origin);
}
export function validatedLinkedResult(value, identityOrigin) {
  if (!exact(value, ['state', 'identityOrigin', 'owner', 'credentialDid']) || value.state !== 'linked' || value.identityOrigin !== identityOrigin
    || !exact(value.owner, ['userId', 'did', 'webId', 'podUrl', 'displayName']) || !text(value.owner.userId, 200)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value.owner.userId) || !text(value.owner.displayName, 160)
    || !/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(value.credentialDid)) throw new Error(failure);
  const { userId, did, webId, podUrl, displayName } = value.owner;
  const expectedDid = `did:web:${new URL(identityOrigin).host.replace(/:/g, '%3A')}:users:${userId}`;
  if (did !== expectedDid || webId !== `${identityOrigin}/users/${userId}/profile#me` || !text(podUrl, 2048)) throw new Error(failure);
  let pod;
  try { pod = new URL(podUrl); } catch { throw new Error(failure); }
  if (!['https:', 'http:'].includes(pod.protocol) || pod.username || pod.password || pod.search || pod.hash || pod.href !== podUrl || !pod.pathname.endsWith(`/${userId}/`)) throw new Error(failure);
  return { state: 'linked', identityOrigin, owner: { userId, did, webId, podUrl, displayName }, credentialDid: value.credentialDid };
}
