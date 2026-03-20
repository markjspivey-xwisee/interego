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
