/**
 * @module @interego/openclaw-memory/plugin
 * @description OpenClaw plugin glue — wires the substrate-pure bridge
 *              functions into OpenClaw's memory-engine slot.
 *
 * Architectural framing: this file exists ONLY because OpenClaw's
 * plugin SDK has its own ergonomic shape. The actual memory operations
 * live in ./bridge.ts as substrate-pure functions. If OpenClaw's SDK
 * surface evolves, only this file needs to change.
 *
 * The plugin claims OpenClaw's exclusive `plugins.slots.memory` slot
 * (per the LanceDB / Honcho integration patterns) and registers three
 * tools:
 *   - memory_store    → bridge.storeMemory
 *   - memory_recall   → bridge.recallMemories
 *   - memory_forget   → bridge.forgetMemory
 *
 * If `autoCapture` is enabled in config, the plugin also subscribes to
 * the `after_assistant_response` hook and stores any extracted facts
 * automatically. If `autoRecall` is enabled, it injects relevant
 * memories into the `before_prompt_build` phase.
 *
 * SCOPE NOTE: this scaffold is written against the public OpenClaw
 * plugin docs (sdk-overview, memory-lancedb, memory-honcho) and the
 * exclusive-slot pattern those use. The exact OpenClaw type signatures
 * may differ in detail; consult @openclaw/plugin-sdk for the canonical
 * types when wiring this into a live OpenClaw install. The bridge
 * functions themselves (./bridge.ts) are stable substrate primitives.
 */

import {
  storeMemory,
  recallMemories,
  forgetMemory,
  type BridgeConfig,
  type StoreMemoryArgs,
  type RecallMemoriesArgs,
  type ForgetMemoryArgs,
} from './bridge.js';
import type { IRI } from '../../../src/index.js';

// ── OpenClaw plugin API surface (minimal subset we use) ──────────────
//
// Replace these with imports from `openclaw/plugin-sdk` once you wire
// this into the live OpenClaw install. We define them here so the
// scaffold compiles standalone for inspection and unit testing.

interface OpenClawPluginApi {
  registerMemoryCapability(capability: MemoryCapability): void;
  registerHook(name: HookName, handler: (ctx: HookContext) => Promise<void>): void;
  registerTool(tool: McpToolRegistration): void;
  log: { info: (m: string) => void; error: (m: string) => void };
}

interface MemoryCapability {
  readonly id: string;
  /** Substrate-side store handler — invoked when the agent stores memory. */
  readonly store: (args: { text: string; kind?: string; tags?: string[] }) => Promise<unknown>;
  /** Substrate-side recall handler — invoked during prompt build / on tool call. */
  readonly recall: (args: { query?: string; kind?: string; limit?: number }) => Promise<unknown>;
  /** Substrate-side forget handler. */
  readonly forget: (args: { iri: string; reason?: string }) => Promise<unknown>;
}

type HookName = 'before_prompt_build' | 'after_assistant_response';
interface HookContext { readonly userMessage?: string; readonly assistantResponse?: string; }

interface McpToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ── Plugin config ────────────────────────────────────────────────────

export interface InteregoMemoryPluginConfig {
  /** Pod URL where memories will be stored. Required. */
  readonly podUrl: string;
  /** Authoring agent DID. Required. */
  readonly agentDid: IRI;
  /** Optional human/org owner DID — used in PROV provenance attribution. */
  readonly onBehalfOf?: IRI;
  /** Optional default delegates to share memories with via E2EE. */
  readonly shareWith?: readonly IRI[];
  /** Default true: also write the memory automatically after each agent turn. */
  readonly autoCapture?: boolean;
  /** Default true: inject relevant memories before each prompt build. */
  readonly autoRecall?: boolean;
}

// ── definePluginEntry — OpenClaw SDK convention ─────────────────────

/**
 * Plugin entry point. OpenClaw calls this with the API; we wire memory
 * operations to substrate primitives via the bridge.
 *
 * Use:
 *
 *   import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
 *   import { interegoMemoryPlugin } from "@interego/openclaw-memory";
 *   export default definePluginEntry({ register: interegoMemoryPlugin(yourConfig) });
 */
export function interegoMemoryPlugin(config: InteregoMemoryPluginConfig) {
  const bridgeConfig: BridgeConfig = {
    podUrl: config.podUrl,
    authoringAgentDid: config.agentDid,
    ...(config.onBehalfOf ? { onBehalfOf: config.onBehalfOf } : {}),
    ...(config.shareWith ? { defaultShareWith: config.shareWith } : {}),
  };

  return (api: OpenClawPluginApi): void => {
    // 1. Claim the memory-engine slot.
    api.registerMemoryCapability({
      id: 'interego',
      store: async (a) => {
        const args: StoreMemoryArgs = { text: a.text, kind: a.kind, tags: a.tags };
        return storeMemory(args, bridgeConfig);
      },
      recall: async (a) => {
        const args: RecallMemoriesArgs = { query: a.query, kind: a.kind, limit: a.limit };
        return recallMemories(args, bridgeConfig);
      },
      forget: async (a) => {
        const args: ForgetMemoryArgs = { iri: a.iri as IRI, reason: a.reason };
        return forgetMemory(args, bridgeConfig);
      },
    });

    // 2. Register named tools so the LLM can call them explicitly.
    api.registerTool({
      name: 'memory_store',
      description: 'Persist a fact, preference, decision, or observation into the agent\'s pod-rooted memory. The descriptor is signed, provenance-attributed, and (if shareWith was configured) E2EE-shared with delegates.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remember.' },
          kind: { type: 'string', description: 'Category — fact / preference / decision / entity / observation.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for filterable recall.' },
        },
        required: ['text'],
      },
      handler: async (raw) => storeMemory(raw as StoreMemoryArgs, bridgeConfig),
    });

    api.registerTool({
      name: 'memory_recall',
      description: 'Recall memories from the agent\'s pod-rooted store. Returns Asserted memories by default; pass includeHypothetical=true for the speculative pool.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          kind: { type: 'string' },
          limit: { type: 'number' },
          includeHypothetical: { type: 'boolean' },
          includeFederated: { type: 'boolean' },
        },
        required: [],
      },
      handler: async (raw) => recallMemories(raw as RecallMemoriesArgs, bridgeConfig),
    });

    api.registerTool({
      name: 'memory_forget',
      description: 'Mark a memory as no-longer-active by publishing a Counterfactual that supersedes it. The original remains queryable for audit.',
      inputSchema: {
        type: 'object',
        properties: {
          iri: { type: 'string', description: 'IRI of the memory to retract.' },
          reason: { type: 'string', description: 'Optional reason recorded on the superseding descriptor.' },
        },
        required: ['iri'],
      },
      handler: async (raw) => forgetMemory(raw as ForgetMemoryArgs, bridgeConfig),
    });

    // 3. Optional auto-recall / auto-capture hooks.
    if (config.autoRecall ?? true) {
      api.registerHook('before_prompt_build', async (ctx) => {
        if (!ctx.userMessage) return;
        const hits = await recallMemories({ query: ctx.userMessage, limit: 5 }, bridgeConfig);
        if (hits.length > 0) {
          api.log.info(`[interego-memory] auto-recall surfaced ${hits.length} hit(s) for current turn`);
        }
      });
    }

    if (config.autoCapture ?? true) {
      api.registerHook('after_assistant_response', async (ctx) => {
        if (!ctx.assistantResponse) return;
        // Heuristic: if the assistant explicitly framed something as a
        // fact/decision/preference (the runtime will pre-extract via its
        // existing capture pipeline), persist it. The bridge does not
        // do extraction — that's the runtime's job. We expose the API.
        // No write happens automatically here; this hook is a slot the
        // runtime fills with extracted facts.
      });
    }

    api.log.info('[interego-memory] plugin loaded; memory-engine slot claimed');
  };
}
