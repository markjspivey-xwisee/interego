/**
 * The first xapi-x profile: an xAPI Profiles 1.0 document that declares the four `iep:` keys a
 * descriptor projection already carries under `result.extensions`, and one statement template
 * that holds a projection to them.
 *
 * Nothing here changes what any emitter writes. The lrs-adapter has written these keys for as
 * long as it has projected descriptors, and no profile declared them, so a profile processor
 * could say nothing about them. This is that declaration.
 *
 * The concepts' ids are the `iep:` IRIs as they are in stored statements. A profile may define a
 * concept whose IRI is not under the profile's own; the specification asks only that a version's
 * id differ from the profile's. xapi-x does not mint a second name for a key that is already in
 * other people's stores.
 *
 * The template states no determining property, because nothing in a statement the adapter writes
 * today marks it as a projection except these keys: its verb and object are the caller's. So,
 * within this profile, every statement matches the template, and a statement without the keys is
 * invalid rather than unmatched. That is the question this profile answers ("is this a
 * well-formed projection?"). ../../xapix/README.md, section 7, says how a later version selects
 * on a category instead.
 */
import { buildProfileDoc } from '../xapi-profile.js';
import { IEP_DECORATIONS, MODAL_STATUSES, XAPIX_PROFILE_ID } from './namespace.js';

/** When version 1 of the profile was written. A constant: a profile version does not change with the clock. */
export const XAPIX_PROFILE_GENERATED_AT = '2026-11-15T00:00:00.000Z';
export const XAPIX_PROFILE_VERSION_ID = `${XAPIX_PROFILE_ID}/v/1`;
export const XAPIX_PROJECTION_TEMPLATE_ID = `${XAPIX_PROFILE_ID}/templates/descriptor-projection`;

const schema = (s: object): string => JSON.stringify(s);
const at = (key: string): string => `$.result.extensions['${key}']`;

const concepts = [
  {
    id: IEP_DECORATIONS.sourceDescriptor, type: 'ResultExtension',
    prefLabel: { en: 'source descriptor' },
    definition: { en: 'The IRI of the signed context descriptor this statement is a projection of. The descriptor is the record; the statement is a view of it for systems that read xAPI. Fetch the descriptor to verify the claim, read what the projection left out, or act on it.' },
    inlineSchema: schema({ type: 'string', format: 'iri' }),
  },
  {
    id: IEP_DECORATIONS.modalStatus, type: 'ResultExtension',
    prefLabel: { en: 'modal status' },
    definition: { en: 'Whether the source descriptor asserts its claim (Asserted), puts it forward without committing to it (Hypothetical), states what did not happen (Counterfactual), or repeats a claim someone else made without endorsing it (Quoted). A statement that is not Asserted is not evidence that anything occurred: it must not be counted as a completion, a success, a score or an attempt.' },
    inlineSchema: schema({ enum: [...MODAL_STATUSES] }),
  },
  {
    id: IEP_DECORATIONS.coherentNarratives, type: 'ResultExtension',
    prefLabel: { en: 'coherent narratives' },
    definition: { en: 'Every reading the source descriptor holds as coherent, in its order. `result.response` carries only the first, so a reader of `result.response` alone sees one reading of several.' },
    inlineSchema: schema({ type: 'array', items: { type: 'string' }, minItems: 1 }),
  },
  {
    id: IEP_DECORATIONS.projectionLossy, type: 'ResultExtension',
    prefLabel: { en: 'projection lossy' },
    definition: { en: 'True when the statement says less than the descriptor it was projected from, false when it says as much. Statements written before 2026-11-15 carry it only when it is true, so on those an absent value means not stated, not false.' },
    inlineSchema: schema({ type: 'boolean' }),
  },
];

const templates = [
  {
    id: XAPIX_PROJECTION_TEMPLATE_ID,
    prefLabel: { en: 'descriptor projection' },
    definition: { en: 'A statement projected from a signed context descriptor names that descriptor and states its modal status. Where it says whether the projection is lossy, it says so with a boolean.' },
    rules: [
      { location: at(IEP_DECORATIONS.sourceDescriptor), presence: 'included' },
      { location: at(IEP_DECORATIONS.modalStatus), presence: 'included', any: [...MODAL_STATUSES] },
      // No presence stated: absent passes, and a value that is not a boolean does not.
      { location: at(IEP_DECORATIONS.projectionLossy), all: [true, false] },
    ],
  },
];

/** The xapi-x profile, version 1, as an xAPI Profiles 1.0 document. Pure. */
export function buildXapixProfileDoc(): Record<string, unknown> {
  return buildProfileDoc({
    id: XAPIX_PROFILE_ID,
    prefLabel: { en: 'xapi-x: descriptor projection' },
    definition: { en: 'Declares what an xAPI statement carries when it is a projection of a signed Interego context descriptor: the descriptor it came from, the modal status of the claim, every coherent reading, and whether the projection lost anything. A plain LRS stores these as extensions it does not interpret.' },
    seeAlso: 'https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/xapix/README.md',
    author: { type: 'Organization', name: 'Interego — Foxxi Content Intelligence', url: new URL(XAPIX_PROFILE_ID).origin },
    generatedAt: XAPIX_PROFILE_GENERATED_AT,
    concepts,
    templates,
    patterns: [],
  });
}
