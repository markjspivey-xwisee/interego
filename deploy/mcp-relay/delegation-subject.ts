/**
 * Bind a verified session principal to the EXISTING delegation subject.
 *
 * Registry and signed credential identifiers are never rewritten. A legacy
 * identity-server slug is an alias only in this deployment's identity namespace.
 * Exact canonical rows take precedence, including revoked or narrowed rows.
 */
import { canonicalSessionActorId } from './session-actor.js';
export interface DelegationSubject {
  readonly presented: string;
  readonly registered: string;
  readonly basis: 'exact'|'identity-alias'|'missing'|'ambiguous';
}
export function selectDelegationSubject(
  presented:string,
  entries:readonly {readonly agentId:string}[],
  identityBaseUrl:string,
):DelegationSubject {
  if(entries.some(row=>row.agentId===presented))return {presented,registered:presented,basis:'exact'};
  const aliases=entries.filter(row=>{
    // Do not equate arbitrary DID suffixes or absolute IRIs. Only local slugs
    // minted by the same configured identity service have a canonical spelling.
    if(!/^[A-Za-z0-9._~-]+$/.test(row.agentId))return false;
    return canonicalSessionActorId(row.agentId,identityBaseUrl)===presented;
  });
  if(aliases.length===1)return {presented,registered:aliases[0]!.agentId,basis:'identity-alias'};
  return {presented,registered:presented,basis:aliases.length?'ambiguous':'missing'};
}
/**
 * Alias grants are read on every request: owner updates invalidate caches by
 * the original registry subject, not the presented DID. Missing/invalid grants
 * are not cached either, so an owner's newly installed alias is visible at once.
 */
export function cacheDelegationSubject(valid:boolean,subject:DelegationSubject):boolean {
  return valid&&subject.basis==='exact';
}

/**
 * An explicit OWNER revocation targets a principal, including its known local
 * and canonical spellings. Revoked rows disappear from serialized registries;
 * removing only a canonical row must not revive a remaining legacy alias.
 * Other DID authorities are never equated by their suffix.
 */
export function equivalentDelegationSubjects(
  presented:string,
  entries:readonly {readonly agentId:string}[],
  identityBaseUrl:string,
):string[] {
  const canonical=(value:string):string|undefined=>{
    if(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))return value;
    if(/^[A-Za-z0-9._~-]+$/.test(value))return canonicalSessionActorId(value,identityBaseUrl);
    return undefined;
  };
  const principal=canonical(presented);
  const targets=[presented,...(principal?[principal]:[])];
  if(principal)for(const row of entries)if(canonical(row.agentId)===principal)targets.push(row.agentId);
  return [...new Set(targets)];
}

/** A proven owner may provision an absent principal, never overwrite an existing alias ceiling. */
export function canAutoRegisterPrincipal(ownerAuthorized:boolean,subject:DelegationSubject):boolean {
  return ownerAuthorized&&subject.basis==='missing';
}
