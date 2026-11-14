/** Types of guest-access.mjs (dependency-free ESM, shared with the css-gate). */
import type { AccessControlPolicyData } from '@interego/core';
import type { AttributeGraph, PolicyPredicateShape, AbacVerdict } from '@interego/abac';

export declare const GUEST: Readonly<{
  provisional: 'guest:provisional'; claimed: 'guest:claimed'; createdAt: 'guest:createdAt';
  expiresAt: 'guest:expiresAt'; ageSeconds: 'guest:ageSeconds'; secondsRemaining: 'guest:secondsRemaining';
  admittedBy: 'guest:admittedBy'; hostedTermsVersion: 'guest:hostedTermsVersion';
  proofKeyThumbprint: 'guest:proofKeyThumbprint';
}>;
export declare const GUEST_ACTIONS: Readonly<{ useApplication: 'guest:UseApplication'; writeCheckpoint: 'guest:WriteCheckpoint' }>;

export declare class GuestAccessError extends Error { readonly code: string; constructor(code: string); }

/** What identity states about a guest (`guestAttributes` in its exchange and introspection answers). Times in Unix seconds. */
export interface GuestFacts {
  readonly subject: string;
  readonly provisional: true;
  readonly claimed: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly admittedBy: readonly string[];
  readonly proofKeyThumbprint: string;
  readonly hostedTermsVersion?: string;
}
export type GuestAttributeGraph = AttributeGraph & { readonly attributes: ReadonlyMap<string, readonly (string | number | boolean)[]> };
export interface GuestPolicySet {
  readonly policies: readonly AccessControlPolicyData[];
  readonly predicates: ReadonlyMap<string, PolicyPredicateShape>;
}
export interface GuestDecision {
  readonly allowed: boolean;
  readonly verdict: AbacVerdict;
  readonly reason: string;
  readonly matchedPolicies: readonly string[];
}

export declare function guestAttributeGraph(facts: unknown, nowMs?: number): GuestAttributeGraph;
export declare function evaluateGuestPolicies(policies: readonly AccessControlPolicyData[],
  predicates: ReadonlyMap<string, PolicyPredicateShape>, graph: AttributeGraph, action: string)
  : { verdict: AbacVerdict; matchedPolicies: readonly string[] };
export declare function decide(action: string, policySet: GuestPolicySet, graph: AttributeGraph | null | undefined): GuestDecision;
export declare function guestPolicies(options: { application: string; provisionalMay?: readonly string[];
  claimedMay?: readonly string[]; hostedTermsVersion?: string }): GuestPolicySet;
