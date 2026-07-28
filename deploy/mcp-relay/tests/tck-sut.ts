#!/usr/bin/env tsx
/**
 * SUT harness for the A2A protocol's OWN conformance suite (a2a-tck).
 *
 * The profile publishes `a2ap:conformanceStatus "unverified"`, and the published
 * definition of that term is deliberately narrow: VERIFIED means the protocol's own
 * conformance suite passes in continuous integration — not that the implementation
 * was written against the specification. Every implementation is written against the
 * specification; that is not evidence of anything. This harness exists so the claim
 * can be earned rather than asserted.
 *
 * WHAT IS AND IS NOT UNDER TEST. This boots the real `mountAgentInterop` against the
 * real profile registry — the same code path the relay serves in production, not a
 * reimplementation. What it does NOT boot is the relay's authentication stack, CSS,
 * or database. `verifyCaller` returns a fixed principal.
 *
 * That is a deliberate scoping decision, not a shortcut, and it is worth being exact
 * about why: A2A leaves authentication to the transport and declares its schemes in
 * the card. The TCK's job is the wire protocol — task lifecycle, message shapes,
 * error codes, card structure. Standing up OAuth in CI would test our identity
 * substrate, which already has its own 274 assertions, and would test it under a
 * suite that is not asking about it. The conformance claim this earns is therefore
 * exactly "the wire protocol conforms", which is what the claim says.
 *
 * The capability list is real: the same `ResolvedAffordance` shape the relay derives
 * its card from, so the TCK sees genuine dereferenceable capability ids rather than
 * fixtures shaped to pass.
 *
 * Usage:  tsx tests/tck-sut.ts [port]      # prints the base URL, then serves
 */

import express from 'express';
import { mountAgentInterop } from '../agent-interop-mount.js';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8930);

// A capability set in the substrate's own vocabulary. Ids are dereferenceable URLs
// under the relay's action namespace — the invariant `a2ap:CardShape` pins, and the
// thing the projection DROPS a capability for lacking.
const AFFORDANCES = [
  {
    action: 'https://relay.interego.xwisee.com/ns/iep/action/relay/mint',
    name: 'mint',
    description: 'Kernel verb — content-addressed mint of a context node.',
    target: 'https://relay.interego.xwisee.com/tool/mint',
    method: 'POST' as const,
    mediaType: 'application/json',
  },
  {
    action: 'https://relay.interego.xwisee.com/ns/iep/action/relay/discover',
    name: 'discover',
    description: 'Discover published context descriptors across the fabric.',
    target: 'https://relay.interego.xwisee.com/tool/discover',
    method: 'POST' as const,
    mediaType: 'application/json',
  },
];

const app = express();
app.use(express.json());

const base = `http://127.0.0.1:${port}`;

mountAgentInterop(app as any, {
  publicBase: base,
  agent: {
    id: `${base}/.well-known/operations`,
    name: 'Interego Relay (TCK SUT)',
    description: 'Composable, verifiable, federated context infrastructure.',
  },
  affordances: () => AFFORDANCES as any,
  // Fixed principal — see the scoping note above.
  verifyCaller: async () => 'did:ethr:0x00000000000000000000000000000000000000A2',
  // A real (if tiny) capability implementation, so the harness exercises the
  // execute path rather than a stub: `mint` echoes a content-addressed digest of
  // its input, `discover` refuses as write-side would. Nothing is fabricated —
  // what comes back is computed from what went in.
  invokeCapability: async ({ capability, parts }) => {
    const verb = capability.split('/').pop() ?? '';
    if (verb === 'discover') return { ok: false as const, reason: `capability "${verb}" is not reachable through this interop surface` };
    const text = parts.map(p => (p.kind === 'text' ? p.text ?? '' : JSON.stringify(p))).join(' ');
    const { createHash } = await import('node:crypto');
    return {
      ok: true as const,
      output: {
        name: verb,
        description: `Result of ${verb}`,
        parts: [{ kind: 'text' as const, text: `sha256:${createHash('sha256').update(text).digest('hex')}` }],
      },
    };
  },
  log: () => {},
});

app.listen(port, '127.0.0.1', () => {
  // The runner waits on this line, so it must be the first thing written.
  console.log(`SUT_READY ${base}`);
});
