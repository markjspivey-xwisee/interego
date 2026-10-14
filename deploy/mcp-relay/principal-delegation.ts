/**
 * Verify an authenticated or signed principal through its existing delegation
 * subject, without rewriting any registry, credential or authorship payload.
 */
import { verifyDelegation, type IRI, type DelegationVerification } from '@interego/core';
import { readAgentRegistry, readDelegationCredential, type VerifyAgentDelegationOptions } from '@interego/solid';
import { selectDelegationSubject, type DelegationSubject } from './delegation-subject.js';
export interface PrincipalDelegationOptions extends VerifyAgentDelegationOptions {
  readonly identityBaseUrl:string;
}
export interface PrincipalDelegationVerification extends DelegationVerification {
  readonly delegationSubject:DelegationSubject;
}
export async function verifyPrincipalDelegation(
  principal:IRI,
  podUrl:string,
  options:PrincipalDelegationOptions,
):Promise<PrincipalDelegationVerification> {
  const profile=await readAgentRegistry(podUrl,options);
  const subject=selectDelegationSubject(principal,profile?.authorizedAgents??[],options.identityBaseUrl);
  // Keep the registry's original branded identifier. A missing selection verifies
  // the presented principal and fails through the substrate's ordinary refusal.
  const registered=profile?.authorizedAgents.find(row=>row.agentId===subject.registered)?.agentId??principal;
  let initial=true;
  const verification=await verifyDelegation(
    registered,podUrl,
    async url=>{
      // Selection and the initial grant check use one observed registry snapshot.
      // Later sub-delegation hops retain the substrate's defensive reread.
      if(initial&&url===podUrl){initial=false;return profile;}
      return readAgentRegistry(url,options);
    },
    options.verifier?{
      fetchCredential:(url,agent)=>readDelegationCredential(url,agent,options),
      verifier:options.verifier,
      walkSubDelegations:options.walkSubDelegations,
      maxChainLength:options.maxChainLength,
    }:{},
  );
  return {...verification,delegationSubject:subject};
}
