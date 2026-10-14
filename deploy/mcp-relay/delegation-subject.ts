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
