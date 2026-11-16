/**
 * The xapi-x profile: an xAPI Profiles 1.0 document that declares what a statement carries when
 * it is a projection of a signed context descriptor, and one statement template that holds a
 * projection to it.
 *
 * VERSION 1 declared the four `iep:` keys the lrs-adapter already wrote under
 * `result.extensions`, and its template stated no determining property, because nothing in a
 * statement marked it as a projection except those keys. Asked of version 1, every statement is
 * held to the template. Version 1 is what was first published on the pod, and
 * `buildXapixProfileDocV1` still builds it, byte for byte.
 *
 * VERSION 2 is this file's current document. Emitters now write the category `xapix:Projection`,
 * so its template selects on that: a statement that does not claim to be a projection is
 * unmatched, not invalid, and a domain profile can copy the template. It also declares the
 * `xapix:` context extensions (descriptor digest, supersession, controls, ordering). Version 1's
 * template is kept, deprecated: statements written before the category existed are judged
 * against version 1.
 *
 * The concepts' ids are the `iep:` and `xapix:` IRIs as they are in statements. A profile may
 * define a concept whose IRI is not under the profile's own; the specification asks only that a
 * version's id differ from the profile's. xapi-x does not mint a second name for a key that is
 * already in other people's stores.
 */
import { buildProfileDoc } from '../xapi-profile.js';
import { IEP_DECORATIONS, MODAL_STATUSES, XAPIX_PROFILE_ID, xapix } from './namespace.js';

/** When version 1 of the profile was written. A constant: a profile version does not change with the clock. */
export const XAPIX_PROFILE_GENERATED_AT = '2026-11-15T00:00:00.000Z';
/** When version 2 was written. */
export const XAPIX_PROFILE_V2_GENERATED_AT = '2026-11-16T00:00:00.000Z';
export const XAPIX_PROFILE_V1_ID = `${XAPIX_PROFILE_ID}/v/1`;
/** The current version. */
export const XAPIX_PROFILE_VERSION_ID = `${XAPIX_PROFILE_ID}/v/2`;
/** Version 1's template, which every statement matches. Deprecated in version 2. */
export const XAPIX_V1_TEMPLATE_ID = `${XAPIX_PROFILE_ID}/templates/descriptor-projection`;
/** The current template, which a statement matches by carrying the `xapix:Projection` category. */
export const XAPIX_PROJECTION_TEMPLATE_ID = `${XAPIX_PROFILE_ID}/templates/projection`;

const schema = (s: object): string => JSON.stringify(s);
const at = (key: string): string => `$.result.extensions['${key}']`;
const inContext = (key: string): string => `$.context.extensions['${key}']`;
const DIGEST = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

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

/** What version 2 adds: the marker, and the `xapix:` keys a statement carries in `context.extensions`. */
const added = [
  {
    id: xapix('Projection'), type: 'ActivityType',
    prefLabel: { en: 'projection' },
    definition: { en: 'The type of the category a statement carries when it is a projection of a signed context descriptor. A statement template selects on it, so only statements that claim to be projections are held to the rules for one.' },
  },
  {
    id: xapix('descriptorDigest'), type: 'ContextExtension',
    prefLabel: { en: 'descriptor digest' },
    definition: { en: 'The SHA-256 of the source descriptor\'s bytes as served. A descriptor fetched from the source descriptor\'s IRI that hashes differently is not the one this statement was projected from.' },
    inlineSchema: schema(DIGEST),
  },
  {
    id: xapix('supersedesStatement'), type: 'ContextExtension',
    prefLabel: { en: 'supersedes statement' },
    definition: { en: 'The ids of the earlier statements this statement replaces as the current account, most recent first. It voids none of them: a statement that was wrong and must stop counting is voided by xAPI\'s own voiding statement as well.' },
    inlineSchema: schema({ type: 'array', items: { type: 'string', pattern: UUID }, minItems: 1 }),
  },
  {
    id: xapix('controls'), type: 'ContextExtension',
    prefLabel: { en: 'controls' },
    definition: { en: 'The IRI of a document listing what can be done next about this statement. A statement that names a source descriptor carries none: the descriptor has its own affordances.' },
    inlineSchema: schema({ type: 'string', format: 'iri' }),
  },
  {
    id: xapix('previous'), type: 'ContextExtension',
    prefLabel: { en: 'previous' },
    definition: { en: 'The id of the statement the emitter says came immediately before this one in the same registration. The emitter\'s claim until a digest or an attestation backs it.' },
    inlineSchema: schema({ type: 'string', pattern: UUID }),
  },
  {
    id: xapix('previousDigest'), type: 'ContextExtension',
    prefLabel: { en: 'previous digest' },
    definition: { en: 'The SHA-256 of the statement named by previous, over its RFC 8785 canonical JSON as its emitter sent it, without the stored, authority and version members. A run of statements each carrying it cannot be reordered or altered afterwards without breaking a digest.' },
    inlineSchema: schema(DIGEST),
  },
  {
    id: xapix('orderAttestation'), type: 'ContextExtension',
    prefLabel: { en: 'order attestation' },
    definition: { en: 'The IRI of a signed descriptor that lists, in order, the digests of the statements of a registration. Whoever signed it attests that order; the reader decides whether to trust them.' },
    inlineSchema: schema({ type: 'string', format: 'iri' }),
  },
];

const sourceRule = { location: at(IEP_DECORATIONS.sourceDescriptor), presence: 'included' };
const modalRule = { location: at(IEP_DECORATIONS.modalStatus), presence: 'included', any: [...MODAL_STATUSES] };

const v1Template = {
  id: XAPIX_V1_TEMPLATE_ID,
  prefLabel: { en: 'descriptor projection' },
  definition: { en: 'A statement projected from a signed context descriptor names that descriptor and states its modal status. Where it says whether the projection is lossy, it says so with a boolean.' },
  rules: [
    sourceRule,
    modalRule,
    // No presence stated: absent passes, and a value that is not a boolean does not.
    { location: at(IEP_DECORATIONS.projectionLossy), all: [true, false] },
  ],
};

const templates = [
  {
    id: XAPIX_PROJECTION_TEMPLATE_ID,
    prefLabel: { en: 'projection' },
    definition: { en: 'A statement that carries the projection category names the signed context descriptor it is a projection of, states the modal status of the claim, and says whether the projection lost anything.' },
    contextCategoryActivityType: [xapix('Projection')],
    rules: [
      sourceRule,
      modalRule,
      { location: at(IEP_DECORATIONS.projectionLossy), presence: 'included', all: [true, false] },
      // A projection needs no link to controls: its descriptor carries its own.
      { location: inContext(xapix('controls')), presence: 'excluded' },
    ],
  },
  {
    ...v1Template,
    deprecated: true,
    definition: { en: 'Version 1\'s template, which states no determining property, so that every statement matched it. Deprecated: a projection now carries the projection category and follows the projection template. Statements written before the category existed are judged against version 1 of this profile.' },
  },
];

const ABOUT = {
  id: XAPIX_PROFILE_ID,
  prefLabel: { en: 'xapi-x: descriptor projection' },
  seeAlso: 'https://github.com/markjspivey-xwisee/interego/blob/master/applications/foxxi-content-intelligence/xapix/README.md',
  author: { type: 'Organization', name: 'Interego — Foxxi Content Intelligence', url: new URL(XAPIX_PROFILE_ID).origin },
};

/** The xapi-x profile as an xAPI Profiles 1.0 document, at its current version. Pure. */
export function buildXapixProfileDoc(): Record<string, unknown> {
  const stamp = (parts: Array<Record<string, unknown>>): Array<Record<string, unknown>> => parts.map(p => ({ ...p, inScheme: XAPIX_PROFILE_VERSION_ID }));
  const doc = buildProfileDoc({
    ...ABOUT,
    definition: { en: 'Declares what an xAPI statement carries when it is a projection of a signed Interego context descriptor: the marker that says it is one, the descriptor it came from and its digest, the modal status of the claim, every coherent reading, whether the projection lost anything, what the statement supersedes, and who stands behind its place in a sequence. A plain LRS stores these as a category and extensions it does not interpret.' },
    generatedAt: XAPIX_PROFILE_V2_GENERATED_AT,
    concepts: stamp([...concepts, ...added]),
    templates: stamp(templates),
    patterns: [],
  });
  return {
    ...doc,
    versions: [
      { id: XAPIX_PROFILE_VERSION_ID, wasRevisionOf: [XAPIX_PROFILE_V1_ID], generatedAtTime: XAPIX_PROFILE_V2_GENERATED_AT },
      { id: XAPIX_PROFILE_V1_ID, generatedAtTime: XAPIX_PROFILE_GENERATED_AT },
    ],
  };
}

/** Version 1, as first published on the pod. Pure, and not to be changed: a published version does not change. */
export function buildXapixProfileDocV1(): Record<string, unknown> {
  return buildProfileDoc({
    ...ABOUT,
    definition: { en: 'Declares what an xAPI statement carries when it is a projection of a signed Interego context descriptor: the descriptor it came from, the modal status of the claim, every coherent reading, and whether the projection lost anything. A plain LRS stores these as extensions it does not interpret.' },
    generatedAt: XAPIX_PROFILE_GENERATED_AT,
    concepts,
    templates: [v1Template],
    patterns: [],
  });
}
