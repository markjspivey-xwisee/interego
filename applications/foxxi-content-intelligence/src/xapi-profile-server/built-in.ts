/**
 * The profiles that are part of the deployment: served from its code, never added, never taken down.
 *
 *   Foxxi's own profile   what Foxxi's emitters write.
 *   the xapi-x profile    what a statement carries when it is a projection of a signed descriptor
 *                         (../xapix/profile.ts).
 *
 * The xapi-x profile's IRIs are on the relay's origin, where the pod serves its graph. This server
 * holds the same document, so the specification's three operations (SPARQL, validate a statement,
 * validate a sequence) and the resolver answer for it: a pod serves triples and judges nothing.
 * Both are built from the one function, so the two cannot say different things.
 *
 * A built-in profile is not published through the authoring routes, so it has no stored examples.
 * Its examples are in its tests, which lint it with the lint a published profile has to pass.
 */
import { buildFoxxiProfileDoc } from '../xapi-profile.js';
import { PROFILE_GENERATED_AT } from '../xapi-lrs.js';
import { buildXapixProfileDoc, buildXapixProfileDocV1 } from '../xapix/profile.js';
import type { Json } from './rdf.js';

export function builtInProfiles(): Json[] {
  return [
    buildFoxxiProfileDoc({ generatedAt: PROFILE_GENERATED_AT }) as unknown as Json,
    // Version 1 stays held beside the current one: statements written before the projection
    // category existed are judged against it, and its IRI has been served since it was published.
    buildXapixProfileDocV1() as Json,
    buildXapixProfileDoc() as Json,
  ];
}
