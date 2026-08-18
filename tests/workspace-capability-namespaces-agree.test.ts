/**
 * The two halves of `effective = role.permits ∩ principal's scope` must name the same terms.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * The fold computes effective capability by intersecting what a role PERMITS with what the
 * principal's delegated scope allows. Both sides are lists of IRIs and the intersection is a
 * literal string comparison. They were written against different namespaces:
 *
 *   - the client's `rolesTurtle()` minted `<rolesIri>#Read`, `#Post`, `#Convene` per workspace
 *   - `capabilitiesForScope()` returns the published `wsp-roles-default#read|append|grant|…`
 *
 * so the intersection was EMPTY for every member of every workspace the shipped client had ever
 * created. A Convener holding a full ReadWrite delegation had no capability at all.
 *
 * ★ AND 302 WORKSPACE TESTS PASSED THROUGHOUT, before the fix and after it. Every one of them
 * exercised one side or the other; none put the two together. That is the shape of this defect —
 * an empty effective set is indistinguishable from a correctly-restricted one, so nothing downstream
 * can notice, and each half is independently "correct". The only test that can catch it is one that
 * asserts the two vocabularies MEET.
 */

import { describe, it, expect } from 'vitest';
import { rolesTurtle } from '@interego/workspace-client';
import { CAPS, capabilitiesForScope } from '../applications/shared-workspace/src/can.js';

/** Every IRI the published role document permits, however the client chose to write it. */
function permittedIris(turtle: string): string[] {
  const out: string[] = [];
  // Per LINE, not up to the next '.', because every IRI here contains dots (github.io) — a
  // `[^.]+` clause stops inside the first hostname and finds nothing. Caught by this test failing
  // against a Turtle document that was already correct.
  for (const m of turtle.matchAll(/wsp:permits\s+([^\n]+)/g)) {
    for (const iri of (m[1] ?? '').matchAll(/<([^>]+)>/g)) out.push(iri[1] ?? '');
  }
  return [...new Set(out.filter(Boolean))];
}

const ROLES_IRI = 'https://relay.example/ns/alice/team-roles';

describe('the role profile and the scope map name the same capabilities', () => {
  it('★ a Convener with a ReadWrite delegation ends up with a NON-EMPTY effective set', () => {
    const permitted = permittedIris(rolesTurtle(ROLES_IRI));
    const scope = capabilitiesForScope('ReadWrite');
    const effective = permitted.filter((c) => (scope as readonly string[]).includes(c));
    // The exact assertion the product needs: not "the parser works", but "authority survives
    // the intersection". This failed before the fix with effective = [].
    expect(effective.length).toBeGreaterThan(0);
    expect(effective).toContain(CAPS.read);
    expect(effective).toContain(CAPS.append);
  });

  it('every capability the client permits is a term the scope map can grant', () => {
    // The stronger property: no orphans in either direction for the roles this client writes.
    // An orphan is not a type error and not a parse error — it is silently withheld authority.
    const permitted = permittedIris(rolesTurtle(ROLES_IRI));
    const known = new Set<string>(Object.values(CAPS));
    const orphans = permitted.filter((c) => !known.has(c));
    expect(orphans).toEqual([]);
  });

  it('the client mints no capability terms of its own under the workspace IRI', () => {
    // Roles are per-workspace; capabilities are published vocabulary. A `<rolesIri>#…` capability
    // is the client asserting its own governance under the workspace's name — the thing the role
    // profile's own documentation says not to do, and the mechanism of the original defect.
    const ttl = rolesTurtle(ROLES_IRI);
    expect(ttl).not.toMatch(/wsp:Capability/);
    for (const iri of permittedIris(ttl)) expect(iri.startsWith(ROLES_IRI + '#')).toBe(false);
  });

  it('a narrower delegation still narrows — the ceiling is real, not bypassed', () => {
    const permitted = permittedIris(rolesTurtle(ROLES_IRI));
    const readOnly = capabilitiesForScope('ReadOnly') as readonly string[];
    const effective = permitted.filter((c) => readOnly.includes(c));
    // The property the whole model exists for: a Convener whose agent holds ReadOnly can read and
    // nothing else. Fixing the namespace mismatch must not turn every role into full authority.
    expect(effective).toEqual([CAPS.read]);
  });

  it('an unrecognised scope still yields nothing', () => {
    const permitted = permittedIris(rolesTurtle(ROLES_IRI));
    const unknown = capabilitiesForScope('SomethingTheSubstrateAddedLater') as readonly string[];
    expect(permitted.filter((c) => unknown.includes(c))).toEqual([]);
  });
});
