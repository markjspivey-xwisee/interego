/**
 * A strict reader for ERC-4361 ("Sign-In with Ethereum") messages.
 *
 * The identity server accepts a wallet signature only over a message a wallet itself reads as
 * a sign-in: wallets show the message's domain line and warn when it does not match the page
 * asking for the signature, and that warning is what stops a nonce from this server being
 * signed on another site. A wallet runs that check only on text its ERC-4361 parser accepts
 * (MetaMask: @spruceid/siwe-parser); anything else it shows as a plain signature request, with
 * no domain check at all. So this reader accepts a SUBSET of what that parser accepts, never
 * more: exact bytes, LF line ends, the fixed field order, no leading or trailing whitespace.
 * tests/siwe-message.test.ts checks the subset claim against siwe-parser itself.
 *
 * What it deliberately leaves to the caller: whether the domain and URI name this deployment,
 * whether the address is in EIP-55 form (that needs keccak, which the server has from ethers),
 * and whether the nonce and times fit the challenge.
 */

export const SIWE_DOMAIN_SUFFIX = ' wants you to sign in with your Ethereum account:';

export interface SiweMessageFields {
  readonly domain: string;
  readonly address: string;
  readonly statement?: string;
  readonly uri: string;
  readonly version: '1';
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expirationTime?: string;
  readonly notBefore?: string;
  readonly requestId?: string;
  readonly resources?: readonly string[];
}

export type SiweParse =
  | { ok: true; fields: SiweMessageFields }
  | { ok: false; reason: string };

// A host with an optional port, lowercase ASCII only (URL.host is lowercase, and so is every
// host this server admits). No scheme, no userinfo, no IPv6 literal.
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// ERC-4361: statement = *( reserved / unreserved / " " ), one line.
const STATEMENT = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+$/;
// RFC 3986 characters only, with a scheme; '%' only as a percent-escape.
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const NONCE = /^[A-Za-z0-9]{8,}$/;
const CHAIN_ID = /^[1-9][0-9]*$/;
const REQUEST_ID = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]*$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isUri(s: string): boolean {
  if (!URI.test(s) || /%(?![0-9A-Fa-f]{2})/.test(s)) return false;
  try { new URL(s); return true; } catch { return false; }
}

/** RFC 3339 date-time with real calendar values (no 30 February). */
function isDateTime(s: string): boolean {
  const m = DATE_TIME.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
  if (m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59)) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth && Number.isFinite(Date.parse(s));
}

/** Read `text` as an ERC-4361 message, or say which part of it is not one. */
export function parseSiweMessage(text: string): SiweParse {
  if (text.includes('\r')) return { ok: false, reason: 'lines must end with LF alone (no CR)' };
  const lines = text.split('\n');
  let i = 0;
  const next = (): string | undefined => lines[i++];
  const fail = (reason: string): SiweParse => ({ ok: false, reason });

  const first = next() ?? '';
  if (!first.endsWith(SIWE_DOMAIN_SUFFIX)) return fail(`the first line must be "<host>${SIWE_DOMAIN_SUFFIX}"`);
  const domain = first.slice(0, -SIWE_DOMAIN_SUFFIX.length);
  if (!DOMAIN.test(domain)) return fail('the domain on the first line must be a bare lowercase host (and port), with nothing before it');

  const address = next() ?? '';
  if (!ADDRESS.test(address)) return fail('the second line must be the 0x address of the signing wallet, alone');
  if (next() !== '') return fail('a blank line must follow the address');

  let statement: string | undefined;
  const third = next();
  if (third === undefined) return fail('the message ends after the address');
  if (third !== '') {
    if (!STATEMENT.test(third)) return fail('the statement must be one line of ERC-4361 statement characters');
    statement = third;
    if (next() !== '') return fail('a blank line must follow the statement');
  }

  const field = (label: string): string | null => {
    const line = lines[i];
    if (line === undefined || !line.startsWith(`${label}: `)) return null;
    i++;
    return line.slice(label.length + 2);
  };

  const uri = field('URI');
  if (uri === null || !isUri(uri)) return fail('a "URI: <absolute URI>" line must follow');
  if (field('Version') !== '1') return fail('a "Version: 1" line must follow the URI');
  const chainId = field('Chain ID');
  if (chainId === null || !CHAIN_ID.test(chainId)) return fail('a "Chain ID: <number>" line must follow the version');
  const nonce = field('Nonce');
  if (nonce === null || !NONCE.test(nonce)) return fail('a "Nonce: <at least 8 letters or digits>" line must follow the chain ID');
  const issuedAt = field('Issued At');
  if (issuedAt === null || !isDateTime(issuedAt)) return fail('an "Issued At: <RFC 3339 date-time>" line must follow the nonce');

  let expirationTime: string | undefined;
  let notBefore: string | undefined;
  let requestId: string | undefined;
  let resources: string[] | undefined;
  if (lines[i]?.startsWith('Expiration Time: ')) {
    expirationTime = field('Expiration Time')!;
    if (!isDateTime(expirationTime)) return fail('Expiration Time must be an RFC 3339 date-time');
  }
  if (lines[i]?.startsWith('Not Before: ')) {
    notBefore = field('Not Before')!;
    if (!isDateTime(notBefore)) return fail('Not Before must be an RFC 3339 date-time');
  }
  if (lines[i]?.startsWith('Request ID: ')) {
    requestId = field('Request ID')!;
    if (!REQUEST_ID.test(requestId)) return fail('Request ID has characters ERC-4361 does not allow');
  }
  if (lines[i] === 'Resources:') {
    i++;
    resources = [];
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line.startsWith('- ') || !isUri(line.slice(2))) return fail('each resource must be a "- <absolute URI>" line');
      resources.push(line.slice(2));
      i++;
    }
  }
  if (i !== lines.length) return fail(`line ${i + 1} is not an ERC-4361 field in its place (the optional fields are Expiration Time, Not Before, Request ID, Resources, in that order, and nothing may follow them)`);

  return { ok: true, fields: {
    domain, address, uri, version: '1', chainId: Number(chainId), nonce, issuedAt,
    ...(statement !== undefined ? { statement } : {}),
    ...(expirationTime !== undefined ? { expirationTime } : {}),
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(resources !== undefined ? { resources } : {}),
  } };
}
