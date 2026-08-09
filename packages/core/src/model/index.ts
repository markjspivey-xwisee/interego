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
  TENANT_ADMIN_CAPABILITY,
  createSignedDelegationCredential,
  canonicalCredentialPayload,
  canonicalAuthorshipPayload,
  createSignedAuthorship,
  contentBindingWhenUnchecked,
  verifySignedAuthorship,
  proofBindsToDescriptorUrl,
  ownerProfileToTurtle,
  parseOwnerProfile,
  delegationCredentialToJsonLd,
  parseDelegationCredential,
  verifyDelegation,
  verifyDelegationChain,
} from './delegation.js';
// The live half of the delegation model: seating, reading, revoking and attributing a delegate.
// Also reachable as the narrow subpath `@interego/core/delegate`, which is what a BROWSER bundle
// must import — this barrel pulls in the whole model and an artifact should not pay for that.
export {
  DELEGATION_SCOPES,
  WRITE_ELIGIBLE_SCOPES,
  isDelegationScope,
  scopeWriteEligible,
  AGENT_ID_RX,
  DELEGATE_LABEL_PREFIX,
  DELEGATE_NAME_MAX,
  DELEGATE_SURFACE,
  delegateLabel,
  parseDelegateLabel,
  delegateNameProblem,
  delegateAgentId,
  isDelegateRow,
  relayRefusal,
  readDelegates,
  delegatePlan,
  publishDelegation,
  revokeDelegation,
  scopeCeiling,
  judgeAuthorship,
  authorshipLine,
  signerLine,
  agentPodOf,
} from './delegate.js';
export type {
  DelegateRow,
  DelegateRoster,
  DelegateRegistryPort,
  DelegateField,
  DelegateProblem,
  DelegatePlan,
  DelegateOutcome,
  CeilingVerdict,
  EntryAuthorship,
  EntrySigner,
} from './delegate.js';
export type {
  DelegationSigner,
  DelegationVerifier,
  DelegationVerificationOptions,
  AuthorshipProof,
  AuthorshipProofInputs,
  ContentBinding,
  DescriptorBinding,
  DescriptorBindingBasis,
  ProofOwnerScope,
} from './delegation.js';
export {
  registerFacetType,
  getFacetEntry,
  getRegisteredTypes,
  executeMerge,
} from './registry.js';
export type { MergeStrategy, FacetRegistryEntry, FacetMerge } from './registry.js';
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
