/**
 * Foxxi adapter over the vertical-agnostic hypermedia core.
 *
 * The Richardson-Level-3 navigation machinery — entry-point fetch +
 * cache, link traversal, templated-link expansion, affordance lookup +
 * invocation — lives in `./hypermedia-core.tsx` and mentions nothing
 * Foxxi-specific. This file is the only Foxxi-aware piece: it pins the
 * entry-point URL.
 *
 * Every dashboard component imports its hypermedia primitives from here
 * (`./hypermedia.js`); they get the core implementation plus a
 * `HypermediaProvider` pre-wired to the Foxxi bridge's entry point.
 *
 * The core is deliberately decoupled so it can be promoted verbatim to
 * `applications/_shared/hypermedia-client/` once a second vertical needs
 * a hypermedia dashboard — see the promotion note in hypermedia-core.tsx.
 */

import React from 'react';
import { HypermediaProvider as CoreHypermediaProvider } from './hypermedia-core.js';

// Re-export the entire core surface so components import from one place.
export * from './hypermedia-core.js';

/** Foxxi bridge entry point — the one URL the dashboard must know. */
const ENTRY_URL_DEFAULT =
  (import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined
    ?? 'https://foxxi-bridge.interego.xwisee.com')
  + '/api/foxxi/v1';

/**
 * Foxxi-flavoured provider — the core provider with the Foxxi
 * entry-point URL defaulted in. `entryUrl` stays overridable (tests,
 * alternate deployments). This explicit local export shadows the
 * `HypermediaProvider` re-exported by `export *` above.
 */
export function HypermediaProvider(props: {
  bearer: string | null;
  entryUrl?: string;
  children: React.ReactNode;
}) {
  return (
    <CoreHypermediaProvider bearer={props.bearer} entryUrl={props.entryUrl ?? ENTRY_URL_DEFAULT}>
      {props.children}
    </CoreHypermediaProvider>
  );
}
