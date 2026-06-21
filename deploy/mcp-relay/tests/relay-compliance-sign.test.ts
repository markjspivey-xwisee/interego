#!/usr/bin/env tsx
/**
 * Regression test for the compliance-publish signing contract.
 *
 * The fix at deploy/mcp-relay/server.ts:fetchAndSignCanonicalTurtle
 * re-fetches GET <descriptorUrl> with Accept: text/turtle and signs
 * THOSE bytes — not the locally-built body. This matters because the
 * pod's storage layer routinely re-orders prefixes, normalizes
 * whitespace, or appends an LDP `<>` block on PUT; if the relay signed
 * the local body in that case, every verifyDescriptorSignature against
 * what GET returns would fail and the audit signature would be
 * cryptographically valid but logically useless.
 *
 * This test pins the contract: a regression that signs the pre-PUT
 * body (or skips the re-fetch entirely) is caught here.
 *
 * Run from deploy/mcp-relay/:
 *   npx tsx tests/relay-compliance-sign.test.ts
 *
 * Exits non-zero on any failing assertion.
 */

import { createWallet, verifyDescriptorSignature } from '@interego/core';
import type { FetchFn, IRI } from '@interego/core';
import { fetchAndSignCanonicalTurtle } from '../compliance-sign.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    failures.push(name);
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${name}`);
  }
}

function mockFetchReturning(body: string, getCalls: string[]): FetchFn {
  return async (url, init) => {
    if (!init || (init.method ?? 'GET') === 'GET') {
      getCalls.push(url);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        text: async () => body,
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({}),
    };
  };
}

async function main(): Promise<void> {
  const wallet = await createWallet('agent', 'relay-compliance-test');
  const descriptorId = 'urn:iep:test:compliance:sign' as IRI;
  const descriptorUrl = 'https://pod.example/test/context-graphs/d.ttl';

  // The body publish() would have built locally — what the pod returns
  // differs (prefixes reordered + extra trailing newline + whitespace
  // tweak), simulating what a real LDP server does on PUT/GET round-trip.
  const localBody =
    '@prefix iep: <urn:iep:> .\n' +
    '@prefix prov: <http://www.w3.org/ns/prov#> .\n' +
    '<urn:iep:test:compliance:sign> a iep:ContextDescriptor ;\n' +
    '  iep:describes <urn:graph:test> .\n';
  const podBody =
    '@prefix prov: <http://www.w3.org/ns/prov#> .\n' +
    '@prefix iep: <urn:iep:> .\n' +
    '\n' +
    '<urn:iep:test:compliance:sign> a iep:ContextDescriptor ;\n' +
    '    iep:describes <urn:graph:test> .\n' +
    '\n';

  if (localBody === podBody) {
    throw new Error('test setup: localBody and podBody must differ to exercise the re-fetch contract');
  }

  // ── Scenario 1: helper re-fetches GET <descriptorUrl> with
  //   Accept: text/turtle and signs the GET body, not the local one.
  {
    const getCalls: string[] = [];
    const { signed, canonicalTurtle } = await fetchAndSignCanonicalTurtle(
      descriptorUrl,
      descriptorId,
      wallet,
      mockFetchReturning(podBody, getCalls),
    );

    ok(getCalls.length === 1 && getCalls[0] === descriptorUrl,
      'fetchAndSignCanonicalTurtle GETs the descriptor URL exactly once');
    ok(canonicalTurtle === podBody,
      'returned canonicalTurtle equals the pod-returned body (not the local body)');

    // The signature MUST verify against the pod body, NOT the local body.
    const vsPod = await verifyDescriptorSignature(signed, podBody);
    ok(vsPod.valid === true,
      'signature verifies against the pod-returned body');

    const vsLocal = await verifyDescriptorSignature(signed, localBody);
    ok(vsLocal.valid === false,
      'signature does NOT verify against the locally-built body (regression guard)');

    ok(signed.signerAddress === wallet.address,
      'signed.signerAddress is the relay compliance wallet address');
    ok(signed.descriptorId === descriptorId,
      'signed.descriptorId is the descriptor IRI');
  }

  // ── Scenario 2: if GET fails (non-200), the helper signs the empty
  //   string rather than silently falling back to local bytes. The
  //   resulting signature still verifies against '' so an auditor can
  //   detect "the pod gave us nothing" instead of seeing a forged-looking
  //   mismatch. Pins the current behavior — flipping the fallback to
  //   sign local bytes would require updating both this assertion and
  //   the helper deliberately.
  {
    const fetch500: FetchFn = async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      headers: { get: () => null },
      text: async () => 'oops',
      json: async () => ({}),
    });
    const { signed, canonicalTurtle } = await fetchAndSignCanonicalTurtle(
      descriptorUrl,
      descriptorId,
      wallet,
      fetch500,
    );
    ok(canonicalTurtle === '',
      'non-200 GET falls back to empty canonicalTurtle (not local body)');
    const vsEmpty = await verifyDescriptorSignature(signed, '');
    ok(vsEmpty.valid === true,
      'signature verifies against the empty string the helper actually signed');
  }

  // eslint-disable-next-line no-console
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    // eslint-disable-next-line no-console
    console.error('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
