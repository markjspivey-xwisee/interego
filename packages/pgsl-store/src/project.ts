/**
 * Mediator-side, ABAC-filtered project-on-read.
 *
 * Reads a holon, evaluates each constituent atom through the PDP, and
 * VALUE-REDACTS the ones the requester may not see IN PLACE: the atom URI, its
 * position, and the fragment's arity/level are all preserved, so the partial
 * view is still structurally a valid Fragment (nothing shifts, no list slot
 * disappears, the level = item count is intact). Disclosure is MONOTONE — more
 * clearance only reveals more values, never changes structure — so the SAME
 * holon projects DIFFERENT bytes per requester (atom-granular selective
 * disclosure). This mirrors the existing encrypted-atom placeholder pattern,
 * chosen per-requester instead of once at mint.
 *
 * Runs only in a trusted mediator (see abac-pdp.ts). Fail-closed: only an
 * explicit 'Allowed' verdict discloses a value.
 */

import type { PgslStore } from './store.js';
import type { Pdp } from './abac-pdp.js';

export interface ProjectedAtom {
  uri: string;
  position: number;
  redacted: boolean;
  /** Present iff not redacted. */
  value?: string | number | boolean;
}

export interface ProjectedHolon {
  topUri: string;
  level: number;
  /** Positionally complete — one entry per constituent, redacted or not. */
  items: ProjectedAtom[];
  withheldCount: number;
  /** True iff any atom was redacted for this requester. */
  partial: boolean;
}

export async function projectHolonFor(
  store: PgslStore,
  topUri: string,
  pdp: Pdp,
  opts: { scope?: string } = {},
): Promise<ProjectedHolon> {
  const top = await store.resolve(topUri);
  if (!top) throw new Error(`projectHolonFor: holon not found: ${topUri}`);

  const scope = opts.scope ?? topUri; // edge-scoped attributes: the containing holon
  const itemUris = top.kind === 'fragment' ? top.items ?? [] : [topUri];
  const attrs = await store.getHolonAtomAttributes(scope);

  const items: ProjectedAtom[] = [];
  let withheld = 0;
  for (let position = 0; position < itemUris.length; position++) {
    const uri = itemUris[position]!;
    const verdict = pdp.decide(attrs.get(uri));
    if (verdict === 'Allowed') {
      const node = await store.resolve(uri);
      items.push({ uri, position, redacted: false, value: node?.value });
    } else {
      items.push({ uri, position, redacted: true }); // structure kept, value withheld
      withheld++;
    }
  }

  return { topUri, level: top.level, items, withheldCount: withheld, partial: withheld > 0 };
}
