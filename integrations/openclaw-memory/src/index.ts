/**
 * @interego/openclaw-memory — OpenClaw memory plugin backed by Interego pods.
 *
 * Two layers:
 *   - bridge.ts  — substrate-pure primitives (store/recall/forget); reusable
 *                  by any agent runtime, not just OpenClaw.
 *   - plugin.ts  — OpenClaw plugin glue; wires the bridge into the
 *                  registerMemoryCapability + tool surface OpenClaw exposes.
 *
 * If you're integrating with a different runtime (Hermes, Codex, etc.),
 * import from ./bridge directly and write the runtime-specific glue
 * yourself; you don't need the plugin.ts module.
 */

export {
  storeMemory,
  recallMemories,
  forgetMemory,
  buildMemoryDescriptor,
  // HATEOAS navigation — distributed affordances
  affordancesFor,
  discoverContexts,
  followAffordance,
  type BridgeConfig,
  type DelegationScope,
  type StoreMemoryArgs,
  type StoreMemoryResult,
  type RecallMemoriesArgs,
  type ForgetMemoryArgs,
  type MemoryHit,
  type MemoryKind,
  type AffordanceVerb,
  type BridgeAffordance,
  type DiscoverContextsArgs,
  type DiscoveredDescriptor,
  type FollowAffordanceArgs,
  type FollowAffordanceResult,
} from './bridge.js';

export {
  interegoMemoryPlugin,
  type InteregoMemoryPluginConfig,
} from './plugin.js';
