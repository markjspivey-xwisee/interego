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
 * A built-in profile is not published through the authoring routes. What a published version is
 * kept with, the deployment keeps with these from code (`builtInKept`): the examples the lint is
 * run with, and the terms of other publishers the templates name. Foxxi's statements use ADL's and
 * cmi5's verbs and activity types, which those specifications fix; they are named here as
 * external terms and are not concepts of Foxxi's profile.
 */
import { buildFoxxiProfileDoc, FOXXI_EXTERNAL_TERMS, FOXXI_PROFILE_ID } from '../xapi-profile.js';
import { PROFILE_GENERATED_AT } from '../xapi-lrs.js';
import { buildXapixProfileDoc, buildXapixProfileDocV1, XAPIX_PROFILE_V1_ID, XAPIX_PROFILE_VERSION_ID } from '../xapix/profile.js';
import { foxxiProfileExamples, xapixProfileExamples, xapixProfileV1Examples } from '../built-in-profile-examples.js';
import type { ExternalTerm, ProfileExamples } from './lint.js';
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

/**
 * What each built-in profile version is kept with: its examples and the external terms its
 * templates name. `profile` names a profile (its current version) or one version: the xapi-x
 * profile is held in two versions, and each has its own examples.
 */
export function builtInKept(): Array<{ profile: string; examples: ProfileExamples; external: ExternalTerm[] }> {
  return [
    { profile: FOXXI_PROFILE_ID, examples: foxxiProfileExamples(), external: FOXXI_EXTERNAL_TERMS.map(t => ({ ...t })) },
    { profile: XAPIX_PROFILE_V1_ID, examples: xapixProfileV1Examples(), external: [] },
    { profile: XAPIX_PROFILE_VERSION_ID, examples: xapixProfileExamples(), external: [] },
  ];
}
