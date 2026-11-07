/** Canonical HTTPS origins for explicitly opted-in native browser operations. */
export function relayOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value || u.port || u.username || u.password || !u.hostname.includes('.') || u.hostname.startsWith('[')) throw new Error('Enter the relay’s HTTPS address without a path.');
  return u.origin;
}
