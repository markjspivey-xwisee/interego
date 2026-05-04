/**
 * @module skills
 * @description SKILL.md (agentskills.io) ↔ Interego substrate translator.
 *
 * Layer-3 implementation. Pure translator; no new substrate types or
 * namespaces. The cg:Affordance + cgh:Affordance + dct:hasPart +
 * pgsl:Atom predicates already in the protocol express everything a
 * SKILL.md needs to encode.
 *
 * Why this exists: agentskills.io is the convergence point for skill
 * packaging across OpenClaw, Hermes Agent, VS Code Copilot, OpenAI
 * Codex, Microsoft Agent Framework, Cursor, and other modern agent
 * runtimes. Publishing a SKILL.md as a typed Interego descriptor
 * makes the entire skill ecosystem federable, attestable, supersedable,
 * and verifiable — properties that emerge from existing substrate
 * primitives without runtime-specific code.
 *
 * Exports:
 *   parseSkillMd / emitSkillMd          — frontmatter parser + emitter
 *   skillBundleToDescriptor             — SKILL.md dir → cg:Affordance descriptor
 *   descriptorGraphToSkillBundle        — cg:Affordance descriptor → SKILL.md dir
 *   descriptorGraphToSkillMd            — convenience: re-emit SKILL.md text only
 */

export {
  parseSkillMd,
  emitSkillMd,
  type SkillFrontmatter,
  type SkillDocument,
  type SkillParseResult,
  type SkillValidationError,
} from './skill-md.js';

export {
  skillBundleToDescriptor,
  descriptorGraphToSkillBundle,
  descriptorGraphToSkillMd,
  type SkillBundle,
  type SkillToDescriptorOptions,
  type DescriptorBundle,
} from './agentskills-bridge.js';
