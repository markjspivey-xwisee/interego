/**
 * Compliance signing helpers — extracted from server.ts so the
 * re-fetch-then-sign contract can be unit-tested without booting the
 * full Express relay.
 */

import { signDescriptor } from '@interego/core';
import type { FetchFn, IRI, SignedDescriptor, Wallet } from '@interego/core';

/**
 * Re-fetch the published Turtle and sign the bytes the pod actually
 * persists — NOT the locally-built body. CSS / NSS / other LDP servers
 * routinely re-order prefixes, normalize whitespace, or add an LDP
 * `<>` triple block on PUT; signing the local body in that case makes
 * every audit signature fail to verify against what GET returns. The
 * re-fetch step is therefore audit-load-bearing — the test in
 * tests/relay-compliance-sign.test.ts pins this contract.
 */
export async function fetchAndSignCanonicalTurtle(
  descriptorUrl: string,
  descriptorId: IRI,
  wallet: Wallet,
  fetchImpl: FetchFn,
): Promise<{ signed: SignedDescriptor; canonicalTurtle: string }> {
  const ttlResp = await fetchImpl(descriptorUrl, {
    headers: { 'Accept': 'text/turtle' },
  });
  const canonicalTurtle = ttlResp.ok ? await ttlResp.text() : '';
  const signed = await signDescriptor(descriptorId, canonicalTurtle, wallet);
  return { signed, canonicalTurtle };
}
