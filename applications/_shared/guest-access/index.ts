/**
 * Guest access decisions for bridges: what a provisional guest may do in an application, decided
 * from the attributes identity states about it by policies that are data (default-deny).
 *
 * The implementation is guest-access.mjs beside this file: no imports, so the css-gate carries a
 * byte-identical copy (deploy/css-gate/guest-access.mjs). This module only names it for
 * TypeScript callers. It reads no environment and makes no request.
 */
export { GUEST, GUEST_ACTIONS, GuestAccessError, guestAttributeGraph, evaluateGuestPolicies, decide, guestPolicies } from './guest-access.mjs';
export type { GuestFacts, GuestAttributeGraph, GuestPolicySet, GuestDecision } from './guest-access.mjs';
