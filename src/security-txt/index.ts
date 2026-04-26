/**
 * @module security-txt
 * @description RFC 9116 security.txt body builder.
 *
 *   Every Interego container app serves /.well-known/security.txt to
 *   give security researchers a coordinated-disclosure contact. This
 *   module is the single source of truth for the body — five servers
 *   share it so the policy URL, expiry date, and acknowledgments link
 *   change in one place.
 *
 *   The Expires field is a hard requirement of RFC 9116 §2.5.5
 *   (must be ≤ 1 year). The default below is enforced by the
 *   companion CI check `tools/security-txt-expiry-check.mjs` to fail
 *   builds when the date drifts within 30 days of expiry.
 */

export interface SecurityTxtOptions {
  /**
   * Researcher contact URI. mailto:, https:, or tel: per RFC 9116 §2.5.4.
   * If omitted, falls back to opening a GitHub Security Advisory on
   * the project's repo — a guaranteed-routable channel that does not
   * depend on the operator having a monitored email domain.
   */
  readonly contact?: string;

  /**
   * Canonical URL of this security.txt, per RFC 9116 §2.5.6. Recommended
   * when reachable at multiple URLs (e.g., on a custom domain + the
   * Azure Container App default hostname). Pass the public-facing URL
   * of the surface; if omitted, the Canonical line is suppressed.
   */
  readonly canonicalBaseUrl?: string;

  /**
   * ISO 8601 timestamp at which this file expires (RFC 9116 §2.5.5).
   * Default: '2027-01-01T00:00:00Z'. Refresh annually per
   * spec/policies/14-vulnerability-management.md §5.3.
   */
  readonly expires?: string;
}

const DEFAULT_CONTACT_FALLBACK =
  'https://github.com/markjspivey-xwisee/interego/security/advisories/new';
const DEFAULT_EXPIRES = '2027-01-01T00:00:00Z';
const POLICY_URL =
  'https://github.com/markjspivey-xwisee/interego/blob/main/spec/policies/14-vulnerability-management.md';
const ACKNOWLEDGMENTS_URL =
  'https://github.com/markjspivey-xwisee/interego/blob/main/SECURITY-ACKNOWLEDGMENTS.md';

export function buildSecurityTxt(opts: SecurityTxtOptions = {}): string {
  const contact = opts.contact ?? DEFAULT_CONTACT_FALLBACK;
  const expires = opts.expires ?? DEFAULT_EXPIRES;
  const lines: string[] = [
    contact.startsWith('mailto:') || contact.startsWith('https:') || contact.startsWith('tel:')
      ? `Contact: ${contact}`
      : `Contact: mailto:${contact}`,
    `Expires: ${expires}`,
    `Preferred-Languages: en`,
  ];
  if (opts.canonicalBaseUrl) {
    const base = opts.canonicalBaseUrl.replace(/\/$/, '');
    lines.push(`Canonical: ${base}/.well-known/security.txt`);
  }
  lines.push(`Policy: ${POLICY_URL}`);
  lines.push(`Acknowledgments: ${ACKNOWLEDGMENTS_URL}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Read the security.txt body from process env. Centralizes the
 * `SECURITY_CONTACT` env-var convention every server uses.
 */
export function buildSecurityTxtFromEnv(canonicalBaseUrl?: string): string {
  return buildSecurityTxt({
    contact: process.env['SECURITY_CONTACT'],
    canonicalBaseUrl,
  });
}
