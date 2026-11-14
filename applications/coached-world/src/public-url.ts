/**
 * The address people reach this world at, when that is not the address it listens on.
 *
 * Behind a proxy the process binds a private port, and everything it tells a browser about
 * itself (the guest audience, where to bootstrap, the base of every graph IRI, the DID host)
 * has to be the public origin instead. That origin is configuration, so it is checked once, at
 * start: an origin and nothing else, over https, or over http only on this machine.
 */

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicUrlError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** The origin `value` names, or a refusal that says what is wrong with it. */
export function publicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new PublicUrlError(`the public URL is not a URL: ${JSON.stringify(value)}`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new PublicUrlError(`the public URL must be https (http only for localhost or 127.0.0.1): ${JSON.stringify(value)}`);
  }
  if (url.username || url.password) throw new PublicUrlError('the public URL must not carry credentials');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new PublicUrlError(`the public URL must be an origin with no path, query or fragment: ${JSON.stringify(value)}`);
  }
  return url.origin;
}
