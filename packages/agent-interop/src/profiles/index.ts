/**
 * @module profiles
 * @description The profile registry. Adding a wire format means adding an entry
 *              here and a data file beside it — never a change under `src/`.
 */
export { A2A_PROFILE } from './a2a.profile.js';
export { INTEREGO_AGENTS_PROFILE } from './interego-agents.profile.js';

import { A2A_PROFILE } from './a2a.profile.js';
import { INTEREGO_AGENTS_PROFILE } from './interego-agents.profile.js';
import type { InteropProfile } from '../profile.js';

/** Every profile the engine can serve, by slug. */
export const PROFILES: Readonly<Record<string, InteropProfile>> = Object.freeze({
  [A2A_PROFILE.slug]: A2A_PROFILE,
  [INTEREGO_AGENTS_PROFILE.slug]: INTEREGO_AGENTS_PROFILE,
});
