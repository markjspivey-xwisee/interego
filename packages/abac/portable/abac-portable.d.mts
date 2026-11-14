/** Types of abac-portable.mjs (`@interego/abac/portable`): the dependency-free policy decision. */
import type { AccessControlPolicyData } from '@interego/core';
import type { AttributeGraph, PolicyPredicateShape, AbacVerdict } from '../dist/index.js';

export declare const SUBJECT: Readonly<{
  provisional: 'passport:provisional'; claimed: 'passport:claimed'; establishedAt: 'passport:establishedAt';
  standingUntil: 'passport:standingUntil'; admittedBy: 'passport:admittedBy'; linkedTo: 'passport:linkedTo';
  role: 'passport:role'; onBehalfOf: 'iep:onBehalfOf'; acceptedTermsVersion: 'passport:acceptedTermsVersion';
  proofKeyThumbprint: 'passport:proofKeyThumbprint'; ageSeconds: 'abac:ageSeconds'; secondsRemaining: 'abac:secondsRemaining';
}>;
export declare const ACTIONS: Readonly<{ useService: 'abac:useService'; publish: 'iep:canPublish' }>;

export declare class AbacPortableError extends Error { readonly code: string; constructor(code: string); }

/** What an authority states about a subject. Times in Unix seconds. One model for every principal. */
export interface SubjectFacts {
  readonly subject: string;
  readonly provisional: boolean;
  readonly claimed?: boolean;
  readonly establishedAt?: number;
  readonly standingUntil?: number;
  readonly admittedBy?: readonly string[];
  readonly linkedTo?: string;
  readonly roles?: readonly string[];
  readonly onBehalfOf?: string;
  readonly acceptedTermsVersion?: string;
  readonly proofKeyThumbprint?: string;
}
export type SubjectAttributeGraph = AttributeGraph & { readonly attributes: ReadonlyMap<string, readonly (string | number | boolean)[]> };
export interface PolicySet {
  readonly policies: readonly AccessControlPolicyData[];
  readonly predicates: ReadonlyMap<string, PolicyPredicateShape>;
}
export interface Decision {
  readonly allowed: boolean;
  readonly verdict: AbacVerdict;
  readonly reason: string;
  readonly matchedPolicies: readonly string[];
}
/** What `decideInShadow` logs when the policy and the existing rule differ. Nothing of the request is in it. */
export interface ShadowDisagreement {
  readonly event: 'abac_shadow_disagreement';
  readonly point: string;
  readonly mode: 'shadow' | 'enforce';
  readonly action: string;
  readonly subject: string;
  readonly existing: boolean;
  readonly policy: AbacVerdict;
  readonly matchedPolicies: readonly string[];
}

export declare function subjectAttributeGraph(facts: unknown, nowMs?: number): SubjectAttributeGraph;
export declare function evaluatePolicies(policies: readonly AccessControlPolicyData[],
  predicates: ReadonlyMap<string, PolicyPredicateShape>, graph: AttributeGraph, action: string)
  : { verdict: AbacVerdict; matchedPolicies: readonly string[] };
export declare function decide(action: string, policySet: PolicySet, graph: AttributeGraph | null | undefined): Decision;
export declare function decideInShadow(input: { point: string; mode?: string; existing: boolean; action: string;
  policySet: PolicySet; graph: AttributeGraph | null | undefined; log?: (record: ShadowDisagreement) => void }): boolean;
export declare function provisionalSubjectPolicies(options: { service: string; provisionalMay?: readonly string[];
  claimedMay?: readonly string[]; acceptedTermsVersion?: string }): PolicySet;
