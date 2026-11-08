/**
 * The one rule for a vertical's operator-set "Contact" link (PEV_CONTACT_URL, WRD_CONTACT_URL).
 *
 * The value comes only from the operator's environment and ends up inside an href on every
 * public page, so it is checked here, on the server, before any page is built. Two shapes pass:
 *
 *   - an https page: no user name or password, a host, and no `@` anywhere; returned as the URL
 *     parser's normalised href;
 *   - a mailto: link to exactly ONE address and nothing else: no query (`?subject=`, `?cc=`), no
 *     fragment, no percent-escape (so no encoded line break or second header), no comma (so no
 *     second recipient), no space and no second `@`. The local part is 1 to 64 of
 *     A-Z a-z 0-9 . _ + -, the domain two or more labels of 1 to 63 of A-Z a-z 0-9 -, and the
 *     address at most 254 characters. The scheme may be in any case. The link is rebuilt from
 *     the matched parts (`mailto:` + local part + `@` + the domain lower-cased), never taken
 *     from a URL parser's output.
 *
 * Everything else (javascript:, data:, http:, a relative path, a page with credentials, a mailto
 * with headers or two addresses, an empty value) is null, and the caller keeps its default link.
 * The value is trimmed first; one over 500 characters is null.
 *
 * No environment reads, no I/O: the caller decides what an unusable value means.
 */

/** The longest value read at all, before any other check. */
export const CONTACT_RAW_MAX = 500;
/** The longest address a mailto: link may carry. */
const ADDRESS_MAX = 254;
/** One address: the local part, then a domain of two or more labels. Nothing else fits. */
const ADDRESS = /^([A-Za-z0-9._+-]{1,64})@([A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+)$/;
const MAILTO = /^mailto:/i;

/** An operator's contact value as a page may link it, or null when it is not one this allows. */
export function contactHrefOf(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value.length > CONTACT_RAW_MAX) return null;
  if (MAILTO.test(value)) {
    const address = value.slice('mailto:'.length);
    if (address.length > ADDRESS_MAX) return null;
    const m = ADDRESS.exec(address);
    if (m === null) return null;
    const [, local, domain] = m;
    if (local === undefined || domain === undefined) return null;
    return `mailto:${local}@${domain.toLowerCase()}`;
  }
  if (value.includes('@')) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.hostname === '') return null;
  return u.href;
}

/**
 * How a startup line may name a contact value without printing an email address: an accepted
 * https page as itself; an accepted mailto: link by its domain only; any other value with an `@`
 * (or an escaped one) in it as "not shown"; anything else quoted, cut to 120 characters.
 */
export function contactForLog(raw: string): string {
  const href = contactHrefOf(raw);
  if (href !== null && href.startsWith('mailto:')) return `a mailto: link to one address at ${href.slice(href.indexOf('@') + 1)} (the address itself is not printed)`;
  if (href !== null) return href;
  if (/@|%40/i.test(raw)) return 'a value with an @ in it (not printed)';
  return JSON.stringify(raw.trim().slice(0, 120));
}
