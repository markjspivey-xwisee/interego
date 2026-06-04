/**
 * @module solid/affordance
 * @description Back-compat re-export shim.
 *
 * The generic affordance follower used to live in this file. It is
 * binding-agnostic (HTTP + Turtle/TriG — no Solid-specific surface),
 * so it now lives at `../affordance/follow`. This shim preserves the
 * historical import path while consumers migrate.
 */

export {
  followAffordance,
  DescriptorNotFoundError,
  AffordanceNotFoundError,
} from '@interego/core/affordance';
export type {
  FollowAffordanceOptions,
  FollowAffordanceResult,
  ResolvedAffordance,
  AffordanceMethod,
} from '@interego/core/affordance';
