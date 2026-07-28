/**
 * @module @interego/agent-interop
 * @description A general agent-interop engine: a spec-blind engagement record plus
 *              a card projection, both driven by declarative profile data.
 *
 * The engine names no wire protocol — not even in a comment; a drift-guard test
 * enforces that. Concrete protocols live in `src/profiles/`, and a second profile
 * ships alongside the first so the "another format is data only" claim is tested
 * rather than asserted.
 */
export type {
  Part, Turn, TurnRole, Engagement, EngagementState, Capability, AgentIdentity,
} from './types.js';
export { TERMINAL_STATES } from './types.js';
export type {
  InteropProfile, InteropOperation, InteropErrorKind, WireRoute, ErrorSpec, DeclinedRoute,
  CardProjection, LifecycleProjection, EngagementProjection,
} from './profile.js';
export { EngagementEngine } from './engagement.js';
export type { EngineResult, EngineError, EngagementStoreOptions } from './engagement.js';
export { isEngineError, availableOperations } from './engagement.js';
export { renderCard, cardVersion, capabilitiesFromAffordances } from './card.js';
export { PROFILES, A2A_PROFILE, INTEREGO_AGENTS_PROFILE } from './profiles/index.js';
