export * from './types.js';
export { ContextDescriptor } from './descriptor.js';
export {
  union,
  intersection,
  restriction,
  override,
  effectiveContext,
  resetComposedIdCounter,
} from './composition.js';
export {
  createOwnerProfile,
  addAuthorizedAgent,
  removeAuthorizedAgent,
  createDelegationCredential,
  createSignedDelegationCredential,
  canonicalCredentialPayload,
  canonicalAuthorshipPayload,
  createSignedAuthorship,
  verifySignedAuthorship,
  ownerProfileToTurtle,
  parseOwnerProfile,
  delegationCredentialToJsonLd,
  parseDelegationCredential,
  verifyDelegation,
  verifyDelegationChain,
} from './delegation.js';
export type {
  DelegationSigner,
  DelegationVerifier,
  DelegationVerificationOptions,
  AuthorshipProof,
  AuthorshipProofInputs,
} from './delegation.js';
export {
  registerFacetType,
  getFacetEntry,
  getRegisteredTypes,
  executeMerge,
} from './registry.js';
export type { MergeStrategy, FacetRegistryEntry } from './registry.js';
export {
  toPresheaf,
  fromPresheaf,
  verifyUnionNaturality,
  verifyIntersectionNaturality,
  verifyIdempotence,
  verifyCommutativity,
  verifyAssociativity,
  verifyAbsorption,
  verifyBoundedLattice,
} from './category.js';
export type { DescriptorPresheaf, NaturalityWitness, LatticeLawProof } from './category.js';
export {
  phi,
  psi,
  signUnion,
  signIntersection,
  adjunctionUnit,
  adjunctionCounit,
  verifyAdjunction,
  semioticField,
  verifySemioticFieldFunctoriality,
} from './semiotic.js';
export type { SignMorphism } from './semiotic.js';
export {
  constructOmega,
  makeGeometricMorphism,
  ModalAlgebra,
  facetModal,
  descriptorModal,
  composeFacetTransformations,
  identityFacetTransformation,
  effectiveModal,
  temporalAnnotations,
  temporalNow,
} from './derivation.js';
export type {
  Omega,
  OmegaVerdict,
  PodView,
  GeometricMorphism,
  ModalValue,
  FacetTransformation,
  EffectiveModal,
  TemporalContext,
  TemporalAnnotations,
} from './derivation.js';
export {
  normalizePublishInputs,
  extractRevocationConditions,
  stripStringsAndComments,
} from './publish-preprocess.js';
export type {
  PublishInputs,
  PreprocessedPublish,
} from './publish-preprocess.js';
