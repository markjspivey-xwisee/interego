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
  ownerProfileToTurtle,
  parseOwnerProfile,
  delegationCredentialToJsonLd,
  verifyDelegation,
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
